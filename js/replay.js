/**
 * 轨迹回放播放器
 * =============================================
 * 支持多倍速回放（1x, 1.5x, 2x, 4x）
 * 使用 requestAnimationFrame 进行时间插值回放
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
  constructor(positions, mapManager, callbacks = {}) {
    this.positions = positions;
    this.mapManager = mapManager;
    this.callbacks = callbacks;

    this.speed = 1;
    this.isPlaying = false;
    this.isPaused = false;
    this._rafId = null;

    this._currentIndex = 0;
    this._playbackTime = 0;
    this._lastFrameTime = 0;
    this._accumulatedTime = 0;

    this._replayMarker = null;
    this._replayPathPolyline = null;

    this._markerDisplayPos = null;
    this._markerTargetPos = null;
    this._markerAnimating = false;
    this._markerHeading = null;

    this._hasTimestamps = this._checkTimestamps();
    this._totalDuration = this._calcTotalDuration();
    this._totalDistance = this._calcTotalDistance();

    this._setupMapMarkers();
  }

  _checkTimestamps() {
    if (!this.positions || this.positions.length < 2) return false;
    let count = 0;
    for (const p of this.positions) {
      if (p.time && p.time > 0) count++;
    }
    return count >= this.positions.length * 0.5;
  }

  _calcTotalDuration() {
    if (!this._hasTimestamps) {
      return this.positions.length * 2000;
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

  _setupMapMarkers() {
    if (!this.mapManager.map) return;

    // 初始箭头指向第二个点（若无则朝北）
    const initHeading = this.positions.length >= 2
      ? calcBearing(this.positions[0], this.positions[1])
      : 0;
    this._markerHeading = initHeading;

    this._replayMarker = new qq.maps.Marker({
      position: new qq.maps.LatLng(
        this.positions[0].lat,
        this.positions[0].lng
      ),
      map: this.mapManager.map,
      draggable: false,
      icon: this._createReplayIcon(initHeading)
    });

    this._markerDisplayPos = { lat: this.positions[0].lat, lng: this.positions[0].lng };
    this._markerTargetPos = { lat: this.positions[0].lat, lng: this.positions[0].lng };

    if (this.positions.length >= 2) {
      const path = this.positions.map(
        p => new qq.maps.LatLng(p.lat, p.lng)
      );
      this._replayPathPolyline = new qq.maps.Polyline({
        path,
        strokeColor: new qq.maps.Color(0, 212, 170, 0.3),
        strokeWeight: 4,
        map: this.mapManager.map,
        clickable: false
      });
    }

    this._updatePlayedPath();
  }

  _createReplayIcon(heading) {
    const deg = (heading != null && !isNaN(heading)) ? Number(heading) : 0;
    // 箭头初始朝北（12 点方向），按方位角 deg（正北顺时针）旋转
    const arrow = `<polygon points="20,3 26,15 14,15" fill="#fff" opacity="0.95" transform="rotate(${deg}, 20, 20)"/>`;
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">',
      '  <defs>',
      '    <filter id="replay-glow" x="-50%" y="-50%" width="200%" height="200%">',
      '      <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#FF9500" flood-opacity="0.5"/>',
      '    </filter>',
      '  </defs>',
      '  <circle cx="20" cy="20" r="18" fill="none" stroke="#FF9500" stroke-width="1.5" opacity="0.2"/>',
      '  <circle cx="20" cy="20" r="14" fill="none" stroke="#FF9500" stroke-width="1.5" opacity="0.4"/>',
      '  <circle cx="20" cy="20" r="9" fill="#FF9500" stroke="#fff" stroke-width="2" filter="url(#replay-glow)"/>',
      arrow,
      '</svg>'
    ].join('\n');

    const dataUri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    return new qq.maps.MarkerImage(
      dataUri,
      new qq.maps.Size(40, 40),
      new qq.maps.Point(0, 0),
      new qq.maps.Point(20, 20),
      new qq.maps.Size(40, 40)
    );
  }

  _updatePlayedPath() {
    if (!this.mapManager.map) return;

    const currentPoint = this._interpolateAtTime(this._playbackTime);
    const pathPoints = this.positions.slice(0, this._currentIndex + 1);
    if (this._currentIndex < this.positions.length - 1 && currentPoint) {
      pathPoints.push(currentPoint);
    }

    if (!this._playedPathPolyline && pathPoints.length >= 2) {
      const playedPath = pathPoints.map(p => new qq.maps.LatLng(p.lat, p.lng));
      this._playedPathPolyline = new qq.maps.Polyline({
        path: playedPath,
        strokeColor: new qq.maps.Color(255, 149, 0, 0.9),
        strokeWeight: 4,
        map: this.mapManager.map,
        clickable: false
      });
    } else if (this._playedPathPolyline) {
      const playedPath = pathPoints.map(p => new qq.maps.LatLng(p.lat, p.lng));
      this._playedPathPolyline.setPath(playedPath);
    }
  }

  play() {
    if (!this.positions || this.positions.length < 2) return;
    if (this._currentIndex >= this.positions.length - 1) {
      this._currentIndex = 0;
      this._playbackTime = 0;
      this._accumulatedTime = 0;
      // 重播需重置 marker 平滑动画状态，否则 marker 会从终点平滑飞回起点
      this._markerDisplayPos = null;
      this._markerTargetPos = null;
      this._markerLastAnimTime = 0;
      this._markerHeading = null;
      if (this._playedPathPolyline) {
        this._playedPathPolyline.setMap(null);
        this._playedPathPolyline = null;
      }
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
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  stop() {
    this.isPlaying = false;
    this.isPaused = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._currentIndex = 0;
    this._playbackTime = 0;
    this._accumulatedTime = 0;
    this._markerDisplayPos = null;
    this._markerTargetPos = null;
    this._markerLastAnimTime = 0;
    this._updateMarker(this.positions[0]);
    this._updatePlayedPath();
    if (this.callbacks.onProgress) {
      this.callbacks.onProgress(0);
    }
  }

  destroy() {
    this.stop();
    if (this._replayMarker) {
      this._replayMarker.setMap(null);
      this._replayMarker = null;
    }
    if (this._replayPathPolyline) {
      this._replayPathPolyline.setMap(null);
      this._replayPathPolyline = null;
    }
    if (this._playedPathPolyline) {
      this._playedPathPolyline.setMap(null);
      this._playedPathPolyline = null;
    }
  }

  setSpeed(speed) {
    this.speed = speed;
  }

  seekToProgress(progress) {
    const clampedProgress = Math.max(0, Math.min(1, progress));
    this._playbackTime = clampedProgress * this._totalDuration;
    this._accumulatedTime = this._playbackTime;
    this._currentIndex = this._findIndexAtTime(this._playbackTime);
    const point = this._interpolateAtTime(this._playbackTime);
    this._markerDisplayPos = { lat: point.lat, lng: point.lng };
    this._markerTargetPos = { lat: point.lat, lng: point.lng };
    this._markerLastAnimTime = 0;
    this._updateMarker(point);
    this._updatePlayedPath();
    if (this.callbacks.onProgress) {
      this.callbacks.onProgress(clampedProgress);
    }
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
    if (this.callbacks.onProgress) {
      this.callbacks.onProgress(Math.min(1, progress));
    }
    if (this.callbacks.onFrame) {
      this.callbacks.onFrame(point, this._currentIndex);
    }

    if (this._playbackTime >= this._totalDuration) {
      this.isPlaying = false;
      if (this.callbacks.onComplete) {
        this.callbacks.onComplete();
      }
      return;
    }

    this._rafId = requestAnimationFrame(() => this._tick());
  }

  _findIndexAtTime(timeMs) {
    if (this._hasTimestamps) {
      const baseTime = this.positions[0].time || 0;
      let accumulated = 0;
      for (let i = 0; i < this.positions.length - 1; i++) {
        const segStart = (this.positions[i].time || baseTime) - baseTime;
        const segEnd = (this.positions[i + 1].time || baseTime) - baseTime;
        const segDuration = Math.max(1, segEnd - segStart);
        if (timeMs <= segEnd) {
          return i;
        }
        accumulated += segDuration;
      }
      return this.positions.length - 1;
    } else {
      const segDuration = 2000;
      return Math.min(
        this.positions.length - 1,
        Math.floor(timeMs / segDuration)
      );
    }
  }

  _interpolateAtTime(timeMs) {
    const positions = this.positions;
    if (positions.length < 2) {
      return positions[0] || { lat: 0, lng: 0 };
    }

    let idx = 0;
    let progress = 0;

    if (this._hasTimestamps) {
      const baseTime = positions[0].time || 0;
      let accumulated = 0;
      for (let i = 0; i < positions.length - 1; i++) {
        const segStart = (positions[i].time || baseTime) - baseTime;
        const segEnd = (positions[i + 1].time || baseTime) - baseTime;
        const segDuration = Math.max(1, segEnd - segStart);

        if (timeMs >= segStart && timeMs <= segEnd) {
          idx = i;
          progress = (timeMs - segStart) / segDuration;
          break;
        }
        accumulated += segDuration;
        idx = i;
        progress = 1;
      }
    } else {
      const segDuration = 2000;
      idx = Math.min(
        positions.length - 2,
        Math.floor(timeMs / segDuration)
      );
      progress = (timeMs % segDuration) / segDuration;
    }

    const p0 = positions[idx];
    const p1 = positions[Math.min(idx + 1, positions.length - 1)];

    return {
      lat: p0.lat + (p1.lat - p0.lat) * progress,
      lng: p0.lng + (p1.lng - p0.lng) * progress,
      time: (p0.time || 0) + ((p1.time || 0) - (p0.time || 0)) * progress,
      speed: p0.speed != null ? p0.speed : (p1.speed || 0),
      heading: p0.heading != null ? p0.heading : (p1.heading || 0)
    };
  }

  _updateMarker(point) {
    if (!this._replayMarker || !this.mapManager.map) return;

    // 箭头指向下一个轨迹点：当前显示点 → 下一原始点
    const nextIdx = this._currentIndex + 1;
    const nextPos = this.positions[Math.min(nextIdx, this.positions.length - 1)];
    if (nextPos && (Math.abs(nextPos.lat - point.lat) > 1e-8 || Math.abs(nextPos.lng - point.lng) > 1e-8)) {
      const heading = calcBearing(point, nextPos);
      // 仅当方向变化超过阈值时才重建图标，避免每帧生成 SVG 的开销
      if (this._markerHeading == null || Math.abs(heading - this._markerHeading) >= 5) {
        this._markerHeading = heading;
        this._replayMarker.setIcon(this._createReplayIcon(heading));
      }
    }

    const target = { lat: point.lat, lng: point.lng };
    this._markerTargetPos = target;

    if (!this._markerDisplayPos) {
      this._markerDisplayPos = { lat: target.lat, lng: target.lng };
      this._replayMarker.setPosition(new qq.maps.LatLng(target.lat, target.lng));
      return;
    }

    const now = performance.now();
    const dt = now - (this._markerLastAnimTime || now);
    this._markerLastAnimTime = now;

    const speedFactor = Math.max(0.5, Math.min(this.speed, 4));
    const smoothing = 1 - Math.exp(-dt / (16 / speedFactor));

    this._markerDisplayPos.lat += (target.lat - this._markerDisplayPos.lat) * smoothing;
    this._markerDisplayPos.lng += (target.lng - this._markerDisplayPos.lng) * smoothing;

    this._replayMarker.setPosition(
      new qq.maps.LatLng(this._markerDisplayPos.lat, this._markerDisplayPos.lng)
    );
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
      distance: this._totalDistance
    };
  }

  static formatDuration(ms) {
    if (ms <= 0) return '00:00';
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
}
