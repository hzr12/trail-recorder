/**
 * 途刻 TraceCraft - GPS UI 渲染
 * ============================================
 * 追加 App.prototype 方法：速度曲线、状态条
 * 加载顺序：app-core.js 之后
 */

/* ── 速度曲线 ─────────────────────────────────────── */

App.prototype._showSpeedChart = function () {
  const section = document.getElementById('speed-chart-section');
  if (!section) return;
  section.classList.remove('hidden');
  this._initSpeedChart();
  const header = section.querySelector('.speed-chart-header');
  const body = document.getElementById('speed-chart-body');
  const toggle = document.getElementById('speed-chart-toggle');
  if (header && body && toggle) {
    header.onclick = () => {
      body.classList.toggle('collapsed');
      toggle.classList.toggle('collapsed');
    };
  }
};

App.prototype._hideSpeedChart = function () {
  const section = document.getElementById('speed-chart-section');
  if (section) section.classList.add('hidden');
};

App.prototype._showElevProfile = function () {
  const section = document.getElementById('elev-profile-section');
  if (!section) return;
  section.classList.remove('hidden');
  this._initElevProfileChart();
  const header = section.querySelector('.elev-profile-header');
  const body = document.getElementById('elev-profile-body');
  const toggle = document.getElementById('elev-profile-toggle');
  if (header && body && toggle) {
    header.onclick = () => {
      body.classList.toggle('collapsed');
      toggle.classList.toggle('collapsed');
    };
  }
  // 若记录页已有轨迹点（如加载历史到记录页），先画一次
  if (this.trail && this.trail.positions && this.trail.positions.length) {
    this._updateElevProfileChart(this.trail.positions);
  }
};

App.prototype._hideElevProfile = function () {
  const section = document.getElementById('elev-profile-section');
  if (section) section.classList.add('hidden');
};

App.prototype._initSpeedChart = function () {
  const canvas = document.getElementById('speed-chart-canvas');
  if (!canvas || typeof Chart === 'undefined') return;
  // 重建前销毁旧实例：面板重建/重复初始化时 canvas 被替换，残留 Chart 会引用已移除的 canvas
  if (this._speedChart) {
    try { this._speedChart.destroy(); } catch (e) {}
    this._speedChart = null;
  }
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
};

App.prototype._destroySpeedChart = function () {
  if (this._speedChart) {
    try { this._speedChart.destroy(); } catch (e) {}
    this._speedChart = null;
  }
};

App.prototype._updateSpeedChart = function () {
  if (!this._speedChart) return;
  const now = Date.now();
  if (this._lastChartUpdate && (this._speedHistory.length % 5 !== 0) && now - this._lastChartUpdate < 30000) return;
  this._lastChartUpdate = now;
  const data = this._speedChart.data.datasets[0].data;
  const win = this._speedHistory.slice(-CONFIG.SPEED_CHART_WINDOW);
  data.length = 0;
  for (const p of win) data.push(p);
  this._speedChart.update('none');
  const infoEl = document.getElementById('speed-chart-info');
  if (infoEl && win.length) {
    const last = win[win.length - 1];
    const avg = win.reduce((s, p) => s + p.y, 0) / win.length;
    const max = win.reduce((m, p) => Math.max(m, p.y), -Infinity);
    infoEl.textContent = `当前 ${last.y.toFixed(1)} 平均 ${avg.toFixed(1)} 最高 ${max.toFixed(1)} m/s`;
  }
};

/* ── GPS 状态条 ────────────────────────────────────── */

App.prototype._updateStatusBar = function (force) {
  if (!this._statusEl) return;
  if (!this.myPosition) {
    this._statusEl.innerHTML = '<div class="gps-line1"><span class="gps-dot"></span><span class="gps-offline">⊙ 未定位，点击 GPS 按钮定位</span></div>';
    return;
  }
  const now = Date.now();
  if (!force && this._lastStatusUpdate && now - this._lastStatusUpdate < CONFIG.STATUS_THROTTLE_MS) return;
  this._lastStatusUpdate = now;

  const elapsed = this._formatElapsed();
  const stale = this._isPositionStale();
  const isTracking = this._isWatching;

  let dotClass = '';
  if (stale) {
    dotClass = 'gps-dot stale';
  } else if (isTracking) {
    dotClass = 'gps-dot tracking';
  } else {
    dotClass = 'gps-dot online';
  }

  // GNSS 弱信号省电徽章（常驻；进入/退出由 onWeakSignalChange 各弹一次 Toast）
  const weakBadge = this.gpsManager.isWeakSignal
    ? ' <span class="gnss-weak-badge" title="GNSS 信号弱，已自动降低定位频率省电">⚠ 信号弱</span>'
    : '';
  // 定位源双态标识：GNSS（原生芯片接管）/ Web（浏览器定位顶上）
  const isGnssSource = this.gpsManager.gpsSource === 'GNSS';
  let sourceTitle = isGnssSource
    ? '原生 GNSS 芯片接管（卫星数足够且 DOP 良好）'
    : '浏览器 Geolocation 定位顶上（无 GNSS 或信号弱）';
  if (!isGnssSource && this._lastAccuracy != null) {
    sourceTitle += `，当前精度 ±${Math.round(this._lastAccuracy)}m`;
  }
  const sourceBadge = `<span class="gps-source ${isGnssSource ? 'gnss' : 'web'}${this.gpsManager.imuAssistActive ? ' imu-active' : ''}" title="${sourceTitle}${this.gpsManager.imuAssistActive ? '（IMU 惯性校准辅助中）' : ''}">${isGnssSource ? 'GPS' : '网络'}</span>`;
  // 跟随模式独立为按钮，避免整条状态栏误触切换
  const followIcon = ` <button class="gps-follow-toggle${this._followMode ? ' active' : ''}" title="切换地图跟随">${this._followMode ? '跟随中' : '跟随'}</button>`;

  // 信号质量：按等级分格信号条（格数=等级数，沿用 4 档 80/60/40 阈值），亮格=当前档
  // 连评分都算不出（从未定位）时回退 accuracy 信号条
  let signalHtml = '';
  const qInfo = this.gpsManager.signalQuality;
  if (qInfo != null) {
    const LEVELS = [{ min: 80, n: 4 }, { min: 60, n: 3 }, { min: 40, n: 2 }, { min: 0, n: 1 }];
    const lvl = LEVELS.find(l => qInfo.score >= l.min) || LEVELS[LEVELS.length - 1];
    const srcTag = qInfo.source === 'gnss' ? 'GNSS' : 'Web';
    const tip = `信号质量评分（${srcTag}${qInfo.breakdown ? '：' + qInfo.breakdown : ''}）：${qInfo.score} 分`;
    // 按 n 升序生成：从左到右 s1→s4（矮→高），亮格=当前档，与 accuracy fallback 一致
    // lvl-* 类：按当前等级给整组信号条换色（4 强绿 / 3 绿 / 2 黄 / 1 红）
    signalHtml = `<span class="gps-signal lvl-${lvl.n}" title="${tip}">` +
      [1, 2, 3, 4].map(n => `<span class="signal-bar s${n}${lvl.n >= n ? ' on' : ''}"></span>`).join('') +
      `</span>`;
  } else if (this._lastAccuracy != null) {
    let bars;
    if (this._lastAccuracy <= 10) { bars = 4; }
    else if (this._lastAccuracy <= 30) { bars = 3; }
    else if (this._lastAccuracy <= 100) { bars = 2; }
    else { bars = 1; }
    signalHtml = `<span class="gps-signal lvl-${bars}" title="精度 ±${Math.round(this._lastAccuracy)}m">` +
      `<span class="signal-bar s1${bars >= 1 ? ' on' : ''}"></span>` +
      `<span class="signal-bar s2${bars >= 2 ? ' on' : ''}"></span>` +
      `<span class="signal-bar s3${bars >= 3 ? ' on' : ''}"></span>` +
      `<span class="signal-bar s4${bars >= 4 ? ' on' : ''}"></span>` +
      `</span>`;
  }

  // 运动数据合并胶囊（VTG 风格，始终显示，缺值用 -- 占位）
  const arrows = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
  const kmh = this._lastSpeed != null ? (this._lastSpeed * 3.6).toFixed(1) : '--';
  // 海拔显示相对起点（任务B）：避免 GPS 绝对海拔 10~30m 误差误导；无基准时回退原始值
  let alt = '--';
  if (this._lastAltitude != null) {
    const rel = this._altBase != null ? this._lastAltitude - this._altBase : this._lastAltitude;
    const sign = rel > 0 ? '+' : '';
    alt = `${sign}${Math.round(rel)}m`;
  }
  const h = Number.isFinite(this._lastHeading) ? Math.round(this._lastHeading) : null;
  const arrow = h != null ? arrows[((Math.round(this._lastHeading / 45) % 8) + 8) % 8] : '↗';
  const dir = h != null ? bearingToDir(this._lastHeading) : '';
  const motionHtml = `<span class="gps-motion" title="实时运动数据">${arrow}${h != null ? h : '--'}°${dir ? ' ' + dir : ''} ${kmh}km/h · ${alt}</span>`;

  const line2 = [sourceBadge, signalHtml, motionHtml].filter(Boolean).join('<span class="gps-sep">│</span>');
  const line3 = this._weatherHtml ? `<div class="gps-line3">${this._weatherHtml}</div>` : '';

  this._statusEl.innerHTML =
    `<div class="gps-line1"><span class="${dotClass}" title="${stale ? '定位过期' : isTracking ? '持续追踪中' : '已定位'}"></span><span class="gps-online">已定位</span>${weakBadge}${followIcon} <span class="gps-elapsed">(${elapsed})</span></div>` +
    `<div class="gps-line2">${line2}</div>` +
    line3;
};

/* ── 跟随模式切换 ─────────────────────────────────── */

App.prototype._toggleFollowMode = function () {
  // 仅回放「播放中」锁定跟随按钮；回放暂停时解锁，允许自由切换地图跟随
  if (this._isReplaying && this._replayPlayer && this._replayPlayer.isPlaying) {
    Toast.show(' 回放播放中不可切换跟随模式');
    return;
  }
  if (!this.myPosition) {
    Toast.show(' 请先获取位置');
    return;
  }
  this._followMode = !this._followMode;
  if (this._followMode) {
    this.mapManager.flyTo(this.myPosition);
    Toast.show(' 地图跟随已开启');
  } else {
    Toast.show(' 地图跟随已关闭');
  }
  this._updateStatusBar(true);
};


