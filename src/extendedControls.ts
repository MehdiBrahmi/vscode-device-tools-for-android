import * as vscode from 'vscode';
import * as path from 'path';
import { adb, grpcPortFor, grpcTokenFor } from './sdk';
import { showNativeExtendedControls } from './emulatorGrpc';

const panels = new Map<string, vscode.WebviewPanel>();

// Console commands that the webview is allowed to send (adb emu <cmd>)
const ALLOWED = /^(geo fix|power (capacity|ac|status|health|present)|network (speed|delay)|gsm (call|accept|cancel|voice|data)|sms send|finger (touch|remove)|rotate|sensor set)\b/;

export async function openExtendedControls(extPath: string, serial?: string, title?: string) {
  const port = serial ? grpcPortFor(serial) : undefined;
  if (port) {
    try { await showNativeExtendedControls(port, 'LOCATION', grpcTokenFor(serial!)); return; } catch (e: any) {
      vscode.window.showWarningMessage(`Native Extended Controls unavailable (${e.message}); showing the built-in panel.`);
    }
  }
  else if (serial) { vscode.window.showWarningMessage('Emulator gRPC port not found: restart the emulator from the Device Manager to get the native Extended Controls.'); }
  openPanel(extPath, serial, title);
}

function openPanel(extPath: string, serial?: string, title?: string) {
  if (!serial) { vscode.window.showWarningMessage('No device selected.'); return; }
  if (!serial.startsWith('emulator-')) { vscode.window.showInformationMessage('Extended Controls are only available for emulators.'); return; }
  const existing = panels.get(serial);
  if (existing) { existing.reveal(); return; }
  const media = vscode.Uri.file(path.join(extPath, 'media'));
  const codicons = vscode.Uri.file(path.join(extPath, 'media', 'codicons'));
  const panel = vscode.window.createWebviewPanel('androidExtended', `${title ?? serial} - Extended Controls`, vscode.ViewColumn.Active, {
    enableScripts: true, localResourceRoots: [media, codicons],
  });
  panels.set(serial, panel);
  panel.onDidDispose(() => panels.delete(serial));
  const w = panel.webview;
  const u = (...p: string[]) => w.asWebviewUri(vscode.Uri.joinPath(media, ...p));
  const csp = `default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src ${w.cspSource}; font-src ${w.cspSource};`;
  w.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${w.asWebviewUri(vscode.Uri.joinPath(codicons, 'codicon.css'))}">
<link rel="stylesheet" href="${u('extended', 'main.css')}"></head><body><div id="nav"></div><div id="page"></div>
<script src="${u('extended', 'main.js')}"></script></body></html>`;
  w.onDidReceiveMessage(async (m) => {
    try {
      if (m.type === 'emu' && ALLOWED.test(m.cmd)) {
        const out = (await adb(serial, 'emu', ...m.cmd.split(' '))).trim();
        w.postMessage({ type: 'result', text: out.replace(/\s*OK\s*$/, '') || 'OK' });
      } else if (m.type === 'key') {
        await adb(serial, 'shell', 'input', 'keyevent', String(m.code));
      } else if (m.type === 'sms') {
        await adb(serial, 'emu', 'sms', 'send', String(m.number), String(m.text));
        w.postMessage({ type: 'result', text: 'SMS sent' });
      } else if (m.type === 'display') {
        const size = (await adb(serial, 'shell', 'wm', 'size')).trim().split('\n').pop();
        const dens = (await adb(serial, 'shell', 'wm', 'density')).trim().split('\n').pop();
        w.postMessage({ type: 'display', size, dens });
      }
    } catch (e: any) { w.postMessage({ type: 'result', text: 'Error: ' + (e.message ?? e) }); }
  });
}
