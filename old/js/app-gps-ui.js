/**
 * 圆圈地图 - GPS UI 渲染
 * ============================================
 * 追加 App.prototype 方法：状态条、速度曲线、定位列表
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

/* ── 最近定位列表 ──────────────────────────────────── */

App.prototype._updateRecentFixes = function () {
  const listEl = this._fixListEl || (this._fixListEl = document.getElementById('fix-list'));
  if (!listEl) return;
  const countEl = this._fixCountEl || (this._fixCountEl = document.getElementById('fix-count'));
  if (!this._recentFixes.length) {
    listEl.innerHTML = '<div class="empty-state">暂无定位数据</div>';
    if (countEl) countEl.textContent = '0';
    return;
  }
  // 列表只展示最新 1 条（内部仍保留 MAX_RECENT_FIXES 条记录）
  if (countEl) countEl.textContent = '1';
  const f = this._recentFixes[this._recentFixes.length - 1];
  const d = new Date(f.time);
  const pad = (n) => String(n).padStart(2, '0');
  const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const accStr = f.accuracy ? `±${f.accuracy.toFixed(0)}m` : '--';
  let accClass = 'acc-poor';
  if (f.accuracy < 15) accClass = 'acc-good';
  else if (f.accuracy < 50) accClass = 'acc-ok';
  const manualTag = f.isManual ? ' <span class="fix-manual"> 手动</span>' : '';
  const bgTag = f.isBackground ? ' <span class="fix-bg">后台</span>' : '';
  const coordStr = `${f.lat.toFixed(4)}, ${f.lng.toFixed(4)}`;
  listEl.innerHTML = `<div class="fix-item">
    <span class="fix-time">${timeStr}</span>
    <span class="fix-accuracy ${accClass}">${accStr}</span>
    <span class="fix-coord">${coordStr}${manualTag}${bgTag}</span>
  </div>`;
};

/* ── GPS 状态条 ────────────────────────────────────── */

App.prototype._updateStatusBar = function (force) {
  if (!this._statusEl) return;
  if (!this.myPosition) {
    this._statusEl.innerHTML = '<div class="gps-line1"><span class="gps-dot"></span><span class="gps-offline">⊙ 未定位，点击 GPS 按钮定位</span></div>';
    if (this._gnssBarEl) this._gnssBarEl.innerHTML = '';
    return;
  }
  const now = Date.now();
  if (!force && this._lastStatusUpdate && now - this._lastStatusUpdate < CONFIG.STATUS_THROTTLE_MS) return;
  this._lastStatusUpdate = now;
  const circles = this.mapManager.getCircles();
  let nearest = null;
  let nearDist = Infinity;
  for (const c of circles) {
    const d = calcDistance(this.myPosition, c.center);
    if (d < nearDist) { nearDist = d; nearest = c; }
  }
  let nearStr = '';
  if (nearest) {
    const { within } = this._calcCircleTrend(nearest);
    nearStr = within === 'inrange'
      ? `最近圆 ≤ ${formatDistance(nearest.maxRadius)} `
      : within === 'maybe'
        ? `最近圆 ${formatDistance(nearDist)} `
        : `最近圆 ${formatDistance(nearDist)}`;
  }
  const elapsed = this._formatElapsed();
  const stale = this._isPositionStale();
  const isTracking = this._isWatching;
  const isManual = this._isManualPosition;
  const isDowngraded = this.gpsManager.isDowngraded;
  let dotClass = '';
  if (stale) {
    dotClass = 'gps-dot stale';
  } else if (isTracking) {
    dotClass = 'gps-dot tracking';
  } else {
    dotClass = 'gps-dot online';
  }
  const watchingIcon = isTracking ? ' <span class="gps-tracking">◉</span>' : '';
  const staleIcon = stale ? ' <span class="gps-stale"> 已过期</span>' : '';
  const followIcon = this._followMode ? ' <span class="gps-follow"> 跟随中</span>' : '';
  const manualIcon = isManual ? ' <span class="gps-manual"> 手动定位</span>' : '';
  const degradedIcon = isDowngraded ? ' <span class="gps-degraded"> 低精度</span>' : '';

  let gnssHtml = '';
  if (this.gpsManager.hasGnssPlugin) {
    if (this.gpsManager.gnssVisibleCount > 0) {
      const used = this.gpsManager.gnssUsedCount;
      const visible = this.gpsManager.gnssVisibleCount;
      const snr = this.gpsManager.gnssAvgSnr;
      gnssHtml = `<span class="gnss-indicator" title="参与定位 ${used}/${visible}, 平均信噪比 ${snr.toFixed(0)}dB-Hz">` +
        ` 定位:${used} 可见:${visible} 信噪比:${snr.toFixed(0)}dB</span>`;
    } else {
      gnssHtml = `<span class="gnss-indicator" style="opacity:0.5"> 等待卫星...</span>`;
    }
  }

  let signalHtml = '';
  if (this._lastAccuracy != null) {
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
  if (!stale && this._lastHeading != null) {
    const dir = bearingToDir(this._lastHeading);
    const arrows = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
    const arrow = arrows[Math.round(this._lastHeading / 45) % 8];
    line2Parts.push(`<span class="gps-heading">${arrow} ${dir} ${Math.round(this._lastHeading)}°</span>`);
  }
  if (this._batteryLevel != null) {
    const pct = Math.round(this._batteryLevel * 100);
    const timeStr = this._getBatteryTimeStr();
    const label = this._batteryCharging ? '充电中' : (timeStr ? `约${timeStr}` : '');
    line2Parts.push(`<span class="gps-battery" title="电量 ${pct}%">${pct}%${label ? ' ' + label : ''}</span>`);
  }
  if (nearStr) line2Parts.push(nearStr);
  const line2 = line2Parts.length ? line2Parts.join(' ｜ ') : '<span style="opacity:0.5">位置待更新</span>';
  const line3 = this._weatherHtml ? `<div class="gps-line2">${this._weatherHtml}</div>` : '';

  this._statusEl.innerHTML =
    `<div class="gps-line1"><span class="${dotClass}"></span><span class="gps-online">${isManual ? '' : '◉'} 已定位</span>${degradedIcon}${manualIcon}${watchingIcon}${followIcon} <span class="gps-elapsed">(${elapsed})</span>${staleIcon}</div>` +
    `<div class="gps-line2">${line2}</div>` +
    line3;

  if (this._gnssBarEl) {
    this._gnssBarEl.innerHTML = gnssHtml || '';
  }
};

App.prototype._toggleFollowMode = function () {
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
