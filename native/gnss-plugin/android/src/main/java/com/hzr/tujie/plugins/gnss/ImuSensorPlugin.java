package com.hzr.tujie.plugins.gnss;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

/**
 * IMU 惯性传感器数据插件。
 *
 * 桥接 Android SensorManager 的线性加速度、陀螺仪、旋转向量到 JavaScript。
 * 数据用于 GPS 融合（仅辅助定位）：
 *   - 加速度注入 CA 模型（JS 侧 1Hz 聚合）：线性加速度旋转 ENU 后作为运动学
 *     先验注入滤波预测，GPS 仍是位置权威；不做航迹推算、不参与航向解算。
 *
 * 采样率：100000µs ≈ 10Hz（辅助定位 1s 窗口聚合 10 个样本已足够，显式低频省电）。
 * 事件:
 *   - "imuSample" : ImuSample — 每次线性加速度到达时推送一份合并样本
 *
 * 坐标系：
 *   - 传感器设备系：x 右、y 上（竖屏长轴）、z 指向屏幕外
 *   - rotation 四元数 [w,x,y,z] 描述「设备系 → 世界系(ENU: 东/北/天)」，
 *     JS 侧用它把线性加速度旋转到 ENU 地理系，与 IMM 局部米坐标天然对齐。
 *   - TYPE_LINEAR_ACCELERATION 已去除重力（比裸加速度计少一步重力分离）。
 *
 * 权限：惯性传感器无需权限声明。
 */
@CapacitorPlugin(name = "ImuData")
public class ImuSensorPlugin extends Plugin implements SensorEventListener {

    private static final String TAG = "ImuSensorPlugin";
    // 10Hz ≈ 100ms/样本；辅助定位 1s 窗口聚合 10 个样本已足够，显式低频省电
    private static final int SAMPLING_PERIOD_US = 100000;

    private SensorManager sensorManager;
    private Sensor linearAccelSensor;
    private Sensor gyroSensor;
    private Sensor rotationSensor;

    // 最近一次样本快照（线程安全，getLastImuSample 兜底）
    private final Object sampleLock = new Object();
    private JSObject lastSample;

    // 三类传感器最近值（SensorEvent 回调线程 → 合并样本线程，各自加锁）
    private final Object accelLock = new Object();
    private final Object gyroLock = new Object();
    private final Object rotationLock = new Object();
    private float[] accelValues;
    private float[] gyroValues;
    private float[] rotationValues;
    private long accelTimestamp = 0;

    @Override
    public void load() {
        super.load();
        Context ctx = getContext();
        if (ctx != null) {
            sensorManager = (SensorManager) ctx.getSystemService(Context.SENSOR_SERVICE);
            if (sensorManager != null) {
                linearAccelSensor = sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION);
                gyroSensor = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
                rotationSensor = Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR2
                        ? sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR) : null;
                Log.d(TAG, "Plugin loaded. linearAccel=" + (linearAccelSensor != null)
                        + ", gyro=" + (gyroSensor != null) + ", rotation=" + (rotationSensor != null));
            }
        }
    }

    @Override
    public void handleOnDestroy() {
        unregisterAll();
        super.handleOnDestroy();
    }

    // ──────────────────────────────────────────────
    // Plugin methods (exposed to JS)
    // ──────────────────────────────────────────────

    /**
     * 开始监听 IMU 传感器数据（10Hz）。
     */
    @PluginMethod
    public void startImuListening(PluginCall call) {
        if (sensorManager == null) {
            call.reject("SensorManager not available", "NO_SENSOR");
            return;
        }
        if (linearAccelSensor == null) {
            call.reject("TYPE_LINEAR_ACCELERATION sensor not available", "NO_LINEAR_ACCEL");
            return;
        }
        try {
            registerSensor(linearAccelSensor);
            registerSensor(gyroSensor);
            registerSensor(rotationSensor);
            Log.d(TAG, "IMU listening started (10Hz)");
            call.resolve();
        } catch (Exception e) {
            unregisterAll();
            Log.e(TAG, "Failed to start IMU listening", e);
            call.reject("Failed to start IMU listening: " + e.getMessage(), "UNKNOWN_ERROR");
        }
    }

    /**
     * 停止监听，释放所有传感器。
     */
    @PluginMethod
    public void stopImuListening(PluginCall call) {
        try {
            unregisterAll();
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to stop: " + e.getMessage(), "UNKNOWN_ERROR");
        }
    }

    /**
     * 返回最后一次缓存的 IMU 样本快照（事件流中断时兜底）。
     */
    @PluginMethod
    public void getLastImuSample(PluginCall call) {
        synchronized (sampleLock) {
            call.resolve(lastSample != null ? lastSample : new JSObject());
        }
    }

    // ──────────────────────────────────────────────
    // SensorEventListener
    // ──────────────────────────────────────────────

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event == null) return;
        switch (event.sensor.getType()) {
            case Sensor.TYPE_LINEAR_ACCELERATION:
                handleLinearAccel(event);
                break;
            case Sensor.TYPE_GYROSCOPE:
                handleGyro(event);
                break;
            case Sensor.TYPE_ROTATION_VECTOR:
                handleRotation(event);
                break;
            default:
                break;
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        // 传感器精度变化，忽略
    }

    // ──────────────────────────────────────────────
    // 样本装配：三类传感器事件合并为完整样本
    // ──────────────────────────────────────────────

    private void handleLinearAccel(SensorEvent e) {
        synchronized (accelLock) {
            accelValues = e.values.clone();
            accelTimestamp = e.timestamp;
        }
        publishSample();
    }

    private void handleGyro(SensorEvent e) {
        synchronized (gyroLock) {
            gyroValues = e.values.clone();
        }
    }

    private void handleRotation(SensorEvent e) {
        synchronized (rotationLock) {
            rotationValues = e.values.clone();
        }
    }

    /**
     * 每次线性加速度到达时装配一份完整样本推送（约 10Hz）。
     * 陀螺仪/旋转向量可能晚于首次加速度到达，此时用最近缓存值。
     */
    private void publishSample() {
        float[] acc, gyr, rot;
        long ts;
        synchronized (accelLock) { acc = accelValues; ts = accelTimestamp; }
        synchronized (gyroLock) { gyr = gyroValues; }
        synchronized (rotationLock) { rot = rotationValues; }
        if (acc == null) return;

        JSObject obj = new JSObject();
        obj.put("ax", acc[0]);
        obj.put("ay", acc[1]);
        obj.put("az", acc[2]);
        obj.put("gx", gyr != null ? gyr[0] : 0);
        obj.put("gy", gyr != null ? gyr[1] : 0);
        obj.put("gz", gyr != null ? gyr[2] : 0);
        // 无姿态数据 → 空数组，JS 侧退化为不做注入（防错误旋转）
        obj.put("rotation", rot != null ? rotationToJSArray(rot) : new JSArray());
        obj.put("timestamp", ts);

        synchronized (sampleLock) {
            lastSample = obj;
        }
        notifyListeners("imuSample", obj);
    }

    /**
     * Android ROTATION_VECTOR → 标准四元数 [w,x,y,z]。
     * Android 输出 [x·sin(θ/2), y·sin(θ/2), z·sin(θ/2), cos(θ/2)]；
     * 部分机型只有前 3 分量，此时 w 由模长补齐。
     */
    private static JSArray rotationToJSArray(float[] values) {
        // 平台保证 ROTATION_VECTOR 至少 3 分量；防御性检查，异常 ROM 返回空数组（安全降级）
        if (values == null || values.length < 3) return new JSArray();
        double x = values[0], y = values[1], z = values[2];
        double w;
        if (values.length >= 4) {
            w = values[3];
        } else {
            double sq = x * x + y * y + z * z;
            if (sq > 1.0) {
                // 数值退化 → 归一化向量（缺 w，视为平面旋转，JS 侧仍可近似用）
                double inv = 1.0 / Math.sqrt(sq);
                x *= inv; y *= inv; z *= inv;
                w = 0;
            } else {
                w = Math.sqrt(1.0 - sq);
            }
        }
        // 预校验有限性：四元数出现 NaN/Infinity（传感器异常）时直接返回空数组，
        // 与「无姿态数据」降级路径一致（JS 侧 q.length<4 即安全跳过注入）。
        // 保证输出要么完整 4 元、要么空数组，绝不产生残缺的部分数组。
        if (!isFinite(w) || !isFinite(x) || !isFinite(y) || !isFinite(z)) {
            return new JSArray();
        }
        JSArray arr = new JSArray();
        try {
            arr.put(w);
            arr.put(x);
            arr.put(y);
            arr.put(z);
        } catch (JSONException e) {
            // put(double) 声明抛 JSONException；经预校验后均为有限值，此分支理论上不可达，仅防御
            Log.e(TAG, "Failed to build rotation quaternion JSON", e);
        }
        return arr;
    }

    /** 有限数判断（Double.isFinite 为 API 24+，minSdk 23 用手动实现兼容） */
    private static boolean isFinite(double d) {
        return !Double.isNaN(d) && !Double.isInfinite(d);
    }

    private void registerSensor(Sensor sensor) {
        if (sensor == null) return;
        // 传主线程 Handler：@PluginMethod 在 Capacitor 线程池执行，需指定 Looper 保证回调线程一致
        Handler mainHandler = new Handler(Looper.getMainLooper());
        boolean ok = sensorManager.registerListener(this, sensor, SAMPLING_PERIOD_US, mainHandler);
        Log.d(TAG, "Registered sensor type=" + sensor.getType() + " @10Hz ok=" + ok);
    }

    private void unregisterAll() {
        if (sensorManager != null) {
            sensorManager.unregisterListener(this);
        }
        synchronized (sampleLock) { lastSample = null; }
        synchronized (accelLock) { accelValues = null; }
        synchronized (gyroLock) { gyroValues = null; }
        synchronized (rotationLock) { rotationValues = null; }
        accelTimestamp = 0;
    }
}
