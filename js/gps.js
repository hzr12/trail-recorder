/**
 * Trail Recorder - GPS 定位管理器
 * 使用浏览器原生 Geolocation API 获取设备位置
 * 支持单次定位 + 持续追踪 + 卡尔曼滤波 + 省电模式
 */

class KalmanFilter {
  constructor() {
    this._x = 0;
    this._y = 0;
    this._vx = 0;
    this._vy = 0;
    this._P = [2500, 0, 0, 0,
               0, 2500, 0, 0,
               0, 0, 25, 0,
               0, 0, 0, 25];
    this._refLat = 0;
    this._refLng = 0;
    this._cosLat = 1;
    this._lastTime = 0;
    this._initialized = false;
  }

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

  update(zLat, zLng, accuracy, time, speed) {
    if (!this._initialized || accuracy > 200) {
      this.init(zLat, zLng, time);
      return { lat: zLat, lng: zLng };
    }

    const dt = (time - this._lastTime) / 1000;
    this._lastTime = time;

    if (dt <= 0 || dt > 60) {
      this.init(zLat, zLng, time);
      return { lat: zLat, lng: zLng };
    }

    let mx = (zLng - this._refLng) * 111111 * this._cosLat;
    let my = (zLat - this._refLat) * 111111;

    if (Math.hypot(mx, my) > 3000) {
      this._reanchor();
      mx = (zLng - this._refLng) * 111111 * this._cosLat;
      my = (zLat - this._refLat) * 111111;
    }

    const accClamped = Math.max(Math.min(accuracy || 10, 100), 1);
    const speedFactor = Math.min(12, Math.max(1, (speed || 0) / 0.5));
    const q = Math.max(0.1, (0.5 / accClamped) * speedFactor);

    this._x += this._vx * dt;
    this._y += this._vy * dt;
    const dt2 = dt * dt;
    const q2 = q * q;
    const q00 = 0.25 * q2 * dt2 * dt2;
    const q02 = 0.5 * q2 * dt2 * dt;
    const q22 = q2 * dt2;

    const fp = new Array(16).fill(0);
    for (let i = 0; i < 4; i++) {
      const dRow = i < 2 ? dt : 0;
      const pr = i * 4;
      const pr2 = i < 2 ? (i + 2) * 4 : pr;
      fp[pr + 0] = this._P[pr + 0] + dRow * this._P[pr2 + 0];
      fp[pr + 1] = this._P[pr + 1] + dRow * this._P[pr2 + 1];
      fp[pr + 2] = this._P[pr + 2] + dRow * this._P[pr2 + 2];
      fp[pr + 3] = this._P[pr + 3] + dRow * this._P[pr2 + 3];
    }

    const P = new Array(16).fill(0);
    for (let i = 0; i < 4; i++) {
      P[i * 4 + 0] = fp[i * 4 + 0] + dt * fp[i * 4 + 2];
      P[i * 4 + 1] = fp[i * 4 + 1] + dt * fp[i * 4 + 3];
      P[i * 4 + 2] = fp[i * 4 + 2];
      P[i * 4 + 3] = fp[i * 4 + 3];
    }
    P[0] += q00; P[5] += q00;
    P[2] += q02; P[8] += q02;
    P[7] += q02; P[13] += q02;
    P[10] += q22; P[15] += q22;

    const sigma = Math.max(3, Math.min(accClamped, 100));
    const r = sigma * sigma;
    const s00 = P[0] + r, s01 = P[1], s10 = P[4], s11 = P[5] + r;
    const det = s00 * s11 - s01 * s10;
    const si00 = s11 / det, si01 = -s01 / det, si10 = -s10 / det, si11 = s00 / det;
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

    const dtSafe = Math.max(dt, 0.1);
    this._vx += 0.3 * (k20 * e0 + k21 * e1) / dtSafe;
    this._vy += 0.3 * (k30 * e0 + k31 * e1) / dtSafe;

    const spd = Math.hypot(this._vx, this._vy);
    if (spd > 120) {
      const k = 120 / spd;
      this._vx *= k;
      this._vy *= k;
    }

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
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const v = (Pn[i * 4 + j] + Pn[j * 4 + i]) / 2;
        this._P[i * 4 + j] = v;
      }
    }

    return {
      lat: this._refLat + this._y / 111111,
      lng: this._refLng + this._x / (111111 * this._cosLat)
    };
  }

  _reanchor() {
    const curLat = this._refLat + this._y / 111111;
    const curLng = this._refLng + this._x / (111111 * this._cosLat);
    this._refLat = curLat;
    this._refLng = curLng;
    this._cosLat = Math.cos(curLat * Math.PI / 180);
    this._x = 0;
    this._y = 0;
  }

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

    this.onPositionChange = null;
    this.onError = null;
    this.onWatchStart = null;
    this.onWatchStop = null;
    this.onDowngrade = null;
    this.onRecovery = null;
    this.onPowerSavingChange = null;
    this.onCriticalBattery = null;
    this.onRestoreTracking = null;

    this._consecutiveTimeouts = 0;
    this._downgraded = false;
    this._lastPositionTime = 0;
    this._timeoutCheckId = null;
    this._recoveryTimerId = null;

    this._useFilter = true;
    this._filter = new KalmanFilter();
    this._rawPosition = null;

    this._lowBattery = false;
    this._powerSaving = false;
    this._powerSavingLocked = false;
    this._battery = null;
    this._batteryCheck = null;
    this._autoStoppedByBattery = false;
    this._initBatteryMonitor();

    this._lastProcessedTime = 0;
    this._lastActualInterval = 0;
    this._gpsMinInterval = 1000;
    this._gpsPowerSavingInterval = 20000;
    this._bestPendingPosition = null;
  }

  _updateAdaptiveInterval(speed) {
    const s = typeof speed === 'number' && isFinite(speed) ? speed : null;
    let base;
    if (s === null) base = CONFIG.GPS_ADAPTIVE_K / 1.6;
    else if (s <= 0) base = CONFIG.GPS_MAX_INTERVAL;
    else base = CONFIG.GPS_ADAPTIVE_K / s;
    let interval = Math.min(Math.max(base, CONFIG.GPS_MIN_INTERVAL), CONFIG.GPS_MAX_INTERVAL);
    if (this._powerSaving) interval = Math.max(interval, this._gpsPowerSavingInterval);
    this._gpsMinInterval = Math.round(interval);
  }

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
          this._powerSavingLocked = true;
          if (!this._powerSaving) {
            this.togglePowerSaving(true);
            if (this.onPowerSavingChange) this.onPowerSavingChange(true);
          } else {
            if (this.isWatching) {
              this.stopWatching();
              this.startWatching({ enableHighAccuracy: false, timeout: 15000, maximumAge: 15000 });
            }
          }
        }
        if (battery.level < 0.1 && this.isWatching) {
          console.warn('[GPS] 电量低于 10%，自动停止追踪');
          this._autoStoppedByBattery = true;
          this.stopWatching();
          if (this.onCriticalBattery) this.onCriticalBattery();
        }
        if (battery.level < 0.05 && !battery.charging) {
          console.warn('[GPS] 电量低于 5%');
          if (this.isWatching) {
            this._autoStoppedByBattery = true;
            this.stopWatching();
            if (this.onCriticalBattery) this.onCriticalBattery();
          }
        }
        if (!this._lowBattery && this._powerSavingLocked && battery.charging) {
          this._powerSavingLocked = false;
          if (CONFIG.DEBUG) console.log('[GPS] 电量恢复，省电模式已解锁');
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

  _cleanupBatteryMonitor() {
    if (this._battery && this._batteryCheck) {
      this._battery.removeEventListener('levelchange', this._batteryCheck);
      this._battery.removeEventListener('chargingchange', this._batteryCheck);
      this._battery = null;
      this._batteryCheck = null;
    }
  }

  togglePowerSaving(force) {
    if (this._powerSavingLocked && force === false) {
      console.warn('[GPS] 电量不足，省电模式已锁定');
      return true;
    }
    const next = force !== undefined ? force : !this._powerSaving;
    if (next === this._powerSaving) return this._powerSaving;
    this._powerSaving = next;
    if (CONFIG.DEBUG) console.log(`[GPS] 省电模式: ${next ? '开启' : '关闭'}`);

    this._updateAdaptiveInterval(this.currentPosition ? this.currentPosition.speed : 0);

    if (this.isWatching) {
      this.stopWatching();
      if (next) {
        this.startWatching({ enableHighAccuracy: false, timeout: 15000, maximumAge: 30000 });
      } else {
        this.startWatching({ enableHighAccuracy: true, timeout: CONFIG.GPS_WATCH_TIMEOUT, maximumAge: 2000 });
      }
    }
    return this._powerSaving;
  }

  get isPowerSaving() {
    return this._powerSaving;
  }

  _getCurrentTimeout() {
    return Math.max(
      this._downgraded ? CONFIG.GPS_LOW_ACCURACY_TIMEOUT : CONFIG.GPS_WATCH_TIMEOUT,
      this._gpsMinInterval + 5000
    );
  }

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
        this._lastPositionTime = Date.now();
      }
    }, 1000);
  }

  _stopTimeoutWatch() {
    if (this._timeoutCheckId !== null) {
      clearInterval(this._timeoutCheckId);
      this._timeoutCheckId = null;
    }
  }

  _downgrade() {
    if (this._downgraded) return;
    this._downgraded = true;
    this._consecutiveTimeouts = 0;
    if (CONFIG.DEBUG) console.warn('[GPS] 连续超时达阈值，降级到低精度定位');
    if (this.onDowngrade) this.onDowngrade(this._consecutiveTimeouts);

    if (this.isWatching) {
      this.stopWatching();
      this.startWatching({
        enableHighAccuracy: false,
        timeout: CONFIG.GPS_LOW_ACCURACY_TIMEOUT,
        maximumAge: 5000
      });
    }

    this._startRecoveryTimer();
  }

  _startRecoveryTimer() {
    this._stopRecoveryTimer();
    this._recoveryTimerId = setInterval(() => {
      this._tryRecovery();
    }, CONFIG.GPS_RECOVERY_INTERVAL_MS);
  }

  _stopRecoveryTimer() {
    if (this._recoveryTimerId !== null) {
      clearInterval(this._recoveryTimerId);
      this._recoveryTimerId = null;
    }
  }

  async _tryRecovery() {
    if (!this._downgraded || !this.isWatching) return;
    if (this._powerSaving) return;
    if (CONFIG.DEBUG) console.log('[GPS] 尝试恢复高精度定位...');
    try {
      await this.getCurrentPosition(CONFIG.GPS_WATCH_TIMEOUT);
      this._downgraded = false;
      this._consecutiveTimeouts = 0;
      this._lastProcessedTime = Date.now();
      this._stopRecoveryTimer();
      if (CONFIG.DEBUG) console.log('[GPS] 高精度定位恢复成功');
      if (this.onRecovery) this.onRecovery(true);

      if (this.isWatching) {
        this.stopWatching();
        this.startWatching({
          enableHighAccuracy: true,
          timeout: CONFIG.GPS_WATCH_TIMEOUT,
          maximumAge: 2000
        });
      }
    } catch (err) {
      console.warn('[GPS] 恢复高精度失败:', err.message);
      if (this.onRecovery) this.onRecovery(false);
    }
  }

  _resetTimeouts() {
    if (this._consecutiveTimeouts > 0) {
      if (CONFIG.DEBUG) console.log(`[GPS] 位置更新，重置连续超时计数（was ${this._consecutiveTimeouts}）`);
    }
    this._consecutiveTimeouts = 0;
    this._lastPositionTime = Date.now();
  }

  getCurrentPosition(timeout) {
    const t = timeout || CONFIG.GPS_TIMEOUT;
    const fallbackMs = Math.max(t + 5000, 15000);

    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('您的设备不支持地理定位功能'));
        return;
      }

      const fallbackTimer = setTimeout(() => {
        reject(new Error('定位请求无响应（' + (fallbackMs / 1000).toFixed(0) + ' 秒超时）'));
      }, fallbackMs);

      navigator.geolocation.getCurrentPosition(
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
          maximumAge: 0
        }
      );
    });
  }

  startWatching(options) {
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
          const rawSpeed = position.coords.speed;
          const rawSpeedOK = rawSpeed != null && rawSpeed > CONFIG.GPS_MOVE_THRESHOLD;

          const curAcc = position.coords.accuracy || Infinity;
          if (!this._bestPendingPosition || curAcc < this._bestPendingPosition.accuracy) {
            this._bestPendingPosition = buildPos();
          }
          this._lastPositionTime = now;
          this._consecutiveTimeouts = 0;

          if (!rawSpeedOK) return;
        }
        this._lastActualInterval = prevProcessedTime ? now - prevProcessedTime : 0;
        this._lastProcessedTime = now;

        const currentPos = buildPos();
        const bestPos = this._bestPendingPosition &&
          this._bestPendingPosition.accuracy <= (currentPos.accuracy || Infinity) / 2
          ? this._bestPendingPosition : currentPos;
        this._bestPendingPosition = null;

        const pos = { ...bestPos };
        this._rawPosition = { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, speed: pos.speed, heading: pos.heading, timestamp: pos.timestamp };

        if (this._useFilter && pos.accuracy > 0 && pos.accuracy < 200) {
          const ts = now;
          const acc = pos.accuracy || 10;
          const filtered = this._filter.update(pos.lat, pos.lng, acc, ts, pos.speed);
          pos.lat = filtered.lat;
          pos.lng = filtered.lng;
        } else {
          this._filter.reset();
        }

        this.currentPosition = pos;
        this._resetTimeouts();
        this._updateAdaptiveInterval(pos.speed);
        if (this.onPositionChange) this.onPositionChange(pos);
      },
      (error) => {
        let message;
        switch (error.code) {
          case error.PERMISSION_DENIED:
            message = '定位权限被拒绝';
            this.stopWatching();
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

    this._startTimeoutWatch();
    if (this.onWatchStart) this.onWatchStart();
  }

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

  destroy() {
    this._destroyed = true;
    this.stopWatching();
    this._cleanupBatteryMonitor();
  }

  getLastPosition() {
    return this.currentPosition;
  }

  get lastRawPosition() {
    return this._rawPosition ? { ...this._rawPosition } : null;
  }

  toggleFilter(force) {
    const next = force !== undefined ? force : !this._useFilter;
    if (next === this._useFilter) return this._useFilter;
    this._useFilter = next;
    if (!next) {
      this._filter.reset();
    }
    return this._useFilter;
  }

  get isDowngraded() {
    return this._downgraded;
  }

  get consecutiveTimeouts() {
    return this._consecutiveTimeouts;
  }

  get currentInterval() {
    return this._gpsMinInterval;
  }

  get lastActualInterval() {
    return this._lastActualInterval;
  }
}
