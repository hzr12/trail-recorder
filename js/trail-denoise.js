/**
 * 轨迹级后处理：异常点 / 跳变剔除 + 运动学约束兜底
 * ------------------------------------------------------------
 * 与实时滤波（IMM/IMU）彻底解耦，全部为纯函数，无 DOM 依赖，
 * 输入/输出均为 {lat,lng,time,...} 轨迹点数组（时间轴等长，不增删点）。
 *
 * 依赖：calcDistance（Haversine，config.js 全局）、CONFIG（config.js 全局）。
 * 米坐标转换复用 gps-kalman.js 顶层常量 DEG2RAD / M_PER_DEG（离线后处理通用，无耦合）。
 * 加载顺序需在 config.js / gps-kalman.js 之后。
 *
 * @version 2026-08-13
 */
(function (global) {
  'use strict';

  // gps-kalman.js 顶层 var 已挂全局，这里安全引用（离线场景一致）
  var DEG = (typeof DEG2RAD !== 'undefined') ? DEG2RAD : Math.PI / 180;
  var MPD = (typeof M_PER_DEG !== 'undefined') ? M_PER_DEG : 111320;

  /**
   * 标记并修复 GPS 跳变 / 漂移鬼点。
   * 策略（经用户确认）：**米坐标线性插值修复**（保留等长时间序列，便于 RTS 与回放）。
   * - 内部点：复用 trail-analysis.js 的 maxJumpFactor 思路（相对「速度×时间×factor+base」超限判跳变），
   *   检测到跳变后用前后最近有效点做米坐标线性插值回填（而非删除，避免时间轴断裂）。
   * - 首尾异常点：直接裁剪（无法向前/向后插值），由调用方后续 trimEndpoints 收尾。
   * @param {Array<{lat,lng,time,speed?,accuracy?}>} positions 轨迹点
   * @param {Object} [opts]
   * @param {number} [opts.maxJumpFactor] 相对期望位移倍数上限
   * @param {number} [opts.baseM] 无速度时的基础兜底阈值（米）
   * @returns {Array} 修复后的新数组（等长或首尾裁剪后略短；至少保留 2 点）
   */
  function denoiseTrail(positions, opts) {
    if (!Array.isArray(positions) || positions.length < 4) {
      return Array.isArray(positions) ? positions.slice() : [];
    }
    const o = opts || {};
    const factor = Number.isFinite(o.maxJumpFactor)
      ? o.maxJumpFactor
      : (CONFIG.TRAIL_DENOISE_MAX_JUMP_FACTOR || 5);
    const base = (CONFIG.TRAIL_DENOISE_BASE_M || 10);
    const n = positions.length;

    // 1) 标记跳变点（keep=false 表示需修复）
    const keep = new Array(n).fill(true);
    for (let i = 1; i < n - 1; i++) {
      const prev = positions[i - 1];
      const cur = positions[i];
      const next = positions[i + 1];
      const dt1 = ((cur.time || 0) - (prev.time || 0)) / 1000;
      const dt2 = ((next.time || 0) - (cur.time || 0)) / 1000;
      if (dt1 <= 0 || dt2 <= 0) continue; // 时间缺失保守跳过

      const d1 = calcDistance(prev, cur);
      const d2 = calcDistance(cur, next);
      // 参考速度：取相邻段中较大的（避免高速真实拐点被误杀）
      const r1 = _refSpeed(prev, cur);
      const r2 = _refSpeed(cur, next);
      const maxJump1 = r1 * dt1 * factor + base;
      const maxJump2 = r2 * dt2 * factor + base;
      if (d1 > maxJump1 && d2 > maxJump2) keep[i] = false;
    }

    // 2) 修复：对 keep=false 的内部点做米坐标线性插值
    const out = positions.map(p => Object.assign({}, p));
    for (let i = 1; i < n - 1; i++) {
      if (keep[i]) continue;
      // 向前/向后找最近的有效锚点
      let a = i - 1;
      while (a > 0 && !keep[a]) a--;
      let b = i + 1;
      while (b < n - 1 && !keep[b]) b++;
      if (!keep[a] || !keep[b]) continue; // 首尾异常交由 trimEndpoints 裁剪
      const pa = positions[a], pb = positions[b];
      const ta = pa.time, tb = pb.time, tc = positions[i].time;
      // 时间比例（米坐标内插，避免大跨度经纬度线性偏差）
      const frac = (tb !== ta) ? (tc - ta) / (tb - ta) : 0.5;
      const refLat = pa.lat;
      const cosLat = Math.cos(refLat * DEG);
      const xa = (pa.lng - refLat * 0) * 0 + (pa.lng) * MPD * cosLat; // 直接经纬差转米
      const ya = pa.lat * MPD;
      const xb = pb.lng * MPD * cosLat;
      const yb = pb.lat * MPD;
      const xi = xa + (xb - xa) * frac;
      const yi = ya + (yb - ya) * frac;
      out[i].lat = yi / MPD;
      out[i].lng = xi / (MPD * cosLat);
      // accuracy 插值（取两端均值，标记已修复）
      out[i].accuracy = ((pa.accuracy || 0) + (pb.accuracy || 0)) / 2;
    }

    return out;
  }

  /** 段参考速度（m/s）：取两点中后一点的 speed，缺省回退基础阈值 */
  function _refSpeed(a, b) {
    const s = b.speed != null ? b.speed : (a.speed != null ? a.speed : 0);
    return s > 0 ? s : 0;
  }

  /**
   * 运动学约束兜底：对平滑/修复后序列做速度/加速度限幅。
   * 独立一步（不改已验证的 RTS 核心），超限点用相邻点米坐标插值回拉，
   * 与实时 IMU clamp 解耦，纯离线后处理保护。
   * @param {Array<{lat,lng,time}>} positions 轨迹点（需含 time）
   * @param {Object} [opts]
   * @param {number} [opts.maxSpeed] 单段最大速度 m/s
   * @param {number} [opts.maxAcc] 单段最大加速度 m/s²
   * @returns {Array} 约束后的新数组（等长）
   */
  function kinematicClamp(positions, opts) {
    if (!Array.isArray(positions) || positions.length < 3) {
      return Array.isArray(positions) ? positions.slice() : [];
    }
    const o = opts || {};
    const vMax = Number.isFinite(o.maxSpeed) ? o.maxSpeed : (CONFIG.TRAIL_KINEMATIC_MAX_SPEED || 60);
    const aMax = Number.isFinite(o.maxAcc) ? o.maxAcc : (CONFIG.TRAIL_KINEMATIC_MAX_ACC || 12);
    const n = positions.length;
    const out = positions.map(p => Object.assign({}, p));
    const cosLat = Math.cos(positions[0].lat * DEG);

    // 预计算每点米坐标与速度、加速度
    const mx = new Float64Array(n), my = new Float64Array(n);
    const v = new Float64Array(n), acc = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      mx[i] = positions[i].lng * MPD * cosLat;
      my[i] = positions[i].lat * MPD;
    }
    for (let i = 1; i < n; i++) {
      const dt = (positions[i].time - positions[i - 1].time) / 1000;
      if (dt > 0) v[i] = Math.hypot(mx[i] - mx[i - 1], my[i] - my[i - 1]) / dt;
    }
    for (let i = 1; i < n - 1; i++) {
      const dt1 = (positions[i].time - positions[i - 1].time) / 1000;
      const dt2 = (positions[i + 1].time - positions[i].time) / 1000;
      if (dt1 > 0 && dt2 > 0) acc[i] = (v[i + 1] - v[i]) / ((dt1 + dt2) / 2);
    }

    // 超限点（速度或加速度）→ 用相邻有效点插值回填
    for (let i = 1; i < n - 1; i++) {
      const bad = v[i] > vMax || Math.abs(acc[i]) > aMax;
      if (!bad) continue;
      let a = i - 1;
      while (a > 0 && (v[a] > vMax || Math.abs(acc[a]) > aMax)) a--;
      let b = i + 1;
      while (b < n - 1 && (v[b] > vMax || Math.abs(acc[b]) > aMax)) b++;
      if (a < 0 || b >= n) continue;
      const ta = positions[a].time, tb = positions[b].time, tc = positions[i].time;
      const frac = (tb !== ta) ? (tc - ta) / (tb - ta) : 0.5;
      const xi = mx[a] + (mx[b] - mx[a]) * frac;
      const yi = my[a] + (my[b] - my[a]) * frac;
      out[i].lat = yi / MPD;
      out[i].lng = xi / (MPD * cosLat);
    }
    return out;
  }

  // 暴露为全局（无模块化）
  global.TrailDenoise = {
    denoiseTrail: denoiseTrail,
    kinematicClamp: kinematicClamp
  };
})(typeof window !== 'undefined' ? window : this);
