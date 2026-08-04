/**
 * Trail Recorder - 应用主类
 * 协调 GPS、地图、轨迹、存储模块
 */

class TrailApp {
  constructor() {
    this.mapManager = null;
    this.gpsManager = null;
    this.trail = new Trail();
    this.isWatching = false;
    this._trailSmoothing = true;
    this._speedHistory = [];
    this._speedChart = null;
    this._histogramChart = null;
    this._saveTimer = null;
    this._startTime = null;
    this._elapsedTimer = null;
    this._activeTrailId = null;

    // DOM 缓存
    this._els = {};
  }

  async init() {
    // 先让页面可见，避免初始化失败时黑屏
    document.body.classList.add('app-ready');

    try {
      // 初始化地图
      this.mapManager = new MapManager();
      this.mapManager.init('map', CONFIG.DEFAULT_CENTER, CONFIG.DEFAULT_ZOOM);

      // 初始化 GPS
      this.gpsManager = new GPSManager();

      // 恢复主题设置
      this._loadPreferences();

      // 迁移旧数据
      await Storage.migrateFromOld();

      // 加载历史轨迹
      await this._loadHistory();

      // 设置地图回调
      this.mapManager.onMapClick = (pos) => {
        this._processPosition({ ...pos, timestamp: Date.now() });
      };

      // 绑定事件
      this._bindEvents();

      // 启动时检查是否有进行中的轨迹
      await this._checkResumeTrail();

      // 启动定期保存
      this._startAutoSave();

      // 初始化速度曲线（始终可见）
      this._initSpeedChart();

      // 默认开启持续定位追踪
      this._startWatching();
    } catch (e) {
      console.error('[App] 初始化失败:', e);
    }

    if (CONFIG.DEBUG) console.log('[App] 初始化完成');
  }

  _loadPreferences() {
    try {
      const theme = localStorage.getItem('trailrecorder_theme') || 'dark';
      const accent = localStorage.getItem('trailrecorder_accent') || 'cyan';
      document.documentElement.setAttribute('data-theme', theme);
      document.documentElement.setAttribute('data-accent', accent);
      this.mapManager.setTheme(theme);
    } catch (e) {}
  }

  _savePreferences() {
    try {
      localStorage.setItem('trailrecorder_theme', document.documentElement.getAttribute('data-theme'));
      localStorage.setItem('trailrecorder_accent', document.documentElement.getAttribute('data-accent'));
    } catch (e) {}
  }

  async _loadHistory() {
    try {
      const trails = await Storage.loadAllTrails();
      this._renderHistoryList(trails);
    } catch (e) {
      console.warn('[App] 加载历史失败:', e);
    }
  }

  async _checkResumeTrail() {
    try {
      const trails = await Storage.loadAllTrails();
      const activeTrail = trails.find(t => t.isRecording);
      if (activeTrail) {
        this.trail = Trail.fromJSON(activeTrail);
        this._activeTrailId = this.trail.id;
        this._startTime = this.trail.createdAt;
        this._updateTrailUI();
        if (this.trail.isRecording && !this.trail.isPaused) {
          this._startWatching();
          this.mapManager.setTrail(this.trail.positions, this._trailSmoothing);
          this._startElapsedTimer();
        }
      }
    } catch (e) {}
  }

  _startAutoSave() {
    if (this._saveTimer) clearInterval(this._saveTimer);
    this._saveTimer = setInterval(() => {
      if (this.trail.isRecording || this.trail.positions.length > 0) {
        this._saveCurrentTrail();
      }
    }, 30000); // 每30秒自动保存
  }

  async _saveCurrentTrail() {
    if (!this.trail || this.trail.positions.length === 0) return;
    try {
      await Storage.saveTrail(this.trail);
    } catch (e) {
      console.warn('[App] 保存轨迹失败:', e);
    }
  }

  _startElapsedTimer() {
    if (this._elapsedTimer) clearInterval(this._elapsedTimer);
    this._elapsedTimer = setInterval(() => {
      if (this.trail.isRecording) {
        this._updateElapsedTime();
      }
    }, 1000);
  }

  _updateElapsedTime() {
    const elapsed = Date.now() - this._startTime;
    const el = document.getElementById('elapsed-time');
    if (el) {
      el.textContent = formatDuration(elapsed);
    }
  }

  _bindEvents() {
    // GPS 按钮
    const gpsBtn = document.getElementById('gps-btn');
    if (gpsBtn) {
      gpsBtn.addEventListener('click', () => this._toggleGPS());
    }

    // 主题切换
    const themeBtn = document.getElementById('theme-btn');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => this._toggleTheme());
    }

    // 主题色切换
    document.querySelectorAll('.accent-dot').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const accent = e.target.dataset.accent;
        document.documentElement.setAttribute('data-accent', accent);
        this._savePreferences();
        document.querySelectorAll('.accent-dot').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
      });
    });

    // 录制控制
    const recordBtn = document.getElementById('trail-record-btn');
    if (recordBtn) {
      recordBtn.addEventListener('click', () => this._toggleRecording());
    }

    const pauseBtn = document.getElementById('trail-pause-btn');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => this._togglePause());
    }

    const clearBtn = document.getElementById('trail-clear-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => this._clearTrail());
    }

    // 统计
    const statsBtn = document.getElementById('trail-stats-btn');
    if (statsBtn) {
      statsBtn.addEventListener('click', () => this._showStats());
    }

    // 平滑
    const smoothBtn = document.getElementById('trail-smooth-btn');
    if (smoothBtn) {
      smoothBtn.addEventListener('click', () => this._toggleSmooth());
    }

    // 导出
    const exportBtn = document.getElementById('export-report-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => this._exportReport());
    }

    // 导出 PNG
    const exportPngBtn = document.getElementById('export-png-btn');
    if (exportPngBtn) {
      exportPngBtn.addEventListener('click', () => this._exportPNG());
    }

    // 导出 GPX
    const exportGpxBtn = document.getElementById('export-gpx-btn');
    if (exportGpxBtn) {
      exportGpxBtn.addEventListener('click', () => this._exportGPX());
    }

    // 关闭统计弹窗
    const statsClose = document.getElementById('stats-close');
    if (statsClose) {
      statsClose.addEventListener('click', () => this._hideStats());
    }

    // 轨迹名称保存
    const nameSave = document.getElementById('trail-name-save');
    if (nameSave) {
      nameSave.addEventListener('click', () => this._saveTrailName());
    }

    // 历史管理
    const historyManage = document.getElementById('history-manage-btn');
    if (historyManage) {
      historyManage.addEventListener('click', () => this._showHistoryManage());
    }
  }

  async _toggleGPS() {
    if (this.isWatching) {
      this._stopWatching();
    } else {
      await this._startWatching();
    }
  }

  async _startWatching() {
    if (this.isWatching) return;
    try {
      await this.gpsManager.startWatching((pos) => {
        this._processPosition(pos);
      });
      this.isWatching = true;
      this._updateGPSButton(true);
      this._showSpeedChart();
    } catch (e) {
      console.warn('[App] 启动 GPS 失败:', e);
      Toast.show('定位启动失败');
    }
  }

  _stopWatching() {
    if (!this.isWatching) return;
    this.gpsManager.stopWatching();
    this.isWatching = false;
    this._updateGPSButton(false);
    this._hideSpeedChart();
  }

  _updateGPSButton(watching) {
    const btn = document.getElementById('gps-btn');
    if (btn) {
      btn.classList.toggle('watching', watching);
    }
  }

  _processPosition(pos) {
    if (!this.trail.isRecording) return;
    const added = this.trail.addPoint({
      lat: pos.lat,
      lng: pos.lng,
      time: pos.timestamp || Date.now(),
      accuracy: pos.accuracy || 0,
      speed: pos.speed,
      heading: pos.heading
    });
    if (added) {
      this.mapManager.setTrail(this.trail.positions, this._trailSmoothing);
      this._updateTrailUI();
      this._updateSpeedChart();
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
    // 创建新轨迹
    this.trail = new Trail();
    this.trail.start();
    this._activeTrailId = this.trail.id;
    this._startTime = Date.now();

    // 清空地图轨迹
    this.mapManager.clearTrail();
    this.mapManager.setStartPoint(this.trail.startPoint);
    this.mapManager.setEndPoint(null);

    // 显示速度曲线
    this._showSpeedChart();
    this._startElapsedTimer();

    // 更新 UI
    this._updateTrailUI();
    this._updateHistoryList();

    Toast.show('轨迹记录已开始');
  }

  _stopRecording() {
    if (!this.trail.isRecording) return;

    this.trail.stop();
    this._startTime = null;
    if (this._elapsedTimer) clearInterval(this._elapsedTimer);

    // 保存轨迹
    this._saveCurrentTrail();

    // 更新地图标记
    this.mapManager.setEndPoint(this.trail.endPoint);

    // 更新 UI
    this._updateTrailUI();
    this._updateHistoryList();

    Toast.show(`轨迹已保存，共 ${this.trail.getPointCount()} 点`);
  }

  _togglePause() {
    if (!this.trail.isRecording) return;

    if (this.trail.isPaused) {
      this.trail.resume();
      Toast.show('轨迹已继续');
    } else {
      this.trail.pause();
      Toast.show('轨迹已暂停');
    }
    this._updateTrailUI();
  }

  async _clearTrail() {
    if (!this.trail || this.trail.positions.length === 0) return;

    const savedTrail = { ...this.trail.toJSON() };

    this.trail.clear();
    this.mapManager.clearTrail();
    this._updateTrailUI();

    Toast.showUndo('轨迹已清除', async () => {
      this.trail = Trail.fromJSON(savedTrail);
      this._activeTrailId = this.trail.id;
      if (this.trail.positions.length >= 2) {
        this.mapManager.setTrail(this.trail.positions, this._trailSmoothing);
        this.mapManager.setStartPoint(this.trail.startPoint);
        this.mapManager.setEndPoint(this.trail.endPoint);
      }
      this._updateTrailUI();
      await this._saveCurrentTrail();
    });
  }

  _toggleSmooth() {
    this._trailSmoothing = !this._trailSmoothing;
    try {
      localStorage.setItem('trailrecorder_smooth', this._trailSmoothing ? '1' : '0');
    } catch (e) {}
    this._updateTrailUI();
    if (this.trail.positions.length >= 2) {
      this.mapManager.setTrail(this.trail.positions, this._trailSmoothing);
    }
    Toast.show(this._trailSmoothing ? '轨迹平滑已开启' : '轨迹平滑已关闭');
  }

  _toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    this.mapManager.setTheme(next);
    this._savePreferences();
    // 刷新轨迹颜色
    if (this.trail.positions.length >= 2) {
      this.mapManager.setTrail(this.trail.positions, this._trailSmoothing);
    }
  }

  _showSpeedChart() {
    // 速度曲线始终可见，无需切换
    this._initSpeedChart();
  }

  _hideSpeedChart() {
    // 速度曲线始终可见
  }

  _initSpeedChart() {
    if (this._speedChart) return;
    const canvas = document.getElementById('speed-chart-canvas');
    if (!canvas || typeof Chart === 'undefined') return;

    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    const textColor = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';

    this._speedChart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [{
          data: [],
          borderColor: '#4fc3f7',
          backgroundColor: 'rgba(79,195,247,0.15)',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: '时间(秒)', color: textColor, font: { size: 10 } },
            grid: { color: gridColor },
            ticks: { color: textColor, font: { size: 9 }, maxTicksLimit: 6 }
          },
          y: {
            title: { display: true, text: '速度(m/s)', color: textColor, font: { size: 10 } },
            grid: { color: gridColor },
            ticks: { color: textColor, font: { size: 9 }, maxTicksLimit: 5 },
            beginAtZero: true
          }
        }
      }
    });
  }

  _updateSpeedChart() {
    if (!this._speedChart || !this.trail.positions.length) return;
    const now = Date.now();
    if (this._lastChartUpdate && now - this._lastChartUpdate < 5000) return;
    this._lastChartUpdate = now;

    const data = this._speedChart.data.datasets[0].data;
    // 收集最近的速度数据
    const recent = this.trail.positions.slice(-100);
    data.length = 0;
    let lastTime = null;
    for (const p of recent) {
      if (p.speed != null && p.time) {
        if (lastTime !== null) {
          data.push({
            x: (p.time - this._startTime) / 1000,
            y: p.speed
          });
        }
        lastTime = p.time;
      }
    }
    this._speedChart.update('none');
  }

  _showStats() {
    const pos = this.trail.positions;
    if (pos.length < 2) {
      Toast.show('轨迹点数不足（至少 2 个点）');
      return;
    }

    const totalDist = this.trail.getDistance();
    const duration = this.trail.getDuration();
    const maxSpeed = this.trail.getMaxSpeed();
    const avgSpeed = duration > 0 ? totalDist / (duration / 1000) : 0;

    // 更新统计数值
    document.getElementById('stat-distance').textContent = formatDistance(totalDist);
    document.getElementById('stat-duration').textContent = formatDuration(duration);
    document.getElementById('stat-avg-speed').textContent = avgSpeed > 0
      ? (avgSpeed * 3.6).toFixed(1) + ' km/h'
      : '--';
    document.getElementById('stat-max-speed').textContent = maxSpeed > 0
      ? (maxSpeed * 3.6).toFixed(1) + ' km/h'
      : '--';
    document.getElementById('stat-points').textContent = pos.length;

    // 时间
    const firstTime = pos[0].time;
    const lastTime = pos[pos.length - 1].time;
    document.getElementById('stat-start-time').textContent = firstTime
      ? new Date(firstTime).toLocaleString('zh-CN')
      : '--';

    // 名称编辑
    const nameInput = document.getElementById('trail-name-input');
    if (nameInput) {
      nameInput.value = this.trail.name;
    }

    // 速度直方图
    this._buildHistogram(pos);

    // 显示弹窗
    const modal = document.getElementById('stats-modal');
    if (modal) {
      modal.classList.remove('hidden');
    }
  }

  _hideStats() {
    const modal = document.getElementById('stats-modal');
    if (modal) {
      modal.classList.add('hidden');
    }
  }

  _buildHistogram(positions) {
    // 销毁旧图表
    if (this._histogramChart) {
      this._histogramChart.destroy();
      this._histogramChart = null;
    }

    const canvas = document.getElementById('histogram-canvas');
    if (!canvas) return;

    const bins = [0, 2.78, 5.56, 16.67, 33.33, 55.56, 97.22, Infinity];
    const labels = ['0-10', '10-20', '20-60', '60-120', '120-200', '200-350', '>350'];
    const counts = new Array(bins.length - 1).fill(0);
    let hasSpeedData = false;

    for (const p of positions) {
      if (p.speed == null) continue;
      hasSpeedData = true;
      for (let i = 0; i < bins.length - 1; i++) {
        if (p.speed >= bins[i] && p.speed < bins[i + 1]) {
          counts[i]++;
          break;
        }
      }
    }

    if (!hasSpeedData) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('无速度数据', canvas.width / 2, canvas.height / 2);
      return;
    }

    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    this._histogramChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: counts,
          backgroundColor: isDark
            ? ['rgba(0,229,204,0.7)', 'rgba(255,215,0,0.75)', 'rgba(255,140,0,0.8)', 'rgba(255,94,51,0.82)', 'rgba(255,51,102,0.85)', 'rgba(191,64,255,0.9)', 'rgba(94,92,230,0.92)']
            : ['rgba(52,199,89,0.65)', 'rgba(255,149,0,0.7)', 'rgba(255,59,48,0.75)', 'rgba(255,45,85,0.78)', 'rgba(175,82,222,0.8)', 'rgba(88,86,214,0.85)', 'rgba(0,122,255,0.88)'],
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

  async _saveTrailName() {
    const input = document.getElementById('trail-name-input');
    if (!input || !this.trail.id) return;
    const name = input.value.trim() || '未命名';
    this.trail.name = name;
    await Storage.updateTrailName(this.trail.id, name);
    this._updateHistoryList();
    Toast.show('名称已保存');
  }

  _exportReport() {
    this._exportPNG();
  }

  async _exportPNG() {
    const pos = this.trail.positions;
    if (pos.length < 2) {
      Toast.show('轨迹点数不足');
      return;
    }

    Toast.show('正在生成图片...');

    try {
      const totalDist = this.trail.getDistance();
      const duration = this.trail.getDuration();
      const maxSpeed = this.trail.getMaxSpeed();
      const avgSpeed = duration > 0 ? totalDist / (duration / 1000) : 0;

      const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 1000;
      const ctx = canvas.getContext('2d');

      // 底色
      ctx.fillStyle = isDark ? '#0B1120' : '#f0f4f8';
      ctx.fillRect(0, 0, 800, 1000);

      // 标题
      ctx.fillStyle = isDark ? '#FFFFFF' : '#1a1a2e';
      ctx.font = 'bold 24px sans-serif';
      ctx.fillText(this.trail.name || '轨迹记录', 24, 40);

      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
      ctx.font = '12px sans-serif';
      ctx.fillText(new Date().toLocaleString('zh-CN'), 24, 60);

      // 统计卡片
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)';
      ctx.beginPath();
      ctx.roundRect(24, 80, 360, 100, 8);
      ctx.fill();

      const stats = [
        { label: '距离', value: formatDistance(totalDist) },
        { label: '时长', value: formatDuration(duration) },
        { label: '平均', value: (avgSpeed * 3.6).toFixed(1) + ' km/h' },
        { label: '最高', value: (maxSpeed * 3.6).toFixed(1) + ' km/h' }
      ];

      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.7)';
      ctx.font = '11px sans-serif';
      ctx.fillText('起点: ' + (pos[0].time ? new Date(pos[0].time).toLocaleTimeString('zh-CN') : '--'), 36, 100);
      ctx.fillText('终点: ' + (pos[pos.length-1].time ? new Date(pos[pos.length-1].time).toLocaleTimeString('zh-CN') : '--'), 36, 116);
      ctx.font = 'bold 14px sans-serif';
      ctx.fillStyle = getSpeedColors(isDark ? 'dark' : 'light').walk.r > 128 ? '#1a1a2e' : '#FFFFFF';
      ctx.fillText('总距离: ' + stats[0].value, 36, 140);

      // 绘制简单轨迹图
      let minLat = Infinity, maxLat = -Infinity;
      let minLng = Infinity, maxLng = -Infinity;
      for (const p of pos) {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lng < minLng) minLng = p.lng;
        if (p.lng > maxLng) maxLng = p.lng;
      }

      const pad = 20;
      const mapX = 24, mapY = 200;
      const mapW = 752, mapH = 400;

      // 地图背景
      ctx.fillStyle = isDark ? '#1a2744' : '#dce5f0';
      ctx.fillRect(mapX, mapY, mapW, mapH);

      // 计算缩放
      const lngSpan = maxLng - minLng || 0.001;
      const latSpan = maxLat - minLat || 0.001;
      const scale = Math.min(mapW / lngSpan, mapH / latSpan) * 0.8;
      const originX = mapX + mapW / 2;
      const originY = mapY + mapH / 2;

      const toX = (lng) => originX + (lng - (minLng + maxLng) / 2) * scale;
      const toY = (lat) => originY - (lat - (minLat + maxLat) / 2) * scale;

      // 绘制轨迹线
      const colors = getSpeedColors(isDark ? 'dark' : 'light');
      let batchPath = [];
      let batchKey = null;

      for (let i = 1; i < pos.length; i++) {
        const key = speedColorKey(pos[i].speed);
        if (key !== batchKey) {
          if (batchPath.length >= 2) {
            this._drawPolyline(ctx, batchPath, colors[batchKey]);
          }
          batchPath = [toX(pos[i-1].lng), toY(pos[i-1].lat), toX(pos[i].lng), toY(pos[i].lat)];
          batchKey = key;
        } else {
          batchPath.push(toX(pos[i].lng), toY(pos[i].lat));
        }
      }
      if (batchPath.length >= 4) {
        this._drawPolyline(ctx, batchPath, colors[batchKey]);
      }

      // 起点终点
      if (pos.length > 0) {
        ctx.fillStyle = '#22c55e';
        ctx.beginPath();
        ctx.arc(toX(pos[0].lng), toY(pos[0].lat), 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = isDark ? '#FFF' : '#000';
        ctx.font = '10px sans-serif';
        ctx.fillText('起点', toX(pos[0].lng) + 10, toY(pos[0].lat) - 5);

        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(toX(pos[pos.length-1].lng), toY(pos[pos.length-1].lat), 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = isDark ? '#FFF' : '#000';
        ctx.fillText('终点', toX(pos[pos.length-1].lng) + 10, toY(pos[pos.length-1].lat) - 5);
      }

      // 速度图例
      const legendY = 620;
      ctx.font = '10px sans-serif';
      const legendLabels = ['0-10', '10-20', '20-60', '60-120', '120-200', '200-350', '>350'];
      const legendColors = ['walk', 'bike', 'bus', 'car', 'train', 'hsr', 'sct'];
      let legendX = 24;
      for (let i = 0; i < legendLabels.length; i++) {
        const c = colors[legendColors[i]];
        ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${c.a})`;
        ctx.fillRect(legendX, legendY, 12, 8);
        ctx.fillStyle = isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.7)';
        ctx.fillText(legendLabels[i] + ' km/h', legendX + 16, legendY + 7);
        legendX += 70;
      }

      // 导出
      canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `trail-${this.trail.id || 'recorder'}.png`;
        link.href = url;
        link.click();
        URL.revokeObjectURL(url);
        Toast.show('图片已导出');
      }, 'image/png');

    } catch (e) {
      console.error('[App] 导出失败:', e);
      Toast.show('导出失败');
    }
  }

  _drawPolyline(ctx, path, color) {
    ctx.strokeStyle = `rgba(${color.r},${color.g},${color.b},${color.a})`;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(path[0], path[1]);
    for (let i = 2; i < path.length; i += 2) {
      ctx.lineTo(path[i], path[i + 1]);
    }
    ctx.stroke();
  }

  _exportGPX() {
    const pos = this.trail.positions;
    if (pos.length === 0) {
      Toast.show('无轨迹数据');
      return;
    }

    let gpx = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    gpx += `<gpx version="1.1" creator="TrailRecorder">\n`;
    gpx += `  <trk>\n`;
    gpx += `    <name>${this.trail.name}</name>\n`;
    gpx += `    <trkseg>\n`;

    for (const p of pos) {
      gpx += `      <trkpt lat="${p.lat}" lon="${p.lng}">\n`;
      if (p.time) gpx += `        <time>${new Date(p.time).toISOString()}</time>\n`;
      if (p.speed) gpx += `        <speed>${p.speed}</speed>\n`;
      gpx += `      </trkpt>\n`;
    }

    gpx += `    </trkseg>\n`;
    gpx += `  </trk>\n`;
    gpx += `</gpx>`;

    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `trail-${this.trail.id || 'recorder'}.gpx`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
    Toast.show('GPX 已导出');
  }

  async _loadTrail(id) {
    try {
      const trailData = await Storage.loadTrail(id);
      if (!trailData) {
        Toast.show('轨迹不存在');
        return;
      }

      this.trail = Trail.fromJSON(trailData);
      this._activeTrailId = this.trail.id;
      this._startTime = this.trail.createdAt;

      // 渲染轨迹
      if (this.trail.positions.length >= 2) {
        this.mapManager.setTrail(this.trail.positions, this._trailSmoothing);
        this.mapManager.setStartPoint(this.trail.startPoint);
        this.mapManager.setEndPoint(this.trail.endPoint);
        this.mapManager.fitTrailBounds(this.trail.positions);
      }

      this._updateTrailUI();
      Toast.show('已加载轨迹');
    } catch (e) {
      console.warn('[App] 加载轨迹失败:', e);
      Toast.show('加载失败');
    }
  }

  async _deleteTrail(id) {
    const trail = await Storage.loadTrail(id);
    if (!trail) return;

    const savedTrail = { ...trail };

    await Storage.deleteTrail(id);

    Toast.showUndo('轨迹已删除', async () => {
      await Storage.saveTrail(savedTrail);
      await this._loadHistory();
    });

    if (this._activeTrailId === id) {
      this.trail = new Trail();
      this._activeTrailId = null;
      this.mapManager.clearTrail();
      this._updateTrailUI();
    }

    this._updateHistoryList();
  }

  _updateHistoryList() {
    this._loadHistory();
  }

  _renderHistoryList(trails) {
    const list = document.getElementById('history-list');
    if (!list) return;

    if (!trails || trails.length === 0) {
      list.innerHTML = '<div class="history-empty">暂无轨迹记录</div>';
      return;
    }

    let html = '';
    for (const t of trails) {
      const dist = this._calcDistance(t.positions);
      const duration = this._calcDuration(t.positions);
      const time = t.updatedAt ? new Date(t.updatedAt).toLocaleString('zh-CN') : '--';
      const isActive = t.id === this._activeTrailId;

      html += `<div class="history-item${isActive ? ' active' : ''}" data-id="${t.id}">
        <div class="history-item-info">
          <div class="history-item-name">${this._escapeHtml(t.name || '未命名')}</div>
          <div class="history-item-meta">${formatDistance(dist)} · ${formatDuration(duration)} · ${time}</div>
        </div>
        <div class="history-item-actions">
          <button class="history-item-load" data-id="${t.id}">查看</button>
          <button class="history-item-delete" data-id="${t.id}">删除</button>
        </div>
      </div>`;
    }

    list.innerHTML = html;

    // 绑定事件
    list.querySelectorAll('.history-item-load').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._loadTrail(e.target.dataset.id);
      });
    });

    list.querySelectorAll('.history-item-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._deleteTrail(e.target.dataset.id);
      });
    });
  }

  _calcDistance(positions) {
    if (!positions || positions.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < positions.length; i++) {
      total += calcDistance(positions[i-1], positions[i]);
    }
    return total;
  }

  _calcDuration(positions) {
    if (!positions || positions.length < 2) return 0;
    const first = positions[0].time || 0;
    const last = positions[positions.length - 1].time || 0;
    return last - first;
  }

  _showHistoryManage() {
    // 显示管理界面或展开历史列表
    const list = document.getElementById('history-list');
    if (list) {
      list.classList.toggle('expanded');
    }
  }

  _updateTrailUI() {
    const btn = document.getElementById('trail-record-btn');
    const pauseBtn = document.getElementById('trail-pause-btn');
    const clearBtn = document.getElementById('trail-clear-btn');
    const statsBtn = document.getElementById('trail-stats-btn');
    const distEl = document.getElementById('trail-distance');
    const smoothBtn = document.getElementById('trail-smooth-btn');

    if (btn) {
      btn.classList.toggle('recording', this.trail.isRecording);
      btn.innerHTML = this.trail.isRecording
        ? '<span class="trail-dot"></span> 停止记录'
        : '<span class="trail-dot"></span> 开始记录';
    }

    if (pauseBtn) {
      pauseBtn.disabled = !this.trail.isRecording;
      pauseBtn.textContent = this.trail.isPaused ? '继续' : '暂停';
    }

    if (clearBtn) {
      clearBtn.disabled = this.trail.positions.length === 0;
    }

    if (statsBtn) {
      statsBtn.disabled = this.trail.positions.length < 2;
    }

    // 距离
    const dist = this.trail.getDistance();
    if (distEl) {
      distEl.textContent = dist > 0 ? formatDistance(dist) : '0m';
    }

    // 平滑按钮
    if (smoothBtn) {
      smoothBtn.classList.toggle('active', this._trailSmoothing);
    }

    // 常驻条
    const barDot = document.getElementById('trail-bar-dot');
    const barState = document.getElementById('trail-bar-state');
    const barBtn = document.getElementById('trail-bar-btn');
    const barDist = document.getElementById('trail-bar-dist');

    if (barDot) barDot.classList.toggle('recording', this.trail.isRecording);
    if (barState) {
      barState.textContent = this.trail.isRecording
        ? (this.trail.isPaused ? '已暂停' : '记录中')
        : '未记录';
    }
    if (barBtn) {
      barBtn.classList.toggle('recording', this.trail.isRecording);
      barBtn.textContent = this.trail.isRecording ? '停止' : '开始记录';
    }
    if (barDist) {
      barDist.textContent = dist > 0 ? formatDistance(dist) : '0m';
    }
  }

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

// 全局实例
window.trailApp = null;
