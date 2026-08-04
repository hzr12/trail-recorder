/**
 * Trail Recorder - 多轨迹持久化
 * 使用 IndexedDB 存储多条轨迹，每条轨迹有唯一 ID
 */

class Storage {
  static DB_NAME = 'trailrecorder_db';
  static DB_VERSION = 1;
  static STORE_NAME = 'trails';
  static MAX_TRAILS = 50;
  static LOCAL_KEY_META = 'trailrecorder_meta';

  static _db = null;
  static _dbInitPromise = null;

  /**
   * 初始化 IndexedDB
   */
  static _initDB() {
    if (Storage._db) return Promise.resolve(Storage._db);
    if (Storage._dbInitPromise) return Storage._dbInitPromise;

    Storage._dbInitPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(Storage.DB_NAME, Storage.DB_VERSION);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(Storage.STORE_NAME)) {
          const store = db.createObjectStore(Storage.STORE_NAME, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };

      request.onsuccess = (e) => {
        Storage._db = e.target.result;
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
   * 保存单条轨迹（完整保存）
   */
  static async saveTrail(trail) {
    try {
      const db = await Storage._initDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(Storage.STORE_NAME, 'readwrite');
        const store = tx.objectStore(Storage.STORE_NAME);
        const data = trail.toJSON ? trail.toJSON() : trail;
        data.updatedAt = Date.now();
        store.put(data);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
      });
    } catch (e) {
      console.warn('[Storage] IndexedDB 保存失败，降级 localStorage:', e.message);
      return Storage._saveToLocal(trail);
    }
  }

  /**
   * 加载所有轨迹（按 updatedAt 倒序）
   */
  static async loadAllTrails() {
    try {
      const db = await Storage._initDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(Storage.STORE_NAME, 'readonly');
        const store = tx.objectStore(Storage.STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => {
          const trails = (request.result || [])
            .filter(t => t.positions && t.positions.length > 0)
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            .slice(0, Storage.MAX_TRAILS);
          resolve(trails);
        };
        request.onerror = (e) => reject(e.target.error);
      });
    } catch (e) {
      console.warn('[Storage] IndexedDB 读取失败，降级 localStorage:', e.message);
      return Storage._loadFromLocal();
    }
  }

  /**
   * 加载单条轨迹
   */
  static async loadTrail(id) {
    try {
      const db = await Storage._initDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(Storage.STORE_NAME, 'readonly');
        const store = tx.objectStore(Storage.STORE_NAME);
        const request = store.get(id);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = (e) => reject(e.target.error);
      });
    } catch (e) {
      console.warn('[Storage] IndexedDB 读取失败，降级 localStorage:', e.message);
      return Storage._loadFromLocal(id);
    }
  }

  /**
   * 删除轨迹
   */
  static async deleteTrail(id) {
    try {
      const db = await Storage._initDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(Storage.STORE_NAME, 'readwrite');
        const store = tx.objectStore(Storage.STORE_NAME);
        store.delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
      });
    } catch (e) {
      console.warn('[Storage] IndexedDB 删除失败，降级 localStorage:', e.message);
      return Storage._deleteFromLocal(id);
    }
  }

  /**
   * 更新轨迹名称
   */
  static async updateTrailName(id, name) {
    const trail = await Storage.loadTrail(id);
    if (!trail) return;
    trail.name = name;
    return Storage.saveTrail(trail);
  }

  /**
   * 清除所有轨迹
   */
  static async clearAll() {
    try {
      const db = await Storage._initDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(Storage.STORE_NAME, 'readwrite');
        const store = tx.objectStore(Storage.STORE_NAME);
        store.clear();
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
      });
    } catch (e) {
      localStorage.removeItem(Storage.LOCAL_KEY_META);
      resolve();
    }
  }

  // ─── localStorage 降级存储 ───

  static _saveToLocal(trail) {
    try {
      const data = trail.toJSON ? trail.toJSON() : trail;
      const list = Storage._getLocalList();
      const idx = list.findIndex(t => t.id === data.id);
      if (idx >= 0) {
        list[idx] = { ...list[idx], ...data, updatedAt: Date.now() };
      } else {
        list.push({ ...data, updatedAt: Date.now() });
      }
      // 限制数量
      while (list.length > Storage.MAX_TRAILS) list.shift();
      localStorage.setItem(Storage.LOCAL_KEY_META, JSON.stringify(list));
    } catch (e) {
      console.warn('[Storage] localStorage 保存失败:', e.message);
    }
  }

  static _loadFromLocal() {
    try {
      const raw = localStorage.getItem(Storage.LOCAL_KEY_META);
      if (!raw) return [];
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list.filter(t => t.positions && t.positions.length > 0) : [];
    } catch (e) {
      return [];
    }
  }

  static _loadFromLocal(id) {
    try {
      const list = Storage._loadFromLocal();
      return list.find(t => t.id === id) || null;
    } catch (e) {
      return null;
    }
  }

  static _deleteFromLocal(id) {
    try {
      const list = Storage._getLocalList();
      const idx = list.findIndex(t => t.id === id);
      if (idx >= 0) list.splice(idx, 1);
      localStorage.setItem(Storage.LOCAL_KEY_META, JSON.stringify(list));
    } catch (e) {
      console.warn('[Storage] localStorage 删除失败:', e.message);
    }
  }

  static _getLocalList() {
    try {
      const raw = localStorage.getItem(Storage.LOCAL_KEY_META);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  // ─── 数据迁移 ───

  static async migrateFromOld() {
    try {
      const raw = localStorage.getItem('circlemap_trail');
      if (!raw || raw.length === 0) return false;
      // 尝试解码旧格式
      const decoded = Storage._decodeOldTrail(raw);
      if (!decoded || decoded.positions.length === 0) {
        localStorage.removeItem('circlemap_trail');
        return false;
      }
      // 创建新格式轨迹
      const trail = {
        id: 'migrated_' + Date.now(),
        name: '迁移轨迹',
        positions: decoded.positions,
        startPoint: decoded.positions[0] || null,
        endPoint: decoded.positions[decoded.positions.length - 1] || null,
        annotations: [],
        createdAt: decoded.createdAt || Date.now(),
        updatedAt: Date.now()
      };
      await Storage.saveTrail(trail);
      localStorage.removeItem('circlemap_trail');
      console.info('[Storage] 旧轨迹数据已迁移');
      return true;
    } catch (e) {
      console.warn('[Storage] 迁移失败:', e.message);
      return false;
    }
  }

  static _decodeOldTrail(str) {
    try {
      // 检查是否是 CT1 二进制格式
      if (str.charCodeAt(0) === 84) { // 'T'
        const bytes = new Uint8Array(str.length);
        for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
        if (bytes[0] !== 84 || bytes[1] !== 82 || bytes[2] !== 49) return null; // 不是 TR1
        if (bytes[3] !== 1) return null; // 版本不兼容
        const PB = 26;
        const count = Math.floor((bytes.length - 4) / PB);
        const positions = [];
        const dv = new DataView(bytes.buffer);
        let o = 4;
        for (let i = 0; i < count; i++) {
          const lat = dv.getFloat64(o, true); o += 8;
          const lng = dv.getFloat64(o, true); o += 8;
          const time = dv.getUint32(o, true) * 1000; o += 4;
          const speed = dv.getUint16(o, true) / 100; o += 2;
          const heading = dv.getUint16(o, true) / 100; o += 2;
          const accuracy = dv.getUint16(o, true); o += 2;
          positions.push({ lat, lng, time, speed, heading, accuracy });
        }
        return { positions, createdAt: positions[0]?.time || Date.now() };
      }
      // 尝试 JSON 解析
      const data = JSON.parse(str);
      if (data && Array.isArray(data.positions)) {
        return { positions: data.positions, createdAt: data.createdAt || Date.now() };
      }
      return null;
    } catch (e) {
      return null;
    }
  }
}
