/**
 * 轨迹回放播放器（Canvas 版本）
 * =============================================
 * 支持多倍速回放（1x, 2x, 5x, 10x）
 * 使用 requestAnimationFrame 进行时间插值回放
 * 所有可视化元素通过 Canvas 绘制，不依赖 qq.maps 叠加对象
 */

class TrailPlayer {
  /**
   * @param {Array<{lat:number,lng:number,time?:number,speed?:number,heading?:number}>} positions
   * @param {MapManager} mapManager
   * @param {Object} [callbacks]
   * @param {Function} [callbacks.onProgress] - 进度回调 (0~1)
   * @param {Function} [callbacks.onComplete] - 回放完成回调
   * @param {Function} [callbacks.onFrame] - 每帧回调 (currentPoint, index)
   */
  constructor(positions, mapManager, callbacks = {}, signalLoss = null) {
    this.positions = Array.isArray(positions)
      ? positions.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng))
      : [];
    if (this.positions.length >= 4
      && typeof TrailAnalysis !== 'undefined'
      && typeof TrailAnalysis.filterOutliers === 'function') {
      try {
        const cleaned = TrailAnalysis.filterOutliers(this.positions);
        if (cleaned && cleaned.length >= 2) this.positions = cleaned;
      } catch (e) {}
    }
    this.mapManager = mapManager;
    this.callbacks = callbacks;
    this._signalLossSet = (signalLoss && signalLoss.segments)
      ? (() => { const s = new Set(); for (const seg of signalLoss.segments) for (let i = seg.startIdx; i <= seg.endIdx; i++) s.add(i); return s; })()
      : null;

    this.speed = 1;
    this.isPlaying = false;
    this.isPaused = false;
    this._rafId = null;

    this._currentIndex = 0;
    this._lastIndex = 0;
    this._playbackTime = 0;
    this._lastFrameTime = 0;
    this._accumulatedTime = 0;

    this._replayMarkerPos = null;
    this._replayMarkerHeading = null;
    this._replayPathSegments = [];
    this._playedPathSegments = [];

    this._markerDisplayPos = null;
    this._markerTargetPos = null;
    this._markerAnimating = false;
    this._markerHeading = null;

    this._hasTimestamps = this._checkTimestamps();
    this._segStartTimes = this._buildSegStartTimes();
    this._totalDuration = this._calcTotalDuration();
    this._totalDistance = this._calcTotalDistance();

    if (this.mapManager && this.positions.length > CONFIG.REPLAY_DECIMATE_MAX_POINTS) {
      this._renderPositions = this.mapManager._decimateTrail(this.positions, CONFIG.REPLAY_DECIMATE_MAX_POINTS);
    } else {
      this._renderPositions = this.positions;
    }
    this._renderCount = this._renderPositions.length;

    this._setupMapMarkers();
  }

  _buildSegStartTimes() {
    const positions = this.positions;
    if (!this._hasTimestamps) return null;
    const n = positions.length;
    const baseTime = positions[0].time || 0;
    const times = new Array(n);
    times[0] = 0;
    let acc = 0;
    for (let i = 0; i < n - 1; i++) {
      const segStart = (positions[i].time || baseTime) - baseTime;
      const segEnd = (positions[i + 1].time || baseTime) - baseTime;
      const segDuration = Math.max(0, segEnd - segStart);
      acc += segDuration;
      times[i + 1] = acc;
    }
    return times;
  }

  _checkTimestamps() {
    if (!this.positions || this.positions.length < 2) return false;
    let count = 0;
    for (const p of this.positions) { if (p.time && p.time > 0) count++; }
    return count >= this.positions.length * 0.5;
  }

  _calcTotalDuration() {
    if (!this._hasTimestamps) return this.positions.length * 2000;
    if (this._segStartTimes && this._segStartTimes.length) {
      return Math.max(100, this._segStartTimes[this._segStartTimes.length - 1]);
    }
    const first = this.positions[0].time || 0;
    const last = this.positions[this.positions.length - 1].time || 0;
    return Math.max(100, last - first);
  }

  _calcTotalDistance() {
    let total = 0;
    for (let i = 1; i < this.positions.length; i++) {
      total += calcDistance(
        { lat: this.positions[i - 1].lat, lng: this.positions[i - 1].lng },
        { lat: this.positions[i].lat, lng: this.positions[i].lng }
      );
    }
    return total;
  }

  /**
   * 初始化回放标记状态（Canvas 版本，不再创建 qq.maps.Marker）
   */
  _setupMapMarkers() {
    if (!this.positions || this.positions.length === 0) {
      this._hasPositions = false;
      return;
    }
    this._hasPositions = true;

    const initHeading = this.positions.length >= 2
      ? calcBearing(this.positions[0], this.positions[1])
      : 0;
    this._markerHeading = initHeading;

    this._replayMarkerPos = { lat: this.positions[0].lat, lng: this.positions[0].lng };
    this._replayMarkerHeading = initHeading;
    this._markerDisplayPos = { lat: this.positions[0].lat, lng: this.positions[0].lng };
    this._markerTargetPos = { lat: this.positions[0].lat, lng: this.positions[0].lng };

    if (this._renderPositions.length >= 2) {
      this._buildReplayPathSegments();
    }

    this._updatePlayedPath();

    if (this.mapManager) {
      this.mapManager._activeTrailPlayer = this;
    }
  }

  /**
   * 构建未播路径的 segment 数组
   */
  _buildReplayPathSegments() {
    const colorMap = Object.assign({}, this.mapManager._speedColorMap, { __loss__: this.mapManager._hexToRgb(CONFIG.SIGNAL_LOSS_GREY) });
    this._replayPathSegments = this._buildSpeedSegments(this._renderPositions)
      .filter(s => s.pts.length >= 2)
      .map((s) => {
        const c = colorMap[s.key] || { r: 0, g: 212, b: 170, a: 0.9 };
        return {
          path: s.pts,
          color: { r: c.r, g: c.g, b: c.b, a: Math.round(c.a * 0.35 * 100) / 100 }
        };
      });
  }

  _buildSpeedSegments(pathPoints) {
    const segments = [];
    let curSeg = null;
    for (let i = 1; i < pathPoints.length; i++) {
      const speed = this.mapManager._segmentSpeed(pathPoints[i - 1], pathPoints[i]);
      let key = this.mapManager._speedColorKey(speed);
      if (this._signalLossSet && this._signalLossSet.has(i)) key = '__loss__';
      if (!curSeg || curSeg.key !== key) {
        curSeg = { key, pts: [pathPoints[i - 1]] };
        segments.push(curSeg);
      }
      curSeg.pts.push(pathPoints[i]);
    }
    return segments;
  }

  /**
   * 更新已播路径的 segment 数组
   */
  _updatePlayedPath() {
    if (this._renderPositions.length < 2) {
      this._playedPathSegments = [];
      if (this.mapManager) this.mapManager._overlayRedraw();
      return;
    }

    const totalIdx = this._currentIndex;
    const totalN = this.positions.length;
    const renderN = this._renderPositions.length;
    const renderIdx = totalN > 1
      ? Math.min(renderN - 1, Math.max(0, Math.round((totalIdx / (totalN - 1)) * (renderN - 1))))
      : 0;

    const currentPoint = this._interpolateAtTime(this._playbackTime);
    const pathPoints = this._renderPositions.slice(0, renderIdx + 2);

    if (renderIdx + 2 >= renderN && currentPoint) {
      const tail = pathPoints[pathPoints.length - 1];
      if (currentPoint.lat !== tail.lat || currentPoint.lng !== tail.lng) {
        pathPoints.push(currentPoint);
      }
    }
    if (pathPoints.length < 2) {
      this._playedPathSegments = [];
      if (this.mapManager) this.mapManager._overlayRedraw();
      return;
    }

    const segments = this._buildSpeedSegments(pathPoints);
    const keySig = segments.map(s => s.key).join('|');

    if (this._playedPathKeySig === keySig && this._playedPathSegments.length === segments.length) {
      const lastSeg = segments[segments.length - 1];
      if (lastSeg && lastSeg.pts.length >= 2 && this._playedPathSegments.length > 0) {
        const colorMap = Object.assign({}, this.mapManager._speedColorMap, { __loss__: this.mapManager._hexToRgb(CONFIG.SIGNAL_LOSS_GREY) });
        const c = colorMap[lastSeg.key] || { r: 255, g: 149, b: 0, a: 0.9 };
        this._playedPathSegments[this._playedPathSegments.length - 1] = {
          path: lastSeg.pts,
          color: c
        };
      }
      if (this.mapManager) this.mapManager._overlayRedraw();
      return;
    }

    this._playedPathKeySig = keySig;
    const colorMap = Object.assign({}, this.mapManager._speedColorMap, { __loss__: this.mapManager._hexToRgb(CONFIG.SIGNAL_LOSS_GREY) });
    this._playedPathSegments = segments
      .filter(s => s.pts.length >= 2)
      .map((s) => {
        const c = colorMap[s.key] || { r: 255, g: 149, b: 0, a: 0.9 };
        return { path: s.pts, color: c };
      });

    if (this.mapManager) this.mapManager._overlayRedraw();
  }

  /**
   * Canvas 绘制回放元素（被 MapManager._overlayRedraw 调用）
   */
  drawOnCanvas(ctx, mapManager) {
    // 未播路径（淡色）
    if (this._replayPathSegments && this._replayPathSegments.length > 0) {
      ctx.lineWidth = 4;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const seg of this._replayPathSegments) {
        const c = seg.color;
        ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${c.a})`;
        this._drawPathOnCanvas(ctx, seg.path, mapManager);
      }
    }
    // 已播路径（全色）
    if (this._playedPathSegments && this._playedPathSegments.length > 0) {
      ctx.lineWidth = 4;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const seg of this._playedPathSegments) {
        const c = seg.color;
        ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${c.a})`;
        this._drawPathOnCanvas(ctx, seg.path, mapManager);
      }
    }
    // 回放标记（橙色圆点 + 箭头）
    if (this._replayMarkerPos) {
      const p = mapManager._latLngToContainerPoint(this._replayMarkerPos);
      if (p) {
        const heading = this._replayMarkerHeading;
        ctx.strokeStyle = 'rgba(255, 149, 0, 0.12)';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(p.x, p.y, 17, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(255, 149, 0, 0.28)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, 13, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#FF9500';
        ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill();
        if (heading != null && !isNaN(heading)) {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(heading * Math.PI / 180);
          ctx.fillStyle = '#FF9500';
          ctx.beginPath();
          ctx.moveTo(0, -18);
          ctx.lineTo(3, -10);
          ctx.lineTo(-3, -10);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      }
    }
  }

  _drawPathOnCanvas(ctx, path, mapManager) {
    if (!path || path.length < 2) return;
    ctx.beginPath();
    const p0 = mapManager._latLngToContainerPoint(path[0]);
    if (!p0) return;
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < path.length; i++) {
      const pt = mapManager._latLngToContainerPoint(path[i]);
      if (pt) ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();
  }

  /**
   * 主题切换后调用：重建已播/未播 segments 以套用新色板
   */
  refreshColors() {
    this._playedPathKeySig = undefined;
    if (this._renderPositions && this._renderPositions.length >= 2) {
      this._buildReplayPathSegments();
    } else {
      this._replayPathSegments = [];
    }
    this._updatePlayedPath();
    if (this.callbacks.onProgress) this.callbacks.onProgress(0);
  }

  destroy() {
    this.stop();
    if (this.mapManager && this.mapManager._activeTrailPlayer === this) {
      this.mapManager._activeTrailPlayer = null;
      this.mapManager._overlayRedraw();
    }
    this._replayMarkerPos = null;
    this._replayPathSegments = [];
    this._playedPathSegments = [];
  }

  setSpeed(speed) { this.speed = speed; }

  seekToProgress(progress) {
    const clampedProgress = Number.isFinite(progress)
      ? Math.max(0, Math.min(1, progress))
      : 0;
    this._playbackTime = clampedProgress * this._totalDuration;
    this._accumulatedTime = this._playbackTime;
    this._currentIndex = this._findIndexAtTime(this._playbackTime);
    const point = this._interpolateAtTime(this._playbackTime);
    this._markerDisplayPos = { lat: point.lat, lng: point.lng };
    this._markerTargetPos = { lat: point.lat, lng: point.lng };
    this._markerLastAnimTime = 0;
    this._updateMarker(point);
    this._updatePlayedPath();
    if (this.callbacks.onProgress) this.callbacks.onProgress(clampedProgress);
  }

  getProgress() {
    if (this._totalDuration <= 0) return 0;
    return Math.min(1, this._playbackTime / this._totalDuration);
  }

  _tick() {
    if (!this.isPlaying) return;

    const now = performance.now();
    const deltaMs = now - this._lastFrameTime;
    this._lastFrameTime = now;

    this._accumulatedTime += deltaMs * this.speed;
    this._playbackTime = Math.min(this._accumulatedTime, this._totalDuration);

    this._currentIndex = this._findIndexAtTime(this._playbackTime);
    const point = this._interpolateAtTime(this._playbackTime);

    this._updateMarker(point);
    this._updatePlayedPath();

    const progress = this._playbackTime / this._totalDuration;
    if (this.callbacks.onProgress) this.callbacks.onProgress(Math.min(1, progress));
    if (this.callbacks.onFrame) this.callbacks.onFrame(point, this._currentIndex);

    if (this._playbackTime >= this._totalDuration) {
      this._currentIndex = this.positions.length - 1;
      this._playbackTime = this._totalDuration;
      this._updateMarker(this._interpolateAtTime(this._totalDuration));
      this._updatePlayedPath();
      this.isPlaying = false;
      if (this.callbacks.onComplete) this.callbacks.onComplete();
      return;
    }

    this._rafId = requestAnimationFrame(() => this._tick());
  }

  _findIndexAtTime(timeMs) {
    if (this._hasTimestamps) {
      const times = this._segStartTimes;
      const n = this.positions.length;
      const HEAD_LINEAR = 64;
      const TAIL_LINEAR = 64;
      const MAX_LINEAR_STEPS = 32;
      const GALLOP_CAP = 256;

      const headBound = times[Math.min(HEAD_LINEAR, n - 1)];
      const tailBound = times[Math.max(0, n - 1 - TAIL_LINEAR)];

      if (timeMs <= headBound) {
        let start = this._lastIndex;
        if (start > HEAD_LINEAR + MAX_LINEAR_STEPS) start = this._binarySearch(timeMs);
        let idx = Math.min(Math.max(start, 0), n - 1);
        if (timeMs >= times[idx]) {
          while (idx + 1 < n && times[idx + 1] <= timeMs) idx++;
        } else {
          while (idx > 0 && times[idx] > timeMs) idx--;
        }
        this._lastIndex = idx;
        return idx;
      }

      if (timeMs >= tailBound) {
        let start = this._lastIndex;
        if (start < n - 1 - TAIL_LINEAR - MAX_LINEAR_STEPS) start = this._binarySearch(timeMs);
        let idx = Math.min(Math.max(start, 0), n - 1);
        if (timeMs >= times[idx]) {
          while (idx + 1 < n && times[idx + 1] <= timeMs) idx++;
        } else {
          while (idx > 0 && times[idx] > timeMs) idx--;
        }
        this._lastIndex = idx;
        return idx;
      }

      const last = this._lastIndex;
      if (last >= 0 && last < n) {
        if (timeMs >= times[last]) {
          let hi = last, gap = 1;
          while (hi + gap < n && times[hi + gap] <= timeMs && gap <= GALLOP_CAP) { hi += gap; gap *= 2; }
          if (gap > GALLOP_CAP) { const lo = this._binarySearch(timeMs); this._lastIndex = lo; return lo; }
          if (gap === 1) { this._lastIndex = hi; return hi; }
          let lo = hi; let r = Math.min(hi + gap, n - 1);
          while (lo < r) { const mid = (lo + r + 1) >> 1; if (times[mid] <= timeMs) lo = mid; else r = mid - 1; }
          this._lastIndex = lo; return lo;
        } else {
          let lo = last, gap = 1;
          while (lo - gap >= 0 && times[lo - gap] > timeMs && gap <= GALLOP_CAP) { lo -= gap; gap *= 2; }
          if (gap > GALLOP_CAP) { const r = this._binarySearch(timeMs); this._lastIndex = r; return r; }
          if (gap === 1) { const r = Math.max(0, lo - 1); this._lastIndex = r; return r; }
          let a = Math.max(0, lo - gap); let b = lo;
          while (a < b) { const mid = (a + b + 1) >> 1; if (times[mid] <= timeMs) a = mid; else b = mid - 1; }
          this._lastIndex = a; return a;
        }
      }

      const lo = this._binarySearch(timeMs);
      this._lastIndex = lo;
      return lo;
    } else {
      const segDuration = 2000;
      return Math.min(this.positions.length - 1, Math.floor(timeMs / segDuration));
    }
  }

  _binarySearch(timeMs) {
    const times = this._segStartTimes;
    const n = this.positions.length;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= timeMs) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  _interpolateAtTime(timeMs) {
    const positions = this.positions;
    if (positions.length < 2) return positions[0] || { lat: 0, lng: 0 };

    let idx = 0;
    let progress = 0;

    if (this._hasTimestamps) {
      idx = Math.min(this._findIndexAtTime(timeMs), positions.length - 2);
      const times = this._segStartTimes;
      const segStart = times[idx];
      const segEnd = times[idx + 1];
      const segDuration = Math.max(1, segEnd - segStart);
      progress = Math.min(1, Math.max(0, (timeMs - segStart) / segDuration));
    } else {
      const segDuration = 2000;
      idx = Math.min(positions.length - 2, Math.floor(timeMs / segDuration));
      progress = (timeMs % segDuration) / segDuration;
    }

    const p0 = positions[idx];
    const p1 = positions[Math.min(idx + 1, positions.length - 1)];

    const dispSpeed = (() => {
      const dtMs = (p1.time || 0) - (p0.time || 0);
      if (dtMs < 250) return null;
      const d = calcDistance({ lat: p0.lat, lng: p0.lng }, { lat: p1.lat, lng: p1.lng });
      return d / (dtMs / 1000);
    })();
    const gpsSpeed = p0.speed != null ? Math.max(0, p0.speed) : (p1.speed != null ? Math.max(0, p1.speed) : null);

    const STATIONARY_SPEED = 0.3;
    let speed = 0;
    if (dispSpeed != null && gpsSpeed != null) {
      speed = Math.min(dispSpeed, gpsSpeed) < STATIONARY_SPEED ? 0 : Math.max(dispSpeed, gpsSpeed);
    } else if (gpsSpeed != null) {
      speed = gpsSpeed < STATIONARY_SPEED ? 0 : gpsSpeed;
    } else if (dispSpeed != null) {
      speed = dispSpeed < STATIONARY_SPEED ? 0 : dispSpeed;
    }

    return {
      lat: p0.lat + (p1.lat - p0.lat) * progress,
      lng: p0.lng + (p1.lng - p0.lng) * progress,
      time: (p0.time || 0) + ((p1.time || 0) - (p0.time || 0)) * progress,
      speed,
      heading: p0.heading != null ? p0.heading : (p1.heading || 0)
    };
  }

  /**
   * 更新回放标记位置（Canvas 版本，不再操作 qq.maps.Marker）
   */
  _updateMarker(point) {
    if (!this._replayMarkerPos) return;

    const nextIdx = this._currentIndex + 1;
    const nextPos = this.positions[Math.min(nextIdx, this.positions.length - 1)];
    if (nextPos && (Math.abs(nextPos.lat - point.lat) > 1e-8 || Math.abs(nextPos.lng - point.lng) > 1e-8)) {
      const heading = calcBearing(point, nextPos);
      if (this._markerHeading == null || Math.abs(heading - this._markerHeading) >= 5) {
        this._markerHeading = heading;
        this._replayMarkerHeading = heading;
      }
    }

    const target = { lat: point.lat, lng: point.lng };
    this._markerTargetPos = target;

    if (!this._markerDisplayPos) {
      this._markerDisplayPos = { lat: target.lat, lng: target.lng };
      this._replayMarkerPos = { lat: target.lat, lng: target.lng };
      this.mapManager._overlayRedraw();
      return;
    }

    const now = performance.now();
    const dt = now - (this._markerLastAnimTime || now);
    this._markerLastAnimTime = now;

    const speedFactor = Math.max(0.5, Math.min(this.speed, 4));
    const smoothing = 1 - Math.exp(-dt / (16 / speedFactor));

    this._markerDisplayPos.lat += (target.lat - this._markerDisplayPos.lat) * smoothing;
    this._markerDisplayPos.lng += (target.lng - this._markerDisplayPos.lng) * smoothing;

    this._replayMarkerPos = { lat: this._markerDisplayPos.lat, lng: this._markerDisplayPos.lng };
    this.mapManager._overlayRedraw();
  }

  play() {
    if (!this.positions || this.positions.length < 2) return;
    if (this._currentIndex >= this.positions.length - 1) {
      this._currentIndex = 0;
      this._lastIndex = 0;
      this._playbackTime = 0;
      this._accumulatedTime = 0;
      this._markerDisplayPos = null;
      this._markerTargetPos = null;
      this._markerLastAnimTime = 0;
      this._markerHeading = null;
      this._playedPathSegments = [];
      this._updateMarker(this.positions[0]);
    }

    this.isPlaying = true;
    this.isPaused = false;
    this._lastFrameTime = performance.now();
    this._tick();
  }

  pause() {
    this.isPlaying = false;
    this.isPaused = true;
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
  }

  stop() {
    this.isPlaying = false;
    this.isPaused = false;
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    this._currentIndex = 0;
    this._lastIndex = 0;
    this._playbackTime = 0;
    this._accumulatedTime = 0;
    this._markerDisplayPos = null;
    this._markerTargetPos = null;
    this._markerLastAnimTime = 0;
    this._updateMarker(this.positions[0]);
    this._updatePlayedPath();
  }

  getCurrentInfo() {
    const point = this._interpolateAtTime(this._playbackTime);
    const elapsedMs = this._playbackTime;
    const remainingMs = Math.max(0, this._totalDuration - this._playbackTime);
    return {
      elapsedMs,
      remainingMs,
      progress: this.getProgress(),
      currentSpeed: point.speed || 0,
      currentHeading: point.heading || 0,
      currentPoint: point,
      distance: this._totalDistance
    };
  }

  static formatDuration(ms) {
    if (ms <= 0) return '00:00';
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
}
