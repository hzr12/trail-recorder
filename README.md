# 途刻 TraceCraft — 深度技术规格说明书（可 1:1 复刻）

> **文档目标**：仅凭本文件，即可在没有任何源码的情况下，完整、无歧义地复刻整个项目（Web 端 + Native 接口规格），并实现全部功能。
> **原则**：所有数值、字段名、DOM id、算法、接口均来自真实代码；凡涉及密钥一律以占位符 `{{...}}` 表示，不复现任何真实 Key / Secret。
> **坐标系约定**：GPS 原始坐标为 **WGS84**，仅在"显示 / 持久化历史"时经 `MapManager.wgs84ToGcj02*` 转换为 **GCJ02**（火星坐标）。原始测量缓冲（`GPSManager._rawFixes`）始终保留 WGS84，用于结束记录后的 RTS 离线平滑。

## 2. 运行环境与依赖

| 项 | Web | Android |
|---|---|---|
| 运行 | 任意静态服务器（如 `npx serve .`）根目录，浏览器开 `http://localhost:3000` | `cd native && npm run build:plugin && npm run sync && npm run build:apk` |
| 外部 CDN | 腾讯地图 JS SDK（**同步、禁 async/defer**）、Chart.js v4（**同步 CDN**） | 同左；外加 Capacitor 原生插件 |
| 存储 | IndexedDB + localStorage | 同左（WebView 内） |
| 要求 | 现代浏览器 + `navigator.geolocation` | Android SDK / Java；`native/web/` 须手动与根目录同步 |

> ⚠️ **腾讯地图 SDK 必须同步加载**（内部 `document.write`），加 `async`/`defer` 会卡死初始化。
> ⚠️ **`native/web/` 是根目录资源的手工同步副本，当前已过时**（旧版仅加载合并 `gps.js`）。复刻时以根目录为准；发布 Android 前须手动把根目录 `index.html`/`js/`/`css/` 同步进 `native/web/`。

## 3. 目录结构与文件职责

```
trail-recorder/
├── index.html              # Web 入口（真实运行版，含完整 <script> 链 + DOM，见第 5 节）
├── native/web/index.html   # Android 副本（已过时，仅供参考）
├── mock-data.js            # 控制台模拟轨迹生成器（不参与正常运行）
├── favicon.svg
├── css/  (9 文件)
│   ├── fonts.css theme.css base.css map.css panel.css gps.css trail.css toast-modal.css responsive.css
│   └── (含 1 个 .woff2 字体)
├── js/  (21 文件，加载顺序见第 4 节)
│   ├── config.js toast.js storage.js trail.js trail-analysis.js map.js
│   ├── gps-kalman.js gps-imm.js gps-alt.js gps-imu.js gps-manager.js replay.js
│   └── app-core.js app-list.js app-replay.js app-export.js app-stats.js
│       app-weather.js app-background.js app-battery.js app-gps-ui.js
├── native/
│   ├── package.json  capacitor.config.json
│   ├── gnss-plugin/   # GnssData + ImuData 插件（TS 定义见第 10 节）
│   ├── web/           # 待同步的 web 副本
│   └── android/       # Capacitor Android 工程
└── scripts/  (1 个 .py 辅助脚本，非核心)
```

## 4. 脚本加载顺序（依赖顺序）

根目录 `index.html` 底部严格按此顺序（缺一环即崩溃）：

```
config.js → toast.js → storage.js → trail.js → trail-analysis.js
→ map.js → gps-kalman.js → gps-imm.js → gps-alt.js → gps-imu.js
→ gps-manager.js → replay.js → app-core.js
→ app-list.js → app-replay.js → app-export.js → app-stats.js
→ app-weather.js → app-background.js → app-battery.js → app-gps-ui.js
```

> **注意**：`app-gps-ui.js` 是**最后一个**加载（依赖全部 `App.prototype.*` 已定义），请勿提前。
> 每个 `<script>` 可带查询版本号 `?t=...`（缓存破坏），复刻时可省略或统一递增。

## 5. index.html 完整 DOM 规格（UI 复刻骨架）

以下是 Web 入口的**权威 DOM 结构**（元素 id 与类名必须一致，JS 据此绑定）。可直接照抄本骨架重建 `index.html`。

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#0F172A">
  <meta name="apple-mobile-web-app-title" content="途刻">
  <title>途刻</title>
  <link rel="preconnect" href="https://map.qq.com" crossorigin>
  <link rel="preconnect" href="https://cdn.jsdelivr.net">
  <link rel="dns-prefetch" href="https://map.qq.com">
  <link rel="dns-prefetch" href="https://cdn.jsdelivr.net">
  <link rel="icon" type="image/svg+xml" href="favicon.svg">
  <link rel="apple-touch-icon" href="favicon.svg">
  <!-- CSS 顺序：fonts/theme/base/map/panel/gps/trail/toast-modal/responsive -->
  <link rel="stylesheet" href="css/fonts.css">
  <link rel="stylesheet" href="css/theme.css">
  <link rel="stylesheet" href="css/base.css">
  <link rel="stylesheet" href="css/map.css">
  <link rel="stylesheet" href="css/panel.css">
  <link rel="stylesheet" href="css/gps.css">
  <link rel="stylesheet" href="css/trail.css">
  <link rel="stylesheet" href="css/toast-modal.css">
  <link rel="stylesheet" href="css/responsive.css">
</head>
<body>
  <div id="map">
    <canvas id="circle-canvas"></canvas>
    <canvas id="overlay-canvas"></canvas>
  </div>

  <!-- 浮动控制按钮组 -->
  <div class="floating-buttons">
    <button id="gps-btn" class="fab-btn" title="定位到我的位置" aria-label="定位">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="10" r="3"/>
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
      </svg>
      <span class="pulse-ring"></span>
    </button>
  </div>

  <!-- 底部控制面板 -->
  <div class="bottom-panel" id="bottomPanel">
    <div class="panel-handle"><div class="handle-bar"></div></div>

    <!-- GPS 状态条 -->
    <div class="gps-status" id="gps-status">
      <span class="gps-dot"></span>
      <span class="gps-offline">⊙ 未定位，点击 GPS 按钮定位</span>
    </div>

    <div class="panel-header">
      <h1 class="panel-title">途刻</h1>
      <button id="theme-btn" class="theme-toggle" title="切换浅色主题"><!-- 太阳图标 SVG --></button>
    </div>

    <!-- Tab 切换 -->
    <div class="mode-tabs" id="mode-tabs">
      <span class="mode-tab-slider" aria-hidden="true"></span>
      <button class="mode-tab active" data-tab="record" id="tab-record-btn">记录</button>
      <button class="mode-tab" data-tab="replay" id="tab-replay-btn">回放</button>
      <button class="mode-tab" data-tab="history" id="tab-history-btn">历史</button>
    </div>

    <div class="panel-body">
      <!-- 记录 Tab -->
      <div id="tab-record" class="tab-pane">
        <div class="panel-card card-record">
          <div class="trail-section">
            <div class="trail-header"><span class="field-label">轨迹记录</span></div>
            <div class="rec-stats-grid" id="rec-stats-grid">
              <div class="rec-stat"><span class="rec-stat-label">距离</span><span class="rec-stat-value" id="trail-distance">0m</span></div>
              <div class="rec-stat"><span class="rec-stat-label">时长</span><span class="rec-stat-value" id="rec-duration">--</span></div>
              <div class="rec-stat"><span class="rec-stat-label">平均速度</span><span class="rec-stat-value" id="rec-avg-speed">--</span></div>
              <div class="rec-stat"><span class="rec-stat-label">最高速度</span><span class="rec-stat-value" id="rec-max-speed">--</span></div>
            </div>
            <div class="trail-controls">
              <button id="trail-record-btn" class="btn btn-trail"><span class="trail-dot"></span> 开始记录</button>
              <button id="trail-pause-btn" class="btn btn-secondary btn-sm" disabled>结束并保存</button>
              <button id="trail-clear-btn" class="btn btn-secondary btn-sm" disabled>清除</button>
            </div>
            <div class="trail-actions">
              <button id="trail-stats-btn" class="btn-sm" disabled>统计</button>
              <button id="trail-smooth-btn" class="btn-sm active">平滑</button>
              <button id="export-report-btn" class="btn-sm" title="导出活动报告图片">报告</button>
            </div>
            <div class="power-section" id="power-section">
              <span class="power-status" id="power-status">定位间隔: 2s</span>
              <button id="trail-autopause-btn" class="btn-sm" title="连续静止自动暂停">自动暂停</button>
              <button id="power-saving-btn" class="btn-sm" title="省电模式">省电</button>
            </div>
            <div class="speed-legend">
              <div class="speed-legend-row">
                <span class="speed-legend-item"><i class="legend-walk"></i>0-10 km/h</span>
                <span class="speed-legend-item"><i class="legend-bike"></i>10-20 km/h</span>
                <span class="speed-legend-item"><i class="legend-bus"></i>20-60 km/h</span>
                <span class="speed-legend-item"><i class="legend-car"></i>60-120 km/h</span>
              </div>
              <div class="speed-legend-row">
                <span class="speed-legend-item"><i class="legend-train"></i>120-200 km/h</span>
                <span class="speed-legend-item"><i class="legend-hsr"></i>200-350 km/h</span>
                <span class="speed-legend-item"><i class="legend-sct"></i>&gt;350 km/h</span>
              </div>
            </div>
          </div>
        </div>
        <div id="speed-chart-section" class="speed-chart-section hidden">
          <div class="speed-chart-header">
            <span class="speed-chart-title">速度曲线</span>
            <span class="speed-chart-info" id="speed-chart-info"></span>
            <button id="speed-chart-toggle" class="speed-chart-toggle" title="展开/收起"><!-- 折叠箭头 SVG --></button>
          </div>
          <div class="speed-chart-body" id="speed-chart-body"><canvas id="speed-chart-canvas"></canvas></div>
        </div>
        <div id="elev-profile-section" class="elev-profile-section hidden">
          <div class="elev-profile-header">
            <span class="elev-profile-title">海拔剖面</span>
            <span class="elev-profile-info" id="elev-profile-info"></span>
            <button id="elev-profile-toggle" class="elev-profile-toggle" title="展开/收起"><!-- 折叠箭头 SVG --></button>
          </div>
          <div class="elev-profile-body" id="elev-profile-body"><canvas id="elev-profile-canvas"></canvas></div>
        </div>
      </div><!-- /tab-record -->

      <!-- 回放 Tab -->
      <div id="tab-replay" class="tab-pane" style="display:none">
        <div class="replay-empty" id="replay-empty">
          <div class="replay-empty-icon"><!-- 播放图标 SVG --></div>
          <div class="replay-empty-title">选择轨迹开始回放</div>
          <div class="replay-empty-desc">点击下方历史轨迹中的播放按钮，<br>或在记录 Tab 中点击回放按钮</div>
        </div>
        <div id="replay-panel" class="replay-panel hidden">
          <div class="replay-header">
            <span class="replay-title" id="replay-title">轨迹回放</span>
            <span class="replay-time" id="replay-time">00:00 / 00:00</span>
          </div>
          <div class="replay-progress">
            <input type="range" id="replay-slider" class="replay-slider" min="0" max="1000" value="0" step="1">
          </div>
          <div class="replay-controls">
            <button id="replay-play-btn" class="replay-btn play-btn" title="播放/暂停"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><polygon points="6,4 20,12 6,20" id="replay-play-icon"/></svg></button>
            <button id="replay-stop-btn" class="replay-btn stop-btn" title="停止"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg></button>
            <button id="replay-follow-btn" class="replay-btn follow-btn" title="跟随轨迹" aria-pressed="true"><!-- 定位箭头 SVG --></button>
            <div class="replay-speeds">
              <button class="speed-btn" data-speed="1">1x</button>
              <button class="speed-btn" data-speed="2">2x</button>
              <button class="speed-btn" data-speed="5">5x</button>
              <button class="speed-btn" data-speed="10">10x</button>
            </div>
          </div>
          <div class="replay-info" id="replay-info"></div>
        </div>
        <div class="panel-card card-replay-list">
          <div class="replay-trails-section">
            <div class="replay-trails-header">
              <span>可回放轨迹</span>
              <input type="text" class="trail-search-input" id="replay-search" placeholder="搜索…" />
              <select class="trail-time-select" id="replay-time-range">
                <option value="all">全部</option><option value="today">今天</option>
                <option value="week">本周</option><option value="month">本月</option>
              </select>
              <select class="trail-sort-select" id="replay-sort" title="排序方式">
                <option value="time">最新优先</option><option value="distance">距离</option>
                <option value="duration">时长</option><option value="points">点数</option>
              </select>
              <button class="header-btn batch-select-all-btn" id="batch-select-all-replay" data-tab="replay" title="全选当前">全选当前</button>
              <button class="fav-filter-btn" id="replay-fav-filter" title="仅看收藏"><span>仅看收藏</span></button>
            </div>
            <div class="trail-list" id="replay-trail-list"><div class="trail-list-empty">暂无历史轨迹</div></div>
          </div>
        </div>
      </div>

      <!-- 历史 Tab -->
      <div id="tab-history" class="tab-pane" style="display:none">
        <div class="panel-card card-history-list">
          <div class="trail-list-header">
            <input type="text" class="trail-search-input" id="history-search" placeholder="搜索名称/日期/距离…" />
            <select class="trail-time-select" id="history-time-range">
              <option value="all">全部时间</option><option value="today">今天</option>
              <option value="week">本周</option><option value="month">本月</option>
            </select>
            <select class="trail-sort-select" id="history-sort" title="排序方式">
              <option value="time">最新优先</option><option value="distance">距离</option>
              <option value="duration">时长</option><option value="points">点数</option>
            </select>
            <button class="header-btn batch-select-all-btn" id="batch-select-all-history" data-tab="history" title="全选当前">全选当前</button>
            <button class="fav-filter-btn" id="history-fav-filter" title="仅看收藏"><span>仅看收藏</span></button>
          </div>
          <div class="trail-list" id="trail-list"><div class="trail-list-empty">暂无历史轨迹</div></div>
        </div>
      </div>

      <!-- 批量操作工具栏（多选时显示） -->
      <div class="batch-toolbar" id="batch-toolbar">
        <span class="batch-count">未选择</span>
        <div class="batch-actions">
          <button class="batch-btn batch-export" id="batch-export" disabled>分享合集</button>
          <button class="batch-btn batch-merge" id="batch-merge" disabled>合并轨迹</button>
          <button class="batch-btn batch-delete" id="batch-delete" disabled>删除</button>
          <button class="batch-btn batch-invert" id="batch-invert" disabled>反选</button>
          <button class="batch-btn batch-clear" id="batch-clear" disabled>取消选择</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Tencent Map API（key 以占位符表示，复刻时替换为自有 key，勿提交真实 key） -->
  <script charset="utf-8" src="https://map.qq.com/api/js?v=2.exp&key={{TENCENT_MAP_KEY}}&libraries=geometry,convertor"></script>
  <!-- Chart.js（速度曲线） -->
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <!-- 应用脚本（顺序见第 4 节，每个可带 ?t= 版本号） -->
  <script src="js/config.js"></script>
  <script src="js/toast.js"></script>
  <script src="js/storage.js"></script>
  <script src="js/trail.js"></script>
  <script src="js/trail-analysis.js"></script>
  <script src="js/map.js"></script>
  <script src="js/gps-kalman.js"></script>
  <script src="js/gps-imm.js"></script>
  <script src="js/gps-alt.js"></script>
  <script src="js/gps-imu.js"></script>
  <script src="js/gps-manager.js"></script>
  <script src="js/replay.js"></script>
  <script src="js/app-core.js"></script>
  <script src="js/app-list.js"></script>
  <script src="js/app-replay.js"></script>
  <script src="js/app-export.js"></script>
  <script src="js/app-stats.js"></script>
  <script src="js/app-weather.js"></script>
  <script src="js/app-background.js"></script>
  <script src="js/app-battery.js"></script>
  <script src="js/app-gps-ui.js"></script>
</body>
</html>
```

### 5.1 DOM id → JS 绑定速查

| id | 消费模块 | 用途 |
|---|---|---|
| `map` / `circle-canvas` / `overlay-canvas` | map.js | 地图容器 + 精度圆 Canvas + 叠加层 Canvas（轨迹/箭头） |
| `gps-btn` | app-core | 定位到我的位置（flyTo） |
| `bottomPanel` | app-core/panel.css | 底部面板（折叠拖拽） |
| `gps-status` | app-gps-ui | GPS 状态条（精度/卫星/模式） |
| `theme-btn` | app-core | 切换浅色/深色主题 |
| `tab-record-btn`/`tab-replay-btn`/`tab-history-btn` | app-core | Tab 切换 |
| `trail-distance`/`rec-duration`/`rec-avg-speed`/`rec-max-speed` | app-core | 记录实时统计 |
| `trail-record-btn`/`trail-pause-btn`/`trail-clear-btn` | app-core | 开始/结束保存/清除 |
| `trail-stats-btn`/`trail-smooth-btn`/`export-report-btn` | app-core/app-export | 统计弹窗/平滑开关/报告导出 |
| `power-status`/`trail-autopause-btn`/`power-saving-btn` | app-core/app-battery | 省电/自动暂停 |
| `speed-chart-section`/`speed-chart-canvas`/`elev-profile-canvas` | app-gps-ui | 速度曲线 + 海拔剖面 |
| `tab-replay`/`replay-panel`/`replay-slider`/`replay-play-btn`/`replay-stop-btn`/`replay-follow-btn` | app-replay | 回放控制 |
| `.speed-btn[data-speed]` | app-replay | 倍速 1/2/5/10x |
| `trail-list`/`history-search`/`history-time-range`/`history-sort` | app-list | 历史列表 + 搜索/筛选/排序 |
| `replay-trail-list`/`replay-search`/`replay-time-range`/`replay-sort` | app-list/app-replay | 回放列表 |
| `batch-toolbar`/`batch-export`/`batch-merge`/`batch-delete`/`batch-invert`/`batch-clear` | app-list | 批量操作 |
| `replay-fav-filter`/`history-fav-filter`/`batch-select-all-replay`/`batch-select-all-history` | app-list | 收藏过滤/全选 |

## 6. 配置项 CONFIG 逐条规格（精确值）

定义在 `js/config.js`：`const CONFIG = { ... }`。复刻时**逐字段照抄下表默认值**。

```js
const CONFIG = {
  // —— 地图 ——
  DEFAULT_CENTER: { lat: 23.1291, lng: 113.2644 },  // 广州塔
  DEFAULT_ZOOM: 12,
  LOCATION_ZOOM: 15,
  MIN_DRAW_PX: 4,                                  // 画布最小绘制像素阈值

  // —— GPS 超时与降级 ——
  GPS_TIMEOUT: 10000,
  GPS_WATCH_TIMEOUT: 5000,
  GPS_LOW_ACCURACY_TIMEOUT: 15000,
  GPS_TIMEOUT_MAX_FAILURES: 5,
  GPS_RECOVERY_INTERVAL_MS: 2 * 60 * 1000,
  EARTH_RADIUS: 6371000,                           // 米（Haversine 用）
  STORAGE_KEY: 'trailcraft_data',

  // —— 交互 ——
  LONGPRESS_THRESHOLD_MS: 600,
  LOCATED_ANIM_MS: 3000,

  // —— GPS 相关 ——
  POSITION_STALE_MS: 10 * 60 * 1000,
  RELOCATE_INTERVAL_MS: 5 * 60 * 1000,

  // —— 显示 ——
  STATUS_THROTTLE_MS: 2000,
  MIN_DISPLACEMENT_M: 5,

  // —— 速度曲线 / GPS 状态 UI ——
  SPEED_HISTORY_MAX: 2500,                         // 速度曲线历史样本上限
  SPEED_CHART_WINDOW: 2500,                        // 图表显示窗口

  // —— 后台定位（页面隐藏时）——
  BG_LOCATE_INTERVAL_NORMAL: 5000,                 // 有电后台间隔(ms)
  BG_LOCATE_INTERVAL_POWER_SAVE: 20000,            // 省电后台间隔(ms)
  NATIVE_BG_MIN_INTERVAL: 5000,                    // 原生后台最小上报间隔(ms)

  // —— 轨迹视觉抽稀（map.js / replay.js 共用）——
  TRAIL_DECIMATE_MIN_ZOOM_LIMIT: 2000,             // zoom 抽稀下限（最低密度）
  TRAIL_DECIMATE_MAX_ZOOM_LIMIT: 20000,            // zoom 抽稀上限（最高密度）
  TRAIL_DECIMATE_ZOOM_BASE: 12,                    // 密度随 zoom 增长基准
  REPLAY_DECIMATE_MAX_POINTS: 4000,                // 回放路径视觉抽稀上限
  THUMB_DECIMATE_MAX_POINTS: 6000,                 // 缩略图/分享图抽稀上限
  REPLAY_START_DELAY: 300,                         // 列表点击回放后延迟启动(ms)

  // —— 轨迹采样 / 清洗 ——
  TRAIL_SAMPLE_MIN_DIST: 5,                        // 采样最小水平间隔(米)
  TRAIL_JITTER_FACTOR: 1.5,                        // 抖动过滤系数
  TRAIL_STATIONARY_SPEED: 0.3,                     // 静止速度阈值(m/s)≈1km/h；低于且位移异常大→判漂移鬼点
  TRAIL_MAX_POINTS: 300000,
  AUTO_PAUSE_WINDOW_S: 10,                         // 静止持续(秒)达此值自动暂停
  AUTO_PAUSE_SPEED: 0.5,                           // 低于此速度(m/s)视为静止
  AUTO_PAUSE_RESUME_SPEED: 1.2,                    // 高于此速度(m/s)视为恢复移动
  AUTO_PAUSE_STORAGE_KEY: 'trailcraft_autopause',
  TRAIL_CLEAN_START_M: 30,                         // 起点静止漂移累计位移阈值(米)
  TRAIL_CLEAN_END_M: 30,                           // 终点静止漂移累计位移阈值(米)
  TRAIL_CLEAN_MAX_JUMP_FACTOR: 5,                  // 单点跳变相对「速度×时间」倍数上限

  // —— 轨迹分段 / 关键点分析 ——
  TRAIL_SEGMENT_MIN_POINTS: 3,                     // 速度等级连续 N 点才切段(防抖)
  TRAIL_SEGMENT_MIN_DIST: 60,                      // 段最短距离(米)，过短并入相邻
  TRAIL_SEGMENT_MIN_MS: 10000,                     // 段最短时长(ms)，过短并入相邻

  // —— 速度等级表（单一来源：map.js 着色 + trail-analysis.js 分段共用）——
  // 每个元素 {mode, max(上界 m/s), label(中文), color(hex)}
  TRAIL_SPEED_LEVELS: [
    { mode: 'walk',  max: 2.78,    label: '步行', color: '#00E5CC' },
    { mode: 'bike',  max: 5.56,    label: '骑行', color: '#FFD700' },
    { mode: 'bus',   max: 16.67,   label: '公交', color: '#FF8C00' },
    { mode: 'car',   max: 33.33,   label: '驾车', color: '#FF5E33' },
    { mode: 'train', max: 55.56,   label: '火车', color: '#FF3366' },
    { mode: 'hsr',   max: 97.22,   label: '高铁', color: '#BF40FF' },
    { mode: 'sct',   max: Infinity, label: '超高速', color: '#5E5CE6' },
  ],

  // —— GPS 节流（速度自适应）——
  GPS_ADAPTIVE_K: 8000,
  GPS_MIN_INTERVAL: 500,
  GPS_MAX_INTERVAL: 60000,
  GPS_MOVE_THRESHOLD: 0.5,

  // —— GNSS 弱信号省电联动（滞回带）——
  GNSS_WEAK_USED_MAX: 4,        // 进入：参与定位卫星数 < 此
  GNSS_WEAK_SNR_MAX: 25,        // 进入：平均信噪比 < 此(dB-Hz)
  GNSS_RECOVER_USED_MIN: 6,     // 恢复：参与定位卫星数 >= 此
  GNSS_RECOVER_SNR_MIN: 30,     // 恢复：平均信噪比 >= 此
  GNSS_WEAK_HOLD_MS: 30000,     // 进入需持续(约30次 GNSS 事件)
  GNSS_RECOVER_HOLD_MS: 10000,  // 恢复需持续
  GPS_WEAK_SIGNAL_INTERVAL: 120000,   // 弱信号定位心跳间隔(ms)
  GPS_WEAK_SIGNAL_LOW_ACCURACY: false,// 弱信号是否降精度重启 watch

  // —— NMEA（原生插件：UTC 校准 + VTG 航向/速度）——
  NMEA_VTG_MAX_AGE_MS: 2000,    // VTG 有效窗口
  NMEA_UTC_MAX_AGE_MS: 5000,    // UTC 校准漂移窗口

  // —— GNSS 定位源接管（原生主导 + 浏览器低频兜底）——
  GPS_TAKEOVER_MIN_SATS: 4,     // 接管所需最少卫星
  GPS_TAKEOVER_HDOP: 4,         // HDOP 优于此→信号好(原生主导)
  GPS_NATIVE_FALLBACK_INTERVAL: 30000,   // native 档浏览器兜底心跳(ms)
  GPS_NATIVE_FALLBACK_MAX_AGE: 30000,    // native 档浏览器 maximumAge(ms)
  GPS_SOURCE_HOLD_MS: 5000,     // 源切换滞回

  // —— NMEA 增强（GGA 海拔 / GSA DOP / RMC 交叉验证）——
  NMEA_GGA_MAX_AGE_MS: 5000,
  NMEA_GSA_MAX_AGE_MS: 3000,
  NMEA_RMC_MAX_AGE_MS: 5000,
  NMEA_SPEED_CONFLICT_RATIO: 0.3,     // VTG vs RMC 速度相对偏差阈值
  NMEA_SPEED_CONFLICT_ABS: 2.0,       // VTG vs RMC 速度绝对偏差(m/s)
  NMEA_HEADING_CONFLICT_DEG: 30,      // VTG vs RMC 航向偏差(度)
  NMEA_HEADING_MIN_SPEED: 1.0,        // 低于此速度航向不参与交叉验证
  NMEA_COORD_CONFLICT_M: 30,          // 原生 GGA/RMC vs 浏览器点偏差阈值(米)
  NMEA_COORD_CONFLICT_STREAK: 3,      // 连续 N 次超阈才判原生坐标不可信

  // —— 航向兜底（位置差分）——
  HEADING_DIFF_MIN_M: 2.0,        // 相邻滤波点位移低于此不更新差分航向
  HEADING_DIFF_MIN_SPEED: 1.0,    // 低于此速度 GPS 航向不再可信→用差分
  HEADING_DIFF_LPF_ALPHA: 0.3,    // 差分航向一阶低通系数

  // —— Huber 鲁棒滤波基准阈值（标准化残差；0=禁用）——
  GPS_HUBER_K: 2.0,               // 实际阈值由 KalmanFilter._huberKFor() 按速度+精度自适应缩放

  // —— IMM 实时滤波 ——
  IMM_FILTER_ENABLED: true,
  IMM_MODEL_Q: [0.05, 0.25, 1.0],   // STILL/CV/CA 加速度过程噪声(m/s² 标准差)
  IMM_TRANSITION: [                 // 马尔可夫转移 Π[i][j]=P(下一=模型i|当前=模型j)，列和=1
    [0.98, 0.015, 0.005],
    [0.015, 0.97, 0.015],
    [0.005, 0.015, 0.98],
  ],
  IMM_INIT_PROB: [0.6, 0.3, 0.1],    // 初始模型概率(STILL/CV/CA)
  IMM_POS_VAR: 2500,                 // 初始位置方差(米²)
  IMM_VEL_VAR: 0,                    // 初始速度方差(米²/s²)
  IMM_ACC_VAR: 4,                    // 初始加速度方差(米²/s⁴)
  IMM_REANCHOR_M: 3000,              // 距参考点超此重锚(米)
  IMM_SPEED_LIMIT: 120,              // 模型速度模量限幅(m/s)
  IMM_FREEZE_ACC: 1750,              // 精度超此冻结在最后可信位置(米)
  IMM_LIKELIHOOD_TEMP: 2.0,          // 模型似然温度 γ（Λ^γ 放大模型差异）
  IMM_SPEED_PRIOR: true,             // 速度辅助模型先验(GPS speed 软门控)
  IMM_MIN_PROB: 1e-6,                // 模型概率下界

  // —— IMU 惯性导航融合（仅定位校准）——
  IMU_ENABLED: true,
  IMU_FEED_INTERVAL_MS: 1000,        // 加速度滑窗聚合时长(1Hz)
  IMU_WIN_BUCKETS: 4,                // 滑窗分桶数
  IMU_FEED_MAX_AGE_MS: 2000,         // 聚合值新鲜度上限
  IMU_ACC_LPF_ALPHA: 0.4,            // 窗口均值后一阶低通
  IMU_ACC_TRUST: 0.6,                // 注入强度(0=纯GPS,1=全信IMU)
  IMU_ACC_CLAMP: 30,                 // 加速度幅值限幅(m/s²)
  IMU_MIN_USED_SATS: 5,              // 启用 IMU 所需的最少解算中卫星数(usedInFix > 此值才开启)

  // —— 海拔独立滤波（四级融合）——
  ALT_FILTER_ENABLED: true,
  ALT_FILTER_RTS_ENABLED: true,
  ALT_KALMAN_R_BASE: 64,             // 垂直观测噪声方差基准(~8m²)
  ALT_KALMAN_R_MIN: 16,              // 自适应 R 下限(~4m²)
  ALT_KALMAN_R_MAX: 900,             // 自适应 R 上限(~30m²)
  ALT_KALMAN_Q_BASE: 0.5,            // 垂直动态噪声基准(固定)
  ALT_KALMAN_Q_MAX: 8,               // 自适应 Q 上限
  ALT_KALMAN_Q_REF_VEL: 5,           // Q 自适应参考垂直速度(m/s)
  ALT_RESIDUAL_WINDOW: 20,           // 残差滑动窗口
  ALT_MEDIAN_WINDOW: 5,              // 中值预滤波窗口(奇数)
  ALT_HUBER_K: 2.0,                  // 海拔残差 Huber 阈值系数
  ALT_HUBER_K_MIN: 1.0,              // Huber 阈值下限
  ALT_VELOCITY_LIMIT: 30,            // 海拔变化速率上限(m/s)
  ALT_RTS_ALPHA_MAX: 0.3,            // 海拔 RTS 反向平滑最大权重
  ALT_RTS_ALPHA_MIN: 0.1,            // 海拔 RTS 反向平滑最小权重

  // —— 存储引擎 ——
  TRAIL_STORAGE_ENGINE: 'auto',      // 'auto'|'indexeddb'|'localstorage'
  DB_NAME: 'trailcraft_db',
  DB_VERSION: 2,
  DB_STORE_TRAIL: 'trail',
  DB_STORE_META: 'trail_meta',
  DB_MAX_SIZE: 200 * 1024 * 1024,
  LS_MAX_SIZE: 5 * 1024 * 1024,
  TRAIL_EMERGENCY_KEY: 'trailcraft_emergency',   // 紧急快照(localStorage 同步兜底)

  // —— Debug / UI ——
  DEBUG: false,
  MOBILE_BREAKPOINT: 480,
  DEFAULT_TOAST_DURATION: 3000,
  TOAST_FADE_MS: 300,
};
```

> **速度等级换算**：`walk 2.78=10km/h`、`bike 5.56=20`、`bus 16.67=60`、`car 33.33=120`、`train 55.56=200`、`hsr 97.22=350`、`sct=∞`。图例（见 DOM `.speed-legend`）阈值以此对齐。
> 复刻时 `TRAIL_SPEED_LEVELS` 与图例务必一致；`map.js`/`trail-analysis.js` 只读这一份。

## 7. 全局工具函数规格（精确签名）

全部挂在全局（非模块导出），由 `config.js` 定义。

| 函数 | 签名 | 行为 |
|---|---|---|
| `calcDistance(p1,p2)` | `(p1,p2)→number` | 优先 `qq.maps.spherical.computeDistanceBetween`；否则 Haversine（`EARTH_RADIUS=6371000`）。返回米。 |
| `calcBearing(p1,p2)` | `(p1,p2)→number` | 优先 `qq.maps.spherical.computeHeading`；否则球面初方位角 `((atan2(y,x)*180/π+360)%360)`。0–360 正北起。 |
| `bearingToDir(deg)` | `(deg)→string` | 8 方位英文：`['N','NE','E','SE','S','SW','W','NW'][round(deg/45)%8]`；非有限返回 `'--'`。 |
| `formatDistance(m)` | `(m)→string` | `<1000→"Nm"`；`<10000→"X.XXkm"`；否则 `"X.Xkm"`；非法→`'--'`。 |
| `formatDurationShort(ms)` | `(ms)→string` | 中文：`"NhM分"` / `"M分S秒"` / `"S秒"`；≤0→`'--'`。 |
| `copyText(text)` | `(text)→Promise<bool>` | `navigator.clipboard.writeText` 兜底 `textarea+execCommand('copy')`。 |
| `ddToDms(dd,type)` | `(dd,'lat'\|'lng')→string` | 度分秒 + `N/S/E/W`。 |
| `formatBeijing(ts,withDate=true)` | `(ts,bool)→string` | `toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',...})`；非法→`''`。 |
| `formatDateTime(ts,opts)` | `(ts,{withSeconds,shortDate})→string` | 本地时区 `"YYYY-MM-DD HH:MM"` 或 `"M/D HH:MM:SS"`；缺失→`'--'`。 |
| `formatDurationLong(ms)` | `(ms)→string` | `"H:MM:SS"` / `"M:SS"` / `"S秒"`；≤0→`'--'`。 |

> **坐标转换不在此处**：见第 8 节（`MapManager.wgs84ToGcj02*`）。全局中**不存在** `wgs84ToGcj02` 自由函数。

## 8. 坐标转换规格（WGS84↔GCJ02）

实现为 `MapManager` 的方法（非全局函数）。原始 GPS 点（WGS84）在写入轨迹缓冲时**保持 WGS84**；仅在"显示 / 持久化历史"时转换。

### 8.1 手写同步算法 `_wgs84Gcj02(point)`（零网络，精度偏差 <1m）

```js
_wgs84Gcj02(point) {
  const A = 6378245.0;
  const EE = 0.00669342162296594323;
  const outOfChina = (lat, lng) =>
    lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  const transformLat = (x, y) => {
    let ret = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x));
    ret += (20*Math.sin(6*x*Math.PI) + 20*Math.sin(2*x*Math.PI)) * 2/3;
    ret += (20*Math.sin(y*Math.PI) + 40*Math.sin(y/3*Math.PI)) * 2/3;
    ret += (160*Math.sin(y/12*Math.PI) + 320*Math.sin(y*Math.PI/30)) * 2/3;
    return ret;
  };
  const transformLng = (x, y) => {
    let ret = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x));
    ret += (20*Math.sin(6*x*Math.PI) + 20*Math.sin(2*x*Math.PI)) * 2/3;
    ret += (20*Math.sin(x*Math.PI) + 40*Math.sin(x/3*Math.PI)) * 2/3;
    ret += (150*Math.sin(x/12*Math.PI) + 300*Math.sin(x/30*Math.PI)) * 2/3;
    return ret;
  };
  const { lat, lng } = point;
  if (outOfChina(lat, lng)) return point;          // 中国境外透传
  const dlat = transformLat(lng - 105, lat - 35);
  const dlng = transformLng(lng - 105, lat - 35);
  const radLat = lat / 180 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const dlatFinal = (dlat * 180) / ((A * (1 - EE)) / (magic * sqrtMagic) * Math.PI);
  const dlngFinal = (dlng * 180) / (A / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lat: lat + dlatFinal, lng: lng + dlngFinal };
}
```

### 8.2 公开方法（map.js）

| 方法 | 行为 |
|---|---|
| `async wgs84ToGcj02(point)` | 优先 `qq.maps.convertor.translate([latLng], 1, cb)`（mode=1 即 WGS84→GCJ02），2s 超时；失败/无 SDK 降级 `_wgs84Gcj02`。 |
| `wgs84ToGcj02Sync(point)` | 直接 `_wgs84Gcj02`（高频推算 25Hz 回调用，避免爆网络请求）。 |
| `batchWgs84ToGcj02(points)` | `points.map(p => _wgs84Gcj02(p))`，用于结束记录 RTS 后整段批量转换。 |

### 8.3 数据流中的位置（复刻必须遵循）

```
GPSManager._onGeoSuccess(pos):  原始 pos.coords 为 WGS84
  → 推入 this._rawFixes（WGS84，滤波前，供 RTS 离线平滑）   // gps-manager.js
  → ImmFilter/Kalman 在局部 ENU 米坐标运算（参考点取段首）   // 内部 WGS84 即可
  → 回调 App.onPositionChange(filtered)  // filtered 仍为 WGS84 局部坐标投影
App._recordFix():
  → mapManager.setMyPosition / setTrail 需要 GCJ02：
      convPos = await mapManager.wgs84ToGcj02(pos)   // 单点异步转换
  → trail.addFix(convPos)  // 轨迹点以 GCJ02 存储、画地图
结束记录：
  → App.smoothTrailRts3d(_rawFixes)  // RTS 输出 WGS84
  → gcj = mapManager.batchWgs84ToGcj02(smoothed)  // 批量转 GCJ02
  → Storage.saveTrailToList(gcj, name, favorite)  // 历史以 GCJ02 持久化
```

> **导出 GPX 约定**：导出时建议保留 WGS84（对 `Storage` 中已存 GCJ02 的点做逆变换，或记录时额外留存 WGS84 原始）。至少须保证"导出坐标与显示坐标一致"并在文档注明，避免第三方软件偏移。

## 9. JS 模块逐一定义

> 全部为全局类/对象，无 `export`。方法名/参数顺序/字段名按真实代码给出。

### 9.1 config.js
内容：第 6 节全部 `CONFIG` + 第 7 节全部全局工具函数。加载顺序第 1，无依赖。

### 9.2 toast.js
```js
const Toast = {
  show(msg, type='info', duration=CONFIG.DEFAULT_TOAST_DURATION) { /* 单例容器 #toast（若不存在则创建），append toast 元素，duration 后淡出移除 */ }
}
```
- `type` ∈ `info|success|warning|error`，决定配色（toast-modal.css `.toast-{type}`）。
- 多 toast 纵向排列，不重复堆叠。

### 9.3 storage.js
`Storage` 静态类。IndexedDB（轨迹+meta）/ localStorage（当前轨迹、设置、迁移兜底）自动选择。

**引擎选择**：`TRAIL_STORAGE_ENGINE`：`auto`→有 IndexedDB 用 idb 否则 ls；`indexeddb`/`localstorage` 强制。`_getActiveStore()` 返回 `{save,load,clear}` 接口，二者签名一致（均返回 Promise 或值）。

**IndexedDB 结构**：
- `DB_NAME='trailcraft_db'`, `DB_VERSION=2`。
- store `trail`（keyPath `id`）：存 `id:'current'`（当前轨迹）或 `list_<ts>`（历史完整，含 positions）。
- store `trail_meta`（keyPath `id`，index `updatedAt`）：仅 meta（列表只读，避免反序列化大 positions）。
- 升级：`v0→v1` 建 `trail`；`v1→v2` 建 `trail_meta`。`_initDB()` 成功后执行 `_migrateFromLocalStorage`（把旧 localStorage `trailcraft_trail` 迁到 idb）。

**公开 API（复刻签名，均为静态方法）**：

| 方法 | 返回 | 说明 |
|---|---|---|
| `saveTrail(trail)` | `Promise<bool>` | 存/更新**当前轨迹**（`id:'current'`），含 `positions/updatedAt/isRecording/isPaused`；空轨迹跳过。超配额自动抽稀（按比例均匀抽点）。 |
| `loadTrail()` | `Promise<{positions,isRecording,isPaused,updatedAt,pointCount} \| null>` | 恢复当前轨迹。 |
| `clearTrail()` | `Promise` | 删当前轨迹（idb + 清 localStorage 键）。 |
| `getTrailInfo()` | `Promise<{pointCount,sizeBytes,updatedAt,engine}>` | 当前轨迹信息。 |
| `setEngine(engine)` / `getEngine()` | — / string | 运行时切换引擎（重置检测标志）。 |
| `saveTrailToList(positions, name, favorite, opts)` | `Promise<id \| null>` | 存历史轨迹；`id='list_'+Date.now()`；自动算 `distance`(Haversine 累加)/`duration`/`pointCount`/`name`(默认"轨迹 MM-DD HH:MM")；双写 `trail`+`trail_meta`。`opts.cleaned` 记入 meta。 |
| `loadTrailList()` | `Promise<Array<{id,name,createdAt,distance,duration,pointCount,favorite}>>` | 优先读 `trail_meta`（按 `updatedAt` 倒序游标），为空/未迁移则回退合并 `trail`+`meta` 并懒迁移。 |
| `loadTrailById(id)` | `Promise<{positions,name,favorite,createdAt,distance,pointCount,duration,cleaned} \| null>` | 完整轨迹。 |
| `loadTrailsByIds(ids[])` | `Promise<Array>` | **按 ids 顺序回填**（IndexedDB 不保证 get 回调顺序，按索引位预置占位再 `filter(Boolean)`），用于合并/批量。 |
| `mergeTrails(ids[], name)` | `Promise<id \| null>` | 依序首尾拼接（相邻重合点去重），`saveTrailToList` 存为新轨迹。 |
| `deleteTrail(id)` | `Promise<bool>` | 双 store 删除。 |
| `renameTrail(id,name)` | `Promise<bool>` | 双 store 改名。 |
| `toggleFavorite(id)` | `Promise<bool>` | 切换收藏，返回新状态；双 store 同步。 |
| `updateTrailMeta(id, patch)` | `Promise<bool>` | 部分更新（如 `{cleaned:true, positions, distance, duration}`）；meta store 只同步 `['name','distance','duration','pointCount','favorite','cleaned']`，不写大 positions。 |

**二进制紧凑编码（localStorage 超配额兜底 & 跨引擎兼容）**：
- 魔数 `'CT1'`（字节 `67,84,49`），`_TRAIL_VERSION=2`。
- 头部 12 字节：magic(3) + version(1) + `Float64` baseTime（基准毫秒）。
- 每点 26 字节：`Float64 lat` + `Float64 lng` + `Uint32 time`(相对基准毫秒) + `Uint16 speed`(×100) + `Uint16 heading`(×100，0–35999) + `Uint16 accuracy`。
- `_encodeTrail(positions)`→字符串（chunk 8192 拼 `fromCharCode`）；`_decodeTrail(str)`→`{positions}`；首字节 `67`('C') 识别紧凑格式，否则按 JSON 解析。
- 估算大小 `_estimateSize = 12 + n*26`。

**常量**：`TRAIL_KEY='trailcraft_trail'`, `TRAIL_META_KEY='trailcraft_trail_meta'`, `_TRAIL_LIST_PREFIX='list_'`, `_META_MIGRATED_KEY='trailcraft_meta_migrated_v'+DB_VERSION`。

### 9.4 trail.js
`Trail` 类，当前会话轨迹状态机。

| 字段 | 说明 |
|---|---|
| `positions` | 采样点数组（GCJ02，含 `lat,lng,alt,time,speed,heading,accuracy`） |
| `recording` / `paused` | 记录/暂停状态 |
| `lastFix` | 上一有效点 |
| `totalDistance` / `maxSpeed` / `avgSpeed` | 运行中累计统计 |

**关键方法**：
- `start()`：重置 `positions`，`recording=true,paused=false`。
- `pause()` / `resume()`：切换 `paused`（暂停期间不采样）。
- `stop()`：`recording=false`，记 `endTime`。
- `addFix(fix)`：**采样控制**（传入已是 GCJ02 的滤波点）：
  ```
  if (!recording || paused) return false;
  if (lastFix) {
    d = calcDistance(lastFix, fix);
    dt = fix.time - lastFix.time;
    if (d < TRAIL_SAMPLE_MIN_DIST && dt < /* 最小间隔 */) return false;  // 降噪
    if (fix.speed < TRAIL_STATIONARY_SPEED && d > TRAIL_JITTER_FACTOR * 合理漂移) → 判漂移鬼点，return false;
  }
  positions.push(fix); lastFix = fix; 更新 distance/maxSpeed; return true;
  ```
- `getStats()`：委托 `TrailAnalysis.analyze(positions).stats`。
- `pointCount` getter；`clear()`。

### 9.5 trail-analysis.js
`TrailAnalysis` 纯函数对象（无 DOM）。

| 方法 | 输出 |
|---|---|
| `analyzeKeyPoints(positions)` | `{start, end, maxSpeedPoint}` 关键点。 |
| `analyzeSegments(positions)` | 按速度等级自动分段，带防抖；返回 `[{level,color,mode,startIndex,endIndex,distance}]`。 |
| `analyze(positions)` | `{stats, keyPoints, segments}`。 |

**stats**：`distance`(Haversine 累加) / `duration`(首末 time 差) / `maxSpeed` / `avgSpeed`(距离/时间) / `climb`+`descend`(alt 差分正/负累加) / `pointCount` / `levelDistribution`(`{mode: 里程米}`)。

**分段防抖**（复刻要点）：对每点求 `level = getSpeedLevel(speed)`（`TRAIL_SPEED_LEVELS` 上界匹配）；扫描连续同 level 区间；若某 level 区间 `< TRAIL_SEGMENT_MIN_POINTS` 点且前后 level 相同→并入；或区间 `distance < TRAIL_SEGMENT_MIN_DIST` / `时长 < TRAIL_SEGMENT_MIN_MS`→并入相邻；否则独立成段。

### 9.6 map.js
`MapManager` 类，腾讯地图 `qq.maps` 封装。构造 `new MapManager()`；`init(key)` 异步建实例（依赖全局 `qq.maps`）。所有公开方法在 `this.map` 未就绪时安全返回。

**Canvas 叠加层**：`#map` 内含 `#circle-canvas`（精度圆）+ `#overlay-canvas`（轨迹线/箭头）；`_resizeCanvas()` 按 `devicePixelRatio` 设尺寸；`_metersToPixels(m, latLng)` 用 `156543.03392*cos(lat)*2^-zoom` 把米转像素。

**坐标转换方法**：见第 8 节（`wgs84ToGcj02` / `wgs84ToGcj02Sync` / `batchWgs84ToGcj02` / `_wgs84Gcj02`）。

**公开方法**：

| 方法 | 说明 |
|---|---|
| `init(key)` | `new qq.maps.Map('map', {center:DEFAULT_CENTER, zoom:DEFAULT_ZOOM, ...})`。 |
| `flyTo(center, zoom)` | `panTo` + `setZoom(zoom||LOCATION_ZOOM)`。 |
| `setTheme(theme)` | 缓存主题（影响图标/叠加层配色）。 |
| `setMyPosition({lat,lng,accuracy,heading})` | 画"我的位置"标记（蓝色圆点 + 按 heading 旋转的箭头 SVG，`_createLocationIcon` 按 5° 取整缓存 `MarkerImage`）+ 精度圆（Canvas 半径=`accuracy` 米转像素）。 |
| `setTrail(positions, opts)` | **增量画线 + 抽稀**。基于 `_lastTrailCount` 锚点，仅补画新点；地图缩放低时按 `TRAIL_DECIMATE_*` 抽稀到 `MIN_DRAW_PX` 以上密度（见下）。全量变化先 `clearTrail`。 |
| `clearTrail()` | 清全部叠加层。 |
| `addKeyPointMarker(point, type)` | 起点/终点/最高速标记（自定义 Icon）。 |
| `fitBounds(positions)` | 缩放到包含所有点的视野。 |
| `setFollowMode(bool)` | 跟随开启后定位更新 `panTo`。 |
| `renderTrailThumbnail(positions, w, h)` | 离屏 Canvas 渲染缩略图，**按瓦片拼接**（如 4×3 网格），返回 dataURL，用于列表卡片。 |
| `renderTrailCollage(positions, w, h)` | 多轨迹拼图（分享/报告用）。 |
| `renderShareCard(trail, opts)` | 生成分享图（轨迹+统计条+速度色阶）。 |

**抽稀算法**（复刻要点）：`targetCount = clamp(zoom 映射, TRAIL_DECIMATE_MIN_ZOOM_LIMIT, TRAIL_DECIMATE_MAX_ZOOM_LIMIT)`，以 `TRAIL_DECIMATE_ZOOM_BASE` 为基准，zoom 越高保留越多点；抽稀后逐段按 `TRAIL_SPEED_LEVELS` 着色彩色 polyline（或 Canvas 段）。增量更新只在 `positions.length>_lastTrailCount` 时补画新增段。

### 9.7 gps-kalman.js
**双重职责**：
1. **共享常量**（顶层 `var`，挂全局，供 gps-imm/gps-manager 引用）：
   ```
   var DEG2RAD = Math.PI / 180;
   var M_PER_DEG = 111320;
   var S_DET_EPSILON = 1e-9;   // 矩阵行列式下限，防除零
   var RTS_MIN_DT = 200;       // ms，RTS 最小步长
   ```
2. **`KalmanFilter`**：4 维状态 `[x,y,vx,vy]ᵀ`（局部米坐标），**仅服务离线 RTS 平滑**，与实时 `ImmFilter` 解耦。
   - 预测 `F=[[1,0,dt,0],[0,1,0,dt],[0,0,1,0],[0,0,0,1]]`；`P⁻=F·P·Fᵀ+Q`，`Q=diag([q_pos,q_pos,q_vel,q_vel])`，`q_pos=RTS_Q*dt²/3` 量级、`q_vel=RTS_Q*dt`。
   - 更新 `H=[[1,0,0,0],[0,1,0,0]]`，`R=diag([r,r])`；标准 KF 增益 `K=P⁻Hᵀ(HP⁻Hᵀ+R)⁻¹`；含 **Huber 鲁棒**（见下）。
   - **`_huberKFor(speed, acc)`**：按速度+精度自适应缩放 Huber 阈值（`GPS_HUBER_K` 基准）：低速静止压狠、高速机动放宽、精度差收紧；返回 `k`（标准化残差阈值，0=禁用）。
   - **`smooth(pts)`**：前向 KF + 后向 RTS 平滑，返回平滑后同结构点序列（WGS84 输入/输出，内部转局部米坐标，参考点取段首）。

> 实时定位**不**用此类；实时用 `ImmFilter`（9.8）。

### 9.8 gps-imm.js
`ImmFilter`：交互式多模型（IMM）实时滤波，**统一 6 维状态 `[x,y,vx,vy,ax,ay]ᵀ`（局部 ENU 米坐标）**，三模型差异仅在加速度过程噪声 `q_a`（来自 `IMM_MODEL_Q=[STILL,CV,CA]`）。

**F（各模型，3×3 块 ×2 轴）**：
```
STILL: F=[[1,0,0],[0,0,0],[0,0,0]]   // 位置不变，速度/加速度衰减
CV:    F=[[1,dt,0],[0,1,0],[0,0,0]] // 加速度=0
CA:    F=[[1,dt,dt²/2],[0,1,dt],[0,0,1]]
```

**IMM 四步（每次 `update(z, dt)`）**：
```
1) 交互混合：c_j=Σ_i μ_i·Π_ij；x0_j=Σ_i (μ_i·Π_ij/c_j)·x_i；
            P0_j=Σ_i (μ_i·Π_ij/c_j)·(P_i+(x_i−x0_j)(x_i−x0_j)ᵀ)
2) 各模型 KF：x_j,P_j,Λ_j = KF(x0_j,P0_j,z,dt,F_j,Q_j,R)
   Q_j = diag(q_a_j² 相关块)；R 由 GPS 精度自适应（见 gps-manager）
3) 概率更新：μ_j = (c_j·Λ_j^γ) / Σ_k(c_k·Λ_k^γ)，γ=IMM_LIKELIHOOD_TEMP（放大模型差异）
   Λ_j = exp(−½·νⱼᵀSⱼ⁻¹νⱼ)/√(2π|Sⱼ|)
   若 IMM_SPEED_PRIOR：用 GPS 上报 speed 软门控（速度大→抬 CV/CA 概率，静止→抬 STILL）
4) 融合：x_fused=Σ_j μ_j·x_j；P_fused=Σ_j μ_j·(P_j+(x_j−x_fuse)ᵀ)
```

**保护机制**（全部保留）：
- **Huber/冻结**：残差超 `_huberKFor` 降权；精度 `> IMM_FREEZE_ACC` 冻结在最后可信位置。
- **时间重置/重锚**：`dt>IMM_DT_MAX` 重置模型概率；距参考点 `> IMM_REANCHOR_M` 重锚（参考点取段首 WGS84）。
- **速度限幅**：模型速度模量 `> IMM_SPEED_LIMIT(120m/s)` 截断。
- **概率下界**：`μ_j=max(μ_j, IMM_MIN_PROB)`，列归一防浮点死锁。

**IMU 注入（纯加速度先验）** `feedImu(a_enu, dt, trust)`：
```
// a_enu: ENU 加速度 [a_east,a_north]（来自 ImuManager，见 9.10）
// 仅注入 CA 模型预测：
G = [½dt², dt, 0]ᵀ                  // 只影响位置/速度预测，加速度状态保持模型自持
x⁻_CA = F_CA·x̂_CA + G·a_imu
// 注入期 CA 模型 Q 缩放：Q_CA *= max(0.3, 1 − 0.7·trust)   // trust=IMU_ACC_TRUST
// 仅运动学先验，GPS 仍是位置权威（更新步仍用 GPS z）
```
> **明确不做**：GPS 丢失纯积分航迹推算（无 `predictOnly`/DR 状态机）、IMU 航向解算（航向完全由 GPS 权威 + `coords.heading`）。

**ENU 旋转**（设备系→地理系，IMU 用）：标准 ENU 基向量 `east=[-sin(lng),cos(lng),0]`、`north=[-sin(lat)cos(lng),-sin(lat)sin(lng),cos(lat)]`、`up=...`；设备线性加速度经 `rotation` 四元数旋到 ENU，取东/北分量。

### 9.9 gps-alt.js
海拔滤波链，**完全独立于水平滤波**，四级融合：
1. **L1 源头质量门 `_resolveAltitude`**：按口径来源（`gga` 来自 NMEA `$GPGGA` 海拔 / `browser` 来自 `coords.altitude`）与历史一致性筛除野值。
2. **L2 `AltKalmanFilter`**（1D 自适应卡尔曼）：状态 `[alt]`；`R` 在 `[ALT_KALMAN_R_MIN, ALT_KALMAN_R_MAX]` 间按残差自适应（基准 `ALT_KALMAN_R_BASE`）；`Q` 在 `[ALT_KALMAN_Q_BASE, ALT_KALMAN_Q_MAX]` 间按垂直速度（`ALT_KALMAN_Q_REF_VEL`）自适应。
3. **L3 `AltFilterPipeline`**：中值预滤波（`ALT_MEDIAN_WINDOW=5` 奇数）→ 自适应 Huber（`ALT_HUBER_K`，下限 `ALT_HUBER_K_MIN`，基于 `ALT_RESIDUAL_WINDOW=20` 残差窗口估计鲁棒尺度 σ̂）；速率限幅 `ALT_VELOCITY_LIMIT=30m/s`。
4. **L4 `AltRtsSmoother`**（离线 1D RTS）：结束记录后处理；反向平滑权重 `α∈[ALT_RTS_ALPHA_MIN, ALT_RTS_ALPHA_MAX]`，残差大时权重高。

> 海拔链只消费「原始海拔 + 时间戳 + 口径来源」，参数全走 `ALT_*`，不读精度/水平速度/`GPS_HUBER_K`。

### 9.10 gps-imu.js
`ImuManager`：原生 `ImuData` 插件桥接，**仅定位校准**。

**生命周期**：随 watch 启停（`GPSManager._startImu`/`_stopImu`），省电模式同步关闭；web 端无插件时 `isAvailable()===false`，静默跳过，**纯 GPS 零回归**。

**启用网关**：IMU 强制仅在 GNSS 参与定位（`usedInFix`）卫星数 `> IMU_MIN_USED_SATS(5)` 时才开启（`GPSManager._imuShouldRun`）；卫星数下降到阈值以下、省电模式或停止 watch 时自动 `_stopImu` 清空缓存。卫星数变化时（`_handleGnssSatellites`）动态同步启停，故弱信号/定位早期卫星不足阶段 IMU 不启动，达标后自动恢复。

**采样频率**：实际 IMU 回调频率由原生 `ImuData` 插件的 `sensorDelay` 档决定（接口见 10.2，默认 `SENSOR_DELAY_UI`≈10Hz）；JS 端仅被动接收事件流并按时长分桶聚合，不依赖固定频率，因此 10Hz 或更高档均能正常工作。

**数据流**：
```
ImuData 回调(原始线性加速度 x/y/z + rotation 四元数)
  → 设备系线性加速度经 rotation 旋到 ENU → 取 east/north 分量
  → 滑窗均值（IMU_FEED_INTERVAL_MS 窗口，分 IMU_WIN_BUCKETS=4 个桶环形缓冲，持续输出近 1s 均值）
  → 一阶低通 a_lpf = α·a_new + (1−α)·a_old   (α=IMU_ACC_LPF_ALPHA)
  → 幅值限幅 |a_lpf|>IMU_ACC_CLAMP → 截断
  → GPSManager 每次滤波 update 前 feedImu(a_enu, dt, IMU_ACC_TRUST) 注入 ImmFilter CA 模型
```
**新鲜度门**：聚合值年龄 `> IMU_FEED_MAX_AGE_MS(2000)` 视为过期，本次不注入。

**明确不做**：航向解算（陀螺仪不融合）。航向由 GPS 权威（NMEA VTG/RMC + `coords.heading`）；GPS 航向缺失/低速时由 `GPSManager._resolveHeadingFallback` 用滤波后相邻点位移差分兜底（`HEADING_DIFF_*`）。

### 9.11 gps-manager.js
`GPSManager` 主控制器。构造内实例化 `ImmFilter`/`KalmanFilter`(离线)/`AltFilterPipeline`/`AltRtsSmoother`/`ImuManager`。

**关键方法**：

| 方法 | 说明 |
|---|---|
| `startWatching(opts)` | `navigator.geolocation.watchPosition`；成功 `_onGeoSuccess`；失败 `_onGeoError`；同时 `_startImu()`。 |
| `stopWatching()` | 清 watch + `_stopImu()`。 |
| `_onGeoSuccess(pos)` | 解析 `coords`(WGS84) → 推入 `_rawFixes`(WGS84) → 速度自适应节流 → `ImmFilter.update(z,dt)`(或单模型 `KalmanFilter` 当 `IMM_FILTER_ENABLED=false`) → `AltFilterPipeline.push(alt,口径)` → 注入 IMU → `_resolveHeadingFallback` → 回调 `onPositionChange(filtered)`。 |
| `_onGeoError(err)` | 精度降级/权限拒绝 → `onError`；超时失败累计达 `GPS_TIMEOUT_MAX_FAILURES` 触发降级策略。 |
| `_startImu()`/`_stopImu()` | IMU 启停；web 无插件跳过。 |
| `feedImu(a)` | 供 ImuManager 回调注入。 |
| `_resolveHeadingFallback()` | GPS 航向权威（VTG/`coords.heading`）；低速/缺失用相邻滤波点位移差分 + `HEADING_DIFF_LPF_ALPHA` 一阶低通。 |
| `getFilteredState()` | 当前滤波后 `{lat,lng,alt,speed,heading,accuracy}`（WGS84 局部）。 |
| `setPowerSave(bool)` | 省电：关 IMU、降 `enableHighAccuracy`、拉长间隔到 `BG_LOCATE_INTERVAL_POWER_SAVE`。 |
| `singleLocate()` | `getCurrentPosition` 单次（初始中心/天气）。 |

**NMEA 增强**（原生插件推送）：`addListener('nmea',...)` 解析 `$GPVTG`(航向/速度)、`$GPGGA`(海拔/大地水准面)、`$G?GSA`(PDOP/HDOP/VDOP)、`$GPRMC`(速度/航向/有效性)；交叉验证：`NMEA_SPEED_CONFLICT_*`(VTG vs RMC 速度)、`NMEA_HEADING_CONFLICT_DEG`、`NMEA_COORD_CONFLICT_M`+`STREAK`(原生 GGA/RMC vs 浏览器点)；UTC 时钟校准 `NMEA_UTC_MAX_AGE_MS`。

**定位源接管**（折中方案）：`GPS_TAKEOVER_MIN_SATS`+`GPS_TAKEOVER_HDOP` 判原生主导；否则浏览器低频兜底（`GPS_NATIVE_FALLBACK_INTERVAL`/`MAX_AGE`）；`GPS_SOURCE_HOLD_MS` 滞回防抖。

**GNSS 弱信号省电联动**：参与卫星数/平均 SNR 经 `GNSS_WEAK_*`/`GNSS_RECOVER_*` 滞回带判定进入/恢复降级；降级时定位心跳拉长到 `GPS_WEAK_SIGNAL_INTERVAL`(120s)，可选 `GPS_WEAK_SIGNAL_LOW_ACCURACY` 降精度。

**速度自适应节流**：`interval = clamp(GPS_ADAPTIVE_K/speed 相关, GPS_MIN_INTERVAL, GPS_MAX_INTERVAL)`，弱信号覆盖 `GPS_WEAK_SIGNAL_INTERVAL`。

**回调**：`onPositionChange`/`onError`/`onStateChange` 由 `App` 构造后赋值（见 9.13）。

### 9.12 replay.js
`TrailPlayer`：`requestAnimationFrame` 驱动回放播放器。

| 字段 | 说明 |
|---|---|
| `trail` | 回放轨迹 positions（GCJ02） |
| `speed` | 倍速 `1\|2\|5\|10`（对应 DOM `.speed-btn[data-speed]`） |
| `currentIndex` | 当前点索引 |
| `playbackTime` | 回放虚拟时间(ms) |

**方法**：`play()`/`pause()`/`stop()`（rAF 循环）；`seek(ratio)`（进度条 0–1）；`setSpeed(s)`；`_tick(now)`（按 `speed` 推进 `playbackTime`）；`_updateMarker()`（计算方位角旋转箭头指向下一点，`atan2` + CSS `transform:rotate`）。

**插值**：给定 `playbackTime T`，找 `i` 使 `t_i ≤ T < t_{i+1}`；`f=(T−t_i)/(t_{i+1}−t_i)`；`lat=lerp(lat_i,lat_{i+1},f)`（lng/alt/speed 同）；`heading=calcBearing(p_i,p_{i+1})`。

**性能**：路径视觉抽稀到 `REPLAY_DECIMATE_MAX_POINTS=4000`；**"疾驰二分搜索"**（`galloping binary search`）在 `seek`/按时间定位当前段时，从上一 index 向前后跳跃定位，避免每帧从头扫描。

**回调**：`onProgress(ratio)`/`onComplete()`/`onFrame(virtualPos)`。

### 9.13 app-core.js
`App` 主控制器（最大文件）。构造：`mapManager=new MapManager(); gpsManager=new GPSManager(); trail=new Trail();` + 状态。`init()` 启动入口：

```
1. mapManager.init(CONFIG 中 key)        // key 由 index.html 注入的全局或常量提供
2. _setupUI()                            // 绑定第 5 节全部事件（含事件委托 + stopPropagation）
3. _restoreTheme()/_restoreState()       // localStorage 恢复主题/平滑/自动暂停
4. gpsManager.onPositionChange = this.onPositionChange.bind(this)
   gpsManager.onError = ...
5. gpsManager.startWatching()
```

**核心方法**（复刻签名）：
- `_setupUI()`：绑定 `gps-btn`/`theme-btn`/`tab-*`/`trail-record-btn`/`trail-pause-btn`/`trail-clear-btn`/`trail-stats-btn`/`trail-smooth-btn`/`export-report-btn`/`power-saving-btn`/`trail-autopause-btn`/`replay-*`/`batch-*`/`history-*`/`replay-*` 列表交互。
- `onPositionChange(filtered)`：→ `await mapManager.wgs84ToGcj02(pos)` → `trail.addFix` 采样 → `mapManager.setMyPosition`+`setTrail`(增量) → `_updateTrailUI` → 定时/离页 `Storage.saveTrail` 自动保存。
- `_recordFix()` / `_startRecording()` / `_pauseRecording()` / `_stopRecording()` / `_endTrailAny()`：记录生命周期。
- `_smoothTrailRts3d(rawFixesWGS84)`：调 `KalmanFilter.smooth`（水平 2D）+ `AltRtsSmoother`（海拔独立 1D）→ 平滑 WGS84 → `batchWgs84ToGcj02` → 写回轨迹点 → `Storage.saveTrailToList`。受 `trail-smooth-btn`（`localStorage 'trailcraft_trail_smooth'`）开关控制。
- `_renderTrailList()` / `_trailItemHTML(t)` / `_bindTrailItemEvents()`：历史列表渲染 + 卡片交互（收藏星/加载/详情/更多菜单/多选）。
- `_invalidateTrailCache()`：列表变更后清缓存重渲染。
- `_openDetail(id)`：详情弹窗（关键点 + 统计 + 缩略图）。
- `_exportTrail(id)` / `_reportTrail(id)`：委托 `app-export.js`。
- `_toggleTheme()` / `_applyTheme()`：主题切换（`document.documentElement.dataset.theme` = dark/light，`localStorage 'trailcraft_theme'`）。
- `_toggleFollow()`：跟随模式。
- `_initSmoothing()` / `_initAutoPause()`：读 `localStorage` 偏好初始化平滑/自动暂停开关；自动暂停：`AUTO_PAUSE_WINDOW_S` 静止自动暂停、`AUTO_PAUSE_RESUME_SPEED` 恢复。
- `_saveEmergencySnapshot()` / `_restoreEmergencySnapshot()`：页面强杀时把当前轨迹 JSON 存 `localStorage[CONFIG.TRAIL_EMERGENCY_KEY]`（同步兜底），重启恢复。
- `_onPageHide()` / `_onVisibilityChange()`：离页/隐藏时 `_endTrailAny()` + 后台定位心跳（`app-background.js`）。

### 9.14 app-gps-ui.js
**必须最后加载**（依赖全部 `App.prototype.*`）。通过 `App.prototype.*` 追加方法：

| 方法 | 说明 |
|---|---|
| `_initSpeedChart()` | Chart.js 速度曲线（`#speed-chart-canvas`）；`typeof Chart==='undefined'` 时静默返回。 |
| `_updateSpeedChart(frame)` | 回放时更新曲线游标（窗口 `SPEED_CHART_WINDOW`）。 |
| `_renderGpsStatusBar(state)` | GPS 状态条（`#gps-status`：精度/卫星数/模式）。 |
| `_toggleFollowMode()` | 跟随模式切换（与 9.13 `_toggleFollow` 协同）。 |
| `_initElevProfile()` | 海拔剖面（`#elev-profile-canvas`）。 |
| `_toggleSpeedChart()` / `_toggleElevProfile()` | 折叠/展开面板。 |

### 9.15 app-list.js
历史/回放列表 + 收藏 + 批量 + 合并：

| 方法 | 说明 |
|---|---|
| `_renderTrailList(tab)` | 渲染 `#trail-list`(history) / `#replay-trail-list`(replay)，消费 `Storage.loadTrailList()`。 |
| `_trailItemHTML(t)` | 卡片：缩略图(`map.renderTrailThumbnail`) + 名称 + 距离/时长/日期 + 收藏星 + 更多菜单(加载/回放/导出/删除/分享)。 |
| `_bindTrailItemEvents()` | 事件委托：卡片点击→详情；星→`Storage.toggleFavorite`；更多→加载/导出/删除/分享；播放→`app-replay._replayTrailFromList`。 |
| `_toggleMultiSelect()` | 多选模式；`batch-select-all-*` 全选当前。 |
| `_batchExport()/ _batchMerge()/ _batchDelete()/ _batchInvert()/ _batchClear()` | 绑定 `#batch-*`：`mergeTrails`/`deleteTrail`/反选/取消。 |
| `_searchTrails(query)` / `_applyTimeRange()` / `_applySort()` | 本地按名称/日期/距离过滤 + 时间范围 + 排序（`time/distance/duration/points`）；`fav-filter` 仅看收藏。 |
| `_loadFromCloud()` | 云端同步（可选增强，需自有后端，文档不含密钥）。 |

### 9.16 app-replay.js
回放 UI 桥接：

| 方法 | 说明 |
|---|---|
| `_replayTrailFromList(id)` | `Storage.loadTrailById` → `new TrailPlayer(positions)` → `play()`（延迟 `REPLAY_START_DELAY`）。 |
| `_onReplayFrame(virtualPos)` | 跟随模式 `panTo` 虚拟位置；更新 `#replay-slider`/`#replay-time`。 |
| `_onReplayComplete()` | 停止；自动解锁跟随。 |
| `_bindReplayControls()` | 播放/停止/倍速(`.speed-btn`)/进度条 `input` 事件 → `TrailPlayer.seek`。 |

### 9.17 app-export.js
导出多格式（统一经 `Blob`+`URL.createObjectURL`+`<a download>`，文件名 `轨迹_{name}_{format}.{ext}`）：

| 格式 | 方法 | 输出 |
|---|---|---|
| GPX | `_exportGPX(trail)` | `<gpx>`（建议保留 WGS84，见 8.3） |
| CSV | `_exportCSV(trail)` | `lat,lng,alt,time,speed,heading` 表头 |
| JSON | `_exportJSON(trail)` | 完整 Trail 对象 |
| GeoJSON | `_exportGeoJSON(trail)` | `LineString` + `FeatureCollection` |
| KML | `_exportKML(trail)` | Google Earth |
| PDF | `_exportPDF(trail)` | 报告（缩略图 + 统计 + 速度曲线截图） |
| 图片报告 | `_reportTrail(trail)` | `export-report-btn` 触发：`map.renderShareCard` + 统计条 + 速度色阶，导出 PNG |

### 9.18 app-stats.js
统计页 + 趋势：`_renderStats()`（总里程/时长/轨迹数/最常速度级）；`_renderTrend(range)`（周/月柱状图，Chart.js/Canvas）；`_computeLevelDistribution()`（委托 `TrailAnalysis.analyze` 的 `levelDistribution`）。

### 9.19 app-weather.js
天气查询：`_queryWeather(lat,lng)`（调天气 API，需自有 key，文档不含；失败静默）；`_renderWeatherPanel(data)`；按坐标网格缓存避免频繁请求。无 key 时 UI 区域隐藏，不影响主流程。

### 9.20 app-background.js
后台/离页持续记录：`_setupBackgroundPersistence()`（绑定 `pagehide`/`visibilitychange`→`_endTrailAny`）；`_enableBackgroundTracking()`（Service Worker 后台同步）；`_heartbeat()`（定时 `Storage.saveTrail` 当前轨迹 + 后台定位心跳 `BG_LOCATE_INTERVAL_*`）。

### 9.21 app-battery.js
电量监控与省电：`_initBattery()`（`navigator.getBattery()`，监听 `levelchange`）；`_onBatteryLevel(level)`（`level <` 阈值→`gpsManager.setPowerSave(true)` + Toast；更新 `#power-status`）；`_onBatteryRecover()` 恢复 `setPowerSave(false)`。阈值联动：`trail-autopause-btn`(手动自动暂停) + `power-saving-btn`(手动省电) + 电量自动省电三者共同决定 `#power-status` 文案（"定位间隔: Xs"）。

## 10. Native 层（Capacitor Android）接口规格

`native/gnss-plugin/src/index.ts` + `definitions.ts` 定义插件接口；Java 实现（`android/src/.../plugins/`）对应注册。Web 端通过 Capacitor bridge 调用；**web 无插件时全部静默降级**（见 9.10/9.11）。

### 10.1 GnssData 插件

**TypeScript 接口形态**：
```ts
interface GnssDataPlugin {
  start(options?: { minTimeMs?: number; minDistanceM?: number }): Promise<void>;
  stop(): Promise<void>;
  addListener(event: 'satellites', cb: (d: GnssSatellites) => void): PluginListenerHandle;
  addListener(event: 'nmea', cb: (d: GnssNmea) => void): PluginListenerHandle;
  addListener(event: 'raw', cb: (d: GnssRaw) => void): PluginListenerHandle;
  isAvailable(): Promise<{ available: boolean }>;
}
interface GnssSatellites {
  satellites: { svid: number; constellation: string; cn0DbHz: number; usedInFix: boolean; elevationDeg: number; azimuthDeg: number; }[];
  totalUsed: number;
}
interface GnssNmea {
  timestamp: number;          // ms
  message: string;            // 完整 NMEA 句（如 "$GNRMC,..."）
  courseDeg?: number;         // VTG/RMC 航向（GPS 权威航向来源之一）
  speedKnots?: number;
}
interface GnssRaw { svid: number; constellation: string; timeOffsetNs: number; }
```

**JS 桥接约定**：
```
window.Capacitor?.Plugins?.GnssData?.addListener('nmea', onNmea)
  → GPSManager 解析 courseDeg 注入航向（_resolveHeadingFallback 权威来源之一）
window.Capacitor?.Plugins?.GnssData?.addListener('satellites', onSat)
  → GPS 状态栏显示卫星数/usedInFix
GnssData.isAvailable() → 不可用则 web 静默跳过（不影响纯 GPS）
```

### 10.2 ImuData 插件

**TypeScript 接口形态**：
```ts
interface ImuDataPlugin {
  start(options?: { sensorDelay?: 'normal'|'ui'|'game'|'fastest'; includeRotation?: boolean; }): Promise<void>;
  stop(): Promise<void>;
  addListener(event: 'linearAcceleration', cb: (d: ImuSample) => void): PluginListenerHandle;
  isAvailable(): Promise<{ available: boolean }>;
}
interface ImuSample {
  timestamp: number;   // ms（单调时钟，用于新鲜度门）
  x: number; y: number; z: number;         // 设备坐标系线性加速度（去重力），m/s²
  rotation: { x: number; y: number; z: number; w: number };  // rotation 四元数（设备→世界系）
}
```

**JS 桥接约定**（对应 9.10）：
```
window.Capacitor?.Plugins?.ImuData?.addListener('linearAcceleration', sample => ImuManager.onSample(sample))
ImuData.isAvailable()===false → 静默跳过，纯 GPS 零回归
```

### 10.3 插件注册（Android Java 侧形态）
`native/android/app/src/main/java/.../plugins/`：
- `GnssDataPlugin.java`：`@PluginMethod` 注解 `start`/`stop`；桥接 `GnssStatus.Callback` 与 `GnssMeasurementsEvent`，经 `notifyListeners('satellites'|'nmea'|'raw', ...)` 抛出。
- `ImuDataPlugin.java`：`SensorManager` 注册 `TYPE_LINEAR_ACCELERATION` + `TYPE_ROTATION_VECTOR`，回调打包为 `ImuSample` 经 `notifyListeners('linearAcceleration', ...)` 抛出。

> **复刻要点**：JS 层只依赖 `ImuSample` 的 `x/y/z/rotation` 字段与 `GnssNmea.message/courseDeg`，Java 侧只要按此结构抛出 JSON 即可对接。web 端不实现插件，全靠 `isAvailable()` 降级。

## 11. CSS 设计令牌与主题

9 个 CSS 文件，主题通过 `:root[data-theme]` 变量切换（`theme.css` 定义 dark/light 两套令牌）。

### 11.1 theme.css（设计令牌）
```css
:root[data-theme="dark"] {
  --bg: #0f1115;        --bg-elev: #1a1d23;
  --fg: #e7eaf0;        --fg-dim: #9aa3b2;
  --accent: #3b82f6;    --accent-2: #22c55e;
  --danger: #ef4444;    --warn: #f59e0b;
  --border: #2a2f3a;    --shadow: rgba(0,0,0,.4);
  --panel-h: 220px;
}
:root[data-theme="light"] {
  --bg: #ffffff;        --bg-elev: #f4f6fa;
  --fg: #1a1d23;        --fg-dim: #5b6573;
  --accent: #2563eb;    --accent-2: #16a34a;
  --danger: #dc2626;    --warn: #d97706;
  --border: #e2e8f0;    --shadow: rgba(0,0,0,.12);
}
```
所有组件颜色**一律用 `var(--token)`**，禁止硬编码颜色（除速度等级 `TRAIL_SPEED_LEVELS` 的 hex，那是数据非主题）。

### 11.2 布局
- 单 HTML + 底部可折叠面板。地图全屏（`#map` 占满 viewport），`#bottomPanel` 浮于底部（GPS 状态条 + Tab + 面板 body）。
- 移动端优先：`MOBILE_BREAKPOINT=480`（`responsive.css`），面板折叠态高度可调。
- 字体：自定义 `.woff2`（见 `css/fonts.css`），fallback 系统无衬线。

### 11.3 各 CSS 职责
| 文件 | 职责 |
|---|---|
| `theme.css` | 设计令牌（dark/light） |
| `base.css` | reset + 全局排版 + 变量引用 |
| `map.css` | 地图容器/我的位置/精度圆 |
| `panel.css` | 底部面板折叠/展开/拖拽 |
| `gps.css` | GPS 状态条/记录按钮/精度指示 |
| `trail.css` | 轨迹卡片/列表/详情弹窗 |
| `toast-modal.css` | Toast + 模态框 |
| `responsive.css` | 断点适配 |
| `fonts.css` | `@font-face` woff2 |

## 12. 核心数据流与状态机

### 12.1 记录主链路
```
[原生 GPS] → navigator.geolocation.watchPosition
  → GPSManager._onGeoSuccess
    → 推入 _rawFixes (WGS84)
    → 速度自适应节流
    → ImmFilter.update(z, dt)       [实时 IMM 滤波]
    → AltFilterPipeline.push(alt)   [海拔滤波]
    → 若 IMU 可用: feedImu(a_enu)   [注入预测]
    → _resolveHeadingFallback       [航向]
    → onPositionChange(filtered)
  → App.onPositionChange
    → convPos = await mapManager.wgs84ToGcj02(pos)
    → trail.addFix(convPos)         [采样阈值，GCJ02]
    → mapManager.setMyPosition + setTrail(增量)
    → _updateTrailUI
    → 定时/离页 Storage.saveTrail
结束:
  → _smoothTrailRts3d(_rawFixes)    [RTS 水平2D + 海拔1D, WGS84]
  → batchWgs84ToGcj02 → Storage.saveTrailToList (GCJ02 持久化)
```

### 12.2 回放链路
```
列表卡片播放 → app-replay._replayTrailFromList(id)
  → TrailPlayer(trail.positions).play()
  → rAF _tick: 时间戳插值 virtualPos（疾驰二分搜索定位段）
  → App._onReplayFrame(virtualPos): mapManager.panTo + 进度条
  → onComplete: 解锁跟随
```

### 12.3 状态机（记录）
```
IDLE ──start──▶ RECORDING ──pause──▶ PAUSED ──resume──▶ RECORDING
  ▲                  │                                          │
  └────stop──────────┴────────── stop ──────────────────────────┘
RECORDING/PAUSED 中 pagehide/visibilitychange → _endTrailAny (保存副本 / 紧急快照)
```

### 12.4 精度/源/弱信号状态机
```
NORMAL ──accuracy>降级阈值──▶ DEGRADED ──accuracy<恢复阈值──▶ NORMAL
GNSS 弱信号: 卫星数/SNR 经 GNSS_WEAK_*/GNSS_RECOVER_* 滞回带进入/恢复降级
定位源: 原生主导 ⇄ 浏览器低频兜底（GPS_SOURCE_HOLD_MS 滞回）
```

## 13. PWA 与离线能力
- `manifest.webmanifest`（或 `<meta>` 内联）：name/short_name/start_url/display=standalone/theme_color/background_color/icons。
- Service Worker：注册于 `app-background._setupBackgroundPersistence` 关联；缓存核心 HTML/JS/CSS 用于离线打开（**不含腾讯地图/Chart.js 等 CDN**，CDN 需联网）。
- 数据全部本地（IndexedDB），无服务端依赖（天气/云端为可选增强）。
> 复刻 PWA 时：SW 缓存列表应覆盖 `index.html` + `js/*` + `css/*` + `favicon.svg`，并 `navigator.serviceWorker.register('/sw.js')`。

## 14. 从零复刻步骤（精确到文件）
1. **建目录**：按第 3 节创建 `index.html` / `css/`(9 文件) / `js/`(21 文件)。
2. **写 config.js**：照抄第 6 节全部 `CONFIG` + 第 7 节工具函数。
3. **写 index.html**：照抄第 5 节 DOM 骨架；地图 `<script>` 的 `key={{TENCENT_MAP_KEY}}` 替换为自有腾讯地图 Key（勿提交真实 Key）；严格按第 4 节顺序加载 `js/*`。
4. **实现坐标转换**：`map.js` 的 `_wgs84Gcj02`（第 8.1 节）+ `wgs84ToGcj02`/`wgs84ToGcj02Sync`/`batchWgs84ToGcj02`。
5. **实现存储**：`storage.js`（第 9.3 节：双 store + CT1 编码 + 全部 API）。
6. **实现滤波链**：`gps-kalman`(共享常量+离线KF) → `gps-imm`(IMM+feedImu, 9.8) → `gps-alt`(四级链, 9.9) → `gps-imu`(桶式环形缓冲, 9.10)。
7. **GPS 控制器**：`gps-manager` 串起 watchPosition + 节流 + NMEA + 源接管 + 弱信号 + IMU 桥接 + 航向回退（9.11）。
8. **地图**：`map.js` 用腾讯 `qq.maps` 同步加载；增量画线 + 速度分段着色 + 抽稀 + 缩略图（9.6）。
9. **App 主控制器**：`app-core` 串地图/GPS/Trail/存储；`app-gps-ui`/`app-list`/`app-replay`/`app-export`/`app-stats`/`app-weather`/`app-background`/`app-battery` 按 9.14–9.21 追加原型方法。
10. **CSS/主题**：按第 11 节实现 9 个 CSS + 设计令牌。
11. **本地验证**：`npx serve .` → 浏览器开 `http://localhost:3000`，用 `mock-data.js` 生成模拟轨迹验证记录/回放/列表/导出/合并/批量。
12. **(可选) Android**：`cd native`，手工同步根目录资源到 `native/web/`，`npm run build:plugin && npm run sync && npm run build:apk`；实现 `GnssData`/`ImuData` 插件（接口见第 10 节）。

> **零回归保证**：web 端无 IMU/GNSS 插件时，所有原生调用经 `isAvailable()` 降级，纯 GPS 路径完全可用。

## 15. 算法速查表
| 算法 | 位置 | 公式/要点 |
|---|---|---|
| Haversine | config | `EARTH_RADIUS=6371000`；优先 `qq.maps.spherical` |
| WGS84→GCJ02 | map.js `_wgs84Gcj02` | 第 8.1 节（中国境外透传） |
| IMM 实时滤波 | gps-imm | 交互混合→各模型KF→概率更新(γ温度)→融合（6维ENU，9.8） |
| IMU 注入 | gps-imm.feedImu | `x⁻=F·x̂+G·a_imu`，`G=[½dt²,dt,0]ᵀ`，Q缩放`max(0.3,1−0.7·trust)` |
| ENU 旋转 | gps-imm | 标准 ENU 基向量 + 设备 rotation 四元数 |
| 离线 RTS | gps-kalman | 4D 恒速 KF 前向 + 后向平滑；`_huberKFor` 自适应 |
| 海拔四级链 | gps-alt | 质量门→1D自适应Kalman→中值+Huber→离线RTS |
| 速度自适应节流 | gps-manager | `clamp(GPS_ADAPTIVE_K/speed, MIN, MAX)` + 弱信号覆盖 |
| 航向回退 | gps-manager | GPS 权威 → 位移差分 LPF(`HEADING_DIFF_LPF_ALPHA`) |
| 速度分段着色 | trail-analysis+map | `getSpeedLevel` + `TRAIL_SPEED_LEVELS`（防抖合并） |
| 回放插值 | replay | 时间戳线性插值 + 疾驰二分搜索 |
| CT1 编码 | storage | 12B头 + 26B/点紧凑二进制（localStorage 兜底） |

## 16. 已知约束
- **native/web 副本已过时**：与根目录不一致（旧版仅加载合并 `gps.js`），需手工同步后才能出正确 APK。
- **GPS 丢失不做航迹推算**：IMU 仅作加速度先验注入，无 DR 状态机（设计取舍，避免漂移累积）。
- **IMU 不读陀螺仪航向**：航向完全由 GPS 权威（NMEA VTG/RMC + `coords.heading`）。
- **天气/云端为可选增强**：需自有 key，无 key 时静默隐藏，不影响主流程。
- **无自动化测试**：靠 `mock-data.js` 手动验证。
- **Chart.js / 腾讯 SDK 为同步 CDN**：离线不可用，PWA SW 不缓存 CDN。

---
> 本说明书不含任何签名文件、API Secret 或私钥明文；地图 Key 等需密钥处仅以 `{{TENCENT_MAP_KEY}}` 占位，复刻时自行申请替换。
> 适用版本线：`t=20260812v1`（gps-* / app-core / app-gps-ui）、`t=20260810v2`（app-list / app-replay / app-export / app-stats / app-weather / app-background / app-battery）。
