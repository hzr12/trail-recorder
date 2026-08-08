/**
 * 轨迹回放播放器
 * =============================================
 * 支持多倍速回放（1x, 2x, 5x, 10x）
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
    // 复制数组快照：若回放源是当前记录的 trail.positions，记录继续 addPoint 会原地扩展数组，
    // 快照保证回放期间点数固定，不随记录变化而混乱
    // 同时过滤非法坐标点（lat/lng 非有限数），避免插值输出 NaN/null 污染回放
    this.positions = Array.isArray(positions)
      ? positions.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng))
      : [];
    this.mapManager = mapManager;
    this.callbacks = callbacks;

    this.speed = 1;
    this.isPlaying = false;
    this.isPaused = false;
    this._rafId = null;

    this._currentIndex = 0;
    this._lastIndex = 0;   // 线性探测游标：上次查到的段起点索引，用于利用回放帧间时间局部性
    this._playbackTime = 0;
    this._lastFrameTime = 0;
    this._accumulatedTime = 0;

    this._replayMarker = null;
    this._replayPathPolyline = null;
    this._playedPathPolylines = [];   // 已播放路径：按速度分段的 polyline 集合

    this._markerDisplayPos = null;
    this._markerTargetPos = null;
    this._markerAnimating = false;
    this._markerHeading = null;

    this._hasTimestamps = this._checkTimestamps();

    // 预计算每段的累计起始时间偏移表（构造时一次 O(n)，供 _findIndexAtTime / _interpolateAtTime
    // 二分查找，避免回放每帧线性扫描全量点（大数据量轨迹 O(n)/帧 → O(log n)/帧））
    this._segStartTimes = this._buildSegStartTimes();
    // 总时长必须与分段累计表完全一致（见 _calcTotalDuration 注释），否则二分到不了末索引
    this._totalDuration = this._calcTotalDuration();
    this._totalDistance = this._calcTotalDistance();

    // 回放视觉抽稀：超大数据量轨迹对「路径绘制」抽稀，显著降低每帧 slice/分段/建 polyline 开销；
    // marker 位置插值仍用全量 positions（保证精确），仅路径线用抽稀点。
    if (this.mapManager && this.positions.length > 4000) {
      this._renderPositions = this.mapManager._decimateTrail(this.positions, 4000);
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
      // 注意不能用 max(1, ...) 钳制：清洗后轨迹可能出现重复/极小时间戳的相邻点，
      // 钳制会让累计时间膨胀超过 _calcTotalDuration（last - first），
      // 导致二分查找 _findIndexAtTime(_totalDuration) 到达不了末索引，
      // 回放提前停止且末尾留下未播放的浅色路径段。0 时长段会让 times 允许相等，
      // 二分（找最后一个 ≤ timeMs）与插值（progress 归 1）仍正确。
      const segDuration = Math.max(0, segEnd - segStart);
      acc += segDuration;
      times[i + 1] = acc;
    }
    return times;
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
    // 优先取分段累计表末值，保证 _totalDuration 与 _segStartTimes 完全一致：
    // 若用 last - first 独立计算，当末点 time 缺失（被 || 0 归零）时总时长会被算成
    // 极小值，而累计表末值仍是真实总时长，导致 _findIndexAtTime(_totalDuration)
    // 二分到达不了末索引 → 回放提前停止且末尾留下浅色未播段。
    // 取累计表末值后必有 times[n-1] <= _totalDuration，二分恒可达 n-1。
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

    // 未播放路径：按速度等级分段淡色预览（速度分级一目了然，已播放部分会以全色覆盖其上）
    if (this._renderPositions.length >= 2) {
      this._replayPathPolylines = this._buildSpeedSegments(this._renderPositions)
        .filter(s => s.pts.length >= 2)
        .map((s) => {
          const c = this.mapManager._speedColorMap[s.key] || { r: 0, g: 212, b: 170, a: 0.9 };
          return new qq.maps.Polyline({
            path: s.pts.map(p => new qq.maps.LatLng(p.lat, p.lng)),
            strokeColor: new qq.maps.Color(c.r, c.g, c.b, Math.round(c.a * 0.35 * 100) / 100),
            strokeWeight: 4,
            map: this.mapManager.map,
            clickable: false,
            zIndex: 100 // 回放完整路径置顶，避免被记录轨迹线遮挡
          });
        });
    }

    this._updatePlayedPath();
  }

  // 按速度等级分段：把点数组切分为 [{key, pts}]，供未播预览与已播路径共用
  _buildSpeedSegments(pathPoints) {
    const segments = [];
    let curSeg = null;
    for (let i = 1; i < pathPoints.length; i++) {
      const speed = this.mapManager._segmentSpeed(pathPoints[i - 1], pathPoints[i]);
      const key = this.mapManager._speedColorKey(speed);
      if (!curSeg || curSeg.key !== key) {
        curSeg = { key, pts: [pathPoints[i - 1]] };
        segments.push(curSeg);
      }
      curSeg.pts.push(pathPoints[i]);
    }
    return segments;
  }

  _createReplayIcon(heading) {
    // 回放点：橙色实心圆点 + 方向小三角（结构与定位点一致，颜色区分）
    const arrow = (heading != null && !isNaN(heading))
      ? `<polygon points="20,2 23,10 17,10" fill="#FF9500" transform="rotate(${heading}, 20, 20)"/>`
      : '';
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">',
      '  <defs>',
      '    <filter id="replay-shadow" x="-20%" y="-20%" width="140%" height="140%">',
      '      <feDropShadow dx="0" dy="1" stdDeviation="3" flood-opacity="0.5"/>',
      '    </filter>',
      '  </defs>',
      '  <circle cx="20" cy="20" r="17" fill="none" stroke="#FF9500" stroke-width="1.5" opacity="0.12"/>',
      '  <circle cx="20" cy="20" r="13" fill="none" stroke="#FF9500" stroke-width="2" opacity="0.28"/>',
      '  <circle cx="20" cy="20" r="7" fill="#FF9500" stroke="#fff" stroke-width="2.5" filter="url(#replay-shadow)"/>',
      '  <circle cx="20" cy="20" r="2.5" fill="#fff" opacity="0.95"/>',
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
    if (this._renderPositions.length < 2) return;

    // 全量索引 → 抽稀绘制索引（保持首尾对齐）
    const totalIdx = this._currentIndex;
    const totalN = this.positions.length;
    const renderN = this._renderPositions.length;
    const renderIdx = totalN > 1
      ? Math.min(renderN - 1, Math.max(0, Math.round((totalIdx / (totalN - 1)) * (renderN - 1))))
      : 0;

    const currentPoint = this._interpolateAtTime(this._playbackTime);
    const pathPoints = this._renderPositions.slice(0, renderIdx + 1);
    if (renderIdx < renderN - 1 && currentPoint) {
      pathPoints.push(currentPoint);
    }
    if (pathPoints.length < 2) {
      this._clearPlayedPolylines();
      return;
    }

    // 按速度等级分段构建已播路径：段边界处拆分为多条 polyline 并分别着色
    const segments = this._buildSpeedSegments(pathPoints);

    // 用分段 key 序列做增量判断：绝大多数帧分段序列不变（仅最后一个分段在变长），
    // 此时只需对末段 setPath 增量更新，避免每帧重建全部 polyline 造成卡顿。
    const keySig = segments.map(s => s.key).join('|');
    if (this._playedPathKeySig === keySig && this._playedPathPolylines.length === segments.length) {
      // 分段序列未变：仅更新最后一个分段（正在增长的活动段）
      const lastSeg = segments[segments.length - 1];
      if (lastSeg && lastSeg.pts.length >= 2 && this._playedPathPolylines.length > 0) {
        const pl = this._playedPathPolylines[this._playedPathPolylines.length - 1];
        const ll = new qq.maps.LatLng(lastSeg.pts[lastSeg.pts.length - 1].lat, lastSeg.pts[lastSeg.pts.length - 1].lng);
        // 腾讯地图 getPath() 返回 MVCArray（非普通数组，不支持展开运算符），
        // 用其 push() 增量追加顶点；MVCArray.push 会自动触发 polyline 重绘。
        const path = pl.getPath();
        if (path && typeof path.push === 'function') {
          path.push(ll);
        } else if (Array.isArray(path)) {
          pl.setPath([...path, ll]);
        }
      }
      return;
    }

    // 分段序列变化：清理旧分段，重建速度着色路径
    this._playedPathKeySig = keySig;
    this._clearPlayedPolylines();
    const colorMap = this.mapManager._speedColorMap;
    this._playedPathPolylines = segments
      .filter(s => s.pts.length >= 2)
      .map((s) => {
        const c = colorMap[s.key] || { r: 255, g: 149, b: 0, a: 0.9 };
        return new qq.maps.Polyline({
          path: s.pts.map(p => new qq.maps.LatLng(p.lat, p.lng)),
          strokeColor: new qq.maps.Color(c.r, c.g, c.b, c.a),
          strokeWeight: 4,
          map: this.mapManager.map,
          clickable: false,
          zIndex: 101 // 已播路径最高层级，始终盖在记录轨迹之上
        });
      });
  }

  _clearPlayedPolylines() {
    if (this._playedPathPolylines) {
      for (const pl of this._playedPathPolylines) {
        pl.setMap(null);
      }
      this._playedPathPolylines = [];
    }
  }

  _clearReplayPathPolylines() {
    if (this._replayPathPolylines) {
      for (const pl of this._replayPathPolylines) {
        pl.setMap(null);
      }
      this._replayPathPolylines = [];
    }
  }

  play() {
    if (!this.positions || this.positions.length < 2) return;
    if (this._currentIndex >= this.positions.length - 1) {
      this._currentIndex = 0;
      this._lastIndex = 0;
      this._playbackTime = 0;
      this._accumulatedTime = 0;
      // 重播需重置 marker 平滑动画状态，否则 marker 会从终点平滑飞回起点
      this._markerDisplayPos = null;
      this._markerTargetPos = null;
      this._markerLastAnimTime = 0;
      this._markerHeading = null;
      this._clearPlayedPolylines();
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
    this._lastIndex = 0;
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
    this._clearReplayPathPolylines();
    this._clearPlayedPolylines();
  }

  setSpeed(speed) {
    this.speed = speed;
  }

  seekToProgress(progress) {
    // 非有限值（NaN/Infinity）一律按 0 处理，避免污染内部状态
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
      // 线性+二分混合查找：segStartTimes 为递增的累计时间偏移表，定位最后一个 ≤ timeMs 的段起点。
      // 回放/seek 的查询具备强时间局部性（相邻帧 timeMs 通常只前进很小步长），从 _lastIndex
      // 出发线性探测通常 1~3 次比较即命中（O(1)）；探测 miss（如 seek 大跳/时间回退超上限）时
      // 回退到二分兜底，保证最坏情况仍为 O(log n)。
      const times = this._segStartTimes;
      const n = this.positions.length;
      const MAX_LINEAR_STEPS = 32;

      const last = this._lastIndex;
      if (last >= 0 && last < n) {
        let idx = last;
        if (timeMs >= times[idx]) {
          // 时间前进：向后线性探测，跳过所有 ≤ timeMs 的段起点
          let steps = 0;
          while (idx + 1 < n && times[idx + 1] <= timeMs && steps < MAX_LINEAR_STEPS) {
            idx++;
            steps++;
          }
          if (idx + 1 >= n || timeMs < times[idx + 1]) {
            this._lastIndex = idx;
            return idx;
          }
        } else {
          // 时间回退（seek 后退）：向前线性探测
          let steps = 0;
          while (idx > 0 && times[idx] > timeMs && steps < MAX_LINEAR_STEPS) {
            idx--;
            steps++;
          }
          if (times[idx] <= timeMs) {
            this._lastIndex = idx;
            return idx;
          }
        }
      }

      // 兜底：二分查找最后一个 ≤ timeMs 的段起点
      let lo = 0, hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (times[mid] <= timeMs) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      this._lastIndex = lo;
      return lo;
    } else {
      // 无时间戳：固定 2000ms/段，O(1) 定位，无需混合
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
      // 复用 _findIndexAtTime（线性+二分混合）：回放帧/seek 中它刚被调用过，
      // _lastIndex 已定位到正确段，此处线性探测 0 步直接命中，避免二次二分
      idx = Math.min(this._findIndexAtTime(timeMs), positions.length - 2);
      const times = this._segStartTimes;
      const segStart = times[idx];
      const segEnd = times[idx + 1];
      const segDuration = Math.max(1, segEnd - segStart);
      progress = Math.min(1, Math.max(0, (timeMs - segStart) / segDuration));
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

    // 速度计算：位移推算与 GPS 上报 speed 互相印证
    // - dispSpeed：相邻点位移 / 时间差（距离恒非负）
    // - gpsSpeed：GPS 上报原始 speed（钳制非负）
    // 任一来源显示「静止」（低于阈值，约 1km/h）即视为停车，速度为 0：
    //   静止时 GPS 可能上报 0.3~0.5 m/s 噪声，且漂移会让位移推算放大成 1 m/s 左右，
    //   仅靠单一来源无法可靠判定，取两者较小值 < 阈值则归零。
    const dispSpeed = (() => {
      const dtMs = (p1.time || 0) - (p0.time || 0);
      if (dtMs <= 0) return null;
      const d = calcDistance(
        { lat: p0.lat, lng: p0.lng },
        { lat: p1.lat, lng: p1.lng }
      );
      return d / (dtMs / 1000);
    })();
    const gpsSpeed = p0.speed != null ? Math.max(0, p0.speed)
      : (p1.speed != null ? Math.max(0, p1.speed) : null);

    // 静止速度阈值：约 1km/h（0.3 m/s）
    const STATIONARY_SPEED = 0.3;
    let speed = 0;
    if (dispSpeed != null && gpsSpeed != null) {
      // 两来源都可信：取较小者判断是否静止，移动时取较大者反映真实速度
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
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
}
