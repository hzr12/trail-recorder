/**
 * 途刻 TraceCraft - 主应用控制器
 * ============================================
 * 协调 MapManager、GPSManager 与 UI 交互
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
    this.myPosition = null;
    this.myPositionTime = null;
    this._statusEl = null;
    this._isWatching = false;
    this._firstFix = true;
    this._relocating = false;
    this._lastRelocateAttempt = 0;
    this._lastRawPos = null;
    this._lastDistPos = null;
    this._lastFullUpdate = 0;
    this._panelCollapsed = window.innerWidth <= CONFIG.MOBILE_BREAKPOINT;
    this._panelUserToggled = false;
    this._watchingBeforeHide = false;
    this._restoringView = false;
    this._isBackground = false;
    this._bgLocateInterval = null;
    this._nativeBgStarted = false;
    this._lastBgNativeTime = 0;
    this._wakeLock = null;
    this._recentFixes = [];
    this._speedHistory = [];
    this._speedChart = null;
    this._speedTrackingStart = 0;
    this.trail = new Trail();
    this._followMode = false;
    this._dirty = false;
    this._trailDirty = false;
    this._lastGcj02ErrorToast = 0;
    this._lastWeatherFetch = 0;
    this._lastWeatherPos = null;
    this._lastChartUpdate = 0;
    this._intervalId = null;
    this._resizeHandler = null;
    this._visibilityHandler = null;
    this._pageHideHandler = null;
    this._pageShowHandler = null;
    this._lastSpeed = null;
    this._lastAltitude = null;
    this._lastHeading = null;
    this._batteryLevel = null;
    this._batteryCharging = false;
    this._battery = null;
    this._batteryLevelHandler = null;
    this._batteryChargingHandler = null;
    this._batteryTimeHandler = null;
    this._lowBatteryNotified = false;
    this._panelMediaQuery = null;
    this._panelMediaqueryChange = null;
    this._lastCalcPos = null;
    this._lastCalcTime = null;
    this._lastAccuracy = null;
    this._theme = 'dark';
    this._trailSmoothing = true;
    this._autoPauseEnabled = false;   // 自动暂停手动开关（默认关闭）
    this._autoPaused = false;         // 当前是否处于「静止自动暂停」状态
    this._autoPauseStart = null;      // 连续静止计时起点（时间戳）
    this._processQueue = Promise.resolve();
    this._queuePending = 0;
    this._replayPlayer = null;
    this._isReplaying = false;
    this._replaySpeed = 1;
    this._replaySegments = [];
    this._replayCurrentIndex = 0;
    this._replayFollowMode = true;
    this._onlyFav = false;
    this._replayOnlyFav = false;
    this._searchKeyword = '';
    this._timeRange = 'all';
    this._replaySearchKeyword = '';
    this._replayTimeRange = 'all';
    this._historySelected = new Set();
    this._replaySelected = new Set();
    this._multiSelect = false;
    this._trailCache = null;
    this._sortKey = 'time';
    this._replaySortKey = 'time';
  }

  _sortTrails(items, sortKey) {
    if (!items) return items;
    const key = sortKey || 'time';
    return items.slice().sort((a, b) => {
      const fa = a.favorite ? 1 : 0;
      const fb = b.favorite ? 1 : 0;
      if (fa !== fb) return fb - fa;
      if (key === 'distance') return (b.distance || 0) - (a.distance || 0);
      if (key === 'duration') return (b.duration || 0) - (a.duration || 0);
      if (key === 'points') return (b.pointCount || 0) - (a.pointCount || 0);
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  }

  _matchTimeRange(createdAt, range) {
    if (!range || range === 'all') return true;
    const d = new Date(createdAt);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (range === 'today') return d >= startOfToday;
    if (range === 'week') {
      const day = startOfToday.getDay() || 7;
      const monday = new Date(startOfToday);
      monday.setDate(startOfToday.getDate() - (day - 1));
      return d >= monday;
    }
    if (range === 'month') {
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }
    return true;
  }

  _filterTrails(items, keyword, timeRange) {
    if (!items) return items;
    const kw = (keyword || '').trim().toLowerCase();
    return items.filter((it) => {
      if (kw) {
        const d = new Date(it.createdAt || 0);
        const pad = (n) => String(n).padStart(2, '0');
        const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        const distStr = formatDistance(it.distance);
        const hay = [it.name || '', dateStr, distStr, String(it.pointCount || 0)].join(' ').toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return this._matchTimeRange(it.createdAt, timeRange);
    });
  }

  init() {
    this.mapManager.init('map', CONFIG.DEFAULT_CENTER, CONFIG.DEFAULT_ZOOM);
    this._setupUI();

    if (this._panelCollapsed) {
      this._bottomPanel.classList.add('collapsed');
    }
    this._panelMediaQuery = window.matchMedia(`(max-width: ${CONFIG.MOBILE_BREAKPOINT}px)`);
    this._panelMediaqueryChange = (e) => {
      // 用户手动切换过面板状态后，不再被断点变化强制覆盖
      if (this._panelUserToggled) return;
      this._panelCollapsed = e.matches;
      this._bottomPanel.classList.toggle('collapsed', e.matches);
    };
    this._panelMediaQuery.addEventListener('change', this._panelMediaqueryChange);

    this._restoreTheme();
    this._restoreTrailSmoothing();
    this._restoreAutoPause();
    this._loadState();
    this._updateTrailUI();
    this._syncTabSlider('record');

    window._app = this;
    this._fetchWeather();
    this._initBattery();
    this._stopStaleBg();
    this._startWatching();

    this._pageHideHandler = () => {
      if (this._isWatching) {
        this._watchingBeforeHide = true;
        this._stopWatching();
        this._enterBackgroundMode();
      }
      this._updatePowerStatus();
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

    requestAnimationFrame(() => document.body.classList.add('app-ready'));

    this._intervalId = setInterval(() => {
      if (this.myPosition) {
        this._updateStatusBar(true);
        if (this._isPositionStale() && !this._isWatching) {
          this._autoRelocate();
        }
      }
      this._saveState();
    }, CONFIG.POSITION_STALE_MS / 10);

    this._updatePowerStatus();
  }

  _setupUI() {
    this._gpsBtn = document.getElementById('gps-btn');
    this._bottomPanel = document.getElementById('bottomPanel');
    this._panelHandle = document.querySelector('.panel-handle');

    document.getElementById('trail-record-btn').addEventListener('click', () => this._toggleTrailRecording());
    document.getElementById('trail-pause-btn').addEventListener('click', () => this._stopTrailRecording());
    document.getElementById('trail-clear-btn').addEventListener('click', () => this._clearTrail());
    document.getElementById('trail-stats-btn').addEventListener('click', () => this._showTrailStats());
    document.getElementById('trail-smooth-btn').addEventListener('click', () => this._toggleTrailSmoothing());
    document.getElementById('export-report-btn').addEventListener('click', () => this._exportReport());
    document.getElementById('power-saving-btn').addEventListener('click', () => this._togglePowerSaving());
    const autoPauseBtn = document.getElementById('trail-autopause-btn');
    if (autoPauseBtn) autoPauseBtn.addEventListener('click', () => this._toggleAutoPause());

    // 回放控制面板
    const replaySlider = document.getElementById('replay-slider');
    if (replaySlider) {
      replaySlider.addEventListener('input', (e) => {
        if (this._replayPlayer && !this._replayPlayer.isPlaying) {
          const progress = parseInt(e.target.value, 10) / 1000;
          this._replayPlayer.seekToProgress(progress);
        }
      });
      replaySlider.addEventListener('change', (e) => {
        if (this._replayPlayer) {
          const progress = parseInt(e.target.value, 10) / 1000;
          this._replayPlayer.seekToProgress(progress);
        }
      });
    }

    const replayPlayBtn = document.getElementById('replay-play-btn');
    if (replayPlayBtn) {
      replayPlayBtn.addEventListener('click', () => this._toggleReplayPlay());
    }

    const replayStopBtn = document.getElementById('replay-stop-btn');
    if (replayStopBtn) {
      replayStopBtn.addEventListener('click', () => this._stopReplay());
    }

    const replayFollowBtn = document.getElementById('replay-follow-btn');
    if (replayFollowBtn) {
      replayFollowBtn.addEventListener('click', () => this._toggleReplayFollow());
    }

    document.querySelectorAll('.speed-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const speed = parseFloat(btn.dataset.speed);
        this._setReplaySpeed(speed);
      });
    });

    this._statusEl = document.getElementById('gps-status');
    this._gnssBarEl = document.getElementById('gnss-bar');

    // GPS 状态条：仅点击跟随按钮切换跟随模式，避免整条误触
    this._statusEl.addEventListener('click', (e) => {
      if (e.target.closest('.gps-follow-toggle')) this._toggleFollowMode();
    });

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

    this._panelHandle.addEventListener('click', () => {
      this._panelCollapsed = !this._panelCollapsed;
      this._panelUserToggled = true;
      this._bottomPanel.classList.toggle('collapsed', this._panelCollapsed);
    });

    document.getElementById('theme-btn').addEventListener('click', () => this._toggleTheme());

    // Tab 切换
    document.querySelectorAll('.mode-tab').forEach((btn) => {
      btn.addEventListener('click', () => this._setTab(btn.dataset.tab));
    });

    // 仅看收藏筛选
    const historyFavFilter = document.getElementById('history-fav-filter');
    if (historyFavFilter) {
      historyFavFilter.addEventListener('click', () => {
        this._onlyFav = !this._onlyFav;
        historyFavFilter.classList.toggle('active', this._onlyFav);
        this._renderTrailList();
      });
    }
    const replayFavFilter = document.getElementById('replay-fav-filter');
    if (replayFavFilter) {
      replayFavFilter.addEventListener('click', () => {
        this._replayOnlyFav = !this._replayOnlyFav;
        replayFavFilter.classList.toggle('active', this._replayOnlyFav);
        this._renderReplayTrailList();
      });
    }

    // 搜索 / 时间筛选（防抖）
    let searchTimer = null;
    const historySearch = document.getElementById('history-search');
    if (historySearch) {
      historySearch.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          this._searchKeyword = historySearch.value;
          this._renderTrailList();
        }, 200);
      });
    }
    const historyTime = document.getElementById('history-time-range');
    if (historyTime) {
      historyTime.addEventListener('change', () => {
        this._timeRange = historyTime.value;
        this._renderTrailList();
      });
    }
    const replaySearch = document.getElementById('replay-search');
    if (replaySearch) {
      replaySearch.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          this._replaySearchKeyword = replaySearch.value;
          this._renderReplayTrailList();
        }, 200);
      });
    }
    const replayTime = document.getElementById('replay-time-range');
    if (replayTime) {
      replayTime.addEventListener('change', () => {
        this._replayTimeRange = replayTime.value;
        this._renderReplayTrailList();
      });
    }

    // 排序下拉
    const historySort = document.getElementById('history-sort');
    if (historySort) {
      historySort.addEventListener('change', () => {
        this._sortKey = historySort.value;
        this._renderTrailList();
      });
    }
    const replaySort = document.getElementById('replay-sort');
    if (replaySort) {
      replaySort.addEventListener('change', () => {
        this._replaySortKey = replaySort.value;
        this._renderReplayTrailList();
      });
    }

    // 批量工具栏
    document.querySelectorAll('.header-btn#batch-select-all').forEach((selectAllBtn) => {
      selectAllBtn.addEventListener('click', () => this._selectAll(true));
    });
    const batchExport = document.getElementById('batch-export');
    if (batchExport) {
      batchExport.addEventListener('click', () => this._exportSelectedImages());
    }
    const batchMerge = document.getElementById('batch-merge');
    if (batchMerge) {
      batchMerge.addEventListener('click', () => this._mergeSelectedTrails());
    }
    const batchDelete = document.getElementById('batch-delete');
    if (batchDelete) {
      batchDelete.addEventListener('click', () => this._deleteSelectedTrails());
    }
    const batchClear = document.getElementById('batch-clear');
    if (batchClear) {
      batchClear.addEventListener('click', () => this._toggleMultiSelect(false));
    }
    const batchInvert = document.getElementById('batch-invert');
    if (batchInvert) {
      batchInvert.addEventListener('click', () => this._invertSelection());
    }
    this._syncBatchToolbar();
  }

  _toggleGps() {
    if (this._isWatching) {
      this._stopWatching();
    } else {
      this._startWatching();
    }
  }

  _setTab(tab) {
    this._currentTab = tab;
    document.querySelectorAll('.mode-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    this._syncTabSlider(tab);
    const recordEl = document.getElementById('tab-record');
    const replayEl = document.getElementById('tab-replay');
    const historyEl = document.getElementById('tab-history');
    if (recordEl) recordEl.style.display = tab === 'record' ? '' : 'none';
    if (replayEl) replayEl.style.display = tab === 'replay' ? '' : 'none';
    if (historyEl) historyEl.style.display = tab === 'history' ? '' : 'none';
    // 重触发内容淡入动画（强制 reflow 使相同元素重复播放）
    const targetEl = tab === 'record' ? recordEl : (tab === 'replay' ? replayEl : historyEl);
    if (targetEl) {
      targetEl.classList.remove('tab-pane');
      void targetEl.offsetWidth;
      targetEl.classList.add('tab-pane');
    }
    if (tab === 'history') this._renderTrailList();
    if (tab === 'replay') this._renderReplayTrailList();
  }

  /**
   * 让滑动胶囊指示器对齐当前激活 Tab（含回放橙色语义 data-tab）
   */
  _syncTabSlider(tab) {
    const tabs = document.getElementById('mode-tabs');
    if (!tabs) return;
    const activeBtn = tabs.querySelector('.mode-tab.active');
    const slider = tabs.querySelector('.mode-tab-slider');
    if (!activeBtn || !slider) return;
    tabs.setAttribute('data-tab', tab);
    slider.style.left = `${activeBtn.offsetLeft}px`;
    slider.style.width = `${activeBtn.offsetWidth}px`;
  }

  async _locateMe() {
    if (this._isWatching) return;
    if (this._relocating) return;
    this._relocating = true;

    this._gpsBtn.classList.add('loading');
    this._gpsBtn.disabled = true;

    try {
      const pos = await this.gpsManager.getCurrentPosition();
      const convPos = await this.mapManager.wgs84ToGcj02(pos);

      this.myPosition = convPos;
      this.myPositionTime = Date.now();
      this._lastSpeed = pos.speed;
      this._lastAltitude = pos.altitude;
      this._lastHeading = pos.heading;
      this._lastCalcPos = { lat: convPos.lat, lng: convPos.lng };
      this._lastCalcTime = pos.timestamp || Date.now();
      this._lastAccuracy = pos.accuracy;
      this._recordFix(pos, convPos);

      this.mapManager.setLocation(convPos, pos.accuracy, pos.heading);
      this.mapManager.flyTo(convPos);

      this._updateStatusBar(true);

      this._gpsBtn.classList.add('located');
      setTimeout(() => this._gpsBtn.classList.remove('located'), CONFIG.LOCATED_ANIM_MS);

      Toast.show(` 定位成功（精度 ±${pos.accuracy.toFixed(0)} 米）`);

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

  _startWatching() {
    if (this._isWatching || this._isBackground) return;

    this._isWatching = true;
    this._firstFix = true;
    if (!this._restoringView) {
      this._followMode = false;
    }
    this._restoringView = false;
    if (!this._speedHistory.length) this._speedTrackingStart = Date.now();
    this._showSpeedChart();

    this._gpsBtn.classList.add('watching');
    this._gpsBtn.title = '正在持续追踪位置';

    this.gpsManager.onPositionChange = (pos) => {
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
        .then(() => this._processPosition(pos))
        .catch(() => {})
        .finally(() => { if (this._queuePending > 0) this._queuePending--; });
    };
    this.gpsManager.onError = (err) => {
      if (CONFIG.DEBUG) console.warn('[GPS] 追踪出错:', err.message);
      Toast.show(' ' + err.message);
    };
    this.gpsManager.onDowngrade = () => {
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

  _stopWatching() {
    if (!this._isWatching) return;
    this._isWatching = false;

    this.gpsManager.stopWatching();
    this.gpsManager.onPositionChange = null;
    this.gpsManager.onError = null;
    this.gpsManager.onDowngrade = null;
    this.gpsManager.onRecovery = null;
    this.gpsManager.onRestoreTracking = null;
    this._hideSpeedChart();

    this._speedHistory = [];
    if (this._speedChart) {
      this._speedChart.data.datasets[0].data = [];
      this._speedChart.update('none');
    }

    this._gpsBtn.classList.remove('watching');
    this._gpsBtn.title = '定位到我的位置';

    Toast.show(' 持续追踪已关闭');
  }

  _stopStaleBg() {
    if (!this._hasNativeBgPlugin()) return;
    try {
      Capacitor.Plugins.BackgroundGeolocation.stop();
    } catch (e) {}
  }

  _hasNativeBgPlugin() {
    return typeof Capacitor !== 'undefined'
      && Capacitor.isNativePlatform()
      && Capacitor.Plugins
      && Capacitor.Plugins.BackgroundGeolocation;
  }

  async _startNativeBackgroundTracking() {
    try {
      const plugin = Capacitor.Plugins.BackgroundGeolocation;
      await plugin.start({
        backgroundMessage: '正在后台追踪位置，关闭以省电',
        backgroundTitle: 'TraceCraft 定位中',
        distanceFilter: 10,
        requestPermissions: true,
        stale: false,
      }, (location, error) => {
        if (error || !location) return;
        const now = Date.now();
        // 有电时 5s/次上报后台位置
        if (now - this._lastBgNativeTime < 5000) return;
        this._lastBgNativeTime = now;
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
    } catch (e) {
      this._nativeBgStarted = false;
      this._fallbackBackgroundLocate();
    }
  }

  async _stopNativeBackgroundTracking() {
    try {
      await Capacitor.Plugins.BackgroundGeolocation.stop();
    } catch (e) {}
    this._nativeBgStarted = false;
  }

  _enterBackgroundMode() {
    if (this._isBackground) return;
    this._isBackground = true;

    if (!this.gpsManager.isPowerSaving) {
      this._requestWakeLock();
    }

    if (this._hasNativeBgPlugin()) {
      this._startNativeBackgroundTracking();
    } else {
      this._fallbackBackgroundLocate();
    }
  }

  _fallbackBackgroundLocate() {
    // 省电模式 20s/次，有电时 5s/次
    const interval = this.gpsManager.isPowerSaving ? 20000 : 5000;
    this._backgroundLocate();
    if (this._bgLocateInterval) clearInterval(this._bgLocateInterval);
    this._bgLocateInterval = setInterval(() => {
      this._backgroundLocate();
    }, interval);
  }

  _exitBackgroundMode() {
    this._isBackground = false;

    if (this._nativeBgStarted) {
      this._stopNativeBackgroundTracking();
    }

    if (this._bgLocateInterval) {
      clearInterval(this._bgLocateInterval);
      this._bgLocateInterval = null;
    }

    this._releaseWakeLock();
  }

  async _backgroundLocate() {
    if (this.gpsManager.isPowerSaving && this._batteryLevel != null && this._batteryLevel < 0.1) {
      return;
    }
    try {
      const pos = await this.gpsManager.getCurrentPosition(30000);
      await this._processBackgroundPosition(pos);
    } catch (e) {}
  }

  async _processBackgroundPosition(pos) {
    if (!this._isBackground) return;
    try {
      const convPos = await this.mapManager.wgs84ToGcj02(pos);
      if (!this._isBackground) return;
      this.myPosition = convPos;
      this.myPositionTime = Date.now();
      this._lastAccuracy = pos.accuracy;
      this._lastSpeed = pos.speed;
      this._lastAltitude = pos.altitude;
      this._lastHeading = pos.heading;
      this._lastCalcPos = { lat: convPos.lat, lng: convPos.lng };
      this._lastCalcTime = pos.timestamp || Date.now();
      this.mapManager.setLocation(convPos, pos.accuracy, pos.heading);

      this._recordFix(pos, convPos, false, true);

      // 静止自动暂停检查（后台定位同样生效，仅手动开关开启时）
      this._checkAutoPause(pos.speed, pos.timestamp || Date.now());

      // 回放期间允许记录继续采集（并行模式）：记录轨迹线与回放路径分属不同 zIndex 层，互不遮挡
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
          this.mapManager.setRealtimeKeyPoints(TrailAnalysis.analyzeKeyPoints(this.trail.positions));
        }
      }

      this._saveState();
    } catch (e) {
      if (CONFIG.DEBUG) console.error('[Background] _processBackgroundPosition error:', e.message);
    }
  }

  async _requestWakeLock() {
    if (typeof navigator.wakeLock === 'undefined') return;
    if (this._wakeLock) return;
    try {
      this._wakeLock = await navigator.wakeLock.request('screen');
      this._wakeLock.addEventListener('release', () => {
        this._wakeLock = null;
      });
    } catch (e) {
      this._wakeLock = null;
    }
  }

  _releaseWakeLock() {
    if (!this._wakeLock) return;
    try {
      this._wakeLock.release();
    } catch (e) {}
    this._wakeLock = null;
  }

  _getTrailPositions() {
    return this._trailSmoothing
      ? this.trail.getSmoothedPositions()
      : this.trail.positions;
  }

  _clearTrail() {
    if (this._isReplaying) {
      this._stopReplay();
    }

    const savedPositions = this.trail.positions.slice();
    const savedLastPos = this.trail.lastPos;
    const savedRecording = this.trail.isRecording;
    const savedPaused = this.trail.isPaused;

    this.trail.clear();
    this.mapManager.clearTrail();
    this.mapManager.clearTrailMarkers();
    this._updateTrailUI();
    this._trailDirty = true;
    Storage.clearTrail();

    Toast.showUndo('轨迹已清除', () => {
      this.trail.restore(savedPositions, savedLastPos);
      this.trail.isRecording = savedRecording;
      this.trail.isPaused = savedPaused;
      if (savedPositions.length >= 2) {
        this.mapManager.setTrail(this._getTrailPositions());
        this.mapManager.setTrailMarkers(TrailAnalysis.analyzeKeyPoints(savedPositions));
      }
      this._updateTrailUI();
      this._trailDirty = false;
      Storage.saveTrail(this.trail);
    });
  }

  _toggleTrailRecording() {
    if (this._isReplaying) {
      Toast.show(' 回放中无法记录，请先停止回放');
      return;
    }
    if (!this.trail.isRecording) {
      // 未记录：开始记录
      this.trail.start();
      // 新一轮记录重置自动暂停状态
      this._autoPaused = false;
      this._autoPauseStart = null;
      // 清空原始测量缓冲，RTS 离线平滑只针对本次记录
      if (this.gpsManager) this.gpsManager.clearRawFixes();
      this.mapManager.clearTrail();
      this.mapManager.clearTrailMarkers();
      this.mapManager.clearRealtimeKeyPoints();
      Toast.show(' 轨迹记录已开始');
    } else if (this.trail.isPaused) {
      // 记录中且已暂停：继续记录
      this.trail.resume();
      this._trailDirty = true;
      Toast.show(' 轨迹记录已继续');
      // 手动继续接管暂停状态，清除自动暂停相关标志
      this._autoPaused = false;
      this._autoPauseStart = null;
    } else {
      // 记录中且未暂停：暂停记录
      this.trail.pause();
      Toast.show(' 轨迹记录已暂停');
      // 手动暂停接管暂停状态，清除自动暂停相关标志
      this._autoPaused = false;
      this._autoPauseStart = null;
    }
    this._updateTrailUI();
  }

  _stopTrailRecording() {
    if (!this.trail.isRecording) return;
    const pointCount = this.trail.positions.length;
    this.trail.stop();
    // 停止记录清理自动暂停状态
    this._autoPaused = false;
    this._autoPauseStart = null;
    this._trailDirty = true;
    if (pointCount === 0) {
      Storage.clearTrail();
      Toast.show(' 未记录到轨迹数据');
    } else {
      // 停止记录：先用本次记录的全部原始测量做一次离线 RTS 平滑，
      // 把平滑后的坐标（WGS84→GCJ02）写回轨迹点，再保存
      this._applyTrailRtsSmoothing();
      Storage.saveTrail(this.trail);
      this._saveCurrentTrail();
      // 停止记录：实时关键点层转成固定标记
      this.mapManager.clearRealtimeKeyPoints();
      this.mapManager.setTrailMarkers(TrailAnalysis.analyzeKeyPoints(this.trail.positions));
      Toast.show(' 轨迹记录已停止');
    }
    this._updateTrailUI();
  }

  /**
   * 对刚停止记录的轨迹做 RTS 离线平滑（结束记录时的后处理）
   * 数据流：GPSManager._rawFixes（WGS84 原始测量）→ KalmanFilter.smoothTrail
   * → 平滑 WGS84 → batchWgs84ToGcj02 → 按 ts 匹配写回 trail.positions。
   * 匹配失败的点（如时间戳缺失）保留原值；无原始测量时静默跳过。
   */
  _applyTrailRtsSmoothing() {
    if (!this.gpsManager || !this.trail.positions || !this.trail.positions.length) return;
    try {
      // 取走并清空原始测量缓冲（smoothTrailRts 内部已清空）
      const smoothed = this.gpsManager.smoothTrailRts();
      if (!smoothed || smoothed.length < 2) return;
      // 平滑输出为 WGS84 → 批量转 GCJ02（同步手写算法）
      const gcj = this.mapManager.batchWgs84ToGcj02(smoothed);
      // 建立 ts → 平滑坐标 映射（ts 为原始 GPS 时间戳）
      const byTs = new Map();
      for (let i = 0; i < smoothed.length; i++) {
        if (smoothed[i].ts != null) byTs.set(smoothed[i].ts, gcj[i]);
      }
      let replaced = 0;
      for (const pt of this.trail.positions) {
        const smooth = byTs.get(pt.time);
        if (smooth) {
          pt.lat = smooth.lat;
          pt.lng = smooth.lng;
          replaced++;
        }
      }
      if (CONFIG.DEBUG) {
        console.log(`[RTS] 平滑 ${smoothed.length} 点，替换 ${replaced}/${this.trail.positions.length} 个轨迹点`);
      }
      // 刷新地图轨迹线
      this.mapManager.setTrail(this._getTrailPositions());
    } catch (e) {
      if (CONFIG.DEBUG) console.warn('[RTS] 平滑失败，保留原始轨迹:', e);
    }
  }

  /**
   * 切换「自动暂停」手动开关（默认关闭，localStorage 持久化）
   * 关闭时若有正在进行的自动暂停，先手动恢复记录，避免记录被卡在暂停态。
   */
  _toggleAutoPause() {
    this._autoPauseEnabled = !this._autoPauseEnabled;
    try {
      localStorage.setItem(CONFIG.AUTO_PAUSE_STORAGE_KEY, this._autoPauseEnabled ? '1' : '0');
    } catch (e) {}
    if (!this._autoPauseEnabled) {
      // 关闭开关：若正处自动暂停中，先恢复记录并清标志
      if (this._autoPaused && this.trail.isRecording && this.trail.isPaused) {
        this.trail.resume();
        this._trailDirty = true;
        Toast.show(' 自动暂停已关闭，记录已继续');
      }
      this._autoPaused = false;
      this._autoPauseStart = null;
    } else {
      this._autoPauseStart = null;
      Toast.show(' 自动暂停已开启');
    }
    this._updateTrailUI();
  }

  /**
   * 静止自动暂停检查（仅开关开启时生效，O(1) 增量状态）
   * 连续低速超窗 → 自动暂停计时；恢复移动超阈值 → 自动继续记录。
   * 不覆盖用户手动暂停状态：仅当 trail.isPaused 为 false 时才自动暂停，
   * 仅当 _autoPaused 为 true（且用户未手动接管）时才自动恢复。
   * @param {number|null|undefined} speed 当前速度（m/s）
   * @param {number} time 定位时间戳（ms）
   */
  _checkAutoPause(speed, time) {
    if (!this._autoPauseEnabled) return;
    if (!this.trail.isRecording) {
      this._autoPaused = false;
      this._autoPauseStart = null;
      return;
    }
    const now = time || Date.now();

    if (typeof speed === 'number' && speed >= 0 && speed < CONFIG.AUTO_PAUSE_SPEED) {
      // 低速：开始/延续静止计时
      if (!this._autoPauseStart) this._autoPauseStart = now;
      if (this._autoPauseStart && (now - this._autoPauseStart) >= CONFIG.AUTO_PAUSE_WINDOW_S * 1000) {
        if (!this.trail.isPaused && !this._autoPaused) {
          this.trail.pause();
          this._autoPaused = true;
          this._autoPauseStart = null;
          this._trailDirty = true;
          this._updateTrailUI();
          Toast.show(' 已自动暂停（静止）');
        }
      }
    } else if (typeof speed === 'number' && speed > CONFIG.AUTO_PAUSE_RESUME_SPEED) {
      // 恢复移动：仅当处于自动暂停态且未被手动接管时自动继续
      if (this._autoPaused && this.trail.isPaused) {
        this.trail.resume();
        this._autoPaused = false;
        this._autoPauseStart = null;
        this._trailDirty = true;
        this._updateTrailUI();
        Toast.show(' 自动恢复记录');
      } else {
        this._autoPauseStart = null;
      }
    }
  }

  _toggleTrailSmoothing() {
    this._trailSmoothing = !this._trailSmoothing;
    try {
      localStorage.setItem('trailcraft_trail_smooth', this._trailSmoothing ? '1' : '0');
    } catch (e) {}
    if (this.trail.positions.length >= 2) {
      this.mapManager.setTrail(this._getTrailPositions());
    }
    this._updateTrailUI();
    Toast.show(this._trailSmoothing ? ' 轨迹平滑已开启' : ' 轨迹平滑已关闭');
  }

  // ===== 轨迹回放功能 =====

  _toggleReplay() {
    if (this._isReplaying) {
      this._stopReplay();
      Toast.show(' 回放已停止');
      return;
    }

    // 并行模式：允许记录中回放当前已采集的轨迹（回放与记录互不干扰）
    const positions = this._getTrailPositions();
    if (!positions || positions.length < 2) {
      Toast.show(' 轨迹点数不足，无法回放');
      return;
    }

    this._setTab('replay');
    this._startReplay(positions);
  }

  _startReplay(positions, trailName) {
    this._isReplaying = true;
    document.body.classList.add('replay-mode');
    this._replayFollowMode = true;

    if (this._replayPlayer) {
      this._replayPlayer.destroy();
      this._replayPlayer = null;
    }

    // 清除地图上残留的普通轨迹线（如加载/清洗历史轨迹留下的 zIndex 10 旧线）。
    // 回放有独立的完整路径视觉体系（zIndex 100+），若旧线数据与回放数据不一致
    //（典型场景：先加载轨迹再清洗，地图旧线是清洗前数据），会与回放路径叠加显示成"双轨迹"。
    // 并行记录模式除外：记录轨迹线继续在后台增量绘制，与回放路径分属不同 zIndex 层。
    if (!(this.trail.isRecording && !this.trail.isPaused)) {
      this.mapManager.clearTrail();
    }

    this._replayPlayer = new TrailPlayer(positions, this.mapManager, {
      onProgress: (progress) => this._onReplayProgress(progress),
      onComplete: () => this._onReplayComplete(),
      onFrame: (point, index) => this._onReplayFrame(point, index)
    });

    // 预计算分段，供回放实时显示当前段；回放有独立视觉体系，清掉关键点标记
    this._replaySegments = TrailAnalysis.analyzeSegments(positions);
    this._replayCurrentIndex = 0;
    this.mapManager.clearTrailMarkers();

    this._replayPlayer.setSpeed(this._replaySpeed);

    // 显示回放面板，隐藏空状态
    const replayPanel = document.getElementById('replay-panel');
    if (replayPanel) {
      replayPanel.classList.remove('hidden');
    }
    const replayEmpty = document.getElementById('replay-empty');
    if (replayEmpty) {
      replayEmpty.classList.add('hidden');
    }
    const replayTitle = document.getElementById('replay-title');
    if (replayTitle) {
      replayTitle.textContent = trailName ? `回放: ${trailName}` : '轨迹回放';
    }

    this._updateReplayUI();

    Toast.show(' 开始轨迹回放');
  }

  _stopReplay() {
    this._isReplaying = false;
    document.body.classList.remove('replay-mode');

    if (this._replayPlayer) {
      this._replayPlayer.destroy();
      this._replayPlayer = null;
    }

    this.mapManager.clearRealtimeKeyPoints();

    const replayPanel = document.getElementById('replay-panel');
    if (replayPanel) {
      replayPanel.classList.add('hidden');
    }
    const replayEmpty = document.getElementById('replay-empty');
    if (replayEmpty) {
      replayEmpty.classList.remove('hidden');
    }

    // 恢复真实位置标记
    if (this.myPosition) {
      this.mapManager.setLocation(
        { lat: this.myPosition.lat, lng: this.myPosition.lng },
        this._lastAccuracy || 0,
        this._lastHeading
      );
    }
  }

  _toggleReplayPlay() {
    if (!this._replayPlayer) return;

    if (this._replayPlayer.isPlaying) {
      this._replayPlayer.pause();
      // 暂停即解锁追踪：地图不再跟随回放点，用户可自由拖动浏览
      this._replayFollowMode = false;
      // 解锁 GPS 状态栏的跟随按钮：恢复为可操作的定位跟随，刷新按钮状态
      this._followMode = false;
      this._updateStatusBar(true);
    } else {
      // 继续播放时恢复地图跟随
      this._replayFollowMode = true;
      this._replayPlayer.play();
    }

    this._updateReplayUI();
  }

  /**
   * 切换回放跟随模式：开启时地图中心跟随回放点移动，关闭时自由浏览
   */
  _toggleReplayFollow() {
    if (!this._replayPlayer) return;
    this._replayFollowMode = !this._replayFollowMode;
    // 开启跟随时，立即把地图中心对齐到当前回放点
    if (this._replayFollowMode) {
      const info = this._replayPlayer.getCurrentInfo();
      if (info && info.currentPoint) {
        this._panToReplayPoint(info.currentPoint);
      }
    }
    this._updateReplayUI();
    Toast.show(this._replayFollowMode ? ' 已开启轨迹跟随' : ' 已关闭轨迹跟随（可自由浏览）');
  }

  _setReplaySpeed(speed) {
    this._replaySpeed = speed;
    if (this._replayPlayer) {
      this._replayPlayer.setSpeed(speed);
    }
    this._updateReplayUI();
  }

  _onReplayProgress(progress) {
    const slider = document.getElementById('replay-slider');
    if (slider && document.activeElement !== slider) {
      slider.value = Math.round(progress * 1000);
    }

    const timeEl = document.getElementById('replay-time');
    if (timeEl && this._replayPlayer) {
      const info = this._replayPlayer.getCurrentInfo();
      const elapsed = TrailPlayer.formatDuration(info.elapsedMs);
      const total = TrailPlayer.formatDuration(info.elapsedMs + info.remainingMs);
      timeEl.textContent = `${elapsed} / ${total}`;
    }

    this._updateReplayInfo();
  }

  _onReplayFrame(point, index) {
    this._replayCurrentIndex = index;
    if (this._replayFollowMode && this.mapManager.map) {
      this._panToReplayPoint(point);
    }
  }

  /**
   * 持续追踪：地图中心每帧跟随回放点（无动画 setCenter，相邻帧位移小则视觉平滑连续）。
   * 不使用带动画的 panTo（每帧调用会互相打断导致地图抖动）。
   */
  _panToReplayPoint(point) {
    const map = this.mapManager.map;
    if (!map) return;
    map.setCenter(new qq.maps.LatLng(point.lat, point.lng));
  }

  _onReplayComplete() {
    // 回放自然结束：同步解锁追踪模式，地图恢复自由浏览
    this._replayFollowMode = false;
    this._updateReplayUI();
    Toast.show(' 回放完成');
  }

  _updateReplayUI() {
    if (!this._replayPlayer) return;

    const playBtn = document.getElementById('replay-play-btn');
    if (playBtn) {
      const isPlaying = this._replayPlayer.isPlaying;
      playBtn.classList.toggle('playing', isPlaying);
      if (isPlaying) {
        playBtn.querySelector('svg').innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
      } else {
        playBtn.querySelector('svg').innerHTML = '<polygon points="6,4 20,12 6,20"/>';
      }
    }

    const followBtn = document.getElementById('replay-follow-btn');
    if (followBtn) {
      const on = !!this._replayFollowMode;
      followBtn.classList.toggle('active', on);
      followBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    document.querySelectorAll('.speed-btn').forEach((btn) => {
      btn.classList.toggle('active', parseFloat(btn.dataset.speed) === this._replaySpeed);
    });

    this._updateReplayInfo();
  }

  _updateReplayInfo() {
    const infoEl = document.getElementById('replay-info');
    if (!infoEl || !this._replayPlayer) return;

    const info = this._replayPlayer.getCurrentInfo();
    // 钳制到非负：GPS 可能上报负速度，避免回放面板显示负数
    const speedKmh = Math.max(0, info.currentSpeed || 0) * 3.6;
    const direction = bearingToDir(info.currentHeading || 0);
    const elapsed = TrailPlayer.formatDuration(info.elapsedMs);
    const remaining = TrailPlayer.formatDuration(info.remainingMs);
    const seg = TrailAnalysis.segmentAt(this._replaySegments, this._replayCurrentIndex || 0);

    const html = `
      进度: ${elapsed} | 剩余: ${remaining}<br>
      速度: <span class="speed-val">${speedKmh.toFixed(1)} km/h</span> | 方向: ${direction} | 距离: ${formatDistance(info.distance)}<br>
      当前段: <span class="segment-val">${seg ? seg.label : '--'}</span>
    `;
    // 仅在内容变化时更新 DOM，避免每帧重排导致的面板抖动/卡顿
    if (infoEl._lastHtml !== html) {
      infoEl._lastHtml = html;
      infoEl.innerHTML = html;
    }
  }

  _restoreTrailSmoothing() {
    try {
      const pref = localStorage.getItem('trailcraft_trail_smooth');
      if (pref !== null) this._trailSmoothing = pref === '1';
    } catch (e) {}
  }

  _restoreAutoPause() {
    try {
      const pref = localStorage.getItem(CONFIG.AUTO_PAUSE_STORAGE_KEY);
      this._autoPauseEnabled = pref === '1';
    } catch (e) {
      this._autoPauseEnabled = false;
    }
  }

  // ===== 轨迹列表管理 =====

  _saveCurrentTrail() {
    if (!this.trail.positions || this.trail.positions.length === 0) return;
    const positions = this.trail.positions.slice();
    const name = Storage._fmtTrailName(Date.now());
    Storage.saveTrailToList(positions, name, false).then((id) => {
      if (id) {
        this._invalidateTrailCache();
        Toast.show(' 轨迹已保存');
      }
    });
  }

  _loadTrailListCached() {
    if (this._trailCache) return Promise.resolve(this._trailCache);
    return Storage.loadTrailList().then((items) => {
      this._trailCache = items || [];
      return this._trailCache;
    });
  }

  _invalidateTrailCache() {
    this._trailCache = null;
  }

  _renderTrailList() {
    const listEl = document.getElementById('trail-list');
    if (!listEl) return;
    this._loadTrailListCached().then((items) => {
      if (!items || items.length === 0) {
        listEl.innerHTML = '<div class="trail-list-empty">暂无历史轨迹</div>';
        return;
      }
      let list = this._onlyFav ? items.filter((i) => i.favorite) : items;
      list = this._filterTrails(list, this._searchKeyword, this._timeRange);
      list = this._sortTrails(list, this._sortKey);
      if (list.length === 0) {
        listEl.innerHTML = '<div class="trail-list-empty">没有匹配的轨迹</div>';
        return;
      }
      listEl.innerHTML = list.map((item) => this._trailItemHTML(item, false)).join('');
      this._bindTrailItemEvents(listEl, false);
      this._syncBatchToolbar();
    });
  }

  _replayTrailFromList(id) {
    Storage.loadTrailById(id).then((data) => {
      if (!data || !data.positions || data.positions.length < 2) {
        Toast.show(' 轨迹数据不足');
        return;
      }

      // 停止当前回放
      if (this._isReplaying) {
        this._stopReplay();
      }

      // 切换到回放 Tab
      this._setTab('replay');

      // 回放使用独立数据源，不写入 this.trail：
      // 若正在记录，记录轨迹继续在后台采集/显示，回放轨迹与记录轨迹互不污染、并行共存
      Toast.show(` 已加载「${data.name}」（${data.positions.length} 点）`);

      // 自动开始回放
      setTimeout(() => {
        this._startReplay(data.positions, data.name);
      }, 300);
    });
  }

  _renderReplayTrailList() {
    const listEl = document.getElementById('replay-trail-list');
    if (!listEl) return;
    this._loadTrailListCached().then((items) => {
      if (!items || items.length === 0) {
        listEl.innerHTML = '<div class="trail-list-empty">暂无历史轨迹</div>';
        return;
      }
      let list = this._replayOnlyFav ? items.filter((i) => i.favorite) : items;
      list = this._filterTrails(list, this._replaySearchKeyword, this._replayTimeRange);
      list = this._sortTrails(list, this._replaySortKey);
      if (list.length === 0) {
        listEl.innerHTML = '<div class="trail-list-empty">没有匹配的轨迹</div>';
        return;
      }
      listEl.innerHTML = list.map((item) => this._trailItemHTML(item, true)).join('');
      this._bindTrailItemEvents(listEl, true);
      this._syncBatchToolbar();
    });
  }

  _loadTrailFromList(id) {
    Storage.loadTrailById(id).then((data) => {
      if (!data || !data.positions || data.positions.length < 2) {
        Toast.show(' 轨迹数据不足');
        return;
      }
      // 历史轨迹仅加载显示到地图，不污染 trail 容器：
      // 若正在记录，记录数据保持独立（并行），加载查看不影响采集
      this.mapManager.setTrail(data.positions);
      this.mapManager.setTrailMarkers(TrailAnalysis.analyzeKeyPoints(data.positions));
      // 未记录时同步到 trail 容器，保留「回放当前轨迹」能力；记录中则跳过避免覆盖记录数据
      if (!this.trail.isRecording) {
        this.trail.clear();
        this.trail.positions = data.positions;
        this.trail.lastPos = data.positions[data.positions.length - 1];
      }
      this._updateTrailUI();
      this._setTab('record');
      Toast.show(` 已加载「${data.name}」（${data.positions.length} 点）`);
    });
  }

  _deleteTrailFromList(id) {
    const item = document.querySelector(`.trail-list-item[data-id="${id}"]`);
    const name = item ? (item.querySelector('.trail-item-name')?.textContent || '') : '';
    Storage.deleteTrail(id).then((ok) => {
      if (ok) {
        this._invalidateTrailCache();
        Toast.showUndo(`已删除「${name}」`, () => {
          Storage.loadTrailById(id).then((data) => {
            if (data && data.positions) {
              Storage.saveTrailToList(data.positions, name, data.favorite);
              this._invalidateTrailCache();
              this._renderTrailList();
              this._renderReplayTrailList();
            }
          });
        });
        this._renderTrailList();
      }
    });
  }

  /**
   * 将历史轨迹导出为单张轨迹图片（含标题与统计）
   */
  _exportTrailImage(id) {
    Storage.loadTrailById(id).then(async (data) => {
      if (!data || !data.positions || data.positions.length < 2) {
        Toast.show('轨迹数据不足，无法导出');
        return;
      }
      const stats = this._computeTrailStats(data.positions);
      Toast.show('正在生成轨迹图片…');
      const dataUrl = await this.mapManager.renderTrailThumbnail(data.positions, {
        title: data.name || '轨迹',
        stats: { distance: stats.distance, duration: stats.duration, points: data.positions.length },
        disclaimer: true
      });
      if (!dataUrl) {
        Toast.show('导出失败，请重试');
        return;
      }
      const safeName = (data.name || '轨迹').replace(/[\\/:*?"<>|]/g, '_');
      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = `途刻-${safeName}-${dateStr}.png`;
      // dataURL → Blob：移动端/Capacitor 中 a[download] 会被忽略，改用 toBlob + 原生分享/Blob URL
      this._downloadDataUrl(dataUrl, filename);
    });
  }

  /**
   * 生成并分享轨迹分享卡片（覆盖原「导出轨迹图片」）
   * 分享链路与 _exportReport 相同：原生 Capacitor Filesystem+Share 系统分享 / Web 端 Blob URL 下载。
   * 绘制前可选做只读清洗（剔除首尾漂移段/异常点），仅用于卡片渲染，不落库不污染原数据。
   */
  async _exportShareCard(id) {
    const data = await Storage.loadTrailById(id);
    if (!data || !data.positions || data.positions.length < 2) {
      Toast.show('轨迹数据不足，无法分享');
      return;
    }
    // 只读清洗：trimEndpoints + filterOutliers，仅用于卡片绘制
    let cardPositions = data.positions;
    if (cardPositions.length >= 3) {
      let cleaned = TrailAnalysis.trimEndpoints(cardPositions);
      cleaned = TrailAnalysis.filterOutliers(cleaned);
      if (cleaned.length >= 2) cardPositions = cleaned;
    }
    const stats = this._computeTrailStats(cardPositions);
    Toast.show('正在生成分享卡片…');
    const dataUrl = await this.mapManager.renderShareCard({
      positions: cardPositions,
      name: data.name || '轨迹',
      createdAt: data.createdAt
    }, {
      stats: { distance: stats.distance, duration: stats.duration, points: cardPositions.length }
    });
    if (!dataUrl) {
      Toast.show('生成分享卡片失败，请重试');
      return;
    }
    const safeName = (data.name || '轨迹').replace(/[\\/:*?"<>|]/g, '_');
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `途刻-${safeName}-${dateStr}.png`;
    // 复用 _exportReport 的分享链路（原生系统分享 / Web 下载）
    this._downloadDataUrl(dataUrl, filename, {
      title: '途刻分享卡片',
      text: `途刻 — ${data.name || '轨迹'}`,
      dialogTitle: '分享或保存分享卡片'
    });
  }

  /**
   * 清洗历史轨迹：剔除起点/终点静止漂移段与异常漂移点（数据纠偏）
   * 清洗后重算 distance/duration/pointCount 并写回，打 cleaned 标记。
   * 纯函数处理（不修改原始数组），仅当点数有变化才落库，避免无意义写入。
   */
  async _cleanTrail(id) {
    const data = await Storage.loadTrailById(id);
    if (!data || !data.positions || data.positions.length < 2) {
      Toast.show('轨迹数据不足，无法清洗');
      return;
    }
    Toast.show('正在清洗轨迹…');
    let cleaned = TrailAnalysis.trimEndpoints(data.positions);
    cleaned = TrailAnalysis.filterOutliers(cleaned);

    const before = data.positions.length;
    const after = cleaned.length;
    if (after < 2) {
      Toast.show('清洗后点数不足，已保留原轨迹');
      return;
    }
    if (after === before) {
      Toast.show('轨迹已较干净，无需清洗');
      return;
    }

    const stats = this._computeTrailStats(cleaned);
    const ok = await Storage.updateTrailMeta(id, {
      positions: cleaned,
      distance: stats.distance,
      duration: stats.duration,
      pointCount: stats.points,
      cleaned: true
    });
    if (!ok) {
      Toast.show('清洗保存失败，请重试');
      return;
    }
    this._invalidateTrailCache();
    this._renderTrailList();
    this._renderReplayTrailList();
    Toast.show(`已清洗轨迹：${before} → ${after} 点`);
  }

  /**
   * 下载/分享 dataURL 图片（兼容 web 与 Capacitor 原生环境）
   * 原生：写入缓存目录并调起系统分享；web：Blob URL + a[download]。
   * @param {string} dataUrl PNG dataURL
   * @param {string} filename 文件名
   * @param {Object} [shareMeta] {title,text,dialogTitle} 自定义原生分享文案（默认轨迹图片）
   */
  _downloadDataUrl(dataUrl, filename, shareMeta) {
    // dataURL → Blob（兼容含中文的 SVG dataURI 与 PNG base64）
    const fetchBlob = () =>
      fetch(dataUrl).then((r) => r.blob()).catch(() => null);

    fetchBlob().then((blob) => {
      if (!blob) {
        Toast.show('导出失败，请重试');
        return;
      }
      if (typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform()) {
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = String(reader.result || '').split(',')[1] || '';
          Capacitor.Plugins.Filesystem.writeFile({
            path: filename,
            data: base64,
            directory: 'CACHE'
          }).then((result) => {
            return Capacitor.Plugins.Share.share({
              title: (shareMeta && shareMeta.title) || '途刻轨迹图片',
              text: (shareMeta && shareMeta.text) || filename,
              url: result.uri,
              dialogTitle: (shareMeta && shareMeta.dialogTitle) || '分享或保存轨迹图片'
            });
          }).then(() => {
            Toast.show('轨迹图片已导出');
          }).catch((e) => {
            console.warn('[Export] 原生分享失败:', e && e.message);
            Toast.show('导出失败，请重试');
          });
        };
        reader.onerror = () => Toast.show('导出失败，请重试');
        reader.readAsDataURL(blob);
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        Toast.show('轨迹图片已导出');
      }
    });
  }

  _renameTrail(id, el) {
    if (el.contentEditable === 'true') return;
    const oldName = el.textContent;
    el.contentEditable = 'true';
    el.classList.add('editing');
    el.focus();

    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const commit = () => {
      el.contentEditable = 'false';
      el.classList.remove('editing');
      const newName = el.textContent.trim() || oldName;
      el.textContent = newName;
      if (newName !== oldName) {
        this._invalidateTrailCache();
        Storage.renameTrail(id, newName);
      }
    };

    el.onblur = commit;
    el.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      if (e.key === 'Escape') { el.textContent = oldName; el.blur(); }
    };
  }

  _escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  _showTrailDetail(id) {
    Storage.loadTrailById(id).then(async (data) => {
      if (!data || !data.positions || data.positions.length < 2) {
        Toast.show('轨迹数据不足');
        return;
      }
      const pos = data.positions;
      const stats = this._computeTrailStats(pos);
      const durationMs = stats.duration;

      let maxSpeed = 0;
      let hasSpeed = false;
      for (const p of pos) {
        if (p.speed != null && p.speed > maxSpeed) { maxSpeed = p.speed; hasSpeed = true; }
      }
      const avgSpeed = durationMs > 0 ? stats.distance / (durationMs / 1000) : 0;

      const fmtTime = (ts) => {
        if (!ts) return '--';
        const d = new Date(ts);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      };
      const fmtDuration = (ms) => {
        if (ms <= 0) return '--';
        const s = Math.round(ms / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        if (m > 0) return `${m}:${String(sec).padStart(2, '0')}`;
        return `${sec}秒`;
      };

      const thumb = await this.mapManager.renderTrailThumbnail(pos, {
        title: data.name,
        map: false,
        stats: { distance: stats.distance, duration: durationMs, points: pos.length }
      });
      const firstTime = pos[0].time;
      const lastTime = pos[pos.length - 1].time;

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay show';
      overlay.innerHTML = `
        <div class="modal-box trail-detail-modal">
          <div class="modal-header">
            <span class="modal-title">轨迹详情</span>
            <button class="modal-close trail-detail-close">✕</button>
          </div>
          ${thumb ? `<div class="trail-detail-thumb"><img src="${thumb}" alt="轨迹缩略图"/></div>` : ''}
          <div class="trail-detail-name">${this._escapeHtml(data.name || '')}</div>
          <div class="trail-detail-date">${fmtTime(firstTime)} → ${fmtTime(lastTime)}</div>
          <div class="stat-grid">
            <div class="stat-card"><span class="stat-label">总距离</span><span class="stat-value">${formatDistance(stats.distance)}</span></div>
            <div class="stat-card"><span class="stat-label">总时长</span><span class="stat-value">${fmtDuration(durationMs)}</span></div>
            <div class="stat-card"><span class="stat-label">平均速度</span><span class="stat-value">${avgSpeed > 0 ? (avgSpeed * 3.6).toFixed(1) + ' km/h' : '--'}</span></div>
            <div class="stat-card"><span class="stat-label">最高速度</span><span class="stat-value warning">${hasSpeed ? (maxSpeed * 3.6).toFixed(1) + ' km/h' : '--'}</span></div>
            <div class="stat-card"><span class="stat-label">轨迹点数</span><span class="stat-value accent2">${pos.length}</span></div>
            <div class="stat-card"><span class="stat-label">是否收藏</span><span class="stat-value">${data.favorite ? '已收藏' : '未收藏'}</span></div>
          </div>
          <div class="confirm-actions">
            <button class="btn-sm trail-detail-load">加载到地图</button>
            <button class="btn-sm trail-detail-close">关闭</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      const close = () => {
        overlay.classList.remove('show');
        setTimeout(() => overlay.remove(), 300);
      };
      overlay.querySelectorAll('.trail-detail-close').forEach((b) => b.addEventListener('click', close));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
      });
      const loadBtn = overlay.querySelector('.trail-detail-load');
      if (loadBtn) {
        loadBtn.addEventListener('click', () => {
          close();
          this._loadTrailFromList(id);
        });
      }
    });
  }

  _trailItemHTML(item, isReplay) {
    const d = new Date(item.createdAt);
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const distStr = item.distance >= 1000
      ? (item.distance / 1000).toFixed(2) + ' km'
      : Math.round(item.distance) + ' m';
    const metaExtra = isReplay ? ` · ${item.pointCount || 0} 点` : '';
    const dotColor = isReplay ? ' style="background:#FF9500"' : '';
    const favClass = item.favorite ? ' favorite-btn active' : ' favorite-btn';
    const selectedSet = isReplay ? this._replaySelected : this._historySelected;
    const checked = selectedSet.has(item.id) ? ' checked' : '';
    const multiCls = this._multiSelect ? ' multi' : '';
    const checkHtml = `<label class="trail-select-check${checked}" data-id="${item.id}">
        <input type="checkbox" data-id="${item.id}"${checked ? ' checked' : ''} />
      </label>`;
    const moreBtn = `<button class="trail-item-btn more-btn" data-id="${item.id}" title="更多操作">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
      </button>`;
    const actions = isReplay
      ? `<button class="trail-item-btn replay-btn" data-id="${item.id}" title="回放">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>
        </button>
        ${moreBtn}`
      : `<button class="trail-item-btn load-btn" data-id="${item.id}" title="加载到地图">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
        </button>
        ${moreBtn}`;
    return `<div class="trail-list-item${multiCls}" data-id="${item.id}">
      ${checkHtml}
      <button class="${favClass}" data-id="${item.id}" title="收藏">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="${item.favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
      </button>
      <span class="trail-item-dot"${dotColor}></span>
      <div class="trail-item-info">
        <div class="trail-item-name" data-id="${item.id}">${item.name}</div>
        <div class="trail-item-meta">${dateStr} · ${distStr}${metaExtra}</div>
      </div>
      <div class="trail-item-actions">
        ${actions}
      </div>
    </div>`;
  }

  _bindTrailItemEvents(listEl, isReplay) {
    const selectedSet = isReplay ? this._replaySelected : this._historySelected;

    listEl.querySelectorAll('.trail-select-check').forEach((label) => {
      const input = label.querySelector('input');
      if (!input) return;
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('change', () => {
        const id = input.dataset.id;
        if (input.checked) { selectedSet.add(id); label.classList.add('checked'); }
        else { selectedSet.delete(id); label.classList.remove('checked'); }
        this._syncBatchToolbar();
      });
    });

    listEl.querySelectorAll('.favorite-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        Storage.toggleFavorite(id).then((fav) => {
          this._invalidateTrailCache();
          if (fav === false && (this._onlyFav || this._replayOnlyFav)) {
            this._renderTrailList();
            if (isReplay) this._renderReplayTrailList();
            return;
          }
          btn.classList.toggle('active', fav);
          const svg = btn.querySelector('svg');
          if (svg) svg.setAttribute('fill', fav ? 'currentColor' : 'none');
          const item = listEl.querySelector(`.trail-list-item[data-id="${id}"]`);
          if (item) item.parentNode.insertBefore(item, listEl.firstChild);
          Toast.show(fav ? '已收藏' : '已取消收藏');
        });
      });
    });

    // 点击名称 → 重命名（已替代 rename-btn）
    listEl.querySelectorAll('.trail-item-name').forEach((el) => {
      el.addEventListener('click', () => this._renameTrail(el.dataset.id, el));
    });

    // 点击卡片空白区域 → 打开详情（已替代 info-btn）
    listEl.querySelectorAll('.trail-list-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.trail-item-btn, .favorite-btn, .trail-select-check, .trail-item-name')) return;
        this._showTrailDetail(item.dataset.id);
      });
    });

    // 更多操作按钮 → 弹出菜单
    listEl.querySelectorAll('.trail-item-btn.more-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._showTrailItemMenu(btn, btn.dataset.id, isReplay);
      });
    });

    if (isReplay) {
      listEl.querySelectorAll('.trail-item-btn.replay-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._replayTrailFromList(btn.dataset.id);
        });
      });
    }

    listEl.querySelectorAll('.trail-item-btn.load-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._loadTrailFromList(btn.dataset.id);
      });
    });
  }

  /**
   * 弹出轨迹项的「⋯」更多操作菜单
   * @param {HTMLElement} anchorBtn 触发按钮
   * @param {string} id 轨迹 id
   * @param {boolean} isReplay 是否回放列表
   */
  _showTrailItemMenu(anchorBtn, id, isReplay) {
    this._closeTrailItemMenu();

    // 全屏透明遮罩：拦截点击，避免误触被遮挡的轨迹操作
    const backdrop = document.createElement('div');
    backdrop.className = 'trail-menu-backdrop';
    backdrop.addEventListener('click', (e) => {
      e.stopPropagation();
      this._closeTrailItemMenu();
    });
    document.body.appendChild(backdrop);
    this._trailMenuBackdrop = backdrop;

    const menu = document.createElement('div');
    menu.className = 'trail-item-menu';
    const items = [
      { act: 'detail', label: '详情', fn: () => this._showTrailDetail(id) },
      { act: 'load', label: '加载到地图', fn: () => this._loadTrailFromList(id), replayOnly: true },
      { act: 'clean', label: '清洗轨迹', fn: () => this._cleanTrail(id), historyOnly: true },
      { act: 'share-card', label: '分享卡片', fn: () => this._exportShareCard(id), historyOnly: true },
      { act: 'delete', label: '删除', danger: true, fn: () => this._deleteTrailFromList(id) }
    ];
    menu.innerHTML = items
      .filter((it) => !(it.replayOnly && !isReplay) && !(it.historyOnly && isReplay))
      .map((it) => `<button class="trail-menu-item${it.danger ? ' danger' : ''}" data-act="${it.act}" data-id="${id}">${it.label}</button>`)
      .join('');
    document.body.appendChild(menu);

    // 自适应定位（fixed，避免被列表 overflow 裁剪）
    const rect = anchorBtn.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const gap = 6;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 水平：优先右对齐触发按钮，并钳制在视口内
    let left = Math.min(rect.right - mw, vw - mw - margin);
    left = Math.max(margin, left);

    // 垂直：下方空间足够则向下弹出，否则翻转到上方；上下都不足则贴边
    let top;
    const below = vh - rect.bottom;
    const above = rect.top;
    if (below >= mh + gap + margin) {
      top = rect.bottom + gap;
    } else if (above >= mh + gap + margin) {
      top = rect.top - mh - gap;
    } else {
      top = Math.max(margin, Math.min(vh - mh - margin, rect.bottom - mh / 2));
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    this._trailMenu = menu;
    this._trailMenuClickHandler = (e) => {
      const btn = e.target.closest('.trail-menu-item');
      if (!btn) return;
      const item = items.find((it) => it.act === btn.dataset.act);
      this._closeTrailItemMenu();
      if (item && item.fn) item.fn();
    };
    menu.addEventListener('click', this._trailMenuClickHandler);
  }

  _closeTrailItemMenu() {
    if (this._trailMenu) {
      this._trailMenu.remove();
      this._trailMenu = null;
    }
    if (this._trailMenuBackdrop) {
      this._trailMenuBackdrop.remove();
      this._trailMenuBackdrop = null;
    }
    if (this._trailMenuClickHandler) {
      // handler 随元素移除自动失效，无需额外清理
      this._trailMenuClickHandler = null;
    }
  }

  _syncBatchToolbar() {
    const bar = document.getElementById('batch-toolbar');
    if (!bar) return;
    const total = this._historySelected.size + this._replaySelected.size;
    const countEl = bar.querySelector('.batch-count');
    if (countEl) countEl.textContent = total > 0 ? `已选 ${total} 条` : '未选择';
    bar.querySelector('.batch-export').disabled = total === 0;
    bar.querySelector('.batch-merge').disabled = total < 2;
    const deleteBtn = bar.querySelector('.batch-delete');
    if (deleteBtn) deleteBtn.disabled = total === 0;
    const invertBtn = bar.querySelector('.batch-invert');
    if (invertBtn) invertBtn.disabled = total === 0;
    bar.querySelector('.batch-clear').disabled = total === 0;
    bar.classList.toggle('visible', total > 0 || this._multiSelect);
  }

  _selectAll(checked) {
    // 只选择当前 Tab 可见列表（全选当前）
    if (this._currentTab === 'replay') {
      this._replaySelected.clear();
      if (checked) {
        const list = document.getElementById('replay-trail-list');
        if (list) list.querySelectorAll('.trail-list-item').forEach((el) => this._replaySelected.add(el.dataset.id));
      }
    } else {
      this._historySelected.clear();
      if (checked) {
        const list = document.getElementById('trail-list');
        if (list) list.querySelectorAll('.trail-list-item').forEach((el) => this._historySelected.add(el.dataset.id));
      }
    }
    this._multiSelect = true;
    this._renderTrailList();
    this._renderReplayTrailList();
  }

  _invertSelection() {
    const histList = document.getElementById('trail-list');
    const replayList = document.getElementById('replay-trail-list');
    if (histList) {
      histList.querySelectorAll('.trail-list-item').forEach((el) => {
        const id = el.dataset.id;
        if (this._historySelected.has(id)) this._historySelected.delete(id);
        else this._historySelected.add(id);
      });
    }
    if (replayList) {
      replayList.querySelectorAll('.trail-list-item').forEach((el) => {
        const id = el.dataset.id;
        if (this._replaySelected.has(id)) this._replaySelected.delete(id);
        else this._replaySelected.add(id);
      });
    }
    this._multiSelect = true;
    this._renderTrailList();
    this._renderReplayTrailList();
  }

  _toggleMultiSelect(force) {
    this._multiSelect = force != null ? force : !this._multiSelect;
    if (!this._multiSelect) {
      this._historySelected.clear();
      this._replaySelected.clear();
    }
    this._renderTrailList();
    this._renderReplayTrailList();
  }

  _computeTrailStats(positions) {
    if (!positions || positions.length === 0) return { distance: 0, duration: 0, points: 0 };
    const distance = Storage._calcDistance(positions);
    let durationMs = 0;
    const first = positions[0];
    const last = positions[positions.length - 1];
    if (first && last && first.time && last.time && last.time > first.time) {
      durationMs = last.time - first.time;
    }
    return { distance, duration: durationMs, points: positions.length };
  }

  _exportSelectedImages() {
    const ids = Array.from(new Set([...this._historySelected, ...this._replaySelected]));
    if (ids.length === 0) return;
    Toast.show('正在生成轨迹合集卡片…');
    Storage.loadTrailsByIds(ids).then(async (trails) => {
      if (!trails || trails.length === 0) {
        Toast.show('分享失败');
        return;
      }
      const items = trails.map((t) => ({
        positions: t.positions,
        name: t.name,
        stats: this._computeTrailStats(t.positions)
      }));
      const dataUrl = await this.mapManager.renderTrailCollage(items);
      if (!dataUrl) {
        Toast.show('生成失败，请重试');
        return;
      }
      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = `途刻-轨迹合集-${dateStr}.png`;
      // 批量导出改为分享链路（与报告导出相同）：原生系统分享 / Web 端下载
      this._downloadDataUrl(dataUrl, filename, {
        title: '途刻轨迹合集',
        text: `途刻 — ${items.length} 条轨迹合集`,
        dialogTitle: '分享或保存轨迹合集长图'
      });
      this._toggleMultiSelect(false);
    });
  }

  _mergeSelectedTrails() {
    const ids = Array.from(new Set([...this._historySelected, ...this._replaySelected]));
    if (ids.length < 2) { Toast.show('至少选择 2 条轨迹才能合并'); return; }
    this._loadTrailListCached().then((items) => {
      const selected = items.filter((it) => ids.includes(it.id));
      const totalDist = selected.reduce((s, it) => s + (it.distance || 0), 0);
      const totalPts = selected.reduce((s, it) => s + (it.pointCount || 0), 0);
      this._showMergeDialog(ids, selected.length || ids.length, totalDist, totalPts);
    });
  }

  _showMergeDialog(ids, count, totalDist, totalPts) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const defaultName = `合并轨迹 ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay show';
    overlay.innerHTML = `
      <div class="modal-box">
        <div class="modal-header">
          <span class="modal-title">合并轨迹</span>
          <button class="modal-close merge-dialog-cancel">✕</button>
        </div>
        <div class="confirm-body">
          <div class="confirm-text">将拼接 ${count} 条轨迹为 1 条</div>
          <div class="confirm-detail">合计约 ${formatDistance(totalDist)} · ${totalPts} 个点。若轨迹时间/位置不连续，合并后距离会偏大。</div>
        </div>
        <div class="merge-name-field">
          <label class="merge-name-label" for="merge-name-input">新轨迹名称</label>
          <input type="text" id="merge-name-input" class="modal-input" value="${defaultName}" maxlength="60" />
        </div>
        <div class="confirm-actions">
          <button class="btn-sm merge-dialog-cancel">取消</button>
          <button class="btn-sm btn-danger" id="merge-confirm-btn">合并</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => {
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 300);
    };
    const onCancel = (e) => {
      e.stopPropagation();
      close();
    };
    overlay.querySelectorAll('.merge-dialog-cancel').forEach((b) => b.addEventListener('click', onCancel));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    const input = overlay.querySelector('#merge-name-input');
    input.focus();
    input.select();

    const doMerge = () => {
      const name = input.value.trim() || defaultName;
      const btn = overlay.querySelector('#merge-confirm-btn');
      btn.disabled = true;
      btn.textContent = '合并中…';
      Storage.mergeTrails(ids, name).then((newId) => {
        close();
        if (newId) {
          this._invalidateTrailCache();
          Toast.show(`已合并为「${name}」`);
          this._toggleMultiSelect(false);
          this._renderTrailList();
          this._renderReplayTrailList();
        } else {
          Toast.show('合并失败，请重试');
        }
      });
    };
    overlay.querySelector('#merge-confirm-btn').addEventListener('click', doMerge);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doMerge(); }
      if (e.key === 'Escape') close();
    });
  }

  _deleteSelectedTrails() {
    const ids = Array.from(new Set([...this._historySelected, ...this._replaySelected]));
    if (ids.length === 0) return;
    Storage.loadTrailsByIds(ids).then((trails) => {
      if (!trails || trails.length === 0) {
        Toast.show('没有可删除的轨迹');
        return;
      }
      // 确认对话框
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay show';
      overlay.innerHTML = `
        <div class="modal-box">
          <div class="modal-header">
            <span class="modal-title">批量删除</span>
            <button class="modal-close batch-delete-cancel">✕</button>
          </div>
          <div class="confirm-body">
            <div class="confirm-text">确定删除选中的 ${trails.length} 条轨迹？</div>
            <div class="confirm-detail">删除后可在 5 秒内撤销。该操作不可恢复，请谨慎操作。</div>
          </div>
          <div class="confirm-actions">
            <button class="btn-sm batch-delete-cancel">取消</button>
            <button class="btn-sm btn-danger" id="batch-delete-confirm-btn">确认删除</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      const close = () => {
        overlay.classList.remove('show');
        setTimeout(() => overlay.remove(), 300);
      };
      const onCancel = (e) => {
        e.stopPropagation();
        close();
      };
      overlay.querySelectorAll('.batch-delete-cancel').forEach((b) => b.addEventListener('click', onCancel));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
      });

      overlay.querySelector('#batch-delete-confirm-btn').addEventListener('click', () => {
        const btn = overlay.querySelector('#batch-delete-confirm-btn');
        btn.disabled = true;
        btn.textContent = '删除中…';
        Promise.all(ids.map((id) => Storage.deleteTrail(id).catch(() => false))).then((results) => {
          close();
          const okCount = results.filter((r) => r).length;
          if (okCount === 0) {
            Toast.show('删除失败，请重试');
            return;
          }
          this._invalidateTrailCache();
          const msg = okCount === ids.length ? `已删除 ${okCount} 条轨迹` : `已删除 ${okCount}/${ids.length} 条轨迹`;
          Toast.showUndo(msg, () => {
            // 撤销：重新保存被删轨迹（逐条恢复，失败静默）
            return Promise.all(
              trails.filter((t) => t.positions && t.positions.length > 0)
                .map((t) => Storage.saveTrailToList(t.positions, t.name, t.favorite).catch(() => null))
            ).then(() => {
              this._invalidateTrailCache();
              this._renderTrailList();
              this._renderReplayTrailList();
              this._syncBatchToolbar();
            });
          });
          this._toggleMultiSelect(false);
          this._renderTrailList();
          this._renderReplayTrailList();
          this._syncBatchToolbar();
        });
      });
    });
  }

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

  _showTrailStats() {
    const pos = this.trail.positions;
    if (pos.length < 2) {
      Toast.show(' 轨迹点数不足（至少 2 个点）');
      return;
    }

    const totalDist = this.trail.getDistance();
    const firstTime = pos[0].time || null;
    const lastTime = pos[pos.length - 1].time || null;
    let durationMs = 0;
    if (firstTime && lastTime && lastTime > firstTime) {
      durationMs = lastTime - firstTime;
    }

    let maxSpeed = 0;
    let hasSpeed = false;
    for (const p of pos) {
      if (p.speed != null && p.speed > maxSpeed) {
        maxSpeed = p.speed;
        hasSpeed = true;
      }
    }

    const avgSpeed = durationMs > 0 ? totalDist / (durationMs / 1000) : 0;

    const fmtTime = (ts) => {
      if (!ts) return '--';
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    const fmtDate = (ts) => {
      if (!ts) return '--';
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(ts)}`;
    };
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

    const overlay = document.getElementById('stats-modal');
    if (overlay) {
      document.getElementById('stat-distance').textContent = formatDistance(totalDist);
      document.getElementById('stat-duration').textContent = fmtDuration(durationMs);
      document.getElementById('stat-avg-speed').textContent = avgSpeed > 0 ? (avgSpeed * 3.6).toFixed(1) + ' km/h' : '--';
      document.getElementById('stat-max-speed').textContent = hasSpeed ? (maxSpeed * 3.6).toFixed(1) + ' km/h' : '--';
      document.getElementById('stat-points').textContent = pos.length;
      document.getElementById('stat-start-time').textContent = fmtDate(firstTime);
      document.getElementById('stat-end-time').textContent = fmtDate(lastTime);
      overlay.classList.add('show');
      return;
    }

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
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);

    const mo = document.getElementById('stats-modal');
    const box = mo.querySelector('.modal-box');
    const closeModal = () => {
      mo.classList.remove('show');
      setTimeout(() => mo.remove(), 300);
    };
    mo.addEventListener('click', (e) => {
      if (!box.contains(e.target)) closeModal();
    });
    document.getElementById('stats-close-btn').addEventListener('click', closeModal);
  }

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

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = 800 * dpr;
      const H = 900 * dpr;
      const S = dpr;

      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');

      ctx.fillStyle = isDark ? '#1a1a2e' : '#f0f0f5';
      ctx.fillRect(0, 0, W, H);

      ctx.fillStyle = isDark ? '#16213e' : '#ffffff';
      ctx.fillRect(0, 0, W, 80 * S);
      ctx.fillStyle = isDark ? '#00d4aa' : '#0ea5e9';
      ctx.font = `${24 * S}px "HarmonyOS Sans", sans-serif`;
      ctx.fillText(' 途刻活动报告', 24 * S, 44 * S);
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)';
      ctx.font = `${13 * S}px "HarmonyOS Sans", sans-serif`;
      ctx.fillText(new Date().toLocaleString('zh-CN'), 24 * S, 66 * S);

      const mapY = 96 * S;
      const mapH = 320 * S;
      const mapW = W - 48 * S;
      const mapX = 24 * S;

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
      const padR = Math.max(0.001, Math.max(rawLatSpan, rawLngSpan) * 0.5);
      minLat -= padR; maxLat += padR;
      minLng -= padR; maxLng += padR;
      const lngSpan = maxLng - minLng || 0.001;
      const latSpan = maxLat - minLat || 0.001;
      const margin = 20 * S;
      const drawW = mapW - margin * 2;
      const drawH = mapH - margin * 2;

      const midLat = (minLat + maxLat) / 2;
      const cosLat = Math.cos(midLat * Math.PI / 180);
      const dataW = lngSpan * cosLat;
      const dataH = latSpan;
      const scale = Math.min(drawW / dataW, drawH / dataH);
      const usedW = dataW * scale;
      const usedH = dataH * scale;
      const originX = mapX + margin + (drawW - usedW) / 2;
      const originY = mapY + margin + (drawH - usedH) / 2;

      const toX = (lng) => originX + (lng - minLng) * cosLat * scale;
      const toY = (lat) => originY + (maxLat - lat) * scale;

      // ── 地图底图：腾讯地图瓦片（realtimerender 矢量渲染，GCJ-02 与轨迹同坐标系，与应用显示底图一致） ──
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
      // 瓦片数量上限 100：超出则降档
      let tileRange = null;
      for (; z >= 3; z--) {
        const x0 = Math.floor(mercX(mapLeftLng) * (1 << z));
        const x1 = Math.floor(mercX(mapRightLng) * (1 << z));
        const y0 = Math.floor(mercY(mapTopLat) * (1 << z));
        const y1 = Math.floor(mercY(mapBotLat) * (1 << z));
        tileRange = { x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
        if (tileRange.count <= 100) break;
      }
      // 异步加载全部瓦片：任一张失败 → 降级纯色底图（不阻塞导出）
      let tileImages = [];
      if (tileRange) {
        const results = await Promise.allSettled(
          (() => {
            const jobs = [];
            for (let tx = tileRange.x0; tx <= tileRange.x1; tx++) {
              for (let ty = tileRange.y0; ty <= tileRange.y1; ty++) {
                jobs.push(this.mapManager._loadMapTile(z, tx, ty));
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
        ctx.fillRect(mapX, mapY, mapW, mapH);
      }

      const trailPoints = this._getTrailPositions();
      if (trailPoints.length >= 2) {
        const colorMap = isDark ? this.mapManager._speedColorDark : this.mapManager._speedColorLight;
        const getSpeedKey = (s) => this.mapManager._speedColorKey(s);

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
            flushBatch();
            batchPath = [{ x: toX(p0.lng), y: toY(p0.lat) }];
            batchKey = key;
          }
          batchPath.push({ x: toX(p1.lng), y: toY(p1.lat) });
        }
        flushBatch();
      }

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
        ctx.fillStyle = 'rgba(0,0,0,0.85)';
        ctx.font = `${11 * S}px "HarmonyOS Sans", sans-serif`;
        ctx.fillText('起点', toX(first.lng) + 8 * S, toY(first.lat) + 4 * S);
        ctx.fillText('终点', toX(last.lng) + 8 * S, toY(last.lat) + 4 * S);
      }

      const statsY = mapY + mapH + 16 * S;
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

      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)';
      ctx.font = `${11 * S}px "HarmonyOS Sans", sans-serif`;
      ctx.textAlign = 'right';
      ctx.fillText('途刻', W - 24 * S, H - 16 * S);
      ctx.fillText('注：底图较老，仅供参考使用', W - 24 * S, H - 40 * S);
      ctx.textAlign = 'left';

      const dateStr = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const filename = `tracecraft-activity-${dateStr}.png`;
      canvas.toBlob(async (blob) => {
        if (!blob) {
          Toast.show(' 导出失败：无法生成图片');
          return;
        }

        if (typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform()) {
          try {
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
              title: '途刻活动报告',
              text: '途刻 — 轨迹活动报告',
              url: result.uri,
              dialogTitle: '分享或保存活动报告',
            });

            Toast.show(' 报告已分享');
          } catch (e) {
            Toast.show(' 分享取消或失败');
          }
        } else {
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

  _updateTrailUI() {
    const btn = this._trailRecordBtn || (this._trailRecordBtn = document.getElementById('trail-record-btn'));
    const pauseBtn = this._trailPauseBtn || (this._trailPauseBtn = document.getElementById('trail-pause-btn'));
    const clearBtn = this._trailClearBtn || (this._trailClearBtn = document.getElementById('trail-clear-btn'));
    const statsBtn = this._trailStatsBtn || (this._trailStatsBtn = document.getElementById('trail-stats-btn'));
    const exportBtn = this._trailExportBtn || (this._trailExportBtn = document.getElementById('export-report-btn'));
    const smoothBtn = this._trailSmoothBtn || (this._trailSmoothBtn = document.getElementById('trail-smooth-btn'));
    const autoPauseBtn = this._trailAutoPauseBtn || (this._trailAutoPauseBtn = document.getElementById('trail-autopause-btn'));
    const distEl = this._trailDistEl || (this._trailDistEl = document.getElementById('trail-distance'));

    if (btn) {
      btn.classList.toggle('recording', this.trail.isRecording && !this.trail.isPaused);
      if (!this.trail.isRecording) {
        btn.innerHTML = '<span class="trail-dot"></span> 开始记录';
      } else if (this.trail.isPaused) {
        btn.innerHTML = '<span class="trail-dot"></span> 继续';
      } else {
        btn.innerHTML = '<span class="trail-dot"></span> 暂停';
      }
    }

    if (pauseBtn) {
      pauseBtn.disabled = !this.trail.isRecording;
      pauseBtn.textContent = '结束并保存';
    }

    const dist = this.trail.getDistance();
    if (distEl) {
      distEl.textContent = dist > 0 ? formatDistance(dist) : '0m';
    }

    const hasPoints = this.trail.positions.length > 0;
    if (clearBtn) clearBtn.disabled = !hasPoints;
    if (statsBtn) statsBtn.disabled = this.trail.positions.length < 2;
    if (exportBtn) exportBtn.disabled = this.trail.positions.length < 2;

    if (smoothBtn) {
      smoothBtn.classList.toggle('active', this._trailSmoothing);
    }

    if (autoPauseBtn) {
      autoPauseBtn.classList.toggle('active', this._autoPauseEnabled);
      autoPauseBtn.textContent = this._autoPauseEnabled ? '自动暂停开' : '自动暂停';
    }
  }

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
    if (this._recentFixes.length > 10) {
      this._recentFixes = this._recentFixes.slice(-10);
    }
  }

  async _processPosition(pos) {
    try {
      const age = Date.now() - (pos.timestamp || Date.now());
      if (age > CONFIG.GPS_WATCH_TIMEOUT * 3) return;
      this._lastRawPos = { lat: pos.lat, lng: pos.lng };

      const convPos = await this.mapManager.wgs84ToGcj02(pos);

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

      this.myPosition = convPos;
      this.myPositionTime = Date.now();
      this._recordFix(pos, convPos);

      // 静止自动暂停检查（仅手动开关开启时生效）
      this._checkAutoPause(this._lastSpeed, pos.timestamp || Date.now());

      this._fetchWeather();

      this.mapManager.setLocation(convPos, pos.accuracy, pos.heading);

      if (this._firstFix) {
        this._firstFix = false;

        if (this._restoringView) {
          this._restoringView = false;
        } else if (!this._isReplaying) {
          this.mapManager.flyTo(convPos);
          this._gpsBtn.classList.add('located');
          setTimeout(() => this._gpsBtn.classList.remove('located'), CONFIG.LOCATED_ANIM_MS);
          Toast.show(` 定位成功（精度 ±${(pos.accuracy || 0).toFixed(0)} 米）`);

          this.gpsManager.startGnss().then(() => {
            if (this.gpsManager.isGnssActive) {
              Toast.show(` GNSS 卫星数据已激活`);
            }
          }).catch(err => console.error('[GNSS] unexpected error:', err));
        }
      } else if (this._isWatching && !this._isReplaying) {
        if (this._followMode) {
          this.mapManager.flyTo(convPos);
        }
      }

      // 回放期间允许记录继续采集（并行模式）
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
          this.mapManager.setRealtimeKeyPoints(TrailAnalysis.analyzeKeyPoints(this.trail.positions));
          this._updateTrailUI();
        }
      }

      const now = Date.now();
      const moved = this._lastDistPos ? calcDistance(convPos, this._lastDistPos) : Infinity;
      if (moved > CONFIG.MIN_DISPLACEMENT_M || !this._lastDistPos) {
        this._lastDistPos = convPos;
        this._updateStatusBar(true);
        this._lastFullUpdate = now;
      } else if (now - this._lastFullUpdate > 60000) {
        this._lastDistPos = convPos;
        this._updateStatusBar(true);
        this._lastFullUpdate = now;
      } else {
        this._updateStatusBar();
      }
    } catch (e) {
      if (CONFIG.DEBUG) console.error('_processPosition error:', e.message);
      if (!this._lastGcj02ErrorToast || Date.now() - this._lastGcj02ErrorToast > 30000) {
        this._lastGcj02ErrorToast = Date.now();
        Toast.show(' 坐标转换失败，位置未更新');
      }
    }
  }

  async _autoRelocate() {
    if (this._relocating) return;
    if (Date.now() - this._lastRelocateAttempt < CONFIG.RELOCATE_INTERVAL_MS) return;

    this._relocating = true;
    Toast.show(' 定位已过期，正在重新定位...');

    try {
      const pos = await this.gpsManager.getCurrentPosition();
      const convPos = await this.mapManager.wgs84ToGcj02(pos);

      this.myPosition = convPos;
      this.myPositionTime = Date.now();
      this._lastAltitude = pos.altitude;
      this._lastSpeed = pos.speed;
      this._lastHeading = pos.heading;
      this._lastAccuracy = pos.accuracy;
      this._recordFix(pos, convPos);
      this.mapManager.setLocation(convPos, pos.accuracy, pos.heading);

      this._updateStatusBar(true);
    } catch (err) {
      console.warn('[AutoRelocate] 重定位失败:', err.message);
      Toast.show(' 自动重定位失败');
    } finally {
      this._relocating = false;
      this._lastRelocateAttempt = Date.now();
    }
  }

  get POSITION_STALE_MS() { return CONFIG.POSITION_STALE_MS; }

  _isPositionStale() {
    return this.myPositionTime !== null && (Date.now() - this.myPositionTime) > this.POSITION_STALE_MS;
  }

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

  _updateStatusBar(force) {
    if (!this._statusEl) return;
    const now = Date.now();
    if (!force && now - (this._lastStatusBarUpdate || 0) < CONFIG.STATUS_THROTTLE_MS) return;
    this._lastStatusBarUpdate = now;

    const dot = this._statusEl.querySelector('.gps-dot');
    const offlineSpan = this._statusEl.querySelector('.gps-offline');

    if (!this.myPosition) {
      if (dot) dot.className = 'gps-dot';
      if (offlineSpan) offlineSpan.textContent = '⊙ 未定位，点击 GPS 按钮定位';
      return;
    }

    const stale = this._isPositionStale();
    if (this._isWatching) {
      if (dot) dot.className = 'gps-dot active';
    } else if (stale) {
      if (dot) dot.className = 'gps-dot';
    } else {
      if (dot) dot.className = 'gps-dot active';
    }

    const elapsed = this._formatElapsed();
    const acc = this._lastAccuracy != null ? ` ±${Math.round(this._lastAccuracy)}m` : '';
    const elapsedText = elapsed ? ` · ${elapsed}` : '';
    const staleText = stale ? ' (已过期)' : '';

    if (offlineSpan) {
      offlineSpan.textContent = `⊙ ${this.myPosition.lat.toFixed(4)}, ${this.myPosition.lng.toFixed(4)}${acc}${elapsedText}${staleText}`;
    }
  }

  _restoreTheme() {
    try {
      const saved = localStorage.getItem('trailcraft_theme');
      if (saved === 'light' || saved === 'dark') {
        this._theme = saved;
      }
    } catch (e) {}
    document.documentElement.setAttribute('data-theme', this._theme);
    this.mapManager.setTheme(this._theme);
    this._updateThemeBtn();
  }

  _toggleTheme() {
    this._theme = this._theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', this._theme);
    this.mapManager.setTheme(this._theme);
    const positions = this._getTrailPositions();
    if (positions && positions.length >= 2) {
      this.mapManager.refreshTrailColors(positions);
    }
    this._updateChartTheme();
    try {
      localStorage.setItem('trailcraft_theme', this._theme);
    } catch (e) {}
    this._updateThemeBtn();
    Toast.show(this._theme === 'light' ? ' 已切换为浅色主题' : ' 已切换为深色主题');
  }

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

  _updateThemeBtn() {
    const btn = document.getElementById('theme-btn');
    if (!btn) return;
    const isDark = this._theme === 'dark';
    btn.innerHTML = isDark
      ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    btn.title = isDark ? '切换浅色主题' : '切换深色主题';
  }

  _fetchWeather() {
    if (!navigator.onLine) return;
    if (this.gpsManager.isPowerSaving) return;
    const now = Date.now();
    if (this._lastWeatherFetch && now - this._lastWeatherFetch < 300000) return;
    if (this._lastWeatherPos && this.myPosition) {
      const d = calcDistance(this.myPosition, this._lastWeatherPos);
      if (d < 1000 && now - this._lastWeatherFetch < 1800000) return;
    }
    this._lastWeatherFetch = now;
    this._lastWeatherPos = this.myPosition ? { lat: this.myPosition.lat, lng: this.myPosition.lng } : this._lastWeatherPos;
    const pos = this.myPosition;
    const lat = pos?.lat ?? 39.9;
    const lng = pos?.lng ?? 116.4;
    // 主源 Open-Meteo，失败自动降级 wttr.in
    this._fetchWeatherOpenMeteo(lat, lng)
      .catch(() => this._fetchWeatherWttrIn(lat, lng).catch(() => {}));
  }

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
        const desc = App._weatherCodeToZh(cur.weather_code);
        const feelsText = feelsLike != null ? ` 体感${Math.round(feelsLike)}°` : '';
        const humidityText = humidity != null ? ` 湿度${humidity}%` : '';
        let sunText = '';
        const daily = data.daily;
        if (daily?.sunrise?.[0] && daily?.sunset?.[0]) {
          const sunrise = daily.sunrise[0].slice(11);
          const sunset = daily.sunset[0].slice(11);
          sunText = ` 日出${sunrise} 日落${sunset}`;
        }
        // 更新时间：Open-Meteo current.time 为本地时区 ISO 时间（timezone=auto），取 HH:MM；缺失则用本地时间兜底，保证常驻
        let updateText;
        if (cur.time && /T\d{2}:\d{2}/.test(cur.time)) {
          updateText = cur.time.slice(11, 16);
        } else {
          const d = new Date();
          updateText = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        }
        // 日出日落等完整信息移入 title 悬停，常态只显示关键信息；更新时间独立胶囊醒目常驻
        const weatherTitle = `${temp}°C${feelsText}${humidityText}${desc ? ' ' + desc : ''}${sunText}`;
        this._weatherHtml =
          `<span class="gps-weather" title="${weatherTitle}">${temp}°C${feelsText}${humidityText}${desc ? ' ' + desc : ''}</span>` +
          `<span class="gps-weather-update" title="天气更新时间">🕐 更新${updateText}</span>`;
        this._updateStatusBar(true);
      });
  }

  /**
   * 备用天气源：wttr.in（Open-Meteo 失败时降级）
   * 返回结构：current_condition[0]（temp_C/FeelsLikeC/humidity/windspeedKmph/weatherDesc[0].value/localObsDateTime）
   * 与 weather[0].astronomy[0]（sunrise/sunset）。lang=zh 使 weatherDesc 直接返回中文。
   */
  _fetchWeatherWttrIn(lat, lng) {
    const url = `https://wttr.in/${lat.toFixed(4)},${lng.toFixed(4)}?format=j1&lang=zh&timezone=auto`;
    return fetch(url, { signal: AbortSignal.timeout(6000) })
      .then(r => r.json())
      .then(data => {
        const cc = data?.current_condition?.[0];
        if (!cc) throw new Error('no data');
        const temp = cc.temp_C;
        const feelsLike = cc.FeelsLikeC;
        const humidity = cc.humidity;
        const desc = cc.weatherDesc?.[0]?.value || '';
        const feelsText = feelsLike != null ? ` 体感${Math.round(feelsLike)}°` : '';
        const humidityText = humidity != null ? ` 湿度${humidity}%` : '';
        let sunText = '';
        const astro = data.weather?.[0]?.astronomy?.[0];
        if (astro?.sunrise && astro?.sunset) {
          sunText = ` 日出${astro.sunrise} 日落${astro.sunset}`;
        }
        // 更新时间：wttr.in localObsDateTime 如 "2026-08-07 02:30 PM"，转 24 小时制 HH:MM；缺失则用本地时间兜底，保证常驻
        let updateText = '';
        const obs = String(cc.localObsDateTime || '');
        const m = obs.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (m) {
          let h = parseInt(m[1], 10) % 12;
          if (/pm/i.test(m[3])) h += 12;
          updateText = `${String(h).padStart(2, '0')}:${m[2]}`;
        } else {
          const d = new Date();
          updateText = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        }
        // 日出日落等完整信息移入 title 悬停，常态只显示关键信息；更新时间独立胶囊醒目常驻
        const weatherTitle = `${temp}°C${feelsText}${humidityText}${desc ? ' ' + desc : ''}${sunText}`;
        this._weatherHtml =
          `<span class="gps-weather" title="${weatherTitle}">${temp}°C${feelsText}${humidityText}${desc ? ' ' + desc : ''}</span>` +
          `<span class="gps-weather-update" title="天气更新时间">🕐 更新${updateText}</span>`;
        this._updateStatusBar(true);
      });
  }

  static _weatherCodeToZh(code) {
    const map = {
      0: '晴', 1: '大部晴', 2: '多云', 3: '阴',
      45: '雾', 48: '雾凇',
      51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
      61: '小雨', 63: '中雨', 65: '大雨',
      71: '小雪', 73: '中雪', 75: '大雪',
      80: '小阵雨', 81: '阵雨', 82: '大阵雨',
      95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '大雷阵雨伴冰雹'
    };
    return map[code] || '';
  }

  _initBattery() {
    if (!navigator.getBattery) return;
    navigator.getBattery().then(battery => {
      this._battery = battery;
      this._batteryLevel = battery.level;
      this._batteryCharging = battery.charging;
      this._batteryTime = battery.dischargingTime;
      this._updateStatusBar(true);

      this._batteryLevelHandler = () => {
        this._batteryLevel = battery.level;
        this._batteryCharging = battery.charging;
        this._batteryTime = battery.dischargingTime;
        this._updateStatusBar(true);
        // 仅在首次进入低电量（≤15% 且未充电）时提示一次，避免每次 levelchange 重复弹
        if (battery.level <= 0.15 && !battery.charging) {
          if (!this._lowBatteryNotified) {
            this._lowBatteryNotified = true;
            Toast.show('电量不足 15%，建议开启省电模式');
          }
        } else {
          this._lowBatteryNotified = false;
        }
      };
      battery.addEventListener('levelchange', this._batteryLevelHandler);

      this._batteryChargingHandler = () => {
        this._batteryCharging = battery.charging;
        this._batteryTime = battery.dischargingTime;
        this._updateStatusBar(true);
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

  _saveState() {
    if (this._trailDirty) {
      this._trailDirty = false;
      Storage.saveTrail(this.trail);
    }
  }

  _loadState() {
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
          this.mapManager.setTrailMarkers(TrailAnalysis.analyzeKeyPoints(this._getTrailPositions()));
        }
      }

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

  destroy() {
    this._stopWatching();

    if (this._isReplaying) {
      this._stopReplay();
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
    this._exitBackgroundMode();
    this._releaseWakeLock();
    this.gpsManager.destroy();
    if (this._speedChart) {
      this._speedChart.destroy();
      this._speedChart = null;
    }
    this._cleanupBattery();
    if (this._panelMediaQuery && this._panelMediaqueryChange) {
      this._panelMediaQuery.removeEventListener('change', this._panelMediaqueryChange);
      this._panelMediaqueryChange = null;
    }
    this.mapManager.destroy();
  }
}

let _appInitialized = false;

function _bootApp() {
  if (_appInitialized) return;
  _appInitialized = true;
  const app = new App();
  app.init();
  window.app = app;
}

document.addEventListener('DOMContentLoaded', _bootApp);

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  _bootApp();
}
