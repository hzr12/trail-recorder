/**
 * 圆圈地图 - 主应用控制器
 * ============================================
 * 协调 MapManager、GPSManager 与 UI 交互
 * 是所有模块的入口
 */

class App {
  constructor() {
    this.mapManager = new MapManager();
    this.gpsManager = new GPSManager();
    this.gpsManager.onCriticalBattery = () => {
      if (this._isWatching) {
        Toast.show(' 电量不足 10%，追踪已自动停止');
        this._isWatching = false;
        this.gpsManager.stopWatching();
        this.gpsManager.onPositionChange = null;
        this.gpsManager.onError = null;
        this.gpsManager.onDowngrade = null;
        this.gpsManager.onRecovery = null;
        this._gpsBtn.classList.remove('watching');
        this._gpsBtn.title = '定位到我的位置';
        this._hideSpeedChart();
        this._speedHistory = [];
        this._prevDistances = {};
        if (this._speedChart) {
          this._speedChart.data.datasets[0].data = [];
          this._speedChart.update('none');
        }
      }
    };
    this.gpsManager.onPowerSavingChange = (isOn) => {
      const btn = document.getElementById('power-saving-btn');
      if (btn) btn.classList.toggle('active', isOn);
    };
    this.gpsManager.onRestoreTracking = () => {
      Toast.show(' 电量恢复，已自动恢复追踪');
      this._startWatching();
    };
    this.circleRadius = CONFIG.DEFAULT_RADIUS;
    this.center = null;          // 当前标记位置
    this.myPosition = null;      // 我的位置（GCJ-02，由 GPS 定位设置）
    this.myPositionTime = null;  // 上次定位成功时间戳（毫秒，用于过期检测）
    this.mode = 'click';
    this._circleListEl = null;   // 圆列表 DOM
    this._statusEl = null;       // GPS 状态条
    this._isWatching = false;    // 持续追踪开关
    this._prevDistances = {};    // circleId → 上次距离（米），用于趋势判断
    this._firstFix = true;       // 是否是首次定位
    this._relocating = false;    // 是否正在自动重定位
    this._lastRelocateAttempt = 0; // 上次自动重定位时间戳
    this._lastRawPos = null;     // 上次原始 WGS84 坐标，用于移动距离判断
    this._lastDistPos = null;    // 上次刷新距离的位置，用于 5m 位移节流
    this._lastFullUpdate = 0;    // 上次全量UI更新时间戳（链式节流）
    this._panelCollapsed = window.innerWidth <= CONFIG.MOBILE_BREAKPOINT; // 移动端面板默认收起
    this._watchingBeforeHide = false; // 切后台前是否在追踪
    this._restoringView = false;      // 从后台恢复时不飞地图
    this._isBackground = false;       // 是否在后台模式（pagehide 后 60s polling）
    this._bgLocateInterval = null;    // 后台轮询定位定时器
    this._nativeBgStarted = false;    // 原生后台定位插件是否已启动（@capgo/background-geolocation）
    this._lastBgNativeTime = 0;       // 上次原生后台定位时间戳（30s 节流）
    this._wakeLock = null;            // 屏幕唤醒锁引用
    this._recentFixes = [];           // 最近定位记录（最多 10 条）
    this._speedHistory = [];          // 速度历史 [{x: 秒, y: m/s}]
    this._speedChart = null;          // Chart.js 实例
    this._speedTrackingStart = 0;     // 追踪开始时间戳
    this._lastRecordedFix = null;     // 上次记录的定位
    this.trail = new Trail();         // #18 轨迹管理独立模块
    this._followMode = false;         // #12 地图跟随模式
    this._isManualPosition = false;   // #13 是否手动设置的位置
    this._manualCenter = false;       // 用户是否通过点击/输入手动设过中心点
    this._dirty = false;              // 是否有未持久化的状态变更
    this._trailDirty = false;         // 轨迹是否有未持久化的变更
    this._lastGcj02ErrorToast = 0;    // 坐标转换失败 Toast 防抖时间戳
    this._lastWeatherFetch = 0;       // 上次天气请求时间戳（节流）
    this._lastWeatherPos = null;      // 上次天气请求时的位置
    this._lastChartUpdate = 0;        // 上次速度曲线更新时间戳
    this._intervalId = null;          // 定时刷新 interval ID
    this._resizeHandler = null;       // 地图 resize 事件处理器引用
    this._visibilityHandler = null;   // visibilitychange 处理器引用
    this._pageHideHandler = null;     // pagehide 处理器引用
    this._pageShowHandler = null;     // pageshow 处理器引用
    this._lastSpeed = null;           // 上次速度（m/s）
    this._lastAltitude = null;        // 上次海拔（米）
    this._lastHeading = null;         // 上次方位角（度）
    this._batteryLevel = null;        // 电池电量（0-1）
    this._batteryCharging = false;    // 是否在充电
    this._battery = null;             // BatteryManager 引用（用于清理）
    this._batteryLevelHandler = null;        // levelchange 处理器引用
    this._batteryChargingHandler = null;     // chargingchange 处理器引用
    this._batteryTimeHandler = null;         // dischargingtimechange 处理器引用
    this._panelMediaQuery = null;     // 面板折叠响应式查询引用
    this._panelMediaqueryChange = null; // mediaquery change 处理器引用
    this._lastCalcPos = null;         // 上一个连续定位位置（用于自行计算速度）
    this._lastCalcTime = null;        // 上一个连续定位时间戳
    this._lastAccuracy = null;        // 最近一次定位精度（米），用于精度圈范围判断
    this._theme = 'dark';             // 主题：dark | light
    this._accent = 'cyan';            // 主色方案：cyan | green | blue | purple | orange
    this._trailSmoothing = true;      // 轨迹平滑开关
    this._onboardingStep = 0;         // 引导当前步骤
    this._onboardingActive = false;   // 引导是否正在显示
    this._processQueue = Promise.resolve(); // GPS 位置处理串行队列
    this._queuePending = 0;                 // GPS 位置队列积压计数

    // 多人房间
    this.roomManager = null;
    this._roomJoined = false;
    this._followedPlayerId = null; // 远程圆关注的玩家 ID
  }

  /**
   * 应用入口
   */
  init() {
    // 初始化地图
    this.mapManager.init('map', CONFIG.DEFAULT_CENTER, CONFIG.DEFAULT_ZOOM);

    // 注册中心点变化回调（含选中圆圈回调）
    this.mapManager.onCenterChange = (center, circle) => this._onCenterChanged(center, circle);

    // #13 — 长按地图：GPS 过期时设为手动位置，否则快速创建圆
    this.mapManager.onLongPress = (pos) => this._onMapLongPress(pos);
    this.mapManager.onMapClick = (pos) => this._onMapClickInRoom(pos);

    // 初始化 UI
    this._setupUI();

    // 移动端面板默认收起 + 响应横竖屏旋转（#4）
    if (this._panelCollapsed) {
      this._bottomPanel.classList.add('collapsed');
    }
    this._panelMediaQuery = window.matchMedia(`(max-width: ${CONFIG.MOBILE_BREAKPOINT}px)`);
    this._panelMediaqueryChange = (e) => {
      this._panelCollapsed = e.matches;
      this._bottomPanel.classList.toggle('collapsed', e.matches);
    };
    this._panelMediaQuery.addEventListener('change', this._panelMediaqueryChange);

    // 读取 URL 参数
    this._checkUrlParams();

    // 恢复主题偏好
    this._restoreTheme();

    // 恢复主色方案
    this._restoreAccent();

    // 恢复轨迹平滑偏好
    try {
      const pref = localStorage.getItem('circlemap_trail_smooth');
      if (pref !== null) this._trailSmoothing = pref === '1';
    } catch (e) { /* 静默 */ }

    // 从 localStorage 恢复数据
    this._loadState();

    // 初始化轨迹 UI 状态
    this._updateTrailUI();

    // 暴露到全局，方便控制台模拟轨迹
    window._app = this;

    // 天气获取
    this._weatherHtml = '';
    this._fetchWeather();

    // 电池监控
    this._initBattery();

    // 清理可能残留的原生后台定位（来自上一次进程被杀未完全清理）
    this._stopStaleBg();

    // 进入页面后自动启动持续 GPS 追踪
    this._startWatching();

    // 首次功能提示
    this._hintsTimeout = setTimeout(() => this._showHints(), 1500);

    // 页面隐藏时切换到后台定位模式（60s 一次单次定位 + wakeLock）
    this._pageHideHandler = () => {
      if (this._isWatching) {
        this._watchingBeforeHide = true;
        this._stopWatching();
        this._enterBackgroundMode();
      }
      this._updatePowerStatus();
      // 轨迹保存（无论是否有点，都保存录制状态）
      if (this.trail.positions.length > 0 || this.trail.isRecording) {
        Storage.saveTrail(this.trail);
      }
    };
    this._pageShowHandler = () => {
      if (this._isBackground) {
        this._exitBackgroundMode();
      }
      if (this._watchingBeforeHide) {
        this._watchingBeforeHide = false;
        this._restoringView = true;
        this._startWatching();
      }
      this._updatePowerStatus();
    };
    this._visibilityHandler = () => {
      if (document.hidden) {
        this._pageHideHandler();
      } else {
        this._pageShowHandler();
      }
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);
    window.addEventListener('pagehide', this._pageHideHandler);
    window.addEventListener('pageshow', this._pageShowHandler);

    // 入口淡入动画
    requestAnimationFrame(() => document.body.classList.add('app-ready'));

    // 定时刷新状态 & 持久化 & 自动重定位（每 60s）
    this._intervalId = setInterval(() => {
      if (this.myPosition) {
        this._updateStatusBar(true);
        this._updateInfo();
        this._updateCircleList();
        if (this._isPositionStale() && !this._isWatching) {
          this._autoRelocate();
        }
      }
      this._saveState();
    }, CONFIG.POSITION_STALE_MS / 10); // 每 60s

    // 自动重连上次的房间（异步，不阻塞）
    this._autoRejoinRoom();

    this._updatePowerStatus();
  }

  /* ============= UI 事件绑定 ============= */

  _setupUI() {
    // —— 缓存高频 DOM 元素 ——
    this._latInput = document.getElementById('lat');
    this._lngInput = document.getElementById('lng');
    this._radiusSlider = document.getElementById('radius-slider');
    this._radiusInput = document.getElementById('radius-input');
    this._gpsBtn = document.getElementById('gps-btn');
    this._circleCountEl = document.getElementById('circle-count');
    this._bottomPanel = document.getElementById('bottomPanel');
    this._panelHandle = document.querySelector('.panel-handle');

    // —— 模式切换 ——
    document.querySelectorAll('.mode-tab').forEach((btn) => {
      btn.addEventListener('click', () => this._setMode(btn.dataset.mode));
    });

    // —— 坐标输入 ——
    let inputTimer;
    const handleCoordInput = () => {
      clearTimeout(inputTimer);
      inputTimer = setTimeout(() => this._onCoordInput(), CONFIG.INPUT_DEBOUNCE_MS);
    };

    this._latInput.addEventListener('input', handleCoordInput);
    this._lngInput.addEventListener('input', handleCoordInput);

    // —— 智能粘贴：自动解析多种坐标格式 ——
    const handlePaste = (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      const parsed = this._parseCoordText(text);
      if (!parsed) return;
      e.preventDefault();
      this._latInput.value = parsed.lat.toFixed(6);
      this._lngInput.value = parsed.lng.toFixed(6);
      this._onCoordInput();
      Toast.show(' 已识别坐标');
    };
    this._latInput.addEventListener('paste', handlePaste);
    this._lngInput.addEventListener('paste', handlePaste);

    // —— 智能解析输入框：粘贴/输入自动读取 ——
    const parseInput = document.getElementById('parse-input');
    let parseTimer;
    parseInput.addEventListener('input', () => {
      clearTimeout(parseTimer);
      parseTimer = setTimeout(() => {
        const text = parseInput.value.trim();
        if (!text) return;
        const parsed = this._parseCoordText(text);
        if (!parsed) return;
        this._latInput.value = parsed.lat.toFixed(6);
        this._lngInput.value = parsed.lng.toFixed(6);
        this._onCoordInput();
        Toast.show(' 已识别坐标');
      }, CONFIG.PARSE_DELAY_MS);
    });
    // 回车直接解析
    parseInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(parseTimer);
        const text = parseInput.value.trim();
        if (!text) return;
        const parsed = this._parseCoordText(text);
        if (!parsed) return;
        this._latInput.value = parsed.lat.toFixed(6);
        this._lngInput.value = parsed.lng.toFixed(6);
        this._onCoordInput();
        Toast.show(' 已识别坐标');
      }
    });

    // —— 半径滑块 & 数字输入双向绑定（#11 对数映射） ——
    const sliderToVal = (sliderPos) => {
      const sMin = parseInt(this._radiusSlider.min, 10);
      const v = sliderToRadius((sliderPos - sMin) / (this._radiusSlider.max - this._radiusSlider.min));
      this._radiusInput.value = v;
      this.circleRadius = v;
      return v;
    };
    const valToSlider = (v) => {
      this._setRadiusSliderValue(v);
    };

    this._radiusSlider.addEventListener('input', () => {
      const val = sliderToVal(parseInt(this._radiusSlider.value, 10));
      const sel = this.mapManager.getSelectedCircle();
      if (sel) {
        this.mapManager.updateCircleRadius(sel.id, val);
        this._dirty = true;
        this._updateInfo();
        this._updateCircleList(true);
      }
    });
    this._radiusSlider.addEventListener('change', () => {
      const val = sliderToVal(parseInt(this._radiusSlider.value, 10));
      const sel = this.mapManager.getSelectedCircle();
      if (sel && this.roomManager && this._roomJoined) {
        this.roomManager.publishCircle('update', sel);
      }
    });

    this._radiusInput.addEventListener('change', () => {
      let val = parseInt(this._radiusInput.value, 10);
      if (isNaN(val) || val < CONFIG.MIN_RADIUS) val = CONFIG.MIN_RADIUS;
      if (val > CONFIG.MAX_RADIUS) val = CONFIG.MAX_RADIUS;
      valToSlider(val);
      const sel = this.mapManager.getSelectedCircle();
      if (sel) {
        this.mapManager.updateCircleRadius(sel.id, val);
        this._dirty = true;
        this._updateCircleList(true);
        this._updateInfo();
        if (this.roomManager && this._roomJoined) this.roomManager.publishCircle('update', sel);
      }
    });

    // —— 半径预设快捷按钮 ——
    document.querySelector('.radius-presets').addEventListener('click', (e) => {
      const btn = e.target.closest('.preset-btn');
      if (!btn) return;
      const radius = parseInt(btn.dataset.radius, 10);
      if (isNaN(radius) || radius < CONFIG.MIN_RADIUS || radius > CONFIG.MAX_RADIUS) return;
      this._setRadiusSliderValue(radius);
      const sel = this.mapManager.getSelectedCircle();
      if (sel) {
        this.mapManager.updateCircleRadius(sel.id, radius);
        this._dirty = true;
        this._updateCircleList(true);
        this._updateInfo();
        if (this.roomManager && this._roomJoined) this.roomManager.publishCircle('update', sel);
      }
    });

    // —— 选点至我的位置按钮 ——
    document.getElementById('center-to-me-btn').addEventListener('click', () => {
      if (!this.myPosition) {
        Toast.show(' 尚未定位，请先点击 GPS 按钮');
        return;
      }
      this.mapManager.setCenter(this.myPosition);
      Toast.show(' 选点中心已设为我的位置');
    });

    // —— #14 设为我当前位置按钮 ——
    document.getElementById('set-mypos-btn').addEventListener('click', () => {
      const lat = parseFloat(this._latInput.value);
      const lng = parseFloat(this._lngInput.value);
      if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        Toast.show(' 请输入有效的坐标');
        return;
      }
      this._setManualPosition({ lat, lng });
      Toast.show(' 已设为我当前位置');
    });

    // —— 绘制按钮 ——
    document.getElementById('draw-btn').addEventListener('click', () => this._drawCircle());

    // —— 清除按钮 ——
    document.getElementById('clear-btn').addEventListener('click', () => this._clearAll());

    // —— 轨迹记录按钮 ——
    document.getElementById('trail-record-btn').addEventListener('click', () => this._toggleTrailRecording());
    document.getElementById('trail-pause-btn').addEventListener('click', () => this._toggleTrailPause());
    document.getElementById('trail-clear-btn').addEventListener('click', () => this._clearTrail());
    document.getElementById('trail-stats-btn').addEventListener('click', () => this._showTrailStats());
    document.getElementById('trail-smooth-btn').addEventListener('click', () => this._toggleTrailSmoothing());
    document.getElementById('export-report-btn').addEventListener('click', () => this._exportReport());
    document.getElementById('power-saving-btn').addEventListener('click', () => this._togglePowerSaving());

    // —— 常驻记录条（非轨迹 tab） ——
    const barBtn = document.getElementById('trail-bar-btn');
    if (barBtn) barBtn.addEventListener('click', () => this._toggleTrailRecording());

    // —— 对方位置标记（复用坐标输入区） ——
    this._targetInfoEl = document.getElementById('target-info');
    this._targetClearBtn = document.getElementById('target-clear-btn');
    this._targetRange = document.getElementById('target-range');
    this._targetRangeInput = document.getElementById('target-range-input');
    this._targetRangeRow = document.getElementById('target-range-row');
    document.getElementById('target-set-btn').addEventListener('click', () => this._setTargetPosition());
    this._targetClearBtn.addEventListener('click', () => this._clearTarget());
    // 精度范围：滑块  输入框双向同步
    this._targetRange.addEventListener('input', () => {
      const v = parseInt(this._targetRange.value);
      this._targetRangeInput.value = v;
      if (this._targetPos) this.mapManager.setTargetRange(v);
    });
    this._targetRangeInput.addEventListener('input', () => {
      let v = parseInt(this._targetRangeInput.value) || 0;
      if (v < 0) v = 0;
      if (v > 5000) v = 5000;
      this._targetRange.value = v;
      if (this._targetPos) this.mapManager.setTargetRange(v);
    });

    // —— 复制选点坐标 ——
    document.getElementById('copy-mypos-btn').addEventListener('click', async () => {
      if (!this.center) {
        Toast.show(' 尚无选点，请先点击地图选点');
        return;
      }
      const text = `${this.center.lat.toFixed(6)}, ${this.center.lng.toFixed(6)}`;
      const ok = await copyText(text);
      Toast.show(ok ? ` 已复制: ${text}` : ' 复制失败');
    });

    // —— GPS 状态条缓存 + #12 点击切换跟随模式 ——
    this._statusEl = document.getElementById('gps-status');
    this._statusEl.addEventListener('click', () => this._toggleFollowMode());
    this._statusEl.style.cursor = 'pointer';

    // —— GNSS 卫星显示：始终在面板最底部的独立 bar ——
    this._gnssBarEl = document.getElementById('gnss-bar');

    // —— GPS 按钮：短按单次定位，长按切换持续追踪 ——
    let pressTimer = null;
    let isLongPress = false;
    this._gpsBtn.addEventListener('pointerdown', () => {
      isLongPress = false;
      pressTimer = setTimeout(() => {
        isLongPress = true;
        this._toggleGps();
        pressTimer = null;
      }, CONFIG.LONGPRESS_THRESHOLD_MS);
    });
    this._gpsBtn.addEventListener('pointerup', () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (!isLongPress) this._locateMe();
    });
    this._gpsBtn.addEventListener('pointerleave', () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    });

    // —— 底部面板折叠切换 ——
    this._panelHandle.addEventListener('click', () => {
      this._panelCollapsed = !this._panelCollapsed;
      this._bottomPanel.classList.toggle('collapsed', this._panelCollapsed);
    });

    // —— 主题切换按钮 ——
    document.getElementById('theme-btn').addEventListener('click', () => this._toggleTheme());

    // —— 主色选择器 ——
    document.querySelectorAll('.accent-dot').forEach(btn => {
      btn.addEventListener('click', () => this._setAccent(btn.dataset.accent));
    });

    // —— 功能提示按钮 ——
    document.getElementById('hint-next').addEventListener('click', () => this._nextHint());
    document.getElementById('hint-skip').addEventListener('click', () => this._dismissHints());
    document.getElementById('hint-close').addEventListener('click', () => this._dismissHints());

    // —— 圆列表事件委托（选中/编辑/删除/远程组折叠/关注） ——
    this._circleListEl = document.getElementById('circle-list');
    this._circleListEl.addEventListener('click', (e) => {
      const groupHeader = e.target.closest('.remote-group-header');
      if (groupHeader) {
        const author = groupHeader.dataset.author;
        if (!author) return;
        const key = 'circlemap_remote_collapsed';
        let state = {};
        try { state = JSON.parse(localStorage.getItem(key)) || {}; } catch (ex) {}
        state[author] = !state[author];
        localStorage.setItem(key, JSON.stringify(state));
        this._updateCircleList(true);
        return;
      }
      const followBtn = e.target.closest('.npc-follow-btn, .npc-follow-star');
      if (followBtn) {
        const pid = followBtn.dataset.player;
        if (!pid) return;
        if (this._followedPlayerId === pid) {
          this._followedPlayerId = null;
        } else {
          this._followedPlayerId = pid;
        }
        this._updateCircleList(true);
        return;
      }
      const item = e.target.closest('.circle-item');
      const editBtn = e.target.closest('.circle-edit');
      const delBtn = e.target.closest('.circle-del');
      if (!item) return;
      // 远程同步圆仅展示，不可本地编辑/删除/选中（其 id 是 "作者:序号" 复合键）
      if (item.dataset.remote === '1') return;
      const id = parseInt(item.dataset.id);
      if (editBtn) {
        this._editCircle(id);
      } else if (delBtn) {
        this._deleteCircle(id);
      } else {
        this._selectCircle(id);
      }
    });

    // —— 点击坐标复制 ——
    document.getElementById('info-center').addEventListener('click', async function () {
      const text = this.textContent;
      if (!text || text === '--') return;
      const ok = await copyText(text);
      if (ok) Toast.show(' 已复制坐标');
    });

    // —— 多人房间 ——
    this._roomSection = document.getElementById('room-section');
    this._roomCreateBtn = document.getElementById('room-create-btn');
    this._roomJoinBtn = document.getElementById('room-join-btn');
    this._roomLeaveBtn = document.getElementById('room-leave-btn');
    this._roomNickInput = document.getElementById('room-nick-input');
    this._roomCodeInput = document.getElementById('room-code-input');
    this._roomCodeDisplay = document.getElementById('room-code-display');
    this._roomCodeValue = document.getElementById('room-code-value');
    this._roomPlayerList = document.getElementById('room-player-list');
    this._roomFormCreate = document.getElementById('room-form-create');
    this._roomFormJoin = document.getElementById('room-form-join');
    this._roomStatus = document.getElementById('room-status-bar');
    this._roomConnDot = document.getElementById('room-conn-dot');
    this._roomPlayerCount = document.getElementById('room-player-count');
    this._roomSharingBtn = document.getElementById('room-sharing-btn');

    // 队伍
    this._roomTeamsSection = document.getElementById('room-teams-section');
    this._roomTeamCreateBtn = document.getElementById('room-team-create-btn');
    this._roomTeamCreateForm = document.getElementById('room-team-create-form');
    this._roomTeamNameInput = document.getElementById('room-team-name-input');
    this._roomTeamSelectedColor = '#4ECDC4';
    this._roomTeamPresets = document.getElementById('room-team-presets');
    this._roomTeamCreateConfirm = document.getElementById('room-team-create-confirm');
    this._roomTeamNpcCheckbox = document.getElementById('room-team-npc-checkbox');
    this._roomTeamList = document.getElementById('room-team-list');

    // 队伍预设色板：点击即选中并高亮（无原生取色框）
    if (this._roomTeamPresets) {
      this._roomTeamPresets.querySelectorAll('.room-team-preset').forEach((btn) => {
        btn.addEventListener('click', () => {
          const c = btn.dataset.color;
          if (c) this._roomTeamSelectedColor = c;
          this._updateTeamPresetActive(c);
        });
      });
      this._updateTeamPresetActive(this._roomTeamSelectedColor);
    }

    this._roomCreateBtn.addEventListener('click', () => this._roomCreate());
    this._roomJoinBtn.addEventListener('click', () => this._roomJoin());
    this._roomLeaveBtn.addEventListener('click', () => this._roomLeave());
    this._roomSharingBtn.addEventListener('click', () => this._roomToggleSharing());
    // 回车快速创建/加入
    this._roomNickInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._roomCreate();
    });
    this._roomCodeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._roomJoin();
    });

    // 队伍事件
    this._roomTeamCreateBtn.addEventListener('click', () => {
      this._roomTeamCreateForm.classList.toggle('hidden');
    });
    this._roomTeamCreateConfirm.addEventListener('click', () => this._roomCreateTeam());
    this._roomTeamNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._roomCreateTeam();
    });

    // —— 观战模式 ——
    this._roomSpectatorCheck = document.getElementById('room-spectator-check');

    // —— 统一开始 + 结束时间 ——
    this._roomTimerSection = document.getElementById('room-timer-section');
    this._roomTimerInput = document.getElementById('room-timer-input');
    this._roomTimerCountdown = document.getElementById('room-timer-countdown');
    this._roomTimerValue = document.getElementById('room-timer-value');
    this._roomScheduleSetBtn = document.getElementById('room-schedule-set-btn');
    this._roomScheduleAbortBtn = document.getElementById('room-schedule-abort-btn');

    // —— 位置共享 ——
    this._roomBurstSection = document.getElementById('room-burst-section');
    this._roomBurstSilent = document.getElementById('room-burst-silent');
    this._roomBurstShare = document.getElementById('room-burst-share');
    this._roomBurstPhase = document.getElementById('room-burst-phase');

    // —— 共享会话结束时间 ——
    this._roomBurstEndInput = document.getElementById('room-burst-end-input');
    this._roomEndCountdown = document.getElementById('room-end-countdown');
    this._roomEndValue = document.getElementById('room-end-value');

    // —— 路径预测 ——
    this._roomPredictionSection = document.getElementById('room-prediction-section');
    this._roomPredictionEnable = document.getElementById('room-prediction-enable');

    // 设定/取消（统一开始 + 结束时间共用）
    if (this._roomScheduleSetBtn) this._roomScheduleSetBtn.addEventListener('click', () => this._roomSetSchedule());
    if (this._roomScheduleAbortBtn) this._roomScheduleAbortBtn.addEventListener('click', () => this._roomAbortSchedule());
    if (this._roomTimerInput) {
      this._roomTimerInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this._roomSetSchedule();
      });
    }
    if (this._roomBurstEndInput) {
      this._roomBurstEndInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this._roomSetSchedule();
      });
    }

    // —— 路径预测切换 ——
    this._roomPredictionEnable.addEventListener('change', () => this._roomTogglePrediction());
    // 从 localStorage 恢复状态
    const saved = localStorage.getItem('circlemap_prediction');
    if (saved !== null) {
      CONFIG.ENABLE_PREDICTION = saved === '1';
      this._roomPredictionEnable.checked = CONFIG.ENABLE_PREDICTION;
    }
  }

  /**
   * 统一设置半径滑块 + 数字输入 + 当前半径
   * 替代 5 处重复的 slider/input 赋值（DRY）
   * @param {number} v 半径值（米）
   */
  _setRadiusSliderValue(v) {
    const sMin = parseInt(this._radiusSlider.min, 10);
    this._radiusSlider.value = Math.round(radiusToSlider(v) * (this._radiusSlider.max - this._radiusSlider.min)) + sMin;
    this._radiusInput.value = v;
    this.circleRadius = v;
  }

  /* ============= 核心交互方法 ============= */

/**
    * 切换选择模式
    * @param {'click'|'input'|'room'|'trail'} mode
    */
  _setMode(mode) {
    this.mode = mode;
    this.mapManager.setMode(mode);

    // 切换标签状态
    document.querySelectorAll('.mode-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    // 显示/隐藏输入区
    const inputGroup = document.getElementById('inputGroup');
    inputGroup.classList.toggle('visible', mode === 'input');

    // 显示/隐藏点击提示
    const clickHint = document.getElementById('clickHint');
    clickHint.classList.toggle('hidden', mode === 'input');

    // 显示/隐藏多人房间区
    if (this._roomSection) {
      this._roomSection.classList.toggle('visible', mode === 'room');
    }

    // 轨迹模式: 隐藏其它常规区块，轨迹面板始终显示在底部
    this._setTrailMode(mode === 'trail');
  }

  /**
   * 切换轨迹模式下的区块显隐
   * 轨迹 tab: 隐藏其它常规区块
   * 其它 tab: 显示所有区块
   * @param {boolean} visible 是否处于轨迹模式
   */
  _setTrailMode(visible) {
    if (!this._trailModeSections) {
      this._trailModeSections = [
        document.querySelector('.parse-section'),
        document.querySelector('.radius-section'),
        document.querySelector('.action-row'),
        document.querySelector('.circle-list-section'),
        document.querySelector('.fix-list-section'),
        document.getElementById('infoArea'),
      ].filter(Boolean);
    }
    for (const el of this._trailModeSections) {
      el.classList.toggle('hidden-by-mode', visible);
    }
  }

  /**
   * 中心点变更 / 圆圈选中的回调
   * @param {{lat:number,lng:number}} center
   * @param {object} [circle] - 选中的圆圈对象
   */
  _onCenterChanged(center, circle) {
    this.center = center;

    // 同步到输入框
    this._latInput.value = center.lat.toFixed(6);
    this._lngInput.value = center.lng.toFixed(6);

    if (circle) {
      // 通过点击圆心选中 → 更新半径滑块和信息面板（#11 对数映射）
      this._setRadiusSliderValue(circle.maxRadius);
    }
    this._updateInfo();
    this._updateCircleList(true);
    this._manualCenter = true; // 用户点击/选中标记 → 不再被 GPS 覆盖
    this._dirty = true;
  }

  /**
   * 智能解析粘贴文本中的经纬度
   * 支持格式：
   *   "23.1291, 113.2644"         → 逗号分隔
   *   "23.1291 113.2644"           → 空格分隔
   *   "lat 23.1291 lng 113.2644"   → 带标签
   *   "纬度:23.1291 经度:113.2644" → 中文标签
   *   "39.9°N 116.4°E"             → 度分秒简写
   *   "N 39.9 E 116.4"             → 前缀格式（#8）
   * @param {string} text
   * @returns {{lat:number,lng:number}|null}
   */
  /**
   * 度分秒 → 十进制
   * 支持: 23°7'44.76"N  23°7′44.76″N  N23°7'44.76"  23°7'44.76"
   */
  _dmsToDecimal(str) {
    if (!str || typeof str !== 'string') return null;
    str = str.trim();
    if (!str) return null;
    if (!/[°]/.test(str)) return null;

    let dir = 1;
    if (/[SsWw]/.test(str)) dir = -1;

    // 去掉方向字母和度符号，统一分秒分隔符为空格
    str = str.replace(/[NSEWnsew°]/g, '').replace(/['′]/g, ' ').replace(/["″]/g, ' ');

    const nums = str.match(/-?\d+\.?\d*/g);
    if (!nums || nums.length < 1) return null;

    const deg = parseFloat(nums[0]);
    const min = nums.length >= 2 ? parseFloat(nums[1]) : 0;
    const sec = nums.length >= 3 ? parseFloat(nums[2]) : 0;

    if (isNaN(deg)) return null;
    // 方向字母（S/W）优先于数字符号，避免 "-23° S" 双重取反
    const sign = dir < 0 ? dir : (deg < 0 ? -1 : 1);
    return sign * (Math.abs(deg) + (min || 0) / 60 + (sec || 0) / 3600);
  }

  /**
   * 解析度分秒格式坐标文本
   */
  _parseDmsText(text) {
    const parts = text.split(/[,，\s]+/).filter(Boolean);
    let lat = null, lng = null;

    for (const p of parts) {
      const dd = this._dmsToDecimal(p);
      if (dd == null) continue;
      if (/[NnSs]/.test(p)) lat = dd;
      else if (/[EeWw]/.test(p)) lng = dd;
    }

    if (lat != null && lng != null) return { lat, lng };

    // 无方向标记，取前两个 DMS 值为 lat, lng
    const dmsVals = [];
    for (const p of parts) {
      const dd = this._dmsToDecimal(p);
      if (dd != null) dmsVals.push(dd);
    }
    if (dmsVals.length >= 2) return { lat: dmsVals[0], lng: dmsVals[1] };

    return null;
  }

  _parseCoordText(text) {
    if (!text) return null;

    // 度分秒格式优先
    if (/[°]/.test(text)) return this._parseDmsText(text);

    // 提取所有数字（含负号和小数点）
    const nums = text.match(/-?\d+\.?\d*/g);
    if (!nums || nums.length < 2) return null;

    // 判断是否带 N/S/E/W 方向标识（#8 修正重复字符）
    const hasNS = /[北n]|north/i.test(text);
    const hasEW = /[东e]|east/i.test(text);

    // 根据上下文确定 lat/lng
    if (hasNS && hasEW) {
      // 方向标识模式：找到含 N/S 的作为纬度，含 E/W 的作为经度
      const parts = text.split(/[,，\s]+/).filter(Boolean);
      let lat, lng;
      for (const p of parts) {
        const n = parseFloat(p);
        if (isNaN(n)) continue;
        // 只匹配明确的 N/S/E/W 方向标记，防止字母 s 误匹配 "East" 等单词
        if (/(?:北|南|(?:^|[°\s])[nNsS](?:$|[°\s])|[nN]orth|[sS]outh)/i.test(p)) lat = n;
        if (/(?:东|西|(?:^|[°\s])[eEwW](?:$|[°\s])|[eE]ast|[wW]est)/i.test(p)) lng = n;
      }
      if (lat != null && lng != null) return { lat, lng };
    }

    // 检测中文/英文标签
    const hasLatLabel = /(纬度?|lat)/i.test(text);
    const hasLngLabel = /(经度?|lng|lon|long)/i.test(text);

    if (hasLatLabel || hasLngLabel) {
      const latMatch = text.match(/(?:纬度?|lat)\s*[:：=\s]*(-?\d+\.?\d*)/i);
      const lngMatch = text.match(/(?:经度?|lng|lon|long)\s*[:：=\s]*(-?\d+\.?\d*)/i);
      const lat = latMatch ? parseFloat(latMatch[1]) : NaN;
      const lng = lngMatch ? parseFloat(lngMatch[1]) : NaN;
      if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
    }

    // 方向前缀格式："N 39.9 E 116.4" 或 "N39.9 E116.4"（#8）
    const prefixMatch = text.match(/^[NnSs]\s*([\d.]+)\s*[EeWw]\s*([\d.]+)/);
    if (prefixMatch) {
      const lat = parseFloat(prefixMatch[1]);
      const lng = parseFloat(prefixMatch[2]);
      if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
    }

    // 默认：取前两个数字作 lat, lng
    const lat = parseFloat(nums[0]);
    const lng = parseFloat(nums[1]);
    if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };

    return null;
  }

  /**
   * 手动输入坐标 → 仅定位，不自动绘制
   */
  _onCoordInput() {
    let lat = parseFloat(this._latInput.value);
    let lng = parseFloat(this._lngInput.value);

    // 尝试度分秒解析
    if (isNaN(lat)) lat = this._dmsToDecimal(this._latInput.value);
    if (isNaN(lng)) lng = this._dmsToDecimal(this._lngInput.value);

    if (!isNaN(lat) && !isNaN(lng) &&
        lat >= -90 && lat <= 90 &&
        lng >= -180 && lng <= 180) {
      this.center = { lat, lng };
      // 转换成功后回填十进制
      this._latInput.value = lat.toFixed(6);
      this._lngInput.value = lng.toFixed(6);
      this.mapManager.setCenter(this.center);
      this._manualCenter = true; // 手动输入坐标 → 不再被 GPS 覆盖
      this._dirty = true;
    }
  }

  /**
   * #13 — 长按地图回调
   * GPS 过期/手动模式时设为当前位置；否则快速创建圆
   */
  _onMapLongPress(pos) {
    if (!pos) return;
    if (this._isPositionStale() || this._isManualPosition) {
      this._setManualPosition(pos);
      Toast.show(' 已设为当前位置（手动）');
    } else {
      // 直接以当前半径创建圆
      if (!this.center) {
        this.center = pos;
        this.mapManager.setCenter(pos);
      }
      this._drawCircle();
    }
  }

  /**
   * 多人模式下点击地图：仅选点（设圆心），不设为我的 GPS 位置
   */
  _onMapClickInRoom(pos) {
    if (!pos) return;
    // 恢复「点击选点」：把点击点设为圆心（不画圆；画圆只走「绘制圆形」按钮或长按地图）
    this.center = pos;
    // map.js 的 click handler 已先调 setCenter，此处不重复
  }

  /**
   * #13 — 手动设置"我的位置"
   * @param {{lat:number,lng:number}} pos
   */
  _setManualPosition(pos) {
    this.myPosition = pos;
    this.myPositionTime = Date.now();
    this._isManualPosition = true;
    this._prevDistances = {};
    this._lastSpeed = null;
    this._lastAltitude = null;
    this._lastHeading = null;
    this._lastCalcPos = null;
    this._lastCalcTime = null;
    this._lastAccuracy = 50;
    this.mapManager.setMyPos(pos);
    this.mapManager.setLocation(pos, 50); // 手动定位默认精度 50m
    this._recordFix({ ...pos, accuracy: 50 }, pos, true); // 手动定位加入最近列表
    this._updateStatusBar(true);
    this._updateCircleList(true);
    this._updateInfo();
    this._dirty = true;
    this._saveState();
    // 手动定位也刷新天气
    this._fetchWeather();
  }

  /**
   * 添加一个同心圆
   */
  _drawCircle() {
    if (!this.center) {
      Toast.show('请先选择中心点（点击地图或输入坐标）');
      return;
    }
    // 直接从输入框读取半径值（绕过 change 事件不触发问题）
    const inputVal = parseInt(this._radiusInput.value, 10);
    const radius = (!isNaN(inputVal) && inputVal >= CONFIG.MIN_RADIUS && inputVal <= CONFIG.MAX_RADIUS)
      ? inputVal
      : this.circleRadius;
    this.circleRadius = radius;

    if (this.circleRadius <= 0) {
      Toast.show('请输入有效的半径');
      return;
    }

    const color = '#FF6B6B';
    const newCircleId = this.mapManager.addCircle(this.center, this.circleRadius, color);
    this._updateInfo();
    this._updateCircleList(true);
    this._updateStatusBar(true);
    this._dirty = true;
    this._saveState();
    if (this.roomManager && this._roomJoined) {
      const c = this.mapManager.circles.find(x => x.id === newCircleId);
      if (c) this.roomManager.publishCircle('add', c);
    }
    Toast.show(`已创建同心圆，半径 ${
      this.circleRadius >= 1000
        ? (this.circleRadius / 1000).toFixed(1) + ' km'
        : this.circleRadius + ' m'
    }`);
  }

  /**
   * 切换持续追踪（长按 GPS 按钮）
   */
  _toggleGps() {
    if (this._isWatching) {
      this._stopWatching();
    } else {
      this._startWatching();
    }
  }

  /**
   * 单次定位（短按 GPS 按钮）
   * 获取一次位置并飞到该处，不开启持续追踪
   */
  async _locateMe() {
    if (this._isWatching) return;
    if (this._relocating) return;
    this._relocating = true;

    this._gpsBtn.classList.add('loading');
    this._gpsBtn.disabled = true;

    try {
      const pos = await this.gpsManager.getCurrentPosition();
      const convPos = await this.mapManager.wgs84ToGcj02(pos);

      this.center = convPos;
      this.myPosition = convPos;
      this.myPositionTime = Date.now();
      this.mapManager.setMyPos(convPos);
      this._isManualPosition = false; // #13 GPS 定位覆盖手动
      this._lastSpeed = pos.speed;
      this._lastAltitude = pos.altitude;
      this._lastHeading = pos.heading;
      this._lastCalcPos = { lat: convPos.lat, lng: convPos.lng };
      this._lastCalcTime = pos.timestamp || Date.now();
      this._lastAccuracy = pos.accuracy;
      this._recordFix(pos, convPos);

      this.mapManager.setCenter(convPos);
      this.mapManager.setLocation(convPos, pos.accuracy, pos.heading); // #17 精度环
      this.mapManager.flyTo(convPos);

      this._latInput.value = convPos.lat.toFixed(6);
      this._lngInput.value = convPos.lng.toFixed(6);

      this._updateStatusBar(true);
      this._updateCircleList(true);
      this._updateInfo();

      this._gpsBtn.classList.add('located');
      setTimeout(() => this._gpsBtn.classList.remove('located'), CONFIG.LOCATED_ANIM_MS);

      Toast.show(` 定位成功（精度 ±${pos.accuracy.toFixed(0)} 米）`);

      // 权限已确认，激活 GNSS 卫星监听
      this.gpsManager.startGnss().then(() => {
        if (this.gpsManager.isGnssActive) {
          Toast.show(` GNSS 卫星数据已激活`);
        }
      }).catch(err => console.error('[GNSS] unexpected error:', err));
    } catch (err) {
      Toast.show(' ' + err.message);
      this._gpsBtn.classList.remove('located');
    } finally {
      this._gpsBtn.classList.remove('loading');
      this._gpsBtn.disabled = false;
      this._relocating = false;
    }
  }

  /**
   * 启动持续 GPS 追踪（纯 watchPosition）
   */
  _startWatching() {
    if (this._isWatching || this._isBackground) return;

    this._isWatching = true;
    this._firstFix = true;
    // 仅在全新启动时重置手动中心，后台恢复时保留用户设置
    if (!this._restoringView) {
      this._manualCenter = false;
    }
    this._restoringView = false;
    if (!this._speedHistory.length) this._speedTrackingStart = Date.now();
    this._showSpeedChart();

    this._gpsBtn.classList.add('watching');
    this._gpsBtn.title = '正在持续追踪位置';

    this.gpsManager.onPositionChange = (pos) => {
      // 速度数据采集
      if (this._isWatching && pos.speed != null) {
        const elapsed = (Date.now() - this._speedTrackingStart) / 1000;
        this._speedHistory.push({ x: Math.round(elapsed * 10) / 10, y: pos.speed });
        if (this._speedHistory.length > 2500) this._speedHistory.shift();
        this._updateSpeedChart();
      }
      this._updatePowerStatus();
      if (!this._queuePending) this._queuePending = 0;
      if (this._queuePending >= 3) return;
      this._queuePending++;
      this._processQueue = this._processQueue
        .then(() => {
          return this._processPosition(pos);
        })
        .catch(() => { /* 静默 */ })
        .finally(() => { if (this._queuePending > 0) this._queuePending--; });
    };
    this.gpsManager.onError = (err) => {
      if (CONFIG.DEBUG) console.warn('[GPS] 追踪出错:', err.message);
      Toast.show(' ' + err.message);
    };
    this.gpsManager.onDowngrade = (count) => {
      Toast.show(` 已切换低精度定位`);
      this._updateStatusBar(true);
    };
    this.gpsManager.onRecovery = (success) => {
      if (success) {
        Toast.show(' GPS 信号恢复，已切换高精度定位');
      } else {
        Toast.show(' GPS 信号仍未恢复，继续使用低精度定位');
      }
      this._updateStatusBar(true);
    };
    this.gpsManager.onRestoreTracking = () => {
      Toast.show(' 电量恢复，已自动恢复追踪');
      this._startWatching();
    };
    this.gpsManager.startWatching();

    Toast.show(' 持续追踪已开启');
  }

  /**
   * 停止持续 GPS 追踪
   */
  _stopWatching() {
    if (!this._isWatching) return;
    this._isWatching = false;

    this.gpsManager.stopWatching();
    // 清空回调钩子：停止后迟到的位置/错误/降级/恢复回调不得再触发 UI（_processPosition 等）
    this.gpsManager.onPositionChange = null;
    this.gpsManager.onError = null;
    this.gpsManager.onDowngrade = null;
    this.gpsManager.onRecovery = null;
    this.gpsManager.onRestoreTracking = null;
    this._prevDistances = {};
    this._hideSpeedChart();

    // 清理速度曲线数据，避免重启追踪时显示旧数据
    this._speedHistory = [];
    if (this._speedChart) {
      this._speedChart.data.datasets[0].data = [];
      this._speedChart.update('none');
    }

    this._gpsBtn.classList.remove('watching');
    this._gpsBtn.title = '定位到我的位置';

    Toast.show(' 持续追踪已关闭');
  }

  /* ── 后台定位（pagehide → 60s polling + wakeLock） ── */

  /**
   * 清理可能残留的原生后台定位服务
   * 用于 app 启动时：如果上次划掉任务后服务未完全清理，在此停止
   */
  async _stopStaleBg() {
    if (!this._hasNativeBgPlugin()) return;
    try {
      await Capacitor.Plugins.BackgroundGeolocation.stop();
    } catch (e) {
      // 静默：没有活跃的 watcher 时 stop() 会抛错，忽略
    }
  }

  /**
   * 检查 Capacitor 原生后台定位插件是否可用
   */
  _hasNativeBgPlugin() {
    return typeof Capacitor !== 'undefined'
      && Capacitor.isNativePlatform()
      && Capacitor.Plugins
      && Capacitor.Plugins.BackgroundGeolocation;
  }

  /**
   * 启动 @capgo/background-geolocation 原生后台定位
   * 插件在 native 层独立运行，不依赖 WebView JS 存活
   */
  async _startNativeBackgroundTracking() {
    try {
      const plugin = Capacitor.Plugins.BackgroundGeolocation;
      if (CONFIG.DEBUG) console.log('[Background] 启动原生后台定位插件');
      await plugin.start({
        backgroundMessage: '正在后台追踪位置，关闭以省电',
        backgroundTitle: 'Circlemap 定位中',
        distanceFilter: 10,
        requestPermissions: true,
        stale: false,
      }, (location, error) => {
        if (error) {
          if (CONFIG.DEBUG) console.log('[Background] 原生定位错误:', error.code, error.message);
          return;
        }
        if (!location) return;
        // 30s 最小间隔节流（替代原生插件的 distanceFilter 方案）
        const now = Date.now();
        if (now - this._lastBgNativeTime < 30000) return;
        this._lastBgNativeTime = now;
        // 将插件 Location 转为 app 内部的 {lat, lng, ...} 格式
        this._processBackgroundPosition({
          lat: location.latitude,
          lng: location.longitude,
          accuracy: location.accuracy,
          speed: location.speed,
          heading: location.bearing,
          altitude: location.altitude,
          timestamp: location.time,
        });
      });
      this._nativeBgStarted = true;
      // 通知栏显示插件自己的通知（无需额外处理）
    } catch (e) {
      if (CONFIG.DEBUG) console.log('[Background] 原生定位插件启动失败:', e.message);
      this._nativeBgStarted = false;
      // 降级到 JS 60s 轮询
      this._fallbackBackgroundLocate();
    }
  }

  /**
   * 停止 @capgo/background-geolocation 原生后台定位
   */
  async _stopNativeBackgroundTracking() {
    try {
      const plugin = Capacitor.Plugins.BackgroundGeolocation;
      await plugin.stop();
      if (CONFIG.DEBUG) console.log('[Background] 原生后台定位已停止');
    } catch (e) {
      // 静默
    }
    this._nativeBgStarted = false;
  }

  /**
   * 进入后台定位模式
   *
   * 优先使用原生后台定位插件（Android），
   * 降级到 JS 轮询（后台 15s，后台+省电 60s）
   */
  _enterBackgroundMode() {
    if (this._isBackground) return;
    this._isBackground = true;
    if (CONFIG.DEBUG) console.log('[Background] 进入后台定位模式');

    // 通知 RoomManager 降低心跳频率、暂停 position 定时器
    if (this.roomManager && this.roomManager.isConnected()) {
      this.roomManager.setBackgroundMode(true);
    }

    // 省电模式下不尝试 wakeLock（避免无谓唤醒）
    if (!this.gpsManager.isPowerSaving) {
      this._requestWakeLock();
    }

    // 优先使用原生后台定位插件（独立于 WebView 存活）
    if (this._hasNativeBgPlugin()) {
      this._startNativeBackgroundTracking();
    } else {
      this._fallbackBackgroundLocate();
    }
  }

  /**
   * 降级方案：JS 轮询（后台 15s，后台+省电 60s）
   */
  _fallbackBackgroundLocate() {
    const interval = this.gpsManager.isPowerSaving ? 60000 : 15000;
    this._backgroundLocate();
    if (this._bgLocateInterval) clearInterval(this._bgLocateInterval);
    this._bgLocateInterval = setInterval(() => {
      this._backgroundLocate();
    }, interval);
  }

  /**
   * 退出后台定位模式，清理资源
   */
  _exitBackgroundMode() {
    this._isBackground = false;

    // 通知 RoomManager 恢复心跳频率
    if (this.roomManager && this.roomManager.isConnected()) {
      this.roomManager.setBackgroundMode(false);
    }

    // 停止原生后台定位（如果已启动）
    if (this._nativeBgStarted) {
      this._stopNativeBackgroundTracking();
    }

    // 停止 JS 轮询
    if (this._bgLocateInterval) {
      clearInterval(this._bgLocateInterval);
      this._bgLocateInterval = null;
    }

    this._releaseWakeLock();
    if (CONFIG.DEBUG) console.log('[Background] 退出后台定位模式');
  }

  /**
   * 后台单次定位（静默更新位置，toast/flyTo 全部跳过）
   */
  async _backgroundLocate() {
    if (this.gpsManager.isPowerSaving && this._batteryLevel != null && this._batteryLevel < 0.1) {
      // 极低电量时连后台定位也跳过
      return;
    }
    try {
      // 后台用较长超时（低精度由 gpsManager 自行控制）
      const pos = await this.gpsManager.getCurrentPosition(30000);
      await this._processBackgroundPosition(pos);
    } catch (e) {
      // 后台定位失败 → 静默，等下一轮
    }
  }

  /**
   * 后台位置处理（静默版 _processPosition，无 UI 刷新）
   */
  async _processBackgroundPosition(pos) {
    if (!this._isBackground) return;
    try {
      const convPos = await this.mapManager.wgs84ToGcj02(pos);
      // 异步转换后重新检查，防止用户已回到前台
      if (!this._isBackground) return;
      this.myPosition = convPos;
      this.myPositionTime = Date.now();
      this._lastAccuracy = pos.accuracy;
      this._lastSpeed = pos.speed;
      this._lastAltitude = pos.altitude;
      this._lastHeading = pos.heading;
      this._lastCalcPos = { lat: convPos.lat, lng: convPos.lng };
      this._lastCalcTime = pos.timestamp || Date.now();
      this.mapManager.setMyPos(convPos);
      this._isManualPosition = false;
      this.mapManager.setLocation(convPos, pos.accuracy, pos.heading);

      // 记录最近定位（标记为后台定位）
      this._recordFix(pos, convPos, false, true);
      this._prevDistances = {};

      // 如果正在记录轨迹且轨迹未正在加载，加入轨迹点
      if (this.trail.isRecording && !this.trail.isPaused && !this._trailLoading) {
        const added = this.trail.addPoint({
          lat: convPos.lat,
          lng: convPos.lng,
          time: pos.timestamp || Date.now(),
          accuracy: pos.accuracy || 0,
          speed: pos.speed,
          heading: pos.heading
        });
        if (added) {
          this._trailDirty = true;
          this.mapManager.setTrail(this._getTrailPositions());
        }
      }

      // 后台不更新 UI，但保存状态
      this._saveState();

      // 后台定位回调触发 MQTT 发布（原生线程回调不受 WebView 节流）
      if (this.roomManager && this.roomManager.isConnected()) {
        this.roomManager.publishFromBackground(
          convPos.lat, convPos.lng,
          pos.accuracy || 0,
          this._lastSpeed || 0,
          pos.heading || 0
        );
      }
    } catch (e) {
      if (CONFIG.DEBUG) console.error('[Background] _processBackgroundPosition error:', e.message);
    }
  }

  /**
   * 请求屏幕唤醒锁（阻止后台定位时设备休眠）
   */
  async _requestWakeLock() {
    if (typeof navigator.wakeLock === 'undefined') return;
    if (this._wakeLock) return; // 已有锁
    try {
      this._wakeLock = await navigator.wakeLock.request('screen');
      this._wakeLock.addEventListener('release', () => {
        this._wakeLock = null;
      });
      if (CONFIG.DEBUG) console.log('[WakeLock] 已获取唤醒锁');
    } catch (e) {
      // wakeLock 被拒绝（如省电模式中）
      this._wakeLock = null;
      if (CONFIG.DEBUG) console.log('[WakeLock] 获取失败:', e.message);
    }
  }

  /**
   * 释放屏幕唤醒锁
   */
  _releaseWakeLock() {
    if (!this._wakeLock) return;
    try {
      this._wakeLock.release();
    } catch (e) {
      // 静默
    }
    this._wakeLock = null;
    if (CONFIG.DEBUG) console.log('[WakeLock] 已释放唤醒锁');
  }

  /**
   * 获取渲染用的轨迹坐标数组（根据平滑开关决定是否平滑）
   * @returns {Array}
   */
  _getTrailPositions() {
    return this._trailSmoothing
      ? this.trail.getSmoothedPositions()
      : this.trail.positions;
  }

  /**
   * 清除历史轨迹
   */
  _clearTrail() {
    const savedPositions = this.trail.positions.slice();
    const savedLastPos = this.trail.lastPos;
    const savedRecording = this.trail.isRecording;
    const savedPaused = this.trail.isPaused;

    this.trail.clear();
    this.mapManager.clearTrail();
    this._updateTrailUI();
    this._trailDirty = true;
    Storage.clearTrail(); // 清除 IndexedDB 持久化

    Toast.showUndo('轨迹已清除', () => {
      this.trail.restore(savedPositions, savedLastPos);
      this.trail.isRecording = savedRecording;
      this.trail.isPaused = savedPaused;
      if (savedPositions.length >= 2) {
        this.mapManager.setTrail(this._getTrailPositions());
      }
      this._updateTrailUI();
      this._trailDirty = false;
      Storage.saveTrail(this.trail);
    });
  }

  /**
   * 切换轨迹记录状态
   */
_toggleTrailRecording() {
    if (this.trail.isRecording) {
      const pointCount = this.trail.positions.length;
      this.trail.stop();
      this._trailDirty = true;
      if (pointCount === 0) {
        Storage.clearTrail(); // 空轨迹 → 清除旧数据
      } else {
        Storage.saveTrail(this.trail); // 停止时保存最终轨迹
      }
      Toast.show(pointCount === 0 ? ' 未记录到轨迹数据' : ' 轨迹记录已停止');
    } else {
       this.trail.start();
       this.mapManager.clearTrail();
       Toast.show(' 轨迹记录已开始');
       this._setMode('trail');
     }
     this._updateTrailUI();
   }

  /**
   * 切换轨迹暂停/继续状态
   */
  _toggleTrailPause() {
    if (!this.trail.isRecording) return;
    if (this.trail.isPaused) {
      this.trail.resume();
      this._trailDirty = true;
      Toast.show(' 轨迹记录已继续');
    } else {
      this.trail.pause();
      Toast.show(' 轨迹记录已暂停');
    }
    this._updateTrailUI();
  }

  /**
   * 切换轨迹平滑开关
   */
  _toggleTrailSmoothing() {
    this._trailSmoothing = !this._trailSmoothing;
    // 保存偏好
    try {
      localStorage.setItem('circlemap_trail_smooth', this._trailSmoothing ? '1' : '0');
    } catch (e) { /* 静默 */ }
    // 刷新轨迹渲染
    if (this.trail.positions.length >= 2) {
      this.mapManager.setTrail(this._getTrailPositions());
    }
    this._updateTrailUI();
    Toast.show(this._trailSmoothing ? ' 轨迹平滑已开启' : ' 轨迹平滑已关闭');
  }

  /**
   * 切换省电模式
   */
  _togglePowerSaving() {
    if (this.gpsManager.isPowerSavingLocked) {
      Toast.show('电量不足，省电模式已锁定，充电后自动解锁');
      return;
    }
    const next = this.gpsManager.togglePowerSaving();
    const btn = document.getElementById('power-saving-btn');
    if (btn) {
      btn.classList.toggle('active', next);
    }
    this._updatePowerStatus();
    Toast.show(next ? '省电模式已开启' : '省电模式已关闭');
  }

  _updatePowerStatus() {
    const el = document.getElementById('power-status');
    if (!el) return;
    const actual = this.gpsManager.lastActualInterval;
    if (this.gpsManager.isWatching && actual > 0) {
      el.textContent = `定位间隔: ${(actual / 1000).toFixed(1)}s`;
    } else {
      el.textContent = '定位间隔: --';
    }
  }

  /**
   * 显示轨迹统计面板
   */
  _showTrailStats() {
    const pos = this.trail.positions;
    if (pos.length < 2) {
      Toast.show(' 轨迹点数不足（至少 2 个点）');
      return;
    }

    const totalDist = this.trail.getDistance();

    // 总时长（用首尾点的时间戳）
    const firstTime = pos[0].time || null;
    const lastTime = pos[pos.length - 1].time || null;
    let durationMs = 0;
    if (firstTime && lastTime && lastTime > firstTime) {
      durationMs = lastTime - firstTime;
    }

    // 最高速度
    let maxSpeed = 0;
    let hasSpeed = false;
    for (const p of pos) {
      if (p.speed != null && p.speed > maxSpeed) {
        maxSpeed = p.speed;
        hasSpeed = true;
      }
    }

    // 平均速度（总距离 / 总时长）
    const avgSpeed = durationMs > 0 ? totalDist / (durationMs / 1000) : 0;

    // 格式化时间
    const fmtTime = (ts) => {
      if (!ts) return '--';
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    const fmtDate = (ts) => {
      if (!ts) return '--';
      const d = new Date(ts);
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const datePart = (d.getMonth() + 1) + '/' + d.getDate();
      return datePart + ' ' + fmtTime(ts);
    };

    // 格式化时长（秒 → HH:MM:SS）
    const fmtDuration = (ms) => {
      if (ms <= 0) return '--';
      const totalSec = Math.round(ms / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      if (m > 0) return `${m}:${String(s).padStart(2, '0')}`;
      return `${s}秒`;
    };

    // 速度分布直方图数据（与图例 7 档完全一致，单位 km/h，bins 用 m/s 阈值）
    const bins = [0, 2.78, 5.56, 16.67, 33.33, 55.56, 97.22, Infinity];
    const labels = ['0-10', '10-20', '20-60', '60-120', '120-200', '200-350', '>350'];
    const counts = new Array(bins.length - 1).fill(0);
    let hasSpeedData = false;
    for (const p of pos) {
      if (p.speed == null) continue;
      hasSpeedData = true;
      for (let i = 0; i < bins.length - 1; i++) {
        if (p.speed >= bins[i] && p.speed < bins[i + 1]) {
          counts[i]++;
          break;
        }
      }
    }

    // 填充或创建 modal
    const overlay = document.getElementById('stats-modal');
    if (overlay) {
      document.getElementById('stat-distance').textContent = formatDistance(totalDist);
      document.getElementById('stat-duration').textContent = fmtDuration(durationMs);
      document.getElementById('stat-avg-speed').textContent = avgSpeed > 0
        ? (avgSpeed * 3.6).toFixed(1) + ' km/h'
        : (hasSpeed ? '--' : '--');
      document.getElementById('stat-max-speed').textContent = hasSpeed
        ? (maxSpeed * 3.6).toFixed(1) + ' km/h'
        : '--';
      document.getElementById('stat-points').textContent = pos.length;
      document.getElementById('stat-start-time').textContent = fmtDate(firstTime);
      document.getElementById('stat-end-time').textContent = fmtDate(lastTime);
      this._updateHistogram(counts, labels, hasSpeedData);
      overlay.classList.add('show');
      return;
    }

    // 首次创建 modal
    const html = `<div id="stats-modal" class="modal-overlay show">
      <div class="modal-box">
        <div class="modal-header">
          <span class="modal-title"> 轨迹统计</span>
          <button class="modal-close" id="stats-close-btn">✕</button>
        </div>
        <div class="stat-grid">
          <div class="stat-card"><span class="stat-label">总距离</span><span class="stat-value" id="stat-distance">${formatDistance(totalDist)}</span></div>
          <div class="stat-card"><span class="stat-label">总时长</span><span class="stat-value" id="stat-duration">${fmtDuration(durationMs)}</span></div>
          <div class="stat-card"><span class="stat-label">平均速度</span><span class="stat-value" id="stat-avg-speed">${avgSpeed > 0 ? (avgSpeed * 3.6).toFixed(1) + ' km/h' : '--'}</span></div>
          <div class="stat-card"><span class="stat-label">最高速度</span><span class="stat-value warning" id="stat-max-speed">${hasSpeed ? (maxSpeed * 3.6).toFixed(1) + ' km/h' : '--'}</span></div>
          <div class="stat-card"><span class="stat-label">轨迹点数</span><span class="stat-value accent2" id="stat-points">${pos.length}</span></div>
          <div class="stat-card"><span class="stat-label">开始时间</span><span class="stat-value" id="stat-start-time">${fmtDate(firstTime)}</span></div>
          <div class="stat-card full"><span class="stat-label">结束时间</span><span class="stat-value" id="stat-end-time">${fmtDate(lastTime)}</span></div>
        </div>
        ${hasSpeedData ? `<div class="histogram-section">
          <div class="histogram-header"><span class="histogram-title">速度分布</span></div>
          <div class="histogram-body"><canvas id="histogram-canvas" height="160"></canvas></div>
        </div>` : ''}
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);

    // 点击 overlay 外部区域关闭
    const mo = document.getElementById('stats-modal');
    const box = mo.querySelector('.modal-box');
    const closeModal = () => {
      mo.classList.remove('show');
      this._destroyHistogram();
      setTimeout(() => mo.remove(), 300);
    };
    mo.addEventListener('click', (e) => {
      if (!box.contains(e.target)) closeModal();
    });
    document.getElementById('stats-close-btn').addEventListener('click', closeModal);

    if (hasSpeedData) this._updateHistogram(counts, labels);
  }

  _updateHistogram(counts, labels) {
    if (this._histogramChart) this._histogramChart.destroy();
    const canvas = document.getElementById('histogram-canvas');
    if (!canvas) return;
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    this._histogramChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: counts,
          backgroundColor: isDark
            ? ['rgba(0,229,204,0.70)', 'rgba(255,215,0,0.75)', 'rgba(255,140,0,0.80)', 'rgba(255,94,51,0.82)', 'rgba(255,51,102,0.85)', 'rgba(191,64,255,0.90)', 'rgba(94,92,230,0.92)']
            : ['rgba(52,199,89,0.65)', 'rgba(255,149,0,0.70)', 'rgba(255,59,48,0.75)', 'rgba(255,45,85,0.78)', 'rgba(175,82,222,0.80)', 'rgba(88,86,214,0.85)', 'rgba(0,122,255,0.88)'],
          borderColor: isDark
            ? ['#00E5CC', '#FFD700', '#FF8C00', '#FF5E33', '#FF3366', '#BF40FF', '#5E5CE6']
            : ['#34C759', '#FF9500', '#FF3B30', '#FF2D55', '#AF52DE', '#5856D6', '#007AFF'],
          borderWidth: 1,
          borderRadius: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: {
            title: { display: true, text: '速度 (km/h)', color: isDark ? '#aaa' : '#666', font: { size: 10 } },
            ticks: { color: isDark ? '#888' : '#999', font: { size: 9 } },
            grid: { display: false }
          },
          y: {
            beginAtZero: true,
            title: { display: true, text: '点数', color: isDark ? '#aaa' : '#666', font: { size: 10 } },
            ticks: { color: isDark ? '#888' : '#999', font: { size: 9 }, precision: 0 },
            grid: { color: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)' }
          }
        }
      }
    });
  }

  _destroyHistogram() {
    if (this._histogramChart) {
      this._histogramChart.destroy();
      this._histogramChart = null;
    }
  }

  /**
   * 导出活动报告（单张 PNG 图片）
   * 合成：地图画布（轨迹 + 同心圆） + 速度曲线 + 统计数据
   */
  async _exportReport() {
    const pos = this.trail.positions;
    if (pos.length < 2) {
      Toast.show(' 轨迹点数不足（至少 2 个点）');
      return;
    }

    Toast.show(' 正在生成报告...');

    try {
      const totalDist = this.trail.getDistance();
      const firstTime = pos[0].time || null;
      const lastTime = pos[pos.length - 1].time || null;
      let durationMs = 0;
      if (firstTime && lastTime && lastTime > firstTime) durationMs = lastTime - firstTime;

      let maxSpeed = 0;
      let hasSpeed = false;
      for (const p of pos) {
        if (p.speed != null && p.speed > maxSpeed) {
          maxSpeed = p.speed;
          hasSpeed = true;
        }
      }
      const avgSpeed = durationMs > 0 ? totalDist / (durationMs / 1000) : 0;

      const fmtDate = (ts) => {
        if (!ts) return '--';
        const d = new Date(ts);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      };
      const fmtDuration = (ms) => {
        if (ms <= 0) return '--';
        const s = Math.round(ms / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
      };
      const isDark = this._theme === 'dark';

      // ── 计算画布尺寸 ──
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = 800 * dpr;
      const H = 1100 * dpr;
      const S = dpr; // scale factor for text

      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');

      // ── 底色 ──
      ctx.fillStyle = isDark ? '#1a1a2e' : '#f0f0f5';
      ctx.fillRect(0, 0, W, H);

      // ── 标题栏 ──
      ctx.fillStyle = isDark ? '#16213e' : '#ffffff';
      ctx.fillRect(0, 0, W, 80 * S);
      ctx.fillStyle = isDark ? '#00d4aa' : '#0ea5e9';
      ctx.font = `${24 * S}px "HarmonyOS Sans", sans-serif`;
      ctx.fillText(' 活动报告', 24 * S, 44 * S);
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)';
      ctx.font = `${13 * S}px "HarmonyOS Sans", sans-serif`;
      ctx.fillText(new Date().toLocaleString('zh-CN'), 24 * S, 66 * S);

      // ── 绘制轨迹图预览（用 trail 数据渲染迷你地图） ──
      const mapY = 96 * S;
      const mapH = 320 * S;
      const mapW = W - 48 * S;
      const mapX = 24 * S;

      // 地图背景（无圆角，瓦片完整铺满）
      ctx.fillStyle = isDark ? '#0f3460' : '#dce5f0';
      ctx.fillRect(mapX, mapY, mapW, mapH);

      // 计算 trail 边界
      let minLat = Infinity, maxLat = -Infinity;
      let minLng = Infinity, maxLng = -Infinity;
      for (const p of pos) {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lng < minLng) minLng = p.lng;
        if (p.lng > maxLng) maxLng = p.lng;
      }
      const rawLatSpan = maxLat - minLat || 0.001;
      const rawLngSpan = maxLng - minLng || 0.001;
      const padR = Math.max(0.001, Math.max(rawLatSpan, rawLngSpan) * 0.5); // 动态外扩：至少100m，最大50%余量
      minLat -= padR; maxLat += padR;
      minLng -= padR; maxLng += padR;
      const lngSpan = maxLng - minLng || 0.001;
      const latSpan = maxLat - minLat || 0.001;
      const margin = 20 * S;
      const drawW = mapW - margin * 2;
      const drawH = mapH - margin * 2;

      // 纵横比校正：补偿经度在非赤道处的压缩
      const midLat = (minLat + maxLat) / 2;
      const cosLat = Math.cos(midLat * Math.PI / 180);
      const dataW = lngSpan * cosLat;          // 经度跨度"折合"为纬度等效度数
      const dataH = latSpan;
      const scale = Math.min(drawW / dataW, drawH / dataH);
      const usedW = dataW * scale;
      const usedH = dataH * scale;
      const originX = mapX + margin + (drawW - usedW) / 2;
      const originY = mapY + margin + (drawH - usedH) / 2;

      const toX = (lng) => originX + (lng - minLng) * cosLat * scale;
      const toY = (lat) => originY + (maxLat - lat) * scale; // lat flipped

      // ── 地图底图：高德瓦片（普通道路图 style=8，GCJ-02 与腾讯同坐标系） ──
      // Web Mercator 投影（0~1 世界坐标）
      const mercX = (lng) => (lng + 180) / 360;
      const mercY = (lat) => {
        const r = lat * Math.PI / 180;
        return (1 - Math.log(Math.tan(Math.PI / 4 + r / 2)) / Math.PI) / 2;
      };
      const invMercY = (v) => Math.atan(Math.sinh(Math.PI * (1 - 2 * v))) * 180 / Math.PI;
      // 地图区四角经纬度（用于瓦片范围计算，确保瓦片覆盖整个地图区）
      const mapLeftLng = (mapX - originX) / (cosLat * scale) + minLng;
      const mapRightLng = (mapX + mapW - originX) / (cosLat * scale) + minLng;
      const mapTopLat = maxLat - (mapY - originY) / scale;
      const mapBotLat = maxLat - (mapY + mapH - originY) / scale;
      // 瓦片层级：按目标每像素米数反算（cos 纬度修正），clamp 3~18
      const targetMpp = 111320 / scale;
      let z = Math.round(Math.log2(156543.03392 * Math.cos(midLat * Math.PI / 180) / targetMpp));
      z = Math.min(18, Math.max(3, z));
      // 瓦片数量上限 24：超出则降档
      let tileRange = null;
      for (; z >= 3; z--) {
        const x0 = Math.floor(mercX(mapLeftLng) * (1 << z));
        const x1 = Math.floor(mercX(mapRightLng) * (1 << z));
        const y0 = Math.floor(mercY(mapTopLat) * (1 << z));
        const y1 = Math.floor(mercY(mapBotLat) * (1 << z));
        tileRange = { x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
        if (tileRange.count <= 36) break;
      }
      // 异步加载全部瓦片：任一张失败 → 降级纯色底图（不阻塞导出）
      let tileImages = [];
      if (tileRange) {
        const results = await Promise.allSettled(
          (() => {
            const jobs = [];
            for (let tx = tileRange.x0; tx <= tileRange.x1; tx++) {
              for (let ty = tileRange.y0; ty <= tileRange.y1; ty++) {
                jobs.push(this._loadMapTile(z, tx, ty));
              }
            }
            return jobs;
          })()
        );
        if (results.every(r => r.status === 'fulfilled')) {
          tileImages = results.map(r => r.value);
        } else if (CONFIG.DEBUG) {
          console.log('[Report] 瓦片加载失败，降级纯色背景');
        }
      }
      if (tileRange && tileImages.length === tileRange.count) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(mapX, mapY, mapW, mapH);
        ctx.clip();
        const tileWpx = (360 / (1 << z)) * cosLat * scale;
        let i = 0;
        for (let tx = tileRange.x0; tx <= tileRange.x1; tx++) {
          for (let ty = tileRange.y0; ty <= tileRange.y1; ty++) {
            const tileLng = tx / (1 << z) * 360 - 180;
            const latTop = invMercY(ty / (1 << z));
            const latBot = invMercY((ty + 1) / (1 << z));
            const px = toX(tileLng);
            const py = toY(latTop);
            const ph = toY(latBot) - toY(latTop);
            ctx.drawImage(tileImages[i++], px - 0.5, py - 0.5, tileWpx + 1, ph + 1);
          }
        }
        ctx.restore();
      } else {
        // 降级：纯色底图（主题色跟随）
        ctx.fillStyle = isDark ? '#0f3460' : '#dce5f0';
        ctx.beginPath();
        ctx.roundRect(mapX, mapY, mapW, mapH, 12 * S);
        ctx.fill();
      }

      // 绘制采样点（同心圆中心）——地图区固定深色系（适配浅色瓦片底图）
      const circles = this.mapManager.getCircles();
      ctx.strokeStyle = 'rgba(2,132,199,0.7)';
      ctx.lineWidth = 1.5 * S;
      for (const c of circles) {
        const cx = toX(c.center.lng);
        const cy = toY(c.center.lat);
        // 圆圈半径映射（与校正后的投影 scale 一致）
        const rPx = Math.max(3 * S, c.maxRadius / 111320 * scale);
        ctx.beginPath();
        ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
        ctx.stroke();
        // 圆心点
        ctx.fillStyle = '#0284c7';
        ctx.beginPath();
        ctx.arc(cx, cy, 3 * S, 0, Math.PI * 2);
        ctx.fill();
      }

      // 绘制轨迹线（与地图显示完全一致的 7 档速度色阶着色）
      const trailPoints = this._getTrailPositions();
      if (trailPoints.length >= 2) {
        // 根据导出时的主题获取对应色阶（与 isDark 保持一致，不依赖 _speedColorMap getter）
        const colorMap = isDark ? this.mapManager._speedColorDark : this.mapManager._speedColorLight;
        const getSpeedKey = (s) => this.mapManager._speedColorKey(s);

        // 按速度色阶分段绘制：连续相同档位的点合并绘制，减少 stroke 调用
        let batchPath = [];
        let batchKey = null;

        const flushBatch = () => {
          if (batchPath.length < 2 || !batchKey) return;
          const c = colorMap[batchKey];
          ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${c.a})`;
          ctx.lineWidth = 2.5 * S;
          ctx.beginPath();
          ctx.moveTo(batchPath[0].x, batchPath[0].y);
          for (let j = 1; j < batchPath.length; j++) {
            ctx.lineTo(batchPath[j].x, batchPath[j].y);
          }
          ctx.stroke();
        };

        for (let i = 1; i < trailPoints.length; i++) {
          const p0 = trailPoints[i - 1];
          const p1 = trailPoints[i];
          const speed = p1.speed != null ? p1.speed : 0;
          const key = getSpeedKey(speed);

          if (key !== batchKey) {
            // 颜色档位变化：冲刷上一段
            flushBatch();
            batchPath = [{ x: toX(p0.lng), y: toY(p0.lat) }];
            batchKey = key;
          }
          batchPath.push({ x: toX(p1.lng), y: toY(p1.lat) });
        }
        flushBatch(); // 冲刷最后一段
      }

      // 起点/终点标记
      if (trailPoints.length >= 2) {
        const first = trailPoints[0];
        const last = trailPoints[trailPoints.length - 1];
        ctx.fillStyle = '#22c55e';
        ctx.beginPath();
        ctx.arc(toX(first.lng), toY(first.lat), 5 * S, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(toX(last.lng), toY(last.lat), 5 * S, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.85)'; // 地图区固定深色文字（浅色瓦片底图）
        ctx.font = `${11 * S}px "HarmonyOS Sans", sans-serif`;
        ctx.fillText('起点', toX(first.lng) + 8 * S, toY(first.lat) + 4 * S);
        ctx.fillText('终点', toX(last.lng) + 8 * S, toY(last.lat) + 4 * S);
      }

      // ── 比例尺 ──
      {
        const mpp = 111320 / scale; // 每像素对应米数
        const targetPx = 100 * S;
        let barMeters = Math.round(targetPx * mpp);
        const mag = Math.pow(10, Math.floor(Math.log10(barMeters)));
        const norm = barMeters / mag;
        let niceMeters;
        if (norm < 1.5) niceMeters = 1 * mag;
        else if (norm < 3.5) niceMeters = 2 * mag;
        else if (norm < 7.5) niceMeters = 5 * mag;
        else niceMeters = 10 * mag;
        const barPx = niceMeters / mpp;
        const barLabel = niceMeters >= 1000
          ? (niceMeters / 1000).toFixed(1) + 'km'
          : niceMeters + 'm';
        const barX = mapX + margin + 8 * S;
        const barY = mapY + mapH - margin - 8 * S;
        ctx.strokeStyle = 'rgba(0,0,0,0.65)'; // 比例尺固定深色（浅色瓦片底图）
        ctx.lineWidth = 2 * S;
        ctx.beginPath();
        ctx.moveTo(barX, barY);
        ctx.lineTo(barX + barPx, barY);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(barX, barY - 4 * S);
        ctx.lineTo(barX, barY + 4 * S);
        ctx.moveTo(barX + barPx, barY - 4 * S);
        ctx.lineTo(barX + barPx, barY + 4 * S);
        ctx.stroke();
        ctx.fillStyle = 'rgba(0,0,0,0.65)'; // 比例尺文字固定深色
        ctx.font = `${10 * S}px "HarmonyOS Sans", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(barLabel, barX + barPx / 2, barY + 5 * S);
        ctx.textAlign = 'left';
      }

      // ── 速度图例（与地图轨迹色阶 7 档一致，单行） ──
      const legendDotH = 4 * S;
      const legendTopPad = 14 * S;
      const legendBottomPad = 14 * S;
      {
        const legendLabels = ['0-10', '10-20', '20-60', '60-120', '120-200', '200-350', '>350'];
        const colorMap = isDark ? this.mapManager._speedColorDark : this.mapManager._speedColorLight;
        const keys = ['walk', 'bike', 'bus', 'car', 'train', 'hsr', 'sct'];
        const dotW = 12 * S;
        const gapX = 10 * S;
        const labelPad = 4 * S;
        const rowY = mapY + mapH + legendTopPad;

        ctx.font = `${10 * S}px "HarmonyOS Sans", sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';

        // 单行居中对齐
        const legendTextColor = isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.75)';
        let totalW = 0;
        for (let i = 0; i < legendLabels.length; i++) {
          totalW += dotW + labelPad + ctx.measureText(legendLabels[i]).width + (i < legendLabels.length - 1 ? gapX : 0);
        }
        let cx = mapX + (mapW - totalW) / 2;
        for (let i = 0; i < legendLabels.length; i++) {
          const c = colorMap[keys[i]];
          ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${c.a})`;
          ctx.beginPath();
          ctx.roundRect(cx, rowY, dotW, legendDotH, 2 * S);
          ctx.fill();
          cx += dotW + labelPad;
          ctx.fillStyle = legendTextColor;
          ctx.fillText(legendLabels[i], cx, rowY + legendDotH / 2);
          cx += ctx.measureText(legendLabels[i]).width + (i < legendLabels.length - 1 ? gapX : 0);
        }
      }

      // ── 速度曲线图（Canvas2D 直接绘制，不依赖 Chart.js） ──
      let chartY = mapY + mapH + legendTopPad + legendDotH + legendBottomPad;
      {
        const chartH = 150 * S;
        const padL = 50 * S, padR = 16 * S, padT = 24 * S, padB = 36 * S;
        const innerW = mapW - padL - padR;
        const innerH = chartH - padT - padB;

        // 收集速度数据：优先 _speedHistory，否则从 trail positions 计算
        let speedData = this._speedHistory.length > 0
          ? this._speedHistory.slice(-2500)
          : (() => {
              const arr = [];
              for (let i = 1; i < pos.length; i++) {
                const dt = (pos[i].time - pos[i - 1].time) / 1000;
                if (dt > 0 && dt < 60) {
                  const dlng = (pos[i].lng - pos[i - 1].lng) * Math.cos((pos[i].lat + pos[i - 1].lat) / 2 * Math.PI / 180) * 111320;
                  const dlat = (pos[i].lat - pos[i - 1].lat) * 111320;
                  const sp = Math.sqrt(dlng * dlng + dlat * dlat) / dt;
                  arr.push({ x: Math.round((pos[i].time - pos[0].time) / 100) / 10, y: Math.min(sp, 30) });
                }
              }
              return arr;
            })();

        // 峰值降采样到 600 点
        const MAX_PTS = 600;
        if (speedData.length > MAX_PTS) {
          const bin = speedData.length / MAX_PTS;
          const ds2 = [];
          for (let i = 0; i < MAX_PTS; i++) {
            const s = Math.floor(i * bin);
            const e = Math.max(s + 1, Math.floor((i + 1) * bin));
            let peak = speedData[s];
            for (let j = s + 1; j < e; j++) {
              if (speedData[j].y > peak.y) peak = speedData[j];
            }
            ds2.push(peak);
          }
          speedData = ds2;
        }

        // 背景卡片
        ctx.fillStyle = isDark ? '#16213e' : '#ffffff';
        ctx.beginPath();
        ctx.roundRect(mapX, chartY, mapW, chartH, 12 * S);
        ctx.fill();

        if (speedData.length < 2) {
          ctx.fillStyle = isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)';
          ctx.font = `${13 * S}px "HarmonyOS Sans", sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText('暂无速度数据', mapX + mapW / 2, chartY + chartH / 2);
          ctx.textAlign = 'left';
          chartY += chartH + 16 * S;
        } else {
          // 计算范围
          let xMin = Infinity, xMax = -Infinity, yMax = 0;
          for (const p of speedData) {
            if (p.x < xMin) xMin = p.x;
            if (p.x > xMax) xMax = p.x;
            if (p.y > yMax) yMax = p.y;
          }
          if (xMax === xMin) xMax = xMin + 1;
          yMax = Math.max(yMax * 1.15, 0.5); // 上留 15% 余量，最低 0.5 m/s

          // nice 刻度
          const niceMax = (v) => {
            const exp = Math.pow(10, Math.floor(Math.log10(v)));
            const norm = v / exp;
            return (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * exp;
          };
          const yNice = niceMax(yMax);
          const xRange = xMax - xMin;

          const toChartX = (v) => padL + (v - xMin) / xRange * innerW;
          const toChartY = (v) => padT + innerH - (v / yNice) * innerH;

          const textColor = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
          const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
          const axisColor = isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)';

          // 平移到卡片坐标系：后续所有绘制以卡片左上角为原点
          ctx.save();
          ctx.translate(mapX, chartY);

          // Y 轴网格 + 刻度
          const yTicks = 5;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.font = `${10 * S}px "HarmonyOS Sans", sans-serif`;
          for (let i = 0; i <= yTicks; i++) {
            const v = yNice * i / yTicks;
            const cy = toChartY(v);
            if (i > 0) {
              ctx.strokeStyle = gridColor;
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(padL, cy);
              ctx.lineTo(padL + innerW, cy);
              ctx.stroke();
            }
            ctx.fillStyle = textColor;
            ctx.fillText(v.toFixed(1), padL - 6 * S, cy);
          }

          // X 轴网格 + 刻度
          const xTicks = 6;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          for (let i = 0; i <= xTicks; i++) {
            const v = xMin + xRange * i / xTicks;
            const cx = toChartX(v);
            if (i > 0) {
              ctx.strokeStyle = gridColor;
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(cx, padT);
              ctx.lineTo(cx, padT + innerH);
              ctx.stroke();
            }
            ctx.fillStyle = textColor;
            ctx.fillText(Math.round(v) + '', cx, padT + innerH + 6 * S);
          }

          // 轴线
          ctx.strokeStyle = axisColor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(padL, padT);
          ctx.lineTo(padL, padT + innerH);
          ctx.lineTo(padL + innerW, padT + innerH);
          ctx.stroke();

          // 数据线 + fill
          ctx.save();
          ctx.beginPath();
          ctx.rect(padL, padT, innerW, innerH);
          ctx.clip();

          ctx.beginPath();
          ctx.moveTo(toChartX(speedData[0].x), toChartY(speedData[0].y));
          for (let i = 1; i < speedData.length; i++) {
            ctx.lineTo(toChartX(speedData[i].x), toChartY(speedData[i].y));
          }
          ctx.strokeStyle = '#4fc3f7';
          ctx.lineWidth = 1.5 * S;
          ctx.stroke();

          // fill
          ctx.lineTo(toChartX(speedData[speedData.length - 1].x), padT + innerH);
          ctx.lineTo(toChartX(speedData[0].x), padT + innerH);
          ctx.closePath();
          ctx.fillStyle = 'rgba(79,195,247,0.15)';
          ctx.fill();

          ctx.restore(); // clip

          // 轴标签
          ctx.fillStyle = textColor;
          ctx.font = `${10 * S}px "HarmonyOS Sans", sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText('时间(秒)', padL + innerW / 2, chartH - 6 * S);
          ctx.save();
          ctx.translate(12 * S, padT + innerH / 2);
          ctx.rotate(-Math.PI / 2);
          ctx.fillText('速度(m/s)', 0, 0);
          ctx.restore();

          ctx.restore(); // translate(mapX, chartY)
          chartY += chartH + 16 * S;
        }
      }

      // ── 统计信息 ──
      const statsY = chartY;
      ctx.fillStyle = isDark ? '#16213e' : '#ffffff';
      ctx.beginPath();
      ctx.roundRect(mapX, statsY, mapW, 160 * S, 12 * S);
      ctx.fill();

      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)';
      ctx.font = `${16 * S}px "HarmonyOS Sans", sans-serif`;
      ctx.fillText(' 轨迹统计', mapX + 16 * S, statsY + 32 * S);

      const statItems = [
        { label: '总距离', value: formatDistance(totalDist) },
        { label: '总时长', value: fmtDuration(durationMs) },
        { label: '平均速度', value: avgSpeed > 0 ? (avgSpeed * 3.6).toFixed(1) + ' km/h' : '--' },
        { label: '最高速度', value: hasSpeed ? (maxSpeed * 3.6).toFixed(1) + ' km/h' : '--' },
        { label: '轨迹点数', value: String(pos.length) },
      ];

      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
      ctx.font = `${12 * S}px "HarmonyOS Sans", sans-serif`;
      const colW = (mapW - 32 * S) / 3;
      for (let i = 0; i < statItems.length; i++) {
        const col = i % 3;
        const row = Math.floor(i / 3);
        const sx = mapX + 16 * S + col * colW;
        const sy = statsY + 56 * S + row * 48 * S;
        ctx.fillText(statItems[i].label, sx, sy);
        ctx.fillStyle = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)';
        ctx.font = `${18 * S}px "HarmonyOS Sans", sans-serif`;
        ctx.fillText(statItems[i].value, sx, sy + 22 * S);
        ctx.fillStyle = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
        ctx.font = `${12 * S}px "HarmonyOS Sans", sans-serif`;
      }

      // ── 底部圆信息 ──
      if (circles.length > 0) {
        const bottomY = statsY + 180 * S;
        ctx.fillStyle = isDark ? '#16213e' : '#ffffff';
        ctx.beginPath();
        ctx.roundRect(mapX, bottomY, mapW, Math.min(circles.length * 24 + 36, 120) * S, 12 * S);
        ctx.fill();
        ctx.fillStyle = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)';
        ctx.font = `${14 * S}px "HarmonyOS Sans", sans-serif`;
        ctx.fillText(' 同心圆', mapX + 16 * S, bottomY + 26 * S);
        ctx.fillStyle = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.6)';
        ctx.font = `${11 * S}px "HarmonyOS Sans", sans-serif`;
        const maxShow = Math.min(circles.length, 4);
        for (let i = 0; i < maxShow; i++) {
          const c = circles[i];
          const radiusStr = c.maxRadius >= 1000 ? `${(c.maxRadius/1000).toFixed(1)}km` : `${c.maxRadius}m`;
          ctx.fillText(`#${i+1}  ${c.center.lat.toFixed(4)}, ${c.center.lng.toFixed(4)} · ${radiusStr}`,
            mapX + 16 * S, bottomY + 48 * S + i * 22 * S);
        }
        if (circles.length > 4) {
          ctx.fillText(`... 共 ${circles.length} 个`, mapX + 16 * S, bottomY + 48 * S + 4 * 22 * S);
        }
      }

      // ── 水印 ──
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)';
      ctx.font = `${11 * S}px "HarmonyOS Sans", sans-serif`;
      ctx.textAlign = 'right';
      ctx.fillText('Circlemap · 地图雷达', W - 24 * S, H - 16 * S);
      ctx.textAlign = 'left';

      // ── 导出 PNG ──
      const dateStr = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const filename = `circlemap-activity-${dateStr}.png`;
      canvas.toBlob(async (blob) => {
        if (!blob) {
          Toast.show(' 导出失败：无法生成图片');
          return;
        }

        // 检测 Capacitor 原生环境
        if (typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform()) {
          try {
            // 方案 B：写缓存 → 系统分享（零权限）
            const reader = new FileReader();
            const base64 = await new Promise(resolve => {
              reader.onloadend = () => resolve(reader.result.split(',')[1]);
              reader.readAsDataURL(blob);
            });

            const result = await Capacitor.Plugins.Filesystem.writeFile({
              path: filename,
              data: base64,
              directory: 'CACHE',
            });

            await Capacitor.Plugins.Share.share({
              title: 'Circlemap 活动报告',
              text: 'Circlemap 地图雷达 — 轨迹活动报告',
              url: result.uri,
              dialogTitle: '分享或保存活动报告',
            });

            Toast.show(' 报告已分享');
          } catch (e) {
            console.error('[Export] 分享失败:', e);
            Toast.show(' 分享取消或失败');
          }
        } else {
          // Web 端：直接下载
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.download = filename;
          link.href = url;
          link.style.display = 'none';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);
          Toast.show(` 已导出：${filename}`);
        }
      }, 'image/png');
    } catch (e) {
      console.error('[Export] 报告导出失败:', e);
      Toast.show(' 导出报告失败');
    }
  }

  /**
   * 加载高德地图瓦片（普通道路图 style=8，GCJ-02 与腾讯地图同坐标系）
   * scale=2（512px retina）失败时回退 scale=1（256px）
   * fetch + blob 加载避免 canvas 污染（PNG 可正常导出）
   * @param {number} z 瓦片层级
   * @param {number} x 瓦片列号
   * @param {number} y 瓦片行号
   * @returns {Promise<HTMLImageElement>}
   */
  async _loadMapTile(z, x, y) {
    const base = 'https://webrd01.is.autonavi.com/appmaptile';
    for (const scale of [2, 1]) {
      const url = `${base}?lang=zh_cn&size=1&scale=${scale}&style=8&x=${x}&y=${y}&z=${z}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const blob = await res.blob();
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(blob);
        img.onload = () => { URL.revokeObjectURL(objectUrl); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('tile decode failed')); };
        img.src = objectUrl;
      });
      return image;
    }
    throw new Error('tile fetch failed');
  }

  /**
   * 更新轨迹 UI（按钮状态 + 距离显示）
   */
_updateTrailUI() {
     const btn = this._trailRecordBtn || (this._trailRecordBtn = document.getElementById('trail-record-btn'));
     const pauseBtn = this._trailPauseBtn || (this._trailPauseBtn = document.getElementById('trail-pause-btn'));
     const clearBtn = this._trailClearBtn || (this._trailClearBtn = document.getElementById('trail-clear-btn'));
     const statsBtn = this._trailStatsBtn || (this._trailStatsBtn = document.getElementById('trail-stats-btn'));
     const exportBtn = this._trailExportBtn || (this._trailExportBtn = document.getElementById('export-report-btn'));
     const smoothBtn = this._trailSmoothBtn || (this._trailSmoothBtn = document.getElementById('trail-smooth-btn'));
     const distEl = this._trailDistEl || (this._trailDistEl = document.getElementById('trail-distance'));

     // 记录按钮
     if (btn) {
       btn.classList.toggle('recording', this.trail.isRecording);
       btn.innerHTML = this.trail.isRecording
         ? '<span class="trail-dot"></span> 记录中...'
         : '<span class="trail-dot"></span> 开始记录';
     }

     // 暂停按钮
     if (pauseBtn) {
       pauseBtn.disabled = !this.trail.isRecording;
       pauseBtn.textContent = this.trail.isPaused ? '继续' : '暂停';
     }

     // 距离
     const dist = this.trail.getDistance();
     if (distEl) {
       distEl.textContent = dist > 0 ? formatDistance(dist) : '0m';
     }

     // 操作按钮状态
     const hasPoints = this.trail.positions.length > 0;
     if (clearBtn) clearBtn.disabled = !hasPoints;
     if (statsBtn) statsBtn.disabled = this.trail.positions.length < 2;
     if (exportBtn) exportBtn.disabled = this.trail.positions.length < 2;

     // 平滑按钮状态
     if (smoothBtn) {
       smoothBtn.classList.toggle('active', this._trailSmoothing);
       smoothBtn.innerHTML = this._trailSmoothing
         ? '<span class="smooth-icon"></span> 平滑'
         : '<span class="smooth-icon"></span> 平滑';
     }

     // 同步常驻记录条
     this._updateTrailBar();
   }

   /**
    * 同步常驻记录条 UI 状态
    */
   _updateTrailBar() {
     const dot = this._trailBarDot || (this._trailBarDot = document.getElementById('trail-bar-dot'));
     const state = this._trailBarState || (this._trailBarState = document.getElementById('trail-bar-state'));
     const btn = this._trailBarBtn || (this._trailBarBtn = document.getElementById('trail-bar-btn'));
     const dist = this._trailBarDist || (this._trailBarDist = document.getElementById('trail-bar-dist'));

     if (dot) dot.classList.toggle('recording', this.trail.isRecording);
     if (state) {
       state.textContent = this.trail.isRecording
         ? '记录中'
         : this.trail.isPaused ? '已暂停' : '未记录';
     }
     if (btn) {
       btn.classList.toggle('recording', this.trail.isRecording);
       btn.textContent = this.trail.isRecording ? '结束记录' : '开始记录';
     }
     if (dist) {
       const d = this.trail.getDistance();
       dist.textContent = d > 0 ? formatDistance(d) : '0m';
     }
   }

  /* ========== 通用位置处理 ========== */

  /**
   * 记录一次定位到最近列表（最多 10 条）
   */
  _recordFix(pos, convPos, isManual, isBackground) {
    this._recentFixes.push({
      time: Date.now(),
      lat: convPos.lat,
      lng: convPos.lng,
      accuracy: pos.accuracy || 0,
      speed: pos.speed,
      heading: pos.heading,
      isManual: !!isManual,
      isBackground: !!isBackground
    });
    if (this._recentFixes.length > CONFIG.MAX_RECENT_FIXES) {
      this._recentFixes = this._recentFixes.slice(-CONFIG.MAX_RECENT_FIXES);
    }
    this._updateRecentFixes();
  }

  /**
   * 处理位置数据：GCJ-02 转换 + UI 刷新
   */
  async _processPosition(pos) {
    try {
    // 丢弃过期位置（队列积压时的兜底）
    const age = Date.now() - (pos.timestamp || Date.now());
    if (age > CONFIG.GPS_WATCH_TIMEOUT * 3) return;
    // 跟踪原始坐标用于下次位移判断
    this._lastRawPos = {lat: pos.lat, lng: pos.lng};

    const convPos = await this.mapManager.wgs84ToGcj02(pos);

    // 保存速度/海拔
    // 浏览器 speed 常为 null（尤其桌面/首次定位），用连续定位的距离/时间自行计算
    if (pos.speed != null) {
      this._lastSpeed = pos.speed;
    } else if (this._lastCalcPos) {
      const dt = (pos.timestamp || Date.now()) - this._lastCalcTime;
      if (dt > 100) {
        const dist = calcDistance(this._lastCalcPos, convPos);
        this._lastSpeed = dist / (dt / 1000);
      }
    } else {
      this._lastSpeed = null;
    }
    this._lastAltitude = pos.altitude;
    this._lastHeading = pos.heading;
    this._lastCalcPos = { lat: convPos.lat, lng: convPos.lng };
    this._lastCalcTime = pos.timestamp || Date.now();
    this._lastAccuracy = pos.accuracy;

    // 保存定位信息
    this.myPosition = convPos;
    this.myPositionTime = Date.now();
    this.mapManager.setMyPos(convPos);
    this._isManualPosition = false; // #13 GPS 定位覆盖手动
    // 记录到最近列表
    this._recordFix(pos, convPos);

    // GPS 定位成功后刷新天气（使用精确坐标）
    this._fetchWeather();

    // 更新位置标记 + 精度环（#17）
    this.mapManager.setLocation(convPos, pos.accuracy, pos.heading);

    if (this._firstFix) {
      this._firstFix = false;

      if (this._restoringView) {
        // 从后台恢复：更新位置但不飞地图，不弹 toast
        this._restoringView = false;
      } else {
        // 首次定位或手动开启追踪：飞到我的位置
        this.center = convPos;
        this.mapManager.flyTo(convPos);

        // 同步到输入框
        this._latInput.value = convPos.lat.toFixed(6);
        this._lngInput.value = convPos.lng.toFixed(6);

        this._gpsBtn.classList.add('located');
        setTimeout(() => this._gpsBtn.classList.remove('located'), CONFIG.LOCATED_ANIM_MS);

        Toast.show(` 定位成功（精度 ±${(pos.accuracy || 0).toFixed(0)} 米）`);

        // 首次定位成功 → 权限已确认，激活 GNSS 卫星监听
        this.gpsManager.startGnss().then(() => {
          if (this.gpsManager.isGnssActive) {
            Toast.show(` GNSS 卫星数据已激活`);
          }
        }).catch(err => console.error('[GNSS] unexpected error:', err));
      }
    } else if (this._isWatching) {
      // 用户手动选过中心点 → 不覆盖 center（GPS 只更新自身位置标记）
      if (!this._manualCenter) {
        this.center = convPos;
      }
      // 同步到输入框（保持输入坐标与当前位置一致）
      if (!this._manualCenter) {
        this._latInput.value = convPos.lat.toFixed(6);
        this._lngInput.value = convPos.lng.toFixed(6);
      }
      // #12 — 跟随模式：每次位置更新都移动地图视角
      if (this._followMode) {
        this.mapManager.flyTo(convPos);
      }
    }

    // —— 记录历史轨迹（通过 Trail 模块，#18） ——
    if (this.trail.isRecording && !this._trailLoading) {
      const added = this.trail.addPoint({
        lat: convPos.lat,
        lng: convPos.lng,
        time: pos.timestamp || Date.now(),
        accuracy: pos.accuracy || 0,
        speed: pos.speed,
        heading: pos.heading
      });
      if (added) {
        this._trailDirty = true;
        this.mapManager.setTrail(this._getTrailPositions());
        this._updateTrailUI();
      }
    }

    // 链式节流：大位移触发全量UI更新，微动只更新距离数字
    const now = Date.now();
    const moved = this._lastDistPos ? calcDistance(convPos, this._lastDistPos) : Infinity;
    if (moved > CONFIG.MIN_DISPLACEMENT_M || !this._lastDistPos) {
      this._lastDistPos = convPos;
      this._updateCircleList(true);
      this._updateStatusBar(true);
      this._updateInfo();
      this._lastFullUpdate = now;
    } else if (now - this._lastFullUpdate > 60000) {
      // 60s 强制一次全量更新（保证时间/过期状态准确）
      this._lastDistPos = convPos;
      this._updateCircleList(true);
      this._updateStatusBar(true);
      this._updateInfo();
      this._lastFullUpdate = now;
    } else {
      // 微动：仅刷新状态条（节流）+ 叠加层标注
      this._updateStatusBar();
      this.mapManager._scheduleRedrawOverlay();
    }

    // 多人房间：发送位置
    if (this.roomManager && this.roomManager.isConnected()) {
      this.roomManager.publishPosition(
        convPos.lat, convPos.lng,
        pos.accuracy || 0,
        this._lastSpeed || 0,
        pos.heading || 0
      );
    }

    // 更新对方距离
    if (this._targetPos) {
      const dist = calcDistance(convPos, this._targetPos);
      this._targetInfoEl.textContent = `${this._targetPos.lat.toFixed(6)}, ${this._targetPos.lng.toFixed(6)} · 距我 ${formatDistance(dist)}`;
    }
    } catch (e) {
      if (CONFIG.DEBUG) console.error('_processPosition error:', e.message);
      // 转换失败时通知用户（30秒内不重复提示）
      if (!this._lastGcj02ErrorToast || Date.now() - this._lastGcj02ErrorToast > 30000) {
        this._lastGcj02ErrorToast = Date.now();
        Toast.show(' 坐标转换失败，位置未更新');
      }
    }
  }

  /**
   * 定位过期时的自动重定位（单次尝试，不开启追踪）
   * 由 60s 定时器触发，仅当位置过期且未在追踪时执行
   */
  async _autoRelocate() {
    // 防止并发 / 频繁重试（失败后至少等 N 分钟）
    if (this._relocating) return;
    if (Date.now() - this._lastRelocateAttempt < CONFIG.RELOCATE_INTERVAL_MS) return;

    this._relocating = true;
    Toast.show(' 定位已过期，正在重新定位...');

    try {
      const pos = await this.gpsManager.getCurrentPosition();
      const convPos = await this.mapManager.wgs84ToGcj02(pos);

      this.myPosition = convPos;
      this.myPositionTime = Date.now();
      this.mapManager.setMyPos(convPos);
      this._isManualPosition = false; // #13 GPS 定位覆盖手动
      this._lastAltitude = pos.altitude;
      this._lastSpeed = pos.speed;
      this._lastHeading = pos.heading;
      this._lastAccuracy = pos.accuracy;
      this._recordFix(pos, convPos);
      this.mapManager.setLocation(convPos, pos.accuracy, pos.heading); // #17 精度环
      this._prevDistances = {}; // 重置趋势缓存

      this._updateStatusBar(true);
      this._updateCircleList(true);
      this._updateInfo();

    } catch (err) {
      console.warn('[AutoRelocate] 重定位失败:', err.message);
      Toast.show(' 自动重定位失败');
      // 失败后留待下一个周期再试（依靠 _lastRelocateAttempt 控制频率）
    } finally {
      this._relocating = false;
      this._lastRelocateAttempt = Date.now();
    }
  }

  /**
   * 设置对方位置标记
   */
  _setTargetPosition() {
    const lat = parseFloat(this._latInput.value);
    const lng = parseFloat(this._lngInput.value);
    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      Toast.show(' 请输入有效的坐标');
      return;
    }
    this._targetPos = { lat, lng };
    const range = parseInt(this._targetRange.value) || 0;
    this.mapManager.setTarget(this._targetPos, range);
    this._targetClearBtn.disabled = false;
    this._targetRangeRow.classList.remove('hidden');
    this._targetInfoEl.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    if (this.myPosition) {
      const dist = calcDistance(this.myPosition, this._targetPos);
      this._targetInfoEl.textContent += ` · 距我 ${formatDistance(dist)}`;
    }
    Toast.show(' 已标记对方位置');
  }

  /**
   * 清除对方位置标记
   */
  _clearTarget() {
    this._targetPos = null;
    this.mapManager.setTarget(null);
    this._targetClearBtn.disabled = true;
    this._targetInfoEl.textContent = '';
    this._targetRangeRow.classList.add('hidden');
    this._targetRange.value = 0;
    this._targetRangeInput.value = 0;
  }

  /**
   * 清除所有同心圆（支持撤销）
   */
  _clearAll() {
    const savedCircles = this.mapManager.circles.slice();
    const savedSelectedId = this.mapManager.selectedCircleId;
    const savedPrevDistances = { ...this._prevDistances };

    this.mapManager.clearCircles();
    document.getElementById('infoArea').classList.add('hidden');
    this._prevDistances = {}; // 清理趋势缓存，避免 ID 意外碰撞时有残留数据
    this._updateCircleList(true);
    this._updateStatusBar(true);
    this._dirty = true;
    this._saveState();
    if (this.roomManager && this._roomJoined) this.roomManager.publishCircle('clear');

    Toast.showUndo('已清除全部', () => {
      this.mapManager.circles = savedCircles;
      this.mapManager.selectedCircleId = savedSelectedId;
      this._prevDistances = savedPrevDistances;
      if (savedSelectedId != null) {
        this._setRadiusSliderValue(
          this.mapManager.circles.find(c => c.id === savedSelectedId)?.maxRadius || CONFIG.DEFAULT_RADIUS
        );
      }
      this.mapManager._scheduleRedraw();
      this._updateInfo();
      this._updateCircleList(true);
      this._updateStatusBar(true);
      this._dirty = true;
      this._saveState();
      if (this.roomManager && this._roomJoined) {
        savedCircles.forEach((c) => this.roomManager.publishCircle('add', c));
      }
    });
  }

  /* ============= 状态 & 信息更新 ============= */

  /** 定位过期阈值（毫秒） */
  get POSITION_STALE_MS() { return CONFIG.POSITION_STALE_MS; }

  /**
   * 检查上次定位是否已过期
   */
  _isPositionStale() {
    return this.myPositionTime !== null && (Date.now() - this.myPositionTime) > this.POSITION_STALE_MS;
  }

  /**
   * 格式化解上次定位已过时间
   */
  _formatElapsed() {
    if (this.myPositionTime === null) return '';
    const diff = Date.now() - this.myPositionTime;
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min}分钟前`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m > 0 ? `${h}小时${m}分钟前` : `${h}小时前`;
  }

  /**
   * 计算距圆心的距离、方位角、范围内外、趋势
   * @param {{id:number,center:{lat:number,lng:number},maxRadius:number}} circle
   * @returns {{dist:number, bearing:number, bearingStr:string, within:boolean, stale:boolean, trend:string, trendHtml:string}}
   */
  _calcCircleTrend(circle) {
    const dist = calcDistance(this.myPosition, circle.center);
    const bearing = calcBearing(this.myPosition, circle.center);
    const bearingStr = `${Math.round(bearing)}° ${bearingToDir(bearing)}`;
    const accuracy = this._lastAccuracy || 0;
    // 三态范围：'inrange' 确定在圆内 / 'maybe' 精度圈与圆重叠 / false 在圆外
    let within = false;
    if (dist <= circle.maxRadius) {
      within = 'inrange';
    } else if (accuracy > 0 && (dist - accuracy) <= circle.maxRadius) {
      within = 'maybe';
    }
    const stale = this._isPositionStale();
    let trend = '';
    let trendHtml = '';
    if (!stale && circle.id in this._prevDistances) {
      const diff = dist - this._prevDistances[circle.id];
      if (Math.abs(diff) > 1) {
        if (diff < 0) {
          trend = ' ↑';
          trendHtml = ' <span class="trend-up">↑ 靠近中</span>';
        } else {
          trend = ' ↓';
          trendHtml = ' <span class="trend-down">↓ 远离中</span>';
        }
      }
    }
    this._prevDistances[circle.id] = dist;
    return { dist, bearing, bearingStr, within, stale, trend, trendHtml };
  }

  _escapeHtml(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  /* ============= 主题切换 ============= */

  /**
   * 恢复主题偏好
   */
  _restoreTheme() {
    try {
      const saved = localStorage.getItem('circlemap_theme');
      if (saved === 'light' || saved === 'dark') {
        this._theme = saved;
      }
    } catch (e) { /* 静默 */ }
    document.documentElement.setAttribute('data-theme', this._theme);
    this.mapManager.setTheme(this._theme);
    this._updateThemeBtn();
  }

  /**
   * 切换深色/浅色主题
   */
  _toggleTheme() {
    this._theme = this._theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', this._theme);
    this.mapManager.setTheme(this._theme);
    // 渐进重绘轨迹以匹配新主题颜色
    const positions = this._getTrailPositions();
    if (positions && positions.length >= 2) {
      this.mapManager.refreshTrailColors(positions);
    }
    this._updateChartTheme(); // 同步更新速度曲线主题色
    try {
      localStorage.setItem('circlemap_theme', this._theme);
    } catch (e) { /* 静默 */ }
    this._updateThemeBtn();
    Toast.show(this._theme === 'light' ? ' 已切换为浅色主题' : ' 已切换为深色主题');
  }

  /**
   * 更新速度曲线（Chart.js）的主题色，跟随全局 _theme 变化
   */
  _updateChartTheme() {
    if (!this._speedChart) return;
    const isDark = this._theme === 'dark';
    const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    const textColor = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
    const scales = this._speedChart.options.scales;
    if (scales?.x?.ticks) scales.x.ticks.color = textColor;
    if (scales?.x?.title) scales.x.title.color = textColor;
    if (scales?.x?.grid) scales.x.grid.color = gridColor;
    if (scales?.y?.ticks) scales.y.ticks.color = textColor;
    if (scales?.y?.title) scales.y.title.color = textColor;
    if (scales?.y?.grid) scales.y.grid.color = gridColor;
    this._speedChart.update('none');
  }

  /**
   * 更新主题按钮图标
   */
  _updateThemeBtn() {
    const btn = document.getElementById('theme-btn');
    if (!btn) return;
    const isDark = this._theme === 'dark';
    btn.innerHTML = isDark
      ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    btn.title = isDark ? '切换浅色主题' : '切换深色主题';
  }

  /* ============= 主色方案 ============= */

  /**
   * 恢复主色方案偏好
   */
  _restoreAccent() {
    const accents = ['cyan', 'green', 'blue', 'purple', 'orange'];
    try {
      const saved = localStorage.getItem('circlemap_accent');
      if (accents.includes(saved)) this._accent = saved;
    } catch (e) { /* 静默 */ }
    document.documentElement.setAttribute('data-accent', this._accent);
    this._updateAccentBtns();
  }

  /**
   * 设置主色方案
   * @param {string} name
   */
  _setAccent(name) {
    if (name === this._accent) return;
    this._accent = name;
    document.documentElement.setAttribute('data-accent', name);
    this._updateAccentBtns();
    try { localStorage.setItem('circlemap_accent', name); } catch (e) { /* 静默 */ }
    Toast.show(` 已切换为${ {cyan:'青色', green:'绿色', blue:'蓝色', purple:'紫色', orange:'橙色'}[name] }主题`);
  }

  /**
   * 更新主色按钮选中状态
   */
  _updateAccentBtns() {
    document.querySelectorAll('.accent-dot').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.accent === this._accent);
    });
  }

  /* ============= 功能提示（放在对应功能旁） ============= */

  /** 提示步骤定义 */
  static HINT_STEPS = [
    {
      target: '#gps-btn',
      text: '短按定位，长按持续追踪',
      placement: 'left',
    },
    {
      target: '.mode-tabs',
      text: '切换到坐标输入模式可手动输入',
      placement: 'bottom',
    },
    {
      target: '#parse-input',
      text: '智能识别度分秒和十进制坐标',
      placement: 'top',
    },
    {
      target: '#draw-btn',
      text: '设好半径后点击绘制同心圆',
      placement: 'top',
    },
{
       target: '#mode-trail',
       text: '切换到轨迹模式，记录运动路线并查看统计',
       placement: 'bottom',
     },
  ];

  /**
   * 显示功能提示
   */
  _showHints() {
    try {
      const done = localStorage.getItem('circlemap_onboarding_done');
      if (done === '1') return;
    } catch (e) { /* 静默 */ }

    this._onboardingStep = 0;
    this._onboardingActive = true;
    this._renderHint();
  }

  /**
   * 定位并渲染当前提示
   */
  _renderHint() {
    const steps = App.HINT_STEPS;
    const step = steps[this._onboardingStep];
    if (!step) {
      this._dismissHints();
      return;
    }

    const tooltip = document.getElementById('hint-tooltip');
    const textEl = document.getElementById('hint-text');
    const stepEl = document.getElementById('hint-step');

    textEl.textContent = step.text;
    stepEl.textContent = `${this._onboardingStep + 1}/${steps.length}`;

    // 如果提示位于面板内且面板折叠了，展开面板
    if (step.target && step.target !== '#gps-btn' && step.target !== '#mode-select') {
      if (this._panelCollapsed) {
        this._panelCollapsed = false;
        this._bottomPanel.classList.remove('collapsed');
      }
    }

    this._positionHint(step.target, step.placement || 'bottom');

    tooltip.style.display = 'block';
    // 先让浏览器完成布局再淡入
    requestAnimationFrame(() => {
      tooltip.style.opacity = '1';
    });
  }

  /**
   * 将提示浮层定位到目标元素旁
   * @param {string|null} targetSelector CSS 选择器，null 则居中
   * @param {string} placement 首选方位: top|bottom|left|right
   */
  _positionHint(targetSelector, placement) {
    const tooltip = document.getElementById('hint-tooltip');
    const arrow = document.getElementById('hint-arrow');

    // 无目标 → 居中（结尾提示）
    if (!targetSelector) {
      tooltip.style.transform = '';
      tooltip.style.top = '50%';
      tooltip.style.left = '50%';
      tooltip.style.transform = 'translate(-50%, -50%)';
      tooltip.setAttribute('data-placement', 'center');
      if (arrow) arrow.style.display = 'none';
      return;
    }

    if (arrow) arrow.style.display = 'block';

    const target = document.querySelector(targetSelector);
    if (!target || target.offsetWidth === 0) {
      // 目标不存在或隐藏 → 居中降级
      tooltip.style.transform = '';
      tooltip.style.top = '50%';
      tooltip.style.left = '50%';
      tooltip.style.transform = 'translate(-50%, -50%)';
      tooltip.setAttribute('data-placement', 'center');
      return;
    }

    tooltip.style.transform = '';
    const tr = target.getBoundingClientRect();

    // 临时显示以测量尺寸
    tooltip.style.display = 'block';
    tooltip.style.opacity = '0';
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    tooltip.style.display = 'none';
    tooltip.style.opacity = '';

    const PAD = 10;     // 距视口边距
    const GAP = 12;     // 与目标的间距（含箭头视觉空间）

    // 按优先级依次尝试各方位，选第一个完全可见的
    const tries = [placement, 'bottom', 'top', 'right', 'left'];
    let best = null;

    for (const p of tries) {
      let t, l;
      switch (p) {
        case 'left':
          t = tr.top + tr.height / 2 - th / 2;
          l = tr.left - tw - GAP;
          break;
        case 'right':
          t = tr.top + tr.height / 2 - th / 2;
          l = tr.right + GAP;
          break;
        case 'top':
          t = tr.top - th - GAP;
          l = tr.left + tr.width / 2 - tw / 2;
          break;
        case 'bottom':
        default:
          t = tr.bottom + GAP;
          l = tr.left + tr.width / 2 - tw / 2;
          break;
      }

      // 夹紧到视口内
      const ct = Math.max(PAD, Math.min(t, window.innerHeight - th - PAD));
      const cl = Math.max(PAD, Math.min(l, window.innerWidth - tw - PAD));

      // 检查方向是否仍然正确（没有被夹偏太远）
      const tOff = Math.abs(ct - t);
      const lOff = Math.abs(cl - l);
      const tooFar = Math.max(tOff, lOff) > Math.max(tw, th) * 0.5;

      if (!tooFar || best === null) {
        best = { top: ct, left: cl, placement: p };
        if (!tooFar && p === placement) break; // 完美命中
      }
    }

    // 如果全都失败，居中
    if (!best) {
      tooltip.style.top = '50%';
      tooltip.style.left = '50%';
      tooltip.style.transform = 'translate(-50%, -50%)';
      tooltip.setAttribute('data-placement', 'center');
      return;
    }

    tooltip.style.top = best.top + 'px';
    tooltip.style.left = best.left + 'px';
    tooltip.setAttribute('data-placement', best.placement);
  }

  /**
   * 下一个提示
   */
  _nextHint() {
    const steps = App.HINT_STEPS;
    if (this._onboardingStep >= steps.length - 1) {
      this._dismissHints();
      return;
    }
    this._onboardingStep++;
    this._renderHint();
  }

  /**
   * 关闭所有提示
   */
  _dismissHints() {
    this._onboardingActive = false;
    const tooltip = document.getElementById('hint-tooltip');
    tooltip.style.display = 'none';
    tooltip.style.opacity = '0';
    try { localStorage.setItem('circlemap_onboarding_done', '1'); } catch (e) { /* 静默 */ }
  }

  /* ============= 数据持久化 ============= */

  /**
   * 保存状态到 localStorage（circles + 设置）（#18 委托给 Storage 模块）
   */
  _saveState() {
    // 轨迹仅在有变更时保存
    if (this._trailDirty) {
      this._trailDirty = false;
      Storage.saveTrail(this.trail);
    }
    if (!this._dirty) return;
    Storage.saveCircles(this.mapManager, this.circleRadius, this.center);
    this._dirty = false;
  }

  /**
   * 从 localStorage 恢复状态（页面启动时调用）（#18 委托给 Storage 模块）
   */
  _loadState() {
    // 恢复圆圈（没有数据就跳过）
    const data = Storage.loadCircles();
    if (data) {
      // 恢复设置（#11 对数映射）
      if (data.circleRadius && !isNaN(data.circleRadius)) {
        this._setRadiusSliderValue(data.circleRadius);
      }

      if (data.center) {
        this.center = data.center;
        this.mapManager.setCenter(data.center);
      }

      // 恢复圆圈
      if (data.circles && Array.isArray(data.circles) && data.circles.length > 0) {
        for (const c of data.circles) {
          // 损坏数据防御：非法圆直接跳过，防 NaN 入 canvas arc() 中断渲染
          if (!c || !c.center || !Number.isFinite(c.center.lat) || !Number.isFinite(c.center.lng)) continue;
          const maxRadius = (Number.isFinite(c.maxRadius) && c.maxRadius > 0)
            ? Math.min(c.maxRadius, CONFIG.MAX_RADIUS)
            : CONFIG.CONCENTRIC_INTERVAL;
          this.mapManager.circles.push({
            id: c.id,
            center: c.center,
            maxRadius,
            interval: CONFIG.CONCENTRIC_INTERVAL,
            color: c.color || '',
            createdAt: c.createdAt || Date.now()
          });
        }
        // 恢复选中状态
        if (data.selectedCircleId && this.mapManager.circles.some(c => c.id === data.selectedCircleId)) {
          this.mapManager.selectedCircleId = data.selectedCircleId;
        }
        this._updateInfo();
        this._updateCircleList(true);
        this._updateStatusBar(true);
        this.mapManager._scheduleRedraw();
      }
    }

    // 恢复轨迹数据（IndexedDB 异步）
    this._trailLoading = true;
    Storage.loadTrail().then(trailData => {
      this._trailLoading = false;
      if (!trailData) return;

      const hasPositions = trailData.positions && trailData.positions.length > 0;

      if (hasPositions) {
        this.trail.positions = trailData.positions;
        this.trail.lastPos = trailData.positions[trailData.positions.length - 1];
        if (trailData.positions.length >= 2) {
          this.mapManager.setTrail(this._getTrailPositions());
        }
      }

      // 恢复录制状态
      if (trailData.isRecording) {
        this.trail.isRecording = true;
        this.trail.isPaused = trailData.isPaused || false;
        Toast.show(trailData.isPaused ? '轨迹记录已恢复（暂停中）' : '轨迹记录已恢复');
      }

      this._updateTrailUI();
    }).catch(err => {
      console.warn('[App] 轨迹恢复失败:', err.message);
    });
  }

  /**
   * Open-Meteo 天气代码 → 中文描述
   */
  static _wttrCodeToZh(code) {
    const map = {
      113: '晴', 116: '多云', 119: '阴', 122: '阴天',
      143: '雾',
      176: '零星小雨', 179: '零星小雪', 182: '零星雨夹雪', 185: '零星冻毛毛雨',
      200: '雷阵雨', 227: '吹雪', 230: '暴风雪',
      248: '雾', 260: '冻雾',
      263: '小毛毛雨', 266: '毛毛雨',
      281: '冻毛毛雨', 284: '大冻毛毛雨',
      293: '零星小雨', 296: '小雨', 299: '时中雨', 302: '中雨',
      305: '时大雨', 308: '大雨',
      311: '小冻雨', 314: '中大冻雨',
      317: '小雨夹雪', 320: '中大雨夹雪',
      323: '零星小雪', 326: '小雪', 329: '零星中雪', 332: '中雪',
      335: '零星大雪', 338: '大雪',
      350: '冰粒',
      353: '小阵雨', 356: '中大阵雨', 359: '暴雨',
      362: '小阵雨夹雪', 365: '中大阵雨夹雪',
      368: '小阵雪', 371: '中大阵雪',
      374: '小冰粒', 377: '中大冰粒',
      386: '小雷阵雨', 389: '大雷阵雨',
      392: '小雷阵雪', 395: '大雷阵雪'
    };
    return map[parseInt(code, 10)] || '';
  }

  static _weatherCodeToZh(code) {
    const map = {
      0: '晴', 1: '大部晴', 2: '多云', 3: '阴',
      45: '雾', 48: '雾凇',
      51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
      56: '冻毛毛雨', 57: '大冻毛毛雨',
      61: '小雨', 63: '中雨', 65: '大雨',
      66: '冻雨', 67: '大冻雨',
      71: '小雪', 73: '中雪', 75: '大雪',
      77: '雪粒',
      80: '小阵雨', 81: '阵雨', 82: '大阵雨',
      85: '小阵雪', 86: '大阵雪',
      95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '大雷阵雨伴冰雹'
    };
    return map[code] || '';
  }

  /**
   * 获取当前天气（主用 Open-Meteo，备用 wttr.in）
   * 两个 API 均原生支持 CORS，无需代理
   */
  _fetchWeather() {
    if (!navigator.onLine) return;
    if (this.gpsManager.isPowerSaving) return;
    // 节流：5 分钟内不重复请求
    const now = Date.now();
    if (this._lastWeatherFetch && now - this._lastWeatherFetch < 300000) return;
    // 位移 < 1km 不刷新（坐标精度不需要）
    if (this._lastWeatherPos && this.myPosition) {
      const d = calcDistance(this.myPosition, this._lastWeatherPos);
      if (d < 1000 && now - this._lastWeatherFetch < 1800000) return;
    }
    this._lastWeatherFetch = now;
    this._lastWeatherPos = this.myPosition ? { lat: this.myPosition.lat, lng: this.myPosition.lng } : this._lastWeatherPos;
    const pos = this.myPosition;
    const lat = pos?.lat ?? 39.9;
    const lng = pos?.lng ?? 116.4;
    // 主用 Open-Meteo（免费、快速、无需注册）
    this._fetchWeatherOpenMeteo(lat, lng)
      .catch(() => { this._fetchWeatherWttr(lat, lng).catch(() => {}); });
  }

  /**
   * Open-Meteo 天气 API（主用）
   * 免费、无需 API key、原生 CORS
   */
  _fetchWeatherOpenMeteo(lat, lng) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code&daily=sunrise,sunset&timezone=auto&forecast_days=1`;
    return fetch(url, { signal: AbortSignal.timeout(5000) })
      .then(r => r.json())
      .then(data => {
        const cur = data.current;
        if (!cur) throw new Error('no data');
        const temp = cur.temperature_2m;
        const feelsLike = cur.apparent_temperature;
        const humidity = cur.relative_humidity_2m;
        const wind = cur.wind_speed_10m;
        const code = cur.weather_code;
        const desc = App._weatherCodeToZh(code);
        const feelsText = feelsLike != null ? ` 体感${Math.round(feelsLike)}°` : '';
        const humidityText = humidity != null ? ` 湿度${humidity}%` : '';
        // 日出日落
        let sunText = '';
        const daily = data.daily;
        if (daily?.sunrise?.[0] && daily?.sunset?.[0]) {
          const sunrise = daily.sunrise[0].slice(11);
          const sunset = daily.sunset[0].slice(11);
          sunText = ` 日出${sunrise} 日落${sunset}`;
        }
        this._weatherHtml = `<span class="gps-weather" title="湿度 ${humidity}%">${temp}°C${feelsText} ${wind}km/h${humidityText}${desc ? ' ' + desc : ''}${sunText}</span>`;
        this._updateStatusBar(true);
      });
  }

  /**
   * wttr.in 备用天气
   */
  _fetchWeatherWttr(lat, lng) {
    const url = (lat && lng)
      ? `https://wttr.in/${lat},${lng}?format=j1&lang=zh`
      : 'https://wttr.in/?format=j1&lang=zh';
    return fetch(url, { signal: AbortSignal.timeout(8000) })
      .then(r => r.json())
      .then(data => {
        const cur = data.current_condition?.[0];
        if (!cur) return;
        const temp = cur.temp_C;
        const feelsLike = cur.FeelsLikeC;
        const wind = cur.windspeedKmph;
        const desc = App._wttrCodeToZh(cur.weatherCode) || cur.weatherDesc?.[0]?.value || '';
        const humidity = cur.humidity;
        const feelsText = feelsLike ? ` 体感${Math.round(feelsLike)}°` : '';
        const humidityText = humidity ? ` 湿度${humidity}%` : '';
        this._weatherHtml = `<span class="gps-weather" title="湿度 ${humidity}%">${temp}°C${feelsText} ${wind}km/h${humidityText}${desc ? ' ' + desc : ''}</span>`;
        this._updateStatusBar(true);
      })
      .catch(() => {});
  }

  /**
   * 初始化电池监控
   */
  _initBattery() {
    if (!navigator.getBattery) return;
    navigator.getBattery().then(battery => {
      this._battery = battery;
      this._batteryLevel = battery.level;
      this._batteryCharging = battery.charging;
      this._batteryTime = battery.dischargingTime; // 剩余时间（秒），Infinity 表示充电中
      this._updateStatusBar(true);
      this._pushBatteryToRoom();

      // 记录电量变化时间点，用于计算消耗速率
      this._batteryLastLevel = battery.level;
      this._batteryLastTime = Date.now();

      this._batteryLevelHandler = () => {
        const now = Date.now();
        const dt = (now - this._batteryLastTime) / 1000; // 秒
        const dl = this._batteryLastLevel - battery.level;
        if (dt > 60 && dl > 0) {
          // 超过 1 分钟且有消耗，计算速率
          this._batteryConsumeRate = dl / dt; // 每秒消耗比例
        }
        this._batteryLastLevel = battery.level;
        this._batteryLastTime = now;
        this._batteryLevel = battery.level;
        this._batteryCharging = battery.charging;
        this._batteryTime = battery.dischargingTime;
        this._updateStatusBar(true);
        this._pushBatteryToRoom();
        // 低电量警告
        if (battery.level <= 0.15 && !battery.charging) {
          Toast.show('电量不足 15%，建议开启省电模式');
        }
      };
      battery.addEventListener('levelchange', this._batteryLevelHandler);

      this._batteryChargingHandler = () => {
        this._batteryCharging = battery.charging;
        this._batteryTime = battery.dischargingTime;
        this._updateStatusBar(true);
        this._pushBatteryToRoom();
      };
      battery.addEventListener('chargingchange', this._batteryChargingHandler);

      this._batteryTimeHandler = () => {
        this._batteryTime = battery.dischargingTime;
        this._updateStatusBar(true);
      };
      battery.addEventListener('dischargingtimechange', this._batteryTimeHandler);
    }).catch(() => {});
  }

  _cleanupBattery() {
    if (this._battery) {
      if (this._batteryLevelHandler) this._battery.removeEventListener('levelchange', this._batteryLevelHandler);
      if (this._batteryChargingHandler) this._battery.removeEventListener('chargingchange', this._batteryChargingHandler);
      if (this._batteryTimeHandler) this._battery.removeEventListener('dischargingtimechange', this._batteryTimeHandler);
      this._battery = null;
      this._batteryLevelHandler = null;
      this._batteryChargingHandler = null;
      this._batteryTimeHandler = null;
    }
  }

  /**
   * 获取格式化的电池续航时间
   * @returns {string|null}
   */
  _getBatteryTimeStr() {
    if (this._batteryCharging) return null;
    // 优先用浏览器 API
    if (this._batteryTime && isFinite(this._batteryTime) && this._batteryTime > 0) {
      const h = Math.floor(this._batteryTime / 3600);
      const m = Math.floor((this._batteryTime % 3600) / 60);
      return h > 0 ? `${h}h${m}m` : `${m}m`;
    }
    // 降级：用消耗速率估算
    if (this._batteryConsumeRate && this._batteryConsumeRate > 0 && this._batteryLevel != null) {
      const remainSec = this._batteryLevel / this._batteryConsumeRate;
      const h = Math.floor(remainSec / 3600);
      const m = Math.floor((remainSec % 3600) / 60);
      return h > 0 ? `~${h}h${m}m` : `~${m}m`;
    }
    return null;
  }

  /* ============= URL 参数 ============= */

  /**
   * 从 URL 参数读取初始状态
   * 支持：?lat=39.9&lng=116.4&radius=1000
   */
  _checkUrlParams() {
    try {
      const params = new URLSearchParams(window.location.search);
      const lat = parseFloat(params.get('lat'));
      const lng = parseFloat(params.get('lng'));
      const radius = parseInt(params.get('radius'), 10);

      if (!isNaN(lat) && !isNaN(lng) &&
          lat >= -90 && lat <= 90 &&
          lng >= -180 && lng <= 180) {
        this.center = { lat, lng };
        this.mapManager.setCenter(this.center);

        if (!isNaN(radius) && radius >= CONFIG.MIN_RADIUS && radius <= CONFIG.MAX_RADIUS) {
          this._setRadiusSliderValue(radius);
          const newCircleId = this.mapManager.addCircle(this.center, radius);
          this._updateInfo();
          this._updateCircleList(true);
          this._dirty = true;
          this._saveState();
          if (this.roomManager && this._roomJoined) {
            const c = this.mapManager.circles.find(x => x.id === newCircleId);
            if (c) this.roomManager.publishCircle('add', c);
          }
        }
      }
    } catch (e) {
      // 静默忽略 URL 解析错误
    }
  }

  /* ============= 多人房间 ============= */

  // ---------- 房间会话持久化（自动重连） ----------

  /**
   * 保存房间会话到 localStorage
   */
  _saveRoomSession(code, nick, spectator) {
    try {
      const session = {
        roomCode: code,
        nickname: nick,
        spectator: !!spectator,
        timestamp: Date.now()
      };
      localStorage.setItem('circlemap_room_session', JSON.stringify(session));
    } catch (e) {
      console.warn('[Room] 保存房间会话失败:', e.message);
    }
  }

  /**
   * 清除房间会话
   */
  _clearRoomSession() {
    try {
      localStorage.removeItem('circlemap_room_session');
    } catch (e) { /* 静默 */ }
  }

  /**
   * 自动重连上次的房间（页面加载时调用）
   * 24 小时内有效，过期或失败自动清除
   */
  async _autoRejoinRoom() {
    if (this.roomManager) return;
    let raw;
    try {
      raw = localStorage.getItem('circlemap_room_session');
    } catch (e) { return; }
    if (!raw) return;
    let session;
    try {
      session = JSON.parse(raw);
    } catch (e) { return; }
    if (!session || !session.roomCode || !session.nickname) return;
    // 24 小时过期
    if (Date.now() - session.timestamp > 24 * 60 * 60 * 1000) {
      this._clearRoomSession();
      return;
    }
    // 短时间内的页面刷新（5 秒内）也跳过，由 MQTT 重连机制自行恢复
    if (Date.now() - session.timestamp < 5000) return;

    Toast.show(' 检测到上次的房间，正在自动重连...');
    try {
      if (this.roomManager) {
        this.roomManager.leaveRoom();
        this.roomManager.destroy();
        this.roomManager = null;
      }
      this.roomManager = new RoomManager();
      this._bindRoomEvents();
      await this.roomManager.joinRoom(session.roomCode, session.nickname, session.spectator);
      this._roomJoined = true;
      this._showRoomCode(session.roomCode);
      this._roomFormCreate.classList.add('hidden');
      this._roomFormJoin.classList.add('hidden');
      this._updateRoomPlayerList();
      this._showRoomExtras();
      // 更新会话时间戳
      this._saveRoomSession(session.roomCode, session.nickname, session.spectator);
      Toast.show(` 已自动重连至房间：${session.roomCode}`);
    } catch (e) {
      console.warn('[Room] 自动重连失败:', e.message);
      // 失败路径必须销毁 manager：joinRoom 中途失败的连接会残留活跃状态与事件绑定
      if (this.roomManager) {
        this.roomManager.destroy();
        this.roomManager = null;
      }
      this._roomCleanup();
      this._clearRoomSession();
      Toast.show(' 房间已过期，已自动断开');
    }
  }

  /**
   * 创建房间
   */
  async _roomCreate() {
    const nick = (this._roomNickInput.value || '').trim() || '玩家' + Math.random().toString(36).slice(2, 5);
    const spectator = this._roomSpectatorCheck ? this._roomSpectatorCheck.checked : false;
    Toast.show(' 正在创建房间...');
    try {
      if (this.roomManager) {
        this.roomManager.leaveRoom();
        this.roomManager.destroy();
        this.roomManager = null;
      }
      this.roomManager = new RoomManager();
      this._bindRoomEvents();
      const code = await this.roomManager.createRoom(nick, spectator);
      this._roomJoined = true;
      this._showRoomCode(code);
      this._roomFormCreate.classList.add('hidden');
      this._roomFormJoin.classList.add('hidden');
      this._updateRoomPlayerList();
      this._showRoomExtras();
      this._saveRoomSession(code, nick, spectator);
      Toast.show(` 房间已创建：${code}，分享给队友`);
    } catch (e) {
      console.error('[Room] 创建失败:', e);
      Toast.show(' 房间创建失败：' + (e.message || '连接超时'));
      // 失败路径销毁 manager（_roomCleanup 不销毁，防连接残留）
      if (this.roomManager) {
        this.roomManager.destroy();
        this.roomManager = null;
      }
      this._roomCleanup();
    }
  }

  /**
   * 加入房间
   */
  async _roomJoin() {
    const code = (this._roomCodeInput.value || '').trim().toUpperCase();
    if (!code || code.length < 4) {
      Toast.show(' 请输入有效的房间码');
      return;
    }
    const nick = (this._roomNickInput.value || '').trim() || '玩家' + Math.random().toString(36).slice(2, 5);
    const spectator = this._roomSpectatorCheck ? this._roomSpectatorCheck.checked : false;
    Toast.show(' 正在加入房间...');
    try {
      if (this.roomManager) {
        this.roomManager.leaveRoom();
        this.roomManager.destroy();
        this.roomManager = null;
      }
      this.roomManager = new RoomManager();
      this._bindRoomEvents();
      await this.roomManager.joinRoom(code, nick, spectator);
      this._roomJoined = true;
      this._showRoomCode(code);
      this._roomFormCreate.classList.add('hidden');
      this._roomFormJoin.classList.add('hidden');
      this._updateRoomPlayerList();
      this._showRoomExtras();
      this._saveRoomSession(code, nick, spectator);
      Toast.show(` 已加入房间：${code}`);
    } catch (e) {
      console.error('[Room] 加入失败:', e);
      Toast.show(' 加入失败：' + (e.message || '连接超时'));
      // 失败路径销毁 manager（_roomCleanup 不销毁，防连接残留）
      if (this.roomManager) {
        this.roomManager.destroy();
        this.roomManager = null;
      }
      this._roomCleanup();
    }
  }

  /**
   * 离开房间
   */
  _roomLeave() {
    if (this.roomManager) {
      this.roomManager.leaveRoom();
      this.roomManager.destroy();
      this.roomManager = null;
    }
    this._roomJoined = false;
    this._followedPlayerId = null;
    this._clearRoomSession();
    this.mapManager.clearPlayerMarkers();
    this.mapManager.clearPlayerPredictions();
    this.mapManager.setRemoteCircles([]);
    this._roomCleanup();
    Toast.show(' 已离开房间');
  }

  /**
   * 切换定位共享开关
   */
  _roomToggleSharing() {
    if (!this.roomManager) return;
    if (this.roomManager.isNpcTeam()) {
      Toast.show(' NPC 队持续共享，无法关闭');
      return;
    }
    const enabled = !this.roomManager.isSharingEnabled();
    this.roomManager.setSharingEnabled(enabled);
    this._updateSharingBtn();
    this._updateRoomPlayerList();
    Toast.show(enabled ? ' 已开启定位共享' : ' 已关闭定位共享，其他人将看不到你的位置');
    if (!enabled) {
      // 关闭共享时从地图移除自己的标记
      this.mapManager.clearPlayerMarkers();
      // 重绘他人标记
      const myId = this.roomManager.getMyInfo().id;
      const allTeams = this.roomManager.getTeams();
      Object.values(this.roomManager.getPlayers()).forEach((p) => {
        if (p.id !== myId && p.online) {
          const teamLabel2 = (p.teamId && allTeams[p.teamId]) ? (allTeams[p.teamId].name || '').trim().charAt(0) || '' : '';
          this.mapManager.updatePlayerMarker(p.id, p.lat, p.lng, p.name, p.color, 1, p.acc, teamLabel2);
        }
      });
    }
  }

  /**
   * 将本地电量注入 roomManager，下次 ping 时发送给其他玩家
   */
  _pushBatteryToRoom() {
    if (this.roomManager && this._batteryLevel != null) {
      this.roomManager.setBatteryInfo(this._batteryLevel, !!this._batteryCharging);
    }
  }

  /**
   * 销毁应用，清理所有定时器和事件监听器
   */
  destroy() {
    this._stopWatching();
    if (this.roomManager) {
      this.roomManager.destroy();
      this.roomManager = null;
    }
    if (this._timerInterval) {
      clearInterval(this._timerInterval);
      this._timerInterval = null;
    }
    if (this._burstEndInterval) {
      clearInterval(this._burstEndInterval);
      this._burstEndInterval = null;
    }
    if (this._burstPhaseInterval) {
      clearInterval(this._burstPhaseInterval);
      this._burstPhaseInterval = null;
    }
    if (this.mapManager) {
      this.mapManager.clearPlayerMarkers();
    }
    this.gpsManager.destroy(); // 停止 GPS + GNSS + 电池监控
    // 清理 Chart.js 实例（必须显式销毁，否则会泄漏 canvas 引用 + 动画帧）
    if (this._speedChart) {
      this._speedChart.destroy();
      this._speedChart = null;
    }
    this._destroyHistogram();
    // 清理电池事件监听器
    this._cleanupBattery();
    // 清理 mediaQuery 监听器
    if (this._panelMediaQuery && this._panelMediaqueryChange) {
      this._panelMediaQuery.removeEventListener('change', this._panelMediaqueryChange);
      this._panelMediaqueryChange = null;
    }
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this._pageHideHandler) {
      window.removeEventListener('pagehide', this._pageHideHandler);
      this._pageHideHandler = null;
    }
    if (this._pageShowHandler) {
      window.removeEventListener('pageshow', this._pageShowHandler);
      this._pageShowHandler = null;
    }
    // 清理后台定位资源
    this._exitBackgroundMode();
    this._releaseWakeLock();
    if (this._hintsTimeout) { clearTimeout(this._hintsTimeout); this._hintsTimeout = null; }
    this.mapManager.destroy();
  }

}

/* ============= 启动 ============= */

let _appInitialized = false;

function _bootApp() {
  if (_appInitialized) return;
  _appInitialized = true;
  const app = new App();
  app.init();
  // 暴露到全局便于调试
  window.app = app;
}

// DOM 就绪后启动（脚本在 </body> 前，readyState 为 interactive，两个路径可能都执行）
document.addEventListener('DOMContentLoaded', _bootApp);

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  _bootApp();
}
