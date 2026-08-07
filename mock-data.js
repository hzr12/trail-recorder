/**
 * 轨迹模拟数据生成器
 * ================================
 * 在浏览器控制台中运行此脚本，生成模拟轨迹数据用于测试
 *
 * 使用方法：
 *   1. 打开浏览器控制台 (F12)
 *   2. 粘贴此脚本内容并运行
 *   3. 选择要生成的轨迹类型
 */

// ===== 工具函数 =====

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ===== 轨迹生成器 =====

const MockTrails = {
  /**
   * 生成一条直线行走轨迹
   * @param {Object} opts
   * @param {number} opts.startLat 起点纬度
   * @param {number} opts.startLng 起点经度
   * @param {number} opts.pointCount 点数
   * @param {number} opts.durationMs 总时长（毫秒）
   * @param {number} opts.speedKmh 速度 (km/h)
   */
  straightWalk(opts = {}) {
    const startLat = opts.startLat || 23.1291;
    const startLng = opts.startLng || 113.2644;
    const pointCount = opts.pointCount || 100;
    const durationMs = opts.durationMs || 60000; // 1分钟
    const speedKmh = opts.speedKmh || 5; // 5 km/h

    const positions = [];
    const baseTime = Date.now();
    const interval = durationMs / pointCount;
    const speedMs = speedKmh / 3.6;

    // 计算每点移动距离
    const stepDistance = speedMs * interval / 1000;
    const dLat = 0; // 纯纬度方向（向北）
    const dLng = stepDistance / (111320 * Math.cos(startLat * Math.PI / 180));

    for (let i = 0; i < pointCount; i++) {
      const progress = i / pointCount;
      const jitter = (Math.random() - 0.5) * 0.00005; // GPS抖动

      positions.push({
        lat: startLat + dLat * i + jitter,
        lng: startLng + dLng * i + jitter,
        time: baseTime + i * interval,
        speed: speedMs + (Math.random() - 0.5) * 0.5,
        heading: 0,
        accuracy: 5 + Math.random() * 10
      });
    }

    return this._buildResult(positions, '直线行走');
  },

  /**
   * 生成一条圆形跑步轨迹（绕圈）
   */
  circleRun(opts = {}) {
    const centerLat = opts.centerLat || 23.1291;
    const centerLng = opts.centerLng || 113.2644;
    const radiusM = opts.radiusM || 200;
    const laps = opts.laps || 2;
    const pointCount = opts.pointCount || 200;
    const speedKmh = opts.speedKmh || 10;

    const positions = [];
    const baseTime = Date.now();
    const durationMs = opts.durationMs || 4 * 60 * 1000; // 4分钟
    const interval = durationMs / pointCount;

    for (let i = 0; i < pointCount; i++) {
      const angle = (i / pointCount) * 2 * Math.PI * laps;
      const lat = centerLat + (radiusM / 111320) * Math.cos(angle);
      const lng = centerLng + (radiusM / (111320 * Math.cos(centerLat * Math.PI / 180))) * Math.sin(angle);

      const nextAngle = ((i + 1) / pointCount) * 2 * Math.PI * laps;
      const nextLat = centerLat + (radiusM / 111320) * Math.cos(nextAngle);
      const nextLng = centerLng + (radiusM / (111320 * Math.cos(centerLat * Math.PI / 180))) * Math.sin(nextAngle);
      const heading = Math.atan2(nextLng - lng, nextLat - lat) * 180 / Math.PI;

      positions.push({
        lat,
        lng,
        time: baseTime + i * interval,
        speed: speedKmh / 3.6 + (Math.random() - 0.5) * 1,
        heading: (heading + 360) % 360,
        accuracy: 3 + Math.random() * 8
      });
    }

    return this._buildResult(positions, '圆形跑步');
  },

  /**
   * 生成一条弯曲骑行轨迹
   */
  windingCycle(opts = {}) {
    const startLat = opts.startLat || 23.1291;
    const startLng = opts.startLng || 113.2644;
    const pointCount = opts.pointCount || 150;
    const speedKmh = opts.speedKmh || 15;
    const durationMs = opts.durationMs || 10 * 60 * 1000;

    const positions = [];
    const baseTime = Date.now();
    const interval = durationMs / pointCount;

    let lat = startLat;
    let lng = startLng;
    let heading = 90; // 初始向东

    for (let i = 0; i < pointCount; i++) {
      // 随机改变方向
      heading += (Math.random() - 0.5) * 60; // ±30度变化

      const distance = (speedKmh / 3.6) * interval / 1000;
      const rad = heading * Math.PI / 180;

      lat += (distance / 111320) * Math.cos(rad);
      lng += (distance / (111320 * Math.cos(lat * Math.PI / 180))) * Math.sin(rad);

      positions.push({
        lat,
        lng,
        time: baseTime + i * interval,
        speed: speedKmh / 3.6 + (Math.random() - 0.5) * 2,
        heading,
        accuracy: 5 + Math.random() * 10
      });
    }

    return this._buildResult(positions, '弯曲骑行');
  },

  /**
   * 生成一条模拟驾驶轨迹（含加减速）
   */
  drivingCar(opts = {}) {
    const startLat = opts.startLat || 23.1291;
    const startLng = opts.startLng || 113.2644;
    const pointCount = opts.pointCount || 300;
    const durationMs = opts.durationMs || 15 * 60 * 1000;

    const positions = [];
    const baseTime = Date.now();
    const interval = durationMs / pointCount;

    let lat = startLat;
    let lng = startLng;
    let heading = 90;

    for (let i = 0; i < pointCount; i++) {
      // 模拟加减速：正弦波变化
      const speedFactor = 0.5 + 0.5 * Math.sin(i * 0.05);
      const speedKmh = 20 + speedFactor * 60; // 20-80 km/h
      const distance = (speedKmh / 3.6) * interval / 1000;

      heading += (Math.random() - 0.5) * 20;
      const rad = heading * Math.PI / 180;

      lat += (distance / 111320) * Math.cos(rad);
      lng += (distance / (111320 * Math.cos(lat * Math.PI / 180))) * Math.sin(rad);

      positions.push({
        lat,
        lng,
        time: baseTime + i * interval,
        speed: speedKmh / 3.6,
        heading,
        accuracy: 8 + Math.random() * 15
      });
    }

    return this._buildResult(positions, '模拟驾驶');
  },

  /**
   * 生成一条短距离轨迹（用于快速测试）
   */
  quickTest() {
    return this.straightWalk({
      startLat: 23.1291,
      startLng: 113.2644,
      pointCount: 30,
      durationMs: 30000,
      speedKmh: 5
    });
  },

  /**
   * 生成一条长距离轨迹（用于回放测试）
   */
  longTrail() {
    return this.drivingCar({
      startLat: 23.1291,
      startLng: 113.2644,
      pointCount: 500,
      durationMs: 30 * 60 * 1000
    });
  },

  // ===== 内部方法 =====

  _buildResult(positions, name) {
    let distance = 0;
    let maxSpeed = 0;
    let totalTime = 0;

    for (let i = 1; i < positions.length; i++) {
      distance += haversine(
        { lat: positions[i - 1].lat, lng: positions[i - 1].lng },
        { lat: positions[i].lat, lng: positions[i].lng }
      );
      if (positions[i].speed > maxSpeed) maxSpeed = positions[i].speed;
    }

    if (positions.length >= 2) {
      totalTime = positions[positions.length - 1].time - positions[0].time;
    }

    const avgSpeed = distance / Math.max(1, totalTime / 1000);

    return {
      name: name + ' ' + new Date().toLocaleTimeString(),
      positions,
      stats: {
        pointCount: positions.length,
        distance: Math.round(distance),
        distanceStr: distance >= 1000
          ? (distance / 1000).toFixed(2) + ' km'
          : Math.round(distance) + ' m',
        durationMs: totalTime,
        durationStr: this._formatDuration(totalTime),
        maxSpeedKmh: (maxSpeed * 3.6).toFixed(1),
        avgSpeedKmh: (avgSpeed * 3.6).toFixed(1)
      }
    };
  },

  _formatDuration(ms) {
    const sec = Math.floor(ms / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }
};

// ===== 注入到应用中 =====

function injectMockTrail(trailData) {
  if (typeof window.app === 'undefined') {
    console.error('错误: 应用未初始化，请等待页面加载完成');
    return false;
  }

  const app = window.app;

  // 如果正在记录，先停止
  if (app.trail.isRecording) {
    app.trail.stop();
  }

  // 加载轨迹
  app.trail.clear();
  app.trail.positions = trailData.positions.slice();
  app.trail.lastPos = trailData.positions[trailData.positions.length - 1];

  // 渲染到地图
  app.mapManager.setTrail(app._getTrailPositions());
  app._updateTrailUI();

  console.log('%c轨迹已注入!', 'color:#00D4AA;font-weight:bold');
  console.log('名称:', trailData.name);
  console.log('点数:', trailData.stats.pointCount);
  console.log('距离:', trailData.stats.distanceStr);
  console.log('时长:', trailData.stats.durationStr);
  console.log('最大速度:', trailData.stats.maxSpeedKmh, 'km/h');
  console.log('平均速度:', trailData.stats.avgSpeedKmh, 'km/h');

  return true;
}

function saveMockTrail(trailData) {
  if (typeof window.app === 'undefined') {
    console.error('错误: 应用未初始化');
    return;
  }

  const name = trailData.name || Storage._fmtTrailName(Date.now());
  Storage.saveTrailToList(trailData.positions, name).then((id) => {
    if (id) {
      console.log('%c轨迹已保存到历史!', 'color:#00D4AA;font-weight:bold');
      console.log('ID:', id);
      console.log('名称:', name);
    } else {
      console.error('保存失败');
    }
  });
}

// ===== 快捷命令 =====

const __mock = {
  // 快速注入
  quick() {
    const data = MockTrails.quickTest();
    return injectMockTrail(data);
  },

  // 直线行走
  walk(pointCount = 100) {
    const data = MockTrails.straightWalk({ pointCount });
    return injectMockTrail(data);
  },

  // 圆形跑步
  run(pointCount = 200) {
    const data = MockTrails.circleRun({ pointCount });
    return injectMockTrail(data);
  },

  // 弯曲骑行
  cycle(pointCount = 150) {
    const data = MockTrails.windingCycle({ pointCount });
    return injectMockTrail(data);
  },

  // 驾驶
  drive(pointCount = 300) {
    const data = MockTrails.drivingCar({ pointCount });
    return injectMockTrail(data);
  },

  // 注入并保存到历史
  save(type = 'quick') {
    const generators = {
      quick: MockTrails.quickTest,
      walk: () => MockTrails.straightWalk({ pointCount: 50 }),
      run: () => MockTrails.circleRun({ pointCount: 100 }),
      cycle: () => MockTrails.windingCycle({ pointCount: 80 }),
      drive: () => MockTrails.drivingCar({ pointCount: 150 }),
      long: MockTrails.longTrail
    };

    const gen = generators[type];
    if (!gen) {
      console.error('未知类型:', type, '可选: quick, walk, run, cycle, drive, long');
      return;
    }

    const data = gen();
    injectMockTrail(data);
    saveMockTrail(data);
  },

  // 批量生成多条轨迹并保存
  batch() {
    const types = ['walk', 'run', 'cycle', 'drive'];
    types.forEach((type, i) => {
      setTimeout(() => {
        const generators = {
          walk: () => MockTrails.straightWalk({ pointCount: 50 + i * 10 }),
          run: () => MockTrails.circleRun({ pointCount: 80 + i * 10 }),
          cycle: () => MockTrails.windingCycle({ pointCount: 60 + i * 10 }),
          drive: () => MockTrails.drivingCar({ pointCount: 100 + i * 20 })
        };
        const data = generators[type]();
        saveMockTrail(data);
        console.log(`%c[${i + 1}/4] ${type} 轨迹已保存`, 'color:#00D4AA');
      }, i * 500);
    });
    console.log('%c开始批量生成 4 条轨迹...', 'color:#FF9500;font-weight:bold');
  },

  // 显示帮助
  help() {
    console.log(`
%c📊 轨迹模拟数据生成器 %c

可用命令:
  __mock.quick()       快速注入短轨迹 (30点, 30秒)
  __mock.walk(n)       注入直线行走轨迹 (默认100点)
  __mock.run(n)        注入圆形跑步轨迹 (默认200点)
  __mock.cycle(n)      注入弯曲骑行轨迹 (默认150点)
  __mock.drive(n)      注入驾驶轨迹 (默认300点)
  __mock.save(type)    注入并保存到历史 (types: quick, walk, run, cycle, drive, long)
  __mock.batch()       批量生成4条轨迹并保存

示例:
  __mock.quick()       // 注入快速测试轨迹
  __mock.save('walk')  // 注入行走轨迹并保存到历史
  __mock.batch()       // 批量生成4条轨迹
    `.replace(/%c/g, ''));
  }
};

// 自动显示帮助
__mock.help();
