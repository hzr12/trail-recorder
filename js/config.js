/**
 * Trail Recorder - 配置
 * 所有可调参数集中管理
 */

const CONFIG = {
  // 默认地图中心
  DEFAULT_CENTER: { lat: 39.9042, lng: 116.4074 },
  DEFAULT_ZOOM: 13,
  LOCATION_ZOOM: 16,

  // GPS 超时时间（毫秒）
  GPS_TIMEOUT: 10000,
  GPS_WATCH_TIMEOUT: 5000,
  GPS_LOW_ACCURACY_TIMEOUT: 15000,

  // GPS 超时降级
  GPS_TIMEOUT_MAX_FAILURES: 5,
  GPS_RECOVERY_INTERVAL_MS: 2 * 60 * 1000,

  // 地球半径（米）
  EARTH_RADIUS: 6371000,

  // ----- GPS 节流 -----
  GPS_ADAPTIVE_K: 8000,
  GPS_MIN_INTERVAL: 500,
  GPS_MAX_INTERVAL: 60000,
  GPS_MOVE_THRESHOLD: 0.5,

  // ----- 轨迹 -----
  TRAIL_SAMPLE_MIN_DIST: 5,
  TRAIL_JITTER_FACTOR: 1.5,
  TRAIL_MAX_POINTS: 150000,

  // ----- 存储 -----
  TRAIL_STORAGE_ENGINE: 'auto',
  DB_NAME: 'trail_recorder_db',
  DB_VERSION: 1,
  DB_STORE_TRAIL: 'trail',
  DB_MAX_SIZE: 25 * 1024 * 1024,
  LS_MAX_SIZE: 5 * 1024 * 1024,

  // ----- 交互参数 -----
  LONGPRESS_THRESHOLD_MS: 600,
  LOCATED_ANIM_MS: 3000,
  STATUS_THROTTLE_MS: 2000,
  POSITION_STALE_MS: 10 * 60 * 1000,

  // ----- UI -----
  MOBILE_BREAKPOINT: 480,
  DEFAULT_TOAST_DURATION: 3000,
  TOAST_FADE_MS: 300,

  // ----- Debug -----
  DEBUG: false,
};

/**
 * 计算两点之间的球面距离（Haversine 公式）
 */
function calcDistance(p1, p2) {
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLng = (p2.lng - p1.lng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
          + Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180)
          * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return CONFIG.EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * 格式化距离文字
 */
function formatDistance(meters) {
  if (!Number.isFinite(meters) || meters < 0) return '--';
  const val = Math.round(meters);
  if (val < 1000) return `${val}m`;
  return `${(val / 1000).toFixed(2)}km`;
}

/**
 * 格式化时间
 */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/**
 * 格式化速度
 */
function formatSpeed(mps) {
  if (!Number.isFinite(mps) || mps < 0) return '--';
  const kmh = mps * 3.6;
  if (kmh < 1) return `${(mps).toFixed(1)} m/s`;
  return `${kmh.toFixed(1)} km/h`;
}

/**
 * 格式化海拔
 */
function formatAltitude(m) {
  if (!Number.isFinite(m)) return '--';
  return `${m.toFixed(1)}m`;
}

/**
 * 速度色阶键名
 */
function speedColorKey(speed) {
  if (speed == null || speed < 2.78) return 'walk';
  if (speed < 5.56) return 'bike';
  if (speed < 16.67) return 'bus';
  if (speed < 33.33) return 'car';
  if (speed < 55.56) return 'train';
  if (speed < 97.22) return 'hsr';
  return 'sct';
}

/**
 * 速度色阶表（深色模式）
 */
const SPEED_COLORS_DARK = {
  walk:  { r: 0,   g: 229, b: 204, a: 0.85 },
  bike:  { r: 255, g: 215, b: 0,   a: 0.90 },
  bus:   { r: 255, g: 140, b: 0,   a: 0.92 },
  car:   { r: 255, g: 94,  b: 51,  a: 0.94 },
  train: { r: 255, g: 51,  b: 102, a: 0.95 },
  hsr:   { r: 191, g: 64,  b: 255, a: 0.96 },
  sct:   { r: 94,  g: 92,  b: 230, a: 0.97 },
};

/**
 * 速度色阶表（浅色模式）
 */
const SPEED_COLORS_LIGHT = {
  walk:  { r: 52,  g: 199, b: 89,  a: 0.80 },
  bike:  { r: 255, g: 149, b: 0,   a: 0.82 },
  bus:   { r: 255, g: 59,  b: 48,  a: 0.85 },
  car:   { r: 255, g: 45,  b: 85,  a: 0.88 },
  train: { r: 175, g: 82,  b: 222, a: 0.90 },
  hsr:   { r: 88,  g: 86,  b: 214, a: 0.92 },
  sct:   { r: 0,   g: 122, b: 255, a: 0.94 },
};

/**
 * 获取当前主题的色阶表
 */
function getSpeedColors(theme) {
  return theme === 'light' ? SPEED_COLORS_LIGHT : SPEED_COLORS_DARK;
}
