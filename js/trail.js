/**
 * Trail Recorder - 轨迹管理
 * 轨迹点存储、采样、距离计算、平滑
 */

class Trail {
  constructor() {
    this.id = null;               // 轨迹唯一 ID
    this.name = '未命名';         // 轨迹名称
    this.positions = [];
    this.lastPos = null;
    this.isRecording = false;
    this.isPaused = false;
    this.startPoint = null;       // 起点（自动记录）
    this.endPoint = null;         // 终点（停止时记录）
    this.annotations = [];        // 自定义标注点
    this.createdAt = null;        // 创建时间戳
    this.updatedAt = null;        // 更新时间戳
  }

  start() {
    this.positions = [];
    this.lastPos = null;
    this.startPoint = null;
    this.endPoint = null;
    this.annotations = [];
    this.isRecording = true;
    this.isPaused = false;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    if (!this.id) {
      this.id = 'trail_' + new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    }
  }

  stop() {
    this.isRecording = false;
    this.isPaused = false;
    if (this.positions.length > 0) {
      this.endPoint = this.positions[this.positions.length - 1];
    }
    this.updatedAt = Date.now();
  }

  pause() {
    this.isPaused = true;
  }

  resume() {
    this.isPaused = false;
    this.lastPos = null;
  }

  clear() {
    this.positions = [];
    this.lastPos = null;
    this.startPoint = null;
    this.endPoint = null;
    this.annotations = [];
    this.name = '未命名';
    this.createdAt = null;
    this.updatedAt = null;
  }

  restore(data) {
    if (!data) return;
    this.id = data.id || null;
    this.name = data.name || '未命名';
    this.positions = data.positions || [];
    this.lastPos = this.positions.length > 0 ? this.positions[this.positions.length - 1] : null;
    this.isRecording = false;
    this.isPaused = false;
    this.startPoint = data.startPoint || null;
    this.endPoint = data.endPoint || null;
    this.annotations = data.annotations || [];
    this.createdAt = data.createdAt || null;
    this.updatedAt = data.updatedAt || Date.now();
  }

  addPoint(pt) {
    if (!pt) return false;
    if (this.isPaused) return false;
    if (typeof pt.lat !== 'number' || !isFinite(pt.lat) ||
        typeof pt.lng !== 'number' || !isFinite(pt.lng)) {
      if (CONFIG.DEBUG) console.warn('[Trail] 丢弃无效点:', pt.lat, pt.lng);
      return false;
    }
    if (this.lastPos) {
      const dist = calcDistance(
        { lat: pt.lat, lng: pt.lng },
        { lat: this.lastPos.lat, lng: this.lastPos.lng }
      );
      const jitterThreshold = Math.max(
        CONFIG.TRAIL_SAMPLE_MIN_DIST,
        CONFIG.TRAIL_JITTER_FACTOR * (pt.accuracy || 0)
      );
      if (dist <= jitterThreshold) {
        return false;
      }
    }
    // 记录起点（第一个点）
    if (this.positions.length === 0 && this.startPoint === null) {
      this.startPoint = { ...pt };
    }
    this.positions.push(pt);
    this.lastPos = pt;
    this.updatedAt = Date.now();
    if (this.positions.length > CONFIG.TRAIL_MAX_POINTS) {
      this.positions = this.positions.slice(-CONFIG.TRAIL_MAX_POINTS);
    }
    return true;
  }

  getDistance() {
    if (this.positions.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < this.positions.length; i++) {
      total += calcDistance(
        { lat: this.positions[i-1].lat, lng: this.positions[i-1].lng },
        { lat: this.positions[i].lat, lng: this.positions[i].lng }
      );
    }
    return total;
  }

  getPointCount() {
    return this.positions.length;
  }

  getDuration() {
    if (this.positions.length < 2) return 0;
    const first = this.positions[0];
    const last = this.positions[this.positions.length - 1];
    const t1 = first.time || first.timestamp || 0;
    const t2 = last.time || last.timestamp || 0;
    return t2 - t1;
  }

  getAvgSpeed() {
    const duration = this.getDuration();
    if (duration <= 0) return 0;
    return this.getDistance() / (duration / 1000);
  }

  getMaxSpeed() {
    let maxSpeed = 0;
    for (const p of this.positions) {
      if (p.speed != null && p.speed > maxSpeed) {
        maxSpeed = p.speed;
      }
    }
    return maxSpeed;
  }

  getSmoothedPositions(windowSize = 5) {
    const n = this.positions.length;
    if (n < 4) return this.positions.slice();
    const half = Math.floor(windowSize / 2);
    const result = [];
    for (let i = 0; i < n; i++) {
      const start = Math.max(0, i - half);
      const end = Math.min(n - 1, i + half);
      let sumLat = 0, sumLng = 0;
      for (let j = start; j <= end; j++) {
        sumLat += this.positions[j].lat;
        sumLng += this.positions[j].lng;
      }
      const count = end - start + 1;
      result.push(Object.assign({}, this.positions[i], {
        lat: sumLat / count,
        lng: sumLng / count,
        _smoothed: true
      }));
    }
    return result;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      positions: this.positions,
      startPoint: this.startPoint,
      endPoint: this.endPoint,
      annotations: this.annotations,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      isRecording: this.isRecording,
      isPaused: this.isPaused
    };
  }

  static fromJSON(json) {
    const t = new Trail();
    t.restore(json);
    return t;
  }
}
