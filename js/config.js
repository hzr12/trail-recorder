/**
 * 途刻 TraceCraft - 配置
 * ============================================
 * 所有可调参数集中管理
 */

const CONFIG = {
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
  GRAVITY: 9.81,                   // 标准重力加速度（m/s²，IMU U 轴泄漏比估计用）

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

  // ----- 速度曲线 / GPS 状态 UI -----
  SPEED_HISTORY_MAX: 2500,     // 速度曲线历史样本上限
  SPEED_CHART_WINDOW: 2500,    // 速度曲线图表显示窗口（与历史上限一致）

  // ----- 后台定位（页面隐藏时）-----
  BG_LOCATE_INTERVAL_NORMAL: 5000,    // 有电时后台定位间隔（ms）
  BG_LOCATE_INTERVAL_POWER_SAVE: 20000, // 省电时后台定位间隔（ms）
  NATIVE_BG_MIN_INTERVAL: 5000,       // 原生后台定位最小上报间隔（ms）

  // ----- 轨迹视觉抽稀（map.js / replay.js 共用）-----
  TRAIL_DECIMATE_MIN_ZOOM_LIMIT: 2000,   // zoom 抽稀下限（最低密度）
  TRAIL_DECIMATE_MAX_ZOOM_LIMIT: 20000,  // zoom 抽稀上限（最高密度）
  TRAIL_DECIMATE_ZOOM_BASE: 12,          // 密度随 zoom 增长基准
  REPLAY_DECIMATE_MAX_POINTS: 4000,      // 回放路径视觉抽稀上限
  THUMB_DECIMATE_MAX_POINTS: 6000,       // 缩略图/分享图抽稀上限
  REPLAY_START_DELAY: 300,               // 列表点击回放后延迟启动（等面板切换动画）

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

  // ----- 航向兜底（位置差分，GPS 航向缺失/低速时）-----
  // GPS 航向（VTG/浏览器 heading）低速或无信号时无意义，导致箭头乱抖。
  // 用滤波后相邻两点的位移反推航向（atan2(dE, dN)）做兜底，一阶低通平滑。
  // 位移过小（静止）不更新，保持上次方向；高速且 GPS 航向有效时始终以 GPS 为权威。
  HEADING_DIFF_MIN_M: 2.0,          // 相邻滤波点位移低于此值（m）不更新差分航向（防静止噪声）
  HEADING_DIFF_MIN_SPEED: 1.0,      // 低于此速度（m/s）即视为低速，GPS 航向不再可信 → 用差分兜底
  HEADING_DIFF_LPF_ALPHA: 0.3,      // 差分航向一阶低通系数（0=保持旧值，1=全信最新差分）

  // Huber Loss 鲁棒滤波「基准阈值」（标准化残差，无量纲）：0 禁用（纯最小二乘）。
  // |残差|/σ 超过该值的测量被降权（M-估计），抑制 GPS 粗差/漂移点。
  // 实际生效阈值由 KalmanFilter._huberKFor() 按「速度+精度」启发式在此基准上自动缩放
  // （低速静止漂移压狠、高速机动放宽、精度差收紧），用户无需手动调参。
  // 默认 2.0 ≈ 2σ 截断。
  GPS_HUBER_K: 2.0,

  // ----- IMM 交互式多模型滤波（实时定位，取代原单模型自适应 Q）-----
  // 三模型统一 6 维状态 [x,y,vx,vy,ax,ay]（局部 ENU 米坐标），差异仅在加速度过程噪声
  // q_a（标准差）：STILL 极小 Q 强抑漂移、CV 中 Q 匀速跟随、CA 大 Q 机动跟踪。
  // 模型间切换完全由「马尔可夫转移概率 × 测量似然」驱动，取代旧实现按速度手动调 q 的
  // 启发式，逻辑更纯粹。Huber/冻结/时间重置/重锚/速度限幅等保护机制全部保留。
  IMM_FILTER_ENABLED: true,          // 实时滤波总开关（false 回退单模型 KalmanFilter）
  IMM_MODEL_Q: [0.05, 0.25, 1.0],    // STILL/CV/CA 三模型加速度过程噪声（m/s²，标准差）
  IMM_TRANSITION: [                   // 马尔可夫转移矩阵 Π[i][j] = P(下一时刻模型=i | 当前=模型j)
    [0.98, 0.015, 0.005],            // 列和=1（构造时自动归一防御）；STILL 惯性最强，CA 直连最弱
    [0.015, 0.97, 0.015],
    [0.005, 0.015, 0.98],
  ],
  IMM_INIT_PROB: [0.6, 0.3, 0.1],    // 初始模型概率（STILL/CV/CA）
  IMM_POS_VAR: 2500,                 // 初始位置方差（米²，与单模型一致）
  IMM_VEL_VAR: 0,                    // 初始速度方差（米²/s²，新轨迹速度未知）
  IMM_ACC_VAR: 4,                    // 初始加速度方差（米²/s⁴，适度初始不确定度）
  IMM_REANCHOR_M: 3000,              // 距参考点超此距离重锚（米，与单模型一致）
  IMM_SPEED_LIMIT: 120,              // 模型速度模量限幅（m/s ≈ 432km/h）
  IMM_FREEZE_ACC: 1750,              // 精度超此值冻结在最后可信位置（米，放宽：1750m 内均正常滤波）
  IMM_LIKELIHOOD_TEMP: 2.0,          // 模型似然温度 γ（Λ^γ 放大模型差异，加速强模型主导；1 为标准 IMM）
  IMM_SPEED_PRIOR: true,             // 速度辅助模型先验（用 GPS 上报 speed 软门控模型切换，弥补纯位置观测辨识慢）
  IMM_MIN_PROB: 1e-6,                // 模型概率下界（防浮点死锁）

  // ----- IMU 惯性导航融合（仅定位校准：加速度注入辅助滤波，不做航迹推算）-----
  // 职责收窄：只消费 TYPE_LINEAR_ACCELERATION（去重力线性加速度），用 rotation 四元数
  // 旋转到 ENU 地理系 → 滑窗均值（近 IMU_FEED_INTERVAL_MS 窗口，分 IMU_WIN_BUCKETS 个桶
  // 环形缓冲持续输出）→ 一阶低通 → 注入 ImmFilter 的 CA 模型预测
  // （x⁻=F·x̂+G·a_imu，仅运动学先验，GPS 仍是位置权威）。
  // 姿态-加速度时间对齐：插件下发 rotationTs（姿态事件时间戳），JS 侧姿态环形缓冲按
  // 加速度事件时间戳查询最近姿态（偏差 > IMU_ROT_MAX_DT_MS 视为不匹配，安全降级）。
  // 三轴输出：旋转后的 E/N/U 全部保留；U 轴（垂直）用于海拔卡尔曼 CA 注入（方向 3），
  // 并做 U 轴偏置统计估计重力泄漏量级，衰减水平注入（方向 6）。
  // 注入强度自适应：IMU 推断速度变化与滤波速度变化方向一致 → trust 抬升，冲突 → 回落
  // （方向 4）；clamp 按 GPS 速度分级：静止收紧防噪声、高速放宽保机动（方向 5）。
  // 航向由 GPS 权威（NMEA VTG/RMC + 浏览器 coords.heading），GPS 航向缺失/低速时由
  // HEADING_DIFF_* 位置差分兜底；IMU 不参与航向解算。
  // 不做 GPS 丢失时的纯推算（无 predictOnly / DR 状态机）。web 端无插件零回归。
  // IMU_HORIZONTAL_REQUIRE_HEADING：水平 E/N 注入要求 GPS 航向可靠（非低速且航向源有效）。
  // 单靠加速度计在数学上不可观测航向（绕重力轴旋转不可解），航向缺失时水平注入方向
  // 会差一个未知固定角 → 错误拉偏轨迹。故航向不可靠（低速起步/遮挡/丢星）时禁用水平
  // 注入、只保留 U 轴海拔注入（垂直不依赖航向，只依赖俯仰/翻滚，是加速度可观测部分）。
  // 设 false 则回归旧行为（航向缺失仍注入水平，靠 tiltLeakFactor/trust 自适应兜底）。
  IMU_HORIZONTAL_REQUIRE_HEADING: true,
  IMU_ENABLED: true,               // IMU 总开关（false 完全禁用；web 无插件自动跳过）
  IMU_FEED_INTERVAL_MS: 1000,      // 加速度滑窗聚合时长（1Hz，对齐 GPS 秒级步长）
  IMU_WIN_BUCKETS: 4,              // 滑窗分桶数（窗口均分，桶粒度=窗口/桶数，滑动输出近 1s 均值）
  IMU_FEED_MAX_AGE_MS: 2000,       // 聚合值新鲜度上限：超时视为过期不注入（防陈旧数据）
  IMU_ACC_LPF_ALPHA: 0.4,          // 窗口均值后一阶低通系数（0=保持旧值，1=全信最新均值）
  IMU_ACC_TRUST: 0.6,              // 注入强度基础值（0=纯 GPS，1=完全信任 IMU 加速度；随一致性自适应）
  IMU_ACC_TRUST_MIN: 0.2,          // trust 自适应下限（一致性冲突/低速噪声时回落）
  IMU_ACC_TRUST_MAX: 0.8,          // trust 自适应上限（一致性一致时抬升）
  IMU_TRUST_STEP: 0.08,            // trust 每帧调整步长（方向一致性余弦加权）
  IMU_TRUST_LOWSPEED_RETURN: 0.05, // 低速（<0.5m/s）时 trust 回归基础值的速率（GPS 速度噪声大，一致性不可靠）
  IMU_ACC_CLAMP: 30,               // 加速度绝对安全上限（m/s²，防传感器粗差；注入前再按速度分级收紧）
  IMU_ACC_CLAMP_LEVELS: [          // 注入 clamp 分级（按 GPS 速度 m/s）：静止收紧防噪声、高速放宽保机动
    { maxSpeed: 1, clamp: 1.0 },    // 静止：微小抖动视为噪声
    { maxSpeed: 3, clamp: 3.0 },    // 步行
    { maxSpeed: 8, clamp: 6.0 },    // 骑行
    { maxSpeed: Infinity, clamp: 10.0 }, // 机动/高速
  ],
  IMU_MIN_USED_SATS: 5,            // 参与定位（解算中）卫星数阈值：仅当 usedInFix 卫星数 > 此值时才启用 IMU
  IMU_ROT_MAX_DT_MS: 200,          // 姿态-加速度最大时间差（毫秒）：姿态事件与加速度事件时间戳偏差超此值视为不匹配，安全降级不注入
  IMU_ROT_BUF_MAX: 32,             // 姿态环形缓冲容量（姿态约 5-10Hz，32 条 ≈ 3-6s 历史）
  IMU_U_RMS_LPF_ALPHA: 0.2,        // U 轴抖动 RMS 一阶低通系数（垂直动态检测）
  IMU_U_BIAS_LPF_ALPHA: 0.05,      // U 轴偏置慢速低通系数（姿态误差 → 重力泄漏到水平轴的量级估计）
  IMU_U_BIAS_LOW_RMS_MAX: 1.0,     // 仅当 U 轴 RMS 低于此值（m/s²，低动态）才更新偏置（防运动加速度污染）

  // ----- 海拔独立滤波（完全自洽，不依赖水平滤波/Huber/RTS 机制）-----
  // 四级融合：L1 源头质量门(_resolveAltitude) → L2 1D 自适应卡尔曼(AltKalmanFilter)
  // → L3 中值预滤波 + 自适应 Huber(AltFilterPipeline) → L4 离线 1D RTS(AltRtsSmoother)。
  // 海拔链只消费「原始海拔 + 时间戳 + 口径来源(gga/browser)」，参数全走 ALT_*，
  // 不读精度/水平速度/GPS_HUBER_K，实时滤波与离线平滑各自独立自洽。
  ALT_FILTER_ENABLED: true,           // 实时海拔融合总开关
  ALT_IMU_ENABLED: true,              // 海拔 IMU 融合（垂直加速度注入 CA 模型）总开关；web 无插件自动跳过
  ALT_IMU_TRUST: 0.5,                 // 垂直注入强度（0=纯 GPS，1=完全信任；U 轴依赖姿态四元数，默认比水平略保守）
  ALT_IMU_U_CLAMP_LEVELS: [           // 垂直注入 clamp 分级（垂直动作幅度通常大于水平，略微放宽）
    { maxSpeed: 1, clamp: 2.0 },
    { maxSpeed: 3, clamp: 4.0 },
    { maxSpeed: 8, clamp: 8.0 },
    { maxSpeed: Infinity, clamp: 10.0 },
  ],
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
  DB_VERSION: 2,
  DB_STORE_TRAIL: 'trail',
  DB_STORE_META: 'trail_meta',
  DB_MAX_SIZE: 200 * 1024 * 1024,

  LS_MAX_SIZE: 5 * 1024 * 1024,

  // 紧急快照 key：页面被强杀时 IndexedDB 异步写可能丢失，用 localStorage 同步兜底
  TRAIL_EMERGENCY_KEY: 'trailcraft_emergency',

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

/**
 * 本地时区日期时间格式化（单一来源：详情弹窗、统计弹窗、导出报告共用）。
 * @param {number} ts 毫秒时间戳
 * @param {Object} [opts]
 * @param {boolean} [opts.withSeconds=false] 是否输出秒
 * @param {boolean} [opts.shortDate=false] 短日期 "M/D"，否则 "YYYY-MM-DD"
 * @returns {string} 如 "2026-08-10 14:30" 或 "8/10 14:30:05"
 */
function formatDateTime(ts, opts) {
  const o = opts || {};
  if (!ts) return '--';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '--';
  const pad = (n) => String(n).padStart(2, '0');
  const datePart = o.shortDate
    ? `${d.getMonth() + 1}/${d.getDate()}`
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timePart = o.withSeconds
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${datePart} ${timePart}`;
}

/**
 * 时长格式化（单一来源：详情弹窗、统计弹窗、导出报告共用）。
 * "1:02:03" / "5:03" / "42秒"，与 formatDurationShort 的中文长格式互补。
 * @param {number} ms 毫秒
 * @returns {string}
 */
function formatDurationLong(ms) {
  if (!ms || ms <= 0) return '--';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  if (m > 0) return `${m}:${String(sec).padStart(2, '0')}`;
  return `${sec}秒`;
}
