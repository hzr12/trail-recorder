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
    if (this._gnssBarEl) this._gnssBarEl.innerHTML = '';
    if (this._updateSatelliteSky) this._updateSatelliteSky();
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
    ? ' <span class="gnss-weak-badge" title="GNSS 信号弱，已自动降低定位频率省电">⚠ 信号弱·省电中</span>'
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
  const sourceBadge = ` <span class="gps-source ${isGnssSource ? 'gnss' : 'web'}" title="${sourceTitle}">${sourceLabel}</span>`;
  // GNSS 芯片航向/速度徽章（仅原生接管且有 VTG 数据时显示；Web 源无原生航向）
  const vtgInfo = (isGnssSource && this.gpsManager.speedSource === 'gnss')
    ? ` <span class="gps-vtg" title="GNSS 芯片航向/速度（优先于浏览器定位数据）">↗${Math.round(this.gpsManager.vtgTrack || 0)}° ${this.gpsManager.vtgSpeedKmh != null ? this.gpsManager.vtgSpeedKmh.toFixed(1) : '--'}km/h·GNSS</span>`
    : '';
  // 跟随模式独立为按钮，避免整条状态栏误触切换
  const followIcon = ` <button class="gps-follow-toggle${this._followMode ? ' active' : ''}" title="切换地图跟随">${this._followMode ? '跟随中' : '跟随'}</button>`;

  let gnssHtml = '';
  if (this.gpsManager.hasGnssPlugin) {
    if (this.gpsManager.gnssVisibleCount > 0) {
      const used = this.gpsManager.gnssUsedCount;
      const visible = this.gpsManager.gnssVisibleCount;
      const snr = this.gpsManager.gnssAvgSnr;
      const dop = this.gpsManager.fusedDop;
      const pdop = this.gpsManager.pdop;
      const hdop = this.gpsManager.hdop;
      const vdop = this.gpsManager.vdop;
      const dopTitle = `参与定位 ${used}/${visible}, 平均信噪比 ${snr.toFixed(0)}dB-Hz` +
        (dop != null ? `, 综合精度因子(PDOP) ${dop.value}·${dop.label}` +
          ` [PDOP:${pdop != null ? pdop.toFixed(1) : '--'} HDOP:${hdop != null ? hdop.toFixed(1) : '--'} VDOP:${vdop != null ? vdop.toFixed(1) : '--'}]` : '');
      const dopHtml = dop != null
        ? ` <span class="gps-dop ${dop.quality}" title="综合精度因子（PDOP=√(HDOP²+VDOP²)）">精度因子:${dop.value}·${dop.label}</span>`
        : '';
      gnssHtml = `<span class="gnss-indicator" title="${dopTitle}">` +
        ` 定位:${used} 可见:${visible} 信噪比:${snr.toFixed(0)}dB${dopHtml}</span>`;
    } else {
      gnssHtml = `<span class="gnss-indicator" style="opacity:0.5"> 等待卫星...</span>`;
    }
  }

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
    signalHtml = `<span class="gps-signal-score ${lvl.c}" title="${tip}">质${qInfo.score}·${lvl.t}</span>`;
  } else if (this._lastAccuracy != null) {
    let bars, label;
    if (this._lastAccuracy <= 10) { bars = 4; label = '极好'; }
    else if (this._lastAccuracy <= 30) { bars = 3; label = '良好'; }
    else if (this._lastAccuracy <= 100) { bars = 2; label = '一般'; }
    else { bars = 1; label = '弱'; }
    signalHtml = `<span class="gps-signal" title="精度 ±${Math.round(this._lastAccuracy)}m">` +
      `<span class="signal-bar s1${bars >= 1 ? ' on' : ''}"></span>` +
      `<span class="signal-bar s2${bars >= 2 ? ' on' : ''}"></span>` +
      `<span class="signal-bar s3${bars >= 3 ? ' on' : ''}"></span>` +
      `<span class="signal-bar s4${bars >= 4 ? ' on' : ''}"></span>` +
      `</span>`;
  }

  const line2Parts = [];
  if (signalHtml) line2Parts.push(signalHtml);
  if (!stale && this._lastSpeed != null) {
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
  const line2 = line2Parts.length ? line2Parts.join('<span class="gps-sep">│</span>') : '<span style="opacity:0.5">位置待更新</span>';
  const line3 = this._weatherHtml ? `<div class="gps-line3">${this._weatherHtml}</div>` : '';

  this._statusEl.innerHTML =
    `<div class="gps-line1"><span class="${dotClass}" title="${stale ? '定位过期' : isTracking ? '持续追踪中' : '已定位'}"></span><span class="gps-online">◉ 已定位</span>${degradedIcon}${weakBadge}${sourceBadge}${vtgInfo}${followIcon}<span class="gps-elapsed">(${elapsed})</span></div>` +
    `<div class="gps-line2">${line2}</div>` +
    line3;

  if (this._gnssBarEl) {
    this._gnssBarEl.innerHTML = gnssHtml || '';
  }
  this._updateSatelliteSky();
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

/* ── 卫星天顶图（Canvas 2D 手绘极坐标，不依赖 Chart.js）────────── */

// 天顶图直径：撑满面板宽但封顶 260，窄屏最小 180
App.prototype._satSkySize = function () {
  const body = document.getElementById('satellite-body');
  const parentW = body ? body.clientWidth : 260;
  return Math.max(180, Math.min(260, parentW - 24));
};

// 显示面板并绑定折叠交互（只绑一次）
App.prototype._showSatelliteSky = function () {
  const section = document.getElementById('satellite-section');
  if (!section) return;
  section.classList.remove('hidden');
  if (this._satToggleBound) return;
  const header = document.getElementById('satellite-header');
  const body = document.getElementById('satellite-body');
  const toggle = document.getElementById('satellite-toggle');
  if (header && body && toggle) {
    this._satToggleBound = true;
    header.onclick = () => {
      body.classList.toggle('collapsed');
      toggle.classList.toggle('collapsed');
    };
  }
};

/**
 * 更新卫星天顶图（自节流 ~1s，配合 GNSS 事件 1s/次）。
 * 无原生 GNSS 插件或无可见卫星 → 整块面板隐藏。
 */
App.prototype._updateSatelliteSky = function () {
  const canvas = document.getElementById('satellite-canvas');
  const section = document.getElementById('satellite-section');
  if (!canvas || !section) return;
  const sats = this.gpsManager.gnssSatellites;
  if (!this.gpsManager.hasGnssPlugin || sats.length === 0) {
    section.classList.add('hidden');
    return;
  }
  const now = Date.now();
  if (this._lastSatSkyUpdate && now - this._lastSatSkyUpdate < 1000) return;
  this._lastSatSkyUpdate = now;
  this._showSatelliteSky();

  // 图例：按星座统计可见卫星数（放 satellite-info 行）
  const infoEl = document.getElementById('satellite-info');
  if (infoEl) {
    const c = this.gpsManager.gnssConstellationStats;
    const parts = [];
    if (c.gps) parts.push(`GPS ${c.gps}`);
    if (c.beidou) parts.push(`北斗 ${c.beidou}`);
    if (c.glonass) parts.push(`GLONASS ${c.glonass}`);
    if (c.galileo) parts.push(`GALILEO ${c.galileo}`);
    if (c.other) parts.push(`其他 ${c.other}`);
    infoEl.textContent = parts.join(' · ') || '可见 0 颗';
  }

  const size = this._satSkySize();
  if (this._satSkySizeCached !== size) {
    this._satSkySizeCached = size;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
  }
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  // 主题感知配色（dark/light 均读当前 data-theme）
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  const bg = isDark ? 'rgba(15,23,42,0.88)' : 'rgba(255,255,255,0.88)';
  const grid = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)';
  const text = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - 16;

  // 背景圆
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fill();

  // 同心网格：外圈=地平线(0°)、45°、天顶(90°)
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  for (const elev of [0, 45, 90]) {
    ctx.beginPath();
    ctx.arc(cx, cy, elev === 90 ? 0.5 : (R * (90 - elev) / 90), 0, Math.PI * 2);
    ctx.stroke();
  }
  // 方位十字线
  ctx.beginPath();
  ctx.moveTo(cx - R, cy);
  ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R);
  ctx.lineTo(cx, cy + R);
  ctx.stroke();
  // 方位标注 N/E/S/W（正北向上）
  ctx.fillStyle = text;
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', cx, cy - R - 8);
  ctx.fillText('E', cx + R + 9, cy);
  ctx.fillText('S', cx, cy + R + 9);
  ctx.fillText('W', cx - R - 9, cy);

  // 卫星散点：r = R·(90-仰角)/90；x = cx + r·sin(azimuth)，y = cy - r·cos(azimuth)
  // 颜色按 cn0DbHz：<20 红、20-30 黄、>30 绿；usedInFix 加白色描边
  // 星座形状：GPS □ / 北斗 ● / GLONASS △ / GALILEO ✕
  for (const s of sats) {
    if (s.elevation == null || s.azimuth == null) continue;
    const r = R * (90 - s.elevation) / 90;
    const rad = s.azimuth * Math.PI / 180;
    const x = cx + r * Math.sin(rad);
    const y = cy - r * Math.cos(rad);
    const cno = s.cn0DbHz;
    let color = '#f44336';
    if (cno >= 30) color = '#4caf50';
    else if (cno >= 20) color = '#ffc107';
    ctx.fillStyle = color;
    ctx.strokeStyle = s.usedInFix ? '#ffffff' : color;
    ctx.lineWidth = 1.2;
    switch (s.constellation) {
      case 'GPS':
        ctx.fillRect(x - 3, y - 3, 6, 6); // □
        break;
      case 'GLONASS':
        ctx.beginPath(); // △
        ctx.moveTo(x, y - 4.5);
        ctx.lineTo(x + 4, y + 3.5);
        ctx.lineTo(x - 4, y + 3.5);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        break;
      case 'GALILEO':
        ctx.beginPath(); // ✕
        ctx.moveTo(x - 4, y - 4);
        ctx.lineTo(x + 4, y + 4);
        ctx.moveTo(x + 4, y - 4);
        ctx.lineTo(x - 4, y + 4);
        ctx.stroke();
        break;
      default: // 北斗/其他 ●
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        break;
    }
  }
};
