/**
 * 圆圈地图 - GPS 定位（海拔滤波链）
 * ============================================
 * gps.js 拆分文件：AltKalmanFilter（1D 自适应卡尔曼）+ AltFilterPipeline（实时
 * 流水线）+ AltRtsSmoother（离线 1D RTS）。三者完全独立于水平滤波，无共享常量。
 */

/**
 * 一维自适应卡尔曼滤波器 — 海拔专用（完全独立，不依赖水平 KalmanFilter）
 * 状态 [alt, vAlt]，1D 恒速模型。参数全部走 CONFIG.ALT_*，不读精度/水平速度。
 * 自适应机制：
 *  - 自适应 R：滑动残差窗口的鲁棒尺度 σ̂（MAD×1.4826）估计垂直观测噪声，
 *    R = clamp(σ̂², R_MIN, R_MAX)，环境安静时收紧、环境吵闹时放宽。
 *  - 自适应 Q：垂直速度 |vAlt| 越大 → 认为真实垂直运动越强 → Q 线性放大，
 *    使滤波器在高动态（爬坡/下降）时跟得上，静止时平滑。
 *  - 自适应 Huber：k = ALT_HUBER_K × σ̂（阈值随噪声尺度自动缩放），
 *    残差 |e| > k 时收缩到 k·sign(e)，抑制 GNSS 垂直粗差/尖刺。
 *  - vAlt 限幅：垂直速度估计钳制在 ±ALT_VELOCITY_LIMIT，防突发漂移。
 */
class AltKalmanFilter {
  constructor() {
    const C = (typeof CONFIG !== 'undefined' && CONFIG) || {};
    this._rBase = C.ALT_KALMAN_R_BASE != null ? C.ALT_KALMAN_R_BASE : 64;
    this._rMin = C.ALT_KALMAN_R_MIN != null ? C.ALT_KALMAN_R_MIN : 16;
    this._rMax = C.ALT_KALMAN_R_MAX != null ? C.ALT_KALMAN_R_MAX : 900;
    this._qBase = C.ALT_KALMAN_Q_BASE != null ? C.ALT_KALMAN_Q_BASE : 0.5;
    this._qMax = C.ALT_KALMAN_Q_MAX != null ? C.ALT_KALMAN_Q_MAX : 8;
    this._qRefVel = C.ALT_KALMAN_Q_REF_VEL != null ? C.ALT_KALMAN_Q_REF_VEL : 5;
    this._huberK = C.ALT_HUBER_K != null ? C.ALT_HUBER_K : 2.0;
    this._velLimit = C.ALT_VELOCITY_LIMIT != null ? C.ALT_VELOCITY_LIMIT : 30;
    this._win = Math.max(5, C.ALT_RESIDUAL_WINDOW != null ? C.ALT_RESIDUAL_WINDOW : 20);

    // 状态 [alt, vAlt]
    this._alt = 0;
    this._vAlt = 0;
    // 协方差 P（2×2 对称：p00 位置方差，p11 速度方差，p01 交叉）
    this._p00 = 0;
    this._p01 = 0;
    this._p11 = 0;
    this._lastTime = 0;
    this._initialized = false;
    this._lastFiltered = null;

    // 残差滑动窗口（环形缓冲，预分配，自适应 R/Huber 共用）
    this._residuals = new Float64Array(this._win);
    this._resIdx = 0;
    this._resCount = 0;
    this._sortBuf = new Float64Array(this._win);
    this._devBuf = new Float64Array(this._win);
    this._sigma = Math.sqrt(this._rBase); // 当前鲁棒尺度 σ̂
  }

  /** 重置（原地填充，避免 GC） */
  reset() {
    this._initialized = false;
    this._alt = 0;
    this._vAlt = 0;
    this._p00 = 0;
    this._p01 = 0;
    this._p11 = 0;
    this._lastFiltered = null;
    this._resIdx = 0;
    this._resCount = 0;
    this._sigma = Math.sqrt(this._rBase);
  }

  /** 以当前测量初始化 */
  init(alt, time) {
    this._alt = alt;
    this._vAlt = 0;
    this._p00 = 2500;   // 初始位置不确定度 50m → 方差 2500
    this._p01 = 0;
    this._p11 = 25;     // 初始垂直速度不确定度 5m/s → 方差 25
    this._lastTime = time;
    this._initialized = true;
    this._lastFiltered = alt;
    this._resIdx = 0;
    this._resCount = 0;
  }

  /** 残差入窗并更新鲁棒尺度 σ̂（MAD×1.4826） */
  _pushResidual(e) {
    this._residuals[this._resIdx] = e;
    this._resIdx = (this._resIdx + 1) % this._win;
    if (this._resCount < this._win) this._resCount++;
    if (this._resCount < 5) return; // 窗口未热，保持初始 σ
    // 按时间顺序拷贝窗口 → 排序取中位数
    const n = Math.min(this._resCount, this._win);
    for (let i = 0; i < n; i++) {
      this._sortBuf[i] = this._residuals[(this._resIdx - n + i + this._win * 2) % this._win];
    }
    Array.prototype.sort.call(this._sortBuf.subarray(0, n), (a, b) => a - b);
    const med = n % 2
      ? this._sortBuf[(n - 1) >> 1]
      : (this._sortBuf[n / 2 - 1] + this._sortBuf[n / 2]) / 2;
    for (let i = 0; i < n; i++) this._devBuf[i] = Math.abs(this._sortBuf[i] - med);
    Array.prototype.sort.call(this._devBuf.subarray(0, n), (a, b) => a - b);
    const mad = n % 2
      ? this._devBuf[(n - 1) >> 1]
      : (this._devBuf[n / 2 - 1] + this._devBuf[n / 2]) / 2;
    const s = 1.4826 * mad;
    // 尺度下限保护：至少对应 R_MIN 的 σ，防止滤波器过度自信
    this._sigma = Math.max(Math.sqrt(this._rMin), s);
  }

  /**
   * 更新测量 → 返回滤波后海拔
   * @param {number} zAlt 原始海拔（米）
   * @param {number} time 时间戳（毫秒）
   * @returns {number} 滤波后海拔
   */
  update(zAlt, time) {
    if (!this._initialized) {
      this.init(zAlt, time);
      return zAlt;
    }
    const dt = (time - this._lastTime) / 1000;
    this._lastTime = time;
    if (dt <= 0 || dt > 60) {
      this.init(zAlt, time);
      return zAlt;
    }

    // ── Predict ──
    const altPred = this._alt + this._vAlt * dt;
    // 自适应 Q：|vAlt| 大 → 真实垂直动态强 → Q 线性放大
    const q = Math.min(this._qMax, this._qBase * (1 + Math.abs(this._vAlt) / this._qRefVel));
    const dt2 = dt * dt;
    const q00 = 0.25 * q * q * dt2 * dt2;
    const q01 = 0.5 * q * q * dt2 * dt;
    const q11 = q * q * dt2;
    const p00p = this._p00 + 2 * this._p01 * dt + this._p11 * dt2 + q00;
    const p01p = this._p01 + this._p11 * dt + q01;
    const p11p = this._p11 + q11;

    // ── innovation ──
    let e = zAlt - altPred;
    this._pushResidual(e);
    // 自适应 R：鲁棒残差尺度平方
    const R = Math.max(this._rMin, Math.min(this._rMax, this._sigma * this._sigma));
    // 自适应 Huber：k = ALT_HUBER_K × σ̂（随噪声尺度缩放）
    const k = this._huberK * this._sigma;
    if (Math.abs(e) > k) e = Math.sign(e) * k;

    // ── Update ──
    const S = p00p + R;
    if (!(S > 1e-9)) {
      this.init(zAlt, time);
      return zAlt;
    }
    const K0 = p00p / S;
    const K1 = p01p / S;
    let alt = altPred + K0 * e;
    let vAlt = this._vAlt + K1 * e;
    // vAlt 限幅
    if (vAlt > this._velLimit) vAlt = this._velLimit;
    else if (vAlt < -this._velLimit) vAlt = -this._velLimit;
    this._alt = alt;
    this._vAlt = vAlt;
    // P⁺ = (I − K·H)·P⁻
    this._p00 = p00p * (1 - K0);
    this._p01 = p01p * (1 - K0);
    this._p11 = p11p - K1 * p01p;
    this._lastFiltered = alt;
    return alt;
  }
}

/**
 * 海拔实时滤波流水线（L2 自适应卡尔曼 + L3 中值预滤波 / 自适应 Huber）
 * 消费：原始海拔 + 口径来源（gga/browser）+ 时间戳，完全独立。
 * - zAlt == null（弱信号/无海拔源）→ 清窗 + 重置卡尔曼，返回 null（不内插）。
 * - 口径切换（GGA 椭球高 ↔ 浏览器 altitude）→ 重置，避免平台基准跳变。
 */
class AltFilterPipeline {
  constructor() {
    const C = (typeof CONFIG !== 'undefined' && CONFIG) || {};
    this.enabled = C.ALT_FILTER_ENABLED !== false;
    this._winSize = Math.max(3, C.ALT_MEDIAN_WINDOW != null ? C.ALT_MEDIAN_WINDOW : 5);
    this._window = [];         // 中值预滤波窗口
    this._lastSource = null;   // 口径来源（gga/browser）
    this._kf = new AltKalmanFilter();
  }

  reset() {
    this._window.length = 0;
    this._lastSource = null;
    this._kf.reset();
  }

  /**
   * 推入一个原始海拔 → 返回滤波后海拔
   * @param {number|null} zAlt 原始海拔（米），null 表示无海拔源
   * @param {string} source 口径来源：'gga' | 'browser'
   * @param {number} time 时间戳（毫秒）
   * @returns {number|null}
   */
  push(zAlt, source, time) {
    if (zAlt == null || !Number.isFinite(zAlt)) {
      this.reset();
      return null;
    }
    if (!this.enabled) return zAlt; // 总开关关闭 → 原始透传
    if (source !== this._lastSource) {
      this._lastSource = source;
      this._window.length = 0;
      this._kf.reset();
    }
    // L3 中值预滤波（去瞬态尖刺，窗口满前透传）
    this._window.push(zAlt);
    if (this._window.length > this._winSize) this._window.shift();
    let med = zAlt;
    if (this._window.length >= 3) {
      const sorted = this._window.slice().sort((a, b) => a - b);
      med = sorted[(sorted.length - 1) >> 1];
    }
    // L2 自适应卡尔曼 + 自适应 Huber
    return this._kf.update(med, time);
  }
}

/**
 * 离线 1D RTS 平滑 — 海拔专用（完全独立，不调用水平 smoothTrail）
 * 前向：AltKalmanFilter 逐点过滤（自适应 Q/R/Huber）
 * 反向：固定权重 α = ALT_RTS_ALPHA_MAX 的简化递推
 *   out[i] = fwd[i]·(1−α) + out[i+1]·α
 * 用未来测量修正历史海拔，显著降低实时滤波的滞后与抖动。
 * null 点冻结：前向沿用上一值、重置滤波器；输出保持 null（不内插）。
 * @param {Array<{altitude?:number,time:number}>} seq 原始序列（升序）
 * @returns {Array<number|null>} 平滑后海拔序列（与输入等长）
 */
class AltRtsSmoother {
  constructor() {
    const C = (typeof CONFIG !== 'undefined' && CONFIG) || {};
    this.enabled = C.ALT_FILTER_RTS_ENABLED !== false;
    this._alpha = C.ALT_RTS_ALPHA_MAX != null ? C.ALT_RTS_ALPHA_MAX : 0.3;
  }

  smooth(seq) {
    if (!Array.isArray(seq) || seq.length === 0) return [];
    const n = seq.length;
    if (n === 1) return [seq[0].altitude != null ? seq[0].altitude : null];

    // ── 前向过滤 ──
    const kf = new AltKalmanFilter();
    const fwd = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const z = seq[i].altitude;
      if (z == null || !Number.isFinite(z)) {
        if (i > 0) fwd[i] = fwd[i - 1]; // 冻结
        kf.reset();
        continue;
      }
      fwd[i] = kf.update(z, seq[i].time);
    }

    // ── 反向递推 ──
    const alpha = Math.min(Math.max(this._alpha, 0), 1);
    const out = new Array(n);
    out[n - 1] = seq[n - 1].altitude != null ? fwd[n - 1] : null;
    for (let i = n - 2; i >= 0; i--) {
      if (seq[i].altitude == null || !Number.isFinite(seq[i].altitude)) {
        out[i] = null; // null 点不内插，保持缺口
        continue;
      }
      const next = out[i + 1] != null ? out[i + 1] : fwd[i]; // 后一有效值
      out[i] = fwd[i] * (1 - alpha) + next * alpha;
    }
    return out;
  }
}
