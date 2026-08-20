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
 *    低通 → 供 GPSManager 在每次滤波 update 前 feedImu() 注入离线 RTS 平滑器（KalmanFilter._offlineSmoother）的 CA 模型预测
 *    （仅运动学先验，GPS 仍是位置权威；实时定位已改用原始单次定位，无实时 ImmFilter）。
 *  - 姿态-加速度时间对齐（方向 1）：插件下发 rotationTs（姿态事件时间戳，纳秒），
 *    此处维护带时间戳的姿态环形缓冲，旋转加速度时按加速度事件时间戳查询最近姿态，
 *    避免加速度被旋转到"错误时刻的姿态"（加速度与姿态来自不同传感器异步到达）。
 *    旧插件无 rotationTs → 降级用加速度自身时间戳，行为与旧版等价，零回归。
 *  - 三轴输出（方向 2）：旋转后的 E/N/U 全部保留；U 轴（垂直）供海拔卡尔曼 CA 注入，
 *    并做 U 轴偏置统计估计重力泄漏量级（方向 6：姿态误差使约 g·sinε 的重力泄漏到
 *    水平轴，泄漏越大水平注入越不可信 → tiltLeakFactor 衰减）。
 *  - 不参与航向解算：heading 完全由 GPS 权威（_resolveHeading），IMU 不读陀螺仪融合。
 *  - 航向约束（方向 5 增强）：水平 E/N 注入依赖航向（ENU 旋转需航向信息），单靠加速度
 *    计不可观测航向（绕重力轴旋转无信息）。GPSManager 每次 fix 据航向来源/速度判定
 *    setHeadingReliable()，航向不可靠（低速起步/遮挡/丢星 → 回退差分航向）时水平注入被
 *    禁用、只保留 U 轴海拔注入（垂直不依赖航向，只依赖俯仰/翻滚，是加速度可观测部分）。
 *    IMU_HORIZONTAL_REQUIRE_HEADING=false 时恒可靠（回归旧行为）。
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
      this._buckets.push({ bucketIdx: -1, count: 0, sumE: 0, sumN: 0, sumU: 0 });
    }
    // 最新输出：低通后的 ENU 加速度 [东, 北, 天]（m/s²，三轴，U 供海拔 CA 注入），无数据为 null
    this._lastAccEnu = null;
    this._lastSampleTime = 0;  // 最近一次 IMU 事件时间戳（新鲜度判断，Date.now 毫秒）

    // 方向 1：姿态-加速度时间对齐——带时间戳的姿态环形缓冲
    // 姿态事件时间戳与加速度事件时间戳同源（Android sensor clock，纳秒）。
    this._rotBufMax = Math.max(4, C.IMU_ROT_BUF_MAX != null ? C.IMU_ROT_BUF_MAX : 32);
    this._rotBuf = [];
    const rotMaxDt = C.IMU_ROT_MAX_DT_MS != null ? C.IMU_ROT_MAX_DT_MS : 200;
    this._rotMaxDtNs = Math.max(0, rotMaxDt) * 1e6; // 毫秒 → 纳秒（与传感器时间戳同单位）

    // 方向 6：偏置/抖动统计——重力泄漏 + 三轴零偏估计（水平注入衰减依据）
    this._uRmsAlpha = Math.min(1, Math.max(0, C.IMU_U_RMS_LPF_ALPHA != null ? C.IMU_U_RMS_LPF_ALPHA : 0.2));
    this._uBiasAlpha = Math.min(1, Math.max(0, C.IMU_U_BIAS_LPF_ALPHA != null ? C.IMU_U_BIAS_LPF_ALPHA : 0.05));
    this._uBiasLowRmsMax = C.IMU_U_BIAS_LOW_RMS_MAX != null ? C.IMU_U_BIAS_LOW_RMS_MAX : 1.0;
    this._uRms = 0;   // U 轴短期抖动 RMS（低通）
    this._uBias = 0;  // U 轴长期偏置（低动态时更新，反映姿态误差导致的恒定重力泄漏）
    // 方向 6 扩展：E/N 轴零偏在线估计（传感器固有直流偏置，静止时 LINEAR_ACCELERATION
    // 应≈0，但实际有恒定偏移；不扣除会被滑窗均值+低通保留成持续虚假加速度注入 CA 预测，
    // 导致长期缓慢漂移）。仅"真静止"时学习（见 _stillSpeed），与 U 轴偏置共用该判定。
    this._eBias = 0;  // E 轴长期零偏（静止时更新）
    this._nBias = 0;  // N 轴长期零偏（静止时更新）
    this._biasStillSpeed = C.IMU_BIAS_STILL_SPEED != null ? C.IMU_BIAS_STILL_SPEED : 0.3; // GPS 速度 < 此值视为静止
    this._biasStillCount = 0; // 连续静止样本计数（偏置可信度：达到阈值才启用扣除）
    this._biasMinStill = C.IMU_BIAS_MIN_STILL != null ? C.IMU_BIAS_MIN_STILL : 30; // 至少 N 帧静止才启用扣除
    this._gpsSpeed = null; // 最近一次 GPS 速度（由 GPSManager.setGpsSpeed 注入，静止判定）

    // 方向 5 增强：水平 E/N 注入是否需要 GPS 航向可靠。单靠加速度计不可观测航向
    // （绕重力轴旋转无信息），航向缺失/低速时水平方向会差一个未知固定角 → 错误
    // 拉偏。故航向不可靠时禁用水平注入、只保留 U 轴海拔注入（垂直不依赖航向）。
    this._requireHeading = C.IMU_HORIZONTAL_REQUIRE_HEADING !== false;
    this._headingReliable = !this._requireHeading; // 默认：不要求则不依赖（恒可靠）
  }

  /**
   * 设置当前 GPS 航向是否可靠（由 GPSManager 在每次 fix 时依据航向来源/速度判定后调用）。
   * 仅当 IMU_HORIZONTAL_REQUIRE_HEADING=true 时生效；不要求航向时恒为 true。
   * @param {boolean} reliable 航向可靠（GPS 航向有效且非低速）→ true；低速起步/遮挡/丢星 → false
   */
  setHeadingReliable(reliable) {
    this._headingReliable = this._requireHeading ? !!reliable : true;
  }

  /**
   * 注入最近一次 GPS 解算速度（m/s，可能为 null）。
   * 用于 E/N/U 零偏估计的"真静止"判定：只有 GPS 速度低于 IMU_BIAS_STILL_SPEED 时
   * 才更新偏置，避免把运动加速度学进偏置（比单看 U 轴抖动 RMS 更准）。
   * 由 GPSManager 在每次 fix 时与 setHeadingReliable 一并调用。
   * @param {number|null} speed GPS 解算速度（m/s）
   */
  setGpsSpeed(speed) {
    this._gpsSpeed = (speed == null || !isFinite(speed)) ? null : speed;
  }

  /**
   * 当前是否处于"真静止"——偏置学习的唯一安全窗口。
   * 双判据：U 轴抖动 RMS 低（设备垂直动态小）+ GPS 速度低于静止阈值。
   * 任一不满足都不更新偏置，防止运动污染（方向 6 扩展）。
   */
  _isStill() {
    const gpsStill = this._gpsSpeed == null || this._gpsSpeed < this._biasStillSpeed;
    return this._uRms < this._uBiasLowRmsMax && gpsStill;
  }

  /** E/N/U 三轴零偏是否已足够可信（静止样本累积达标），启用扣除 */
  get biasReady() {
    return this._biasStillCount >= this._biasMinStill;
  }

  /** 是否可用（web 无插件 → false） */
  get hasData() {
    return !!(this._plugin && this._listening);
  }

  /**
   * 重力泄漏衰减因子（0~1，方向 6）。
   * 设备倾斜且姿态估计存在残余误差 ε 时，约 g·sin(ε) 的重力被泄漏到水平轴，
   * 该泄漏表现为 U 轴恒定偏置 |uBias|。泄漏越大 → 水平注入越不可信。
   * @returns {number} 1=无泄漏（正常注入），0=完全泄漏（禁止水平注入）
   */
  get tiltLeakFactor() {
    const g = (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.GRAVITY) || 9.81;
    const ratio = Math.min(1, Math.abs(this._uBias) / g);
    return 1 - ratio * ratio;
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
        if (CONFIG.DEBUG) Logger.warn('[IMU] 监听启动失败', err && err.message || err);
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
    this._rotBuf.length = 0;
    this._uRms = 0;
    this._uBias = 0;
    this._eBias = 0;
    this._nBias = 0;
    this._biasStillCount = 0;
    this._gpsSpeed = null;
    this._resetWindow();
  }

  /**
   * 获取最新 ENU 加速度 [东, 北, 天]（m/s²，已聚合 + 低通 + 限幅）。
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
      b.sumU = 0;
    }
  }

  /** 方向 1：推入带时间戳的姿态到环形缓冲（q 为 [w,x,y,z] 副本，防外部数组改动） */
  _pushRot(t, q) {
    this._rotBuf.push({ t, q: [q[0], q[1], q[2], q[3]] });
    if (this._rotBuf.length > this._rotBufMax) this._rotBuf.shift();
  }

  /**
   * 方向 1：查询 t 时刻（纳秒）最近的姿态。
   * @param {number} t 加速度事件时间戳（纳秒）
   * @returns {{t: number, q: number[]}|null} 时间差 ≤ IMU_ROT_MAX_DT_MS 的最近姿态；找不到返回 null
   */
  _queryRot(t) {
    const buf = this._rotBuf;
    let best = null;
    let bestDt = Infinity;
    for (let i = buf.length - 1; i >= 0; i--) {
      const dt = Math.abs(buf[i].t - t);
      if (dt < bestDt) { bestDt = dt; best = buf[i]; }
    }
    if (!best || bestDt > this._rotMaxDtNs) return null;
    return best;
  }

  /**
   * 方向 6：三轴零偏/抖动统计（重力泄漏 + E/N/U 零偏在线估计）。
   *  - _uRms：短期抖动（低通 |u|），反映垂直动态/设备晃动。
   *  - _uBias：U 轴长期偏置，仅"真静止"时更新（防运动加速度污染），反映姿态误差
   *    导致的恒定重力泄漏量级（供 tiltLeakFactor 衰减水平注入）。
   *  - _eBias/_nBias：E/N 轴零偏，同样仅"真静止"时更新，扣除后避免持续虚假加速度
   *    注入 CA 预测导致长期漂移。
   *  - _biasStillCount：连续静止帧计数（偏置可信度），仅达阈值后 biasReady 才启用扣除，
   *    避免运动段误学偏置立即污染输出。
   * @param {number} e 聚合后 E 轴加速度（m/s²）
   * @param {number} n 聚合后 N 轴加速度（m/s²）
   * @param {number} u 聚合后 U 轴加速度（m/s²）
   */
  _updateBiasStats(e, n, u) {
    this._uRms += this._uRmsAlpha * (Math.abs(u) - this._uRms);
    if (this._isStill()) {
      this._uBias += this._uBiasAlpha * (u - this._uBias);
      this._eBias += this._uBiasAlpha * (e - this._eBias);
      this._nBias += this._uBiasAlpha * (n - this._nBias);
      if (this._biasStillCount < this._biasMinStill) this._biasStillCount++;
    } else {
      // 非静止：偏置冻结（不学不遗忘），可信度随脱离静止缓慢衰减，
      // 防止一次长运动永久禁用扣除而偏置已过时（温漂场景）。
      if (this._biasStillCount > 0) this._biasStillCount--;
    }
  }

  /**
   * 10Hz 事件：滑窗聚合（桶式环形缓冲）→ 低通 → 输出三轴 ENU。
   * 每样本累加进「当前绝对桶号」对应桶，窗口为最近 _feedInterval 内所有桶；
   * 均值持续更新，GPS fix 任意时刻到达都能取到最新近 1s 均值。
   */
  _onSample(sample) {
    if (!sample || typeof sample !== 'object') return;
    const ax = Number(sample.ax), ay = Number(sample.ay), az = Number(sample.az);
    if (!isFinite(ax) || !isFinite(ay) || !isFinite(az)) return;
    const q = sample.rotation;
    if (!Array.isArray(q) || q.length < 4) return; // 无姿态 → 不做错误旋转（安全降级）

    const tsNs = Number(sample.timestamp) || 0;         // 加速度事件时间戳（纳秒）
    const rotTsNs = Number(sample.rotationTs) || tsNs;  // 姿态事件时间戳（纳秒；旧插件无字段 → 用加速度时间戳）

    // 方向 1：姿态-加速度时间对齐——推入带时间戳姿态，按加速度时间戳查最近姿态。
    // 旧插件无 rotationTs → rotTsNs=tsNs，缓冲中该姿态与查询键时差为 0，行为与旧版等价。
    if (tsNs > 0) this._pushRot(rotTsNs, q);
    let rotQ = q;
    if (tsNs > 0) {
      const matched = this._queryRot(tsNs);
      if (matched) rotQ = matched.q;
    }

    const accEnu = this._rotateAccToEnu([ax, ay, az], rotQ);
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
      b.sumU = 0;
    }
    b.count++;
    b.sumE += accEnu[0];
    b.sumN += accEnu[1];
    b.sumU += accEnu[2];

    // 窗口 = 最近 _feedInterval：绝对桶号 ≥ 当前桶号 - 桶数 + 1 的桶
    const winStartBucket = bucketIdx - this._bucketCount + 1;
    let sumE = 0, sumN = 0, sumU = 0, count = 0;
    for (let i = 0; i < this._bucketCount; i++) {
      const bb = this._buckets[i];
      if (bb.bucketIdx >= winStartBucket) {
        sumE += bb.sumE;
        sumN += bb.sumN;
        sumU += bb.sumU;
        count += bb.count;
      }
    }
    if (count <= 0) return;

    const inv = 1 / count;
    const meanE = sumE * inv;
    const meanN = sumN * inv;
    const meanU = sumU * inv;
    // 方向 6：三轴零偏/抖动统计（重力泄漏量级 + E/N/U 零偏估计，供注入端衰减/扣除）
    this._updateBiasStats(meanE, meanN, meanU);

    // 一阶低通（α=1 全信最新均值，α=0 保持旧值）+ 绝对安全上限限幅
    // （注入前的速度分级 clamp 在离线平滑器/AltKalmanFilter 侧按 GPS 速度动态收紧）
    // E/N 轴扣除在线零偏（biasReady 后启用）：剔除传感器固有直流偏移，防止持续虚假
    // 加速度注入 CA 预测导致长期漂移。U 轴偏置不在此扣除——它反映重力泄漏，交由
    // tiltLeakFactor 衰减水平注入（垂直 U 注入仍用原始均值，由 GPS 海拔权威零基准校正）。
    const eBias = this.biasReady ? this._eBias : 0;
    const nBias = this.biasReady ? this._nBias : 0;
    const meanE0 = meanE - eBias;
    const meanN0 = meanN - nBias;
    const a = this._lpfAlpha;
    const pe = this._lastAccEnu ? this._lastAccEnu[0] : meanE0;
    const pn = this._lastAccEnu ? this._lastAccEnu[1] : meanN0;
    const pu = this._lastAccEnu ? this._lastAccEnu[2] : meanU;
    const e = Math.max(-this._clamp, Math.min(this._clamp, pe + a * (meanE0 - pe)));
    const n = Math.max(-this._clamp, Math.min(this._clamp, pn + a * (meanN0 - pn)));
    const u = Math.max(-this._clamp, Math.min(this._clamp, pu + a * (meanU - pu)));
    this._lastAccEnu = [e, n, u];
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
