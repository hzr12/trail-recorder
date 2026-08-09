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

App.prototype._initSpeedChart = function () {
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
};

App.prototype._updateSpeedChart = function () {
  if (!this._speedChart) return;
  const now = Date.now();
  if (this._lastChartUpdate && (this._speedHistory.length % 5 !== 0) && now - this._lastChartUpdate < 30000) return;
  this._lastChartUpdate = now;
  const data = this._speedChart.data.datasets[0].data;
  const win = this._speedHistory.slice(-2500);
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
  const isDowngraded = this.gpsManager.isDowngraded;

  let dotClass = '';
  if (stale) {
    dotClass = 'gps-dot stale';
  } else if (isTracking) {
    dotClass = 'gps-dot tracking';
  } else {
    dotClass = 'gps-dot online';
  }

  // 降级/过期改图标+title，追踪并入圆点 tracking 动画，去除冗余文字
  const degradedIcon = isDowngraded ? ' <span class="gps-state-icon warn" title="低精度定位">⚠</span>' : '';
  // GNSS 弱信号省电徽章（常驻；进入/退出由 onWeakSignalChange 各弹一次 Toast）
  const weakBadge = this.gpsManager.isWeakSignal
    ? ' <span class="gnss-weak-badge" title="GNSS 信号弱，已自动降低定位频率省电">⚠ 信号弱</span>'
    : '';
  // 定位源两态标识：GNSS（原生芯片接管）/ Web（浏览器定位顶上）
  // 桌面端（无 GNSS 插件）Web 源按 accuracy 标注近似精度等级，直观感知定位可信度
  const isGnssSource = this.gpsManager.gpsSource === 'GNSS';
  let sourceLabel = isGnssSource ? 'GPS 芯片定位' : '网络定位';
  let sourceTitle = isGnssSource
    ? '原生 GNSS 芯片接管（卫星数足够且 DOP 良好）'
    : '浏览器 Geolocation 定位顶上（无 GNSS 或信号弱）';
  if (!isGnssSource && this._lastAccuracy != null) {
    const acc = Math.round(this._lastAccuracy);
    sourceLabel += acc > 500 ? '·≈城市级' : `·±${acc}m`;
    sourceTitle += `，当前精度 ±${acc}m`;
  }
  const sourceBadge = `<span class="gps-source ${isGnssSource ? 'gnss' : 'web'}" title="${sourceTitle}">${sourceLabel}</span>`;
  // GNSS 芯片航向/速度徽章（仅原生接管且有 VTG 数据时显示；Web 源无原生航向）
  const vtgInfo = (isGnssSource && this.gpsManager.speedSource === 'gnss')
    ? ` <span class="gps-vtg" title="GNSS 芯片航向/速度（优先于浏览器定位数据）">↗${Math.round(this.gpsManager.vtgTrack || 0)}° ${this.gpsManager.vtgSpeedKmh != null ? this.gpsManager.vtgSpeedKmh.toFixed(1) : '--'}km/h·GNSS</span>`
    : '';
  // 跟随模式独立为按钮，避免整条状态栏误触切换
  const followIcon = ` <button class="gps-follow-toggle${this._followMode ? ' active' : ''}" title="切换地图跟随">${this._followMode ? '跟随中' : '跟随'}</button>`;

  // 信号质量评分（GNSS：SNR/HDOP/卫星数/星座融合；Web：accuracy 降级分）恒有值；
  // 连评分都算不出（从未定位）时回退 accuracy 信号条
  let signalHtml = '';
  const qInfo = this.gpsManager.signalQuality;
  if (qInfo != null) {
    const lvl = qInfo.score >= 80 ? { t: '优', c: 'excellent' }
      : qInfo.score >= 60 ? { t: '良', c: 'good' }
        : qInfo.score >= 40 ? { t: '中', c: 'moderate' }
          : { t: '差', c: 'poor' };
    const srcTag = qInfo.source === 'gnss' ? 'GNSS' : 'Web';
    const tip = `信号质量评分（${srcTag}${qInfo.breakdown ? '：' + qInfo.breakdown : ''}）：${qInfo.score} 分`;
    signalHtml = `<span class="gps-signal-score ${lvl.c}" title="${tip}">质量·${lvl.t}(${qInfo.score})</span>`;
  } else if (this._lastAccuracy != null) {
    let bars;
    if (this._lastAccuracy <= 10) { bars = 4; }
    else if (this._lastAccuracy <= 30) { bars = 3; }
    else if (this._lastAccuracy <= 100) { bars = 2; }
    else { bars = 1; }
    signalHtml = `<span class="gps-signal" title="精度 ±${Math.round(this._lastAccuracy)}m">` +
      `<span class="signal-bar s1${bars >= 1 ? ' on' : ''}"></span>` +
      `<span class="signal-bar s2${bars >= 2 ? ' on' : ''}"></span>` +
      `<span class="signal-bar s3${bars >= 3 ? ' on' : ''}"></span>` +
      `<span class="signal-bar s4${bars >= 4 ? ' on' : ''}"></span>` +
      `</span>`;
  }

  const line2Parts = [];
  if (sourceBadge) line2Parts.push(sourceBadge);
  if (signalHtml) line2Parts.push(signalHtml);
  if (!stale && this._lastSpeed != null && this._lastSpeed * 3.6 > 0.1) {
    const kmh = this._lastSpeed * 3.6;
    line2Parts.push(`<span class="gps-speed">${kmh.toFixed(1)}km/h</span>`);
  }
  if (!stale && this._lastAltitude != null) {
    line2Parts.push(`<span class="gps-altitude">${Math.round(this._lastAltitude)}m</span>`);
  }
  if (!stale && Number.isFinite(this._lastHeading)) {
    const dir = bearingToDir(this._lastHeading);
    const arrows = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
    // 负 heading（GPS 未知方向）时索引归一化到 [0,8)，避免 arrows[负索引] 显示 undefined
    const arrow = arrows[((Math.round(this._lastHeading / 45) % 8) + 8) % 8];
    line2Parts.push(`<span class="gps-heading">${arrow} ${dir} ${Math.round(this._lastHeading)}°</span>`);
  }
  if (this._batteryLevel != null) {
    const pct = Math.round(this._batteryLevel * 100);
    const timeStr = this._getBatteryTimeStr ? this._getBatteryTimeStr() : null;
    const label = this._batteryCharging ? '充电中' : (timeStr ? `约${timeStr}` : '');
    line2Parts.push(`<span class="gps-battery" title="电量 ${pct}%${label ? '，' + label : ''}">${pct}%</span>`);
  }
  const line2 = line2Parts.length
    ? line2Parts.join('<span class="gps-sep">│</span>')
    : `<span style="opacity:0.5">位置待更新</span>`;
  const line3 = this._weatherHtml ? `<div class="gps-line3">${this._weatherHtml}</div>` : '';

  this._statusEl.innerHTML =
    `<div class="gps-line1"><span class="${dotClass}" title="${stale ? '定位过期' : isTracking ? '持续追踪中' : '已定位'}"></span><span class="gps-online">已定位</span>${degradedIcon}${weakBadge}${vtgInfo}${followIcon} <span class="gps-elapsed">(${elapsed})</span></div>` +
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


