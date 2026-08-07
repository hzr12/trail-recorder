'use strict';
// 临时验证脚本：mock 浏览器环境后真实执行 js/map.js 的缩略图瓦片底图绘制逻辑。
// 验证：瓦片无缝平铺、尺寸合理、覆盖绘制区、导出入口可用。验证后删除。
const fs = require('fs');
const vm = require('vm');

// ===== 浏览器环境 mock =====
const drawCalls = [];
function makeCtx() {
  const handler = {
    get(_t, prop) {
      if (prop === 'drawImage') return (img, x, y, w, h) => drawCalls.push({ img, x, y, w, h });
      if (prop === 'canvas') return null;
      return (...args) => args && undefined;
    },
    set() { return true; }
  };
  return new Proxy({}, handler);
}
function makeCanvas() {
  const canvas = { width: 800, height: 500 };
  canvas.getContext = () => makeCtx();
  canvas.toDataURL = () => 'data:image/png;base64,QUJD';
  return canvas;
}

globalThis.document = {
  documentElement: { getAttribute: (k) => (k === 'data-theme' ? 'dark' : null) },
  createElement: (tag) => (tag === 'canvas' ? makeCanvas() : {})
};
globalThis.Image = class {
  constructor() { this.width = 256; this.height = 256; this.onload = null; this.onerror = null; }
  set src(_v) { if (this.onload) this.onload(); }
};
globalThis.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} };
globalThis.fetch = async () => ({ ok: true, blob: async () => new Blob(['x']) });
globalThis.window = globalThis;

// ===== 加载源码 =====
const src = ['js/config.js', 'js/trail-analysis.js', 'js/map.js']
  .map((f) => fs.readFileSync('f:/project/trail-recorder/' + f, 'utf8'))
  .join('\n;\n') +
  '\n;\nglobalThis.__MapManager = MapManager;\nglobalThis.__CONFIG = CONFIG;';
vm.runInThisContext(src, { filename: 'combined.js' });
const MapManager = globalThis.__MapManager;

// ===== 数据生成 =====
function genCircle(cLat, cLng, radiusM, pts) {
  const out = [];
  const latStep = radiusM / 111320;
  const lngStep = radiusM / (111320 * Math.cos((cLat * Math.PI) / 180));
  for (let i = 0; i < pts; i++) {
    const a = (i / pts) * Math.PI * 2;
    out.push({ lat: cLat + Math.sin(a) * latStep, lng: cLng + Math.cos(a) * lngStep, time: i * 1000, speed: 1 + (i % 5) });
  }
  return out;
}

let pass = 0, fail = 0;
const errors = [];
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; errors.push(`${name}: ${detail}`); }
}

const padYFor = (opts) => {
  const hasStats = opts.stats && (opts.stats.distance != null || opts.stats.duration != null || opts.stats.points != null);
  return Math.max(opts.title ? 56 : 30, 30 + (hasStats ? 44 : 0));
};

const cases = [
  ['杭州环线', genCircle(30.25, 120.15, 5000, 200), { title: '测试', stats: { distance: 1, duration: 1, points: 200 } }],
  ['北京城区', genCircle(39.9, 116.4, 20000, 300), { title: '北京', stats: {} }],
  ['无标题小环', genCircle(30.22, 120.2, 250, 50), {}],
  ['竖长窄轨迹', (() => { const o = []; for (let i = 0; i < 150; i++) o.push({ lat: 30.0 + i * 0.004, lng: 120.15, time: i * 1000, speed: 2 }); return o; })(), { title: '竖线', stats: { distance: 1, duration: 1, points: 150 } }],
];

(async () => {
  for (const [name, positions, opts] of cases) {
    drawCalls.length = 0;
    const m = new MapManager();
    const loaded = [];
    m._loadMapTile = async (z, x, y) => { loaded.push([z, x, y]); return { width: 256, height: 256 }; };

    const canvas = makeCanvas();
    canvas.width = 800; canvas.height = 500;
    const ok = await m._drawTrailThumbnail(canvas, positions, opts);

    check(`${name}: 绘制函数返回 canvas`, ok === canvas, `ok=${ok === canvas}`);
    check(`${name}: 有瓦片绘制`, drawCalls.length > 0, `draws=${drawCalls.length}`);
    check(`${name}: 瓦片数量<=100`, drawCalls.length <= 100, `draws=${drawCalls.length}`);
    if (drawCalls.length === 0) continue;

    const ws = new Set(drawCalls.map((d) => Math.round(d.w * 100)));
    const hs = new Set(drawCalls.map((d) => Math.round(d.h * 100)));
    const w = drawCalls[0].w, h = drawCalls[0].h;
    check(`${name}: 瓦片宽度一致`, ws.size === 1, `wset=[${[...ws]}]`);
    check(`${name}: 瓦片高度一致`, hs.size === 1, `hset=[${[...hs]}]`);
    check(`${name}: 瓦片尺寸合理(1<w<=512)`, w > 1 && w <= 512 && h > 1 && h <= 512, `w=${w} h=${h}`);
    check(`${name}: 瓦片近正方形`, Math.abs(w - h) < 0.6, `w=${w} h=${h}`);

    // 行内相邻瓦片无缝平铺：步进 == 瓦片宽（代码刻意 +1px 防缝隙，允许 1px 重叠）
    const minY = Math.min(...drawCalls.map((d) => d.y));
    const rowTiles = drawCalls.filter((d) => Math.abs(d.y - minY) < 0.6).sort((a, b) => a.x - b.x);
    let spacingOk = rowTiles.length >= 1;
    for (let i = 1; i < rowTiles.length; i++) {
      const step = rowTiles[i].x - rowTiles[i - 1].x; // 瓦片世界步进像素
      if (Math.abs(step - (w - 1)) > 0.7) { spacingOk = false; break; }
    }
    check(`${name}: 同行瓦片无缝平铺`, spacingOk, `rowTiles=${rowTiles.length}`);

    // 瓦片覆盖整个绘制区
    const padY = padYFor(opts);
    const minX = Math.min(...drawCalls.map((d) => d.x));
    const maxX = Math.max(...drawCalls.map((d) => d.x + d.w));
    const maxY = Math.max(...drawCalls.map((d) => d.y + d.h));
    check(`${name}: 瓦片覆盖绘制区左/上缘`, minX <= 40 + 0.6 && minY <= padY + 0.6, `minX=${minX} minY=${minY} padY=${padY}`);
    check(`${name}: 瓦片覆盖绘制区右/下缘`, maxX >= 800 - 40 - 0.6 && maxY >= 500 - padY - 0.6, `maxX=${maxX} maxY=${maxY} padY=${padY}`);

    // 瓦片加载的 z 在合理范围
    const zs = new Set(loaded.map((t) => t[0]));
    check(`${name}: zoom∈[3,18]`, [...zs].every((z) => z >= 3 && z <= 18), `zs=[${[...zs]}]`);

    // 完整导出入口
    const dataUrl = await m.renderTrailThumbnail(positions, { title: '导出', stats: { distance: 1, duration: 1, points: positions.length } });
    check(`${name}: renderTrailThumbnail 返回 dataURL`, typeof dataUrl === 'string' && dataUrl.length > 10, `len=${dataUrl && dataUrl.length}`);
  }

  // 批量长图
  drawCalls.length = 0;
  const m2 = new MapManager();
  m2._loadMapTile = async () => ({ width: 256, height: 256 });
  const collage = await m2.renderTrailCollage([
    { positions: genCircle(30.25, 120.15, 5000, 100), name: 'A', stats: { distance: 1, duration: 1, points: 100 } },
    { positions: genCircle(31.2, 121.5, 8000, 120), name: 'B', stats: { distance: 1, duration: 1, points: 120 } }
  ]);
  check('renderTrailCollage 返回 dataURL', typeof collage === 'string' && collage.length > 10, `len=${collage && collage.length}`);

  // 详情预览关闭底图时仍可用（map:false）
  drawCalls.length = 0;
  const m3 = new MapManager();
  const thumb = await m3.renderTrailThumbnail(genCircle(30.25, 120.15, 3000, 80), { title: '预览', map: false, stats: { distance: 1, duration: 1, points: 80 } });
  check('map:false 纯色缩略图可用', typeof thumb === 'string' && thumb.length > 10 && drawCalls.length === 0, `len=${thumb && thumb.length} draws=${drawCalls.length}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (errors.length) {
    console.log('\nFAILURES:');
    errors.forEach((e) => console.log('  - ' + e));
    process.exit(1);
  }
})();
