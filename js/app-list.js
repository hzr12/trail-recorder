/**
 * 途刻 TraceCraft - 历史列表模块
 * =============================================
 * 通过 App.prototype.* 挂载到 App（须在 app-core.js 之后加载）：
 *  - 列表渲染 / 缓存：_loadTrailListCached / _invalidateTrailCache / _renderTrailList / _renderReplayTrailList
 *  - 列表操作：_loadTrailFromList / _replayTrailFromList / _deleteTrailFromList / _cleanTrail
 *  - 分享 / 下载：_exportShareCard / _downloadDataUrl
 *  - 重命名 / 转义 / 详情：_renameTrail / _escapeHtml / _showTrailDetail
 *  - 条目渲染 / 事件委托：_trailItemHTML / _bindTrailItemEvents / _showTrailItemMenu / _closeTrailItemMenu
 *  - 批量操作：_syncBatchToolbar / _selectAll / _invertSelection / _toggleMultiSelect / _deleteSelectedTrails
 *  - 合并 / 导出：_mergeSelectedTrails / _showMergeDialog / _exportSelectedImages / _computeTrailStats
 */

App.prototype._loadTrailListCached = function () {
  if (this._trailCache) return Promise.resolve(this._trailCache);
  return Storage.loadTrailList().then((items) => {
    this._trailCache = items || [];
    return this._trailCache;
  });
};

App.prototype._invalidateTrailCache = function () {
  this._trailCache = null;
};

App.prototype._renderTrailList = function () {
  const listEl = document.getElementById('trail-list');
  if (!listEl) return;
  this._loadTrailListCached().then((items) => {
    if (!items || items.length === 0) {
      listEl.innerHTML = '<div class="trail-list-empty">暂无历史轨迹</div>';
      return;
    }
    let list = this._onlyFav ? items.filter((i) => i.favorite) : items;
    list = this._filterTrails(list, this._searchKeyword, this._timeRange);
    list = this._sortTrails(list, this._sortKey);
    if (list.length === 0) {
      listEl.innerHTML = '<div class="trail-list-empty">没有匹配的轨迹</div>';
      return;
    }
    listEl.innerHTML = list.map((item) => this._trailItemHTML(item, false)).join('');
    this._bindTrailItemEvents(listEl, false);
    this._syncBatchToolbar();
  });
};

App.prototype._replayTrailFromList = function (id) {
  Storage.loadTrailById(id).then((data) => {
    if (!data || !data.positions || data.positions.length < 2) {
      Toast.show(' 轨迹数据不足');
      return;
    }

    // 停止当前回放
    if (this._isReplaying) {
      this._stopReplay();
    }

    // 切换到回放 Tab
    this._setTab('replay');

    // 回放使用独立数据源，不写入 this.trail：
    // 若正在记录，记录轨迹继续在后台采集/显示，回放轨迹与记录轨迹互不污染、并行共存
    Toast.show(` 已加载「${data.name}」（${data.positions.length} 点）`);

    // 自动开始回放
    setTimeout(() => {
      this._startReplay(data.positions, data.name);
    }, CONFIG.REPLAY_START_DELAY);
  });
};

App.prototype._renderReplayTrailList = function () {
  const listEl = document.getElementById('replay-trail-list');
  if (!listEl) return;
  this._loadTrailListCached().then((items) => {
    if (!items || items.length === 0) {
      listEl.innerHTML = '<div class="trail-list-empty">暂无历史轨迹</div>';
      return;
    }
    let list = this._replayOnlyFav ? items.filter((i) => i.favorite) : items;
    list = this._filterTrails(list, this._replaySearchKeyword, this._replayTimeRange);
    list = this._sortTrails(list, this._replaySortKey);
    if (list.length === 0) {
      listEl.innerHTML = '<div class="trail-list-empty">没有匹配的轨迹</div>';
      return;
    }
    listEl.innerHTML = list.map((item) => this._trailItemHTML(item, true)).join('');
    this._bindTrailItemEvents(listEl, true);
    this._syncBatchToolbar();
  });
};

App.prototype._loadTrailFromList = function (id) {
  Storage.loadTrailById(id).then((data) => {
    if (!data || !data.positions || data.positions.length < 2) {
      Toast.show(' 轨迹数据不足');
      return;
    }
    // 历史轨迹仅加载显示到地图，不污染 trail 容器：
    // 若正在记录，记录数据保持独立（并行），加载查看不影响采集
    this.mapManager.setTrail(data.positions);
    this.mapManager.setTrailMarkers(TrailAnalysis.analyzeKeyPoints(data.positions));
    // 未记录时同步到 trail 容器，保留「回放当前轨迹」能力；记录中则跳过避免覆盖记录数据
    if (!this.trail.isRecording) {
      this.trail.clear();
      this.trail.positions = data.positions;
      this.trail.lastPos = data.positions[data.positions.length - 1];
    }
    this._updateTrailUI();
    this._setTab('record');
    Toast.show(` 已加载「${data.name}」（${data.positions.length} 点）`);
  });
};

App.prototype._deleteTrailFromList = function (id) {
  const item = document.querySelector(`.trail-list-item[data-id="${id}"]`);
  const name = item ? (item.querySelector('.trail-item-name')?.textContent || '') : '';
  Storage.deleteTrail(id).then((ok) => {
    if (ok) {
      this._invalidateTrailCache();
      Toast.showUndo(`已删除「${name}」`, () => {
        Storage.loadTrailById(id).then((data) => {
          if (data && data.positions) {
            Storage.saveTrailToList(data.positions, name, data.favorite);
            this._invalidateTrailCache();
            this._renderTrailList();
            this._renderReplayTrailList();
          }
        });
      });
      this._renderTrailList();
    }
  });
};

/**
 * 生成并分享轨迹分享卡片
 * 分享链路与 _exportReport 相同：原生 Capacitor Filesystem+Share 系统分享 / Web 端 Blob URL 下载。
 * 绘制前可选做只读清洗（剔除首尾漂移段/异常点），仅用于卡片渲染，不落库不污染原数据。
 */
App.prototype._exportShareCard = async function (id) {
  const data = await Storage.loadTrailById(id);
  if (!data || !data.positions || data.positions.length < 2) {
    Toast.show('轨迹数据不足，无法分享');
    return;
  }
  // 只读清洗：trimEndpoints + filterOutliers，仅用于卡片绘制
  let cardPositions = data.positions;
  if (cardPositions.length >= 3) {
    let cleaned = TrailAnalysis.trimEndpoints(cardPositions);
    cleaned = TrailAnalysis.filterOutliers(cleaned);
    if (cleaned.length >= 2) cardPositions = cleaned;
  }
  const stats = this._computeTrailStats(cardPositions);
  Toast.show('正在生成分享卡片…');
  const dataUrl = await this.mapManager.renderShareCard({
    positions: cardPositions,
    name: data.name || '轨迹',
    createdAt: data.createdAt
  }, {
    stats: { distance: stats.distance, duration: stats.duration, points: cardPositions.length, avgSpeed: stats.avgSpeed, maxSpeed: stats.maxSpeed }
  });
  if (!dataUrl) {
    Toast.show('生成分享卡片失败，请重试');
    return;
  }
  const safeName = (data.name || '轨迹').replace(/[\\/:*?"<>|]/g, '_');
  const dateStr = formatBeijing(Date.now()).slice(0, 10).replace(/\//g, '-');
  const filename = `途刻-${safeName}-${dateStr}.png`;
  // 复用 _exportReport 的分享链路（原生系统分享 / Web 下载）
  this._downloadDataUrl(dataUrl, filename, {
    title: '途刻分享卡片',
    text: `途刻 — ${data.name || '轨迹'}`,
    dialogTitle: '分享或保存分享卡片'
  });
};

/**
 * 清洗历史轨迹：剔除起点/终点静止漂移段与异常漂移点（数据纠偏）
 * 清洗后重算 distance/duration/pointCount 并写回，打 cleaned 标记。
 * 纯函数处理（不修改原始数组），仅当点数有变化才落库，避免无意义写入。
 */
App.prototype._cleanTrail = async function (id) {
  const data = await Storage.loadTrailById(id);
  if (!data || !data.positions || data.positions.length < 2) {
    Toast.show('轨迹数据不足，无法清洗');
    return;
  }
  Toast.show('正在清洗轨迹…');
  let cleaned = TrailAnalysis.trimEndpoints(data.positions);
  // 跳变修复（复用后处理 TrailDenoise.denoiseTrail：米坐标插值，不删点、保时间轴）
  if (globalThis.TrailDenoise) {
    cleaned = globalThis.TrailDenoise.denoiseTrail(cleaned);
  } else {
    cleaned = TrailAnalysis.filterOutliers(cleaned);
  }

  const before = data.positions.length;
  const after = cleaned.length;
  if (after < 2) {
    Toast.show('清洗后点数不足，已保留原轨迹');
    return;
  }
  if (after === before) {
    Toast.show('轨迹已较干净，无需清洗');
    return;
  }

  const stats = this._computeTrailStats(cleaned);
  const ok = await Storage.updateTrailMeta(id, {
    positions: cleaned,
    distance: stats.distance,
    duration: stats.duration,
    pointCount: stats.points,
    cleaned: true
  });
  if (!ok) {
    Toast.show('清洗保存失败，请重试');
    return;
  }
  this._invalidateTrailCache();
  this._renderTrailList();
  this._renderReplayTrailList();
  Toast.show(`已清洗轨迹：${before} → ${after} 点`);
};

/**
 * 下载/分享 dataURL 图片（兼容 web 与 Capacitor 原生环境）
 * 原生：写入缓存目录并调起系统分享；web：Blob URL + a[download]。
 * @param {string} dataUrl PNG dataURL
 * @param {string} filename 文件名
 * @param {Object} [shareMeta] {title,text,dialogTitle} 自定义原生分享文案（默认轨迹图片）
 */
App.prototype._downloadDataUrl = function (dataUrl, filename, shareMeta) {
  // dataURL → Blob（兼容含中文的 SVG dataURI 与 PNG base64）
  const fetchBlob = () =>
    fetch(dataUrl).then((r) => r.blob()).catch(() => null);

  fetchBlob().then((blob) => {
    if (!blob) {
      Toast.show('导出失败，请重试');
      return;
    }
    if (typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform()) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = String(reader.result || '').split(',')[1] || '';
        Capacitor.Plugins.Filesystem.writeFile({
          path: filename,
          data: base64,
          directory: 'CACHE'
        }).then((result) => {
          return Capacitor.Plugins.Share.share({
            title: (shareMeta && shareMeta.title) || '途刻轨迹图片',
            text: (shareMeta && shareMeta.text) || filename,
            url: result.uri,
            dialogTitle: (shareMeta && shareMeta.dialogTitle) || '分享或保存轨迹图片'
          });
        }).then(() => {
          Toast.show('轨迹图片已导出');
        }).catch((e) => {
          console.warn('[Export] 原生分享失败:', e && e.message);
          Toast.show('导出失败，请重试');
        });
      };
      reader.onerror = () => Toast.show('导出失败，请重试');
      reader.readAsDataURL(blob);
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      Toast.show('轨迹图片已导出');
    }
  });
};

App.prototype._renameTrail = function (id, el) {
  if (el.contentEditable === 'true') return;
  const oldName = el.textContent;
  el.contentEditable = 'true';
  el.classList.add('editing');
  el.focus();

  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const commit = () => {
    el.contentEditable = 'false';
    el.classList.remove('editing');
    const newName = el.textContent.trim() || oldName;
    el.textContent = newName;
    if (newName !== oldName) {
      this._invalidateTrailCache();
      Storage.renameTrail(id, newName);
    }
  };

  el.onblur = commit;
  el.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    if (e.key === 'Escape') { el.textContent = oldName; el.blur(); }
  };
};

App.prototype._escapeHtml = function (str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
};

App.prototype._showTrailDetail = function (id) {
  Storage.loadTrailById(id).then(async (data) => {
    if (!data || !data.positions || data.positions.length < 2) {
      Toast.show('轨迹数据不足');
      return;
    }
    const pos = data.positions;
    const stats = this._computeTrailStats(pos);
    const durationMs = stats.duration;

    let maxSpeed = 0;
    let hasSpeed = false;
    for (const p of pos) {
      if (p.speed != null && p.speed > maxSpeed) { maxSpeed = p.speed; hasSpeed = true; }
    }
    const avgSpeed = durationMs > 0 ? stats.distance / (durationMs / 1000) : 0;
    const elev = TrailAnalysis.analyzeElevation(pos);

    const fmtTime = (ts) => formatDateTime(ts, { shortDate: true });
    const fmtDuration = formatDurationLong;

    const thumb = await this.mapManager.renderTrailThumbnail(pos, {
      title: data.name,
      map: false,
      stats: { distance: stats.distance, duration: durationMs, points: pos.length }
    });
    const firstTime = pos[0].time;
    const lastTime = pos[pos.length - 1].time;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay show';
    overlay.innerHTML = `
      <div class="modal-box trail-detail-modal">
        <div class="modal-header">
          <span class="modal-title">轨迹详情</span>
          <button class="modal-close trail-detail-close">✕</button>
        </div>
        ${thumb ? `<div class="trail-detail-thumb"><img src="${thumb}" alt="轨迹缩略图"/></div>` : ''}
        <div class="trail-detail-name">${this._escapeHtml(data.name || '')}</div>
        <div class="trail-detail-date">${fmtTime(firstTime)} → ${fmtTime(lastTime)}</div>
        <div class="stat-grid">
          <div class="stat-card"><span class="stat-label">总距离</span><span class="stat-value">${formatDistance(stats.distance)}</span></div>
          <div class="stat-card"><span class="stat-label">总时长</span><span class="stat-value">${fmtDuration(durationMs)}</span></div>
          <div class="stat-card"><span class="stat-label">平均速度</span><span class="stat-value">${avgSpeed > 0 ? (avgSpeed * 3.6).toFixed(1) + ' km/h' : '--'}</span></div>
          <div class="stat-card"><span class="stat-label">最高速度</span><span class="stat-value warning">${hasSpeed ? (maxSpeed * 3.6).toFixed(1) + ' km/h' : '--'}</span></div>
          <div class="stat-card"><span class="stat-label">轨迹点数</span><span class="stat-value accent2">${pos.length}</span></div>
          <div class="stat-card"><span class="stat-label">最高海拔</span><span class="stat-value">${elev.hasAltitude ? elev.maxAlt + ' m' : '--'}</span></div>
          <div class="stat-card"><span class="stat-label">累计爬升</span><span class="stat-value">${elev.hasAltitude ? '+' + elev.gain + ' m' : '--'}</span></div>
          <div class="stat-card"><span class="stat-label">累计下降</span><span class="stat-value">${elev.hasAltitude ? '-' + elev.loss + ' m' : '--'}</span></div>
          <div class="stat-card"><span class="stat-label">是否收藏</span><span class="stat-value">${data.favorite ? '已收藏' : '未收藏'}</span></div>
        </div>
        <div class="confirm-actions">
          <button class="btn-sm trail-detail-load">加载到地图</button>
          <button class="btn-sm trail-detail-close">关闭</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => {
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 300);
    };
    overlay.querySelectorAll('.trail-detail-close').forEach((b) => b.addEventListener('click', close));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    const loadBtn = overlay.querySelector('.trail-detail-load');
    if (loadBtn) {
      loadBtn.addEventListener('click', () => {
        close();
        this._loadTrailFromList(id);
      });
    }
  });
};

App.prototype._trailItemHTML = function (item, isReplay) {
  const dateStr = formatDateTime(item.createdAt);
  const distStr = item.distance >= 1000
    ? (item.distance / 1000).toFixed(2) + ' km'
    : Math.round(item.distance) + ' m';
  const metaExtra = isReplay ? ` · ${item.pointCount || 0} 点` : '';
  const dotColor = isReplay ? ' style="background:#FF9500"' : '';
  const favClass = item.favorite ? ' favorite-btn active' : ' favorite-btn';
  const selectedSet = isReplay ? this._replaySelected : this._historySelected;
  const checked = selectedSet.has(item.id) ? ' checked' : '';
  const multiCls = this._multiSelect ? ' multi' : '';
  const checkHtml = `<label class="trail-select-check${checked}" data-id="${item.id}">
      <input type="checkbox" data-id="${item.id}"${checked ? ' checked' : ''} />
    </label>`;
  const moreBtn = `<button class="trail-item-btn more-btn" data-id="${item.id}" title="更多操作">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
    </button>`;
  const actions = isReplay
    ? `<button class="trail-item-btn replay-btn" data-id="${item.id}" title="回放">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>
      </button>
      ${moreBtn}`
    : `<button class="trail-item-btn load-btn" data-id="${item.id}" title="加载到地图">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
      </button>
      ${moreBtn}`;
  return `<div class="trail-list-item${multiCls}" data-id="${item.id}">
    ${checkHtml}
    <button class="${favClass}" data-id="${item.id}" title="收藏">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="${item.favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
    </button>
    <span class="trail-item-dot"${dotColor}></span>
    <div class="trail-item-info">
      <div class="trail-item-name" data-id="${item.id}">${this._escapeHtml(item.name || '')}</div>
      <div class="trail-item-meta">${dateStr} · ${distStr}${metaExtra}</div>
    </div>
    <div class="trail-item-actions">
      ${actions}
    </div>
  </div>`;
};

App.prototype._bindTrailItemEvents = function (listEl, isReplay) {
  // 事件委托：容器上只绑定一次，子元素事件统一分发，避免每次渲染全量重绑 N 个监听器
  listEl._trailIsReplay = isReplay;
  if (listEl._trailDelegated) return;
  listEl._trailDelegated = true;

  // checkbox change（冒泡到容器）
  listEl.addEventListener('change', (e) => {
    const input = e.target;
    if (!input || !input.matches || !input.matches('.trail-select-check input')) return;
    const label = input.closest('.trail-select-check');
    if (!label) return;
    const selectedSet = listEl._trailIsReplay ? this._replaySelected : this._historySelected;
    const id = input.dataset.id;
    if (input.checked) { selectedSet.add(id); label.classList.add('checked'); }
    else { selectedSet.delete(id); label.classList.remove('checked'); }
    this._syncBatchToolbar();
  });

  // 点击委托（优先级：checkbox → 收藏 → 名称重命名 → 更多 → 回放/加载 → 卡片详情）
  listEl.addEventListener('click', (e) => {
    const checkbox = e.target.closest('.trail-select-check');
    if (checkbox) return; // checkbox 由 change 事件处理，click 直接忽略，避免误触卡片详情

    const favBtn = e.target.closest('.favorite-btn');
    if (favBtn) {
      e.stopPropagation();
      const id = favBtn.dataset.id;
      Storage.toggleFavorite(id).then((fav) => {
        this._invalidateTrailCache();
        if (fav === false && (this._onlyFav || this._replayOnlyFav)) {
          this._renderTrailList();
          if (listEl._trailIsReplay) this._renderReplayTrailList();
          return;
        }
        // 局部更新：仅切换按钮态与置顶，不整表重绘
        favBtn.classList.toggle('active', fav);
        const svg = favBtn.querySelector('svg');
        if (svg) svg.setAttribute('fill', fav ? 'currentColor' : 'none');
        const item = listEl.querySelector(`.trail-list-item[data-id="${id}"]`);
        if (item && item.parentNode) item.parentNode.insertBefore(item, listEl.firstChild);
        Toast.show(fav ? '已收藏' : '已取消收藏');
      });
      return;
    }

    const nameEl = e.target.closest('.trail-item-name');
    if (nameEl) {
      this._renameTrail(nameEl.dataset.id, nameEl);
      return;
    }

    const moreBtn = e.target.closest('.trail-item-btn.more-btn');
    if (moreBtn) {
      e.stopPropagation();
      this._showTrailItemMenu(moreBtn, moreBtn.dataset.id, listEl._trailIsReplay);
      return;
    }

    if (listEl._trailIsReplay) {
      const replayBtn = e.target.closest('.trail-item-btn.replay-btn');
      if (replayBtn) {
        e.stopPropagation();
        this._replayTrailFromList(replayBtn.dataset.id);
        return;
      }
    }

    const loadBtn = e.target.closest('.trail-item-btn.load-btn');
    if (loadBtn) {
      e.stopPropagation();
      this._loadTrailFromList(loadBtn.dataset.id);
      return;
    }

    // 卡片空白区域 → 打开详情
    const item = e.target.closest('.trail-list-item');
    if (item && !e.target.closest('.trail-item-btn, .favorite-btn, .trail-select-check, .trail-item-name')) {
      this._showTrailDetail(item.dataset.id);
    }
  });
};

/**
 * 弹出轨迹项的「⋯」更多操作菜单
 * @param {HTMLElement} anchorBtn 触发按钮
 * @param {string} id 轨迹 id
 * @param {boolean} isReplay 是否回放列表
 */
App.prototype._showTrailItemMenu = function (anchorBtn, id, isReplay) {
  this._closeTrailItemMenu();

  // 全屏透明遮罩：拦截点击，避免误触被遮挡的轨迹操作
  const backdrop = document.createElement('div');
  backdrop.className = 'trail-menu-backdrop';
  backdrop.addEventListener('click', (e) => {
    e.stopPropagation();
    this._closeTrailItemMenu();
  });
  document.body.appendChild(backdrop);
  this._trailMenuBackdrop = backdrop;

  const menu = document.createElement('div');
  menu.className = 'trail-item-menu';
  const items = [
    { act: 'detail', label: '详情', fn: () => this._showTrailDetail(id) },
    { act: 'load', label: '加载到地图', fn: () => this._loadTrailFromList(id), replayOnly: true },
    { act: 'clean', label: '清洗轨迹', fn: () => this._cleanTrail(id), historyOnly: true },
    { act: 'share-card', label: '分享图片', fn: () => this._exportShareCard(id), historyOnly: true },
    { act: 'delete', label: '删除', danger: true, fn: () => this._deleteTrailFromList(id) }
  ];
  menu.innerHTML = items
    .filter((it) => !(it.replayOnly && !isReplay) && !(it.historyOnly && isReplay))
    .map((it) => `<button class="trail-menu-item${it.danger ? ' danger' : ''}" data-act="${it.act}" data-id="${id}">${it.label}</button>`)
    .join('');
  document.body.appendChild(menu);

  // 自适应定位（fixed，避免被列表 overflow 裁剪）
  const rect = anchorBtn.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const gap = 6;
  const margin = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 水平：优先右对齐触发按钮，并钳制在视口内
  let left = Math.min(rect.right - mw, vw - mw - margin);
  left = Math.max(margin, left);

  // 垂直：下方空间足够则向下弹出，否则翻转到上方；上下都不足则贴边
  let top;
  const below = vh - rect.bottom;
  const above = rect.top;
  if (below >= mh + gap + margin) {
    top = rect.bottom + gap;
  } else if (above >= mh + gap + margin) {
    top = rect.top - mh - gap;
  } else {
    top = Math.max(margin, Math.min(vh - mh - margin, rect.bottom - mh / 2));
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  this._trailMenu = menu;
  this._trailMenuClickHandler = (e) => {
    const btn = e.target.closest('.trail-menu-item');
    if (!btn) return;
    const item = items.find((it) => it.act === btn.dataset.act);
    this._closeTrailItemMenu();
    if (item && item.fn) item.fn();
  };
  menu.addEventListener('click', this._trailMenuClickHandler);
};

App.prototype._closeTrailItemMenu = function () {
  if (this._trailMenu) {
    this._trailMenu.remove();
    this._trailMenu = null;
  }
  if (this._trailMenuBackdrop) {
    this._trailMenuBackdrop.remove();
    this._trailMenuBackdrop = null;
  }
  if (this._trailMenuClickHandler) {
    // handler 随元素移除自动失效，无需额外清理
    this._trailMenuClickHandler = null;
  }
};

App.prototype._syncBatchToolbar = function () {
  const bar = document.getElementById('batch-toolbar');
  if (!bar) return;
  const total = this._historySelected.size + this._replaySelected.size;
  const countEl = bar.querySelector('.batch-count');
  if (countEl) countEl.textContent = total > 0 ? `已选 ${total} 条` : '未选择';
  // 合集一次最多导出 2 条：超过时按钮仍可点，由 _exportSelectedImages 弹出 toast 提示
  const exportBtn = bar.querySelector('.batch-export');
  exportBtn.disabled = total === 0;
  bar.querySelector('.batch-merge').disabled = total < 2;
  const deleteBtn = bar.querySelector('.batch-delete');
  if (deleteBtn) deleteBtn.disabled = total === 0;
  const invertBtn = bar.querySelector('.batch-invert');
  if (invertBtn) invertBtn.disabled = total === 0;
  bar.querySelector('.batch-clear').disabled = total === 0;
  bar.classList.toggle('visible', total > 0 || this._multiSelect);
};

App.prototype._selectAll = function (checked) {
  // 只选择当前 Tab 可见列表（全选当前）
  if (this._currentTab === 'replay') {
    this._replaySelected.clear();
    if (checked) {
      const list = document.getElementById('replay-trail-list');
      if (list) list.querySelectorAll('.trail-list-item').forEach((el) => this._replaySelected.add(el.dataset.id));
    }
  } else {
    this._historySelected.clear();
    if (checked) {
      const list = document.getElementById('trail-list');
      if (list) list.querySelectorAll('.trail-list-item').forEach((el) => this._historySelected.add(el.dataset.id));
    }
  }
  this._multiSelect = true;
  this._renderTrailList();
  this._renderReplayTrailList();
};

App.prototype._invertSelection = function () {
  const histList = document.getElementById('trail-list');
  const replayList = document.getElementById('replay-trail-list');
  if (histList) {
    histList.querySelectorAll('.trail-list-item').forEach((el) => {
      const id = el.dataset.id;
      if (this._historySelected.has(id)) this._historySelected.delete(id);
      else this._historySelected.add(id);
    });
  }
  if (replayList) {
    replayList.querySelectorAll('.trail-list-item').forEach((el) => {
      const id = el.dataset.id;
      if (this._replaySelected.has(id)) this._replaySelected.delete(id);
      else this._replaySelected.add(id);
    });
  }
  this._multiSelect = true;
  this._renderTrailList();
  this._renderReplayTrailList();
};

App.prototype._toggleMultiSelect = function (force) {
  this._multiSelect = force != null ? force : !this._multiSelect;
  if (!this._multiSelect) {
    this._historySelected.clear();
    this._replaySelected.clear();
  }
  this._renderTrailList();
  this._renderReplayTrailList();
};

App.prototype._computeTrailStats = function (positions) {
  const s = TrailAnalysis.calcStats(positions);
  // 兼容旧字段名：duration 兼容清洗/分享/详情路径
  return { distance: s.distance, duration: s.durationMs, points: s.points, avgSpeed: s.avgSpeed, maxSpeed: s.maxSpeed, hasSpeed: s.hasSpeed };
};

App.prototype._exportSelectedImages = function () {
  const ids = Array.from(new Set([...this._historySelected, ...this._replaySelected]));
  if (ids.length === 0) return;
  if (ids.length > 2) {
    Toast.show('轨迹合集一次最多导出 2 条');
    return;
  }
  Toast.show('正在生成轨迹合集卡片…');
  Storage.loadTrailsByIds(ids).then(async (trails) => {
    if (!trails || trails.length === 0) {
      Toast.show('分享失败');
      return;
    }
    const items = trails.map((t) => ({
      positions: t.positions,
      name: t.name,
      stats: this._computeTrailStats(t.positions)
    }));
    const dataUrl = await this.mapManager.renderTrailCollage(items);
    if (!dataUrl) {
      Toast.show('生成失败，请重试');
      return;
    }
    const dateStr = formatBeijing(Date.now()).slice(0, 10).replace(/\//g, '-');
    const filename = `途刻-轨迹合集-${dateStr}.png`;
    // 批量导出改为分享链路（与报告导出相同）：原生系统分享 / Web 端下载
    this._downloadDataUrl(dataUrl, filename, {
      title: '途刻轨迹合集',
      text: `途刻 — ${items.length} 条轨迹合集`,
      dialogTitle: '分享或保存轨迹合集长图'
    });
    this._toggleMultiSelect(false);
  });
};

App.prototype._mergeSelectedTrails = function () {
  const ids = Array.from(new Set([...this._historySelected, ...this._replaySelected]));
  if (ids.length < 2) { Toast.show('至少选择 2 条轨迹才能合并'); return; }
  this._loadTrailListCached().then((items) => {
    const selected = items.filter((it) => ids.includes(it.id));
    const totalDist = selected.reduce((s, it) => s + (it.distance || 0), 0);
    const totalPts = selected.reduce((s, it) => s + (it.pointCount || 0), 0);
    this._showMergeDialog(ids, selected.length || ids.length, totalDist, totalPts);
  });
};

App.prototype._showMergeDialog = function (ids, count, totalDist, totalPts) {
  const now = Date.now();
  const d = new Date(now);
  const defaultName = `合并轨迹 ${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay show';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <span class="modal-title">合并轨迹</span>
        <button class="modal-close merge-dialog-cancel">✕</button>
      </div>
      <div class="confirm-body">
        <div class="confirm-text">将拼接 ${count} 条轨迹为 1 条</div>
        <div class="confirm-detail">合计约 ${formatDistance(totalDist)} · ${totalPts} 个点。若轨迹时间/位置不连续，合并后距离会偏大。</div>
      </div>
      <div class="merge-name-field">
        <label class="merge-name-label" for="merge-name-input">新轨迹名称</label>
        <input type="text" id="merge-name-input" class="modal-input" value="${defaultName}" maxlength="60" />
      </div>
      <div class="confirm-actions">
        <button class="btn-sm merge-dialog-cancel">取消</button>
        <button class="btn-sm btn-danger" id="merge-confirm-btn">合并</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 300);
  };
  const onCancel = (e) => {
    e.stopPropagation();
    close();
  };
  overlay.querySelectorAll('.merge-dialog-cancel').forEach((b) => b.addEventListener('click', onCancel));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  const input = overlay.querySelector('#merge-name-input');
  input.focus();
  input.select();

  const doMerge = () => {
    const name = input.value.trim() || defaultName;
    const btn = overlay.querySelector('#merge-confirm-btn');
    btn.disabled = true;
    btn.textContent = '合并中…';
    Storage.mergeTrails(ids, name).then((newId) => {
      close();
      if (newId) {
        this._invalidateTrailCache();
        Toast.show(`已合并为「${name}」`);
        this._toggleMultiSelect(false);
        this._renderTrailList();
        this._renderReplayTrailList();
      } else {
        Toast.show('合并失败，请重试');
      }
    });
  };
  overlay.querySelector('#merge-confirm-btn').addEventListener('click', doMerge);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doMerge(); }
    if (e.key === 'Escape') close();
  });
};

App.prototype._deleteSelectedTrails = function () {
  const ids = Array.from(new Set([...this._historySelected, ...this._replaySelected]));
  if (ids.length === 0) return;
  Storage.loadTrailsByIds(ids).then((trails) => {
    if (!trails || trails.length === 0) {
      Toast.show('没有可删除的轨迹');
      return;
    }
    // 确认对话框
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay show';
    overlay.innerHTML = `
      <div class="modal-box">
        <div class="modal-header">
          <span class="modal-title">批量删除</span>
          <button class="modal-close batch-delete-cancel">✕</button>
        </div>
        <div class="confirm-body">
          <div class="confirm-text">确定删除选中的 ${trails.length} 条轨迹？</div>
          <div class="confirm-detail">删除后可在 5 秒内撤销。该操作不可恢复，请谨慎操作。</div>
        </div>
        <div class="confirm-actions">
          <button class="btn-sm batch-delete-cancel">取消</button>
          <button class="btn-sm btn-danger" id="batch-delete-confirm-btn">确认删除</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => {
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 300);
    };
    const onCancel = (e) => {
      e.stopPropagation();
      close();
    };
    overlay.querySelectorAll('.batch-delete-cancel').forEach((b) => b.addEventListener('click', onCancel));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    overlay.querySelector('#batch-delete-confirm-btn').addEventListener('click', () => {
      const btn = overlay.querySelector('#batch-delete-confirm-btn');
      btn.disabled = true;
      btn.textContent = '删除中…';
      Promise.all(ids.map((id) => Storage.deleteTrail(id).catch(() => false))).then((results) => {
        close();
        const okCount = results.filter((r) => r).length;
        if (okCount === 0) {
          Toast.show('删除失败，请重试');
          return;
        }
        this._invalidateTrailCache();
        const msg = okCount === ids.length ? `已删除 ${okCount} 条轨迹` : `已删除 ${okCount}/${ids.length} 条轨迹`;
        Toast.showUndo(msg, () => {
          // 撤销：重新保存被删轨迹（逐条恢复，失败静默）
          return Promise.all(
            trails.filter((t) => t.positions && t.positions.length > 0)
              .map((t) => Storage.saveTrailToList(t.positions, t.name, t.favorite).catch(() => null))
          ).then(() => {
            this._invalidateTrailCache();
            this._renderTrailList();
            this._renderReplayTrailList();
            this._syncBatchToolbar();
          });
        });
        this._toggleMultiSelect(false);
        this._renderTrailList();
        this._renderReplayTrailList();
        this._syncBatchToolbar();
      });
    });
  });
};
