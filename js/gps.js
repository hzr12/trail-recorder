/**
 * 圆圈地图 - GPS 定位管理器
 * ============================================
 * 使用浏览器原生 Geolocation API 获取设备位置
 * 支持单次定位 + 持续追踪
 */

/** 角度转弧度系数（多次使用，避免重复 Math.PI / 180） */
const DEG2RAD = Math.PI / 180;
/** 纬度方向的米/度近似系数（赤道约 111111m/°），经度方向需乘 cos(lat) */
const M_PER_DEG = 111111;
/** 2×2 协方差 S 求逆的奇异保护阈值（det 低于此值视为奇异，退化处理） */
const S_DET_EPSILON = 1e-9;
/** RTS 时间回环防御：段内出现 dt<=0 时钳制的极小时间窗（秒） */
const RTS_MIN_DT = 1e-6;

/**
 * 二维卡尔曼滤波器 — 2D 恒速模型（位置+速度矢量），局部 ENU 米坐标
 * 以首次定位为参考点，lat/lng → 米滤波 → 逆变换输出
 * Q/R 自适应 accuracy，速度更新带阻尼 + 模量限幅
 * 更新采用 Huber Loss 鲁棒化（M-估计）：超出阈值的测量残差降权，抑制 GPS 粗差/漂移点
 */
class KalmanFilter {
  constructor() {
    this._x = 0;          // 位置估计 x（米，相对参考点）
    this._y = 0;          // 位置估计 y（米，相对参考点）
    this._vx = 0;         // 速度估计 vx（米/秒）
    this._vy = 0;         // 速度估计 vy（米/秒）
    // 协方差 P（4×4 行主序 [x, y, vx, vy]）
    // 所有临时数组在构造时一次性预分配（Float64Array 固定内存），update() 只读写不新建，
    // 消除高频定位下的 GC 压力
    this._P = new Float64Array(16);     // 状态协方差
    this._fp = new Float64Array(16);    // 前向投影 F·P
    this._Ppred = new Float64Array(16); // 预测协方差 P⁻ = F·P·Fᵀ + Q
    this._IKH = new Float64Array(16);   // I − K·H
    this._Pnew = new Float64Array(16);  // (I−K·H)·P⁻ 中间结果
    this._setInitP(25);   // 初始速度不确定度 5m/s → 方差 25
    this._refLat = 0;     // 参考点纬度（度）
    this._refLng = 0;     // 参考点经度（度）
    this._cosLat = 1;     // cos(refLat)，经度→米换算系数
    this._lastTime = 0;
    this._initialized = false;
    this._lastFiltered = null;   // 最近一次滤波输出缓存（精度差时冻结用）

    // Huber Loss 鲁棒更新：0 表示禁用（纯最小二乘）。
    // |残差|/σ ≤ k 的点正常更新；超过的点残差收缩到 k·σ（M-估计），抑制 GPS 粗差/漂移点。
    // 这里存的是「基准值」（CONFIG.GPS_HUBER_K），实际生效阈值由 _huberKFor()
    // 按速度+精度启发式在基准值基础上自适应缩放（用户无需也无法手动调参）。
    this._huberK = (typeof CONFIG !== 'undefined' && CONFIG.GPS_HUBER_K != null)
      ? CONFIG.GPS_HUBER_K : 2.0;
    this._lastHuberK = this._huberK > 0 ? this._huberK : 0; // 最近一次实际生效的 K（调试用）

    // RTS 离线平滑的求逆工作区（构造时预分配，避免平滑期逐点分配）
    this._rtsInvA = new Float64Array(16); // inv 高斯-约当：当前矩阵副本
    this._rtsInvI = new Float64Array(16); // inv 高斯-约当：单位阵侧
  }

  /**
   * 原地填充初始协方差（位置不确定度 50m → 2500m²，速度方差可指定）
   * @param {number} speedVar 速度方差（m²/s²），新轨迹未知取 0，恢复会话取 25
   */
  _setInitP(speedVar) {
    this._P.fill(0);
    this._P[0] = 2500;
    this._P[5] = 2500;
    this._P[10] = speedVar;
    this._P[15] = speedVar;
  }

  /**
   * 重置滤波器并设置初始值（当前点即参考点）
   */
  init(lat, lng, time) {
    this._refLat = lat;
    this._refLng = lng;
    this._cosLat = Math.cos(lat * DEG2RAD);
    this._x = 0;
    this._y = 0;
    this._vx = 0;
    this._vy = 0;
    this._setInitP(0);   // 新轨迹速度未知 → 速度方差 0（原地填充，避免 GC）
    this._lastTime = time;
    this._initialized = true;
    this._lastFiltered = { lat, lng };
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
   * 更新测量值 → 返回滤波后结果
   * @param {number} zLat 测量纬度
   * @param {number} zLng 测量经度
   * @param {number} accuracy GPS 精度（米）
   * @param {number} time 时间戳（毫秒）
   * @param {number} [speed] 速度（m/s），用于动态调整响应
   * @returns {{lat: number, lng: number}} 滤波后坐标
   */
  update(zLat, zLng, accuracy, time, speed) {
    if (!this._initialized) {
      // 未初始化 → 以测量为初始状态
      this.init(zLat, zLng, time);
      this._lastFiltered = { lat: zLat, lng: zLng };
      return { lat: zLat, lng: zLng };
    }
    if (accuracy > 2000) {
      // 精度极差（>2000m，地下/信号遮挡）：测量坐标不可信，保持上次滤波输出（冻结），
      // 避免「init 重置 + 接受跳变测量」导致的轨迹被突然拉回又回去。
      // 实时显示位置暂停，但 _rawFixes 仍记录原始测量，结束记录后 RTS 离线平滑
      // 会用未来测量修正这段轨迹，最终落库的是修正后的路径。
      // 更新时间戳，避免信号恢复时 dt 过大触发重置、再次跳变。
      this._lastTime = time;
      return this._lastFiltered || { lat: zLat, lng: zLng };
    }

    const dt = (time - this._lastTime) / 1000; // 秒
    this._lastTime = time;

    if (dt <= 0 || dt > 60) {
      // 时间异常或间隙过大 → 重置
      this.init(zLat, zLng, time);
      return { lat: zLat, lng: zLng };
    }

    // 坐标正变换：lat/lng → 局部米
    let mx = (zLng - this._refLng) * M_PER_DEG * this._cosLat;
    let my = (zLat - this._refLat) * M_PER_DEG;

    // 距参考点超 3km → 重新锚定（x/y 平移，速度不变）
    if (Math.hypot(mx, my) > 3000) {
      this._reanchor();
      mx = (zLng - this._refLng) * M_PER_DEG * this._cosLat;
      my = (zLat - this._refLat) * M_PER_DEG;
    }

    // 动态 q（m/s²）：精度好时跟手（响应快），精度差时平滑（抑制噪声）
    // 系数 0.5 + 速度自适应 speedFactor（clamp(speed/0.5,1,12)）：
    // 静止 q=0.1、步行 1.5m/s q=0.3、高速 40m/s q=1.2 m/s²。
    // 经参数扫描校准（5 次运行全过：静止 RMSE 2.3-2.9m ≤3.5；轨迹 RMSE
    // 3.4-3.8m < 1D 3.9-4.1m；重锚 40m/s 误差 40m <60m。原固定 sf=3 时
    // 高速场景速度收敛过慢 → 重锚误差 97.5m 超标）
    const accClamped = Math.max(Math.min(accuracy || 10, 2000), 1);
    const speedFactor = Math.min(12, Math.max(1, (speed || 0) / 0.5)); // 速度越快机动越强，q 越大
    const q = Math.max(0.1, (0.5 / accClamped) * speedFactor);

    // ── Predict（预测）──
    this._x += this._vx * dt;
    this._y += this._vy * dt;
    const dt2 = dt * dt;
    // P⁻ = F·P·Fᵀ + Q（Q: DWNA 块对角，q²·[¼dt⁴, ½dt³; ½dt³, dt²]）
    const q2 = q * q;
    const q00 = 0.25 * q2 * dt2 * dt2;
    const q02 = 0.5 * q2 * dt2 * dt;
    const q22 = q2 * dt2;
    // F·P（F: [1,0,dt,0; 0,1,0,dt; 0,0,1,0; 0,0,0,1]）→ 写入预分配 this._fp
    // 正确展开：A[i][j] = P[i][j] + dt·P[(i+2)][j]（i<2 时，列方向 j 遍历）；i≥2 时 A[i][j] = P[i][j]
    for (let i = 0; i < 4; i++) {
      const dRow = i < 2 ? dt : 0;
      const pr = i * 4;
      // i≥2 时 dRow=0，不读取越界行（i+2 行超出 4×4 范围，避免 0×undefined=NaN）
      const pr2 = i < 2 ? (i + 2) * 4 : pr;
      this._fp[pr + 0] = this._P[pr + 0] + dRow * this._P[pr2 + 0];
      this._fp[pr + 1] = this._P[pr + 1] + dRow * this._P[pr2 + 1];
      this._fp[pr + 2] = this._P[pr + 2] + dRow * this._P[pr2 + 2];
      this._fp[pr + 3] = this._P[pr + 3] + dRow * this._P[pr2 + 3];
    }
    // (F·P)·Fᵀ：B[i][0]=A[i][0]+dt·A[i][2], B[i][1]=A[i][1]+dt·A[i][3], B[i][2]=A[i][2], B[i][3]=A[i][3]
    // → 写入预分配 this._Ppred
    for (let i = 0; i < 4; i++) {
      this._Ppred[i * 4 + 0] = this._fp[i * 4 + 0] + dt * this._fp[i * 4 + 2];
      this._Ppred[i * 4 + 1] = this._fp[i * 4 + 1] + dt * this._fp[i * 4 + 3];
      this._Ppred[i * 4 + 2] = this._fp[i * 4 + 2];
      this._Ppred[i * 4 + 3] = this._fp[i * 4 + 3];
    }
    // + Q（DWNA 块对角，对称叠加：行主序 P00/P11/P22/P33 对角，P02=P20、P13=P31 交叉对）
    this._Ppred[0] += q00;  this._Ppred[5] += q00;   // 位置对角 (x,x),(y,y)
    this._Ppred[2] += q02;  this._Ppred[8] += q02;   // x/vx 交叉（对称对）
    this._Ppred[7] += q02;  this._Ppred[13] += q02;  // y/vy 交叉（对称对）
    this._Ppred[10] += q22; this._Ppred[15] += q22;  // 速度对角 (vx,vx),(vy,vy)

    // ── Update（更新）──
    const sigma = Math.max(3, Math.min(accClamped, 2000)); // 米
    const r = sigma * sigma;
    // S = H·P⁻·Hᵀ + R（2×2：P 的位置块 + diag(r, r)）
    const s00 = this._Ppred[0] + r, s01 = this._Ppred[1],
          s10 = this._Ppred[4], s11 = this._Ppred[5] + r;
    const det = s00 * s11 - s01 * s10;
    // 数值稳定性：det 过小 → S 奇异（GPS 精度极高且滤波器极度自信时 P→0 的极端数值退化）。
    // 直接做 s/det 会得到 Infinity/NaN 污染状态并剧烈震荡。退化时重置并接受测量（安全回退）。
    if (!(Math.abs(det) > S_DET_EPSILON)) {
      this.init(zLat, zLng, time);
      this._lastFiltered = { lat: zLat, lng: zLng };
      return { lat: zLat, lng: zLng };
    }
    const si00 = s11 / det, si01 = -s01 / det, si10 = -s10 / det, si11 = s00 / det;
    // K = P⁻·Hᵀ·S⁻¹（4×2，取 P 前两列 × S⁻¹）
    const k00 = (this._Ppred[0] * si00 + this._Ppred[1] * si10);
    const k01 = (this._Ppred[0] * si01 + this._Ppred[1] * si11);
    const k10 = (this._Ppred[4] * si00 + this._Ppred[5] * si10);
    const k11 = (this._Ppred[4] * si01 + this._Ppred[5] * si11);
    const k20 = (this._Ppred[8] * si00 + this._Ppred[9] * si10);
    const k21 = (this._Ppred[8] * si01 + this._Ppred[9] * si11);
    const k30 = (this._Ppred[12] * si00 + this._Ppred[13] * si10);
    const k31 = (this._Ppred[12] * si01 + this._Ppred[13] * si11);

    // Huber Loss 鲁棒更新（与离线 RTS 一致）：按标准化残差降权粗差/漂移点。
    // e 服从 ~N(0, S)，|e|/√S 超过阈值 k 的测量残差收缩到 k·√S（M-估计）。
    // 平方比较避免开方；k=0 时退化为标准最小二乘更新。
    let e0 = mx - this._x;
    let e1 = my - this._y;
    // 自适应 K：低速静止漂移压狠、高速机动放宽、精度差收紧（用户无需手动调参）
    const hk = (this._lastHuberK = this._huberKFor(speedFactor, accClamped));
    if (hk > 0) {
      const n0 = e0 * e0 / s00, n1 = e1 * e1 / s11;
      if (n0 > hk * hk) e0 *= hk / Math.sqrt(n0);
      if (n1 > hk * hk) e1 *= hk / Math.sqrt(n1);
    }
    this._x += k00 * e0 + k01 * e1;
    this._y += k10 * e0 + k11 * e1;

    // 速度更新：增益 k20/k21 的量纲为 1/s（协方差比），k20·e 即为 m/s 速度增量，
    // 无需再除 dt 也无需手动阻尼系数——速度自适应完全交给动态 Q。原先的
    // 「0.3 阻尼 + /dtSafe」实为掩盖「多除了 dt」的维度错误，现已修正。
    this._vx += k20 * e0 + k21 * e1;
    this._vy += k30 * e0 + k31 * e1;

    // 速度模量限幅（120m/s ≈ 432km/h，防止突发漂移）
    const spd = Math.hypot(this._vx, this._vy);
    if (spd > 120) {
      const k = 120 / spd;
      this._vx *= k;
      this._vy *= k;
    }

    // P = (I − K·H)·P⁻，随后对称化（全部写入预分配数组）
    this._IKH[0] = 1 - k00;  this._IKH[1] = -k01;  this._IKH[2] = 0;  this._IKH[3] = 0;
    this._IKH[4] = -k10;     this._IKH[5] = 1 - k11; this._IKH[6] = 0; this._IKH[7] = 0;
    this._IKH[8] = -k20;     this._IKH[9] = -k21;  this._IKH[10] = 1; this._IKH[11] = 0;
    this._IKH[12] = -k30;    this._IKH[13] = -k31; this._IKH[14] = 0; this._IKH[15] = 1;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += this._IKH[i * 4 + k] * this._Ppred[k * 4 + j];
        this._Pnew[i * 4 + j] = sum;
      }
    }
    // 对称化 (P + Pᵀ) / 2
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        this._P[i * 4 + j] = (this._Pnew[i * 4 + j] + this._Pnew[j * 4 + i]) / 2;
      }
    }

    // 逆变换：米 → lat/lng
    const filtered = {
      lat: this._refLat + this._y / M_PER_DEG,
      lng: this._refLng + this._x / (M_PER_DEG * this._cosLat)
    };
    this._lastFiltered = filtered;
    return filtered;
  }

  /**
   * 重新锚定参考点到当前状态位置（x/y 平移，速度不变）
   * 速度协方差（P 中 vx、vy 对角元素）放大 ×2：
   * 触发重锚说明已移动较长距离，期间速度可能已变化，适度放大速度不确定度
   * 可让滤波器对后续速度变化更敏感（更快收敛），又不至于完全重置丢失历史。
   */
  _reanchor() {
    // 当前估计位置成为新参考点（x/y 平移，速度不变）
    const curLat = this._refLat + this._y / M_PER_DEG;
    const curLng = this._refLng + this._x / (M_PER_DEG * this._cosLat);
    this._refLat = curLat;
    this._refLng = curLng;
    this._cosLat = Math.cos(curLat * DEG2RAD);
    this._x = 0;
    this._y = 0;
    // 触发重锚说明已移动较长距离，期间速度可能已变化：
    // 适度放大速度不确定度（×2），让滤波器对后续速度变化更敏感，又不至于完全重置
    this._P[10] *= 2; // vx 协方差放大 ×2
    this._P[15] *= 2; // vy 协方差放大 ×2
  }

  /** 重置滤波器（原地填充，避免 GC） */
  reset() {
    this._initialized = false;
    this._x = 0;
    this._y = 0;
    this._vx = 0;
    this._vy = 0;
    this._setInitP(0);
    this._lastFiltered = null;
  }

  /**
   * 离线批处理 RTS（Rauch–Tung–Striebel）平滑
   * 对整段原始测量序列做「前向滤波 + 反向递推」，利用未来测量修正历史状态，
   * 显著降低轨迹滞后与抖动（实时滤波的 RMSE 通常可再降 30~40%）。
   * 输入输出均为 WGS84 坐标；内部在局部米坐标系下运算，参考点取段首。
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
    // 分段：时间断裂 / 精度失效 / 距段首超 3km（重锚等价物）→ 段边界
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
        const breakSeg = dt <= 0 || dt > 60 || (f.accuracy || 0) > 2000 || Math.hypot(mx, my) > 3000;
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
      // 动态 q（与 update() 完全一致）
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

      // Predict：P⁻ = F·P·Fᵀ + Q（F 恒速模型，解析展开，与 update() 两次循环等价）
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

      // Update：S、K 计算与 update() 一致
      const sigma = Math.max(3, Math.min(accClamped, 2000));
      const r = sigma * sigma;
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

      // Huber Loss 鲁棒更新（与实时 update() 一致）：粗差/漂移点残差降权。
      // K 按该点速度/精度自适应（与 update() 相同启发式）
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

/**
 * IMU 惯性传感器管理器 — 仅定位校准（加速度注入辅助滤波）。
 *
 * 职责收窄（本次重引入的唯一形态）：
 *  - 只消费 TYPE_LINEAR_ACCELERATION（去重力线性加速度）→ rotation 四元数旋转到 ENU
 *    地理系 → 1s 窗口均值 → 一阶低通 → 供 GPSManager 在每次滤波 update 前 feedImu()
 *    注入 ImmFilter CA 模型预测（仅运动学先验，GPS 仍是位置权威）。
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

    // 1s 聚合窗口（ENU 三轴累加）
    this._winAcc = [0, 0, 0];
    this._winCount = 0;
    this._winStart = 0;
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

  /** 启动监听（25Hz 事件流），重复调用自动忽略 */
  start() {
    if (!this._enabled || !this._plugin || this._listening || this._starting) {
      return Promise.resolve(false);
    }
    this._starting = (async () => {
      try {
        // 先注册监听器再启动：Java 端注册传感器后立即开始回调（25Hz），
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
    this._winAcc[0] = 0;
    this._winAcc[1] = 0;
    this._winAcc[2] = 0;
    this._winCount = 0;
    this._winStart = 0;
  }

  /** 25Hz 事件：聚合 → 满窗口输出均值 → 低通 */
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
    if (this._winCount === 0) this._winStart = now;
    this._winAcc[0] += accEnu[0];
    this._winAcc[1] += accEnu[1];
    this._winAcc[2] += accEnu[2];
    this._winCount++;

    if (this._winCount > 0 && now - this._winStart >= this._feedInterval) {
      const inv = 1 / this._winCount;
      const meanE = this._winAcc[0] * inv;
      const meanN = this._winAcc[1] * inv;
      const meanU = this._winAcc[2] * inv;
      this._winAcc[0] = 0; this._winAcc[1] = 0; this._winAcc[2] = 0;
      this._winCount = 0;
      this._winStart = now;
      // 一阶低通（α=1 全信最新均值，α=0 保持旧值）+ 限幅
      const a = this._lpfAlpha;
      const pe = this._lastAccEnu ? this._lastAccEnu[0] : meanE;
      const pn = this._lastAccEnu ? this._lastAccEnu[1] : meanN;
      const e = Math.max(-this._clamp, Math.min(this._clamp, pe + a * (meanE - pe)));
      const n = Math.max(-this._clamp, Math.min(this._clamp, pn + a * (meanN - pn)));
      this._lastAccEnu = [e, n];
    }
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

class GPSManager {
  constructor() {
    this.watchId = null;
    this.currentPosition = null;
    this.isWatching = false;
    this._destroyed = false;

    // 回调钩子
    this.onPositionChange = null;
    this.onError = null;
    this.onWatchStart = null;
    this.onWatchStop = null;
    this.onSatellitesChange = null; // GNSS 卫星数据更新（事件/轮询统一入口触发）
    this.onDowngrade = null;   // 降级回调 (timeout) => void
    this.onRecovery = null;    // 恢复回调 (success: boolean) => void
    this.onPowerSavingChange = null; // 省电模式变更回调 (isOn: boolean) => void
    this.onCriticalBattery = null;   // 低电量自动停止回调 () => void
    this.onRestoreTracking = null;   // 电量恢复自动恢复追踪回调 () => void
    this.onWeakSignalChange = null;  // GNSS 弱信号状态变更回调 (weak: boolean) => void

    // GPS 超时降级状态
    this._consecutiveTimeouts = 0;  // 连续超时次数
    this._downgraded = false;       // 是否已降级到低精度
    this._lastPositionTime = 0;     // 上次收到位置的时间戳
    this._timeoutCheckId = null;    // 超时检测定时器
    this._recoveryTimerId = null;   // 恢复尝试定时器

    // GNSS 插件（Capacitor 原生端卫星数据）
    this._gnssPlugin = null;       // Capacitor.Plugins.GnssData 引用
    this._gnssSatellites = [];     // GnssSatelliteInfo[]
    this._satStatsCache = null;    // 卫星统计预计算缓存（见 _handleGnssSatellites）
    this._gnssInitError = null;    // 初始化失败原因
    this._gnssListeningStarted = false; // startGnss() 是否已调用
    this._gnssStarting = null;     // startGnss() 的 Promise，防止并发
    this._gnssStopRequested = false; // stopGnss() 在启动过程中被调用时置位，中止启动
    this._gnssPollRunning = false;  // GNSS 轮询兜底是否正在执行
    this._gnssStatusHandle = null; // gnssStatus 事件监听器句柄
    this._gnssNmeaHandle = null;   // nmeaSentence 事件监听器句柄
    this._gnssPollId = null;       // GNSS 轮询兜底定时器
    this._lastVtg = null;          // 最近一条 $GPVTG 航向/速度（VTG 优先源）
    this._utcOffsetMs = 0;         // 设备时钟校准偏移（RMC UTC - 本地时钟，±12h 过滤）
    this._lastUtcReceivedAt = 0;   // 上次采纳 UTC 的时间（防旧 NMEA 回灌）

    // GNSS NMEA 增强（定位源接管 / GGA 海拔 / GSA DOP / RMC 交叉验证）
    this._lastRmc = null;          // $GPRMC：定位有效性 + 速度/航向交叉源 + 经纬度
    this._lastGga = null;          // $GPGGA：海拔 MSL + 大地水准面分离 + 经纬度
    this._lastGsa = null;          // $G?GSA：PDOP/HDOP/VDOP
    this._gpsSource = 'fallback';  // 定位源状态：native（原生主导）| browser（浏览器顶上）| fallback（无插件）
    this._sourceNativeCnt = 0;     // 切 native 持续计数（滞回防抖）
    this._sourceBrowserCnt = 0;    // 切 browser 持续计数（滞回防抖）
    this._lastSourceEvalAt = 0;    // evaluateSource 节流时间戳（NMEA 高频到达时限制评估频率）
    this._nativeLat = null;        // 最近可信原生坐标纬度（坐标交叉校验用）
    this._nativeLng = null;        // 最近可信原生坐标经度
    this._coordConflictStreak = 0; // 原生 vs 浏览器偏差连续超阈计数
    this._nativeCoordTrusted = true; // 原生坐标是否可信（连续超阈后置 false，恢复后回到 true）

    // GPS 漂移滤波器
    this._useFilter = true;           // 是否启用滤波
    // 实时：IMM 交互式多模型（6 维×3 模型，取代单模型自适应 Q；false 回退单模型）
    this._filter = (typeof CONFIG !== 'undefined' && CONFIG.IMM_FILTER_ENABLED !== false)
      ? new ImmFilter()
      : new KalmanFilter();
    // 离线 RTS 平滑：独立单模型实例（实时/离线彻底解耦，离线保持已调优的 4 维 RTS）
    this._offlineSmoother = new KalmanFilter();
    this._rawPosition = null;         // 滤波前的原始位置（保留供 trail 等使用）
    this._rawFixes = [];              // 原始测量缓冲（WGS84，滤波前），供结束记录时 RTS 离线平滑
    this._maxRawFixes = 50000;        // 缓冲上限（超出丢弃最旧，防止内存膨胀）

    // 海拔独立滤波链（L2 自适应卡尔曼 + L3 中值/Huber 实时，L4 离线 1D RTS）
    this._altFilter = new AltFilterPipeline();
    this._altRts = new AltRtsSmoother();

    // 电量监控
    this._lowBattery = false;   // 是否处于低电量状态（<20%）
    this._powerSaving = false;  // 省电模式开关
    this._powerSavingLocked = false;  // 省电模式锁定（低电量时锁定开启）
    this._battery = null;       // BatteryManager 引用（用于清理）
    this._batteryCheck = null;  // 电池检查函数引用（用于清理）
    this._autoStoppedByBattery = false;  // 是否因低电量自动停止追踪
    this._initBatteryMonitor();
    this._tryInitGnssPlugin();

    // GPS 节流：速度自适应动态间隔（移动快→密，静止 60s 心跳省电）
    this._lastProcessedTime = 0;
    this._lastActualInterval = 0;
    this._gpsMinInterval = 1000;
    this._gpsPowerSavingInterval = 20000;   // 省电模式间隔
    this._gpsBackgroundInterval = 15000;    // 后台定位间隔
    this._bestPendingPosition = null;       // 节流窗口内精度最优的位置缓存

    // GNSS 弱信号降级状态机（独立于 powerSaving，不关闭 GNSS 监听以便监测恢复）
    this._weakSignal = false;          // 是否处于弱信号省电降级
    this._weakCnt = 0;                 // 弱信号持续计数（GNSS 事件约 1s/次）
    this._strongCnt = 0;               // 强信号持续计数（滞回恢复）

    // IMU 惯性传感器（仅定位校准：加速度注入辅助滤波，随 watch 生命周期启停）
    this._imuManager = new ImuManager();
    this._imuStarted = false;          // 本次 watch 会话内 IMU 是否已启动
    this._imuManager._tryInitPlugin(); // web 无插件 → 静默零回归

  }

  /**
   * 百度式速度自适应节流：间隔 = K / 速度（clamp 1s~60s）
   * 移动越快定位越密，静止 60s 心跳（长时间记录省电核心）
   * 速度未知（无速度源）时按步行假设 ~5s 保守节流
   * 省电模式按 20s 下限取 max
   * @param {number} [speed] 上次定位速度（m/s）
   */
  _updateAdaptiveInterval(speed) {
    const s = typeof speed === 'number' && isFinite(speed) ? speed : null;
    let base;
    if (s === null) base = CONFIG.GPS_ADAPTIVE_K / 1.6; // 无速度源 → 按步行 ~5s
    else if (s <= 0) base = CONFIG.GPS_MAX_INTERVAL;    // 静止 → 60s 心跳
    else base = CONFIG.GPS_ADAPTIVE_K / s;              // 移动 → K/速度
    let interval = Math.min(Math.max(base, CONFIG.GPS_MIN_INTERVAL), CONFIG.GPS_MAX_INTERVAL);
    if (this._powerSaving) interval = Math.max(interval, this._gpsPowerSavingInterval);
    // 弱信号降级：心跳间隔拉长至 GPS_WEAK_SIGNAL_INTERVAL（省电），恢复后自动回落
    if (this._weakSignal) interval = Math.max(interval, CONFIG.GPS_WEAK_SIGNAL_INTERVAL);
    this._gpsMinInterval = Math.round(interval);
  }

  /**
   * 初始化电池监控 — 低电量时降低 GPS 频率
   */
  _initBatteryMonitor() {
    if (!navigator.getBattery) return;
    navigator.getBattery().then(battery => {
      if (this._destroyed) return;
      this._battery = battery;
      this._batteryCheck = () => {
        const wasLow = this._lowBattery;
        this._lowBattery = battery.level < 0.2;
        if (this._lowBattery && !wasLow) {
          console.warn('[GPS] 电量低于 20%，已降低 GPS 频率');
          // 低电量时锁定省电模式
          this._powerSavingLocked = true;
          if (!this._powerSaving) {
            this.togglePowerSaving(true);
            if (this.onPowerSavingChange) this.onPowerSavingChange(true);
            // togglePowerSaving已重启watchPosition，跳过显式重启
          } else {
            // 省电已开启，仅用更严格参数重启
            if (this.isWatching) {
              this.stopWatching();
              this.startWatching({ enableHighAccuracy: false, timeout: 15000, maximumAge: 15000 });
            }
          }
        }
        // 电量 < 10%：自动停止追踪
        if (battery.level < 0.1 && this.isWatching) {
          console.warn('[GPS] 电量低于 10%，自动停止追踪');
          this._autoStoppedByBattery = true;
          this.stopWatching();
          if (this.onCriticalBattery) this.onCriticalBattery();
        }

        // 电量 < 5%：强制停止所有耗电功能（含 GNSS）
        if (battery.level < 0.05 && !battery.charging) {
          console.warn('[GPS] 电量低于 5%，强制停止所有定位功能');
          if (this._gnssListeningStarted) this.stopGnss();
          // 如果 watch 还在跑（上面阈值没触发），也停掉
          if (this.isWatching) {
            this._autoStoppedByBattery = true;
            this.stopWatching();
            if (this.onCriticalBattery) this.onCriticalBattery();
          }
        }
        // 充电时解锁省电模式并恢复追踪
        if (!this._lowBattery && this._powerSavingLocked && battery.charging) {
          this._powerSavingLocked = false;
          if (CONFIG.DEBUG) console.log('[GPS] 电量恢复，省电模式已解锁');
          // 如果是因低电量自动停止的，恢复追踪
          if (this._autoStoppedByBattery && this.onRestoreTracking) {
            this._autoStoppedByBattery = false;
            this.onRestoreTracking();
          }
        }
      };
      battery.addEventListener('levelchange', this._batteryCheck);
      battery.addEventListener('chargingchange', this._batteryCheck);
      this._batteryCheck();
    }).catch(() => {});
  }

  /**
   * 清理电池监控监听器
   */
  _cleanupBatteryMonitor() {
    if (this._battery && this._batteryCheck) {
      this._battery.removeEventListener('levelchange', this._batteryCheck);
      this._battery.removeEventListener('chargingchange', this._batteryCheck);
      this._battery = null;
      this._batteryCheck = null;
    }
  }

  /**
   * 切换省电模式
   * @param {boolean} [force] - 强制设置，不传则切换
   * @returns {boolean} 当前省电模式状态
   */
  togglePowerSaving(force) {
    // 锁定时不允许关闭
    if (this._powerSavingLocked && force === false) {
      console.warn('[GPS] 电量不足，省电模式已锁定');
      return true;
    }
    const next = force !== undefined ? force : !this._powerSaving;
    if (next === this._powerSaving) return this._powerSaving;
    this._powerSaving = next;
    if (CONFIG.DEBUG) console.log(`[GPS] 省电模式: ${next ? '开启' : '关闭'}`);

    // 调整处理间隔（速度自适应，省电模式按 20s 下限）
    this._updateAdaptiveInterval(this.currentPosition ? this.currentPosition.speed : 0);

    // 省电模式下关闭 GNSS 卫星监听（节省 CPU + 电池）
    if (next && this._gnssListeningStarted) {
      if (CONFIG.DEBUG) console.log('[GPS] 省电模式：关闭 GNSS 卫星监听');
      this.stopGnss();
    } else if (!next && !this._gnssListeningStarted && this._gnssPlugin) {
      // 退出省电且 GNSS 插件存在 → 尝试重新激活
      // 由外部在适当时机调用 startGnss()
    }

    // 省电模式：IMU 同步关闭（节省传感器耗电 + 暂停校准），退出时随 watch 重启自动恢复
    if (next) this._stopImu();

    if (this.isWatching) {
      this.stopWatching();
      if (next) {
        // 省电模式：低精度 + 长超时 + 允许缓存 + 宽松节流
        this.startWatching({ enableHighAccuracy: false, timeout: 15000, maximumAge: 30000 });
      } else {
        // 标准模式：高精度 + 短超时
        this.startWatching({ enableHighAccuracy: true, timeout: CONFIG.GPS_WATCH_TIMEOUT, maximumAge: 2000 });
      }
    }
    return this._powerSaving;
  }

  /**
   * 获取省电模式状态
   */
  get isPowerSaving() {
    return this._powerSaving;
  }

  /**
   * 获取省电模式是否锁定
   */
  get isPowerSavingLocked() {
    return this._powerSavingLocked;
  }

  /**
   * 是否处于 GNSS 弱信号省电降级
   */
  get isWeakSignal() {
    return this._weakSignal;
  }

  /**
   * 获取当前节流间隔（毫秒）
   */
  get currentInterval() {
    return this._gpsMinInterval;
  }

  /**
   * 获取上次实际定位间隔（毫秒）
   */
  get lastActualInterval() {
    return this._lastActualInterval;
  }

  /**
   * 探测 Capacitor GNSS 原生插件是否存在。
   * 仅存储插件引用，不启动监听——监听需要定位权限，延迟到 startGnss() 调用。
   */
  _tryInitGnssPlugin() {
    if (typeof Capacitor === 'undefined' || !Capacitor.Plugins) {
      this._gnssInitError = 'not_capacitor';
      console.info('[GPS] 非 Capacitor 环境，跳过 GNSS 插件探测');
      return;
    }
    const plugin = Capacitor.Plugins.GnssData;
    if (!plugin) {
      this._gnssInitError = 'plugin_not_registered';
      console.info('[GPS] 未注册 GnssData 插件，跳过 GNSS 卫星数据');
      return;
    }
    this._gnssPlugin = plugin;
    if (CONFIG.DEBUG) console.log('[GPS] GNSS 插件已探测到，等待 startGnss() 激活');
  }

  /**
   * 激活 GNSS 监听（注册卫星状态 + NMEA 回调）。
   * 需确认定位权限已授予后调用，由 app.js 在首次定位成功后触发。
   */
  async startGnss() {
    if (!this._gnssPlugin) {
      // 尝试重新探测（Capacitor 可能延迟加载）
      this._tryInitGnssPlugin();
      if (!this._gnssPlugin) {
        console.warn('[GPS] startGnss 跳过：无 GNSS 插件引用');
        return;
      }
    }
    if (this._gnssListeningStarted) {
      return; // 已启动
    }
    // 防止并发调用（用 Promise 作为 mutex）
    if (this._gnssStarting) {
      return this._gnssStarting;
    }
    this._gnssStopRequested = false; // 新的启动请求清除停止标记
    this._gnssGeneration = (this._gnssGeneration || 0) + 1;
    const myGen = this._gnssGeneration;
    this._gnssStarting = this._startGnssImpl();
    try {
      await this._gnssStarting;
    } finally {
      // 仅当没有新的 startGnss() 调用时才清除
      if (this._gnssGeneration === myGen) {
        this._gnssStarting = null;
      }
    }
  }

  /**
   * startGnss() 的实际实现
   */
  async _startGnssImpl() {
    try {
      // 先请求 Capacitor 权限（与浏览器 GPS 权限是独立的）
      if (typeof Capacitor !== 'undefined' && Capacitor.requestPermissions) {
        const result = await Capacitor.requestPermissions({ permissions: ['location'] });
        if (result.location !== 'granted') {
          console.warn('[GPS] GNSS 权限未授予:', result.location);
          this._gnssInitError = 'permission_denied';
          return;
        }
      }

      //  先注册监听器，再调用 startGnssListening()
      // 原因：Java 端 registerGnssCallback() 会立即开始回调，
      // 如果先 start 后 addListener，第一批卫星事件会被丢弃（竞态条件）
      const gnssHandler = (event) => {
        if (event && event.satellites) {
          this._handleGnssSatellites(event.satellites);
          if (CONFIG.DEBUG) console.log('[GPS] GNSS 事件收到，卫星数:', event.satellites.length);
        }
      };
      const nmeaHandler = (nmea) => {
        if (nmea && nmea.sentence) {
          if (CONFIG.DEBUG) console.log('[GPS] NMEA:', nmea.sentence.substring(0, 20) + '...');
          this._parseNmea(nmea.sentence);
        }
      };

      // 先注册（Capacitor v3+ 的 addListener 返回 Promise<PluginListenerHandle>，必须 await 拿到真实句柄）
      try {
        this._gnssStatusHandle = await this._gnssPlugin.addListener('gnssStatus', gnssHandler);
        this._gnssNmeaHandle = await this._gnssPlugin.addListener('nmeaSentence', nmeaHandler);
      } catch (listenErr) {
        // 监听器注册失败 → 交给外层 catch 统一清理（会移除已注册的第一个句柄）
        throw listenErr;
      }

      // 再启动原生监听
      try {
        await this._gnssPlugin.startGnssListening();
      } catch (startErr) {
        // 把 PermissionDenied 直接显式说清楚，方便排查
        const code = startErr && startErr.code ? String(startErr.code) : 'NO_CODE';
        const msg = `[${code}] ${startErr?.message || '未知'}`;
        console.warn('[GPS] startGnssListening 拒绝:', msg);
        if (code === 'PERMISSION_DENIED') {
          Toast.show(` ACCESS_FINE_LOCATION 权限被拒 — 请到系统设置→应用→途刻→位置，开启"始终允许"`, 6000);
        }
        throw startErr;
      }

      // 启动期间 stopGnss() 被调用 → 立即中止，避免僵尸"已激活"状态（有标志无监听）
      if (this._gnssStopRequested) {
        this._removeGnssListeners();
        try { this._gnssPlugin.stopGnssListening?.(); } catch (_) {}
        this._gnssSatellites = [];
        this._gnssInitError = null;
        return;
      }
      this._gnssListeningStarted = true;
      this._gnssInitError = null;
      if (CONFIG.DEBUG) console.log('[GPS] GNSS 插件已激活，卫星数据可用');

      // 兜底轮询：前 15 秒每 2 秒主动拉取一次，防止事件丢失
      this._startGnssPollFallback();
    } catch (err) {
      this._gnssInitError = err.message || 'start_failed';
      console.warn('[GPS] GNSS 插件激活失败:', err.message);
      Toast.show(` GNSS 启动失败: ${err.message || '未知错误'}`, 4000);
      // 清理：移除 JS 监听器 + 停止原生 GNSS 监听
      this._removeGnssListeners();
      if (this._gnssPlugin && this._gnssListeningStarted) {
        try { this._gnssPlugin.stopGnssListening?.(); } catch (_) {}
      }
      this._gnssListeningStarted = false;
    }
  }

  /**
   * GNSS 轮询兜底：启动后前 15 秒每 2 秒拉取一次 getLastGnssData()
   * 如果事件监听正常工作，轮询结果只是冗余覆盖（无副作用）
   */
  _startGnssPollFallback() {
    this._stopGnssPollFallback();
    let elapsed = 0;
    const interval = 2000;
    const maxDuration = 15000;
    let toastedNoData = false; // 避免 2s 轮询重复弹 toast

    this._gnssPollId = setInterval(async () => {
      elapsed += interval;
      if (!this._gnssListeningStarted || !this._gnssPlugin) {
        this._stopGnssPollFallback();
        return;
      }
      if (this._gnssPollRunning) return;
      this._gnssPollRunning = true;
      // 如果事件已收到卫星数据，提前停止轮询
      if (this._gnssSatellites.length > 0) {
        if (CONFIG.DEBUG) console.log('[GPS] GNSS 轮询兜底：已收到卫星数据，停止轮询');
        this._stopGnssPollFallback();
        this._gnssPollRunning = false;
        return;
      }
      try {
        const data = await this._gnssPlugin.getLastGnssData();
        // 关键：await 之后再 re-check，stopGnss() 可能在我们 yield 期间清空了状态，
        // 此时任何回写都会让 _gnssSatellites 显示陈旧数据
        if (!this._gnssListeningStarted || !this._gnssPlugin) {
          this._stopGnssPollFallback();
          this._gnssPollRunning = false;
          return;
        }
        // 轮询兜底也要消费 NMEA 数组：事件路径失效时，GGA 海拔 / VTG 航向 /
        // RMC 时钟校准等不能丢，否则极端 ROM 下会退回浏览器多为 null 的 altitude
        if (data && data.nmea && Array.isArray(data.nmea)) {
          for (const nmea of data.nmea) {
            if (nmea && nmea.sentence) this._parseNmea(nmea.sentence);
          }
          if (CONFIG.DEBUG) console.log('[GPS] GNSS 轮询兜底：解析 NMEA 数:', data.nmea.length);
        }
        if (data && data.satellites && data.satellites.length > 0) {
          this._handleGnssSatellites(data.satellites);
          if (CONFIG.DEBUG) console.log('[GPS] GNSS 轮询兜底：收到卫星数:', data.satellites.length);
          this._stopGnssPollFallback();
        }
      } catch (e) {
        console.warn('[GPS] GNSS 轮询兜底失败:', e.message);
      }
      this._gnssPollRunning = false;
      if (elapsed >= maxDuration) {
        this._stopGnssPollFallback();
        if (this._gnssSatellites.length === 0 && !toastedNoData) {
          toastedNoData = true;
          console.warn('[GPS] GNSS 轮询兜底：15s 内未收到卫星数据');
        }
      }
    }, interval);
  }

  _stopGnssPollFallback() {
    this._gnssPollRunning = false;
    if (this._gnssPollId) {
      clearInterval(this._gnssPollId);
      this._gnssPollId = null;
    }
  }

  /**
   * 移除所有 GNSS 事件监听器
   */
  _removeGnssListeners() {
    try {
      if (this._gnssStatusHandle) { this._gnssStatusHandle.remove(); }
    } catch (e) {
      try { this._gnssPlugin?.removeAllListeners?.(); } catch (_) {}
    }
    this._gnssStatusHandle = null;
    try {
      if (this._gnssNmeaHandle) { this._gnssNmeaHandle.remove(); }
    } catch (e) {
      try { this._gnssPlugin?.removeAllListeners?.(); } catch (_) {}
    }
    this._gnssNmeaHandle = null;
    this._clearNmeaCache();
    this._utcOffsetMs = 0;
    this._lastUtcReceivedAt = 0;
    // 复位定位源状态（含坐标交叉校验）
    this._gpsSource = 'fallback';
    this._sourceNativeCnt = 0;
    this._sourceBrowserCnt = 0;
    this._lastSourceEvalAt = 0;
    this._nativeLat = null;
    this._nativeLng = null;
    this._coordConflictStreak = 0;
    this._nativeCoordTrusted = true;
  }

  /* ── GNSS NMEA 解析（VTG 航向/速度 + RMC/GGA UTC 时钟校准）── */

  /**
   * 解析单条 NMEA 语句，只保留最新状态（零内存增长）。
   * - $GPVTG: 真航向 + 对地速度 → _lastVtg（VTG 优先源）
   * - $GPRMC: 定位有效性 + 速度/航向 + 经纬度 → _lastRmc（交叉验证源）
   * - $GPGGA: UTC 时间 + 海拔 MSL + 大地水准面分离 + 经纬度 → _lastGga
   * - $G?GSA: PDOP/HDOP/VDOP → _lastGsa
   */
  _parseNmea(sentence) {
    if (!sentence || typeof sentence !== 'string') return;
    const parts = sentence.split(',');
    if (parts.length < 2) return;
    // 语句类型：$GPVTG / $GNVTG → "VTG"（去掉 $ 与 2 位 talker 前缀 GP/GN/GL/GA/GB）
    const type = parts[0].replace(/^\$/, '').slice(2);
    if (type === 'VTG') {
      // $GPVTG,<真航向>,T,<磁航向>,M,<节>,N,<km/h>,K,<模式>
      const track = parseFloat(parts[1]);
      let kmh = parseFloat(parts[7]);
      // 部分芯片无 km/h 字段时用节换算（1 节 = 1.852 km/h）
      if (isNaN(kmh)) {
        const knots = parseFloat(parts[5]);
        kmh = isNaN(knots) ? NaN : knots * 1.852;
      }
      this._lastVtg = {
        trackTrue: isNaN(track) ? null : track,
        speedKmh: isNaN(kmh) ? null : kmh,
        receivedAt: Date.now()
      };
    } else if (type === 'RMC') {
      // $GPRMC,<hhmmss>,<A/V>,<纬度>,<N/S>,<经度>,<E/W>,<节>,<航向>,<日期>,...
      const valid = parts[2] === 'A';
      if (valid) {
        const utcMs = this._nmeaUtcToMs(parts[1], parts[9]);
        if (utcMs != null) this._applyUtcOffset(utcMs);
      }
      const lat = this._nmeaCoordToDecimal(parts[3], parts[4]);
      const lng = this._nmeaCoordToDecimal(parts[5], parts[6]);
      const knots = parseFloat(parts[7]);
      const trackTrue = parseFloat(parts[8]);
      this._lastRmc = {
        valid: valid,
        lat: lat,
        lng: lng,
        speedKmh: isNaN(knots) ? null : knots * 1.852,
        trackTrue: isNaN(trackTrue) ? null : trackTrue,
        receivedAt: Date.now()
      };
      if (valid && lat != null && lng != null) this._updateNativeCoord(lat, lng);
    } else if (type === 'GGA') {
      // $GPGGA,<hhmmss>,<纬度>,<N/S>,<经度>,<E/W>,<定位状态>,<卫星数>,<HDOP>,<海拔>,M,<分离>,M,...
      const utcMs = this._nmeaUtcToMs(parts[1], null);
      if (utcMs != null) this._applyUtcOffset(utcMs);
      const altMsl = parseFloat(parts[9]);
      const geoidSep = parseFloat(parts[11]);
      const fixQuality = parseInt(parts[6], 10);
      const lat = this._nmeaCoordToDecimal(parts[2], parts[3]);
      const lng = this._nmeaCoordToDecimal(parts[4], parts[5]);
      this._lastGga = {
        altitudeMsl: isNaN(altMsl) ? null : altMsl,
        geoidSep: isNaN(geoidSep) ? null : geoidSep,
        lat: lat,
        lng: lng,
        fixValid: Number.isInteger(fixQuality) && fixQuality > 0,
        receivedAt: Date.now()
      };
      if (lat != null && lng != null && fixQuality > 0) this._updateNativeCoord(lat, lng);
    } else if (type === 'GSA') {
      // $GPGSA,<模式>,<fix>,<sv1..sv12>,<PDOP>,<HDOP>,<VDOP>
      const pdop = parseFloat(parts[15]);
      const hdop = parseFloat(parts[16]);
      const vdop = parseFloat(parts[17]);
      this._lastGsa = {
        pdop: isNaN(pdop) ? null : pdop,
        hdop: isNaN(hdop) ? null : hdop,
        vdop: isNaN(vdop) ? null : vdop,
        receivedAt: Date.now()
      };
    }
    // 数据更新 → 重估定位源（节流：最多每 1s 一次，避免高频 NMEA 反复评估）
    this._maybeEvaluateSource();
  }

  /**
   * NMEA 度分坐标（ddmm.mmmmm / dddmm.mmmmm + 半球）→ 十进制经纬度
   * @param {string} coordStr 如 "2307.1234"
   * @param {string} hemi 半球 N/S/E/W（空/无效 → null）
   * @returns {number|null}
   */
  _nmeaCoordToDecimal(coordStr, hemi) {
    if (!coordStr || !hemi || coordStr.length < 4) return null;
    const val = parseFloat(coordStr);
    if (isNaN(val)) return null;
    const sign = (hemi === 'S' || hemi === 'W') ? -1 : 1;
    // NMEA 度分坐标：纬度 ddmm.mmmm（2 位度），经度 dddmm.mmmm（3 位度）。
    // 以小数点前整数位数判断（>=5 位 → 经度取 3 位度，否则纬度取 2 位度）
    const dotIdx = coordStr.indexOf('.');
    if (dotIdx < 0) return null;
    const degLen = dotIdx >= 5 ? 3 : 2;
    const deg = parseFloat(coordStr.slice(0, degLen));
    const min = parseFloat(coordStr.slice(degLen));
    if (isNaN(deg) || isNaN(min) || min >= 60) return null;
    const abs = deg + min / 60;
    if (abs > 180) return null; // 越界脏数据拦截
    return sign * abs;
  }

  /**
   * 原生坐标更新：解析出可信原生经纬度时记录，并供浏览器点做交叉校验。
   * @param {number} lat
   * @param {number} lng
   */
  _updateNativeCoord(lat, lng) {
    this._nativeLat = lat;
    this._nativeLng = lng;
  }

  /**
   * 定位源评估入口（NMEA/卫星数据更新时调用，节流最多每 1s 一次）。
   * 仅在 GNSS 监听激活时评估；无插件/未激活保持 fallback。
   */
  _maybeEvaluateSource() {
    if (!this._gnssListeningStarted || !this._gnssPlugin) return;
    const now = Date.now();
    if (now - this._lastSourceEvalAt < 1000) return;
    this._lastSourceEvalAt = now;
    this.evaluateSource();
  }

  /**
   * 定位源三态评估（native / browser / fallback）+ 滞回防抖。
   * 决策依据：参与定位卫星数 + HDOP + RMC 定位有效性。
   * - native：used ≥ GPS_TAKEOVER_MIN_SATS 且（HDOP ≤ 阈值，HDOP 缺失时以 RMC 状态 A 佐证）
   * - browser：有插件但信号差 / RMC=V / 原生数据过期
   * - fallback：无 GNSS 插件（web 端，零回归）
   * 对外 gpsSource 归并两态：native → 'GNSS'，browser/fallback → 'Web'
   */
  evaluateSource() {
    if (!this._gnssPlugin || !this._gnssListeningStarted) {
      if (this._gpsSource !== 'fallback') {
        this._gpsSource = 'fallback';
        this._sourceNativeCnt = 0;
        this._sourceBrowserCnt = 0;
      }
      return;
    }
    const used = this.gnssUsedCount;
    const hdop = this.hdop;
    const rmcValid = this.rmcPositionValid;
    // GGA 明确报 fix 无效（fixQuality=0）→ 即便卫星数/HDOP 达标也视为尚未锁定，强制降级 browser
    // ggaFixValid 为 null（未收到 GGA）时保留原有放行逻辑，零回归
    const ggaFix = this.ggaFixValid;
    const ggaFixOk = ggaFix == null ? true : ggaFix;
    // 信号好：卫星数达标，且 HDOP 在阈值内（HDOP 缺失但有 RMC 有效定位时放行），且 GGA fix 有效
    const gnssGood = used >= CONFIG.GPS_TAKEOVER_MIN_SATS &&
      ggaFixOk &&
      (hdop == null ? rmcValid : hdop <= CONFIG.GPS_TAKEOVER_HDOP);
    const hold = Math.max(1, Math.round(CONFIG.GPS_SOURCE_HOLD_MS / 1000));
    if (gnssGood) {
      this._sourceBrowserCnt = 0;
      if (this._gpsSource === 'native') return;
      if (++this._sourceNativeCnt >= hold) this._enterNativeSource();
    } else {
      this._sourceNativeCnt = 0;
      if (this._gpsSource === 'browser') return;
      if (++this._sourceBrowserCnt >= hold) this._enterBrowserSource();
    }
  }

  /**
   * 进入 native（原生 GNSS 主导）。
   * 浏览器 watch 保留高精度（轨迹点仍由浏览器提供，坐标质量不能崩），
   * 仅放宽缓存窗口（允许系统复用最多 30s 旧点，减轻 GPS 芯片唤醒）——
   * 不做 enableHighAccuracy:false，否则 Android 会退回网络定位导致坐标崩坏。
   */
  _enterNativeSource() {
    const changed = this._gpsSource !== 'native';
    this._gpsSource = 'native';
    this._sourceNativeCnt = 0;
    this._sourceBrowserCnt = 0;
    if (changed && this.isWatching && !this._powerSaving && !this._downgraded) {
      this.stopWatching();
      this.startWatching({
        enableHighAccuracy: true,
        timeout: CONFIG.GPS_LOW_ACCURACY_TIMEOUT,
        maximumAge: CONFIG.GPS_NATIVE_FALLBACK_MAX_AGE
      });
    }
    if (CONFIG.DEBUG) console.log('[GPS] 定位源 → native（原生 GNSS 主导）');
  }

  /**
   * 进入 browser（浏览器定位顶上）。
   * 清空过期原生派生缓存强制回退浏览器 coords，并切回高精度 + 短缓存让浏览器混合定位顶上。
   */
  _enterBrowserSource() {
    const changed = this._gpsSource !== 'browser';
    this._gpsSource = 'browser';
    this._sourceNativeCnt = 0;
    this._sourceBrowserCnt = 0;
    this._clearNmeaCache();
    if (changed && this.isWatching && !this._powerSaving && !this._downgraded) {
      this.stopWatching();
      this.startWatching({
        enableHighAccuracy: true,
        timeout: CONFIG.GPS_WATCH_TIMEOUT,
        maximumAge: 2000
      });
    }
    if (CONFIG.DEBUG) console.log('[GPS] 定位源 → browser（浏览器定位顶上）');
  }

  /**
   * 清空全部 NMEA 派生缓存（源切换到 browser / 停止监听时强制回退浏览器 coords）
   */
  _clearNmeaCache() {
    this._lastVtg = null;
    this._lastRmc = null;
    this._lastGga = null;
    this._lastGsa = null;
  }

  /**
   * 原生坐标 vs 浏览器坐标交叉校验（更严：阈值 + 连续超阈防抖）。
   * 仅记录原生坐标信任状态，不替代浏览器点。
   * @param {number} browserLat
   * @param {number} browserLng
   */
  _checkNativeCoordConflict(browserLat, browserLng) {
    if (this._nativeLat == null || this._nativeLng == null) return;
    const dist = calcDistance(
      { lat: this._nativeLat, lng: this._nativeLng },
      { lat: browserLat, lng: browserLng }
    );
    if (dist > CONFIG.NMEA_COORD_CONFLICT_M) {
      this._coordConflictStreak++;
      if (this._coordConflictStreak >= CONFIG.NMEA_COORD_CONFLICT_STREAK && this._nativeCoordTrusted) {
        this._nativeCoordTrusted = false;
        if (CONFIG.DEBUG) console.warn(`[GPS] 原生坐标(GGA ${this._lastGga.lat?.toFixed(5)},${this._lastGga.lng?.toFixed(5)}) 与浏览器偏差连续 ${this._coordConflictStreak} 次 > ${CONFIG.NMEA_COORD_CONFLICT_M}m，判定原生坐标不可信`);
      }
    } else {
      // 偏差回到阈值内：计数回落，降至 0 恢复信任
      this._coordConflictStreak = Math.max(0, this._coordConflictStreak - 1);
      if (this._coordConflictStreak === 0 && !this._nativeCoordTrusted) {
        this._nativeCoordTrusted = true;
        if (CONFIG.DEBUG) console.log(`[GPS] 原生坐标与浏览器偏差恢复正常，恢复信任（GGA 锚点 ${this._lastGga.lat?.toFixed(5)},${this._lastGga.lng?.toFixed(5)}）`);
      }
    }
  }

  /**
   * NMEA 时间(hhmmss.ss) + 日期(ddmmyy) → UTC 毫秒时间戳
   * @param {string} timeStr
   * @param {string|null} dateStr 缺省时用设备当日 UTC 日期兜底
   * @returns {number|null}
   */
  _nmeaUtcToMs(timeStr, dateStr) {
    if (!timeStr || timeStr.length < 6) return null;
    const h = parseInt(timeStr.slice(0, 2), 10);
    const m = parseInt(timeStr.slice(2, 4), 10);
    const s = parseFloat(timeStr.slice(4));
    if (isNaN(h) || isNaN(m) || isNaN(s) || h > 23 || m > 59 || s >= 60) return null;
    let utcDay;
    if (dateStr && dateStr.length === 6) {
      const dd = parseInt(dateStr.slice(0, 2), 10);
      const mm = parseInt(dateStr.slice(2, 4), 10);
      const yy = parseInt(dateStr.slice(4, 6), 10);
      const year = yy >= 70 ? 1900 + yy : 2000 + yy;
      utcDay = Date.UTC(year, mm - 1, dd);
      // Date.UTC 会自动进位（如 2 月 30 日 → 3 月 2 日），显式校验拦截脏日期
      const check = new Date(utcDay);
      if (check.getUTCFullYear() !== year || check.getUTCMonth() !== mm - 1 || check.getUTCDate() !== dd) return null;
    } else {
      // GGA 兜底：设备当日 UTC 日期（跨日误差会被 _applyUtcOffset 的 ±12h 过滤）
      const now = new Date();
      utcDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    }
    return utcDay + (h * 3600 + m * 60 + s) * 1000;
  }

  /**
   * 设备时钟校准：offset = GNSS UTC - 本地时钟。
   * ±12h 过滤脏 UTC；已校准后新 UTC 相对校准时钟漂移须在窗口内（防旧语句回灌）。
   */
  _applyUtcOffset(realUtcMs) {
    const now = Date.now();
    // 同一批推送的多条语句只采纳第一条（RMC 优先于 GGA）
    if (now - this._lastUtcReceivedAt < 100) return;
    const offset = realUtcMs - now;
    if (Math.abs(offset) > 12 * 3600 * 1000) return;
    if (this._lastUtcReceivedAt > 0) {
      const calibratedNow = now + this._utcOffsetMs;
      if (Math.abs(realUtcMs - calibratedNow) > CONFIG.NMEA_UTC_MAX_AGE_MS) return;
    }
    this._lastUtcReceivedAt = now;
    this._utcOffsetMs = offset;
  }

  /**
   * 停止 GNSS 监听，移除事件监听器。
   */
  stopGnss() {
    this._gnssStopRequested = true;
    // 不清除 _gnssStarting，让 finally 块中的 generation 检查处理
    this._removeGnssListeners();
    this._stopGnssPollFallback();
    if (this._gnssPlugin && this._gnssListeningStarted) {
      try {
        this._gnssPlugin.stopGnssListening?.();
      } catch (e) {
        // 插件可能没有这些方法
      }
    }
    this._gnssListeningStarted = false;
    this._gnssSatellites = [];
    this._satStatsCache = null;
    this._gnssInitError = null;
    // 弱信号状态机依赖 GNSS 监听，监听已关闭 → 复位
    this._resetWeakSignalState();
  }

  /**
   * GNSS 卫星数据统一处理入口（事件监听 + 轮询兜底共用）：
   * 更新 _gnssSatellites 并驱动弱信号状态机
   * @param {Array} satellites GnssSatelliteInfo[]
   */
  _handleGnssSatellites(satellites) {
    this._gnssSatellites = satellites || [];
    // 预计算卫星统计缓存：UI 轮询 getter 直接读缓存，避免每秒多次 filter/reduce
    this._satStatsCache = this._computeSatStats(this._gnssSatellites);
    // 卫星数据变化 → 通知 UI（卫星天顶图等），即使监听未就绪也推送（用于隐藏空态）
    if (this.onSatellitesChange) this.onSatellitesChange(this._gnssSatellites);
    // 弱信号状态机仅在 GNSS 激活且无初始化错误时运行（异常状态不得误判弱信号）
    if (!this._gnssListeningStarted || this._gnssInitError) return;
    this._evaluateWeakSignal();
    // 卫星状态变化 → 重估定位源（节流内置）
    this._maybeEvaluateSource();
  }

  _computeSatStats(satellites) {
    const stats = { used: 0, visible: 0, snrSum: 0, consts: { gps: 0, beidou: 0, glonass: 0, galileo: 0, other: 0 }, usedConsts: { gps: 0, beidou: 0, glonass: 0, galileo: 0, other: 0 } };
    if (!satellites || satellites.length === 0) return stats;
    for (const s of satellites) {
      const c = s.constellation;
      switch (c) {
        case 'GPS': stats.consts.gps++; break;
        case 'BEIDOU': stats.consts.beidou++; break;
        case 'GLONASS': stats.consts.glonass++; break;
        case 'GALILEO': stats.consts.galileo++; break;
        default: stats.consts.other++; break;
      }
      if (s.usedInFix) {
        stats.used++;
        stats.snrSum += s.cn0DbHz || 0;
        switch (c) {
          case 'GPS': stats.usedConsts.gps++; break;
          case 'BEIDOU': stats.usedConsts.beidou++; break;
          case 'GLONASS': stats.usedConsts.glonass++; break;
          case 'GALILEO': stats.usedConsts.galileo++; break;
          default: stats.usedConsts.other++; break;
        }
      }
    }
    stats.visible = satellites.length;
    stats.avgSnr = stats.used > 0 ? stats.snrSum / stats.used : 0;
    return stats;
  }

  /**
   * GNSS 弱信号状态机评估（约 1s/次）
   * - 进入：参与定位卫星数 < GNSS_WEAK_USED_MAX 且 平均信噪比 < GNSS_WEAK_SNR_MAX，
   *         持续 GNSS_WEAK_HOLD_MS → 进入弱信号省电降级
   * - 恢复：参与定位卫星数 >= GNSS_RECOVER_USED_MIN 且 平均信噪比 >= GNSS_RECOVER_SNR_MIN，
   *         持续 GNSS_RECOVER_HOLD_MS → 退出降级（滞回带防抖）
   * - 任一条件不满足 → 对应计数平滑回落（减 1），防止单次抖动立刻触发
   */
  _evaluateWeakSignal() {
    // 省电模式已强制低功耗（通常已关闭 GNSS 监听），弱信号状态机无额外价值 → 保持复位
    if (this._powerSaving) {
      this._resetWeakSignalState();
      return;
    }
    const used = this.gnssUsedCount;
    const snr = this.gnssAvgSnr;
    if (this._weakSignal) {
      if (used >= CONFIG.GNSS_RECOVER_USED_MIN && snr >= CONFIG.GNSS_RECOVER_SNR_MIN) {
        this._strongCnt++;
      } else {
        this._strongCnt = Math.max(0, this._strongCnt - 1);
      }
      if (this._strongCnt >= Math.max(1, Math.round(CONFIG.GNSS_RECOVER_HOLD_MS / 1000))) {
        this._exitWeakSignal();
      }
    } else {
      if (used < CONFIG.GNSS_WEAK_USED_MAX && snr < CONFIG.GNSS_WEAK_SNR_MAX) {
        this._weakCnt++;
      } else {
        this._weakCnt = Math.max(0, this._weakCnt - 1);
      }
      if (this._weakCnt >= Math.max(1, Math.round(CONFIG.GNSS_WEAK_HOLD_MS / 1000))) {
        this._enterWeakSignal();
      }
    }
  }

  /**
   * 进入弱信号省电降级：放宽定位节流（心跳间隔拉长至 GPS_WEAK_SIGNAL_INTERVAL），
   * 可选降精度（GPS_WEAK_SIGNAL_LOW_ACCURACY=true 时重启 watch）。
   * 不关闭 GNSS 监听——需要它监测信号恢复。
   */
  _enterWeakSignal() {
    if (this._weakSignal) return;
    this._weakSignal = true;
    this._weakCnt = 0;
    this._strongCnt = 0;
    if (CONFIG.DEBUG) console.warn(`[GPS] GNSS 弱信号（卫星<${CONFIG.GNSS_WEAK_USED_MAX} 且 信噪比<${CONFIG.GNSS_WEAK_SNR_MAX}dB 持续 ${CONFIG.GNSS_WEAK_HOLD_MS / 1000}s），进入省电降级`);
    // 放宽节流：立即生效（覆盖当前窗口），后续由 _updateAdaptiveInterval 的弱信号钳制维持
    if (this._gpsMinInterval < CONFIG.GPS_WEAK_SIGNAL_INTERVAL) {
      this._gpsMinInterval = CONFIG.GPS_WEAK_SIGNAL_INTERVAL;
    }
    // 可选降精度（默认关）：重启 watchPosition，最省电但有短暂失锁风险
    if (CONFIG.GPS_WEAK_SIGNAL_LOW_ACCURACY && this.isWatching) {
      this.stopWatching();
      this.startWatching({ enableHighAccuracy: false, timeout: CONFIG.GPS_WATCH_TIMEOUT, maximumAge: 15000 });
    }
    if (this.onWeakSignalChange) this.onWeakSignalChange(true);
  }

  /**
   * 退出弱信号降级：恢复正常自适应节流，可选恢复高精度 watch
   */
  _exitWeakSignal() {
    if (!this._weakSignal) return;
    this._weakSignal = false;
    this._weakCnt = 0;
    this._strongCnt = 0;
    if (CONFIG.DEBUG) console.log(`[GPS] GNSS 信号恢复（卫星>=${CONFIG.GNSS_RECOVER_USED_MIN} 且 信噪比>=${CONFIG.GNSS_RECOVER_SNR_MIN}dB 持续 ${CONFIG.GNSS_RECOVER_HOLD_MS / 1000}s），退出省电降级`);
    // 恢复节流：按当前速度重新计算正常间隔
    this._updateAdaptiveInterval(this.currentPosition ? this.currentPosition.speed : 0);
    if (CONFIG.GPS_WEAK_SIGNAL_LOW_ACCURACY && this.isWatching) {
      this.stopWatching();
      this.startWatching({ enableHighAccuracy: true, timeout: CONFIG.GPS_WATCH_TIMEOUT, maximumAge: 2000 });
    }
    if (this.onWeakSignalChange) this.onWeakSignalChange(false);
  }

  /**
   * 复位弱信号状态（stopGnss / destroy / 省电模式开启时调用）。
   * 静默复位，不触发 onWeakSignalChange（避免误导性"信号恢复"提示）。
   * @param {boolean} [restoreWatch] 若因降精度重启过 watch，是否恢复高精度（默认 true）
   */
  _resetWeakSignalState(restoreWatch) {
    const wasWeak = this._weakSignal;
    this._weakSignal = false;
    this._weakCnt = 0;
    this._strongCnt = 0;
    if (wasWeak && restoreWatch !== false && CONFIG.GPS_WEAK_SIGNAL_LOW_ACCURACY && this.isWatching) {
      this._updateAdaptiveInterval(this.currentPosition ? this.currentPosition.speed : 0);
      this.stopWatching();
      this.startWatching({ enableHighAccuracy: true, timeout: CONFIG.GPS_WATCH_TIMEOUT, maximumAge: 2000 });
    }
  }

  /**
   * 获取当前生效的 GPS 超时时间
   */
  _getCurrentTimeout() {
    // 对齐自适应节流间隔：静止时心跳可达 60s（省电模式 20s 下限），
    // 固定 5s 看门狗会把 Android duty-cycle 下的正常慢 fix 误判为超时并降级
    return Math.max(
      this._downgraded ? CONFIG.GPS_LOW_ACCURACY_TIMEOUT : CONFIG.GPS_WATCH_TIMEOUT,
      this._gpsMinInterval + 5000
    );
  }

  /**
   * 启动超时检测定时器 — 每秒检查是否超时
   */
  _startTimeoutWatch() {
    this._stopTimeoutWatch();
    this._lastPositionTime = Date.now();
    this._timeoutCheckId = setInterval(() => {
      if (!this.isWatching) return;
      const elapsed = Date.now() - this._lastPositionTime;
      if (elapsed > this._getCurrentTimeout()) {
        this._consecutiveTimeouts++;
        if (CONFIG.DEBUG) console.warn(`[GPS] 超时 #${this._consecutiveTimeouts}（${(elapsed / 1000).toFixed(0)}s 无新位置）`);
        if (!this._downgraded && this._consecutiveTimeouts >= CONFIG.GPS_TIMEOUT_MAX_FAILURES) {
          this._downgrade();
        }
        // 重置计时起点，避免下次立即又判定超时
        this._lastPositionTime = Date.now();
      }
    }, 1000);
  }

  /**
   * 停止超时检测定时器
   */
  _stopTimeoutWatch() {
    if (this._timeoutCheckId !== null) {
      clearInterval(this._timeoutCheckId);
      this._timeoutCheckId = null;
    }
  }

  /**
   * 降级到低精度定位
   */
  _downgrade() {
    if (this._downgraded) return;
    this._downgraded = true;
    this._consecutiveTimeouts = 0;
    if (CONFIG.DEBUG) console.warn('[GPS] 连续超时达阈值，降级到低精度定位');
    if (this.onDowngrade) this.onDowngrade(this._consecutiveTimeouts);

    // 用新参数重启 watchPosition
    if (this.isWatching) {
      this.stopWatching(); // 内部已设置 isWatching = false
      this.startWatching({
        enableHighAccuracy: false,
        timeout: CONFIG.GPS_LOW_ACCURACY_TIMEOUT,
        maximumAge: 5000
      });
    }

    // 启动恢复尝试定时器
    this._startRecoveryTimer();
  }

  /**
   * 启动恢复尝试定时器 — 每 2 分钟尝试恢复高精度
   */
  _startRecoveryTimer() {
    this._stopRecoveryTimer();
    this._recoveryTimerId = setInterval(() => {
      this._tryRecovery();
    }, CONFIG.GPS_RECOVERY_INTERVAL_MS);
  }

  /**
   * 停止恢复尝试定时器
   */
  _stopRecoveryTimer() {
    if (this._recoveryTimerId !== null) {
      clearInterval(this._recoveryTimerId);
      this._recoveryTimerId = null;
    }
  }

  /**
   * 尝试恢复高精度定位 — 用单次 getCurrentPosition 测试
   */
  async _tryRecovery() {
    if (!this._downgraded || !this.isWatching) return;
    // 省电模式本身就是低精度 + 20s 节流，恢复高精度会破坏省电设定，直接跳过
    if (this._powerSaving) return;
    if (CONFIG.DEBUG) console.log('[GPS] 尝试恢复高精度定位...');
    try {
      await this.getCurrentPosition(CONFIG.GPS_WATCH_TIMEOUT);
      // 成功 → 恢复高精度
      this._downgraded = false;
      this._consecutiveTimeouts = 0;
      this._lastProcessedTime = Date.now();
      this._stopRecoveryTimer();
      if (CONFIG.DEBUG) console.log('[GPS] 高精度定位恢复成功');
      if (this.onRecovery) this.onRecovery(true);

      // 用高精度参数重启 watchPosition
      if (this.isWatching) {
        this.stopWatching(); // 内部已设置 isWatching = false
        this.startWatching({
          enableHighAccuracy: true,
          timeout: CONFIG.GPS_WATCH_TIMEOUT,
          maximumAge: 2000
        });
      }
    } catch (err) {
      // 失败 → 继续低精度
      console.warn('[GPS] 恢复高精度失败:', err.message);
      if (this.onRecovery) this.onRecovery(false);
    }
  }

  /**
   * 重置超时计数（位置成功时调用）
   */
  _resetTimeouts() {
    if (this._consecutiveTimeouts > 0) {
      if (CONFIG.DEBUG) console.log(`[GPS] 位置更新，重置连续超时计数（was ${this._consecutiveTimeouts}）`);
    }
    this._consecutiveTimeouts = 0;
    this._lastPositionTime = Date.now();
  }

  /**
   * 单次获取当前位置（高精度 GPS）
   * @param {number} timeout - 超时时间（毫秒）
   * @returns {Promise<{lat: number, lng: number, accuracy: number}>}
   */
  getCurrentPosition(timeout) {
    const t = timeout || CONFIG.GPS_TIMEOUT;

    // 总超时兜底（比 geolocation timeout 多 5s，防止 GPS 信号弱卡死）
    const fallbackMs = Math.max(t + 5000, 15000);

    return new Promise((resolve, reject) => {
      // 检查浏览器支持
      if (!navigator.geolocation) {
        reject(new Error('您的设备不支持地理定位功能'));
        return;
      }

      // 总超时兜底
      const fallbackTimer = setTimeout(() => {
        reject(new Error('定位请求无响应（' + (fallbackMs / 1000).toFixed(0) + ' 秒超时）'));
      }, fallbackMs);

      let lowAccuracyFallback = false;

      // 成功回调（高精度 / 低精度重试共用）
      const handleSuccess = (position) => {
        clearTimeout(fallbackTimer);
        this._checkNativeCoordConflict(position.coords.latitude, position.coords.longitude);
        // 单次定位同样走海拔实时滤波链（中值预滤波 + 自适应卡尔曼 + Huber）
        const pos = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          altitude: this._altFilter.push(
            this._resolveAltitude(position.coords.altitude),
            this.altitudeSource,
            position.timestamp
          ),
          speed: this._resolveSpeed(position.coords.speed),
          heading: this._resolveHeading(position.coords.heading),
          timestamp: position.timestamp,
          signalQuality: this.signalQualityScore
        };
        this.currentPosition = pos;
        resolve(pos);
      };

      // 失败回调
      const handleError = (error) => {
        clearTimeout(fallbackTimer);
        // 高精度超时 → 退到低精度（IP / 基站定位）重试一次，兼容桌面端无 GPS 硬件
        if (error.code === error.TIMEOUT && !lowAccuracyFallback) {
          lowAccuracyFallback = true;
          console.info('[GPS] 高精度定位超时，退用低精度（IP/基站）重试');
          navigator.geolocation.getCurrentPosition(handleSuccess, handleError, {
            enableHighAccuracy: false,
            timeout: t,
            maximumAge: 0
          });
          return;
        }
        let message;
        switch (error.code) {
          case error.PERMISSION_DENIED:
            message = '定位权限被拒绝，请在浏览器设置中允许访问位置信息';
            break;
          case error.POSITION_UNAVAILABLE:
            message = '无法获取位置信息（GPS 信号弱或不可用）';
            break;
          case error.TIMEOUT:
            message = '定位请求超时，请确保 GPS 已开启并在室外';
            break;
          default:
            message = '定位失败（未知错误）';
        }
        reject(new Error(message));
      };

      navigator.geolocation.getCurrentPosition(handleSuccess, handleError, {
        enableHighAccuracy: true,
        timeout: t,
        maximumAge: 0 // 每次获取最新位置
      });
    });
  }

  /**
   * 持续监听位置变化
   * @param {object} [options] - 可选，覆盖默认 watchPosition 选项
   */
  startWatching(options) {
    // 已在监听中，且传了新选项 → 重启用新参数
    if (this.isWatching) {
      if (options) {
        this.stopWatching();
      } else {
        if (CONFIG.DEBUG) console.warn('GPS 已在监听中');
        return;
      }
    }

    if (!navigator.geolocation) {
      if (this.onError) this.onError(new Error('设备不支持地理定位'));
      return;
    }

    const opts = Object.assign({
      enableHighAccuracy: true,
      timeout: CONFIG.GPS_WATCH_TIMEOUT,
      maximumAge: 2000
    }, options || {});

    this.isWatching = true;

    this.watchId = navigator.geolocation.watchPosition(
      (position) => {
        const now = Date.now();

        // 原生/浏览器坐标交叉校验（仅记录信任状态，不替代坐标）
        this._checkNativeCoordConflict(position.coords.latitude, position.coords.longitude);

        // 构造统一位置对象
        const buildPos = () => ({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          altitude: this._resolveAltitude(position.coords.altitude),
          speed: this._resolveSpeed(position.coords.speed),
          heading: this._resolveHeading(position.coords.heading),
          timestamp: position.timestamp
        });

        const prevProcessedTime = this._lastProcessedTime;
        if (now - this._lastProcessedTime < this._gpsMinInterval) {
          // 静止节流中的运动检测：若浏览器报告速度 > 阈值，立即跳过节流窗口
          // 防止静止时突然移动却要等 60s 才反应过来
          const rawSpeed = position.coords.speed;
          const rawSpeedOK = rawSpeed != null && rawSpeed > CONFIG.GPS_MOVE_THRESHOLD;

          // 择优缓存：节流窗口内保留精度最佳的位置，而非直接丢弃
          const curAcc = position.coords.accuracy || Infinity;
          if (!this._bestPendingPosition || curAcc < this._bestPendingPosition.accuracy) {
            this._bestPendingPosition = buildPos();
          }
          // 仍视为有效信号，更新超时检测
          this._lastPositionTime = now;
          this._consecutiveTimeouts = 0;

          if (!rawSpeedOK) return;
        }
        this._lastActualInterval = prevProcessedTime ? now - prevProcessedTime : 0;
        this._lastProcessedTime = now;

        // 窗口到期：从缓存和当前信号中选精度最优者
        const currentPos = buildPos();
        const bestPos = this._bestPendingPosition &&
          this._bestPendingPosition.accuracy <= (currentPos.accuracy || Infinity) / 2
          ? this._bestPendingPosition : currentPos;
        this._bestPendingPosition = null;

        const pos = { ...bestPos };
        // 信号质量评分（0-100）写入轨迹点，供后续轨迹质量分聚合使用
        pos.signalQuality = this.signalQualityScore;

        // ── 海拔独立滤波（L2 自适应卡尔曼 + L3 中值/Huber）──
        // 原始海拔（质量门后、滤波前）保留供离线 RTS 使用；滤波值用于实时展示/落点
        const rawAltitude = pos.altitude;
        pos.altitude = this._altFilter.push(rawAltitude, this.altitudeSource, now);

        // 保存原始位置（滤波前，WGS84），供结束记录时的 RTS 离线平滑使用
        this._rawPosition = { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, speed: pos.speed, heading: pos.heading, altitude: rawAltitude, timestamp: pos.timestamp };
        if (this._rawFixes.length < this._maxRawFixes) {
          this._rawFixes.push({
            lat: pos.lat,
            lng: pos.lng,
            accuracy: pos.accuracy || 0,
            speed: pos.speed,
            altitude: rawAltitude, // 原始海拔（质量门后），供离线 1D RTS 平滑
            time: now, // 用收到时刻（与滤波器 dt 一致）
            ts: pos.timestamp // 原始 GPS 时间戳（保留供匹配/展示）
          });
        }

        // ── 2D 卡尔曼滤波实时平滑 ──
        if (this._useFilter && pos.accuracy > 0) {
          // ── IMU 定位校准：加速度注入 CA 模型预测（仅线性加速度，航向仍由 GPS 权威）──
          // 无 IMU 数据（web 无插件 / 事件流过期 / 未启动）→ getLatestAccEnu() 返回 null，
          // 跳过注入，纯 GPS 行为不变。注入值单次消费，不影响 pos.heading。
          if (this._imuManager) {
            const imuAcc = this._imuManager.getLatestAccEnu();
            if (imuAcc && typeof this._filter.feedImu === 'function') {
              this._filter.feedImu(imuAcc);
            }
          }
          // 用收到时刻而非 position.timestamp：maximumAge 缓存/重复 fix 的旧时间戳
          // 会使 dt ≤ 0 触发滤波器重置，平滑被静默关闭
          const ts = now;
          const acc = pos.accuracy || 10;
          // 精度差（>2000m，地下/遮挡）也进 update()：内部改为冻结在最后可信位置，
          // 不再重置+接受跳变测量（避免轨迹拉回又回去）。RTS 后处理修正地下段。
          const filtered = this._filter.update(pos.lat, pos.lng, acc, ts, pos.speed);
          pos.lat = filtered.lat;
          pos.lng = filtered.lng;
        } else {
          // 无精度信息或滤波关闭 → 重置滤波器
          this._filter.reset();
        }

        this.currentPosition = pos;
        this._resetTimeouts(); // 收到位置 → 重置超时计数
        this._updateAdaptiveInterval(pos.speed); // 按本次速度调下次节流间隔
        if (this.onPositionChange) this.onPositionChange(pos);
      },
      (error) => {
        let message;
        switch (error.code) {
          case error.PERMISSION_DENIED:
            message = '定位权限被拒绝';
            this.stopWatching(); // 权限拒绝时停止追踪，避免无限降级/恢复循环
            break;
          case error.POSITION_UNAVAILABLE:
            message = '无法获取位置信息（GPS 信号弱或不可用）';
            break;
          case error.TIMEOUT:
            message = '定位请求超时，请确保 GPS 已开启并在室外';
            break;
          default:
            message = '定位失败（未知错误）';
        }
        if (this.onError) this.onError(new Error(message));
      },
      opts
    );

    this._startTimeoutWatch(); // 启动超时检测
    this._startImu();          // IMU 随 watch 生命周期启动（仅定位校准）
    if (this.onWatchStart) this.onWatchStart();
  }

  /**
   * 停止监听位置
   */
  stopWatching() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.isWatching = false;
    this._downgraded = false;
    this._lastProcessedTime = 0;
    this._bestPendingPosition = null;
    this._consecutiveTimeouts = 0;
    this._stopTimeoutWatch();
    this._stopRecoveryTimer();
    this._stopImu();           // IMU 随 watch 停止（释放传感器 + 清缓存）
    if (this.onWatchStop) this.onWatchStop();
  }

  /**
   * 启动 IMU（仅定位校准：加速度注入辅助滤波）。
   * 重复调用自动忽略（_startImu 幂等）；web 无插件时 ImuManager.start 静默返回。
   */
  _startImu() {
    if (!this._imuManager || this._imuStarted) return;
    this._imuStarted = true;
    this._imuManager.start();
  }

  /**
   * 停止 IMU（释放传感器 + 清空缓存，防止陈旧数据注入）。
   */
  _stopImu() {
    if (!this._imuManager) return;
    this._imuStarted = false;
    this._imuManager.stop();
  }

  /**
   * 释放所有资源（GPS + GNSS + 电池监控）
   */
  destroy() {
    this._destroyed = true;
    this.stopWatching();
    this.stopGnss();
    this._cleanupBatteryMonitor();
  }

  /**
   * 获取缓存的最近位置
   * @returns {{lat: number, lng: number, accuracy: number}|null}
   */
  getLastPosition() {
    return this.currentPosition;
  }

  /**
   * 获取最近一次原始（未滤波）位置
   */
  get lastRawPosition() {
    return this._rawPosition ? { ...this._rawPosition } : null;
  }

  /**
   * 切换/设置卡尔曼滤波
   * @param {boolean} [force] - 不传则切换
   * @returns {boolean} 当前状态
   */
  toggleFilter(force) {
    const next = force !== undefined ? force : !this._useFilter;
    if (next === this._useFilter) return this._useFilter;
    this._useFilter = next;
    if (!next) {
      this._filter.reset();
      // 海拔滤波链与总开关联动（各自独立实现，仅共享开关状态）
      if (this._altFilter) {
        this._altFilter.enabled = false;
        this._altFilter.reset();
      }
    } else {
      // 恢复为 CONFIG 配置值（而非强制 true），尊重 ALT_FILTER_ENABLED 总开关
      if (this._altFilter) {
        this._altFilter.enabled = (typeof CONFIG !== 'undefined' && CONFIG.ALT_FILTER_ENABLED !== false);
        this._altFilter.reset();
      }
    }
    if (CONFIG.DEBUG) console.log(`[GPS] 漂移滤波: ${next ? '开启' : '关闭'}`);
    return this._useFilter;
  }

  /**
   * 获取原始测量缓冲（WGS84，滤波前）
   */
  get rawFixes() {
    return this._rawFixes;
  }

  /** 清空原始测量缓冲（同步清空海拔实时滤波链状态） */
  clearRawFixes() {
    this._rawFixes = [];
    if (this._altFilter) this._altFilter.reset();
  }

  /**
   * 对缓冲内所有原始测量做离线 RTS 平滑（整段后处理）
   * 用于结束记录后提升轨迹精度。会清空缓冲，返回平滑结果。
   * @returns {Array<{lat:number,lng:number,time:number,ts:*}>} 平滑后 WGS84 坐标序列
   */
  smoothTrailRts() {
    const fixes = this._rawFixes;
    this._rawFixes = [];
    if (!fixes.length) return [];
    // 离线平滑固定走独立单模型实例（与实时 IMM 彻底解耦）
    return this._offlineSmoother.smoothTrail(fixes);
  }

  /**
   * 海拔实时滤波统一入口（供内部定位与外部后台路径复用）。
   * 走 L2 自适应卡尔曼 + L3 中值/Huber 链，口径切换自动重置。
   * @param {number|null} rawAlt 原始海拔（质量门后）
   * @param {number} time 时间戳（毫秒）
   * @returns {number|null} 滤波后海拔
   */
  filterAltitude(rawAlt, time) {
    return this._altFilter.push(rawAlt, this.altitudeSource, time);
  }

  /**
   * 对缓冲内所有原始测量做 3D 离线 RTS 平滑（结束记录后处理）。
   * 水平复用现有 2D RTS（KalmanFilter.smoothTrail），海拔走完全独立的 1D RTS（AltRtsSmoother），
   * 二者互不依赖。返回元素在水平 RTS 输出基础上并入 `alt` 字段（null 表示该点无海拔/缺口）。
   * @returns {Array<{lat:number,lng:number,time:number,ts:*,alt:number|null}>}
   */
  smoothTrailRts3d() {
    const fixes = this._rawFixes;
    this._rawFixes = [];
    if (!fixes.length) return [];
    // 水平：现有 2D RTS（只动 lat/lng，不动 altitude；离线走独立单模型实例）
    const horizontal = this._offlineSmoother.smoothTrail(fixes);
    // 海拔：独立 1D RTS（只消费原始 altitude + time）
    if (!this._altRts.enabled) {
      return horizontal.map(p => ({ ...p, alt: null }));
    }
    let alt;
    try {
      alt = this._altRts.smooth(fixes);
    } catch (e) {
      if (CONFIG.DEBUG) console.warn('[ALT-RTS] 海拔平滑失败，保留原始:', e);
      return horizontal.map(p => ({ ...p, alt: null }));
    }
    return horizontal.map((p, i) => ({ ...p, alt: alt[i] }));
  }

  /**
   * 是否处于降级（低精度）模式
   */
  get isDowngraded() {
    return this._downgraded;
  }

  /**
   * 连续超时次数
   */
  get consecutiveTimeouts() {
    return this._consecutiveTimeouts;
  }

  /**
   * 是否已连接 Capacitor GNSS 插件（原生端）
   */
  get hasGnssPlugin() {
    return this._gnssPlugin !== null;
  }

  /**
   * GNSS 是否已激活（正在监听卫星数据）
   */
  get isGnssActive() {
    return this._gnssListeningStarted && this._gnssPlugin !== null;
  }

  /**
   * GNSS 初始化错误
   */
  get gnssError() {
    return this._gnssInitError;
  }

  /**
   * 可见卫星列表（来自原生 GNSS 插件）
   * @returns {Array<{svid:number, constellation:string, cn0DbHz:number, usedInFix:boolean}>}
   */
  get gnssSatellites() {
    return this._gnssSatellites.slice(); // 返回防御性副本
  }

  /**
   * 参与定位的卫星数（读预计算缓存）
   */
  get gnssUsedCount() {
    return this._satStatsCache ? this._satStatsCache.used : 0;
  }

  /**
   * 可见卫星总数（读预计算缓存）
   */
  get gnssVisibleCount() {
    return this._satStatsCache ? this._satStatsCache.visible : this._gnssSatellites.length;
  }

  /**
   * 参与定位卫星的平均信噪比 (dB-Hz)（读预计算缓存）
   */
  get gnssAvgSnr() {
    return this._satStatsCache ? this._satStatsCache.avgSnr : 0;
  }

  /**
   * 按星座分组的卫星数量（所有可见卫星，读预计算缓存）
   * @returns {{gps:number, beidou:number, glonass:number, galileo:number, other:number}}
   */
  get gnssConstellationStats() {
    return this._satStatsCache
      ? Object.assign({}, this._satStatsCache.consts)
      : { gps: 0, beidou: 0, glonass: 0, galileo: 0, other: 0 };
  }

  /**
   * 按星座分组的参与定位卫星数量（读预计算缓存）
   * @returns {{gps:number, beidou:number, glonass:number, galileo:number, other:number}}
   */
  get gnssUsedConstellationStats() {
    return this._satStatsCache
      ? Object.assign({}, this._satStatsCache.usedConsts)
      : { gps: 0, beidou: 0, glonass: 0, galileo: 0, other: 0 };
  }

  /**
   * 经 GNSS 校准的当前 UTC 毫秒时间戳（无 NMEA 时 = Date.now()，零回归）
   */
  get calibratedNow() {
    return Date.now() + this._utcOffsetMs;
  }

  /**
   * $GPVTG 真航向（度），过期/缺失返回 null
   */
  get vtgTrack() {
    if (!this._lastVtg) return null;
    if (Date.now() - this._lastVtg.receivedAt > CONFIG.NMEA_VTG_MAX_AGE_MS) return null;
    return this._lastVtg.trackTrue;
  }

  /**
   * $GPVTG 对地速度（km/h），过期/缺失返回 null
   */
  get vtgSpeedKmh() {
    if (!this._lastVtg) return null;
    if (Date.now() - this._lastVtg.receivedAt > CONFIG.NMEA_VTG_MAX_AGE_MS) return null;
    return this._lastVtg.speedKmh;
  }

  /**
   * $GPRMC 定位有效性（状态 A 且未过期）
   */
  get rmcPositionValid() {
    if (!this._lastRmc) return false;
    if (Date.now() - this._lastRmc.receivedAt > CONFIG.NMEA_RMC_MAX_AGE_MS) return false;
    return this._lastRmc.valid;
  }

  /**
   * $GPRMC 对地速度（km/h），过期/缺失返回 null（速度交叉验证源）
   */
  get rmcSpeedKmh() {
    if (!this._lastRmc) return null;
    if (Date.now() - this._lastRmc.receivedAt > CONFIG.NMEA_RMC_MAX_AGE_MS) return null;
    return this._lastRmc.speedKmh;
  }

  /**
   * $GPRMC 真航向（度），过期/缺失返回 null（航向交叉验证源）
   */
  get rmcTrack() {
    if (!this._lastRmc) return null;
    if (Date.now() - this._lastRmc.receivedAt > CONFIG.NMEA_RMC_MAX_AGE_MS) return null;
    return this._lastRmc.trackTrue;
  }

  /**
   * $G?GSA PDOP（多星座 GSA 最后到达为准），过期/缺失返回 null
   */
  get pdop() {
    if (!this._lastGsa) return null;
    if (Date.now() - this._lastGsa.receivedAt > CONFIG.NMEA_GSA_MAX_AGE_MS) return null;
    return this._lastGsa.pdop;
  }

  /**
   * $G?GSA HDOP，过期/缺失返回 null
   */
  get hdop() {
    if (!this._lastGsa) return null;
    if (Date.now() - this._lastGsa.receivedAt > CONFIG.NMEA_GSA_MAX_AGE_MS) return null;
    return this._lastGsa.hdop;
  }

  /**
   * $G?GSA VDOP，过期/缺失返回 null
   */
  get vdop() {
    if (!this._lastGsa) return null;
    if (Date.now() - this._lastGsa.receivedAt > CONFIG.NMEA_GSA_MAX_AGE_MS) return null;
    return this._lastGsa.vdop;
  }

  /**
   * 融合精度因子（3D Dilution of Precision 综合评估）。
   * PDOP = sqrt(HDOP² + VDOP²) 是三维几何精度的总度量，作为融合主值；
   * 缺失 PDOP 时用 sqrt(HDOP² + VDOP²) 兜底合成。
   * 返回 { value, quality, label }，quality ∈ 'excellent'|'good'|'moderate'|'poor'；无数据返回 null。
   */
  get fusedDop() {
    if (!this._lastGsa) return null;
    if (Date.now() - this._lastGsa.receivedAt > CONFIG.NMEA_GSA_MAX_AGE_MS) return null;
    const p = this._lastGsa.pdop;
    const h = this._lastGsa.hdop;
    const v = this._lastGsa.vdop;
    let value;
    if (p != null && !isNaN(p) && p > 0) {
      value = p;
    } else {
      const hs = (h != null && !isNaN(h)) ? h * h : 0;
      const vs = (v != null && !isNaN(v)) ? v * v : 0;
      const sum = hs + vs;
      if (sum <= 0) return null;
      value = Math.sqrt(sum);
    }
    if (!isFinite(value) || value <= 0) return null;
    let quality;
    if (value < 2) quality = 'excellent';
    else if (value < 3) quality = 'good';
    else if (value < 6) quality = 'moderate';
    else quality = 'poor';
    const label = { excellent: '极佳', good: '良好', moderate: '一般', poor: '差' }[quality];
    return { value: Math.round(value * 10) / 10, quality, label };
  }

  /**
   * HDOP 定位质量分级（与 accuracy 信号条互补）：
   * 'excellent' | 'good' | 'moderate' | 'poor' | null（无数据）
   */
  get dopQuality() {
    const h = this.hdop;
    if (h == null) return null;
    if (h < 1) return 'excellent';
    if (h < 2) return 'good';
    if (h < 5) return 'moderate';
    return 'poor';
  }

  /**
   * 参与定位星座数（多系统协同冗余，参与定位卫星归属的非零星座个数）
   */
  get gnssUsedConstellationCount() {
    const stats = this.gnssUsedConstellationStats;
    return ['gps', 'beidou', 'glonass', 'galileo', 'other'].filter((k) => stats[k] > 0).length;
  }

  /**
   * 单次定位信号质量评分（0-100）：SNR(35) + HDOP(40) + 参与卫星数(25) + 多星座冗余加成(5)
   * 有 GNSS 插件且卫星参与时按上述打分；
   * 无插件（Web/IP 定位）时基于 accuracy 给降级分，保证评分恒有值；
   * 从未获得任何位置时返回 null。
   */
  get signalQualityScore() {
    if (this._gnssPlugin && this.gnssUsedCount > 0) {
      const snr = this.gnssAvgSnr;
      const hdop = this.hdop;
      const used = this.gnssUsedCount;
      // SNR 35 分：20dB→0, 40dB→35；缺失给中间值 17
      const snrScore = snr == null ? 17 : Math.max(0, Math.min(35, ((snr - 20) / 20) * 35));
      // HDOP 40 分：4→0, 1→40；缺失给中间值 20
      const hdopScore = hdop == null ? 20 : Math.max(0, Math.min(40, ((4 - hdop) / 3) * 40));
      // 卫星数 25 分：4→0, 8→25
      const usedScore = Math.max(0, Math.min(25, ((used - 4) / 4) * 25));
      // 多星座冗余加成 5 分：参与定位星座 ≥3 个（多系统协同，几何更强）时 +5
      const constBonus = this.gnssUsedConstellationCount >= 3 ? 5 : 0;
      return Math.min(100, Math.round(snrScore + hdopScore + usedScore + constBonus));
    }
    // Web/IP 降级分：无 GNSS 插件时按 accuracy（米）粗略分级，让评分融合出单一值
    const acc = this.currentPosition && Number.isFinite(this.currentPosition.accuracy)
      ? this.currentPosition.accuracy : null;
    if (acc == null) return null;
    if (acc <= 20) return 60;
    if (acc <= 100) return 40;
    if (acc <= 500) return 20;
    return 5;
  }

  /**
   * 信号评分详细信息（UI 展示分解用）
   * @returns {{score:number, source:'gnss'|'web', breakdown:string}|null}
   */
  get signalQuality() {
    const score = this.signalQualityScore;
    if (score == null) return null;
    if (this._gnssPlugin && this.gnssUsedCount > 0) {
      let breakdown = `SNR ${this.gnssAvgSnr != null ? this.gnssAvgSnr.toFixed(0) : '--'}dB` +
        ` · HDOP ${this.hdop != null ? this.hdop.toFixed(1) : '--'}` +
        ` · 卫星 ${this.gnssUsedCount} 颗`;
      const constCount = this.gnssUsedConstellationCount;
      if (constCount >= 2) breakdown += ` · ${constCount} 星座`;
      return { score, source: 'gnss', breakdown };
    }
    const acc = this.currentPosition && Number.isFinite(this.currentPosition.accuracy)
      ? this.currentPosition.accuracy : null;
    return { score, source: 'web', breakdown: acc != null ? `精度 ±${Math.round(acc)}m` : '' };
  }

  /**
   * $GPGGA 海拔 MSL（米），过期/缺失返回 null
   */
  get altitudeMsl() {
    if (!this._lastGga) return null;
    if (Date.now() - this._lastGga.receivedAt > CONFIG.NMEA_GGA_MAX_AGE_MS) return null;
    return this._lastGga.altitudeMsl;
  }

  /**
   * $GPGGA 大地水准面分离（米，可正可负），过期/缺失返回 null
   */
  get geoidSep() {
    if (!this._lastGga) return null;
    if (Date.now() - this._lastGga.receivedAt > CONFIG.NMEA_GGA_MAX_AGE_MS) return null;
    return this._lastGga.geoidSep;
  }

  /**
   * $GPGGA 定位质量有效性（fixQuality > 0），过期/缺失返回 null。
   * 作为定位源降级信号：GGA 明确报 fix 无效（fixQuality=0）时，即便卫星数/HDOP 达标也不足以信任原生坐标。
   * null 表示未收到 GGA，不干预既有决策（与 "无数据" 区分）。
   */
  get ggaFixValid() {
    if (!this._lastGga) return null;
    if (Date.now() - this._lastGga.receivedAt > CONFIG.NMEA_GGA_MAX_AGE_MS) return null;
    return this._lastGga.fixValid;
  }

  /**
   * 椭球高 = MSL 海拔 + 大地水准面分离（与浏览器 coords.altitude 口径一致）
   */
  get ellipsoidalAltitude() {
    const msl = this.altitudeMsl;
    if (msl == null) return null;
    const sep = this.geoidSep;
    return sep == null ? msl : msl + sep;
  }

  /**
   * 海拔口径来源：'gga'（GGA 椭球高）| 'browser'（浏览器 coords.altitude）
   * 海拔滤波链用它检测口径切换，切换时重置卡尔曼避免平台基准跳变。
   */
  get altitudeSource() {
    return this.ellipsoidalAltitude != null ? 'gga' : 'browser';
  }

  /**
   * 原生坐标是否可信（坐标交叉校验连续超阈后置 false，恢复后回到 true）
   */
  get nativeCoordTrusted() {
    return this._nativeCoordTrusted;
  }

  /**
   * 当前定位源（对外两态）：
   * 'GNSS' = 原生芯片接管（有插件且信号好）
   * 'Web'  = 浏览器定位顶上（无插件 / 信号差 / NMEA 过期）
   */
  get gpsSource() {
    return this._gpsSource === 'native' ? 'GNSS' : 'Web';
  }

  /**
   * 当前速度来源：'gnss'（原生 VTG/RMC 优先）| 'browser'（浏览器降级）
   */
  get speedSource() {
    return this.vtgSpeedKmh != null ? 'gnss' : 'browser';
  }

  /**
   * 速度解算：VTG（km/h → m/s）优先，RMC 交叉验证，浏览器 coords.speed 兜底。
   * VTG 与 RMC 速度偏差过大（绝对 + 相对双阈值）→ 判定冲突，降级浏览器物理测量。
   */
  _resolveSpeed(browserSpeed) {
    const vtg = this.vtgSpeedKmh;
    if (vtg != null && vtg >= 0) {
      const rmc = this.rmcSpeedKmh;
      if (rmc != null && rmc >= 0) {
        const vtgMs = vtg / 3.6;
        const rmcMs = rmc / 3.6;
        const diff = Math.abs(vtgMs - rmcMs);
        const ratioConflict = vtgMs > 0 && diff / vtgMs > CONFIG.NMEA_SPEED_CONFLICT_RATIO;
        if (diff > CONFIG.NMEA_SPEED_CONFLICT_ABS && ratioConflict) {
          // 两原生源冲突 → 浏览器 coords.speed（物理测量，最可信）
          return browserSpeed != null ? browserSpeed : null;
        }
      }
      return vtg / 3.6;
    }
    return browserSpeed != null ? browserSpeed : null;
  }

  /**
   * 航向解算：VTG 真航向优先，RMC 交叉验证，浏览器 coords.heading 兜底。
   * 低速（< NMEA_HEADING_MIN_SPEED）航向无意义，跳过交叉验证。
   */
  _resolveHeading(browserHeading) {
    const vtg = this.vtgTrack;
    if (vtg != null && !isNaN(vtg)) {
      const rmc = this.rmcTrack;
      if (rmc != null && !isNaN(rmc)) {
        const speed = this._resolveSpeed(null);
        if (speed != null && speed >= CONFIG.NMEA_HEADING_MIN_SPEED) {
          let diff = Math.abs(vtg - rmc) % 360;
          if (diff > 180) diff = 360 - diff;
          if (diff > CONFIG.NMEA_HEADING_CONFLICT_DEG) {
            return browserHeading != null ? browserHeading : null;
          }
        }
      }
      return vtg;
    }
    return browserHeading != null ? browserHeading : null;
  }

  /**
   * 海拔解算：GGA 椭球高（MSL+分离，与浏览器口径一致）优先，浏览器 coords.altitude 兜底。
   * 弱信号（GNSS 降级）时不接收任何海拔数据——弱信号下垂直精度极差，海拔无意义。
   */
  _resolveAltitude(browserAltitude) {
    if (this._weakSignal) return null;
    const gga = this.ellipsoidalAltitude;
    if (gga != null) return gga;
    return browserAltitude != null ? browserAltitude : null;
  }
}
