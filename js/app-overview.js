/**
 * 途刻 TraceCraft - 总览模块（阶段2）
 * =============================================
 *  - 纯函数聚合：TrailOverview.aggregate(metas)（无 DOM 依赖，便于回归测试）
 *  - 渲染：App.prototype._renderOverview（复用 _loadTrailListCached 的 meta 缓存，零额外 IO）
 */
(function () {
  'use strict';

  function dayKey(ts) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  // 人类可读时长（秒 → 1h23m / 45m / 30s）
  function _fmtDuration(sec) {
    sec = Math.round(Number(sec) || 0);
    if (sec <= 0) return '0s';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return h + 'h' + (m > 0 ? m + 'm' : '');
    if (m > 0) return m + 'm';
    return (sec % 60) + 's';
  }

  const TrailOverview = {
    /**
     * 从轨迹 meta 数组聚合总览指标（全部本地计算，不触碰 positions）。
     * @param {Array} metas Storage meta 列表：[{distance,duration,createdAt,...}]
     * @returns {{trailCount,totalDistance,totalDuration,longestDistance,longestDuration,activeDays,avgDistance}}
     */
    aggregate(metas) {
      const list = Array.isArray(metas) ? metas : [];
      let totalDistance = 0, totalDuration = 0, longestDistance = 0, longestDuration = 0;
      const days = new Set();
      let count = 0;
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        const d = Number(m.distance) || 0;
        const dur = Number(m.duration) || 0;
        if (d <= 0 && dur <= 0 && !m.createdAt) continue; // 无效记录跳过
        count++;
        totalDistance += d;
        totalDuration += dur;
        if (d > longestDistance) longestDistance = d;
        if (dur > longestDuration) longestDuration = dur;
        if (m.createdAt) {
          const k = dayKey(m.createdAt);
          if (k) days.add(k);
        }
      }
      return {
        trailCount: count,
        totalDistance: totalDistance,
        totalDuration: totalDuration,
        longestDistance: longestDistance,
        longestDuration: longestDuration,
        activeDays: days.size,
        avgDistance: count > 0 ? totalDistance / count : 0
      };
    }
  };

  // 暴露给全局（浏览器与测试桩中 window===global）
  if (typeof window !== 'undefined') window.TrailOverview = TrailOverview;
  if (typeof globalThis !== 'undefined') globalThis.TrailOverview = TrailOverview;

  // App.prototype 挂载（须 app-core.js 已加载）
  if (typeof App !== 'undefined') {
    App.prototype._renderOverview = function () {
      const el = document.getElementById('tab-overview');
      if (!el) return;
      if (typeof this._loadTrailListCached !== 'function') return;
      const loading = document.getElementById('ov-loading');
      const heroLabel = document.getElementById('ov-hero-label');
      if (loading) loading.style.display = '';
      this._loadTrailListCached().then((items) => {
        if (loading) loading.style.display = 'none';
        const stats = TrailOverview.aggregate(items);
        const setText = (id, v) => {
          const n = document.getElementById(id);
          if (n) n.textContent = v;
        };
        setText('ov-total-distance', (stats.totalDistance / 1000).toFixed(1));
        setText('ov-trail-count', String(stats.trailCount));
        setText('ov-active-days', String(stats.activeDays));
        setText('ov-total-duration', _fmtDuration(stats.totalDuration));
        setText('ov-longest-distance', (stats.longestDistance / 1000).toFixed(1) + ' km');
        setText('ov-avg-distance', (stats.avgDistance / 1000).toFixed(1) + ' km');
        // 空态友好文案（阶段5）：无轨迹时不显示空白难看的 0
        if (heroLabel) heroLabel.textContent = stats.trailCount === 0 ? '暂无轨迹记录' : '累计里程';
      }).catch(function () {
        if (loading) loading.style.display = 'none';
      });
    };
  }
})();
