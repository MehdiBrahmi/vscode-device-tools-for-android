(function () {
  const vs = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const emu = (cmd) => vs.postMessage({ type: 'emu', cmd });
  const opts = (a) => a.map((x) => `<option>${x}</option>`).join('');
  const SECTIONS = [
    ['Displays', 'screen-full', () => `<h3>Primary display</h3><div class="row"><label>Size</label><span id="dsize" class="big">…</span></div><div class="row"><label>Density</label><span id="ddens" class="big">…</span></div>`],
    ['Cellular', 'broadcast', () => `<div class="row"><label>Network type</label><select id="ns">${opts(['full', 'lte', 'hsdpa', 'umts', 'edge', 'gprs', 'hscsd', 'gsm'])}</select></div>
<div class="row"><label>Signal / voice</label><select id="gv">${opts(['home', 'roaming', 'searching', 'denied', 'unregistered'])}</select></div>
<div class="row"><label>Data status</label><select id="gd">${opts(['home', 'roaming', 'searching', 'denied', 'unregistered'])}</select></div>
<div class="row"><label>Network delay</label><select id="nd">${opts(['none', 'gprs', 'edge', 'umts'])}</select></div>
<div class="row"><button class="pri" id="apply">Apply</button></div>`,
      () => { $('apply').onclick = () => { emu('network speed ' + $('ns').value); emu('gsm voice ' + $('gv').value); emu('gsm data ' + $('gd').value); emu('network delay ' + $('nd').value); }; }],
    ['Battery', 'plug', () => `<div class="row"><label>Charge level</label><input type="range" id="cap" min="0" max="100" value="100"><b id="capv">100%</b></div>
<div class="row"><label>Charger</label><select id="ac">${opts(['AC charger', 'None'])}</select></div>
<div class="row"><label>Battery status</label><select id="bs">${opts(['charging', 'discharging', 'not-charging', 'full'])}</select></div>
<div class="row"><label>Health</label><select id="bh">${opts(['good', 'failed', 'dead', 'overvoltage', 'overheated'])}</select></div>`,
      () => {
        $('cap').oninput = () => { $('capv').textContent = $('cap').value + '%'; emu('power capacity ' + $('cap').value); };
        $('ac').onchange = () => emu('power ac ' + ($('ac').value === 'None' ? 'off' : 'on'));
        $('bs').onchange = () => emu('power status ' + $('bs').value);
        $('bh').onchange = () => emu('power health ' + $('bh').value);
      }],
    ['Location', 'location', () => `<div class="row"><label>Latitude</label><input id="lat" value="48.8566"></div><div class="row"><label>Longitude</label><input id="lon" value="2.3522"></div><div class="row"><label>Altitude (m)</label><input id="alt" value="0"></div>
<div class="row"><button class="pri" id="geo">Send</button></div>`,
      () => { $('geo').onclick = () => emu(`geo fix ${$('lon').value} ${$('lat').value} ${$('alt').value}`); }],
    ['Phone', 'call-incoming', () => `<h3>Incoming call</h3><div class="row"><label>Phone number</label><input id="num" value="5551234"></div>
<div class="row"><button class="pri" id="call">Call device</button><button id="accept">Answer</button><button id="hang">Hang up</button></div>
<h3 style="margin-top:28px">SMS</h3><div class="row"><label>Message</label><input id="sms" style="width:320px" value="Hello"></div><div class="row"><button class="pri" id="send">Send message</button></div>`,
      () => {
        $('call').onclick = () => emu('gsm call ' + $('num').value);
        $('accept').onclick = () => emu('gsm accept ' + $('num').value);
        $('hang').onclick = () => emu('gsm cancel ' + $('num').value);
        $('send').onclick = () => vs.postMessage({ type: 'sms', number: $('num').value, text: $('sms').value });
      }],
    ['Directional pad', 'target', () => `<div class="dpad"><span></span><button data-k="19">▲</button><span></span><button data-k="21">◀</button><button data-k="23">●</button><button data-k="22">▶</button><span></span><button data-k="20">▼</button><span></span></div>`,
      () => document.querySelectorAll('[data-k]').forEach((b) => { b.onclick = () => vs.postMessage({ type: 'key', code: b.dataset.k }); })],
    ['Fingerprint', 'lock', () => `<div class="row"><label>Finger</label><select id="fid">${opts(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])}</select></div><div class="row"><button class="pri" id="touch">Touch the sensor</button><button id="rem">Remove finger</button></div>`,
      () => { $('touch').onclick = () => emu('finger touch ' + $('fid').value); $('rem').onclick = () => emu('finger remove'); }],
    ['Virtual sensors', 'sync', () => `<div class="row"><button class="pri" id="rot">Rotate device</button></div>`, () => { $('rot').onclick = () => emu('rotate'); }],
  ];

  function show(i) {
    [...$('nav').children].forEach((c, k) => c.classList.toggle('on', k === i));
    $('page').innerHTML = SECTIONS[i][2]() + '<div id="status"></div>';
    SECTIONS[i][3] && SECTIONS[i][3]();
    if (i === 0) { vs.postMessage({ type: 'display' }); }
  }
  $('nav').innerHTML = SECTIONS.map((s) => `<div><span class="codicon codicon-${s[1]}"></span>${s[0]}</div>`).join('');
  [...$('nav').children].forEach((c, i) => { c.onclick = () => show(i); });
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'result' && $('status')) { $('status').textContent = m.text; }
    if (m.type === 'display' && $('dsize')) { $('dsize').textContent = m.size.replace(/.*: /, ''); $('ddens').textContent = m.dens.replace(/.*: /, '') + ' dpi'; }
  });
  show(0);
})();
