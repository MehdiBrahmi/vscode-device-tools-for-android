import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChildProcess, spawn } from 'child_process';
import { Device, adb, adbPath, listDevices, sdkRoot } from './sdk';

const LINE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEAF])\s+(.*?)\s*:\s?(.*)$/;

interface Item { ts: string; pid: number; tid: number; lv: string; tag: string; pkg: string; msg: string; rx: number; }

export class LogcatView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private serial?: string;
  private proc?: ChildProcess;
  private gen = 0;
  private queue: Item[] = [];
  private timer?: NodeJS.Timeout;
  private poll?: NodeJS.Timeout;
  private pkgs = new Map<number, string>();
  private missing = new Set<number>();
  private lastPs = 0;
  private psBusy = false;
  private devices: Device[] = [];

  constructor(private extPath: string) {}

  private icons() {
    const out: Record<string, string> = {};
    for (const n of ['logcat', 'wrap-text', 'filter-history', 'favorite', 'favorite-filled', 'screenshot', 'record', ...['delete', 'pause', 'refresh', 'scroll-end', 'up', 'down', 'softwrap'].map((x) => `lc-${x}`)]) {
      out[n] = fs.readFileSync(path.join(this.extPath, 'media', 'icons', `${n}.svg`), 'utf8');
    }
    return out;
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.file(path.join(this.extPath, 'media'));
    const codicons = vscode.Uri.file(path.join(this.extPath, 'media', 'codicons'));
    const w = view.webview;
    w.options = { enableScripts: true, localResourceRoots: [media, codicons] };
    const u = (...p: string[]) => w.asWebviewUri(vscode.Uri.joinPath(media, ...p));
    const csp = `default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src ${w.cspSource}; font-src ${w.cspSource};`;
    w.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${w.asWebviewUri(vscode.Uri.joinPath(codicons, 'codicon.css'))}">
<link rel="stylesheet" href="${u('logcat', 'main.css')}"></head><body>
<div id="header"><select id="dev" title="Device"></select><select id="fmt" title="Format"><option value="standard">Standard</option><option value="compact">Compact</option></select>
<div id="filterbox"><button class="ib" id="hist-btn" title="Filter history"></button><div id="editor"><div id="hl"></div><input id="q" spellcheck="false" placeholder="Filter, e.g. tag:foo level:warn -message:bar"></div><button class="ib" id="fav" title="Favorite"></button></div>
<span id="count"></span></div>
<div id="main"><div id="side"></div><div id="sc"><div id="spacer"></div><div id="win"></div><div id="empty"></div><div id="status"></div></div></div>
<script src="${u('logcat', 'filter.js')}"></script><script src="${u('logcat', 'main.js')}"></script></body></html>`;
    w.onDidReceiveMessage((m) => this.onMessage(m).catch(() => {}));
    view.onDidChangeVisibility(() => { if (view.visible) { this.startPolling(); } else { this.stopPolling(); this.stopStream(); } });
    view.onDidDispose(() => { this.stopPolling(); this.stopStream(); this.view = undefined; });
  }

  async show(d?: { serial: string }) {
    if (d?.serial) { this.serial = d.serial; }
    await vscode.commands.executeCommand('android.logcat.focus');
    if (d?.serial && this.view) { this.start(); this.post({ type: 'devices', list: this.devices, serial: this.serial }); }
  }

  private post(m: any) { this.view?.webview.postMessage(m); }

  private async onMessage(m: any) {
    switch (m.type) {
      case 'ready':
        this.post({ type: 'init', icons: this.icons(), mine: await this.mine(), max: vscode.workspace.getConfiguration('android').get('logcat.maxEntries', 50000) });
        this.startPolling();
        break;
      case 'select': this.serial = m.serial; this.start(); break;
      case 'clear': if (this.serial) { await adb(this.serial, 'logcat', '-c').catch(() => {}); } break;
      case 'restart': this.start(); break;
      case 'screenshot': if (this.serial) { vscode.commands.executeCommand('android.screenshot', { serial: this.serial }); } break;
      case 'record': if (this.serial) { vscode.commands.executeCommand('android.screenRecord', { serial: this.serial }); } break;
      case 'copy': await vscode.env.clipboard.writeText(m.text); break;
    }
  }

  private startPolling() {
    this.stopPolling();
    const tick = async () => {
      try { this.devices = (await listDevices()).filter((d) => d.state === 'device'); } catch { this.devices = []; }
      if (!this.devices.some((d) => d.serial === this.serial)) {
        const was = this.serial;
        this.serial = this.devices[0]?.serial;
        if (was !== this.serial) { this.stopStream(); }
      }
      this.post({ type: 'devices', list: this.devices, serial: this.serial });
      if (this.serial && !this.proc) { this.start(); }
    };
    tick();
    this.poll = setInterval(tick, 3000);
  }

  private stopPolling() { if (this.poll) { clearInterval(this.poll); this.poll = undefined; } }

  private stopStream() {
    this.gen++;
    this.proc?.kill();
    this.proc = undefined;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.queue = [];
  }

  private start() {
    this.stopStream();
    const serial = this.serial;
    if (!serial || !this.view) { return; }
    const gen = this.gen;
    this.pkgs.clear(); this.missing.clear(); this.lastPs = 0;
    this.post({ type: 'reset' });
    const proc = spawn(adbPath(), ['-s', serial, 'logcat', '-v', 'threadtime', '-v', 'year', '-T', '1000'], { env: { ...process.env, ANDROID_HOME: sdkRoot() } });
    this.proc = proc;
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      if (gen !== this.gen) { return; }
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      const now = Date.now();
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        const m = LINE.exec(line);
        if (!m) { continue; }
        const pid = +m[2];
        this.queue.push({ ts: m[1], pid, tid: +m[3], lv: m[4] === 'F' ? 'A' : m[4], tag: m[5], pkg: this.pkgs.get(pid) ?? '', msg: m[6], rx: now });
      }
    });
    proc.on('exit', () => {
      if (gen !== this.gen) { return; }
      this.flush();
      this.proc = undefined;
      this.post({ type: 'status', text: 'Log stream ended' });
    });
    this.timer = setInterval(() => this.flush(), 60);
  }

  private flush() {
    if (!this.queue.length) { return; }
    const items = this.queue;
    this.queue = [];
    if (items.some((i) => !i.pkg && !this.missing.has(i.pid))) { this.refreshPs(); }
    this.post({ type: 'batch', items });
    // late package resolution: tell the webview which pids are now known
  }

  private async refreshPs() {
    const serial = this.serial;
    if (!serial || this.psBusy || Date.now() - this.lastPs < 1500) { return; }
    this.psBusy = true; this.lastPs = Date.now();
    try {
      const out = await adb(serial, 'shell', 'ps', '-A', '-o', 'PID,NAME');
      const map: Record<number, string> = {};
      for (const l of out.split('\n').slice(1)) {
        const m = /^\s*(\d+)\s+(\S+)/.exec(l);
        if (m) { const name = m[2].split(':')[0]; this.pkgs.set(+m[1], name); map[+m[1]] = name; }
      }
      if (serial === this.serial) { this.post({ type: 'pkgs', map }); }
    } catch { /* ignore */ } finally { this.psBusy = false; }
  }

  private async mine(): Promise<string[]> {
    const ids = new Set<string>();
    try {
      const files = await vscode.workspace.findFiles('**/{build.gradle,build.gradle.kts}', '**/{node_modules,build,.git}/**', 30);
      for (const f of files) {
        const txt = fs.readFileSync(f.fsPath, 'utf8');
        for (const m of txt.matchAll(/(?:applicationId|namespace)\s*(?:=)?\s*["']([\w.]+)["']/g)) { ids.add(m[1]); }
      }
    } catch { /* ignore */ }
    return [...ids];
  }
}
