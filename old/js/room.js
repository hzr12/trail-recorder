/**
 * 多人实时位置共享 — RoomManager
 * ============================================
 * 基于 MQTT over WebSocket 实现设备间位置同步
 * 主用 EMQX 国内节点（腾讯云上海），备用 HiveMQ 公共 Broker
 * 均为免费公共 MQTT 服务，无需注册
 * 消息协议：每个设备发布到自己 topic，订阅房间通配符 topic
 */

const ROOM_CONFIG = {
  // 主用 EMQX 国内节点（腾讯云上海，免注册）
  BROKER_URL: 'wss://broker-cn.emqx.io:8084/mqtt',
  // 备用 Broker 链（按序尝试）：HiveMQ 公共 Broker → Eclipse Mosquitto 公共测试服务
  // 注意：test.mosquitto.org 的加密 WebSocket(8081)在其配置中已被注释禁用，
  //       仅 8080 明文 ws 可用；在 https/本地页面下浏览器会因混合内容拦截 ws://，
  //       故该备用仅在 file:// 直开或 http:// 页面下才真正可达。
  BROKER_FALLBACKS: [
    'wss://broker.mqtt-dashboard.com:8884/mqtt',
    'ws://test.mosquitto.org:8080/',
  ],
  TOPIC_PREFIX: 'circlemap',
  ROOM_CODE_LEN: 6,
  RECONNECT_DELAY: 5000,         // 重连间隔（ms）
  POSITION_INTERVAL: 10000,      // 坐标发布基准间隔（ms）；自适应下限（移动时不短于它）
  POSITION_INTERVAL_MAX: 15000,  // 自适应：静止时的下发间隔上限（到点后最多 15s 发一次）
  POS_STILL_SPEED: 0.5,          // 低于此速度(m/s)视为静止 → 用最长间隔
  POS_FAST_SPEED: 3,             // 高于此速度(m/s)视为快速移动 → 用基准间隔
  HEARTBEAT_INTERVAL: 15000,     // 心跳保活间隔（ms），二进制 ping 维持在线 + 发报员选举
  PRESENCE_INTERVAL: 30000,       // 在场广播间隔（ms），低频回填静态身份
  OFFLINE_GRACE_MS: 60000,        // 离线宽限（ms）：收到 offline 后不立即删除，宽限期内收到任意消息视为「没真走」
  NPC_POSITION_INTERVAL: 60000,  // NPC 队坐标发布间隔（ms），持续共享（1 分钟/次）
  HOST_CLAIM_TIMEOUT: 5000,     // 加入房间后多久未同步到房主 → 自动接管成为新房主（ms）
  CONNECT_TIMEOUT: 20000,        // MQTT connectTimeout（ms），等 CONNACK
  MAX_RETRY: 5,                  // 连续失败几次后切备用 Broker
  PLAYER_COLORS: [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
    '#DDA0DD', '#FFD93D', '#6BCB77', '#FF8C94',
  ],
};

/**
 * 生成随机房间码（大写字母 + 数字）
 */
function _generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < ROOM_CONFIG.ROOM_CODE_LEN; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/**
 * 获取随机玩家颜色
 */
function _pickColor(seed) {
  const colors = ROOM_CONFIG.PLAYER_COLORS;
  let idx;
  if (seed != null) {
    let hash = 0;
    for (let i = 0; i < String(seed).length; i++) {
      hash = ((hash << 5) - hash) + String(seed).charCodeAt(i);
      hash |= 0;
    }
    idx = Math.abs(hash) % colors.length;
  } else {
    idx = Math.floor(Math.random() * colors.length);
  }
  return colors[idx];
}

class RoomManager {
  constructor() {
    this._client = null;
    this._deviceId = this._getDeviceId();
    this._roomCode = null;
    this._nickname = '玩家';
    this._color = '#FF6B6B';
    this._connected = false;

    /** @type {Object.<string, {id:string, name:string, color:string, lat:number, lng:number, acc:number, speed:number, bearing:number, ts:number, online:boolean, sharing:boolean, teamId:string|null, teamBroadcaster:boolean, teamSeparation:boolean}>} */
    this._players = {};

    /** @type {Object.<string, {id:string, name:string, color:string, creatorId:string}>} */
    this._teams = {};
    this._myTeamId = null;

    // 队伍发报员模式
    this._teamBroadcasterId = null;  // 当前发报员 deviceId
    this._lastBroadcastTs = 0;       // 上次收到发报心跳的时间戳
    this._myAmBroadcaster = false;   // 我是不是发报员
    this._teamSeparation = false;    // 我是否从发报员分离

    this._posTimer = null;          // 自适应位置定时器（setTimeout 自调度）
    this._heartbeatTimer = null;    // 心跳定时器（setInterval）
    this._presenceTimer = null;     // 在场广播定时器（setInterval）
    this._npcTimer = null;          // NPC 队强制共享定时器（setInterval）
    this._offlineTimers = {};       // 离线宽限定时器（id → setTimeout），防抖避免抖动/重加闪烁

    // 玩家更新合并（H1）：微任务级合并，同一 tick 内多次变更只触发一次 onPositionUpdate 回调
    this._updateScheduled = false;
    this._changedPlayers = new Set(); // 自上次通知以来变更的玩家 ID

    this._lastPosition = null;      // 最近一次 GPS 坐标
    this._lastSentPos = null;       // 最近一次实际下发的坐标（自适应位移判定用）
    this._lastSentSpeed = null;     // 最近一次下发时的速度（静止→移动 瞬间判定用）
    this._sharingEnabled = false;     // 默认关闭，可由共享定位开关 / 统一开始开启

    // 其他玩家同步过来的圆（多人可见）：key = `${author}:${cid}`
    this._remoteCircles = {};
    this._remoteCircleTimers = {};  // key → setTimeout id，10分钟后自动删除
    this._pendingPlayerTeams = {};  // 重加入时缓存的玩家-队伍映射，玩家到位后回填

    // 位置共享（静默/共享交替）
    this._burstEnabled = false;
    this._burstSilentMin = 25;       // 静默时长（分钟）
    this._burstShareMin = 5;         // 共享时长（分钟）
    this._burstPhase = 'silent';     // 'silent' | 'sharing'
    this._burstPhaseEnd = 0;         // 当前阶段结束时间戳
    this._burstTimer = null;
    this._burstSeq = 0;              // 阶段序号（发起者权威同步，客户端按 seq 采纳，零时间运算）
    this._burstPublishTimer = null;  // 阶段周期性重发定时器（仅发起者，10s）
    this._burstEndAt = 0;            // 共享会话结束时间戳，0=未设置
    this._burstEndTimer = null;      // 会话结束定时器（仅发起者）

    // 观战模式
    this._isSpectator = false;

    // MQTT 5.0 / topicAlias 状态
    this._mqttVersion = 5;            // 尝试的协议版本（5=MQTT 5.0, 4=3.1.1）
    this._topicAliases = {};          // topic → alias number
    this._topicAliasRegistered = null; // Set: 已向 broker 注册别名的 topic
    this._topicAliasMax = 0;          // broker 返回的 topicAliasMaximum

    // 统一开始倒计时
    this._gameStartAt = 0;           // 开始时间戳，0=未设置
    this._gameTimerAborted = false;

    // 房主身份
    this._isHost = false;            // 创建房间的玩家为房主
    this._hostId = null;             // 当前房主 deviceId（房主离线后自动迁移）
    this._hostClaimTimer = null;     // 加入后无房主自荐定时器
    this._retryTimer = null;         // Broker 降级/切换的重试定时器（需随销毁清理）

    // 设备健康信息（由 app 层注入）
    this._batteryLevel = 1;
    this._batteryCharging = false;

    // 回调钩子
    this.onPositionUpdate = null;   // (players) → void
    this.onPlayerJoin = null;       // (playerId, nickname) → void
    this.onPlayerLeave = null;      // (playerId, nickname) → void
    this.onTeamUpdate = null;       // (teams, myTeamId) → void
    this.onRoomError = null;        // (msg) → void
    this.onConnectionChange = null; // (connected) → void
    this.onBurstPhaseChange = null; // (phase, phaseEnd) → void
    this.onBurstEndChange = null;   // (endAt) → void，共享会话结束时间变化（0=清除）
    this.onBurstEnded = null;       // () → void，共享会话结束（本地清理完成后）
    this.onGameTimerUpdate = null;  // (startAt) → void
    this.onGameTimerAborted = null; // () → void
    this.onCircleSync = null;       // (circles[]) → void，其他玩家的圆变更
    this.onHostChange = null;       // (hostId) → void，房主变更（含接管）
    this.onRequestCircles = null;   // () → void，新玩家请求同步圆
  }

  // ════════════════════════════════════════════════════════════
  //  内部辅助（H1/H2 优化）
  // ════════════════════════════════════════════════════════════

  /**
   * H2: 获取/创建玩家对象 — 去重 _onPositionMsg / _onPingMsg / _onPresenceMsg
   * 三段重复的默认字段 + { ...existing } 浅拷贝。
   * 若玩家已存在则就地更新（避免旧引用），不存在则用默认值初始化。
   */
  _ensurePlayer(id) {
    if (this._players[id]) return this._players[id];
    const p = {
      id, name: '未知', color: '#888', online: true, sharing: true,
      teamId: null, teamBroadcaster: false, teamSeparation: false,
      spectator: false, isNpc: false, _lastSeen: 0,
    };
    this._players[id] = p;
    return p;
  }

  /**
   * H1: 安排一次 onPositionUpdate 回调（同一 tick 内合并）
   * 使用微任务（Promise.resolve().then）将同一 tick 内多次变更合并为一次全量通知。
   * 若传入 changedId，则跟踪变更玩家，回调第二参数为 changedIds Set，便于消费者增量重绘。
   * @param {string} [changedId] 发生变更的玩家 ID（可选）
   */
  _schedulePositionUpdate(changedId) {
    if (!this.onPositionUpdate) return;
    if (changedId) this._changedPlayers.add(changedId);
    if (this._updateScheduled) return;
    this._updateScheduled = true;
    Promise.resolve().then(() => {
      if (!this._updateScheduled) return;
      this._updateScheduled = false;
      const changed = this._changedPlayers;
      this._changedPlayers = new Set();
      this.onPositionUpdate({ ...this._players }, changed.size ? changed : null);
    });
  }

  /**
   * 生成/恢复设备 ID（localStorage 持久化）
   */
  _getDeviceId() {
    try {
      let id = localStorage.getItem('circlemap_device_id');
      if (!id) {
        id = crypto.randomUUID ? crypto.randomUUID() : 'd' + Date.now() + Math.random().toString(36).slice(2, 8);
        localStorage.setItem('circlemap_device_id', id);
      }
      return id;
    } catch (e) {
      return 'd' + Date.now() + Math.random().toString(36).slice(2, 8);
    }
  }

  /**
   * 连接 MQTT Broker
   * @returns {Promise<void>}
   */
  _connect() {
    return new Promise((resolve, reject) => {
      if (this._client && this._connected) {
        resolve();
        return;
      }

      // 清理旧连接
      this._disconnect();

      // MQTT 5.0 / topicAlias 状态重置
      this._mqttVersion = 5;
      this._topicAliases = {};
      this._topicAliasRegistered = new Set();
      this._topicAliasMax = 0;

      // 生成短 Client ID（< 23 字符，兼容 MQTT 3.1.1）
      const shortId = 'cm' + Math.random().toString(36).slice(2, 10);

      // 尝试主用 Broker；失败时按 BROKER_FALLBACKS 顺序依次尝试
      this._tryConnect(ROOM_CONFIG.BROKER_URL, ROOM_CONFIG.BROKER_FALLBACKS.slice(), shortId, resolve, reject);
    });
  }

  /**
   * 尝试连接指定 Broker（失败时按 fallbacks 数组依次尝试下一个）
   * @param {string} brokerUrl 当前要连接的 Broker URL
   * @param {string[]} fallbacks 剩余备用 Broker URL 列表（会被 shift 消费）
   */
  _tryConnect(brokerUrl, fallbacks, clientId, resolve, reject) {
    const discarded = { current: false };
    let errCount = 0;
    let lastErr = null;
    const isMqtt5 = (this._mqttVersion === 5);

    if (CONFIG.DEBUG) console.log('[Room] 正在连接 MQTT:', brokerUrl, 'protocol:', isMqtt5 ? '5.0' : '3.1.1', 'clientId:', clientId);

    try {
      // 遗嘱消息（Last-Will）：异常断开时 Broker 代发离线通知
      const willTopic = this._roomCode
        ? `${ROOM_CONFIG.TOPIC_PREFIX}/${this._roomCode}/${this._deviceId}`
        : null;

      const connectOpts = {
        clientId,
        clean: true,
        reconnectPeriod: ROOM_CONFIG.RECONNECT_DELAY,
        connectTimeout: ROOM_CONFIG.CONNECT_TIMEOUT,
        keepalive: 120,
        wsOptions: { perMessageDeflate: true },
      };

      // MQTT 5.0 连接选项
      if (isMqtt5) {
        connectOpts.protocolVersion = 5;
        connectOpts.properties = {};
      }

      if (willTopic) {
        connectOpts.will = {
          topic: willTopic,
          payload: JSON.stringify({ id: this._deviceId, offline: true }),
          qos: 1,
          retain: false,
        };
        if (isMqtt5) {
          connectOpts.will.properties = {};
        }
      }

      this._client = mqtt.connect(brokerUrl, connectOpts);

      this._client.on('connect', (connack) => {
        if (discarded.current) return;

        // MQTT 5.0: 检查 CONNACK reasonCode
        if (isMqtt5 && connack && connack.reasonCode && connack.reasonCode !== 0) {
          if (CONFIG.DEBUG) console.log('[Room] MQTT 5.0 CONNACK 拒绝 reasonCode:', connack.reasonCode, '→ 降级到 3.1.1');
          this._mqttVersion = 4;
          this._topicAliasMax = 0;
          discarded.current = true;
          this._client.end(true);
          this._retryTimer = setTimeout(() => {
            this._tryConnect(brokerUrl, fallbacks, clientId, resolve, reject);
          }, 100);
          return;
        }

        discarded.current = true;
        this._connected = true;

        // topicAlias 仅在单条连接内有效：重连后注册表必须重建，
        // 否则沿用旧 alias 编号发空 topic 会被 Broker 当作协议错误丢弃
        this._topicAliases = {};
        this._topicAliasRegistered = new Set();

        // 重连场景：恢复订阅 + 重新宣告在线 + 请求全量同步
        if (this._roomCode) {
          this._subscribeRoom(this._roomCode);
          this._publishPresence();
          this._publish({ join: 1 });
          this._publish({ type: 'request_state' });
          // 断线重连：房主恢复 burst 会话推进（离线期阶段定时器已过期，重新对齐）
          if (this._isHost && this._burstEnabled) this._resumeBurstOwner();
        }

        // 提取 topicAliasMaximum（MQTT 5.0 CONNACK 属性）
        if (isMqtt5 && connack && connack.properties) {
          this._topicAliasMax = connack.properties.topicAliasMaximum || 0;
          if (this._topicAliasMax > 0) {
            if (CONFIG.DEBUG) console.log('[Room] MQTT 5.0 连接成功，topicAliasMaximum:', this._topicAliasMax);
          }
        }

        if (this.onConnectionChange) this.onConnectionChange(true);
        resolve();
      });

      this._client.on('reconnect', () => {
        if (CONFIG.DEBUG) console.log('[Room] MQTT 重连中...');
      });

      this._client.on('close', () => {
        if (discarded.current) return; // 已被降级/切换流程放弃的旧连接，事件不再处理
        this._connected = false;
        if (this.onConnectionChange) this.onConnectionChange(false);
      });

      this._client.on('offline', () => {
        if (discarded.current) return; // 同上：切换 Broker 期间旧连接事件会污染状态
        this._connected = false;
        if (this.onConnectionChange) this.onConnectionChange(false);
      });

      // 累计错误次数：MQTT 5.0 首次失败立即降级到 3.1.1（不计入 MAX_RETRY）
      this._client.on('error', (err) => {
        if (discarded.current) return;
        errCount++;

        // MQTT 5.0 连接失败 → 立即降级到 3.1.1，重试同一 Broker
        if (isMqtt5 && errCount === 1) {
          if (CONFIG.DEBUG) console.log('[Room] MQTT 5.0 连接失败:', err && err.message, '→ 降级到 3.1.1');
          this._mqttVersion = 4;
          this._topicAliasMax = 0;
          discarded.current = true;
          this._disconnect(true);
          this._retryTimer = setTimeout(() => {
            this._tryConnect(brokerUrl, fallbacks, clientId, resolve, reject);
          }, 100);
          return;
        }

        lastErr = err;
        console.error(`[Room] MQTT 错误 (${errCount}/${ROOM_CONFIG.MAX_RETRY}):`, err && err.message);

        if (errCount >= ROOM_CONFIG.MAX_RETRY) {
          discarded.current = true;

          if (!fallbacks || fallbacks.length === 0) {
            reject(new Error(this._formatMqttError(err, `已尝试所有 Broker，连续失败 ${ROOM_CONFIG.MAX_RETRY} 次`)));
            return;
          }

          // 当前 Broker 失败后给出明确提示再切下一个备用
          const next = fallbacks.shift();
          if (this.onRoomError) this.onRoomError(this._formatMqttError(err) + '，正在尝试备用服务器…');
          if (CONFIG.DEBUG) console.log(`[Room] 当前 Broker 连续失败 ${ROOM_CONFIG.MAX_RETRY} 次，切换到备用:`, next);
          this._disconnect(true);
          this._tryConnect(next, fallbacks, clientId, resolve, reject);
        }
      });

      this._client.on('message', (topic, payload) => {
        if (discarded.current) return; // 旧连接消息丢弃，避免切换期间状态污染
        this._handleMessage(topic, payload);
      });

    } catch (e) {
      // 连接抛出同步异常 → 尝试下一个备用
      if (fallbacks && fallbacks.length > 0) {
        const next = fallbacks.shift();
        if (CONFIG.DEBUG) console.log('[Room] 当前 Broker 异常，尝试备用:', next);
        this._disconnect(true);
        this._tryConnect(next, fallbacks, clientId, resolve, reject);
      } else {
        reject(new Error(this._formatMqttError(e)));
      }
    }
  }

  /**
   * 将 MQTT 底层错误转换为中文可读提示
   * 区分「握手失败/不可达」与「超时」等常见情况
   * @param {Error} err 原始错误
   * @param {string} [suffix] 附加说明（如重试次数），拼在括号里
   * @returns {string}
   */
  _formatMqttError(err, suffix) {
    const msg = (err && err.message) || '';
    let friendly = '房间服务连接失败';
    if (msg.includes('WebSocket is closed') || (msg.includes('close') && msg.includes('connect'))) {
      friendly = '无法连接房间服务（WebSocket 握手失败），请检查网络或防火墙是否拦截 8084/8884 端口';
    } else if (msg.includes('timeout') || msg.includes('Timeout')) {
      friendly = '连接房间服务超时，请检查网络后重试';
    } else if (msg.includes('refused') || msg.includes('ECONNREFUSED')) {
      friendly = '房间服务拒绝连接（可能已满或限流）';
    } else if (msg) {
      friendly = '房间服务连接失败：' + msg;
    }
    return suffix ? `${friendly}（${suffix}）` : friendly;
  }

  /**
   * 断开连接
   */
  _disconnect(isBrokerFailover = false) {
    this._stopPublishing();
    // Broker failover 时保留 burst 状态（定时器已随旧连接停止，重连后重建）
    if (!isBrokerFailover) {
      this._endBurstSession();
    }
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this._client) {
      try {
        this._client.end(true);
      } catch (e) { /* 静默 */ }
      this._client = null;
    }
    this._connected = false;
    this._topicAliases = {};
    this._topicAliasRegistered = null;
    this._topicAliasMax = 0;
  }

  /**
   * 处理接收到的 MQTT 消息
   */
  _handleMessage(topic, payload) {
    try {
      // 从 topic 提取发送者 deviceId：circlemap/<room>/<id>[/pos|/ping]
      const parts = topic.split('/');
      const senderId = parts[2];

      // 二进制坐标（…/<id>/pos）
      if (topic.endsWith('/pos')) {
        try { this._onPositionMsg(senderId, this._decodePos(payload)); }
        catch (e) { console.warn('[Room] pos 解码/处理失败:', topic, e); }
        return;
      }
      // 二进制心跳（…/<id>/ping）
      if (topic.endsWith('/ping')) {
        try { this._onPingMsg(senderId, this._decodePing(payload)); }
        catch (e) { console.warn('[Room] ping 解码/处理失败:', topic, e); }
        return;
      }
      // 二进制在场（…/<id>/presence）
      if (topic.endsWith('/presence')) {
        try { this._onPresenceMsg(senderId, this._decodePresence(payload)); }
        catch (e) { console.warn('[Room] presence 解码/处理失败:', topic, e); }
        return;
      }
      // 二进制圆同步（…/<id>/circle）
      if (topic.endsWith('/circle')) {
        try { this._onCircleMsg(senderId, this._decodeCircle(payload)); }
        catch (e) { console.warn('[Room] circle 解码/处理失败:', topic, e); }
        return;
      }

      const data = JSON.parse(payload.toString());

      // === 队伍控制消息 ===
      if (data.type === 'team_create') {
        this._teams[data.teamId] = {
          id: data.teamId,
          name: data.teamName,
          color: data.teamColor,
          creatorId: data.id,
          isNpc: data.isNpc === true,
        };
        if (this._players[data.id]) {
          this._players[data.id].teamId = data.teamId;
        }
        if (this.onTeamUpdate) this.onTeamUpdate({ ...this._teams }, this._myTeamId);
        this._schedulePositionUpdate();
        return;
      }

      if (data.type === 'team_join') {
        if (this._players[data.id]) {
          this._players[data.id].teamId = data.teamId;
        }
        if (this.onTeamUpdate) this.onTeamUpdate({ ...this._teams }, this._myTeamId);
        this._schedulePositionUpdate();
        return;
      }

      if (data.type === 'team_leave') {
        if (this._players[data.id]) {
          this._players[data.id].teamId = null;
        }
        if (this.onTeamUpdate) this.onTeamUpdate({ ...this._teams }, this._myTeamId);
        this._schedulePositionUpdate();
        return;
      }

      if (data.type === 'team_kick') {
        const team = this._teams[data.teamId];
        if (team && team.creatorId === data.id) {
          if (this._players[data.targetId]) {
            this._players[data.targetId].teamId = null;
          }
          if (data.targetId === this._deviceId) {
            this._myTeamId = null;
          }
          if (this.onTeamUpdate) this.onTeamUpdate({ ...this._teams }, this._myTeamId);
          this._schedulePositionUpdate();
        }
        return;
      }

      // 统一开始倒计时消息
      if (data.type === 'game_timer_set') {
        this._gameStartAt = data.startAt;
        this._gameTimerAborted = false;
        if (this.onGameTimerUpdate) this.onGameTimerUpdate(data.startAt);
        return;
      }

      if (data.type === 'game_timer_abort') {
        this._gameStartAt = 0;
        this._gameTimerAborted = true;
        if (this.onGameTimerAborted) this.onGameTimerAborted();
        return;
      }

      // === 房主接管仲裁 ===
      // 房主离线/加入无主房间时的迁移：deviceId 小者胜，并发宣布时收敛到唯一房主
      if (data.type === 'host_elect') {
        if (data.id === this._deviceId) return;   // 自己回声
        const hid = data.hostId;
        if (!hid) return;
        if (this._isHost) {
          // 双方都是房主（并发宣布）→ 小者胜
          if (hid < this._deviceId) {
            this._isHost = false;
            this._hostId = hid;
            if (this.onHostChange) this.onHostChange(hid);
          }
          return;
        }
        if (this._hostId !== hid) {
          this._hostId = hid;
          if (this.onHostChange) this.onHostChange(hid);
        }
        return;
      }

      // === 位置共享周期阶段同步 ===
      // 阶段由发起者权威推进（附单调 seq），客户端按 seq 采纳状态，不做跨时钟时间运算，
      // 彻底消除设备时钟偏差导致的阶段错位 → 单向可见
      if (data.type === 'burst_phase') {
        if (data.id === this._deviceId) return;
        const seq = data.burstSeq || 0;
        if (data.burstEnabled === false) {
          if (seq >= this._burstSeq) {
            this._burstSeq = seq;
            this._stopBurstLocal();
          }
          return;
        }
        if (!data.burstPhase) return;
        if (seq < this._burstSeq) return;   // 旧消息回放，忽略
        const wasSharing = this._burstEnabled && this._burstPhase === 'sharing';
        this._burstSeq = seq;
        this._burstEnabled = true;
        this._burstPhase = data.burstPhase;
        this._burstPhaseEnd = data.burstPhaseEnd || 0;
        if (this.onBurstPhaseChange) this.onBurstPhaseChange(this._burstPhase, this._burstPhaseEnd);
        // 采纳「共享中」立即补发一次，让对方马上看到自己
        if (!wasSharing && this._burstPhase === 'sharing' && this._shouldSendPosition()) this._publishPosition();
        return;
      }

      // === 统一开始（房主广播）：全员自动开启共享定位 + 爆发周期 ===
      if (data.type === 'burst_start') {
        if (data.id === this._deviceId) return;
        this.setSharingEnabled(true);
        // 时长钳制 [1,240] 分钟：远程值不可信，防野值撑爆阶段定时器
        this._burstSilentMin = Math.min(240, Math.max(1, data.silent || 25));
        this._burstShareMin = Math.min(240, Math.max(1, data.share || 5));
        if (Number.isFinite(data.endAt) && data.endAt !== this._burstEndAt) {
          this._burstEndAt = data.endAt || 0;
          if (this.onBurstEndChange) this.onBurstEndChange(this._burstEndAt);
        }
        // 阶段由随后 burst_phase 消息接管（QoS1 保序）
        return;
      }

      // === 共享会话结束时间同步 ===
      if (data.type === 'burst_end_set') {
        if (data.id === this._deviceId) return;
        if (data.endAt !== this._burstEndAt) {
          this._burstEndAt = data.endAt || 0;
          if (this.onBurstEndChange) this.onBurstEndChange(this._burstEndAt);
        }
        return;
      }

      // === 共享会话结束（发起者到点/终止广播）===
      if (data.type === 'burst_end') {
        if (data.id === this._deviceId) return;
        if ((data.seq || 0) >= this._burstSeq) {
          this._burstSeq = data.seq || 0;
          this._endBurstSession();
        }
        return;
      }

      // 房间状态请求：新玩家加入时请求同步完整状态
      if (data.type === 'request_state') {
        this._broadcastFullState();
        if (this.onRequestCircles) this.onRequestCircles();
        return;
      }

      // 房间状态同步：收到后重建队伍、统一开始、共享会话等信息
      if (data.type === 'room_state') {
        if (data.id === this._deviceId) return;
        // 重建队伍
        if (data.teams) {
          for (const [teamId, team] of Object.entries(data.teams)) {
            if (!this._teams[teamId]) {
              this._teams[teamId] = team;
            }
          }
          if (this.onTeamUpdate) this.onTeamUpdate({ ...this._teams }, this._myTeamId);
        }
        // 重建玩家-队伍分配
        if (data.playerTeams) {
          for (const [playerId, teamId] of Object.entries(data.playerTeams)) {
            if (this._players[playerId]) {
              this._players[playerId].teamId = teamId;
              this._players[playerId].isNpc = (this._teams[teamId] && this._teams[teamId].isNpc) || false;
              delete this._pendingPlayerTeams[playerId];
            }
          }
          // 缓存尚未到位的玩家队伍，待 position/presence 到达时回填
          const pending = {};
          for (const [playerId, teamId] of Object.entries(data.playerTeams)) {
            if (!this._players[playerId]) pending[playerId] = teamId;
          }
          this._pendingPlayerTeams = pending;
          this._schedulePositionUpdate();
        }
        // 同步房主的位置共享设定
        if (data.burstSilent != null) this._burstSilentMin = Math.max(1, data.burstSilent);
        if (data.burstShare != null) this._burstShareMin = Math.max(1, data.burstShare);
        // 同步共享/burst 状态（按 seq 采纳，防旧状态覆盖新会话）
        if (data.burstSeq != null && data.burstSeq >= this._burstSeq) {
          this._burstSeq = data.burstSeq;
          if (data.sharingEnabled != null) this._sharingEnabled = data.sharingEnabled;
          if (data.burstEnabled != null) this._burstEnabled = data.burstEnabled;
          if (data.burstPhase) this._burstPhase = data.burstPhase;
          if (data.burstPhaseEnd) this._burstPhaseEnd = data.burstPhaseEnd;
        }
        // 同步共享会话结束时间
        if (data.burstEndAt != null && data.burstEndAt !== this._burstEndAt) {
          this._burstEndAt = data.burstEndAt;
          if (this.onBurstEndChange) this.onBurstEndChange(this._burstEndAt);
        }
        // 同步房主身份（新加入者据此得知房主，超时自荐不触发）
        if (data.hostId) this._hostId = data.hostId;
        // 重建统一开始倒计时（说明倒计时已设但未开始）
        if (data.gameStartAt) {
          this._gameStartAt = data.gameStartAt;
          if (this.onGameTimerUpdate) this.onGameTimerUpdate(data.gameStartAt);
        }
        return;
      }

      // 离线消息（含 Broker 代发的遗嘱）：先进入宽限，避免网络抖动 / 刷新重加导致的闪烁
      if (data.offline) {
        this._schedulePendingOffline(data.id);
        return;
      }

      // 加入消息（携带 name/color，触发 onPlayerJoin）
      if (data.id && data.id !== this._deviceId && data.join != null) {
        this._cancelPendingOffline(data.id);
        const existing = this._players[data.id];
        const isNew = !existing;
        const player = this._ensurePlayer(data.id);
        if (data.name) player.name = data.name;
        if (data.color) player.color = data.color;
        player.online = true;
        if (data.teamId) player.teamId = data.teamId;
        player.isNpc = (this._teams[player.teamId] && this._teams[player.teamId].isNpc) || false;
        if (isNew && this.onPlayerJoin) this.onPlayerJoin(data.id, player.name);
        this._schedulePositionUpdate(data.id);
        return;
      }
    } catch (e) {
      console.warn('[Room] 消息处理失败:', topic, e);
    }
  }

  /**
   * 离开房间
   */
  leaveRoom() {
    // 发送离线遗言
    if (this._client && this._connected && this._roomCode) {
      this._publish({
        offline: true,
        name: this._nickname,
      });
    }

    // 取消订阅
    if (this._client && this._roomCode) {
      try {
        this._client.unsubscribe(`${ROOM_CONFIG.TOPIC_PREFIX}/${this._roomCode}/#`);
      } catch (e) { /* 静默 */ }
    }

    this._stopPublishing();
    this._endBurstSession(); // 仅本地清理，不广播（离开房间不影响他人会话）
    if (this._hostClaimTimer) {
      clearTimeout(this._hostClaimTimer);
      this._hostClaimTimer = null;
    }
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this._roomCode = null;
    this._players = {};
    this._lastPosition = null;
    this._lastSentPos = null;
    this._lastSentSpeed = null;
    this._teams = {};
    this._myTeamId = null;
    this._remoteCircles = {};  // 清除其他玩家同步的圆
    // 清除远程圆过期定时器
    Object.values(this._remoteCircleTimers).forEach(t => clearTimeout(t));
    this._remoteCircleTimers = {};
    this._pendingPlayerTeams = {};
    this._backgroundMode = false;
    // 重置发报员状态
    this._teamBroadcasterId = null;
    this._lastBroadcastTs = 0;
    this._myAmBroadcaster = false;
    this._teamSeparation = false;
    this._isSpectator = false;
    this._gameStartAt = 0;
    this._gameTimerAborted = false;
    this._isHost = false;
    this._hostId = null;
  }

  /**
   * 订阅房间主题
   */
  _subscribeRoom(roomCode) {
    if (!this._client) return;
    const topic = `${ROOM_CONFIG.TOPIC_PREFIX}/${roomCode}/#`;
    this._client.subscribe(topic, { qos: 1 }, (err) => {
      if (err) {
        console.error('[Room] 订阅失败:', err);
        if (this.onRoomError) this.onRoomError('订阅房间失败');
      }
    });
  }

  /**
   * 发布消息到自己的 topic
   */
  _publish(data) {
    if (!this._client || !this._connected || !this._roomCode) return;
    const topic = `${ROOM_CONFIG.TOPIC_PREFIX}/${this._roomCode}/${this._deviceId}`;
    const msg = {
      ...data,
      id: this._deviceId,
      name: this._nickname,
      color: this._color,
      ts: Date.now(),
    };
    if (this._myTeamId) msg.teamId = this._myTeamId;
    if (this._myAmBroadcaster) msg.teamBroadcaster = true;
    if (this._teamSeparation) msg.teamSeparation = true;
    if (this._isSpectator) msg.spectator = true;
    if (this._isNpcTeam()) msg.isNpc = true;
    this._publishWithAlias(topic, JSON.stringify(msg), { qos: 1, retain: false });
  }

  // ============================================================
  //  接收：坐标 / 心跳（二进制）
  // ============================================================

  _onPositionMsg(senderId, pos) {
    if (senderId === this._deviceId) return;
    this._cancelPendingOffline(senderId);
    const existing = this._players[senderId];
    const isNew = !existing;
    const player = this._ensurePlayer(senderId);
    // 重加入竞态：新玩家到位时回填 room_state 中缓存的队伍
    if (!existing && this._pendingPlayerTeams[senderId]) {
      player.teamId = this._pendingPlayerTeams[senderId];
      delete this._pendingPlayerTeams[senderId];
    }
    player.ts = pos.ts || Date.now();
    player.online = true;
    player.lat = pos.lat;
    player.lng = pos.lng;
    player.acc = pos.acc || 0;
    player.speed = pos.speed || 0;
    player.bearing = pos.bearing || 0;
    player.lastPosUpdate = Date.now();
    player.isNpc = (this._teams[player.teamId] && this._teams[player.teamId].isNpc) || false;
    player._lastSeen = Date.now();
    if (isNew && this.onPlayerJoin) this.onPlayerJoin(senderId, player.name);
    // 新玩家（名字为默认"未知"）不触发 UI 更新，等加入/在场消息带来名字后再更新
    if (!isNew) this._schedulePositionUpdate(senderId);
  }

  _onPingMsg(senderId, flags) {
    if (senderId === this._deviceId) return;
    this._cancelPendingOffline(senderId);
    const existing = this._players[senderId];
    const isNew = !existing;
    const player = this._ensurePlayer(senderId);
    player.online = true;
    player.sharing = flags.sharing;
    player.spectator = flags.spectator;
    player.teamBroadcaster = flags.teamBroadcaster;
    player.teamSeparation = flags.teamSeparation;
    if (flags.batteryLevel != null) player.batteryLevel = flags.batteryLevel;
    if (flags.charging != null) player.charging = flags.charging;
    // 房主身份同步：双房主并存（并发接管/重连竞态）按 deviceId 小者胜收敛；
    // 无条件让位会让双方都让位 → 房间无人为房主
    if (flags.host && senderId !== this._deviceId) {
      if (this._isHost) {
        if (senderId < this._deviceId) {
          this._isHost = false;
          this._hostId = senderId;
          if (this.onHostChange) this.onHostChange(senderId);
        }
        // else: 我们保持host，不改变_hostId
      } else {
        this._hostId = senderId;
        if (this.onHostChange) this.onHostChange(senderId);
      }
    }
    // 队伍发报员选举（原 pos 分支逻辑迁移）
    if (player.teamId === this._myTeamId && flags.teamBroadcaster) {
      this._teamBroadcasterId = senderId;
      this._myAmBroadcaster = false;
      this._lastBroadcastTs = Date.now();
    }
    player._lastSeen = Date.now();
    if (isNew && this.onPlayerJoin) this.onPlayerJoin(senderId, player.name);
    // 新玩家（名字为默认"未知"）不触发 UI 更新，等加入/在场消息带来名字后再更新
    if (!isNew) this._schedulePositionUpdate(senderId);
  }

  // 在场消息：低频回填静态身份（name/color/teamId/spectator/isNpc）
  _onPresenceMsg(senderId, p) {
    if (senderId === this._deviceId) return;
    this._cancelPendingOffline(senderId);
    const player = this._ensurePlayer(senderId);
    // 不覆盖名字和颜色（保留首次收到时的值，避免后续空值覆盖）
    if (p.name) player.name = p.name;
    if (p.color) player.color = p.color;
    player.teamId = p.teamId || player.teamId || null;
    // 重加入竞态：无 teamId 时回填 room_state 中缓存的队伍（回填后即删除，防泄漏）
    if (!player.teamId && this._pendingPlayerTeams[senderId]) {
      player.teamId = this._pendingPlayerTeams[senderId];
      delete this._pendingPlayerTeams[senderId];
    }
    player.spectator = p.spectator === true;
    player.isNpc = (this._teams[player.teamId] && this._teams[player.teamId].isNpc) || p.isNpc === true;
    player._lastSeen = Date.now();
    this._schedulePositionUpdate(senderId);
  }

  // ============================================================
  //  二进制编解码（零依赖，DataView）
  // ============================================================

  _asDataView(payload) {
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(payload)) {
      return new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    }
    if (payload instanceof ArrayBuffer) return new DataView(payload);
    if (payload instanceof Uint8Array) {
      return new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    }
    return new DataView(payload.buffer || payload);
  }

  // 位置包 21 字节：lat/lng Int32(×1e6)，acc Uint32(米)，speed Uint16(×100)，brg Uint16(×100)，ts Uint32(秒)，flags Uint8
  _encodePos(p) {
    const buf = new ArrayBuffer(21);
    const dv = new DataView(buf);
    dv.setInt32(0, Math.round(p.lat * 1e6), true);
    dv.setInt32(4, Math.round(p.lng * 1e6), true);
    dv.setUint32(8, Math.max(0, Math.min(0xFFFFFFFF, Math.round(p.acc || 0))), true);
    dv.setUint16(12, Math.max(0, Math.min(65535, Math.round((p.speed || 0) * 100))), true);
    dv.setUint16(14, Math.max(0, Math.min(65535, Math.round((p.bearing || 0) * 100))), true);
    dv.setUint32(16, Math.floor((p.ts || Date.now()) / 1000), true);
    dv.setUint8(20, 1);
    return new Uint8Array(buf);
  }

  _decodePos(payload) {
    const dv = this._asDataView(payload);
    return {
      lat: dv.getInt32(0, true) / 1e6,
      lng: dv.getInt32(4, true) / 1e6,
      acc: dv.getUint32(8, true),
      speed: dv.getUint16(12, true) / 100,
      bearing: dv.getUint16(14, true) / 100,
      ts: dv.getUint32(16, true) * 1000,
    };
  }

  // 心跳包 4 字节：bit0-3 flags (sharing/broadcaster/separation/spectator), bit4=charging, bit5=host, 保留 bit6-7
  //   字节 1-2 预留给信号强度/延迟（未用）
  //   字节 3 电量 0-100
  _encodePing(flags) {
    const buf = new ArrayBuffer(4);
    const dv = new DataView(buf);
    let b = 0;
    if (flags.sharing) b |= 1;
    if (flags.teamBroadcaster) b |= 2;
    if (flags.teamSeparation) b |= 4;
    if (flags.spectator) b |= 8;
    if (flags.charging) b |= 16;
    if (flags.host) b |= 32;
    dv.setUint8(0, b);
    dv.setUint8(1, 0); // 保留
    dv.setUint8(2, 0); // 保留
    dv.setUint8(3, Math.max(0, Math.min(100, Math.round((flags.batteryLevel ?? 1) * 100))));
    return new Uint8Array(buf);
  }

  _decodePing(payload) {
    const dv = this._asDataView(payload);
    const len = dv.byteLength;
    const b = dv.getUint8(0);
    const out = {
      sharing: !!(b & 1),
      teamBroadcaster: !!(b & 2),
      teamSeparation: !!(b & 4),
      spectator: !!(b & 8),
      charging: !!(b & 16),
      host: !!(b & 32),
      batteryLevel: null,
    };
    // 兼容旧版 1 字节 ping
    if (len >= 4) {
      out.batteryLevel = dv.getUint8(3) / 100;
    }
    return out;
  }

  // 圆同步包（二进制，像 pos/ping/presence）：
  //   op Uint8（0 add / 1 update / 2 remove / 3 clear）
  //   cid Float64（圆 id，可能超过 Uint32，用 Float64 保精度）
  //   以下仅 add/update 携带：lat Int32(×1e6) / lng Int32(×1e6) / r Uint32(米) / colorLen Uint8 + color(UTF-8)
  _encodeCircle(opCode, c) {
    const isAddOrUpdate = (opCode === 0 || opCode === 1);
    const colorU = new TextEncoder().encode(isAddOrUpdate ? (c.color || '#888') : '');
    const headerLen = 1 + 8 + (isAddOrUpdate ? 12 : 0);
    const buf = new ArrayBuffer(headerLen + 1 + colorU.length);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    let o = 0;
    dv.setUint8(o, opCode); o += 1;
    dv.setFloat64(o, c.cid || 0, true); o += 8;
    if (isAddOrUpdate) {
      dv.setInt32(o, Math.round(c.lat * 1e6), true); o += 4;
      dv.setInt32(o, Math.round(c.lng * 1e6), true); o += 4;
      dv.setUint32(o, Math.min(0xFFFFFFFF, Math.max(0, Math.round(c.r || 0))), true); o += 4;
      u8[o] = colorU.length; o += 1; u8.set(colorU, o); o += colorU.length;
    }
    return u8;
  }

  _decodeCircle(payload) {
    const dv = this._asDataView(payload);
    const u8 = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    let o = 0;
    const opCode = u8[o]; o += 1;
    const cid = dv.getFloat64(o, true); o += 8;
    const out = { cid };
    if (opCode === 0 || opCode === 1) {
      out.lat = dv.getInt32(o, true) / 1e6; o += 4;
      out.lng = dv.getInt32(o, true) / 1e6; o += 4;
      out.r = dv.getUint32(o, true); o += 4;
      const colorLen = u8[o]; o += 1;
      out.color = new TextDecoder().decode(u8.subarray(o, o + colorLen));
      o += colorLen;
    }
    out.op = (['add', 'update', 'remove', 'clear'])[opCode] || 'clear';
    return out;
  }

  // 在场包：1 字节 flags + 三段变长字符串（name/color/teamId，各 1 字节长度前缀 + UTF-8）
  // flags bit0 旁观 / bit1 NPC（其余保留）
  _encodePresence(p) {
    const nameU = new TextEncoder().encode(p.name || '');
    const colorU = new TextEncoder().encode(p.color || '');
    const teamU = new TextEncoder().encode(p.teamId || '');
    const buf = new ArrayBuffer(1 + 1 + nameU.length + 1 + colorU.length + 1 + teamU.length);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    let f = 0;
    if (p.spectator) f |= 1;
    if (p.isNpc) f |= 2;
    let o = 0;
    dv.setUint8(o, f); o += 1;
    u8[o] = nameU.length; o += 1; u8.set(nameU, o); o += nameU.length;
    u8[o] = colorU.length; o += 1; u8.set(colorU, o); o += colorU.length;
    u8[o] = teamU.length; o += 1; u8.set(teamU, o); o += teamU.length;
    return u8;
  }

  _decodePresence(payload) {
    const dv = this._asDataView(payload);
    const u8 = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    let o = 0;
    const f = u8[o]; o += 1;
    const readStr = () => {
      const len = u8[o]; o += 1;
      const s = new TextDecoder().decode(u8.subarray(o, o + len));
      o += len;
      return s;
    };
    const name = readStr();
    const color = readStr();
    const teamLen = u8[o]; o += 1;
    const teamId = teamLen ? new TextDecoder().decode(u8.subarray(o, o + teamLen)) : null;
    o += teamLen;
    return {
      name, color, teamId,
      spectator: !!(f & 1),
      isNpc: !!(f & 2),
    };
  }

  // ============================================================
  //  topicAlias 压缩（MQTT 5.0）
  // ============================================================

  /**
   * 获取 topic 的 alias 编号（首次分配后自动注册）
   * @param {string} topic 完整 topic
   * @returns {number|null} alias 编号，不可用时返回 null
   */
  _getTopicAlias(topic) {
    if (this._mqttVersion !== 5 || this._topicAliasMax === 0) return null;
    if (this._topicAliases[topic]) return this._topicAliases[topic];
    const nextId = Object.keys(this._topicAliases).length + 1;
    if (nextId > this._topicAliasMax) return null;
    this._topicAliases[topic] = nextId;
    return nextId;
  }

  /**
   * 使用 topicAlias 发布消息（MQTT 5.0 自动压缩 topic）
   * 首次发布携带完整 topic 字符串 + alias；后续只传空 topic + alias
   * @param {string} topic 完整 topic
   * @param {string|Uint8Array} payload 消息体
   * @param {object} opts publish 选项（qos/retain/binary）
   */
  _publishWithAlias(topic, payload, opts) {
    if (!this._client || !this._connected) return;
    const alias = this._getTopicAlias(topic);
    if (alias != null) {
      const registered = this._topicAliasRegistered.has(topic);
      const pubTopic = registered ? '' : topic;
      this._client.publish(pubTopic, payload, { ...opts, properties: { topicAlias: alias } });
      if (!registered) this._topicAliasRegistered.add(topic);
    } else {
      this._client.publish(topic, payload, opts);
    }
  }

  _publishPosition() {
    if (!this._client || !this._connected || !this._roomCode || !this._lastPosition) return;
    const p = this._lastPosition;
    const topic = `${ROOM_CONFIG.TOPIC_PREFIX}/${this._roomCode}/${this._deviceId}/pos`;
    const bytes = this._encodePos({
      lat: p.lat, lng: p.lng, acc: p.acc, speed: p.speed, bearing: p.bearing, ts: Date.now(),
    });
    this._publishWithAlias(topic, bytes, { qos: 1, retain: false, binary: true });
    this._lastSentPos = { lat: p.lat, lng: p.lng, bearing: p.bearing, ts: Date.now() };
    this._lastSentSpeed = p.speed;
  }

  _publishPing() {
    if (!this._client || !this._connected || !this._roomCode) return;
    const topic = `${ROOM_CONFIG.TOPIC_PREFIX}/${this._roomCode}/${this._deviceId}/ping`;
    const bytes = this._encodePing({
      sharing: this._isSpectator ? false : this._sharingEnabled,
      teamBroadcaster: this._myAmBroadcaster,
      teamSeparation: this._teamSeparation,
      spectator: this._isSpectator,
      host: this._isHost,
      batteryLevel: this._batteryLevel,
      charging: this._batteryCharging,
    });
    this._publishWithAlias(topic, bytes, { qos: 1, retain: false, binary: true });
  }

  _publishPresence() {
    // 静态身份低频回填（二进制，像 pos/ping）：name/color/teamId/spectator/isNpc
    if (!this._client || !this._connected || !this._roomCode) return;
    const topic = `${ROOM_CONFIG.TOPIC_PREFIX}/${this._roomCode}/${this._deviceId}/presence`;
    const bytes = this._encodePresence({
      name: this._nickname,
      color: this._color,
      teamId: this._myTeamId,
      spectator: this._isSpectator,
      isNpc: this._isNpcTeam(),
    });
    this._publishWithAlias(topic, bytes, { qos: 1, retain: false, binary: true });
  }

  // ============================================================
  //  房间状态同步（重新加入时恢复完整状态）
  // ============================================================

  /**
   * 广播当前房间完整状态（队伍、统一开始、共享设定等）
   * 当收到 request_state 时调用，让重新加入的玩家同步
   */
  _broadcastFullState() {
    if (!this._client || !this._connected || !this._roomCode) return;
    const playerTeams = {};
    for (const [id, p] of Object.entries(this._players)) {
      if (p.teamId) playerTeams[id] = p.teamId;
    }
    const msg = {
      type: 'room_state',
      hostId: this._hostId || (this._isHost ? this._deviceId : null),
      teams: { ...this._teams },
      playerTeams,
      gameStartAt: this._gameStartAt || 0,
      burstSilent: this._burstSilentMin,
      burstShare: this._burstShareMin,
      sharingEnabled: this._sharingEnabled,
      burstEnabled: this._burstEnabled,
      burstPhase: this._burstPhase,
      burstPhaseEnd: this._burstPhaseEnd,
      burstSeq: this._burstSeq,
      burstEndAt: this._burstEndAt,
    };
    this._publish(msg);
  }

  // ============================================================
  //  自适应位置下发
  // ============================================================

  _computePositionInterval() {
    const speed = (this._lastPosition && this._lastPosition.speed) || 0; // m/s
    const min = ROOM_CONFIG.POSITION_INTERVAL;       // 移动时最短间隔（=原基准，不更短以免增带宽）
    const max = ROOM_CONFIG.POSITION_INTERVAL_MAX;   // 静止时最长间隔
    const still = ROOM_CONFIG.POS_STILL_SPEED;
    const fast = ROOM_CONFIG.POS_FAST_SPEED;
    if (speed <= still) return max;                   // 基本静止 → 最长间隔
    if (speed >= fast) return min;                    // 快速移动 → 基准间隔
    // 0.5~3 m/s：在 [min, max] 间线性插值（始终 ≥ 原基准 10s）
    return Math.round(min + (max - min) * (1 - (speed - still) / (fast - still)));
  }

  _shouldSendPosition() {
    if (this._isSpectator || this._isNpcTeam()) return false;
    const canShare = this._sharingEnabled && this._lastPosition &&
      (!this._burstEnabled || this._burstPhase === 'sharing');
    if (!canShare) return false;
    // 发报员压制：每队仅发报员广播，无队伍/已分离者各自广播
    const broadcasterOk = this._myAmBroadcaster || this._teamSeparation || !this._myTeamId;
    if (!broadcasterOk) return false;
    const sinceSent = this._lastSentPos ? Date.now() - this._lastSentPos.ts : Infinity;
    return sinceSent >= this._computePositionInterval();
  }

  /** 立即补发一次当前位置（开启共享 / 到点进入共享阶段时调用） */
  flushPositionNow() {
    if (this._shouldSendPosition()) this._publishPosition();
  }

  _positionTick() {
    this._preparePublish();
    if (this._shouldSendPosition()) {
      this._publishPosition();
    }
  }

  _schedulePositionTick() {
    const interval = this._computePositionInterval();
    this._posTimer = setTimeout(() => {
      this._positionTick();
      this._schedulePositionTick();
    }, interval);
  }

  /**
   * 设置是否共享定位
   */
  setSharingEnabled(enabled) {
    this._sharingEnabled = enabled;
    if (!enabled) {
      // 关闭共享时清除缓存的最后位置，心跳不再带坐标
      this._lastPosition = null;
      this._lastSentPos = null;
    } else {
      // 恢复共享时发一条心跳通知告知在线
      this._publishPing();
    }
  }

  isSharingEnabled() {
    return this._sharingEnabled;
  }

  /**
   * 注入本机电量和充电状态（由 app 层 Battery API 定期调用）
   * 数据在下次 ping 时发送给其他玩家
   */
  setBatteryInfo(level, charging) {
    this._batteryLevel = level;
    this._batteryCharging = charging;
  }

  /**
   * 更新并发布位置（受 sharingEnabled + 发报员模式控制）
   */
  publishPosition(lat, lng, acc, speed, bearing) {
    if (this._isSpectator) return;
    // 始终缓存最新坐标：即便共享关闭也记录，便于统一开始后立即补发（发送仍受共享开关控制）
    this._lastPosition = { lat, lng, acc, speed, bearing };
    // NPC 队：忽略静默期与共享开关，持续共享
    const npc = this._isNpcTeam();
    if (this._burstEnabled && this._burstPhase === 'silent' && !npc) return;
    if (!this._sharingEnabled && !npc) return;
    if (npc) return; // NPC 不在 GPS 回调即时发，交由 _npcTimer 按 60s 节奏统一发
    // 静止→移动 的瞬间立即下发，让他人及时看到起步（仅触发一次，不持续增频）
    const transition = this._lastSentPos && (this._lastSentSpeed || 0) <= ROOM_CONFIG.POS_STILL_SPEED && speed > ROOM_CONFIG.POS_STILL_SPEED;
    if (!this._lastSentPos) {
      if (this._shouldSendPosition()) this._publishPosition();   // 首点
    } else if (transition) {
      this._publishPosition();                                    // 起步即时反映
    } else if (this._lastSentPos) {
      // 真实位移（超过阈值）立即下发，消除持续移动/慢走时的发报延迟；静止抖动 <阈值 不触发
      const moved = calcDistance(this._lastPosition, this._lastSentPos);
      if (moved > CONFIG.MIN_DISPLACEMENT_M && this._shouldSendPosition()) this._publishPosition();
    }
    // 其余交给自适应 _positionTick（静止时按最长间隔保活）
  }

  /**
   * 发布圆变更（多人同步，其他队伍可见）：add / update / remove / clear
   * circle: { id, center:{lat,lng}, maxRadius, interval }
   */
  publishCircle(op, circle) {
    if (!this._client || !this._connected || !this._roomCode) return;
    const teams = this.getTeams();
    const myTeamId = this.getMyTeamId();
    const color = (myTeamId && teams[myTeamId]) ? teams[myTeamId].color : this.getMyInfo().color;
    let opCode;
    if (op === 'add') opCode = 0;
    else if (op === 'update') opCode = 1;
    else if (op === 'remove') opCode = 2;
    else opCode = 3; // clear
    const c = { cid: (circle && circle.id) || 0 };
    if (opCode === 0 || opCode === 1) {
      c.lat = circle.center.lat;
      c.lng = circle.center.lng;
      c.r = circle.maxRadius;
      c.color = circle.color || color;
    }
    this._publishWithAlias(
      `${ROOM_CONFIG.TOPIC_PREFIX}/${this._roomCode}/${this._deviceId}/circle`,
      this._encodeCircle(opCode, c),
      { qos: 1, retain: false, binary: true }
    );
  }

  /**
   * 处理收到的圆同步消息
   */
  getPlayerName(id) {
    const p = this._players[id];
    return p ? (p.name || this._nickname || '玩家') : (id === this._deviceId ? this._nickname : '玩家');
  }

  _onCircleMsg(senderId, data) {
    if (!data || senderId === this._deviceId) return;
    const key = `${senderId}:${data.cid}`;
    if (data.op === 'add' || data.op === 'update') {
      this._remoteCircles[key] = {
        author: senderId, cid: data.cid,
        center: { lat: data.lat, lng: data.lng },
        maxRadius: data.r, interval: CONFIG.CONCENTRIC_INTERVAL,
        color: data.color || '#888',
        receivedAt: Date.now(),
        authorName: this.getPlayerName(senderId),
      };
      // 10 分钟后自动删除
      this._scheduleRemoteCircleExpiry(key);
    } else if (data.op === 'remove') {
      this._cancelRemoteCircleTimer(key);
      delete this._remoteCircles[key];
    } else if (data.op === 'clear') {
      Object.keys(this._remoteCircles).forEach((k) => {
        if (k.indexOf(senderId + ':') === 0) {
          this._cancelRemoteCircleTimer(k);
          delete this._remoteCircles[k];
        }
      });
    } else {
      return;
    }
    if (this.onCircleSync) this.onCircleSync(this.getRemoteCircles());
  }

  /** 安排远程圆 10 分钟后自动过期删除 */
  _scheduleRemoteCircleExpiry(key) {
    this._cancelRemoteCircleTimer(key);
    this._remoteCircleTimers[key] = setTimeout(() => {
      delete this._remoteCircles[key];
      delete this._remoteCircleTimers[key];
      if (this.onCircleSync) this.onCircleSync(this.getRemoteCircles());
    }, 10 * 60 * 1000);
  }

  _cancelRemoteCircleTimer(key) {
    if (this._remoteCircleTimers[key]) {
      clearTimeout(this._remoteCircleTimers[key]);
      delete this._remoteCircleTimers[key];
    }
  }

  /**
   * 获取其他玩家同步过来的圆列表
   */
  getRemoteCircles() {
    return Object.values(this._remoteCircles);
  }

  /**
   * 启动定时发布
   * - 坐标定时器（POSITION_INTERVAL=5s）：仅在有坐标可共享时发送，保证共享时位置时效
   * - 心跳定时器（HEARTBEAT_INTERVAL=30s）：仅发轻量 ping 维持在线状态，与坐标解耦
   */
  _startPublishing() {
    this._stopPublishing();
    // 自适应位置发布（自调度 setTimeout，间隔随速度浮动）
    this._schedulePositionTick();
    // 心跳保活（15s，二进制 ping 维持在线 + 发报员选举）
    this._heartbeatTimer = setInterval(() => {
      this._preparePublish();
      this._publishPing();
    }, ROOM_CONFIG.HEARTBEAT_INTERVAL);
    // 在场广播（30s，JSON 低频回填静态身份）
    this._presenceTimer = setInterval(() => {
      this._publishPresence();
    }, ROOM_CONFIG.PRESENCE_INTERVAL);
    // NPC 队强制持续共享（60s，二进制 pos，绕过共享开关/静默期/发报员模式）
    this._npcTimer = setInterval(() => {
      if (this._isNpcTeam() && this._lastPosition) {
        this._publishPosition();
      }
    }, ROOM_CONFIG.NPC_POSITION_INTERVAL);
  }

  /**
   * 安排「待定离线」：收到 offline 后不立即删除，
   * 宽限期内若同一设备再次发来任意消息则撤销（见 _cancelPendingOffline）；
   * 仅当宽限期满仍无任何消息，才真正判定离线并清理（见 _expirePendingOffline）。
   * @param {string} id 设备 ID
   */
  _schedulePendingOffline(id) {
    if (!id || !this._players[id]) return; // 玩家本就不存在，无需处理
    if (this._offlineTimers[id]) clearTimeout(this._offlineTimers[id]);
    this._offlineTimers[id] = setTimeout(() => this._expirePendingOffline(id), ROOM_CONFIG.OFFLINE_GRACE_MS);
  }

  _expirePendingOffline(id) {
    if (this._offlineTimers[id]) delete this._offlineTimers[id];
    // 移除该玩家同步过来的圆
    let circleChanged = false;
    Object.keys(this._remoteCircles).forEach((k) => {
      if (k.indexOf(id + ':') === 0) {
        if (this._remoteCircleTimers[k]) { clearTimeout(this._remoteCircleTimers[k]); delete this._remoteCircleTimers[k]; }
        delete this._remoteCircles[k]; circleChanged = true;
      }
    });
    if (circleChanged && this.onCircleSync) this.onCircleSync(this.getRemoteCircles());
    const p = this._players[id];
    if (!p) return;
    p.online = false;
    if (this.onPlayerLeave) this.onPlayerLeave(id, p.name);
    delete this._players[id];

    // 房主离线 → 自动迁移：在线非观战者（含自己）中 deviceId 最小者接管
    // 全员对离线判定一致（同一宽限），选举结果收敛；全为观战者则暂无人接管
    if (this._hostId === id) {
      this._hostId = null;
      const candidates = Object.values(this._players).filter(x => x.online && !x.spectator);
      if (!this._isSpectator) candidates.push({ id: this._deviceId });
      if (candidates.length > 0) {
        candidates.sort((a, b) => (a.id < b.id ? -1 : 1));
        const next = candidates[0].id;
        this._hostId = next;
        if (next === this._deviceId) {
          this._becomeHost();
        } else if (this.onHostChange) {
          this.onHostChange(next);
        }
      }
    }

    // 清理该玩家创建的空队伍
    Object.keys(this._teams).forEach((teamId) => {
      if (this._teams[teamId].creatorId === id && this.getTeamMembers(teamId).length === 0) {
        delete this._teams[teamId];
      }
    });
    if (this.onTeamUpdate) this.onTeamUpdate({ ...this._teams }, this._myTeamId);

    this._schedulePositionUpdate();
  }

  _cancelPendingOffline(id) {
    if (id && this._offlineTimers[id]) {
      clearTimeout(this._offlineTimers[id]);
      delete this._offlineTimers[id];
    }
  }

  _clearOfflineTimers() {
    Object.keys(this._offlineTimers).forEach((id) => {
      clearTimeout(this._offlineTimers[id]);
      delete this._offlineTimers[id];
    });
  }

  /**
   * 切换后台模式：后台时降低心跳频率、暂停 position 发布；前台时恢复
   * @param {boolean} enabled true=进入后台，false=回到前台
   */
  setBackgroundMode(enabled) {
    if (this._backgroundMode === enabled) return;
    this._backgroundMode = enabled;
    if (enabled) {
      if (CONFIG.DEBUG) console.log('[Room] 后台模式：降低心跳频率');
      // 重置心跳定时器 → 60s
      if (this._heartbeatTimer) {
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = setInterval(() => {
          this._preparePublish();
          this._publishPing();
        }, 60000);
      }
      // 重置在场广播 → 120s
      if (this._presenceTimer) {
        clearInterval(this._presenceTimer);
        this._presenceTimer = setInterval(() => {
          this._publishPresence();
        }, 120000);
      }
      // 暂停 position 定时器（后台由原生回调或 JS 轮询触发）
      if (this._posTimer) {
        clearTimeout(this._posTimer);
        this._posTimer = null;
      }
      // NPC 定时器保留（NPC 需要持续共享位置）
    } else {
      if (CONFIG.DEBUG) console.log('[Room] 前台模式：恢复正常心跳频率');
      // 恢复心跳 → 15s
      if (this._heartbeatTimer) {
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = setInterval(() => {
          this._preparePublish();
          this._publishPing();
        }, ROOM_CONFIG.HEARTBEAT_INTERVAL);
      }
      // 恢复在场广播 → 30s
      if (this._presenceTimer) {
        clearInterval(this._presenceTimer);
        this._presenceTimer = setInterval(() => {
          this._publishPresence();
        }, ROOM_CONFIG.PRESENCE_INTERVAL);
      }
      // 恢复 position 定时器
      this._schedulePositionTick();
    }
  }

  /**
   * 后台模式下单次触发 MQTT 发布（由原生后台定位回调调用）
   * 仅发布 ping + position，不触发完整 _preparePublish
   * 与前台一致受共享开关 / 静默期 / 发报员模式门控（NPC 队持续共享除外），
   * 避免后台回调绕过门控造成单向可见
   */
  publishFromBackground(lat, lng, acc, speed, bearing) {
    if (!this._connected || !this._client) return;
    if (lat != null) {
      this._lastPosition = { lat, lng, acc: acc || 0, speed: speed || 0, bearing: bearing || 0 };
    }
    this._publishPing();
    if (this._lastPosition && (this._isNpcTeam() || this._shouldSendPosition())) {
      this._publishPosition();
    }
  }

  _stopPublishing() {
    this._clearOfflineTimers();
    if (this._posTimer) {
      clearTimeout(this._posTimer);
      this._posTimer = null;
    }
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._presenceTimer) {
      clearInterval(this._presenceTimer);
      this._presenceTimer = null;
    }
    if (this._npcTimer) {
      clearInterval(this._npcTimer);
      this._npcTimer = null;
    }
    if (this._burstPublishTimer) {
      clearInterval(this._burstPublishTimer);
      this._burstPublishTimer = null;
    }
  }

  // ============================================================
  //  位置共享（静默/共享交替）
  // ============================================================

  /**
   * 启动位置共享周期（仅发起者/房主调用：统一开始）
   * 阶段由发起者权威推进并附单调 seq 广播，客户端只按 seq 采纳状态，
   * 不再依赖各设备本地时钟对齐，杜绝「单向可见」
   * @param {number} silentMin 静默时长（分钟）
   * @param {number} shareMin 共享时长（分钟）
   */
  startBurstCycle(silentMin, shareMin) {
    if (this._burstEnabled) this._stopBurstLocal();
    this._burstEnabled = true;
    this._burstSilentMin = Math.max(1, silentMin || 25);
    this._burstShareMin = Math.max(1, shareMin || 5);
    this._startBurstRepublish();
    this._enterBurstPhase('silent');
  }

  /**
   * 接管房主后恢复推进爆发周期（阶段已过期则直接进入共享）
   */
  _resumeBurstOwner() {
    if (!this._burstEnabled) return;
    this._startBurstRepublish();
    // 接管/重连后旧 phaseEnd 是过期时钟值（delta 定时器会立即空转或迟到），
    // 直接以本机时钟重启当前阶段：seq+1 广播后全员重新对齐
    this._enterBurstPhase(this._burstPhase === 'sharing' ? 'sharing' : 'silent');
  }

  /** 仅本地停止爆发周期（不广播），供客户端采纳停止消息 / 发起者复用 */
  _stopBurstLocal() {
    if (this._burstTimer) {
      clearTimeout(this._burstTimer);
      this._burstTimer = null;
    }
    if (this._burstPublishTimer) {
      clearInterval(this._burstPublishTimer);
      this._burstPublishTimer = null;
    }
    if (this._burstEndTimer) {
      // 重启周期时旧到点定时器必须清掉，否则会在新会话中途炸掉（提前广播结束）
      clearTimeout(this._burstEndTimer);
      this._burstEndTimer = null;
    }
    this._burstEnabled = false;
    this._burstPhase = 'silent';
    this._burstPhaseEnd = 0;
    if (this.onBurstPhaseChange) this.onBurstPhaseChange(null, 0);
  }

  /** 进入位置共享下一阶段（仅发起者），seq 单调递增后广播 */
  _enterBurstPhase(phase) {
    this._burstPhase = phase;
    const duration = phase === 'silent' ? this._burstSilentMin : this._burstShareMin;
    this._burstPhaseEnd = Date.now() + duration * 60 * 1000;
    this._burstSeq += 1;

    if (this.onBurstPhaseChange) this.onBurstPhaseChange(phase, this._burstPhaseEnd);

    // 阶段变更广播（QoS1 保序 + seq 单调 → 客户端确定性采纳）
    this._publish({
      type: 'burst_phase',
      burstEnabled: true,
      burstPhase: this._burstPhase,
      burstPhaseEnd: this._burstPhaseEnd,
      burstSeq: this._burstSeq,
    });

    // 进入共享阶段立即发 1 次（到点不延迟）
    if (phase === 'sharing' && this._shouldSendPosition()) this._publishPosition();

    // 本地推进下一阶段（仅发起者）
    if (this._burstTimer) clearTimeout(this._burstTimer);
    this._burstTimer = setTimeout(() => {
      const next = phase === 'silent' ? 'sharing' : 'silent';
      this._enterBurstPhase(next);
    }, duration * 60 * 1000);

    this._scheduleBurstEndTimer();
  }

  /** 阶段周期性重发（防丢包/迟到加入者），会话激活期间每 10s 一次 */
  _startBurstRepublish() {
    if (this._burstPublishTimer) clearInterval(this._burstPublishTimer);
    this._burstPublishTimer = setInterval(() => {
      if (!this._burstEnabled) {
        clearInterval(this._burstPublishTimer);
        this._burstPublishTimer = null;
        return;
      }
      this._publish({
        type: 'burst_phase',
        burstEnabled: true,
        burstPhase: this._burstPhase,
        burstPhaseEnd: this._burstPhaseEnd,
        burstSeq: this._burstSeq,
      });
    }, 10000);
  }

  /**
   * 设置共享会话结束时间（仅房主），0=清除
   */
  setBurstEndAt(ts) {
    if (!this._isHost) return;
    this._burstEndAt = ts || 0;
    this._publish({ type: 'burst_end_set', endAt: this._burstEndAt });
    if (this.onBurstEndChange) this.onBurstEndChange(this._burstEndAt);
    this._scheduleBurstEndTimer();
  }

  /** 会话激活且已设结束时间 → 排定到点定时器（仅发起者）；结束时间已过 → 立即结束 */
  _scheduleBurstEndTimer() {
    if (this._burstEndTimer) {
      clearTimeout(this._burstEndTimer);
      this._burstEndTimer = null;
    }
    if (!this._burstEnabled || !this._burstEndAt) return;
    const remaining = this._burstEndAt - Date.now();
    if (remaining <= 0) {
      this.endSharingSession();
      return;
    }
    this._burstEndTimer = setTimeout(() => {
      this._burstEndTimer = null;
      this.endSharingSession();
    }, remaining);
  }

  /**
   * 结束共享会话（发起者调用）：广播结束并本地清理
   */
  endSharingSession() {
    if (!this._burstEnabled && !this._burstEndAt) return;
    this._burstSeq += 1;
    this._publish({ type: 'burst_end', seq: this._burstSeq });
    this._endBurstSession();
  }

  /**
   * 本地清理共享会话（不广播）：停阶段/重发/结束定时器，关共享定位
   */
  _endBurstSession() {
    if (this._burstTimer) {
      clearTimeout(this._burstTimer);
      this._burstTimer = null;
    }
    if (this._burstPublishTimer) {
      clearInterval(this._burstPublishTimer);
      this._burstPublishTimer = null;
    }
    if (this._burstEndTimer) {
      clearTimeout(this._burstEndTimer);
      this._burstEndTimer = null;
    }
    const wasActive = this._burstEnabled;
    this._burstEnabled = false;
    this._burstPhase = 'silent';
    this._burstPhaseEnd = 0;
    if (this._burstEndAt) {
      this._burstEndAt = 0;
      if (this.onBurstEndChange) this.onBurstEndChange(0);
    }
    if (this.onBurstPhaseChange) this.onBurstPhaseChange(null, 0);
    this.setSharingEnabled(false);
    if (wasActive && this.onBurstEnded) this.onBurstEnded();
  }

  isBurstEnabled() { return this._burstEnabled; }
  getBurstPhase() { return this._burstPhase; }
  getBurstPhaseEnd() { return this._burstPhaseEnd; }
  getBurstSettings() { return { silent: this._burstSilentMin, share: this._burstShareMin }; }

  // ============================================================
  //  观战模式
  // ============================================================

  isSpectator() { return this._isSpectator; }

  /**
   * 创建房间（支持观战模式）
   */
  async createRoom(nickname, spectator) {
    this._isSpectator = spectator === true;
    const code = await this._createRoomInternal(nickname);
    return code;
  }

  /**
   * 加入房间（支持观战模式）
   */
  async joinRoom(roomCode, nickname, spectator) {
    this._isSpectator = spectator === true;
    await this._joinRoomInternal(roomCode, nickname);
  }

  // 将原有 createRoom/joinRoom 逻辑拆为内部方法
  async _createRoomInternal(nickname) {
    this._nickname = nickname || '玩家';
    this._color = _pickColor(this._deviceId);
    this._roomCode = _generateRoomCode();
    this._isHost = true;  // 创建者自动成为房主
    this._hostId = this._deviceId;

    await this._connect();
    this._subscribeRoom(this._roomCode);
    this._startPublishing();

    // 发布加入消息
    this._publish({ join: true, name: this._nickname, color: this._color });
    this._publishPresence(); // 立即回填静态身份，避免他人等 ≤30s 才拿到
    return this._roomCode;
  }

  async _joinRoomInternal(roomCode, nickname) {
    this._nickname = nickname || '玩家';
    this._color = _pickColor(this._deviceId);
    this._roomCode = roomCode.toUpperCase();

    await this._connect();
    this._subscribeRoom(this._roomCode);
    this._startPublishing();

    // 发布加入消息
    this._publish({ join: true, name: this._nickname, color: this._color });
    this._publishPresence(); // 立即回填静态身份，避免他人等 ≤30s 才拿到
    // 请求房间状态同步（队伍、统一开始、共享会话等），让已有玩家广播完整状态
    this._publish({ type: 'request_state' });
    // 无主房间接管：一段时间内未同步到任何房主 → 自动成为新房主
    this._scheduleHostClaim();
  }

  /**
   * 安排「无主房间自荐」定时器：加入后 HOST_CLAIM_TIMEOUT 内
   * 未同步到房主 → 自动接管；或当前房主是观战者而我非观战 → 优先接管
   */
  _scheduleHostClaim() {
    if (this._hostClaimTimer) clearTimeout(this._hostClaimTimer);
    this._hostClaimTimer = setTimeout(() => {
      this._hostClaimTimer = null;
      if (!this._roomCode || this._isHost) return;
      // 观战者不参与接管：观战房主只能看守房间，不能成为指挥者
      if (this._isSpectator) return;
      const curHost = this._hostId ? this._players[this._hostId] : null;
      const hostIsSpectator = !!(curHost && curHost.spectator);
      if (!this._hostId || (hostIsSpectator && !this._isSpectator)) {
        this._becomeHost();
      }
    }, ROOM_CONFIG.HOST_CLAIM_TIMEOUT);
  }

  // ============================================================
  //  统一开始倒计时
  // ============================================================

  /**
   * 设置统一开始时间（任何玩家可设，覆盖上一次）
   * @param {number} startAt 开始时间戳（Date.now() + 秒数*1000）
   */
  setGameTimer(startAt) {
    this._gameStartAt = startAt;
    this._gameTimerAborted = false;
    this._publish({ type: 'game_timer_set', startAt });
    if (this.onGameTimerUpdate) this.onGameTimerUpdate(startAt);
  }

  /**
   * 取消统一开始倒计时
   */
  abortGameTimer() {
    this._gameStartAt = 0;
    this._gameTimerAborted = true;
    this._publish({ type: 'game_timer_abort' });
    if (this.onGameTimerAborted) this.onGameTimerAborted();
  }

  getGameStartAt() { return this._gameStartAt; }
  isGameTimerAborted() { return this._gameTimerAborted; }

  /**
   * 统一开始（房主专用）：本地开启共享定位 + 爆发周期，并广播全员同步
   * @param {number} silentMin 静默时长（分钟）
   * @param {number} shareMin 共享时长（分钟）
   */
  burstStart(silentMin, shareMin) {
    if (!this._isHost) return;
    this.setSharingEnabled(true);
    this.startBurstCycle(silentMin, shareMin); // 内部发布 burst_phase 同步阶段
    this._publish({ type: 'burst_start', silent: silentMin, share: shareMin, endAt: this._burstEndAt || 0 });
  }

  /**
   * 我是否是房主
   */
  isHost() { return this._isHost; }

  /**
   * 当前房主 deviceId（null=暂无房主）
   */
  getHostId() { return this._hostId; }

  /**
   * 接管成为新房主：本地确认 + 广播 host_elect + 立即发心跳让全员同步
   */
  _becomeHost() {
    if (this._isHost) return;
    if (this._isSpectator) return; // 观战者禁止接管房主（不能指挥游戏）
    this._isHost = true;
    this._hostId = this._deviceId;
    this._publish({ type: 'host_elect', hostId: this._deviceId });
    this._publishPing();
    this._resumeBurstOwner(); // 接管后若爆发会话仍激活，恢复推进阶段
    if (this.onHostChange) this.onHostChange(this._hostId);
  }

  // ============================================================

  /**
   * 获取当前房间所有玩家
   */
  getPlayers() {
    return { ...this._players };
  }

  /**
   * 获取自己在房间中的信息
   */
  getMyInfo() {
    return {
      id: this._deviceId,
      name: this._nickname,
      color: this._color,
      teamId: this._myTeamId,
      isNpc: this._isNpcTeam(),
    };
  }

  /**
   * 连接状态
   */
  isConnected() {
    return this._connected;
  }

  /**
   * 当前房间码
   */
  getRoomCode() {
    return this._roomCode;
  }

  /**
   * 在线玩家数
   */
  getPlayerCount() {
    return Object.values(this._players).filter(p => p.online).length;
  }

  // ============================================================
  //  队伍管理
  // ============================================================

  /**
   * 创建队伍
   * @param {string} teamName
   * @param {string} teamColor
   * @returns {string} teamId
   */
  /**
   * 我是否在 NPC 队（持续位置共享，不受共享开关/静默期/发报员模式限制）
   */
  _isNpcTeam() {
    return !!(this._myTeamId && this._teams[this._myTeamId] && this._teams[this._myTeamId].isNpc);
  }

  /**
   * 公开：我是否在 NPC 队
   */
  isNpcTeam() {
    return this._isNpcTeam();
  }

  createTeam(teamName, teamColor, isNpc) {
    const teamId = 't' + Math.random().toString(36).slice(2, 8);
    this._myTeamId = teamId;
    const npc = isNpc === true;
    this._teams[teamId] = {
      id: teamId,
      name: teamName,
      color: teamColor,
      creatorId: this._deviceId,
      isNpc: npc,
    };
    this._publish({
      type: 'team_create',
      teamId,
      teamName,
      teamColor,
      isNpc: npc,
    });
    this._startPublishing(); // 重新评估发布定时器（NPC 队启用 60s 强制共享）
    if (this.onTeamUpdate) this.onTeamUpdate({ ...this._teams }, this._myTeamId);
    return teamId;
  }

  /**
   * 加入队伍
   */
  joinTeam(teamId) {
    if (!this._teams[teamId]) return;
    this._myTeamId = teamId;
    this._publish({ type: 'team_join', teamId });
    this._startPublishing(); // 重新评估发布定时器（可能加入 NPC 队）
    if (this.onTeamUpdate) this.onTeamUpdate({ ...this._teams }, this._myTeamId);
  }

  /**
   * 离开队伍
   * @param {string} [teamId] 缺省时离开当前队伍
   */
  leaveTeam(teamId) {
    const targetId = teamId || this._myTeamId;
    if (!targetId) return;
    this._myTeamId = null;
    this._publish({ type: 'team_leave', teamId: targetId });
    this._startPublishing(); // 停止 NPC 强制共享定时器
    if (this.onTeamUpdate) this.onTeamUpdate({ ...this._teams }, this._myTeamId);
  }

  /**
   * 踢出队伍（仅队伍创建者可操作，接收端校验 team.creatorId）
   */
  kickFromTeam(teamId, targetId) {
    this._publish({ type: 'team_kick', teamId, targetId });
  }

  /**
   * 获取所有队伍元数据
   */
  getTeams() {
    return { ...this._teams };
  }

  /**
   * 获取自己的队伍 ID
   */
  getMyTeamId() {
    return this._myTeamId;
  }

  /**
   * 获取指定队伍的在线成员
   */
  getTeamMembers(teamId) {
    return Object.values(this._players).filter(p => p.teamId === teamId && p.online);
  }

  // ============================================================
  //  队伍发报员模式
  // ============================================================

  /**
   * 每次心跳前的发报准备：检查超时 → 选举 → 分离检测
   */
  _preparePublish() {
    // 断线重连风暴期不判离线/不选举，避免误伤队友（_lastSeen 只在在线时更新）
    if (!this._connected) return;
    // 静默掉线检测（不依赖队伍状态）：三路皆无消息超过宽限期 → 触发离线
    const now = Date.now();
    Object.keys(this._players).forEach((id) => {
      if (id === this._deviceId) return;
      const p = this._players[id];
      if (!p || !p.online || !p._lastSeen) return;
      if (now - p._lastSeen > ROOM_CONFIG.OFFLINE_GRACE_MS && !this._offlineTimers[id]) {
        this._schedulePendingOffline(id);
      }
    });

    if (!this._myTeamId) return;

    // 1. 发报员超时检测（连续 3 个心跳周期无广播 → 重选）
    if (this._teamBroadcasterId && Date.now() - this._lastBroadcastTs > ROOM_CONFIG.POSITION_INTERVAL * 3) {
      this._teamBroadcasterId = null;
      this._myAmBroadcaster = false;
    }

    // 2. 无发报员 → 选举
    if (!this._teamBroadcasterId) {
      this._electBroadcaster();
    }

    // 3. 跟随者 → 分离检测
    if (this._teamBroadcasterId && this._teamBroadcasterId !== this._deviceId) {
      this._checkSeparation();
    }
  }

  /**
   * 选举发报员：队伍内定位精度最高（acc 最小）的成员担任
   * 每个客户端独立计算，因规则确定，结果一致
   */
  _electBroadcaster() {
    const candidates = [];

    // 其他在线队友（需有坐标；sharing===false 者关闭了共享/观战，选了会成为"哑发报员"）
    Object.values(this._players).forEach(p => {
      if (p.teamId === this._myTeamId && p.online && p.lat != null && p.sharing !== false) {
        candidates.push({ id: p.id, acc: p.acc != null ? p.acc : 999 });
      }
    });

    // 自己（如果有位置）
    if (this._lastPosition) {
      candidates.push({ id: this._deviceId, acc: this._lastPosition.acc != null ? this._lastPosition.acc : 999 });
    }

    if (candidates.length === 0) return;

    // 精度最高（acc 最小）优先，平局按 deviceId 排序
    candidates.sort((a, b) => {
      if (a.acc !== b.acc) return a.acc - b.acc;
      return a.id < b.id ? -1 : 1;
    });

    const bestId = candidates[0].id;
    this._teamBroadcasterId = bestId;
    this._myAmBroadcaster = (bestId === this._deviceId);
    this._lastBroadcastTs = Date.now();
  }

  /**
   * 分离检测：跟随者与发报员的距离是否 > 300m
   * 带 100m 回滞，防止频繁切换
   */
  _checkSeparation() {
    if (!this._lastPosition || !this._teamBroadcasterId) {
      this._teamSeparation = false;
      return;
    }

    // 我自己就是发报员 → 不需要检测
    if (this._teamBroadcasterId === this._deviceId) {
      this._teamSeparation = false;
      return;
    }

    const broadcaster = this._players[this._teamBroadcasterId];
    if (!broadcaster || broadcaster.lat == null) {
      this._teamSeparation = false;
      return;
    }

    const dist = calcDistance(
      { lat: this._lastPosition.lat, lng: this._lastPosition.lng },
      { lat: broadcaster.lat, lng: broadcaster.lng }
    );

    // 回滞：300m 进入分离，100m 回到跟随
    if (this._teamSeparation) {
      this._teamSeparation = dist > 100;
    } else {
      this._teamSeparation = dist > 300;
    }
  }

  /**
   * 获取当前发报员 ID
   */
  getTeamBroadcasterId() {
    return this._teamBroadcasterId;
  }

  /**
   * 我是否是发报员
   */
  isTeamBroadcaster() {
    return this._myAmBroadcaster;
  }

  /**
   * 我是否从发报员分离
   */
  isTeamSeparated() {
    return this._teamSeparation;
  }

  /**
   * 销毁实例，清理所有资源
   */
  destroy() {
    this.leaveRoom();
    this._disconnect();
    this._endBurstSession();
    this._players = {};
    this._teams = {};
    this._myTeamId = null;
    this._teamBroadcasterId = null;
    this._lastBroadcastTs = 0;
    this._myAmBroadcaster = false;
    this._teamSeparation = false;
    this._isSpectator = false;
    this._gameStartAt = 0;
    this._gameTimerAborted = false;
    this._isHost = false;
    // 排空合并队列 + 清空回调：destroy 后微任务/事件不得再触发任何 UI
    this._updateScheduled = false;
    this._changedPlayers.clear();
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this.onPositionUpdate = null;
    this.onPlayerJoin = null;
    this.onPlayerLeave = null;
    this.onTeamUpdate = null;
    this.onRoomError = null;
    this.onConnectionChange = null;
    this.onBurstPhaseChange = null;
    this.onBurstEndChange = null;
    this.onBurstEnded = null;
    this.onGameTimerUpdate = null;
    this.onGameTimerAborted = null;
    this.onCircleSync = null;
    this.onHostChange = null;
    this.onRequestCircles = null;
  }
}

// 仅用于 Node 测试桩（浏览器中 module 未定义，无副作用）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RoomManager, ROOM_CONFIG };
}
