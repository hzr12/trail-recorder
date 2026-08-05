package com.hzr.circlemap.plugins.gnss;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.GnssStatus;
import android.location.LocationManager;
import android.location.OnNmeaMessageListener;
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
import com.getcapacitor.annotation.Permission;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/**
 * GNSS 原始数据插件。
 *
 * 桥接 Android LocationManager 的卫星状态和 NMEA 数据到 JavaScript。
 * 可获取：卫星数、信噪比、星座类型、仰角/方位角、NMEA 原始语句。
 *
 * 事件:
 *   - "gnssStatus"   : GnssSatelliteInfo[] — 卫星状态更新 (~1s/次)
 *   - "nmeaSentence" : GnssNmeaData        — 每收到一条 NMEA 语句触发
 */
@CapacitorPlugin(
    name = "GnssData",
    permissions = {
        @Permission(
            alias = "location",
            strings = { Manifest.permission.ACCESS_FINE_LOCATION }
        )
    }
)
public class GnssDataPlugin extends Plugin {

    private static final String TAG = "GnssDataPlugin";
    private static final int MAX_NMEA_CACHE = 50;

    private LocationManager locationManager;
    private GnssStatus.Callback gnssCallback;
    private OnNmeaMessageListener nmeaListener;

    // 使用 synchronized 保护的线程安全列表
    private final Object satelliteLock = new Object();
    private final List<GnssSatelliteInfo> lastSatellites = new ArrayList<>();

    private final Object nmeaLock = new Object();
    private final ArrayDeque<GnssNmeaData> lastNmeaSentences = new ArrayDeque<>();

    // ──────────────────────────────────────────────
    // Plugin lifecycle
    // ──────────────────────────────────────────────

    @Override
    public void load() {
        super.load();
        Context ctx = getContext();
        if (ctx != null) {
            locationManager = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
            Log.d(TAG, "Plugin loaded");
        }
    }

    /**
     * Activity 销毁时释放 GNSS 回调，防止内存泄漏。
     */
    @Override
    public void handleOnDestroy() {
        if (locationManager != null) {
            unregisterGnssCallback();
            unregisterNmeaListener();
        }
        super.handleOnDestroy();
    }

    // ──────────────────────────────────────────────
    // Plugin methods (exposed to JS)
    // ──────────────────────────────────────────────

    /**
     * 开始监听 GNSS 原始数据。
     * 需要 ACCESS_FINE_LOCATION 权限（已在 @CapacitorPlugin 中声明）。
     *
     * 启动后:
     *   - 卫星状态通过 "gnssStatus" 事件推送
     *   - NMEA 语句通过 "nmeaSentence" 事件推送
     */
    @PluginMethod
    public void startGnssListening(PluginCall call) {
        if (locationManager == null) {
            call.reject("LocationManager not available");
            return;
        }

        // ⚠️ 不要用 Capacitor 的 hasPermission("location") alias 检查
        // 原因：浏览器 Geolocation 与 Capacitor plugin 的权限别名不同步，
        // 例如：Geolocation API 已工作（精度 5m）但 GnssDataPlugin 的 alias 仍为 not granted
        // 直接用 Android 系统权限检查，拿到的就是 LocationManager 真实可用的状态
        Context ctx = getContext();
        if (ctx == null) {
            call.reject("Plugin context not available", "NO_CONTEXT");
            return;
        }
        int perm = ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION);
        if (perm != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "ACCESS_FINE_LOCATION not granted (system check), but trying anyway — " +
                    "LocationManager may have its own grant from prior browser Geolocation flow");
            // 不直接 reject，让 try/catch 兜底。LocationManager 内部会再次校验权限。
        } else {
            Log.d(TAG, "ACCESS_FINE_LOCATION granted (system check)");
        }

        try {
            registerGnssCallback();
            registerNmeaListener();
            Log.d(TAG, "GNSS listening started");
            call.resolve();
        } catch (SecurityException e) {
            // 真的没权限时 LocationManager 会抛这个
            Log.w(TAG, "SecurityException during GNSS start: " + e.getMessage());
            // 清理可能已成功注册的部分（registerGnssCallback 可能已注册 GnssStatus callback）
            unregisterGnssCallback();
            unregisterNmeaListener();
            call.reject("Location permission denied: " + e.getMessage(), "PERMISSION_DENIED");
        } catch (Exception e) {
            Log.e(TAG, "Failed to start GNSS listening", e);
            // 同上，catch-all 路径也清理
            unregisterGnssCallback();
            unregisterNmeaListener();
            call.reject("Failed to start GNSS listening: " + e.getMessage(), "UNKNOWN_ERROR");
        }
    }

    /**
     * 停止监听 GNSS 原始数据，释放回调。
     */
    @PluginMethod
    public void stopGnssListening(PluginCall call) {
        try {
            unregisterGnssCallback();
            unregisterNmeaListener();
            Log.d(TAG, "GNSS listening stopped");
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "Failed to stop GNSS listening", e);
            call.reject("Failed to stop: " + e.getMessage(), "UNKNOWN_ERROR");
        }
    }

    /**
     * 返回最后一次缓存的卫星列表和 NMEA 语句快照。
     */
    @PluginMethod
    public void getLastGnssData(PluginCall call) {
        JSObject result = new JSObject();
        synchronized (satelliteLock) {
            result.put("satellites", satellitesToJSArray(lastSatellites));
        }
        synchronized (nmeaLock) {
            result.put("nmea", nmeaToJSArray(lastNmeaSentences));
        }
        call.resolve(result);
    }

    // ──────────────────────────────────────────────
    // GnssStatus.Callback (API 24+)
    // ──────────────────────────────────────────────

    private void registerGnssCallback() {
        if (gnssCallback != null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            gnssCallback = new GnssStatus.Callback() {
                @Override
                public void onSatelliteStatusChanged(GnssStatus status) {
                    handleSatelliteStatus(status);
                }

                @Override
                public void onStarted() {
                    Log.d(TAG, "GnssStatus callback started");
                }

                @Override
                public void onStopped() {
                    Log.d(TAG, "GnssStatus callback stopped");
                }

                @Override
                public void onFirstFix(int ttffMillis) {
                    Log.d(TAG, "First fix in " + ttffMillis + "ms");
                }
            };

            try {
                // 必须传 Handler → 主线程 Looper。原因：
                // 单参数 registerGnssStatusCallback(callback) 要求调用方必须是 Looper 线程，
                // 但 Capacitor @PluginMethod 默认在线程池里跑，不是 Looper。
                // 传 Handler 后 callback 固定在主线程触发，回调和 notifyListeners 都在 Looper 上，不会丢事件。
                Handler mainHandler = new Handler(Looper.getMainLooper());
                boolean registered = locationManager.registerGnssStatusCallback(gnssCallback, mainHandler);
                Log.d(TAG, "GnssStatus.Callback registered=" + registered + " on mainLooper");
            } catch (SecurityException e) {
                gnssCallback = null;
                throw e;
            } catch (IllegalArgumentException e) {
                // API 24/25 上某些 ROM 的 registerGnssStatusCallback 仍然单参数重载不识别
                // 无参 fallback 一次
                Log.w(TAG, "registerGnssStatusCallback(handler) failed, fallback: " + e.getMessage());
                try {
                    locationManager.registerGnssStatusCallback(gnssCallback);
                    Log.d(TAG, "GnssStatus.Callback registered via no-arg fallback");
                } catch (Exception e2) {
                    gnssCallback = null;
                    throw e2;
                }
            }
        } else {
            Log.w(TAG, "GnssStatus.Callback requires API 24+, current API: "
                    + Build.VERSION.SDK_INT + " — satellite detail unavailable");
        }
    }

    private void unregisterGnssCallback() {
        if (gnssCallback != null && locationManager != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                locationManager.unregisterGnssStatusCallback(gnssCallback);
            }
            gnssCallback = null;
            synchronized (satelliteLock) {
                lastSatellites.clear();
            }
            Log.d(TAG, "GnssStatus.Callback unregistered");
        }
    }

    /**
     * 处理 GnssStatus 更新，提取卫星信息并推送到 JS。
     */
    private void handleSatelliteStatus(GnssStatus status) {
        // 构建本地快照，避免长时间持有锁
        List<GnssSatelliteInfo> snapshot = new ArrayList<>();
        int count = status.getSatelliteCount();

        for (int i = 0; i < count; i++) {
            GnssSatelliteInfo info = new GnssSatelliteInfo(
                    status.getSvid(i),
                    constellationTypeToString(status.getConstellationType(i)),
                    status.getCn0DbHz(i),
                    status.getElevationDegrees(i),
                    status.getAzimuthDegrees(i),
                    status.usedInFix(i),
                    status.hasEphemerisData(i),
                    status.hasAlmanacData(i)
            );
            snapshot.add(info);
        }

        // 更新共享列表（持锁时间最短）
        synchronized (satelliteLock) {
            lastSatellites.clear();
            lastSatellites.addAll(snapshot);
        }

        // 推送给 JS 监听器（使用本地快照，不持锁）
        JSObject event = new JSObject();
        event.put("satellites", satellitesToJSArray(snapshot));
        notifyListeners("gnssStatus", event);

        Log.d(TAG, "Satellites: " + count
                + " (used: " + countUsed(snapshot)
                + ", avg SNR: " + String.format("%.1f", avgSnr(snapshot)) + " dB-Hz)");
    }

    // ──────────────────────────────────────────────
    // NMEA Listener
    // ──────────────────────────────────────────────

    private void registerNmeaListener() {
        if (nmeaListener != null) return;

        // API 24+ 才有 OnNmeaMessageListener
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            Log.w(TAG, "NMEA listener requires API 24+, current API: "
                    + Build.VERSION.SDK_INT + " — NMEA unavailable");
            return;
        }

        nmeaListener = (sentence, timestamp) -> {
            GnssNmeaData data = new GnssNmeaData(timestamp, sentence);

            // 缓存（限制数量防内存泄漏）
            synchronized (nmeaLock) {
                if (lastNmeaSentences.size() >= MAX_NMEA_CACHE) {
                    lastNmeaSentences.pollFirst(); // O(1)
                }
                lastNmeaSentences.addLast(data);
            }

            // 推送给 JS
            notifyListeners("nmeaSentence", data.toJSObject());

            Log.v(TAG, "NMEA: " + sentence.trim());
        };

        try {
            // 同样传主线程 handler — 避免 capacitor 线程池不是 looper 线程导致 callback 永远不触发
            Handler mainHandler = new Handler(Looper.getMainLooper());
            boolean added = locationManager.addNmeaListener(nmeaListener, mainHandler);
            Log.d(TAG, "NmeaListener registered=" + added + " on mainLooper");
        } catch (SecurityException e) {
            nmeaListener = null;
            throw e;
        }
    }

    private void unregisterNmeaListener() {
        if (nmeaListener != null && locationManager != null) {
            locationManager.removeNmeaListener(nmeaListener);
            nmeaListener = null;
            synchronized (nmeaLock) {
                lastNmeaSentences.clear();
            }
            Log.d(TAG, "NmeaListener unregistered");
        }
    }

    // ──────────────────────────────────────────────
    // Helpers
    // ──────────────────────────────────────────────

    /**
     * Android GnssStatus 星座类型码 → 可读名称。
     */
    private static String constellationTypeToString(int type) {
        switch (type) {
            case GnssStatus.CONSTELLATION_GPS:     return "GPS";
            case GnssStatus.CONSTELLATION_SBAS:    return "SBAS";
            case GnssStatus.CONSTELLATION_GLONASS: return "GLONASS";
            case GnssStatus.CONSTELLATION_QZSS:    return "QZSS";
            case GnssStatus.CONSTELLATION_BEIDOU:  return "BEIDOU";
            case GnssStatus.CONSTELLATION_GALILEO: return "GALILEO";
            case GnssStatus.CONSTELLATION_IRNSS:   return "IRNSS";
            default: return "UNKNOWN";
        }
    }

    private static JSArray satellitesToJSArray(List<GnssSatelliteInfo> sats) {
        JSArray arr = new JSArray();
        for (GnssSatelliteInfo sat : sats) {
            arr.put(sat.toJSObject());
        }
        return arr;
    }

    private static JSArray nmeaToJSArray(ArrayDeque<GnssNmeaData> nmeaQueue) {
        JSArray arr = new JSArray();
        // 按时间倒序，最新的在前
        Object[] array = nmeaQueue.toArray();
        for (int i = array.length - 1; i >= 0; i--) {
            arr.put(((GnssNmeaData) array[i]).toJSObject());
        }
        return arr;
    }

    /** 计算参与定位的卫星数 */
    private static int countUsed(List<GnssSatelliteInfo> sats) {
        int n = 0;
        for (GnssSatelliteInfo s : sats) {
            if (s.isUsedInFix()) n++;
        }
        return n;
    }

    /** 计算平均信噪比（仅 usedInFix 的卫星） */
    private static double avgSnr(List<GnssSatelliteInfo> sats) {
        double sum = 0;
        int n = 0;
        for (GnssSatelliteInfo s : sats) {
            if (s.isUsedInFix()) {
                sum += s.getCn0DbHz();
                n++;
            }
        }
        return n > 0 ? sum / n : 0;
    }
}
