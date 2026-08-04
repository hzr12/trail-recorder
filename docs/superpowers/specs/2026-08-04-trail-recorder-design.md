# Trail Recorder — 设计规格文档

> 从 circlemap-gnss 项目提取轨迹记录模块，构建独立 App。
> 专注 GPS 轨迹录制、多轨迹历史管理、统计导出，支持 Web 和 Android。

**日期：** 2026-08-04
**状态：** 设计中

---

## 1. 目标与范围

### 1.1 核心目标
- 提供独立的 GPS 轨迹记录应用
- 支持多条轨迹历史管理
- 起点/终点自动标注（增强标注）
- 统计分析与报告导出
- Web 浏览器 + Android APK 双平台

### 1.2 范围外功能（不实现）
- 同心圆绘制与编辑
- 多人房间/MQTT
- 天气查询
- 坐标输入/手动定位
- 路径预测

---

## 2. 数据模型

### 2.1 轨迹点（Trail Point）
```js
{
  lat: number,        // GCJ-02 纬度
  lng: number,        // GCJ-02 经度
  time: number,       // 毫秒时间戳
  accuracy: number,   // GPS 精度（米）
  speed: number | null,
  heading: number | null,
}
```

### 2.2 轨迹记录（Trail Record）
```js
{
  id: string,               // 唯一 ID，格式: trail_YYYYMMDD_HHmmss
  name: string,             // 用户自定义名称，默认 "未命名"
  positions: TrailPoint[],  // 轨迹点数组
  startPoint: TrailPoint,   // 起点（录制开始时自动记录）
  endPoint: TrailPoint | null, // 终点（停止时自动记录）
  createdAt: number,
  updatedAt: number,
  annotations: [],          // 自定义标注点（预留）
}
```

---

## 3. 模块架构

### 3.1 文件结构
```
F:\project\trail-recorder\
│
├── index.html                 # 入口，零构建
├── css/
│   ├── theme.css              # CSS 变量：主题色、深色/浅色
│   ├── base.css               # 重置、基础布局
│   ├── map.css                # 地图全屏 + Canvas 叠加层
│   ├── trail.css              # 录制控制、按钮、状态条
│   ├── history.css            # 历史轨迹列表
│   ├── stats.css              # 统计弹窗、速度直方图
│   └── responsive.css         # 移动端断点
│
├── js/
│   ├── config.js              # 配置常量（拷贝自原项目，精简）
│   ├── toast.js               # Toast 提示（拷贝，微调）
│   ├── storage.js             # 多轨迹 IndexedDB 持久化
│   ├── trail.js               # Trail 类（拷贝+扩展标注字段）
│   ├── gps.js                 # GPSManager + KalmanFilter（拷贝）
│   ├── map.js                 # MapManager（拷贝，移除圆圈逻辑）
│   ├── trail-app.js           # App 主类（全新）
│   └── trail-ui.js            # UI 渲染（全新）
│
└── native/                    # Capacitor Android
    ├── capacitor.config.json
    ├── package.json
    ├── gnss-plugin/           # 复制原项目 gnss-plugin
    ├── web/                   # 构建输出目录
    └── android/               # 由 npx cap add android 生成
```

### 3.2 模块职责

| 模块 | 来源 | 改动 | 职责 |
|------|------|------|------|
| `config.js` | 拷贝 | 删除圆圈/房间常量 | GPS、轨迹、存储参数 |
| `toast.js` | 拷贝 | 移除 App 依赖 | Toast 提示 |
| `storage.js` | 重写 | 改为多轨迹 | IndexedDB 存多条轨迹，保留 CT1 编码 |
| `trail.js` | 拷贝+扩展 | 新增 startPoint/endPoint | 轨迹点管理、采样、距离、平滑 |
| `gps.js` | 拷贝 | 移除 GNSS 强依赖 | GPS 定位、Kalman 滤波、自适应节流 |
| `map.js` | 拷贝+精简 | 移除圆圈绘制 | 腾讯地图 + Canvas 轨迹叠加层 |
| `trail-app.js` | 全新 | — | 录制状态机、历史管理、统计导出 |
| `trail-ui.js` | 全新 | — | 所有 DOM 渲染与事件绑定 |

---

## 4. 核心功能

### 4.1 GPS 追踪
- 浏览器 Geolocation API + Kalman 滤波
- 速度自适应节流：间隔 = 8000 / 速度（clamp 0.5s~60s）
- 省电模式：间隔下限 20s
- 后台定位：pagehide 后 15s 单次定位轮询
- 精度降级：连续 5 次超时后切换低精度模式

### 4.2 轨迹录制
- 开始：清空当前轨迹，记录起点（自动），启动 GPS
- 暂停：保留轨迹，暂停添加新点
- 继续：重置 lastPos，恢复添加
- 停止：记录终点（自动），保存轨迹，停止 GPS
- 采样：最小间距 5m，抖动过滤（accuracy × 1.5 阈值）
- 上限：150,000 点

### 4.3 轨迹历史管理
- IndexedDB `trails` store，keyPath: `id`
- 按 `updatedAt` 倒序展示
- 每条显示：名称、距离、时长、时间
- 支持：查看、重命名、删除（带撤销 Toast）

### 4.4 起点/终点标注
- 起点：`trail.start()` 时自动记录第一个有效点
- 终点：`trail.stop()` 时自动记录最后一个点
- 地图上用绿色圆点标记起点，红色圆点标记终点

### 4.5 统计面板
- 总距离、总时长、平均速度、最高速度、轨迹点数
- 开始/结束时间
- 速度分布直方图（7 档）

### 4.6 速度曲线
- Chart.js 实时曲线，录制中显示

### 4.7 报告导出
- Canvas 合成 PNG：轨迹地图 + 速度曲线 + 统计卡片
- Web：自动下载 PNG；Android：调用 Share 插件

---

## 5. UI 设计

### 5.1 布局（全屏地图 + 底部面板）

```
┌────────────────────────────┐
│     腾讯地图（全屏）         │
│   Canvas 叠加层：轨迹线     │
│   起点绿点 / 终点红点       │
│                            │
│   [GPS FAB 按钮]  (右上)   │
├────────────────────────────┤
│ ◉ 记录中  1.23km  [暂停]   │  ← 录制状态条
├────────────────────────────┤
│ 轨迹记录                    │
│ [开始记录]                  │
│ 距离 1.23km  时长 00:12:34 │
│ [暂停] [清除] [统计] [导出] │
│ [平滑] [省电]               │
├────────────────────────────┤
│ 历史轨迹                    │
│ ● 晨跑  1.23km  08:30       │
│ ● 夜跑  3.45km  昨天 21:15  │
├────────────────────────────┤
│ 定位间隔: 2.3s  [电池 87%]  │
└────────────────────────────┘
```

### 5.2 主题
- 深色（默认）/ 浅色一键切换
- 5 种主色：青 / 绿 / 蓝 / 紫 / 橙
- CSS 变量驱动

---

## 6. 持久化方案

### 6.1 IndexedDB 设计
```
DB: trailrecorder_db
Store: trails (keyPath: 'id')
Index: updatedAt（非唯一，用于排序）
```

### 6.2 轨迹点编码
- 复用原项目 CT1 二进制格式（26 字节/点）
- 单条轨迹 < 4MB 时存 JSON，超大轨迹自动抽稀后存 CT1
- 元数据（录制状态）单独存 localStorage

### 6.3 数据迁移
- 首次启动检测旧 localStorage key `circlemap_trail`
- 如有数据，自动迁移为一条历史轨迹

---

## 7. Android 打包

### 7.1 Capacitor 配置
```json
{
  "appId": "com.trailrecorder.app",
  "appName": "TrailRecorder",
  "webDir": "web",
  "server": { "androidScheme": "https", "androidUseLegacyBridge": true },
  "plugins": {
    "GnssData": {},
    "Filesystem": {},
    "Share": {},
    "BackgroundGeolocation": {}
  }
}
```

### 7.2 原生插件
- `gnss-plugin`：复制原项目 `native/gnss-plugin/`
- `@capgo/background-geolocation`：后台定位
- `@capacitor/filesystem` + `@capacitor/share`：导出分享

---

## 8. 技术约束

- 零构建工具，浏览器直接打开 `index.html`
- 纯 ES6 Class，零框架依赖
- 中文注释 + 中文 UI
- localStorage key：`trailrecorder_*`（不与原项目冲突）
- IndexedDB：`trailrecorder_db`
- 腾讯地图 API key：沿用原项目 key
- CDN：腾讯地图 SDK、Chart.js 4
