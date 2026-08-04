/**
 * 途刻（TraceCraft）- 会话管理器
 * =============================================
 * 多轨迹会话的增删改查、容量管理、收藏逻辑
 */

class SessionManager {
  constructor() {
    this._sessions = [];
    this._recordingSessions = [];
  }

  /**
   * 初始化：加载会话 + 迁移旧数据
   */
  async init() {
    await Storage.migrateCurrentToSession();
    await this.loadAll();
  }

  /**
   * 加载所有会话
   * @returns {Promise<{ sessions: object[], recordings: object[] }>}
   */
  async loadAll() {
    try {
      const all = await Storage.loadSessions();
      this._sessions = all.filter(s => !s.isRecording);
      this._recordingSessions = all.filter(s => s.isRecording);
      return { sessions: this._sessions, recordings: this._recordingSessions };
    } catch (e) {
      console.warn('[SessionManager] 加载失败:', e.message);
      this._sessions = [];
      this._recordingSessions = [];
      return { sessions: [], recordings: [] };
    }
  }

  /**
   * 保存当前录制为一条新会话
   * @param {Trail} trail
   * @param {string} name
   * @returns {Promise<object|null>} 新会话，失败返回 null
   */
  async save(trail, name) {
    if (!trail || trail.positions.length < 2) return null;
    const positions = trail.positions;
    const firstTime = positions[0].time || Date.now();
    const lastTime = positions[positions.length - 1].time || Date.now();
    const durationMs = lastTime > firstTime ? lastTime - firstTime : 0;
    let distance = 0;
    let maxSpeed = 0;
    for (let i = 1; i < positions.length; i++) {
      distance += calcDistance(positions[i - 1], positions[i]);
      if (positions[i].speed != null && positions[i].speed > maxSpeed) maxSpeed = positions[i].speed;
    }
    const session = {
      id: 'trail_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name: name || this._autoName(firstTime),
      createdAt: firstTime,
      updatedAt: Date.now(),
      durationMs,
      distance,
      pointCount: positions.length,
      positions: JSON.parse(JSON.stringify(positions)),
      isFavorite: false,
      isRecording: false,
      isPaused: false,
      stats: {
        avgSpeed: durationMs > 0 ? distance / (durationMs / 1000) : 0,
        maxSpeed
      }
    };
    await this._saveWithCapacity(session);
    await this.loadAll();
    return session;
  }

  /**
   * 保存单条会话，处理容量上限
   * @param {object} session
   */
  async _saveWithCapacity(session) {
    const isFav = session.isFavorite;
    const normalSessions = this._sessions.filter(s => !s.isFavorite);
    const favSessions = this._sessions.filter(s => s.isFavorite);

    if (isFav) {
      if (favSessions.length >= CONFIG.TRAIL_SESSION_MAX_FAVORITE) {
        throw new Error('FAVORITE_LIMIT');
      }
    } else {
      if (normalSessions.length >= CONFIG.TRAIL_SESSION_MAX_COUNT) {
        // 删除最旧的非收藏会话
        const oldest = normalSessions.reduce((a, b) => a.createdAt < b.createdAt ? a : b);
        await Storage.deleteSession(oldest.id);
      }
    }
    await Storage.saveSession(session);
  }

  /**
   * 删除单条会话
   * @param {string} id
   */
  async delete(id) {
    await Storage.deleteSession(id);
    await this.loadAll();
  }

  /**
   * 清空全部非录制中的会话
   */
  async deleteAll() {
    const ids = [...this._sessions.map(s => s.id), ...this._recordingSessions.map(s => s.id)];
    for (const id of ids) {
      await Storage.deleteSession(id);
    }
    await this.loadAll();
  }

  /**
   * 切换收藏状态
   * @param {string} id
   * @returns {Promise<boolean>} 新收藏状态
   */
  async toggleFavorite(id) {
    const session = this._sessions.find(s => s.id === id)
      || this._recordingSessions.find(s => s.id === id);
    if (!session) return session?.isFavorite || false;
    const wasFav = session.isFavorite;
    const currentFavCount = this._sessions.filter(s => s.isFavorite).length;
    if (!wasFav && currentFavCount >= CONFIG.TRAIL_SESSION_MAX_FAVORITE) {
      throw new Error('FAVORITE_LIMIT');
    }
    session.isFavorite = !wasFav;
    session.updatedAt = Date.now();
    await Storage.saveSession(session);
    await this.loadAll();
    return session.isFavorite;
  }

  /**
   * 编辑会话名称
   * @param {string} id
   * @param {string} name
   */
  async updateName(id, name) {
    const session = this._sessions.find(s => s.id === id)
      || this._recordingSessions.find(s => s.id === id);
    if (!session) return;
    session.name = name;
    session.updatedAt = Date.now();
    await Storage.saveSession(session);
    await this.loadAll();
  }

  /**
   * 获取按时间范围查询的会话
   * @param {number} start
   * @param {number} end
   * @returns {object[]}
   */
  getByTimeRange(start, end) {
    return this._sessions.filter(s => s.createdAt >= start && s.createdAt <= end);
  }

  /**
   * 获取会话总数（不含录制中）
   */
  get count() { return this._sessions.length; }

  /**
   * 获取收藏数量
   */
  get favoriteCount() { return this._sessions.filter(s => s.isFavorite).length; }

  /**
   * 自动命名：今天 14:30 / 昨天 09:15 / 07-08 21:00
   * @param {number} timestamp
   * @returns {string}
   */
  _autoName(timestamp) {
    const d = new Date(timestamp);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const pad = n => String(n).padStart(2, '0');
    const dateStr = pad(d.getMonth() + 1) + '/' + pad(d.getDate());
    const timeStr = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (day.getTime() === today.getTime()) return `今天 ${timeStr}`;
    const yesterday = new Date(today.getTime() - 86400000);
    if (day.getTime() === yesterday.getTime()) return `昨天 ${timeStr}`;
    return `${dateStr} ${timeStr}`;
  }

  get sessions() { return this._sessions; }
  get recordings() { return this._recordingSessions; }
}
