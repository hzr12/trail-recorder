# CODEBUDDY.md This file provides guidance to CodeBuddy when working with code in this repository.

## 项目概览

途刻 TraceCraft：一个**纯前端**的轨迹记录/回放 PWA（无构建工具、无框架、无测试套件），核心是腾讯地图 + GPS 追踪。根目录是可直接用静态服务器打开的 web 应用；`native/` 是 Capacitor 封装的 Android 壳（含 GNSS 卫星数据插件 `GnssData` 与 IMU 惯性传感器插件 `ImuData`）。

**重要**：`native/web/` 是根目录资源的**手工同步副本**（当前与根目录不一致），用于打进 APK。修改根目录 `index.html`/`js/`/`css/` 后，如需发布 Android 版要手动把对应资源复制到 `native/web/`。

## 常用命令

无构建/打包步骤，web 端直接用任意静态服务器打开根目录即可调试（如 `npx serve .` 或 VS Code Live Server）。没有测试框架。

- **开发运行（web）**：`npx serve .` 后浏览器打开 `http://localhost:3000`，或直接用 Live Server 打开 `index.html`。
- **Android 打包**：`cd native && npm run build:plugin && npm run sync && npm run build:apk`（需要 Android SDK/Java；构建前先手动同步 web 资源到 `native/web/`）。
- **生成模拟轨迹测试数据**：浏览器控制台粘贴运行 `mock-data.js`（生成直线/折线/环线等模拟轨迹，用于无 GPS 环境测试回放与列表）。

## 架构总览

无模块化、无打包器，全部通过 `<script>` 按顺序加载的全局类/对象。**加载顺序即依赖顺序**（见 `index.html` 底部）：
`config.js` → `toast.js` → `storage.js` → `trail.js` → `trail-analysis.js` → `map.js` → `gps.js` → `replay.js` → `app-core.js` → `app-gps-ui.js`。

### 核心模块

- **`js/config.js`**：`CONFIG` 常量集中地（地图 key、GPS 参数、IMM 滤波、IMU 校准、海拔滤波、速度等级表、存储配置、交互阈值）。**同时定义全局工具函数**：`calcDistance`（Haversine）、`calcBearing`、`bearingToDir`、`formatDistance`、`formatDurationShort`、`ddToDms`、`copyText`。速度等级表 `CONFIG.TRAIL_SPEED_LEVELS` 是着色与分段的**单一数据源**，修改需保持 `map.js` 与 `trail-analysis.js` 同步消费。
- **`js/storage.js`**：`Storage` 静态类。轨迹数据存储引擎自动选择 IndexedDB / localStorage（`CONFIG.TRAIL_STORAGE_ENGINE`），通过 `_getActiveStore()` 抽象出统一接口。含当前轨迹、历史列表、收藏、批量操作等 API。**大轨迹用 IndexedDB，meta 用 localStorage**。
- **`js/trail.js`**：`Trail` 类，当前会话轨迹状态（`positions` 数组、记录/暂停开关、采样距离控制）。
- **`js/trail-analysis.js`**：`TrailAnalysis` 纯函数对象，无 DOM 依赖。`analyzeKeyPoints()`（起点/终点/最高速点）、`analyzeSegments()`（按速度等级自动分段，带防抖）、`analyze()` 综合输出。输入 `{lat, lng, time, speed}` 点数组，是回放分段与关键点标记的数据源。
- **`js/map.js`**：`MapManager` 类，腾讯地图（`qq.maps`）封装。管理地图实例、Canvas 叠加层（速度着色轨迹线）、我的位置标记/精度圆、关键点标记、轨迹缩略图渲染（`renderTrailThumbnail`/`renderTrailCollage`）。**轨迹线按速度分段批量绘制 polyline**，增量更新基于 `_lastTrailCount` 锚点。所有公开方法都应在 `this.map` 未就绪时安全返回。
- **`js/gps.js`**：`GPSManager` + `ImmFilter`（交互式多模型实时滤波，6 维×3 模型：静止/CV/恒加速，x/y 两轴解耦成 3×3 子问题优化矩阵运算）+ `KalmanFilter`（仅服务离线 RTS 平滑，独立实例 `_offlineSmoother`，与实时层彻底解耦）+ `ImuManager`（原生 `ImuData` 插件桥接，**仅定位校准**：设备系线性加速度经 rotation 四元数旋转到 ENU 地理系 → 1s 窗口均值 → 一阶低通 → 注入滤波预测）。封装浏览器 Geolocation，支持单次定位、持续追踪、精度降级/恢复、省电模式，回调通过 `onPositionChange`/`onError` 等注入。**IMU 职责收窄为纯加速度注入校准**：`ImmFilter.feedImu()` 把 1Hz 聚合的 ENU 加速度注入 CA 模型预测（`x⁻=F·x̂+G·a_imu`，`G=[½dt²,dt,0]ᵀ` 只影响位置/速度预测，加速度状态保持模型自持；注入期 CA 模型 Q 缩放 `max(0.3, 1−0.7·trust)`；仅运动学先验，GPS 仍是位置权威）。**明确不做**：GPS 丢失航迹推算（无 `predictOnly`/DR 状态机）、IMU 航向解算（航向完全由 GPS 权威——NMEA VTG/RMC + 浏览器 `coords.heading`，IMU 不读陀螺仪融合）。IMU 随 watch 生命周期启停（`_startImu`/`_stopImu`），省电模式同步关闭；web 端无插件时静默跳过，纯 GPS 零回归。
- **`js/replay.js`**：`TrailPlayer` 类，requestAnimationFrame 驱动的轨迹回放播放器（1x/1.5x/2x/4x）。支持时间戳插值、进度条 seek、已播放路径高亮、箭头标记指向下一轨迹点（`_updateMarker` 计算方位角旋转）。回调 `onProgress`/`onComplete`/`onFrame`。
- **`js/app-core.js`**：`App` 主控制器（最大文件 ~100KB）。构造函数创建 `MapManager`/`GPSManager`/`Trail` 并初始化全部状态；`init()` 是启动入口：初始化地图 → `_setupUI()` 绑定事件 → 恢复主题/状态 → 启动 GPS。内含轨迹记录、回放控制、历史列表渲染（`_trailItemHTML` + `_bindTrailItemEvents`）、批量操作、详情弹窗、报告导出等全部业务逻辑。文件底部 `_bootApp()` 在 `DOMContentLoaded` 时实例化 App。
- **`js/app-gps-ui.js`**：通过 `App.prototype.*` 给 `App` 追加方法：速度曲线（Chart.js）、GPS 状态栏渲染、跟随模式切换。**必须在 `app-core.js` 之后加载**（依赖 `App` 类）。
- **`js/toast.js`**：`Toast.show()` 全局提示。
- **`mock-data.js`**：控制台测试用模拟轨迹生成器，不参与正常运行。

### 关键数据流

1. **GPS 定位**：`GPSManager` 回调 → `App` 的 `onPositionChange` → `wgs84ToGcj02()`（腾讯 convertor，**WGS84 转 GCJ02 坐标系**）→ 更新 `myPosition`、地图位置标记、轨迹点采样。
2. **轨迹记录**：`App._recordFix()` 按 `TRAIL_SAMPLE_MIN_DIST` 采样入 `trail.positions` → `mapManager.setTrail()` 增量画线 → `_updateTrailUI()` 更新 UI → 定时/离页时 `Storage.saveTrail()` 持久化。
3. **历史列表**：`Storage.loadTrailList()`（IndexedDB）→ `App._renderTrailList()` 渲染卡片 → 卡片交互（收藏/加载/详情/更多菜单/多选）→ 删除/收藏等操作后 `_invalidateTrailCache()` + 重渲染。
4. **回放**：`_replayTrailFromList(id)` 加载轨迹 → `TrailPlayer` 逐帧驱动 → `_onReplayFrame` 跟随模式平移地图 → 暂停自动解锁跟随（`_replayFollowMode = false`）。

### 布局与主题

- 页面为**单 HTML + 底部可折叠面板**：地图全屏 + 底部 `#bottomPanel`（GPS 状态条、Tab 切换、面板 body）。
- 样式拆 9 个 CSS（`theme.css` 设计令牌变量、`base/panel/gps/trail/toast-modal/map/responsive/fonts`）。**主题通过 `:root[data-theme]` 变量切换**，`theme.css` 定义 dark/light 两套令牌。
- 移动端优先：`MOBILE_BREAKPOINT = 480` 断点，`responsive.css` 控制面板折叠。

### 关键约定与注意事项

- **坐标系**：GPS 原生是 WGS84，地图是 GCJ02（火星坐标），一切显示/存储前经 `wgs84ToGcj02` 转换。
- **腾讯地图 SDK 必须同步 `<script>` 加载**（内部依赖 `document.write`），**严禁加 `async`/`defer`**——会导致 SDK 初始化卡死。
- **Chart.js 是同步 CDN 脚本**，用于速度曲线；`App.prototype._initSpeedChart` 在 `typeof Chart === 'undefined'` 时静默返回，改加载方式需谨慎。
- 修改 `map.js`/`trail-analysis.js` 涉及速度等级时，确认两者读的是同一份 `CONFIG.TRAIL_SPEED_LEVELS`。
- `App` 事件绑定分散在 `_setupUI` 与各渲染函数中，新增交互注意事件委托与 `stopPropagation`（卡片点击详情 vs 按钮点击）。
- 无 TypeScript/ESM，保持全局类风格；文件内有版本号 query（`?t=`）用于缓存刷新，改动后如需强刷可递增。
