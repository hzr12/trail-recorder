/**
 * 优化回归测试：把所有浏览器脚本拼接为单一词法环境（模拟浏览器全局 <script> 共享作用域），
 * 并在同一环境内运行断言，避免 vm 多次 runInContext 导致 const/class 顶层声明不互通的问题。
 * 运行：node scripts/test-optimizations.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');

// ---- 最小浏览器桩 ----
function makeStubs() {
  const captured = { log: [], info: [], debug: [], warn: [], error: [] };
  const realLog = (...a) => process.stdout.write(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n');
  const fakeConsole = {
    log: (...a) => { realLog('[console.log]', ...a); captured.log.push(a); },
    info: (...a) => { realLog('[console.info]', ...a); captured.info.push(a); },
    debug: (...a) => { realLog('[console.debug]', ...a); captured.debug.push(a); },
    warn: (...a) => { realLog('[console.warn]', ...a); captured.warn.push(a); },
    error: (...a) => { realLog('[console.error]', ...a); captured.error.push(a); },
  };
  const _ls = {};
  const localStorage = {
    getItem: (k) => (k in _ls ? _ls[k] : null),
    setItem: (k, v) => { _ls[k] = String(v); },
    removeItem: (k) => { delete _ls[k]; },
    clear: () => { for (const k in _ls) delete _ls[k]; },
  };
  const document = {
    addEventListener: () => {}, removeEventListener: () => {},
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false }, appendChild() {}, setAttribute() {}, getContext: () => null }),
    body: { appendChild() {} },
  };
  const navigator = {
    geolocation: { getCurrentPosition() {}, watchPosition() { return 1; }, clearWatch() {} },
    userAgent: 'node-test',
  };
  const sandbox = {
    console: fakeConsole, document, navigator, localStorage,
    addEventListener: () => {}, removeEventListener: () => {},
    devicePixelRatio: 1, indexedDB: undefined,
    qq: undefined,
    Intl, Math, Date, JSON, Promise, Object, Array, Number, String, Boolean,
    isNaN, isFinite, parseFloat, parseInt, setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    Float64Array, Map, Set, RegExp, Error, TypeError,
  };
  // 让 window 即全局对象自身：脚本中 `window.X = ...` / `(function(global){...})(window)` 暴露的
  // 全局符号（如 PositionSmoother）才能在全局作用域被直接访问（模拟浏览器 window===全局对象）
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  return { sandbox, captured };
}

// ---- 加载顺序（严格对齐 index.html 底部 <script> 顺序）----
const LOAD_ORDER = [
  'config.js', 'toast.js', 'storage.js', 'trail.js', 'trail-analysis.js',
  'map.js', 'gps-kalman.js', 'gps-window.js', 'trail-denoise.js',
  'gps-alt.js', 'gps-imu.js', 'gps-manager.js', 'replay.js', 'app-core.js',
  'app-list.js', 'app-replay.js', 'app-export.js', 'app-stats.js',
  'app-weather.js', 'app-background.js', 'app-battery.js', 'app-gps-ui.js',
];

const { sandbox, captured } = makeStubs();
const ctx = vm.createContext(sandbox);

let bundle = '';
for (const f of LOAD_ORDER) {
  const fp = path.join(JS_DIR, f);
  if (!fs.existsSync(fp)) continue;
  bundle += `\n// ==== ${f} ====\n` + fs.readFileSync(fp, 'utf8') + '\n';
}

// ---- 测试代码（注入同一词法环境，可直接访问 CONFIG/Logger/GPSManager/formatDateTime 等）----
const testCode = `
(function(){
  let pass = 0, fail = 0; const failures = [];
  function check(name, cond, detail) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
  }
  function eq(name, a, b) { check(name, a === b, 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

  console.log('=== 1. Logger 开关行为 (2.1) ===');
  eq('CONFIG.DEBUG 默认 false', CONFIG.DEBUG, false);
  captured.log.length = 0; captured.warn.length = 0; captured.error.length = 0;
  Logger.log('x'); Logger.info('x'); Logger.debug('x');
  Logger.warn('y'); Logger.error('z');
  check('非 DEBUG 时 log/info/debug 静默', captured.log.length === 0 && captured.info.length === 0 && captured.debug.length === 0);
  check('warn 始终输出', captured.warn.length === 1 && captured.warn[0][0] === '[TraceCraft]');
  check('error 始终输出', captured.error.length === 1 && captured.error[0][0] === '[TraceCraft]');
  CONFIG.DEBUG = true; captured.log.length = 0; Logger.log('x');
  check('DEBUG=true 时 log 输出', captured.log.length === 1);
  CONFIG.DEBUG = false;

  console.log('=== 2. formatDateTime 东八区 (4.1) ===');
  const ts = Date.UTC(2026, 7, 10, 6, 30, 0);
  // 东八区应为 14:30；zh-CN 下 Intl 日期分隔符为 "/"，故 "2026/08/10 14:30"
  const s1 = formatDateTime(ts);
  check('东八区 HH:mm 正确（UTC 06:30 → 北京 14:30）', s1 === '2026/08/10 14:30', 'got ' + s1);
  const s2 = formatDateTime(ts, { withSeconds: true });
  check('东八区 带秒 正确', s2 === '2026/08/10 14:30:00', 'got ' + s2);
  const s3 = formatDateTime(ts, { shortDate: true, withSeconds: true });
  check('短日期+秒 东八区', s3.indexOf('8/10 14:30:00') !== -1, 'got ' + s3);
  eq('空时间戳返回 --', formatDateTime(0), '--');
  eq('NaN 时间戳返回 --', formatDateTime(NaN), '--');

  console.log('=== 3. calcDistance / calcBearing 手写实现 (4.2) ===');
  // 用平均地球半径（CONFIG.EARTH_RADIUS）算，赤道1°≈111195m；验证手写实现确定性、不依赖 SDK
  const d1 = calcDistance({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
  check('赤道经度差1° 手写实现确定性', Math.abs(d1 - 111195) < 2, 'got ' + d1);
  eq('同点距离0', calcDistance({ lat: 10, lng: 20 }, { lat: 10, lng: 20 }), 0);
  const bN = calcBearing({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
  check('正北方位≈0°', Math.abs(bN - 0) < 1e-6, 'got ' + bN);
  const bE = calcBearing({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
  check('正东方位≈90°', Math.abs(bE - 90) < 1e-6, 'got ' + bE);

  console.log('=== 4. setMapManager 断言 (4.3) ===');
  const gps = new GPSManager();
  let warned = false; const origWarn = Logger.warn;
  Logger.warn = () => { warned = true; };
  gps.isWatching = true; gps.setMapManager(null);
  check('晚注入触发 warn 断言', warned === true);
  Logger.warn = origWarn;
  warned = false; gps.isWatching = false; gps.setMapManager({});
  check('正常顺序不告警', warned === false && gps._mapManager !== null);

  console.log('=== 5. Storage 落盘 (3.1 依赖) ===');
  const eng = Storage._resolveEngine();
  check('Storage 引擎=localStorage（桩环境）', eng === 'localstorage', 'got ' + eng);
  let savedOk = true, savedVal = null;
  Storage.saveTrail({ id: 't1', name: '测试', positions: [{ lat: 1, lng: 2, time: Date.now(), speed: 0 }] })
    .then(() => {}).catch(e => { savedOk = false; });
  check('Storage.saveTrail 返回 Promise', typeof Storage.saveTrail({}) === 'object' && Storage.saveTrail({}).then);

  console.log('=== 6. 节流配置与源码替换校验 (3.1) ===');
  check('CONFIG.TRAIL_SAVE_THROTTLE_MS 已定义且>0',
    typeof CONFIG.TRAIL_SAVE_THROTTLE_MS === 'number' && CONFIG.TRAIL_SAVE_THROTTLE_MS > 0,
    'got ' + CONFIG.TRAIL_SAVE_THROTTLE_MS);
  const appCoreSrc = __readAppCore();
  check('_forceSaveTrail 已注入 app-core.js', appCoreSrc.includes('_forceSaveTrail()'));
  check('_saveState 使用节流常量', appCoreSrc.includes('TRAIL_SAVE_THROTTLE_MS'));
  check('构造含 _lastTrailSaveTs 字段', appCoreSrc.includes('this._lastTrailSaveTs = 0'));
  const forcedCount = (appCoreSrc.match(/this\._forceSaveTrail\(\)/g) || []).length;
  check('_forceSaveTrail 调用点≥4（pagehide/停止/恢复/undo）', forcedCount >= 4, 'count=' + forcedCount);

  console.log('=== 7. 死配置已清理 (1.3) ===');
  const configSrc = __readConfig();
  check('IMM_FILTER_ENABLED 已删除', !configSrc.includes('IMM_FILTER_ENABLED'));
  check('IMM_MODEL_Q 已删除', !configSrc.includes('IMM_MODEL_Q'));
  check('IMM_TRANSITION 已删除', !configSrc.includes('IMM_TRANSITION'));
  check('IMM_FORGET_MAX 已删除', !configSrc.includes('IMM_FORGET_MAX'));
  check('IMM_LIKELIHOOD_TEMP 已删除', !configSrc.includes('IMM_LIKELIHOOD_TEMP'));

  console.log('=== 8. Trail 采样与鬼点过滤 (运行期) ===');
  const tr = new Trail();
  tr.start();
  check('Trail 首点必入', tr.addPoint({ lat: 0, lng: 0, time: 1000, accuracy: 5, speed: 0 }) === true);
  check('Trail 1.1m 位移被拒(阈值7.5m)', tr.addPoint({ lat: 0.00001, lng: 0, time: 2000, accuracy: 5, speed: 0 }) === false);
  check('Trail 11.1m 位移接受', tr.addPoint({ lat: 0.0001, lng: 0, time: 3000, accuracy: 5, speed: 1.0 }) === true);
  eq('Trail 点数=2', tr.positions.length, 2);
  const tr2 = new Trail(); tr2.start();
  tr2.addPoint({ lat: 0, lng: 0, time: 1, accuracy: 50, speed: 0 });
  check('Trail accuracy=50 时 33m 位移被拒(阈值75m)', tr2.addPoint({ lat: 0.0003, lng: 0, time: 2, accuracy: 50, speed: 0.4 }) === false);
  const tr3 = new Trail(); tr3.start();
  tr3.addPoint({ lat: 0, lng: 0, time: 1, accuracy: 1, speed: 0 });
  check('Trail 静止漂移鬼点被拒(556m>阈20m)', tr3.addPoint({ lat: 0, lng: 0.005, time: 2, accuracy: 1, speed: 0.2 }) === false);
  tr.pause();
  check('Trail 暂停时不加点', tr.addPoint({ lat: 0.001, lng: 0, time: 4000, accuracy: 5, speed: 1 }) === false);
  tr.resume();
  check('Trail 拒绝 NaN 坐标', tr.addPoint({ lat: NaN, lng: 0, time: 5000, accuracy: 5 }) === false);
  check('Trail.getDistance 约11.1m', Math.abs(tr.getDistance() - 11.12) < 0.5, 'got ' + tr.getDistance());
  eq('Trail.getMaxSpeed=1.0', tr.getMaxSpeed(), 1.0);
  const beforeJson = JSON.stringify(tr.positions);
  tr.getSmoothedPositions(3);
  check('getSmoothedPositions 不修改原轨迹', JSON.stringify(tr.positions) === beforeJson);

  console.log('=== 9. TrailAnalysis 关键点与分段 (运行期) ===');
  const M_DEG = 111194;
  const seg = [];
  let lngAcc = 0;
  for (let i = 0; i < 12; i++) { lngAcc += 7 / M_DEG; seg.push({ lat: 0, lng: lngAcc, time: (i + 1) * 5000, speed: 1.4, accuracy: 5 }); }
  for (let i = 12; i < 24; i++) { lngAcc += 20 / M_DEG; seg.push({ lat: 0, lng: lngAcc, time: (i + 1) * 5000, speed: 4.0, accuracy: 5 }); }
  const kp = TrailAnalysis.analyzeKeyPoints(seg);
  check('关键点 start 正确', kp.start && kp.start.type === 'start' && kp.start.lng === seg[0].lng);
  check('关键点 end 指向最后点', kp.end && kp.end.lng === seg[seg.length - 1].lng);
  check('关键点 maxSpeed=4.0', kp.maxSpeed && Math.abs(kp.maxSpeed.speed - 4.0) < 0.01, 'got ' + (kp.maxSpeed && kp.maxSpeed.speed));
  const segs = TrailAnalysis.analyzeSegments(seg);
  check('分段>=2段', Array.isArray(segs) && segs.length >= 2, 'got ' + (segs && segs.length));
  check('分段含步行档 walk', segs.some(function (s) { return s.mode === 'walk'; }));
  check('分段含骑行档 bike', segs.some(function (s) { return s.mode === 'bike'; }));
  const ana = TrailAnalysis.analyze(seg);
  check('analyze 输出 keyPoints+segments', !!(ana && ana.keyPoints && Array.isArray(ana.segments)));
  const messy = [
    { lat: 0, lng: 0, time: 5000, speed: 1 },
    { lat: 0, lng: 0.0002, time: 15000, speed: 1 },
    { lat: 0, lng: 0.0001, time: 10000, speed: 1 },
    { lat: 0, lng: 0.0003, time: 20000, speed: 1 },
  ];
  const kp2 = TrailAnalysis.analyzeKeyPoints(messy);
  check('时间乱序不崩溃且有输出', !!(kp2 && kp2.start));

  console.log('=== 10. PositionSmoother 平滑与鬼点截断 (运行期) ===');
  const ps = new PositionSmoother({ win: 5, madK: 3, freezeDt: 3000, staticRatio: 1.0, enabled: true });
  const o1 = ps.push({ lat: 0, lng: 0, time: 1000, accuracy: 5 });
  check('平滑窗不足透传', o1.lat === 0 && o1.lng === 0);
  ps.push({ lat: 0.0001, lng: 0, time: 2000, accuracy: 5 });
  ps.push({ lat: 0.0002, lng: 0, time: 3000, accuracy: 5 });
  const ghost = ps.push({ lat: 0.5, lng: 0, time: 4000, accuracy: 5 });
  check('鬼点被中位数截断(输出远离0.5)', ghost.lat < 0.1, 'got lat=' + ghost.lat);
  const frozen = ps.push({ lat: 0.0003, lng: 0, time: 8000, accuracy: 5 });
  check('丢点冻结>freezeDt透传原始点', frozen.lat === 0.0003, 'got ' + frozen.lat);
  const ps2 = new PositionSmoother({ win: 5, madK: 3, enabled: true });
  ps2.push({ lat: 0, lng: 0, time: 1000, accuracy: 50 });
  ps2.push({ lat: 0, lng: 0, time: 2000, accuracy: 50 });
  const stat = ps2.push({ lat: 0.00001, lng: 0, time: 3000, accuracy: 50 });
  check('静止冻结(1.1m<50m)输出原始点', stat.lat === 0.00001, 'got ' + stat.lat);
  const psoff = new PositionSmoother({ enabled: false });
  check('enabled=false 纯透传', psoff.push({ lat: 9, lng: 9 }).lat === 9);

  console.log('=== 11. KalmanFilter 离线 RTS 平滑 (运行期) ===');
  // 注：实时单步 update() 已随实时 2D 滤波（原 IMM）一并删除，本类只保留离线 RTS 批处理
  const k = new KalmanFilter();
  // 匀速直线 11m/s 向东（0.0001° ≈ 11.1m/s）
  const track = [];
  for (let i = 0; i < 21; i++) {
    track.push({ lat: 0, lng: i * 0.0001, time: (i + 1) * 1000, accuracy: 5, speed: 11, ts: i });
  }
  const sm = k.smoothTrail(track);
  eq('RTS 输出等长', sm.length, track.length);
  eq('RTS ts 原样透传（回写轨迹的匹配 key）', sm[7].ts, 7);
  check('RTS 输出无 NaN', sm.every(function (p) { return isFinite(p.lat) && isFinite(p.lng); }));
  check('RTS 末点收敛接近真值(偏差<60m)', Math.abs(sm[20].lng - 0.002) * 111194 < 60,
    'got ' + (Math.abs(sm[20].lng - 0.002) * 111194) + 'm');
  // 第 10 点注入 555m 粗差 → RTS（双向平滑 + Huber）应显著抑制
  const noisyT = track.map(function (p, i) {
    return i === 10 ? { lat: p.lat, lng: p.lng + 0.005, time: p.time, accuracy: 5, speed: 11, ts: i } : p;
  });
  const sm2 = k.smoothTrail(noisyT);
  const jumpM = 0.005 * 111194;
  const devM = Math.abs(sm2[10].lng - 0.001) * 111194;
  check('RTS 粗差点被抑制(偏移<原始跳变一半)', devM < jumpM / 2, 'dev=' + devM + 'm, jump=' + jumpM + 'm');
  // 时间断裂（>60s）自动分段，输出仍等长且无 NaN
  const gapped = track.map(function (p, i) {
    return i < 10 ? p : { lat: p.lat, lng: p.lng, time: p.time + 120000, accuracy: 5, speed: 11, ts: i };
  });
  const sm3 = k.smoothTrail(gapped);
  eq('时间断裂(>60s)分段后仍等长', sm3.length, track.length);
  check('时间断裂段无 NaN', sm3.every(function (p) { return isFinite(p.lat) && isFinite(p.lng); }));
  // 精度失效（>2000m）自动分段
  const badAcc = track.map(function (p, i) {
    return i === 5 ? { lat: p.lat, lng: p.lng, time: p.time, accuracy: 3000, speed: 11, ts: i } : p;
  });
  const sm4 = k.smoothTrail(badAcc);
  check('精度失效点(>2000m)不炸裂', sm4.length === track.length && sm4.every(function (p) { return isFinite(p.lng); }));
  eq('空输入返回空数组', k.smoothTrail([]).length, 0);

  console.log('=== 12. TrailDenoise 跳变修复 (运行期) ===');
  const noisy = [];
  for (let i = 0; i < 8; i++) noisy.push({ lat: 0, lng: i * 0.0001, time: (i + 1) * 1000, speed: 11 });
  noisy.splice(4, 0, { lat: 0, lng: 0.02, time: 4500, speed: 11 });
  const dn = TrailDenoise.denoiseTrail(noisy);
  check('denoiseTrail 返回非空数组', Array.isArray(dn) && dn.length > 0);
  let maxLng = 0;
  for (const p of dn) if (p.lng > maxLng) maxLng = p.lng;
  check('denoiseTrail 跳变被修复(所有点<0.01°)', maxLng < 0.01, 'maxLng=' + maxLng);
  const clamped = TrailDenoise.kinematicClamp(noisy);
  check('kinematicClamp 返回非空数组', Array.isArray(clamped) && clamped.length > 0);

  console.log('=== 13. GNSS 质量评分 qualScore 非 NaN（effUsed 先读后写回归）===');
  const gps2 = new GPSManager();
  const goodSats = [];
  for (let i = 0; i < 8; i++) {
    goodSats.push({
      svid: i, constellation: i < 4 ? 'GPS' : 'BEIDOU',
      cn0DbHz: 40, usedInFix: true, elevation: 80, carrierFreqHz: 1575.42,
    });
  }
  const stGood = gps2._computeSatStats(goodSats);
  check('qualScore 是有限数（此前恒为 NaN）',
    typeof stGood.qualScore === 'number' && isFinite(stGood.qualScore), 'got ' + stGood.qualScore);
  check('qualScore 落在 [0,1]', stGood.qualScore >= 0 && stGood.qualScore <= 1, 'got ' + stGood.qualScore);
  check('effUsed 已赋值=加权有效星数', typeof stGood.effUsed === 'number' && stGood.effUsed > 0, 'got ' + stGood.effUsed);
  check('8星双星座 评分偏高(>0.5)', stGood.qualScore > 0.5, 'got ' + stGood.qualScore);
  const stWeak = gps2._computeSatStats([
    { svid: 1, constellation: 'GPS', cn0DbHz: 20, usedInFix: true, elevation: 10, carrierFreqHz: 1575.42 },
  ]);
  check('单星单星座 评分偏低(<0.5)', stWeak.qualScore < 0.5, 'got ' + stWeak.qualScore);
  check('单星场景标记 weak=true', stWeak.weak === true, 'got ' + stWeak.weak);

  console.log('=== 14. 信号丢失段与健康分（SIGNAL_LOSS_ACC_M 回归）===');
  check('CONFIG.SIGNAL_LOSS_ACC_M 已定义且>0',
    typeof CONFIG.SIGNAL_LOSS_ACC_M === 'number' && CONFIG.SIGNAL_LOSS_ACC_M > 0,
    'got ' + CONFIG.SIGNAL_LOSS_ACC_M);
  // 中段 5 个点精度劣化到 500m（远超阈值）
  const lossy = [];
  for (let i = 0; i < 10; i++) {
    lossy.push({ lat: 0, lng: i * 0.0001, time: (i + 1) * 1000, accuracy: (i >= 3 && i <= 7) ? 500 : 8, speed: 11 });
  }
  const sl = TrailAnalysis.detectSignalLoss(lossy);
  const weakSegs = sl.segments.filter(function (s) { return s.reason === 'weak'; });
  check('弱信号段被检出（此前 accLimit=undefined 恒检不出）', weakSegs.length === 1, 'got ' + weakSegs.length);
  const hh = TrailAnalysis.analyzeHealth(lossy);
  check('健康分 weakRatio>0', hh.weakRatio > 0, 'got ' + hh.weakRatio);
  check('健康分因此被扣分(<1)', hh.score < 1, 'got ' + hh.score);
  const cleanT = lossy.map(function (p) { return { lat: p.lat, lng: p.lng, time: p.time, accuracy: 8, speed: 11 }; });
  eq('全好点 weakRatio=0', TrailAnalysis.analyzeHealth(cleanT).weakRatio, 0);
  eq('全好点无丢星段', TrailAnalysis.detectSignalLoss(cleanT).segments.length, 0);

  console.log('\\n=== 结果: ' + pass + ' passed, ' + fail + ' failed ===');
  if (fail > 0) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); }
  globalThis.__result = { pass, fail, failures };
})();
`;

// 提供给测试代码读取源文件的辅助
sandbox.__readAppCore = () => fs.readFileSync(path.join(JS_DIR, 'app-core.js'), 'utf8');
sandbox.__readConfig = () => fs.readFileSync(path.join(JS_DIR, 'config.js'), 'utf8');
sandbox.captured = captured;

try {
  vm.runInContext(bundle + testCode, ctx, { filename: 'bundle+test.js' });
} catch (e) {
  console.log('运行期错误: ' + e.stack);
  process.exit(2);
}

const result = sandbox.__result || { pass: 0, fail: 0, failures: ['未产出结果'] };
process.exit(result.fail > 0 ? 1 : 0);
