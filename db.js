/* ==========================================================
   Store —— IndexedDB 数据层
   两条数据线：
     kv  : { k:'state', v:{ trades, reviews, quotes, settings } }  文字，很小
     img : { id, blob, bytes, at }                                 截图，按需读写
   所有数据只在这台设备上，不发任何网络请求。
   ========================================================== */
'use strict';

const Store = (function () {
  const DB_NAME = 'trade-diary';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('这个浏览器不支持本地数据库'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('img')) db.createObjectStore('img', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('数据库打开失败'));
      req.onblocked = () => reject(new Error('数据库被另一个页面占用，请关掉其他标签页'));
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      let t;
      try {
        t = db.transaction(store, mode);
      } catch (e) {
        reject(e);
        return;
      }
      const os = t.objectStore(store);
      let result;
      let req;
      try {
        req = fn(os);
      } catch (e) {
        reject(e);
        return;
      }
      if (req) req.onsuccess = () => { result = req.result; };
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error || new Error('数据库操作失败'));
      t.onabort = () => reject(t.error || new Error('数据库操作被中止'));
    }));
  }

  function newId() {
    return 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  async function putMany(store, items) {
    if (!items.length) return 0;
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, 'readwrite');
      const os = t.objectStore(store);
      items.forEach(it => os.put(it));
      t.oncomplete = () => resolve(items.length);
      t.onerror = () => reject(t.error || new Error('批量写入失败'));
    });
  }

  /* 压缩：长边 1400px、JPEG 质量 0.8，手机截图约 120–300KB
     优先用 createImageBitmap（解码在后台线程，Safari 15+ 支持），失败退回 <img> */
  async function compressImage(file, maxSide, quality) {
    const limit = maxSide || 1400;
    const q = quality || 0.8;
    let bmp = null;
    let url = null;
    let el = null;

    try {
      if (typeof createImageBitmap === 'function') {
        try { bmp = await createImageBitmap(file); } catch (e) { bmp = null; }
      }

      if (!bmp) {
        url = URL.createObjectURL(file);
        el = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('这张图读不出来'));
          img.src = url;
        });
      }

      const w0 = bmp ? bmp.width : (el.naturalWidth || el.width);
      const h0 = bmp ? bmp.height : (el.naturalHeight || el.height);
      if (!w0 || !h0) throw new Error('图片尺寸异常');

      const scale = Math.min(1, limit / Math.max(w0, h0));
      const w = Math.max(1, Math.round(w0 * scale));
      const h = Math.max(1, Math.round(h0 * scale));

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0f1218';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp || el, 0, 0, w, h);

      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', q));
      if (!blob) throw new Error('图片压缩失败');
      return blob;
    } finally {
      if (bmp && typeof bmp.close === 'function') bmp.close();
      if (url) URL.revokeObjectURL(url);
    }
  }

  return {
    open,
    newId,
    putMany,
    compressImage,
    get: (store, key) => tx(store, 'readonly', os => os.get(key)),
    put: (store, value) => tx(store, 'readwrite', os => os.put(value)),
    del: (store, key) => tx(store, 'readwrite', os => os.delete(key)),
    all: (store) => tx(store, 'readonly', os => os.getAll()),
    keys: (store) => tx(store, 'readonly', os => os.getAllKeys()),
    clear: (store) => tx(store, 'readwrite', os => os.clear())
  };
})();
