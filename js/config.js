/**
 * 途刻 TraceCraft - 配置
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

  // 画布最小绘制像素阈值
  MIN_DRAW_PX: 4,

  // GPS 超时时间（毫秒）
  GPS_TIMEOUT: 10000,
  GPS_WATCH_TIMEOUT: 5000,
  GPS_LOW_ACCURACY_TIMEOUT: 15000,

  // GPS 超时降级
  GPS_TIMEOUT_MAX_FAILURES: 5,
  GPS_RECOVERY_INTERVAL_MS: 2 * 60 * 1000,

  // 地球半径（米）
  EARTH_RADIUS: 6371000,

  // localStorage 存储键名
  STORAGE_KEY: 'trailcraft_data',

  // ----- 交互参数 -----
  LONGPRESS_THRESHOLD_MS: 600,
  LOCATED_ANIM_MS: 3000,

  // ----- GPS 相关 -----
  POSITION_STALE_MS: 10 * 60 * 1000,
  RELOCATE_INTERVAL_MS: 5 * 60 * 1000,

  // ----- 显示参数 -----
  STATUS_THROTTLE_MS: 2000,
  MIN_DISPLACEMENT_M: 5,

  // ----- 轨迹 -----
  TRAIL_SAMPLE_MIN_DIST: 5,
  TRAIL_JITTER_FACTOR: 1.5,
  TRAIL_MAX_POINTS: 300000,

  // ----- GPS 节流（百度式速度自适应）-----
  GPS_ADAPTIVE_K: 8000,
  GPS_MIN_INTERVAL: 500,
  GPS_MAX_INTERVAL: 60000,
  GPS_MOVE_THRESHOLD: 0.5,

  // ----- 存储引擎 -----
  TRAIL_STORAGE_ENGINE: 'auto',

  DB_NAME: 'trailcraft_db',
  DB_VERSION: 1,
  DB_STORE_TRAIL: 'trail',
  DB_MAX_SIZE: 200 * 1024 * 1024,

  LS_MAX_SIZE: 5 * 1024 * 1024,

  // ----- Debug -----
  DEBUG: false,

  // ----- UI -----
  MOBILE_BREAKPOINT: 480,
  DEFAULT_TOAST_DURATION: 3000,
  TOAST_FADE_MS: 300,
};

/**
 * 计算两点之间的球面距离（Haversine 公式）
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
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLng = (p2.lng - p1.lng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
          + Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180)
          * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return CONFIG.EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * 计算从 p1 到 p2 的方位角（正北顺时针）
 */
function calcBearing(p1, p2) {
  try {
    if (typeof qq !== 'undefined' && qq.maps && qq.maps.spherical) {
      const h = qq.maps.spherical.computeHeading(
        new qq.maps.LatLng(p1.lat, p1.lng),
        new qq.maps.LatLng(p2.lat, p2.lng)
      );
      return ((h % 360) + 360) % 360;
    }
  } catch (_) {}
  const φ1 = p1.lat * Math.PI / 180;
  const φ2 = p2.lat * Math.PI / 180;
  const Δλ = (p2.lng - p1.lng) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * 方位角转文字方向
 */
function bearingToDir(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  if (!Number.isFinite(deg)) return '--';
  return dirs[((Math.round(deg / 45) % 8) + 8) % 8];
}

/**
 * 格式化距离文字
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
 */
async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { }
  }
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
