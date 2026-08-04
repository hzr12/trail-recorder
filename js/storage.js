/**
 * 途刻（TraceCraft）- 数据持久化
 * =============================================
 * 轨迹数据：IndexedDB / localStorage 可选
 * 会话数据：IndexedDB 独立存储
 */

class Storage {
  }

  // ===== 存储引擎选择 =====

  static _activeEngine = null;       // 当前使用的引擎：'indexeddb' | 'localstorage'
  static _engineDetected = false;     // 是否已完成引擎检测
  static _fallbackAttempted = false;  // 本次保存是否已尝试过降级（防止无限循环）

  /**
   * 检测并选择存储引擎
   * @returns {'indexeddb'|'localstorage'}
   */
  static _resolveEngine() {
    if (Storage._engineDetected) return Storage._activeEngine;

    const config = CONFIG.TRAIL_STORAGE_ENGINE || 'auto';

    if (config === 'localstorage') {
      Storage._activeEngine = 'localstorage';
    } else if (config === 'indexeddb') {
      Storage._activeEngine = 'indexeddb';
    } else {
      // auto：优先 IndexedDB
      Storage._activeEngine = Storage._isIndexedDBAvailable()
        ? 'indexeddb'
        : 'localstorage';
    }

    Storage._engineDetected = true;
    if (CONFIG.DEBUG) console.info('[Storage] 轨迹存储引擎:', Storage._activeEngine);
    return Storage._activeEngine;
  }

  /**
   * 检测 IndexedDB 是否可用
   * @returns {boolean}
   */
  static _isIndexedDBAvailable() {
    try {
      return 'indexedDB' in window && typeof window.indexedDB === 'object';
    } catch (e) {
      return false;
    }
  }

  /**
   * 获取当前活跃的存储引擎接口
   * @returns {object} 包含 save/load 方法的存储接口
   */
  static _getActiveStore() {
    const engine = Storage._resolveEngine();
    return engine === 'indexeddb'
      ? Storage._indexedDBStore
      : Storage._localStorageStore;
  }

  // ===== IndexedDB 引擎 =====

  static _db = null;             // IndexedDB 连接实例
  static _dbInitPromise = null;  // 初始化 Promise（防止并发初始化）
  static _dbInitialized = false; // 是否已完成初始化（含数据迁移）

  /**
   * 初始化 IndexedDB 连接（懒加载，首次调用时初始化）
   * @returns {Promise<IDBDatabase>}
   */
  static _initDB() {
    if (Storage._db) return Promise.resolve(Storage._db);
    if (Storage._dbInitPromise) return Storage._dbInitPromise;

    Storage._dbInitPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(CONFIG.DB_STORE_TRAIL)) {
          const store = db.createObjectStore(CONFIG.DB_STORE_TRAIL, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };

      request.onsuccess = (e) => {
        Storage._db = e.target.result;
        Storage._dbInitialized = true;
        Storage._migrateFromLocalStorage().catch(err => {
          console.warn('[Storage] 数据迁移失败:', err.message);
        });
        resolve(Storage._db);
      };

      request.onerror = (e) => {
        console.warn('[Storage] IndexedDB 打开失败:', e.target.error);
        Storage._dbInitPromise = null;
        reject(e.target.error);
      };
    });

    return Storage._dbInitPromise;
  }

  /**
   * 数据迁移：将旧 localStorage 中的轨迹数据迁移到 IndexedDB
   */
  static _migrateFromLocalStorage() {
    return new Promise((resolve) => {
      try {
        const oldData = localStorage.getItem(Storage.TRAIL_KEY);
        if (!oldData) { resolve(); return; }

        let positions = null;
        if (oldData.charCodeAt(0) === 67) {
          const decoded = Storage._decodeTrail(oldData);
          if (decoded) positions = decoded.positions;
        } else {
          const data = JSON.parse(oldData);
          if (data && Array.isArray(data.positions)) {
            positions = data.positions.filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng));
          }
        }

        if (positions && positions.length > 0) {
          const trailData = {
            id: 'current',
            positions: positions,
            updatedAt: Date.now(),
            pointCount: positions.length,
            sizeBytes: new Blob([oldData]).size
          };
          Storage._saveToIndexedDB(trailData).then(() => {
            try {
              localStorage.removeItem(Storage.TRAIL_KEY);
              console.info('[Storage] 轨迹数据已迁移到 IndexedDB（', positions.length, '点）');
            } catch (_) {}
            resolve();
          }).catch(() => resolve());
        } else {
          resolve();
        }
      } catch (e) {
        resolve();
      }
    });
  }

  static _saveToIndexedDB(data) {
    return Storage._initDB().then(db => {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CONFIG.DB_STORE_TRAIL, 'readwrite');
        const store = transaction.objectStore(CONFIG.DB_STORE_TRAIL);
        store.put(data);
        transaction.oncomplete = () => resolve();
        transaction.onerror = (e) => reject(e.target.error);
      });
    });
  }

  static _loadFromIndexedDB() {
    return Storage._initDB().then(db => {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CONFIG.DB_STORE_TRAIL, 'readonly');
        const store = transaction.objectStore(CONFIG.DB_STORE_TRAIL);
        const request = store.get('current');
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = (e) => reject(e.target.error);
      });
    });
  }

  // ===== IndexedDB 存储接口 =====

  static _indexedDBStore = {
    save(trail) {
      if (!trail) return;
      // 无点且未录制 → 不保存
      if ((!trail.positions || trail.positions.length === 0) && !trail.isRecording) return;

      const positions = trail.positions || [];
      let workingPositions = positions;
      let estimatedSize = Storage._estimateSize(workingPositions);
      const maxSize = Storage._getMaxSize();

      if (estimatedSize > maxSize) {
        const ratio = maxSize / estimatedSize;
        const keepCount = Math.max(10, Math.floor(workingPositions.length * ratio));
        const step = Math.ceil(workingPositions.length / keepCount);
        workingPositions = workingPositions.filter((_, i) => i % step === 0);
        estimatedSize = Storage._estimateSize(workingPositions);
        console.warn('[Storage] IndexedDB 轨迹超配额（', positions.length, '点），已抽稀至', workingPositions.length, '点');
      }

      const trailData = {
        id: 'current',
        positions: workingPositions,
        updatedAt: Date.now(),
        pointCount: workingPositions.length,
        sizeBytes: estimatedSize,
        isRecording: trail.isRecording || false,
        isPaused: trail.isPaused || false
      };

      Storage._saveToIndexedDB(trailData).catch(err => {
        console.warn('[Storage] IndexedDB 保存失败:', err.message);
        // auto 模式且未尝试过降级 → 回退到 localStorage
        if (Storage._activeEngine === 'indexeddb' && CONFIG.TRAIL_STORAGE_ENGINE === 'auto' && !Storage._fallbackAttempted) {
          console.info('[Storage] IndexedDB 失败，降级到 localStorage');
          Storage._fallbackAttempted = true;
          Storage._activeEngine = 'localstorage';
          try {
            Storage._localStorageStore.save(trail);
          } catch (e) {
            console.warn('[Storage] localStorage 降级保存也失败:', e.message);
          }
        } else {
          try { Toast.show('轨迹保存失败：本地存储空间不足'); } catch (_) {}
        }
      });
    },

    load() {
      return Storage._loadFromIndexedDB()
        .then(data => {
          if (!data) return null;
          const hasPositions = data.positions && data.positions.length > 0;
          if (!hasPositions && !data.isRecording) return null;
          return {
            positions: data.positions || [],
            updatedAt: data.updatedAt,
            pointCount: data.pointCount || (data.positions ? data.positions.length : 0),
            isRecording: data.isRecording || false,
            isPaused: data.isPaused || false
          };
        })
        .catch(err => {
          console.warn('[Storage] IndexedDB 恢复失败:', err.message);
          if (Storage._activeEngine === 'indexeddb' && CONFIG.TRAIL_STORAGE_ENGINE === 'auto') {
            console.info('[Storage] 降级到 localStorage 读取');
            Storage._activeEngine = 'localstorage';
            return Storage._localStorageStore.load();
          }
          return null;
        });
    },

    clear() {
      return Storage._initDB().then(db => {
        return new Promise((resolve, reject) => {
          const transaction = db.transaction(CONFIG.DB_STORE_TRAIL, 'readwrite');
          const store = transaction.objectStore(CONFIG.DB_STORE_TRAIL);
          store.delete('current');
          transaction.oncomplete = () => {
            try {
              localStorage.removeItem(Storage.TRAIL_KEY);
              localStorage.removeItem(Storage.TRAIL_META_KEY);
            } catch (_) {}
            resolve();
          };
          transaction.onerror = (e) => reject(e.target.error);
        });
      });
    }
  };

  // ===== localStorage 存储接口 =====

  static _localStorageStore = {
    save(trail) {
      if (!trail) return;
      // 无点且未录制 → 不保存
      if ((!trail.positions || trail.positions.length === 0) && !trail.isRecording) return;

      const positions = trail.positions || [];
      let workingPositions = positions;
      let estimatedSize = Storage._estimateSize(workingPositions);
      const maxSize = Storage._getMaxSize();

      // 保存录制状态元数据
      try {
        const meta = JSON.stringify({
          isRecording: trail.isRecording || false,
          isPaused: trail.isPaused || false,
          updatedAt: Date.now()
        });
        localStorage.setItem(Storage.TRAIL_META_KEY, meta);
      } catch (_) {}

      if (positions.length === 0) return; // 仅保存了元数据，无需保存位置

      // 尝试直接保存
      const encoded = Storage._encodeTrail(workingPositions);
      try {
        localStorage.setItem(Storage.TRAIL_KEY, encoded);
        return;
      } catch (e) {
        if (e.name === 'QuotaExceededError' || e.code === 22) {
          // 抽稀重试
          const ratio = maxSize / estimatedSize;
          const keepCount = Math.max(10, Math.floor(workingPositions.length * ratio));
          const step = Math.ceil(workingPositions.length / keepCount);
          workingPositions = workingPositions.filter((_, i) => i % step === 0);
          console.warn('[Storage] localStorage 超配额（', positions.length, '点），已抽稀至', workingPositions.length, '点');

          try {
            const encodedHalf = Storage._encodeTrail(workingPositions);
            localStorage.setItem(Storage.TRAIL_KEY, encodedHalf);
            return;
          } catch (e2) {
            console.warn('[Storage] localStorage 抽稀保存也失败:', e2.message);
          }
        } else {
          console.warn('[Storage] localStorage 保存失败:', e.message);
        }

        // auto 模式：localStorage 也失败，尝试回退到 IndexedDB
        if (Storage._activeEngine === 'localstorage' && CONFIG.TRAIL_STORAGE_ENGINE === 'auto' && Storage._isIndexedDBAvailable() && !Storage._fallbackAttempted) {
          console.info('[Storage] localStorage 失败，回退到 IndexedDB');
          Storage._fallbackAttempted = true;
          Storage._activeEngine = 'indexeddb';
          Storage._indexedDBStore.save(trail).catch(err => {
            console.warn('[Storage] IndexedDB 降级保存也失败:', err.message);
          });
          return;
        }

        // 彻底失败
        try { Toast.show('轨迹保存失败：本地存储空间不足，建议切换存储引擎'); } catch (_) {}
      }
    },

    load() {
      try {
        const raw = localStorage.getItem(Storage.TRAIL_KEY);
        let result = null;

        if (raw) {
          if (raw.charCodeAt(0) === 67) {
            const decoded = Storage._decodeTrail(raw);
            if (decoded) {
              result = {
                positions: decoded.positions,
                updatedAt: null,
                pointCount: decoded.positions.length
              };
            }
          } else {
            const data = JSON.parse(raw);
            if (data && Array.isArray(data.positions)) {
              result = {
                positions: data.positions,
                updatedAt: null,
                pointCount: data.positions.length
              };
            }
          }
        }

        // 读取录制状态元数据（即使没有位置数据也可能有录制状态）
        let metaResult = null;
        try {
          const metaRaw = localStorage.getItem(Storage.TRAIL_META_KEY);
          if (metaRaw) {
            const meta = JSON.parse(metaRaw);
            metaResult = {
              isRecording: meta.isRecording || false,
              isPaused: meta.isPaused || false,
              updatedAt: meta.updatedAt || null
            };
          }
        } catch (_) {}

        // 合并结果
        if (result) {
          if (metaResult) {
            result.isRecording = metaResult.isRecording;
            result.isPaused = metaResult.isPaused;
            result.updatedAt = metaResult.updatedAt;
          } else {
            result.isRecording = false;
            result.isPaused = false;
          }
          return result;
        }

        // 无位置数据但有录制状态
        if (metaResult && metaResult.isRecording) {
          return {
            positions: [],
            pointCount: 0,
            isRecording: metaResult.isRecording,
            isPaused: metaResult.isPaused,
            updatedAt: metaResult.updatedAt
          };
        }

        return null;
      } catch (e) {
        console.warn('[Storage] localStorage 恢复失败:', e.message);
        return null;
      }
    },

    clear() {
      try {
        localStorage.removeItem(Storage.TRAIL_KEY);
        localStorage.removeItem(Storage.TRAIL_META_KEY);
      } catch (_) {}
      return Promise.resolve();
    }
  };

  // ===== 轨迹持久化公共接口 =====

  static TRAIL_KEY = 'circlemap_trail';
  static TRAIL_META_KEY = 'circlemap_trail_meta';  // 轨迹元数据（录制状态等）

  // 编码参数
  static _TRAIL_MAGIC = 'CT1';
  static _TRAIL_VERSION = 1;
  static _TRAIL_POINT_BYTES = 26;

  /**
   * 获取当前引擎的存储上限
   * @returns {number} 字节
   */
  static _getMaxSize() {
    const engine = Storage._resolveEngine();
    return engine === 'indexeddb' ? CONFIG.DB_MAX_SIZE : CONFIG.LS_MAX_SIZE;
  }

  static _estimateSize(positions) {
    return 4 + positions.length * Storage._TRAIL_POINT_BYTES;
  }

  /**
   * 保存轨迹数据
   * @param {Trail} trail
   */
  static saveTrail(trail) {
    const store = Storage._getActiveStore();
    store.save(trail);
  }

  /**
   * 恢复轨迹数据
   * @returns {Promise<{positions:Array}|null>}
   */
  static loadTrail() {
    const store = Storage._getActiveStore();
    const result = store.load();
    // localStorage store.load() 返回同步值，包装为 Promise
    if (result && typeof result.then === 'function') {
      return result;
    }
    return Promise.resolve(result);
  }

  /**
   * 获取轨迹存储统计信息
   * @returns {Promise<{pointCount:number,sizeBytes:number,updatedAt:number,engine:string}|null>}
   */
  static getTrailInfo() {
    const engine = Storage._resolveEngine();
    return Storage.loadTrail().then(data => {
      if (!data) return null;
      return {
        pointCount: data.pointCount || (data.positions ? data.positions.length : 0),
        sizeBytes: data.positions ? Storage._estimateSize(data.positions) : 0,
        updatedAt: data.updatedAt || 0,
        engine: engine
      };
    });
  }

  /**
   * 清除所有轨迹数据
   * @returns {Promise<void>}
   */
  static clearTrail() {
    const store = Storage._getActiveStore();
    return Promise.resolve(store.clear());
  }

  // ===== 会话持久化（IndexedDB） =====

  static _sessionsDb = null;
  static _sessionsDbInitPromise = null;
  static _sessionsDbInitialized = false;

  static _initSessionsDB() {
    if (Storage._sessionsDb) return Promise.resolve(Storage._sessionsDb);
    if (Storage._sessionsDbInitPromise) return Storage._sessionsDbInitPromise;
    Storage._sessionsDbInitPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(CONFIG.DB_STORE_SESSIONS)) {
          const store = db.createObjectStore(CONFIG.DB_STORE_SESSIONS, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };
      request.onsuccess = (e) => {
        Storage._sessionsDb = e.target.result;
        Storage._sessionsDbInitialized = true;
        resolve(Storage._sessionsDb);
      };
      request.onerror = (e) => {
        Storage._sessionsDbInitPromise = null;
        reject(e.target.error);
      };
    });
    return Storage._sessionsDbInitPromise;
  }

  /**
   * 保存会话
   * @param {object} session
   */
  static async saveSession(session) {
    const db = await Storage._initSessionsDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CONFIG.DB_STORE_SESSIONS, 'readwrite');
      tx.objectStore(CONFIG.DB_STORE_SESSIONS).put(session);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * 加载所有会话，按 createdAt 降序
   * @returns {Promise<object[]>}
   */
  static async loadSessions() {
    const db = await Storage._initSessionsDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CONFIG.DB_STORE_SESSIONS, 'readonly');
      const store = tx.objectStore(CONFIG.DB_STORE_SESSIONS);
      const request = store.getAll();
      request.onsuccess = () => {
        const sessions = (request.result || []).sort((a, b) => b.createdAt - a.createdAt);
        resolve(sessions);
      };
      request.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * 删除单条会话
   */
  static async deleteSession(id) {
    const db = await Storage._initSessionsDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CONFIG.DB_STORE_SESSIONS, 'readwrite');
      tx.objectStore(CONFIG.DB_STORE_SESSIONS).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * 清空全部会话
   */
  static async clearSessions() {
    const db = await Storage._initSessionsDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CONFIG.DB_STORE_SESSIONS, 'readwrite');
      tx.objectStore(CONFIG.DB_STORE_SESSIONS).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * 启动时迁移旧 'current' 轨迹记录为第一条会话
   */
  static async migrateCurrentToSession() {
    try {
      const currentData = await new Promise((resolve) => {
        const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
        request.onsuccess = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(CONFIG.DB_STORE_TRAIL)) { resolve(null); return; }
          const tx = db.transaction(CONFIG.DB_STORE_TRAIL, 'readonly');
          const req = tx.objectStore(CONFIG.DB_STORE_TRAIL).get('current');
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        };
        request.onerror = () => resolve(null);
      });
      if (!currentData || !currentData.positions || currentData.positions.length < 2) return;
      // 检查是否已迁移
      const sessions = await Storage.loadSessions();
      const alreadyMigrated = sessions.some(s => s.id === currentData.id || s.migratedFrom === 'current');
      if (alreadyMigrated) return;
      const positions = currentData.positions;
      const firstTime = positions[0].time || Date.now();
      const lastTime = positions[positions.length - 1].time || Date.now();
      const durationMs = lastTime > firstTime ? lastTime - firstTime : 0;
      let distance = 0;
      for (let i = 1; i < positions.length; i++) {
        distance += calcDistance(positions[i - 1], positions[i]);
      }
      const session = {
        id: 'trail_' + firstTime + '_' + Math.random().toString(36).slice(2, 6),
        name: '导入轨迹 ' + new Date(firstTime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }),
        createdAt: firstTime,
        updatedAt: Date.now(),
        durationMs,
        distance,
        pointCount: positions.length,
        positions,
        isFavorite: false,
        isRecording: false,
        isPaused: false,
        migratedFrom: 'current'
      };
      await Storage.saveSession(session);
      console.info('[Storage] 旧轨迹已迁移为会话:', session.id);
    } catch (e) {
      console.warn('[Storage] 迁移失败:', e.message);
    }
  }

  /**
   * 切换存储引擎（运行时切换）
   * @param {'indexeddb'|'localstorage'|'auto'} engine
   */
  static setEngine(engine) {
    CONFIG.TRAIL_STORAGE_ENGINE = engine;
    Storage._engineDetected = false;
    Storage._activeEngine = null;
    Storage._fallbackAttempted = false;
    const resolved = Storage._resolveEngine();
    if (CONFIG.DEBUG) console.info('[Storage] 切换存储引擎:', resolved);
  }

  /**
   * 获取当前存储引擎名称
   * @returns {'indexeddb'|'localstorage'}
   */
  static getEngine() {
    return Storage._resolveEngine();
  }

  // ===== 编解码工具 =====

  /** 轨迹点数组 → Latin1 二进制字符串 */
  static _encodeTrail(positions) {
    const n = positions.length;
    const PB = Storage._TRAIL_POINT_BYTES;
    const bytes = new Uint8Array(4 + n * PB);
    bytes[0] = 67; bytes[1] = 84; bytes[2] = 49; // 'CT1'
    bytes[3] = Storage._TRAIL_VERSION;
    const dv = new DataView(bytes.buffer);
    let o = 4;
    for (const p of positions) {
      dv.setFloat64(o, Number(p.lat) || 0, true); o += 8;
      dv.setFloat64(o, Number(p.lng) || 0, true); o += 8;
      dv.setUint32(o, Math.max(0, Math.floor((Number(p.time) || 0) / 1000)), true); o += 4;
      dv.setUint16(o, Math.max(0, Math.min(65535, Math.round((Number(p.speed) || 0) * 100))), true); o += 2;
      const h = (((Number(p.heading) || 0) % 360) + 360) % 360;
      dv.setUint16(o, Math.max(0, Math.min(35999, Math.round(h * 100))), true); o += 2;
      dv.setUint16(o, Math.max(0, Math.min(65535, Math.round(Number(p.accuracy) || 0))), true); o += 2;
    }
    let str = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      str += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return str;
  }

  /** Latin1 二进制字符串 → 轨迹点数组 */
  static _decodeTrail(str) {
    const len = str.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = str.charCodeAt(i);
    if (bytes.length < 4 || bytes[0] !== 67 || bytes[1] !== 84 || bytes[2] !== 49) return null;
    if (bytes[3] !== Storage._TRAIL_VERSION) {
      console.warn('[Storage] 轨迹格式版本不兼容:', bytes[3], '（当前', Storage._TRAIL_VERSION, '）');
      return null;
    }
    const PB = Storage._TRAIL_POINT_BYTES;
    const dv = new DataView(bytes.buffer);
    const count = Math.floor((len - 4) / PB);
    const positions = new Array(count);
    let o = 4;
    for (let i = 0; i < count; i++) {
      const lat = dv.getFloat64(o, true); o += 8;
      const lng = dv.getFloat64(o, true); o += 8;
      const time = dv.getUint32(o, true) * 1000; o += 4;
      const speed = dv.getUint16(o, true) / 100; o += 2;
      const heading = dv.getUint16(o, true) / 100; o += 2;
      const accuracy = dv.getUint16(o, true); o += 2;
      positions[i] = { lat, lng, time, speed, heading, accuracy };
    }
    return { positions };
  }
}
