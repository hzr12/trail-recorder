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
  // 静止速度阈值（m/s）：约 1km/h。GPS 上报速度低于该值视为静止，此时若位移异常大则判定为漂移鬼点
  TRAIL_STATIONARY_SPEED: 0.3,
  TRAIL_MAX_POINTS: 300000,

  // ----- 自动暂停（记录 Tab 手动开关，默认关闭）-----
  AUTO_PAUSE_WINDOW_S: 10,       // 静止持续时长（秒）达到后自动暂停计时
  AUTO_PAUSE_SPEED: 0.5,         // 低于该速度视为静止（m/s）
  AUTO_PAUSE_RESUME_SPEED: 1.2,  // 高于该速度视为恢复移动（m/s）
  AUTO_PAUSE_STORAGE_KEY: 'trailcraft_autopause',

  // ----- 轨迹清洗（trimEndpoints / filterOutliers）-----
  TRAIL_CLEAN_START_M: 30,          // 起点静止漂移段累计位移阈值（米），累计超过则停止裁剪
  TRAIL_CLEAN_END_M: 30,            // 终点静止漂移段累计位移阈值（米）
  TRAIL_CLEAN_MAX_JUMP_FACTOR: 5,   // 单点跳变相对「速度×时间」的倍数上限，超过判异常

  // ----- 轨迹分段 / 关键点分析 -----
  TRAIL_SEGMENT_MIN_POINTS: 3,   // 速度等级连续 N 个点才切段（防抖）
  TRAIL_SEGMENT_MIN_DIST: 60,    // 段最短距离（米），过短并入相邻段
  TRAIL_SEGMENT_MIN_MS: 10000,   // 段最短时长（毫秒），过短并入相邻段

  // 速度等级表（单一来源：map.js 着色、trail-analysis.js 分段共用）
  TRAIL_SPEED_LEVELS: [
    { mode: 'walk',  max: 2.78,    label: '步行', color: '#00E5CC' },
    { mode: 'bike',  max: 5.56,    label: '骑行', color: '#FFD700' },
    { mode: 'bus',   max: 16.67,   label: '公交', color: '#FF8C00' },
    { mode: 'car',   max: 33.33,   label: '驾车', color: '#FF5E33' },
    { mode: 'train', max: 55.56,   label: '火车', color: '#FF3366' },
    { mode: 'hsr',   max: 97.22,   label: '高铁', color: '#BF40FF' },
    { mode: 'sct',   max: Infinity, label: '超高速', color: '#5E5CE6' },
  ],

  // ----- GPS 节流（百度式速度自适应）-----
  GPS_ADAPTIVE_K: 8000,
  GPS_MIN_INTERVAL: 500,
  GPS_MAX_INTERVAL: 60000,
  GPS_MOVE_THRESHOLD: 0.5,

  // ----- GNSS 弱信号省电联动 -----
  // 进入降级：参与定位卫星数 < GNSS_WEAK_USED_MAX 且 平均信噪比 < GNSS_WEAK_SNR_MAX，持续 GNSS_WEAK_HOLD_MS
  // 恢复降级：参与定位卫星数 >= GNSS_RECOVER_USED_MIN 且 平均信噪比 >= GNSS_RECOVER_SNR_MIN，持续 GNSS_RECOVER_HOLD_MS
  // （恢复阈值高于进入阈值 → 滞回带，避免边界抖动频繁切换）
  GNSS_WEAK_USED_MAX: 4,                // 进入阈值：参与定位卫星数上限
  GNSS_WEAK_SNR_MAX: 25,                // 进入阈值：平均信噪比上限（dB-Hz）
  GNSS_RECOVER_USED_MIN: 6,             // 恢复阈值：参与定位卫星数下限（滞回）
  GNSS_RECOVER_SNR_MIN: 30,             // 恢复阈值：平均信噪比下限（滞回）
  GNSS_WEAK_HOLD_MS: 30000,             // 进入需持续时长（GNSS 事件约 1s/次 → 约 30 次）
  GNSS_RECOVER_HOLD_MS: 10000,          // 恢复需持续时长（约 10 次）
  GPS_WEAK_SIGNAL_INTERVAL: 120000,     // 弱信号期间定位心跳间隔（ms），覆盖 GPS_MAX_INTERVAL
  GPS_WEAK_SIGNAL_LOW_ACCURACY: false,  // 弱信号是否同时降精度（重启 watch 用低精度，更省电但有重启失锁风险）

  // ----- GNSS NMEA（原生插件推送：UTC 时钟校准 + $GPVTG 航向/速度）-----
  NMEA_VTG_MAX_AGE_MS: 2000,    // $GPVTG 航向/速度有效窗口：超过视为过期，回退浏览器 coords
  NMEA_UTC_MAX_AGE_MS: 5000,    // UTC 校准漂移窗口：新 RMC 相对已校准时钟超窗视为陈旧回灌，不采纳

  // ----- GNSS 定位源接管（折中方案：原生主导 + 浏览器低频兜底）-----
  GPS_TAKEOVER_MIN_SATS: 4,             // 接管所需最少参与定位卫星数
  GPS_TAKEOVER_HDOP: 4,                 // HDOP 优于此值视为信号好（原生主导）
  GPS_NATIVE_FALLBACK_INTERVAL: 30000,  // native 档浏览器兜底心跳间隔（ms）
  GPS_NATIVE_FALLBACK_MAX_AGE: 30000,   // native 档浏览器 maximumAge（ms）
  GPS_SOURCE_HOLD_MS: 5000,             // 源切换滞回持续时长（防边界抖动，约 1s/次 GNSS 事件）

  // ----- GNSS NMEA 增强（GGA 海拔 / GSA DOP / RMC 交叉验证）-----
  NMEA_GGA_MAX_AGE_MS: 5000,    // $GPGGA 海拔/大地水准面分离有效窗口
  NMEA_GSA_MAX_AGE_MS: 3000,    // $G?GSA PDOP/HDOP/VDOP 有效窗口
  NMEA_RMC_MAX_AGE_MS: 5000,    // $GPRMC 速度/航向/定位有效性有效窗口
  NMEA_SPEED_CONFLICT_RATIO: 0.3,   // VTG vs RMC 速度相对偏差比例阈值（超过触发冲突）
  NMEA_SPEED_CONFLICT_ABS: 2.0,     // VTG vs RMC 速度绝对偏差阈值（m/s）
  NMEA_HEADING_CONFLICT_DEG: 30,    // VTG vs RMC 航向偏差阈值（度）
  NMEA_HEADING_MIN_SPEED: 1.0,      // 低于此速度（m/s）航向无意义，不参与交叉验证
  NMEA_COORD_CONFLICT_M: 30,        // 原生 GGA/RMC 经纬度 vs 浏览器点偏差阈值（米），超过标记可疑
  NMEA_COORD_CONFLICT_STREAK: 3,    // 连续 N 次偏差超阈才判定"原生坐标不可信"（防抖）

  // Huber Loss 鲁棒滤波「基准阈值」（标准化残差，无量纲）：0 禁用（纯最小二乘）。
  // |残差|/σ 超过该值的测量被降权（M-估计），抑制 GPS 粗差/漂移点。
  // 实际生效阈值由 KalmanFilter._huberKFor() 按「速度+精度」启发式在此基准上自动缩放
  // （低速静止漂移压狠、高速机动放宽、精度差收紧），用户无需手动调参。
  // 默认 2.0 ≈ 2σ 截断。
  GPS_HUBER_K: 2.0,

  // ----- 海拔独立滤波（完全自洽，不依赖水平滤波/Huber/RTS 机制）-----
  // 四级融合：L1 源头质量门(_resolveAltitude) → L2 1D 自适应卡尔曼(AltKalmanFilter)
  // → L3 中值预滤波 + 自适应 Huber(AltFilterPipeline) → L4 离线 1D RTS(AltRtsSmoother)。
  // 海拔链只消费「原始海拔 + 时间戳 + 口径来源(gga/browser)」，参数全走 ALT_*，
  // 不读精度/水平速度/GPS_HUBER_K，实时滤波与离线平滑各自独立自洽。
  ALT_FILTER_ENABLED: true,           // 实时海拔融合总开关
  ALT_FILTER_RTS_ENABLED: true,       // 离线 1D RTS 平滑（必须启用，结束记录后处理）
  ALT_KALMAN_R_BASE: 64,              // 垂直观测噪声方差基准（~8m²）
  ALT_KALMAN_R_MIN: 16,               // 自适应 R 下限（~4m²）
  ALT_KALMAN_R_MAX: 900,              // 自适应 R 上限（~30m²）
  ALT_KALMAN_Q_BASE: 0.5,             // 垂直动态噪声基准（固定，不随水平速度缩放）
  ALT_KALMAN_Q_MAX: 8,                // 自适应 Q 上限（垂直速度大时放宽）
  ALT_KALMAN_Q_REF_VEL: 5,            // Q 自适应参考垂直速度（m/s）
  ALT_RESIDUAL_WINDOW: 20,            // 残差滑动窗口（自适应 R/Huber 估计共用）
  ALT_MEDIAN_WINDOW: 5,               // 中值预滤波窗口（奇数，去瞬态尖刺）
  ALT_HUBER_K: 2.0,                   // 海拔残差 Huber 阈值系数（×鲁棒尺度 σ̂，自适应）
  ALT_HUBER_K_MIN: 1.0,               // Huber 阈值下限（σ̂ 倍数，防止过度收缩）
  ALT_VELOCITY_LIMIT: 30,             // 海拔变化速率上限（m/s）
  ALT_RTS_ALPHA_MAX: 0.3,             // 海拔 RTS 反向平滑最大权重（残差大时）
  ALT_RTS_ALPHA_MIN: 0.1,             // 海拔 RTS 反向平滑最小权重（残差小时）

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
  if (val < 1000) return `${val}m`;
  if (val < 10000) return `${(val / 1000).toFixed(2)}km`;
  return `${(val / 1000).toFixed(1)}km`;
}

/**
 * 格式化时长文字（单一来源：缩略图统计条、分段标签共用）
 */
function formatDurationShort(ms) {
  if (!ms || ms <= 0) return '--';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
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

/**
 * 统一北京时间格式化（UTC 绝对毫秒 → Asia/Shanghai 东八区展示）。
 * 存储层保持 Unix 毫秒（UTC 绝对时间），仅"给人看"的展示用此函数。
 * @param {number} ts  UTC 毫秒时间戳
 * @param {boolean} [withDate] true 输出 "2026/08/09 14:30"，false 仅 "14:30"
 */
function formatBeijing(ts, withDate = true) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const opt = withDate
    ? { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' };
  return d.toLocaleString('zh-CN', opt);
}
