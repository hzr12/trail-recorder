/**
 * 途刻 TraceCraft - 地图管理器
 * ============================================
 * 腾讯地图 + 轨迹可视化
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

    this.locationMarker = null;
    this.accuracyCircle = null;
    this.trailPolylines = [];
    this._lastTrailCount = 0;
    this._lastTrailAnchor = null;

    this.onCenterChange = null;
    this._theme = 'dark';
    this._rafId = null;
    this._overlayRafId = null;
  }

  /**
   * 初始化地图 + Canvas 叠加层
   */
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

    this._syncCenter = new qq.maps.LatLng(center.lat, center.lng);

    qq.maps.event.addListener(this.map, 'center_changed', () => {
      if (this._settingCenter) return;
      const c = this.map.getCenter();
      if (c) this._syncCenter = c;
      this._invalidateCoordCache();
    });
    qq.maps.event.addListener(this.map, 'zoom_changed', () => {
      this._invalidateCoordCache();
    });

    this._resizeHandler = () => {
      this._resizeCanvas();
    };
    window.addEventListener('resize', this._resizeHandler);

    this._resizeCanvas();

    return this;
  }

  _invalidateCoordCache() {
    this._coordCache.clear();
  }

  _latLngToContainerPoint(latLng) {
    if (!this.map) return null;
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

  setTheme(theme) {
    this._theme = theme;
  }

  /* ================================================================
   *  公开 API
   * ================================================================ */

  flyTo(center, zoom) {
    if (!this.map) return;
    this.map.panTo(new qq.maps.LatLng(center.lat, center.lng));
    this.map.setZoom(zoom || CONFIG.LOCATION_ZOOM);
  }

  async wgs84ToGcj02(point) {
    if (typeof qq !== 'undefined' && qq.maps && qq.maps.convertor) {
      try {
        const result = await new Promise((resolve, reject) => {
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
    return this._wgs84Gcj02(point);
  }

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
   * 创建我的位置标记图标（蓝色实心圆点）
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

    this._updateAccuracyCircle(latLng, accuracy);
  }

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
      if (this._locAnim !== anim) return;
      const t = Math.min(1, (now - anim.start) / 500);
      const e = 1 - Math.pow(1 - t, 3);
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

  _stopLocationAnim() {
    const anim = this._locAnim;
    if (anim) {
      if (anim.rafId) cancelAnimationFrame(anim.rafId);
      this._locAnim = null;
    }
  }

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

  // ----- 速度→色阶映射 -----

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
    if (!Array.isArray(positions) || positions.length < 2) {
      this.clearTrail();
      return;
    }

    if (positions.length < (this._lastTrailCount || 0)) {
      this.clearTrail();
    }

    const from = Math.max(1, this._lastTrailCount || 0);
    if (from >= positions.length) {
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

    let batchPath = [];
    let batchKey = null;

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
        const interpolated = this._subdivideSegment(p0, p1);
        for (const pt of interpolated) {
          batchPath.push(new qq.maps.LatLng(pt.lat, pt.lng));
        }
      } else {
        if (batchPath.length >= 2) {
          this._flushSegment(batchPath, this._speedColorMap[batchKey]);
        }
        const interpolated = this._subdivideSegment(p0, p1);
        batchPath = [new qq.maps.LatLng(p0.lat, p0.lng)];
        for (const pt of interpolated) {
          batchPath.push(new qq.maps.LatLng(pt.lat, pt.lng));
        }
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

  _subdivideSegment(p0, p1) {
    const dist = calcDistance(p0, p1);
    if (dist < 10) return [p1];

    const steps = Math.min(10, Math.max(2, Math.round(dist / 10)));
    const result = [];
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      result.push({
        lat: p0.lat + (p1.lat - p0.lat) * t,
        lng: p0.lng + (p1.lng - p0.lng) * t
      });
    }
    return result;
  }

  _flushSegment(path, clr) {
    const poly = new qq.maps.Polyline({
      path,
      strokeColor: new qq.maps.Color(clr.r, clr.g, clr.b, clr.a),
      strokeWeight: 3.5,
      map: this.map
    });
    this.trailPolylines.push(poly);
  }

  clearTrail() {
    for (const poly of this.trailPolylines) {
      poly.setMap(null);
    }
    this.trailPolylines = [];
    this._lastTrailCount = 0;
  }

  refreshTrailColors(positions) {
    if (!this.map || !Array.isArray(positions) || positions.length < 2) return;
    if (this._themeRefreshRaf) {
      cancelAnimationFrame(this._themeRefreshRaf);
      this._themeRefreshRaf = null;
    }
    const centerIdx = this._findVisibleCenterIndex(positions);
    this.clearTrail();
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
      const step = Math.max(1, Math.floor(positions.length / 500));
      for (let i = 0; i < positions.length; i += step) {
        const p = positions[i];
        const d = (p.lat - centerLat) ** 2 + (p.lng - centerLng) ** 2;
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
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

  _processThemeRefreshBatch() {
    const q = this._themeRefreshQueue;
    if (!q || q.done) return;

    const elapsed = Date.now() - q.startTime;
    const totalPoints = q.positions.length;

    const remainingTime = Math.max(1, q.timeBudget - elapsed);
    const remainingPoints = (q.left > 0 ? q.left : 0) + (totalPoints - q.right);
    if (remainingPoints <= 0 || elapsed >= q.timeBudget) {
      this._renderRemainingTrail(q);
      this._finishThemeRefresh(q);
      return;
    }

    const batchSize = Math.max(10, Math.ceil(remainingPoints / (remainingTime / 16)));

    const leftEnd = Math.max(0, q.left - batchSize);
    if (leftEnd < q.left) {
      this._renderTrailRange(q.positions, leftEnd, q.left + 1, q);
      q.left = leftEnd;
    }

    const rightEnd = Math.min(totalPoints, q.right + batchSize);
    if (rightEnd > q.right) {
      this._renderTrailRange(q.positions, q.right, rightEnd, q);
      q.right = rightEnd;
    }

    if (q.left <= 0 && q.right >= totalPoints) {
      this._finishThemeRefresh(q);
      return;
    }

    this._themeRefreshRaf = requestAnimationFrame(() => this._processThemeRefreshBatch());
  }

  _renderTrailRange(positions, from, to, q) {
    if (from >= to) return;
    const start = Math.max(1, from);
    const end = Math.min(positions.length, to);

    let batchPath = [];
    let batchKey = null;

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

  _renderRemainingTrail(q) {
    if (q.left > 0) {
      this._renderTrailRange(q.positions, 0, q.left + 1, q);
    }
    if (q.right < q.positions.length) {
      this._renderTrailRange(q.positions, q.right, q.positions.length, q);
    }
  }

  _finishThemeRefresh(q) {
    q.done = true;
    this._themeRefreshRaf = null;
    this._themeRefreshQueue = null;
  }

  /**
   * 销毁地图实例
   */
  destroy() {
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    this._stopLocationAnim();
    this.clearTrail();
    if (this.accuracyCircle) {
      this.accuracyCircle.setMap(null);
      this.accuracyCircle = null;
    }
    if (this.locationMarker) {
      this.locationMarker.setMap(null);
      this.locationMarker = null;
    }
    this.map = null;
    this.canvas = null;
    this.ctx = null;
    this.overlayCanvas = null;
    this.overlayCtx = null;
  }
}
