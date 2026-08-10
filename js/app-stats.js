/**
 * 途刻 TraceCraft - 统计弹窗 + 海拔剖面模块
 * =============================================
 * 通过 App.prototype.* 挂载到 App（须在 app-core.js 之后加载）：
 *  - _showTrailStats: 当前轨迹统计弹窗
 *  - _buildElevProfileData: 构建海拔剖面数据（app-export.js 报告导出复用）
 *  - _initElevProfileChart / _updateElevProfileChart: 海拔剖面 Chart.js
 */

App.prototype._showTrailStats = function () {
  const pos = this.trail.positions;
  if (pos.length < 2) {
    Toast.show(' 轨迹点数不足（至少 2 个点）');
    return;
  }

  const stats = this._calcLiveStats(pos);
  const totalDist = stats.distance;
  const durationMs = stats.durationMs;
  const maxSpeed = stats.maxSpeed;
  const hasSpeed = stats.hasSpeed;
  const avgSpeed = stats.avgSpeed;
  const elev = TrailAnalysis.analyzeElevation(pos);
  const firstTime = pos[0].time || null;
  const lastTime = pos[pos.length - 1].time || null;

  const fmtTime = (ts) => formatDateTime(ts, { shortDate: false, withSeconds: true });
  const fmtDate = (ts) => formatDateTime(ts, { shortDate: true, withSeconds: true });
  const fmtDuration = formatDurationLong;

  const overlay = document.getElementById('stats-modal');
  if (overlay) {
    document.getElementById('stat-distance').textContent = formatDistance(totalDist);
    document.getElementById('stat-duration').textContent = fmtDuration(durationMs);
    document.getElementById('stat-avg-speed').textContent = avgSpeed > 0 ? (avgSpeed * 3.6).toFixed(1) + ' km/h' : '--';
    document.getElementById('stat-max-speed').textContent = hasSpeed ? (maxSpeed * 3.6).toFixed(1) + ' km/h' : '--';
    document.getElementById('stat-points').textContent = pos.length;
    document.getElementById('stat-start-time').textContent = fmtDate(firstTime);
    document.getElementById('stat-end-time').textContent = fmtDate(lastTime);
    document.getElementById('stat-elev-max').textContent = elev.hasAltitude ? elev.maxAlt + ' m' : '--';
    document.getElementById('stat-elev-gain').textContent = elev.hasAltitude ? '+' + elev.gain + ' m' : '--';
    document.getElementById('stat-elev-loss').textContent = elev.hasAltitude ? '-' + elev.loss + ' m' : '--';
    overlay.classList.add('show');
    return;
  }

  const elevHasData = elev.hasAltitude;
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
          <div class="stat-card"><span class="stat-label">最高海拔</span><span class="stat-value" id="stat-elev-max">${elevHasData ? elev.maxAlt + ' m' : '--'}</span></div>
          <div class="stat-card"><span class="stat-label">累计爬升</span><span class="stat-value" id="stat-elev-gain">${elevHasData ? '+' + elev.gain + ' m' : '--'}</span></div>
          <div class="stat-card"><span class="stat-label">累计下降</span><span class="stat-value" id="stat-elev-loss">${elevHasData ? '-' + elev.loss + ' m' : '--'}</span></div>
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
};

/**
 * 构建海拔剖面数据：累计距离（米）→ 海拔（米），相邻点距离累加
 * @param {Array} positions 轨迹点 [{lat,lng,altitude?}]
 * @returns {Array<{x:number,y:number}>} 有海拔的点序列（不足 2 个返回空数组）
 */
App.prototype._buildElevProfileData = function (positions) {
  const data = [];
  if (!Array.isArray(positions) || positions.length < 2) return data;
  let cumDist = 0;
  let prev = null;
  for (const p of positions) {
    if (p == null || p.lat == null || p.lng == null) continue;
    if (prev) cumDist += calcDistance({ lat: prev.lat, lng: prev.lng }, { lat: p.lat, lng: p.lng });
    prev = { lat: p.lat, lng: p.lng };
    if (p.altitude != null && Number.isFinite(p.altitude)) {
      data.push({ x: cumDist, y: p.altitude });
    }
  }
  return data;
};

/**
 * 初始化海拔剖面图（Chart.js line，横轴累计距离，纵轴海拔）
 * @param {Array} positions 轨迹点
 */
App.prototype._initElevProfileChart = function (positions) {
  if (this._elevChart) return;
  const canvas = document.getElementById('elev-profile-canvas');
  if (!canvas || typeof Chart === 'undefined') return;
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const textColor = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
  this._elevChart = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [{
        data: [],
        borderColor: '#22c55e',
        backgroundColor: 'rgba(34,197,94,0.15)',
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
          title: { display: true, text: '距离(米)', color: textColor, font: { size: 10 } },
          grid: { color: gridColor },
          ticks: { color: textColor, font: { size: 9 }, maxTicksLimit: 6 }
        },
        y: {
          title: { display: true, text: '海拔(米)', color: textColor, font: { size: 10 } },
          grid: { color: gridColor },
          ticks: { color: textColor, font: { size: 9 }, maxTicksLimit: 5 }
        }
      }
    }
  });
  this._updateElevProfileChart(positions);
};

/**
 * 更新海拔剖面图数据（modal 复用与弹窗刷新共用）
 * @param {Array} positions 轨迹点
 */
App.prototype._updateElevProfileChart = function (positions) {
  if (!this._elevChart) return;
  const data = this._buildElevProfileData(positions);
  const infoEl = document.getElementById('elev-profile-info');
  if (infoEl && data.length) {
    let minAlt = Infinity, maxAlt = -Infinity;
    for (const d of data) {
      if (d.y < minAlt) minAlt = d.y;
      if (d.y > maxAlt) maxAlt = d.y;
    }
    infoEl.textContent = `${Math.round(minAlt)}~${Math.round(maxAlt)}m`;
  }
  this._elevChart.data.datasets[0].data = data;
  this._elevChart.update('none');
};
