/**
 * 途刻 TraceCraft - 轨迹分析引擎
 * ============================================
 * 纯函数，无 DOM 依赖：
 *  - analyzeKeyPoints: 关键点（起点 / 终点 / 最高速点）
 *  - analyzeSegments: 自动分段（按速度等级，带防抖）
 *  - analyze: 综合输出（关键点 + 自动分段 + 手动分段）
 *
 * 手动分段数据模型（存于轨迹记录的 manualSegments 字段）：
 *  [{ id, label, lat, lng, time, ratio }]
 *  - ratio: 0~1，表示沿轨迹累计距离的比例
 */

const TrailAnalysis = {
  // 与 map.js 速度着色保持一致的速度等级
  SPEED_LEVELS: [
    { mode: 'walk',  max: 2.78,    label: '步行', color: '#00E5CC' },
    { mode: 'bike',  max: 5.56,    label: '骑行', color: '#FFD700' },
    { mode: 'bus',   max: 16.67,   label: '公交', color: '#FF8C00' },
    { mode: 'car',   max: 33.33,   label: '驾车', color: '#FF5E33' },
    { mode: 'train', max: 55.56,   label: '火车', color: '#FF3366' },
    { mode: 'hsr',   max: 97.22,   label: '高铁', color: '#BF40FF' },
    { mode: 'sct',   max: Infinity, label: '超高速', color: '#5E5CE6' },
  ],

  /**
   * 速度(m/s) → 交通方式等级
   */
  speedLevel(speed) {
    if (speed == null || speed < 2.78) return 'walk';
    if (speed < 5.56) return 'bike';
    if (speed < 16.67) return 'bus';
    if (speed < 33.33) return 'car';
    if (speed < 55.56) return 'train';
    if (speed < 97.22) return 'hsr';
    return 'sct';
  },

  modeLabel(mode) {
    const m = this.SPEED_LEVELS.find((s) => s.mode === mode);
    return m ? m.label : (mode || '--');
  },

  modeColor(mode) {
    const m = this.SPEED_LEVELS.find((s) => s.mode === mode);
    return m ? m.color : '#00E5CC';
  },

  // 与 map.js 一致：优先取后一点速度
  _segmentSpeed(p0, p1) {
    return p1.speed != null ? p1.speed : (p0.speed != null ? p0.speed : 0);
  },

  // 用位移/时间推算即时速度（旧数据可能缺 speed 或为 0）
  _calcInstantSpeed(p0, p1) {
    const dist = calcDistance(p0, p1);
    const dt = (p1.time || 0) - (p0.time || 0);
    if (dt <= 0) return 0;
    return dist / (dt / 1000);
  },

  /**
   * 关键点分析：起点 / 终点 / 最高速点
   * @param {Array} positions
   * @returns {{start:Object|null, end:Object|null, maxSpeed:Object|null}}
   */
  analyzeKeyPoints(positions) {
    if (!Array.isArray(positions) || positions.length < 2) {
      return { start: null, end: null, maxSpeed: null };
    }
    const start = positions[0];
    const end = positions[positions.length - 1];

    let maxSpeedPt = null;
    let maxSpeed = 0;
    for (let i = 1; i < positions.length; i++) {
      const p = positions[i];
      let speed = (p.speed != null && p.speed > 0) ? p.speed : 0;
      if (speed <= 0) {
        speed = this._calcInstantSpeed(positions[i - 1], p);
      }
      if (speed > maxSpeed) {
        maxSpeed = speed;
        maxSpeedPt = p;
      }
    }
    if (!maxSpeedPt) maxSpeedPt = end;

    return {
      start: {
        type: 'start',
        lat: start.lat, lng: start.lng,
        time: start.time || 0,
        label: '起点'
      },
      end: {
        type: 'end',
        lat: end.lat, lng: end.lng,
        time: end.time || 0,
        label: '终点'
      },
      maxSpeed: {
        type: 'maxSpeed',
        lat: maxSpeedPt.lat, lng: maxSpeedPt.lng,
        time: maxSpeedPt.time || 0,
        speed: maxSpeed,
        label: `最高速 ${(maxSpeed * 3.6).toFixed(1)} km/h`
      }
    };
  },

  /**
   * 自动分段：沿轨迹按速度等级切段（防抖：需连续 N 个点维持新等级才切换）
   * @param {Array} positions
   * @returns {Array<{startIdx,endIdx,mode,distance,durationMs,avgSpeed,label}>}
   */
  analyzeSegments(positions) {
    if (!Array.isArray(positions) || positions.length < 3) return [];
    const n = positions.length;
    const minPts = Math.max(1, CONFIG.TRAIL_SEGMENT_MIN_POINTS || 3);

    // 每段的等级（i 与 i-1 之间）
    const levels = new Array(n);
    for (let i = 1; i < n; i++) {
      levels[i] = this.speedLevel(this._segmentSpeed(positions[i - 1], positions[i]));
    }

    // 防抖切段
    const rawSegments = [];
    let segStart = 0;
    let segLevel = levels[1];
    let candidateLevel = null;
    let candidateCount = 0;

    for (let i = 1; i < n; i++) {
      const lv = levels[i];
      if (lv === segLevel) {
        candidateLevel = null;
        candidateCount = 0;
        continue;
      }
      if (candidateLevel === lv) {
        candidateCount++;
      } else {
        candidateLevel = lv;
        candidateCount = 1;
      }
      if (candidateCount >= minPts) {
        const endIdx = i - minPts + 1;
        rawSegments.push({ startIdx: segStart, endIdx, mode: segLevel });
        segStart = endIdx;
        segLevel = lv;
        candidateLevel = null;
        candidateCount = 0;
      }
    }
    rawSegments.push({ startIdx: segStart, endIdx: n - 1, mode: segLevel });

    // 汇总统计
    const segments = [];
    for (const seg of rawSegments) {
      const s = this._summarizeSegment(positions, seg.startIdx, seg.endIdx, seg.mode);
      if (s) segments.push(s);
    }
    return this._mergeTinySegments(positions, segments);
  },

  _summarizeSegment(positions, startIdx, endIdx, mode) {
    if (endIdx <= startIdx) return null;
    let distance = 0;
    for (let i = startIdx + 1; i <= endIdx; i++) {
      distance += calcDistance(positions[i - 1], positions[i]);
    }
    const first = positions[startIdx];
    const last = positions[endIdx];
    let durationMs = 0;
    if (first && last && first.time && last.time && last.time > first.time) {
      durationMs = last.time - first.time;
    }
    return {
      startIdx, endIdx, mode,
      distance,
      durationMs,
      avgSpeed: durationMs > 0 ? distance / (durationMs / 1000) : 0,
      label: this.formatSegmentLabel(mode, distance, durationMs)
    };
  },

  // 把过短的段并入相邻段，避免产生大量碎段
  _mergeTinySegments(positions, segments) {
    if (segments.length <= 1) return segments;
    const minDist = CONFIG.TRAIL_SEGMENT_MIN_DIST || 60;
    const minMs = CONFIG.TRAIL_SEGMENT_MIN_MS || 10000;
    const result = [];
    for (const seg of segments) {
      const tiny = seg.distance < minDist && seg.durationMs < minMs;
      if (tiny && result.length > 0) {
        const prev = result[result.length - 1];
        const merged = this._summarizeSegment(
          positions, prev.startIdx, seg.endIdx, prev.mode
        );
        if (merged) result[result.length - 1] = merged;
        continue;
      }
      result.push(seg);
    }
    return result;
  },

  formatSegmentLabel(mode, distance, durationMs) {
    return `${this.modeLabel(mode)} ${formatDistance(distance)} · ${this._fmtDurationShort(durationMs)}`;
  },

  _fmtDurationShort(ms) {
    if (!ms || ms <= 0) return '--';
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}小时${m}分`;
    if (m > 0) return `${m}分${s}秒`;
    return `${s}秒`;
  },

  /**
   * 综合输出
   * @param {Array} positions
   * @param {Array} [manualSegments]
   * @returns {{keyPoints:Object, segments:Array, manualSegments:Array}}
   */
  analyze(positions, manualSegments) {
    return {
      keyPoints: this.analyzeKeyPoints(positions),
      segments: this.analyzeSegments(positions),
      manualSegments: Array.isArray(manualSegments) ? manualSegments : []
    };
  },

  /**
   * 返回指定轨迹点索引所在的分段（回放实时显示用）
   */
  segmentAt(segments, index) {
    if (!Array.isArray(segments) || segments.length === 0) return null;
    for (const seg of segments) {
      if (index >= seg.startIdx && index <= seg.endIdx) return seg;
    }
    return segments[segments.length - 1];
  },

  /**
   * 沿轨迹累计距离比例(0~1) → 轨迹点索引
   */
  ratioToIndex(positions, ratio) {
    if (!Array.isArray(positions) || positions.length === 0) return 0;
    if (positions.length < 2) return 0;
    const r = Math.max(0, Math.min(1, ratio));
    let total = 0;
    for (let i = 1; i < positions.length; i++) {
      total += calcDistance(positions[i - 1], positions[i]);
    }
    if (total <= 0) return Math.round(r * (positions.length - 1));
    const target = r * total;
    if (target <= 0) return 0;
    let acc = 0;
    for (let i = 1; i < positions.length; i++) {
      acc += calcDistance(positions[i - 1], positions[i]);
      if (acc >= target) return i;
    }
    return positions.length - 1;
  },

  /**
   * 手动分段按 ratio 排序并标记"删除后是否可移除"（至少保留 0 个即可）
   */
  sortManualSegments(manualSegments) {
    return (Array.isArray(manualSegments) ? manualSegments : [])
      .slice()
      .sort((a, b) => (a.ratio || 0) - (b.ratio || 0));
  }
};
