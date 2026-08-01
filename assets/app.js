/* Ted 工作台 — 靜態前端，資料在私有 repo 的 todos.json
   設計原則：所有寫入都先抓最新版、重播本地操作、再寫回（手機跟 Mac 同時改也不會互相蓋掉）。
   同步狀態一律顯示出來，失敗絕不靜默。 */

const CFG = {
  owner: 'tientien830205-tech',
  repo: 'dashboard-data',
  path: 'todos.json',
  branch: 'main',
  widgetDir: 'widgets',
};

const API = `https://api.github.com/repos/${CFG.owner}/${CFG.repo}/contents`;
const LS_TOKEN = 'ted-dash-token';
const LS_OPEN = 'ted-dash-open';
// ?local=1 ＝ 開發預覽模式：直接讀隔壁 dashboard-data 資料夾，不需授權碼，唯讀不寫回
const LOCAL = new URLSearchParams(location.search).has('local');

const state = {
  token: localStorage.getItem(LS_TOKEN) || '',
  doc: null,
  sha: null,
  ops: [],
  saving: false,
  timer: null,
  filter: new URLSearchParams(location.search).get('f') || 'focus',
  open: new Set(JSON.parse(localStorage.getItem(LS_OPEN) || '[]')),
  widgets: {},
  gatesExpanded: false,
  quickExpanded: false,
};

/* ---------- 主題（自動／淺／深） ---------- */
const LS_THEME = 'ted-dash-theme';
const GATES_FOLD = 4;   // 聚焦模式先只顯示這幾個截止日，其餘收起來
const QUICK_FOLD = 6;   // 同理，快清清單先露出最省時的幾件

function applyTheme() {
  // ?theme=light|dark 可暫時覆蓋（截圖驗版面用）
  const pref = new URLSearchParams(location.search).get('theme') || localStorage.getItem(LS_THEME) || 'auto';
  const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = dark ? '#151c2b' : '#eef2f8';
  const seg = document.getElementById('theme-seg');
  if (seg) [...seg.children].forEach(b => b.classList.toggle('is-active', b.dataset.theme === pref));
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if ((localStorage.getItem(LS_THEME) || 'auto') === 'auto') applyTheme();
});

/* ---------- utils ---------- */
const $ = (s, r = document) => r.querySelector(s);
const el = (t, c, txt) => { const n = document.createElement(t); if (c) n.className = c; if (txt != null) n.textContent = txt; return n; };
const esc = s => String(s ?? '');

function b64dec(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
function b64enc(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(y, m - 1, d) - t) / 86400000);
}
function dayLabel(n) {
  if (n === null) return '';
  if (n < 0) return `過期 ${-n} 天`;
  if (n === 0) return '就是今天';
  if (n === 1) return '明天';
  return `還有 ${n} 天`;
}
function uid(p) { return p + Math.random().toString(36).slice(2, 8); }

/* ---------- github ---------- */
async function gh(pathAndQuery, opts = {}) {
  const res = await fetch(`${API}/${pathAndQuery}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${state.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
  });
  if (res.status === 401) throw new Error('授權碼無效或已過期（401）');
  if (res.status === 403) throw new Error('授權碼權限不足，Contents 要設 Read and write（403）');
  if (res.status === 404) { const e = new Error('找不到檔案（404）'); e.notFound = true; throw e; }
  if (res.status === 409) throw new Error('版本衝突，請再按一次同步（409）');
  if (!res.ok) throw new Error(`GitHub 回 ${res.status}`);
  return res.json();
}

async function loadDoc() {
  if (LOCAL) {
    const r = await fetch(`../dashboard-data/${CFG.path}?t=${Date.now()}`);
    if (!r.ok) throw new Error(`本機讀取失敗 ${r.status}`);
    return { doc: await r.json(), sha: null };
  }
  const j = await gh(`${CFG.path}?ref=${CFG.branch}&t=${Date.now()}`);
  return { doc: JSON.parse(b64dec(j.content)), sha: j.sha };
}

async function putDoc(doc, sha) {
  const body = JSON.stringify({
    message: `工作台更新 ${new Date().toISOString()}`,
    content: b64enc(JSON.stringify(doc, null, 2) + '\n'),
    sha,
    branch: CFG.branch,
  });
  return gh(CFG.path, { method: 'PUT', body });
}

/* ---------- ops（每個操作都可重播到最新版本上） ---------- */
function findProject(doc, pid) { return (doc.projects || []).find(p => p.id === pid); }

function applyOp(doc, op) {
  const p = op.projectId ? findProject(doc, op.projectId) : null;
  switch (op.type) {
    case 'toggle': {
      const it = p && (p.items || []).find(i => i.id === op.itemId);
      if (it) {
        it.done = op.done;
        if (op.done) it.completedAt = todayISO();
        else delete it.completedAt;
      }
      break;
    }
    case 'addItem':
      if (p) (p.items = p.items || []).unshift({ ...op.item });
      break;
    case 'delItem':
      if (p) p.items = (p.items || []).filter(i => i.id !== op.itemId);
      break;
    case 'setDeadline':
      if (p) p.deadline = op.date || null;
      break;
    case 'addProject':
      (doc.projects = doc.projects || []).push({ ...op.project });
      break;
  }
}

function pushOp(op) {
  applyOp(state.doc, op);
  state.ops.push(op);
  render();
  setSync('busy');
  clearTimeout(state.timer);
  state.timer = setTimeout(flush, 900);
}

async function flush() {
  if (LOCAL) { setSync('err', '本機預覽・唯讀'); return; }
  if (!state.ops.length || state.saving) return;
  state.saving = true;
  setSync('busy');
  const batch = state.ops.slice();
  try {
    const { doc, sha } = await loadDoc();          // 先抓最新（手機/Mac 可能都改過）
    batch.forEach(op => applyOp(doc, op));          // 重播本地操作
    doc.updated = new Date().toISOString();
    doc.updatedBy = 'web';
    const res = await putDoc(doc, sha);
    state.ops.splice(0, batch.length);
    state.doc = doc;
    state.sha = res.content.sha;
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
    setSync(state.ops.length ? 'busy' : 'ok');
  } catch (e) {
    setSync('err', e.message);
  } finally {
    state.saving = false;
    if (state.ops.length) { clearTimeout(state.timer); state.timer = setTimeout(flush, 3000); }
  }
}

function setSync(kind, msg) {
  const n = $('#sync');
  if (!n) return;
  if (LOCAL && kind !== 'err') { n.className = 'sync sync-busy'; n.textContent = '本機預覽・唯讀'; return; }
  n.className = 'sync ' + (kind === 'ok' ? 'sync-ok' : kind === 'busy' ? 'sync-busy' : 'sync-err');
  n.textContent = kind === 'ok' ? '已同步' : kind === 'busy' ? '儲存中…' : (msg || '沒存到');
  n.title = kind === 'err' ? (msg || '') : '';
}

/* ---------- widgets ---------- */
async function loadWidgets() {
  for (const w of state.doc.widgets || []) {
    if (!w.source) continue;
    try {
      if (LOCAL) {
        const r = await fetch(`../dashboard-data/${w.source}?t=${Date.now()}`);
        if (!r.ok) throw new Error('404');
        state.widgets[w.id] = await r.json();
      } else {
        const j = await gh(`${w.source}?ref=${CFG.branch}&t=${Date.now()}`);
        state.widgets[w.id] = JSON.parse(b64dec(j.content));
      }
    } catch (e) {
      state.widgets[w.id] = null;   // 還沒接上，維持佔位卡
    }
  }
  renderWidgets();
}

/* ---------- render ---------- */
function itemTags(it) {
  const wrap = el('div', 'it-sub');
  if (it.owner === 'ted') wrap.append(el('span', 'tag tag-ted', '你'));
  if (it.owner === 'other') wrap.append(el('span', 'tag tag-min', '等別人'));
  if (it.owner === 'claude') wrap.append(el('span', 'tag tag-min', '我做'));
  if (it.minutes) wrap.append(el('span', 'tag tag-min', `${it.minutes} 分`));
  const f = it.flag;
  if (f) {
    const map = { decision: ['tag-decision', '要拍板'], urgent: ['tag-urgent', '急'], stale: ['tag-stale', '躺很久'], important: ['tag-important', '別漏'], quickwin: ['tag-quickwin', '順手清'] };
    if (map[f]) wrap.append(el('span', 'tag ' + map[f][0], map[f][1]));
  }
  return wrap.children.length ? wrap : null;
}

function buildPrompt(proj, it) {
  const track = (state.doc.tracks || []).find(t => t.id === proj.track);
  return `接續處理這個待辦事項：\n\n專案：${proj.name}${track ? `（${track.label}）` : ''}\n事項：${it.text}${it.note ? `\n備註：${it.note}` : ''}\n\n（來源：工作台 project=${proj.id} item=${it.id}）\n\n做完之後：口頭跟我說「這件事完成了」，並直接幫我更新 dashboard-data/todos.json（該項目 done 設 true）、commit push，不用再另外跟我確認。`;
}

async function copyPrompt(proj, it, btn) {
  const text = buildPrompt(proj, it);
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    prompt('複製失敗，手動複製這段貼給我：', text);
    return;
  }
  const orig = btn.textContent;
  btn.textContent = '已複製 ✓';
  btn.disabled = true;
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
}

async function copyGatePrompt(g, btn) {
  const text = `接續處理這個截止日相關的工作：\n\n事項：${g.label}\n日期：${g.date}${g.note ? `\n備註：${g.note}` : ''}\n\n（來源：工作台截止日 id=${g.id}）\n\n做完之後：口頭跟我說「這件事完成了」，如果這個截止日已經沒用了（事情做完或過期），也直接幫我把它從 dashboard-data/todos.json 的 gates 裡刪掉、commit push，不用再另外跟我確認。`;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    prompt('複製失敗，手動複製這段貼給我：', text);
    return;
  }
  const orig = btn.textContent;
  btn.textContent = '已複製 ✓';
  btn.disabled = true;
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
}

function itemRow(proj, it, showWhere) {
  const row = el('div', 'item' + (it.done ? ' is-done' : ''));
  const cb = el('button', 'cb', '✓');
  cb.setAttribute('aria-label', it.done ? '取消完成' : '標記完成');
  cb.onclick = () => pushOp({ type: 'toggle', projectId: proj.id, itemId: it.id, done: !it.done });
  const main = el('div', 'it-main');
  if (showWhere) main.append(el('div', 'it-where', proj.name));
  main.append(el('div', 'it-text', it.text));
  const tags = itemTags(it);
  if (tags) main.append(tags);
  if (it.note) main.append(el('div', 'it-note', it.note));
  row.append(cb, main);
  if (!it.done) {
    const copy = el('button', 'it-copy', '📋');
    copy.title = '複製成給 Claude 的 prompt';
    copy.onclick = () => copyPrompt(proj, it, copy);
    row.append(copy);
  }
  const del = el('button', 'it-del', '×');
  del.title = '刪除';
  del.onclick = () => { if (confirm(`刪掉「${it.text.slice(0, 30)}…」？`)) pushOp({ type: 'delItem', projectId: proj.id, itemId: it.id }); };
  row.append(del);
  return row;
}

function renderToday() {
  const sec = $('#sec-today');
  sec.innerHTML = '';
  if (state.filter !== 'focus') return;
  // 最近的截止日 1 件＋最快清掉的 2 件，全部從既有資料算出來，不用手動維護
  const gate = (state.doc.gates || [])
    .filter(g => { const n = daysUntil(g.date); return n !== null && n >= -14; })
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))[0] || null;
  const quick = [];
  (state.doc.projects || []).forEach(p => (p.items || []).forEach(it => {
    if (!it.done && it.owner === 'ted' && it.minutes != null && it.minutes <= 30) quick.push([p, it]);
  }));
  quick.sort((a, b) => (a[1].minutes || 999) - (b[1].minutes || 999));
  const picks = quick.slice(0, gate ? 2 : 3);
  const count = (gate ? 1 : 0) + picks.length;
  if (!count) return;
  const head = el('div', 'sec-head');
  head.append(el('h2', null, `🎯 今天就這 ${count} 件`));
  sec.append(head);
  const box = el('div', 'today-card');
  if (gate) {
    const n = daysUntil(gate.date);
    const r = el('div', 'today-gate' + (n < 0 ? ' is-past' : ''));
    const b = el('div', 'it-main');
    b.append(el('div', 'it-text', gate.label));
    b.append(el('div', 'today-meta', `🔴 ${dayLabel(n)}・${gate.date}${gate.note ? `・${gate.note}` : ''}`));
    r.append(b);
    const copy = el('button', 'it-copy', '📋');
    copy.title = '複製成給 Claude 的 prompt';
    copy.onclick = () => copyGatePrompt(gate, copy);
    r.append(copy);
    box.append(r);
  }
  picks.forEach(([p, it]) => box.append(itemRow(p, it, true)));
  sec.append(box);
}

function renderGates() {
  const sec = $('#sec-gates');
  sec.innerHTML = '';
  if (['quick', 'mine', 'history'].includes(state.filter)) return;
  const all = (state.doc.gates || []).slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  // 聚焦只看 4 個月內的（更遠的在「全部」才出現，不然每天都被 2028 的事洗版）
  const list = state.filter === 'focus'
    ? all.filter(g => { const n = daysUntil(g.date); return n >= -14 && n <= 130; })
    : state.filter === 'all' ? all : all.filter(g => daysUntil(g.date) >= -14);
  if (!list.length) return;
  const head = el('div', 'sec-head');
  head.append(el('h2', null, '🔴 截止日'), el('span', 'count', `${list.length} 個`));
  sec.append(head);
  // 手機上一次列十張卡要滑很久，聚焦模式先摺起來
  const foldable = state.filter === 'focus' && list.length > GATES_FOLD;
  const shown = foldable && !state.gatesExpanded ? list.slice(0, GATES_FOLD) : list;
  const box = el('div', 'gates');
  shown.forEach(g => {
    const n = daysUntil(g.date);
    const r = el('div', `gate-row sev-${g.severity || 'info'}${n < 0 ? ' is-past' : ''}`);
    const d = el('div', 'gate-d');
    d.append(el('b', null, n < 0 ? '過期' : String(n)), el('span', null, n < 0 ? `${-n} 天` : '天'));
    const body = el('div', 'gate-body');
    body.append(el('div', 'lb', g.label));
    body.append(el('div', 'nt', g.note ? `${g.date}・${g.note}` : g.date));
    r.append(d, body);
    const copy = el('button', 'gate-copy', '📋');
    copy.title = '複製成給 Claude 的 prompt';
    copy.onclick = () => copyGatePrompt(g, copy);
    r.append(copy);
    box.append(r);
  });
  sec.append(box);
  if (foldable) {
    const more = el('button', 'more', state.gatesExpanded
      ? '收起 ▴'
      : `還有 ${list.length - GATES_FOLD} 個截止日 ▾`);
    more.onclick = () => { state.gatesExpanded = !state.gatesExpanded; renderGates(); };
    sec.append(more);
  }
}

function renderQuick() {
  const sec = $('#sec-quick');
  sec.innerHTML = '';
  if (!['focus', 'quick', 'mine'].includes(state.filter)) return;
  const mine = state.filter === 'mine';
  // 照專案分組（組內快的在前），最快能清掉的專案排最上面
  const groups = [];
  (state.doc.projects || []).forEach(p => {
    const its = (p.items || []).filter(it =>
      !it.done && it.owner === 'ted' && (mine || (it.minutes != null && it.minutes <= 30)));
    if (!its.length) return;
    its.sort((a, b) => (a.minutes || 999) - (b.minutes || 999));
    groups.push([p, its]);
  });
  groups.sort((a, b) => (a[1][0].minutes || 999) - (b[1][0].minutes || 999));
  const total = groups.reduce((n, [, its]) => n + its.length, 0);
  const head = el('div', 'sec-head');
  head.append(el('h2', null, mine ? '🧍 卡在你身上' : '⚡ 30 分鐘內清得掉'), el('span', 'count', `${total} 件`));
  sec.append(head);
  if (!mine) sec.append(el('p', 'sec-note', '都是別人在等你、或你一按就完成的事。'));
  if (!total) { sec.append(el('div', 'empty', '清光了。')); return; }
  // 聚焦模式只露出最快能清掉的幾件，其餘收起來（不然專案卡被推到很下面）
  const foldable = state.filter === 'focus' && total > QUICK_FOLD;
  let budget = foldable && !state.quickExpanded ? QUICK_FOLD : Infinity;
  const box = el('div', 'flat');
  for (const [p, its] of groups) {
    if (budget <= 0) break;
    const gh = el('div', 'flat-ghead');
    gh.append(el('span', 'gname', p.name), el('span', 'count', `${its.length} 件`));
    box.append(gh);
    its.slice(0, budget).forEach(it => box.append(itemRow(p, it, false)));
    budget -= its.length;
  }
  sec.append(box);
  if (foldable) {
    const more = el('button', 'more', state.quickExpanded ? '收起 ▴' : `還有 ${total - QUICK_FOLD} 件 ▾`);
    more.onclick = () => { state.quickExpanded = !state.quickExpanded; renderQuick(); };
    sec.append(more);
  }
}

function renderWidgets() {
  const sec = $('#sec-widgets');
  sec.innerHTML = '';
  if (!['focus', 'all'].includes(state.filter)) return;
  // 還沒接上資料源的不顯示（feeder 把 JSON 推上來就自動出現），佔位卡放著只會變雜訊
  const ws = (state.doc.widgets || []).filter(w => state.widgets[w.id]);
  if (!ws.length) return;
  const head = el('div', 'sec-head');
  head.append(el('h2', null, '📊 我的工具'));
  sec.append(head);
  const grid = el('div', 'wgrid');
  ws.forEach(w => {
    const data = state.widgets[w.id];
    const card = el('div', 'widget');
    card.append(el('h3', null, `${w.icon || '•'} ${data.title || w.title}`));
    {
      if (data.metrics?.length) {
        const m = el('div', 'wmetrics');
        data.metrics.forEach(x => {
          const b = el('div', 'wmetric');
          b.append(el('b', null, x.value), el('span', null, x.label));
          m.append(b);
        });
        card.append(m);
      }
      if (data.lines?.length) {
        const ul = el('ul', 'wlines');
        data.lines.forEach(t => ul.append(el('li', null, t)));
        card.append(ul);
      }
      if (data.link?.href) {
        const a = el('a', null, data.link.text || '開啟');
        a.href = data.link.href; a.target = '_blank'; a.rel = 'noopener';
        a.style.fontSize = '12.5px';
        card.append(a);
      }
      if (data.updated) card.append(el('div', 'wupd', `更新：${data.updated}`));
    }
    grid.append(card);
  });
  sec.append(grid);
}

function statusPill(p) {
  const map = {
    done: ['pill-done', '完成'],
    'in-progress': ['pill-progress', '進行中'],
    'waiting-ted': ['pill-ted', '等你'],
    'waiting-other': ['pill-other', '等別人'],
    blocked: ['pill-blocked', '卡住'],
    idea: ['pill-idea', '構想'],
  };
  const m = map[p.status] || ['pill-other', p.status || '—'];
  return el('span', 'pill ' + m[0], m[1]);
}

function renderProjects() {
  const sec = $('#sec-projects');
  sec.innerHTML = '';
  if (['quick', 'mine', 'history'].includes(state.filter)) return;
  const showDone = state.filter === 'all';
  const focusTracks = ['cash', 'evidence', 'bni'];
  const tracks = (state.doc.tracks || []).filter(t => state.filter !== 'focus' || focusTracks.includes(t.id));

  tracks.forEach(t => {
    const projects = (state.doc.projects || []).filter(p => p.track === t.id);
    if (!projects.length) return;
    const wrap = el('div', 'track');
    const h = el('div', 'track-head');
    h.append(el('span', 'ic', t.icon || '•'), el('span', null, t.label));
    wrap.append(h);
    if (t.note) wrap.append(el('p', 'track-note', t.note));

    projects.forEach(p => {
      const items = (p.items || []).filter(i => showDone || !i.done);
      const total = (p.items || []).length;
      const done = (p.items || []).filter(i => i.done).length;
      const card = el('div', 'card' + (state.open.has(p.id) ? ' is-open' : ''));

      const head = el('div', 'card-head');
      const title = el('div', 'card-title');
      const nm = el('div', 'nm');
      nm.append(el('span', null, p.name), statusPill(p));
      title.append(nm);
      if (p.summary) title.append(el('div', 'sm', p.summary));
      const meta = el('div', 'card-meta');
      const prog = el('div', 'prog');
      const bar = el('div', 'bar');
      const fill = el('i'); fill.style.width = total ? `${Math.round(done / total * 100)}%` : '0%';
      bar.append(fill);
      prog.append(bar, el('span', null, `${done}/${total}`));
      meta.append(prog);
      if (p.deadline) {
        const dl = el('button', 'deadline', `⏳ ${p.deadline}・${dayLabel(daysUntil(p.deadline))}`);
        dl.onclick = ev => {
          ev.stopPropagation();
          const v = prompt('截止日期（YYYY-MM-DD，留空＝取消）', p.deadline || '');
          if (v !== null) pushOp({ type: 'setDeadline', projectId: p.id, date: v.trim() || null });
        };
        meta.append(dl);
      }
      if (p.memory) meta.append(el('span', 'muted', `記憶：${p.memory}`));
      title.append(meta);
      head.append(title, el('div', 'caret', '▶'));
      head.onclick = () => {
        card.classList.toggle('is-open');
        state.open.has(p.id) ? state.open.delete(p.id) : state.open.add(p.id);
        localStorage.setItem(LS_OPEN, JSON.stringify([...state.open]));
      };

      const body = el('div', 'card-body');
      if (!items.length) body.append(el('div', 'item', '（沒有待辦了）'));
      items.forEach(it => body.append(itemRow(p, it, false)));

      const add = el('div', 'add-row');
      const inp = el('input');
      inp.placeholder = '新增一項…';
      const btn = el('button', null, '加入');
      const commit = () => {
        const v = inp.value.trim();
        if (!v) return;
        inp.value = '';
        pushOp({ type: 'addItem', projectId: p.id, item: { id: uid('x'), text: v, done: false, owner: 'ted' } });
      };
      btn.onclick = commit;
      inp.onkeydown = e => { if (e.key === 'Enter') commit(); };
      add.append(inp, btn);
      body.append(add);

      card.append(head, body);
      wrap.append(card);
    });

    const addP = el('button', 'btn btn-ghost');
    addP.textContent = '＋ 新增專案';
    addP.style.fontSize = '12.5px';
    addP.onclick = () => {
      const name = prompt(`在「${t.label}」新增專案，名稱？`);
      if (!name || !name.trim()) return;
      pushOp({ type: 'addProject', project: { id: uid('p'), name: name.trim(), track: t.id, status: 'in-progress', deadline: null, summary: '', items: [] } });
    };
    wrap.append(addP);
    sec.append(wrap);
  });

  if (state.filter === 'focus') {
    const note = el('p', 'sec-note', '聚焦模式只顯示現金線、案例軌、BNI。要看產品／青商／基建／個人，切「全部未完成」。');
    sec.append(note);
  }
}

function renderHistory() {
  const sec = $('#sec-history');
  sec.innerHTML = '';
  if (state.filter !== 'history') return;

  const tracks = state.doc.tracks || [];
  const projects = state.doc.projects || [];
  const head = el('div', 'sec-head');
  head.append(el('h2', null, '📜 完成紀錄'));
  sec.append(head);
  sec.append(el('p', 'sec-note', '照專案分開，點開看完成日期的時間軸。'));

  let totalDone = 0;
  tracks.forEach(t => {
    const group = projects
      .filter(p => p.track === t.id)
      .map(p => ({ p, items: (p.items || []).filter(i => i.done).sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || '')) }))
      .filter(x => x.items.length);
    if (!group.length) return;
    const trackCount = group.reduce((a, x) => a + x.items.length, 0);
    totalDone += trackCount;

    const tKey = 'h-' + t.id;
    const tWrap = el('div', 'hist-track' + (state.open.has(tKey) ? ' is-open' : ''));
    const tHead = el('button', 'hist-track-head');
    tHead.append(el('span', 'ic', t.icon || '•'), el('span', null, t.label), el('span', 'count', `${trackCount} 件`), el('span', 'caret', '▶'));
    tHead.onclick = () => {
      state.open.has(tKey) ? state.open.delete(tKey) : state.open.add(tKey);
      localStorage.setItem(LS_OPEN, JSON.stringify([...state.open]));
      renderHistory();
    };
    tWrap.append(tHead);

    const pBox = el('div', 'hist-projects');
    group.forEach(({ p, items }) => {
      const pKey = 'h-' + p.id;
      const pWrap = el('div', 'hist-project' + (state.open.has(pKey) ? ' is-open' : ''));
      const pHead = el('button', 'hist-project-head');
      pHead.append(el('span', null, p.name), el('span', 'count', `${items.length} 件`), el('span', 'caret', '▶'));
      pHead.onclick = () => {
        state.open.has(pKey) ? state.open.delete(pKey) : state.open.add(pKey);
        localStorage.setItem(LS_OPEN, JSON.stringify([...state.open]));
        renderHistory();
      };
      pWrap.append(pHead);
      const tl = el('div', 'timeline');
      if (p.portfolio && (p.portfolio.url || (p.portfolio.images || []).length)) {
        const pf = el('div', 'portfolio-row');
        if (p.portfolio.url) {
          const a = el('a', 'portfolio-link');
          a.href = p.portfolio.url;
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = '🔗 查看作品';
          pf.append(a);
        }
        (p.portfolio.images || []).forEach(src => {
          const a = el('a', 'portfolio-thumb');
          a.href = src;
          a.target = '_blank';
          a.rel = 'noopener';
          const img = el('img');
          img.src = src;
          img.loading = 'lazy';
          img.alt = p.name + ' 截圖';
          a.append(img);
          pf.append(a);
        });
        tl.append(pf);
      }
      items.forEach(it => {
        const row = el('div', 'tl-row');
        row.append(el('div', 'tl-date', it.completedAt || '日期不明'), el('div', 'tl-text', it.text));
        tl.append(row);
      });
      pWrap.append(tl);
      pBox.append(pWrap);
    });
    tWrap.append(pBox);
    sec.append(tWrap);
  });

  if (!totalDone) sec.append(el('div', 'empty', '還沒有完成紀錄——事項標完成之後會自動出現在這裡。'));
}

function render() {
  const d = state.doc;
  const nOpen = (d.projects || []).reduce((a, p) => a + (p.items || []).filter(i => !i.done).length, 0);
  $('#today').textContent = `${todayISO()}・未完成 ${nOpen} 項・資料更新 ${(d.updated || '').slice(0, 16).replace('T', ' ')}`;
  renderToday();
  renderGates();
  renderQuick();
  renderWidgets();
  renderProjects();
  renderHistory();
}

/* ---------- boot ---------- */
async function boot() {
  applyTheme();
  $('#gate-repo').textContent = `${CFG.owner}/${CFG.repo}`;
  if (!state.token && !LOCAL) return showGate();
  try {
    const { doc, sha } = await loadDoc();
    state.doc = doc; state.sha = sha;
    $('#gate').hidden = true;
    $('#app').hidden = false;
    [...$('#filters').children].forEach(c => c.classList.toggle('is-active', c.dataset.filter === state.filter));
    setSync('ok');
    render();
    loadWidgets();
  } catch (e) {
    showGate(e.message);
  }
}

function showGate(err) {
  $('#app').hidden = true;
  $('#gate').hidden = false;
  if (err) { $('#gate-err').hidden = false; $('#gate-err').textContent = err; }
}

$('#gate-go').onclick = async () => {
  const v = $('#gate-token').value.trim();
  if (!v) return;
  state.token = v;
  localStorage.setItem(LS_TOKEN, v);
  $('#gate-err').hidden = true;
  await boot();
};
$('#gate-token').onkeydown = e => { if (e.key === 'Enter') $('#gate-go').click(); };

$('#filters').onclick = e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  [...$('#filters').children].forEach(c => c.classList.toggle('is-active', c === b));
  state.filter = b.dataset.filter;
  render();
  window.scrollTo(0, 0);
};

$('#btn-reload').onclick = async () => {
  setSync('busy');
  try {
    const { doc, sha } = await loadDoc();
    state.doc = doc; state.sha = sha;
    render(); await loadWidgets(); setSync('ok');
  } catch (e) { setSync('err', e.message); }
};

$('#btn-menu').onclick = () => {
  $('#menu-meta').textContent = `資料：${CFG.owner}/${CFG.repo}/${CFG.path}\n最後更新：${state.doc?.updated || '—'}（${state.doc?.updatedBy || '—'}）`;
  $('#menu').hidden = false;
};
$('#btn-close').onclick = () => { $('#menu').hidden = true; };
$('#theme-seg').onclick = e => {
  const b = e.target.closest('button');
  if (!b) return;
  localStorage.setItem(LS_THEME, b.dataset.theme);
  applyTheme();
};
$('#btn-export').onclick = async () => {
  await navigator.clipboard.writeText(JSON.stringify(state.doc, null, 2));
  $('#btn-export').textContent = '已複製 ✓';
  setTimeout(() => { $('#btn-export').textContent = '複製整份 JSON'; }, 1500);
};
$('#btn-forget').onclick = () => {
  if (!confirm('清除授權碼？下次進來要重新貼一次。')) return;
  localStorage.removeItem(LS_TOKEN);
  location.reload();
};

// 回到前景時自動抓最新（手機切出去再回來）
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.doc && !state.ops.length) $('#btn-reload').click();
});

boot();
