/**
 * 圆圈地图 - GPS 定位管理器（主控制器）
 * ============================================
 * gps.js 拆分后的最后一个文件：GPSManager 实例化并协调前面所有类
 * （KalmanFilter / ImmFilter / AltFilterPipeline / AltRtsSmoother / ImuManager）。
 * 依赖 gps-kalman.js 的全局常量 DEG2RAD / M_PER_DEG、config.js 的 calcDistance、
 * toast.js 的 Toast，必须在其后加载。
 */

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
    this._geoidBaseline = null;    // 大地水准面分离基准（米），计划 D：首个可信 GGA sep 锁定
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
    this._rawFixes = [];              // 原始测量缓冲（滤波前），供结束记录时 RTS 离线平滑
    this._maxRawFixes = 50000;        // 缓冲上限（超出丢弃最旧，防止内存膨胀）
    this._mapManager = null;          // 注入 mapManager，采集时把原始坐标预转 GCJ02（与轨迹点同系）

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

    // 位置差分航向兜底（GPS 航向缺失/低速时，用滤波后相邻点位移反推航向 + 一阶低通）
    this._diffHeading = null;          // 低通后的差分航向（度，0~360）
    this._diffHeadingPos = null;       // 上一次用于差分的滤波后位置 {lat, lng}
    this._lastHeadingSource = 'none';  // 航向来源（vtg/browser/none），驱动 IMU 水平注入开关

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
    this._geoidBaseline = null; // 清除海拔基准（源切换/重置）
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
      // 计划 D：锁定首个有效 sep 作为本地大地水准面基准（零基准，避免跨城坏数据）
      if (CONFIG.ALT_USE_GEOID_BASELINE !== false && geoidSep != null && isFinite(geoidSep)) {
        if (this._geoidBaseline == null) {
          this._geoidBaseline = geoidSep;
          if (CONFIG.DEBUG) console.log(`[ALT] 锁定大地水准面基准 sep=${geoidSep.toFixed(1)}m`);
        }
      }
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
    // 卫星数变化 → 动态同步 IMU 启停（解算中卫星数 > IMU_MIN_USED_SATS 才开启）
    this._syncImuState();
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
    // 计划 #6：双频探测——同系统存在 L5(≈1176.45MHz) 与 L1(≈1575.42MHz) 观测
    let hasL1 = false, hasL5 = false;
    for (const s of satellites) {
      const f = s.carrierFreqHz;
      if (typeof f === 'number' && f > 0) {
        if (f > 1170 && f < 1185) hasL5 = true;
        else if (Math.abs(f - 1575.42) < 5) hasL1 = true;
      }
    }
    stats.dualBand = hasL1 && hasL5;
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

        // 方向 5 增强：水平 E/N 注入依赖航向（ENU 旋转需要航向信息）。单靠加速度计
        // 在数学上不可观测航向（绕重力轴旋转无信息），航向缺失/低速时水平方向会差
        // 一个未知固定角 → 错误拉偏轨迹。故航向不可靠时禁用水平注入、只保留 U 轴
        // 海拔注入（垂直不依赖航向，只依赖俯仰/翻滚，是加速度可观测部分）。
        // 航向可靠 = GPS 航向源有效（vtg 原生 / browser 物理测量）且非低速。
        // IMU_HORIZONTAL_REQUIRE_HEADING=false → 回归旧行为（恒可靠，不受航向约束）。
        const hdrSrc = this._lastHeadingSource;
        const hdrReliable = CONFIG.IMU_HORIZONTAL_REQUIRE_HEADING === false ? true :
          (hdrSrc === 'vtg' || hdrSrc === 'browser') &&
          (pos.speed == null || pos.speed >= CONFIG.HEADING_DIFF_MIN_SPEED);
        if (this._imuManager) this._imuManager.setHeadingReliable(hdrReliable);
        // 注入 GPS 速度供 IMU 零偏估计的"真静止"判定（方向 6 扩展：E/N 轴零偏仅静止时学习）
        if (this._imuManager) this._imuManager.setGpsSpeed(pos.speed);

        // ── IMU 定位校准：三轴加速度一次取用 ──
        // web 无插件 / 事件流过期 / 未启动 → getLatestAccEnu() 返回 null，跳过注入纯 GPS 不变。
        // 水平 [E,N] 注入 ImmFilter CA 预测（trust 自适应 + 分级 clamp + 重力泄漏衰减）；
        // 垂直 [U] 注入海拔 CA 融合（GPS 仍是海拔权威，方向 3）。
        const imuAcc = this._imuManager ? this._imuManager.getLatestAccEnu() : null;
        // IMU 辅助状态：本帧有可用三轴加速度（参与海拔/水平注入）即为辅助激活。
        // web 无插件 / 事件流过期 → imuAcc 为 null → 关闭（状态栏胶囊淡紫发光随之熄灭）。
        this.imuAssistActive = !!imuAcc;

        // ── 海拔独立滤波（L2 自适应卡尔曼 + L3 中值/Huber + IMU 垂直注入）──
        // 垂直 [U] 不依赖航向，始终注入（GPS 仍是海拔权威，方向 3）。
        // 原始海拔（质量门后、滤波前）保留供离线 RTS 使用；滤波值用于实时展示/落点
        if (imuAcc && this._altFilter && typeof this._altFilter.feedAccU === 'function') {
          this._altFilter.feedAccU(imuAcc[2], pos.speed);
        }
        const rawAltitude = pos.altitude;
        pos.altitude = this._altFilter.push(rawAltitude, this.altitudeSource, now);

        // 保存原始位置（滤波前），供结束记录时的 RTS 离线平滑使用。
        // 坐标预转 GCJ02（与 trail.positions 同系），时间戳用 pos.timestamp（与 addPoint 的 pt.ts 同源）。
        // 修复：此前存 WGS84 + 用收到时刻 now，导致 RTS 输出被写回 GCJ02 轨迹时出现
        // 坐标系错位（整体漂移 ~500m）与匹配失败（byTs 查 pt.time 落空）。
        this._rawPosition = { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, speed: pos.speed, heading: pos.heading, altitude: rawAltitude, timestamp: pos.timestamp };
        if (this._rawFixes.length < this._maxRawFixes) {
          const fixLatLng = this._mapManager
            ? this._mapManager.wgs84ToGcj02Sync({ lat: pos.lat, lng: pos.lng })
            : { lat: pos.lat, lng: pos.lng };
          this._rawFixes.push({
            lat: fixLatLng.lat,          // GCJ02（与轨迹点同系，RTS 全程 GCJ02 空间平滑）
            lng: fixLatLng.lng,          // GCJ02
            accuracy: pos.accuracy || 0,
            speed: pos.speed,
            altitude: rawAltitude,       // 原始海拔（质量门后），供离线 1D RTS 平滑
            time: pos.timestamp,         // GPS 事件时刻（与 addPoint 的 pt.ts 同源）
            ts: pos.timestamp            // 匹配 key：与 trail.positions 的 pt.ts 逐位相等
          });
        }

        // ── 2D 卡尔曼滤波实时平滑 ──
        if (this._useFilter && pos.accuracy > 0) {
          // ── IMU 定位校准：水平加速度注入 CA 模型预测（航向仍由 GPS 权威）──
          // 方向 4/5/6：按 GPS 速度分级 clamp、重力泄漏衰减（ImuManager.tiltLeakFactor）、
          // trust 随 GPS-IMU 一致性自适应（ImmFilter 内部调整）。注入值单次消费。
          // 航向不可靠（低速起步/遮挡/丢星）时跳过水平注入，只留海拔注入（见上）。
          if (imuAcc && hdrReliable && typeof this._filter.feedImu === 'function') {
            const tiltFactor = this._imuManager ? this._imuManager.tiltLeakFactor : 1;
            this._filter.feedImu(imuAcc, pos.speed, tiltFactor);
          }
          // 用收到时刻而非 position.timestamp：maximumAge 缓存/重复 fix 的旧时间戳
          // 会使 dt ≤ 0 触发滤波器重置，平滑被静默关闭
          const ts = now;
          const acc = pos.accuracy || 10;
          // 计划 #2/#6：注入 GNSS 质量（HDOP + 双频）调制观测噪声 R。
          // Web 端无 GSA → hdop=null（不调制）；无双频 → scale=1（降级单频）。
          if (typeof this._filter.setGnssQuality === 'function') {
            this._filter.setGnssQuality(this.hdop, this.dualBandAvailable ? CONFIG.GNSS_DUALBAND_R_SCALE : 1);
          }
          // 精度差（>2000m，地下/遮挡）也进 update()：内部改为冻结在最后可信位置，
          // 不再重置+接受跳变测量（避免轨迹拉回又回去）。RTS 后处理修正地下段。
          const filtered = this._filter.update(pos.lat, pos.lng, acc, ts, pos.speed);
          pos.lat = filtered.lat;
          pos.lng = filtered.lng;
        } else {
          // 无精度信息或滤波关闭 → 重置滤波器
          this._filter.reset();
        }

        // 位置差分航向兜底：GPS 航向缺失或低速（步行起步/遮挡）时，用滤波后相邻点
        // 位移反推航向（atan2(dE,dN)）+ 一阶低通，避免箭头乱抖。仅此路径启用。
        pos.heading = this._resolveHeadingFallback(pos);

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
    this._syncImuState();      // IMU 按条件启动（仅定位校准；需 usedInFix 卫星数 > IMU_MIN_USED_SATS）
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
    // 重置位置差分航向状态，防止跨会话用陈旧基线推算航向
    this._diffHeading = null;
    this._diffHeadingPos = null;
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
   * IMU 是否应当运行：web 无插件 / 未 watch / 省电模式 → 不运行；
   * 仅当参与定位（解算中 usedInFix）卫星数 > IMU_MIN_USED_SATS 才启用。
   * @returns {boolean}
   */
  _imuShouldRun() {
    if (!this._imuManager || !this.isWatching || this._powerSaving) return false;
    return this.gnssUsedCount > CONFIG.IMU_MIN_USED_SATS;
  }

  /**
   * 按当前条件同步 IMU 启停状态（随卫星数 / 省电 / watch 生命周期动态切换）：
   * 满足条件则启动，否则停止（停止会清空缓存，防止陈旧加速度注入）。
   */
  _syncImuState() {
    if (!this._imuManager) return;
    if (this._imuShouldRun()) this._startImu();
    else this._stopImu();
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
    this._geoidBaseline = null; // 清空海拔基准（跨会话/源切换重置）
  }

  /** 注入 MapManager：采集原始测量时预转 GCJ02，使 RTS 全程在 GCJ02 空间平滑 */
  setMapManager(mapManager) {
    this._mapManager = mapManager;
  }

  /**
   * 对缓冲内所有原始测量做离线 RTS 平滑（整段后处理）
   * 用于结束记录后提升轨迹精度。会清空缓冲，返回平滑结果。
   * @returns {Array<{lat:number,lng:number,time:number,ts:*}>} 平滑后 GCJ02 坐标序列
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
   * 输入已由采集路径预转为 GCJ02（与轨迹点同系），输出亦为 GCJ02，回写零转换。
   * 水平复用现有 2D RTS（KalmanFilter.smoothTrail），海拔走完全独立的 1D RTS（AltRtsSmoother），
   * 二者互不依赖。返回元素在水平 RTS 输出基础上并入 `alt` 字段（null 表示该点无海拔/缺口）。
   * @returns {Array<{lat:number,lng:number,time:number,ts:*,alt:number|null}>}
   */
  smoothTrailRts3d() {
    const fixes = this._rawFixes;
    this._rawFixes = [];
    if (!fixes.length) return [];
    // 跳变剔除（独立纯函数，先于 RTS）：修复原始测量中的 GPS 鬼点/漂移，
    // 米坐标线性插值回填，保留等长时间轴。RTS 输入即干净测量，避免炸裂。
    let cleanFixes = fixes;
    if (globalThis.TrailDenoise) {
      cleanFixes = globalThis.TrailDenoise.denoiseTrail(fixes);
    }
    // 水平：现有 2D RTS（只动 lat/lng，不动 altitude；离线走独立单模型实例）
    let horizontal = this._offlineSmoother.smoothTrail(cleanFixes);
    // 运动学约束兜底（独立一步）：对 RTS 输出再做速度/加速度限幅，回拉残留跳变，
    // 与实时 IMU clamp 解耦。TrailDenoise 在 gps-kalman 之后加载，此处必已就绪。
    if (globalThis.TrailDenoise) {
      horizontal = globalThis.TrailDenoise.kinematicClamp(horizontal);
    }
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
   * 计划 #6：是否检测到双频（同系统 L1+L5）。Web 端/老设备无 carrierFreqHz → false（降级单频）。
   * 受 GNSS_DUALBAND_ENABLED 总开关控制。
   */
  get dualBandAvailable() {
    if (CONFIG.GNSS_DUALBAND_ENABLED === false) return false;
    return !!(this._satStatsCache && this._satStatsCache.dualBand);
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
   * 计划 D：当前大地水准面校正量（米）= 实时 sep − 基准 sep。
   * 实时 sep 缺失（browser 口径）时退化为 0（不校正，纯 GPS 零回归）。
   * 偏差超 ALT_GEOID_MAX_DIFF_M 返回 null（放弃校正，防坏数据跳变）。
   */
  get geoidCorrectionM() {
    if (CONFIG.ALT_USE_GEOID_BASELINE === false) return null;
    if (this._geoidBaseline == null) return null;
    const sep = this.geoidSep; // 已含过期判定
    if (sep == null) return 0; // 实时口径无 sep → 不校正
    const corr = sep - this._geoidBaseline;
    if (Math.abs(corr) > CONFIG.ALT_GEOID_MAX_DIFF_M) {
      if (CONFIG.DEBUG) console.warn(`[ALT] 大地水准面校正量 ${corr.toFixed(1)}m 超阈值，放弃校正`);
      return null;
    }
    return corr;
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
            const h = browserHeading != null ? browserHeading : null;
            this._lastHeadingSource = h != null ? 'browser' : 'none';
            return h;
          }
        }
      }
      this._lastHeadingSource = 'vtg';
      return vtg;
    }
    const h = browserHeading != null ? browserHeading : null;
    this._lastHeadingSource = h != null ? 'browser' : 'none';
    return h;
  }

  /**
   * 位置差分航向兜底：GPS 航向缺失或低速（步行起步/遮挡）时，用滤波后相邻两点的
   * 位移反推航向（atan2(dE, dN)）并做一阶低通，避免低速时箭头乱抖。
   * - GPS 航向有效且非低速 → GPS 仍为权威（重置差分状态防遗留旧值）。
   * - 基线位置始终跟踪最近滤波点，保证高速→低速切换时差分可立即生效。
   * - 位移过小（静止/冻结）不更新，保持上次方向。
   * @param {object} pos 已含滤波后 lat/lng、speed、heading（可能 null）的位置对象
   * @returns {number|null} 航向（度 0~360），无法估计时返回原 GPS 航向
   */
  _resolveHeadingFallback(pos) {
    const C = (typeof CONFIG !== 'undefined' && CONFIG) || {};
    const minSpeed = C.HEADING_DIFF_MIN_SPEED != null ? C.HEADING_DIFF_MIN_SPEED : 0.4;
    const minM = C.HEADING_DIFF_MIN_M != null ? C.HEADING_DIFF_MIN_M : 2.0;
    const alpha = C.HEADING_DIFF_LPF_ALPHA != null ? C.HEADING_DIFF_LPF_ALPHA : 0.3;

    const gpsHeading = pos.heading;
    const gpsHeadingValid = gpsHeading != null && !isNaN(gpsHeading);
    const isLowSpeed = pos.speed != null && pos.speed < minSpeed;

    // 基线始终跟踪最近滤波点（无论本次是否走差分）
    const prev = this._diffHeadingPos;
    this._diffHeadingPos = { lat: pos.lat, lng: pos.lng };

    // GPS 航向有效 且 非低速 → GPS 权威，清掉差分状态防遗留
    if (gpsHeadingValid && !isLowSpeed) {
      this._diffHeading = null;
      return gpsHeading;
    }

    // 需要差分兜底（GPS 航向缺失 或 低速）
    if (!prev) return gpsHeading; // 无历史点 → 无法差分

    const dE = (pos.lng - prev.lng) * M_PER_DEG * Math.cos(pos.lat * DEG2RAD);
    const dN = (pos.lat - prev.lat) * M_PER_DEG;
    const dist = Math.hypot(dE, dN);
    if (dist >= minM) {
      let raw = Math.atan2(dE, dN) * 180 / Math.PI;
      if (raw < 0) raw += 360;
      if (this._diffHeading == null) {
        this._diffHeading = raw;
      } else {
        // 角度一阶低通（处理 0/360 环绕）
        let delta = raw - this._diffHeading;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        this._diffHeading = (this._diffHeading + alpha * delta + 360) % 360;
      }
    }
    return this._diffHeading != null ? this._diffHeading : gpsHeading;
  }

  /**
   * 海拔解算：GGA 椭球高（MSL+分离，与浏览器口径一致）优先，浏览器 coords.altitude 兜底。
   * 弱信号（GNSS 降级）时不接收任何海拔数据——弱信号下垂直精度极差，海拔无意义。
   */
  _resolveAltitude(browserAltitude) {
    if (this._weakSignal) return null;
    const corr = this.geoidCorrectionM; // null=放弃校正, 0=无基准不校, 数值=校正量
    const gga = this.ellipsoidalAltitude;
    let raw = gga != null ? gga : (browserAltitude != null ? browserAltitude : null);
    if (raw == null) return null;
    // 校正：把椭球高换算到以本地 geoid 基准对齐的口径，跨口径（GGA↔browser）不跳变
    return corr == null ? raw : raw - corr;
  }
}
