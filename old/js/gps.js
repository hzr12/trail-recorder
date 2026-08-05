/**
 * 圆圈地图 - GPS 定位管理器
 * ============================================
 * 使用浏览器原生 Geolocation API 获取设备位置
 * 支持单次定位 + 持续追踪
 */

/**
 * 二维卡尔曼滤波器 — 2D 恒速模型（位置+速度矢量），局部 ENU 米坐标
 * 以首次定位为参考点，lat/lng → 米滤波 → 逆变换输出
 * Q/R 自适应 accuracy，速度更新带阻尼 + 模量限幅
 */
class KalmanFilter {
  constructor() {
    this._x = 0;          // 位置估计 x（米，相对参考点）
    this._y = 0;          // 位置估计 y（米，相对参考点）
    this._vx = 0;         // 速度估计 vx（米/秒）
    this._vy = 0;         // 速度估计 vy（米/秒）
    // 协方差 P（4×4 行主序 [x, y, vx, vy]），初始位置不确定度 50m，速度不确定度 5m/s
    this._P = [2500, 0, 0, 0,
               0, 2500, 0, 0,
               0, 0, 25, 0,
               0, 0, 0, 25];
    this._refLat = 0;     // 参考点纬度（度）
    this._refLng = 0;     // 参考点经度（度）
    this._cosLat = 1;     // cos(refLat)，经度→米换算系数
    this._lastTime = 0;
    this._initialized = false;
  }

  /**
   * 重置滤波器并设置初始值（当前点即参考点）
   */
  init(lat, lng, time) {
    this._refLat = lat;
    this._refLng = lng;
    this._cosLat = Math.cos(lat * Math.PI / 180);
    this._x = 0;
    this._y = 0;
    this._vx = 0;
    this._vy = 0;
    this._P = [2500, 0, 0, 0,
               0, 2500, 0, 0,
               0, 0, 0, 0,
               0, 0, 0, 0];
    this._lastTime = time;
    this._initialized = true;
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
    if (!this._initialized || accuracy > 200) {
      // 精度太差或未初始化 → 直接接受测量值
      this.init(zLat, zLng, time);
      return { lat: zLat, lng: zLng };
    }

    const dt = (time - this._lastTime) / 1000; // 秒
    this._lastTime = time;

    if (dt <= 0 || dt > 60) {
      // 时间异常或间隙过大 → 重置
      this.init(zLat, zLng, time);
      return { lat: zLat, lng: zLng };
    }

    // 坐标正变换：lat/lng → 局部米
    let mx = (zLng - this._refLng) * 111111 * this._cosLat;
    let my = (zLat - this._refLat) * 111111;

    // 距参考点超 3km → 重新锚定（x/y 平移，速度不变）
    if (Math.hypot(mx, my) > 3000) {
      this._reanchor();
      mx = (zLng - this._refLng) * 111111 * this._cosLat;
      my = (zLat - this._refLat) * 111111;
    }

    // 动态 q（m/s²）：精度好时跟手（响应快），精度差时平滑（抑制噪声）
    // 系数 0.5 + 速度自适应 speedFactor（clamp(speed/0.5,1,12)）：
    // 静止 q=0.1、步行 1.5m/s q=0.3、高速 40m/s q=1.2 m/s²。
    // 经参数扫描校准（5 次运行全过：静止 RMSE 2.3-2.9m ≤3.5；轨迹 RMSE
    // 3.4-3.8m < 1D 3.9-4.1m；重锚 40m/s 误差 40m <60m。原固定 sf=3 时
    // 高速场景速度收敛过慢 → 重锚误差 97.5m 超标）
    const accClamped = Math.max(Math.min(accuracy || 10, 100), 1);
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
    // F·P（F: [1,0,dt,0; 0,1,0,dt; 0,0,1,0; 0,0,0,1]）
    // 正确展开：A[i][j] = P[i][j] + dt·P[(i+2)][j]（i<2 时，列方向 j 遍历）；i≥2 时 A[i][j] = P[i][j]
    const fp = new Array(16).fill(0);
    for (let i = 0; i < 4; i++) {
      const dRow = i < 2 ? dt : 0;
      const pr = i * 4;
      // i≥2 时 dRow=0，不读取越界行（i+2 行超出 4×4 范围，避免 0×undefined=NaN）
      const pr2 = i < 2 ? (i + 2) * 4 : pr;
      fp[pr + 0] = this._P[pr + 0] + dRow * this._P[pr2 + 0];
      fp[pr + 1] = this._P[pr + 1] + dRow * this._P[pr2 + 1];
      fp[pr + 2] = this._P[pr + 2] + dRow * this._P[pr2 + 2];
      fp[pr + 3] = this._P[pr + 3] + dRow * this._P[pr2 + 3];
    }
    // (F·P)·Fᵀ：B[i][0]=A[i][0]+dt·A[i][2], B[i][1]=A[i][1]+dt·A[i][3], B[i][2]=A[i][2], B[i][3]=A[i][3]
    const P = new Array(16).fill(0);
    for (let i = 0; i < 4; i++) {
      P[i * 4 + 0] = fp[i * 4 + 0] + dt * fp[i * 4 + 2];
      P[i * 4 + 1] = fp[i * 4 + 1] + dt * fp[i * 4 + 3];
      P[i * 4 + 2] = fp[i * 4 + 2];
      P[i * 4 + 3] = fp[i * 4 + 3];
    }
    // + Q（DWNA 块对角，对称叠加：行主序 P00/P11/P22/P33 对角，P02=P20、P13=P31 交叉对）
    P[0] += q00;  P[5] += q00;   // 位置对角 (x,x),(y,y)
    P[2] += q02;  P[8] += q02;   // x/vx 交叉（对称对）
    P[7] += q02;  P[13] += q02;  // y/vy 交叉（对称对）
    P[10] += q22; P[15] += q22;  // 速度对角 (vx,vx),(vy,vy)

    // ── Update（更新）──
    const sigma = Math.max(3, Math.min(accClamped, 100)); // 米
    const r = sigma * sigma;
    // S = H·P⁻·Hᵀ + R（2×2：P 的位置块 + diag(r, r)）
    const s00 = P[0] + r, s01 = P[1], s10 = P[4], s11 = P[5] + r;
    const det = s00 * s11 - s01 * s10;
    const si00 = s11 / det, si01 = -s01 / det, si10 = -s10 / det, si11 = s00 / det;
    // K = P⁻·Hᵀ·S⁻¹（4×2，取 P 前两列 × S⁻¹）
    const k00 = (P[0] * si00 + P[1] * si10);
    const k01 = (P[0] * si01 + P[1] * si11);
    const k10 = (P[4] * si00 + P[5] * si10);
    const k11 = (P[4] * si01 + P[5] * si11);
    const k20 = (P[8] * si00 + P[9] * si10);
    const k21 = (P[8] * si01 + P[9] * si11);
    const k30 = (P[12] * si00 + P[13] * si10);
    const k31 = (P[12] * si01 + P[13] * si11);

    const e0 = mx - this._x;
    const e1 = my - this._y;
    this._x += k00 * e0 + k01 * e1;
    this._y += k10 * e0 + k11 * e1;

    // 带阻尼的速度更新（防止噪声放大）
    const dtSafe = Math.max(dt, 0.1);
    this._vx += 0.3 * (k20 * e0 + k21 * e1) / dtSafe;
    this._vy += 0.3 * (k30 * e0 + k31 * e1) / dtSafe;

    // 速度模量限幅（120m/s ≈ 432km/h，防止突发漂移）
    const spd = Math.hypot(this._vx, this._vy);
    if (spd > 120) {
      const k = 120 / spd;
      this._vx *= k;
      this._vy *= k;
    }

    // P = (I − K·H)·P⁻，随后对称化
    const IKH = [1 - k00, -k01, 0, 0,
                 -k10, 1 - k11, 0, 0,
                 -k20, -k21, 1, 0,
                 -k30, -k31, 0, 1];
    const Pn = new Array(16).fill(0);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += IKH[i * 4 + k] * P[k * 4 + j];
        Pn[i * 4 + j] = sum;
      }
    }
    // 对称化 (P + Pᵀ) / 2
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const v = (Pn[i * 4 + j] + Pn[j * 4 + i]) / 2;
        this._P[i * 4 + j] = v;
      }
    }

    // 逆变换：米 → lat/lng
    return {
      lat: this._refLat + this._y / 111111,
      lng: this._refLng + this._x / (111111 * this._cosLat)
    };
  }

  /**
   * 重新锚定参考点到当前状态位置（x/y 平移，速度不变）
   */
  _reanchor() {
    const curLat = this._refLat + this._y / 111111;
    const curLng = this._refLng + this._x / (111111 * this._cosLat);
    this._refLat = curLat;
    this._refLng = curLng;
    this._cosLat = Math.cos(curLat * Math.PI / 180);
    this._x = 0;
    this._y = 0;
  }

  /** 重置滤波器 */
  reset() {
    this._initialized = false;
    this._x = 0;
    this._y = 0;
    this._vx = 0;
    this._vy = 0;
    this._P = [2500, 0, 0, 0,
               0, 2500, 0, 0,
               0, 0, 0, 0,
               0, 0, 0, 0];
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
    this.onDowngrade = null;   // 降级回调 (timeout) => void
    this.onRecovery = null;    // 恢复回调 (success: boolean) => void
    this.onPowerSavingChange = null; // 省电模式变更回调 (isOn: boolean) => void
    this.onCriticalBattery = null;   // 低电量自动停止回调 () => void
    this.onRestoreTracking = null;   // 电量恢复自动恢复追踪回调 () => void

    // GPS 超时降级状态
    this._consecutiveTimeouts = 0;  // 连续超时次数
    this._downgraded = false;       // 是否已降级到低精度
    this._lastPositionTime = 0;     // 上次收到位置的时间戳
    this._timeoutCheckId = null;    // 超时检测定时器
    this._recoveryTimerId = null;   // 恢复尝试定时器

    // GNSS 插件（Capacitor 原生端卫星数据）
    this._gnssPlugin = null;       // Capacitor.Plugins.GnssData 引用
    this._gnssSatellites = [];     // GnssSatelliteInfo[]
    this._gnssInitError = null;    // 初始化失败原因
    this._gnssListeningStarted = false; // startGnss() 是否已调用
    this._gnssStarting = null;     // startGnss() 的 Promise，防止并发
    this._gnssStopRequested = false; // stopGnss() 在启动过程中被调用时置位，中止启动
    this._gnssPollRunning = false;  // GNSS 轮询兜底是否正在执行
    this._gnssStatusHandle = null; // gnssStatus 事件监听器句柄
    this._gnssNmeaHandle = null;   // nmeaSentence 事件监听器句柄
    this._gnssPollId = null;       // GNSS 轮询兜底定时器

    // GPS 漂移滤波器
    this._useFilter = true;           // 是否启用滤波
    this._filter = new KalmanFilter();
    this._rawPosition = null;         // 滤波前的原始位置（保留供 trail 等使用）

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
      return;
    }
    const plugin = Capacitor.Plugins.GnssData;
    if (!plugin) {
      this._gnssInitError = 'plugin_not_registered';
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
          this._gnssSatellites = event.satellites;
          if (CONFIG.DEBUG) console.log('[GPS] GNSS 事件收到，卫星数:', event.satellites.length);
        }
      };
      const nmeaHandler = (nmea) => {
        if (nmea) {
          if (CONFIG.DEBUG) console.log('[GPS] NMEA:', nmea.sentence?.substring(0, 20) + '...');
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
          Toast.show(` ACCESS_FINE_LOCATION 权限被拒 — 请到系统设置→应用→CircleMap→位置，开启"始终允许"`, 6000);
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
        if (data && data.satellites && data.satellites.length > 0) {
          this._gnssSatellites = data.satellites;
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
    this._gnssInitError = null;
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

      navigator.geolocation.getCurrentPosition(
        // 成功回调
        (position) => {
          clearTimeout(fallbackTimer);
          const pos = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
            altitude: position.coords.altitude,
            speed: position.coords.speed,
            heading: position.coords.heading,
            timestamp: position.timestamp
          };
          this.currentPosition = pos;
          resolve(pos);
        },
        // 失败回调
        (error) => {
          clearTimeout(fallbackTimer);
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
        },
        {
          enableHighAccuracy: true,
          timeout: t,
          maximumAge: 0 // 每次获取最新位置
        }
      );
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

        // 构造统一位置对象
        const buildPos = () => ({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          altitude: position.coords.altitude,
          speed: position.coords.speed,
          heading: position.coords.heading,
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

        // 保存原始位置（滤波前）
        this._rawPosition = { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, speed: pos.speed, heading: pos.heading, timestamp: pos.timestamp };

        // ── 2D 卡尔曼滤波实时平滑 ──
        if (this._useFilter && pos.accuracy > 0 && pos.accuracy < 200) {
          // 用收到时刻而非 position.timestamp：maximumAge 缓存/重复 fix 的旧时间戳
          // 会使 dt ≤ 0 触发滤波器重置，平滑被静默关闭
          const ts = now;
          const acc = pos.accuracy || 10;
          const filtered = this._filter.update(pos.lat, pos.lng, acc, ts, pos.speed);
          pos.lat = filtered.lat;
          pos.lng = filtered.lng;
        } else {
          // 精度太差或滤波关闭 → 重置滤波器
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
    if (this.onWatchStop) this.onWatchStop();
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
    }
    if (CONFIG.DEBUG) console.log(`[GPS] 漂移滤波: ${next ? '开启' : '关闭'}`);
    return this._useFilter;
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
   * 参与定位的卫星数
   */
  get gnssUsedCount() {
    return this._gnssSatellites.filter(s => s.usedInFix).length;
  }

  /**
   * 可见卫星总数
   */
  get gnssVisibleCount() {
    return this._gnssSatellites.length;
  }

  /**
   * 参与定位卫星的平均信噪比 (dB-Hz)
   */
  get gnssAvgSnr() {
    const used = this._gnssSatellites.filter(s => s.usedInFix);
    if (used.length === 0) return 0;
    return used.reduce((sum, s) => sum + s.cn0DbHz, 0) / used.length;
  }

  /**
   * 按星座分组的卫星数量（所有可见卫星）
   * @returns {{gps:number, beidou:number, glonass:number, galileo:number, other:number}}
   */
  get gnssConstellationStats() {
    const stats = { gps: 0, beidou: 0, glonass: 0, galileo: 0, other: 0 };
    for (const s of this._gnssSatellites) {
      switch (s.constellation) {
        case 'GPS':     stats.gps++; break;
        case 'BEIDOU':  stats.beidou++; break;
        case 'GLONASS': stats.glonass++; break;
        case 'GALILEO': stats.galileo++; break;
        default:        stats.other++; break;
      }
    }
    return stats;
  }

  /**
   * 按星座分组的参与定位卫星数量
   * @returns {{gps:number, beidou:number, glonass:number, galileo:number, other:number}}
   */
  get gnssUsedConstellationStats() {
    const stats = { gps: 0, beidou: 0, glonass: 0, galileo: 0, other: 0 };
    for (const s of this._gnssSatellites) {
      if (!s.usedInFix) continue;
      switch (s.constellation) {
        case 'GPS':     stats.gps++; break;
        case 'BEIDOU':  stats.beidou++; break;
        case 'GLONASS': stats.glonass++; break;
        case 'GALILEO': stats.galileo++; break;
        default:        stats.other++; break;
      }
    }
    return stats;
  }
}
