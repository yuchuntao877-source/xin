'use strict';

/* ==========================================================
   交易手记 v1.0
   只记两件事：每天的心得、每一笔买卖的心得（配 K 线截图 + 盈亏）
   数据全部在本机 IndexedDB，不发任何网络请求。
   ========================================================== */

/* ---------------- 小工具 ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = k => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const now = new Date();
const TODAY_KEY = ymd(now);

const fn = (n, d = 2) => {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  return (v < 0 ? '-' : '') + s;
};
const fsign = (n, d = 2) => {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  return (v > 0 ? '+' : v < 0 ? '-' : '') + s;
};
const cls = n => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const sideText = s => (s === 'buy' ? '买' : '卖');
const sideFull = s => (s === 'buy' ? '买入' : '卖出');

/* ---------------- 运行期状态 ---------------- */
let trades = [];
let reviews = {};
let quotes = [];
let settings = { theme: 'dark', zoom: 1, updown: 'cn', lastExport: '' };

const imgUrls = new Map();     // 图片 id -> objectURL
let imgBytes = 0;

const PLACEHOLDER = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="210" viewBox="0 0 320 210">' +
  '<rect width="320" height="210" fill="#1a1f28"/>' +
  '<text x="160" y="112" font-size="13" fill="#6c7488" text-anchor="middle">图片已丢失</text></svg>'
);

const shotUrl = id => imgUrls.get(id) || PLACEHOLDER;

const ui = {
  side: 'buy',
  sub: 'flow',
  star: 4,
  calMonth: new Date(now.getFullYear(), now.getMonth(), 1),
  noteDate: TODAY_KEY,
  noteTab: 'mine',
  qtag: '',
  editingId: null,
  editingQuote: null,
  draftShots: [],
  reviewShots: [],
  query: '',
  sheet: null
};

/* ==========================================================
   计算
   ========================================================== */
function computePositions(list) {
  const map = new Map();
  list.slice()
    .sort((a, b) => ((a.date + a.time) < (b.date + b.time) ? -1 : 1))
    .forEach(t => {
      const key = t.code || t.name;
      const p = map.get(key) || { code: t.code, name: t.name, qty: 0, cost: 0 };
      if (t.side === 'buy') {
        const total = p.cost * p.qty + t.price * t.qty + (t.fee || 0);
        p.qty += t.qty;
        p.cost = p.qty ? total / p.qty : 0;
        p.name = t.name;
      } else {
        p.qty -= t.qty;
        p.name = t.name;
      }
      if (p.qty > 0.0001) map.set(key, p); else map.delete(key);
    });
  return Array.from(map.values());
}

const dayPnl = key => trades.filter(t => t.date === key).reduce((s, t) => s + (t.pnl || 0), 0);
const totalPnl = () => trades.reduce((s, t) => s + (t.pnl || 0), 0);
const dayCount = key => trades.filter(t => t.date === key).length;

function streak() {
  let n = 0;
  let d = new Date(now);
  if (!reviews[ymd(d)]) d = addDays(d, -1);
  while (reviews[ymd(d)]) {
    n++;
    d = addDays(d, -1);
  }
  return n;
}

/* ==========================================================
   持久化
   ========================================================== */
let saveTimer = null;

function snapshot() {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    trades, reviews, quotes, settings
  };
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    await Store.put('kv', { k: 'state', v: snapshot() });
  } catch (e) {
    showFatal('保存失败：' + (e.message || e));
  }
}

async function loadAll() {
  const rec = await Store.get('kv', 'state');
  if (rec && rec.v) {
    trades = Array.isArray(rec.v.trades) ? rec.v.trades : [];
    reviews = rec.v.reviews && typeof rec.v.reviews === 'object' ? rec.v.reviews : {};
    quotes = Array.isArray(rec.v.quotes) ? rec.v.quotes : [];
    settings = Object.assign({ theme: 'dark', zoom: 1, updown: 'cn', lastExport: '' }, rec.v.settings || {});
  }
  const imgs = (await Store.all('img')) || [];
  imgBytes = 0;
  imgs.forEach(it => {
    if (it && it.id && it.blob) {
      imgUrls.set(it.id, URL.createObjectURL(it.blob));
      imgBytes += it.bytes || it.blob.size || 0;
    }
  });
}

/* ==========================================================
   图片
   ========================================================== */
async function addImage(file) {
  const blob = await Store.compressImage(file);
  const id = Store.newId();
  await Store.put('img', { id, blob, bytes: blob.size, at: Date.now() });
  imgUrls.set(id, URL.createObjectURL(blob));
  imgBytes += blob.size;
  return id;
}

async function removeImages(ids) {
  for (const id of ids) {
    const url = imgUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    imgUrls.delete(id);
    try { await Store.del('img', id); } catch (e) { /* 忽略 */ }
  }
}

async function gcImages() {
  try {
    const used = new Set();
    trades.forEach(t => (t.shots || []).forEach(id => used.add(id)));
    Object.keys(reviews).forEach(k => (reviews[k].shots || []).forEach(id => used.add(id)));
    ui.draftShots.forEach(id => used.add(id));
    ui.reviewShots.forEach(id => used.add(id));
    const all = (await Store.all('img')) || [];
    const dead = all.filter(it => !used.has(it.id)).map(it => it.id);
    if (dead.length) {
      imgBytes = Math.max(0, imgBytes - all.filter(it => !used.has(it.id)).reduce((s, it) => s + (it.bytes || 0), 0));
      await removeImages(dead);
    }
  } catch (e) { /* 回收失败不影响使用 */ }
}

/* ==========================================================
   渲染：今日
   ========================================================== */
function recItem(t, opts = {}) {
  const d = parseKey(t.date);
  const dateLabel = opts.showDate ? `${d.getMonth() + 1}月${d.getDate()}日 · ` : '';
  const pnlHtml = t.side === 'sell'
    ? `<span class="rec-pnl num ${cls(t.pnl)}">${t.pnl == null ? '—' : fsign(t.pnl)}</span>`
    : '<span class="rec-pnl" style="color:var(--text-3);font-size:var(--fs-sm)">持仓中</span>';
  const tags = (t.reasons || []).map(r => `<i>${esc(r)}</i>`).join('') + (t.mood ? `<i class="mood">${esc(t.mood)}</i>` : '');
  const shots = t.shots || [];
  const media = shots.length ? `
    <div class="rec-media">
      <div class="rec-track">${shots.map(id => `<img src="${shotUrl(id)}" data-view alt="">`).join('')}</div>
      ${shots.length > 1 ? `<span class="rec-count">${shots.length} 张 · 左右滑</span>` : ''}
    </div>` : '';
  return `
    <article class="rec" data-trade="${t.id}" role="button" tabindex="0">
      ${media}
      <div class="rec-body">
        <div class="rec-meta">
          <span class="badge ${t.side}">${sideText(t.side)}</span>
          <span class="rec-name">${esc(t.name)}</span>
          <span class="code">${esc(t.code || '')}</span>
          ${pnlHtml}
        </div>
        <div class="rec-sub">${dateLabel}${fn(t.price)} × ${t.qty}${t.fee ? ' · 手续费 ' + fn(t.fee) : ''}${opts.showDate ? ' · ' + t.time : ''}</div>
        <p class="rec-note ${t.note ? '' : 'muted'}">${t.note ? esc(t.note) : '（还没写心得）'}</p>
        ${tags ? `<div class="rec-tags">${tags}</div>` : ''}
      </div>
    </article>`;
}

function renderShots(sel, arr, who) {
  const box = $(sel);
  if (!box) return;
  box.innerHTML = arr.map((id, i) => `
    <div class="shot">
      <img src="${shotUrl(id)}" data-view alt="">
      <button class="shot-crop" data-crop="${i}" data-who="${who}">裁剪</button>
      <button class="shot-x" data-rm="${i}" data-who="${who}" aria-label="删除">✕</button>
    </div>`).join('') + `
    <button class="shot-add" type="button" data-add="${who}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      <span>添加 K 线截图</span>
    </button>`;
}

function renderHome() {
  $('#homeDate').textContent = `${now.getMonth() + 1}月${now.getDate()}日`;
  const totalDays = Object.keys(reviews).length;
  $('#homeWeek').textContent = totalDays ? `${WEEK[now.getDay()]} · 已记 ${totalDays} 天` : `${WEEK[now.getDay()]} · 还没有记录`;

  const today = trades.filter(t => t.date === TODAY_KEY);
  const pnl = dayPnl(TODAY_KEY);
  const hero = $('#heroPnl');
  hero.textContent = today.length ? fsign(pnl) : '—';
  hero.className = 'hero-num num ' + (today.length ? cls(pnl) : '');
  const fee = today.reduce((s, t) => s + (t.fee || 0), 0);
  const sells = today.filter(t => t.side === 'sell').length;
  $('#heroMeta').textContent = today.length
    ? `${today.length} 笔 · 卖出 ${sells} 笔 · 手续费 ${fn(fee)}`
    : '今天还没有交易记录';

  $('#todayTrades').innerHTML = today.length
    ? today.slice().sort((a, b) => (a.time < b.time ? 1 : -1)).map(t => recItem(t)).join('')
    : '<p class="empty">点下面的「记一笔」开始</p>';

  const empty = !trades.length && !Object.keys(reviews).length;
  $('#onboard').hidden = !empty;

  const rv = reviews[TODAY_KEY];
  const pill = $('#noteStar');
  if (rv && (rv.text || (rv.shots || []).length)) {
    pill.textContent = '★'.repeat(rv.star || 0);
    pill.classList.add('star');
    const linked = (rv.checks || []).length;
    $('#todayNote').innerHTML = `
      <p class="note-text">${esc(rv.text || '')}</p>
      <div class="note-meta">
        ${rv.plan ? `<i>明日：${esc(rv.plan)}</i>` : ''}
        ${linked ? `<i>标记做对 ${linked} 笔</i>` : ''}
        ${rv.shots && rv.shots.length ? `<i>${rv.shots.length} 张图</i>` : ''}
      </div>`;
  } else {
    pill.textContent = '还没写';
    pill.classList.remove('star');
    $('#todayNote').innerHTML = '<p class="note-text" style="color:var(--text-3)">今天还没写心得。哪怕只写一句「今天为什么没做」，也比空白强。</p>';
  }

  const keys = Object.keys(reviews).filter(k => k !== TODAY_KEY).sort().reverse().slice(0, 2);
  $('#recentNotes').innerHTML = keys.length ? keys.map(key => {
    const r = reviews[key];
    const d = parseKey(key);
    const p = dayPnl(key);
    return `
      <div class="ti" data-note="${key}" role="button" tabindex="0">
        <div class="ti-head">
          <span class="nv-day">${d.getDate()}</span>
          <span class="hint">${d.getMonth() + 1}月 ${WEEK[d.getDay()]}</span>
          <span class="ti-price num ${cls(p)}">${fsign(p)}</span>
        </div>
        <p class="ti-note">${esc(String(r.text || '').replace(/\n+/g, ' ') || '（只记了心情）')}</p>
      </div>`;
  }).join('') : '<p class="empty">还没有记录</p>';

  const qList = quotes.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  const dayIdx = qList.length ? Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000) % qList.length : 0;
  const qd = qList[dayIdx];
  $('#homeQuote').innerHTML = qd
    ? `<p class="q-text">${esc(qd.text)}</p><div class="q-foot"><span class="q-src">— ${esc(qd.source || '没记出处')}</span>${(qd.tags || []).map(t => `<i>${esc(t)}</i>`).join('')}</div>`
    : '<p class="empty" style="padding:14px 0">还没有语录，去「心得 → 大佬语录」加一条</p>';
}

/* ==========================================================
   渲染：交易
   ========================================================== */
function renderTrades() {
  $('#tradeSub').textContent = trades.length
    ? `共 ${trades.length} 笔 · 累计 ${fsign(totalPnl())}`
    : '还没有记录';

  const groups = {};
  trades.forEach(t => { (groups[t.date] = groups[t.date] || []).push(t); });
  const keys = Object.keys(groups).sort().reverse();

  $('#flowPane').innerHTML = keys.length ? keys.map(key => {
    const list = groups[key].slice().sort((a, b) => (a.time < b.time ? 1 : -1));
    const p = dayPnl(key);
    const dt = parseKey(key);
    const label = key === TODAY_KEY ? '今天' : `${dt.getMonth() + 1}月${dt.getDate()}日`;
    return `
      <div class="day-hd">
        <span>${label} ${WEEK[dt.getDay()]} · ${list.length} 笔</span>
        <b class="num ${cls(p)}">${fsign(p)}</b>
      </div>
      <div class="reclist">${list.map(t => recItem(t)).join('')}</div>`;
  }).join('') : `<div class="card"><p class="empty">还没有交易记录<br><span class="hint">点右上角「＋ 记一笔」开始</span></p></div>`;

  const pos = computePositions(trades);
  $('#posDetail').innerHTML = pos.length ? pos.map(p => `
    <div class="pi">
      <div class="pi-l"><b>${esc(p.name)}</b><span>${esc(p.code || '')} · ${p.qty} 股</span></div>
      <div class="pi-r"><b class="num">${fn(p.cost)}</b><span>摊薄成本</span></div>
    </div>`).join('') : '<p class="empty">当前空仓</p>';

  $('#stCount').textContent = pos.length;
  $('#stCost').textContent = fn(pos.reduce((s, p) => s + p.cost * p.qty, 0), 0);
  const tp = totalPnl();
  $('#stPnl').textContent = fsign(tp, 0);
  $('#stPnl').className = 'num ' + cls(tp);

  renderStockPane();
}

function stockGroups() {
  const map = new Map();
  trades.forEach(t => {
    const key = t.code || t.name;
    const g = map.get(key) || { key, name: t.name, code: t.code, list: [] };
    g.name = t.name;
    g.code = t.code;
    g.list.push(t);
    map.set(key, g);
  });
  return Array.from(map.values()).map(g => {
    g.list.sort((a, b) => ((a.date + a.time) < (b.date + b.time) ? 1 : -1));
    g.last = g.list[0].date;
    g.pnl = g.list.reduce((s, t) => s + (t.pnl || 0), 0);
    g.sells = g.list.filter(t => t.side === 'sell');
    g.wins = g.sells.filter(t => (t.pnl || 0) > 0).length;
    return g;
  }).sort((a, b) => (a.last < b.last ? 1 : -1));
}

function renderStockPane() {
  const groups = stockGroups();
  $('#stockList').innerHTML = groups.length ? groups.map(g => {
    const d = parseKey(g.last);
    return `
      <button class="row" data-stock="${esc(g.key)}">
        <span class="r-ic">${esc(g.name.slice(0, 1))}</span>
        <span class="r-main">
          <span class="r-title">${esc(g.name)} <span class="code">${esc(g.code || '')}</span></span>
          <span class="r-desc">${g.list.length} 笔 · 最近 ${d.getMonth() + 1}月${d.getDate()}日</span>
        </span>
        <span class="num ${cls(g.pnl)}">${fsign(g.pnl)}</span>
      </button>`;
  }).join('') : '<p class="empty" style="padding:20px">还没有交易记录</p>';
}

function openStock(key) {
  const g = stockGroups().find(x => x.key === key);
  if (!g) return;
  $('#stockTitle').textContent = g.name;

  const sells = g.sells.length;
  const winRate = sells ? Math.round((g.wins / sells) * 100) + '%' : '—';
  const timeline = g.list.map(t => recItem(t, { showDate: true })).join('');

  $('#stockBody').innerHTML = `
    <div class="card" style="margin:0">
      <div class="ti-head">
        <span class="ti-name" style="font-size:var(--fs-xl)">${esc(g.name)}</span>
        <span class="code">${esc(g.code || '')}</span>
      </div>
      <div class="stat-row" style="margin:12px 0 0">
        <div class="stat"><b class="num ${cls(g.pnl)}">${fsign(g.pnl, 0)}</b><span>累计盈亏</span></div>
        <div class="stat"><b class="num">${g.list.length}</b><span>交易笔数</span></div>
        <div class="stat"><b class="num">${winRate}</b><span>卖出胜率</span></div>
      </div>
    </div>
    <div class="card-hd" style="padding:2px 2px 0">
      <h2 style="margin:0;font-size:var(--fs-lg);font-weight:600">买卖与心得</h2>
      <span class="hint">共 ${g.list.length} 条</span>
    </div>
    <div class="reclist">${timeline}</div>`;
  openSheet('stock');
}

/* ==========================================================
   渲染：心得
   ========================================================== */
function renderCalendar() {
  const y = ui.calMonth.getFullYear();
  const m = ui.calMonth.getMonth();
  $('#calTitle').textContent = `${y}年${m + 1}月`;

  const first = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  let html = '';
  for (let i = 0; i < first; i++) html += '<button class="cal-cell blank" disabled></button>';
  for (let d = 1; d <= days; d++) {
    const key = `${y}-${pad(m + 1)}-${pad(d)}`;
    const has = !!reviews[key];
    const p = dayPnl(key);
    const c = ['cal-cell'];
    if (has) c.push('has');
    if (p > 0) c.push('win');
    else if (p < 0) c.push('loss');
    if (key === TODAY_KEY) c.push('today');
    html += `<button class="${c.join(' ')}" data-day="${key}">${d}${has ? '<i class="dot"></i>' : ''}</button>`;
  }
  $('#calGrid').innerHTML = html;

  const prefix = `${y}-${pad(m + 1)}`;
  const keys = Object.keys(reviews).filter(k => k.startsWith(prefix));
  const tradeDays = Array.from(new Set(trades.map(t => t.date).filter(d => d.startsWith(prefix))));
  const pnl = tradeDays.reduce((s, k) => s + dayPnl(k), 0);
  const wins = tradeDays.filter(k => dayPnl(k) > 0).length;
  $('#calDays').textContent = keys.length;
  $('#calPnl').textContent = fsign(pnl, 0);
  $('#calPnl').className = 'num ' + cls(pnl);
  $('#calWin').textContent = tradeDays.length ? Math.round((wins / tradeDays.length) * 100) + '%' : '—';
}

function renderNoteList() {
  const q = ui.query.trim().toLowerCase();
  let keys = Object.keys(reviews).sort().reverse();
  if (q) {
    keys = keys.filter(key => {
      const r = reviews[key];
      const hay = [r.text, r.plan, ...(r.checks || [])].join(' ').toLowerCase();
      const names = trades.filter(t => t.date === key).map(t => `${t.name} ${t.code || ''} ${t.note || ''}`).join(' ').toLowerCase();
      return hay.includes(q) || names.includes(q);
    });
  }

  const total = Object.keys(reviews).length;
  $('#noteSub').textContent = `${total} 篇 · ${quotes.length} 条语录 · 连续 ${streak()} 天`;
  $('#listTitle').textContent = q ? '搜索结果' : '全部记录';
  $('#listCount').textContent = q ? `${keys.length} 条匹配` : `共 ${keys.length} 天`;

  $('#noteList').innerHTML = keys.length ? keys.map(key => {
    const r = reviews[key];
    const d = parseKey(key);
    const p = dayPnl(key);
    const n = dayCount(key);
    const shots = (r.shots || []).length + trades.filter(t => t.date === key).reduce((s, t) => s + (t.shots || []).length, 0);
    return `
      <div class="nv" data-note="${key}" role="button" tabindex="0">
        <div class="nv-hd">
          <span class="nv-day">${d.getDate()}</span>
          <span>${d.getMonth() + 1}月 ${WEEK[d.getDay()]}</span>
          <span class="nv-score">${'★'.repeat(r.star || 0)}</span>
          <span class="num ${cls(p)}" style="margin-left:auto">${fsign(p)}</span>
        </div>
        <p>${esc(String(r.text || '（只记了心情，没写字）'))}</p>
        <div class="nv-ft">
          ${n ? `<span>${n} 笔交易</span>` : ''}
          ${shots ? `<span>· ${shots} 张图</span>` : ''}
          ${r.plan ? `<span style="margin-left:auto">明日：${esc(r.plan)}</span>` : ''}
        </div>
      </div>`;
  }).join('') : `<div class="card"><p class="empty">${q ? '没找到匹配的记录' : '还没有心得<br><span class="hint">点日历上的今天开始写</span>'}</p></div>`;
}

/* ==========================================================
   渲染：语录
   ========================================================== */
function renderTagFilter() {
  const tags = Array.from(new Set(quotes.flatMap(x => x.tags || [])));
  $('#tagFilter').innerHTML =
    `<button class="chip ${ui.qtag ? '' : 'on'}" data-qtag="">全部</button>` +
    tags.map(t => `<button class="chip ${ui.qtag === t ? 'on' : ''}" data-qtag="${esc(t)}">${esc(t)}</button>`).join('');
}

function renderQuotes() {
  const q = ui.query.trim().toLowerCase();
  let list = quotes.slice();
  if (q) list = list.filter(x => `${x.text} ${x.source || ''} ${(x.tags || []).join(' ')}`.toLowerCase().includes(q));
  if (ui.qtag) list = list.filter(x => (x.tags || []).includes(ui.qtag));
  list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (a.date < b.date ? 1 : -1));

  $('#quoteCount').textContent = `${quotes.length} 条`;
  renderTagFilter();

  $('#quoteList').innerHTML = list.length ? list.map(r => `
    <div class="quote ${r.pinned ? 'pinned' : ''}" data-quote="${r.id}" role="button" tabindex="0">
      <p class="q-text">${esc(r.text)}</p>
      <div class="q-foot">
        <span class="q-src">— ${esc(r.source || '没记出处')}</span>
        ${(r.tags || []).map(t => `<i>${esc(t)}</i>`).join('')}
        <button class="q-pin ${r.pinned ? 'on' : ''}" data-pin="${r.id}" aria-label="置顶">★</button>
      </div>
    </div>`).join('')
    : `<div class="card"><p class="empty">${quotes.length ? '没有匹配的语录' : '还没有语录<br><span class="hint">点右上角「＋ 加一条」</span>'}</p></div>`;
}

function setNoteTab(name) {
  ui.noteTab = name;
  $$('#noteSeg button').forEach(b => b.classList.toggle('on', b.dataset.ntab === name));
  $('#minePane').hidden = name !== 'mine';
  $('#quotePane').hidden = name !== 'quotes';
  $('#notesFoot').textContent = name === 'mine' ? '点任意一天，补写那天的记录' : '语录存在本机，随时可以改';
}

/* ==========================================================
   渲染：我的
   ========================================================== */
function renderMe() {
  const shotCount = trades.reduce((s, t) => s + (t.shots || []).length, 0)
    + Object.keys(reviews).reduce((s, k) => s + (reviews[k].shots || []).length, 0);

  const dates = trades.map(t => t.date).concat(Object.keys(reviews)).sort();
  const since = dates.length ? parseKey(dates[0]) : null;

  $('#meTrades').textContent = trades.length;
  $('#meShots').textContent = shotCount;
  $('#meSize').textContent = imgBytes ? (imgBytes / 1048576).toFixed(1) + 'M' : '—';
  $('#meSince').textContent = since
    ? `自 ${since.getFullYear()} 年 ${since.getMonth() + 1} 月开始记录 · 连续 ${streak()} 天`
    : '还没有记录，从今天开始吧';

  let exportText = '还没导出过，建议先做一次';
  if (settings.lastExport) {
    const d = new Date(settings.lastExport);
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    exportText = `上次：${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (days >= 14) exportText += `（${days} 天前，该备份了）`;
  }
  const el = $('#lastExportText');
  el.textContent = exportText;
  el.style.color = settings.lastExport && (Date.now() - new Date(settings.lastExport).getTime()) < 14 * 86400000
    ? '' : 'var(--star)';
}

function renderAll() {
  renderHome();
  renderTrades();
  renderCalendar();
  renderNoteList();
  renderQuotes();
  renderMe();
}

/* ==========================================================
   设置
   ========================================================== */
function applySettings() {
  const theme = settings.theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.updown = settings.updown === 'intl' ? 'intl' : 'cn';
  const zoom = [0.94, 1, 1.1];
  const zi = settings.zoom <= 0.97 ? 0 : settings.zoom >= 1.05 ? 2 : 1;
  document.documentElement.style.setProperty('--zoom', String(zoom[zi]));

  const swTheme = $('#swTheme');
  swTheme.classList.toggle('on', theme === 'dark');
  swTheme.setAttribute('aria-checked', String(theme === 'dark'));

  const swUpdown = $('#swUpdown');
  swUpdown.classList.toggle('on', settings.updown !== 'intl');
  swUpdown.setAttribute('aria-checked', String(settings.updown !== 'intl'));

  $('#fsRange').value = zi;
  $('#fsLabel').textContent = ['小', '标准', '大'][zi];

  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f2f4f8' : '#0f1218');
}

/* ==========================================================
   弹层 / 提示
   ========================================================== */
function openSheet(name) {
  const el = document.getElementById('sheet-' + name);
  if (!el) return;
  ui.sheet = name;
  $('#overlay').classList.add('show');
  el.classList.add('is-open');
  el.setAttribute('aria-hidden', 'false');
}

function closeSheet() {
  $('#overlay').classList.remove('show');
  $$('.sheet.is-open').forEach(s => {
    s.classList.remove('is-open');
    s.setAttribute('aria-hidden', 'true');
  });
  ui.sheet = null;
}

/* ---- 看大图：双指 / 双击 / 滚轮缩放 ---- */
const zoom = { scale: 1, tx: 0, ty: 0 };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function applyZoom() {
  $('#viewerImg').style.transform = `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`;
}

function clampPan() {
  const maxX = (zoom.scale - 1) * window.innerWidth / 2;
  const maxY = (zoom.scale - 1) * window.innerHeight / 2;
  zoom.tx = clamp(zoom.tx, -maxX, maxX);
  zoom.ty = clamp(zoom.ty, -maxY, maxY);
}

function resetZoom() {
  zoom.scale = 1;
  zoom.tx = 0;
  zoom.ty = 0;
  applyZoom();
}

function openViewer(src) {
  $('#viewerImg').src = src;
  resetZoom();
  $('#viewer').classList.add('show');
  $('#viewer').setAttribute('aria-hidden', 'false');
}

function closeViewer() {
  $('#viewer').classList.remove('show');
  $('#viewer').setAttribute('aria-hidden', 'true');
  resetZoom();
}

/* ---- 裁剪 ---- */
const cropState = {
  open: false, who: null, index: -1, oldId: null,
  imgEl: null, natW: 0, natH: 0, dispW: 0, dispH: 0,
  box: { x: 0, y: 0, w: 0, h: 0 }, drag: null
};

function paintCropBox() {
  const b = cropState.box;
  const el = $('#cropBox');
  el.style.left = b.x + 'px';
  el.style.top = b.y + 'px';
  el.style.width = b.w + 'px';
  el.style.height = b.h + 'px';
}

function layoutCropper() {
  const body = $('.crop-body');
  const stage = $('#cropStage');
  const availW = Math.max(80, body.clientWidth - 24);
  const availH = Math.max(80, body.clientHeight - 12);
  const scale = Math.min(availW / cropState.natW, availH / cropState.natH);
  const w = Math.max(40, Math.round(cropState.natW * scale));
  const h = Math.max(40, Math.round(cropState.natH * scale));
  cropState.dispW = w;
  cropState.dispH = h;
  stage.style.width = w + 'px';
  stage.style.height = h + 'px';
  cropState.box = { x: 0, y: 0, w, h };
  paintCropBox();
}

function openCropper(index, who) {
  const arr = who === 'draft' ? ui.draftShots : ui.reviewShots;
  const id = arr[index];
  if (!id) return;

  const img = new Image();
  img.onload = () => {
    cropState.open = true;
    cropState.who = who;
    cropState.index = index;
    cropState.oldId = id;
    cropState.imgEl = img;
    cropState.natW = img.naturalWidth || 1;
    cropState.natH = img.naturalHeight || 1;
    $('#cropImg').src = shotUrl(id);
    $('#cropper').hidden = false;
    requestAnimationFrame(layoutCropper);
  };
  img.onerror = () => toast('这张图读不出来');
  img.src = shotUrl(id);
}

function closeCropper() {
  $('#cropper').hidden = true;
  cropState.open = false;
  cropState.imgEl = null;
  cropState.drag = null;
}

async function applyCrop() {
  if (!cropState.open) return;
  const b = cropState.box;
  const k = cropState.natW / cropState.dispW;
  const sx = Math.max(0, Math.round(b.x * k));
  const sy = Math.max(0, Math.round(b.y * k));
  const sw = Math.min(cropState.natW - sx, Math.max(8, Math.round(b.w * k)));
  const sh = Math.min(cropState.natH - sy, Math.max(8, Math.round(b.h * k)));

  const cv = document.createElement('canvas');
  cv.width = sw;
  cv.height = sh;
  const ctx = cv.getContext('2d');
  ctx.drawImage(cropState.imgEl, sx, sy, sw, sh, 0, 0, sw, sh);

  const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.9));
  if (!blob) return toast('裁剪失败，换张图试试');

  const id = Store.newId();
  await Store.put('img', { id, blob, bytes: blob.size, at: Date.now() });
  imgUrls.set(id, URL.createObjectURL(blob));
  imgBytes += blob.size;

  const arr = cropState.who === 'draft' ? ui.draftShots : ui.reviewShots;
  arr[cropState.index] = id;
  const sel = cropState.who === 'draft' ? '#fShots' : '#rShots';
  closeCropper();
  renderShots(sel, arr, cropState.who);
  toast('已裁剪，记得点保存');
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function showFatal(msg) {
  const el = $('#fatal');
  if (!el) return;
  el.hidden = false;
  el.textContent = msg;
}

/* ==========================================================
   交易表单
   ========================================================== */
function openTradeForm(trade) {
  ui.editingId = trade ? trade.id : null;
  ui.side = trade ? trade.side : 'buy';

  $('#tradeTitle').textContent = trade ? '编辑这笔' : '记一笔';
  $$('#sideSeg button').forEach(b => b.classList.toggle('on', b.dataset.side === ui.side));
  $('#pnlField').hidden = ui.side !== 'sell';

  $('#fName').value = trade ? trade.name : '';
  $('#fCode').value = trade ? (trade.code || '') : '';
  $('#fDate').value = trade ? trade.date : TODAY_KEY;
  $('#fPrice').value = trade ? trade.price : '';
  $('#fQty').value = trade ? trade.qty : '';
  $('#fFee').value = trade ? trade.fee : '';
  $('#fPnl').value = trade && trade.pnl != null ? trade.pnl : '';
  $('#fNote').value = trade ? trade.note : '';
  $('#fPnlHint').textContent = '';

  const reasons = trade ? (trade.reasons || []) : [];
  const mood = trade ? trade.mood : '';
  $$('[data-multi="reason"] .chip').forEach(c => c.classList.toggle('on', reasons.includes(c.dataset.val)));
  $$('[data-single="mood"] .chip').forEach(c => c.classList.toggle('on', c.dataset.val === mood));

  ui.draftShots = trade ? (trade.shots || []).slice() : [];
  renderShots('#fShots', ui.draftShots, 'draft');
  updatePnlHint();
  openSheet('trade');
}

function updatePnlHint() {
  const hint = $('#fPnlHint');
  if (ui.side !== 'sell') {
    hint.textContent = '';
    return;
  }
  const code = $('#fCode').value.trim();
  const name = $('#fName').value.trim();
  const price = parseFloat($('#fPrice').value);
  const qty = parseInt($('#fQty').value, 10);
  const pos = computePositions(trades.filter(t => t.id !== ui.editingId))
    .find(p => (code && p.code === code) || (!code && p.name === name));
  if (pos && price > 0 && qty > 0) {
    const feeRaw = parseFloat($('#fFee').value);
    const fee = Number.isFinite(feeRaw) ? feeRaw : price * qty * 0.00025;
    const est = (price - pos.cost) * qty - fee;
    hint.textContent = `按成本 ${fn(pos.cost)} 估算：${fsign(est)}`;
    if (!$('#fPnl').value) $('#fPnl').value = est.toFixed(2);
  } else {
    hint.textContent = '没有对应买入记录，直接填金额';
  }
}

async function saveTrade() {
  const name = $('#fName').value.trim();
  const code = $('#fCode').value.trim();
  const price = parseFloat($('#fPrice').value);
  const qty = parseInt($('#fQty').value, 10);
  if (!name) return toast('股票名称填一下');
  if (!(price > 0)) return toast('成交价要大于 0');
  if (!(qty > 0)) return toast('数量要大于 0');

  const feeRaw = parseFloat($('#fFee').value);
  const fee = Number.isFinite(feeRaw) ? feeRaw : +(price * qty * 0.00025).toFixed(2);
  const pnlRaw = parseFloat($('#fPnl').value);
  const reasons = $$('[data-multi="reason"] .chip.on').map(c => c.dataset.val);
  const moodEl = $('[data-single="mood"] .chip.on');
  const mood = moodEl ? moodEl.dataset.val : '';

  const date = $('#fDate').value || TODAY_KEY;
  const time = date === TODAY_KEY ? `${pad(now.getHours())}:${pad(now.getMinutes())}` : '12:00';

  const data = {
    name, code, side: ui.side, price, qty, fee, date, time,
    pnl: ui.side === 'sell' && Number.isFinite(pnlRaw) ? pnlRaw : null,
    note: $('#fNote').value.trim(),
    reasons, mood,
    shots: ui.draftShots.slice()
  };

  if (ui.editingId) {
    const t = trades.find(x => x.id === ui.editingId);
    if (t) Object.assign(t, data);
    toast('已保存修改');
  } else {
    trades.unshift({ id: 'n' + Date.now(), ...data });
    toast(`已记录：${sideFull(ui.side)} ${name}`);
  }

  closeSheet();
  renderAll();
  scheduleSave();
  gcImages();
}

/* ==========================================================
   每日心得
   ========================================================== */
function paintStars() {
  $$('#stars button').forEach(b => b.classList.toggle('on', Number(b.dataset.star) <= ui.star));
}

function renderChecks(key) {
  const rv = reviews[key] || {};
  const list = trades.filter(t => t.date === key);
  $('#revTrades').innerHTML = list.length
    ? list.map(t => `
        <label class="ck">
          <input type="checkbox" data-ck="${t.id}" ${(rv.checks || []).includes(t.id) ? 'checked' : ''}>
          <span class="ck-name">${sideFull(t.side)} ${esc(t.name)} ${fn(t.price)} × ${t.qty}</span>
          <span class="num ${t.pnl != null ? cls(t.pnl) : ''}">${t.pnl != null ? fsign(t.pnl) : ''}</span>
        </label>`).join('')
    : '<p class="empty">这天没有交易记录</p>';
}

function openNoteFor(key) {
  ui.noteDate = key;
  const d = parseKey(key);
  const rv = reviews[key] || {};

  $('#revDate').textContent = `${d.getMonth() + 1}月${d.getDate()}日 心得`;
  ui.star = rv.star || 4;
  paintStars();
  $('#rPlan').value = rv.plan || '';
  $('#rText').value = rv.text || '';
  ui.reviewShots = (rv.shots || []).slice();
  renderShots('#rShots', ui.reviewShots, 'review');
  renderChecks(key);
  openSheet('note');
}

function saveNote() {
  const key = ui.noteDate;
  const rv = reviews[key] || {};
  rv.star = ui.star;
  rv.plan = $('#rPlan').value.trim();
  rv.text = $('#rText').value.trim();
  rv.checks = $$('#revTrades input[type="checkbox"]:checked').map(c => c.dataset.ck);
  rv.shots = ui.reviewShots.slice();
  reviews[key] = rv;

  closeSheet();
  renderAll();
  scheduleSave();
  gcImages();
  const d = parseKey(key);
  toast(`${d.getMonth() + 1}月${d.getDate()}日 已保存`);
}

/* ==========================================================
   交易详情
   ========================================================== */
function openDetail(id) {
  const t = trades.find(x => x.id === id);
  if (!t) return;
  ui.editingId = t.id;
  const rows = [
    ['方向', sideFull(t.side)],
    ['时间', `${t.date} ${t.time}`],
    ['成交价', fn(t.price)],
    ['数量', `${t.qty} 股`],
    ['成交金额', fn(t.price * t.qty)],
    ['手续费', fn(t.fee)],
    ['本次盈亏', t.pnl == null ? '—' : fsign(t.pnl)],
    ['理由', (t.reasons || []).length ? t.reasons.join('、') : '—'],
    ['心态', t.mood || '—']
  ];
  const shots = t.shots || [];
  $('#detailBody').innerHTML = `
    ${shots.length ? `<div class="detail-shots">${shots.map(s => `<img src="${shotUrl(s)}" data-view alt="">`).join('')}</div>` : ''}
    <div class="rec-meta">
      <span class="badge ${t.side}">${sideText(t.side)}</span>
      <span class="rec-name" style="font-size:var(--fs-xl)">${esc(t.name)}</span>
      <span class="code">${esc(t.code || '')}</span>
      ${t.side === 'sell' ? `<span class="rec-pnl num ${cls(t.pnl)}">${t.pnl == null ? '—' : fsign(t.pnl)}</span>` : ''}
    </div>
    <div class="detail-note">${t.note ? esc(t.note) : '（这笔没写心得）'}</div>
    <div class="dl">${rows.map(([k, v]) => `<div class="dl-row"><span>${k}</span><b class="${k === '本次盈亏' ? cls(t.pnl) : ''}">${v}</b></div>`).join('')}</div>
    <button class="btn btn-ghost" data-stock="${esc(t.code || t.name)}">看这只票的全部记录</button>
    <button class="btn btn-ghost" data-del="${t.id}" style="color:var(--danger)">删除这笔记录</button>`;
  openSheet('detail');
}

function deleteTrade(id) {
  const t = trades.find(x => x.id === id);
  if (!t) return;
  if (!confirm(`删除「${t.name} ${fn(t.price)} × ${t.qty}」这笔记录？`)) return;
  trades = trades.filter(x => x.id !== id);
  closeSheet();
  renderAll();
  scheduleSave();
  gcImages();
  toast('已删除');
}

/* ==========================================================
   语录
   ========================================================== */
function pinQuoteBtn(on) {
  $('#qPin').classList.toggle('on', on);
  $('#qPin').setAttribute('aria-checked', String(on));
}

function openQuoteForm(r) {
  ui.editingQuote = r ? r.id : null;
  $('#quoteTitle').textContent = r ? '编辑语录' : '加一条语录';
  $('#qText').value = r ? r.text : '';
  $('#qSource').value = r ? (r.source || '') : '';
  const tags = r ? (r.tags || []) : [];
  $$('[data-multi="qtag"] .chip').forEach(c => c.classList.toggle('on', tags.includes(c.dataset.val)));
  pinQuoteBtn(!!(r && r.pinned));
  $('#delQuote').style.display = r ? '' : 'none';
  openSheet('quote');
}

function saveQuote() {
  const text = $('#qText').value.trim();
  if (!text) return toast('先把语录抄进去');
  const tags = $$('[data-multi="qtag"] .chip.on').map(c => c.dataset.val);
  const pinned = $('#qPin').classList.contains('on');
  const source = $('#qSource').value.trim();

  if (ui.editingQuote) {
    const r = quotes.find(x => x.id === ui.editingQuote);
    if (r) Object.assign(r, { text, source, tags, pinned });
    toast('已保存修改');
  } else {
    quotes.unshift({ id: 'q' + Date.now(), text, source, tags, pinned, date: TODAY_KEY });
    toast('语录已收录');
  }
  closeSheet();
  renderAll();
  scheduleSave();
}

function deleteQuote() {
  const i = quotes.findIndex(x => x.id === ui.editingQuote);
  if (i < 0) return;
  if (!confirm('删除这条语录？')) return;
  quotes.splice(i, 1);
  closeSheet();
  renderAll();
  scheduleSave();
  toast('已删除');
}

function togglePin(id) {
  const r = quotes.find(x => x.id === id);
  if (!r) return;
  r.pinned = !r.pinned;
  renderQuotes();
  renderHome();
  scheduleSave();
  toast(r.pinned ? '已置顶' : '已取消置顶');
}

/* ==========================================================
   备份：导出 / 导入 / 清空
   ========================================================== */
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function exportBackup() {
  const btn = $('#exportBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  toast('正在打包，图多的话要等一会儿…');
  try {
    const ids = new Set();
    trades.forEach(t => (t.shots || []).forEach(id => ids.add(id)));
    Object.keys(reviews).forEach(k => (reviews[k].shots || []).forEach(id => ids.add(id)));

    const files = [{
      name: 'data.json',
      data: new TextEncoder().encode(JSON.stringify(snapshot(), null, 1))
    }];

    let missing = 0;
    for (const id of ids) {
      const rec = await Store.get('img', id);
      if (!rec || !rec.blob) { missing++; continue; }
      const buf = new Uint8Array(await rec.blob.arrayBuffer());
      files.push({ name: `images/${id}.jpg`, data: buf });
    }

    const bytes = TinyZip.build(files);
    const blob = new Blob([bytes], { type: 'application/zip' });
    downloadBlob(blob, `交易手记-备份-${TODAY_KEY}.zip`);

    settings.lastExport = new Date().toISOString();
    await saveNow();
    renderMe();
    toast(`已导出 ${(blob.size / 1048576).toFixed(1)}MB${missing ? '，' + missing + ' 张图缺失' : ''}`);
  } catch (e) {
    toast('导出失败：' + (e.message || e));
  } finally {
    btn.disabled = false;
  }
}

async function importBackup(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const map = TinyZip.parse(bytes);
    const raw = map.get('data.json');
    if (!raw) throw new Error('备份文件里没有 data.json，可能不是本应用导出的');

    const data = JSON.parse(new TextDecoder().decode(raw));
    const tradeCount = Array.isArray(data.trades) ? data.trades.length : 0;
    const noteCount = data.reviews ? Object.keys(data.reviews).length : 0;
    if (!confirm(`导入后会用备份里的 ${tradeCount} 笔交易、${noteCount} 天心得覆盖当前全部数据，确定？`)) return;

    toast('正在导入…');
    await Store.clear('kv');
    await Store.clear('img');
    imgUrls.forEach(u => URL.revokeObjectURL(u));
    imgUrls.clear();
    imgBytes = 0;

    trades = Array.isArray(data.trades) ? data.trades : [];
    reviews = data.reviews && typeof data.reviews === 'object' ? data.reviews : {};
    quotes = Array.isArray(data.quotes) ? data.quotes : [];
    settings = Object.assign({ theme: 'dark', zoom: 1, updown: 'cn', lastExport: '' }, data.settings || {});

    const items = [];
    for (const [name, buf] of map.entries()) {
      if (!name.startsWith('images/') || !name.endsWith('.jpg')) continue;
      const id = name.slice(7, -4);
      const blob = new Blob([buf], { type: 'image/jpeg' });
      items.push({ id, blob, bytes: blob.size, at: Date.now() });
      imgUrls.set(id, URL.createObjectURL(blob));
      imgBytes += blob.size;
    }
    if (items.length) await Store.putMany('img', items);

    await saveNow();
    applySettings();
    renderAll();
    toast(`导入完成：${trades.length} 笔交易、${items.length} 张图`);
  } catch (e) {
    toast('导入失败：' + (e.message || e));
  }
}

async function clearAll() {
  if (!confirm('清空全部交易、心得、语录和截图？建议先导出备份，这个操作不可撤销。')) return;
  if (!confirm('最后确认一次：真的要清空吗？')) return;
  await Store.clear('kv');
  await Store.clear('img');
  imgUrls.forEach(u => URL.revokeObjectURL(u));
  imgUrls.clear();
  imgBytes = 0;
  trades = [];
  reviews = {};
  quotes = [];
  ui.draftShots = [];
  ui.reviewShots = [];
  await saveNow();
  renderAll();
  toast('已清空');
}

/* ==========================================================
   视图切换
   ========================================================== */
function switchView(name) {
  const target = document.getElementById('view-' + name);
  if (!target) return;
  $$('.view').forEach(v => v.classList.toggle('is-active', v === target));
  $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.go === name));
  const scroller = target.querySelector('.scroll');
  if (scroller) scroller.scrollTop = 0;
}

/* ==========================================================
   事件
   ========================================================== */
function bindEvents() {
  $$('[data-go]').forEach(b => b.addEventListener('click', () => switchView(b.dataset.go)));

  $$('[data-sheet]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.sheet === 'trade') openTradeForm(null);
    if (b.dataset.sheet === 'note') openNoteFor(TODAY_KEY);
    if (b.dataset.sheet === 'quote') openQuoteForm(null);
  }));

  $('#overlay').addEventListener('click', closeSheet);
  $$('[data-close]').forEach(b => b.addEventListener('click', closeSheet));
  $('#viewerClose').addEventListener('click', closeViewer);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    closeViewer();
    closeSheet();
    closeCropper();
  });

  /* ---- 大图缩放手势 ---- */
  const vStage = $('#viewerStage');
  const pts = new Map();
  let pinchStart = 0;
  let pinchBase = 1;
  let dragStart = null;
  let dragging = false;
  let suppressClick = false;
  let lastTap = 0;
  let lastTapPos = { x: 0, y: 0 };

  vStage.addEventListener('pointerdown', e => {
    vStage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const [a, b] = Array.from(pts.values());
      pinchStart = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      pinchBase = zoom.scale;
    }
    if (pts.size === 1) {
      dragStart = { x: e.clientX, y: e.clientY, tx: zoom.tx, ty: zoom.ty };
      dragging = false;
    }
  });

  vStage.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pts.size === 2) {
      const [a, b] = Array.from(pts.values());
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoom.scale = clamp(pinchBase * (d / pinchStart), 1, 6);
      clampPan();
      applyZoom();
      return;
    }

    if (pts.size === 1 && dragStart) {
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) dragging = true;
      if (dragging && zoom.scale > 1) {
        zoom.tx = dragStart.tx + dx;
        zoom.ty = dragStart.ty + dy;
        clampPan();
        applyZoom();
      }
    }
  });

  const endPointer = e => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinchStart = 0;
    if (pts.size === 1) {
      const p = Array.from(pts.values())[0];
      dragStart = { x: p.x, y: p.y, tx: zoom.tx, ty: zoom.ty };
      return;
    }
    if (pts.size > 0) return;

    const moved = dragging;
    dragStart = null;
    dragging = false;
    if (moved) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 60);
    }

    const t = Date.now();
    if (!moved && t - lastTap < 320 &&
        Math.abs(e.clientX - lastTapPos.x) < 36 && Math.abs(e.clientY - lastTapPos.y) < 36) {
      if (zoom.scale > 1.2) {
        resetZoom();
      } else {
        zoom.scale = 2.6;
        zoom.tx = 0;
        zoom.ty = 0;
        applyZoom();
      }
      lastTap = 0;
    } else {
      lastTap = t;
      lastTapPos = { x: e.clientX, y: e.clientY };
    }
  };

  vStage.addEventListener('pointerup', endPointer);
  vStage.addEventListener('pointercancel', endPointer);

  vStage.addEventListener('click', e => {
    if (suppressClick) return;
    if (e.target === vStage) closeViewer();
  });

  vStage.addEventListener('wheel', e => {
    e.preventDefault();
    zoom.scale = clamp(zoom.scale * (e.deltaY < 0 ? 1.12 : 0.9), 1, 6);
    if (zoom.scale === 1) { zoom.tx = 0; zoom.ty = 0; }
    clampPan();
    applyZoom();
  }, { passive: false });

  /* ---- 裁剪手势 ---- */
  const cStage = $('#cropStage');

  cStage.addEventListener('pointerdown', e => {
    if (!cropState.open) return;
    const r = cStage.getBoundingClientRect();
    const x = clamp(e.clientX - r.left, 0, cropState.dispW);
    const y = clamp(e.clientY - r.top, 0, cropState.dispH);
    const b = cropState.box;
    const inside = x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
    cStage.setPointerCapture(e.pointerId);
    if (inside) {
      cropState.drag = { mode: 'move', sx: x, sy: y, ox: b.x, oy: b.y };
    } else {
      cropState.drag = { mode: 'new', sx: x, sy: y };
      cropState.box = { x, y, w: 0, h: 0 };
      paintCropBox();
    }
  });

  cStage.addEventListener('pointermove', e => {
    const d = cropState.drag;
    if (!d) return;
    const r = cStage.getBoundingClientRect();
    const x = clamp(e.clientX - r.left, 0, cropState.dispW);
    const y = clamp(e.clientY - r.top, 0, cropState.dispH);
    if (d.mode === 'move') {
      const w = cropState.box.w;
      const h = cropState.box.h;
      cropState.box = {
        x: clamp(d.ox + (x - d.sx), 0, Math.max(0, cropState.dispW - w)),
        y: clamp(d.oy + (y - d.sy), 0, Math.max(0, cropState.dispH - h)),
        w, h
      };
    } else {
      cropState.box = {
        x: Math.min(d.sx, x),
        y: Math.min(d.sy, y),
        w: Math.abs(x - d.sx),
        h: Math.abs(y - d.sy)
      };
    }
    paintCropBox();
  });

  const endCropDrag = () => {
    if (!cropState.drag) return;
    cropState.drag = null;
    const b = cropState.box;
    if (b.w < 30 || b.h < 30) {
      cropState.box = { x: 0, y: 0, w: cropState.dispW, h: cropState.dispH };
      paintCropBox();
    }
  };

  cStage.addEventListener('pointerup', endCropDrag);
  cStage.addEventListener('pointercancel', endCropDrag);
  $('#cropCancel').addEventListener('click', closeCropper);
  $('#cropDone').addEventListener('click', applyCrop);

  // 买 / 卖
  $$('#sideSeg button').forEach(b => b.addEventListener('click', () => {
    ui.side = b.dataset.side;
    $$('#sideSeg button').forEach(x => x.classList.toggle('on', x === b));
    $('#pnlField').hidden = ui.side !== 'sell';
    updatePnlHint();
  }));

  ['#fCode', '#fName', '#fPrice', '#fQty', '#fFee'].forEach(sel => {
    $(sel).addEventListener('input', updatePnlHint);
  });

  // 标签
  document.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const box = chip.parentElement;
    if (box.dataset.multi) {
      chip.classList.toggle('on');
    } else if (box.dataset.single) {
      $$('.chip', box).forEach(c => c.classList.toggle('on', c === chip && !c.classList.contains('on')));
    }
  });

  // 星级
  $$('#stars button').forEach(b => b.addEventListener('click', () => {
    ui.star = Number(b.dataset.star);
    paintStars();
  }));

  // 截图：添加
  document.addEventListener('click', e => {
    const add = e.target.closest('[data-add]');
    if (!add) return;
    (add.dataset.add === 'draft' ? $('#fShotInput') : $('#rShotInput')).click();
  });

  async function handleFiles(files, who) {
    if (!files || !files.length) return;
    const arr = [];
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      toast('正在处理图片…');
      try {
        arr.push(await addImage(f));
      } catch (err) {
        toast('有一张图处理失败：' + (err.message || err));
      }
    }
    if (!arr.length) return;
    if (who === 'draft') {
      ui.draftShots.push(...arr);
      renderShots('#fShots', ui.draftShots, 'draft');
    } else {
      ui.reviewShots.push(...arr);
      renderShots('#rShots', ui.reviewShots, 'review');
    }
    toast(`已加 ${arr.length} 张图`);
  }

  $('#fShotInput').addEventListener('change', async e => {
    await handleFiles(e.target.files, 'draft');
    e.target.value = '';
  });
  $('#rShotInput').addEventListener('change', async e => {
    await handleFiles(e.target.files, 'review');
    e.target.value = '';
  });

  // 截图：裁剪
  document.addEventListener('click', e => {
    const c = e.target.closest('[data-crop]');
    if (!c) return;
    openCropper(Number(c.dataset.crop), c.dataset.who);
  });

  // 截图：删除
  document.addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (!rm) return;
    const i = Number(rm.dataset.rm);
    if (rm.dataset.who === 'draft') {
      ui.draftShots.splice(i, 1);
      renderShots('#fShots', ui.draftShots, 'draft');
    } else {
      ui.reviewShots.splice(i, 1);
      renderShots('#rShots', ui.reviewShots, 'review');
    }
  });

  // 保存
  $('#saveTrade').addEventListener('click', saveTrade);
  $('#saveNote').addEventListener('click', saveNote);
  $('#saveQuote').addEventListener('click', saveQuote);
  $('#delQuote').addEventListener('click', deleteQuote);
  $('#qPin').addEventListener('click', () => pinQuoteBtn(!$('#qPin').classList.contains('on')));

  $('#editTrade').addEventListener('click', () => {
    const t = trades.find(x => x.id === ui.editingId);
    closeSheet();
    if (t) setTimeout(() => openTradeForm(t), 220);
  });

  // 心得 / 语录
  $$('#noteSeg button').forEach(b => b.addEventListener('click', () => setNoteTab(b.dataset.ntab)));
  $('#homeQuoteAll').addEventListener('click', () => {
    switchView('notes');
    setNoteTab('quotes');
  });

  // 列表 / 日历 / 图片 / 删除 / 提示
  document.addEventListener('click', e => {
    const img = e.target.closest('img[data-view]');
    if (img) { openViewer(img.src); return; }

    const sk = e.target.closest('[data-stock]');
    if (sk) {
      const key = sk.dataset.stock;
      if (ui.sheet) { closeSheet(); setTimeout(() => openStock(key), 220); }
      else openStock(key);
      return;
    }

    const pin = e.target.closest('[data-pin]');
    if (pin) { togglePin(pin.dataset.pin); return; }

    const quote = e.target.closest('[data-quote]');
    if (quote) {
      const r = quotes.find(x => x.id === quote.dataset.quote);
      if (r) openQuoteForm(r);
      return;
    }

    const qtag = e.target.closest('[data-qtag]');
    if (qtag) { ui.qtag = qtag.dataset.qtag; renderQuotes(); return; }

    const ti = e.target.closest('[data-trade]');
    if (ti) { openDetail(ti.dataset.trade); return; }

    const del = e.target.closest('[data-del]');
    if (del) { deleteTrade(del.dataset.del); return; }

    const note = e.target.closest('[data-note]');
    if (note) { openNoteFor(note.dataset.note); return; }

    const day = e.target.closest('[data-day]');
    if (day) { openNoteFor(day.dataset.day); return; }
  });

  // 流水 / 持仓 / 个股
  $$('#tradeSeg button').forEach(b => b.addEventListener('click', () => {
    ui.sub = b.dataset.sub;
    $$('#tradeSeg button').forEach(x => x.classList.toggle('on', x === b));
    $('#flowPane').hidden = ui.sub !== 'flow';
    $('#posPane').hidden = ui.sub !== 'pos';
    $('#stockPane').hidden = ui.sub !== 'stock';
  }));

  // 日历翻月
  $('#calPrev').addEventListener('click', () => {
    ui.calMonth = new Date(ui.calMonth.getFullYear(), ui.calMonth.getMonth() - 1, 1);
    renderCalendar();
  });
  $('#calNext').addEventListener('click', () => {
    ui.calMonth = new Date(ui.calMonth.getFullYear(), ui.calMonth.getMonth() + 1, 1);
    renderCalendar();
  });

  // 搜索
  $('#searchInput').addEventListener('input', e => {
    ui.query = e.target.value;
    renderNoteList();
    renderQuotes();
  });

  // 设置
  $('#swTheme').addEventListener('click', () => {
    settings.theme = settings.theme === 'light' ? 'dark' : 'light';
    applySettings();
    scheduleSave();
  });

  $('#swUpdown').addEventListener('click', () => {
    settings.updown = settings.updown === 'intl' ? 'cn' : 'intl';
    applySettings();
    renderAll();
    scheduleSave();
  });

  $('#fsRange').addEventListener('input', e => {
    const zi = Number(e.target.value);
    settings.zoom = [0.94, 1, 1.1][zi];
    applySettings();
    scheduleSave();
  });

  // 备份
  $('#exportBtn').addEventListener('click', exportBackup);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) await importBackup(f);
  });
  $('#clearBtn').addEventListener('click', clearAll);
  $('#aboutBtn').addEventListener('click', () => {
    toast('交易手记 v1.0 · 纯本地 · 数据不上传');
  });

  // 离开页面时尽量落盘
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });
  window.addEventListener('pagehide', () => { saveNow(); });
}

/* ==========================================================
   Service Worker
   ========================================================== */
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch(() => { /* 离线能力不可用不影响使用 */ });
}

/* ==========================================================
   启动
   ========================================================== */
async function boot() {
  bindEvents();
  applySettings();

  try {
    await Store.open();
    await loadAll();
    renderAll();
    applySettings();
  } catch (e) {
    showFatal('本地存储打不开：' + (e.message || e) + '（无痕模式 / 隐私模式可能禁用 IndexedDB）');
    renderAll();
  }

  registerSW();
}

window.addEventListener('error', e => {
  if (e && e.message) showFatal('出错了：' + e.message + '（数据仍在本地，刷新试试）');
});
window.addEventListener('unhandledrejection', e => {
  const r = e && e.reason;
  showFatal('操作失败：' + (r && r.message ? r.message : r));
});

document.addEventListener('DOMContentLoaded', boot);
