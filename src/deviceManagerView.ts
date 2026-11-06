import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Avd, Device, adb, listAvds, listDevices, sdkRoot } from './sdk';

interface Row {
  id: string; name: string; sub: string; api: string; type: 'Virtual' | 'Physical'; running: boolean; startable: boolean;
}

const RELEASE: Record<number, string> = { 26: '8.0', 27: '8.1', 28: '9', 29: '10', 30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15' };
const CODENAME: Record<number, string> = { 33: 'Tiramisu', 34: 'UpsideDownCake', 35: 'VanillaIceCream', 36: 'Baklava', 37: 'CinnamonBun' };

function androidLabel(api: number): string {
  const rel = RELEASE[api] ?? (api >= 36 ? `${api - 20}.0` : `API ${api}`);
  const code = CODENAME[api];
  return `Android ${rel}${code ? ` ("${code}")` : ''}`;
}

function describeAvd(a: Avd): { sub: string; api: string } {
  const c = a.config;
  const dir = c['image.sysdir.1'] ?? '';
  const parts = dir.split('/').filter(Boolean);
  const abi = c['abi.type'] ?? parts[parts.length - 1] ?? '';
  let api = (parts[1] ?? '').replace(/^android-/, '');
  try {
    const props = fs.readFileSync(path.join(sdkRoot(), dir, 'source.properties'), 'utf8');
    api = /AndroidVersion\.ApiLevel=(.+)/.exec(props)?.[1].trim() ?? api;
  } catch { /* image not installed */ }
  const n = parseInt(api, 10);
  return { api, sub: [Number.isNaN(n) ? '' : androidLabel(n), abi].filter(Boolean).join(' | ') };
}

export class DeviceManagerView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private timer?: NodeJS.Timeout;
  private nodes = new Map<string, any>();
  private sig = '';
  private props = new Map<string, { api: string; sub: string }>();

  constructor(private extPath: string) {}

  private icons() {
    const out: Record<string, string> = {};
    for (const n of ['virtual-light', 'virtual-dark', 'physical-light', 'physical-dark', 'run', 'stop', 'pair-over-wifi']) {
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
    const csp = `default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src ${w.cspSource}; font-src ${w.cspSource};`;
    const u = (...p: string[]) => w.asWebviewUri(vscode.Uri.joinPath(media, ...p));
    w.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${w.asWebviewUri(vscode.Uri.joinPath(codicons, 'codicon.css'))}">
<link rel="stylesheet" href="${u('devicemanager', 'main.css')}"></head><body>
<div id="bar"></div><div id="head"></div><div id="list"></div>
<script src="${u('devicemanager', 'main.js')}"></script></body></html>`;
    w.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidChangeVisibility(() => { if (view.visible) { this.startPolling(); } else { this.stopPolling(); } });
    view.onDidDispose(() => { this.stopPolling(); this.view = undefined; });
  }

  private onMessage(m: any) {
    switch (m.type) {
      case 'ready': this.post({ type: 'init', icons: this.icons() }); this.sig = ''; this.startPolling(); break;
      case 'cmd': vscode.commands.executeCommand(m.cmd, m.id ? this.nodes.get(m.id) : undefined); break;
    }
  }

  private post(m: any) { this.view?.webview.postMessage(m); }

  private startPolling() {
    this.stopPolling();
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 3000);
  }
  private stopPolling() { if (this.timer) { clearInterval(this.timer); this.timer = undefined; } }

  private async physicalInfo(serial: string) {
    let p = this.props.get(serial);
    if (!p) {
      try {
        const rel = (await adb(serial, 'shell', 'getprop', 'ro.build.version.release')).trim();
        const api = (await adb(serial, 'shell', 'getprop', 'ro.build.version.sdk')).trim();
        const abi = (await adb(serial, 'shell', 'getprop', 'ro.product.cpu.abi')).trim();
        p = { api, sub: [`Android ${rel}`, abi].filter(Boolean).join(' | ') };
        this.props.set(serial, p);
      } catch { p = { api: '', sub: serial }; }
    }
    return p;
  }

  async refresh() {
    if (!this.view) { return; }
    let devices: Device[] = [];
    try { devices = await listDevices(); } catch { /* adb unavailable */ }
    const rows: Row[] = [];
    const nodes = new Map<string, any>();
    for (const avd of listAvds()) {
      const running = devices.find((d) => d.avdName === avd.name);
      const { sub, api } = describeAvd(avd);
      const id = 'avd:' + avd.name;
      nodes.set(id, { kind: 'avd', avd, running });
      rows.push({ id, name: avd.config['avd.ini.displayname'] || avd.name.replace(/_/g, ' '), sub, api, type: 'Virtual', running: !!running, startable: true });
    }
    for (const d of devices.filter((x) => !x.serial.startsWith('emulator-') && x.state === 'device')) {
      const info = await this.physicalInfo(d.serial);
      nodes.set('dev:' + d.serial, d);
      rows.push({ id: 'dev:' + d.serial, name: d.model || d.serial, sub: info.sub, api: info.api, type: 'Physical', running: true, startable: false });
    }
    this.nodes = nodes;
    const sig = JSON.stringify(rows);
    if (sig !== this.sig) { this.sig = sig; this.post({ type: 'rows', rows }); }
  }
}
