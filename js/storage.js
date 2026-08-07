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
      if ((!trail.positions || trail.positions.length === 0) && !trail.isRecording) return;

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

      if (positions.length === 0) return;

      const encoded = Storage._encodeTrail(workingPositions);
      try {
        localStorage.setItem(Storage.TRAIL_KEY, encoded);
        return;
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
            return;
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
          Storage._indexedDBStore.save(trail).catch(err => {
            console.warn('[Storage] IndexedDB 降级保存也失败:', err.message);
          });
          return;
        }

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
  static _TRAIL_VERSION = 1;
  static _TRAIL_POINT_BYTES = 26;

  static _getMaxSize() {
    const engine = Storage._resolveEngine();
    return engine === 'indexeddb' ? CONFIG.DB_MAX_SIZE : CONFIG.LS_MAX_SIZE;
  }

  static _estimateSize(positions) {
    return 4 + positions.length * Storage._TRAIL_POINT_BYTES;
  }

  static saveTrail(trail) {
    const store = Storage._getActiveStore();
    store.save(trail);
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
    const trailMeta = {
      id,
      name: name || Storage._fmtTrailName(now),
      createdAt: now,
      distance,
      duration,
      pointCount: positions.length,
      favorite: !!favorite,
      ...(o.cleaned ? { cleaned: true } : {}),
      positions
    };
    return Storage._saveToIndexedDB(trailMeta).then(() => id).catch(err => {
      console.warn('[Storage] 轨迹列表保存失败:', err.message);
      return null;
    });
  }

  static loadTrailList() {
    return Storage._initDB().then(db => {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CONFIG.DB_STORE_TRAIL, 'readonly');
        const store = transaction.objectStore(CONFIG.DB_STORE_TRAIL);
        const results = [];
        const request = store.openCursor();
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
            results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            resolve(results);
          }
        };
        request.onerror = (e) => reject(e.target.error);
      });
    }).catch(err => {
      console.warn('[Storage] 加载轨迹列表失败:', err.message);
      return [];
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
    return Promise.all(ids.map((id) => Storage.loadTrailById(id))).then((list) => {
      return list.filter((d) => d && d.positions && d.positions.length > 0);
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
        const transaction = db.transaction(CONFIG.DB_STORE_TRAIL, 'readwrite');
        const store = transaction.objectStore(CONFIG.DB_STORE_TRAIL);
        store.delete(id);
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
        const transaction = db.transaction(CONFIG.DB_STORE_TRAIL, 'readwrite');
        const store = transaction.objectStore(CONFIG.DB_STORE_TRAIL);
        const request = store.get(id);
        request.onsuccess = () => {
          const data = request.result;
          if (data) {
            data.name = name;
            store.put(data);
          }
          transaction.oncomplete = () => resolve(true);
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
        const transaction = db.transaction(CONFIG.DB_STORE_TRAIL, 'readwrite');
        const store = transaction.objectStore(CONFIG.DB_STORE_TRAIL);
        const request = store.get(id);
        request.onsuccess = () => {
          const data = request.result;
          if (!data) { resolve(false); return; }
          data.favorite = !data.favorite;
          store.put(data);
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
        const transaction = db.transaction(CONFIG.DB_STORE_TRAIL, 'readwrite');
        const store = transaction.objectStore(CONFIG.DB_STORE_TRAIL);
        const request = store.get(id);
        request.onsuccess = () => {
          const data = request.result;
          if (!data) { resolve(false); return; }
          Object.assign(data, patch);
          store.put(data);
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
    const bytes = new Uint8Array(4 + n * PB);
    bytes[0] = 67; bytes[1] = 84; bytes[2] = 49;
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
