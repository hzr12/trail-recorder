/**
 * 临时诊断脚本：量化「保存时 RTS 平滑 vs 原始轨迹」的质量差异
 * 复刻 smoothTrailRts3d 水平链：denoiseTrail → KalmanFilter.smoothTrail → kinematicClamp
 * 用后即删。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..');
const files = ['js/config.js', 'js/gps-kalman.js', 'js/trail-denoise.js'];
let bundle = '';
for (const f of files) bundle += fs.readFileSync(path.join(root, f), 'utf8') + '\n';
bundle += '\nglobalThis.__X = { KalmanFilter, TrailDenoise: globalThis.TrailDenoise, CONFIG: globalThis.CONFIG, calcDistance: globalThis.calcDistance };';
vm.runInThisContext(bundle, { filename: 'bundle.js' });
const { KalmanFilter, TrailDenoise, CONFIG } = globalThis.__X;

// ── 合成真值轨迹（局部米坐标）：直行30步 → 90°弯3步 → 直行30步 → 停20步 → 直行30步 ──
// 步行 1.5 m/s，dt = 1s
function buildTruth() {
  const pts = []; // {x, y, phase}  phase: 'straight'|'turn'|'stop'
  let x = 0, y = 0;
  const v = 1.5, dt = 1;
  for (let i = 0; i < 30; i++) { pts.push({ x, y, phase: 'straight1' }); x += v * dt; }
  // 90° 弯：3 步内转向（每步转 30°）
  let heading = 0;
  for (let i = 0; i < 3; i++) {
    heading += Math.PI / 6;
    x += v * dt * Math.cos(heading); y += v * dt * Math.sin(heading);
    pts.push({ x, y, phase: 'turn' });
  }
  for (let i = 0; i < 30; i++) { x += v * dt * Math.cos(heading); y += v * dt * Math.sin(heading); pts.push({ x, y, phase: 'straight2' }); }
  for (let i = 0; i < 20; i++) { pts.push({ x, y, phase: 'stop' }); }
  for (let i = 0; i < 30; i++) { x += v * dt * Math.cos(heading); y += v * dt * Math.sin(heading); pts.push({ x, y, phase: 'straight3' }); }
  return pts;
}

// 确定性伪随机（可复现）
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rnd) {
  const u = Math.max(rnd(), 1e-9), w = Math.max(rnd(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
}

// 真值 → 加噪 GPS fix（GCJ02 空间用假想纬度 30° 近似）
const REF_LAT = 30, MPD = 111111, COS = Math.cos(REF_LAT * Math.PI / 180);
function truthToNoisyFixes(truth, noiseSigma, acc, seed) {
  const rnd = mulberry32(seed);
  const t0 = 1757000000000;
  return truth.map((p, i) => {
    const lat = REF_LAT + (p.y + gauss(rnd) * noiseSigma) / MPD;
    const lng = (p.x + gauss(rnd) * noiseSigma) / (MPD * COS);
    return {
      lat, lng,
      time: t0 + i * 1000,
      ts: t0 + i * 1000,
      accuracy: acc,
      speed: p.phase === 'stop' ? 0.1 : 1.5
    };
  });
}

function fixesToMeters(fixes) {
  return fixes.map(f => ({
    x: f.lng * MPD * COS,
    y: (f.lat - REF_LAT) * MPD
  }));
}

// ── 完整管线（复刻 smoothTrailRts3d 水平部分）──
function pipeline(fixes) {
  let clean = TrailDenoise.denoiseTrail(fixes);
  // 注意：denoiseTrail 首尾可能裁剪，这里 ts 匹配不受影响（合成数据无跳变）
  const kf = new KalmanFilter();
  let smooth = kf.smoothTrail(clean);
  smooth = TrailDenoise.kinematicClamp(smooth);
  return smooth;
}

// 点到真值轨迹的最小距离（米）
function distToTruth(p, truth) {
  let best = Infinity;
  for (const t of truth) {
    const d = Math.hypot(p.x - t.x, p.y - t.y);
    if (d < best) best = d;
  }
  return best;
}

function run(label, noiseSigma, acc, seed) {
  const truth = buildTruth();
  const fixes = truthToNoisyFixes(truth, noiseSigma, acc, seed);
  const raw = fixesToMeters(fixes);
  const smoothM = fixesToMeters(pipeline(fixes));

  // 索引对齐：denoise 不裁剪时等长
  const n = Math.min(truth.length, smoothM.length);

  // 1) 弯道切角：phase==='turn' 的 3 点 + 前后各 1 点
  const turnIdx = [];
  for (let i = 0; i < n; i++) if (truth[i].phase === 'turn') turnIdx.push(i);
  let rawTurn = 0, smTurn = 0;
  for (const i of turnIdx) {
    rawTurn += distToTruth(raw[i], [truth[i]]);
    smTurn += distToTruth(smoothM[i], [truth[i]]);
  }
  rawTurn /= turnIdx.length; smTurn /= turnIdx.length;

  // 2) 停顿段：位置散布（std）+ 停顿结束前拖尾（输出速度>0.3 的步数）
  const stopIdx = [];
  for (let i = 0; i < n; i++) if (truth[i].phase === 'stop') stopIdx.push(i);
  const stopMid = stopIdx.slice(3, -3); // 去掉停顿首尾过渡
  let meanX = 0, meanY = 0;
  for (const i of stopMid) { meanX += smoothM[i].x; meanY += smoothM[i].y; }
  meanX /= stopMid.length; meanY /= stopMid.length;
  let spread = 0, rawSpread = 0;
  for (const i of stopMid) {
    spread += Math.hypot(smoothM[i].x - meanX, smoothM[i].y - meanY);
    rawSpread += Math.hypot(raw[i].x - meanX, raw[i].y - meanY);
  }
  spread = spread / stopMid.length; rawSpread = rawSpread / stopMid.length;
  // 拖尾：停顿段内相邻输出步速度 > 0.3 m/s 的前 5 步计数
  let tail = 0;
  for (let k = 1; k < Math.min(6, stopIdx.length); k++) {
    const i = stopIdx[k];
    const v = Math.hypot(smoothM[i].x - smoothM[i - 1].x, smoothM[i].y - smoothM[i - 1].y);
    if (v > 0.3) tail++;
  }
  // 拖尾空间量级：停入点（停顿首步真值）之后 5 步内输出偏离该点的最大距离（米）
  const stopEntry = truth[stopIdx[0]];
  let overshoot = 0;
  for (let k = 1; k < Math.min(6, stopIdx.length); k++) {
    const i = stopIdx[k];
    const d = Math.hypot(smoothM[i].x - stopEntry.x, smoothM[i].y - stopEntry.y);
    if (d > overshoot) overshoot = d;
  }

  // 3) 端点偏差：首末点相对真值
  const e0s = distToTruth(smoothM[0], [truth[0]]);
  const e0r = distToTruth(raw[0], [truth[0]]);
  const eNs = distToTruth(smoothM[n - 1], [truth[n - 1]]);
  const eNr = distToTruth(raw[n - 1], [truth[n - 1]]);

  // 4) 整体 RMSE（对齐同相位点）
  let seRaw = 0, seSm = 0;
  for (let i = 0; i < n; i++) {
    seRaw += (raw[i].x - truth[i].x) ** 2 + (raw[i].y - truth[i].y) ** 2;
    seSm += (smoothM[i].x - truth[i].x) ** 2 + (smoothM[i].y - truth[i].y) ** 2;
  }
  const rmseRaw = Math.sqrt(seRaw / n), rmseSm = Math.sqrt(seSm / n);

  console.log(`\n=== ${label}（noise σ=${noiseSigma}m, accuracy=${acc}m, n=${n}）===`);
  console.log(`弯道切角(均值偏差m):  raw=${rawTurn.toFixed(2)}  smooth=${smTurn.toFixed(2)}  ${smTurn > rawTurn ? '⚠️ 平滑更差' : 'ok'}`);
  console.log(`停顿段散布(std m):    raw=${rawSpread.toFixed(2)}  smooth=${spread.toFixed(2)}`);
  console.log(`停顿拖尾(前5步超速):  ${tail}/5  超越量=${overshoot.toFixed(2)}m`);
  console.log(`首点偏差(m):          raw=${e0r.toFixed(2)}  smooth=${e0s.toFixed(2)}  ${e0s > e0r * 1.5 ? '⚠️' : 'ok'}`);
  console.log(`末点偏差(m):          raw=${eNr.toFixed(2)}  smooth=${eNs.toFixed(2)}  ${eNs > eNr * 1.5 ? '⚠️' : 'ok'}`);
  console.log(`整体RMSE(m):          raw=${rmseRaw.toFixed(2)}  smooth=${rmseSm.toFixed(2)}  ${rmseSm < rmseRaw ? '平滑整体更优' : '⚠️ 平滑整体更差'}`);
}

// 场景：步行 + 典型精度；步行 + 高精度（原生 GNSS）；骑行速度场景
run('步行·acc=5m', 3, 5, 42);
run('步行·acc=2m(原生高精度)', 1.5, 2, 42);
run('步行·acc=15m(弱信号)', 5, 15, 42);
