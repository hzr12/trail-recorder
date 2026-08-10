/**
 * 途刻 TraceCraft - 报告导出模块
 * =============================================
 * 通过 App.prototype.* 挂载到 App（须在 app-core.js 之后加载）：
 *  - _exportReport: 活动报告导出（Canvas 手绘地图瓦片 + 统计 + 海拔剖面）
 */

App.prototype._exportReport = async function () {
  const pos = this.trail.positions;
  if (pos.length < 2) {
    Toast.show(' 轨迹点数不足（至少 2 个点）');
    return;
  }

  Toast.show(' 正在生成报告...');

  try {
    const totalDist = this.trail.getDistance();
    const firstTime = pos[0].time || null;
    const lastTime = pos[pos.length - 1].time || null;
    let durationMs = 0;
    if (firstTime && lastTime && lastTime > firstTime) durationMs = lastTime - firstTime;

    let maxSpeed = 0;
    let hasSpeed = false;
    for (const p of pos) {
      if (p.speed != null && p.speed > maxSpeed) {
        maxSpeed = p.speed;
        hasSpeed = true;
      }
    }
    const avgSpeed = durationMs > 0 ? totalDist / (durationMs / 1000) : 0;
    const elev = TrailAnalysis.analyzeElevation(pos);

    const fmtDate = (ts) => formatDateTime(ts, { withSeconds: true });
    const fmtDuration = formatDurationLong;
    const isDark = this._theme === 'dark';

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = 800 * dpr;
    const H = 1120 * dpr;
    const S = dpr;

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = isDark ? '#1a1a2e' : '#f0f0f5';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = isDark ? '#16213e' : '#ffffff';
    ctx.fillRect(0, 0, W, 80 * S);
    ctx.fillStyle = isDark ? '#00d4aa' : '#0ea5e9';
    ctx.font = `${24 * S}px "HarmonyOS Sans", sans-serif`;
    ctx.fillText(' 途刻活动报告', 24 * S, 44 * S);
    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)';
    ctx.font = `${13 * S}px "HarmonyOS Sans", sans-serif`;
    ctx.fillText(formatBeijing(Date.now()), 24 * S, 66 * S);

    const mapY = 96 * S;
    const mapH = 320 * S;
    const mapW = W - 48 * S;
    const mapX = 24 * S;

    let minLat = Infinity, maxLat = -Infinity;
    let minLng = Infinity, maxLng = -Infinity;
    for (const p of pos) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }
    const rawLatSpan = maxLat - minLat || 0.001;
    const rawLngSpan = maxLng - minLng || 0.001;
    const padR = Math.max(0.001, Math.max(rawLatSpan, rawLngSpan) * 0.5);
    minLat -= padR; maxLat += padR;
    minLng -= padR; maxLng += padR;
    const lngSpan = maxLng - minLng || 0.001;
    const latSpan = maxLat - minLat || 0.001;
    const margin = 20 * S;
    const drawW = mapW - margin * 2;
    const drawH = mapH - margin * 2;

    const midLat = (minLat + maxLat) / 2;
    const cosLat = Math.cos(midLat * Math.PI / 180);
    const dataW = lngSpan * cosLat;
    const dataH = latSpan;
    const scale = Math.min(drawW / dataW, drawH / dataH);
    const usedW = dataW * scale;
    const usedH = dataH * scale;
    const originX = mapX + margin + (drawW - usedW) / 2;
    const originY = mapY + margin + (drawH - usedH) / 2;

    const toX = (lng) => originX + (lng - minLng) * cosLat * scale;
    const toY = (lat) => originY + (maxLat - lat) * scale;

    // ── 地图底图：腾讯地图瓦片（realtimerender 矢量渲染，GCJ-02 与轨迹同坐标系，与应用显示底图一致） ──
    // Web Mercator 投影（0~1 世界坐标）
    const mercX = (lng) => (lng + 180) / 360;
    const mercY = (lat) => {
      const r = lat * Math.PI / 180;
      return (1 - Math.log(Math.tan(Math.PI / 4 + r / 2)) / Math.PI) / 2;
    };
    const invMercY = (v) => Math.atan(Math.sinh(Math.PI * (1 - 2 * v))) * 180 / Math.PI;
    // 地图区四角经纬度（用于瓦片范围计算，确保瓦片覆盖整个地图区）
    const mapLeftLng = (mapX - originX) / (cosLat * scale) + minLng;
    const mapRightLng = (mapX + mapW - originX) / (cosLat * scale) + minLng;
    const mapTopLat = maxLat - (mapY - originY) / scale;
    const mapBotLat = maxLat - (mapY + mapH - originY) / scale;
    // 瓦片层级：按目标每像素米数反算（cos 纬度修正），clamp 3~18
    const targetMpp = 111320 / scale;
    let z = Math.round(Math.log2(156543.03392 * Math.cos(midLat * Math.PI / 180) / targetMpp));
    z = Math.min(18, Math.max(3, z));
    // 瓦片数量上限 100：超出则降档
    let tileRange = null;
    for (; z >= 3; z--) {
      const x0 = Math.floor(mercX(mapLeftLng) * (1 << z));
      const x1 = Math.floor(mercX(mapRightLng) * (1 << z));
      const y0 = Math.floor(mercY(mapTopLat) * (1 << z));
      const y1 = Math.floor(mercY(mapBotLat) * (1 << z));
      tileRange = { x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
      if (tileRange.count <= 100) break;
    }
    // 受限并发加载瓦片（浏览器并发连接数限制，一次全量并发易触发限流/失败），任一张失败 → 降级纯色底图
    let tileImages = [];
    if (tileRange) {
      tileImages = await this._loadReportTiles(tileRange, z, { mapX, mapY, mapW, mapH });
    }
    if (tileRange && tileImages.length === tileRange.count) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(mapX, mapY, mapW, mapH);
      ctx.clip();
      const tileWpx = (360 / (1 << z)) * cosLat * scale;
      let i = 0;
      for (let tx = tileRange.x0; tx <= tileRange.x1; tx++) {
        for (let ty = tileRange.y0; ty <= tileRange.y1; ty++) {
          const tileLng = tx / (1 << z) * 360 - 180;
          const latTop = invMercY(ty / (1 << z));
          const latBot = invMercY((ty + 1) / (1 << z));
          const px = toX(tileLng);
          const py = toY(latTop);
          const ph = toY(latBot) - toY(latTop);
          ctx.drawImage(tileImages[i++], px - 0.5, py - 0.5, tileWpx + 1, ph + 1);
        }
      }
      ctx.restore();
    } else {
      // 降级：纯色底图（主题色跟随）
      ctx.fillStyle = isDark ? '#0f3460' : '#dce5f0';
      ctx.fillRect(mapX, mapY, mapW, mapH);
    }

    const trailPoints = this._getTrailPositions();
    if (trailPoints.length >= 2) {
      const colorMap = isDark ? this.mapManager._speedColorDark : this.mapManager._speedColorLight;
      const getSpeedKey = (s) => this.mapManager._speedColorKey(s);

      let batchPath = [];
      let batchKey = null;

      const flushBatch = () => {
        if (batchPath.length < 2 || !batchKey) return;
        const c = colorMap[batchKey];
        ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${c.a})`;
        ctx.lineWidth = 2.5 * S;
        ctx.beginPath();
        ctx.moveTo(batchPath[0].x, batchPath[0].y);
        for (let j = 1; j < batchPath.length; j++) {
          ctx.lineTo(batchPath[j].x, batchPath[j].y);
        }
        ctx.stroke();
      };

      for (let i = 1; i < trailPoints.length; i++) {
        const p0 = trailPoints[i - 1];
        const p1 = trailPoints[i];
        const speed = p1.speed != null ? p1.speed : 0;
        const key = getSpeedKey(speed);

        if (key !== batchKey) {
          flushBatch();
          batchPath = [{ x: toX(p0.lng), y: toY(p0.lat) }];
          batchKey = key;
        }
        batchPath.push({ x: toX(p1.lng), y: toY(p1.lat) });
      }
      flushBatch();
    }

    if (trailPoints.length >= 2) {
      const first = trailPoints[0];
      const last = trailPoints[trailPoints.length - 1];
      ctx.fillStyle = '#22c55e';
      ctx.beginPath();
      ctx.arc(toX(first.lng), toY(first.lat), 5 * S, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(toX(last.lng), toY(last.lat), 5 * S, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      ctx.font = `${11 * S}px "HarmonyOS Sans", sans-serif`;
      ctx.fillText('起点', toX(first.lng) + 8 * S, toY(first.lat) + 4 * S);
      ctx.fillText('终点', toX(last.lng) + 8 * S, toY(last.lat) + 4 * S);
    }

    const statsY = mapY + mapH + 16 * S;
    const statsH = 200 * S;
    ctx.fillStyle = isDark ? '#16213e' : '#ffffff';
    ctx.beginPath();
    ctx.roundRect(mapX, statsY, mapW, statsH, 12 * S);
    ctx.fill();

    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)';
    ctx.font = `${16 * S}px "HarmonyOS Sans", sans-serif`;
    ctx.fillText(' 轨迹统计', mapX + 16 * S, statsY + 32 * S);

    const statItems = [
      { label: '总距离', value: formatDistance(totalDist) },
      { label: '总时长', value: fmtDuration(durationMs) },
      { label: '平均速度', value: avgSpeed > 0 ? (avgSpeed * 3.6).toFixed(1) + ' km/h' : '--' },
      { label: '最高速度', value: hasSpeed ? (maxSpeed * 3.6).toFixed(1) + ' km/h' : '--' },
      { label: '最高海拔', value: elev.hasAltitude ? elev.maxAlt + ' m' : '--' },
      { label: '累计爬升', value: elev.hasAltitude ? '+' + elev.gain + ' m' : '--' },
      { label: '累计下降', value: elev.hasAltitude ? '-' + elev.loss + ' m' : '--' },
      { label: '轨迹点数', value: String(pos.length) },
    ];

    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
    ctx.font = `${12 * S}px "HarmonyOS Sans", sans-serif`;
    const colW = (mapW - 32 * S) / 3;
    for (let i = 0; i < statItems.length; i++) {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const sx = mapX + 16 * S + col * colW;
      const sy = statsY + 56 * S + row * 48 * S;
      ctx.fillText(statItems[i].label, sx, sy);
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)';
      ctx.font = `${18 * S}px "HarmonyOS Sans", sans-serif`;
      ctx.fillText(statItems[i].value, sx, sy + 22 * S);
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
      ctx.font = `${12 * S}px "HarmonyOS Sans", sans-serif`;
    }

    // ── 海拔剖面图（手绘：累计距离 → 海拔折线 + 渐变填充） ──
    const elevY = statsY + statsH + 16 * S;
    const elevH = 180 * S;
    ctx.fillStyle = isDark ? '#16213e' : '#ffffff';
    ctx.beginPath();
    ctx.roundRect(mapX, elevY, mapW, elevH, 12 * S);
    ctx.fill();

    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)';
    ctx.font = `${16 * S}px "HarmonyOS Sans", sans-serif`;
    ctx.fillText(' 海拔剖面', mapX + 16 * S, elevY + 32 * S);

    const elevData = this._buildElevProfileData(pos);
    if (elevData.length >= 2) {
      let minAlt = Infinity, maxAlt = -Infinity, maxDist = 0;
      for (const d of elevData) {
        if (d.y < minAlt) minAlt = d.y;
        if (d.y > maxAlt) maxAlt = d.y;
        if (d.x > maxDist) maxDist = d.x;
      }
      if (minAlt === maxAlt) { minAlt -= 5; maxAlt += 5; }
      const altPad = (maxAlt - minAlt) * 0.15;
      minAlt -= altPad; maxAlt += altPad;

      const plotX = mapX + 48 * S;
      const plotY = elevY + 48 * S;
      const plotW = mapW - 72 * S;
      const plotH = elevH - 72 * S;
      const toX2 = (x) => plotX + (maxDist > 0 ? (x / maxDist) * plotW : plotW / 2);
      const toY2 = (y) => plotY + ((maxAlt - y) / (maxAlt - minAlt)) * plotH;

      // 网格横线 + 海拔刻度
      ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
      ctx.lineWidth = S;
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)';
      ctx.font = `${10 * S}px "HarmonyOS Sans", sans-serif`;
      ctx.textAlign = 'right';
      for (let g = 0; g <= 4; g++) {
        const gy = plotY + (g / 4) * plotH;
        ctx.beginPath();
        ctx.moveTo(plotX, gy);
        ctx.lineTo(plotX + plotW, gy);
        ctx.stroke();
        const altVal = maxAlt - (g / 4) * (maxAlt - minAlt);
        ctx.fillText(Math.round(altVal) + 'm', plotX - 6 * S, gy + 4 * S);
      }
      ctx.textAlign = 'left';
      ctx.fillText('0m', plotX - 6 * S, plotY + plotH + 14 * S);
      ctx.textAlign = 'right';
      ctx.fillText(formatDistance(maxDist), plotX + plotW, plotY + plotH + 14 * S);
      ctx.textAlign = 'left';

      // 折线 + 渐变填充
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(toX2(elevData[0].x), toY2(elevData[0].y));
      for (let i = 1; i < elevData.length; i++) {
        ctx.lineTo(toX2(elevData[i].x), toY2(elevData[i].y));
      }
      ctx.strokeStyle = isDark ? '#4ade80' : '#16a34a';
      ctx.lineWidth = 2 * S;
      ctx.stroke();
      // 填充（折线闭合到底部）
      ctx.lineTo(plotX + plotW, plotY + plotH);
      ctx.lineTo(plotX, plotY + plotH);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, plotY, 0, plotY + plotH);
      grad.addColorStop(0, isDark ? 'rgba(74,222,128,0.35)' : 'rgba(22,163,74,0.25)');
      grad.addColorStop(1, 'rgba(74,222,128,0.02)');
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();

      // 最高/最低点标注
      let hiPt = elevData[0], loPt = elevData[0];
      for (const d of elevData) {
        if (d.y > hiPt.y) hiPt = d;
        if (d.y < loPt.y) loPt = d;
      }
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(toX2(hiPt.x), toY2(hiPt.y), 4 * S, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `${10 * S}px "HarmonyOS Sans", sans-serif`;
      ctx.fillText('最高 ' + Math.round(hiPt.y) + 'm', toX2(hiPt.x) + 6 * S, toY2(hiPt.y) - 6 * S);
      ctx.fillStyle = '#22c55e';
      ctx.beginPath();
      ctx.arc(toX2(loPt.x), toY2(loPt.y), 4 * S, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText('最低 ' + Math.round(loPt.y) + 'm', toX2(loPt.x) + 6 * S, toY2(loPt.y) + 14 * S);
    } else {
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)';
      ctx.font = `${13 * S}px "HarmonyOS Sans", sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('轨迹无海拔数据', mapX + mapW / 2, elevY + elevH / 2);
      ctx.textAlign = 'left';
    }

    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)';
    ctx.font = `${11 * S}px "HarmonyOS Sans", sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText('途刻', W - 24 * S, H - 16 * S);
    ctx.fillText('注：底图较老，仅供参考使用', W - 24 * S, H - 40 * S);
    ctx.textAlign = 'left';

    const dateStr = formatBeijing(Date.now()).replace(/[/\s:]/g, '-');
    const filename = `tracecraft-activity-${dateStr}.png`;
    canvas.toBlob(async (blob) => {
      if (!blob) {
        Toast.show(' 导出失败：无法生成图片');
        return;
      }

      if (typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform()) {
        try {
          const reader = new FileReader();
          const base64 = await new Promise(resolve => {
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.readAsDataURL(blob);
          });

          const result = await Capacitor.Plugins.Filesystem.writeFile({
            path: filename,
            data: base64,
            directory: 'CACHE',
          });

          await Capacitor.Plugins.Share.share({
            title: '途刻活动报告',
            text: '途刻 — 轨迹活动报告',
            url: result.uri,
            dialogTitle: '分享或保存活动报告',
          });

          Toast.show(' 报告已分享');
        } catch (e) {
          Toast.show(' 分享取消或失败');
        }
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = filename;
        link.href = url;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        Toast.show(` 已导出：${filename}`);
      }
    }, 'image/png');
  } catch (e) {
    console.error('[Export] 报告导出失败:', e);
    Toast.show(' 导出报告失败');
  }
};

/**
 * 受限并发加载地图瓦片：每次并发 6 张，避免一次性全量并发触发浏览器连接数限制/服务端限流
 * @returns {Promise<Array>} 瓦片 Image 数组（任一张失败 → 返回空数组触发降级）
 */
App.prototype._loadReportTiles = async function (tileRange, z, rect) {
  const jobs = [];
  for (let tx = tileRange.x0; tx <= tileRange.x1; tx++) {
    for (let ty = tileRange.y0; ty <= tileRange.y1; ty++) {
      jobs.push({ z, x: tx, y: ty });
    }
  }
  const results = new Array(jobs.length).fill(null);
  let cursor = 0;
  const CONCURRENCY = 6;
  const workers = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= jobs.length) return;
      const j = jobs[idx];
      try {
        const img = await this.mapManager._loadMapTile(j.z, j.x, j.y);
        results[idx] = img;
      } catch (e) {
        results[idx] = null;
        if (CONFIG.DEBUG) console.warn('[Report] 瓦片加载失败:', j.z, j.x, j.y, e.message);
      }
    }
  });
  await Promise.all(workers);
  if (results.some((r) => !r)) return [];
  return results;
};
