/**
 * 圆圈地图 - GPS 定位（共享常量 + 离线 RTS 平滑）
 * ============================================
 * gps.js 拆分后的第一个文件。顶部定义跨文件共享常量（var 顶层声明，挂全局，
 * 供 trail-denoise.js / gps-manager.js 引用），并提供离线 RTS 平滑用的 KalmanFilter。
 *
 * 注意：本类只做「离线批处理 RTS」——对整段原始测量做前向滤波 + 反向递推。
 * 实时 2D 位置滤波早已移除（蓝点走 PositionSmoother 滑动窗，见 gps-window.js），
 * 与之配套的单步 update()/init()/reset() 一并删除，避免留下无人调用的实时路径。
 */

/** 角度转弧度系数（多次使用，避免重复 Math.PI / 180） */
var DEG2RAD = Math.PI / 180;
/** 纬度方向的米/度近似系数（赤道约 111111m/°），经度方向需乘 cos(lat) */
var M_PER_DEG = 111111;
/** 2×2 协方差 S 求逆的奇异保护阈值（det 低于此值视为奇异，退化处理） */
var S_DET_EPSILON = 1e-9;
/** RTS 时间回环防御：段内出现 dt<=0 时钳制的极小时间窗（秒） */
var RTS_MIN_DT = 1e-6;

/**
 * 二维卡尔曼滤波器（离线 RTS 平滑专用）— 2D 恒速模型（位置+速度矢量），局部 ENU 米坐标
 * 以段首为参考点，lat/lng → 米 → 前向滤波 + 反向 RTS 递推 → 逆变换输出
 * Q/R 自适应 accuracy，更新采用 Huber Loss 鲁棒化（M-估计）：超出阈值的测量残差降权，
 * 抑制 GPS 粗差/漂移点。所有临时数组预分配，消除长轨迹下的 GC 压力。
 */
class KalmanFilter {
  constructor() {
    // Huber Loss 鲁棒更新的基准阈值（标准化残差，无量纲）：0 表示禁用（纯最小二乘）。
    // |残差|/σ ≤ k 的点正常更新；超过的点残差收缩到 k·σ（M-估计），抑制 GPS 粗差/漂移点。
    // 实际生效阈值由 _huberKFor() 按「速度+精度」启发式在基准值上自适应缩放。
    this._huberK = (typeof CONFIG !== 'undefined' && CONFIG.GPS_HUBER_K != null)
      ? CONFIG.GPS_HUBER_K : 2.0;

    // RTS 离线平滑的求逆工作区（构造时预分配，避免平滑期逐点分配）
    this._rtsInvA = new Float64Array(16); // inv 高斯-约当：当前矩阵副本
    this._rtsInvI = new Float64Array(16); // inv 高斯-约当：单位阵侧
  }

  /**
   * 自适应 Huber 阈值 K（速度+精度启发式），返回实际生效的 K。
   * 用户无需手动调参：以 _huberK（CONFIG.GPS_HUBER_K）为基准自动缩放。
   * - 速度启发式：低速静止漂移压狠（K 小）；高速机动残差天然大 → 放宽避免误伤正常机动
   * - 精度启发式：精度差时测量噪声大、标准化残差偏小 → 收紧阈值维持抑制能力
   * @param {number} speedFactor 速度因子（1~12，clamp(speed/0.5)，与动态 Q 共用）
   * @param {number} accClamped 精度（clamp 1~2000 米）
   * @returns {number} 实际 K（≤0 表示禁用 Huber，纯最小二乘）
   */
  _huberKFor(speedFactor, accClamped) {
    if (this._huberK <= 0) return 0; // 基准 0 → 禁用
    // 速度启发式：0.7 + 0.08·sf → 静止 0.78× 基准，高速 1.66× 基准
    let k = this._huberK * (0.7 + 0.08 * speedFactor);
    // 精度启发式：acc=10m → 1.0，精度越差阈值越紧，约 100m 起触底 0.65 下限，
    // 即精度越差阈值越紧，避免「噪声大→标准化残差小→Huber 失效」
    const accFactor = 1 - 0.004 * Math.max(0, accClamped - 10);
    k *= Math.max(0.65, accFactor);
    // 硬上下限兜底：防止极端场景完全失效或正常机动被误伤
    return Math.max(1.0, Math.min(4.0, k));
  }

  /**
   * 离线批处理 RTS（Rauch–Tung–Striebel）平滑
   * 对整段原始测量序列做「前向滤波 + 反向递推」，利用未来测量修正历史状态，
   * 显著降低轨迹滞后与抖动（实时滤波的 RMSE 通常可再降 30~40%）。
   * 坐标经调用方预转（GPSManager 采集时已转 GCJ02），此处对坐标系无依赖；
   * 内部在局部米坐标系下运算，参考点取段首。
   * 遇到时间断裂（dt≤0 或 >60s）、精度过差（>2000m）或距段首超 3km 时自动分段，
   * 每段独立平滑后拼接（重锚/重置点即段边界）。
   * @param {Array<{lat:number,lng:number,time:number,accuracy?:number,speed?:number,ts?:*}>} fixes 原始测量序列（升序）
   * @returns {Array<{lat:number,lng:number,time:number,ts:*}>} 平滑后坐标（与输入等长）
   */
  smoothTrail(fixes) {
    if (!Array.isArray(fixes) || fixes.length === 0) return [];
    if (fixes.length === 1) {
      const f = fixes[0];
      return [{ lat: f.lat, lng: f.lng, time: f.time, ts: f.ts }];
    }
    // 分段：时间断裂 / 精度失效 / 距段首超速度自适应阈值 → 段边界
    const segments = [];
    let seg = [];
    for (let i = 0; i < fixes.length; i++) {
      const f = fixes[i];
      if (seg.length > 0) {
        const prev = fixes[i - 1];
        const dt = (f.time - prev.time) / 1000;
        const ref = seg[0];
        const mx = (f.lng - ref.lng) * M_PER_DEG * Math.cos(ref.lat * DEG2RAD);
        const my = (f.lat - ref.lat) * M_PER_DEG;
        // 速度自适应距离阈值：至少 3km，或速度×60s（高铁 300km/h≈83m/s → 阈值≈8km）
        const distThresh = Math.max(3000, (f.speed || 0) * 60);
        const breakSeg = dt <= 0 || dt > 60 || (f.accuracy || 0) > 2000 || Math.hypot(mx, my) > distThresh;
        if (breakSeg) { segments.push(seg); seg = []; }
      }
      seg.push(f);
    }
    if (seg.length) segments.push(seg);

    const out = [];
    for (const s of segments) {
      out.push.apply(out, this._rtsSegment(s));
    }
    return out;
  }

  /** 对单个连续段做 RTS（前向滤波 + 反向递推），返回平滑坐标数组 */
  _rtsSegment(fixes) {
    const n = fixes.length;
    if (n === 1) {
      const f = fixes[0];
      return [{ lat: f.lat, lng: f.lng, time: f.time, ts: f.ts }];
    }
    const refLat = fixes[0].lat, refLng = fixes[0].lng;
    const cosLat = Math.cos(refLat * DEG2RAD);

    // 测量 → 局部米（扁平 Float64Array，缓存友好）
    const zx = new Float64Array(n);
    const zy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      zx[i] = (fixes[i].lng - refLng) * M_PER_DEG * cosLat;
      zy[i] = (fixes[i].lat - refLat) * M_PER_DEG;
    }

    // ── 前向滤波，扁平存储每步状态与协方差（一次分配，消除逐点 GC）──
    // xf[i*4..] 更新后状态   xp[i*4..] 预测状态
    // Pf[i*16..] 更新后协方差  Pp[i*16..] 预测协方差
    const xf = new Float64Array(n * 4);
    const xp = new Float64Array(n * 4);
    const Pf = new Float64Array(n * 16);
    const Pp = new Float64Array(n * 16);
    // 工作区（循环内复用，无分配）
    const Ppred = new Float64Array(16);
    const Pnew = new Float64Array(16);

    Pf[0] = 2500; Pf[5] = 2500; // 初始位置不确定度 50m²，速度未知
    let x0 = 0, x1 = 0, x2 = 0, x3 = 0;
    let lastTime = fixes[0].time;

    for (let i = 1; i < n; i++) {
      let dt = (fixes[i].time - lastTime) / 1000;
      lastTime = fixes[i].time;
      // 时间回环防御：smoothTrail 已按 dt<=0 分段，段内理论上恒有 dt>0；
      // 但系统时间微调/异常数据仍可能产生负 dt（时间倒流），导致状态转移矩阵
      // F 物理意义错误、平滑结果炸裂。钳制到极小正值：状态几乎不转移、结果≈测量，
      // 避免溢出/炸裂（正常路径 dt>0 完全不受影响）。
      if (!(dt > RTS_MIN_DT)) dt = RTS_MIN_DT;
      // 动态 q：精度好时跟手（响应快），精度差时平滑（抑制噪声）；速度越快机动越强，q 越大
      const accClamped = Math.max(Math.min(fixes[i].accuracy || 10, 2000), 1);
      const speedFactor = Math.min(12, Math.max(1, (fixes[i].speed || 0) / 0.5));
      const q = Math.max(0.1, (0.5 / accClamped) * speedFactor);
      const dt2 = dt * dt, q2 = q * q;
      const q00 = 0.25 * q2 * dt2 * dt2, q02 = 0.5 * q2 * dt2 * dt, q22 = q2 * dt2;

      // 读上一轮更新后协方差（16 个局部标量）
      const po = (i - 1) * 16;
      const P00 = Pf[po], P01 = Pf[po + 1], P02 = Pf[po + 2], P03 = Pf[po + 3];
      const P10 = Pf[po + 4], P11 = Pf[po + 5], P12 = Pf[po + 6], P13 = Pf[po + 7];
      const P20 = Pf[po + 8], P21 = Pf[po + 9], P22 = Pf[po + 10], P23 = Pf[po + 11];
      const P30 = Pf[po + 12], P31 = Pf[po + 13], P32 = Pf[po + 14], P33 = Pf[po + 15];

      // Predict：P⁻ = F·P·Fᵀ + Q（F 恒速模型，解析展开）
      // (F·P)[i][j] = P[i][j] + dt·P[i+2][j]（i<2），否则 P[i][j]
      const a00 = P00 + dt * P20, a01 = P01 + dt * P21, a02 = P02 + dt * P22, a03 = P03 + dt * P23;
      const a10 = P10 + dt * P30, a11 = P11 + dt * P31, a12 = P12 + dt * P32, a13 = P13 + dt * P33;
      const a20 = P20, a21 = P21, a22 = P22, a23 = P23;
      const a30 = P30, a31 = P31, a32 = P32, a33 = P33;
      // (·Fᵀ)[i][j] = A[i][j]（j<2），A[i][j] + dt·A[i][j-2]（j≥2）
      Ppred[0] = a00 + dt * a02 + q00;
      Ppred[1] = a01 + dt * a03;
      Ppred[2] = a02 + q02;
      Ppred[3] = a03;
      Ppred[4] = a10 + dt * a12;
      Ppred[5] = a11 + dt * a13 + q00;
      Ppred[6] = a12;
      Ppred[7] = a13 + q02;
      Ppred[8] = a20 + dt * a22 + q02;
      Ppred[9] = a21 + dt * a23;
      Ppred[10] = a22 + q22;
      Ppred[11] = a23;
      Ppred[12] = a30 + dt * a32;
      Ppred[13] = a31 + dt * a33 + q02;
      Ppred[14] = a32;
      Ppred[15] = a33 + q22;

      // 预测状态，存入 xp[i]；预测协方差存入 Pp[i]（供反向递推）
      const px0 = x0 + x2 * dt, px1 = x1 + x3 * dt, px2 = x2, px3 = x3;
      const p4 = i * 4;
      xp[p4] = px0; xp[p4 + 1] = px1; xp[p4 + 2] = px2; xp[p4 + 3] = px3;
      Pp.set(Ppred, i * 16);

      // Update：S、K 计算
      const sigma = Math.max(3, Math.min(accClamped, 2000));
      // accuracy 加权（RTS_ACC_WEIGHT）：低精度点（sigma 大）的噪声方差被放大，
      // RTS 反向递推时更信任模型预测而非该测量；高精度点反之亦然。
      // 以 50m 为参考基准：rExp=1 退化为原 sigma^2；rExp>1 时低精度权重更陡峭，
      // 等价于隐式运动学一致性约束（与实时 IMU clamp 解耦）。
      const rExp = CONFIG.RTS_ACC_WEIGHT || 1;
      const r = sigma * sigma * Math.pow(sigma / 50, rExp - 1);
      const s00 = Ppred[0] + r, s01 = Ppred[1], s10 = Ppred[4], s11 = Ppred[5] + r;
      const det = s00 * s11 - s01 * s10;
      // 数值稳定性：S 奇异（det→0）时直接求逆溢出。退化时跳过卡尔曼增益（K=0），
      // 位置保持预测值、协方差保持预测值，不炸裂不污染后续段（正常路径不受影响）。
      if (!(Math.abs(det) > S_DET_EPSILON)) {
        xf[p4] = px0; xf[p4 + 1] = px1; xf[p4 + 2] = px2; xf[p4 + 3] = px3;
        Pf.set(Ppred, i * 16);
        continue;
      }
      const si00 = s11 / det, si01 = -s01 / det, si10 = -s10 / det, si11 = s00 / det;
      const k00 = Ppred[0] * si00 + Ppred[1] * si10;
      const k01 = Ppred[0] * si01 + Ppred[1] * si11;
      const k10 = Ppred[4] * si00 + Ppred[5] * si10;
      const k11 = Ppred[4] * si01 + Ppred[5] * si11;
      const k20 = Ppred[8] * si00 + Ppred[9] * si10;
      const k21 = Ppred[8] * si01 + Ppred[9] * si11;
      const k30 = Ppred[12] * si00 + Ppred[13] * si10;
      const k31 = Ppred[12] * si01 + Ppred[13] * si11;

      // Huber Loss 鲁棒更新：粗差/漂移点残差降权。
      // K 按该点速度/精度自适应
      let e0 = zx[i] - px0;
      let e1 = zy[i] - px1;
      const hk = this._huberKFor(speedFactor, accClamped);
      if (hk > 0) {
        const n0 = e0 * e0 / s00, n1 = e1 * e1 / s11;
        if (n0 > hk * hk) e0 *= hk / Math.sqrt(n0);
        if (n1 > hk * hk) e1 *= hk / Math.sqrt(n1);
      }

      x0 = px0 + k00 * e0 + k01 * e1;
      x1 = px1 + k10 * e0 + k11 * e1;
      x2 = px2 + k20 * e0 + k21 * e1;
      x3 = px3 + k30 * e0 + k31 * e1;
      xf[p4] = x0; xf[p4 + 1] = x1; xf[p4 + 2] = x2; xf[p4 + 3] = x3;

      // P⁺ = (I − K·H)·P⁻，利用 H=[I₂ 0] 结构避免通用 4×4 乘法：
      // P⁺[i][j] = P⁻[i][j] − K[i][0]·P⁻[0][j] − K[i][1]·P⁻[1][j]，随后对称化
      Pnew[0] = Ppred[0] - k00 * Ppred[0] - k01 * Ppred[4];
      Pnew[1] = Ppred[1] - k00 * Ppred[1] - k01 * Ppred[5];
      Pnew[2] = Ppred[2] - k00 * Ppred[2] - k01 * Ppred[6];
      Pnew[3] = Ppred[3] - k00 * Ppred[3] - k01 * Ppred[7];
      Pnew[4] = Ppred[4] - k10 * Ppred[0] - k11 * Ppred[4];
      Pnew[5] = Ppred[5] - k10 * Ppred[1] - k11 * Ppred[5];
      Pnew[6] = Ppred[6] - k10 * Ppred[2] - k11 * Ppred[6];
      Pnew[7] = Ppred[7] - k10 * Ppred[3] - k11 * Ppred[7];
      Pnew[8] = Ppred[8] - k20 * Ppred[0] - k21 * Ppred[4];
      Pnew[9] = Ppred[9] - k20 * Ppred[1] - k21 * Ppred[5];
      Pnew[10] = Ppred[10] - k20 * Ppred[2] - k21 * Ppred[6];
      Pnew[11] = Ppred[11] - k20 * Ppred[3] - k21 * Ppred[7];
      Pnew[12] = Ppred[12] - k30 * Ppred[0] - k31 * Ppred[4];
      Pnew[13] = Ppred[13] - k30 * Ppred[1] - k31 * Ppred[5];
      Pnew[14] = Ppred[14] - k30 * Ppred[2] - k31 * Ppred[6];
      Pnew[15] = Ppred[15] - k30 * Ppred[3] - k31 * Ppred[7];

      // 对称化 (Pnew + Pnewᵀ)/2：只算上三角再镜像，写回 Pf
      const fi = i * 16;
      Pf[fi] = Pnew[0];
      Pf[fi + 1] = (Pnew[1] + Pnew[4]) / 2;
      Pf[fi + 2] = (Pnew[2] + Pnew[8]) / 2;
      Pf[fi + 3] = (Pnew[3] + Pnew[12]) / 2;
      Pf[fi + 4] = Pf[fi + 1];
      Pf[fi + 5] = Pnew[5];
      Pf[fi + 6] = (Pnew[6] + Pnew[9]) / 2;
      Pf[fi + 7] = (Pnew[7] + Pnew[13]) / 2;
      Pf[fi + 8] = Pf[fi + 2];
      Pf[fi + 9] = Pf[fi + 6];
      Pf[fi + 10] = Pnew[10];
      Pf[fi + 11] = (Pnew[11] + Pnew[14]) / 2;
      Pf[fi + 12] = Pf[fi + 3];
      Pf[fi + 13] = Pf[fi + 7];
      Pf[fi + 14] = Pf[fi + 11];
      Pf[fi + 15] = Pnew[15];
    }

    // ── 反向 RTS 递推 ──
    const xs = new Float64Array(n * 4);
    const ln = (n - 1) * 4;
    xs[ln] = xf[ln]; xs[ln + 1] = xf[ln + 1]; xs[ln + 2] = xf[ln + 2]; xs[ln + 3] = xf[ln + 3];

    const A = new Float64Array(16);    // A = P_f[k]·Fᵀ
    const C = new Float64Array(16);    // C = A·inv(P_p[k+1])
    const invW = new Float64Array(16); // 求逆结果工作区
    for (let k = n - 2; k >= 0; k--) {
      // 时间回环防御（与前向一致）：负 dt 会让 Fᵀ 物理意义错误，钳制到极小正值
      let dt = (fixes[k + 1].time - fixes[k].time) / 1000;
      if (!(dt > RTS_MIN_DT)) dt = RTS_MIN_DT;
      const po = k * 16;
      // A = P_f[k]·Fᵀ：这是「列变换」，A[i][j] 取同一行 i 的列元素：
      //   A[i][0] = Pk[i][0] + dt·Pk[i][2]（列 0 的 Fᵀ 形如 [1,0,dt,0]ᵀ）
      //   A[i][1] = Pk[i][1] + dt·Pk[i][3]
      //   A[i][2] = Pk[i][2]，A[i][3] = Pk[i][3]
      // （注意与前向 F·P 的「行变换」索引方向相反，不要混用 Pk[i+2][j]）
      A[0] = Pf[po] + dt * Pf[po + 2];      A[1] = Pf[po + 1] + dt * Pf[po + 3];
      A[2] = Pf[po + 2];                    A[3] = Pf[po + 3];
      A[4] = Pf[po + 4] + dt * Pf[po + 6];  A[5] = Pf[po + 5] + dt * Pf[po + 7];
      A[6] = Pf[po + 6];                    A[7] = Pf[po + 7];
      A[8] = Pf[po + 8] + dt * Pf[po + 10]; A[9] = Pf[po + 9] + dt * Pf[po + 11];
      A[10] = Pf[po + 10];                  A[11] = Pf[po + 11];
      A[12] = Pf[po + 12] + dt * Pf[po + 14]; A[13] = Pf[po + 13] + dt * Pf[po + 15];
      A[14] = Pf[po + 14];                  A[15] = Pf[po + 15];

      // C = A · inv(P_p[k+1])（求逆原地写入 invW，4×4 乘按列向量展开）
      this._inv4x4Into(Pp, (k + 1) * 16, invW);
      for (let r = 0; r < 4; r++) {
        const r4 = r * 4;
        const A0 = A[r4], A1 = A[r4 + 1], A2 = A[r4 + 2], A3 = A[r4 + 3];
        C[r4] = A0 * invW[0] + A1 * invW[4] + A2 * invW[8] + A3 * invW[12];
        C[r4 + 1] = A0 * invW[1] + A1 * invW[5] + A2 * invW[9] + A3 * invW[13];
        C[r4 + 2] = A0 * invW[2] + A1 * invW[6] + A2 * invW[10] + A3 * invW[14];
        C[r4 + 3] = A0 * invW[3] + A1 * invW[7] + A2 * invW[11] + A3 * invW[15];
      }

      // x_s[k] = x_f[k] + C·(x_s[k+1] − x_p[k+1])
      const p4 = k * 4;
      const q4 = (k + 1) * 4;
      const dx0 = xs[q4] - xp[q4], dx1 = xs[q4 + 1] - xp[q4 + 1],
            dx2 = xs[q4 + 2] - xp[q4 + 2], dx3 = xs[q4 + 3] - xp[q4 + 3];
      xs[p4] = xf[p4] + C[0] * dx0 + C[1] * dx1 + C[2] * dx2 + C[3] * dx3;
      xs[p4 + 1] = xf[p4 + 1] + C[4] * dx0 + C[5] * dx1 + C[6] * dx2 + C[7] * dx3;
      xs[p4 + 2] = xf[p4 + 2] + C[8] * dx0 + C[9] * dx1 + C[10] * dx2 + C[11] * dx3;
      xs[p4 + 3] = xf[p4 + 3] + C[12] * dx0 + C[13] * dx1 + C[14] * dx2 + C[15] * dx3;
    }

    // 平滑状态 → lat/lng
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const p4 = i * 4;
      out[i] = {
        lat: refLat + xs[p4 + 1] / M_PER_DEG,
        lng: refLng + xs[p4] / (M_PER_DEG * cosLat),
        time: fixes[i].time,
        ts: fixes[i].ts
      };
    }
    return out;
  }

  /**
   * 4×4 矩阵求逆（高斯-约当消元，复用构造预分配的原地工作区）。
   * 相比旧实现（每步 slice + new 数组）不产生分配，供 RTS 反向递推高频调用。
   * @param {Float64Array} M 扁平矩阵源（行主序）
   * @param {number} off 起始偏移（M 中取 16 个元素）
   * @param {Float64Array} out 输出数组（写入逆矩阵）
   */
  _inv4x4Into(M, off, out) {
    const a = this._rtsInvA;
    const inv = this._rtsInvI;
    for (let i = 0; i < 16; i++) {
      a[i] = M[off + i];
      inv[i] = 0;
    }
    inv[0] = 1; inv[5] = 1; inv[10] = 1; inv[15] = 1;
    for (let col = 0; col < 4; col++) {
      // 选主元（当前列绝对值最大行），避免奇异/数值不稳
      let piv = col;
      for (let r = col + 1; r < 4; r++) {
        if (Math.abs(a[r * 4 + col]) > Math.abs(a[piv * 4 + col])) piv = r;
      }
      if (Math.abs(a[piv * 4 + col]) < 1e-12) {
        // 奇异：返回单位阵兜底（仅理论上不可达）
        out.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        return;
      }
      if (piv !== col) {
        for (let j = 0; j < 4; j++) {
          const t1 = a[col * 4 + j]; a[col * 4 + j] = a[piv * 4 + j]; a[piv * 4 + j] = t1;
          const t2 = inv[col * 4 + j]; inv[col * 4 + j] = inv[piv * 4 + j]; inv[piv * 4 + j] = t2;
        }
      }
      const pivotVal = a[col * 4 + col];
      for (let j = 0; j < 4; j++) {
        a[col * 4 + j] /= pivotVal;
        inv[col * 4 + j] /= pivotVal;
      }
      for (let r = 0; r < 4; r++) {
        if (r === col) continue;
        const factor = a[r * 4 + col];
        if (factor === 0) continue;
        for (let j = 0; j < 4; j++) {
          a[r * 4 + j] -= factor * a[col * 4 + j];
          inv[r * 4 + j] -= factor * inv[col * 4 + j];
        }
      }
    }
    out.set(inv);
  }
}
