/**
 * Trail Recorder - 主应用控制器
 * 协调 GPS、轨迹、存储与 UI 交互
 */

class App {
  constructor() {
    this.mapManager = new MapManager();
    this.gpsManager = new GPSManager();
    this.trail = new Trail();

    this._isWatching = false;
    this._firstFix = true;
    this._speedHistory = [];
    this._speedTrackingStart = 0;
    this._speedChart = null;
    this._batteryLevel = null;
    this._batteryCharging = false;
    this._trailSmoothing = true;
    this._theme = 'dark';
    this._dirty = false;
    this._intervalId = null;
  }

  init() {
    this.mapManager.init('map', CONFIG.DEFAULT_CENTER, CONFIG.DEFAULT_ZOOM);

    this._setupUI();
    this._restoreTheme();
    this._restoreTrailSmoothing();
    this._loadState();
    this._updateTrailUI();
    this._initBattery();
    this._updatePowerStatus();

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this._saveState();
      }
    });

    this._intervalId = setInterval(() => {
      this._saveState();
      this._updatePowerStatus();
    }, 30000);

    window.addEventListener('beforeunload', () => {
      this._saveState();
    });

    requestAnimationFrame(() => document.body.classList.add('app-ready'));
  }

  _setupUI() {
    this._recordBtn = document.getElementById('record-btn');
    this._pauseBtn = document.getElementById('pause-btn');
    this._stopBtn = document.getElementById('stop-btn');
    this._clearBtn = document.getElementById('clear-btn');
    this._statsBtn = document.getElementById('stats-btn');
    this._smoothBtn = document.getElementById('smooth-btn');
    this._powerBtn = document.getElementById('power-btn');
    this._locateBtn = document.getElementById('locate-btn');
    this._themeBtn = document.getElementById('theme-btn');
    this._statusEl = document.getElementById('status');
    this._distanceEl = document.getElementById('distance');
    this._durationEl = document.getElementById('duration');
    this._speedEl = document.getElementById('speed');
    this._maxSpeedEl = document.getElementById('max-speed');
    this._elevationEl = document.getElementById('elevation');
    this._pointsEl = document.getElementById('points');
    this._intervalEl = document.getElementById('interval');
    this._speedChartCanvas = document.getElementById('speed-chart');
    this._statsModal = document.getElementById('stats-modal');
    this._statsCloseBtn = document.getElementById('stats-close');

    this._recordBtn.addEventListener('click', () => this._toggleRecording());
    this._pauseBtn.addEventListener('click', () => this._togglePause());
    this._stopBtn.addEventListener('click', () => this._stopRecording());
    this._clearBtn.addEventListener('click', () => this._clearTrail());
    this._statsBtn.addEventListener('click', () => this._showStats());
    this._smoothBtn.addEventListener('click', () => this._toggleSmoothing());
    this._powerBtn.addEventListener('click', () => this._togglePowerSaving());
    this._locateBtn.addEventListener('click', () => this._locateMe());
    this._themeBtn.addEventListener('click', () => this._toggleTheme());
    this._statsCloseBtn.addEventListener('click', () => this._hideStats());
    this._statsModal.addEventListener('click', (e) => {
      if (e.target === this._statsModal) this._hideStats();
    });
  }

  _restoreTheme() {
    try {
      const saved = localStorage.getItem('trail_theme');
      if (saved === 'light' || saved === 'dark') {
        this._theme = saved;
        this._applyTheme();
      }
    } catch (_) {}
  }

  _applyTheme() {
    document.documentElement.setAttribute('data-theme', this._theme);
    this.mapManager.setTheme(this._theme);
    try {
      localStorage.setItem('trail_theme', this._theme);
    } catch (_) {}
  }

  _toggleTheme() {
    this._theme = this._theme === 'dark' ? 'light' : 'dark';
    this._applyTheme();
    if (this.trail.positions.length > 1) {
      this._renderTrail();
    }
  }

  _restoreTrailSmoothing() {
    try {
      const saved = localStorage.getItem('trail_smooth');
      if (saved !== null) this._trailSmoothing = saved === '1';
    } catch (_) {}
    this._smoothBtn.classList.toggle('active', this._trailSmoothing);
  }

  _toggleSmoothing() {
    this._trailSmoothing = !this._trailSmoothing;
    this._smoothBtn.classList.toggle('active', this._trailSmoothing);
    try {
      localStorage.setItem('trail_smooth', this._trailSmoothing ? '1' : '0');
    } catch (_) {}
    if (this.trail.positions.length > 1) {
      this._renderTrail();
    }
  }

  _toggleRecording() {
    if (this.trail.isRecording) {
      this._stopRecording();
    } else {
      this._startRecording();
    }
  }

  _startRecording() {
    this.trail.start();
    this._speedTrackingStart = Date.now();
    this._speedHistory = [];
    this._startWatching();
    this._updateTrailUI();
    Toast.show('开始记录');
  }

  _stopRecording() {
    if (!this.trail.isRecording) return;
    this.trail.stop();
    this._stopWatching();
    this._saveState();
    this._updateTrailUI();
    this._renderTrail();
    this._showStats();
    Toast.show('已停止记录');
  }

  _togglePause() {
    if (!this.trail.isRecording) return;
    if (this.trail.isPaused) {
      this.trail.resume();
      Toast.show('继续记录');
    } else {
      this.trail.pause();
      Toast.show('已暂停');
    }
    this._updateTrailUI();
    this._saveState();
  }

  _clearTrail() {
    if (!this.trail.isRecording && this.trail.positions.length === 0) return;
    this.trail.clear();
    Storage.clearTrail();
    this.mapManager.clearTrail();
    this._speedHistory = [];
    if (this._speedChart) {
      this._speedChart.data.datasets[0].data = [];
      this._speedChart.update('none');
    }
    this._updateTrailUI();
    Toast.show('已清除轨迹');
  }

  _showStats() {
    if (this.trail.positions.length < 2) {
      Toast.show('没有足够的轨迹数据');
      return;
    }

    const distance = this.trail.getDistance();
    const duration = this.trail.getDuration();
    const avgSpeed = this.trail.getAvgSpeed();
    const maxSpeed = this.trail.getMaxSpeed();
    const elevation = this.trail.getElevationGain();
    const points = this.trail.getPointCount();

    document.getElementById('stats-distance').textContent = formatDistance(distance);
    document.getElementById('stats-duration').textContent = formatDuration(duration);
    document.getElementById('stats-avg-speed').textContent = formatSpeed(avgSpeed);
    document.getElementById('stats-max-speed').textContent = formatSpeed(maxSpeed);
    document.getElementById('stats-elevation').textContent = formatAltitude(elevation);
    document.getElementById('stats-points').textContent = points;

    this._statsModal.classList.remove('hidden');
  }

  _hideStats() {
    this._statsModal.classList.add('hidden');
  }

  _togglePowerSaving() {
    const current = this.gpsManager.isPowerSaving;
    const next = this.gpsManager.togglePowerSaving();
    this._powerBtn.classList.toggle('active', next);
    Toast.show(next ? '省电模式已开启' : '省电模式已关闭');
  }

  _startWatching() {
    if (this._isWatching) return;

    this._isWatching = true;
    this._firstFix = true;

    this.gpsManager.onPositionChange = (pos) => {
      if (!this._isWatching) return;

      if (this.trail.isRecording && !this.trail.isPaused) {
        this.trail.addPoint(pos);
        this._dirty = true;
      }

      if (pos.speed != null) {
        const elapsed = (Date.now() - this._speedTrackingStart) / 1000;
        this._speedHistory.push({ x: Math.round(elapsed * 10) / 10, y: pos.speed });
        if (this._speedHistory.length > 5000) this._speedHistory.shift();
        this._updateSpeedChart();
      }

      this.mapManager.setLocation(pos, pos.accuracy, pos.heading);
      this._updateStatusDisplay(pos);
      this._updatePowerStatus();
      this._firstFix = false;
    };

    this.gpsManager.onError = (err) => {
      if (CONFIG.DEBUG) console.warn('[GPS] 追踪出错:', err.message);
    };

    this.gpsManager.onDowngrade = () => {
      Toast.show('已切换低精度定位');
    };

    this.gpsManager.onRecovery = (success) => {
      Toast.show(success ? 'GPS 信号恢复' : '继续使用低精度定位');
    };

    this.gpsManager.startWatching();
  }

  _stopWatching() {
    if (!this._isWatching) return;
    this._isWatching = false;
    this.gpsManager.stopWatching();
    this.gpsManager.onPositionChange = null;
    this.gpsManager.onError = null;
    this.gpsManager.onDowngrade = null;
    this.gpsManager.onRecovery = null;
  }

  async _locateMe() {
    try {
      Toast.show('正在定位...');
      const pos = await this.gpsManager.getCurrentPosition();
      this.mapManager.setLocation(pos, pos.accuracy, pos.heading);
      this.mapManager.flyTo(pos, CONFIG.LOCATION_ZOOM);
      this._updateStatusDisplay(pos);
      Toast.show(`定位成功（精度 ±${pos.accuracy.toFixed(0)} 米）`);
    } catch (err) {
      Toast.show(err.message);
    }
  }

  _renderTrail() {
    if (this.trail.positions.length < 2) {
      this.mapManager.clearTrail();
      return;
    }
    const positions = this._trailSmoothing
      ? this.trail.getSmoothedPositions(5)
      : this.trail.positions;
    this.mapManager.setTrail(positions, this._trailSmoothing);
  }

  _updateTrailUI() {
    const isRecording = this.trail.isRecording;
    const isPaused = this.trail.isPaused;

    this._recordBtn.textContent = isRecording ? '停止记录' : '开始记录';
    this._recordBtn.classList.toggle('recording', isRecording);
    this._recordBtn.innerHTML = isRecording
      ? '<span class="trail-dot"></span> 停止记录'
      : '开始记录';

    this._pauseBtn.disabled = !isRecording;
    this._pauseBtn.textContent = isPaused ? '继续' : '暂停';

    this._stopBtn.disabled = !isRecording;
    this._clearBtn.disabled = isRecording || this.trail.positions.length === 0;
    this._statsBtn.disabled = this.trail.positions.length < 2;

    if (this.trail.positions.length > 1) {
      this._statsBtn.textContent = '统计';
    } else {
      this._statsBtn.textContent = `统计 (${this.trail.positions.length})`;
    }

    if (isRecording) {
      const distance = this.trail.getDistance();
      const duration = this.trail.getDuration();
      const points = this.trail.getPointCount();

      this._distanceEl.textContent = formatDistance(distance);
      this._durationEl.textContent = formatDuration(duration);
      this._pointsEl.textContent = points;

      if (points > 1) {
        const avgSpeed = this.trail.getAvgSpeed();
        this._speedEl.textContent = formatSpeed(avgSpeed);
      }
    }
  }

  _updateStatusDisplay(pos) {
    if (!pos) return;

    const parts = [];
    if (pos.accuracy != null) {
      parts.push(`±${pos.accuracy.toFixed(0)}m`);
    }
    if (pos.speed != null && pos.speed > 0) {
      parts.push(formatSpeed(pos.speed));
    }
    this._statusEl.textContent = parts.join(' | ') || '定位中...';

    this._updateTrailUI();
  }

  _updatePowerStatus() {
    const interval = this.gpsManager.currentInterval;
    const intervalText = interval < 1000
      ? `${interval}ms`
      : `${(interval / 1000).toFixed(1)}s`;
    this._intervalEl.textContent = `定位间隔: ${intervalText}`;

    if (this._batteryLevel != null) {
      this._intervalEl.textContent += ` | 电量: ${(this._batteryLevel * 100).toFixed(0)}%`;
    }
  }

  _initBattery() {
    if (!navigator.getBattery) return;
    navigator.getBattery().then(battery => {
      this._batteryLevel = battery.level;
      this._batteryCharging = battery.charging;
      battery.addEventListener('levelchange', () => {
        this._batteryLevel = battery.level;
        this._updatePowerStatus();
      });
      battery.addEventListener('chargingchange', () => {
        this._batteryCharging = battery.charging;
      });
    }).catch(() => {});
  }

  _updateSpeedChart() {
    if (this._speedHistory.length < 2) {
      if (this._speedChart) {
        this._speedChart.data.datasets[0].data = this._speedHistory;
        this._speedChart.update('none');
      }
      return;
    }

    if (!this._speedChart) {
      this._speedChart = new Chart(this._speedChartCanvas, {
        type: 'line',
        data: {
          datasets: [{
            data: this._speedHistory,
            borderColor: '#00D4AA',
            backgroundColor: 'rgba(0, 212, 170, 0.1)',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.3,
            fill: true
          }]
        },
        options: {
          responsive: true,
          animation: false,
          plugins: {
            legend: { display: false },
            tooltip: { enabled: false }
          },
          scales: {
            x: {
              type: 'linear',
              title: { display: false },
              ticks: { display: false },
              grid: { display: false }
            },
            y: {
              title: { display: false },
              ticks: {
                color: this._theme === 'light' ? '#666' : '#aaa',
                callback: (v) => (v * 3.6).toFixed(0)
              },
              grid: {
                color: this._theme === 'light' ? '#eee' : 'rgba(255,255,255,0.1)'
              }
            }
          }
        }
      });
    } else {
      this._speedChart.data.datasets[0].data = this._speedHistory;
      this._speedChart.update('none');
    }
  }

  _saveState() {
    if (this._dirty || this.trail.isRecording || this.trail.positions.length > 0) {
      Storage.saveTrail(this.trail);
      this._dirty = false;
    }
  }

  _loadState() {
    Storage.loadTrail().then(data => {
      if (!data) return;

      if (data.positions && data.positions.length > 0) {
        this.trail.restore(data.positions, data.positions[data.positions.length - 1]);
        this._speedHistory = [];
        if (this.trail.positions.length > 1) {
          for (let i = 0; i < this.trail.positions.length; i++) {
            const p = this.trail.positions[i];
            if (p.speed != null) {
              this._speedHistory.push({
                x: (p.time ? (p.time / 1000) : i),
                y: p.speed
              });
            }
          }
        }
        this._renderTrail();
        this.mapManager.fitTrailBounds(this.trail.positions);
        Toast.show(`已恢复 ${this.trail.positions.length} 个轨迹点`);
      }

      if (data.isRecording) {
        this.trail.isRecording = true;
        this._updateTrailUI();
        Toast.show('检测到上次未完成的记录');
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
  window.app.init();
});
