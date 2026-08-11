# 途刻 TraceCraft

一个**纯前端**的 GPS 轨迹记录 / 回放 PWA（Progressive Web App），以腾讯地图为底座，提供从实时定位滤波、轨迹采集、离线平滑到回放分享的一整套流程。

> 无构建工具、无框架、无测试套件 —— 打开 `index.html` 即可运行的经典三件套（HTML + CSS + JS）。`native/` 是 Capacitor 封装的 Android 壳，提供 GNSS 卫星数据、IMU 惯性传感器与原生后台定位能力。

---

## 目录

- [功能特性](#功能特性)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [功能说明](#功能说明)
- [定位与滤波算法](#定位与滤波算法)
- [目录结构](#目录结构)
- [代码架构](#代码架构)
- [配置参数](#配置参数)
- [开发指南](#开发指南)
- [常见问题](#常见问题)
- [许可证](#许可证)

---

## 功能特性

### 轨迹记录
- 一键开始 / 结束 / 清除，实时统计**距离、时长、平均速度、最高速度**
- 按 `TRAIL_SAMPLE_MIN_DIST`（默认 5m）距离采样，自动滤除静止漂移鬼点
- **自动暂停**：连续静止 10s 自动暂停计时，恢复移动自动继续
- **后台记录**：页面切到后台仍可定位（浏览器兜底 + 原生 `BackgroundGeolocation` 双通道）
- **省电模式**：定位间隔自适应拉长（正常 2s → 省电 20s），联动 GNSS 弱信号滞回判断

### 轨迹展示与分析
- **速度分段着色**：7 档速度等级（步行/骑行/公交/驾车/火车/高铁/超高速）多色轨迹线
- **速度曲线**：实时 Chart.js 曲线（含移动窗口统计）
- **海拔剖面**：累计爬升 / 下降 / 最高海拔，独立滤波链保证数据可信
- **轨迹平滑**：离线 RTS（Rauch–Tung–Striebel）平滑，消除 GPS 抖动
- **统计弹窗**：总距离、时长、均速、极速、海拔汇总

### 轨迹回放
- 1x / 2x / 5x / 10x 倍速播放，支持时间戳插值、进度条 seek
- 已播放路径高亮 + 箭头方向标记
- 跟随模式（地图随回放平移）/ 手动模式切换
- 记录中即可回放当前已采集轨迹（回放与记录并行互不干扰）

### 历史管理
- 卡片列表：搜索（名称/日期/距离）、时间筛选（今天/本周/本月）、排序（时间/距离/时长/点数）
- 收藏 / 重命名 / 详情弹窗 / 删除
- **批量操作**：全选、反选、批量删除、合并轨迹、分享合集（多图拼接）

### 分享与报告
- **活动报告导出**：Canvas 手绘地图瓦片 + 统计摘要 + 海拔剖面 + 速度剖面，一张长图（支持深/浅色两版）
- **分享卡片**：轨迹缩略图 + 统计信息，下载或系统分享

### 系统集成
- 天气胶囊（Open-Meteo 主源，wttr.in 备用降级，节流 + 位置去重）
- 电池状态（Battery API，≤15% 低电量提醒）
- 深色 / 浅色主题切换，移动端优先布局
- 纯前端存储：IndexedDB / localStorage 自动选型，大轨迹进 IndexedDB、元信息进 localStorage

---

## 技术栈

| 类别 | 选型 |
| --- | --- |
| 地图 | 腾讯地图 JS API v2（`map.qq.com/api/js`，同步加载） |
| 坐标 | WGS84 → GCJ02（火星坐标）统一转换后显示/存储 |
| 图表 | Chart.js 4（CDN，速度曲线 + 海拔剖面） |
| 前端形态 | 原生 HTML + CSS + JS（全局类，无模块化） |
| 存储 | IndexedDB + localStorage（自动选择） |
| Android 壳 | Capacitor 8 + 自定义 GNSS/IMU 原生插件 |
| 后台定位 | @capgo/background-geolocation |
| 算法 | IMM 交互式多模型滤波 + Huber 鲁棒 + RTS 离线平滑 |

---

## 快速开始

### Web 端（调试）

```bash
# 任意静态服务器，例如：
npx serve .
# 或 VS Code Live Server 直接打开 index.html
```

浏览器访问 `http://localhost:3000`。

> 需要可访问外网以加载腾讯地图 SDK 与 Chart.js（均为同步 CDN 脚本）。
> 浏览器需要支持 Geolocation API；在 PC 上可用 `mock-data.js` 生成模拟轨迹测试。

### Android 打包

```bash
cd native
npm install
npm run build:plugin   # 编译 gnss-plugin（tsc）
npm run sync           # capacitor sync
npm run build:apk      # gradlew assembleDebug
```

输出 APK 位于 `native/android/app/build/outputs/apk/debug/`。

> ⚠️ **重要**：`native/web/` 是根目录资源的**手工同步副本**。修改根目录 `index.html` / `js/` / `css/` 后，发布 Android 版前需手动把改动复制到 `native/web/`。

---

## 功能说明

### 记录 Tab
- **开始记录**：开启持续定位并采样入当前轨迹
- **结束并保存**：停止记录，自动做离线清洗（起终点漂移裁剪 + 跳变点过滤）与 RTS 平滑，存入历史
- **清除**：丢弃当前未保存轨迹
- **统计 / 平滑 / 报告**：实时统计弹窗、离线平滑重算、导出报告图
- **自动暂停**：静止自动停表
- **省电**：切换省电模式（联动后台定位间隔与 GNSS 弱信号策略）
- **速度曲线 / 海拔剖面**：随记录实时刷新，可折叠

### 回放 Tab
- 左侧为播放器（加载轨迹后出现）：播放/停止、进度条 seek、跟随开关、倍速切换
- 下方为可回放轨迹列表：搜索 / 时间筛选 / 排序 / 收藏筛选 / 全选
- 点击卡片上的播放按钮立即回放

### 历史 Tab
- 轨迹卡片：缩略图、名称、日期、距离、时长、点数、均速
- 卡片操作：播放回放、加载到地图、详情、收藏、更多菜单（重命名/分享/下载/删除）
- 多选模式：全选当前、反选、合并、分享合集、删除

### 浮动按钮
- 地图右下角定位按钮：快速回到当前位置（带脉冲动画）

---

## 定位与滤波算法

这是项目的技术核心，全部实现在 `js/gps.js`。

### 实时定位：IMM 交互式多模型滤波

实时滤波采用 **IMM（Interacting Multiple Model）**，取代早期的单模型自适应 Q 方案：

- **三模型**：静止（STILL）/ 恒速（CV）/ 恒加速（CA），统一 **6 维状态** `[x, y, vx, vy, ax, ay]`（局部 ENU 米坐标），差异仅在于加速度过程噪声 `q_a`
  - `IMM_MODEL_Q: [0.05, 0.25, 1.0]` —— 静止极小 Q 强抑漂移、恒速中 Q 匀速跟随、恒加速大 Q 机动跟踪
- **模型切换**由「马尔可夫转移概率 × 测量似然」驱动（`IMM_TRANSITION` 转移矩阵 + 似然温度 `IMM_LIKELIHOOD_TEMP` 放大模型差异）
- **速度辅助先验**（`IMM_SPEED_PRIOR`）：用 GPS 上报 speed 软门控模型切换，弥补纯位置观测辨识慢
- **性能优化**：x/y 两轴解耦成两个 3×3 子问题，优化矩阵运算

保留的全部保护机制：

| 机制 | 说明 | 参数 |
| --- | --- | --- |
| Huber 鲁棒 | 标准化残差超阈值降权（M-估计），抑制 GPS 粗差/漂移点 | `GPS_HUBER_K` |
| 精度冻结 | accuracy 超阈值冻结在最后可信位置 | `IMM_FREEZE_ACC` |
| 时间重置 | dt≤0 或 >60s 重置状态 | — |
| 重锚 | 距参考点 >3km 重新初始化 | `IMM_REANCHOR_M` |
| 速度限幅 | 速度模量上限 120m/s | `IMM_SPEED_LIMIT` |
| 模型概率下限 | 防浮点死锁 | `IMM_MIN_PROB` |

### 离线平滑：RTS Smoother

- `smoothTrail()`：实时滤波结果的**后向平滑**，消除相位滞后，用于保存轨迹前的最终处理
- `AltRtsSmoother`：海拔独立的一维 RTS 平滑
- 离线链路使用独立的 4 维单模型 `KalmanFilter`（`_offlineSmoother`），与实时 IMM 层完全解耦

### 海拔独立滤波链

海拔不依赖水平滤波，四级融合（参数全走 `ALT_*`）：

1. **L1 源头质量门**（`_resolveAltitude`）：区分 GGA / 浏览器口径
2. **L2 一维自适应卡尔曼**（`AltKalmanFilter`）：自适应 R / Q
3. **L3 中值预滤波 + 自适应 Huber**（`AltFilterPipeline`）：去瞬态尖刺
4. **L4 离线一维 RTS**（`AltRtsSmoother`）：结束后处理

### GNSS 原始数据增强（仅 Android）

原生 `GnssData` 插件推送卫星状态（星座/信噪比/仰角/方位角/参与解算）与 NMEA 语句：

- **NMEA 解析**：`$GPRMC`/`$GPGGA`/`$GPGSA`/`$GPVTG` —— UTC 时钟校准、海拔、DOP、航向/速度，且 VTG vs RMC 交叉验证防冲突
- **源接管**：原生主导 + 浏览器低频兜底（`GPS_TAKEOVER_MIN_SATS`/`GPS_TAKEOVER_HDOP` 门控，滞回防抖）
- **弱信号省电**：卫星数 + 信噪比双阈值滞回判断，进入弱信号档拉长定位心跳

### IMU 惯性导航（阶段二/三，仅 Android）

原生 `ImuData` 插件 25Hz 采集线性加速度 + 陀螺仪 + 姿态四元数：

- **阶段二**：四元数姿态旋转到 ENU 地理系 → 1Hz 窗口均值聚合（`IMU_FEED_INTERVAL_MS`）→ 注入 CA 模型预测（`x⁻ = F·x̂ + G·a_imu`），只做运动学先验，GPS 仍是位置权威
- **阶段三**：GPS 丢失（accuracy 超阈值且卫星不足）时切换高频 `predictOnly()` 短时航迹推算，推算状态机 `_maybeEnterDeadReckoning` / `_advanceDeadReckoning` / `_exitDeadReckoning` 管理，上限 `IMU_DEAD_RECKON_MAX_MS`；watch 断流时由超时看门狗 `_tryEnterDeadReckoningFromTimeout` 兜底触发，恢复后一次 GPS fix 重锚无缝接回

> Web 端无 IMU/GNSS 插件（插件提供 Web stub），自动零回归。

---

## 目录结构

```
trail-recorder/
├── index.html              # 单页入口（脚本加载顺序即依赖顺序）
├── css/                    # 9 个样式文件 + 字体
│   ├── theme.css           #   设计令牌（:root[data-theme] 切换 dark/light）
│   ├── base.css            #   基础/排版
│   ├── map.css             #   地图与画布层
│   ├── panel.css           #   底部面板
│   ├── gps.css             #   GPS 状态条
│   ├── trail.css           #   轨迹卡片/列表
│   ├── toast-modal.css     #   提示与弹窗
│   ├── responsive.css      #   移动端断点（480px）
│   └── fonts.css / fonts/  #   字体
├── js/                     # 17 个全局脚本
├── mock-data.js            # 控制台模拟轨迹生成器（测试用）
├── native/                 # Capacitor Android 壳
│   ├── gnss-plugin/        #   自定义原生插件（GnssData + ImuData）
│   ├── ua-override/        #   MainActivity UA 覆盖（去移动端标识）
│   ├── web/                #   根目录资源的手工同步副本（打进 APK）
│   ├── scripts/            #   后台定位配置脚本
│   ├── android/            #   Capacitor 生成的 Android 工程
│   └── capacitor.config.json
├── scripts/
│   └── generate_android_icons.py   # Android 图标生成
├── old/                    # 历史遗留备份目录（勿改）
├── LICENSE                 # MIT
└── CODEBUDDY.md            # AI 协作项目说明
```

---

## 代码架构

无模块化、无打包器，全部通过 `<script>` 按顺序加载全局类/对象，**加载顺序即依赖顺序**：

```
config.js → toast.js → storage.js → trail.js → trail-analysis.js
→ map.js → gps.js → replay.js → app-core.js → app-gps-ui.js
（app-list / app-replay / app-export / app-stats / app-weather
  / app-background / app-battery 在 app-core.js 之后按需追加）
```

| 文件 | 职责 |
| --- | --- |
| `config.js` | `CONFIG` 常量 + 全局工具函数（`calcDistance`/`calcBearing`/`formatDistance`/`formatDurationShort`/`ddToDms`/`copyText` 等）。速度等级表 `TRAIL_SPEED_LEVELS` 是着色与分段的**单一数据源** |
| `storage.js` | `Storage` 静态类，IndexedDB / localStorage 自动选型，统一 `_getActiveStore()` 接口 |
| `trail.js` | `Trail` 类：当前会话轨迹状态（positions、记录/暂停、采样距离控制） |
| `trail-analysis.js` | `TrailAnalysis` 纯函数：关键点分析、速度等级分段（带防抖）、综合统计 |
| `map.js` | `MapManager`：腾讯地图封装、Canvas 速度着色轨迹线、位置/精度圆、关键点、缩略图 |
| `gps.js` | `GPSManager` + `ImmFilter` + `KalmanFilter`（离线 RTS）+ `ImuManager` + 海拔滤波链 |
| `replay.js` | `TrailPlayer`：requestAnimationFrame 驱动回放（倍速/seek/跟随/箭头） |
| `app-core.js` | `App` 主控制器：初始化、事件绑定、记录/回放/历史/详情/报告业务逻辑 |
| `app-*.js` | 通过 `App.prototype.*` 追加功能：列表、回放控制、导出报告、统计/海拔、天气、后台定位、电池、GPS UI |
| `toast.js` | `Toast.show()` 全局提示 |

### 关键数据流

1. **定位**：`GPSManager` 回调 → `App.onPositionChange` → `wgs84ToGcj02()`（WGS84 → GCJ02）→ 更新位置标记与轨迹采样
2. **记录**：`App._recordFix()` 距离采样 → `mapManager.setTrail()` 增量画线 → UI 刷新 → 定时/离页持久化
3. **历史**：`Storage.loadTrailList()` → `_renderTrailList()` 卡片 → 操作后 `_invalidateTrailCache()` 重渲染
4. **回放**：加载轨迹 → `TrailPlayer` 逐帧 → `_onReplayFrame` 跟随平移；暂停自动解锁跟随

### 重要约定

- **坐标**：GPS 原生 WGS84，地图为 GCJ02，一切显示/存储前经 `wgs84ToGcj02` 转换
- **腾讯地图 SDK 必须同步 `<script>` 加载**（内部依赖 `document.write`），**严禁加 `async`/`defer`**，否则 SDK 初始化卡死
- Chart.js 同步 CDN 加载，`_initSpeedChart` 在 `typeof Chart === 'undefined'` 时静默返回
- 修改涉及速度等级的代码时，确认 `map.js` 与 `trail-analysis.js` 读的是同一份 `CONFIG.TRAIL_SPEED_LEVELS`
- 文件内版本号 query（`?t=...`）用于缓存刷新，改动后如需强刷可递增

---

## 配置参数

所有可调参数集中在 `js/config.js` 的 `CONFIG`，主要包括：

| 分组 | 关键参数 |
| --- | --- |
| 地图 | `MAP_KEY`、`DEFAULT_CENTER`、`DEFAULT_ZOOM`、`LOCATION_ZOOM` |
| GPS 基础 | `GPS_TIMEOUT`、`GPS_WATCH_TIMEOUT`、`GPS_TIMEOUT_MAX_FAILURES`、自适应节流 `GPS_ADAPTIVE_K`/`GPS_MIN_INTERVAL`/`GPS_MAX_INTERVAL` |
| 轨迹采样 | `TRAIL_SAMPLE_MIN_DIST`、`TRAIL_STATIONARY_SPEED`、`TRAIL_MAX_POINTS` |
| 轨迹清洗 | `TRAIL_CLEAN_START_M`/`TRAIL_CLEAN_END_M`/`TRAIL_CLEAN_MAX_JUMP_FACTOR` |
| 自动暂停 | `AUTO_PAUSE_WINDOW_S`/`AUTO_PAUSE_SPEED`/`AUTO_PAUSE_RESUME_SPEED` |
| 分段/关键点 | `TRAIL_SEGMENT_MIN_POINTS`/`MIN_DIST`/`MIN_MS`、`TRAIL_SPEED_LEVELS` |
| IMM 滤波 | `IMM_*` 全部参数（见上文算法章节） |
| GNSS 弱信号 | `GNSS_WEAK_USED_MAX`/`GNSS_WEAK_SNR_MAX`/`GNSS_RECOVER_*`（滞回）/`GPS_WEAK_SIGNAL_INTERVAL` |
| NMEA | `NMEA_*_MAX_AGE_MS`、`NMEA_SPEED_CONFLICT_*`、`NMEA_HEADING_CONFLICT_DEG`、`NMEA_COORD_CONFLICT_*` |
| IMU | `IMU_*`（开关、注入间隔、聚合低通、推算阈值与上限） |
| 海拔 | `ALT_*`（卡尔曼 R/Q 范围、Huber、速度上限、RTS 权重） |
| 存储 | `TRAIL_STORAGE_ENGINE`、`DB_NAME`/`DB_VERSION`/`DB_MAX_SIZE`、`LS_MAX_SIZE` |
| 后台定位 | `BG_LOCATE_INTERVAL_NORMAL`/`POWER_SAVE`、`NATIVE_BG_MIN_INTERVAL` |

---

## 开发指南

### 无 GPS 环境测试（模拟数据）

浏览器控制台（F12）粘贴运行 `mock-data.js` 内容，然后：

```js
__mock.quick()        // 注入 30 点/30s 短轨迹
__mock.walk(100)      // 直线行走
__mock.run(200)       // 圆形跑步
__mock.cycle(150)     // 弯曲骑行
__mock.drive(300)     // 模拟驾驶（含加减速）
__mock.save('walk')   // 注入并保存到历史
__mock.batch()        // 批量生成 4 条轨迹并保存
__mock.help()         // 帮助
```

### 发布 Android 版

1. 修改根目录资源后，**手动同步**到 `native/web/`
2. `cd native && npm run build:plugin && npm run sync && npm run build:apk`
3. 需要 Android SDK / JDK；`tujie.keystore` 为签名文件

### 调试提示

- 地图 SDK 与 Chart.js 是同步 CDN，无网环境无法运行
- 修改 JS 后可递增 `?t=` 版本号强制浏览器刷新缓存
- `CODEBUDDY.md` 是面向 AI 协作的持续更新的架构说明，改动架构时请同步

---

## 常见问题

**Q：为什么地图白屏？**
腾讯地图 SDK 同步加载失败。检查网络可达 `map.qq.com`，并确认 `index.html` 中该 `<script>` 未加 `async`/`defer`。

**Q：PC 上没有定位数据？**
PC 浏览器 Geolocation 精度差或需授权。建议使用 `mock-data.js` 生成模拟轨迹，或部署到 HTTPS 环境（Chrome 要求安全上下文）。

**Q：Android APK 中地图瓦片模糊或行为异常？**
`native/ua-override/MainActivity.java` 在 WebView 加载前覆盖 User-Agent 去除移动端标识，让腾讯地图返回桌面版完整瓦片。若修改 UA 策略需同步调整。

**Q：修改了 web 端代码但 APK 没生效？**
需手动把改动同步到 `native/web/` 后再重新打包（web 目录是手工副本，不会自动同步）。

**Q：轨迹保存到哪里？**
浏览器端数据全部本地存储：大轨迹进 IndexedDB（`trailcraft_db`），元信息进 localStorage。清除站点数据会删除全部历史轨迹。

---

## 许可证

[MIT](LICENSE) © 2026 hzr12
