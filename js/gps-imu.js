/**
 * 圆圈地图 - GPS 定位（IMU 惯性传感器）
 * ============================================
 * gps.js 拆分文件：ImuManager（仅定位校准，加速度注入辅助滤波）。
 * 无共享常量依赖，可独立加载。
 */

/**
 * IMU 惯性传感器管理器 — 仅定位校准（加速度注入辅助滤波）。
 *
 * 职责收窄（本次重引入的唯一形态）：
 *  - 只消费 TYPE_LINEAR_ACCELERATION（去重力线性加速度）→ rotation 四元数旋转到 ENU
 *    地理系 → 滑窗均值（近 IMU_FEED_INTERVAL_MS 窗口，分桶环形缓冲持续输出）→ 一阶
 *    低通 → 供 GPSManager 在每次滤波 update 前 feedImu() 注入 ImmFilter CA 模型预测
 *    （仅运动学先验，GPS 仍是位置权威）。
 *  - 不参与航向解算：heading 完全由 GPS 权威（_resolveHeading），IMU 不读陀螺仪融合。
 *  - 不做航迹推算：无 setHighFrequency / onSample 推算路径 / predictOnly / DR 状态机。
 *  - web 端无 Capacitor 插件 → hasData=false，静默跳过，纯 GPS 行为零回归。
 *  - 生命周期随 GPSManager 的 watch 启停（startWatching → start，stopWatching → stop）。
 */
class ImuManager {
  constructor() {
    const C = (typeof CONFIG !== 'undefined' && CONFIG) || {};
    this._enabled = C.IMU_ENABLED !== false;
    this._feedInterval = C.IMU_FEED_INTERVAL_MS != null ? C.IMU_FEED_INTERVAL_MS : 1000;
    this._feedMaxAge = C.IMU_FEED_MAX_AGE_MS != null ? C.IMU_FEED_MAX_AGE_MS : 2000;
    const alpha = C.IMU_ACC_LPF_ALPHA != null ? C.IMU_ACC_LPF_ALPHA : 0.4;
    this._lpfAlpha = Math.min(1, Math.max(0, alpha));
    this._clamp = C.IMU_ACC_CLAMP != null ? C.IMU_ACC_CLAMP : 30;

    this._plugin = null;       // Capacitor.Plugins.ImuData 引用（web 端为 null）
    this._listening = false;   // 插件监听是否已启动
    this._starting = null;     // start() 的 Promise（防并发启动）
    this._handle = null;       // imuSample 事件监听器句柄

    // 滑窗聚合（桶式环形缓冲，预分配防 GC）：窗口时长=IMU_FEED_INTERVAL_MS，
    // 均分为 IMU_WIN_BUCKETS 个桶。每样本累加进当前桶，窗口随绝对桶号滑动，
    // 均值持续更新——GPS fix 任意时刻到达都能取到「最近 1s」均值（取代旧整窗
    // 「满窗才输出」，避免注入用上跨窗旧值）。
    const buckets = C.IMU_WIN_BUCKETS != null ? C.IMU_WIN_BUCKETS : 4;
    this._bucketCount = Math.max(1, Math.min(32, Math.round(buckets)));
    this._bucketMs = this._feedInterval / this._bucketCount;
    this._buckets = [];
    for (let i = 0; i < this._bucketCount; i++) {
      this._buckets.push({ bucketIdx: -1, count: 0, sumE: 0, sumN: 0 });
    }
    // 最新输出：低通后的水平 ENU 加速度 [东, 北]（m/s²），无数据为 null
    this._lastAccEnu = null;
    this._lastSampleTime = 0;  // 最近一次 IMU 事件时间戳（新鲜度判断）
  }

  /** 是否可用（web 无插件 → false） */
  get hasData() {
    return !!(this._plugin && this._listening);
  }

  /** 探测 Capacitor ImuData 插件（web 端 Capacitor 未注入时静默跳过，零回归） */
  _tryInitPlugin() {
    if (!this._enabled) return;
    try {
      const cap = typeof Capacitor !== 'undefined' ? Capacitor : null;
      const plugins = cap && cap.Plugins ? cap.Plugins : null;
      if (plugins && plugins.ImuData && typeof plugins.ImuData.startImuListening === 'function') {
        this._plugin = plugins.ImuData;
      }
    } catch (_) {}
  }

  /** 启动监听（10Hz 事件流，取决于原生 sensorDelay 档），重复调用自动忽略 */
  start() {
    if (!this._enabled || !this._plugin || this._listening || this._starting) {
      return Promise.resolve(false);
    }
    this._starting = (async () => {
      try {
        // 先注册监听器再启动：Java 端注册传感器后立即开始回调（10Hz），
        // 避免首批 imuSample 事件在监听器注册前被丢弃（与 GNSS 处理一致）。
        // Capacitor v3+ 的 addListener 返回 Promise<PluginListenerHandle>，必须 await。
        this._handle = await this._plugin.addListener('imuSample', (s) => this._onSample(s));
        try {
          await this._plugin.startImuListening();
        } catch (e) {
          // 启动失败 → 清理监听器，退化为不注入
          try { if (this._handle && this._handle.remove) this._handle.remove(); } catch (_) {}
          this._handle = null;
          throw e;
        }
        this._listening = true;
        this._resetWindow();
        return true;
      } catch (err) {
        if (CONFIG.DEBUG) console.warn('[IMU] 监听启动失败', err && err.message || err);
        return false;
      } finally {
        this._starting = null;
      }
    })();
    return this._starting;
  }

  /** 停止监听（释放传感器 + 清空缓存，防止陈旧数据注入） */
  stop() {
    this._starting = null;
    if (!this._plugin) return;
    this._listening = false;
    try {
      if (this._handle) {
        if (typeof this._handle.remove === 'function') this._handle.remove();
        this._handle = null;
      }
    } catch (_) { this._handle = null; }
    try { this._plugin.stopImuListening(); } catch (_) {}
    this._lastAccEnu = null;
    this._lastSampleTime = 0;
    this._resetWindow();
  }

  /**
   * 获取最新水平 ENU 加速度 [东, 北]（m/s²，已聚合 + 低通 + 限幅）。
   * 未启动 / 无数据 / 事件流过期（超过 IMU_FEED_MAX_AGE_MS 无新样本）→ 返回 null，
   * 调用方据此跳过注入（GPS 暂停节流或 IMU 中断时不喂陈旧数据）。
   */
  getLatestAccEnu() {
    if (!this._listening || !this._lastAccEnu) return null;
    if (this._lastSampleTime <= 0 || Date.now() - this._lastSampleTime > this._feedMaxAge) return null;
    return this._lastAccEnu;
  }

  _resetWindow() {
    for (let i = 0; i < this._bucketCount; i++) {
      const b = this._buckets[i];
      b.bucketIdx = -1;
      b.count = 0;
      b.sumE = 0;
      b.sumN = 0;
    }
  }

  /**
   * 10Hz 事件：滑窗聚合（桶式环形缓冲）→ 低通。
   * 每样本累加进「当前绝对桶号」对应桶，窗口为最近 _feedInterval 内所有桶；
   * 均值持续更新，GPS fix 任意时刻到达都能取到最新近 1s 均值。
   */
  _onSample(sample) {
    if (!sample || typeof sample !== 'object') return;
    const ax = Number(sample.ax), ay = Number(sample.ay), az = Number(sample.az);
    if (!isFinite(ax) || !isFinite(ay) || !isFinite(az)) return;
    const q = sample.rotation;
    if (!Array.isArray(q) || q.length < 4) return; // 无姿态 → 不做错误旋转（安全降级）
    const accEnu = this._rotateAccToEnu([ax, ay, az], q);
    if (!accEnu) return;

    const now = Date.now();
    this._lastSampleTime = now;

    // 绝对桶号（单调递增时间轴）→ 环形索引；桶号变更说明已滑出上一周期
    const bucketIdx = Math.floor(now / this._bucketMs);
    const b = this._buckets[bucketIdx % this._bucketCount];
    if (b.bucketIdx !== bucketIdx) {
      // 首次使用该桶位（新桶，替换的是更早周期的旧桶）→ 清零重开
      b.bucketIdx = bucketIdx;
      b.count = 0;
      b.sumE = 0;
      b.sumN = 0;
    }
    b.count++;
    b.sumE += accEnu[0];
    b.sumN += accEnu[1];

    // 窗口 = 最近 _feedInterval：绝对桶号 ≥ 当前桶号 - 桶数 + 1 的桶
    const winStartBucket = bucketIdx - this._bucketCount + 1;
    let sumE = 0, sumN = 0, count = 0;
    for (let i = 0; i < this._bucketCount; i++) {
      const bb = this._buckets[i];
      if (bb.bucketIdx >= winStartBucket) {
        sumE += bb.sumE;
        sumN += bb.sumN;
        count += bb.count;
      }
    }
    if (count <= 0) return;

    const inv = 1 / count;
    const meanE = sumE * inv;
    const meanN = sumN * inv;
    // 一阶低通（α=1 全信最新均值，α=0 保持旧值）+ 限幅
    const a = this._lpfAlpha;
    const pe = this._lastAccEnu ? this._lastAccEnu[0] : meanE;
    const pn = this._lastAccEnu ? this._lastAccEnu[1] : meanN;
    const e = Math.max(-this._clamp, Math.min(this._clamp, pe + a * (meanE - pe)));
    const n = Math.max(-this._clamp, Math.min(this._clamp, pn + a * (meanN - pn)));
    this._lastAccEnu = [e, n];
  }

  /**
   * 四元数旋转：设备系加速度 → 世界系 ENU（纯数学旋转工具，与航向解算无关）。
   * q = [w,x,y,z] 单位四元数，v' = q·v·q⁻¹，用简化公式
   *   t = 2·(xyz × v)，v' = v + w·t + xyz × t
   * @param {number[]} v 设备系线性加速度 [ax,ay,az]
   * @param {number[]} q 姿态四元数 [w,x,y,z]
   * @returns {number[]|null} ENU 加速度 [E,N,U]，四元数非法返回 null
   */
  _rotateAccToEnu(v, q) {
    const qw = Number(q[0]), qx = Number(q[1]), qy = Number(q[2]), qz = Number(q[3]);
    if (!isFinite(qw) || !isFinite(qx) || !isFinite(qy) || !isFinite(qz)) return null;
    let norm = qw * qw + qx * qx + qy * qy + qz * qz;
    if (!(norm > 0) || !isFinite(norm)) return null;
    norm = Math.sqrt(norm);
    const x = qx / norm, y = qy / norm, z = qz / norm, w = qw / norm;
    // t = 2·(xyz × v)
    const t1 = 2 * (y * v[2] - z * v[1]);
    const t2 = 2 * (z * v[0] - x * v[2]);
    const t3 = 2 * (x * v[1] - y * v[0]);
    // v' = v + w·t + xyz × t
    return [
      v[0] + w * t1 + (y * t3 - z * t2),
      v[1] + w * t2 + (z * t1 - x * t3),
      v[2] + w * t3 + (x * t2 - y * t1)
    ];
  }
}
