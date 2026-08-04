# Trail Recorder

轻量级轨迹记录APP，基于浏览器 Geolocation API 和 Leaflet + OpenStreetMap 实现。

## 功能特性

- **GPS 定位** - 支持单次定位和持续追踪
- **轨迹记录** - 开始/暂停/停止记录，带抖动过滤
- **轨迹可视化** - 按速度着色的轨迹线，支持平滑处理
- **实时统计** - 距离、时长、速度、海拔爬升等
- **速度曲线** - 实时绘制速度-时间曲线
- **省电模式** - 降低 GPS 频率，延长电池续航
- **数据持久化** - 支持 IndexedDB 和 localStorage 自动切换
- **主题切换** - 深色/浅色主题

## 使用方法

### 直接打开

双击 `index.html` 即可在浏览器中运行。

### 本地服务器

```bash
# Python 3
python -m http.server 8080

# Node.js
npx serve .

# 然后访问 http://localhost:8080
```

## 技术栈

- **前端框架**: 原生 JavaScript (ES6+)
- **地图**: Leaflet + OpenStreetMap
- **图表**: Chart.js
- **定位**: 浏览器 Geolocation API
- **数据存储**: IndexedDB / localStorage

## 项目结构

```
trail-recorder/
├── index.html          # 主页面
├── favicon.svg         # 网站图标
├── js/
│   ├── config.js       # 配置和工具函数
│   ├── trail.js        # 轨迹数据管理
│   ├── gps.js          # GPS 定位管理（含卡尔曼滤波）
│   ├── storage.js      # 数据持久化
│   ├── map.js          # 地图管理
│   ├── toast.js        # 提示组件
│   └── app.js          # 主应用控制器
└── css/
    ├── theme.css       # 主题变量
    ├── base.css        # 基础样式
    ├── map.css         # 地图样式
    ├── controls.css    # 控件样式
    └── responsive.css  # 响应式样式
```

## 注意事项

1. 需要 HTTPS 或 localhost 环境才能使用 Geolocation API
2. 首次使用需要授权位置访问权限
3. 室内或 GPS 信号弱的环境可能影响定位精度
4. 长时间记录建议开启省电模式

## 许可证

MIT License
