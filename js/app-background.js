/**
 * 途刻 TraceCraft - 后台定位模块
 * =============================================
 * 通过 App.prototype.* 挂载到 App（须在 app-core.js 之后加载）：
 *  - _enterBackgroundMode / _exitBackgroundMode
 *  - _fallbackBackgroundLocate / _backgroundLocate / _processBackgroundPosition
 *  - _requestWakeLock / _releaseWakeLock
 *  - _hasNativeBgPlugin / _startNativeBackgroundTracking / _stopNativeBackgroundTracking / _stopStaleBg
 */

App.prototype._stopStaleBg = function () {
  if (!this._hasNativeBgPlugin()) return;
  try {
    Capacitor.Plugins.BackgroundGeolocation.stop();
  } catch (e) {}
};

App.prototype._hasNativeBgPlugin = function () {
  return typeof Capacitor !== 'undefined'
    && Capacitor.isNativePlatform()
    && Capacitor.Plugins
    && Capacitor.Plugins.BackgroundGeolocation;
};

App.prototype._startNativeBackgroundTracking = async function () {
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
      if (now - this._lastBgNativeTime < CONFIG.NATIVE_BG_MIN_INTERVAL) return;
      this._lastBgNativeTime = now;
      this._processBackgroundPosition({
        lat: location.latitude,
        lng: location.longitude,
        accuracy: location.accuracy,
        speed: location.speed,
        heading: location.bearing,
        altitude: this.gpsManager.filterAltitude(
          this.gpsManager._resolveAltitude(location.altitude),
          location.time
        ),
        timestamp: location.time,
      });
    });
    this._nativeBgStarted = true;
  } catch (e) {
    this._nativeBgStarted = false;
    this._fallbackBackgroundLocate();
  }
};

App.prototype._stopNativeBackgroundTracking = async function () {
  try {
    await Capacitor.Plugins.BackgroundGeolocation.stop();
  } catch (e) {}
  this._nativeBgStarted = false;
};

App.prototype._enterBackgroundMode = function () {
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
};

App.prototype._fallbackBackgroundLocate = function () {
  // 省电模式 20s/次，有电时 5s/次
  const interval = this.gpsManager.isPowerSaving
    ? CONFIG.BG_LOCATE_INTERVAL_POWER_SAVE
    : CONFIG.BG_LOCATE_INTERVAL_NORMAL;
  this._backgroundLocate();
  if (this._bgLocateInterval) clearInterval(this._bgLocateInterval);
  this._bgLocateInterval = setInterval(() => {
    this._backgroundLocate();
  }, interval);
};

App.prototype._exitBackgroundMode = function () {
  this._isBackground = false;

  if (this._nativeBgStarted) {
    this._stopNativeBackgroundTracking();
  }

  if (this._bgLocateInterval) {
    clearInterval(this._bgLocateInterval);
    this._bgLocateInterval = null;
  }

  this._releaseWakeLock();
};

App.prototype._backgroundLocate = async function () {
  if (this.gpsManager.isPowerSaving && this._batteryLevel != null && this._batteryLevel < 0.1) {
    return;
  }
  try {
    const pos = await this.gpsManager.getCurrentPosition(30000);
    await this._processBackgroundPosition(pos);
  } catch (e) {}
};

App.prototype._processBackgroundPosition = async function (pos) {
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
        time: this.gpsManager.calibratedNow,
        accuracy: pos.accuracy || 0,
        speed: pos.speed,
        heading: pos.heading,
        altitude: pos.altitude
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
};

App.prototype._requestWakeLock = async function () {
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
};

App.prototype._releaseWakeLock = function () {
  if (!this._wakeLock) return;
  try {
    this._wakeLock.release();
  } catch (e) {}
  this._wakeLock = null;
};
