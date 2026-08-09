/**
 * 轨迹管理
 * =============================================
 * 轨迹点存储、采样、距离计算
 */

class Trail {
  constructor() {
    this.positions = [];      // 轨迹点数组
    this.lastPos = null;      // 上次记录的位置（用于采样）
    this.isRecording = false; // 是否正在记录
    this.isPaused = false;    // 是否暂停记录
    this._maxSpeed = 0;       // 增量维护的最高速度（m/s），供实时统计卡 O(1) 读取
  }

  /**
   * 开始新记录（清空旧轨迹）
   */
  start() {
    this.positions = [];
    this.lastPos = null;
    this.isRecording = true;
    this.isPaused = false;
    this._maxSpeed = 0;
  }

  /**
   * 停止记录
   */
  stop() {
    this.isRecording = false;
    this.isPaused = false;
  }

  /**
   * 暂停记录（保留已有轨迹，暂停添加新点）
   */
  pause() {
    this.isPaused = true;
  }

  /**
   * 继续记录
   */
  resume() {
    this.isPaused = false;
    this.lastPos = null;
  }

  /**
   * 清除所有轨迹点
   */
  clear() {
    this.positions = [];
    this.lastPos = null;
    this._maxSpeed = 0;
  }

  /**
   * 恢复轨迹点（用于撤销操作）
   * @param {Array} positions
   * @param {{lat:number,lng:number}|null} lastPos
   */
  restore(positions, lastPos) {
    this.positions = positions;
    this.lastPos = lastPos;
    this._maxSpeed = 0;
    for (const p of positions) {
      if (p && p.speed != null && p.speed > this._maxSpeed) this._maxSpeed = p.speed;
    }
  }

  /**
   * 采样记录一个轨迹点（每 >5m 采一个点，上限由 CONFIG.TRAIL_MAX_POINTS 控制）
   * 抖动过滤：位移必须同时超过最小间距和 accuracy × 抖动系数，避免站定时 GPS 漂移鬼点
   * @param {{lat:number,lng:number,time?:number,accuracy?:number,speed?:number,heading?:number}} pt
   * @returns {boolean} 是否实际添加了点
   */
  addPoint(pt) {
    if (!pt) return false;
    // 暂停时不添加点
    if (this.isPaused) return false;
    // 防御：拒绝无效坐标
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
      // 必须同时超过固定最小间距和精度联动阈值（防抖动）
      const jitterThreshold = Math.max(
        CONFIG.TRAIL_SAMPLE_MIN_DIST,
        CONFIG.TRAIL_JITTER_FACTOR * (pt.accuracy || 0)
      );
      if (dist <= jitterThreshold) {
        return false;
      }
      // 漂移鬼点过滤：上报速度显示静止（<0.5 m/s），但位移却异常大（超过精度抖动阈值的数倍），
      // 说明是 GPS 静止漂移而非真实移动，丢弃该点避免轨迹出现「分叉尾巴」
      const speed = pt.speed;
      if (typeof speed === 'number' && speed >= 0 && speed < CONFIG.TRAIL_STATIONARY_SPEED) {
        if (dist > jitterThreshold * 4) {
          if (CONFIG.DEBUG) console.warn('[Trail] 丢弃静止漂移点:', dist.toFixed(1) + 'm', speed + 'm/s');
          return false;
        }
      }
    }
    this.positions.push(pt);
    this.lastPos = pt;
    if (pt.speed != null && pt.speed > this._maxSpeed) {
      this._maxSpeed = pt.speed;
    }
    if (this.positions.length > CONFIG.TRAIL_MAX_POINTS) {
      this.positions = this.positions.slice(-CONFIG.TRAIL_MAX_POINTS);
      // 裁剪可能丢弃最高速点，重建保证统计准确
      this._maxSpeed = 0;
      for (const p of this.positions) {
        if (p && p.speed != null && p.speed > this._maxSpeed) this._maxSpeed = p.speed;
      }
    }
    return true;
  }

  /**
   * @returns {number} 轨迹最高速度（m/s），增量维护，O(1) 读取
   */
  getMaxSpeed() {
    return this._maxSpeed;
  }

  /**
   * 计算轨迹总距离
   * @returns {number} 米
   */
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

  /**
   * @returns {number} 轨迹点数量
   */
  getPointCount() {
    return this.positions.length;
  }

  /**
   * 滑动窗口平均平滑，返回新的坐标数组（不修改原始数据）
   * @param {number} [windowSize=5] 窗口大小（奇数效果最佳）
   * @returns {Array<{lat:number,lng:number,speed?:number,time?:number,…>}
   */
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
      // 保留原始所有字段，只覆盖 lat/lng
      result.push(Object.assign({}, this.positions[i], {
        lat: sumLat / count,
        lng: sumLng / count,
        _smoothed: true
      }));
    }
    return result;
  }
}
