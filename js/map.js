/**
 * 途刻（TraceCraft）- 地图管理器
 * ============================================
 * 轨迹 Polyline 渲染 + GPS 定位标记 + 回放支持
 */

// roundRect polyfill
if (typeof CanvasRenderingContext2D !== 'undefined' &&
    !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    const radii = typeof r === 'number' ? [r, r, r, r] : r;
    const [tl, tr, br, bl] = radii;
    if (tl < 0 || tr < 0 || br < 0 || bl < 0) throw new TypeError('roundRect radii must not be negative');
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
    this._locAnim = null;
    this.canvas = null;
    this.ctx = null;
    this.overlayCanvas = null;
    this.overlayCtx = null;
    this.center = null;
    this._idCounter = Date.now();
    this._rafId = null;
    this._overlayRafId = null;
    this._syncCenter = null;
    this._coordCache = new Map();
    this.locationMarker = null;
    this.accuracyCircle = null;
    this.trailPolylines = [];
    this._lastTrailCount = 0;
    this._replayTrailPolyline = null;
    this._replayMarker = null;
    this._replaySession = null;
    this._replayPosIndex = 0;
    this.onCenterChange = null;
    this.onMapClick = null;
    this._theme = 'dark';
  }

  init(containerId, center, zoom) {
    const mapEl = document.getElementById(containerId);
    this.canvas = document.getElementById('circle-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.overlayCanvas = document.getElementById('overlay-canvas');
    this.overlayCtx = this.overlayCanvas ? this.overlayCanvas.getContext('2d') : null;

    if (typeof qq === 'undefined' || !qq.maps || typeof qq.maps.Map !== 'function') {
      console.error('[MapManager] 腾讯地图 SDK 加载失败');
      try { Toast.show(' 地图加载失败，请检查网络后刷新页面'); } catch (_) {}
      throw new Error('腾讯地图 SDK 未加载');
    }

    this.map = new qq.maps.Map(mapEl, {
      center: new qq.maps.LatLng(center.lat, center.lng),
      zoom: zoom || CONFIG.DEFAULT_ZOOM,
      mapTypeId: qq.maps.MapTypeId.ROADMAP
    });

    if (CONFIG.DEBUG) {
      console.info('[MapManager] init env:', JSON.stringify({
        ua: (navigator.userAgent || '').substring(0, 80),
        dpr: window.devicePixelRatio || 1,
        viewport: window.innerWidth + 'x' + window.innerHeight,
      }));
    }

    this._syncCenter = new qq.maps.LatLng(center.lat, center.lng);

    qq.maps.event.addListener(this.map, 'click', (event) => {
      if (!event.latLng) return;
      const pos = { lat: event.latLng.getLat(), lng: event.latLng.getLng() };
      this.setCenter(pos);
      if (this.onMapClick) this.onMapClick(pos);
    });

    qq.maps.event.addListener(this.map, 'center_changed', () => {
      if (this._settingCenter) return;
      const c = this.map.getCenter();
      if (c) this._syncCenter = c;
      this._invalidateCoordCache();
      this._scheduleRedraw();
    });
    qq.maps.event.addListener(this.map, 'zoom_changed', () => {
      this._invalidateCoordCache();
      this._scheduleRedraw();
    });
    qq.maps.event.addListener(this.map, 'drag', () => this._scheduleRedraw());
    qq.maps.event.addListener(this.map, 'dragend', () => {
      this._invalidateCoordCache();
      this._scheduleRedraw();
    });

    this._resizeHandler = () => {
      this._resizeCanvas();
      this._scheduleRedraw();
    };
    window.addEventListener('resize', this._resizeHandler);
    this._resizeCanvas();
    this._scheduleRedraw();
    return this;
  }

  _resizeCanvas() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = parent.offsetWidth * dpr;
    this.canvas.height = parent.offsetHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.overlayCanvas) {
      this.overlayCanvas.width = parent.offsetWidth * dpr;
      this.overlayCanvas.height = parent.offsetHeight * dpr;
      this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  _scheduleRedraw() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = requestAnimationFrame(() => this._redraw());
  }

  _redraw() {
    this._rafId = null;
    if (!this.map || !this.canvas) return;
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    const w = parent.offsetWidth;
    const h = parent.offsetHeight;
    if (w === 0 || h === 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
  }

  /** 仅重绘叠加层（位置更新时调用） */
  _scheduleRedrawOverlay() {
    if (this._overlayRafId) cancelAnimationFrame(this._overlayRafId);
    this._overlayRafId = requestAnimationFrame(() => {
      this._overlayRafId = null;
      if (!this.map || !this.overlayCanvas || !this.overlayCtx) return;
      const parent = this.overlayCanvas.parentElement;
      if (!parent) return;
      const dpr = window.devicePixelRatio || 1;
      const ctx = this.overlayCtx;
      const w = parent.offsetWidth, h = parent.offsetHeight;
      if (w === 0 || h === 0) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
    });
  }

  _latLngToContainerPoint(latLng) {
    const parent = this.canvas.parentElement;
    if (!parent) return null;
    const bounds = this.map.getBounds();
    if (!bounds) return null;
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    const w = parent.offsetWidth, h = parent.offsetHeight;
    const lngRange = ne.getLng() - sw.getLng();
    const latRange = sw.getLat() - ne.getLat();
    if (lngRange === 0 || latRange === 0) return null;
    const x = (latLng.getLng() - sw.getLng()) / lngRange * w;
    const y = (ne.getLat() - latLng.getLat()) / latRange * h;
    return { x, y };
  }

  _metersToPixels(meters, latLng) {
    const cp = this._latLngToContainerPoint(latLng);
    if (!cp) return 0;
    const zoom = this.map.getZoom();
    const lat = latLng ? latLng.getLat() : (this._syncCenter ? this._syncCenter.getLat() : 0);
    const mpp = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    return meters / mpp;
  }

  _invalidateCoordCache() {
    this._coordCache.clear();
  }

  /**
   * 设置/移动中心点标记
   */
  setCenter(center) {
    this.center = center;
    const latLng = new qq.maps.LatLng(center.lat, center.lng);
    if (this.marker) {
      this.marker.setPosition(latLng);
    } else {
      this.marker = new qq.maps.Marker({
        position: latLng, map: this.map,
        draggable: true, icon: this._createMarkerIcon()
      });
      qq.maps.event.addListener(this.marker, 'dragend', (event) => {
        const pos = event.latLng;
        this.center = { lat: pos.lat, lng: pos.lng };
        if (this.onCenterChange) this.onCenterChange(this.center);
      });
    }
    this._settingCenter = true;
    this._syncCenter = latLng;
    this.map.setCenter(latLng);
    this._settingCenter = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._redraw();
    this._lastRedrawTime = performance.now();
    if (this.onCenterChange) this.onCenterChange(this.center);
  }

  /**
   * 更新定位标记（我的位置 + 精度圆环）
   */
  setLocation(convPos, accuracy) {
    if (!this.map) return;
    const latLng = new qq.maps.LatLng(convPos.lat, convPos.lng);
    if (!this.locationMarker) {
      this.locationMarker = new qq.maps.Marker({
        position: latLng, map: this.map,
        icon: this._createLocationIcon()
      });
    } else {
      this.locationMarker.setPosition(latLng);
    }
    if (this._locAnim) cancelAnimationFrame(this._locAnim);
    this._locAnim = null;
    if (accuracy > 0 && !this.accuracyCircle) {
      this.accuracyCircle = new qq.maps.Circle({
        map: this.map, center: latLng, radius: accuracy,
        fillColor: new qq.maps.Color(0, 136, 255, 0.08),
        strokeColor: new qq.maps.Color(0, 136, 255, 0.15),
        strokeWeight: 1, clickable: false, editable: false
      });
    } else if (this.accuracyCircle) {
      this.accuracyCircle.setCenter(latLng);
      this.accuracyCircle.setRadius(accuracy);
    }
    this._scheduleRedrawOverlay();
  }

  // ----- 速度→色阶映射 -----
  _speedColorDark = {
    walk: { r: 0, g: 229, b: 204, a: 0.70 }, bike: { r: 255, g: 215, b: 0, a: 0.75 },
    bus: { r: 255, g: 140, b: 0, a: 0.80 }, car: { r: 255, g: 94, b: 51, a: 0.82 },
    train: { r: 255, g: 51, b: 102, a: 0.85 }, hsr: { r: 191, g: 64, b: 255, a: 0.90 },
    sct: { r: 94, g: 92, b: 230, a: 0.92 },
  };
  _speedColorLight = {
    walk: { r: 52, g: 199, b: 89, a: 0.65 }, bike: { r: 255, g: 149, b: 0, a: 0.70 },
    bus: { r: 255, g: 59, b: 48, a: 0.75 }, car: { r: 255, g: 45, b: 85, a: 0.78 },
    train: { r: 175, g: 82, b: 222, a: 0.80 }, hsr: { r: 88, g: 86, b: 214, a: 0.85 },
    sct: { r: 0, g: 122, b: 255, a: 0.88 },
  };
  get _speedColorMap() {
    return document.documentElement.getAttribute('data-theme') === 'light'
      ? this._speedColorLight : this._speedColorDark;
  }
  _speedColorKey(speed) {
    if (speed == null || speed < 2.78) return 'walk';
    if (speed < 5.56) return 'bike';
    if (speed < 16.67) return 'bus';
    if (speed < 33.33) return 'car';
    if (speed < 55.56) return 'train';
    if (speed < 97.22) return 'hsr';
    return 'sct';
  }
  _segmentSpeed(p0, p1) {
    return p1.speed != null ? p1.speed : (p0.speed != null ? p0.speed : 0);
  }

  /**
   * 更新历史轨迹线（按速度分段着色）
   */
  setTrail(positions) {
    if (!this.map) return;
    if (!Array.isArray(positions) || positions.length < 2) { this.clearTrail(); return; }
    if (positions.length < (this._lastTrailCount || 0)) { this.clearTrail(); }
    const from = Math.max(1, this._lastTrailCount || 0);
    if (from >= positions.length) {
      if (positions.length > 0 && this._lastTrailCount > 0 && this._lastTrailAnchor) {
        const first = positions[0];
        if (first.lat !== this._lastTrailAnchor.lat || first.lng !== this._lastTrailAnchor.lng) this.clearTrail();
        else return;
      } else { return; }
    }
    let batchPath = [], batchKey = null;
    const startIdx = Math.max(1, this._lastTrailCount || 0);
    for (let i = startIdx; i < positions.length; i++) {
      const p0 = positions[i - 1], p1 = positions[i];
      const key = this._speedColorKey(this._segmentSpeed(p0, p1));
      if (batchPath.length === 0) {
        batchPath.push(new qq.maps.LatLng(p0.lat, p0.lng), new qq.maps.LatLng(p1.lat, p1.lng));
        batchKey = key;
      } else if (key === batchKey) {
        batchPath.push(new qq.maps.LatLng(p1.lat, p1.lng));
      } else {
        if (batchPath.length >= 2) this._flushSegment(batchPath, this._speedColorMap[batchKey]);
        batchPath = [new qq.maps.LatLng(p0.lat, p0.lng), new qq.maps.LatLng(p1.lat, p1.lng)];
        batchKey = key;
      }
    }
    if (batchPath.length >= 2) this._flushSegment(batchPath, this._speedColorMap[batchKey]);
    this._lastTrailCount = positions.length;
    if (positions.length > 0) this._lastTrailAnchor = positions[0];
  }

  _flushSegment(path, clr) {
    const poly = new qq.maps.Polyline({ path, strokeColor: new qq.maps.Color(clr.r, clr.g, clr.b, clr.a), strokeWeight: 3.5, map: this.map });
    this.trailPolylines.push(poly);
  }

  /**
   * 清除历史轨迹线
   */
  clearTrail() {
    for (const poly of this.trailPolylines) { poly.setMap(null); }
    this.trailPolylines = [];
    this._lastTrailCount = 0;
  }

  // ----- 主题切换渐进重绘 -----
  refreshTrailColors(positions) {
    if (!this.map || !Array.isArray(positions) || positions.length < 2) return;
    if (this._themeRefreshRaf) { cancelAnimationFrame(this._themeRefreshRaf); this._themeRefreshRaf = null; }
    const centerIdx = this._findVisibleCenterIndex(positions);
    this.clearTrail();
    this._themeRefreshQueue = { positions, left: centerIdx, right: centerIdx + 1, startTime: Date.now(), timeBudget: 60000, done: false };
    this._processThemeRefreshBatch();
  }

  _findVisibleCenterIndex(positions) {
    if (!this.map) return Math.floor(positions.length / 2);
    try {
      const bounds = this.map.getBounds();
      if (!bounds) return Math.floor(positions.length / 2);
      const ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
      const centerLat = (ne.lat + sw.lat) / 2, centerLng = (ne.lng + sw.lng) / 2;
      let bestIdx = 0, bestDist = Infinity;
      const step = Math.max(1, Math.floor(positions.length / 500));
      for (let i = 0; i < positions.length; i += step) {
        const p = positions[i], d = (p.lat - centerLat) ** 2 + (p.lng - centerLng) ** 2;
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      const searchStart = Math.max(0, bestIdx - step), searchEnd = Math.min(positions.length - 1, bestIdx + step);
      for (let i = searchStart; i <= searchEnd; i++) {
        const p = positions[i], d = (p.lat - centerLat) ** 2 + (p.lng - centerLng) ** 2;
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      return bestIdx;
    } catch (_) { return Math.floor(positions.length / 2); }
  }

  _processThemeRefreshBatch() {
    const q = this._themeRefreshQueue;
    if (!q || q.done) return;
    const elapsed = Date.now() - q.startTime, totalPoints = q.positions.length;
    const remainingTime = Math.max(1, q.timeBudget - elapsed);
    const remainingPoints = (q.left > 0 ? q.left : 0) + (totalPoints - q.right);
    if (remainingPoints <= 0 || elapsed >= q.timeBudget) { this._finishThemeRefresh(q); return; }
    const batchSize = Math.max(10, Math.ceil(remainingPoints / (remainingTime / 16)));
    const leftEnd = Math.max(0, q.left - batchSize);
    if (leftEnd < q.left) { this._renderTrailRange(q.positions, leftEnd, q.left + 1, q); q.left = leftEnd; }
    const rightEnd = Math.min(totalPoints, q.right + batchSize);
    if (rightEnd > q.right) { this._renderTrailRange(q.positions, q.right, rightEnd, q); q.right = rightEnd; }
    if (q.left <= 0 && q.right >= totalPoints) { this._finishThemeRefresh(q); return; }
    this._themeRefreshRaf = requestAnimationFrame(() => this._processThemeRefreshBatch());
  }

  _renderTrailRange(positions, from, to, q) {
    if (from >= to) return;
    const start = Math.max(1, from), end = Math.min(positions.length, to);
    let batchPath = [], batchKey = null;
    if (start > 0) {
      const anchor = positions[start - 1];
      batchPath.push(new qq.maps.LatLng(anchor.lat, anchor.lng));
      batchKey = this._speedColorKey(this._segmentSpeed(anchor, positions[start]));
    }
    for (let i = start; i < end; i++) {
      const p0 = positions[i - 1], p1 = positions[i];
      const key = this._speedColorKey(this._segmentSpeed(p0, p1));
      if (batchPath.length === 0) {
        batchPath.push(new qq.maps.LatLng(p0.lat, p0.lng), new qq.maps.LatLng(p1.lat, p1.lng));
        batchKey = key;
      } else if (key === batchKey) {
        batchPath.push(new qq.maps.LatLng(p1.lat, p1.lng));
      } else {
        if (batchPath.length >= 2) this._flushSegment(batchPath, this._speedColorMap[batchKey]);
        batchPath = [new qq.maps.LatLng(p0.lat, p0.lng), new qq.maps.LatLng(p1.lat, p1.lng)];
        batchKey = key;
      }
    }
    if (batchPath.length >= 2) this._flushSegment(batchPath, this._speedColorMap[batchKey]);
  }

  _finishThemeRefresh(q) {
    this._themeRefreshQueue = null; this._themeRefreshRaf = null;
    this._lastTrailCount = q.positions.length;
    if (q.positions.length > 0) this._lastTrailAnchor = q.positions[0];
  }

  /**
   * 回放：在地图上绘制会话轨迹并放置定位点
   */
  async replayTrail(session) {
    if (!this.map || !session?.positions?.length) return;
    this.stopReplay();
    this._replaySession = session;
    const positions = session.positions;
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const p of positions) {
      if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng; if (p.lng > maxLng) maxLng = p.lng;
    }
    const pad = 0.001;
    const bounds = new qq.maps.LatLngBounds(
      new qq.maps.LatLng(minLat - pad, minLng - pad),
      new qq.maps.LatLng(maxLat + pad, maxLng + pad)
    );
    this.map.fitBounds(bounds);
    const gcjPositions = [];
    for (const p of positions) {
      try { const conv = await this.wgs84ToGcj02(p); gcjPositions.push(conv); } catch (_) { gcjPositions.push(p); }
    }
    this.setTrail(gcjPositions);
    const first = gcjPositions[0];
    this._replayMarker = new qq.maps.Marker({
      position: new qq.maps.LatLng(first.lat, first.lng), map: this.map, icon: this._createMarkerIcon()
    });
    this._replayPosIndex = 0;
    this._scheduleRedraw();
  }

  /**
   * 停止回放，清除回放元素
   */
  stopReplay() {
    if (this._replayAnimId) { cancelAnimationFrame(this._replayAnimId); this._replayAnimId = null; }
    if (this._replayMarker) { this._replayMarker.setMap(null); this._replayMarker = null; }
    if (this._replayTrailPolyline) { this._replayTrailPolyline.setMap(null); this._replayTrailPolyline = null; }
    this._replaySession = null; this._replayPosIndex = 0;
    this._scheduleRedraw();
  }

  /**
   * 回放中移动到指定轨迹点
   */
  advanceReplayTo(position, index) {
    if (!this._replayMarker) return;
    this._replayMarker.setPosition(new qq.maps.LatLng(position.lat, position.lng));
    this._replayPosIndex = index;
  }

  // ----- 图标创建 -----
  _createMarkerIcon() {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">',
      '  <defs><filter id="ms" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="3" flood-opacity="0.5"/></filter></defs>',
      '  <circle cx="20" cy="20" r="18" fill="none" stroke="rgba(0,212,170,0.3)" stroke-width="1.5"/>',
      '  <circle cx="20" cy="20" r="13" fill="none" stroke="rgba(0,212,170,0.5)" stroke-width="2"/>',
      '  <circle cx="20" cy="20" r="7" fill="#00D4AA" stroke="#fff" stroke-width="2.5" filter="url(#ms)"/>',
      '  <circle cx="20" cy="20" r="2.5" fill="#fff" opacity="0.95"/>',
      '</svg>'
    ].join('\n');
    const dataUri = 'data:image/svg+xml;base64,' + btoa(svg);
    return new qq.maps.MarkerImage(dataUri, new qq.maps.Size(40, 40), new qq.maps.Point(0, 0), new qq.maps.Point(20, 20), new qq.maps.Size(40, 40));
  }

  _createLocationIcon() {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">',
      '  <circle cx="20" cy="20" r="18" fill="rgba(0,136,255,0.15)" stroke="rgba(0,136,255,0.5)" stroke-width="1.5"/>',
      '  <circle cx="20" cy="20" r="10" fill="rgba(0,136,255,0.3)"/>',
      '  <circle cx="20" cy="20" r="5" fill="#0088FF" stroke="#fff" stroke-width="2"/>',
      '</svg>'
    ].join('\n');
    const dataUri = 'data:image/svg+xml;base64,' + btoa(svg);
    return new qq.maps.MarkerImage(dataUri, new qq.maps.Size(40, 40), new qq.maps.Point(0, 0), new qq.maps.Point(20, 20), new qq.maps.Size(40, 40));
  }

  // ----- 工具方法 -----
  flyTo(center, zoom) {
    if (!this.map) return;
    this.map.panTo(new qq.maps.LatLng(center.lat, center.lng));
    this.map.setZoom(zoom || CONFIG.LOCATION_ZOOM);
  }

  async wgs84ToGcj02(point) {
    if (typeof qq !== 'undefined' && qq.maps && qq.maps.convertor) {
      try {
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('convertor API timeout')), 2000);
          const latLng = new qq.maps.LatLng(point.lat, point.lng);
          qq.maps.convertor.translate([latLng], 1, (res) => {
            clearTimeout(timer);
            if (res && res[0] && typeof res[0].lat === 'number' && typeof res[0].lng === 'number') resolve({ lat: res[0].lat, lng: res[0].lng });
            else reject(new Error('unexpected convertor response'));
          });
        });
        return result;
      } catch (e) { console.warn('wgs84ToGcj02: 降级到手写算法', e.message); }
    }
    return this._wgs84Gcj02(point);
  }

  _wgs84Gcj02(point) {
    const A = 6378245.0, EE = 0.00669342162296594323;
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

  _hexToRgba(hex, alpha) {
    let h = (hex || '#888').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16) || 0;
    const g = parseInt(h.slice(2, 4), 16) || 0;
    const b = parseInt(h.slice(4, 6), 16) || 0;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  _getOffscreen(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  destroy() {
    this.clearTrail();
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    if (this._overlayRafId) { cancelAnimationFrame(this._overlayRafId); this._overlayRafId = null; }
    if (this._themeRefreshRaf) { cancelAnimationFrame(this._themeRefreshRaf); this._themeRefreshRaf = null; }
    if (this._resizeHandler) { window.removeEventListener('resize', this._resizeHandler); this._resizeHandler = null; }
    if (this.accuracyCircle) { this.accuracyCircle.setMap(null); this.accuracyCircle = null; }
    if (this.map) { qq.maps.event.clearInstanceListeners(this.map); }
    if (this.marker) { this.marker.setMap(null); this.marker = null; }
    if (this.locationMarker) { this.locationMarker.setMap(null); this.locationMarker = null; }
    this.stopReplay();
    this._myPos = null;
    this._offCanvas = null;
    this.canvas = null; this.ctx = null;
    this._syncCenter = null; this.map = null; this.center = null;
  }
}
