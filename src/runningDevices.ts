import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ChildProcess, spawn } from 'child_process';
import { Device, adb, sdkRoot, adbPath, grpcPortFor, grpcTokenFor, listDevices, runBuffer } from './sdk';
import { EmulatorSession, grpcSupported } from './emulatorGrpc';
import { ScrcpySession, bundledJar } from './scrcpy';
import { Skin, skinForAvd } from './skin';

type Mode = 'emulator' | 'scrcpy' | 'screencap';

export class RunningDeviceView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private serial?: string;
  private forced?: Mode; // set after a failure to skip a mode that does not work
  private session?: ScrcpySession;
  private emu?: EmulatorSession;
  private inflight = false;
  private pending?: { w: number; h: number; data: Uint8Array };
  private viewport = { w: 1080, h: 2200 };
  private generation = 0;
  private capturing = false;
  private loop?: NodeJS.Timeout;
  private size = { w: 0, h: 0 };
  private skin?: Skin;

  private rec?: { proc: ChildProcess; serial: string; stopping: boolean };

  constructor(private extPath: string) {}

  private icons(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const n of ['back', 'home', 'overview', 'power', 'volume-up', 'volume-down', 'rotate', 'screenshot', 'record', 'rotate-left', 'rotate-right', 'virtual-dark', 'virtual-light', 'physical-dark', 'physical-light']) {
      out[n] = fs.readFileSync(path.join(this.extPath, 'media', 'icons', `${n}.svg`), 'utf8');
    }
    return out;
  }

  async toggleRecording(serial: string) {
    if (this.rec) {
      this.rec.stopping = true;
      // SIGINT lets screenrecord finalize the mp4
      await adb(this.rec.serial, 'shell', 'pkill', '-2', 'screenrecord').catch(() => adb(this.rec!.serial, 'shell', 'killall', '-2', 'screenrecord'));
      return;
    }
    const remote = `/sdcard/vscode-rec-${Date.now()}.mp4`;
    const proc = spawn(adbPath(), ['-s', serial, 'shell', 'screenrecord', '--bit-rate', '8000000', '--time-limit', '180', remote], { env: { ...process.env, ANDROID_HOME: sdkRoot() } });
    this.rec = { proc, serial, stopping: false };
    this.post({ type: 'recording', on: true });
    proc.on('exit', async () => {
      this.rec = undefined;
      this.post({ type: 'recording', on: false });
      try {
        await new Promise((r) => setTimeout(r, 500));
        const tmp = path.join(os.tmpdir(), path.basename(remote));
        await adb(serial, 'pull', remote, tmp);
        const uri = await vscode.window.showSaveDialog({ filters: { MP4: ['mp4'] }, defaultUri: vscode.Uri.file(path.join(os.homedir(), `recording-${Date.now()}.mp4`)) });
        if (uri) { await vscode.workspace.fs.copy(vscode.Uri.file(tmp), uri, { overwrite: true }); }
        fs.rmSync(tmp, { force: true });
      } catch (e: any) {
        vscode.window.showErrorMessage(`Screen recording failed: ${e.message}`);
      } finally { adb(serial, 'shell', 'rm', '-f', remote).catch(() => {}); }
    });
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.file(path.join(this.extPath, 'media', 'codicons'));
    view.webview.options = { enableScripts: true, localResourceRoots: [media, vscode.Uri.file(path.join(this.extPath, 'media', 'icons'))] };
    const art = (n: string) => view.webview.asWebviewUri(vscode.Uri.file(path.join(this.extPath, 'media', 'icons', n))).toString();
    view.webview.html = html(view.webview, view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'codicon.css')), this.icons(), { dark: art('devices-lineup-dark.png'), light: art('devices-lineup-light.png') });
    view.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => this.post({ type: 'error', text: e.message })));
    view.onDidChangeVisibility(() => this.restart());
    view.onDidDispose(() => this.stop());
  }

  async show(d?: Device) {
    if (d) { this.serial = d.serial; }
    await vscode.commands.executeCommand('android.runningDevice.focus');
    this.post({ type: 'select', serial: this.serial });
    this.restart();
  }

  mirroredSerial(): string | undefined {
    return this.view?.visible && (this.session || this.emu || this.loop) ? this.serial : undefined;
  }

  stopMirroring() {
    this.stop();
    this.post({ type: 'error', text: 'Mirroring stopped. Select a device or refresh to resume.' });
  }

  private post(m: unknown) { this.view?.webview.postMessage(m); }

  private stop() {
    this.generation++;
    if (this.loop) { clearInterval(this.loop); this.loop = undefined; }
    this.session?.stop();
    this.session = undefined;
    this.emu?.stop();
    this.emu = undefined;
    this.pending = undefined;
    this.inflight = false;
  }

  private async restart() {
    this.stop();
    if (!this.view?.visible) { return; }
    await this.refreshDevices();
    if (!this.serial) { return; }
    const mode = this.pickMode(this.serial);
    if (mode === 'emulator') { await this.startEmulator(this.serial); }
    else if (mode === 'scrcpy') { await this.startScrcpy(); }
    else { this.startScreencap(); }
  }

  private pickMode(serial: string): Mode {
    const order: Mode[] = ['emulator', 'scrcpy', 'screencap'];
    const usable = (m: Mode) => m === 'screencap' || m === 'scrcpy' || (grpcSupported() && grpcPortFor(serial) !== undefined);
    const start = this.forced ? order.indexOf(this.forced) : 0;
    return order.slice(start).find(usable)!;
  }

  private async startEmulator(serial: string) {
    const gen = this.generation;
    this.post({ type: 'mode', mode: 'emulator' });
    const emu = new EmulatorSession(grpcPortFor(serial)!, {
      onFrame: (f) => {
        if (gen !== this.generation) { return; }
        this.pending = { w: f.w, h: f.h, data: new Uint8Array(f.rgba.buffer, f.rgba.byteOffset, f.rgba.length) };
        this.flush();
      },
      onClose: (reason) => {
        if (gen !== this.generation) { return; }
        if (reason) { this.fallback('scrcpy', `Emulator stream stopped (${reason}); switching to scrcpy`); }
      },
    }, this.viewport, grpcTokenFor(serial));
    this.emu = emu;
    try { await emu.start(); } catch (e: any) {
      if (gen === this.generation) { this.fallback('scrcpy', `Emulator gRPC failed (${e.message}); switching to scrcpy`); }
    }
  }

  // Only one frame in flight: the webview acks each frame, newer frames replace the pending one.
  private flush() {
    if (this.inflight || !this.pending) { return; }
    const f = this.pending;
    this.pending = undefined;
    this.inflight = true;
    this.post({ type: 'rgba', ...f });
  }

  private async startScrcpy() {
    const gen = this.generation;
    const serial = this.serial!;
    this.post({ type: 'mode', mode: 'scrcpy' });
    const session = new ScrcpySession(serial, bundledJar(this.extPath), {
      onPacket: (kind, data) => { if (gen === this.generation) { this.post({ type: 'video', kind, data: new Uint8Array(data) }); } },
      onClose: (reason) => {
        if (gen !== this.generation) { return; }
        this.session = undefined;
        if (reason) { this.post({ type: 'error', text: `Stream stopped: ${reason}` }); }
      },
    });
    this.session = session;
    try {
      await session.start();
    } catch (e: any) {
      if (gen !== this.generation) { return; }
      this.fallback('screencap', `scrcpy failed (${e.message}); using screenshot mode`);
    }
  }

  private fallback(mode: Mode, reason: string) {
    this.stop();
    this.forced = mode;
    this.post({ type: 'error', text: reason });
    this.restart().then(() => this.post({ type: 'error', text: reason }));
  }

  private startScreencap() {
    this.post({ type: 'mode', mode: 'screencap' });
    const every = vscode.workspace.getConfiguration('android').get<number>('mirrorIntervalMs', 150);
    this.loop = setInterval(() => this.capture(), every);
  }

  private async refreshDevices() {
    const devs = (await listDevices()).filter((d) => d.state === 'device');
    if (!this.serial || !devs.some((d) => d.serial === this.serial)) { this.serial = devs[0]?.serial; }
    this.post({ type: 'devices', devices: devs.map((d) => ({ serial: d.serial, label: d.name || d.avdName || d.model || d.serial, physical: !d.serial.startsWith('emulator-') })), serial: this.serial });
    this.skin = skinForAvd(devs.find((d) => d.serial === this.serial)?.avdName);
    this.post({ type: 'skin', skin: this.skin ? this.skinPayload(this.skin) : null });
  }

  private skinPayload(k: Skin) {
    const url = (f?: string) => (f ? `data:image/${path.extname(f).slice(1)};base64,${fs.readFileSync(f).toString('base64')}` : '');
    return { back: url(k.back), mask: url(k.mask), lw: k.lw, lh: k.lh, dx: k.dx, dy: k.dy, dw: k.dw, dh: k.dh, radius: k.radius };
  }

  private async capture() {
    if (this.capturing || !this.serial) { return; }
    this.capturing = true;
    try {
      const png = await runBuffer(adbPath(), ['-s', this.serial, 'exec-out', 'screencap', '-p']);
      if (png.length > 24 && png.readUInt32BE(12) === 0x49484452) { // IHDR
        this.size = { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
      }
      this.post({ type: 'frame', data: png.toString('base64'), ...this.size });
    } catch (e: any) {
      this.post({ type: 'error', text: e.message });
      this.refreshDevices();
    } finally { this.capturing = false; }
  }

  private async onMessage(m: any) {
    const s = this.serial;
    switch (m.type) {
      case 'ready': return this.restart();
      case 'select': this.serial = m.serial; this.forced = undefined; return this.restart();
      case 'refresh': this.forced = undefined; return this.restart();
      case 'ext': if (s) { vscode.commands.executeCommand('android.extendedControls', { serial: s }); } return;
      case 'logcat': if (s) { vscode.commands.executeCommand('android.showLogcat', { serial: s }); } return;
      case 'reboot': if (s) { return this.reboot(s); } return;
      case 'openDM': vscode.commands.executeCommand('android.deviceManager.focus'); return;
      case 'viewport': this.viewport = { w: Math.max(200, m.w), h: Math.max(200, m.h) }; this.emu?.setViewport(this.viewport); return;
      case 'ack': this.inflight = false; return this.flush();
      case 'rotate': if (this.emu) { this.emu.rotate(m.dir); return; } if (s) { return this.rotate(s, m.dir); } return;
      case 'record': if (s) { return this.toggleRecording(s); } return;
      case 'noDecoder': return this.fallback('screencap', 'Video decoding unavailable in this VS Code; using screenshot mode');
      case 'decodeError': return this.fallback('screencap', `Decoder error: ${m.text}; using screenshot mode`);
      default: if (!s) { return; }
    }
    if (this.emu) { return this.onEmulatorInput(this.emu, m, s); }
    if (this.session) { return this.onScrcpyInput(this.session, m, s); }

    const x = Math.round(m.x * this.size.w), y = Math.round(m.y * this.size.h);
    switch (m.type) {
      case 'tap': await adb(s, 'shell', 'input', 'tap', `${x}`, `${y}`); break;
      case 'swipe': {
        const x2 = Math.round(m.x2 * this.size.w), y2 = Math.round(m.y2 * this.size.h);
        await adb(s, 'shell', 'input', 'swipe', `${x}`, `${y}`, `${x2}`, `${y2}`, `${Math.max(50, Math.min(m.ms, 2000))}`);
        break;
      }
      case 'key': await adb(s, 'shell', 'input', 'keyevent', String(m.code)); break;
      case 'text': await adb(s, 'shell', 'input', 'text', String(m.text).replace(/ /g, '%s').replace(/[^\w%@.,:/+-]/g, '')); break;
      case 'screenshot': return this.screenshot(s);
    }
  }

  private async onEmulatorInput(emu: EmulatorSession, m: any, serial: string) {
    switch (m.type) {
      case 'touch': emu.touch(m.action, m.x, m.y, m.w, m.h); break;
      case 'scroll': emu.swipe(m.x, m.y, m.x, Math.min(0.95, Math.max(0.05, m.y + m.v * 0.25)), m.w, m.h, 120); break;
      case 'text': emu.key(String(m.text)); break;
      case 'key': await adb(serial, 'shell', 'input', 'keyevent', String(m.code)); break;
      case 'screenshot': return this.screenshot(serial);
    }
  }

  private async onScrcpyInput(sess: ScrcpySession, m: any, serial: string) {
    switch (m.type) {
      case 'touch': sess.touch(m.action, m.x * m.w, m.y * m.h, m.w, m.h); break;
      case 'scroll': sess.scroll(m.x * m.w, m.y * m.h, m.w, m.h, m.v); break;
      case 'key': sess.key(Number(m.code)); break;
      case 'text': sess.text(String(m.text)); break;
      case 'screenshot': return this.screenshot(serial);
    }
  }

  private async reboot(serial: string) {
    this.post({ type: 'error', text: 'Restarting device…' });
    await adb(serial, 'reboot');
    this.stop();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if ((await listDevices()).some((d) => d.serial === serial && d.state === 'device') && (await adb(serial, 'shell', 'getprop', 'sys.boot_completed').catch(() => '')).trim() === '1') {
        this.forced = undefined;
        return this.restart();
      }
    }
  }

  private async rotate(serial: string, dir: number) {
    const cur = parseInt((await adb(serial, 'shell', 'settings', 'get', 'system', 'user_rotation')).trim(), 10) || 0;
    const step = dir < 0 ? 3 : 1;
    let n = (cur + step) % 4;
    if (n === 2) { n = (n + step) % 4; } // phones ignore 180°, which would make the click look dead
    const next = String(n);
    await adb(serial, 'shell', 'cmd', 'window', 'user-rotation', 'lock', next).catch(async () => {
      await adb(serial, 'shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
      await adb(serial, 'shell', 'settings', 'put', 'system', 'user_rotation', next);
    });
  }

  async screenshot(serial: string) {
    const png = await runBuffer(adbPath(), ['-s', serial, 'exec-out', 'screencap', '-p']);
    let out: Buffer = png;
    if (this.skin && this.view && this.serial === serial) {
      const pick = await vscode.window.showQuickPick(
        [{ label: 'Rectangular', id: 'rect' }, { label: 'Display Shape', id: 'shape' }, { label: 'Show Device Frame', id: 'frame' }],
        { placeHolder: 'Screenshot type' });
      if (!pick) { return; }
      if (pick.id !== 'rect') {
        const composed = await this.compose(pick.id, png);
        if (composed) { out = composed; }
      }
    }
    const uri = await vscode.window.showSaveDialog({ filters: { PNG: ['png'] }, defaultUri: vscode.Uri.file(`${process.env.HOME}/screenshot-${Date.now()}.png`) });
    if (uri) { await vscode.workspace.fs.writeFile(uri, out); }
  }

  // The webview has a canvas, so it does the compositing (frame / rounded display).
  private compose(mode: string, png: Buffer): Promise<Buffer | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { sub.dispose(); resolve(undefined); }, 15000);
      const sub = this.view!.webview.onDidReceiveMessage((m) => {
        if (m.type !== 'composed') { return; }
        clearTimeout(timer); sub.dispose();
        resolve(m.data ? Buffer.from(m.data, 'base64') : undefined);
      });
      this.post({ type: 'compose', mode, png: png.toString('base64') });
    });
  }
}

function html(webview: vscode.Webview, codicons: vscode.Uri, icons: Record<string, string>, art: { dark: string; light: string }) {
  return /* html */ `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'unsafe-inline';">
<link rel="stylesheet" href="${codicons}"><style>
body{margin:0;padding:0;gap:0;font-family:var(--vscode-font-family);color:var(--vscode-foreground);display:flex;flex-direction:column;align-items:center;gap:6px;height:100vh;box-sizing:border-box}
#tabs{display:flex;width:100%;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border,#444);box-sizing:border-box}
#tab{position:relative;display:flex;align-items:center;gap:8px;padding:4px 10px;border:1px solid var(--vscode-focusBorder,#3574f0);background:var(--vscode-list-inactiveSelectionBackground,#2e436e);border-radius:6px;max-width:100%}
#tab svg{width:18px;height:18px}
#tab .dot{position:absolute;left:24px;bottom:5px;width:6px;height:6px;border-radius:50%;background:#57965c}
#chev{display:none;pointer-events:none;font-size:14px;opacity:.8}
#tab.multi #chev{display:block}
#tab.multi select{padding-right:0}
#tab select{background:transparent;border:0;color:inherit;font-size:14px;appearance:none;-webkit-appearance:none;outline:0;cursor:pointer;padding:0 4px;text-overflow:ellipsis;max-width:320px}
.dk,.lt{display:none}body:not(.vscode-light) .dk{display:flex}body.vscode-light .lt{display:flex}
#bar{display:flex;gap:2px;flex-wrap:wrap;width:100%;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border,#444);box-sizing:border-box;align-items:center}
button{background:transparent;color:var(--vscode-icon-foreground);border:0;width:30px;height:30px;padding:0;cursor:pointer;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;font-size:16px}
button:hover{background:var(--vscode-toolbar-hoverBackground)}
button svg{width:20px;height:20px}
#rec.on{background:#db3b4b33}
#timer{font-size:11px;color:#db3b4b;align-self:center}
.sep{width:1px;height:22px;background:var(--vscode-panel-border,#555);margin:0 6px}
#wrap{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;width:100%;padding:8px;box-sizing:border-box}
#screen,#cv{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;cursor:default;user-select:none;outline:none}
#screen{display:none}
#frame{display:contents}
#bk,#fg{display:none}
#frame.skin{display:block;position:relative;flex:none}
#frame.skin #bk,#frame.skin #fg{display:block;position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}
#frame.skin #cv,#frame.skin #screen{position:absolute;max-width:none;max-height:none;border-radius:0;object-fit:fill}
#menu{display:none;position:fixed;z-index:10;background:var(--vscode-menu-background);color:var(--vscode-menu-foreground);border:1px solid var(--vscode-menu-border,#555);border-radius:4px;padding:4px 0;min-width:160px;box-shadow:0 2px 8px #0008;font-size:12px}
#menu div{padding:4px 14px;cursor:pointer}#menu div:hover{background:var(--vscode-menu-selectionBackground);color:var(--vscode-menu-selectionForeground)}
#msg{font-size:11px;opacity:.7;padding:2px 8px}
#empty{display:none;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:24px;padding:16px 24px;text-align:center;opacity:.9;font-size:13px;line-height:1.6;color:var(--vscode-descriptionForeground)}
#empty img{width:225px;height:150px}
#empty a{color:var(--vscode-textLink-foreground);cursor:pointer;text-decoration:none}#empty a:hover{text-decoration:underline}
body.empty #tabs,body.empty #bar,body.empty #wrap,body.empty #msg{display:none}
body.empty #empty{display:flex}
</style></head><body class="empty">
<div id="tabs"><div id="tab"><span class="dk" id="tic-d">${icons['virtual-dark']}</span><span class="lt" id="tic-l">${icons['virtual-light']}</span><i class="dot" id="tdot"></i><select id="dev"></select><i class="codicon codicon-chevron-down" id="chev"></i></div></div>
<div id="bar">
<button data-k="26" title="Power">${icons['power']}</button>
<button data-k="24" title="Volume up">${icons['volume-up']}</button>
<button data-k="25" title="Volume down">${icons['volume-down']}</button><span class="sep"></span>
<button id="rotl" title="Rotate left">${icons['rotate-left']}</button>
<button id="rotr" title="Rotate right">${icons['rotate-right']}</button><span class="sep"></span>
<button data-k="4" title="Back">${icons['back']}</button>
<button data-k="3" title="Home">${icons['home']}</button>
<button data-k="187" title="Overview">${icons['overview']}</button><span class="sep"></span>
<button id="shot" title="Take screenshot">${icons['screenshot']}</button>
<button id="rec" title="Record screen">${icons['record']}</button><span id="timer"></span><span class="sep"></span>
<button id="ref" title="Restart device"><i class="codicon codicon-debug-restart"></i></button>
<button id="more" title="More"><i class="codicon codicon-kebab-vertical"></i></button></div>
<div id="menu"><div id="m-frame">Show Device Frame</div><div id="m-ext">Extended Controls</div><div id="m-log">Show Logcat</div></div>
<div id="empty"><img class="dk" src="${art.dark}" alt=""><img class="lt" src="${art.light}" alt="">
<div>To mirror a physical device, connect it via USB cable or over Wi-Fi.<br>To launch a virtual device, start one from the <a id="open-dm">Device Manager</a>.</div></div>
<div id="wrap"><div id="frame"><img id="screen" tabindex="0" draggable="false"><canvas id="cv" tabindex="0"></canvas><img id="bk" draggable="false" alt=""><img id="fg" draggable="false" alt=""></div></div><div id="msg">No device</div>
<script>
const vs=acquireVsCodeApi(),img=document.getElementById('screen'),cv=document.getElementById('cv'),dev=document.getElementById('dev'),msg=document.getElementById('msg');
const ctx=cv.getContext('2d');let tm;
const send=m=>vs.postMessage(m);
let mode='emulator',target=cv,fw=0,fh=0;
document.getElementById('open-dm').onclick=()=>send({type:'openDM'});
const frame=document.getElementById('frame'),bk=document.getElementById('bk'),fg=document.getElementById('fg'),wrapEl=document.getElementById('wrap');
let skin=null,frameOn=(vs.getState()||{}).frame!==false,skinOn=false,fScale=1;
const place=(el,x,y,w,h)=>{el.style.setProperty('left',x*100+'%','important');el.style.setProperty('top',y*100+'%','important');el.style.setProperty('width',w*100+'%','important');el.style.setProperty('height',h*100+'%','important')};
function layout(){
 const r=wrapEl.getBoundingClientRect(),W=r.width-16,H=r.height-16;
 const on=!!skin&&frameOn&&!(fw&&fh&&fw>fh);
 if(on!==skinOn||on){skinOn=on;frame.classList.toggle('skin',on)}
 if(!on){for(const el of[cv,img])for(const k of['left','top','width','height','border-radius'])el.style.removeProperty(k);
  if(mode==='emulator'&&cv.width){const k=devicePixelRatio||1;cv.style.width=cv.width/k+'px';cv.style.height=cv.height/k+'px'}
  return W>0&&H>0?{w:W,h:H}:null}
 fScale=Math.max(0.01,Math.min(W/skin.lw,H/skin.lh));
 frame.style.width=skin.lw*fScale+'px';frame.style.height=skin.lh*fScale+'px';
 const f=[skin.dx/skin.lw,skin.dy/skin.lh,skin.dw/skin.lw,skin.dh/skin.lh];
 place(cv,...f);place(img,...f);place(fg,...f);for(const el of[cv,img])el.style.setProperty('border-radius',(skin.radius/skin.dw*100)+'% / '+(skin.radius/skin.dh*100)+'%','important');
 return{w:skin.dw*fScale,h:skin.dh*fScale};
}
let vpT;const sendVp=()=>{const s=layout(),d=devicePixelRatio||1;if(s)send({type:'viewport',w:Math.round(s.w*d),h:Math.round(s.h*d)})};
new ResizeObserver(()=>{layout();clearTimeout(vpT);vpT=setTimeout(sendVp,250)}).observe(wrapEl);
function setSkin(k){skin=k;if(k){bk.src=k.back;fg.src=k.mask||''}fg.style.visibility=k&&k.mask?'visible':'hidden';sendVp()}
document.getElementById('m-frame').onclick=()=>{frameOn=!frameOn;vs.setState({frame:frameOn});sendVp()};
const loadImg=u=>new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.onerror=()=>r(null);i.src=u});
async function compose(m){
 try{
  const shot=await loadImg('data:image/png;base64,'+m.png);if(!shot||!skin)throw 0;
  const s=shot.width/skin.dw,c=document.createElement('canvas'),x=c.getContext('2d');
  if(m.mode==='frame'){
   c.width=Math.round(skin.lw*s);c.height=Math.round(skin.lh*s);
   x.save();x.beginPath();x.roundRect(skin.dx*s,skin.dy*s,skin.dw*s,skin.dh*s,skin.radius*s);x.clip();
   x.drawImage(shot,skin.dx*s,skin.dy*s,skin.dw*s,skin.dh*s);x.restore();
   const b=await loadImg(skin.back);if(b)x.drawImage(b,0,0,c.width,c.height);
   if(skin.mask){const k=await loadImg(skin.mask);if(k)x.drawImage(k,skin.dx*s,skin.dy*s,skin.dw*s,skin.dh*s)}
  }else{
   c.width=shot.width;c.height=shot.height;
   x.drawImage(shot,0,0);const k=skin.mask&&await loadImg(skin.mask);
   if(k){x.globalCompositeOperation='destination-out';x.drawImage(k,0,0,c.width,c.height)}
   else{x.clearRect(0,0,c.width,c.height);x.beginPath();x.roundRect(0,0,c.width,c.height,skin.radius*s);x.clip();x.drawImage(shot,0,0)}
  }
  send({type:'composed',data:c.toDataURL('image/png').split(',')[1]});
 }catch(e){send({type:'composed'})}
}
dev.onchange=()=>send({type:'select',serial:dev.value});
document.querySelectorAll('[data-k]').forEach(b=>b.onclick=()=>send({type:'key',code:b.dataset.k}));
rec.onclick=()=>send({type:'record'});rotl.onclick=()=>send({type:'rotate',dir:-1});rotr.onclick=()=>send({type:'rotate',dir:1});shot.onclick=()=>send({type:'screenshot'});ref.onclick=()=>send({type:'reboot'});
more.onclick=e=>{const r=more.getBoundingClientRect();menu.style.left=Math.max(0,r.right-160)+'px';menu.style.top=r.bottom+'px';menu.style.display='block';e.stopPropagation()};
document.addEventListener('click',()=>menu.style.display='none');
document.getElementById('m-ext').onclick=()=>send({type:'ext'});document.getElementById('m-log').onclick=()=>send({type:'logcat'});;

// ---- video decoding (scrcpy H.264 annex-B) ----
let decoder,configData,spsKey,needKey=true;
function newDecoder(){
 if(decoder&&decoder.state!=='closed')decoder.close();
 decoder=new VideoDecoder({
  output:f=>{if(cv.width!==f.displayWidth||cv.height!==f.displayHeight){cv.width=f.displayWidth;cv.height=f.displayHeight}fw=f.displayWidth;fh=f.displayHeight;ctx.drawImage(f,0,0);f.close();msg.textContent=fw+'×'+fh},
  error:e=>send({type:'decodeError',text:String(e.message||e)})});
 needKey=true;
}
function onConfig(d){
 const key=Array.from(d.slice(0,16)).join();
 configData=d;
 const i=d.findIndex((b,k)=>k>=3&&d[k-3]===0&&d[k-2]===0&&d[k-1]===1&&(b&31)===7);
 const hex=x=>x.toString(16).padStart(2,'0');
 const codec=i>=0?'avc1.'+hex(d[i+1])+hex(d[i+2])+hex(d[i+3]):'avc1.640033';
 if(key!==spsKey||!decoder||decoder.state==='closed'){spsKey=key;newDecoder();decoder.configure({codec,optimizeForLatency:true})}
}
function onVideo(kind,raw){
 const d=raw instanceof Uint8Array?raw:new Uint8Array(raw);
 if(kind==='config'){onConfig(d);return}
 if(!decoder||decoder.state!=='configured')return;
 if(needKey&&kind!=='key')return;
 let data=d;
 if(kind==='key'&&configData){data=new Uint8Array(configData.length+d.length);data.set(configData);data.set(d,configData.length)}
 if(kind==='key')needKey=false;
 if(decoder.decodeQueueSize>8&&kind!=='key')return;
 decoder.decode(new EncodedVideoChunk({type:kind==='key'?'key':'delta',timestamp:performance.now()*1000,data}));
}

// ---- input ----
const rel=e=>{const r=target.getBoundingClientRect();return{x:Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),y:Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))}};
let down=null;
function bind(el){
 el.onmousedown=e=>{e.preventDefault();el.focus();const p=rel(e);down={...p,t:Date.now()};
  if(mode!=='screencap')send({type:'touch',action:0,...p,w:fw,h:fh})};
 el.onmousemove=e=>{if(down&&mode!=='screencap'&&e.buttons)send({type:'touch',action:2,...rel(e),w:fw,h:fh})};
 const up=e=>{if(!down)return;const u=rel(e);
  if(mode!=='screencap')send({type:'touch',action:1,...u,w:fw,h:fh});
  else if(Math.hypot(u.x-down.x,u.y-down.y)<0.015)send({type:'tap',x:u.x,y:u.y});
  else send({type:'swipe',x:down.x,y:down.y,x2:u.x,y2:u.y,ms:Date.now()-down.t});
  down=null};
 el.onmouseup=up;el.onmouseleave=e=>{if(down&&mode!=='screencap')up(e)};
 el.onwheel=e=>{e.preventDefault();const p=rel(e);
  if(mode!=='screencap')send({type:'scroll',...p,w:fw,h:fh,v:-Math.sign(e.deltaY)*Math.min(1,Math.abs(e.deltaY)/100)});
  else{const s=e.deltaY>0?[.5,.65,.5,.35]:[.5,.35,.5,.65];send({type:'swipe',x:s[0],y:s[1],x2:s[2],y2:s[3],ms:200})}};
 el.onkeydown=e=>{const map={Backspace:67,Enter:66,Escape:4,ArrowUp:19,ArrowDown:20,ArrowLeft:21,ArrowRight:22,Tab:61};
  if(map[e.key]){send({type:'key',code:map[e.key]});e.preventDefault()}
  else if(e.key.length===1&&!e.metaKey&&!e.ctrlKey){send({type:'text',text:e.key});e.preventDefault()}};
}
bind(img);bind(cv);

function setMode(m){mode=m;const c=m!=='screencap';target=c?cv:img;cv.style.display=c?'block':'none';img.style.display=c?'none':'block'}
function onRgba(m){const d=m.data instanceof Uint8Array?m.data:new Uint8Array(m.data);
 if(cv.width!==m.w||cv.height!==m.h){cv.width=m.w;cv.height=m.h;const k=devicePixelRatio||1;if(!skinOn){cv.style.width=(m.w/k)+'px';cv.style.height=(m.h/k)+'px'}}const wasLand=fw>fh;fw=m.w;fh=m.h;if(skin&&(fw>fh)!==wasLand)sendVp();
 ctx.putImageData(new ImageData(new Uint8ClampedArray(d.buffer,d.byteOffset,m.w*m.h*4),m.w,m.h),0,0);
 msg.textContent=fw+'×'+fh+' · emulator';send({type:'ack'})}
addEventListener('message',({data:m})=>{
 if(m.type==='video')onVideo(m.kind,m.data);
 else if(m.type==='rgba')onRgba(m);
 else if(m.type==='recording'){rec.classList.toggle('on',m.on);rec.title=m.on?'Stop recording':'Record screen';clearInterval(tm);timer.textContent='';if(m.on){const t0=Date.now();tm=setInterval(()=>{const s=Math.floor((Date.now()-t0)/1000);timer.textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0')},500)}}
 else if(m.type==='frame'){img.src='data:image/png;base64,'+m.data;msg.textContent=m.w+'×'+m.h}
 else if(m.type==='mode'){setMode(m.mode);spsKey=undefined;if(m.mode==='scrcpy'&&typeof VideoDecoder==='undefined')send({type:'noDecoder'})}
 else if(m.type==='devices'){document.body.classList.toggle('empty',!m.devices.length);dev.innerHTML=m.devices.map(d=>'<option value="'+d.serial+'">'+d.label+(d.physical?' ('+d.serial+')':'')+'</option>').join('');if(m.serial)dev.value=m.serial;tdot.style.display=m.devices.length?'block':'none';tab.classList.toggle('multi',m.devices.length>1);
  if(!m.devices.length){msg.textContent='No device. Start an emulator or connect a phone.';img.removeAttribute('src');ctx.clearRect(0,0,cv.width,cv.height)}}
 else if(m.type==='select'){dev.value=m.serial}
 else if(m.type==='skin')setSkin(m.skin);
 else if(m.type==='compose')compose(m);
 else if(m.type==='error')msg.textContent=m.text;});
send({type:'ready'});
</script></body></html>`;
}
