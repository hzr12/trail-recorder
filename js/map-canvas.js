/**
 * 途刻 TraceCraft - 地图管理器（Canvas 覆盖层版本）
 * ============================================
 * 腾讯地图 + Canvas 覆盖层 + 三层降级
 * 所有可视化元素通过 Canvas 绘制，不依赖 qq.maps 叠加对象
 */

// roundRect polyfill
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

/**
 * FallbackProjection - 手写 Web Mercator 投影（Layer 3 专用）
 * 用于腾讯地图 SDK 完全不可用时的定位/轨迹标记
 */
class FallbackProjection {
  constructor(center, zoom) {
    this._center = center || { lat: 39.908823, lng: 116.397470 };
    this._zoom = zoom || 12;
    this._centerWorld = this._latLngToWorld(this._center);
  }

  setCenter(c) { this._center = c; this._centerWorld = this._latLngToWorld(c); }
  setZoom(z) { this._zoom = z; }
  getZoom() { return this._zoom; }

  fromLatLngToPoint(latLng) {
    return this._latLngToWorld(latLng);
  }

  worldToLatLng(wp) {
    const lng = (wp.x - 0.5) * 360;
    const n = Math.PI - 2 * Math.PI * wp.y;
    const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lat, lng };
  }

  containerPointToLatLng(cp, containerW, containerH) {
    const scale = Math.pow(2, this._zoom);
    const wx = this._centerWorld.x + (cp.x - containerW / 2) / (256 * scale);
    const wy = this._centerWorld.y + (cp.y - containerH / 2) / (256 * scale);
    return this.worldToLatLng({ x: wx, y: wy });
  }

  latLngToContainerPoint(latLng, containerW, containerH) {
    const wp = this._latLngToWorld(latLng);
    const scale = Math.pow(2, this._zoom);
    const dx = (wp.x - this._centerWorld.x) * 256 * scale;
    const dy = (wp.y - this._centerWorld.y) * 256 * scale;
    return { x: containerW / 2 + dx, y: containerH / 2 + dy };
  }

  _latLngToWorld(ll) {
    const x = ll.lng / 360 + 0.5;
    const y = 0.5 - Math.log(Math.tan(Math.PI / 4 + (ll.lat * Math.PI / 180) / 2)) / (2 * Math.PI);
    return { x, y };
  }
}

class MapManager {
  constructor() {
    this.map = null;
    this._locAnim = null;
    this.canvas = null;
    this.ctx = null;
    this.overlayCanvas = null;
    this.overlayCtx = null;
    this._syncCenter = null;
    this._coordCache = new Map();

    this._locPos = null;
    this._locAccuracy = null;
    this._locHeading = null;
    this._accRadius = 0;

    this._trailSegments = [];
    this._trailKeyPoints = [];
    this._rtKeyPoints = {};

    this.onCenterChange = null;
    this._theme = 'dark';
    this._rafId = null;
    this._overlayRafId = null;
    this._fallback = null;

    this._decimateCache = new Map();
    this._zoomDecimateTimer = null;
    this._lastTrailInput = null;
    this._lastTrailCount = 0;
    this._lastTrailAnchor = null;

    this._activeTrailPlayer = null;
  }

  /**
   * 初始化地图 + Canvas 叠加层（三层降级）
   */
  init(containerId, center, zoom) {
    const mapEl = document.getElementById(containerId);

    this.canvas = document.getElementById('circle-canvas');
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.overlayCanvas = document.getElementById('overlay-canvas');
    this.overlayCtx = this.overlayCanvas ? this.overlayCanvas.getContext('2d') : null;

    const qqAvailable = typeof qq !== 'undefined' && qq.maps && typeof qq.maps.Map === 'function';

    if (qqAvailable) {
      // Layer 1/2: QQ Maps SDK 可用
      this.map = new qq.maps.Map(mapEl, {
        center: new qq.maps.LatLng(center.lat, center.lng),
        zoom: zoom || CONFIG.DEFAULT_ZOOM,
        mapTypeId: qq.maps.MapTypeId.ROADMAP
      });

      this._syncCenter = new qq.maps.LatLng(center.lat, center.lng);

      qq.maps.event.addListener(this.map, 'center_changed', () => {
        if (this._settingCenter) return;
        const c = this.map.getCenter();
        if (c) this._syncCenter = c;
        this._invalidateCoordCache();
        this._overlayRedraw();
      });
      qq.maps.event.addListener(this.map, 'zoom_changed', () => {
        this._invalidateCoordCache();
        this._overlayRedraw();
        clearTimeout(this._zoomDecimateTimer);
        this._zoomDecimateTimer = setTimeout(() => {
          this._zoomDecimateTimer = null;
          if (this._lastTrailInput && this._lastTrailInput.length > 2000) {
            const limit = this._getZoomLimit();
            const positions = this._lastTrailInput;
            if (positions.length > limit) {
              const decimated = this._decimateTrail(positions, limit);
              if (decimated !== positions) {
                this._lastTrailInput = decimated;
                this.clearTrail();
                this.setTrail(decimated);
              }
            }
          }
        }, 300);
      });

      // Layer 2 探测：SDK 加载但瓦片不可达 → 纯色背景 + 保留交互
      setTimeout(() => { this._probeTiles(center, zoom); }, 8000);
    } else {
      // Layer 3: SDK 完全不可用 → 手写投影 + 纯色背景 + 自建交互
      mapEl.style.background = '#0f1419';
      this._fallback = new FallbackProjection(center, zoom || CONFIG.DEFAULT_ZOOM);
      this._setupFallbackInteraction(mapEl, center, zoom);
    }

    this._resizeHandler = () => { this._resizeCanvas(); };
    window.addEventListener('resize', this._resizeHandler);
    this._resizeCanvas();
    return this;
  }

  /**
   * Layer 2 探测：SDK 加载但瓦片可能不可达
   */
  _probeTiles(center, zoom) {
    if (this._fallback) return;
    const probe = new Image();
    const z = zoom || CONFIG.DEFAULT_ZOOM;
    const yTms = (1 << z) - 1 - 16;
    probe.src = `https://rt0.map.gtimg.com/realtimerender?z=${z}&x=16&y=${yTms}&type=vector&style=0`;
    probe.onload = () => {
      if (this.map) {
        const mapEl = document.getElementById('map');
        if (mapEl) mapEl.style.background = '';
      }
    };
    probe.onerror = () => {
      if (this.map) {
        const mapEl = document.getElementById('map');
        if (mapEl) mapEl.style.background = '#e8ecf0';
        const isLight = document.documentElement.getAttribute('data-theme') === 'light';
        if (isLight) mapEl.style.background = '#e8ecf0';
      }
    };
  }

  /**
   * Layer 3 交互：拖拽平移 + 滚轮缩放
   */
  _setupFallbackInteraction(mapEl, center, zoom) {
    if (!this._fallback) return;
    let dragging = false, lastX = 0, lastY = 0;

    mapEl.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      mapEl.setPointerCapture(e.pointerId);
    });
    mapEl.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const w = mapEl.offsetWidth, h = mapEl.offsetHeight;
      const cp = this._fallback.containerPointToLatLng({ x: w / 2 - dx, y: h / 2 - dy }, w, h);
      this._fallback.setCenter(cp);
      this._invalidateCoordCache();
      this._overlayRedraw();
    });
    mapEl.addEventListener('pointerup', () => { dragging = false; });
    mapEl.addEventListener('pointercancel', () => { dragging = false; });

    mapEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -1 : 1;
      const newZoom = Math.max(1, Math.min(20, this._fallback.getZoom() + delta));
      this._fallback.setZoom(newZoom);
      this._invalidateCoordCache();
      this._overlayRedraw();
    }, { passive: false });
  }

  _invalidateCoordCache() { this._coordCache.clear(); }

  /**
   * 统一坐标转换：接受 qq.maps.LatLng 或 {lat,lng} 对象
   */
  _latLngToContainerPoint(latLng) {
    const lat = typeof latLng.getLat === 'function' ? latLng.getLat() : latLng.lat;
    const lng = typeof latLng.getLng === 'function' ? latLng.getLng() : latLng.lng;

    if (this._fallback) {
      const el = this.canvas ? this.canvas.parentElement : null;
      if (!el) return null;
      return this._fallback.latLngToContainerPoint({ lat, lng }, el.offsetWidth, el.offsetHeight);
    }

    if (!this.map) return null;
    const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
    const cached = this._coordCache.get(key);
    const now = performance.now();
    if (cached && now - cached.ts < 100) return { x: cached.x, y: cached.y };

    const latLngObj = new qq.maps.LatLng(lat, lng);
    const proj = this.map.getProjection();
    if (!proj || !this._syncCenter) return null;
    const wp = proj.fromLatLngToPoint(latLngObj);
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

  _metersToPixels(meters, latLng) {
    if (meters <= 0) return 0;
    const lat = typeof latLng.getLat === 'function' ? latLng.getLat() : latLng.lat;
    const zoom = this._fallback ? this._fallback.getZoom() : (this.map ? this.map.getZoom() : 12);
    const mpp = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    return meters / mpp;
  }

  _resizeCanvas() {
    const parent = this.canvas ? this.canvas.parentElement : null;
    if (!parent) return;
    const dpr = window.devicePixelRatio || 1;
    const w = parent.offsetWidth;
    const h = parent.offsetHeight;
    if (this.canvas) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
    }
    if (this.overlayCanvas) {
      this.overlayCanvas.width = Math.round(w * dpr);
      this.overlayCanvas.height = Math.round(h * dpr);
      this.overlayCanvas.style.width = w + 'px';
      this.overlayCanvas.style.height = h + 'px';
    }
  }

  setTheme(theme) { this._theme = theme; }

  /* ================================================================
   *  公开 API
   * ================================================================ */

  flyTo(center, zoom) {
    if (this._fallback) {
      this._fallback.setCenter(center);
      this._fallback.setZoom(zoom || CONFIG.LOCATION_ZOOM);
      this._invalidateCoordCache();
      this._overlayRedraw();
      return;
    }
    if (!this.map) return;
    this.map.panTo(new qq.maps.LatLng(center.lat, center.lng));
    this.map.setZoom(zoom || CONFIG.LOCATION_ZOOM);
  }

  async wgs84ToGcj02(point) {
    if (typeof qq !== 'undefined' && qq.maps && qq.maps.convertor) {
      try {
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { reject(new Error('convertor API timeout')); }, 2000);
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
        Logger.warn('wgs84ToGcj02: convertor API 失败，降级到手写算法', e.message);
      }
    }
    return this._wgs84Gcj02(point);
  }

  wgs84ToGcj02Sync(point) { return this._wgs84Gcj02(point); }

  _wgs84Gcj02(point) {
    const A = 6378245.0;
    const EE = 0.00669342162296594323;
    const outOfChina = (lat, lng) => lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
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

  batchWgs84ToGcj02(points) {
    if (!points || !points.length) return [];
    return points.map(p => this._wgs84Gcj02(p));
  }

  /* ================================================================
   *  速度→色阶映射
   * ================================================================ */

  _speedColorDark = {
    walk:  { r: 0,   g: 229, b: 204, a: 0.70 },
    bike:  { r: 255, g: 215, b: 0,   a: 0.75 },
    bus:   { r: 255, g: 140, b: 0,   a: 0.80 },
    car:   { r: 255, g: 94,  b: 51,  a: 0.82 },
    train: { r: 255, g: 51,  b: 102, a: 0.85 },
    hsr:   { r: 191, g: 64,  b: 255, a: 0.90 },
    sct:   { r: 94,  g: 92,  b: 230, a: 0.92 },
  };

  _speedColorLight = {
    walk:  { r: 52,  g: 199, b: 89,  a: 0.65 },
    bike:  { r: 255, g: 149, b: 0,   a: 0.70 },
    bus:   { r: 255, g: 59,  b: 48,  a: 0.75 },
    car:   { r: 255, g: 45,  b: 85,  a: 0.78 },
    train: { r: 175, g: 82,  b: 222, a: 0.80 },
    hsr:   { r: 88,  g: 86,  b: 214, a: 0.85 },
    sct:   { r: 0,   g: 122, b: 255, a: 0.88 },
  };

  get _speedColorMap() {
    return document.documentElement.getAttribute('data-theme') === 'light'
      ? this._speedColorLight
      : this._speedColorDark;
  }

  _speedColorKey(speed) {
    if (typeof TrailAnalysis !== 'undefined' && TrailAnalysis.speedLevel) {
      return TrailAnalysis.speedLevel(speed);
    }
    if (speed == null) return 'walk';
    const levels = CONFIG.TRAIL_SPEED_LEVELS || [];
    for (const lv of levels) {
      if (speed < lv.max) return lv.mode;
    }
    return 'sct';
  }

  _segmentSpeed(p0, p1) {
    return p1.speed != null ? p1.speed : (p0.speed != null ? p0.speed : 0);
  }

  _hexToRgb(hex) {
    const m = String(hex || '#888888').replace('#', '');
    const v = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
    return {
      r: parseInt(v.substr(0, 2), 16) || 0,
      g: parseInt(v.substr(2, 2), 16) || 0,
      b: parseInt(v.substr(4, 2), 16) || 0,
      a: 1
    };
  }

  _getZoomLimit() {
    let zoom = 15;
    if (this._fallback) {
      zoom = this._fallback.getZoom();
    } else if (this.map) {
      try { const z = this.map.getZoom(); if (typeof z === 'number') zoom = z; } catch (_) {}
    }
    return Math.round(Math.min(
      CONFIG.TRAIL_DECIMATE_MAX_ZOOM_LIMIT,
      Math.max(CONFIG.TRAIL_DECIMATE_MIN_ZOOM_LIMIT,
        CONFIG.TRAIL_DECIMATE_MIN_ZOOM_LIMIT * Math.pow(2, zoom - CONFIG.TRAIL_DECIMATE_ZOOM_BASE))
      )
    );
  }

  _decimateTrail(positions, maxPoints) {
    const limit = maxPoints || this._getZoomLimit();
    const n = positions.length;
    if (n <= limit) return positions;
    const cached = this._decimateCache.get(positions);
    if (cached && cached.limit === limit) return cached.points;
    const step = Math.ceil(n / limit);
    const out = [];
    for (let i = 0; i < n; i += step) out.push(positions[i]);
    if (out[out.length - 1] !== positions[n - 1]) out.push(positions[n - 1]);
    this._decimateCache.set(positions, { limit, points: out });
    if (this._decimateCache.size > 3) {
      const oldest = this._decimateCache.keys().next().value;
      this._decimateCache.delete(oldest);
    }
    return out;
  }

  _cleanSpikes(positions) {
    if (!Array.isArray(positions) || positions.length < 4) return positions;
    if (typeof TrailAnalysis === 'undefined' || typeof TrailAnalysis.filterOutliers !== 'function') return positions;
    try {
      const cleaned = TrailAnalysis.filterOutliers(positions);
      return cleaned && cleaned.length >= 2 ? cleaned : positions;
    } catch (e) { return positions; }
  }

  /* ================================================================
   *  Canvas 覆盖层：定位标记（替代 qq.maps.Marker）
   * ================================================================ */

  setLocation(center, accuracy, heading) {
    this._locPos = { lat: center.lat, lng: center.lng };
    this._locAccuracy = accuracy;
    this._locHeading = heading;
    this._overlayRedraw();
  }

  /* ================================================================
   *  Canvas 覆盖层：精度圈（替代 qq.maps.Circle）
   * ================================================================ */

  _drawAccuracyCircle(ctx) {
    if (!this._locPos || this._locAccuracy == null || this._locAccuracy <= 0) return;
    const center = this._latLngToContainerPoint(this._locPos);
    if (!center) return;
    const r = this._metersToPixels(this._locAccuracy, this._locPos);
    if (r <= 0) return;

    ctx.strokeStyle = 'rgba(0, 136, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(0, 136, 255, 0.08)';
    ctx.fill();
  }

  /* ================================================================
   *  Canvas 覆盖层：定位标记（替代 qq.maps.Marker）
   * ================================================================ */

  _drawLocationOnCanvas(ctx) {
    if (!this._locPos) return;
    const p = this._latLngToContainerPoint(this._locPos);
    if (!p) return;

    const heading = this._locHeading;
    // 外圈
    ctx.strokeStyle = 'rgba(0, 136, 255, 0.12)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(p.x, p.y, 17, 0, Math.PI * 2); ctx.stroke();
    // 中圈
    ctx.strokeStyle = 'rgba(0, 136, 255, 0.28)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.x, p.y, 13, 0, Math.PI * 2); ctx.stroke();
    // 实心蓝点
    ctx.fillStyle = '#0088FF';
    ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fill();
    // 白边
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.stroke();
    // 白心
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill();
    // 箭头
    if (heading != null && !isNaN(heading)) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(heading * Math.PI / 180);
      ctx.fillStyle = '#00A3FF';
      ctx.beginPath();
      ctx.moveTo(0, -18);
      ctx.lineTo(3, -10);
      ctx.lineTo(-3, -10);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  /* ================================================================
   *  Canvas 覆盖层：轨迹线（替代 qq.maps.Polyline）
   * ================================================================ */

  _drawTrailOnCanvas(ctx) {
    for (const seg of this._trailSegments) {
      const c = seg.color;
      ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${c.a})`;
      ctx.lineWidth = 3.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      const p0 = this._latLngToContainerPoint(seg.path[0]);
      if (!p0) continue;
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < seg.path.length; i++) {
        const pt = this._latLngToContainerPoint(seg.path[i]);
        if (pt) ctx.lineTo(pt.x, pt.y);
      }
      ctx.stroke();
    }
  }

  /* ================================================================
   *  Canvas 覆盖层：关键点标记（替代 qq.maps.Marker）
   * ================================================================ */

  _drawKeyPointsOnCanvas(ctx) {
    const color = { start: '#34C759', end: '#FF453A', maxSpeed: '#FF9500' };
    for (const kp of this._trailKeyPoints) {
      const p = this._latLngToContainerPoint(kp);
      if (!p) continue;
      const c = color[kp.type] || '#00A3FF';
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.stroke();
    }
  }

  /* ================================================================
   *  Canvas 覆盖层：实时关键点标记
   * ================================================================ */

  _drawRtKeyPointsOnCanvas(ctx) {
    const color = { start: '#34C759', end: '#FF453A', maxSpeed: '#FF9500' };
    for (const type of Object.keys(this._rtKeyPoints)) {
      const kp = this._rtKeyPoints[type];
      if (!kp) continue;
      const p = this._latLngToContainerPoint(kp);
      if (!p) continue;
      const c = color[kp.type] || '#00A3FF';
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.stroke();
    }
  }

  /* ================================================================
   *  Canvas 覆盖层：统一重绘
   * ================================================================ */

  _overlayRedraw() {
    if (!this.overlayCanvas || !this.overlayCtx) return;
    if (this._overlayRafId) return;
    this._overlayRafId = requestAnimationFrame(() => {
      this._overlayRafId = null;
      this._doOverlayRedraw();
    });
  }

  _doOverlayRedraw() {
    const ctx = this.overlayCtx;
    const dpr = window.devicePixelRatio || 1;
    const w = this.overlayCanvas.width;
    const h = this.overlayCanvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.scale(dpr, dpr);

    this._drawTrailOnCanvas(ctx);
    this._drawKeyPointsOnCanvas(ctx);
    this._drawRtKeyPointsOnCanvas(ctx);
    this._drawAccuracyCircle(ctx);
    this._drawLocationOnCanvas(ctx);

    if (this._activeTrailPlayer && typeof this._activeTrailPlayer.drawOnCanvas === 'function') {
      this._activeTrailPlayer.drawOnCanvas(ctx, this);
    }

    ctx.restore();
  }

  /* ================================================================
   *  轨迹管理
   * ================================================================ */

  _subdivideSegment(p0, p1) {
    const dist = calcDistance(p0, p1);
    if (dist < 10) return [p1];
    const steps = Math.min(10, Math.max(2, Math.round(dist / 10)));
    const result = [];
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      result.push({ lat: p0.lat + (p1.lat - p0.lat) * t, lng: p0.lng + (p1.lng - p0.lng) * t });
    }
    return result;
  }

  /**
   * 将一段轨迹加入 _trailSegments（替代 _flushSegment 创建 qq.maps.Polyline）
   */
  _flushSegment(path, clr) {
    if (!clr || typeof clr.r !== 'number') clr = { r: 0, g: 212, b: 170, a: 0.85 };
    const flatPath = [];
    for (let i = 0; i < path.length; i++) {
      const pt = path[i];
      flatPath.push({ lat: typeof pt.getLat === 'function' ? pt.getLat() : pt.lat, lng: typeof pt.getLng === 'function' ? pt.getLng() : pt.lng });
    }
    this._trailSegments.push({ path: flatPath, color: clr });
  }

  setTrail(positions, opts) {
    if (!Array.isArray(positions) || positions.length < 2) {
      this.clearTrail();
      return;
    }
    const o = opts || {};
    let lossSet = null;
    if (o.signalLoss && o.signalLoss.segments) {
      lossSet = new Set();
      for (const s of o.signalLoss.segments) {
        for (let i = s.startIdx; i <= s.endIdx; i++) lossSet.add(i);
      }
    }
    const colorMap = Object.assign({}, this._speedColorMap, { __loss__: this._hexToRgb(CONFIG.SIGNAL_LOSS_GREY) });

    const incremental = positions === this._lastTrailInput;
    if (!incremental) {
      positions = this._cleanSpikes(positions);
      const limit = this._getZoomLimit();
      if (positions.length > limit) positions = this._decimateTrail(positions, limit);
    }

    if (incremental && this._trailSegments.length > 400) {
      const limit = this._getZoomLimit();
      const decimated = this._decimateTrail(positions, limit);
      if (decimated !== positions) {
        this._lastTrailInput = decimated;
        this.clearTrail();
        positions = decimated;
      }
    }

    if (positions !== this._lastTrailInput) {
      this._lastTrailInput = positions;
      this.clearTrail();
    } else if (positions.length < (this._lastTrailCount || 0)) {
      this.clearTrail();
    }

    const from = Math.max(1, this._lastTrailCount || 0);
    if (from >= positions.length) {
      if (positions.length > 0 && this._lastTrailCount > 0 && this._lastTrailAnchor) {
        const first = positions[0];
        if (first.lat !== this._lastTrailAnchor.lat || first.lng !== this._lastTrailAnchor.lng) {
          this.clearTrail();
        } else {
          this._overlayRedraw();
          return;
        }
      } else {
        this._overlayRedraw();
        return;
      }
    }

    let batchPath = [];
    let batchKey = null;

    if ((this._lastTrailCount || 0) > 0) {
      const anchor = positions[this._lastTrailCount - 1];
      batchPath.push({ lat: anchor.lat, lng: anchor.lng });
      batchKey = this._speedColorKey(this._segmentSpeed(anchor, positions[this._lastTrailCount]));
    }

    for (let i = from; i < positions.length; i++) {
      const p0 = positions[i - 1];
      const p1 = positions[i];
      const key = lossSet && lossSet.has(i) ? '__loss__' : this._speedColorKey(this._segmentSpeed(p0, p1));

      if (batchPath.length === 0) {
        batchPath.push({ lat: p0.lat, lng: p0.lng });
        batchPath.push({ lat: p1.lat, lng: p1.lng });
        batchKey = key;
      } else if (key === batchKey) {
        const interpolated = this._subdivideSegment(p0, p1);
        for (const pt of interpolated) batchPath.push(pt);
      } else {
        if (batchPath.length >= 2) this._flushSegment(batchPath, colorMap[batchKey]);
        const interpolated = this._subdivideSegment(p0, p1);
        batchPath = [{ lat: p0.lat, lng: p0.lng }];
        for (const pt of interpolated) batchPath.push(pt);
        batchKey = key;
      }
    }
    if (batchPath.length >= 2) this._flushSegment(batchPath, colorMap[batchKey]);

    this._lastTrailCount = positions.length;
    if (positions.length > 0) this._lastTrailAnchor = positions[0];
    this._overlayRedraw();
  }

  clearTrail() {
    this._trailSegments = [];
    this._lastTrailCount = 0;
    this._overlayRedraw();
  }

  /* ================================================================
   *  轨迹关键点标记
   * ================================================================ */

  /**
   * 在地图上标出关键点（替代 qq.maps.Marker + MarkerImage）
   */
  setTrailMarkers(keyPoints) {
    this.clearTrailMarkers();
    if (!keyPoints) return;

    const kpList = [];
    if (keyPoints.start) kpList.push(keyPoints.start);
    if (keyPoints.end) kpList.push(keyPoints.end);
    if (keyPoints.maxSpeed) kpList.push(keyPoints.maxSpeed);

    for (const kp of kpList) {
      if (!kp || !Number.isFinite(kp.lat) || !Number.isFinite(kp.lng)) continue;
      this._trailKeyPoints.push({ lat: kp.lat, lng: kp.lng, type: kp.type });
    }
    this._overlayRedraw();
  }

  clearTrailMarkers() {
    this._trailKeyPoints = [];
    this.clearRealtimeKeyPoints();
    this._overlayRedraw();
  }

  /* ================================================================
   *  实时关键点图层
   * ================================================================ */

  setRealtimeKeyPoints(keyPoints) {
    if (!keyPoints) return;
    if (this._kpEnabled === false) return;
    this._kpEnabled = true;

    const defs = [
      { type: 'start', kp: keyPoints.start },
      { type: 'end', kp: keyPoints.end },
      { type: 'maxSpeed', kp: keyPoints.maxSpeed }
    ];

    for (const { type, kp } of defs) {
      if (!kp || !Number.isFinite(kp.lat) || !Number.isFinite(kp.lng)) continue;
      this._rtKeyPoints[type] = { lat: kp.lat, lng: kp.lng, type };
    }
    this._overlayRedraw();
  }

  clearRealtimeKeyPoints() {
    this._rtKeyPoints = {};
    this._kpEnabled = false;
    this._overlayRedraw();
  }

  refreshTrailColors(positions) {
    if (!Array.isArray(positions) || positions.length < 2) return;
    this.clearTrail();
    const limit = CONFIG.TRAIL_DECIMATE_MAX_ZOOM_LIMIT;
    if (positions.length > limit) positions = this._decimateTrail(positions, limit);
    this.setTrail(positions);
  }

  /* ================================================================
   *  缩略图/分享卡片（纯 Canvas 绘制，不依赖 qq.maps）
   * ================================================================ */

  async _drawTrailThumbnail(canvas, positions, opts) {
    if (!positions || positions.length < 2) return canvas;
    const o = opts || {};
    const lossSet = (o.signalLoss && o.signalLoss.segments)
      ? (() => { const s = new Set(); for (const seg of o.signalLoss.segments) for (let i = seg.startIdx; i <= seg.endIdx; i++) s.add(i); return s; })()
      : null;
    if (!lossSet && positions.length > CONFIG.THUMB_DECIMATE_MAX_POINTS) {
      positions = this._decimateTrail(positions, CONFIG.THUMB_DECIMATE_MAX_POINTS);
    }
    const W = canvas.width;
    const H = canvas.height;
    const ctx = canvas.getContext('2d');

    const hasStats = o.stats && (o.stats.distance != null || o.stats.duration != null || o.stats.points != null);
    const statsH = hasStats ? 44 : 0;
    const padX = 40;
    const padTop = o.title ? 56 : 30;
    const padBottom = 30 + statsH;
    const padY = Math.max(padTop, padBottom);

    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const bg = o.background || (isLight ? '#f7f9fb' : '#0f1419');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const worldPts = positions.map((p) => {
      const wp = { x: p.lng / 360 + 0.5, y: 0.5 - Math.log(Math.tan(Math.PI / 4 + (p.lat * Math.PI / 180) / 2)) / (2 * Math.PI) };
      if (wp.x < minX) minX = wp.x; if (wp.y < minY) minY = wp.y;
      if (wp.x > maxX) maxX = wp.x; if (wp.y > maxY) maxY = wp.y;
      return wp;
    });

    const worldW = Math.max(1e-9, maxX - minX);
    const worldH = Math.max(1e-9, maxY - minY);
    const scaleX = (W - 2 * padX) / worldW;
    const scaleY = (H - 2 * padY) / worldH;
    const scale = Math.min(scaleX, scaleY);
    const drawW = worldW * scale;
    const drawH = worldH * scale;
    const offX = (W - drawW) / 2 - minX * scale;
    const offY = (H - drawH) / 2 - minY * scale;
    const toXY = (wp) => ({ x: wp.x * scale + offX, y: wp.y * scale + offY });

    if (o.map !== false) {
      try { await this._drawThumbnailTiles(ctx, { padX, padY, W, H, scale, offX, offY }); } catch (e) {}
    }

    const colorMap = Object.assign({}, this._speedColorMap, { __loss__: this._hexToRgb(CONFIG.SIGNAL_LOSS_GREY) });
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let i = 1; i < worldPts.length; i++) {
      const p0 = worldPts[i - 1]; const p1 = worldPts[i];
      const key = lossSet && lossSet.has(i) ? '__loss__' : this._speedColorKey(this._segmentSpeed(positions[i - 1], positions[i]));
      const c = colorMap[key] || { r: 0, g: 200, b: 160, a: 0.8 };
      const a = toXY(p0); const b = toXY(p1);
      ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${c.a})`;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    const start = toXY(worldPts[0]); const end = toXY(worldPts[worldPts.length - 1]);
    ctx.fillStyle = '#34C759'; ctx.beginPath(); ctx.arc(start.x, start.y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#FF453A'; ctx.beginPath(); ctx.arc(end.x, end.y, 5, 0, Math.PI * 2); ctx.fill();

    if (o.title) {
      ctx.fillStyle = isLight ? '#1c1c1e' : '#e6e6e6';
      ctx.font = '600 20px -apple-system, "PingFang SC", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(o.title, padX, padTop / 2 + 6);
    }

    if (hasStats) {
      const statsY = H - statsH;
      ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(24, statsY); ctx.lineTo(W - 24, statsY); ctx.stroke();
      ctx.fillStyle = isLight ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.65)';
      ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
      ctx.textBaseline = 'middle';
      const parts = [];
      if (o.stats.distance != null) parts.push(`距离 ${formatDistance(o.stats.distance)}`);
      if (o.stats.duration != null && o.stats.duration > 0) parts.push(`时长 ${formatDurationShort(o.stats.duration)}`);
      if (o.stats.points != null) parts.push(`${o.stats.points} 点`);
      if (parts.length) ctx.fillText(parts.join('  ·  '), 40, statsY + statsH / 2);
    }
    return canvas;
  }

  async _drawThumbnailTiles(ctx, geo) {
    const { padX, padY, W, H, scale, offX, offY } = geo;
    const padBottom = geo.padBottom != null ? geo.padBottom : padY;
    const areaHpx = H - padY - padBottom;
    const areaLeft = (padX - offX) / scale;
    const areaRight = (W - padX - offX) / scale;
    const areaTop = (padY - offY) / scale;
    const areaBottom = (H - padBottom - offY) / scale;
    const areaW = Math.max(1e-9, areaRight - areaLeft);
    let z = Math.round(Math.log2((W - 2 * padX) / (256 * areaW)));
    z = Math.min(18, Math.max(3, z));
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    let range = null;
    for (; z >= 3; z--) {
      const n = 1 << z;
      const x0 = clamp(Math.floor(areaLeft * n), 0, n - 1);
      const x1 = clamp(Math.floor(areaRight * n), 0, n - 1);
      const y0 = clamp(Math.floor(areaTop * n), 0, n - 1);
      const y1 = clamp(Math.floor(areaBottom * n), 0, n - 1);
      range = { z, x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
      if (range.count <= 100) break;
    }
    if (!range) return false;
    const jobs = [];
    for (let tx = range.x0; tx <= range.x1; tx++) {
      for (let ty = range.y0; ty <= range.y1; ty++) {
        jobs.push(this._loadMapTile(range.z, tx, ty));
      }
    }
    const results = await Promise.allSettled(jobs);
    if (!results.every((r) => r.status === 'fulfilled')) return false;
    const imgs = results.map((r) => r.value);
    const n = 1 << range.z;
    const tilePx = scale / n;
    ctx.save();
    ctx.beginPath(); ctx.rect(padX, padY, W - 2 * padX, areaHpx); ctx.clip();
    let i = 0;
    for (let tx = range.x0; tx <= range.x1; tx++) {
      for (let ty = range.y0; ty <= range.y1; ty++) {
        const px = (tx / n) * scale + offX;
        const py = (ty / n) * scale + offY;
        ctx.drawImage(imgs[i++], px - 0.5, py - 0.5, tilePx + 1, tilePx + 1);
      }
    }
    ctx.restore();
    return true;
  }

  _loadMapTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (this._tileCache && this._tileCache.get(key)) return this._tileCache.get(key);
    const task = (async () => {
      const yTms = (1 << z) - 1 - y;
      const sources = [
        (sub) => [`https://rt${sub}.map.gtimg.com/realtimerender?z=${z}&x=${x}&y=${yTms}&type=vector&style=0`],
        (sub) => [`https://rt${sub}.map.gtimg.com/tile?z=${z}&x=${x}&y=${yTms}&styleid=1`],
        (sub) => [
          `https://webrd0${sub + 1}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=2&style=8&x=${x}&y=${y}&z=${z}`,
          `https://webrd0${sub + 1}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${x}&y=${y}&z=${z}`
        ]
      ];
      for (const makeUrls of sources) {
        for (let i = 0; i < 4; i++) {
          const sub = (x + y + i) % 4;
          for (const url of makeUrls(sub)) {
            try {
              const img = await this._fetchTileImage(url, 5000);
              if (!this._isPlaceholderTile(img)) return img;
            } catch (_) {}
          }
        }
      }
      throw new Error('tile fetch failed');
    })();
    if (!this._tileCache) this._tileCache = new Map();
    this._tileCache.set(key, task);
    task.catch(() => { if (this._tileCache) this._tileCache.delete(key); });
    if (this._tileCache.size > 80) this._tileCache.clear();
    return task;
  }

  async _fetchTileImage(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`tile status ${res.status}`);
      const blob = await res.blob();
      return await new Promise((resolve, reject) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(blob);
        img.onload = () => { URL.revokeObjectURL(objectUrl); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('tile decode failed')); };
        img.src = objectUrl;
      });
    } finally { clearTimeout(timer); }
  }

  _isPlaceholderTile(img) {
    try {
      if (!img || !img.width || !img.height) return true;
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return false;
      ctx.drawImage(img, 0, 0);
      const samples = [
        [0, 0], [img.width - 1, 0], [0, img.height - 1],
        [img.width - 1, img.height - 1],
        [Math.floor(img.width / 2), Math.floor(img.height / 2)]
      ];
      const data = ctx.getImageData(0, 0, img.width, img.height).data;
      const first = data.slice(0, 4);
      for (const [sx, sy] of samples) {
        const i = (sy * img.width + sx) * 4;
        if (data[i] !== first[0] || data[i + 1] !== first[1] || data[i + 2] !== first[2] || data[i + 3] !== first[3]) {
          return false;
        }
      }
      return true;
    } catch (e) { return false; }
  }

  async renderTrailThumbnail(positions, opts) {
    if (!positions || positions.length < 2) return null;
    const o = opts || {};
    const W = o.width || 800; const H = o.height || 500;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    await this._drawTrailThumbnail(canvas, positions, o);
    try { return canvas.toDataURL('image/png'); } catch (e) { return null; }
  }

  async renderTrailCollage(items, opts) {
    if (!items || items.length === 0) return null;
    const o = opts || {};
    const W = o.width || 800;
    const gap = 34; const titleH = 72; const padBottom = 40;
    let thumbH = o.thumbHeight || 500;
    const estTotal = titleH + items.length * (thumbH + gap) + padBottom;
    if (estTotal > 15000) thumbH = Math.max(260, Math.floor((15000 - titleH - padBottom) / items.length) - gap);
    const totalH = titleH + items.length * (thumbH + gap) + padBottom;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = totalH;
    const ctx = canvas.getContext('2d');
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    ctx.fillStyle = isLight ? '#eef1f5' : '#0b0e14';
    ctx.fillRect(0, 0, W, totalH);
    ctx.fillStyle = isLight ? '#111418' : '#eceff3';
    ctx.font = '600 22px -apple-system, "PingFang SC", sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`途刻 轨迹合集（${items.length} 条）`, 26, 38);
    ctx.fillStyle = isLight ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)';
    ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText(`生成时间 ${new Date().toLocaleString('zh-CN')}`, 26, 60);
    let y = titleH;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const panel = document.createElement('canvas');
      panel.width = W; panel.height = thumbH;
      await this._drawTrailThumbnail(panel, it.positions, { title: it.name || `轨迹 ${i + 1}`, stats: it.stats });
      ctx.drawImage(panel, 0, y, W, thumbH);
      y += thumbH + gap;
      if (i < items.length - 1) {
        ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(26, y - 6); ctx.lineTo(W - 26, y - 6); ctx.stroke();
        ctx.fillStyle = isLight ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.28)';
        ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${i + 1}. ${it.name || ''}`, 26, y - 16);
      }
    }
    ctx.fillStyle = isLight ? 'rgba(0,0,0,0.28)' : 'rgba(255,255,255,0.24)';
    ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('注：底图较老，仅供参考使用', 26, totalH - 16);
    try { return canvas.toDataURL('image/png'); } catch (e) { return null; }
  }

  _truncateText(ctx, text, maxWidth) {
    if (!text) return '';
    let str = String(text);
    if (ctx.measureText(str).width <= maxWidth) return str;
    let lo = 0, hi = str.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (ctx.measureText(str.slice(0, mid) + '…').width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return str.slice(0, lo) + '…';
  }

  _fmtShareDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${week} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async renderShareCard(trail, opts) {
    if (!trail || !trail.positions || trail.positions.length < 2) return null;
    const o = opts || {};
    const positions = trail.positions;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const health = o.health || null;
    const W = o.width || 1080; const H = o.height || 1080;
    const S = dpr;
    const canvas = document.createElement('canvas');
    canvas.width = W * S; canvas.height = H * S;
    const ctx = canvas.getContext('2d');
    ctx.scale(S, S);
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const bg = o.background || (isLight ? '#f3f5f9' : '#0d1117');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const worldPts = positions.map((p) => {
      const wp = { x: p.lng / 360 + 0.5, y: 0.5 - Math.log(Math.tan(Math.PI / 4 + (p.lat * Math.PI / 180) / 2)) / (2 * Math.PI) };
      if (wp.x < minX) minX = wp.x; if (wp.y < minY) minY = wp.y;
      if (wp.x > maxX) maxX = wp.x; if (wp.y > maxY) maxY = wp.y;
      return wp;
    });
    const worldW = Math.max(1e-9, maxX - minX);
    const worldH = Math.max(1e-9, maxY - minY);
    const padX = o.padX || 56; const padTop = o.padTop || 130; const padBottom = o.padBottom || 320;
    const bufferRatio = (o.bufferRatio != null && o.bufferRatio > 0) ? o.bufferRatio : 0.18;
    const extX = worldW * bufferRatio; const extY = worldH * bufferRatio;
    const bMinX = minX - extX; const bMaxX = maxX + extX;
    const bMinY = minY - extY; const bMaxY = maxY + extY;
    const bufW = Math.max(1e-9, bMaxX - bMinX); const bufH = Math.max(1e-9, bMaxY - bMinY);
    const areaW = W - 2 * padX; const areaH = H - padTop - padBottom;
    const scaleX = areaW / bufW; const scaleY = areaH / bufH;
    const scale = Math.min(scaleX, scaleY);
    const drawW = bufW * scale; const drawH = bufH * scale;
    const offX = padX + (areaW - drawW) / 2 - bMinX * scale;
    const offY = padTop + (areaH - drawH) / 2 - bMinY * scale;
    const toXY = (wp) => ({ x: wp.x * scale + offX, y: wp.y * scale + offY });

    if (o.map !== false) {
      try { await this._drawThumbnailTiles(ctx, { padX, padY: padTop, W, H, scale, offX, offY, padBottom }); } catch (e) {}
    }

    const headerGrad = ctx.createLinearGradient(0, 0, 0, padTop);
    headerGrad.addColorStop(0, isLight ? 'rgba(243,245,249,0.96)' : 'rgba(13,17,23,0.94)');
    headerGrad.addColorStop(1, isLight ? 'rgba(243,245,249,0.30)' : 'rgba(13,17,23,0.25)');
    ctx.fillStyle = headerGrad; ctx.fillRect(0, 0, W, padTop);

    const title = this._truncateText(ctx, o.title || trail.name || '途刻轨迹', W - 2 * padX);
    ctx.fillStyle = isLight ? '#14181f' : '#ffffff';
    ctx.font = '700 32px "HarmonyOS Sans", "PingFang SC", sans-serif';
    ctx.textBaseline = 'middle'; ctx.fillText(title, padX, 52);

    if (health && health.grade) {
      const grade = health.grade;
      const badgeText = '健康 ' + grade;
      ctx.font = '700 20px "HarmonyOS Sans", "PingFang SC", sans-serif';
      const badgeW = ctx.measureText(badgeText).width + 28; const badgeH = 36;
      const badgeX = W - padX - badgeW; const badgeY = 34;
      const badgeColor = grade === 'A' ? '#34C759' : grade === 'B' ? '#30B0C7' : grade === 'C' ? '#FF9F0A' : '#FF453A';
      ctx.fillStyle = badgeColor;
      ctx.beginPath(); ctx.roundRect(badgeX, badgeY, badgeW, badgeH, badgeH / 2); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center';
      ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + badgeH / 2);
      ctx.textAlign = 'left';
    }

    const subtitle = o.subtitle || this._fmtShareDate(trail.createdAt);
    if (subtitle) {
      ctx.fillStyle = isLight ? 'rgba(20,24,31,0.55)' : 'rgba(255,255,255,0.55)';
      ctx.font = '18px "HarmonyOS Sans", "PingFang SC", sans-serif';
      ctx.fillText(subtitle, padX, 94);
    }

    const lossSet = (o.signalLoss && o.signalLoss.segments)
      ? (() => { const s = new Set(); for (const seg of o.signalLoss.segments) for (let i = seg.startIdx; i <= seg.endIdx; i++) s.add(i); return s; })()
      : null;
    const colorMap = Object.assign({}, this._speedColorMap, { __loss__: this._hexToRgb(CONFIG.SIGNAL_LOSS_GREY) });
    ctx.lineWidth = 8; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (let i = 1; i < worldPts.length; i++) {
      const p0 = worldPts[i - 1]; const p1 = worldPts[i];
      const key = lossSet && lossSet.has(i) ? '__loss__' : this._speedColorKey(this._segmentSpeed(positions[i - 1], positions[i]));
      const c = colorMap[key] || { r: 0, g: 200, b: 160, a: 0.9 };
      const a = toXY(p0); const b = toXY(p1);
      ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${c.a})`;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    const startPt = toXY(worldPts[0]); const endPt = toXY(worldPts[worldPts.length - 1]);
    ctx.fillStyle = '#34C759'; ctx.beginPath(); ctx.arc(startPt.x, startPt.y, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#FF453A'; ctx.beginPath(); ctx.arc(endPt.x, endPt.y, 9, 0, Math.PI * 2); ctx.fill();

    const legendY = padTop - 16;
    let legendX = padX;
    const dotR = 7;
    const drawLegendItem = (color, label) => {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(legendX + dotR, legendY, dotR, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = isLight ? 'rgba(20,24,31,0.7)' : 'rgba(255,255,255,0.7)';
      ctx.font = '15px "HarmonyOS Sans", "PingFang SC", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, legendX + dotR * 2 + 6, legendY);
      legendX += dotR * 2 + 6 + ctx.measureText(label).width + 22;
    };
    const levels = CONFIG.TRAIL_SPEED_LEVELS || [];
    let prevMax = 0;
    for (const lv of levels) {
      const lo = prevMax * 3.6; const hi = lv.max === Infinity ? null : lv.max * 3.6;
      const range = hi === null ? `${Math.round(lo)}+` : `${Math.round(lo)}-${Math.round(hi)}`;
      drawLegendItem(lv.color || '#00E5CC', `${range} km/h`);
      prevMax = lv.max === Infinity ? prevMax : lv.max;
    }
    drawLegendItem(CONFIG.SIGNAL_LOSS_GREY, '信号丢失');

    const stats = o.stats || (() => {
      let distance = 0;
      for (let i = 1; i < positions.length; i++) distance += calcDistance(positions[i - 1], positions[i]);
      let duration = 0;
      const f = positions[0]; const l = positions[positions.length - 1];
      if (f && l && f.time && l.time && l.time > f.time) duration = l.time - f.time;
      let maxSpeed = 0;
      for (const p of positions) { if (p.speed != null && p.speed > maxSpeed) maxSpeed = p.speed; }
      const avgSpeed = duration > 0 ? distance / (duration / 1000) : 0;
      return { distance, duration, points: positions.length, maxSpeed, avgSpeed };
    })();

    const panelY = H - 280; const panelH = 200;
    ctx.fillStyle = isLight ? 'rgba(255,255,255,0.92)' : 'rgba(22,27,34,0.92)';
    ctx.beginPath(); ctx.roundRect(32, panelY - 26, W - 64, panelH, 24); ctx.fill();

    const fmtSpeed = (v) => (v > 0 ? (v * 3.6).toFixed(1) + ' km/h' : '--');
    const statCols = [
      { label: '距离', value: formatDistance(stats.distance), big: true },
      { label: '时长', value: formatDurationShort(stats.duration), big: false },
      { label: '均速', value: fmtSpeed(stats.avgSpeed), big: false },
      { label: '最高速', value: fmtSpeed(stats.maxSpeed), big: false },
      { label: '爬升', value: (stats.climb != null && stats.climb > 0) ? Math.round(stats.climb) + ' m' : '--', big: false }
    ];
    const colW = (W - 64) / statCols.length;
    statCols.forEach((col, i) => {
      const cx = 32 + colW * i + colW / 2; const top = panelY + 24;
      ctx.textAlign = 'center';
      ctx.fillStyle = isLight ? 'rgba(20,24,31,0.5)' : 'rgba(255,255,255,0.5)';
      ctx.font = '15px "HarmonyOS Sans", "PingFang SC", sans-serif';
      ctx.fillText(col.label, cx, top);
      ctx.fillStyle = isLight ? '#14181f' : '#ffffff';
      ctx.font = col.big ? '700 26px "HarmonyOS Sans", sans-serif' : '700 22px "HarmonyOS Sans", sans-serif';
      ctx.fillText(col.value, cx, top + 44);
      ctx.textAlign = 'left';
    });

    const watermarkY = H - 12;
    ctx.textAlign = 'right';
    ctx.fillStyle = isLight ? 'rgba(20,24,31,0.35)' : 'rgba(255,255,255,0.30)';
    ctx.font = '17px "HarmonyOS Sans", "PingFang SC", sans-serif';
    ctx.fillText('途刻 TraceCraft', W - 40, watermarkY);
    ctx.fillStyle = isLight ? 'rgba(20,24,31,0.28)' : 'rgba(255,255,255,0.24)';
    ctx.font = '13px "HarmonyOS Sans", "PingFang SC", sans-serif';
    ctx.fillText('注：底图较老，仅供参考使用', W - 40, watermarkY - 20);
    ctx.textAlign = 'left';

    try { return canvas.toDataURL('image/png'); } catch (e) { return null; }
  }

  destroy() {
    if (this._resizeHandler) { window.removeEventListener('resize', this._resizeHandler); this._resizeHandler = null; }
    if (this._zoomDecimateTimer) { clearTimeout(this._zoomDecimateTimer); this._zoomDecimateTimer = null; }
    if (this._themeRefreshRaf) { cancelAnimationFrame(this._themeRefreshRaf); this._themeRefreshRaf = null; }
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    if (this._overlayRafId) { cancelAnimationFrame(this._overlayRafId); this._overlayRafId = null; }
    if (this._tileCache) { this._tileCache.clear(); this._tileCache = null; }
    if (this._decimateCache) { this._decimateCache.clear(); this._decimateCache = null; }
    if (this._coordCache) { this._coordCache.clear(); this._coordCache = null; }
    this.clearTrail();
    this.clearTrailMarkers();
    this.clearRealtimeKeyPoints();
    this.map = null;
    this._fallback = null;
    this.canvas = null;
    this.ctx = null;
    this.overlayCanvas = null;
    this.overlayCtx = null;
  }
}
