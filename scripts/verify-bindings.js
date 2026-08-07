'use strict';
// 临时验证脚本：核对面板重构后 JS 依赖的 id 是否全部存在于 index.html。
// 验证后删除。
const fs = require('fs');

const html = fs.readFileSync('f:/project/trail-recorder/index.html', 'utf8');
const appCore = fs.readFileSync('f:/project/trail-recorder/js/app-core.js', 'utf8');
const appGpsUi = fs.readFileSync('f:/project/trail-recorder/js/app-gps-ui.js', 'utf8');
const js = appCore + '\n' + appGpsUi;

// HTML 中所有 id
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

// JS 中 getElementById('...')
const getById = new Set([...js.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]));

// JS 中 querySelector/querySelectorAll 里的 #id
const qsIds = new Set([...js.matchAll(/querySelectorAll?\(\s*['"]([^'"]*#[A-Za-z0-9_-]+[^'"]*)['"]\s*\)/g)].map((m) => m[1]));

let pass = 0, fail = 0;
const errors = [];

// 1. getElementById 引用的 id 必须存在于 HTML
for (const id of getById) {
  if (htmlIds.has(id)) pass++;
  else { fail++; errors.push(`getElementById('${id}') 在 HTML 中缺失`); }
}

// 2. querySelector/All 中的 #id 必须存在（拆出每个 id）
for (const sel of qsIds) {
  const ids = [...sel.matchAll(/#([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
  for (const id of ids) {
    if (htmlIds.has(id)) pass++;
    else { fail++; errors.push(`querySelector('${sel}') 引用的 #${id} 缺失`); }
  }
}

// 3. 面板关键 id 抽查
const critical = ['tab-record', 'tab-replay', 'tab-history', 'gps-status', 'gnss-bar',
  'trail-record-btn', 'trail-pause-btn', 'trail-clear-btn', 'trail-stats-btn',
  'trail-smooth-btn', 'export-report-btn', 'trail-distance', 'power-saving-btn',
  'power-status', 'speed-chart-section', 'speed-chart-body', 'speed-chart-toggle',
  'speed-chart-canvas', 'speed-chart-info', 'replay-empty', 'replay-panel',
  'replay-title', 'replay-time', 'replay-slider', 'replay-play-btn', 'replay-stop-btn',
  'replay-follow-btn', 'replay-info', 'replay-search', 'replay-time-range', 'replay-sort',
  'replay-fav-filter', 'replay-trail-list', 'history-search', 'history-time-range',
  'history-sort', 'history-fav-filter', 'trail-list', 'batch-toolbar', 'batch-export',
  'batch-merge', 'batch-invert', 'batch-clear', 'theme-btn', 'gps-btn'];
for (const id of critical) {
  if (htmlIds.has(id)) pass++;
  else { fail++; errors.push(`关键 id #${id} 缺失`); }
}

// 4. 关键 class 抽查（JS 事件委托依赖）
const htmlClasses = new Set([...html.matchAll(/\bclass="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
const criticalClasses = ['bottom-panel', 'panel-handle', 'handle-bar', 'panel-header',
  'panel-title', 'panel-body', 'mode-tabs', 'mode-tab', 'gps-status', 'gps-dot',
  'replay-empty', 'replay-panel', 'replay-trails-section', 'trail-list-header',
  'trail-list', 'trail-list-empty', 'batch-toolbar', 'trail-section', 'trail-header',
  'trail-controls', 'trail-actions', 'power-section', 'speed-legend',
  'speed-chart-section', 'speed-chart-header', 'speed-chart-body', 'gnss-bar'];
for (const c of criticalClasses) {
  if (htmlClasses.has(c)) pass++;
  else { fail++; errors.push(`关键 class .${c} 在 HTML 静态结构中缺失`); }
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log('HTML 中 id 数量:', htmlIds.size, '| JS getElementById 引用:', getById.size, '| querySelector # 引用:', qsIds.size);
if (errors.length) {
  console.log('\nFAILURES:');
  errors.forEach((e) => console.log('  - ' + e));
  process.exit(1);
}
