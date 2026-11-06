(function () {
  const vs = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const st = Object.assign({ asc: true }, vs.getState() || {});
  let icons = {}, rows = [], sel = null, menuEl = null;
  const busy = new Map(); // row id -> { state: 'starting' | 'stopping', timer }
  const setBusy = (id, state) => {
    clearTimeout(busy.get(id)?.timer);
    busy.set(id, { state, timer: setTimeout(() => { busy.delete(id); draw(); }, 120000) });
    draw();
  };

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cmd = (c, id) => {
    if (id && (c === 'android.startAvd' || c === 'android.coldBootAvd')) { setBusy(id, 'starting'); }
    else if (id && c === 'android.stopAvd') { setBusy(id, 'stopping'); }
    vs.postMessage({ type: 'cmd', cmd: c, id });
  };
  const codicon = (n) => `<span class="codicon codicon-${n}"></span>`;
  const both = (n) => `<span class="dark-only">${icons[n + '-dark']}</span><span class="light-only">${icons[n + '-light']}</span>`;

  function buildBar() {
    $('bar').innerHTML = `<button class="ib" id="add" title="Create Virtual Device">${codicon('add')}</button>
<button class="ib" id="pair" title="Pair Devices Using Wi-Fi">${icons['pair-over-wifi']}</button>
<span class="sep"></span><button class="ib" id="refresh" title="Refresh">${codicon('refresh')}</button>`;
    $('add').onclick = () => cmd('android.createAvd');
    $('pair').onclick = () => cmd('android.pairDevice');
    $('refresh').onclick = () => cmd('android.refresh');
    $('head').innerHTML = `<div></div><div class="n" id="sort">${codicon(st.asc ? 'chevron-up' : 'chevron-down')} Name</div><div>API</div><div>Type</div><div></div>`;
    $('sort').onclick = () => { st.asc = !st.asc; vs.setState(st); buildBar(); draw(); };
  }

  function draw() {
    const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * (st.asc ? 1 : -1));
    if (!sorted.length) { $('list').innerHTML = '<div id="empty">No devices. Use + to create a virtual device.</div>'; return; }
    $('list').innerHTML = sorted.map((r) => {
      const ic = r.type === 'Virtual' ? both('virtual') : both('physical');
      const b = busy.get(r.id);
      const act = r.startable
        ? `<button class="ib${b ? ' off' : ''}" ${b ? 'disabled' : ''} data-a="${r.running ? 'stop' : 'start'}" title="${r.running ? 'Stop' : 'Launch'}">${icons[r.running ? 'stop' : 'run']}</button>`
        : r.type === 'Physical'
          ? `<button class="ib" data-a="${r.mirroring ? 'unmirror' : 'mirror'}" title="${r.mirroring ? 'Stop Mirroring' : 'Show on Running Devices'}">${icons[r.mirroring ? 'mirror-stop' : 'mirror-start']}</button>`
          : '';
      const sub = b ? (b.state === 'starting' ? 'Starting up' : 'Shutting down') : r.sub;
      const lead = b ? '<span class="codicon codicon-loading codicon-modifier-spin spin"></span>' : r.running ? '<div class="dot"></div>' : '';
      return `<div class="r${sel === r.id ? ' sel' : ''}" data-id="${esc(r.id)}"><div class="lead">${lead}</div>
<div class="nm">${ic}<div class="t"><b title="${esc(r.name)}">${esc(r.name)}</b><small title="${esc(sub)}">${esc(sub)}</small></div></div>
<div class="c" title="${esc(r.api)}">${esc(r.api)}</div><div class="c">${r.type}</div>
<div class="act">${act}<button class="ib" data-a="more" title="More">${codicon('kebab-vertical')}</button></div></div>`;
    }).join('');
  }

  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function openMenu(items, x, y) {
    closeMenu();
    const m = document.createElement('div'); m.className = 'menu';
    for (const it of items) {
      if (it === '-') { m.appendChild(document.createElement('hr')); continue; }
      const d = document.createElement('div'); d.textContent = it.label; d.onclick = () => { closeMenu(); it.run(); }; m.appendChild(d);
    }
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(0, Math.min(x, innerWidth - r.width)) + 'px';
    m.style.top = Math.max(0, Math.min(y, innerHeight - r.height)) + 'px';
    menuEl = m;
  }
  document.addEventListener('mousedown', (e) => { if (menuEl && !menuEl.contains(e.target)) { closeMenu(); } });

  function menuFor(r, x, y) {
    const id = r.id, items = [];
    if (r.type === 'Virtual') {
      if (!r.running) { items.push({ label: 'Cold Boot Now', run: () => cmd('android.coldBootAvd', id) }); }
      if (r.running) { items.push({ label: 'Show on Running Devices', run: () => cmd('android.mirrorDevice', id) }, { label: 'Show Logcat', run: () => cmd('android.showLogcat', id) }, '-'); }
      items.push({ label: 'Edit', run: () => cmd('android.editAvd', id) });
      if (!r.running) { items.push({ label: 'Wipe Data', run: () => cmd('android.wipeAvd', id) }); }
      items.push('-', { label: 'Delete', run: () => cmd('android.deleteAvd', id) });
    } else {
      items.push({ label: 'Show on Running Devices', run: () => cmd('android.mirrorDevice', id) }, { label: 'Show Logcat', run: () => cmd('android.showLogcat', id) });
    }
    openMenu(items, x, y);
  }

  $('list').addEventListener('click', (ev) => {
    const el = ev.target.closest('.r'); if (!el) { return; }
    const r = rows.find((x) => x.id === el.dataset.id); if (!r) { return; }
    const a = ev.target.closest('[data-a]')?.dataset.a;
    sel = r.id;
    if (a === 'start') { cmd('android.startAvd', r.id); }
    else if (a === 'stop') { cmd('android.stopAvd', r.id); }
    else if (a === 'mirror') { cmd('android.mirrorDevice', r.id); }
    else if (a === 'unmirror') { cmd('android.stopMirror'); }
    else if (a === 'more') { const b = ev.target.closest('button').getBoundingClientRect(); menuFor(r, b.left, b.bottom); ev.stopPropagation(); }
    draw();
  });
  $('list').addEventListener('dblclick', (ev) => {
    const el = ev.target.closest('.r'); const r = el && rows.find((x) => x.id === el.dataset.id);
    if (r && r.running && !ev.target.closest('button')) { cmd('android.mirrorDevice', r.id); }
  });
  $('list').addEventListener('contextmenu', (ev) => {
    const el = ev.target.closest('.r'); if (!el) { return; }
    ev.preventDefault(); const r = rows.find((x) => x.id === el.dataset.id); sel = r.id; draw(); menuFor(r, ev.clientX, ev.clientY);
  });

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'init') { icons = m.icons; buildBar(); draw(); }
    else if (m.type === 'rows') {
      rows = m.rows;
      for (const r of rows) {
        const b = busy.get(r.id);
        if (b && ((b.state === 'starting' && r.running) || (b.state === 'stopping' && !r.running))) { clearTimeout(b.timer); busy.delete(r.id); }
      }
      draw();
    }
  });
  vs.postMessage({ type: 'ready' });
})();
