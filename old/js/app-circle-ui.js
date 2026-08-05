/**
 * 圆圈地图 - 圆列表 & 信息展示 UI
 * ============================================
 * 追加 App.prototype 方法：圆列表渲染、info 面板、删除/撤销
 * 加载顺序：app-core.js 之后
 */

/* ── 信息展示区（选中圆圈信息） ───────────────────── */

App.prototype._updateInfo = function () {
  const infoArea = this._infoAreaEl || (this._infoAreaEl = document.getElementById('infoArea'));
  if (!infoArea) return;
  if (this.mapManager.selectedCircleId === null && infoArea.classList.contains('hidden')) return;
  const sel = this.mapManager.getSelectedCircle();

  if (!sel) {
    infoArea.classList.add('hidden');
    return;
  }

  infoArea.classList.remove('hidden');

  const centerEl = this._infoCenterEl || (this._infoCenterEl = document.getElementById('info-center'));
  centerEl.textContent = `${sel.center.lat.toFixed(6)}, ${sel.center.lng.toFixed(6)}`;

  const radiusEl = this._infoRadiusEl || (this._infoRadiusEl = document.getElementById('info-radius'));
  radiusEl.textContent =
    sel.maxRadius >= 1000
      ? `${(sel.maxRadius / 1000).toFixed(2)} km`
      : `${sel.maxRadius} m`;

  const areaValue = Math.PI * sel.maxRadius * sel.maxRadius;
  const areaEl = this._infoAreaValueEl || (this._infoAreaValueEl = document.getElementById('info-area'));
  areaEl.textContent =
    areaValue >= 1e6
      ? `${(areaValue / 1e6).toFixed(2)} km²`
      : `${areaValue.toFixed(0)} m²`;

  const distEl = this._infoDistEl || (this._infoDistEl = document.getElementById('info-distance'));
  if (this.myPosition && distEl) {
    const { dist, bearingStr, within, stale, trendHtml } = this._calcCircleTrend(sel);
    const manualTag = this._isManualPosition ? ' <span class="tag-manual">手动</span>' : '';
    let rangeTag = '';
    if (within === 'inrange') rangeTag = ' <span class="tag-inrange">范围内</span>';
    else if (within === 'maybe') rangeTag = ' <span class="tag-maybe">可能范围内</span>';
    distEl.innerHTML = `${formatDistance(dist)} ${trendHtml} · 方位${bearingStr}${rangeTag}${stale ? ' <span class="tag-stale">可能过期</span>' : ''}${manualTag}`;
  } else if (distEl) {
    distEl.textContent = '--';
  }
};

/* ── 圆选中 ────────────────────────────────────────── */

App.prototype._selectCircle = function (id) {
  this.mapManager.selectCircle(id);
  const sel = this.mapManager.getSelectedCircle();
  if (sel) {
    this._setRadiusSliderValue(sel.maxRadius);
    this.mapManager.setCenter(sel.center);
  }
  this._updateInfo();
  this._updateCircleList(true);
  this._updateStatusBar(true);
};

/* ── 删除圆 ────────────────────────────────────────── */

App.prototype._deleteCircle = function (id) {
  const circle = this.mapManager.circles.find(c => c.id === id);
  if (!circle) return;
  const wasSelected = this.mapManager.selectedCircleId === id;
  const originalIdx = this.mapManager.circles.findIndex(c => c.id === id);

  this.mapManager.removeCircle(id);
  this._updateInfo();
  this._updateCircleList(true);
  this._updateStatusBar(true);
  this._dirty = true;
  this._saveState();
  delete this._prevDistances[id];
  if (this.roomManager && this._roomJoined) this.roomManager.publishCircle('remove', { id });

    Toast.showUndo('已删除', () => {
    this.mapManager.circles.splice(originalIdx, 0, circle);
    if (wasSelected) {
      this.mapManager.selectedCircleId = circle.id;
    }
    this.mapManager._scheduleRedraw();
    this._updateInfo();
    this._updateCircleList(true);
    this._updateStatusBar(true);
    this._dirty = true;
    this._saveState();
    if (this.roomManager && this._roomJoined) this.roomManager.publishCircle('add', circle);
  });
};

/* ── 编辑圆半径 ────────────────────────────────────── */

App.prototype._editCircle = function (id) {
  this._selectCircle(id);
  const radiusSection = document.querySelector('.radius-section');
  if (radiusSection && this._bottomPanel) {
    this._bottomPanel.scrollTo({
      top: radiusSection.offsetTop - this._bottomPanel.offsetTop - 10,
      behavior: 'smooth'
    });
  }
  this._radiusSlider.classList.add('editing');
  this._radiusInput.focus();
  setTimeout(() => this._radiusSlider.classList.remove('editing'), CONFIG.EDIT_HIGHLIGHT_MS);
  Toast.show(' 拖动滑块调整半径');
};

/* ── 渲染圆列表 ────────────────────────────────────── */

App.prototype._updateCircleList = function (force) {
  const circles = this.mapManager.getCircles();
  const selId = this.mapManager.selectedCircleId;

  const now = Date.now();
  if (!force && this._lastCircleUpdate && now - this._lastCircleUpdate < CONFIG.LIST_THROTTLE_MS) return;
  this._lastCircleUpdate = now;

    let html = '';
    for (let i = 0; i < circles.length; i++) {
      const c = circles[i];
      const isSel = c.id === selId;
    const radiusStr = c.maxRadius >= 1000
      ? (c.maxRadius / 1000).toFixed(1) + ' km'
      : c.maxRadius + ' m';
    const coordStr = c.center.lat.toFixed(4) + ', ' + c.center.lng.toFixed(4);
    const createDate = new Date(c.createdAt || Date.now());
    const nowDate = new Date();
    const timeStr = createDate.toTimeString().slice(0, 8);
    const dateStr = createDate.toDateString() === nowDate.toDateString()
      ? timeStr
      : `${createDate.getMonth() + 1}/${createDate.getDate()} ${timeStr}`;

    let distStr = '';
    let distClass = '';
    if (this.myPosition) {
      const { dist, bearingStr, within, stale, trend } = this._calcCircleTrend(c);
      const rangeTag = within === 'inrange' ? ' [范围内]' : within === 'maybe' ? ' [可能范围内]' : ' [范围外]';
      distStr = formatDistance(dist) + rangeTag + trend + (stale ? ' ' : '') + (this._isManualPosition ? ' ' : '') + ` 方位${bearingStr}`;
      distClass = within === 'inrange' ? 'dist-within' : within === 'maybe' ? 'dist-maybe' : 'dist-outside';
    }

    const safeColor = this._sanitizeColor(c.color);
    html += `<div class="circle-item${isSel ? ' active' : ''}" data-id="${c.id}"${safeColor ? ` style="border-left-color:${safeColor}"` : ''}>
      <span class="circle-idx"${safeColor ? ` style="background:${safeColor};border-color:${safeColor}"` : ''}>#${i + 1}</span>
      <div class="circle-summary">
        <div class="circle-meta">${radiusStr} <span class="circle-created">${dateStr}</span></div>
      </div>
      <span class="circle-dist ${distClass}">${distStr}</span>
      <button class="circle-edit" aria-label="编辑半径">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
          <path d="m15 5 4 4"/>
        </svg>
      </button>
      <button class="circle-del" aria-label="删除此圆">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>`;
  }

  // NPC 视角：显示其他队伍的圆 + 各队员到圆心的距离
  if (this.roomManager && this.roomManager.isNpcTeam() && this.roomManager.isConnected()) {
    const remoteCircles = this.roomManager.getRemoteCircles();
    const players = this.roomManager.getPlayers();
    const teams = this.roomManager.getTeams();
    const myInfo = this.roomManager.getMyInfo();
    const now = Date.now();
    const follower = this._followedPlayerId;

    if (remoteCircles.length) {
      // 按作者分组
      const groups = {};
      for (const rc of remoteCircles) {
        const key = rc.author || 'unknown';
        if (!groups[key]) groups[key] = [];
        groups[key].push(rc);
      }

      // 展开状态
      const collapsedKey = 'circlemap_remote_collapsed';
      const collapsedAuthors = (() => { try { return JSON.parse(localStorage.getItem(collapsedKey)) || {}; } catch (e) { return {}; } })();

      for (const [author, circles] of Object.entries(groups)) {
        const authorName = circles[0].authorName || '玩家';
        // 远程颜色来自公共 Broker，消毒防 CSS 注入/结构破坏
        const authorColor = this._sanitizeColor(circles[0].color);
        const isCollapsed = collapsedAuthors[author];
        const circleCount = circles.length;

        html += `<div class="circle-section-divider remote-group-header" data-author="${this._escapeHtml(author)}">
          <span class="remote-group-toggle">${isCollapsed ? '▶' : '▼'}</span>
          <span class="remote-group-name" style="color:${authorColor}">${this._escapeHtml(authorName)}</span>
          <span class="remote-group-count">${circleCount} 圆</span>
        </div>`;

        if (!isCollapsed) {
          circles.forEach((rc, idx) => {
            const age = now - rc.receivedAt;
            let freshnessClass = 'freshness-ok';
            if (age < 30000) freshnessClass = 'freshness-recent';
            else if (age < 120000) freshnessClass = 'freshness-stale';
            else freshnessClass = 'freshness-old';

            const radiusStr = rc.maxRadius >= 1000
              ? (rc.maxRadius / 1000).toFixed(1) + ' km'
              : rc.maxRadius + ' m';
            const teamColor = this._sanitizeColor(rc.color);
            const distLines = [];

            // 关注的玩家置顶
            if (follower && players[follower] && players[follower].lat != null && players[follower].lng != null) {
              const p = players[follower];
              const dist = calcDistance({ lat: p.lat, lng: p.lng }, rc.center);
              const pName = p.name || '未知';
              let rangeTag = '';
              if (dist <= rc.maxRadius) rangeTag = ' <span class="tag-inrange">范围内</span>';
              else {
                const fb = Math.max(this._lastAccuracy || 0, 15);
                rangeTag = (dist - fb) <= rc.maxRadius ? ' <span class="tag-maybe">可能范围内</span>' : ' <span class="tag-outside">范围外</span>';
              }
              distLines.push(`<span class="npc-dist-line followed-line"><span class="npc-follow-star" data-player="${this._escapeHtml(follower)}">★</span><span class="npc-dist-player" style="color:${this._sanitizeColor(p.color)}">${this._escapeHtml(pName)}</span> ${formatDistance(dist)}${rangeTag}</span>`);
            }

            Object.values(players).forEach((p) => {
              if (p.id === myInfo.id || !p.online || p.spectator || p.isNpc) return;
              if (p.id === follower) return;
              if (p.lat == null || p.lng == null) return;
              const dist = calcDistance({ lat: p.lat, lng: p.lng }, rc.center);
              const pName = p.name || '未知';
              let rangeTag = '';
              if (dist <= rc.maxRadius) rangeTag = ' <span class="tag-inrange">范围内</span>';
              else {
                const fb = Math.max(this._lastAccuracy || 0, 15);
                rangeTag = (dist - fb) <= rc.maxRadius ? ' <span class="tag-maybe">可能范围内</span>' : ' <span class="tag-outside">范围外</span>';
              }
              const isFollowed = p.id === follower;
              distLines.push(`<span class="npc-dist-line${isFollowed ? ' followed-line' : ''}"><span class="npc-follow-btn${isFollowed ? ' followed' : ''}" data-player="${this._escapeHtml(p.id)}">${isFollowed ? '★' : '☆'}</span><span class="npc-dist-player" style="color:${this._sanitizeColor(p.color)}">${this._escapeHtml(pName)}</span> ${formatDistance(dist)}${rangeTag}</span>`);
            });

            html += `<div class="circle-item remote ${freshnessClass}" data-remote="1" data-remote-idx="${idx}">
              <span class="circle-idx" style="border-color:${teamColor}">R${idx + 1}</span>
              <div class="circle-summary">
                <div class="circle-name">${radiusStr} <span class="circle-created" style="color:${teamColor}">${this._escapeHtml(authorName)}</span></div>
                <div class="circle-meta freshness-indicator ${freshnessClass}">${age < 30000 ? '刚刚' : age < 120000 ? Math.round(age/1000) + '秒前' : Math.round(age/60000) + '分钟前'}</div>
                ${distLines.length ? `<div class="circle-meta npc-dist-list">${distLines.join('')}</div>` : '<div class="circle-meta">暂无位置数据</div>'}
              </div>
            </div>`;
          });
        }
      }
    }
  }

  if (!html) {
    html = `<div class="empty-state">暂无同心圆，点击「绘制圆形」添加</div>`;
  }
  this._circleListEl.innerHTML = html;
  this._circleCountEl.textContent = circles.length;
};
