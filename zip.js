/* ==========================================================
   TinyZip —— 极简 zip 打包/解包（只支持 stored，不压缩）
   用途：把「文字 + 截图」打成一个文件做备份，图片本身已是 JPEG，
   再压缩没有意义，所以用 stored 最省事、最快、最不容易出错。

   同时兼容浏览器和 Node（Node 下 module.exports，用来自测）。
   ========================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TinyZip = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');

  function dosDateTime(d) {
    const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((Math.floor(d.getSeconds() / 2)) & 31);
    const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time, date };
  }

  /**
   * files: [{ name: string, data: Uint8Array, date?: Date }]
   * 返回：Uint8Array（完整 zip 字节）
   */
  function build(files) {
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = encoder.encode(f.name);
      const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
      const crc = crc32(data);
      const { time, date } = dosDateTime(f.date || new Date());

      const lh = new Uint8Array(30 + nameBytes.length);
      const ld = new DataView(lh.buffer);
      ld.setUint32(0, 0x04034b50, true);   // local file header
      ld.setUint16(4, 20, true);           // version needed
      ld.setUint16(6, 0x0800, true);       // flag: UTF-8 名称
      ld.setUint16(8, 0, true);            // method: stored
      ld.setUint16(10, time, true);
      ld.setUint16(12, date, true);
      ld.setUint32(14, crc, true);
      ld.setUint32(18, data.length, true);
      ld.setUint32(22, data.length, true);
      ld.setUint16(26, nameBytes.length, true);
      ld.setUint16(28, 0, true);           // extra len
      lh.set(nameBytes, 30);

      chunks.push(lh, data);

      const ch = new Uint8Array(46 + nameBytes.length);
      const cd = new DataView(ch.buffer);
      cd.setUint32(0, 0x02014b50, true);   // central directory header
      cd.setUint16(4, 20, true);           // version made by
      cd.setUint16(6, 20, true);           // version needed
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, time, true);
      cd.setUint16(14, date, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint16(30, 0, true);           // extra
      cd.setUint16(32, 0, true);           // comment
      cd.setUint16(34, 0, true);           // disk number
      cd.setUint16(36, 0, true);           // internal attrs
      cd.setUint32(38, 0, true);           // external attrs
      cd.setUint32(42, offset, true);      // local header offset
      ch.set(nameBytes, 46);
      central.push(ch);

      offset += lh.length + data.length;
    }

    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const eocd = new Uint8Array(22);
    const ed = new DataView(eocd.buffer);
    ed.setUint32(0, 0x06054b50, true);
    ed.setUint16(4, 0, true);
    ed.setUint16(6, 0, true);
    ed.setUint16(8, files.length, true);
    ed.setUint16(10, files.length, true);
    ed.setUint32(12, cdSize, true);
    ed.setUint32(16, offset, true);
    ed.setUint16(20, 0, true);

    const all = chunks.concat(central, [eocd]);
    const total = all.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of all) {
      out.set(c, p);
      p += c.length;
    }
    return out;
  }

  /**
   * bytes: Uint8Array
   * 返回：Map<name, Uint8Array>
   */
  function parse(bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    let eocd = -1;
    const minStart = Math.max(0, buf.length - 22 - 0xFFFF);
    for (let i = buf.length - 22; i >= minStart; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 zip 文件');

    const count = dv.getUint16(eocd + 10, true);
    const cdOffset = dv.getUint32(eocd + 16, true);

    const out = new Map();
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip 目录损坏，无法读取');
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));

      if (method !== 0) throw new Error('不支持的压缩方式，请使用本应用导出的备份文件');

      if (dv.getUint32(localOff, true) !== 0x04034b50) throw new Error('zip 数据损坏');
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const start = localOff + 30 + lNameLen + lExtraLen;
      out.set(name, buf.subarray(start, start + compSize));

      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  return { build, parse, crc32 };
});
