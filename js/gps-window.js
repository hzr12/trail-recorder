/**
 * 途刻 TraceCraft - 实时位置稳健滑动窗平滑
 * ============================================
 * 替代已删除的 IMM/Kalman 实时 2D 滤波。设计目标：
 *   - 零外推：输出永远是"已观测到的点之间"的统计，绝不按最后速度往前冲
 *     （彻底消除移动场景丢点时的系统性拉偏，如火车北偏顺德）。
 *   - 轻量：无矩阵、无状态机，仅中位数 + Hampel 截断 + 双冻结。
 *   - 与离线 RTS 后处理彻底解耦（GPSManager._offlineSmoother 单独存在）。
 *
 * 行业依据：Google FLP / Apple Core Location 把融合放在系统层且严格限时 DR；
 * OsmAnd 用速度/精度/距离阈值筛选；GPSBabel/Visualizer 用几何抽稀+距离去抖；
 * Strava 后处理忽略坏点。没有任何一家在实时蓝点上做"会外推的重卡尔曼"。
 *
 * 接线位置：GPSManager 收到单次定位 → PositionSmoother.push(rawPos) →
 * 平滑后 pos 传给 onPositionChange（蓝点 + 轨迹入库同源）。原始 rawPos 仍
 * 存入 _rawFixes 供离线 RTS。
 */
(function (global) {
  'use strict';

  /** 升序中位数 */
  function median(arr) {
    const a = arr.slice().sort((x, y) => x - y);
    const n = a.length;
    if (n === 0) return 0;
    const mid = (n - 1) / 2;
    return n % 2 ? a[Math.floor(mid)] : (a[mid] + a[mid + 0.5]) / 2;
  }

  /** 绝对中位差 MAD（对中位数偏差的鲁棒标准差估计） */
  function madOf(arr, med) {
    if (!arr.length) return 0;
    const dev = arr.map(v => Math.abs(v - med));
    return median(dev);
  }

  /** 两点 Haversine 距离（米），用于静止/位移判定 */
  function distM(a, b) {
    const R = 6371000;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const lat1 = a.lat * Math.PI / 180, lat2 = b.lat * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  class PositionSmoother {
    /**
     * @param {object} [opts]
     * @param {number} [opts.win=5]        滑动窗大小（奇数，约 5 个 fix）
     * @param {number} [opts.madK=3]       Hampel 截断倍数（残差 > k·MAD 视为鬼点）
     * @param {number} [opts.freezeDt=3000] 丢点冻结阈值（ms）：距上次超过则回退原始点
     * @param {number} [opts.staticRatio=1.0] 静止判定：位移 < accuracy×该值 → 输出原始点（防拖影）
     * @param {boolean}[opts.enabled=true] 是否启用（关闭则直接透传原始点）
     */
    constructor(opts) {
      opts = opts || {};
      this.win = opts.win || 5;
      this.madK = opts.madK != null ? opts.madK : 3;
      this.freezeDt = opts.freezeDt != null ? opts.freezeDt : 3000;
      this.staticRatio = opts.staticRatio != null ? opts.staticRatio : 1.0;
      this.enabled = opts.enabled !== false;
      this._buf = [];      // 原始 fix 缓冲 {lat,lng,accuracy,time}
      this._lastT = 0;     // 上次 push 的时间戳（ms）
      this._rejected = 0;  // 累计 Hampel 拒绝鬼点数（调试用）
    }

    /**
     * 推入一个原始 fix，返回平滑后的 {lat,lng}（不动 accuracy/speed/heading，
     * 这些由 GPSManager 直接透传）。窗不足或降级时返回原始点。
     * @param {{lat:number,lng:number,accuracy?:number,time?:number}} fix
     */
    push(fix) {
      if (!this.enabled) return { lat: fix.lat, lng: fix.lng };

      const t = fix.time || Date.now();

      // 1) 丢点冻结：距上次超过 freezeDt → 重置窗，直接回退原始点（绝不外推）
      if (this._lastT && t - this._lastT > this.freezeDt) {
        this._buf = [];
        this._lastT = t;
        this._buf.push(fix);
        return { lat: fix.lat, lng: fix.lng };
      }
      this._lastT = t;

      this._buf.push(fix);
      if (this._buf.length > this.win) this._buf.shift();

      // 窗不足 3 点：直接输出原始点（避免初期抖动）
      if (this._buf.length < 3) return { lat: fix.lat, lng: fix.lng };

      // 2) 静止冻结：与窗首位移 < accuracy×ratio → 直接输出最新原始点（消除拖影）
      const acc = fix.accuracy || 10;
      const d0 = distM(fix, this._buf[0]);
      if (d0 < acc * this.staticRatio) {
        return { lat: fix.lat, lng: fix.lng };
      }

      // 3) 横纵分别取中位数（抗单点粗差）
      const lats = this._buf.map(b => b.lat);
      const lngs = this._buf.map(b => b.lng);
      const mlat = median(lats);
      const mlng = median(lngs);

      // 4) Hampel 截断：最新点偏离中位数超 k·MAD → 用中位数替换（防鬼点）
      const madLat = 1.4826 * madOf(lats, mlat);
      if (madLat > 1e-9 && Math.abs(fix.lat - mlat) > this.madK * madLat) {
        this._rejected++;
        return { lat: mlat, lng: mlng };
      }
      return { lat: mlat, lng: mlng };
    }

    /** 清空状态（watch 停止/恢复/切换源时调用） */
    reset() {
      this._buf = [];
      this._lastT = 0;
      this._rejected = 0;
    }

    setEnabled(on) {
      this.enabled = !!on;
      if (!this.enabled) this.reset();
    }
  }

  global.PositionSmoother = PositionSmoother;
})(typeof window !== 'undefined' ? window : this);
