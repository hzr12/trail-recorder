/**
 * 圆圈地图 - 配置
 * ============================================
 * 所有可调参数集中管理
 */

const CONFIG = {
  // 腾讯地图 API 密钥
  MAP_KEY: 'OB4BZ-D4W3U-B7VVO-4PJWW-6TKDJ-WPB77',

  // 默认地图中心（广州塔）
  DEFAULT_CENTER: { lat: 23.1291, lng: 113.2644 },

  // 默认缩放级别
  DEFAULT_ZOOM: 12,

  // 定位后缩放级别
  LOCATION_ZOOM: 15,

  // 半径范围（米）
  MIN_RADIUS: 1,
  MAX_RADIUS: 25000,
  DEFAULT_RADIUS: 5000,

  // 同心圆间隔（米）— 每 2.5 公里一圈
  CONCENTRIC_INTERVAL: 2500,

  // 画布最小绘制像素阈值
  MIN_DRAW_PX: 4,

  // GPS 超时时间（毫秒）
  GPS_TIMEOUT: 10000,
  GPS_WATCH_TIMEOUT: 5000,               // 持续追踪超时（毫秒）
  GPS_LOW_ACCURACY_TIMEOUT: 15000,       // 降级后 GPS 超时（毫秒）— 更宽松以适应弱信号

  // GPS 超时降级
  GPS_TIMEOUT_MAX_FAILURES: 5,            // 连续超时次数阈值，超过则降级
  GPS_RECOVERY_INTERVAL_MS: 2 * 60 * 1000, // 降级后每 2 分钟尝试恢复高精度

  // 地图缩放级别与半径适配映射
  ZOOM_MAP: [
    { maxRadius: 50, zoom: 17 },
    { maxRadius: 100, zoom: 16 },
    { maxRadius: 200, zoom: 15 },
    { maxRadius: 500, zoom: 14 },
    { maxRadius: 1000, zoom: 13 },
    { maxRadius: 2000, zoom: 12 },
    { maxRadius: 5000, zoom: 11 },
    { maxRadius: 10000, zoom: 10 },
    { maxRadius: 20000, zoom: 9 },
    { maxRadius: Infinity, zoom: 8 }
  ],

  // 地球半径（米）
  EARTH_RADIUS: 6371000,

  // localStorage 存储键名
  STORAGE_KEY: 'circlemap_data',

  // ----- 交互参数 -----
  INPUT_DEBOUNCE_MS: 400,           // 坐标输入防抖（毫秒）
  PARSE_DELAY_MS: 300,              // 智能解析防抖（毫秒）
  LONGPRESS_THRESHOLD_MS: 600,      // GPS 按钮长按判定（毫秒）
  LOCATED_ANIM_MS: 3000,            // 定位成功按钮高亮（毫秒）
  EDIT_HIGHLIGHT_MS: 2000,          // 编辑滑块高亮（毫秒）

  // ----- GPS 相关 -----
  POSITION_STALE_MS: 10 * 60 * 1000,    // 位置过期阈值（10 分钟）
  RELOCATE_INTERVAL_MS: 5 * 60 * 1000,  // 自动重定位最小间隔（5 分钟）

  // ----- 显示参数 -----
  STATUS_THROTTLE_MS: 2000,             // 状态条更新节流（毫秒）
  LIST_THROTTLE_MS: 2000,               // 圆列表更新节流（毫秒）
  MAX_RECENT_FIXES: 10,                 // 最近定位最大条数
  MIN_DISPLACEMENT_M: 5,                // 位移重建阈值（米）

  // ----- 功能开关 -----
  ENABLE_PREDICTION: true,              // 玩家路径预测椭圆（多人模式 10s/30s 椭圆投影）

  // ----- 轨迹 -----
  TRAIL_SAMPLE_MIN_DIST: 5,             // 轨迹采样最小间隔（米）
  TRAIL_JITTER_FACTOR: 1.5,            // 抖动检测：位移必须 > accuracy × 倍数才记录
  TRAIL_MAX_POINTS: 150000,             // 轨迹最大点数（>5m 采样 ≈ 750km 移动量）

  // ----- GPS 节流（百度式速度自适应）-----
  GPS_ADAPTIVE_K: 8000,             // 自适应系数：间隔 = K/速度（跑动 2.3s、步行 5.7s、静止 60s）
  GPS_MIN_INTERVAL: 500,           // 定位最小间隔（ms）
  GPS_MAX_INTERVAL: 60000,          // 定位最大间隔（静止心跳，ms）
  GPS_MOVE_THRESHOLD: 0.5,          // 运动检测阈值（m/s），超过此速度立即打断静止节流

  // ----- 存储引擎（IndexedDB / localStorage 可选）-----
  // 'auto'    - 优先 IndexedDB，失败时降级 localStorage
  // 'indexeddb' - 强制使用 IndexedDB
  // 'localstorage' - 强制使用 localStorage（5MB 配额）
  TRAIL_STORAGE_ENGINE: 'auto',

  DB_NAME: 'circlemap_db',          // IndexedDB 数据库名称
  DB_VERSION: 1,                    // IndexedDB 版本号
  DB_STORE_TRAIL: 'trail',          // 轨迹数据存储对象名称
  DB_MAX_SIZE: 25 * 1024 * 1024,   // IndexedDB 最大存储上限（25MB）

  LS_MAX_SIZE: 5 * 1024 * 1024,    // localStorage 最大存储上限（5MB）

  // ----- Debug -----
  DEBUG: false,                         // debug 日志开关，true=输出 console.log/console.info

  // ----- UI -----
  MOBILE_BREAKPOINT: 480,               // 移动端断点（像素）
  DEFAULT_TOAST_DURATION: 3000,         // Toast 默认显示时长（毫秒）
  TOAST_FADE_MS: 300,                   // Toast 消失动画（毫秒）
};

/**
 * 计算两点之间的球面距离（Haversine 公式）
 * @param {{lat:number,lng:number}} p1
 * @param {{lat:number,lng:number}} p2
 * @returns {number} 距离（米）
 */
function calcDistance(p1, p2) {
  try {
    if (typeof qq !== 'undefined' && qq.maps && qq.maps.spherical) {
      return qq.maps.spherical.computeDistanceBetween(
        new qq.maps.LatLng(p1.lat, p1.lng),
        new qq.maps.LatLng(p2.lat, p2.lng)
      );
    }
  } catch (_) {}
  // Fallback: 手写 Haversine 公式
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLng = (p2.lng - p1.lng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
          + Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180)
          * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return CONFIG.EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * 计算从 p1 到 p2 的方位角（正北顺时针）
 * @param {{lat:number,lng:number}} p1
 * @param {{lat:number,lng:number}} p2
 * @returns {number} 角度 0-360（0=正北）
 */
function calcBearing(p1, p2) {
  try {
    if (typeof qq !== 'undefined' && qq.maps && qq.maps.spherical) {
      const h = qq.maps.spherical.computeHeading(
        new qq.maps.LatLng(p1.lat, p1.lng),
        new qq.maps.LatLng(p2.lat, p2.lng)
      );
      // QQ API 返回 [-180,180)，归一化到 [0,360) 与降级路径一致
      return ((h % 360) + 360) % 360;
    }
  } catch (_) {}
  // Fallback: 手写方位角公式
  const φ1 = p1.lat * Math.PI / 180;
  const φ2 = p2.lat * Math.PI / 180;
  const Δλ = (p2.lng - p1.lng) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * 方位角转文字方向
 * @param {number} deg 角度 0-360
 * @returns {string} 如 "N" / "NE" / "SW"
 */
function bearingToDir(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  if (!Number.isFinite(deg)) return '--';
  // JS 负数取模得负数（-2 % 8 = -2），先归一化再取模
  return dirs[((Math.round(deg / 45) % 8) + 8) % 8];
}

/**
 * 真对数半径映射 — 滑块值 → 实际半径（#11）
 * 每个数量级均分滑块行程：滑块 50% = √(min·max)，小半径区间可精细调节
 * @param {number} sliderVal 0-1 归一化滑块位置
 * @returns {number} 半径（米）
 */
function sliderToRadius(sliderVal) {
  const minR = CONFIG.MIN_RADIUS;
  const maxR = CONFIG.MAX_RADIUS;
  return Math.round(minR * Math.pow(maxR / minR, sliderVal));
}

/**
 * 真对数半径映射 — 实际半径 → 滑块归一化值（#11）
 * @param {number} radius 半径（米）
 * @returns {number} 0-1 归一化值
 */
function radiusToSlider(radius) {
  const minR = CONFIG.MIN_RADIUS;
  const maxR = CONFIG.MAX_RADIUS;
  const r = Math.min(Math.max(radius, minR), maxR);
  return Math.log(r / minR) / Math.log(maxR / minR);
}

/**
 * 格式化距离文字
 * @param {number} meters
 * @returns {string}
 */
function formatDistance(meters) {
  if (!Number.isFinite(meters) || meters < 0) return '--';
  const val = Math.round(meters);
  if (val < 10) return `${val}m`;
  if (val < 1000) return `${val}m`;
  if (val < 10000) return `${(val / 1000).toFixed(2)}km`;
  return `${(val / 1000).toFixed(1)}km`;
}

/**
 * 复制文本到剪贴板
 * 优先 Clipboard API，降级到 textarea + execCommand（兼容 Android WebView）
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function copyText(text) {
  // 优先尝试 Clipboard API
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* 降级 */ }
  }
  // 降级：textarea + execCommand（Android WebView 可用）
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * 十进制经纬度 → 度分秒(DMS) 格式
 * @param {number} dd 十进制度数
 * @param {'lat'|'lng'} type 纬度或经度
 * @returns {string} 如 "23°7′44.76″N"
 */
function ddToDms(dd, type) {
  const dir = type === 'lat'
    ? (dd >= 0 ? 'N' : 'S')
    : (dd >= 0 ? 'E' : 'W');
  const abs = Math.abs(dd);
  const deg = Math.floor(abs);
  const minFull = (abs - deg) * 60;
  const min = Math.floor(minFull);
  const sec = (minFull - min) * 60;
  return `${deg}°${min}′${sec.toFixed(2)}″${dir}`;
}
