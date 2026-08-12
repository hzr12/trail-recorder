/**
 * 圆圈地图 - GPS 定位（交互式多模型实时滤波）
 * ============================================
 * gps.js 拆分文件：ImmFilter（实时定位 IMM 滤波器）。
 * 依赖 gps-kalman.js 的全局常量 DEG2RAD / M_PER_DEG，必须在其后加载。
 */

/**
 * 交互式多模型（IMM）滤波器 — 实时定位专用
 * ============================================================
 * 三模型统一 6 维状态 [x, y, vx, vy, ax, ay]（局部 ENU 米坐标），模型差异
 * 仅在加速度过程噪声 q_a：STILL(极小)/CV(中)/CA(大)。取代单模型 KalmanFilter
 * 的「自适应 Q」启发式——模型间切换由马尔可夫转移概率 × 测量似然驱动，
 * 自动匹配 静止→走→跑/车→转弯 等运动模式，且保留各模型独立历史信息。
 *
 * 矩阵优化：x/y 两轴完全解耦（F/Q 为 diag(B,B) 分块结构），6×6 问题拆成
 * 两个独立 3×3 子问题（[x,vx,ax] / [y,vy,ay]），解析展开 + 构造时一次性
 * 预分配 Float64Array，高频定位路径零 GC。
 *
 * 保护机制（与单模型一致，全部保留）：精度冻结(acc>IMM_FREEZE_ACC)、
 * 时间重置(dt≤0||>60)、重锚(>IMM_REANCHOR_M)、Huber 鲁棒（每模型 update
 * 内降权）、模型速度模量限幅(IMM_SPEED_LIMIT)。
 */
class ImmFilter {
  constructor() {
    const C = (typeof CONFIG !== 'undefined' && CONFIG) || {};
    this._q = (Array.isArray(C.IMM_MODEL_Q) && C.IMM_MODEL_Q.length === 3)
      ? [C.IMM_MODEL_Q[0], C.IMM_MODEL_Q[1], C.IMM_MODEL_Q[2]] : [0.05, 0.25, 1.0];
    this._T = this._normalizeTransition(C.IMM_TRANSITION);
    this._mu0 = (Array.isArray(C.IMM_INIT_PROB) && C.IMM_INIT_PROB.length === 3)
      ? [C.IMM_INIT_PROB[0], C.IMM_INIT_PROB[1], C.IMM_INIT_PROB[2]] : [0.6, 0.3, 0.1];
    this._posVar = C.IMM_POS_VAR != null ? C.IMM_POS_VAR : 2500;
    this._velVar = C.IMM_VEL_VAR != null ? C.IMM_VEL_VAR : 0;
    this._accVar = C.IMM_ACC_VAR != null ? C.IMM_ACC_VAR : 4;
    this._reanchorM = C.IMM_REANCHOR_M != null ? C.IMM_REANCHOR_M : 3000;
    this._speedLimit = C.IMM_SPEED_LIMIT != null ? C.IMM_SPEED_LIMIT : 120;
    this._freezeAcc = C.IMM_FREEZE_ACC != null ? C.IMM_FREEZE_ACC : 2000;
    this._likTemp = C.IMM_LIKELIHOOD_TEMP != null ? C.IMM_LIKELIHOOD_TEMP : 2.0;
    this._minProb = C.IMM_MIN_PROB != null ? C.IMM_MIN_PROB : 1e-6;
    // 速度辅助模型先验开关：用 GPS 上报 speed 修正转移预测概率 c̄。
    // 纯位置观测下低速/高速的模型辨识依赖残差积累，切换慢；speed 是现成
    // 的运动模式强信号（比位置噪声小得多），做软门控可显著加速正确切换。
    this._speedPrior = C.IMM_SPEED_PRIOR !== false;
    this._huberK = C.GPS_HUBER_K != null ? C.GPS_HUBER_K : 2.0;
    this._lastHuberK = this._huberK > 0 ? this._huberK : 0;

    // IMU 定位校准（仅加速度注入 CA 模型预测，航向仍由 GPS 权威）
    // _imuAcc 为待消费的水平 ENU 加速度 [axE, axN]（m/s²），feedImu() 写入、update() 单次消费
    this._imuTrust = C.IMU_ACC_TRUST != null ? Math.min(1, Math.max(0, C.IMU_ACC_TRUST)) : 0.6;
    this._imuAccClamp = C.IMU_ACC_CLAMP != null ? C.IMU_ACC_CLAMP : 30;
    this._imuAcc = null;

    // 三模型 × 两轴状态（x 轴 [x,vx,ax]，y 轴 [y,vy,ay]）
    this._sx = [new Float64Array(3), new Float64Array(3), new Float64Array(3)];
    this._sy = [new Float64Array(3), new Float64Array(3), new Float64Array(3)];
    // 三模型 × 两轴协方差 P（3×3 行主序 9 元素）
    this._Px = [new Float64Array(9), new Float64Array(9), new Float64Array(9)];
    this._Py = [new Float64Array(9), new Float64Array(9), new Float64Array(9)];
    // 模型概率
    this._mu = new Float64Array(3);

    // 交互混合工作区（单套，逐模型复用）
    this._cbar = new Float64Array(3);   // 转移预测概率 c̄_i = Σ_j T[i][j]·μ_j
    this._cbarRaw = new Float64Array(3); // 未修正的 c̄_i（速度先验前），混合权重归一化用
    this._w = new Float64Array(3);      // 混合权重 μ_{j|i}
    this._mxs = new Float64Array(3);    // 混合状态 x̂⁰（x 轴）
    this._mys = new Float64Array(3);    // 混合状态 ŷ⁰（y 轴）
    this._mPx = new Float64Array(9);    // 混合协方差 P⁰（x 轴）
    this._mPy = new Float64Array(9);    // 混合协方差 P⁰（y 轴）
    this._Pp = new Float64Array(9);     // 预测协方差 P⁻（单轴暂存）
    this._lik = new Float64Array(3);    // 模型对数似然 logΛ

    // 通用状态
    this._refLat = 0;
    this._refLng = 0;
    this._cosLat = 1;
    this._lastTime = 0;
    this._initialized = false;
    this._lastFiltered = null;
    // 输出混合加速度估计
    this._ax = 0;
    this._ay = 0;

    this.reset();
  }

  /** 转移矩阵校验 + 列归一化（防御配置误差，保证列和=1 以维持概率结构） */
  _normalizeTransition(raw) {
    const T = [
      [0.98, 0.015, 0.005],
      [0.015, 0.97, 0.015],
      [0.005, 0.015, 0.98],
    ];
    if (Array.isArray(raw) && raw.length === 3) {
      let ok = true;
      for (let i = 0; i < 3 && ok; i++) {
        if (!Array.isArray(raw[i]) || raw[i].length !== 3) ok = false;
      }
      if (ok) {
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) T[i][j] = raw[i][j];
        }
      }
    }
    for (let j = 0; j < 3; j++) {
      const s = T[0][j] + T[1][j] + T[2][j];
      if (!(s > 0) || !isFinite(s)) { T[0][j] = T[1][j] = T[2][j] = 1 / 3; continue; }
      T[0][j] /= s; T[1][j] /= s; T[2][j] /= s;
    }
    return T;
  }

  /** 原地填充初始协方差（位置/速度/加速度对角） */
  _setInitP(P) {
    P.fill(0);
    P[0] = this._posVar; // (x,x)
    P[4] = this._velVar; // (vx,vx)
    P[8] = this._accVar; // (ax,ax)
  }

  /**
   * 重置滤波器并设置初始值（当前点即参考点，模型概率恢复先验）
   */
  init(lat, lng, time) {
    this._refLat = lat;
    this._refLng = lng;
    this._cosLat = Math.cos(lat * DEG2RAD);
    for (let m = 0; m < 3; m++) {
      this._sx[m].fill(0);
      this._sy[m].fill(0);
      this._setInitP(this._Px[m]);
      this._setInitP(this._Py[m]);
    }
    this._mu[0] = this._mu0[0];
    this._mu[1] = this._mu0[1];
    this._mu[2] = this._mu0[2];
    this._lastTime = time;
    this._initialized = true;
    this._lastFiltered = { lat, lng };
  }

  /** 重置滤波器（原地填充，避免 GC） */
  reset() {
    this._initialized = false;
    for (let m = 0; m < 3; m++) {
      this._sx[m].fill(0);
      this._sy[m].fill(0);
      this._Px[m].fill(0);
      this._Py[m].fill(0);
    }
    this._mu[0] = this._mu0[0];
    this._mu[1] = this._mu0[1];
    this._mu[2] = this._mu0[2];
    this._lastFiltered = null;
  }

  /**
   * 自适应 Huber 阈值 K（速度+精度启发式，与 KalmanFilter 完全一致）：
   * 低速静止漂移压狠、高速机动放宽、精度差收紧。
   */
  _huberKFor(speedFactor, accClamped) {
    if (this._huberK <= 0) return 0;
    let k = this._huberK * (0.7 + 0.08 * speedFactor);
    const accFactor = 1 - 0.004 * Math.max(0, accClamped - 10);
    k *= Math.max(0.65, accFactor);
    return Math.max(1.0, Math.min(4.0, k));
  }

  /**
   * 注入 IMU 水平 ENU 加速度（定位校准，仅运动学先验）。
   * 由 GPSManager 在每次 update() 前调用；无 IMU 数据时不要调用（保持纯 GPS）。
   * @param {number[]} accEnu 水平加速度 [东向, 北向]（m/s²），已 1s 聚合 + 低通
   */
  feedImu(accEnu) {
    if (!Array.isArray(accEnu) || accEnu.length < 2) return;
    const ae = Number(accEnu[0]);
    const an = Number(accEnu[1]);
    if (!isFinite(ae) || !isFinite(an)) return;
    const c = this._imuAccClamp;
    this._imuAcc = [
      Math.max(-c, Math.min(c, ae)),
      Math.max(-c, Math.min(c, an))
    ];
  }

  /** 读取并清空待注入加速度（单次消费：update() 开头调用） */
  _consumeImuAcc() {
    const acc = this._imuAcc;
    this._imuAcc = null;
    return acc;
  }

  /**
   * 更新测量值 → 返回滤波后结果（IMM 单步）。
   * 接口与 KalmanFilter.update 完全一致，GPSManager 调用点零改动。
   * @param {number} zLat 测量纬度
   * @param {number} zLng 测量经度
   * @param {number} accuracy GPS 精度（米）
   * @param {number} time 时间戳（毫秒）
   * @param {number} [speed] 速度（m/s），用于 Huber 自适应
   * @returns {{lat: number, lng: number}} 滤波后坐标
   */
  update(zLat, zLng, accuracy, time, speed) {
    if (!this._initialized) {
      this.init(zLat, zLng, time);
      this._lastFiltered = { lat: zLat, lng: zLng };
      return { lat: zLat, lng: zLng };
    }
    if (accuracy > this._freezeAcc) {
      // 精度极差（地下/遮挡）：冻结在最后可信位置，避免跳变；更新 _lastTime 防恢复时重置
      this._lastTime = time;
      return this._lastFiltered || { lat: zLat, lng: zLng };
    }

    const dt = (time - this._lastTime) / 1000; // 秒
    this._lastTime = time;

    if (dt <= 0 || dt > 60) {
      // 时间异常或间隙过大 → 重置（与单模型一致）
      this.init(zLat, zLng, time);
      return { lat: zLat, lng: zLng };
    }

    // 坐标正变换：lat/lng → 局部米
    let mx = (zLng - this._refLng) * M_PER_DEG * this._cosLat;
    let my = (zLat - this._refLat) * M_PER_DEG;

    // 距参考点超 IMM_REANCHOR_M → 重新锚定（三模型平移，速度/加速度保留）
    if (Math.hypot(mx, my) > this._reanchorM) {
      this._reanchor();
      mx = (zLng - this._refLng) * M_PER_DEG * this._cosLat;
      my = (zLat - this._refLat) * M_PER_DEG;
    }

    const accClamped = Math.max(Math.min(accuracy || 10, 2000), 1);
    const speedFactor = Math.min(12, Math.max(1, (speed || 0) / 0.5));
    const sigma = Math.max(3, Math.min(accClamped, 2000)); // 米
    const R = sigma * sigma;
    const hk = (this._lastHuberK = this._huberKFor(speedFactor, accClamped));

    // ── IMM 单步（x/y 两轴解耦，各为独立 3×3 子问题）──
    const imuAcc = this._consumeImuAcc();
    this._immStep(mx, my, R, hk, dt, speed || 0, imuAcc);

    // ── 输出：模型概率加权混合 ──
    let xhat = 0, yhat = 0, vxhat = 0, vyhat = 0, axhat = 0, ayhat = 0;
    for (let m = 0; m < 3; m++) {
      const w = this._mu[m];
      xhat += w * this._sx[m][0];
      yhat += w * this._sy[m][0];
      vxhat += w * this._sx[m][1];
      vyhat += w * this._sy[m][1];
      axhat += w * this._sx[m][2];
      ayhat += w * this._sy[m][2];
    }
    // 输出速度模量限幅（防御性，模型内已限幅）
    const spd = Math.hypot(vxhat, vyhat);
    if (spd > this._speedLimit) {
      const k = this._speedLimit / spd;
      vxhat *= k;
      vyhat *= k;
    }
    this._ax = axhat;
    this._ay = ayhat;

    const filtered = {
      lat: this._refLat + yhat / M_PER_DEG,
      lng: this._refLng + xhat / (M_PER_DEG * this._cosLat)
    };
    this._lastFiltered = filtered;
    return filtered;
  }

  /**
   * IMM 单步核心：交互混合 → 各模型预测 → 各模型更新(Huber) → 似然/概率更新。
   * x/y 两轴对称，各自作为独立 3×3 卡尔曼子问题处理（矩阵优化核心）。
   * @param {number} mx x 轴测量（米，相对参考点）
   * @param {number} my y 轴测量（米，相对参考点）
   * @param {number} R 测量噪声方差（米²）
   * @param {number} hk Huber 阈值 K（≤0 禁用）
   * @param {number} dt 时间间隔（秒）
   * @param {number} speed GPS 上报速度（m/s，用于速度辅助模型先验）
   * @param {number[]} [imuAcc] 待注入水平 ENU 加速度 [axE, axN]（m/s²），仅 CA 模型消费
   */
  _immStep(mx, my, R, hk, dt, speed, imuAcc) {
    const T = this._T, mu = this._mu;

    // ── 1. 转移预测概率 c̄_i = Σ_j T[i][j]·μ_j（概率更新与混合共用）──
    for (let i = 0; i < 3; i++) {
      this._cbar[i] = T[i][0] * mu[0] + T[i][1] * mu[1] + T[i][2] * mu[2];
      if (!(this._cbar[i] > 0) || !isFinite(this._cbar[i])) this._cbar[i] = 1e-12;
    }
    // 保存未修正的 c̄：速度先验只应影响模型概率更新（第 3 步），
    // 混合权重（第 2 步）须用原始 c̄ 作分母，否则 Σ_j μ_{j|i} ≠ 1 导致混合状态/协方差比例偏差
    this._cbarRaw[0] = this._cbar[0];
    this._cbarRaw[1] = this._cbar[1];
    this._cbarRaw[2] = this._cbar[2];

    // ── 1b. 速度辅助模型先验（软门控，可选）──
    // 纯位置观测下，低速静止时 STILL 的 S 仍由 R 主导（P 收缩受交互混合限制），
    // 移动时残差标准化不显著 → 切换慢。speed 是独立于位置的运动模式强信号：
    // 低速抬 STILL、高速偏 CA、中间偏 CV。作为 c̄ 的乘性修正（归一化保持概率结构）。
    if (this._speedPrior) {
      const spd = speed > 0 ? speed : 0;
      // 三个高斯峰的相对先验：STILL 峰 0、CV 峰 2.5m/s、CA 峰 7m/s
      const pS = 1 / (1 + spd * spd / 4);
      const dC = spd - 2.5;
      const pC = 1 / (1 + dC * dC / 4);
      const dA = spd - 7;
      const pA = 1 / (1 + dA * dA / 9);
      const ps = pS + pC + pA;
      if (ps > 0 && isFinite(ps)) {
        this._cbar[0] *= pS / ps;
        this._cbar[1] *= pC / ps;
        this._cbar[2] *= pA / ps;
        const cs = this._cbar[0] + this._cbar[1] + this._cbar[2];
        if (cs > 0 && isFinite(cs)) {
          this._cbar[0] /= cs; this._cbar[1] /= cs; this._cbar[2] /= cs;
        }
      }
    }

    const d2 = dt * dt, d3 = dt * d2, d4 = dt * d3;
    const h = 0.5 * d2; // ½dt²

    // ── 2. 逐模型：混合输入 → 预测 → 更新(Huber) → 对数似然 ──
    for (let m = 0; m < 3; m++) {
      // 混合权重 μ_{j|i} = T[i][j]·μ_j / c̄_i（用未修正 c̄ 归一，保证 Σ_j μ_{j|i} = 1）
      const ci = this._cbarRaw[m];
      this._w[0] = T[m][0] * mu[0] / ci;
      this._w[1] = T[m][1] * mu[1] / ci;
      this._w[2] = T[m][2] * mu[2] / ci;

      // ---- x 轴：混合状态/协方差 ----
      const w0 = this._w[0], w1 = this._w[1], w2 = this._w[2];
      this._mxs[0] = w0 * this._sx[0][0] + w1 * this._sx[1][0] + w2 * this._sx[2][0];
      this._mxs[1] = w0 * this._sx[0][1] + w1 * this._sx[1][1] + w2 * this._sx[2][1];
      this._mxs[2] = w0 * this._sx[0][2] + w1 * this._sx[1][2] + w2 * this._sx[2][2];
      // P⁰ = Σ_j w_j·(P_j + (x̂_j−x̂⁰)(x̂_j−x̂⁰)ᵀ)，对称只算上三角
      for (let a = 0; a < 3; a++) {
        for (let b = a; b < 3; b++) {
          let s = 0;
          for (let j = 0; j < 3; j++) {
            const da = this._sx[j][a] - this._mxs[a];
            const db = this._sx[j][b] - this._mxs[b];
            s += this._w[j] * (this._Px[j][a * 3 + b] + da * db);
          }
          this._mPx[a * 3 + b] = s;
          this._mPx[b * 3 + a] = s;
        }
      }
      // ---- y 轴：混合状态/协方差 ----
      this._mys[0] = w0 * this._sy[0][0] + w1 * this._sy[1][0] + w2 * this._sy[2][0];
      this._mys[1] = w0 * this._sy[0][1] + w1 * this._sy[1][1] + w2 * this._sy[2][1];
      this._mys[2] = w0 * this._sy[0][2] + w1 * this._sy[1][2] + w2 * this._sy[2][2];
      for (let a = 0; a < 3; a++) {
        for (let b = a; b < 3; b++) {
          let s = 0;
          for (let j = 0; j < 3; j++) {
            const da = this._sy[j][a] - this._mys[a];
            const db = this._sy[j][b] - this._mys[b];
            s += this._w[j] * (this._Py[j][a * 3 + b] + da * db);
          }
          this._mPy[a * 3 + b] = s;
          this._mPy[b * 3 + a] = s;
        }
      }

      // ---- x 轴 predict（3×3 恒加速模型 F=[1,dt,½dt²; 0,1,dt; 0,0,1]，离散白噪声加速度 Q）----
      // IMU 加速度注入（仅 CA 模型 m=2）：运动学先验 x⁻=F·x̂+G·a_imu，
      // 位置 +½dt²·a、速度 +dt·a、加速度状态保持模型自持（GPS 残差驱动）；
      // 注入期间 CA 模型 Q 同步缩小（更信 IMU 运动学预测），低机动时更平滑。
      const qa = this._q[m];
      const qa2 = qa * qa;
      const useImu = (m === 2 && imuAcc);
      const axI = useImu ? imuAcc[0] * this._imuTrust : 0;
      const ayI = useImu ? imuAcc[1] * this._imuTrust : 0;
      const qScale = useImu ? Math.max(0.3, 1 - this._imuTrust * 0.7) : 1;
      const q00 = 0.25 * qa2 * d4 * qScale, q01 = 0.5 * qa2 * d3 * qScale, q02 = 0.5 * qa2 * d2 * qScale,
            q11 = qa2 * d2 * qScale, q12 = qa2 * dt * qScale, q22 = qa2 * qScale;
      const P = this._mPx, Pp = this._Pp;
      const A00 = P[0] + dt * P[3] + h * P[6];
      const A01 = P[1] + dt * P[4] + h * P[7];
      const A02 = P[2] + dt * P[5] + h * P[8];
      const A10 = P[3] + dt * P[6];
      const A11 = P[4] + dt * P[7];
      const A12 = P[5] + dt * P[8];
      // A20=P[6], A21=P[7], A22=P[8]（F 第三行 [0,0,1]）
      Pp[0] = A00 + dt * A01 + h * A02 + q00;
      Pp[1] = A01 + dt * A02 + q01;
      Pp[2] = A02 + q02;
      Pp[3] = Pp[1];
      Pp[4] = A11 + dt * A12 + q11;
      Pp[5] = A12 + q12;
      Pp[6] = Pp[2];
      Pp[7] = Pp[5];
      Pp[8] = P[8] + q22;
      // 预测状态（CA 模型：位置 +dt·v +½dt²·a、速度 +dt·a、加速度保持；IMU 注入叠加运动学先验）
      const px = this._mxs[0] + this._mxs[1] * dt + this._mxs[2] * h + h * axI;
      const pvx = this._mxs[1] + this._mxs[2] * dt + dt * axI;
      const pax = this._mxs[2];

      // ---- x 轴 update（观测只测位置 H=[1,0,0]，S 为标量）----
      const S = Pp[0] + R;
      if (!(S > 0) || !isFinite(S)) { this._degradeReset(mx, my); return; }
      let e = mx - px;       // 原始残差（似然用）
      let eH = e;            // Huber 收缩残差（状态更新用）
      if (hk > 0) {
        const n = e * e / S;
        if (n > hk * hk) eH *= hk / Math.sqrt(n);
      }
      const K0 = Pp[0] / S, K1 = Pp[3] / S, K2 = Pp[6] / S;
      const sx = this._sx[m];
      sx[0] = px + K0 * eH;
      sx[1] = pvx + K1 * eH;
      sx[2] = pax + K2 * eH;
      // P⁺ = (I − K·H)·P⁻（H=[1,0,0]），全量展开后对称化
      const Pn = this._Px[m];
      Pn[0] = Pp[0] - K0 * Pp[0];
      Pn[1] = Pp[1] - K0 * Pp[1];
      Pn[2] = Pp[2] - K0 * Pp[2];
      Pn[3] = Pp[3] - K1 * Pp[0];
      Pn[4] = Pp[4] - K1 * Pp[1];
      Pn[5] = Pp[5] - K1 * Pp[2];
      Pn[6] = Pp[6] - K2 * Pp[0];
      Pn[7] = Pp[7] - K2 * Pp[1];
      Pn[8] = Pp[8] - K2 * Pp[2];
      Pn[1] = Pn[3] = 0.5 * (Pn[1] + Pn[3]);
      Pn[2] = Pn[6] = 0.5 * (Pn[2] + Pn[6]);
      Pn[5] = Pn[7] = 0.5 * (Pn[5] + Pn[7]);

      // ---- y 轴 predict + update（与 x 轴完全对称）----
      const Py = this._mPy;
      const By00 = Py[0] + dt * Py[3] + h * Py[6];
      const By01 = Py[1] + dt * Py[4] + h * Py[7];
      const By02 = Py[2] + dt * Py[5] + h * Py[8];
      const By10 = Py[3] + dt * Py[6];
      const By11 = Py[4] + dt * Py[7];
      const By12 = Py[5] + dt * Py[8];
      Pp[0] = By00 + dt * By01 + h * By02 + q00;
      Pp[1] = By01 + dt * By02 + q01;
      Pp[2] = By02 + q02;
      Pp[3] = Pp[1];
      Pp[4] = By11 + dt * By12 + q11;
      Pp[5] = By12 + q12;
      Pp[6] = Pp[2];
      Pp[7] = Pp[5];
      Pp[8] = Py[8] + q22;
      const py = this._mys[0] + this._mys[1] * dt + this._mys[2] * h + h * ayI;
      const pvy = this._mys[1] + this._mys[2] * dt + dt * ayI;
      const pay = this._mys[2];

      const Sy = Pp[0] + R;
      if (!(Sy > 0) || !isFinite(Sy)) { this._degradeReset(mx, my); return; }
      let ey = my - py;    // 原始残差
      let eyH = ey;        // Huber 收缩残差
      if (hk > 0) {
        const n = ey * ey / Sy;
        if (n > hk * hk) eyH *= hk / Math.sqrt(n);
      }
      const Ky0 = Pp[0] / Sy, Ky1 = Pp[3] / Sy, Ky2 = Pp[6] / Sy;
      const syv = this._sy[m];
      syv[0] = py + Ky0 * eyH;
      syv[1] = pvy + Ky1 * eyH;
      syv[2] = pay + Ky2 * eyH;
      const Pny = this._Py[m];
      Pny[0] = Pp[0] - Ky0 * Pp[0];
      Pny[1] = Pp[1] - Ky0 * Pp[1];
      Pny[2] = Pp[2] - Ky0 * Pp[2];
      Pny[3] = Pp[3] - Ky1 * Pp[0];
      Pny[4] = Pp[4] - Ky1 * Pp[1];
      Pny[5] = Pp[5] - Ky1 * Pp[2];
      Pny[6] = Pp[6] - Ky2 * Pp[0];
      Pny[7] = Pp[7] - Ky2 * Pp[1];
      Pny[8] = Pp[8] - Ky2 * Pp[2];
      Pny[1] = Pny[3] = 0.5 * (Pny[1] + Pny[3]);
      Pny[2] = Pny[6] = 0.5 * (Pny[2] + Pny[6]);
      Pny[5] = Pny[7] = 0.5 * (Pny[5] + Pny[7]);

      // 每模型速度模量限幅（防极端模型速度带偏混合输出）
      const spd = Math.hypot(sx[1], syv[1]);
      if (spd > this._speedLimit) {
        const k = this._speedLimit / spd;
        sx[1] *= k;
        syv[1] *= k;
      }

      // ---- 对数似然（联合二维高斯，用 Huber 收缩残差）----
      // 用收缩残差 eH 而非原始残差 e：粗差/大噪声时若用原始残差，大 Q 模型
      // 因 S 大而惩罚小，概率会错误偏向 CA，把输出拉向粗差方向。Huber 化后
      // 超出阈值 k·√S 的残差被压回，所有模型似然惩罚接近，概率由模型先验
      // 与转移概率主导，静止/低速时 STILL 自然占优。
      // logΛ = −½·(eH²/S + eyH²/Sy) − ½·ln(2π·√(S·Sy))
      this._lik[m] = -0.5 * (eH * eH / S + eyH * eyH / Sy)
                   - 0.5 * Math.log(2 * Math.PI * Math.sqrt(S * Sy));
    }

    // ── 3. 模型概率更新：μ_i = c̄_i·Λ_i / Σ_j c̄_j·Λ_j（对数域减最大值防下溢）──
    // 似然温度 γ：Λ^γ 放大模型间似然差异，加速强模型主导（大测量噪声下似然
    // 差异被稀释，温度可补偿），γ=1 即标准 IMM。
    const tmp = this._likTemp;
    let maxL = -Infinity;
    for (let m = 0; m < 3; m++) {
      const s = this._lik[m] * tmp;
      if (s > maxL) maxL = s;
    }
    let sum = 0;
    for (let m = 0; m < 3; m++) {
      const v = this._cbar[m] * Math.exp(this._lik[m] * tmp - maxL);
      this._lik[m] = v; // 复用为未归一化权重
      sum += v;
    }
    if (!(sum > 0) || !isFinite(sum)) {
      // 数值异常（如所有似然下溢为 0）：回退到转移预测概率（纯先验）
      this._mu[0] = this._cbar[0];
      this._mu[1] = this._cbar[1];
      this._mu[2] = this._cbar[2];
      return;
    }
    this._mu[0] = this._lik[0] / sum;
    this._mu[1] = this._lik[1] / sum;
    this._mu[2] = this._lik[2] / sum;
    // 概率下界保护（防浮点死锁到 0）
    const minP = this._minProb;
    if (this._mu[0] < minP || this._mu[1] < minP || this._mu[2] < minP) {
      this._mu[0] = Math.max(this._mu[0], minP);
      this._mu[1] = Math.max(this._mu[1], minP);
      this._mu[2] = Math.max(this._mu[2], minP);
      const s = this._mu[0] + this._mu[1] + this._mu[2];
      this._mu[0] /= s; this._mu[1] /= s; this._mu[2] /= s;
    }
  }

  /**
   * 数值退化兜底（理论不可达：S=P⁻[0][0]+R，R≥9 恒正）：所有模型接受测量、
   * 协方差恢复初始、概率恢复先验。与单模型「奇异保护→init」语义一致。
   * @param {number} mx x 轴测量（米）
   * @param {number} my y 轴测量（米）
   */
  _degradeReset(mx, my) {
    for (let m = 0; m < 3; m++) {
      this._sx[m][0] = mx; this._sx[m][1] = 0; this._sx[m][2] = 0;
      this._sy[m][0] = my; this._sy[m][1] = 0; this._sy[m][2] = 0;
      this._setInitP(this._Px[m]);
      this._setInitP(this._Py[m]);
    }
    this._mu[0] = this._mu0[0];
    this._mu[1] = this._mu0[1];
    this._mu[2] = this._mu0[2];
  }

  /**
   * 重新锚定参考点到当前概率加权混合位置（x/y 平移，速度/加速度不变）。
   * 三模型各自放大速度不确定度 ×2（与单模型一致），更快收敛后续机动。
   */
  _reanchor() {
    let xhat = 0, yhat = 0;
    for (let m = 0; m < 3; m++) {
      xhat += this._mu[m] * this._sx[m][0];
      yhat += this._mu[m] * this._sy[m][0];
    }
    const curLat = this._refLat + yhat / M_PER_DEG;
    const curLng = this._refLng + xhat / (M_PER_DEG * this._cosLat);
    this._refLat = curLat;
    this._refLng = curLng;
    this._cosLat = Math.cos(curLat * DEG2RAD);
    for (let m = 0; m < 3; m++) {
      this._sx[m][0] -= xhat;
      this._sy[m][0] -= yhat;
      this._Px[m][4] *= 2; // vx 协方差放大 ×2
      this._Py[m][4] *= 2; // vy 协方差放大 ×2
    }
  }

}
