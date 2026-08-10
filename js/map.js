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
    this._lastTrailInput = null;
    this._decimateCache = new Map(); // 抽稀结果缓存：key = 原始数组引用
    this._zoomDecimateTimer = null;  // zoom 防抖重绘定时器

    this.trailMarkers = [];

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
      // 方案 C：缩放级别变化后防抖重绘轨迹（抽稀点数上限随 zoom 变化）。
      // 缩放过程不立即重建，松手 300ms 后再按新 zoom 的重绘上限刷新，避免拖动期间频繁重建卡顿。
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

  /**
   * 同步 WGS84 → GCJ02（手写算法，零网络开销）
   * 推算位置 25Hz 高频回调用：逐点走网络 convertor API 会爆请求，
   * 手写算法精度与官方偏差 < 1m，对 UI 展示足够。
   */
  wgs84ToGcj02Sync(point) {
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
   * 批量 WGS84 → GCJ02（同步手写算法）
   * 用于停止记录后的 RTS 离线平滑后处理：整段轨迹点量较大，
   * 逐点调用 convertor 网络 API（每次 2s 超时）不现实，手写算法同步、零网络开销，
   * 精度与官方转换偏差 < 1m，对离线轨迹修正足够。
   * @param {Array<{lat:number,lng:number}>} points
   * @returns {Array<{lat:number,lng:number}>}
   */
  batchWgs84ToGcj02(points) {
    if (!points || !points.length) return [];
    return points.map(p => this._wgs84Gcj02(p));
  }

  /**
   * 创建我的位置标记图标（蓝色实心圆点）
   * 按 heading 取整到 5° 缓存 MarkerImage：定位 marker 高频刷新时避免每帧重建 SVG/解码开销
   */
  _createLocationIcon(heading) {
    const key = (heading != null && !isNaN(heading))
      ? `h${Math.round(heading / 5) * 5}`
      : 'none';
    if (!this._locIconCache) this._locIconCache = {};
    if (this._locIconCache[key]) return this._locIconCache[key];

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

    const dataUri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

    this._locIconCache[key] = new qq.maps.MarkerImage(
      dataUri,
      new qq.maps.Size(40, 40),
      new qq.maps.Point(0, 0),
      new qq.maps.Point(20, 20),
      new qq.maps.Size(40, 40)
    );
    return this._locIconCache[key];
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
      // getPosition() 在 marker 初始化/挂载过渡期可能返回 null，加防护避免 TypeError
      const cur = this.locationMarker.getPosition();
      if (!cur) {
        this._stopLocationAnim();
        this.locationMarker.setPosition(latLng);
        return;
      }
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
    if (typeof TrailAnalysis !== 'undefined' && TrailAnalysis.speedLevel) {
      return TrailAnalysis.speedLevel(speed);
    }
    // 极端 fallback：TrailAnalysis 未加载时，依据单一来源速度等级表兜底
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

  /**
   * 当前 zoom 下的视觉抽稀点数上限（方案 C：缩放自适应）
   * zoom 越小（视野越大）需要的点越少；zoom 越大（细节越密）需要的点越多。
   */
  _getZoomLimit() {
    let zoom = 15;
    if (this.map) {
      try {
        const z = this.map.getZoom();
        if (typeof z === 'number') zoom = z;
      } catch (_) {}
    }
    return Math.round(Math.min(
      CONFIG.TRAIL_DECIMATE_MAX_ZOOM_LIMIT,
      Math.max(CONFIG.TRAIL_DECIMATE_MIN_ZOOM_LIMIT,
        CONFIG.TRAIL_DECIMATE_MIN_ZOOM_LIMIT * Math.pow(2, zoom - CONFIG.TRAIL_DECIMATE_ZOOM_BASE))
      )
    );
  }

  /**
   * 轨迹抽稀（均匀 + 缓存）：
   * - 超出 zoom 自适应上限时，按比例均匀抽稀（保留首尾点），视觉形状几乎无损。
   *   （实测对比：均匀抽稀误差为 0，DP 保形算法在平滑轨迹上反而引入拉直误差且慢 30 倍，
   *   故采用均匀抽稀作为默认。）
   * - 抽稀结果按「原始数组引用 + 上限」缓存，重复调用（记录增量/重绘）零成本。
   * @param {Array} positions
   * @param {number} [maxPoints]
   * @returns {Array}
   */
  _decimateTrail(positions, maxPoints) {
    const limit = maxPoints || this._getZoomLimit();
    const n = positions.length;
    if (n <= limit) return positions;
    const cached = this._decimateCache.get(positions);
    if (cached && cached.limit === limit) return cached.points;

    const step = Math.ceil(n / limit);
    const out = [];
    for (let i = 0; i < n; i += step) {
      out.push(positions[i]);
    }
    if (out[out.length - 1] !== positions[n - 1]) {
      out.push(positions[n - 1]);
    }
    // 限容：最多保留 3 条抽稀结果，超限淘汰最旧，避免缓存随大轨迹无限膨胀
    this._decimateCache.set(positions, { limit, points: out });
    if (this._decimateCache.size > 3) {
      const oldest = this._decimateCache.keys().next().value;
      this._decimateCache.delete(oldest);
    }
    return out;
  }

  /**
   * 运行时鬼点清洗：剔除 GPS 跳变尖刺（信号遮挡/多路径导致坐标瞬移的点）。
   * 复用 TrailAnalysis.filterOutliers 判据（相对前后位移均超预期阈值），只读不落库。
   * 若缺依赖/数据异常则原样返回，保证渲染流程不中断。
   */
  _cleanSpikes(positions) {
    if (!Array.isArray(positions) || positions.length < 4) return positions;
    if (typeof TrailAnalysis === 'undefined' || typeof TrailAnalysis.filterOutliers !== 'function') {
      return positions;
    }
    try {
      const cleaned = TrailAnalysis.filterOutliers(positions);
      return cleaned && cleaned.length >= 2 ? cleaned : positions;
    } catch (e) {
      return positions;
    }
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

    // 增量/全量判定：记录模式是同一数组引用持续追加（增量）；加载/平滑/切换是新数组（全量）。
    // 全量场景超限先抽稀，显著降低 polyline 数量与绘制开销；
    // 增量场景保持原数组以维持增量锚点（抽稀会生成新数组导致每次全量重绘回归）。
    const incremental = positions === this._lastTrailInput;
    if (!incremental) {
      // 运行时鬼点清洗：剔除 GPS 跳变尖刺（信号遮挡/多路径导致坐标瞬移的点）。
      // 仅全量路径清洗（历史加载/平滑切换），增量记录不洗以维持锚点。
      // 只读清洗不落库，不污染存储数据。
      positions = this._cleanSpikes(positions);
      const limit = this._getZoomLimit();
      if (positions.length > limit) {
        positions = this._decimateTrail(positions, limit);
      }
    }

    // 增量记录且已有太多 polyline（速度段过密）时，强制做一次全量抽稀重绘，
    // 避免记录长轨迹时 polyline 对象无限增长拖垮地图。
    if (incremental && this.trailPolylines.length > 400) {
      const limit = this._getZoomLimit();
      const decimated = this._decimateTrail(positions, limit);
      if (decimated !== positions) {
        this._lastTrailInput = decimated;
        this.clearTrail();
        positions = decimated;
      }
    }

    // 传入数组引用变化（平滑重算 / 数据加载 / 轨迹切换）时，增量渲染的锚点已失效：
    // 平滑数组每次由 getSmoothedPositions() 新建且所有点坐标随窗口平均变化，
    // 若只追加新段，新旧 polyline 会在锚点处产生断点缝隙。
    // 此时应全量重绘（clearTrail 会重置 _lastTrailCount，from 从 1 开始完整绘制）。
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
    // 兜底：速度等级表与色板 key 若不一致，避免 new qq.maps.Color(undefined,...) 崩溃
    if (!clr || typeof clr.r !== 'number') {
      clr = { r: 0, g: 212, b: 170, a: 0.85 };
    }
    const poly = new qq.maps.Polyline({
      path,
      strokeColor: new qq.maps.Color(clr.r, clr.g, clr.b, clr.a),
      strokeWeight: 3.5,
      map: this.map,
      zIndex: 10 // 记录轨迹线置于回放路径（zIndex 100+）之下，支持并行显示
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

  /* ================================================================
   *  轨迹关键点标记
   * ================================================================ */

  /**
   * 关键点图标（SVG dataURI）—— 弱化显示：纯色小圆点，无滤镜/文字
   * start: 绿色 / end: 红色 / maxSpeed: 橙色
   */
  _createKeyPointIcon(type) {
    const color = {
      start: '#34C759',
      end: '#FF453A',
      maxSpeed: '#FF9500',
    }[type] || '#00A3FF';
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
      `  <circle cx="8" cy="8" r="6" fill="${color}" stroke="#fff" stroke-width="1.5"/>`,
      '</svg>'
    ].join('\n');
    const dataUri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    return new qq.maps.MarkerImage(
      dataUri,
      new qq.maps.Size(16, 16),
      new qq.maps.Point(0, 0),
      new qq.maps.Point(8, 8),
      new qq.maps.Size(16, 16)
    );
  }

  /**
   * 手动分段标记图标（紫色旗帜）
   */
  /**
   * 在地图上标出关键点（起点/终点/最高速）—— 弱化显示，仅小圆点，无弹窗
   * @param {Object} keyPoints analyzeKeyPoints 的输出 {start,end,maxSpeed}
   */
  setTrailMarkers(keyPoints) {
    this.clearTrailMarkers();
    if (!this.map || !keyPoints) return;

    const kpList = [];
    if (keyPoints.start) kpList.push(keyPoints.start);
    if (keyPoints.end) kpList.push(keyPoints.end);
    if (keyPoints.maxSpeed) kpList.push(keyPoints.maxSpeed);

    for (const kp of kpList) {
      if (!kp || !Number.isFinite(kp.lat) || !Number.isFinite(kp.lng)) continue;
      const marker = new qq.maps.Marker({
        position: new qq.maps.LatLng(kp.lat, kp.lng),
        map: this.map,
        icon: this._createKeyPointIcon(kp.type),
        title: kp.label,
        zIndex: 20,
        clickable: false
      });
      this.trailMarkers.push(marker);
    }
  }

  clearTrailMarkers() {
    for (const m of this.trailMarkers) {
      try { m.setMap(null); } catch (_) {}
    }
    this.trailMarkers = [];
    this.clearRealtimeKeyPoints();
  }

  /* ================================================================
   *  实时关键点图层（记录过程中增量更新 起/终/速，不整层重建）
   * ================================================================ */

  /**
   * 记录过程中实时显示关键点（起点 / 终点 / 最高速点）。
   * 只对每个 type 增量更新：不存在则创建，坐标变化超过阈值才 setPosition，
   * label 变化才刷新 title 与 InfoWindow 内容。
   * @param {Object} keyPoints analyzeKeyPoints 的输出 {start,end,maxSpeed}
   */
  setRealtimeKeyPoints(keyPoints) {
    if (!this.map || !keyPoints) return;
    if (this._kpEnabled === false) return;
    this._kpEnabled = true;

    if (!this._kpMarkers) this._kpMarkers = {};

    const defs = [
      { type: 'start', kp: keyPoints.start },
      { type: 'end', kp: keyPoints.end },
      { type: 'maxSpeed', kp: keyPoints.maxSpeed }
    ];

    for (const { type, kp } of defs) {
      if (!kp || !Number.isFinite(kp.lat) || !Number.isFinite(kp.lng)) continue;
      const marker = this._kpMarkers[type];
      if (!marker) {
        const m = new qq.maps.Marker({
          position: new qq.maps.LatLng(kp.lat, kp.lng),
          map: this.map,
          icon: this._createKeyPointIcon(kp.type),
          title: kp.label || '',
          zIndex: 25,
          clickable: false
        });
        this._kpMarkers[type] = m;
        continue;
      }
      const cur = marker.getPosition();
      if (!cur) continue;
      if (Math.abs(cur.lat - kp.lat) > 1e-7 || Math.abs(cur.lng - kp.lng) > 1e-7) {
        marker.setPosition(new qq.maps.LatLng(kp.lat, kp.lng));
      }
      const label = kp.label || '';
      if (marker.getTitle && marker.getTitle() !== label) {
        try { marker.setTitle(label); } catch (_) {}
      }
    }
  }

  /**
   * 清除实时关键点图层（停止记录 / 清空轨迹 / 切回放时调用）
   */
  clearRealtimeKeyPoints() {
    if (this._kpMarkers) {
      for (const type of Object.keys(this._kpMarkers)) {
        try { this._kpMarkers[type].setMap(null); } catch (_) {}
      }
      this._kpMarkers = null;
    }
    this._kpEnabled = false;
  }

  refreshTrailColors(positions) {
    if (!this.map) return;
    if (!Array.isArray(positions) || positions.length < 2) return;
    if (this._themeRefreshRaf) {
      cancelAnimationFrame(this._themeRefreshRaf);
      this._themeRefreshRaf = null;
    }
    this.clearTrail();
    // 视觉抽稀：主题切换是低频全量重绘，为保持与正常显示（setTrail 增量场景全量点）几何完全一致，
    // 抽稀上限固定取 _getZoomLimit() 的最大值（即最高 zoom 的显示密度）。
    // 若沿用 _getZoomLimit()（zoom 较小时仅 2000 点），弯折密集区的点会被抽掉，
    // 导致"切换主题后线段弯折位置/角度与切换前不同"。仅超大轨迹才抽稀保性能。
    const limit = CONFIG.TRAIL_DECIMATE_MAX_ZOOM_LIMIT;
    if (positions.length > limit) {
      positions = this._decimateTrail(positions, limit);
    }
    // 短轨迹：清空后在同一帧内同步重绘，避免逐帧重建造成的闪烁
    if (positions.length <= 3000) {
      this._renderTrailRange(positions, 0, positions.length);
      return;
    }
    // 超长轨迹：从可见中心向外快速分批补全（目标 ~250ms 完成）
    const centerIdx = this._findVisibleCenterIndex(positions);
    this._themeRefreshQueue = {
      positions,
      left: centerIdx,
      right: centerIdx + 1,
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

    const totalPoints = q.positions.length;
    const remainingPoints = (q.left > 0 ? q.left : 0) + (totalPoints - q.right);
    if (remainingPoints <= 0) {
      this._renderRemainingTrail(q);
      this._finishThemeRefresh(q);
      return;
    }

    // 每帧画足量，目标 ~15 帧（≈250ms）内完成全部重绘，避免长时间闪烁
    const batchSize = Math.max(250, Math.ceil(totalPoints / 15));

    const leftEnd = Math.max(0, q.left - batchSize);
    if (leftEnd < q.left) {
      this._renderTrailRange(q.positions, leftEnd, q.left + 1);
      q.left = leftEnd;
    }

    const rightEnd = Math.min(totalPoints, q.right + batchSize);
    if (rightEnd > q.right) {
      this._renderTrailRange(q.positions, q.right, rightEnd);
      q.right = rightEnd;
    }

    if (q.left <= 0 && q.right >= totalPoints) {
      this._finishThemeRefresh(q);
      return;
    }

    this._themeRefreshRaf = requestAnimationFrame(() => this._processThemeRefreshBatch());
  }

  _renderTrailRange(positions, from, to) {
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
        // 与 setTrail 一致：对 >10m 的长段做细分插值，保证主题切换重绘的
        // 线段顶点密度与正常渲染完全相同（避免形态差异）
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
  }

  _renderRemainingTrail(q) {
    if (q.left > 0) {
      this._renderTrailRange(q.positions, 0, q.left + 1);
    }
    if (q.right < q.positions.length) {
      this._renderTrailRange(q.positions, q.right, q.positions.length);
    }
  }

  _finishThemeRefresh(q) {
    q.done = true;
    this._themeRefreshRaf = null;
    this._themeRefreshQueue = null;
  }

  /**
   * 在 canvas 上绘制轨迹缩略图（默认叠加高德瓦片底图，跨域安全；失败自动降级纯色）
   * @param {HTMLCanvasElement} canvas
   * @param {Array} positions 轨迹点 [{lat,lng,speed?}]
   * @param {Object} opts {width,height,title,stats,background,map}
   * @returns {Promise<HTMLCanvasElement>}
   */
  async _drawTrailThumbnail(canvas, positions, opts) {
    if (!positions || positions.length < 2) return canvas;
    const o = opts || {};
    // 视觉抽稀：超大轨迹先抽稀再投影/绘制，避免逐点三角函数与逐段 canvas 绘制卡死
    if (positions.length > CONFIG.THUMB_DECIMATE_MAX_POINTS) {
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

    // 世界坐标（zoom 0）
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const worldPts = positions.map((p) => {
      const wp = { x: p.lng / 360 + 0.5, y: 0.5 - Math.log(Math.tan(Math.PI / 4 + (p.lat * Math.PI / 180) / 2)) / (2 * Math.PI) };
      if (wp.x < minX) minX = wp.x;
      if (wp.y < minY) minY = wp.y;
      if (wp.x > maxX) maxX = wp.x;
      if (wp.y > maxY) maxY = wp.y;
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

    // 地图底图：高德瓦片（GCJ-02 与轨迹同坐标系），失败/禁用时保持纯色背景
    if (o.map !== false) {
      try {
        await this._drawThumbnailTiles(ctx, { padX, padY, W, H, scale, offX, offY });
      } catch (e) {
        if (typeof CONFIG !== 'undefined' && CONFIG.DEBUG) console.warn('[MapManager] 缩略图底图降级纯色:', e && e.message);
      }
    }

    // 速度着色折线
    const colorMap = this._speedColorMap;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let i = 1; i < worldPts.length; i++) {
      const p0 = worldPts[i - 1];
      const p1 = worldPts[i];
      const speed = this._segmentSpeed(positions[i - 1], positions[i]);
      const c = colorMap[this._speedColorKey(speed)] || { r: 0, g: 200, b: 160, a: 0.8 };
      const a = toXY(p0);
      const b = toXY(p1);
      ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${c.a})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // 起点/终点标记
    const start = toXY(worldPts[0]);
    const end = toXY(worldPts[worldPts.length - 1]);
    ctx.fillStyle = '#34C759';
    ctx.beginPath();
    ctx.arc(start.x, start.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FF453A';
    ctx.beginPath();
    ctx.arc(end.x, end.y, 5, 0, Math.PI * 2);
    ctx.fill();

    // 标题
    if (o.title) {
      ctx.fillStyle = isLight ? '#1c1c1e' : '#e6e6e6';
      ctx.font = '600 20px -apple-system, "PingFang SC", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(o.title, padX, padTop / 2 + 6);
    }

    // 统计信息底部条（距离 / 时长 / 点数）
    if (hasStats) {
      const statsY = H - statsH;
      ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(24, statsY);
      ctx.lineTo(W - 24, statsY);
      ctx.stroke();
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

  /**
   * 为缩略图绘制高德瓦片底图（普通道路图 style=8，GCJ-02 与轨迹同坐标系）
   * fetch + blob 加载避免 canvas 污染；任一张失败整体降级纯色
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} geo {padX,padY,W,H,scale,offX,offY} 绘制区几何
   * @returns {Promise<boolean>} 是否绘制成功
   */
  async _drawThumbnailTiles(ctx, geo) {
    const { padX, padY, W, H, scale, offX, offY } = geo;
    // 支持非对称底部 padding：默认与顶部一致（对称），分享卡片传入 padBottom 限定底部
    const padBottom = geo.padBottom != null ? geo.padBottom : padY;
    const areaHpx = H - padY - padBottom;
    // 绘制区四角世界坐标（Web Mercator 0~1）
    const areaLeft = (padX - offX) / scale;
    const areaRight = (W - padX - offX) / scale;
    const areaTop = (padY - offY) / scale;
    const areaBottom = (H - padBottom - offY) / scale;
    const areaW = Math.max(1e-9, areaRight - areaLeft);

    // 选定层级：瓦片像素分辨率 ≈ 画布分辨率
    let z = Math.round(Math.log2((W - 2 * padX) / (256 * areaW)));
    z = Math.min(18, Math.max(3, z));

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    // 瓦片数量上限 100，超出则降档
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

    // 并发加载全部瓦片
    const jobs = [];
    for (let tx = range.x0; tx <= range.x1; tx++) {
      for (let ty = range.y0; ty <= range.y1; ty++) {
        jobs.push(this._loadMapTile(range.z, tx, ty));
      }
    }
    const results = await Promise.allSettled(jobs);
    if (!results.every((r) => r.status === 'fulfilled')) return false;
    const imgs = results.map((r) => r.value);

    // 绘制（与轨迹投影严格对齐，边缘 +1px 防缝隙）
    // 世界 0~1 投影下瓦片覆盖宽度 1/n，画布目标宽度 = scale/n（≈256px，由 zoom 选择保证）
    const n = 1 << range.z;
    const tilePx = scale / n;
    ctx.save();
    ctx.beginPath();
    ctx.rect(padX, padY, W - 2 * padX, areaHpx);
    ctx.clip();
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

  /**
   * 加载地图瓦片（GCJ-02 与轨迹同坐标系）
   * 主源：高德 webrd01-04 节点（style=8 普通道路图，已验证稳定返回有效图）
   * 每次成功解码都会做「占位图」校验：部分服务端会返回可正常解码的纯色占位图，
   * 若不校验会误当成有效瓦片导致底图纯色。
   * fetch + blob 加载避免 canvas 污染（PNG 可正常导出）；带内存缓存与超时
   * @param {number} z 瓦片层级
   * @param {number} x 瓦片列号
   * @param {number} y 瓦片行号
   * @returns {Promise<HTMLImageElement>}
   */
  _loadMapTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (this._tileCache && this._tileCache.get(key)) return this._tileCache.get(key);
    const task = (async () => {
      // 主源：腾讯地图矢量瓦片 realtimerender（rt0-rt3 节点，GCJ-02 与轨迹同坐标系，与应用显示底图一致）
      // 备源：腾讯地图 tile 接口（rt0-rt3 节点）；各子域负载均衡
      // 兜底：高德 webrd01-04 节点（scale=2 → scale=1 两级降级）
      // 注意：腾讯瓦片使用 TMS 坐标（y 轴从南向北），入参 y 为标准 XYZ（y 向下），
      //       请求前必须翻转：yTms = (1 << z) - 1 - y。否则会请求到南半球无数据区，
      //       服务端返回 1712 字节单色占位图。maptilesv2 接口实测不可用，不作为备源。
      //       高德为标准 XYZ（y 向下），不翻转。
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

  /**
   * 抓取单个瓦片并解码为图片（fetch + blob + objectURL，避免 canvas 污染）
   * @param {string} url 瓦片 URL
   * @param {number} timeoutMs 超时毫秒
   * @returns {Promise<HTMLImageElement>}
   */
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
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 判断瓦片是否为纯色占位图（腾讯等服务端来源校验失败时返回的 1714 字节单色 JPEG）
   * 采样四角 + 中心像素，若全部为同一颜色则判定为占位图。
   * @param {HTMLImageElement} img 已解码的瓦片图片
   * @returns {boolean}
   */
  _isPlaceholderTile(img) {
    try {
      if (!img || !img.width || !img.height) return true;
      const c = document.createElement('canvas');
      // 用瓦片原始尺寸绘制，避免缩放下采样混淆纯色判定
      c.width = img.width;
      c.height = img.height;
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
        if (data[i] !== first[0] || data[i + 1] !== first[1] ||
            data[i + 2] !== first[2] || data[i + 3] !== first[3]) {
          return false; // 有颜色差异，是真实地图
        }
      }
      return true; // 五个采样点同色 → 纯色占位图
    } catch (e) {
      return false; // 校验失败时保守放行，避免误降级
    }
  }

  /**
   * 离线生成轨迹缩略图（默认叠加地图底图）
   * @param {Array} positions 轨迹点 [{lat,lng,speed?}]
   * @param {Object} opts {width,height,title,stats,background,map}
   * @returns {Promise<string|null>} PNG dataURL，失败返回 null
   */
  async renderTrailThumbnail(positions, opts) {
    if (!positions || positions.length < 2) return null;
    const o = opts || {};
    const W = o.width || 800;
    const H = o.height || 500;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    await this._drawTrailThumbnail(canvas, positions, o);
    try {
      return canvas.toDataURL('image/png');
    } catch (e) {
      console.warn('[MapManager] 缩略图导出失败:', e.message);
      return null;
    }
  }

  /**
   * 将多条轨迹渲染成一张纵向长图（解决批量导出被浏览器拦截多文件下载的问题）
   * @param {Array} items [{positions, name, stats}]
   * @param {Object} opts {width,thumbHeight}
   * @returns {Promise<string|null>} PNG dataURL，失败返回 null
   */
  async renderTrailCollage(items, opts) {
    if (!items || items.length === 0) return null;
    const o = opts || {};
    const W = o.width || 800;
    const gap = 34;
    const titleH = 72;
    const padBottom = 40;
    // 轨迹较多时自适应缩小缩略图高度，避免超出浏览器 canvas 尺寸上限
    let thumbH = o.thumbHeight || 500;
    const estTotal = titleH + items.length * (thumbH + gap) + padBottom;
    if (estTotal > 15000) {
      thumbH = Math.max(260, Math.floor((15000 - titleH - padBottom) / items.length) - gap);
    }
    const totalH = titleH + items.length * (thumbH + gap) + padBottom;

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = totalH;
    const ctx = canvas.getContext('2d');

    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    ctx.fillStyle = isLight ? '#eef1f5' : '#0b0e14';
    ctx.fillRect(0, 0, W, totalH);

    // 合集标题
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
      panel.width = W;
      panel.height = thumbH;
      await this._drawTrailThumbnail(panel, it.positions, {
        title: it.name || `轨迹 ${i + 1}`,
        stats: it.stats
      });
      ctx.drawImage(panel, 0, y, W, thumbH);
      y += thumbH + gap;
      if (i < items.length - 1) {
        ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(26, y - 6);
        ctx.lineTo(W - 26, y - 6);
        ctx.stroke();
        ctx.fillStyle = isLight ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.28)';
        ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${i + 1}. ${it.name || ''}`, 26, y - 16);
      }
    }

    // 底部免责注记
    ctx.fillStyle = isLight ? 'rgba(0,0,0,0.28)' : 'rgba(255,255,255,0.24)';
    ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('注：底图较老，仅供参考使用', 26, totalH - 16);

    try {
      return canvas.toDataURL('image/png');
    } catch (e) {
      console.warn('[MapManager] 轨迹合集导出失败:', e.message);
      return null;
    }
  }

  /**
   * 截断文本，超出最大宽度以省略号结尾（canvas 标题防溢出）
   */
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

  /**
   * 生成方形一键分享卡片（1080×1080，高 DPR 自动放大）
   * 顶部渐变标题 + 瓦片底图速度着色轨迹 + 底部统计 + 品牌水印。
   * 复用 _drawThumbnailTiles 瓦片底图与 _speedColorMap 速度着色，跨域安全。
   * @param {Object} trail {positions, name, createdAt}
   * @param {Object} [opts] {width,height,title,subtitle,stats,background,map}
   * @returns {Promise<string|null>} PNG dataURL，失败返回 null
   */
  async renderShareCard(trail, opts) {
    if (!trail || !trail.positions || trail.positions.length < 2) return null;
    const o = opts || {};
    const positions = trail.positions;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = o.width || 1080;
    const H = o.height || 1080;
    const S = dpr;
    const canvas = document.createElement('canvas');
    canvas.width = W * S;
    canvas.height = H * S;
    const ctx = canvas.getContext('2d');
    ctx.scale(S, S);

    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const bg = o.background || (isLight ? '#f3f5f9' : '#0d1117');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 轨迹世界坐标（Web Mercator，zoom 0）与绘制区几何
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const worldPts = positions.map((p) => {
      const wp = {
        x: p.lng / 360 + 0.5,
        y: 0.5 - Math.log(Math.tan(Math.PI / 4 + (p.lat * Math.PI / 180) / 2)) / (2 * Math.PI)
      };
      if (wp.x < minX) minX = wp.x;
      if (wp.y < minY) minY = wp.y;
      if (wp.x > maxX) maxX = wp.x;
      if (wp.y > maxY) maxY = wp.y;
      return wp;
    });

    const worldW = Math.max(1e-9, maxX - minX);
    const worldH = Math.max(1e-9, maxY - minY);
    const padX = o.padX || 56;
    const padTop = o.padTop || 130;
    const padBottom = o.padBottom || 320;
    // 轨迹范围四周扩展缓冲比例：起/终点标记（半径 9×DPR）不会贴在绘制区边缘
    const bufferRatio = (o.bufferRatio != null && o.bufferRatio > 0) ? o.bufferRatio : 0.18;
    const extX = worldW * bufferRatio;
    const extY = worldH * bufferRatio;
    const bMinX = minX - extX;
    const bMaxX = maxX + extX;
    const bMinY = minY - extY;
    const bMaxY = maxY + extY;
    const bufW = Math.max(1e-9, bMaxX - bMinX);
    const bufH = Math.max(1e-9, bMaxY - bMinY);
    const areaW = W - 2 * padX;
    const areaH = H - padTop - padBottom;
    const scaleX = areaW / bufW;
    const scaleY = areaH / bufH;
    const scale = Math.min(scaleX, scaleY);
    const drawW = bufW * scale;
    const drawH = bufH * scale;
    // 居中于「轨迹绘制区」（padX..W-padX / padTop..H-padBottom），而非整个画布：
    // 顶部标题区(padTop)与底部统计面板(padBottom)不对称，若按画布中心居中，
    // 轨迹会整体偏下、起终点顶到统计面板/瓦片可视区边缘。
    const offX = padX + (areaW - drawW) / 2 - bMinX * scale;
    const offY = padTop + (areaH - drawH) / 2 - bMinY * scale;
    const toXY = (wp) => ({ x: wp.x * scale + offX, y: wp.y * scale + offY });

    // 地图底图（失败自动降级纯色）；padBottom 使瓦片裁剪区与轨迹绘制区严格一致，
    // 避免瓦片底部延伸到统计面板区域、以及轨迹起终点贴到瓦片可视边缘
    if (o.map !== false) {
      try {
        await this._drawThumbnailTiles(ctx, { padX, padY: padTop, W, H, scale, offX, offY, padBottom });
      } catch (e) {
        if (typeof CONFIG !== 'undefined' && CONFIG.DEBUG) console.warn('[MapManager] 分享卡片底图降级纯色:', e && e.message);
      }
    }

    // 顶部渐变遮罩：压暗地图、衬托标题
    const headerGrad = ctx.createLinearGradient(0, 0, 0, padTop);
    headerGrad.addColorStop(0, isLight ? 'rgba(243,245,249,0.96)' : 'rgba(13,17,23,0.94)');
    headerGrad.addColorStop(1, isLight ? 'rgba(243,245,249,0.30)' : 'rgba(13,17,23,0.25)');
    ctx.fillStyle = headerGrad;
    ctx.fillRect(0, 0, W, padTop);

    // 标题
    const title = this._truncateText(ctx, o.title || trail.name || '途刻轨迹', W - 2 * padX);
    ctx.fillStyle = isLight ? '#14181f' : '#ffffff';
    ctx.font = `700 ${32 * S}px "HarmonyOS Sans", "PingFang SC", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(title, padX, 52);

    // 副标题（日期）
    const subtitle = o.subtitle || this._fmtShareDate(trail.createdAt);
    if (subtitle) {
      ctx.fillStyle = isLight ? 'rgba(20,24,31,0.55)' : 'rgba(255,255,255,0.55)';
      ctx.font = `${18 * S}px "HarmonyOS Sans", "PingFang SC", sans-serif`;
      ctx.fillText(subtitle, padX, 94);
    }

    // 速度着色轨迹折线
    const colorMap = this._speedColorMap;
    ctx.lineWidth = 8 * S;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let i = 1; i < worldPts.length; i++) {
      const p0 = worldPts[i - 1];
      const p1 = worldPts[i];
      const speed = this._segmentSpeed(positions[i - 1], positions[i]);
      const c = colorMap[this._speedColorKey(speed)] || { r: 0, g: 200, b: 160, a: 0.9 };
      const a = toXY(p0);
      const b = toXY(p1);
      ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${c.a})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // 起点/终点标记
    const startPt = toXY(worldPts[0]);
    const endPt = toXY(worldPts[worldPts.length - 1]);
    ctx.fillStyle = '#34C759';
    ctx.beginPath();
    ctx.arc(startPt.x, startPt.y, 9 * S, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FF453A';
    ctx.beginPath();
    ctx.arc(endPt.x, endPt.y, 9 * S, 0, Math.PI * 2);
    ctx.fill();

    // 底部统计区
    const stats = o.stats || (() => {
      let distance = 0;
      for (let i = 1; i < positions.length; i++) distance += calcDistance(positions[i - 1], positions[i]);
      let duration = 0;
      const f = positions[0];
      const l = positions[positions.length - 1];
      if (f && l && f.time && l.time && l.time > f.time) duration = l.time - f.time;
      let maxSpeed = 0;
      for (const p of positions) { if (p.speed != null && p.speed > maxSpeed) maxSpeed = p.speed; }
      const avgSpeed = duration > 0 ? distance / (duration / 1000) : 0;
      return { distance, duration, points: positions.length, maxSpeed, avgSpeed };
    })();

    const panelY = H - 240;
    const panelH = 240;
    ctx.fillStyle = isLight ? 'rgba(255,255,255,0.92)' : 'rgba(22,27,34,0.92)';
    ctx.beginPath();
    ctx.roundRect(32, panelY - 26, W - 64, panelH, 24);
    ctx.fill();

    // 距离（大字）+ 时长/均速/最高速/点数
    const fmtSpeed = (v) => (v > 0 ? (v * 3.6).toFixed(1) + ' km/h' : '--');
    const statCols = [
      { label: '距离', value: formatDistance(stats.distance), big: true },
      { label: '时长', value: formatDurationShort(stats.duration), big: false },
      { label: '均速', value: fmtSpeed(stats.avgSpeed), big: false },
      { label: '最高速', value: fmtSpeed(stats.maxSpeed), big: false },
      { label: '点数', value: String(stats.points), big: false }
    ];
    const colW = (W - 64) / statCols.length;
    statCols.forEach((col, i) => {
      const cx = 32 + colW * i + colW / 2;
      const top = panelY + 24;
      ctx.textAlign = 'center';
      ctx.fillStyle = isLight ? 'rgba(20,24,31,0.5)' : 'rgba(255,255,255,0.5)';
      ctx.font = `${15 * S}px "HarmonyOS Sans", "PingFang SC", sans-serif`;
      ctx.fillText(col.label, cx, top);
      ctx.fillStyle = isLight ? '#14181f' : '#ffffff';
      ctx.font = col.big ? `700 ${26 * S}px "HarmonyOS Sans", sans-serif` : `700 ${22 * S}px "HarmonyOS Sans", sans-serif`;
      ctx.fillText(col.value, cx, top + 44);
      ctx.textAlign = 'left';
    });

    // 品牌水印 + 底图免责注记
    const watermarkY = H - 40;
    ctx.textAlign = 'right';
    ctx.fillStyle = isLight ? 'rgba(20,24,31,0.35)' : 'rgba(255,255,255,0.30)';
    ctx.font = `${17 * S}px "HarmonyOS Sans", "PingFang SC", sans-serif`;
    ctx.fillText('途刻 TraceCraft', W - 40, watermarkY);
    ctx.fillStyle = isLight ? 'rgba(20,24,31,0.28)' : 'rgba(255,255,255,0.24)';
    ctx.font = `${13 * S}px "HarmonyOS Sans", "PingFang SC", sans-serif`;
    ctx.fillText('注：底图较老，仅供参考使用', W - 40, watermarkY - 26 * S);
    ctx.textAlign = 'left';

    try {
      return canvas.toDataURL('image/png');
    } catch (e) {
      console.warn('[MapManager] 分享卡片导出失败:', e.message);
      return null;
    }
  }

  /**
   * 销毁地图实例
   */
  destroy() {
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    // 清理定时器 / 动画帧 / 缓存，避免销毁后仍有任务运行与内存滞留
    if (this._zoomDecimateTimer) {
      clearTimeout(this._zoomDecimateTimer);
      this._zoomDecimateTimer = null;
    }
    if (this._themeRefreshRaf) {
      cancelAnimationFrame(this._themeRefreshRaf);
      this._themeRefreshRaf = null;
    }
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this._overlayRafId) {
      cancelAnimationFrame(this._overlayRafId);
      this._overlayRafId = null;
    }
    if (this._tileCache) {
      this._tileCache.clear();
      this._tileCache = null;
    }
    if (this._decimateCache) {
      this._decimateCache.clear();
      this._decimateCache = null;
    }
    if (this._coordCache) {
      this._coordCache.clear();
      this._coordCache = null;
    }
    if (this._locIconCache) {
      this._locIconCache = null;
    }
    this._stopLocationAnim();
    this.clearTrail();
    this.clearTrailMarkers();
    this.clearRealtimeKeyPoints();
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
