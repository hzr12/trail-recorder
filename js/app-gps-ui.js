/**
 * 途刻（TraceCraft）- GPS UI 渲染
 * ============================================
 * 追加 App.prototype 方法：状态条、速度曲线、定位列表、会话列表
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
    return;
  }
  const now = Date.now();
  if (!force && this._lastStatusUpdate && now - this._lastStatusUpdate < CONFIG.STATUS_THROTTLE_MS) return;
  this._lastStatusUpdate = now;
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

  if (this._batteryLevel != null) {
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
  if (!stale && this._lastAccuracy != null) {
    const bars = this._lastAccuracy <= 10 ? 4 : this._lastAccuracy <= 30 ? 3 : this._lastAccuracy <= 100 ? 2 : 1;
    const label = ['弱', '一般', '良好', '极好'][bars];
    line2Parts.push(`<span class="gps-signal" title="精度 ±${Math.round(this._lastAccuracy)}m">${label}</span>`);
  }
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
  const line2 = line2Parts.length ? line2Parts.join(' ｜ ') : '<span style="opacity:0.5">位置待更新</span>';
  const line3 = this._weatherHtml ? `<div class="gps-line2">${this._weatherHtml}</div>` : '';

  this._statusEl.innerHTML =
    `<div class="gps-line1"><span class="${dotClass}"></span><span class="gps-online">${isManual ? '' : '◉'} 已定位</span>${degradedIcon}${manualIcon}${watchingIcon}${followIcon} <span class="gps-elapsed">(${elapsed})</span>${staleIcon}</div>` +
    `<div class="gps-line2">${line2}</div>` +
    line3;
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

/* ── 历史轨迹会话列表 ─────────────────────────── */

App.prototype._renderSessionList = function () {
  const section = document.getElementById('sessions-section');
  const listEl = document.getElementById('sessions-list');
  if (!section || !listEl) return;
  const hasSessions = this.sessionManager.sessions.length > 0 || this.sessionManager.recordings.length > 0;
  section.style.display = hasSessions ? '' : 'none';
  if (!hasSessions) return;

  const allSessions = [...this.sessionManager.recordings, ...this.sessionManager.sessions];
  let html = '';

  // 收藏区
  const favorites = allSessions.filter(s => s.isFavorite);
  if (favorites.length > 0) {
    html += '<div class="session-group-label">⭐ 收藏</div>';
    for (const s of favorites) html += this._renderSessionItem(s);
  }

  // 全部区
  html += '<div class="session-group-label">全部轨迹</div>';
  for (const s of allSessions) {
    if (s.isFavorite) continue;
    html += this._renderSessionItem(s);
  }
  listEl.innerHTML = html;

  // 绑定事件
  listEl.querySelectorAll('.session-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.session-fav-btn') || e.target.closest('.session-del-btn') || e.target.closest('.session-name')) return;
      this._startReplay(el.dataset.id);
    });
  });
  listEl.querySelectorAll('.session-fav-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleFavorite(el.dataset.id, el);
    });
  });
  listEl.querySelectorAll('.session-del-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this._deleteSession(el.dataset.id);
    });
  });
  listEl.querySelectorAll('.session-name').forEach(el => {
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this._editSessionName(el.dataset.id, el);
    });
  });

  this._updateBatchExportBtn();
  this._updateSelectAllBtn();
};

App.prototype._renderSessionItem = function (s) {
  const isSelected = this._selectedSessionIds && this._selectedSessionIds.has(s.id);
  const isReplaying = this._replayingId === s.id;
  const d = new Date(s.createdAt);
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const durStr = this._formatDuration(s.durationMs);
  const distStr = s.distance > 0 ? formatDistance(s.distance) : '0m';
  const favClass = s.isFavorite ? ' active' : '';
  const selClass = isSelected ? ' selected' : '';
  const replayClass = isReplaying ? ' replaying' : '';
  return `<div class="session-item${selClass}${replayClass}" data-id="${s.id}">
    <div class="session-check${isSelected ? ' checked' : ''}"></div>
    <div class="session-name" data-id="${s.id}" title="双击编辑名称">${this._escapeHtml(s.name)}</div>
    <div class="session-meta">
      <span>${dateStr}</span>
      <span>${distStr}</span>
      <span>${durStr}</span>
    </div>
    <div class="session-actions">
      <button class="session-fav-btn${favClass}" data-id="${s.id}" title="${s.isFavorite ? '取消收藏' : '收藏'}">${s.isFavorite ? '★' : '☆'}</button>
      <button class="session-del-btn" data-id="${s.id}" title="删除">✕</button>
    </div>
  </div>`;
};

App.prototype._updateBatchExportBtn = function () {
  const btn = document.getElementById('batch-export-btn');
  if (!btn) return;
  const count = this._selectedSessionIds ? this._selectedSessionIds.size : 0;
  if (count > 0) {
    btn.textContent = ` 导出${count}条`;
    btn.disabled = false;
  } else {
    btn.textContent = ' 导出';
    btn.disabled = true;
  }
};

App.prototype._updateSelectAllBtn = function () {
  const btn = document.getElementById('select-all-btn');
  if (!btn) return;
  const total = (this.sessionManager.sessions || []).length;
  const selected = this._selectedSessionIds ? this._selectedSessionIds.size : 0;
  btn.textContent = selected === total && total > 0 ? '取消全选' : '全选';
  btn.disabled = total === 0;
};

App.prototype._formatDuration = function (ms) {
  if (!ms || ms <= 0) return '--';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
};

App.prototype._escapeHtml = function (str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
};
