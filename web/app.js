/* 纯原生 JS，无构建、无框架。数据来自同目录 data.json（由 scripts/build.mjs 生成） */
const $ = (s) => document.querySelector(s);
const state = { cat: 'all', q: '', book: '', sort: 'rank', showAll: false, data: null };

/* 出现「书名直达」搜索条的分类 */
const BOOK_CATS = new Set(['novel', 'freebook', 'shuyuan']);

const STATUS = {
  live: ['可用', 'b-live'],
  limited: ['受限', 'b-limited'],
  unreachable: ['不可达', 'b-unreach'],
  pending: ['待观察', 'b-pending'],
  dead: ['已失效', 'b-dead'],
};

init();

async function init() {
  applyTheme(localStorage.getItem('theme') || 'auto');
  const url = new URL(location.href);
  state.cat = url.searchParams.get('cat') || 'all';
  state.q = url.searchParams.get('q') || '';
  state.book = url.searchParams.get('book') || '';
  state.showAll = url.searchParams.get('all') === '1';
  $('#q').value = state.q;
  $('#book').value = state.book;
  $('#showAll').checked = state.showAll;

  bindUi();
  try {
    state.data = await fetch('./data.json', { cache: 'no-cache' }).then((r) => r.json());
  } catch {
    $('#grid').innerHTML = '<p class="empty">数据加载失败：请确认 data.json 已生成（npm run build）</p>';
    return;
  }
  renderAll();
}

function bindUi() {
  let t;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.q = e.target.value.trim(); renderAll(); syncUrl(); }, 160);
  });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; renderList(); });
  $('#showAll').addEventListener('change', (e) => { state.showAll = e.target.checked; renderAll(); syncUrl(); });
  $('#theme').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const cur = localStorage.getItem('theme') || 'auto';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    localStorage.setItem('theme', next);
    applyTheme(next);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); }
    if (e.key === 'Escape' && document.activeElement === $('#q')) { $('#q').value = ''; state.q = ''; renderAll(); }
  });

  // 书名直达：输入即渲染各站搜索链接，回车打开第一个
  let bt;
  $('#book').addEventListener('input', (e) => {
    clearTimeout(bt);
    bt = setTimeout(() => { state.book = e.target.value.trim(); renderBookHits(); syncUrl(); }, 160);
  });
  $('#book').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = $('#bookhits a');
    if (first) window.open(first.href, '_blank', 'noopener');
  });
}

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
}

function syncUrl() {
  const u = new URL(location.href);
  state.cat === 'all' ? u.searchParams.delete('cat') : u.searchParams.set('cat', state.cat);
  state.q ? u.searchParams.set('q', state.q) : u.searchParams.delete('q');
  state.book ? u.searchParams.set('book', state.book) : u.searchParams.delete('book');
  state.showAll ? u.searchParams.set('all', '1') : u.searchParams.delete('all');
  history.replaceState(null, '', u);
}

function renderAll() {
  renderStats();
  renderTabs();
  renderBookBar();
  renderList();
}

/* 「书名直达」只在书相关分类下出现；不在这些分类时隐藏，避免干扰影视用户 */
function renderBookBar() {
  const on = BOOK_CATS.has(state.cat) || state.book;
  $('#bookbar').hidden = !on;
  if (on) renderBookHits();
}

function renderBookHits() {
  const box = $('#bookhits');
  const book = state.book;
  if (!book) {
    box.innerHTML = '<span class="bookhint">输入书名后，下面会出现各站的搜索直达链接，点一下就能看到有没有这本书。</span>';
    return;
  }
  const q = encodeURIComponent(book);
  const sites = state.data.items
    .filter((i) => i.searchUrl && i.visible && i.status !== 'dead')
    .sort((a, b) => b.rating - a.rating);
  const links = sites.map(
    (i) => `<a class="bookhit" href="${esc(i.searchUrl.replace('{q}', q))}" target="_blank" rel="noopener noreferrer nofollow">
      <b>${esc(i.name)}</b><span>${esc(i.host)}</span></a>`,
  );
  box.innerHTML = links.length
    ? links.join('')
    : '<span class="bookhint">当前分类没有支持关键词直达的站点，切到「小说资源」或「免费正版」再试。</span>';
}

function renderStats() {
  const s = state.data.stats;
  const html = [
    ['收录站点', s.total],
    ['实时可用', s.live],
    ['受限/需梯子', s.limited],
    ['待观察', s.pending],
    ['平均响应', s.avgMs ? s.avgMs + 'ms' : '—'],
  ].map(([k, v]) => `<div class="stat"><b>${v}</b>${k}</div>`).join('');
  $('#stats').innerHTML = html;
  const d = new Date(state.data.updatedAt || state.data.generatedAt);
  $('#upd').textContent = `数据更新 ${fmtDate(d)}`;
  $('#gen').textContent = `生成于 ${fmtDate(new Date(state.data.generatedAt))}`;
}

function renderTabs() {
  const cats = state.data.categories;
  const items = [
    `<button class="tab ${state.cat === 'all' ? 'on' : ''}" data-cat="all">全部<span class="n">${state.data.stats.total}</span></button>`,
    ...cats.map(
      (c) =>
        `<button class="tab ${state.cat === c.id ? 'on' : ''}" data-cat="${c.id}">${c.icon} ${c.name}<span class="n">${c.count}</span></button>`,
    ),
  ];
  $('#tabs').innerHTML = items.join('');
  $('#tabs').querySelectorAll('.tab').forEach((b) =>
    b.addEventListener('click', () => {
      state.cat = b.dataset.cat;
      renderAll();
      syncUrl();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }),
  );
}
function renderList() {
  const list = filterItems();
  $('#count').textContent = `${list.length} 个结果`;
  $('#empty').hidden = list.length > 0;
  $('#grid').innerHTML = list.map(card).join('');
}

function filterItems() {
  const qs = state.q.toLowerCase().split(/\s+/).filter(Boolean);
  let list = state.data.items.filter((i) => {
    if (!state.showAll && !i.visible) return false;
    if (state.cat !== 'all' && i.category !== state.cat) return false;
    if (qs.length && !qs.every((w) => i.search.includes(w))) return false;
    return true;
  });
  const deadLast = (i) => (i.status === 'dead' ? 1 : 0);
  if (state.sort === 'rank') list.sort((a, b) => deadLast(a) - deadLast(b) || b.rating - a.rating || a.name.localeCompare(b.name, 'zh'));
  else if (state.sort === 'speed') list.sort((a, b) => (a.ms ?? 9e9) - (b.ms ?? 9e9));
  else list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return list;
}

function card(i) {
  const [txt, cls] = STATUS[i.status] || ['未知', 'b-pending'];
  const stars = '★'.repeat(Math.round(i.rating)) + '☆'.repeat(5 - Math.round(i.rating));
  const ms = i.ms ? (i.ms < 1000 ? i.ms + 'ms' : (i.ms / 1000).toFixed(1) + 's') : '—';
  const mirrors = (i.mirrors || [])
    .filter((m) => /^https?:\/\//.test(m))
    .map((m) => `<a href="${esc(m)}" target="_blank" rel="noopener noreferrer nofollow">备用</a>`)
    .join('');
  return `<article class="card">
    <div class="card-top">
      <img class="favicon" loading="lazy" referrerpolicy="no-referrer"
           src="https://icons.duckduckgo.com/ip3/${esc(i.host)}.ico" alt=""
           onerror="this.style.visibility='hidden'">
      <h3><a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(i.name)}</a></h3>
    </div>
    <div class="host">${esc(i.host)}</div>
    <p class="desc">${esc(i.desc || '')}</p>
    <div class="tags">${(i.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    ${mirrors ? `<div class="mirrors">${mirrors}</div>` : ''}
    <div class="meta">
      <span class="badge ${cls}">${txt}</span>
      <span class="stars" title="推荐指数 ${i.rating}/5">${stars}</span>
      <span class="spd" title="最近一次响应">${ms}</span>
      ${i.uptime != null ? `<span title="近 30 次检测可用率">${i.uptime}%</span>` : ''}
    </div>
  </article>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
