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
- [轨迹采样与清洗](#轨迹采样与清洗)
- [配置参数](#配置参数)
- [数据存储](#数据存储)
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

这是项目的技术核心，全部实现在 `js/gps.js`。整个定位链路分四层：

| 层 | 模块 | 说明 |
| --- | --- | --- |
| 实时水平定位 | `ImmFilter`（IMM） | 6 维状态 × 3 模型交互式多模型滤波，x/y 解耦 |
| 离线水平平滑 | `KalmanFilter`（RTS） | 独立 4 维单模型，保存前反向平滑 |
| 海拔链 | `AltKalmanFilter`/`AltFilterPipeline`/`AltRtsSmoother` | 1D 四级融合，完全独立自洽 |
| 传感器增强 | `ImuManager` + GNSS 插件 | IMU 注入/推算 + NMEA/卫星增强 |

### 实时定位：IMM 交互式多模型滤波

#### 模型选型

早期方案是**单模型自适应 Q**：一个卡尔曼滤波用速度启发式动态调过程噪声，静止时压低 q 抑漂移、移动时调高 q 跟机动。它的本质缺陷是**同一时刻只能有一个运动假设**——GPS 轨迹的典型特征（静止漂移 / 匀速巡航 / 起步刹车强机动）经常在几秒内切换，单模型只能折中，导致"跟手机动时静止段抖动、压住静止时机动段滞后"。

因此改为 **IMM（交互式多模型）**：并行跑三个运动模型，用贝叶斯框架按测量似然实时估计"当前更像哪个模型"，输出按模型概率加权混合：

| 模型 | 缩写 | 加速度过程噪声 `IMM_MODEL_Q` | 适配场景 |
| --- | --- | --- | --- |
| 静止 | STILL | 0.05 m/s²（极小） | 红灯/停留，强抑 GPS 漂移 |
| 恒速 | CV | 0.25 m/s²（中） | 骑行/行车中段，匀速跟随 |
| 恒加速 | CA | 1.0 m/s²（大） | 起步/刹车/转弯，机动跟踪 |

三个模型共用**统一 6 维状态** `[x, y, vx, vy, ax, ay]`（局部 ENU 米坐标，以参考点为原点），模型间**只差过程噪声**，切换完全由数据驱动而非手工规则。选这三个是因为它们构成覆盖 GPS 轨迹运动学的最小完备集：静止、匀速、匀加速（机动）三段覆盖全部常见行为，且转移矩阵物理可解释。

**矩阵优化**：观测只测位置（H=[1,0,0]），x/y 两轴完全解耦，每个模型轴内退化为独立的 **3×3 卡尔曼子问题**（`[x,vx,ax]` 与 `[y,vy,ay]`），避免直接做 6×6 矩阵运算；全部临时数组构造时一次性预分配（`Float64Array` 固定内存），`update()` 只读写不新建，消除高频定位下的 GC 压力。

#### IMM 单步流程（`_immStep`）

1. **转移预测概率**：`c̄ᵢ = Σⱼ Π[i][j]·μⱼ`，`Π = IMM_TRANSITION` 为马尔可夫转移矩阵（`Π[i][j] = P(下一时刻模型 i | 当前模型 j)`），构造时**列归一化**防御配置误差，保证概率结构
2. **速度辅助先验（软门控）**（`IMM_SPEED_PRIOR=true`）：纯位置观测下模型辨识依赖残差积累、切换慢；GPS 上报的 speed 是独立强信号。以 `spd` 为变量构造三个高斯峰（STILL 峰 0、CV 峰 2.5m/s、CA 峰 7m/s），`p = 1/(1+d²/σ²)`，归一化后乘性修正 `c̄`。注意：混合权重（第 3 步）用**未修正**的 `c̄Raw` 作分母，保证 `Σⱼ μⱼ|ᵢ = 1`
3. **交互混合**：混合权重 `μⱼ|ᵢ = Π[i][j]·μⱼ / c̄ᵢ`；混合状态 `x̂⁰ = Σⱼ μⱼ|ᵢ·x̂ⱼ`；混合协方差 `P⁰ = Σⱼ μⱼ|ᵢ·(Pⱼ + (x̂ⱼ−x̂⁰)(x̂ⱼ−x̂⁰)ᵀ)`（含扩散项）
4. **各模型预测**：恒加速状态转移 `F=[1,dt,½dt²; 0,1,dt; 0,0,1]`，离散白噪声加速度 Q（`q₀₀=¼q²dt⁴, q₀₁=½q²dt³, q₀₂=½q²dt², q₁₁=q²dt², q₁₂=q²dt, q₂₂=q²`）；IMU 注入时 CA 模型叠加 `G·a_imu`（见 IMU 章节）
5. **各模型更新**：`S = P⁻₀₀ + R`（标量），Huber 收缩残差，`K = P⁻/S` 更新状态与协方差（全量展开 + 对称化）
6. **对数似然**：`logΛ = −½·(eH²/S + eyH²/Sy) − ½·ln(2π√(S·Sy))`——注意用 **Huber 收缩残差**而非原始残差，否则大噪声下大 Q 模型因 S 大惩罚小、概率错误偏向 CA，把输出拉向粗差
7. **概率更新**：`μᵢ = c̄ᵢ·Λᵢ^γ / Σⱼ c̄ⱼ·Λⱼ^γ`，对数域减最大值防下溢；似然温度 `γ = IMM_LIKELIHOOD_TEMP`（2.0）放大模型间似然差异，加速强模型主导（大测量噪声下似然差异被稀释时有效补偿）；γ=1 即标准 IMM
8. **数值保护**：`IMM_MIN_PROB`（1e-6）概率下界防浮点死锁；S 非正/非有限时 `_degradeReset` 安全重置

#### 参数处理细节

**动态测量噪声 R**：`accClamped = clamp(accuracy, 1, 2000)`，`σ = clamp(accuracy, 3, 2000)`，`R = σ²`。精度差 → 测量噪声大 → 滤波更平滑；精度好 → 更跟手。

**自适应 Huber 阈值**（`_huberKFor`，实时 IMM 与离线单模型完全一致）：以 `GPS_HUBER_K`（2.0，≈2σ 截断）为基准按速度+精度双重启发式缩放，用户无需手动调参：

```
k = GPS_HUBER_K × (0.7 + 0.08 × speedFactor)     # speedFactor = clamp(speed/0.5, 1, 12)
k = k × max(0.65, 1 − 0.004 × (accClamped − 10)) # 精度差 → 阈值收紧
k = clamp(k, 1.0, 4.0)                            # 硬上下限兜底
```

- **速度启发式**：低速静止漂移压狠（k≈0.78×基准）、高速机动放宽（k≈1.66×基准），避免误伤正常机动
- **精度启发式**：精度差时标准化残差天然偏小，收紧阈值维持抑制能力（约 100m 起触底 0.65 下限）
- **实现**：残差 `|e|²/S > k²` 时收缩到 `k·√S`（平方比较避免开方）；k=0 退化为标准最小二乘

**单模型动态 Q**（`KalmanFilter.update`，RTS 前向共用）：`q = max(0.1, (0.5/accClamped) × speedFactor)`——精度好跟手、精度差平滑，速度越快机动越强。典型值：静止 q=0.1、步行 1.5m/s q=0.3、高速 40m/s q=1.2 m/s²。经参数扫描校准（5 次运行全过）：静止 RMSE 2.3–2.9m、轨迹 RMSE 3.4–3.8m（优于 1D 滤波的 3.9–4.1m）、高速重锚误差 <60m（原固定 speedFactor=3 时高速收敛慢 → 97.5m 超标）。

**保护机制**：

| 机制 | 处理逻辑 | 参数 |
| --- | --- | --- |
| 精度冻结 | `accuracy > IMM_FREEZE_ACC` 时保持上次滤波输出，只更新时间戳（防恢复时 dt 过大触发重置再跳变），原始测量仍进 `_rawFixes` 供离线 RTS 用未来数据修正 | `IMM_FREEZE_ACC`（1750m） |
| 时间重置 | `dt≤0 或 >60s` → 重置并接受测量（信号间隙后重新初始化） | — |
| 重锚 | 距参考点 >`IMM_REANCHOR_M`（3km）→ 参考点平移到当前估计位置，速度/加速度保留，**速度协方差 ×2 放大**（已移动较远说明速度可能已变，适度放大让滤波更快收敛） | `IMM_REANCHOR_M` |
| 速度限幅 | 每模型 + 混合输出双层限幅，`|v| > IMM_SPEED_LIMIT`（120m/s≈432km/h）按比例收缩，防突发漂移 | `IMM_SPEED_LIMIT` |
| 初始协方差 | 位置方差 `IMM_POS_VAR`（2500m²）、速度方差 `IMM_VEL_VAR`（0，新轨迹速度未知）、加速度方差 `IMM_ACC_VAR`（4m²/s⁴） | `IMM_*_VAR` |
| 转移矩阵防御 | `IMM_TRANSITION` 构造时校验 3×3 且列和归一（列和异常时均匀化 1/3） | `IMM_TRANSITION` |
| 似然温度 | `Λ^γ` 放大模型间差异 | `IMM_LIKELIHOOD_TEMP` |

### 离线平滑：RTS Smoother

`KalmanFilter.smoothTrail()` 对整段原始测量做**前向滤波 + 反向递推**（Rauch–Tung–Striebel），利用未来测量修正历史状态，实时滤波 RMSE 通常再降 30–40%，用于保存轨迹前的最终处理。输入输出 WGS84，内部局部米坐标运算，参考点取段首。自动分段边界：`dt≤0 || dt>60s || accuracy>2000m || 距段首>3km`，每段独立平滑后拼接（重锚/重置点即段边界）。

离线链路使用独立 4 维单模型 `KalmanFilter`（`_offlineSmoother`，状态 `[x,y,vx,vy]`），与实时 IMM 层彻底解耦、互不污染状态。海拔的 1D RTS 见下节。

### 海拔独立滤波链

海拔完全自洽，不依赖水平滤波/Huber/RTS 机制，参数全走 `ALT_*`，只消费"原始海拔 + 时间戳 + 口径来源(gga/browser)"：

- **L1 源头质量门**（`_resolveAltitude`）：GGA 椭球高（MSL+大地水准面分离，与浏览器口径一致）优先，浏览器 `coords.altitude` 兜底；**弱信号期间返回 null**（垂直精度无意义）
- **L2 自适应卡尔曼**（`AltKalmanFilter`，2 维状态 `[alt, vAlt]`）：
  - 自适应 Q：`q = min(ALT_KALMAN_Q_MAX, ALT_KALMAN_Q_BASE × (1 + |vAlt| / ALT_KALMAN_Q_REF_VEL))`——垂直速度大 → 真实动态强 → Q 线性放大（上限 8）
  - 自适应 R：`R = clamp(σ̂², ALT_KALMAN_R_MIN, ALT_KALMAN_R_MAX)`——σ̂ 为鲁棒残差尺度
  - 鲁棒尺度 σ̂：残差滑动窗口（`ALT_RESIDUAL_WINDOW`=20）MAD×1.4826（窗口 <5 保持初始 σ），下限 `√R_MIN` 防过度自信
  - 自适应 Huber：`k = ALT_HUBER_K × σ̂`（随噪声尺度缩放），残差超 k 收缩；vAlt 限幅 `ALT_VELOCITY_LIMIT`（30m/s）
- **L3 中值预滤波**（`AltFilterPipeline`）：窗口 `ALT_MEDIAN_WINDOW`（5）中值去瞬态尖刺；**口径切换**（GGA↔browser）触发清窗 + 重置卡尔曼，避免平台基准跳变；zAlt 为 null（弱信号/无源）→ 清窗重置返回 null 不内插
- **L4 离线 1D RTS**（`AltRtsSmoother`）：前向 AltKalmanFilter + 反向固定权重 `α = ALT_RTS_ALPHA_MAX`（0.3）递推 `out[i] = fwd[i]·(1−α) + out[i+1]·α`；null 点冻结不内插，保持缺口

### GNSS 原始数据增强（仅 Android）

原生 `GnssData` 插件推送卫星状态（星座/信噪比/仰角/方位角/参与解算）与 NMEA 语句，`GPSManager` 做四级增强：

- **NMEA 解析**（`_parseNmea`）：`$GPRMC`（速度/航向/定位有效/UTC）、`$GPGGA`（海拔/大地水准面分离/fix 质量）、`$GPGSA`（PDOP/HDOP/VDOP）、`$GPVTG`（地面航向/速度）。各语句带有效期窗口（`NMEA_*_MAX_AGE_MS`），过期回退浏览器 coords
- **速度解算**（`_resolveSpeed`）：VTG 优先 → RMC 交叉验证——相对偏差 >`NMEA_SPEED_CONFLICT_RATIO`(0.3) **且**绝对偏差 >`NMEA_SPEED_CONFLICT_ABS`(2m/s) 判冲突 → 冲突回退浏览器 `coords.speed`（物理测量最可信）
- **航向解算**（`_resolveHeading`）：VTG 真航向优先 → RMC 交叉验证（偏差 >`NMEA_HEADING_CONFLICT_DEG`(30°) 且速度 ≥`NMEA_HEADING_MIN_SPEED`(1m/s) 才比较，低速航向无意义）→ 浏览器兜底
- **UTC 时钟校准**（`_applyUtcOffset`）：用 RMC UTC 校准本地时钟漂移；新 RMC 相对已校准时钟超窗（`NMEA_UTC_MAX_AGE_MS`=5s）视为陈旧回灌不采纳
- **源接管**（`evaluateSource`）：`卫星数 ≥ GPS_TAKEOVER_MIN_SATS(4)` 且 `HDOP ≤ GPS_TAKEOVER_HDOP(4)`（HDOP 缺失时以 RMC 有效定位放行）且 GGA fix 有效 → 原生主导；否则浏览器顶上。切换带 `GPS_SOURCE_HOLD_MS`（5s）滞回防抖。native 档**保留高精度 watch**，仅放宽 `maximumAge` 至 `GPS_NATIVE_FALLBACK_MAX_AGE`(30s)——不做低精度，否则 Android 会退回网络定位导致坐标崩坏
- **弱信号省电**（`_evaluateWeakSignal`）：`卫星数 < GNSS_WEAK_USED_MAX(4)` 且平均信噪比 <`GNSS_WEAK_SNR_MAX`(25dB)，持续 `GNSS_WEAK_HOLD_MS`(30s) 进入弱信号档；恢复需 ≥6 颗且 ≥30dB 持续 `GNSS_RECOVER_HOLD_MS`(10s)（恢复阈值高于进入阈值 → 滞回带防边界抖动）。弱信号档定位心跳拉长至 `GPS_WEAK_SIGNAL_INTERVAL`(120s)，可选 `GPS_WEAK_SIGNAL_LOW_ACCURACY` 降精度（默认关，防失锁）；不关闭 GNSS 监听（需要它监测信号恢复）

### 自适应定位节流（`_updateAdaptiveInterval`）

百度式速度自适应——移动越快定位越密，静止 60s 心跳（长时间记录省电核心）：

```
无速度源: base = GPS_ADAPTIVE_K / 1.6      # ≈5s（按步行假设保守节流）
静止:     base = GPS_MAX_INTERVAL           # 60s
移动:     base = GPS_ADAPTIVE_K / speed     # 8000 / 速度(m/s)
interval = clamp(base, GPS_MIN_INTERVAL, GPS_MAX_INTERVAL)
省电模式: interval = max(interval, 20s)     # GPS 下限 20s
弱信号:   interval = max(interval, GPS_WEAK_SIGNAL_INTERVAL)
```

**超时看门狗**（`_startTimeoutWatch`）：当前超时阈值 `= max(降级?GPS_LOW_ACCURACY_TIMEOUT:GPS_WATCH_TIMEOUT, 当前节流间隔+5s)`（对齐自适应间隔，避免 Android duty-cycle 下正常慢 fix 被误判超时）；连续 `GPS_TIMEOUT_MAX_FAILURES`(5) 次超时 → `_downgrade()` 降级。每次超时检查还会调用 `_tryEnterDeadReckoningFromTimeout` 尝试 IMU 推算兜底。

### IMU 惯性导航（阶段二/三，仅 Android）

原生 `ImuData` 插件 25Hz 采集线性加速度（已去重力）+ 陀螺仪 + 姿态四元数：

- **姿态旋转**（`_rotateAccToEnu`）：设备系 → ENU 地理系，Rodrigues 公式四元数旋转，与 IMM 局部米坐标天然对齐（x 东 / y 北）；旧机型无 `ROTATION_VECTOR`（rotation 空/非法）→ 返回 null，上层安全退化
- **按需聚合**：1s 窗口均值（`IMU_FEED_INTERVAL_MS`=1000，与 GPS 秒级步长对齐）→ 一阶低通 `IMU_ACC_LPF_ALPHA`（0.4，抑制窗口间跳变；0=直接用均值，1=全信最新均值）
- **阶段二 注入**（`feedImu`）：仅注入 **CA 模型**（STILL/CV 不注入——低速/匀速下 IMU 噪声会被放大成虚假机动）。`x⁻ = F·x̂ + G·a_imu`（`G=[½dt², dt, 1]ᵀ`），强度缩放 `IMU_ACC_TRUST`(0.6)，幅值限幅 `IMU_ACC_CLAMP`(30m/s² 防传感器粗差拖垮预测)，CA 过程噪声同步缩小 `qScale = max(0.3, 1−0.7×trust)`（运动已由输入描述，防过度自信）。只做运动学先验，GPS 仍是位置权威
- **阶段三 航迹推算**（`predictOnly`）：GPS 丢失时切高频（`setHighFrequency(true)`），每 1s 聚合窗口走**完整 IMM 预测**（交互混合 + 各模型独立 CA 预测 + IMU 注入，概率由速度先验重算而非冻结），预测协方差写回保证恢复后 `update()` 可直接接续
  - **触发**（`_maybeEnterDeadReckoning`）：`accuracy > IMU_ACC_FREEZE`(600m，早于滤波冻结线提前介入) 且（无 GNSS 或参与卫星 <`IMU_SAT_MIN`(4)）且 fix 数 ≥`IMU_MIN_FIXES`(3)（确保有初速）；省电模式不触发
  - **watch 断流兜底**：`_tryEnterDeadReckoningFromTimeout` 由超时看门狗触发（GPS 彻底断信号时位置回调失去执行入口，参考点取最近一次可信 fix）
  - **推进**（`_advanceDeadReckoning`）：推算坐标走独立 `onDeadReckonPosition` 通知（`accuracy=null` 隐藏精度圆、速度不对外发布、**不写轨迹**——纯积分漂移不可信）
  - **上限**：`IMU_DEAD_RECKON_MAX_MS`（15s，纯积分漂移物理上限，超出强制回冻结；15s 内零偏 0.03 情形误差约 3.4m）
  - **退出**（`_exitDeadReckoning`）：GPS 恢复（`accuracy < IMU_RECOVER_ACC`(100m) 且卫星 ≥`IMU_RECOVER_SAT`(6)，滞回高于触发阈值）→ 一次 GPS fix 重锚无缝接回

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

## 轨迹采样与清洗

记录与保存时的数据质量控制，实现在 `js/trail.js`（实时采样）与 `js/trail-analysis.js`（离线清洗，纯函数不修改原数组）。

### 实时采样（`Trail.addPoint`）

每个定位点按「固定最小间距 + 精度联动抖动阈值」双重判定是否采样入轨迹：

```
jitterThreshold = max(TRAIL_SAMPLE_MIN_DIST, TRAIL_JITTER_FACTOR × accuracy)
位移 ≤ jitterThreshold → 丢弃
```

- `TRAIL_SAMPLE_MIN_DIST`（5m）：固定最小采样间距
- `TRAIL_JITTER_FACTOR`（1.5）：精度联动——精度差时阈值自动放大，避免站定时抖动点入轨

**静止漂移鬼点过滤**：GPS 上报速度 < `TRAIL_STATIONARY_SPEED`（0.3m/s≈1km/h）视为静止，但位移却超过抖动阈值 **4 倍** → 判为静止漂移鬼点直接丢弃（避免轨迹出现"分叉尾巴"）。

**点数上限**：`TRAIL_MAX_POINTS`（30 万），超出裁掉最早点（保留尾部最新），并重建最高速统计保证实时卡读数准确。

### 离线清洗（保存 / 绘图前）

**起终点裁剪**（`trimEndpoints`）：起点向后 / 终点向前连续扫描，遇「速度 ≥ 静止阈值」或「累计位移 ≥ 阈值」即停。`TRAIL_CLEAN_START_M` / `TRAIL_CLEAN_END_M`（各 30m）为最大可裁剪累计位移——只裁静止漂移尾巴，不动真实轨迹。

**异常点过滤**（`filterOutliers`）：对每个内部点，若它相对**前一点和后一点**的位移都超过阈值，判为 GPS 跳变/漂移点剔除（必须前后**都**超才剔除，避免误杀高速真实拐点）：

```
maxJump = 参考速度 × dt × TRAIL_CLEAN_MAX_JUMP_FACTOR(5) + 基础阈值(10m)
```

- 参考速度取段上两点中后一点优先，缺速度时由基础阈值兜底
- `base = TRAIL_SAMPLE_MIN_DIST × 2`（10m）
- 时间缺失/无效时保守跳过；结果至少保留 2 点防过度清洗

### 自动暂停（记录页开关，默认关）

静止持续 `AUTO_PAUSE_WINDOW_S`（10s）且速度 < `AUTO_PAUSE_SPEED`（0.5m/s）→ 自动暂停计时；速度 > `AUTO_PAUSE_RESUME_SPEED`（1.2m/s）→ 自动恢复。恢复阈值高于暂停阈值形成滞回，避免边界抖动反复启停。

### 速度等级分段（`TrailAnalysis.analyzeSegments`）

按 `CONFIG.TRAIL_SPEED_LEVELS` 七档速度等级连续切段，带三重防抖：

- `TRAIL_SEGMENT_MIN_POINTS`（3）：连续 N 个点同等级才切段
- `TRAIL_SEGMENT_MIN_DIST`（60m）：段最短距离，过短并入相邻段
- `TRAIL_SEGMENT_MIN_MS`（10s）：段最短时长，过短并入相邻段

分段结果同时供地图着色与回放分段使用，速度等级表是**单一数据源**。

---

## 配置参数

所有可调参数集中在 `js/config.js` 的 `CONFIG`，主要包括：

| 分组 | 关键参数 |
| --- | --- |
| 地图 | `MAP_KEY`、`DEFAULT_CENTER`、`DEFAULT_ZOOM`、`LOCATION_ZOOM` |
| GPS 基础 | `GPS_TIMEOUT`、`GPS_WATCH_TIMEOUT`、`GPS_TIMEOUT_MAX_FAILURES`、自适应节流 `GPS_ADAPTIVE_K`/`GPS_MIN_INTERVAL`/`GPS_MAX_INTERVAL` |
| 轨迹采样 | `TRAIL_SAMPLE_MIN_DIST`、`TRAIL_JITTER_FACTOR`、`TRAIL_STATIONARY_SPEED`、`TRAIL_MAX_POINTS`（处理逻辑见[轨迹采样与清洗](#轨迹采样与清洗)） |
| 轨迹清洗 | `TRAIL_CLEAN_START_M`/`TRAIL_CLEAN_END_M`/`TRAIL_CLEAN_MAX_JUMP_FACTOR`（见[轨迹采样与清洗](#轨迹采样与清洗)） |
| 自动暂停 | `AUTO_PAUSE_WINDOW_S`/`AUTO_PAUSE_SPEED`/`AUTO_PAUSE_RESUME_SPEED`（见[轨迹采样与清洗](#轨迹采样与清洗)） |
| 视觉抽稀 | `TRAIL_DECIMATE_MIN_ZOOM_LIMIT`/`MAX_ZOOM_LIMIT`/`ZOOM_BASE`（轨迹线随 zoom 抽稀）、`REPLAY_DECIMATE_MAX_POINTS`（回放 4000 点上限）、`THUMB_DECIMATE_MAX_POINTS`（缩略图 6000 点上限）、`REPLAY_START_DELAY` |
| 分段/关键点 | `TRAIL_SEGMENT_MIN_POINTS`/`MIN_DIST`/`MIN_MS`、`TRAIL_SPEED_LEVELS` |
| IMM 滤波 | `IMM_*` 全部参数（见上文算法章节） |
| GNSS 弱信号 | `GNSS_WEAK_USED_MAX`/`GNSS_WEAK_SNR_MAX`/`GNSS_RECOVER_*`（滞回）/`GPS_WEAK_SIGNAL_INTERVAL` |
| NMEA | `NMEA_*_MAX_AGE_MS`、`NMEA_SPEED_CONFLICT_*`、`NMEA_HEADING_CONFLICT_DEG`、`NMEA_COORD_CONFLICT_*` |
| IMU | `IMU_*`（开关、注入间隔、聚合低通、推算阈值与上限） |
| 海拔 | `ALT_*`（卡尔曼 R/Q 范围、Huber、速度上限、RTS 权重） |
| 存储 | `TRAIL_STORAGE_ENGINE`、`DB_NAME`/`DB_VERSION`/`DB_MAX_SIZE`、`LS_MAX_SIZE` |
| 后台定位 | `BG_LOCATE_INTERVAL_NORMAL`/`POWER_SAVE`、`NATIVE_BG_MIN_INTERVAL` |

---

## 数据存储

数据全部存储于浏览器本地，由 `js/storage.js` 的 `Storage` 类统一管理。存储引擎通过 `CONFIG.TRAIL_STORAGE_ENGINE`（默认 `'auto'`）选择：**IndexedDB 可用则优先 IndexedDB，否则回退 localStorage**，任一侧写入失败会自动降级到另一侧（`_fallbackAttempted` 防重复切换）。

### IndexedDB（数据库 `trailcraft_db`，版本 v2）

| Store | 内容 |
| --- | --- |
| `trail` | 完整轨迹数据（含全量 `positions`）。两类记录：<br>• **当前会话轨迹**：`id = 'current'`，字段 `positions` / `updatedAt` / `pointCount` / `sizeBytes` / `isRecording` / `isPaused`<br>• **历史轨迹**：`id = 'list_<时间戳>'`，字段 `positions` 全量 + `name` / `createdAt` / `updatedAt` / `distance` / `duration` / `pointCount` / `favorite` / `cleaned`<br>索引：`updatedAt` |
| `trail_meta` | 历史轨迹的**纯元数据**（v2 新增，**不包含大 positions**，列表只读时免反序列化）：`id = 'list_<时间戳>'` + `name` / `createdAt` / `updatedAt` / `distance` / `duration` / `pointCount` / `favorite` / `cleaned`<br>索引：`updatedAt`（列表按此索引倒序读取，免内存排序） |

写入历史轨迹时 **trail 与 meta 双写**；重命名 / 切换收藏 / 清洗更新时同步两份。v1 旧库会在首次加载时经 `_loadTrailListFromTrail` 懒迁移补齐 meta store（`trailcraft_meta_migrated_v2` 标记）。

### localStorage

| Key | 内容 |
| --- | --- |
| `trailcraft_trail` | 当前会话轨迹的**二进制编码字符串**（仅当引擎为 localStorage 时使用）。头部 12 字节：magic `CT1` + 版本号 + 基准时间（Float64 毫秒）；每点 26 字节：`lat` 8B / `lng` 8B / `time`（相对基准毫秒，uint32）4B / `speed`（×100，uint16）2B / `heading`（×100，uint16）2B / `accuracy`（uint16）2B |
| `trailcraft_trail_meta` | 当前会话轨迹的 meta JSON：`isRecording` / `isPaused` / `updatedAt` |
| `trailcraft_emergency` | **紧急快照**：页面被强杀时 IndexedDB 异步写可能丢失，用 localStorage 同步兜底。内容 `positions` + `isRecording` / `isPaused` / `ts`。恢复时仅当快照时间戳比 IndexedDB 数据更新才采用，读后即删 |
| `trailcraft_theme` | 主题偏好 `'dark'` / `'light'` |
| `trailcraft_trail_smooth` | 轨迹平滑开关 `'1'` / `'0'` |
| `trailcraft_autopause` | 自动暂停开关 `'1'` / `'0'`（key 由 `CONFIG.AUTO_PAUSE_STORAGE_KEY` 定义） |
| `trailcraft_meta_migrated_v2` | IndexedDB meta 迁移完成标记 `'1'` |

> `CONFIG.STORAGE_KEY`（`'trailcraft_data'`）为历史遗留常量，当前代码未使用。

### 容量与降级策略

- IndexedDB 配额：`DB_MAX_SIZE` = 200MB；localStorage 配额：`LS_MAX_SIZE` = 5MB（`_getMaxSize()` 按引擎取值）
- 超配额时自动**抽稀降点**（`_estimateSize` 估算后按比例隔点采样，最少保留 10 点）
- 引擎失败自动**互降**：IndexedDB 写失败 → 降级 localStorage；localStorage 配额超限 → 回退 IndexedDB（仅在 `'auto'` 模式下生效）
- 首次使用 IndexedDB 时会执行 `_migrateFromLocalStorage`，把旧 localStorage 里的当前轨迹迁入并清理

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
浏览器端数据全部本地存储：完整轨迹进 IndexedDB（`trailcraft_db` 的 `trail`/`trail_meta` store），主题、开关偏好与紧急快照等小数据进 localStorage。详见[数据存储](#数据存储)。清除站点数据会删除全部历史轨迹。

---

## 许可证

[MIT](LICENSE) © 2026 hzr12
