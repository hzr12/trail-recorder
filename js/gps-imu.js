/**
 * 圆圈地图 - GPS 定位（IMU 惯性传感器）
 * ============================================
 * gps.js 拆分文件：ImuManager（仅海拔垂直校准：U 轴加速度注入）。
 * 无共享常量依赖，可独立加载。
 */

/**
 * IMU 惯性传感器管理器 — 仅海拔垂直校准（U 轴加速度注入）。
 *
 * 职责：
 *  - 只消费 TYPE_LINEAR_ACCELERATION（去重力线性加速度）→ rotation 四元数旋转到 ENU
 *    地理系 → 滑窗均值（近 IMU_FEED_INTERVAL_MS 窗口，分桶环形缓冲持续输出）→ 一阶
 *    低通 → 输出 [E, N, U]。GPSManager 只取 U 轴注入海拔卡尔曼的 CA 预测。
 *  - 姿态-加速度时间对齐：插件下发 rotationTs（姿态事件时间戳，纳秒），
 *    此处维护带时间戳的姿态环形缓冲，旋转加速度时按加速度事件时间戳查询最近姿态，
 *    避免加速度被旋转到"错误时刻的姿态"（加速度与姿态来自不同传感器异步到达）。
 *    旧插件无 rotationTs → 降级用加速度自身时间戳，行为与旧版等价，零回归。
 *  - 不参与航向解算：heading 完全由 GPS 权威（_resolveHeading），IMU 不读陀螺仪融合。
 *  - 水平 [E, N] 不再注入：实时 2D 位置滤波（原 ImmFilter）已删除。单靠加速度计在
 *    数学上不可观测航向（绕重力轴旋转无信息），盲注会给轨迹引入一个未知固定角偏差。
 *    U 轴仍注入（垂直只依赖俯仰/翻滚，是加速度可观测部分，且不需要航向信息）。
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
    // 最新输出：低通后的 ENU 加速度 [东, 北, 天]（m/s²），无数据为 null。
    // 三轴一并保留（四元数旋转一次即得三轴，零额外成本），下游只消费 U 轴。
    this._lastAccEnu = null;
    this._lastSampleTime = 0;  // 最近一次 IMU 事件时间戳（新鲜度判断，Date.now 毫秒）

    // 榨插件 P5：陀螺仪通道（gx/gy/gz 此前上桥未消费）
    // _turnDeltaDeg：自上次排水累计的罗盘转角（度，顺时针为正）——低速转弯强制采样
    // _headingDeltaDeg：自基线重置累计的罗盘转角——短时航向桥（GPS 航向缺失时）
    // 陀螺仪不改变「GPS 航向权威」架构：转弯检测只触发采样决策，航向桥只影响箭头显示。
    this._lastGyroTsNs = 0;
    this._turnDeltaDeg = 0;
    this._headingDeltaDeg = 0;
    this._lastTurnDrainAt = 0;
    this._turnDeadband = C.IMU_TURN_DEADBAND != null ? C.IMU_TURN_DEADBAND : 0.01;
    this._turnRateClamp = C.IMU_TURN_RATE_CLAMP != null ? C.IMU_TURN_RATE_CLAMP : 3.0;
    this._turnStaleMs = C.IMU_TURN_STALE_MS != null ? C.IMU_TURN_STALE_MS : 5000;

    // 姿态-加速度时间对齐——带时间戳的姿态环形缓冲
    // 姿态事件时间戳与加速度事件时间戳同源（Android sensor clock，纳秒）。
    this._rotBufMax = Math.max(4, C.IMU_ROT_BUF_MAX != null ? C.IMU_ROT_BUF_MAX : 32);
    this._rotBuf = [];
    const rotMaxDt = C.IMU_ROT_MAX_DT_MS != null ? C.IMU_ROT_MAX_DT_MS : 200;
    this._rotMaxDtNs = Math.max(0, rotMaxDt) * 1e6; // 毫秒 → 纳秒（与传感器时间戳同单位）
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
    this._lastGyroTsNs = 0;
    this._turnDeltaDeg = 0;
    this._headingDeltaDeg = 0;
    this._lastTurnDrainAt = 0;
    this._rotBuf.length = 0;
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

  /**
   * 排水：返回自上次调用以来累计的罗盘转角（度，顺时针为正），并清零累计器。
   * 消费方：App 转弯强制采样（每定位周期调用一次）。距上次排水超过 IMU_TURN_STALE_MS
   * （非记录期/跨会话）视为陈旧，直接清零返回 0，防旧转角误触发采样。
   * 未监听（web 无插件）→ 返回 null，调用方跳过（零回归）。
   * @returns {number|null}
   */
  drainTurnDelta() {
    if (!this._listening) return null;
    const now = Date.now();
    if (this._lastTurnDrainAt && now - this._lastTurnDrainAt > this._turnStaleMs) {
      this._turnDeltaDeg = 0;
    }
    this._lastTurnDrainAt = now;
    const d = this._turnDeltaDeg;
    this._turnDeltaDeg = 0;
    return isFinite(d) ? d : null;
  }

  /**
   * 航向桥读取：返回自基线重置以来累计的罗盘转角（度，顺时针为正）。
   * 非破坏性（不清零）——中间定位点不消费积分，保证「基线→桥」全程转角完整。
   * 基线由 GPSManager 在取得权威航向时调 resetHeadingDelta() 重置。
   * 未监听 → null。
   * @returns {number|null}
   */
  readHeadingDelta() {
    if (!this._listening) return null;
    const d = this._headingDeltaDeg;
    return isFinite(d) ? d : null;
  }

  /**
   * 航向桥基线重置（GPSManager 取得 GPS 权威航向 / 差分航向更新时调用）。
   */
  resetHeadingDelta() {
    this._headingDeltaDeg = 0;
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

  /** 推入带时间戳的姿态到环形缓冲（q 为 [w,x,y,z] 副本，防外部数组改动） */
  _pushRot(t, q) {
    this._rotBuf.push({ t, q: [q[0], q[1], q[2], q[3]] });
    if (this._rotBuf.length > this._rotBufMax) this._rotBuf.shift();
  }

  /**
   * 查询 t 时刻（纳秒）最近的姿态。
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

    // 姿态-加速度时间对齐：推入带时间戳姿态，按加速度时间戳查最近姿态。
    // 旧插件无 rotationTs → rotTsNs=tsNs，缓冲中该姿态与查询键时差为 0，行为与旧版等价。
    if (tsNs > 0) this._pushRot(rotTsNs, q);
    let rotQ = q;
    if (tsNs > 0) {
      const matched = this._queryRot(tsNs);
      if (matched) rotQ = matched.q;
    }

    const accEnu = this._rotateAccToEnu([ax, ay, az], rotQ);
    if (!accEnu) return;

    // 榨插件 P5：陀螺仪通道——同姿态把角速度旋到 ENU，U 轴即绕重力轴角速率。
    // 罗盘航向（顺时针为正）角速率 = -ω_z_ENU；按传感器时间戳差分积分累计转角。
    // gx/gy/gz 缺失/非法/时间戳回跳 → 只推进基线不积分（安全降级，仅丢失转弯辅助）。
    const gx = Number(sample.gx), gy = Number(sample.gy), gz = Number(sample.gz);
    if (isFinite(gx) && isFinite(gy) && isFinite(gz) && tsNs > 0) {
      const prevGyroTs = this._lastGyroTsNs;
      this._lastGyroTsNs = tsNs;
      if (prevGyroTs > 0 && tsNs > prevGyroTs) {
        const gyroDt = (tsNs - prevGyroTs) / 1e9; // 秒
        if (gyroDt > 0 && gyroDt <= 1.0) { // 正常 10Hz≈0.1s；超 1s 视为流中断不积分
          const gyroEnu = this._rotateAccToEnu([gx, gy, gz], rotQ);
          if (gyroEnu) {
            let w = -gyroEnu[2]; // 罗盘航向角速率（rad/s，顺时针为正）
            if (w > this._turnDeadband || w < -this._turnDeadband) {
              if (w > this._turnRateClamp) w = this._turnRateClamp;
              else if (w < -this._turnRateClamp) w = -this._turnRateClamp;
              const degDelta = w * gyroDt * 180 / Math.PI;
              this._turnDeltaDeg += degDelta;
              this._headingDeltaDeg += degDelta;
            }
          }
        }
      }
    }

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

    // 一阶低通（α=1 全信最新均值，α=0 保持旧值）+ 绝对安全上限限幅（防传感器粗差）。
    // 注入强度缩放与按 GPS 速度分级 clamp 在海拔侧（ALT_IMU_TRUST / ALT_IMU_U_CLAMP_LEVELS）。
    const a = this._lpfAlpha;
    const pe = this._lastAccEnu ? this._lastAccEnu[0] : meanE;
    const pn = this._lastAccEnu ? this._lastAccEnu[1] : meanN;
    const pu = this._lastAccEnu ? this._lastAccEnu[2] : meanU;
    const e = Math.max(-this._clamp, Math.min(this._clamp, pe + a * (meanE - pe)));
    const n = Math.max(-this._clamp, Math.min(this._clamp, pn + a * (meanN - pn)));
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
