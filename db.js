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

  /* 解码/编码有可能在某些机型上一直不回调（内存不够时会这样），
     所以每一步都加超时，超时就当这张图失败，别把整个流程拖死 */
  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(label || '处理超时')), ms);
      })
    ]);
  }

  /* 把任意图片源画到 canvas 再编码成 JPEG */
  async function toJpeg(source, w0, h0, limit, quality) {
    const scale = Math.min(1, limit / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0f1218';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    const blob = await withTimeout(
      new Promise(res => canvas.toBlob(res, 'image/jpeg', quality)),
      15000,
      '图片编码超时（这张可能太大了）'
    );
    if (!blob) throw new Error('图片编码失败');
    return blob;
  }

  /* 解码：优先 createImageBitmap（后台线程，Safari 15+），失败退回 <img> */
  async function decode(source) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bmp = await withTimeout(createImageBitmap(source), 8000, '解码超时');
        return { img: bmp, w: bmp.width, h: bmp.height, cleanup: () => { if (bmp.close) bmp.close(); } };
      } catch (e) { /* 走下面的兜底 */ }
    }
    const url = URL.createObjectURL(source);
    const el = await withTimeout(new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('这张图读不出来'));
      img.src = url;
    }), 15000, '图片读取超时（这张可能太大了）');
    return {
      img: el,
      w: el.naturalWidth || el.width,
      h: el.naturalHeight || el.height,
      cleanup: () => URL.revokeObjectURL(url)
    };
  }

  /* 原图：长边 1800px、质量 0.86 —— 手机截图基本保持原尺寸，尽量不糊 */
  async function compressImage(file, maxSide, quality) {
    const limit = maxSide || 1800;
    const q = quality || 0.86;
    const d = await decode(file);
    try {
      if (!d.w || !d.h) throw new Error('图片尺寸异常');
      return await toJpeg(d.img, d.w, d.h, limit, q);
    } finally {
      d.cleanup();
    }
  }

  /* 缩略图：长边 480px、质量 0.72，给列表和表单用，几十 KB 一张 */
  async function makeThumb(sourceBlob, maxSide, quality) {
    const limit = maxSide || 480;
    const q = quality || 0.72;
    const d = await decode(sourceBlob);
    try {
      if (!d.w || !d.h) throw new Error('缩略图生成失败');
      return await toJpeg(d.img, d.w, d.h, limit, q);
    } finally {
      d.cleanup();
    }
  }

  /* 一张图只解码一次，同时产出原图和缩略图（比解码两次快一倍） */
  async function processImage(file) {
    const d = await decode(file);
    try {
      if (!d.w || !d.h) throw new Error('图片尺寸异常');
      const full = await toJpeg(d.img, d.w, d.h, 1800, 0.86);
      const thumb = await toJpeg(d.img, d.w, d.h, 480, 0.72);
      return { full, thumb };
    } finally {
      d.cleanup();
    }
  }

  /* 从已经画好的 canvas 直接出缩略图（裁剪后用，省一次解码） */
  async function thumbFromCanvas(canvas, maxSide, quality) {
    return toJpeg(canvas, canvas.width, canvas.height, maxSide || 480, quality || 0.72);
  }

  return {
    open,
    newId,
    putMany,
    compressImage,
    makeThumb,
    processImage,
    thumbFromCanvas,
    get: (store, key) => tx(store, 'readonly', os => os.get(key)),
    put: (store, value) => tx(store, 'readwrite', os => os.put(value)),
    del: (store, key) => tx(store, 'readwrite', os => os.delete(key)),
    all: (store) => tx(store, 'readonly', os => os.getAll()),
    keys: (store) => tx(store, 'readonly', os => os.getAllKeys()),
    clear: (store) => tx(store, 'readwrite', os => os.clear())
  };
})();
