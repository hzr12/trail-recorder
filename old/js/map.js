/**
 * 圆圈地图 - 地图管理器
 * ============================================
 * 使用 Canvas 叠加层绘制同心圆（样式参照 demo.html）
 * 纬向墨卡托投影坐标 → 容器像素转换
 */

// roundRect polyfill — 兼容 iOS <15.4、Firefox <112
if (typeof CanvasRenderingContext2D !== 'undefined' &&
    !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    const radii = typeof r === 'number' ? [r, r, r, r] : r;
    const [tl, tr, br, bl] = radii;
    if (tl < 0 || tr < 0 || br < 0 || bl < 0) {
      throw new TypeError('roundRect radii must not be negative');
    }
    this.moveTo(x + tl, y);
    this.lineTo(x + w - tr, y);
    this.quadraticCurveTo(x + w, y, x + w, y + tr);
    this.lineTo(x + w, y + h - br);
    this.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
    this.lineTo(x + bl, y + h);
    this.quadraticCurveTo(x, y + h, x, y + h - bl);
    this.lineTo(x, y + tl);
    this.quadraticCurveTo(x, y, x + tl, y);
    this.closePath();
    return this;
  };
}

class MapManager {
  constructor() {
    this.map = null;
    this.marker = null;
    this._locAnim = null;        // 定位 marker 插值动画状态（rAF 平滑移动）
    this.canvas = null;
    this.ctx = null;
    this.overlayCanvas = null;
    this.overlayCtx = null;
    this.center = null;         // 当前标记位置（用于下一个圆）
    this.mode = 'click';
    this.onMapClick = null;        // 点击地图回调（多人模式：设为我的共享位置）
    this.circles = [];          // {id, center:{lat,lng}, maxRadius, interval}
    this.selectedCircleId = null;
    this._remoteCircles = [];    // 其他玩家同步过来的圆（多人可见）
    this._idCounter = Date.now(); // #3 时间戳起始 + 递增，避免碰撞
    this.PICK_THRESHOLD = 22;   // 像素距离阈值

    this._rafId = null;
    this._overlayRafId = null;
    this._syncCenter = null;    // 地图实际显示中心（我们追踪，不依赖 getCenter）
    this._coordCache = new Map(); // 像素坐标缓存：key -> {cx, cy, mp, ip, ts}

    this.locationMarker = null; // 我的位置标记（区别于圆心标识）
    this.accuracyCircle = null; // #17 定位精度圆环
    this.trailPolylines = [];   // 历史轨迹线（多段，按速度着色）
    this._lastTrailCount = 0;   // 增量渲染基数：已渲染的点数
    this._targetPos = null;    // 对方位置坐标
    this.targetCircle = null;  // 对方精度范围圈
    this._myPos = null;        // 我的位置（Canvas 标注用）
    this.playerMarkers = {};   // 多人位置标记 {deviceId: qq.maps.Marker}
    this.playerAccuracyCircles = {}; // 多人精度圈 {deviceId: qq.maps.Circle}
    this._playerPredictions = {}; // 玩家位置预测 {deviceId: {lat,lng,bearing,speed,acc,ts}}

    // 回调钩子
    this.onCenterChange = null;
    this.onLongPress = null; // #13 长按回调

    this._theme = 'dark';    // 当前主题（影响 Canvas 颜色）
  }

  /**
   * 初始化地图 + Canvas 叠加层
   */
  init(containerId, center, zoom) {
    const mapEl = document.getElementById(containerId);

    // —— Canvas 叠加层 ——
    this.canvas = document.getElementById('circle-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.overlayCanvas = document.getElementById('overlay-canvas');
    this.overlayCtx = this.overlayCanvas ? this.overlayCanvas.getContext('2d') : null;

    // —— 腾讯地图 SDK 加载失败兜底（网络被拦/key 失效/脚本注入失败） ——
    if (typeof qq === 'undefined' || !qq.maps || typeof qq.maps.Map !== 'function') {
      console.error('[MapManager] 腾讯地图 SDK 加载失败');
      try { Toast.show(' 地图加载失败，请检查网络后刷新页面'); } catch (_) { /* 兜底 */ }
      throw new Error('腾讯地图 SDK 未加载');
    }

    // —— 腾讯地图 ——
    this.map = new qq.maps.Map(mapEl, {
      center: new qq.maps.LatLng(center.lat, center.lng),
      zoom: zoom || CONFIG.DEFAULT_ZOOM,
      mapTypeId: qq.maps.MapTypeId.ROADMAP
    });

    // #DEBUG: 输出运行环境关键参数，辅助诊断手机端瓦片差异
    if (CONFIG.DEBUG) {
      console.info('[MapManager] init env:', JSON.stringify({
        ua: (navigator.userAgent || '').substring(0, 80),
        dpr: window.devicePixelRatio || 1,
        viewport: window.innerWidth + 'x' + window.innerHeight,
        platform: navigator.platform || 'unknown',
      }));
    }

    // 追踪地图实际显示中心（绕过 getCenter 异步问题）
    this._syncCenter = new qq.maps.LatLng(center.lat, center.lng);

    // 点击选点 / 选取圆心
    qq.maps.event.addListener(this.map, 'click', (event) => {
      if (!event.latLng) return;
      const pos = { lat: event.latLng.getLat(), lng: event.latLng.getLng() };

      // 仅在 click 模式下做"选取圆心"：点到已有圆心则选中并停止（不触发选点）
      if (this.mode === 'click') {
        const clickedPt = this._latLngToContainerPoint(event.latLng);
        if (clickedPt) {
          const picked = this._pickCircle(clickedPt);
          if (picked) {
            this.selectedCircleId = picked.id;
            this._scheduleRedraw();
            if (this.onCenterChange) this.onCenterChange(picked.center, picked);
            return;
          }
        }
      }

      // click / room / input 等各模式下均允许点击选点（设圆心 + 多人广播）
      this.setCenter(pos);
      if (this.onMapClick) this.onMapClick(pos);
    });

    // #13 — 长按地图触发回调（用于手动设位置或快速创建圆）
    qq.maps.event.addListener(this.map, 'longpress', (event) => {
      if (!event.latLng) return;
      if (this.onLongPress) {
        this.onLongPress({ lat: event.latLng.getLat(), lng: event.latLng.getLng() });
      }
    });

    // 地图变化 → 重绘 Circle Canvas
    qq.maps.event.addListener(this.map, 'center_changed', () => {
      if (this._settingCenter) return; // setCenter 内部触发，跳过冗余处理
      const c = this.map.getCenter();
      if (c) this._syncCenter = c;
      this._invalidateCoordCache();
      this._scheduleRedraw();
    });
    qq.maps.event.addListener(this.map, 'zoom_changed', () => {
      this._invalidateCoordCache();
      this._scheduleRedraw();
    });
    qq.maps.event.addListener(this.map, 'drag', () => {
      this._scheduleRedraw();
    });
    qq.maps.event.addListener(this.map, 'dragend', () => {
      this._invalidateCoordCache();
      this._scheduleRedraw();
    });

    // 窗口大小变化
    this._resizeHandler = () => {
      this._resizeCanvas();
      this._scheduleRedraw();
    };
    window.addEventListener('resize', this._resizeHandler);

    // 初始化尺寸
    this._resizeCanvas();
    this._scheduleRedraw();

    return this;
  }

  /* ================================================================
   *  坐标 → 像素 转换
   * ================================================================ */

  /**
   * 经纬度 → 容器像素坐标
   * 使用地图投影计算世界坐标，再根据缩放/中心点换算
   */
  /** 清除像素坐标缓存（地图移动/缩放/圆变更时调用） */
  _invalidateCoordCache() {
    this._coordCache.clear();
  }

  _latLngToContainerPoint(latLng) {
    if (!this.map) return null; // destroy 后 rAF 迟到回调防御
    const key = `${latLng.getLat().toFixed(6)},${latLng.getLng().toFixed(6)}`;
    const cached = this._coordCache.get(key);
    const now = performance.now();
    if (cached && now - cached.ts < 100) return { x: cached.x, y: cached.y };

    const proj = this.map.getProjection();
    if (!proj || !this._syncCenter) return null;

    const wp = proj.fromLatLngToPoint(latLng);
    if (!wp || typeof wp.x !== 'number') return null;

    const zoom = this.map.getZoom();
    const cwp = proj.fromLatLngToPoint(this._syncCenter);
    if (!cwp) return null;

    const w = this.canvas.parentElement.offsetWidth;
    const h = this.canvas.parentElement.offsetHeight;
    const scale = Math.pow(2, zoom);

    const result = {
      x: w / 2 + (wp.x - cwp.x) * scale,
      y: h / 2 + (wp.y - cwp.y) * scale
    };
    this._coordCache.set(key, { ...result, ts: now });
    return result;
  }

  /**
   * 地面距离（米）→ 屏幕像素
   * 公式：1px = 156543.03392 * cos(lat) / 2^zoom （米）
   */
  _metersToPixels(meters, latLng) {
    if (meters <= 0) return 0;
    const latKey = latLng.getLat().toFixed(6);
    const cacheKey = `mpp:${latKey}:${this.map.getZoom()}`;
    const cached = this._coordCache.get(cacheKey);
    if (cached) return meters / cached.mpp;

    const zoom = this.map.getZoom();
    const lat = latLng.getLat();
    const mpp = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    this._coordCache.set(cacheKey, { mpp, ts: performance.now() });
    return meters / mpp;
  }

  /* ================================================================
   *  Canvas 尺寸
   * ================================================================ */

  _resizeCanvas() {
    const parent = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = parent.offsetWidth;
    const h = parent.offsetHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    if (this.overlayCanvas) {
      this.overlayCanvas.width = Math.round(w * dpr);
      this.overlayCanvas.height = Math.round(h * dpr);
      this.overlayCanvas.style.width = w + 'px';
      this.overlayCanvas.style.height = h + 'px';
    }
  }

  /* ================================================================
   *  同心圆渲染（核心 — 样式匹配 demo.html）
   * ================================================================ */

  _scheduleRedraw() {
    const minInterval = 1000 / 30;

    if (this._rafId) cancelAnimationFrame(this._rafId);

    this._rafId = requestAnimationFrame(() => {
      const now = performance.now();
      if (now - (this._lastRedrawTime || 0) < minInterval) {
        this._rafId = requestAnimationFrame(() => {
          this._redraw();
          this._lastRedrawTime = performance.now();
          this._rafId = null;
        });
        return;
      }
      this._redraw();
      this._lastRedrawTime = performance.now();
      this._rafId = null;
    });
  }

  /** 仅重绘叠加层（轻量，位置更新时调用） */
  _scheduleRedrawOverlay() {
    if (this._overlayRafId) cancelAnimationFrame(this._overlayRafId);
    this._overlayRafId = requestAnimationFrame(() => {
      this._redrawOverlay();
      this._overlayRafId = null;
    });
  }

  /* ================================================================
   *  同心圆渲染（多圆支持）
   * ================================================================ */

  /**
   * 设置主题（影响 Canvas 颜色适配）
   * @param {'dark'|'light'} theme
   */
  setTheme(theme) {
    this._theme = theme;
    this._scheduleRedraw();
  }

  /**
   * 离屏 Canvas（多圆重叠染色用，懒创建）
   */
  _getOffscreen(w, h) {
    const dpr = window.devicePixelRatio || 1;
    if (!this._offCanvas || this._offCanvas.width !== Math.round(w * dpr) || this._offCanvas.height !== Math.round(h * dpr)) {
      this._offCanvas = document.createElement('canvas');
      this._offCanvas.width = Math.round(w * dpr);
      this._offCanvas.height = Math.round(h * dpr);
    }
    return this._offCanvas;
  }

  /** 仅重绘圆圈层（增删/选中/拖拽/缩放时触发） */
  _redrawCircles() {
    if (!this.map || !this.canvas) return; // destroy 后 rAF 迟到回调防御
    const parent = this.canvas.parentElement;
    if (!parent) return;

    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    const w = parent.offsetWidth;
    const h = parent.offsetHeight;
    if (w === 0 || h === 0) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (this.circles.length) {
      const offCanvas = this._getOffscreen(w, h);
      const offCtx = offCanvas.getContext('2d');
      offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      offCtx.clearRect(0, 0, w, h);

      for (const c of this.circles) {
        this._drawCircleFill(offCtx, c);
      }
      ctx.drawImage(offCanvas, 0, 0, offCanvas.width, offCanvas.height, 0, 0, w, h);

      for (const c of this.circles) {
        this._drawCircleStrokes(ctx, c);
      }
    }

    if (this._remoteCircles.length) {
      for (const c of this._remoteCircles) {
        this._drawRemoteCircle(ctx, c);
      }
    }

    // ── 比例尺 ──
    this._drawScaleBar(ctx, w, h);
  }

  _drawScaleBar(ctx, w, h) {
    if (!this.map) return; // destroy 后 rAF 迟到回调防御
    const zoom = this.map.getZoom();
    if (zoom < 3) return;
    const lat = this._syncCenter ? this._syncCenter.getLat() : 39.9;
    const mpp = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    const targetPx = Math.min(120, w * 0.3);
    let barMeters = Math.round(targetPx * mpp);
    const mag = Math.pow(10, Math.floor(Math.log10(barMeters)));
    const norm = barMeters / mag;
    let nice;
    if (norm < 1.5) nice = 1 * mag;
    else if (norm < 3.5) nice = 2 * mag;
    else if (norm < 7.5) nice = 5 * mag;
    else nice = 10 * mag;
    const barPx = nice / mpp;
    const label = nice >= 1000 ? (nice / 1000).toFixed(1) + ' km' : nice + ' m';

    const x = 12;
    const y = h - 16;
    const clr = this._theme === 'light' ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.65)';
    ctx.strokeStyle = clr;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + barPx, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y + 4);
    ctx.moveTo(x + barPx, y - 4);
    ctx.lineTo(x + barPx, y + 4);
    ctx.stroke();
    ctx.fillStyle = clr;
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, x + barPx / 2, y - 4);
    ctx.textAlign = 'left';
  }

  /** 仅重绘叠加层（预测椭圆、距离标注，位置更新时触发） */
  _redrawOverlay() {
    if (!this.map || !this.overlayCanvas || !this.overlayCtx) return; // destroy 后 rAF 迟到回调防御
    const parent = this.overlayCanvas.parentElement;
    if (!parent) return;

    const dpr = window.devicePixelRatio || 1;
    const ctx = this.overlayCtx;
    const w = parent.offsetWidth;
    const h = parent.offsetHeight;
    if (w === 0 || h === 0) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 叠加层：预测椭圆
    this._drawPlayerPredictions(ctx);

    // 叠加层：圆圈上的距离标注（圆心下方，随位置更新）
    this._drawOverlayLabels(ctx);
  }

  /** 绘制叠加层上的距离标注（从 _drawCircleStrokes 移出，仅位置更新时重绘此层） */
  _drawOverlayLabels(ctx) {
    if (!this._myPos && !this._targetPos) return;
    for (const circle of this.circles) {
      const latLng = new qq.maps.LatLng(circle.center.lat, circle.center.lng);
      const cp = this._latLngToContainerPoint(latLng);
      if (!cp) continue;
      const { x: cx, y: cy } = cp;
      const dotR = circle.id === this.selectedCircleId ? 9 : 6;
      let offsetY = 0;

      // 距对方距离
      if (this._targetPos) {
        const dist = calcDistance(circle.center, this._targetPos);
        const distLabel = formatDistance(dist);
        ctx.font = '500 9px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const dtw = ctx.measureText(distLabel).width;
        const dly = cy + dotR + 4;
        ctx.fillStyle = 'rgba(255, 140, 0, 0.8)';
        ctx.beginPath();
        ctx.roundRect(cx - dtw / 2 - 3, dly - 1, dtw + 6, 14, 3);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(distLabel, cx, dly + 1);
        offsetY = 18;
      }

      // 距我距离
      if (this._myPos) {
        const dist = calcDistance(circle.center, this._myPos);
        const distLabel = formatDistance(dist);
        ctx.font = '500 9px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const dtw = ctx.measureText(distLabel).width;
        const dly = cy + dotR + 4 + offsetY;
        ctx.fillStyle = 'rgba(0, 136, 255, 0.8)';
        ctx.beginPath();
        ctx.roundRect(cx - dtw / 2 - 3, dly - 1, dtw + 6, 14, 3);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(distLabel, cx, dly + 1);
      }
    }
  }

  /** 全量重绘（圆圈+叠加层，增删圆/拖拽/缩放时调用） */
  _redraw() {
    this._redrawCircles();
    this._redrawOverlay();
  }

  /**
   * 根据当前主题返回 Canvas 绘制颜色方案
   */
  _getColors() {
    if (this._theme === 'light') {
      return {
        fillBase:  'rgba(0, 80, 200, 0.08)',
        fillAlt:   'rgba(0, 80, 200, 0.04)',
        strokeInner: 'rgba(0, 60, 150, 0.28)',
        strokeOuter: 'rgba(0, 40, 120, 0.45)',
        dotStroke:   'rgba(0, 60, 150, 0.25)',
        dotFill:     'rgba(0, 50, 140, 0.8)',
        selDotStroke: 'rgba(0, 160, 130, 0.5)',
        selDotFill:   '#00a082',
        selDashStroke: 'rgba(0, 160, 130, 0.55)'
      };
    }
    // dark (default)
    return {
      fillBase:  'rgba(70, 140, 220, 0.12)',
      fillAlt:   'rgba(70, 140, 220, 0.06)',
      strokeInner: 'rgba(15, 50, 120, 0.32)',
      strokeOuter: 'rgba(10, 35, 90, 0.55)',
      dotStroke:   'rgba(15, 50, 120, 0.25)',
      dotFill:     'rgba(15, 50, 120, 0.8)',
      selDotStroke: 'rgba(0, 160, 130, 0.4)',
      selDotFill:   '#00a082',
      selDashStroke: 'rgba(0, 160, 130, 0.5)'
    };
  }

  /**
   * 只画圆的填充区域（离屏 Canvas 用）
   * 重叠区域因为多次 fill 叠加，颜色自然比单个圆深
   */
  _drawCircleFill(ctx, circle) {
    const latLng = new qq.maps.LatLng(circle.center.lat, circle.center.lng);
    const cp = this._latLngToContainerPoint(latLng);
    if (!cp) return;

    const maxR = circle.maxRadius;
    const interval = circle.interval;
    const mp = this._metersToPixels(maxR, latLng);
    const ip = this._metersToPixels(interval, latLng);
    const { x: cx, y: cy } = cp;

    if (mp < CONFIG.MIN_DRAW_PX) return;

    const drawInner = ip >= 2;
    const ringCount = drawInner ? Math.max(1, Math.floor(mp / ip)) : 0;
    const clr = this._getColors();

    // ── 整体底色 ──
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, mp), 0, Math.PI * 2);
    ctx.fillStyle = clr.fillBase;
    ctx.fill();

    // ── 间隔填充（偶数圈加深） ──
    if (drawInner) {
      for (let i = ringCount; i >= 1; i--) {
        const ro = i * ip, ri = (i - 1) * ip;
        if (ro > mp) continue;
        if (i % 2 === 0) {
          ctx.beginPath();
          ctx.arc(cx, cy, Math.max(1, ro), 0, Math.PI * 2);
          ctx.arc(cx, cy, Math.max(0.5, ri), 0, Math.PI * 2, true);
          ctx.fillStyle = clr.fillAlt;
          ctx.fill();
        }
      }
    }
  }

  /**
   * 画圆的描边 + 圆心标记（主 Canvas 用）
   */
  _drawCircleStrokes(ctx, circle) {
    const isSel = circle.id === this.selectedCircleId;
    const latLng = new qq.maps.LatLng(circle.center.lat, circle.center.lng);
    const cp = this._latLngToContainerPoint(latLng);
    if (!cp) return;

    const maxR = circle.maxRadius;
    const interval = circle.interval;
    const mp = this._metersToPixels(maxR, latLng);
    const ip = this._metersToPixels(interval, latLng);
    const { x: cx, y: cy } = cp;

    if (mp < CONFIG.MIN_DRAW_PX) return;

    const drawInner = ip >= 2;
    const ringCount = drawInner ? Math.max(1, Math.floor(mp / ip)) : 0;
    const clr = this._getColors();

    const strokeInner = isSel ? clr.selDotStroke : clr.strokeInner;
    const strokeOuter = isSel ? clr.selDashStroke : clr.strokeOuter;
    const dotStroke = isSel ? clr.selDotStroke : clr.dotStroke;
    const dotFill   = isSel ? clr.selDotFill   : clr.dotFill;

    // ── 内部圈描边 ──
    if (drawInner) {
      ctx.strokeStyle = strokeInner;
      ctx.lineWidth = 1.2;
      for (let j = 1; j <= ringCount; j++) {
        const r = j * ip;
        if (r > mp) break;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // ── 最外圈描边（粗线） ──
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, mp), 0, Math.PI * 2);
    ctx.strokeStyle = strokeOuter;
    ctx.lineWidth = 2.2;
    ctx.stroke();

    // ── 选中态：虚线外框 ──
    if (isSel) {
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1, mp + 5), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0, 160, 130, 0.5)';
      ctx.lineWidth = 1.8;
      ctx.setLineDash([7, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── 圆心标记 ──
    const dotR = isSel ? 9 : 6;
    ctx.beginPath();
    ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
    ctx.strokeStyle = dotStroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, isSel ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = dotFill;
    ctx.fill();

    // ── 圆圈距离标注 ──
    if (mp >= 30) {
      const labelR = mp;
      const labelAngle = -Math.PI / 4; // 右上角 45°
      const lx = cx + labelR * Math.cos(labelAngle);
      const ly = cy + labelR * Math.sin(labelAngle);
      const label = formatDistance(maxR);
      ctx.font = '600 10px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // 文字底色
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = isSel ? 'rgba(0, 160, 130, 0.85)' : 'rgba(15, 50, 120, 0.75)';
      ctx.beginPath();
      ctx.roundRect(lx - tw / 2 - 3, ly - 7, tw + 6, 14, 3);
      ctx.fill();
      // 文字
      ctx.fillStyle = '#fff';
      ctx.fillText(label, lx, ly);
    }
  }

  /**
   * 检测容器坐标附近是否有圆心
   */
  _pickCircle(pt) {
    for (const c of this.circles) {
      const center = new qq.maps.LatLng(c.center.lat, c.center.lng);
      const cp = this._latLngToContainerPoint(center);
      if (!cp) continue;
      const dx = pt.x - cp.x;
      const dy = pt.y - cp.y;
      if (Math.sqrt(dx * dx + dy * dy) < this.PICK_THRESHOLD) {
        return c;
      }
    }
    return null;
  }

  /* ================================================================
   *  公开 API
   * ================================================================ */

  /**
   * 设置/移动中心点标记（仅设标记，不创建圆）
   */
  setCenter(center) {
    this.center = center;
    const latLng = new qq.maps.LatLng(center.lat, center.lng);

    if (this.marker) {
      this.marker.setPosition(latLng);
    } else {
      this.marker = new qq.maps.Marker({
        position: latLng,
        map: this.map,
        draggable: true,
        icon: this._createMarkerIcon()
      });
      // 标记拖拽 → 更新待添加圆的预览位置
      qq.maps.event.addListener(this.marker, 'dragend', (event) => {
        const pos = event.latLng;
        this.center = { lat: pos.lat, lng: pos.lng };
        if (this.onCenterChange) {
          this.onCenterChange(this.center);
        }
      });
    }

    // 同步追踪中心 + 强制重绘（不依赖 getCenter 异步结果）
    this._settingCenter = true;
    this._syncCenter = latLng;
    this.map.setCenter(latLng);
    this._settingCenter = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._redraw();
    this._lastRedrawTime = performance.now();

    if (this.onCenterChange) {
      this.onCenterChange(this.center);
    }
  }

  /**
   * 添加一个同心圆到列表
   * @param {{lat:number,lng:number}} center 中心坐标
   * @param {number} maxRadius 最大半径（米）
   * @returns {number} 新圆的 id
   */
  addCircle(center, maxRadius, color) {
    const id = this._idCounter++;
    this.circles.push({
      id,
      center: { lat: center.lat, lng: center.lng },
      maxRadius,
      interval: CONFIG.CONCENTRIC_INTERVAL,
      name: '',
      color: color || '',
      createdAt: Date.now()
    });
    this._invalidateCoordCache();
    this._scheduleRedraw();
    this._zoomToRadius(maxRadius);
    return id;
  }

  updateCircle(id, fields) {
    const c = this.circles.find(x => x.id === id);
    if (!c) return;
    if (fields.maxRadius != null) c.maxRadius = fields.maxRadius;
    if (fields.name !== undefined) c.name = fields.name;
    if (fields.color !== undefined) c.color = fields.color;
    if (fields.center != null) c.center = { lat: fields.center.lat, lng: fields.center.lng };
    this._invalidateCoordCache();
    this._scheduleRedraw();
  }

  /**
   * 删除指定 id 的圆
   */
  removeCircle(id) {
    this.circles = this.circles.filter(c => c.id !== id);
    if (this.selectedCircleId === id) this.selectedCircleId = null;
    this._invalidateCoordCache();
    this._scheduleRedraw();
  }

  /**
   * 删除所有圆
   */
  clearCircles() {
    this.circles = [];
    this.selectedCircleId = null;
    this._invalidateCoordCache();
    this._scheduleRedraw();
  }

  /**
   * 选中一个圆
   */
  selectCircle(id) {
    this.selectedCircleId = id;
    this._scheduleRedraw();
  }

  /**
   * 获取所有圆
   */
  getCircles() {
    return this.circles;
  }

  /**
   * 设置其他玩家同步过来的圆（多人可见），触发重绘
   * 远程数据来自公共 Broker，必须先校验：非法半径/间隔会让 arc(NaN) 中断整个渲染
   */
  setRemoteCircles(circles) {
    const src = Array.isArray(circles) ? circles : [];
    this._remoteCircles = src.filter(c => (
      c && c.center
      && Number.isFinite(c.center.lat) && Number.isFinite(c.center.lng)
      && Number.isFinite(c.maxRadius) && c.maxRadius > 0 && c.maxRadius <= CONFIG.MAX_RADIUS
    ));
    this._scheduleRedraw();
  }

  /**
   * 其他玩家圆的渲染：作者色 + 虚线同心圆 + 昵称标注（与本地蓝圆区分）
   */
  _drawRemoteCircle(ctx, circle) {
    const maxR = circle.maxRadius;
    let interval = circle.interval;
    // 远程数据不可信：非法值直接跳过该圆，避免 NaN 入 arc 抛错中断整个渲染循环
    if (!Number.isFinite(maxR) || maxR <= 0 || maxR > CONFIG.MAX_RADIUS) return;
    if (!Number.isFinite(interval) || interval <= 0) interval = CONFIG.CONCENTRIC_INTERVAL;
    const latLng = new qq.maps.LatLng(circle.center.lat, circle.center.lng);
    const cp = this._latLngToContainerPoint(latLng);
    if (!cp) return;
    const mp = this._metersToPixels(maxR, latLng);
    const ip = this._metersToPixels(interval, latLng);
    const { x: cx, y: cy } = cp;
    if (mp < CONFIG.MIN_DRAW_PX) return;
    const color = circle.color || '#FF8C00';
    const drawInner = ip >= 2;
    // 防 ringCount 爆炸：极小 interval（如 5m）+ 高 zoom 下可达数千圈，渲染卡死
    const ringCount = drawInner ? Math.min(200, Math.max(1, Math.floor(mp / ip))) : 0;
    ctx.save();
    // 轻量填充（使用队伍颜色）
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, mp), 0, Math.PI * 2);
    ctx.fillStyle = this._hexToRgba(color, 0.08);
    ctx.fill();
    // 同心内圈（虚线）
    if (drawInner) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      for (let j = 1; j <= ringCount; j++) {
        const r = j * ip;
        if (r > mp) break;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // 外圈（虚线，醒目）
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, mp), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // 圆心
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    // 作者昵称标注（圆心上方）
    const label = circle.authorName || circle.name || '';
    if (label) {
      ctx.font = '600 11px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const lw = ctx.measureText(label).width;
      const ly = cy - mp - 4;
      ctx.fillStyle = this._hexToRgba(color, 0.85);
      ctx.beginPath();
      ctx.roundRect(cx - lw / 2 - 4, ly - 14, lw + 8, 15, 4);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(label, cx, ly);
    }
    ctx.restore();
  }

  /**
   * 将 #RRGGBB 转为 rgba（带透明度）
   */
  _hexToRgba(hex, alpha) {
    let h = (hex || '#888').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16) || 0;
    const g = parseInt(h.slice(2, 4), 16) || 0;
    const b = parseInt(h.slice(4, 6), 16) || 0;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /**
   * 获取选中的圆
   */
  getSelectedCircle() {
    if (this.selectedCircleId === null) return null;
    return this.circles.find(c => c.id === this.selectedCircleId) || null;
  }

  /**
   * 更新圆的半径
   */
  updateCircleRadius(id, radius) {
    const c = this.circles.find(c => c.id === id);
    if (c) {
      c.maxRadius = radius;
      this._scheduleRedraw();
    }
  }

  /**
   * 设置交互模式
   */
  setMode(mode) {
    this.mode = mode;
  }

  /**
   * 跳转到位置（不改变标记）
   */
  flyTo(center, zoom) {
    if (!this.map) return;
    this.map.panTo(new qq.maps.LatLng(center.lat, center.lng));
    this.map.setZoom(zoom || CONFIG.LOCATION_ZOOM);
  }

  /**
   * WGS84 → GCJ-02 坐标转换（GPS 纠偏）
   * 浏览器 Geolocation 返回的是 WGS84，腾讯地图使用 GCJ-02
   *
   * 优先使用腾讯地图官方 convertor 库（同步回调），
   * 不可用时降级到手写纠偏算法。
   * @param {{lat:number, lng:number}} point
   * @returns {Promise<{lat:number, lng:number}>}
   */
  async wgs84ToGcj02(point) {
    // 尝试官方 convertor 库
    if (typeof qq !== 'undefined' && qq.maps && qq.maps.convertor) {
      try {
        const result = await new Promise((resolve, reject) => {
          // 2秒超时兜底——防止 API 不回调导致 Promise 挂起阻塞串行队列
          const timer = setTimeout(() => {
            reject(new Error('convertor API timeout'));
          }, 2000);
          const latLng = new qq.maps.LatLng(point.lat, point.lng);
          qq.maps.convertor.translate([latLng], 1, (res) => {
            clearTimeout(timer);
            if (res && res[0] && typeof res[0].lat === 'number' && typeof res[0].lng === 'number') {
              resolve({ lat: res[0].lat, lng: res[0].lng });
            } else {
              reject(new Error('unexpected convertor response'));
            }
          });
        });
        return result;
      } catch (e) {
        console.warn('wgs84ToGcj02: convertor API 失败，降级到手写算法', e.message);
      }
    }
    // 降级：手写纠偏算法
    return this._wgs84Gcj02(point);
  }

  /**
   * 手写 WGS84 → GCJ-02 纠偏算法（降级备用）
   * @param {{lat:number, lng:number}} point
   * @returns {{lat:number, lng:number}}
   */
  _wgs84Gcj02(point) {
    const A = 6378245.0;
    const EE = 0.00669342162296594323;

    const outOfChina = (lat, lng) =>
      lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;

    const transformLat = (x, y) => {
      let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
      ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
      ret += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
      ret += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
      return ret;
    };

    const transformLng = (x, y) => {
      let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
      ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
      ret += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
      ret += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
      return ret;
    };

    const { lat, lng } = point;
    if (outOfChina(lat, lng)) return point;

    const dlat = transformLat(lng - 105, lat - 35);
    const dlng = transformLng(lng - 105, lat - 35);
    const radLat = lat / 180 * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    const dlatFinal = (dlat * 180) / ((A * (1 - EE)) / (magic * sqrtMagic) * Math.PI);
    const dlngFinal = (dlng * 180) / (A / sqrtMagic * Math.cos(radLat) * Math.PI);

    return { lat: lat + dlatFinal, lng: lng + dlngFinal };
  }

  /**
   * 自适应缩放
   */
  _zoomToRadius(radius) {
    if (!this.map) return;
    const entry = CONFIG.ZOOM_MAP.find(e => radius <= e.maxRadius);
    if (entry) this.map.setZoom(entry.zoom);
  }

  /**
   * 创建自定义标记图标（渐变色目标圆点）
   */
  _createMarkerIcon() {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">',
      '  <defs>',
      '    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">',
      '      <stop offset="0%" stop-color="#00D4AA"/>',
      '      <stop offset="100%" stop-color="#00A3FF"/>',
      '    </linearGradient>',
      '    <filter id="s" x="-20%" y="-20%" width="140%" height="140%">',
      '      <feDropShadow dx="0" dy="1" stdDeviation="3" flood-opacity="0.45"/>',
      '    </filter>',
      '  </defs>',
      '  <circle cx="16" cy="16" r="14" fill="none" stroke="#00D4AA" stroke-width="1.2" opacity="0.18"/>',
      '  <circle cx="16" cy="16" r="9" fill="url(#g)" stroke="#fff" stroke-width="2.5" filter="url(#s)"/>',
      '  <circle cx="16" cy="16" r="3" fill="#fff" opacity="0.95"/>',
      '</svg>'
    ].join('\n');

    const dataUri = 'data:image/svg+xml;base64,' + btoa(svg);

    return new qq.maps.MarkerImage(
      dataUri,
      new qq.maps.Size(32, 32),
      new qq.maps.Point(0, 0),
      new qq.maps.Point(16, 16),
      new qq.maps.Size(32, 32)
    );
  }

  /**
   * 创建我的位置标记图标（蓝色实心圆点，与圆心标识区分）
   * @param {number} [heading] 可选朝向角度（正北顺时针），传入则叠加方向箭头
   */
  _createLocationIcon(heading) {
    const arrow = (heading != null && !isNaN(heading))
      ? `<polygon points="20,2 23,10 17,10" fill="#00A3FF" transform="rotate(${heading}, 20, 20)"/>`
      : '';
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">',
      '  <defs>',
      '    <filter id="s" x="-20%" y="-20%" width="140%" height="140%">',
      '      <feDropShadow dx="0" dy="1" stdDeviation="3" flood-opacity="0.5"/>',
      '    </filter>',
      '  </defs>',
      '  <circle cx="20" cy="20" r="17" fill="none" stroke="#0088FF" stroke-width="1.5" opacity="0.12"/>',
      '  <circle cx="20" cy="20" r="13" fill="none" stroke="#0088FF" stroke-width="2" opacity="0.28"/>',
      '  <circle cx="20" cy="20" r="7" fill="#0088FF" stroke="#fff" stroke-width="2.5" filter="url(#s)"/>',
      '  <circle cx="20" cy="20" r="2.5" fill="#fff" opacity="0.95"/>',
      arrow,
      '</svg>'
    ].join('\n');

    const dataUri = 'data:image/svg+xml;base64,' + btoa(svg);

    return new qq.maps.MarkerImage(
      dataUri,
      new qq.maps.Size(40, 40),
      new qq.maps.Point(0, 0),
      new qq.maps.Point(20, 20),
      new qq.maps.Size(40, 40)
    );
  }

  /**
   * 在地图上显示我的位置标记
   * 位置更新走 rAF 插值动画（500ms ease-out 平滑滑动），消除定位跳变
   * 位移 >200m（重定位恢复）或首次创建时直接跳
   * @param {{lat:number, lng:number}} center
   * @param {number} [accuracy] 定位精度（米），传入则同时绘制精度环 (#17)
   * @param {number} [heading] 朝向角度（正北顺时针），传入则更新方向箭头
   */
  setLocation(center, accuracy, heading) {
    const target = { lat: center.lat, lng: center.lng };
    const latLng = new qq.maps.LatLng(target.lat, target.lng);

    if (this.locationMarker) {
      if (heading != null && !isNaN(heading)) {
        this.locationMarker.setIcon(this._createLocationIcon(heading));
      } else {
        this.locationMarker.setIcon(this._createLocationIcon());
      }
      // 平滑移动：位移过大（重定位恢复）直接跳，否则 rAF 插值
      const cur = this.locationMarker.getPosition();
      const jumpDist = calcDistance(
        { lat: cur.lat, lng: cur.lng },
        target
      );
      if (jumpDist > 200) {
        this._stopLocationAnim();
        this.locationMarker.setPosition(latLng);
      } else {
        this._animateLocationTo(target);
      }
    } else {
      this.locationMarker = new qq.maps.Marker({
        position: latLng,
        map: this.map,
        draggable: false,
        icon: this._createLocationIcon(heading)
      });
    }

    // #17 更新精度环（跟随动画终点）
    this._updateAccuracyCircle(latLng, accuracy);
  }

  /**
   * rAF 插值动画：500ms 内从 marker 当前位置平滑滑动到目标位置（60fps）
   * 只插值不跳变，视觉连续移动（丝滑化核心）
   * @param {{lat:number, lng:number}} target 目标经纬度
   */
  _animateLocationTo(target) {
    const cur = this.locationMarker.getPosition();
    const anim = {
      from: { lat: cur.lat, lng: cur.lng },
      to: target,
      start: performance.now(),
      rafId: 0
    };
    this._locAnim = anim;
    const step = (now) => {
      if (this._locAnim !== anim) return; // 已被新动画替换或停止
      const t = Math.min(1, (now - anim.start) / 500);
      const e = 1 - Math.pow(1 - t, 3); // ease-out 缓动
      const lat = anim.from.lat + (anim.to.lat - anim.from.lat) * e;
      const lng = anim.from.lng + (anim.to.lng - anim.from.lng) * e;
      this.locationMarker.setPosition(new qq.maps.LatLng(lat, lng));
      if (t >= 1) {
        this._stopLocationAnim();
      } else {
        anim.rafId = requestAnimationFrame(step);
      }
    };
    anim.rafId = requestAnimationFrame(step);
  }

  /**
   * 停止定位 marker 插值动画（清除 rAF 循环）
   */
  _stopLocationAnim() {
    const anim = this._locAnim;
    if (anim) {
      if (anim.rafId) cancelAnimationFrame(anim.rafId);
      this._locAnim = null;
    }
  }

  /**
   * 绘制/更新定位精度环
   * #17 — 在地图上用半透明圆表示定位可信范围
   * @param {qq.maps.LatLng} latLng 中心坐标
   * @param {number} [accuracy] 精度（米），不传或 NaN 则清除精度环
   */
  _updateAccuracyCircle(latLng, accuracy) {
    if (!this.map) return;
    if (accuracy == null || isNaN(accuracy) || accuracy <= 0) {
      if (this.accuracyCircle) {
        this.accuracyCircle.setMap(null);
        this.accuracyCircle = null;
      }
      return;
    }

    if (this.accuracyCircle) {
      this.accuracyCircle.setCenter(latLng);
      this.accuracyCircle.setRadius(accuracy);
    } else {
      this.accuracyCircle = new qq.maps.Circle({
        map: this.map,
        center: latLng,
        radius: accuracy,
        fillColor: new qq.maps.Color(0, 136, 255, 0.08),
        strokeColor: new qq.maps.Color(0, 136, 255, 0.15),
        strokeWeight: 1,
        clickable: false,
        editable: false
      });
    }
  }

  // ----- 速度→色阶映射 (轨迹按速度着色，支持深色/浅色主题) -----

  /** 速度色阶表：深色模式 (霓虹暗色) */
  _speedColorDark = {
    walk:  { r: 0,   g: 229, b: 204, a: 0.70 },  // #00E5CC 霓虹青
    bike:  { r: 255, g: 215, b: 0,   a: 0.75 },  // #FFD700 霓虹金
    bus:   { r: 255, g: 140, b: 0,   a: 0.80 },  // #FF8C00 霓虹橘
    car:   { r: 255, g: 94,  b: 51,  a: 0.82 },  // #FF5E33 霓虹橙红
    train: { r: 255, g: 51,  b: 102, a: 0.85 },  // #FF3366 霓虹粉红
    hsr:   { r: 191, g: 64,  b: 255, a: 0.90 },  // #BF40FF 霓虹紫
    sct:   { r: 94,  g: 92,  b: 230, a: 0.92 },  // #5E5CE6 霓虹蓝紫
  };

  /** 速度色阶表：浅色模式 (苹果风格) */
  _speedColorLight = {
    walk:  { r: 52,  g: 199, b: 89,  a: 0.65 },  // #34C759 苹果绿
    bike:  { r: 255, g: 149, b: 0,   a: 0.70 },  // #FF9500 苹果橙
    bus:   { r: 255, g: 59,  b: 48,  a: 0.75 },  // #FF3B30 苹果红
    car:   { r: 255, g: 45,  b: 85,  a: 0.78 },  // #FF2D55 苹果粉红
    train: { r: 175, g: 82,  b: 222, a: 0.80 },  // #AF52DE 苹果紫
    hsr:   { r: 88,  g: 86,  b: 214, a: 0.85 },  // #5856D6 苹果蓝紫
    sct:   { r: 0,   g: 122, b: 255, a: 0.88 },  // #007AFF 苹果蓝
  };

  /** 根据当前主题返回对应色阶表 */
  get _speedColorMap() {
    return document.documentElement.getAttribute('data-theme') === 'light'
      ? this._speedColorLight
      : this._speedColorDark;
  }

  /**
   * 取速度对应的色阶键名
   * @param {number|null|undefined} speed m/s
   * @returns {string} walk|bike|bus|car|train|hsr|sct
   */
  _speedColorKey(speed) {
    if (speed == null || speed < 2.78) return 'walk';  // <10 km/h   步行/停留
    if (speed < 5.56) return 'bike';                    // 10-20      骑行
    if (speed < 16.67) return 'bus';                    // 20-60      公交
    if (speed < 33.33) return 'car';                    // 60-120     汽车
    if (speed < 55.56) return 'train';                  // 120-200    动车
    if (speed < 97.22) return 'hsr';                    // 200-350    高铁
    return 'sct';                                       // >350       超高速
  }

  /**
   * 计算某一段轨迹的参考速度（取终点的 speed，若无则取起点）
   */
  _segmentSpeed(p0, p1) {
    return p1.speed != null ? p1.speed : (p0.speed != null ? p0.speed : 0);
  }

  /**
   * 更新历史轨迹线（按速度分段着色）
   * 增量模式：轨迹点只追加时，仅从上次渲染位置起构建新段，避免每点全量重建数百条 Polyline
   * @param {Array<{lat:number,lng:number,speed?:number}>} positions GCJ-02 坐标数组
   */
  setTrail(positions) {
    if (!this.map) return;
    if (!Array.isArray(positions) || positions.length < 2) {
      this.clearTrail();
      return;
    }

    // 数据回缩（清除/重置/环形截断）→ 全量重建
    if (positions.length < (this._lastTrailCount || 0)) {
      this.clearTrail();
    }

    const from = Math.max(1, this._lastTrailCount || 0);
    if (from >= positions.length) {
      // 容量上限环形截断检测：长度不变但内容已旋转 → 全量重建
      if (positions.length > 0 && this._lastTrailCount > 0 && this._lastTrailAnchor) {
        const first = positions[0];
        if (first.lat !== this._lastTrailAnchor.lat || first.lng !== this._lastTrailAnchor.lng) {
          this.clearTrail();
        } else {
          return;
        }
      } else {
        return;
      }
    }

    let batchPath = [];       // 当前颜色段的路径
    let batchKey = null;      // 当前颜色段对应的 speed key

    // 增量起点：用已渲染的最后一点作锚，保证衔接段颜色连续
    if ((this._lastTrailCount || 0) > 0) {
      const anchor = positions[this._lastTrailCount - 1];
      batchPath.push(new qq.maps.LatLng(anchor.lat, anchor.lng));
      batchKey = this._speedColorKey(this._segmentSpeed(anchor, positions[this._lastTrailCount]));
    }

    for (let i = from; i < positions.length; i++) {
      const p0 = positions[i - 1];
      const p1 = positions[i];
      const key = this._speedColorKey(this._segmentSpeed(p0, p1));

      if (batchPath.length === 0) {
        batchPath.push(new qq.maps.LatLng(p0.lat, p0.lng));
        batchPath.push(new qq.maps.LatLng(p1.lat, p1.lng));
        batchKey = key;
      } else if (key === batchKey) {
        batchPath.push(new qq.maps.LatLng(p1.lat, p1.lng));
      } else {
        // 锚点单点（增量首段）时 batchPath 可能只有 1 点，长度不足不 flush，直接重开新段
        if (batchPath.length >= 2) {
          this._flushSegment(batchPath, this._speedColorMap[batchKey]);
        }
        batchPath = [
          new qq.maps.LatLng(p0.lat, p0.lng),
          new qq.maps.LatLng(p1.lat, p1.lng)
        ];
        batchKey = key;
      }
    }
    if (batchPath.length >= 2) {
      this._flushSegment(batchPath, this._speedColorMap[batchKey]);
    }
    this._lastTrailCount = positions.length;
    if (positions.length > 0) {
      this._lastTrailAnchor = positions[0];
    }
  }

  /** 创建一条轨迹 Polyline 并存入数组 */
  _flushSegment(path, clr) {
    const poly = new qq.maps.Polyline({
      path,
      strokeColor: new qq.maps.Color(clr.r, clr.g, clr.b, clr.a),
      strokeWeight: 3.5,
      map: this.map
    });
    this.trailPolylines.push(poly);
  }

  /**
   * 清除历史轨迹线
   */
  clearTrail() {
    for (const poly of this.trailPolylines) {
      poly.setMap(null);
    }
    this.trailPolylines = [];
    this._lastTrailCount = 0; // 增量渲染基数必须一并归零
  }

  // ----- 主题切换渐进重绘 -----

  /**
   * 主题切换后渐进重绘轨迹（从可视范围向两端扩展，60s 内完成）
   * @param {Array} positions - 完整轨迹点数组
   */
  refreshTrailColors(positions) {
    if (!this.map || !Array.isArray(positions) || positions.length < 2) return;
    // 取消正在进行的重绘
    if (this._themeRefreshRaf) {
      cancelAnimationFrame(this._themeRefreshRaf);
      this._themeRefreshRaf = null;
    }
    // 找到可视范围中心点索引
    const centerIdx = this._findVisibleCenterIndex(positions);
    // 清除旧轨迹
    this.clearTrail();
    // 初始化渐进渲染队列
    this._themeRefreshQueue = {
      positions,
      left: centerIdx,
      right: centerIdx + 1,
      startTime: Date.now(),
      timeBudget: 60000,
      done: false,
    };
    this._processThemeRefreshBatch();
  }

  /**
   * 找到轨迹中位于地图可视范围中心附近的点索引
   */
  _findVisibleCenterIndex(positions) {
    if (!this.map) return Math.floor(positions.length / 2);
    try {
      const bounds = this.map.getBounds();
      if (!bounds) return Math.floor(positions.length / 2);
      const ne = bounds.getNorthEast();
      const sw = bounds.getSouthWest();
      const centerLat = (ne.lat + sw.lat) / 2;
      const centerLng = (ne.lng + sw.lng) / 2;
      let bestIdx = 0;
      let bestDist = Infinity;
      // 每隔一段采样，避免 75k 点全遍历
      const step = Math.max(1, Math.floor(positions.length / 500));
      for (let i = 0; i < positions.length; i += step) {
        const p = positions[i];
        const d = (p.lat - centerLat) ** 2 + (p.lng - centerLng) ** 2;
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      // 精细搜索采样点附近
      const searchStart = Math.max(0, bestIdx - step);
      const searchEnd = Math.min(positions.length - 1, bestIdx + step);
      for (let i = searchStart; i <= searchEnd; i++) {
        const p = positions[i];
        const d = (p.lat - centerLat) ** 2 + (p.lng - centerLng) ** 2;
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      return bestIdx;
    } catch (_) {
      return Math.floor(positions.length / 2);
    }
  }

  /**
   * 分帧处理渐进重绘批次
   */
  _processThemeRefreshBatch() {
    const q = this._themeRefreshQueue;
    if (!q || q.done) return;

    const elapsed = Date.now() - q.startTime;
    const totalPoints = q.positions.length;

    // 计算剩余时间和点数，动态调整批大小
    const remainingTime = Math.max(1, q.timeBudget - elapsed);
    const remainingPoints = (q.left > 0 ? q.left : 0) + (totalPoints - q.right);
    if (remainingPoints <= 0 || elapsed >= q.timeBudget) {
      // 时间到或已完成，快速渲染剩余部分
      this._renderRemainingTrail(q);
      this._finishThemeRefresh(q);
      return;
    }

    // 动态批大小：剩余点数 / (剩余时间 × 60fps)，至少 10 点
    const batchSize = Math.max(10, Math.ceil(remainingPoints / (remainingTime / 16)));

    // 向左扩展（to 传 q.left+1 确保包含 centerIdx-1 → centerIdx 段）
    const leftEnd = Math.max(0, q.left - batchSize);
    if (leftEnd < q.left) {
      this._renderTrailRange(q.positions, leftEnd, q.left + 1, q);
      q.left = leftEnd;
    }

    // 向右扩展
    const rightEnd = Math.min(totalPoints, q.right + batchSize);
    if (rightEnd > q.right) {
      this._renderTrailRange(q.positions, q.right, rightEnd, q);
      q.right = rightEnd;
    }

    // 检查是否完成
    if (q.left <= 0 && q.right >= totalPoints) {
      this._finishThemeRefresh(q);
      return;
    }

    // 继续下一帧
    this._themeRefreshRaf = requestAnimationFrame(() => this._processThemeRefreshBatch());
  }

  /**
   * 渲染指定范围的轨迹点（按速度分色）
   */
  _renderTrailRange(positions, from, to, q) {
    if (from >= to) return;
    // 确保 from 至少为1（需要 i-1）
    const start = Math.max(1, from);
    const end = Math.min(positions.length, to);

    let batchPath = [];
    let batchKey = null;

    // 如果从中间开始，需要锚点保证颜色连续
    if (start > 0) {
      const anchor = positions[start - 1];
      batchPath.push(new qq.maps.LatLng(anchor.lat, anchor.lng));
      batchKey = this._speedColorKey(this._segmentSpeed(anchor, positions[start]));
    }

    for (let i = start; i < end; i++) {
      const p0 = positions[i - 1];
      const p1 = positions[i];
      const key = this._speedColorKey(this._segmentSpeed(p0, p1));

      if (batchPath.length === 0) {
        batchPath.push(new qq.maps.LatLng(p0.lat, p0.lng));
        batchPath.push(new qq.maps.LatLng(p1.lat, p1.lng));
        batchKey = key;
      } else if (key === batchKey) {
        batchPath.push(new qq.maps.LatLng(p1.lat, p1.lng));
      } else {
        if (batchPath.length >= 2) {
          this._flushSegment(batchPath, this._speedColorMap[batchKey]);
        }
        batchPath = [
          new qq.maps.LatLng(p0.lat, p0.lng),
          new qq.maps.LatLng(p1.lat, p1.lng)
        ];
        batchKey = key;
      }
    }
    if (batchPath.length >= 2) {
      this._flushSegment(batchPath, this._speedColorMap[batchKey]);
    }
  }

  /**
   * 快速渲染剩余未完成部分
   */
  _renderRemainingTrail(q) {
    if (q.left > 0) {
      this._renderTrailRange(q.positions, 0, q.left + 1, q);
    }
    if (q.right < q.positions.length) {
      this._renderTrailRange(q.positions, q.right, q.positions.length, q);
    }
  }

  /**
   * 完成主题刷新
   */
  _finishThemeRefresh(q) {
    this._themeRefreshQueue = null;
    this._themeRefreshRaf = null;
    this._lastTrailCount = q.positions.length;
    if (q.positions.length > 0) {
      this._lastTrailAnchor = q.positions[0];
    }
  }

  // ----- 对方位置标记 -----

  /**
   * 创建对方位置标记图标（橙色实心圆点）
   */
  _createTargetIcon() {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">',
      '  <defs>',
      '    <filter id="ts" x="-20%" y="-20%" width="140%" height="140%">',
      '      <feDropShadow dx="0" dy="1" stdDeviation="3" flood-opacity="0.5"/>',
      '    </filter>',
      '  </defs>',
      '  <circle cx="20" cy="20" r="17" fill="none" stroke="#FF8C00" stroke-width="1.5" opacity="0.2"/>',
      '  <circle cx="20" cy="20" r="13" fill="none" stroke="#FF8C00" stroke-width="2" opacity="0.35"/>',
      '  <circle cx="20" cy="20" r="7" fill="#FF8C00" stroke="#fff" stroke-width="2.5" filter="url(#ts)"/>',
      '  <circle cx="20" cy="20" r="2.5" fill="#fff" opacity="0.95"/>',
      '</svg>'
    ].join('\n');
    const dataUri = 'data:image/svg+xml;base64,' + btoa(svg);
    return new qq.maps.MarkerImage(
      dataUri,
      new qq.maps.Size(40, 40),
      new qq.maps.Point(0, 0),
      new qq.maps.Point(20, 20),
      new qq.maps.Size(40, 40)
    );
  }

  /**
   * 设置我方位置（Canvas 标注用）
   */
  setMyPos(pos) {
    if (!this.map) return;
    this._myPos = pos;
    // 仅重绘叠加层（预测/标注），不触发圆圈全量重绘
    this._scheduleRedrawOverlay();
  }

  /**
   * 设置/更新对方位置标记
   * @param {{lat:number, lng:number}|null} center 坐标，null 则清除
   */
  setTarget(center, range) {
    if (!this.map) return;
    if (!center) {
      this._targetPos = null;
      if (this.targetMarker) {
        this.targetMarker.setMap(null);
        this.targetMarker = null;
      }
      this.setTargetRange(0);
      this._scheduleRedrawOverlay();
      return;
    }
    this._targetPos = center;
    const latLng = new qq.maps.LatLng(center.lat, center.lng);
    if (this.targetMarker) {
      this.targetMarker.setPosition(latLng);
    } else {
      this.targetMarker = new qq.maps.Marker({
        position: latLng,
        map: this.map,
        draggable: false,
        icon: this._createTargetIcon()
      });
    }
    if (range > 0) this.setTargetRange(range);
    this._scheduleRedrawOverlay();
  }

  /**
   * 设置/更新对方位置精度范围圈
   */
  setTargetRange(range) {
    if (!this.map) return;
    if (!this._targetPos || range <= 0) {
      if (this.targetCircle) {
        this.targetCircle.setMap(null);
        this.targetCircle = null;
      }
      return;
    }
    const center = new qq.maps.LatLng(this._targetPos.lat, this._targetPos.lng);
    if (this.targetCircle) {
      this.targetCircle.setCenter(center);
      this.targetCircle.setRadius(range);
    } else {
      this.targetCircle = new qq.maps.Circle({
        map: this.map,
        center,
        radius: range,
        fillColor: new qq.maps.Color(255, 140, 0, 0.08),
        strokeColor: new qq.maps.Color(255, 140, 0, 0.4),
        strokeWeight: 1.5,
        strokeDashArray: [6, 4],
        clickable: false,
        editable: false
      });
    }
  }

  // ----- 多人位置标记 -----

  /**
   * 创建玩家标记图标（圆点 + 名称标签）
   */
  _createPlayerIcon(color, name, opacity = 1, labelOverride) {
    // 远程来源的 color 可能非法（公共 Broker 攻击面）：校验格式，非法回退灰色，
    // 防引号/尖括号破坏 SVG 结构（属性注入）
    const safeColor = /^#[0-9a-fA-F]{3,8}$/.test(color || '') ? color : '#888';
    const label = (labelOverride || (name || '?').charAt(0).toUpperCase()).replace(/[<>&"']/g, '');
    // 与"我的位置 / 标记对方"一致的同心圆点样式，颜色用队伍色；中心保留昵称首字便于辨认
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44">',
      '  <defs>',
      '    <filter id="ps" x="-20%" y="-20%" width="140%" height="140%">',
      '      <feDropShadow dx="0" dy="1" stdDeviation="3" flood-opacity="0.5"/>',
      '    </filter>',
      '  </defs>',
      `  <circle cx="22" cy="22" r="20" fill="none" stroke="${safeColor}" stroke-width="1.5" opacity="${(0.12 * opacity).toFixed(3)}"/>`,
      `  <circle cx="22" cy="22" r="15" fill="none" stroke="${safeColor}" stroke-width="2" opacity="${(0.28 * opacity).toFixed(3)}"/>`,
      `  <circle cx="22" cy="22" r="9" fill="${safeColor}" stroke="#fff" stroke-width="2.5" filter="url(#ps)" opacity="${opacity}"/>`,
      `  <text x="22" y="22" text-anchor="middle" dominant-baseline="central" fill="#fff" font-size="11" font-weight="bold" font-family="Arial" opacity="${opacity}">${label}</text>`,
      '</svg>'
    ].join('\n');
    // btoa 仅支持 Latin1；昵称首字可能为中文，先按 UTF-8 转 Latin1 字节再编码
    const bytes = new TextEncoder().encode(svg);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const dataUri = 'data:image/svg+xml;base64,' + btoa(bin);
    return new qq.maps.MarkerImage(
      dataUri,
      new qq.maps.Size(44, 44),
      new qq.maps.Point(0, 0),
      new qq.maps.Point(22, 22),
      new qq.maps.Size(44, 44)
    );
  }

  /**
   * 更新/添加玩家标记
   * @param {string} id 设备ID
   * @param {number} lat
   * @param {number} lng
   * @param {string} name 昵称
   * @param {string} color 主题色
   */
  updatePlayerMarker(id, lat, lng, name, color, opacity = 1, accuracy, labelOverride) {
    if (!this.map) return;
    const latLng = new qq.maps.LatLng(lat, lng);
    // 图标内容取决于 color/name/label/opacity 四元组：只比较 opacity 会导致改名/换队色后标记不刷新
    const iconKey = `${color}|${name}|${labelOverride || ''}|${opacity}`;
    if (this.playerMarkers[id]) {
      this.playerMarkers[id].setPosition(latLng);
      if (iconKey !== this.playerMarkers[id]._lastIconKey) {
        this.playerMarkers[id].setIcon(this._createPlayerIcon(color, name, opacity, labelOverride));
        this.playerMarkers[id]._lastIconKey = iconKey;
      }
    } else {
      this.playerMarkers[id] = new qq.maps.Marker({
        position: latLng,
        map: this.map,
        draggable: false,
        icon: this._createPlayerIcon(color, name, opacity, labelOverride),
        title: name || '玩家',
      });
      this.playerMarkers[id]._lastIconKey = iconKey;
    }
    this._updatePlayerAccuracyCircle(id, latLng, accuracy, color);
  }

  _hexToMapColor(hex, alpha) {
    const safe = hex || '#888888';
    const r = parseInt(safe.slice(1, 3), 16) || 0;
    const g = parseInt(safe.slice(3, 5), 16) || 0;
    const b = parseInt(safe.slice(5, 7), 16) || 0;
    return new qq.maps.Color(r, g, b, alpha);
  }

  _updatePlayerAccuracyCircle(id, latLng, accuracy, color) {
    if (accuracy == null || isNaN(accuracy) || accuracy <= 0) {
      if (this.playerAccuracyCircles[id]) {
        this.playerAccuracyCircles[id].setMap(null);
        delete this.playerAccuracyCircles[id];
      }
      return;
    }
    if (this.playerAccuracyCircles[id]) {
      this.playerAccuracyCircles[id].setCenter(latLng);
      this.playerAccuracyCircles[id].setRadius(accuracy);
    } else {
      this.playerAccuracyCircles[id] = new qq.maps.Circle({
        map: this.map,
        center: latLng,
        radius: accuracy,
        fillColor: this._hexToMapColor(color, 0.08),
        strokeColor: this._hexToMapColor(color, 0.15),
        strokeWeight: 1,
        clickable: false,
        editable: false,
      });
    }
  }

  /**
   * 移除玩家标记
   */
  removePlayerMarker(id) {
    if (this.playerMarkers[id]) {
      this.playerMarkers[id].setMap(null);
      delete this.playerMarkers[id];
    }
    if (this.playerAccuracyCircles[id]) {
      this.playerAccuracyCircles[id].setMap(null);
      delete this.playerAccuracyCircles[id];
    }
  }

  /**
   * 清除所有玩家标记
   */
  clearPlayerMarkers() {
    Object.keys(this.playerMarkers).forEach((id) => {
      this.playerMarkers[id].setMap(null);
    });
    this.playerMarkers = {};
    Object.keys(this.playerAccuracyCircles).forEach((id) => {
      this.playerAccuracyCircles[id].setMap(null);
    });
    this.playerAccuracyCircles = {};
  }

  // ================================================================
  //  位置预测椭圆
  // ================================================================

  /**
   * 设置/更新玩家预测数据
   */
  setPlayerPrediction(id, lat, lng, bearing, speed, acc) {
    if (!CONFIG.ENABLE_PREDICTION) return;
    this._playerPredictions[id] = { lat, lng, bearing, speed, acc, ts: Date.now() };
    this._scheduleRedrawOverlay();
  }

  /**
   * 移除玩家预测
   */
  removePlayerPrediction(id) {
    delete this._playerPredictions[id];
    this._scheduleRedrawOverlay();
  }

  /**
   * 清除所有预测
   */
  clearPlayerPredictions() {
    this._playerPredictions = {};
    this._scheduleRedrawOverlay();
  }

  /**
   * 沿朝向投影位置
   * @param {number} lat 起始纬度
   * @param {number} lng 起始经度
   * @param {number} bearing 朝向角度（正北顺时针）
   * @param {number} distance 投影距离（米）
   * @returns {{lat:number, lng:number}}
   */
  _projectPosition(lat, lng, bearing, distance) {
    const bearingRad = bearing * Math.PI / 180;
    const d = distance;
    const latRad = lat * Math.PI / 180;
    const dx = d * Math.sin(bearingRad);
    const dy = d * Math.cos(bearingRad);
    const newLat = lat + dy / 111320;
    const newLng = lng + dx / (111320 * Math.cos(latRad));
    return { lat: newLat, lng: newLng };
  }

  /**
   * 绘制玩家位置预测椭圆（Canvas 叠加层）
   * 每个玩家画两个椭圆：10s 预测 + 30s 预测
   */
  _drawPlayerPredictions(ctx) {
    if (!CONFIG.ENABLE_PREDICTION) return;
    const now = Date.now();
    const MAX_AGE = 15000; // 15s 后预测失效

    Object.entries(this._playerPredictions).forEach(([id, pred]) => {
      if (now - pred.ts > MAX_AGE) {
        delete this._playerPredictions[id];
        return;
      }
      if (pred.speed == null || pred.speed < 0.3 || pred.bearing == null) return;

      const bearingRad = pred.bearing * Math.PI / 180;
      const latLng = new qq.maps.LatLng(pred.lat, pred.lng);

      // 两个预测时刻：10s 和 30s
      const times = [10, 30];
      const opacities = [0.2, 0.08];
      const strokeOpacities = [0.35, 0.15];

      times.forEach((t, idx) => {
        const distance = pred.speed * t;
        const proj = this._projectPosition(pred.lat, pred.lng, pred.bearing, distance);
        const projLatLng = new qq.maps.LatLng(proj.lat, proj.lng);
        const cp = this._latLngToContainerPoint(projLatLng);
        if (!cp) return;

        // 不确定性：精度 + 速度 × 时间系数（越远不确定性越大）
        const uncertainty = pred.acc + pred.speed * t * 0.8;
        const semiMinorPx = Math.max(4, this._metersToPixels(uncertainty, projLatLng));
        const semiMajorPx = semiMinorPx * 2.5;

        ctx.save();
        ctx.translate(cp.x, cp.y);
        ctx.rotate(bearingRad);

        ctx.beginPath();
        ctx.ellipse(0, 0, semiMajorPx, semiMinorPx, 0, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 200, 80, ${opacities[idx]})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(255, 200, 80, ${strokeOpacities[idx]})`;
        ctx.lineWidth = 1;
        ctx.stroke();

        // 标注预测时间
        ctx.rotate(-bearingRad); // 恢复旋转以画文字
        ctx.fillStyle = `rgba(255, 255, 255, ${opacities[idx] + 0.1})`;
        ctx.font = '9px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${t}s`, 0, -semiMajorPx - 2);
        ctx.restore();
      });

      // 方向指示器：从当前位置到预测位置的连线
      const curCp = this._latLngToContainerPoint(latLng);
      if (!curCp) return;
      const proj30 = this._projectPosition(pred.lat, pred.lng, pred.bearing, pred.speed * 30);
      const proj30LatLng = new qq.maps.LatLng(proj30.lat, proj30.lng);
      const proj30Cp = this._latLngToContainerPoint(proj30LatLng);
      if (!proj30Cp) return;

      ctx.beginPath();
      ctx.moveTo(curCp.x, curCp.y);
      ctx.lineTo(proj30Cp.x, proj30Cp.y);
      ctx.strokeStyle = 'rgba(255, 200, 80, 0.12)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    });
  }

  destroy() {
    this.clearTrail();
    this.clearPlayerPredictions();

    // 取消待执行渲染
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this._overlayRafId) {
      cancelAnimationFrame(this._overlayRafId);
      this._overlayRafId = null;
    }

    // 移除窗口 resize 监听
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }

    // 清理精度环
    if (this.accuracyCircle) {
      this.accuracyCircle.setMap(null);
      this.accuracyCircle = null;
    }

    // 移除腾讯地图所有事件监听（click, longpress, center_changed, zoom_changed, drag, dragend 等）
    if (this.map) {
      qq.maps.event.clearInstanceListeners(this.map);
    }

    // 清理标记
    if (this.marker) {
      this.marker.setMap(null);
      this.marker = null;
    }
    if (this.locationMarker) {
      this._stopLocationAnim(); // 先停插值动画，避免 rAF 悬空
      this.locationMarker.setMap(null);
      this.locationMarker = null;
    }
    if (this.targetMarker) {
      this.targetMarker.setMap(null);
      this.targetMarker = null;
    }
    if (this.targetCircle) {
      this.targetCircle.setMap(null);
      this.targetCircle = null;
    }

    this.clearPlayerMarkers();
    this._myPos = null;
    this._targetPos = null;
    this._offCanvas = null;
    this.canvas = null;
    this.ctx = null;
    this._syncCenter = null;
    this.map = null;
    this.center = null;
  }
}
