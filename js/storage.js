/**
 * 数据持久化
 * =============================================
 * 轨迹数据：IndexedDB / localStorage 可选（通过 CONFIG.TRAIL_STORAGE_ENGINE 切换）
 */

class Storage {
  // ===== 存储引擎选择 =====

  static _activeEngine = null;
  static _engineDetected = false;
  static _fallbackAttempted = false;

  static _resolveEngine() {
    if (Storage._engineDetected) return Storage._activeEngine;

    const config = CONFIG.TRAIL_STORAGE_ENGINE || 'auto';

    if (config === 'localstorage') {
      Storage._activeEngine = 'localstorage';
    } else if (config === 'indexeddb') {
      Storage._activeEngine = 'indexeddb';
    } else {
      Storage._activeEngine = Storage._isIndexedDBAvailable()
        ? 'indexeddb'
        : 'localstorage';
    }

    Storage._engineDetected = true;
    if (CONFIG.DEBUG) console.info('[Storage] 轨迹存储引擎:', Storage._activeEngine);
    return Storage._activeEngine;
  }

  static _isIndexedDBAvailable() {
    try {
      return 'indexedDB' in window && typeof window.indexedDB === 'object';
    } catch (e) {
      return false;
    }
  }

  static _getActiveStore() {
    const engine = Storage._resolveEngine();
    return engine === 'indexeddb'
      ? Storage._indexedDBStore
      : Storage._localStorageStore;
  }

  // ===== IndexedDB 引擎 =====

  static _db = null;
  static _dbInitPromise = null;
  static _dbInitialized = false;

  static _initDB() {
    if (Storage._db) return Promise.resolve(Storage._db);
    if (Storage._dbInitPromise) return Storage._dbInitPromise;

    Storage._dbInitPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        const oldVersion = e.oldVersion;
        // 增量升级：v0 → v1 创建轨迹 store
        if (oldVersion < 1) {
          if (!db.objectStoreNames.contains(CONFIG.DB_STORE_TRAIL)) {
            const store = db.createObjectStore(CONFIG.DB_STORE_TRAIL, { keyPath: 'id' });
            store.createIndex('updatedAt', 'updatedAt', { unique: false });
          }
        }
        // v1 → v2 新增 meta store（列表只读 meta，不反序列化大 positions）
        if (oldVersion < 2 && !db.objectStoreNames.contains(CONFIG.DB_STORE_META)) {
          const meta = db.createObjectStore(CONFIG.DB_STORE_META, { keyPath: 'id' });
          meta.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };

      request.onsuccess = (e) => {
        Storage._db = e.target.result;
        Storage._dbInitialized = true;
        // 迁移纳入 init 链：确保 _initDB().then 拿到的是迁移完成后的库，
        // 避免外部（loadTrail 等）在迁移完成前读到空数据
        Storage._migrateFromLocalStorage(Storage._db)
          .catch(err => {
            console.warn('[Storage] 数据迁移失败:', err.message);
          })
          .then(() => resolve(Storage._db));
      };

      request.onerror = (e) => {
        console.warn('[Storage] IndexedDB 打开失败:', e.target.error);
        Storage._dbInitPromise = null;
        reject(e.target.error);
      };
    });

    return Storage._dbInitPromise;
  }

  static _migrateFromLocalStorage(db) {
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
          // 直接用已打开的 db 写入，避免经 _initDB() 等待自身 resolve 造成死锁
          const write = db
            ? Storage._writeCurrentTrail(db, trailData)
            : Storage._saveToIndexedDB(trailData);
          write.then(() => {
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

  static _writeCurrentTrail(db, data) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(CONFIG.DB_STORE_TRAIL, 'readwrite');
      const store = transaction.objectStore(CONFIG.DB_STORE_TRAIL);
      store.put(data);
      transaction.oncomplete = () => resolve();
      transaction.onerror = (e) => reject(e.target.error);
    });
  }

  static _saveToIndexedDB(data) {
    return Storage._initDB().then(db => {
      return Storage._writeCurrentTrail(db, data);
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
      // 统一返回 Promise，保存完成 resolve，失败降级或 reject
      if (!trail) return Promise.resolve(false);
      if ((!trail.positions || trail.positions.length === 0) && !trail.isRecording) return Promise.resolve(false);

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

      return Storage._saveToIndexedDB(trailData)
        .then(() => true)
        .catch(err => {
          console.warn('[Storage] IndexedDB 保存失败:', err.message);
          if (Storage._activeEngine === 'indexeddb' && CONFIG.TRAIL_STORAGE_ENGINE === 'auto' && !Storage._fallbackAttempted) {
            console.info('[Storage] IndexedDB 失败，降级到 localStorage');
            Storage._fallbackAttempted = true;
            Storage._activeEngine = 'localstorage';
            return Storage._localStorageStore.save(trail);
          }
          try { Toast.show('轨迹保存失败：本地存储空间不足'); } catch (_) {}
          return false;
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
      // 统一返回 Promise，保存成功 resolve(true)
      if (!trail) return Promise.resolve(false);
      if ((!trail.positions || trail.positions.length === 0) && !trail.isRecording) return Promise.resolve(false);

      const positions = trail.positions || [];
      let workingPositions = positions;
      let estimatedSize = Storage._estimateSize(workingPositions);
      const maxSize = Storage._getMaxSize();

      try {
        const meta = JSON.stringify({
          isRecording: trail.isRecording || false,
          isPaused: trail.isPaused || false,
          updatedAt: Date.now()
        });
        localStorage.setItem(Storage.TRAIL_META_KEY, meta);
      } catch (_) {}

      if (positions.length === 0) return Promise.resolve(true);

      const encoded = Storage._encodeTrail(workingPositions);
      try {
        localStorage.setItem(Storage.TRAIL_KEY, encoded);
        return Promise.resolve(true);
      } catch (e) {
        if (e.name === 'QuotaExceededError' || e.code === 22) {
          const ratio = maxSize / estimatedSize;
          const keepCount = Math.max(10, Math.floor(workingPositions.length * ratio));
          const step = Math.ceil(workingPositions.length / keepCount);
          workingPositions = workingPositions.filter((_, i) => i % step === 0);
          console.warn('[Storage] localStorage 超配额（', positions.length, '点），已抽稀至', workingPositions.length, '点');

          try {
            const encodedHalf = Storage._encodeTrail(workingPositions);
            localStorage.setItem(Storage.TRAIL_KEY, encodedHalf);
            return Promise.resolve(true);
          } catch (e2) {
            console.warn('[Storage] localStorage 抽稀保存也失败:', e2.message);
          }
        } else {
          console.warn('[Storage] localStorage 保存失败:', e.message);
        }

        if (Storage._activeEngine === 'localstorage' && CONFIG.TRAIL_STORAGE_ENGINE === 'auto' && Storage._isIndexedDBAvailable() && !Storage._fallbackAttempted) {
          console.info('[Storage] localStorage 失败，回退到 IndexedDB');
          Storage._fallbackAttempted = true;
          Storage._activeEngine = 'indexeddb';
          return Storage._indexedDBStore.save(trail).catch(err => {
            console.warn('[Storage] IndexedDB 降级保存也失败:', err.message);
            return false;
          });
        }

        try { Toast.show('轨迹保存失败：本地存储空间不足，建议切换存储引擎'); } catch (_) {}
        return Promise.resolve(false);
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

  static TRAIL_KEY = 'trailcraft_trail';
  static TRAIL_META_KEY = 'trailcraft_trail_meta';

  static _TRAIL_MAGIC = 'CT1';
  // v2：头部扩为 12 字节（magic3 + version1 + 基准时间 Float64），点时间存相对基准毫秒
  static _TRAIL_VERSION = 2;
  static _TRAIL_POINT_BYTES = 26;
  static _TRAIL_HEADER_BYTES = 12;

  static _getMaxSize() {
    const engine = Storage._resolveEngine();
    return engine === 'indexeddb' ? CONFIG.DB_MAX_SIZE : CONFIG.LS_MAX_SIZE;
  }

  static _estimateSize(positions) {
    return Storage._TRAIL_HEADER_BYTES + positions.length * Storage._TRAIL_POINT_BYTES;
  }

  static saveTrail(trail) {
    const store = Storage._getActiveStore();
    // 统一 Promise 接口：IndexedDB 与 localStorage 引擎均返回 Promise
    return Promise.resolve(store.save(trail));
  }

  static loadTrail() {
    const store = Storage._getActiveStore();
    const result = store.load();
    if (result && typeof result.then === 'function') {
      return result;
    }
    return Promise.resolve(result);
  }

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

  static clearTrail() {
    const store = Storage._getActiveStore();
    return Promise.resolve(store.clear());
  }

  static setEngine(engine) {
    CONFIG.TRAIL_STORAGE_ENGINE = engine;
    Storage._engineDetected = false;
    Storage._activeEngine = null;
    Storage._fallbackAttempted = false;
    const resolved = Storage._resolveEngine();
    if (CONFIG.DEBUG) console.info('[Storage] 切换存储引擎:', resolved);
  }

  static getEngine() {
    return Storage._resolveEngine();
  }

  // ===== 轨迹列表管理 =====

  static _TRAIL_LIST_PREFIX = 'list_';

  static _calcDistance(positions) {
    let total = 0;
    for (let i = 1; i < positions.length; i++) {
      const p0 = positions[i - 1];
      const p1 = positions[i];
      const R = 6371000;
      const dLat = (p1.lat - p0.lat) * Math.PI / 180;
      const dLng = (p1.lng - p0.lng) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(p0.lat * Math.PI / 180) * Math.cos(p1.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
      total += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
    return total;
  }

  static _fmtTrailName(date) {
    const d = date instanceof Date ? date : new Date(date);
    const pad = (n) => String(n).padStart(2, '0');
    return `轨迹 ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  static _calcDuration(positions) {
    if (!positions || positions.length < 2) return 0;
    const first = positions[0];
    const last = positions[positions.length - 1];
    if (first && last && first.time && last.time && last.time > first.time) {
      return last.time - first.time;
    }
    return 0;
  }

  static saveTrailToList(positions, name, favorite, opts) {
    if (!positions || positions.length === 0) return Promise.resolve(null);
    const id = Storage._TRAIL_LIST_PREFIX + Date.now();
    const distance = Storage._calcDistance(positions);
    const duration = Storage._calcDuration(positions);
    const now = Date.now();
    const o = opts || {};
    const meta = {
      id,
      name: name || Storage._fmtTrailName(now),
      createdAt: now,
      updatedAt: now,
      distance,
      duration,
      pointCount: positions.length,
      favorite: !!favorite,
      ...(o.cleaned ? { cleaned: true } : {}),
      ...(o.health ? { health: o.health } : {})
    };
    const trailData = Object.assign({}, meta, { positions });
    // 同时写 meta store（列表只读 meta，避免每次反序列化大 positions）+ trail store（完整数据）
    return Storage._initDB().then(db => {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([CONFIG.DB_STORE_TRAIL, CONFIG.DB_STORE_META], 'readwrite');
        transaction.objectStore(CONFIG.DB_STORE_TRAIL).put(trailData);
        if (db.objectStoreNames.contains(CONFIG.DB_STORE_META)) {
          transaction.objectStore(CONFIG.DB_STORE_META).put(meta);
        }
        transaction.oncomplete = () => resolve(id);
        transaction.onerror = (e) => reject(e.target.error);
      });
    }).catch(err => {
      console.warn('[Storage] 轨迹列表保存失败:', err.message);
      return null;
    });
  }

  static _META_MIGRATED_KEY = 'trailcraft_meta_migrated_v' + CONFIG.DB_VERSION;

  static _isMetaMigrated() {
    try { return localStorage.getItem(Storage._META_MIGRATED_KEY) === '1'; } catch (_) { return false; }
  }

  static _markMetaMigrated() {
    try { localStorage.setItem(Storage._META_MIGRATED_KEY, '1'); } catch (_) {}
  }

  static loadTrailList() {
    return Storage._initDB().then(db => {
      // v2+ 优先读 meta store：只含 meta，不反序列化大 positions
      if (db.objectStoreNames.contains(CONFIG.DB_STORE_META)) {
        return Storage._loadTrailListFromMeta(db).then(list => {
          // 兼容兜底：meta store 为空（v1→v2 升级后尚未迁移）或尚未确认迁移完整时，
          // 回退合并 trail + meta 两个 store 并懒迁移补齐，保证任何一侧的旧轨迹都不丢。
          // 注意：不能用 localStorage 标记跳过此处——DB 重建后标记残留会让升级路径被跳过。
          if (list.length === 0 || !Storage._isMetaMigrated()) {
            return Storage._loadTrailListFromTrail(db);
          }
          return list;
        });
      }
      // 旧库（v1）回退：遍历 trail store 提取 meta，并在返回后懒迁移到 meta store
      return Storage._loadTrailListFromTrail(db);
    }).catch(err => {
      console.warn('[Storage] 加载轨迹列表失败:', err.message);
      return [];
    });
  }

  static _loadTrailListFromMeta(db) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(CONFIG.DB_STORE_META, 'readonly');
      const store = transaction.objectStore(CONFIG.DB_STORE_META);
      const results = [];
      // updatedAt 索引倒序，免内存排序
      const request = store.index('updatedAt').openCursor(null, 'prev');
      request.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const val = cursor.value;
          if (val && val.id && val.id.startsWith(Storage._TRAIL_LIST_PREFIX)) {
            results.push({
              id: val.id,
              name: val.name,
              createdAt: val.createdAt,
              distance: val.distance,
              duration: val.duration || 0,
              pointCount: val.pointCount,
              favorite: !!val.favorite
            });
          }
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      request.onerror = (e) => reject(e.target.error);
    });
  }

  static _loadTrailListFromTrail(db) {
    return new Promise((resolve, reject) => {
      const stores = [CONFIG.DB_STORE_TRAIL];
      const hasMeta = db.objectStoreNames.contains(CONFIG.DB_STORE_META);
      if (hasMeta) stores.push(CONFIG.DB_STORE_META);
      const transaction = db.transaction(stores, 'readonly');
      const trailStore = transaction.objectStore(CONFIG.DB_STORE_TRAIL);
      const byId = new Map(); // id -> 合并后的 meta
      const toMigrate = [];
      let pending = 1; // trail 游标计数
      if (hasMeta) pending++;

      const maybeDone = () => {
        if (pending > 0) return;
        const results = Array.from(byId.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        resolve(results);
        // 懒迁移：把旧库轨迹 meta 补写进 meta store（后台异步，不阻塞返回）
        if (toMigrate.length > 0) {
          Storage._migrateMeta(toMigrate).then(() => {
            Storage._markMetaMigrated();
          }).catch(err => {
            if (CONFIG.DEBUG) console.warn('[Storage] meta 懒迁移失败:', err.message);
          });
        } else {
          // 无待迁移记录也视为迁移完成，避免每次加载都回退扫描 trail store
          Storage._markMetaMigrated();
        }
      };

      // 主数据源：trail store（旧库记录 + 双写记录）
      const trailReq = trailStore.openCursor();
      trailReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const val = cursor.value;
          if (val && val.id && val.id.startsWith(Storage._TRAIL_LIST_PREFIX)) {
            byId.set(val.id, {
              id: val.id,
              name: val.name,
              createdAt: val.createdAt,
              updatedAt: val.updatedAt || val.createdAt,
              distance: val.distance,
              duration: val.duration || 0,
              pointCount: val.pointCount,
              favorite: !!val.favorite
            });
            toMigrate.push(byId.get(val.id));
          }
          cursor.continue();
        } else {
          pending--;
          maybeDone();
        }
      };
      trailReq.onerror = (e) => reject(e.target.error);

      // 补充数据源：meta store 独有记录（正常情况下双写保持一致，此分支防历史遗留不一致）
      if (hasMeta) {
        const metaReq = transaction.objectStore(CONFIG.DB_STORE_META).openCursor();
        metaReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            const val = cursor.value;
            if (val && val.id && val.id.startsWith(Storage._TRAIL_LIST_PREFIX) && !byId.has(val.id)) {
              byId.set(val.id, {
                id: val.id,
                name: val.name,
                createdAt: val.createdAt,
                updatedAt: val.updatedAt || val.createdAt,
                distance: val.distance,
                duration: val.duration || 0,
                pointCount: val.pointCount,
                favorite: !!val.favorite
              });
              toMigrate.push(byId.get(val.id));
            }
            cursor.continue();
          } else {
            pending--;
            maybeDone();
          }
        };
        metaReq.onerror = (e) => reject(e.target.error);
      }
    });
  }

  static _migrateMeta(metaList) {
    return Storage._initDB().then(db => {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CONFIG.DB_STORE_META, 'readwrite');
        const store = transaction.objectStore(CONFIG.DB_STORE_META);
        metaList.forEach((m) => store.put(m));
        transaction.oncomplete = () => resolve();
        transaction.onerror = (e) => reject(e.target.error);
      });
    });
  }

  static loadTrailById(id) {
    return Storage._initDB().then(db => {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CONFIG.DB_STORE_TRAIL, 'readonly');
        const store = transaction.objectStore(CONFIG.DB_STORE_TRAIL);
        const request = store.get(id);
        request.onsuccess = () => {
          const data = request.result;
          if (data && data.positions) {
            resolve({
              positions: data.positions,
              name: data.name,
              favorite: !!data.favorite,
              createdAt: data.createdAt,
              distance: data.distance,
              pointCount: data.pointCount,
              duration: data.duration || 0,
              cleaned: !!data.cleaned
            });
          } else {
            resolve(null);
          }
        };
        request.onerror = (e) => reject(e.target.error);
      });
    }).catch(err => {
      console.warn('[Storage] 加载轨迹失败:', err.message);
      return null;
    });
  }

  static loadTrailsByIds(ids) {
    if (!ids || ids.length === 0) return Promise.resolve([]);
    // 单事务批量读取：N 条轨迹一次事务，避免 N 次事务往返
    return Storage._initDB().then(db => {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CONFIG.DB_STORE_TRAIL, 'readonly');
        const store = transaction.objectStore(CONFIG.DB_STORE_TRAIL);
        // 按 ids 索引位预置占位，onsuccess 按位回填：
        // IndexedDB 不保证单事务内多个 get 的 onsuccess 顺序与发起顺序一致，
        // 若直接 push 会导致 mergeTrails 的首尾拼接顺序错乱。
        const results = new Array(ids.length).fill(null);
        const seen = new Set();
        const requests = ids.map((id) => store.get(id));
        requests.forEach((request, idx) => {
          request.onsuccess = () => {
            const data = request.result;
            if (data && data.positions && data.positions.length > 0 && !seen.has(data.id)) {
              seen.add(data.id);
              results[idx] = {
                id: data.id,
                positions: data.positions,
                name: data.name,
                favorite: !!data.favorite,
                createdAt: data.createdAt,
                distance: data.distance,
                pointCount: data.pointCount,
                duration: data.duration || 0,
                cleaned: !!data.cleaned
              };
            }
          };
          request.onerror = () => {};
        });
        transaction.oncomplete = () => resolve(results.filter(Boolean));
        transaction.onerror = (e) => reject(e.target.error);
      });
    }).catch(err => {
      console.warn('[Storage] 批量加载轨迹失败:', err.message);
      return [];
    });
  }

  static mergeTrails(ids, name) {
    if (!ids || ids.length < 2) return Promise.resolve(null);
    return Storage.loadTrailsByIds(ids).then((trails) => {
      if (trails.length < 2) return null;
      const merged = [];
      trails.forEach((t) => {
        const pts = t.positions;
        if (merged.length === 0) {
          merged.push(...pts);
        } else {
          const last = merged[merged.length - 1];
          const first = pts[0];
          const samePoint = first && last &&
            Math.abs(first.lat - last.lat) < 1e-7 &&
            Math.abs(first.lng - last.lng) < 1e-7;
          merged.push(...(samePoint ? pts.slice(1) : pts));
        }
      });
      if (merged.length < 2) return null;
      const now = Date.now();
      const mergeName = name || `合并轨迹 ${Storage._fmtTrailName(now)}`;
      return Storage.saveTrailToList(merged, mergeName, false);
    });
  }

  static deleteTrail(id) {
    return Storage._initDB().then(db => {
      return new Promise((resolve, reject) => {
        const stores = db.objectStoreNames.contains(CONFIG.DB_STORE_META)
          ? [CONFIG.DB_STORE_TRAIL, CONFIG.DB_STORE_META]
          : [CONFIG.DB_STORE_TRAIL];
        const transaction = db.transaction(stores, 'readwrite');
        transaction.objectStore(CONFIG.DB_STORE_TRAIL).delete(id);
        if (db.objectStoreNames.contains(CONFIG.DB_STORE_META)) {
          transaction.objectStore(CONFIG.DB_STORE_META).delete(id);
        }
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = (e) => reject(e.target.error);
      });
    }).catch(err => {
      console.warn('[Storage] 删除轨迹失败:', err.message);
      return false;
    });
  }

  static renameTrail(id, name) {
    return Storage._initDB().then(db => {
      return new Promise((resolve, reject) => {
        const stores = db.objectStoreNames.contains(CONFIG.DB_STORE_META)
          ? [CONFIG.DB_STORE_TRAIL, CONFIG.DB_STORE_META]
          : [CONFIG.DB_STORE_TRAIL];
        const transaction = db.transaction(stores, 'readwrite');
        const store = transaction.objectStore(CONFIG.DB_STORE_TRAIL);
        const request = store.get(id);
        request.onsuccess = () => {
          const data = request.result;
          if (data) {
            data.name = name;
            store.put(data);
            if (db.objectStoreNames.contains(CONFIG.DB_STORE_META)) {
              const metaStore = transaction.objectStore(CONFIG.DB_STORE_META);
              const metaReq = metaStore.get(id);
              metaReq.onsuccess = () => {
                const meta = metaReq.result;
                if (meta) {
                  meta.name = name;
                  meta.updatedAt = Date.now();
                  metaStore.put(meta);
                }
              };
            }
            transaction.oncomplete = () => resolve(true);
          } else {
            // id 不存在：如实返回 false，避免调用方误以为重命名成功
            transaction.oncomplete = () => resolve(false);
          }
        };
        transaction.onerror = (e) => reject(e.target.error);
      });
    }).catch(err => {
      console.warn('[Storage] 重命名失败:', err.message);
      return false;
    });
  }

  static toggleFavorite(id) {
    return Storage._initDB().then(db => {
      return new Promise((resolve, reject) => {
        const stores = db.objectStoreNames.contains(CONFIG.DB_STORE_META)
          ? [CONFIG.DB_STORE_TRAIL, CONFIG.DB_STORE_META]
          : [CONFIG.DB_STORE_TRAIL];
        const transaction = db.transaction(stores, 'readwrite');
        const store = transaction.objectStore(CONFIG.DB_STORE_TRAIL);
        const request = store.get(id);
        request.onsuccess = () => {
          const data = request.result;
          if (!data) { resolve(false); return; }
          data.favorite = !data.favorite;
          store.put(data);
          if (db.objectStoreNames.contains(CONFIG.DB_STORE_META)) {
            const metaStore = transaction.objectStore(CONFIG.DB_STORE_META);
            const metaReq = metaStore.get(id);
            metaReq.onsuccess = () => {
              const meta = metaReq.result;
              if (meta) {
                meta.favorite = data.favorite;
                meta.updatedAt = Date.now();
                metaStore.put(meta);
              }
            };
          }
          transaction.oncomplete = () => resolve(data.favorite);
        };
        request.onerror = (e) => reject(e.target.error);
      });
    }).catch(err => {
      console.warn('[Storage] 切换收藏失败:', err.message);
      return false;
    });
  }

  /**
   * 更新单条历史轨迹的元数据 / 数据（仅覆盖传入字段，positions 可在 patch 中整体替换）
   * @param {string} id 轨迹 id
   * @param {Object} patch 要写入的字段（如 {cleaned:true, positions:[...], distance:..., duration:..., pointCount:...}）
   * @returns {Promise<boolean>}
   */
  static updateTrailMeta(id, patch) {
    if (!id || !patch || typeof patch !== 'object') return Promise.resolve(false);
    return Storage._initDB().then(db => {
      return new Promise((resolve, reject) => {
        const stores = db.objectStoreNames.contains(CONFIG.DB_STORE_META)
          ? [CONFIG.DB_STORE_TRAIL, CONFIG.DB_STORE_META]
          : [CONFIG.DB_STORE_TRAIL];
        const transaction = db.transaction(stores, 'readwrite');
        const store = transaction.objectStore(CONFIG.DB_STORE_TRAIL);
        const request = store.get(id);
        request.onsuccess = () => {
          const data = request.result;
          if (!data) { resolve(false); return; }
          Object.assign(data, patch);
          store.put(data);
          // 同步 meta store：仅拷贝元数据字段，避免把大 positions 写入 meta
          if (db.objectStoreNames.contains(CONFIG.DB_STORE_META)) {
            const metaStore = transaction.objectStore(CONFIG.DB_STORE_META);
            const metaReq = metaStore.get(id);
            metaReq.onsuccess = () => {
              const meta = metaReq.result;
              if (meta) {
                const META_FIELDS = ['name', 'distance', 'duration', 'pointCount', 'favorite', 'cleaned'];
                META_FIELDS.forEach((k) => {
                  if (patch[k] !== undefined) meta[k] = patch[k];
                });
                meta.updatedAt = Date.now();
                metaStore.put(meta);
              }
            };
          }
          transaction.oncomplete = () => resolve(true);
          transaction.onerror = (e) => reject(e.target.error);
        };
        request.onerror = (e) => reject(e.target.error);
      });
    }).catch(err => {
      console.warn('[Storage] 更新轨迹失败:', err.message);
      return false;
    });
  }

  // ===== 编解码工具 =====

  static _encodeTrail(positions) {
    const n = positions.length;
    const PB = Storage._TRAIL_POINT_BYTES;
    const HEAD = Storage._TRAIL_HEADER_BYTES;
    const bytes = new Uint8Array(HEAD + n * PB);
    bytes[0] = 67; bytes[1] = 84; bytes[2] = 49;
    bytes[3] = Storage._TRAIL_VERSION;
    const dv = new DataView(bytes.buffer);
    const baseTime = n > 0 ? (Number(positions[0].time) || 0) : 0;
    dv.setFloat64(4, baseTime, true);
    let o = HEAD;
    for (const p of positions) {
      dv.setFloat64(o, Number(p.lat) || 0, true); o += 8;
      dv.setFloat64(o, Number(p.lng) || 0, true); o += 8;
      // 点时间 = 相对基准毫秒偏移（uint32 上限 2^32 ms ≈ 49.7 天，远超单条会话轨迹跨度）
      const t = Math.max(0, (Number(p.time) || 0) - baseTime);
      dv.setUint32(o, Math.min(0xFFFFFFFF, Math.floor(t)), true); o += 4;
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

  static _decodeTrail(str) {
    const len = str.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = str.charCodeAt(i);
    if (bytes.length < 4 || bytes[0] !== 67 || bytes[1] !== 84 || bytes[2] !== 49) return null;
    const ver = bytes[3];
    if (ver !== 1 && ver !== 2) {
      console.warn('[Storage] 轨迹格式版本不兼容:', ver, '（当前', Storage._TRAIL_VERSION, '）');
      return null;
    }
    const PB = Storage._TRAIL_POINT_BYTES;
    const dv = new DataView(bytes.buffer);
    // v1：4 字节头，点时间 = 绝对秒（×1000 转毫秒）；v2：12 字节头，含基准毫秒，点时间 = 基准 + 相对毫秒
    const headerLen = ver === 2 ? Storage._TRAIL_HEADER_BYTES : 4;
    if (bytes.length < headerLen) return null;
    const baseTime = ver === 2 ? dv.getFloat64(4, true) : 0;
    const count = Math.floor((len - headerLen) / PB);
    const positions = new Array(count);
    let o = headerLen;
    for (let i = 0; i < count; i++) {
      const lat = dv.getFloat64(o, true); o += 8;
      const lng = dv.getFloat64(o, true); o += 8;
      const t = dv.getUint32(o, true); o += 4;
      const time = ver === 2 ? baseTime + t : t * 1000;
      const speed = dv.getUint16(o, true) / 100; o += 2;
      const heading = dv.getUint16(o, true) / 100; o += 2;
      const accuracy = dv.getUint16(o, true); o += 2;
      positions[i] = { lat, lng, time, speed, heading, accuracy };
    }
    return { positions };
  }
}
