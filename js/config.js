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
  // 计划 #3：动态采样距离 + 抖动门限（app-core.js _recordFix 使用）
  // 抖动丢弃：滤波位置相对上帧入库点位移 < accuracy×JITTER_RATIO 且低速 → 视为噪声不入库
  TRAIL_JITTER_RATIO: 0.5,
  TRAIL_JITTER_RATIO_DUALBAND: 0.3, // 模块1：双频可用时点更可信，更难被判为抖动（门槛更严）
  TRAIL_JITTER_MAX_SPEED: 0.6,   // 低于此速度(m/s)才启用抖动丢弃
  GNSS_ZUPT_FRAMES: 3,           // 模块2：连续 N 帧平滑速度<MAX_SPEED → 钉零速（ZUPT 静止）
  TRAIL_SAMPLE_FAST_SCALE: 2,    // 高速(>5m/s)时采样距离放宽倍数
  TRAIL_SAMPLE_FAST_SPEED: 5,    // 超过此速度(m/s)视为高速，放宽采样
  // 转弯强制采样（保弯）：相邻入库段航向变化超阈值且速度够 → 强制入库，
  // 绕过 dynMin 与抖动门限，避免固定距离采样把弯道"切直"（OsmAnd 式形状保真）。
  // 注意：Hampel 鬼点拒绝仍生效，跳变点不会被判成转弯而入库。
  TRAIL_TURN_FORCE_SAMPLE: true, // 总开关
  TRAIL_TURN_ANGLE_DEG: 20,      // 航向变化超此值(度)视为转弯
  TRAIL_TURN_MIN_SPEED: 0.5,     // 低于此速度(m/s)不计转弯（静止抖动误触发）
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

  // ----- 轨迹级后处理（RTS 平滑增强 / 跳变修复 / 运动学约束）-----
  // 离线 RTS 的 accuracy→R 权重曲线：sigma 由 accuracy 决定，r=sigma^2；
  // 该指数让低精度点（accuracy 大）的测量噪声权重被放大（RTS 更信任模型预测），
  // 高精度点反向。1=当前行为，>1 更激进地按精度区分。
  RTS_ACC_WEIGHT: 1.3,
  // 时间戳缺口：dt 超过该秒数即视为段间缺口（仍保留缺口点参与输出，避免回放时间轴断裂）
  RTS_GAP_MAX_DT_S: 60,
  // 跳变修复（denoiseTrail）：相对「速度×时间」的倍数上限（超过判跳变），与清洗同源
  TRAIL_DENOISE_MAX_JUMP_FACTOR: 5,
  // 跳变修复：基础兜底阈值（米），无速度信息时仍生效
  TRAIL_DENOISE_BASE_M: 10,
  // —— 信号丢失段标记（计划 A）——
  SIGNAL_LOSS_MIN_WEAK_PTS: 3,        // 连续弱信号点数达此值才标为「信号丢失段」
  SIGNAL_LOSS_GREY: '#888888',        // 丢星段灰色
  // —— 记录健康分（计划 E）——
  HEALTH_GRADE_THRESHOLDS: [0.9, 0.75, 0.6], // A / B / C / D 分数阈值
  // —— 海拔海平面基准校准（计划 D）——
  ALT_USE_GEOID_BASELINE: true,       // 用 GPGGA 大地水准面分离校正本地海拔基准
  ALT_GEOID_MAX_DIFF_M: 200,          // 大地水准面差超此值放弃校正（防坏数据跨城跳变）
  // 运动学约束（kinematicClamp）：对平滑/修复后序列的物理可行性兜底纠偏（独立一步，不改 RTS 核心）
  TRAIL_KINEMATIC_MAX_SPEED: 60,    // 单段最大瞬时速度（m/s），约 216km/h，超出视为不可信
  TRAIL_KINEMATIC_MAX_ACC: 12,      // 单段最大加速度（m/s²），约 1.2g，超出视为跳变残差

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
  GNSS_WEAK_EVAL_INTERVAL_MS: 5000,     // 弱信号状态机常驻重算间隔（与卫星事件流解耦，防事件停推时徽章冻结）
  GPS_WEAK_SIGNAL_INTERVAL: 120000,     // 弱信号期间定位心跳间隔（ms），覆盖 GPS_MAX_INTERVAL
  GPS_WEAK_SIGNAL_LOW_ACCURACY: false,  // 弱信号是否同时降精度（重启 watch 用低精度，更省电但有重启失锁风险）

  // ----- GNSS NMEA（原生插件推送：UTC 时钟校准 + $GPVTG 航向/速度）-----
  NMEA_VTG_MAX_AGE_MS: 2000,    // $GPVTG 航向/速度有效窗口：超过视为过期，回退浏览器 coords
  NMEA_UTC_MAX_AGE_MS: 5000,    // UTC 校准漂移窗口：新 RMC 相对已校准时钟超窗视为陈旧回灌，不采纳

  // ----- GPS 时钟漂移补偿（任务D，仅 web/无 NMEA 时启用）-----
  GPS_TS_DRIFT_WIN: 10,         // 漂移滑动均值窗口（个 fix）

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
  NMEA_HEADING_MIN_SPEED: 0.4,      // 低于此速度（m/s）航向无意义，不参与交叉验证
  NMEA_COORD_CONFLICT_M: 30,        // 原生 GGA/RMC 经纬度 vs 浏览器点偏差阈值（米），超过标记可疑
  NMEA_COORD_CONFLICT_STREAK: 3,    // 连续 N 次偏差超阈才判定"原生坐标不可信"（防抖）

  // ----- 航向兜底（位置差分，GPS 航向缺失/低速时）-----
  // GPS 航向（VTG/浏览器 heading）低速或无信号时无意义，导致箭头乱抖。
  // 用滤波后相邻两点的位移反推航向（atan2(dE, dN)）做兜底，一阶低通平滑。
  // 位移过小（静止）不更新，保持上次方向；高速且 GPS 航向有效时始终以 GPS 为权威。
  HEADING_DIFF_MIN_M: 2.0,          // 相邻滤波点位移低于此值（m）不更新差分航向（防静止噪声）
  HEADING_DIFF_MIN_SPEED: 0.4,      // 低于此速度（m/s）即视为低速，GPS 航向不再可信 → 用差分兜底
  HEADING_DIFF_LPF_ALPHA: 0.3,      // 差分航向一阶低通系数（0=保持旧值，1=全信最新差分）

  // Huber Loss 鲁棒滤波「基准阈值」（标准化残差，无量纲）：0 禁用（纯最小二乘）。
  // |残差|/σ 超过该值的测量被降权（M-估计），抑制 GPS 粗差/漂移点。
  // 实际生效阈值由 KalmanFilter._huberKFor() 按「速度+精度」启发式在此基准上自动缩放
  // （低速静止漂移压狠、高速机动放宽、精度差收紧），用户无需手动调参。
  // 默认 2.0 ≈ 2σ 截断。
  GPS_HUBER_K: 2.0,

  // ----- 实时位置稳健滑动窗滤波（替代已删除的 IMM/Kalman 实时 2D 滤波）-----
  // 设计约束：零外推（输出永远落在已观测点之间，绝不按最后速度前冲）。
  // 算法：滑动窗中位数 + Hampel 鬼点截断 + 静止冻结 + 丢点冻结。
  // 行业依据：OsmAnd 阈值筛选 / GPSBabel 距离去抖 / Strava 后处理忽略坏点，
  // 均不做实时外推卡尔曼。
  // 模块1 多GNSS星座/双频融合：GNSS 质量评分权重——把卫星统计反哺平滑强度
  // qualScore 归一化 0~1：星越多、星座越多样、双频可用 → 评分越高（点越可信）。
  GNSS_QUAL: {
    USED_W: 1.0,          // 每颗参与解算星的基础分
    CONST_DIV_W: 2.0,     // 每多一个可用星座系统的加成（多系统抗遮挡）
    DUALBAND_W: 3.0,      // 双频可用加成
    MAX: 16,              // 评分上限（归一化分母）
    WEAK_USED_MAX: 4,     // used 星数 < 此值视为弱信号
  },

  POS_FILTER: {
    ENABLED: true,            // 总开关（关闭则蓝点=原始单次定位，行为等同删滤波前）
    WIN: 5,                   // 滑动窗大小（个 fix，奇数；约 5s 窗口）
    MAD_K: 3,                 // Hampel 截断倍数（残差 > k·MAD 视为鬼点，用中位数替换）
    FREEZE_DT_MS: 3000,       // 丢点冻结：距上次定位超此值(ms)直接回退原始点，不外推
    STATIC_RATIO: 1.0,        // 静止判定：位移 < accuracy×该值 → 输出原始点（防拖影）
    // 模块1：qualScore → 平滑强度自适应
    QUAL_ADAPT: true,            // 用 GNSS 质量评分调节 Hampel 阈值与静止门限
    QUAL_DUALBAND_MAD_K: 4,      // 双频/星多可用时放宽 Hampel（点更可信，少丢有效点）
    QUAL_WEAK_MAD_K: 2,          // 弱信号（星少单频）时收紧 Hampel（更信模型）
    QUAL_WEAK_STATIC_RATIO: 0.7, // 弱信号时更易判定静止（防抖动拖影）
    // 模块3：卫星加权（仰角掩码 + C/N0 加权），由速度因子自适应插值（见 GNSS_* 配置）
    ADAPTIVE_WEIGHT: true,       // 启用逐星权重（web 端无 elevation 时自动退化为仅 C/N0）
    WEIGHT_ELEV_FLOOR: 0.3,      // 低仰角星最低权重（仰角≥mask 时从 floor 升到 1）
    WEIGHT_ELEV_SPAN_DEG: 60,    // 仰角从 mask 升到满权所需跨度（度）
  },

  // ----- 模块3：卫星加权速度自适应（仰角掩码 + C/N0 门限随速度插值）-----
  // 低速（步行）保卫星数：掩码放宽、C/N0 门限低；
  // 高速（驾车/高铁）保信号干净：掩码收紧、C/N0 门限高，压多径。
  GNSS_SPEED_SLOW_MAX: 2,        // ≤此速度(m/s)视为步行/静止 → 取 slow 档参数
  GNSS_SPEED_FAST_MIN: 15,       // ≥此速度(m/s)视为驾车/高铁 → 取 fast 档参数
  GNSS_SPEED_HYST: 2,            // 速度因子滞回带(m/s)，防档位边缘颤动
  GNSS_ELEV_MASK_SLOW: 3,        // 步行仰角掩码(度)：尽量多收星
  GNSS_ELEV_MASK_FAST: 25,       // 驾车仰角掩码(度)：收紧压多径
  GNSS_CN0_MIN_SLOW: 15,         // 步行 C/N0 门限(dB-Hz)：弱星也接纳
  GNSS_CN0_MIN_FAST: 28,         // 驾车 C/N0 门限(dB-Hz)：只留强星
  GNSS_CN0_LERP_LOW: 18,         // C/N0 权重起算点(dB-Hz，固定)
  GNSS_CN0_LERP_HIGH_SLOW: 30,   // 步行 C/N0 达此值即满权
  GNSS_CN0_LERP_HIGH_FAST: 40,   // 驾车 C/N0 需达此值才满权

  // ----- 模块4：多星座（Multi-GNSS）独立约束 -----
  // 核心：区分"4 颗全在一个星座"(几何弱) 与 "4 颗分布 4 星座"(几何鲁棒)。
  // 仅原生端生效（浏览器不暴露星座/频段，_computeSatStats 不跑 → 零回归）。
  GNSS_MULTI_CONST: {
    ENABLED: true,                  // 总开关
    MIN_PER_CONST: 1,               // 每个参与星座至少需 1 颗加权有效星，否则该星座视为不可信
    MIN_CONST_FOR_TRUST: 2,         // 可信解算至少需 2 个独立星座（单星座几何弱）
    SINGLE_CONST_PENALTY: 0.6,      // 仅单星座(且总星数达门槛)时，qualScore 乘此惩罚 → 平滑自动收紧
    GDOP_FLOOR_CONST: 4,            // 单星座可用星数下限：低于则几何差，触发弱信号
  },

  // ----- 计划 #6：多频/双频 GNSS 融合（可用即用、不可用降级单频）-----
  // GNSS_DUALBAND_* 仍被 GPSManager.dualBandAvailable / _starWeight 使用（原生端卫星统计，与实时滤波解耦），保留。
  GNSS_DUALBAND_ENABLED: true,     // 总开关；false → 全程按单频处理
  GNSS_DUALBAND_R_SCALE: 0.7,      // 双频卫星观测噪声缩放（<1 更可信）：_starWeight 中权重 w /= R_SCALE（封顶 1）
  // 双频/多频频段表（MHz）：L5/E5a(1176.45)、B2a(1191.795)、E5b(1207.14)、L2(1227.60) 等
  // 单星 carrierFreqHz 落入任一频段即视为双频星（比"同系统 L1+L5 共存"更宽松，单颗 L5 星也加权）。
  GNSS_DUALBAND_BANDS: [
    { lo: 1170, hi: 1185 },   // GPS L5 / Galileo E5a / NavIC L5
    { lo: 1188, hi: 1194 },   // BDS B2a
    { lo: 1202, hi: 1212 },   // Galileo E5b / E5
    { lo: 1222, hi: 1232 },   // GPS L2 / BDS B2I/B2b
    { lo: 1565, hi: 1585 },   // L1 主频段（用于同系统双频共存探测，与 L5 配对）
  ],

  // ----- IMU 惯性导航融合（仅定位校准：加速度注入辅助滤波，不做航迹推算）-----
  // 职责收窄：只消费 TYPE_LINEAR_ACCELERATION（去重力线性加速度），用 rotation 四元数
  // 旋转到 ENU 地理系 → 滑窗均值（近 IMU_FEED_INTERVAL_MS 窗口，分 IMU_WIN_BUCKETS 个桶
  // 环形缓冲持续输出）→ 一阶低通 → 注入离线 RTS 平滑器（KalmanFilter._offlineSmoother）
  // 的 CA 模型预测（x⁻=F·x̂+G·a_imu，仅运动学先验，GPS 仍是位置权威）。
  // 注：实时 2D 位置滤波（原 ImmFilter）已硬删，蓝点=原始单次定位，消除高铁/隧道外推漂移；
  // IMU 仅作离线平滑的运动学先验注入，不影响实时定位。
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
  IMU_BIAS_STILL_SPEED: 0.3,       // 零偏学习"真静止"的 GPS 速度阈值（m/s）：速度低于此且 U 轴低动态才更新 E/N/U 零偏
  IMU_BIAS_MIN_STILL: 30,          // 偏置可信度门槛：连续静止帧数达此值才启用 E/N 零偏扣除（防运动段误学立即污染）

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

  // 轨迹持久化节流窗口（毫秒）：_trailDirty 置位后，至少间隔此时间才真正写盘。
  // 避免长轨迹（数万点）每次采样都触发 IndexedDB 全量序列化写入。pagehide/停止记录/
  // 恢复等关键点仍会强制立即保存（见 _forceSaveTrail）。
  TRAIL_SAVE_THROTTLE_MS: 5000,

  // ----- Debug -----
  DEBUG: false,

  // ----- UI -----
  MOBILE_BREAKPOINT: 480,
  DEFAULT_TOAST_DURATION: 3000,
  TOAST_FADE_MS: 300,
};

/**
 * 全局日志代理（替代散落的 console.* 调用）。
 * 受 CONFIG.DEBUG 控制：DEBUG=false 时 log/info/debug 静默，warn/error 始终输出（保留线上可观测性）。
 * 用法：Logger.log(...) / Logger.warn(...) / Logger.error(...) 等。
 */
const Logger = {
  _enabled() { return typeof CONFIG !== 'undefined' && CONFIG.DEBUG === true; },
  log(...a)   { if (this._enabled()) console.log('[TraceCraft]', ...a); },
  info(...a)  { if (this._enabled()) console.info('[TraceCraft]', ...a); },
  debug(...a) { if (this._enabled()) console.debug('[TraceCraft]', ...a); },
  warn(...a)  { console.warn('[TraceCraft]', ...a); },
  error(...a) { console.error('[TraceCraft]', ...a); },
};

/**
 * 绝对中位差（MAD）：输入已排序数组 arr 与其中位数 med，返回各元素与 med 偏差的中位数。
 * 鲁棒离散度估计，配合 MAD_K 用于 Hampel 鬼点检测（轨迹入库去抖）。
 */
function medianAbsDev(sortedArr, med) {
  const n = sortedArr.length;
  if (!n) return 0;
  const dev = new Array(n);
  for (let i = 0; i < n; i++) dev[i] = Math.abs(sortedArr[i] - med);
  dev.sort((a, b) => a - b);
  return dev[Math.floor(n / 2)];
}

/**
 * 计算两点之间的球面距离（Haversine 公式）。
 * 单一实现来源：不依赖腾讯地图 SDK 加载时机，结果稳定可复现（与 SDK 实现有亚米级差异，
 * 统一手写实现可避免"SDK 加载先后导致结果不一致"的隐患）。
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
 * 计算从 p1 到 p2 的方位角（正北顺时针）。
 * 单一实现来源：不依赖腾讯地图 SDK（见 calcDistance 说明）。
 */
function calcBearing(p1, p2) {
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
 * 日期时间格式化（单一来源：详情弹窗、统计弹窗、导出报告共用）。
 * 统一使用东八区（北京时间）展示，与 formatBeijing 保持一致——全站时间给人看时
 * 固定为北京时间，避免"同一 createdAt 在不同时区设备/弹窗显示不一致"。
 * @param {number} ts 毫秒时间戳（UTC 绝对时间）
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
  const base = { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' };
  const datePart = o.shortDate
    ? { month: 'numeric', day: 'numeric' }
    : { year: 'numeric', month: '2-digit', day: '2-digit' };
  const timePart = o.withSeconds ? { second: '2-digit' } : {};
  const fmt = new Intl.DateTimeFormat('zh-CN', Object.assign({}, base, datePart, timePart));
  return fmt.format(d);
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
