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
    this._panelMediaQuery = null;
    this._panelMediaqueryChange = null;
    this._lastCalcPos = null;
    this._lastCalcTime = null;
    this._lastAccuracy = null;
    this._theme = 'dark';
    this._trailSmoothing = true;
    this._processQueue = Promise.resolve();
    this._queuePending = 0;
    this._replayPlayer = null;
    this._isReplaying = false;
    this._replaySpeed = 1;
    this._replayFollowMode = true;
  }

  init() {
    this.mapManager.init('map', CONFIG.DEFAULT_CENTER, CONFIG.DEFAULT_ZOOM);
    this._setupUI();

    if (this._panelCollapsed) {
      this._bottomPanel.classList.add('collapsed');
    }
    this._panelMediaQuery = window.matchMedia(`(max-width: ${CONFIG.MOBILE_BREAKPOINT}px)`);
    this._panelMediaqueryChange = (e) => {
      this._panelCollapsed = e.matches;
      this._bottomPanel.classList.toggle('collapsed', e.matches);
    };
    this._panelMediaQuery.addEventListener('change', this._panelMediaqueryChange);

    this._restoreTheme();
    this._restoreTrailSmoothing();
    this._loadState();
    this._updateTrailUI();

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
    document.getElementById('trail-pause-btn').addEventListener('click', () => this._toggleTrailPause());
    document.getElementById('trail-clear-btn').addEventListener('click', () => this._clearTrail());
    document.getElementById('trail-save-btn').addEventListener('click', () => this._saveCurrentTrailToList());
    document.getElementById('trail-stats-btn').addEventListener('click', () => this._showTrailStats());
    document.getElementById('trail-smooth-btn').addEventListener('click', () => this._toggleTrailSmoothing());
    document.getElementById('export-report-btn').addEventListener('click', () => this._exportReport());
    document.getElementById('power-saving-btn').addEventListener('click', () => this._togglePowerSaving());

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

    document.querySelectorAll('.speed-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const speed = parseFloat(btn.dataset.speed);
        this._setReplaySpeed(speed);
      });
    });

    this._statusEl = document.getElementById('gps-status');
    this._gnssBarEl = document.getElementById('gnss-bar');

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
      this._bottomPanel.classList.toggle('collapsed', this._panelCollapsed);
    });

    document.getElementById('theme-btn').addEventListener('click', () => this._toggleTheme());

    // Tab 切换
    document.querySelectorAll('.mode-tab').forEach((btn) => {
      btn.addEventListener('click', () => this._setTab(btn.dataset.tab));
    });
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
    const recordEl = document.getElementById('tab-record');
    const replayEl = document.getElementById('tab-replay');
    const historyEl = document.getElementById('tab-history');
    if (recordEl) recordEl.style.display = tab === 'record' ? '' : 'none';
    if (replayEl) replayEl.style.display = tab === 'replay' ? '' : 'none';
    if (historyEl) historyEl.style.display = tab === 'history' ? '' : 'none';
    if (tab === 'history') this._renderTrailList();
    if (tab === 'replay') this._renderReplayTrailList();
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
        if (now - this._lastBgNativeTime < 30000) return;
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
    const interval = this.gpsManager.isPowerSaving ? 60000 : 15000;
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
    this._updateTrailUI();
    this._trailDirty = true;
    Storage.clearTrail();

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

  _toggleTrailRecording() {
    if (this.trail.isRecording) {
      const pointCount = this.trail.positions.length;
      this.trail.stop();
      this._trailDirty = true;
      if (pointCount === 0) {
        Storage.clearTrail();
        Toast.show(' 未记录到轨迹数据');
      } else {
        Storage.saveTrail(this.trail);
        this._saveCurrentTrail();
        Toast.show(' 轨迹记录已停止');
      }
    } else {
      this.trail.start();
      this.mapManager.clearTrail();
      Toast.show(' 轨迹记录已开始');
    }
    this._updateTrailUI();
  }

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

    if (this.trail.isRecording) {
      Toast.show(' 记录中无法回放，请先停止记录');
      return;
    }

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

    if (this._replayPlayer) {
      this._replayPlayer.destroy();
      this._replayPlayer = null;
    }

    this._replayPlayer = new TrailPlayer(positions, this.mapManager, {
      onProgress: (progress) => this._onReplayProgress(progress),
      onComplete: () => this._onReplayComplete(),
      onFrame: (point, index) => this._onReplayFrame(point, index)
    });

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
    } else {
      this._replayPlayer.play();
    }

    this._updateReplayUI();
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
    if (this._replayFollowMode && this.mapManager.map) {
      this.mapManager.map.panTo(new qq.maps.LatLng(point.lat, point.lng));
    }
  }

  _onReplayComplete() {
    this._updateReplayUI();
    Toast.show(' 回放完成');
  }

  _updateReplayUI() {
    if (!this._replayPlayer) return;

    const playBtn = document.getElementById('replay-play-btn');
    if (playBtn) {
      const isPlaying = this._replayPlayer.isPlaying;
      playBtn.classList.toggle('playing', isPlaying);
      const icon = document.getElementById('replay-play-icon');
      if (icon) {
        if (isPlaying) {
          icon.setAttribute('points', '6,4 10,4 10,20 6,20');
          icon.setAttribute('points', '6,4 10,4 10,20 6,20');
          // Use a pause icon instead
          playBtn.querySelector('svg').innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
        } else {
          playBtn.querySelector('svg').innerHTML = '<polygon points="6,4 20,12 6,20"/>';
        }
      }
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
    const speedKmh = (info.currentSpeed || 0) * 3.6;
    const direction = bearingToDir(info.currentHeading || 0);
    const elapsed = TrailPlayer.formatDuration(info.elapsedMs);
    const remaining = TrailPlayer.formatDuration(info.remainingMs);

    infoEl.innerHTML = `
      进度: ${elapsed} | 剩余: ${remaining}<br>
      速度: <span class="speed-val">${speedKmh.toFixed(1)} km/h</span> | 方向: ${direction} | 距离: ${formatDistance(info.distance)}
    `;
  }

  _restoreTrailSmoothing() {
    try {
      const pref = localStorage.getItem('trailcraft_trail_smooth');
      if (pref !== null) this._trailSmoothing = pref === '1';
    } catch (e) {}
  }

  // ===== 轨迹列表管理 =====

  _saveCurrentTrailToList() {
    if (!this.trail.positions || this.trail.positions.length < 2) {
      Toast.show(' 轨迹点数不足，无法保存');
      return;
    }

    const positions = this.trail.positions.slice();
    const distance = this.trail.getDistance();
    const duration = this.trail.getDuration ? this.trail.getDuration() : 0;
    const maxSpeed = this.trail.getMaxSpeed ? this.trail.getMaxSpeed() : 0;
    const avgSpeed = distance / Math.max(1, duration / 1000);
    const name = Storage._fmtTrailName(Date.now());

    Toast.show(' 正在保存...', true);

    Storage.saveTrailToList(positions, name).then((id) => {
      if (id) {
        // 显示保存成功，然后清空当前轨迹并切换到历史 Tab
        const itemCount = positions.length;
        const distStr = distance >= 1000
          ? (distance / 1000).toFixed(2) + ' km'
          : Math.round(distance) + ' m';

        // 保存当前轨迹信息用于撤销恢复
        const savedState = {
          positions: positions.slice(),
          trailState: { ...this.trail },
          hadActiveTrail: true
        };

        Toast.showUndo(' 轨迹已保存到历史', () => {
          // 撤销保存：删除刚保存的轨迹并恢复原轨迹
          Storage.deleteTrail(id).then((success) => {
            if (success) {
              // 恢复原轨迹
              this.trail.clear();
              this.trail.positions = savedState.positions;
              if (savedState.trailState.lastPos) {
                this.trail.lastPos = savedState.trailState.lastPos;
              }
              this.mapManager.clearTrail();
              this.mapManager.setTrail(this._getTrailPositions());
              this._trailDirty = true;
              this._updateTrailUI();
              
              // 切回记录 Tab
              this._setTab('record');
              
              Toast.show(' 已撤销保存');
            } else {
              Toast.show(' 撤销失败');
            }
          });
        }, 8000);

        // 清空当前轨迹
        this.trail.clear();
        this.mapManager.clearTrail();
        Storage.clearTrail();
        this._trailDirty = false;
        this._updateTrailUI();

        // 切换到历史 Tab 查看
        this._setTab('history');
        this._renderTrailList();
      } else {
        Toast.show(' 保存失败，请重试');
      }
    });
  }

  _saveCurrentTrail() {
    if (!this.trail.positions || this.trail.positions.length === 0) return;
    const positions = this.trail.positions.slice();
    const name = Storage._fmtTrailName(Date.now());
    Storage.saveTrailToList(positions, name).then((id) => {
      if (id) Toast.show(' 轨迹已保存');
    });
  }

  _renderTrailList() {
    const listEl = document.getElementById('trail-list');
    if (!listEl) return;
    Storage.loadTrailList().then((items) => {
      if (!items || items.length === 0) {
        listEl.innerHTML = '<div class="trail-list-empty">暂无历史轨迹</div>';
        return;
      }
      listEl.innerHTML = items.map((item) => {
        const d = new Date(item.createdAt);
        const pad = (n) => String(n).padStart(2, '0');
        const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const distStr = item.distance >= 1000
          ? (item.distance / 1000).toFixed(2) + ' km'
          : Math.round(item.distance) + ' m';
        return `<div class="trail-list-item" data-id="${item.id}">
          <span class="trail-item-dot"></span>
          <div class="trail-item-info">
            <div class="trail-item-name" data-id="${item.id}">${item.name}</div>
            <div class="trail-item-meta">${dateStr} · ${distStr}</div>
          </div>
          <div class="trail-item-actions">
            <button class="trail-item-btn load-btn" data-id="${item.id}" title="加载到地图">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
            </button>
            <button class="trail-item-btn delete-btn" data-id="${item.id}" title="删除">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </div>`;
      }).join('');

      listEl.querySelectorAll('.trail-item-btn.load-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._loadTrailFromList(btn.dataset.id);
        });
      });

      listEl.querySelectorAll('.trail-item-btn.delete-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._deleteTrailFromList(btn.dataset.id);
        });
      });

      listEl.querySelectorAll('.trail-item-name').forEach((el) => {
        el.addEventListener('click', () => this._renameTrail(el.dataset.id, el));
      });
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

      // 加载轨迹到地图
      this.trail.clear();
      this.trail.positions = data.positions;
      this.trail.lastPos = data.positions[data.positions.length - 1];
      this.mapManager.setTrail(this._getTrailPositions());
      this._updateTrailUI();

      Toast.show(` 已加载「${data.name}」（${data.positions.length} 点）`);

      // 自动开始回放
      setTimeout(() => {
        this._startReplay(this._getTrailPositions(), data.name);
      }, 300);
    });
  }

  _renderReplayTrailList() {
    const listEl = document.getElementById('replay-trail-list');
    if (!listEl) return;
    Storage.loadTrailList().then((items) => {
      if (!items || items.length === 0) {
        listEl.innerHTML = '<div class="trail-list-empty">暂无历史轨迹</div>';
        return;
      }
      listEl.innerHTML = items.map((item) => {
        const d = new Date(item.createdAt);
        const pad = (n) => String(n).padStart(2, '0');
        const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const distStr = item.distance >= 1000
          ? (item.distance / 1000).toFixed(2) + ' km'
          : Math.round(item.distance) + ' m';
        return `<div class="trail-list-item" data-id="${item.id}">
          <span class="trail-item-dot" style="background:#FF9500"></span>
          <div class="trail-item-info">
            <div class="trail-item-name">${item.name}</div>
            <div class="trail-item-meta">${dateStr} · ${distStr} · ${item.pointCount || 0} 点</div>
          </div>
          <div class="trail-item-actions">
            <button class="trail-item-btn replay-btn" data-id="${item.id}" title="回放">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <polygon points="6,4 20,12 6,20"/>
              </svg>
            </button>
            <button class="trail-item-btn load-btn" data-id="${item.id}" title="加载">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
            </button>
          </div>
        </div>`;
      }).join('');

      listEl.querySelectorAll('.trail-item-btn.replay-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._replayTrailFromList(btn.dataset.id);
        });
      });

      listEl.querySelectorAll('.trail-item-btn.load-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._loadTrailFromList(btn.dataset.id);
        });
      });
    });
  }

  _loadTrailFromList(id) {
    Storage.loadTrailById(id).then((data) => {
      if (!data || !data.positions || data.positions.length < 2) {
        Toast.show(' 轨迹数据不足');
        return;
      }
      this.trail.clear();
      this.trail.positions = data.positions;
      this.trail.lastPos = data.positions[data.positions.length - 1];
      this.mapManager.setTrail(this._getTrailPositions());
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
        Toast.showUndo(`已删除「${name}」`, () => {
          Storage.loadTrailById(id).then((data) => {
            if (data && data.positions) {
              Storage.saveTrailToList(data.positions, name);
              this._renderTrailList();
            }
          });
        });
        this._renderTrailList();
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
        Storage.renameTrail(id, newName);
      }
    };

    el.onblur = commit;
    el.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      if (e.key === 'Escape') { el.textContent = oldName; el.blur(); }
    };
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

      ctx.fillStyle = isDark ? '#0f3460' : '#dce5f0';
      ctx.fillRect(mapX, mapY, mapW, mapH);

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
      ctx.fillText('途刻 TraceCraft', W - 24 * S, H - 16 * S);
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
              text: '途刻 TraceCraft — 轨迹活动报告',
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
    const saveBtn = this._trailSaveBtn || (this._trailSaveBtn = document.getElementById('trail-save-btn'));
    const statsBtn = this._trailStatsBtn || (this._trailStatsBtn = document.getElementById('trail-stats-btn'));
    const exportBtn = this._trailExportBtn || (this._trailExportBtn = document.getElementById('export-report-btn'));
    const smoothBtn = this._trailSmoothBtn || (this._trailSmoothBtn = document.getElementById('trail-smooth-btn'));
    const distEl = this._trailDistEl || (this._trailDistEl = document.getElementById('trail-distance'));

    if (btn) {
      btn.classList.toggle('recording', this.trail.isRecording);
      btn.innerHTML = this.trail.isRecording
        ? '<span class="trail-dot"></span> 记录中...'
        : '<span class="trail-dot"></span> 开始记录';
    }

    if (pauseBtn) {
      pauseBtn.disabled = !this.trail.isRecording;
      pauseBtn.textContent = this.trail.isPaused ? '继续' : '暂停';
    }

    const dist = this.trail.getDistance();
    if (distEl) {
      distEl.textContent = dist > 0 ? formatDistance(dist) : '0m';
    }

    const hasPoints = this.trail.positions.length > 0;
    if (clearBtn) clearBtn.disabled = !hasPoints;
    if (saveBtn) {
      const canSave = this.trail.positions.length >= 2 && !this.trail.isRecording;
      saveBtn.disabled = !canSave;
      saveBtn.classList.toggle('active', canSave);
    }
    if (statsBtn) statsBtn.disabled = this.trail.positions.length < 2;
    if (exportBtn) exportBtn.disabled = this.trail.positions.length < 2;

    if (smoothBtn) {
      smoothBtn.classList.toggle('active', this._trailSmoothing);
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

      this._fetchWeather();

      this.mapManager.setLocation(convPos, pos.accuracy, pos.heading);

      if (this._firstFix) {
        this._firstFix = false;

        if (this._restoringView) {
          this._restoringView = false;
        } else {
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
      } else if (this._isWatching) {
        if (this._followMode) {
          this.mapManager.flyTo(convPos);
        }
      }

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
    this._fetchWeatherOpenMeteo(lat, lng)
      .catch(() => {});
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
        const wind = cur.wind_speed_10m;
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
        this._weatherHtml = `<span class="gps-weather">${temp}°C${feelsText} ${wind}km/h${humidityText}${desc ? ' ' + desc : ''}${sunText}</span>`;
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
        if (battery.level <= 0.15 && !battery.charging) {
          Toast.show('电量不足 15%，建议开启省电模式');
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
