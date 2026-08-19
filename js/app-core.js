/**
 * 途刻 TraceCraft - 主应用控制器
 * ============================================
 * 协调 MapManager、GPSManager 与 UI 交互
 */

class App {
  constructor() {
    this.mapManager = new MapManager();
    this.gpsManager = new GPSManager();
    // 注入 mapManager：GPSManager 采集原始测量时预转 GCJ02（与轨迹点同系），
    // 使离线 RTS 全程在 GCJ02 空间平滑，回写零转换，消除坐标系错位漂移。
    this.gpsManager.setMapManager(this.mapManager);
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
        this._hideElevProfile();
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
    // GNSS 弱信号联动：进入/退出各弹一次 Toast + 立即刷新状态栏（徽章）
    this.gpsManager.onWeakSignalChange = (weak) => {
      Toast.show(weak ? ' GNSS 信号弱，已自动降低定位频率省电' : ' GNSS 信号已恢复，定位频率已还原');
      this._updateStatusBar(true);
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
    this._elevChart = null;
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
    this._lastAltitude = null;     // 状态栏显示用（相对起点海拔，任务B）
    this._lastHeading = null;
    this._altBase = null;          // 海拔相对基准：首个有效海拔点（任务B）
    this._lastSampleBearing = null; // 上次入库段航向（任务A 转弯判定）
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
    this._pendingQueue = []; // GPS 待处理有界缓冲：容量上限 3，超限丢旧留新
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
        const dateStr = formatDateTime(it.createdAt, { withSeconds: false });
        const distStr = formatDistance(it.distance);
        const durStr = formatDurationShort(it.duration);
        const hay = [it.name || '', dateStr, distStr, durStr, String(it.pointCount || 0)].join(' ').toLowerCase();
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
        // 同步紧急快照：页面被杀时 IndexedDB 异步写可能来不及完成，先用 localStorage 兜底
        this._writeEmergencySnapshot();
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

    // 批量工具栏：按 data-tab 区分回放/历史两个全选按钮，避免重复 ID 导致跨 Tab 错乱
    document.querySelectorAll('.batch-select-all-btn').forEach((selectAllBtn) => {
      selectAllBtn.addEventListener('click', () => {
        const tab = selectAllBtn.dataset.tab;
        if (tab === 'replay') {
          if (this._currentTab !== 'replay') this._setTab('replay');
        } else {
          if (this._currentTab !== 'history') this._setTab('history');
        }
        this._selectAll(true);
      });
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
      this._lastCalcTime = this.gpsManager.calibratedNow;
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
    this._showElevProfile();

    this._gpsBtn.classList.add('watching');
    this._gpsBtn.title = '正在持续追踪位置';

    this.gpsManager.onPositionChange = (pos) => {
      if (this._isWatching && pos.speed != null) {
        const elapsed = (Date.now() - this._speedTrackingStart) / 1000;
        this._speedHistory.push({ x: Math.round(elapsed * 10) / 10, y: pos.speed });
        if (this._speedHistory.length > CONFIG.SPEED_HISTORY_MAX) this._speedHistory.shift();
        this._updateSpeedChart();
      }
      this._updatePowerStatus();
      if (!this._queuePending) this._queuePending = 0;
      // 有界缓冲：容量上限 3，超限丢弃最旧、保留最新，避免高速移动时轨迹断裂
      this._pendingQueue.push(pos);
      if (this._pendingQueue.length > 3) this._pendingQueue.shift();
      if (this._queuePending >= 3) return;
      this._queuePending++;
      // 每次取出当前缓冲全部快照，串行消费；期间新到的点会进入下一次消费
      const batch = this._pendingQueue;
      this._pendingQueue = [];
      this._processQueue = batch
        .reduce((chain, p) => chain.then(() => this._processPosition(p)), this._processQueue)
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
    this._hideElevProfile();

    this._speedHistory = [];
    if (this._speedChart) {
      this._speedChart.data.datasets[0].data = [];
      this._speedChart.update('none');
    }
    if (this._elevChart) {
      this._elevChart.data.datasets[0].data = [];
      this._elevChart.update('none');
    }

    this._gpsBtn.classList.remove('watching');
    this._gpsBtn.title = '定位到我的位置';

    Toast.show(' 持续追踪已关闭');
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
      // 重置海拔基准与转弯航向（每轮记录独立，任务B/A）
      this._altBase = null;
      this._lastSampleBearing = null;
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
   * 对刚停止记录的轨迹做 3D RTS 离线平滑（结束记录时的后处理）
   * 数据流：GPSManager._rawFixes（采集时已预转 GCJ02）→ smoothTrailRts3d
   * （水平 2D RTS + 海拔独立 1D RTS）→ 平滑 GCJ02
   * → 按 ts（GPS 事件时刻，与轨迹点 pt.ts 同源）匹配写回 trail.positions（含 altitude 回写）。
   * 匹配失败的点（如时间戳缺失）保留原值；无原始测量时静默跳过。
   */
  _applyTrailRtsSmoothing() {
    if (!this.gpsManager || !this.trail.positions || !this.trail.positions.length) return;
    try {
      // 取走并清空原始测量缓冲（smoothTrailRts3d 内部已清空）。
      // 水平走现有 2D RTS，海拔走独立 1D RTS（两者互不依赖），
      // 返回元素含 alt 字段（海拔平滑结果，null 表示无海拔/缺口）。
      const smoothed = this.gpsManager.smoothTrailRts3d();
      if (!smoothed || smoothed.length < 2) return;
      // 平滑输出已是 GCJ02（采集时已预转，RTS 全程 GCJ02 空间），直接回写，零二次转换。
      // 建立 ts → 平滑坐标 映射（ts 为 GPS 事件时刻，与轨迹点 pt.ts 同源逐位匹配）
      const byTs = new Map();
      for (let i = 0; i < smoothed.length; i++) {
        if (smoothed[i].ts != null) {
          byTs.set(smoothed[i].ts, { lat: smoothed[i].lat, lng: smoothed[i].lng, alt: smoothed[i].alt });
        }
      }
      let replaced = 0;
      let replacedAlt = 0;
      for (const pt of this.trail.positions) {
        // 匹配 key 优先 pt.ts（GPS 事件时刻，与 byTs 同源）；历史点无 ts 时回退 pt.time
        const smooth = byTs.get(pt.ts != null ? pt.ts : pt.time);
        if (smooth) {
          pt.lat = smooth.lat;
          pt.lng = smooth.lng;
          if (smooth.alt != null && Number.isFinite(smooth.alt)) {
            // 相对海拔（任务B）：RTS 平滑后的海拔同样减基准，与入库语义一致
            pt.altitude = this._altBase != null ? smooth.alt - this._altBase : smooth.alt;
            replacedAlt++;
          }
          replaced++;
        }
      }
      if (CONFIG.DEBUG) {
        console.log(`[RTS] 平滑 ${smoothed.length} 点，替换 ${replaced}/${this.trail.positions.length} 个轨迹点，含海拔 ${replacedAlt} 个`);
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

  _saveCurrentTrail() {
    if (!this.trail.positions || this.trail.positions.length === 0) return;
    const positions = this.trail.positions.slice();
    const name = Storage._fmtTrailName(Date.now());
    const health = (typeof TrailAnalysis !== 'undefined' && TrailAnalysis.analyzeHealth)
      ? TrailAnalysis.analyzeHealth(positions) : null;
    Storage.saveTrailToList(positions, name, false, { health }).then((id) => {
      if (id) {
        this._invalidateTrailCache();
        Toast.show(' 轨迹已保存');
      }
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
    this._updateRecStats(dist);

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

  /**
   * 实时统计卡刷新（录制/恢复轨迹时由 _updateTrailUI 调用）
   * @param {number} dist 已算好的轨迹总距离（米），避免重复全量计算
   */
  _updateRecStats(dist) {
    const pos = this.trail.positions;
    const setText = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    if (pos.length < 2) {
      setText('rec-duration', '--');
      setText('rec-avg-speed', '--');
      setText('rec-max-speed', '--');
      return;
    }

    const d = typeof dist === 'number' ? dist : this.trail.getDistance();
    const firstTime = pos[0].time || null;
    const lastTime = pos[pos.length - 1].time || null;
    let durationMs = 0;
    if (firstTime && lastTime && lastTime > firstTime) {
      durationMs = lastTime - firstTime;
    }
    const avgSpeed = durationMs > 0 ? d / (durationMs / 1000) : 0;
    const maxSpeed = this.trail.getMaxSpeed();

    setText('rec-duration', formatDurationShort(durationMs));
    setText('rec-avg-speed', avgSpeed > 0 ? (avgSpeed * 3.6).toFixed(1) + ' km/h' : '--');
    setText('rec-max-speed', maxSpeed > 0 ? (maxSpeed * 3.6).toFixed(1) + ' km/h' : '--');
  }

  /**
   * 计算一组轨迹点的核心统计（距离/时长/最高速/均速），供统计弹窗与实时统计卡共用
   * @param {Array} positions
   * @returns {{distance:number, durationMs:number, maxSpeed:number, hasSpeed:boolean, avgSpeed:number}}
   */
  _calcLiveStats(positions) {
    // 统一走 TrailAnalysis.calcStats（单一来源），消除与 _computeTrailStats 的重复遍历
    return TrailAnalysis.calcStats(positions);
  }

  /**
   * 海拔相对化（任务B）：以轨迹首个有效海拔点为基准(0)，之后只记录相对值。
   * GPS 绝对海拔单点误差常 10~30m，直接累加会污染爬升/下降统计；
   * 改为相对起点后，起伏量可信，绝对偏移被消除。
   * @param {number|null} alt 原始海拔(m)
   * @returns {number|null} 相对海拔(m)，首个有效点返回 0
   */
  _recordAltitude(alt) {
    if (alt == null || !Number.isFinite(alt)) return null;
    if (this._altBase == null) {
      this._altBase = alt; // 锁定基准（只取第一个有效点）
      if (CONFIG.DEBUG) console.log(`[ALT] 海拔基准锁定: ${alt.toFixed(1)}m`);
    }
    return alt - this._altBase;
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
        const dt = this.gpsManager.calibratedNow - this._lastCalcTime;
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
      this._lastCalcTime = this.gpsManager.calibratedNow;
      this._lastAccuracy = pos.accuracy;

      this.myPosition = convPos;
      this.myPositionTime = Date.now();
      this._recordFix(pos, convPos);

      // 静止自动暂停检查（仅手动开关开启时生效，统一用校准后时钟）
      this._checkAutoPause(this._lastSpeed, this.gpsManager.calibratedNow);

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
        // 计划 #3：动态采样距离 + 抖动门限（在 trail.js 既有 jitter/静止漂移过滤之上补充）
        const last = this.trail.lastPos;
        let dynMin = CONFIG.TRAIL_SAMPLE_MIN_DIST;
        let added = true; // 计划 #3：默认入库，抖动门限可置 false
        const spd = pos.speed != null ? pos.speed : (this._lastSpeed || 0);
        if (spd > CONFIG.TRAIL_SAMPLE_FAST_SPEED) {
          // 高速行进：放宽采样距离，减少冗余点、压缩存储
          dynMin = CONFIG.TRAIL_SAMPLE_MIN_DIST * CONFIG.TRAIL_SAMPLE_FAST_SCALE;
        }
        // 转弯强制采样（保弯）：当前段航向相对上次入库段变化超阈值且速度足够 →
        // 强制入库，绕过 dynMin 与抖动门限（Hampel 鬼点判仍生效，跳变不算转弯）。
        let forceSample = false;
        if (last && CONFIG.TRAIL_TURN_FORCE_SAMPLE && spd >= CONFIG.TRAIL_TURN_MIN_SPEED) {
          const curBearing = calcBearing(last, convPos);
          if (this._lastSampleBearing != null && Number.isFinite(curBearing)) {
            const angDiff = Math.abs(((curBearing - this._lastSampleBearing + 540) % 360) - 180);
            if (angDiff > CONFIG.TRAIL_TURN_ANGLE_DEG) forceSample = true;
          }
        }
        if (last) {
          const dM = calcDistance({ lat: last.lat, lng: last.lng }, convPos);
          if (!forceSample) {
          // 抖动门限：低速且位移小于 accuracy×ratio → 视为 GPS 噪声，不入库（地图标记已更新）
          if (spd < CONFIG.TRAIL_JITTER_MAX_SPEED &&
              dM < (pos.accuracy || 10) * CONFIG.TRAIL_JITTER_RATIO) {
            added = false; // 仅更新地图标记，不入库
          } else if (CONFIG.POS_FILTER.ENABLED) {
            // 显示层 Hampel 鬼点拒绝：用最近若干 fix 的中位数作参考，若当前点
            // 偏离过远（残差 > k·MAD）视为单点粗差/跳变，不入库（轨迹线不外推）。
            // 蓝点已用滑动窗平滑，此处进一步保证入库轨迹线干净（GPSBabel 式去抖）。
            const recent = this._recentFixes;
            if (recent.length >= 3) {
              const lats = recent.map(r => r.lat).sort((a, b) => a - b);
              const lngs = recent.map(r => r.lng).sort((a, b) => a - b);
              const ml = lats[Math.floor(lats.length / 2)];
              const mn = lngs[Math.floor(lngs.length / 2)];
              const madL = 1.4826 * medianAbsDev(lats, ml);
              const madN = 1.4826 * medianAbsDev(lngs, mn);
              const k = CONFIG.POS_FILTER.MAD_K;
              const badLat = madL > 1e-9 && Math.abs(convPos.lat - ml) > k * madL;
              const badLng = madN > 1e-9 && Math.abs(convPos.lng - mn) > k * madN;
              if (badLat || badLng) added = false; // 鬼点：仅更新蓝点，不入库
            }
          }
        }
        }
        added = added ? this.trail.addPoint({
          lat: convPos.lat,
          lng: convPos.lng,
          time: this.gpsManager.calibratedNow,
          ts: this.gpsManager.getCompensatedTs(pos.timestamp), // 时钟漂移补偿(任务D)
          accuracy: pos.accuracy || 0,
          speed: pos.speed,
          heading: pos.heading,
          altitude: this._recordAltitude(pos.altitude) // 相对基准海拔(任务B)
        }, dynMin) : false;
        if (added) {
          this._trailDirty = true;
          // 入库成功：更新转弯基准航向（供下次转弯判定）
          if (CONFIG.TRAIL_TURN_FORCE_SAMPLE) {
            const b = calcBearing(last || convPos, convPos);
            if (Number.isFinite(b)) this._lastSampleBearing = b;
          }
          this.mapManager.setTrail(this._getTrailPositions());
          this.mapManager.setRealtimeKeyPoints(TrailAnalysis.analyzeKeyPoints(this.trail.positions));
          this._updateTrailUI();
          if (this._isWatching) this._updateElevProfileChart(this.trail.positions);
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
    if (this._isReplaying && this._replayPlayer) {
      // 回放中切主题：只刷新 TrailPlayer 的 zIndex 100/101（已播+未播预览）色板。
      // 不要刷新 zIndex 10 地图轨迹层——回放期间地图层要么已被 _startReplay clearTrail 清空
      //（非并行回放），要么是并行记录轨迹（并行回放时保留原位）。若用 _replayPlayer.positions
      // 去 refreshTrailColors，会把回放轨迹又画一层到 zIndex 10，与回放路径叠加成"双轨迹"。
      if (typeof this._replayPlayer.refreshColors === 'function') {
        this._replayPlayer.refreshColors();
      }
      this._updateChartTheme();
      try {
        localStorage.setItem('trailcraft_theme', this._theme);
      } catch (e) {}
      this._updateThemeBtn();
      Toast.show(this._theme === 'light' ? ' 已切换为浅色主题' : ' 已切换为深色主题');
      return;
    }
    // 非回放状态：刷新地图当前实际显示的轨迹色板。
    // 必须用 mapManager._lastTrailInput（setTrail 最后一次收到的数组），
    // 不能用 _getTrailPositions()：后者返回滑动平滑后的会话轨迹，而地图可能正显示
    // 历史加载的原始轨迹（_loadTrailFromList 把 data.positions 塞进 trail.positions 后，
    // _getTrailPositions() 会对历史数据做平滑）→ 主题切换后轨迹形状被拉直/偏移，
    // 与回放（原始数据）形成"两条不同轨迹"。用 _lastTrailInput 保证重绘形状与切换前逐点一致。
    const trailInput = this.mapManager._lastTrailInput;
    const positions = trailInput && trailInput.length >= 2
      ? trailInput
      : this._getTrailPositions();
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
    if (!this._speedChart && !this._elevChart) return;
    const isDark = this._theme === 'dark';
    const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    const textColor = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
    // 速度曲线
    if (this._speedChart) {
      const scales = this._speedChart.options.scales;
      if (scales?.x?.ticks) scales.x.ticks.color = textColor;
      if (scales?.x?.title) scales.x.title.color = textColor;
      if (scales?.x?.grid) scales.x.grid.color = gridColor;
      if (scales?.y?.ticks) scales.y.ticks.color = textColor;
      if (scales?.y?.title) scales.y.title.color = textColor;
      if (scales?.y?.grid) scales.y.grid.color = gridColor;
      this._speedChart.update('none');
    }
    // 海拔剖面
    if (this._elevChart) {
      const scales = this._elevChart.options.scales;
      if (scales?.x?.ticks) scales.x.ticks.color = textColor;
      if (scales?.x?.title) scales.x.title.color = textColor;
      if (scales?.x?.grid) scales.x.grid.color = gridColor;
      if (scales?.y?.ticks) scales.y.ticks.color = textColor;
      if (scales?.y?.title) scales.y.title.color = textColor;
      if (scales?.y?.grid) scales.y.grid.color = gridColor;
      this._elevChart.update('none');
    }
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

  _saveState() {
    if (this._trailDirty) {
      this._trailDirty = false;
      Storage.saveTrail(this.trail);
    }
  }

  _writeEmergencySnapshot() {
    try {
      const snap = {
        positions: this.trail.positions,
        isRecording: this.trail.isRecording,
        isPaused: this.trail.isPaused,
        ts: Date.now()
      };
      localStorage.setItem(CONFIG.TRAIL_EMERGENCY_KEY, JSON.stringify(snap));
    } catch (e) {
      if (CONFIG.DEBUG) console.warn('[App] 紧急快照写入失败:', e.message);
    }
  }

  _restoreEmergencySnapshot(indexedData) {
    let raw = null;
    try { raw = localStorage.getItem(CONFIG.TRAIL_EMERGENCY_KEY); } catch (_) {}
    if (!raw) return;
    try { localStorage.removeItem(CONFIG.TRAIL_EMERGENCY_KEY); } catch (_) {}

    let snap = null;
    try { snap = JSON.parse(raw); } catch (_) {}
    if (!snap || !Array.isArray(snap.positions) || snap.positions.length === 0) return;

    // 仅当快照比 IndexedDB 数据更新时才采用，避免用旧快照覆盖新数据
    const snapTs = snap.ts || 0;
    const dbTs = (indexedData && indexedData.updatedAt) || 0;
    if (snapTs < dbTs) return;

    if (CONFIG.DEBUG) console.warn('[App] 检测到紧急快照，恢复', snap.positions.length, '个点');

    this.trail.positions = snap.positions;
    this.trail.lastPos = snap.positions[snap.positions.length - 1];
    if (snap.positions.length >= 2) {
      this.mapManager.setTrail(this._getTrailPositions());
      this.mapManager.setTrailMarkers(TrailAnalysis.analyzeKeyPoints(this._getTrailPositions()));
    }
    if (snap.isRecording) {
      this.trail.isRecording = true;
      this.trail.isPaused = snap.isPaused || false;
    }
    this._updateTrailUI();
    // 同步持久化，防止再次因强杀丢失
    Storage.saveTrail(this.trail);
    Toast.show('已恢复上次未保存的轨迹');
  }

  _loadState() {
    this._trailLoading = true;
    Storage.loadTrail().then(trailData => {
      this._trailLoading = false;
      if (trailData) {
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
      }

      // 紧急快照恢复（若快照比 IndexedDB 数据新）
      this._restoreEmergencySnapshot(trailData);

      this._updateTrailUI();
    }).catch(err => {
      console.warn('[App] 轨迹恢复失败:', err.message);
      this._restoreEmergencySnapshot(null);
      this._updateTrailUI();
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
    this._destroySpeedChart();
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
