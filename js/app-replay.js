/**
 * 途刻 TraceCraft - 回放控制模块
 * =============================================
 * 通过 App.prototype.* 挂载到 App（须在 app-core.js 之后加载）：
 *  - _toggleReplay / _startReplay / _stopReplay
 *  - _toggleReplayPlay / _toggleReplayFollow / _setReplaySpeed
 *  - _onReplayProgress / _onReplayFrame / _panToReplayPoint / _onReplayComplete
 *  - _updateReplayUI / _updateReplayInfo
 */

App.prototype._toggleReplay = function () {
  if (this._isReplaying) {
    this._stopReplay();
    Toast.show(' 回放已停止');
    return;
  }

  // 并行模式：允许记录中回放当前已采集的轨迹（回放与记录互不干扰）
  const positions = this._getTrailPositions();
  if (!positions || positions.length < 2) {
    Toast.show(' 轨迹点数不足，无法回放');
    return;
  }

  this._setTab('replay');
  this._startReplay(positions);
};

App.prototype._startReplay = function (positions, trailName) {
  this._isReplaying = true;
  document.body.classList.add('replay-mode');
  this._replayFollowMode = true;

  if (this._replayPlayer) {
    this._replayPlayer.destroy();
    this._replayPlayer = null;
  }

  // 清除地图上残留的普通轨迹线（如加载/清洗历史轨迹留下的 zIndex 10 旧线）。
  // 回放有独立的完整路径视觉体系（zIndex 100+），若旧线数据与回放数据不一致
  //（典型场景：先加载轨迹再清洗，地图旧线是清洗前数据），会与回放路径叠加显示成"双轨迹"。
  // 并行记录模式除外：记录轨迹线继续在后台增量绘制，与回放路径分属不同 zIndex 层。
  if (!(this.trail.isRecording && !this.trail.isPaused)) {
    this.mapManager.clearTrail();
  }

  this._replayPlayer = new TrailPlayer(positions, this.mapManager, {
    onProgress: (progress) => this._onReplayProgress(progress),
    onComplete: () => this._onReplayComplete(),
    onFrame: (point, index) => this._onReplayFrame(point, index)
  });

  // 预计算分段，供回放实时显示当前段；回放有独立视觉体系，清掉关键点标记
  this._replaySegments = TrailAnalysis.analyzeSegments(positions);
  this._replayCurrentIndex = 0;
  this.mapManager.clearTrailMarkers();

  this._replayPlayer.setSpeed(this._replaySpeed);

  // 显示回放面板，隐藏空状态
  const replayPanel = document.getElementById('replay-panel');
  if (replayPanel) {
    replayPanel.classList.remove('hidden');
  }
  const replayEmpty = document.getElementById('replay-empty');
  if (replayEmpty) {
    replayEmpty.classList.add('hidden');
  }
  const replayTitle = document.getElementById('replay-title');
  if (replayTitle) {
    replayTitle.textContent = trailName ? `回放: ${trailName}` : '轨迹回放';
  }

  this._updateReplayUI();

  Toast.show(' 开始轨迹回放');
};

App.prototype._stopReplay = function () {
  this._isReplaying = false;
  document.body.classList.remove('replay-mode');

  if (this._replayPlayer) {
    this._replayPlayer.destroy();
    this._replayPlayer = null;
  }

  this.mapManager.clearRealtimeKeyPoints();

  const replayPanel = document.getElementById('replay-panel');
  if (replayPanel) {
    replayPanel.classList.add('hidden');
  }
  const replayEmpty = document.getElementById('replay-empty');
  if (replayEmpty) {
    replayEmpty.classList.remove('hidden');
  }

  // 恢复真实位置标记
  if (this.myPosition) {
    this.mapManager.setLocation(
      { lat: this.myPosition.lat, lng: this.myPosition.lng },
      this._lastAccuracy || 0,
      this._lastHeading
    );
  }
};

App.prototype._toggleReplayPlay = function () {
  if (!this._replayPlayer) return;

  if (this._replayPlayer.isPlaying) {
    this._replayPlayer.pause();
    // 暂停即解锁追踪：地图不再跟随回放点，用户可自由拖动浏览
    this._replayFollowMode = false;
    // 解锁 GPS 状态栏的跟随按钮：恢复为可操作的定位跟随，刷新按钮状态
    this._followMode = false;
    this._updateStatusBar(true);
  } else {
    // 继续播放时恢复地图跟随
    this._replayFollowMode = true;
    this._replayPlayer.play();
  }

  this._updateReplayUI();
};

/**
 * 切换回放跟随模式：开启时地图中心跟随回放点移动，关闭时自由浏览
 */
App.prototype._toggleReplayFollow = function () {
  if (!this._replayPlayer) return;
  this._replayFollowMode = !this._replayFollowMode;
  // 开启跟随时，立即把地图中心对齐到当前回放点
  if (this._replayFollowMode) {
    const info = this._replayPlayer.getCurrentInfo();
    if (info && info.currentPoint) {
      this._panToReplayPoint(info.currentPoint);
    }
  }
  this._updateReplayUI();
  Toast.show(this._replayFollowMode ? ' 已开启轨迹跟随' : ' 已关闭轨迹跟随（可自由浏览）');
};

App.prototype._setReplaySpeed = function (speed) {
  this._replaySpeed = speed;
  if (this._replayPlayer) {
    this._replayPlayer.setSpeed(speed);
  }
  this._updateReplayUI();
};

App.prototype._onReplayProgress = function (progress) {
  const slider = document.getElementById('replay-slider');
  if (slider && document.activeElement !== slider) {
    slider.value = Math.round(progress * 1000);
  }

  const timeEl = document.getElementById('replay-time');
  if (timeEl && this._replayPlayer) {
    const info = this._replayPlayer.getCurrentInfo();
    const elapsed = TrailPlayer.formatDuration(info.elapsedMs);
    const total = TrailPlayer.formatDuration(info.elapsedMs + info.remainingMs);
    timeEl.textContent = `${elapsed} / ${total}`;
  }

  this._updateReplayInfo();
};

App.prototype._onReplayFrame = function (point, index) {
  this._replayCurrentIndex = index;
  if (this._replayFollowMode && this.mapManager.map) {
    this._panToReplayPoint(point);
  }
};

/**
 * 持续追踪：地图中心每帧跟随回放点（无动画 setCenter，相邻帧位移小则视觉平滑连续）。
 * 不使用带动画的 panTo（每帧调用会互相打断导致地图抖动）。
 */
App.prototype._panToReplayPoint = function (point) {
  const map = this.mapManager.map;
  if (!map || !point) return;
  // 节流到 ~30fps：避免回放 60fps 每帧 setCenter 导致地图频繁重排
  const now = performance.now();
  if (now - (this._lastReplayPanTs || 0) < 33) return;
  this._lastReplayPanTs = now;
  map.setCenter(new qq.maps.LatLng(point.lat, point.lng));
};

App.prototype._onReplayComplete = function () {
  // 回放自然结束：同步解锁追踪模式，地图恢复自由浏览
  this._replayFollowMode = false;
  this._updateReplayUI();
  Toast.show(' 回放完成');
};

App.prototype._updateReplayUI = function () {
  if (!this._replayPlayer) return;

  const playBtn = document.getElementById('replay-play-btn');
  if (playBtn) {
    const isPlaying = this._replayPlayer.isPlaying;
    playBtn.classList.toggle('playing', isPlaying);
    if (isPlaying) {
      playBtn.querySelector('svg').innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    } else {
      playBtn.querySelector('svg').innerHTML = '<polygon points="6,4 20,12 6,20"/>';
    }
  }

  const followBtn = document.getElementById('replay-follow-btn');
  if (followBtn) {
    const on = !!this._replayFollowMode;
    followBtn.classList.toggle('active', on);
    followBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  document.querySelectorAll('.speed-btn').forEach((btn) => {
    btn.classList.toggle('active', parseFloat(btn.dataset.speed) === this._replaySpeed);
  });

  this._updateReplayInfo();
};

App.prototype._updateReplayInfo = function () {
  const infoEl = document.getElementById('replay-info');
  if (!infoEl || !this._replayPlayer) return;

  const info = this._replayPlayer.getCurrentInfo();
  // 钳制到非负：GPS 可能上报负速度，避免回放面板显示负数
  const speedKmh = Math.max(0, info.currentSpeed || 0) * 3.6;
  const direction = bearingToDir(info.currentHeading || 0);
  const elapsed = TrailPlayer.formatDuration(info.elapsedMs);
  const remaining = TrailPlayer.formatDuration(info.remainingMs);
  const seg = TrailAnalysis.segmentAt(this._replaySegments, this._replayCurrentIndex || 0);

  const html = `
    进度: ${elapsed} | 剩余: ${remaining}<br>
    速度: <span class="speed-val">${speedKmh.toFixed(1)} km/h</span> | 方向: ${direction} | 距离: ${formatDistance(info.distance)}<br>
    当前段: <span class="segment-val">${seg ? seg.label : '--'}</span>
  `;
  // 仅在内容变化时更新 DOM，避免每帧重排导致的面板抖动/卡顿
  if (infoEl._lastHtml !== html) {
    infoEl._lastHtml = html;
    infoEl.innerHTML = html;
  }
};
