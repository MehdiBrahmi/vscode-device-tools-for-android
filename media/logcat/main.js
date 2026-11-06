(function () {
  const vs = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const H = 16, WRAP_MAX = 3000;
  const st = Object.assign({ history: [], favs: [], filter: '', fmt: 'standard', wrap: false }, vs.getState() || {});
  const save = () => vs.setState(st);

  let entries = [], rows = [], mine = [], max = 50000;
  let paused = false, pending = [], stick = true, serial = '', compiled = null, pkgMap = {};
  const sc = $('sc'), win = $('win'), spacer = $('spacer'), q = $('q'), hl = $('hl');
  let icons = {};
  const S = { open: false, re: null, rows: [], cur: -1, err: false, dirty: false, scroll: false, timer: 0 };

  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const tagColor = (t) => { let h = 0; for (let i = 0; i < t.length; i++) { h = (h * 31 + t.charCodeAt(i)) >>> 0; } return `hsl(${h % 360},var(--tag-s),var(--tag-l))`; };
  const svg = (n) => icons[n] || '';
  const codicon = (n) => `<span class="codicon codicon-${n}"></span>`;
  const MOD = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+';

  function btn(id, title, html, onclick, parent) {
    const b = document.createElement('button');
    b.className = 'ib'; b.id = id; b.title = title; b.innerHTML = html; b.onclick = onclick;
    parent.appendChild(b); return b;
  }

  function buildToolbar() {
    const side = $('side'); side.innerHTML = '';
    btn('b-clear', 'Clear Logcat', svg('lc-delete'), () => { entries = []; rows = []; pending = []; S.dirty = true; render(); vs.postMessage({ type: 'clear' }); }, side);
    btn('b-pause', 'Pause Logcat', svg('lc-pause'), togglePause, side);
    btn('b-restart', 'Restart Logcat', svg('lc-refresh'), () => vs.postMessage({ type: 'restart' }), side);
    btn('b-end', 'Scroll to the End', svg('lc-scroll-end'), () => { stick = true; render(); }, side);
    btn('b-prev', 'Up the Stack Trace', svg('lc-up'), () => jumpStack(-1), side);
    btn('b-next', 'Down the Stack Trace', svg('lc-down'), () => jumpStack(1), side);
    btn('b-wrap', 'Soft-Wrap', svg('lc-softwrap'), () => { st.wrap = !st.wrap; save(); applyWrap(); }, side);
    btn('b-search', `Search (${MOD}F)`, codicon('search'), () => (S.open ? closeSearch() : openSearch()), side).classList.toggle('on', S.open);
    const sep = document.createElement('div'); sep.className = 'hsep'; side.appendChild(sep);
    btn('b-shot', 'Screen Capture', svg('screenshot'), () => vs.postMessage({ type: 'screenshot' }), side);
    btn('b-rec', 'Screen Record', svg('record'), () => vs.postMessage({ type: 'record' }), side);
    $('hist-btn').innerHTML = svg('filter-history');
    updateFav();
  }

  function togglePause() {
    paused = !paused;
    const b = $('b-pause');
    b.classList.toggle('on', paused);
    b.innerHTML = paused ? codicon('debug-continue') : svg('lc-pause');
    b.title = paused ? 'Resume Logcat' : 'Pause Logcat';
    if (!paused) { const p = pending; pending = []; ingest(p); render(); }
  }

  function applyWrap() {
    $('b-wrap').classList.toggle('on', st.wrap);
    document.body.classList.toggle('wrap', st.wrap);
    spacer.style.display = st.wrap ? 'none' : '';
    render();
  }

  // ---- data ----
  const filterView = (e) => ({ tag: e.tag, pkg: e.pkg, lines: e.lines, lv: e.lv, lvn: e.lvn, rx: e.rx, pid: e.pid, tid: e.tid });
  const visible = (e) => compiled.test(filterView(e));

  function pushRows(e) { for (let i = 0; i < e.lines.length; i++) { rows.push({ e, i }); } }

  function ingest(items) {
    for (const it of items) {
      const last = entries[entries.length - 1];
      if (last && last.ts === it.ts && last.pid === it.pid && last.tid === it.tid && last.lv === it.lv && last.tag === it.tag) {
        last.lines.push(it.msg);
        if (last.vis) { rows.push({ e: last, i: last.lines.length - 1 }); }
        else if (visible(last)) { last.vis = true; pushRows(last); }
        continue;
      }
      const e = { ts: it.ts, pid: it.pid, tid: it.tid, lv: it.lv, lvn: LogFilter.LEVELS[it.lv] || 4, tag: it.tag, pkg: it.pkg || pkgMap[it.pid] || '', lines: [it.msg], rx: it.rx };
      entries.push(e);
      if (visible(e)) { e.vis = true; pushRows(e); }
    }
    S.dirty = true;
    if (entries.length > max * 1.1) { entries = entries.slice(entries.length - max); rebuild(); }
  }

  function rebuild() {
    rows = []; S.dirty = true;
    for (const e of entries) { e.vis = visible(e); if (e.vis) { pushRows(e); } }
  }

  function recompile() {
    compiled = LogFilter.compile(st.filter, () => ({ mine, matchCase: !!st.cc }));
    $('filterbox').classList.toggle('error', !!compiled.error);
    $('filterbox').title = compiled.error || '';
    renderHighlight();
    rebuild(); stick = true; render(); updateFav();
  }

  function renderHighlight() {
    const s = st.filter; let out = '', p = 0;
    for (const t of (compiled.toks || [])) {
      if (t.t !== 'term' || !t.key) { continue; }
      out += esc(s.slice(p, t.s)) + '<span class="kv">' + esc(s.slice(t.s, t.e)) + '</span>'; p = t.e;
    }
    hl.innerHTML = out + esc(s.slice(p)) + ' ';
  }

  // ---- rendering ----
  function rowHtml(i) {
    const { e, i: li } = rows[i];
    const prev = rows[i - 1];
    const first = li === 0;
    const hideTag = first && prev && prev.e.tag === e.tag && prev.e.pid === e.pid;
    const msg = hx(e.lines[li]);
    const cur = S.cur >= 0 && S.rows[S.cur] === i ? ' cur' : '';
    if (st.fmt === 'compact') {
      const head = first ? `<span class="ctime">${hx(e.ts.slice(11))}</span><span class="lvb">${e.lv}</span>` : '<span class="ctime"></span><span class="lvb" style="visibility:hidden"> </span>';
      const tg = first && !hideTag ? `<span style="color:${tagColor(e.tag)}">${hx(e.tag)}</span>: ` : '';
      return `<div class="row lv-${e.lv}${cur}" data-i="${i}" style="height:${H}px">${head}<span class="m">${tg}${msg}</span></div>`;
    }
    const lv = first ? `<span class="lvb">${e.lv}</span>` : '<span class="lvb" style="visibility:hidden"> </span>';
    return `<div class="row lv-${e.lv}${cur}" data-i="${i}" style="height:${st.wrap ? 'auto' : H + 'px'}"><span class="ts">${first ? hx(e.ts) : ''}</span><span class="pt">${first ? hx(e.pid + '-' + e.tid) : ''}</span><span class="tg" style="color:${tagColor(e.tag)}" title="${esc(e.tag)}">${first && !hideTag ? hx(e.tag) : ''}</span><span class="pk" title="${esc(e.pkg)}">${first ? hx(e.pkg) : ''}</span>${lv}<span class="m">${msg}</span></div>`;
  }

  // ---- search in the log (find bar) ----
  function hx(s) {
    const re = S.re;
    if (!re || !s) { return esc(s || ''); }
    re.lastIndex = 0;
    let out = '', p = 0, m;
    while ((m = re.exec(s))) {
      if (!m[0]) { re.lastIndex++; continue; }
      out += esc(s.slice(p, m.index)) + '<mark>' + esc(m[0]) + '</mark>'; p = m.index + m[0].length;
    }
    return out + esc(s.slice(p));
  }

  // Fields displayed for a row, so that the search only matches what is visible.
  function rowFields(i) {
    const { e, i: li } = rows[i];
    const prev = rows[i - 1];
    const f = [];
    if (li === 0) {
      const tag = prev && prev.e.tag === e.tag && prev.e.pid === e.pid ? '' : e.tag;
      if (st.fmt === 'compact') { f.push(e.ts.slice(11), tag); } else { f.push(e.ts, e.pid + '-' + e.tid, tag, e.pkg); }
    }
    f.push(e.lines[li]);
    return f;
  }

  function buildRe() {
    S.err = false;
    const t = S.open ? $('sq').value : '';
    if (!t) { return null; }
    try {
      let src = st.srx ? t : t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (st.sw) { src = `\\b(?:${src})\\b`; }
      return new RegExp(src, st.scc ? 'g' : 'gi');
    } catch { S.err = true; return null; }
  }

  function updateCount() {
    const n = S.rows.length;
    $('scount').textContent = !S.re ? '' : n ? `${S.cur + 1}/${n.toLocaleString('en-US')}` : 'No results';
    $('sbox').classList.toggle('error', S.err);
    $('s-up').disabled = $('s-down').disabled = !n;
  }

  function scheduleSearch(keep, delay) {
    if (!S.open) { return; }
    if (S.timer && keep) { return; }
    clearTimeout(S.timer);
    S.timer = setTimeout(() => { S.timer = 0; runSearch(keep); }, delay);
  }

  function runSearch(keep) {
    S.dirty = false;
    const prev = S.rows[S.cur];
    S.re = buildRe();
    const m = [];
    if (S.re) {
      for (let i = 0; i < rows.length; i++) {
        for (const f of rowFields(i)) { if (f) { S.re.lastIndex = 0; if (S.re.test(f)) { m.push(i); break; } } }
      }
    }
    S.rows = m;
    if (!m.length) { S.cur = -1; updateCount(); render(); return; }
    if (keep && prev != null) {
      const k = m.indexOf(prev);
      S.cur = k >= 0 ? k : Math.min(Math.max(S.cur, 0), m.length - 1);
      updateCount(); render();
    } else {
      const top = st.wrap ? 0 : Math.floor(sc.scrollTop / H);
      const k = m.findIndex((x) => x >= top);
      S.cur = k >= 0 ? k : m.length - 1;
      reveal();
    }
  }

  function reveal() {
    const r = S.rows[S.cur];
    updateCount();
    if (r == null) { render(); return; }
    stick = false;
    if (st.wrap) { S.scroll = true; } else if (r * H < sc.scrollTop || (r + 1) * H > sc.scrollTop + sc.clientHeight) {
      sc.scrollTop = Math.max(0, r * H - sc.clientHeight / 2 + H / 2);
    }
    render();
  }

  function go(dir) {
    if (!S.rows.length) { return; }
    S.cur = (S.cur + dir + S.rows.length) % S.rows.length;
    reveal();
  }

  function openSearch() {
    const bar = $('sbar'), input = $('sq');
    S.open = true; bar.style.display = 'flex';
    $('b-search')?.classList.add('on');
    const sel = String(getSelection() || '').trim();
    if (sel && !sel.includes('\n') && sel.length < 200) { input.value = sel; }
    input.focus(); input.select();
    scheduleSearch(false, 0);
  }

  function closeSearch() {
    S.open = false; S.re = null; S.rows = []; S.cur = -1; S.err = false;
    clearTimeout(S.timer); S.timer = 0;
    $('sbar').style.display = 'none';
    $('b-search')?.classList.remove('on');
    render();
  }

  (function buildSearchBar() {
    const bar = document.createElement('div');
    bar.id = 'sbar';
    bar.innerHTML = `<div id="sbox">${codicon('search')}<input id="sq" spellcheck="false" placeholder="Search in logs"><button class="ib" id="sclear" title="Clear">${codicon('close')}</button>` +
      '<button class="ib opt" id="s-cc" title="Match Case">Cc</button><button class="ib opt" id="s-w" title="Words">W</button><button class="ib opt" id="s-rx" title="Regex">.*</button></div>' +
      `<span id="scount"></span><button class="ib" id="s-up" title="Previous Occurrence (Shift+Enter)">${codicon('arrow-up')}</button><button class="ib" id="s-down" title="Next Occurrence (Enter)">${codicon('arrow-down')}</button>` +
      `<button class="ib" id="s-close" title="Close (Esc)">${codicon('close')}</button>`;
    $('main').parentNode.insertBefore(bar, $('main'));
    const input = $('sq');
    const sync = () => {
      for (const [id, k] of [['s-cc', 'scc'], ['s-w', 'sw'], ['s-rx', 'srx']]) { $(id).classList.toggle('active', !!st[k]); }
      $('sclear').style.visibility = input.value ? 'visible' : 'hidden';
    };
    for (const [id, k] of [['s-cc', 'scc'], ['s-w', 'sw'], ['s-rx', 'srx']]) {
      $(id).onclick = () => { st[k] = !st[k]; save(); sync(); scheduleSearch(false, 0); input.focus(); };
    }
    input.addEventListener('input', () => { sync(); scheduleSearch(false, 120); });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); go(ev.shiftKey ? -1 : 1); }
      else if (ev.key === 'Escape') { ev.preventDefault(); closeSearch(); }
    });
    $('sclear').onclick = () => { input.value = ''; sync(); scheduleSearch(false, 0); input.focus(); };
    $('s-up').onclick = () => go(-1);
    $('s-down').onclick = () => go(1);
    $('s-close').onclick = closeSearch;
    document.addEventListener('keydown', (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === 'f') { ev.preventDefault(); openSearch(); }
      else if (ev.key === 'F3' && S.open) { ev.preventDefault(); go(ev.shiftKey ? -1 : 1); }
    });
    sync();
  })();

  let raf = 0;
  function render() { if (!raf) { raf = requestAnimationFrame(() => { raf = 0; draw(); }); } }

  function draw() {
    const n = rows.length;
    $('count').textContent = entries.length ? `${n} / ${entries.length}` : '';
    $('empty').textContent = entries.length ? '' : (serial ? 'Waiting for logs…' : 'No device connected');
    if (st.wrap) {
      const start = Math.max(0, n - WRAP_MAX);
      let h = ''; for (let i = start; i < n; i++) { h += rowHtml(i); }
      win.innerHTML = h;
      if (stick) { sc.scrollTop = sc.scrollHeight; } else if (S.scroll) {
        S.scroll = false; win.querySelector(`[data-i="${S.rows[S.cur]}"]`)?.scrollIntoView({ block: 'center' });
      }
      if (S.open && S.dirty) { scheduleSearch(true, 500); }
      return;
    }
    spacer.style.height = n * H + 'px';
    if (stick) { sc.scrollTop = Math.max(0, n * H - sc.clientHeight); }
    const top = sc.scrollTop, a = Math.max(0, Math.floor(top / H) - 10), b = Math.min(n, Math.ceil((top + sc.clientHeight) / H) + 10);
    let h = ''; for (let i = a; i < b; i++) { h += rowHtml(i); }
    win.style.top = a * H + 'px';
    win.innerHTML = h;
    if (S.open && S.dirty) { scheduleSearch(true, 500); }
  }

  sc.addEventListener('scroll', () => {
    stick = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4;
    if (!st.wrap) { render(); }
  });
  new ResizeObserver(render).observe(sc);

  // ---- filter input, history, favorites ----
  function setFilter(v, remember) {
    st.filter = v; q.value = v;
    if (remember && v.trim()) { st.history = [v, ...st.history.filter((x) => x !== v)].slice(0, 30); }
    save(); recompile();
  }
  q.addEventListener('input', () => { st.filter = q.value; save(); recompile(); });
  q.addEventListener('scroll', () => { hl.scrollLeft = q.scrollLeft; });
  const STACK = /^\s+at\s+\S+\(.*\)|^Caused by: /;
  function jumpStack(dir) {
    const top = Math.floor(sc.scrollTop / H);
    for (let i = dir > 0 ? top + 1 : top - 1; i >= 0 && i < rows.length; i += dir) {
      const r = rows[i];
      if (STACK.test(r.e.lines[r.i] || '') && (i === 0 || !STACK.test(rows[i - 1].e.lines[rows[i - 1].i] || '') || dir < 0)) {
        stick = false; sc.scrollTop = Math.max(0, i * H - H); render(); return;
      }
    }
  }
  const cc = document.createElement('button'); cc.className = 'ib cc'; cc.id = 'cc'; cc.textContent = 'Cc'; cc.title = 'Match Case';
  const clr = document.createElement('button'); clr.className = 'ib'; clr.id = 'qclear'; clr.title = 'Clear filter'; clr.innerHTML = codicon('close');
  $('filterbox').insertBefore(clr, $('fav')); $('filterbox').insertBefore(cc, $('fav'));
  const syncQ = () => { cc.classList.toggle('active', !!st.cc); clr.style.visibility = q.value ? 'visible' : 'hidden'; };
  cc.onclick = () => { st.cc = !st.cc; save(); syncQ(); recompile(); };
  clr.onclick = () => { setFilter('', false); q.focus(); };
  q.addEventListener('input', syncQ); syncQ();

  // ---- key completion popup ----
  const TXT = { tag: 'Tag', package: 'Package name', process: 'Process name', message: 'Log message', line: 'Log line', name: 'Tag' };
  const MODE = { '': ['contains string', 'does not contain string'], '=': ['is exactly string', 'is not exactly string'], '~': ['matches string', 'does not match string'] };
  const sugg = [];
  for (const neg of ['', '-']) for (const k of Object.keys(TXT)) for (const m of ['', '=', '~']) {
    sugg.push({ ins: `${neg}${k}${m}:`, desc: `${TXT[k]} ${MODE[m][neg ? 1 : 0]}`.replace(/^(Log message|Log line) (contains|does)/, '$1 $2') });
  }
  sugg.push({ ins: 'level:', desc: 'Log level is at least' }, { ins: 'level=:', desc: 'Log level is exactly' },
    { ins: 'age:', desc: 'Entries newer than, e.g. 5m, 30s, 2h' }, { ins: 'is:crash', desc: 'Crash entries' }, { ins: 'is:stacktrace', desc: 'Stack trace entries' });
  const VALS = { level: ['verbose', 'debug', 'info', 'warn', 'error', 'assert'], is: ['crash', 'stacktrace', 'firebase'] };
  const pop = document.createElement('div');
  pop.id = 'sugg'; document.getElementById('filterbox').appendChild(pop);
  let items = [], sel = 0;
  function wordStart() {
    const c = q.selectionStart, before = q.value.slice(0, c);
    let inQ = false, st0 = 0;
    for (let i = 0; i < before.length; i++) {
      const ch = before[i];
      if (ch === '"') { inQ = !inQ; } else if (!inQ && (ch === ' ' || ch === '(')) { st0 = i + 1; }
    }
    return { st0, word: before.slice(st0), end: c };
  }
  function showSugg() {
    const { word } = wordStart();
    items = [];
    const m = word.match(/^-?(\w+)([=~]?):(.*)$/);
    const key = m && m[1].toLowerCase();
    if (m && (VALS[key] || ['tag', 'name', 'package', 'process'].includes(key))) {
      const typed = m[3].replace(/^"/, '').toLowerCase(), head = word.slice(0, word.indexOf(':') + 1);
      let vals = VALS[key];
      if (!vals) {
        const freq = new Map();
        for (let i = Math.max(0, entries.length - 5000); i < entries.length; i++) {
          const v = key === 'tag' || key === 'name' ? entries[i].tag : entries[i].pkg;
          if (v) { freq.set(v, (freq.get(v) || 0) + 1); }
        }
        vals = [...freq.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
        if (key === 'package' || key === 'process') { vals = ['mine', ...vals]; }
      }
      items = vals.filter((v) => v.toLowerCase().includes(typed) && v.toLowerCase() !== typed).slice(0, 100)
        .map((v) => ({ ins: head + (/[\s"()|&]/.test(v) ? '"' + v + '"' : v), desc: key === 'package' && v === 'mine' ? 'Packages of the open project' : '' }));
    } else if (word && !word.includes(':')) {
      items = sugg.filter((x) => x.ins.startsWith(word.toLowerCase()));
    }
    sel = 0;
    if (!items.length) { pop.style.display = 'none'; return; }
    pop.innerHTML = items.map((x, i) => `<div class="si${i === 0 ? ' on' : ''}" data-i="${i}"><span>${esc(x.ins)}</span><span class="d">${esc(x.desc)}</span></div>`).join('');
    pop.style.display = 'block';
  }
  function pick(i) {
    const x = items[i]; if (!x) { return; }
    const { st0, end } = wordStart();
    q.value = q.value.slice(0, st0) + x.ins + q.value.slice(end);
    q.selectionStart = q.selectionEnd = st0 + x.ins.length;
    st.filter = q.value; save(); recompile(); showSugg(); q.focus();
  }
  function mark() { [...pop.children].forEach((c, i) => c.classList.toggle('on', i === sel)); pop.children[sel]?.scrollIntoView({ block: 'nearest' }); }
  pop.addEventListener('mousedown', (e) => { e.preventDefault(); const d = e.target.closest('.si'); if (d) { pick(+d.dataset.i); } });
  q.addEventListener('input', showSugg);
  q.addEventListener('click', showSugg);
  q.addEventListener('blur', () => { pop.style.display = 'none'; });
  q.addEventListener('keydown', (ev) => {
    if (pop.style.display !== 'block') { return; }
    if (ev.key === 'ArrowDown') { sel = (sel + 1) % items.length; mark(); ev.preventDefault(); }
    else if (ev.key === 'ArrowUp') { sel = (sel - 1 + items.length) % items.length; mark(); ev.preventDefault(); }
    else if (ev.key === 'Tab' || ev.key === 'Enter') { pick(sel); ev.preventDefault(); ev.stopImmediatePropagation(); }
    else if (ev.key === 'Escape') { pop.style.display = 'none'; ev.preventDefault(); }
  }, true);
  q.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { setFilter(q.value, true); } });
  q.addEventListener('blur', () => { if (q.value.trim()) { st.history = [q.value, ...st.history.filter((x) => x !== q.value)].slice(0, 30); save(); } });

  function updateFav() {
    const f = $('fav'); const on = st.favs.includes(st.filter);
    f.innerHTML = svg(on ? 'favorite-filled' : 'favorite'); f.classList.toggle('active', on);
    f.title = on ? 'Remove from favorites' : 'Add to favorites';
  }
  $('fav').onclick = () => {
    if (!st.filter.trim()) { return; }
    st.favs = st.favs.includes(st.filter) ? st.favs.filter((x) => x !== st.filter) : [st.filter, ...st.favs];
    save(); updateFav();
  };

  let menuEl;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function openMenu(items, x, y, cls) {
    closeMenu();
    const m = document.createElement('div'); m.className = 'menu ' + (cls || '');
    for (const it of items) {
      if (it === '-') { m.appendChild(document.createElement('hr')); continue; }
      const d = document.createElement('div'); d.textContent = it.label;
      if (it.sec) { d.className = 'sec'; } else { d.onclick = () => { closeMenu(); it.run(); }; }
      m.appendChild(d);
    }
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(0, Math.min(x, innerWidth - r.width)) + 'px';
    m.style.top = Math.max(0, Math.min(y, innerHeight - r.height)) + 'px';
    menuEl = m;
  }
  document.addEventListener('mousedown', (e) => { if (menuEl && !menuEl.contains(e.target)) { closeMenu(); } });

  function matchCount(f) {
    try {
      const c = LogFilter.compile(f, () => ({ mine, matchCase: !!st.cc }));
      if (c.error) { return 0; }
      let n = 0;
      for (let i = entries.length - 1; i >= 0 && n < 100; i--) { if (c.test(entries[i])) { n++; } }
      return n;
    } catch { return 0; }
  }
  $('hist-btn').onclick = (ev) => {
    closeMenu();
    const r = $('filterbox').getBoundingClientRect();
    const m = document.createElement('div'); m.className = 'menu hist';
    const list = [...st.favs.map((f) => ({ f, fav: true })), ...st.history.filter((f) => !st.favs.includes(f)).map((f) => ({ f }))];
    if (!list.length) { const d = document.createElement('div'); d.className = 'sec'; d.textContent = 'No history yet'; m.appendChild(d); }
    for (const it of list) {
      const d = document.createElement('div'); d.className = 'hrow';
      const n = matchCount(it.f);
      d.innerHTML = (it.fav ? '<span class="star">' + svg('favorite-filled') + '</span>' : '') + '<span class="t">' + esc(it.f) + '</span><span class="n">' + (n >= 100 ? '99+' : n) + '</span><span class="x" title="Remove">' + codicon('trash') + '</span>';
      d.onclick = (e) => {
        if (e.target.closest('.x')) {
          st.history = st.history.filter((h) => h !== it.f); st.favs = st.favs.filter((h) => h !== it.f);
          save(); updateFav(); d.remove(); return;
        }
        closeMenu(); setFilter(it.f, true); q.focus();
      };
      m.appendChild(d);
    }
    document.body.appendChild(m);
    const h = m.getBoundingClientRect();
    m.style.minWidth = r.width + 'px';
    m.style.left = Math.max(0, Math.min(r.left, innerWidth - h.width)) + 'px';
    m.style.top = r.bottom + 2 + 'px';
    menuEl = m;
    ev.stopPropagation();
  };

  // ---- context menu ----
  const quote = (v) => (/[\s"()|&]/.test(v) ? '"' + v.replace(/"/g, '\\"') + '"' : v);
  const append = (term) => setFilter((st.filter.trim() ? st.filter.trim() + ' ' : '') + term, true);
  sc.addEventListener('contextmenu', (ev) => {
    const row = ev.target.closest('.row'); if (!row) { return; }
    ev.preventDefault();
    const { e, i } = rows[+row.dataset.i];
    const items = [
      { label: `Show only tag: ${e.tag}`, run: () => append('tag:' + quote(e.tag)) },
      { label: `Hide tag: ${e.tag}`, run: () => append('-tag:' + quote(e.tag)) },
    ];
    if (e.pkg) { items.push('-', { label: `Show only package: ${e.pkg}`, run: () => append('package:' + quote(e.pkg)) }, { label: `Hide package: ${e.pkg}`, run: () => append('-package:' + quote(e.pkg)) }); }
    items.push('-', { label: `Show this level and above (${e.lv})`, run: () => append('level:' + e.lv) });
    items.push('-', { label: 'Copy message', run: () => vs.postMessage({ type: 'copy', text: e.lines.join('\n') }) },
      { label: 'Copy line', run: () => vs.postMessage({ type: 'copy', text: `${e.ts} ${e.pid}-${e.tid} ${e.tag} ${e.lv}: ${e.lines[i]}` }) });
    openMenu(items, ev.clientX, ev.clientY);
  });

  // ---- header ----
  $('fmt').value = st.fmt;
  $('fmt').onchange = () => { st.fmt = $('fmt').value; save(); scheduleSearch(false, 0); render(); };
  $('dev').onchange = () => { entries = []; rows = []; vs.postMessage({ type: 'select', serial: $('dev').value }); };

  function setStatus(text) {
    const s = $('status'); s.textContent = text; s.style.display = text ? 'block' : 'none';
    if (text) { setTimeout(() => { s.style.display = 'none'; }, 4000); }
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'init': icons = m.icons; mine = m.mine || []; max = m.max || 50000; buildToolbar(); q.value = st.filter; applyWrap(); recompile(); break;
      case 'devices': {
        serial = m.serial || '';
        const sel = $('dev'); const sig = JSON.stringify(m.list) + serial;
        if (sel.dataset.sig !== sig) {
          sel.dataset.sig = sig;
          sel.innerHTML = m.list.length ? m.list.map((d) => `<option value="${esc(d.serial)}">${esc(d.name || d.avdName || d.model || d.serial)} (${esc(d.serial)})</option>`).join('') : '<option value="">No devices</option>';
          sel.value = serial;
        }
        break;
      }
      case 'reset': entries = []; rows = []; S.dirty = true; pending = []; pkgMap = {}; stick = true; render(); break;
      case 'batch': if (paused) { pending.push(...m.items); } else { ingest(m.items); render(); } break;
      case 'pkgs': {
        Object.assign(pkgMap, m.map);
        let changed = false;
        for (let i = entries.length - 1; i >= 0 && i >= entries.length - 5000; i--) {
          const e = entries[i]; if (!e.pkg && pkgMap[e.pid]) { e.pkg = pkgMap[e.pid]; changed = true; }
        }
        if (changed) { if (/package|is:|mine/.test(st.filter)) { rebuild(); } render(); }
        break;
      }
      case 'status': setStatus(m.text); break;
    }
  });

  vs.postMessage({ type: 'ready' });
})();
