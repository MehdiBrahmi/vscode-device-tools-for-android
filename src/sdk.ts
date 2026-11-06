import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { execFile, spawn } from 'child_process';

export function sdkRoot(): string {
  const cfg = vscode.workspace.getConfiguration('android').get<string>('sdkPath');
  const candidates = [
    cfg,
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'Library/Android/sdk'),
    path.join(os.homedir(), 'Android/Sdk'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Android/Sdk'),
  ];
  return candidates.find((c) => c && fs.existsSync(c)) ?? '';
}

const exe = (n: string) => (process.platform === 'win32' ? n + '.exe' : n);
const bat = (n: string) => (process.platform === 'win32' ? n + '.bat' : n);

export function adbPath() { return path.join(sdkRoot(), 'platform-tools', exe('adb')); }
export function emulatorPath() { return path.join(sdkRoot(), 'emulator', exe('emulator')); }
function cmdlineTool(name: string) {
  const root = path.join(sdkRoot(), 'cmdline-tools');
  const dirs = fs.existsSync(root) ? fs.readdirSync(root).sort((a, b) => (a === 'latest' ? -1 : b === 'latest' ? 1 : b.localeCompare(a))) : [];
  for (const d of dirs) {
    const p = path.join(root, d, 'bin', bat(name));
    if (fs.existsSync(p)) { return p; }
  }
  return path.join(sdkRoot(), 'tools', 'bin', bat(name));
}
export const avdmanagerPath = () => cmdlineTool('avdmanager');

export function run(cmd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ANDROID_HOME: sdkRoot(), ANDROID_SDK_ROOT: sdkRoot() };
    const p = execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, env }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || stdout || err.message).toString().trim())) : resolve(stdout.toString()));
    if (input !== undefined) { p.stdin?.end(input); }
  });
}

export function runBuffer(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export const adb = (serial: string | undefined, ...args: string[]) =>
  run(adbPath(), serial ? ['-s', serial, ...args] : args);

export function spawnDetached(cmd: string, args: string[]) {
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore', env: { ...process.env, ANDROID_HOME: sdkRoot(), ANDROID_SDK_ROOT: sdkRoot() } });
  p.unref();
}

export interface Device { serial: string; state: string; model?: string; avdName?: string; }

export async function listDevices(): Promise<Device[]> {
  let out: string;
  try { out = await adb(undefined, 'devices', '-l'); } catch { return []; }
  const devices: Device[] = [];
  for (const line of out.split('\n').slice(1)) {
    const m = line.trim().match(/^(\S+)\s+(\S+)(.*)$/);
    if (!m) { continue; }
    const model = m[3].match(/model:(\S+)/)?.[1];
    const d: Device = { serial: m[1], state: m[2], model };
    if (d.serial.startsWith('emulator-') && d.state === 'device') {
      try {
        d.avdName = (await adb(d.serial, 'emu', 'avd', 'name')).split('\n')[0].trim();
      } catch { /* ignore */ }
    }
    devices.push(d);
  }
  return devices;
}

export interface Avd { name: string; dir: string; config: Record<string, string>; }

export const avdHome = () => process.env.ANDROID_AVD_HOME ?? path.join(os.homedir(), '.android', 'avd');

export function readConfig(file: string): Record<string, string> {
  const cfg: Record<string, string> = {};
  if (!fs.existsSync(file)) { return cfg; }
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    const i = l.indexOf('=');
    if (i > 0 && !l.startsWith('#')) { cfg[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  }
  return cfg;
}

export function writeConfigValues(file: string, values: Record<string, string>) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const remaining = { ...values };
  const out = lines.map((l) => {
    const k = l.split('=')[0].trim();
    if (k in remaining) { const v = remaining[k]; delete remaining[k]; return `${k}=${v}`; }
    return l;
  });
  for (const [k, v] of Object.entries(remaining)) { out.push(`${k}=${v}`); }
  fs.writeFileSync(file, out.join('\n'));
}

export function listAvds(): Avd[] {
  const home = avdHome();
  if (!fs.existsSync(home)) { return []; }
  return fs.readdirSync(home).filter((f) => f.endsWith('.ini')).map((f) => {
    const name = f.slice(0, -4);
    const ini = readConfig(path.join(home, f));
    const dir = ini['path'] && fs.existsSync(ini['path']) ? ini['path'] : path.join(home, `${name}.avd`);
    return { name, dir, config: readConfig(path.join(dir, 'config.ini')) };
  });
}

export function installedSystemImages(): { id: string; label: string }[] {
  const base = path.join(sdkRoot(), 'system-images');
  const res: { id: string; label: string }[] = [];
  if (!fs.existsSync(base)) { return res; }
  for (const api of fs.readdirSync(base)) {
    const apiDir = path.join(base, api);
    if (!fs.statSync(apiDir).isDirectory()) { continue; }
    for (const tag of fs.readdirSync(apiDir)) {
      const tagDir = path.join(apiDir, tag);
      if (!fs.statSync(tagDir).isDirectory()) { continue; }
      for (const abi of fs.readdirSync(tagDir)) {
        res.push({ id: `system-images;${api};${tag};${abi}`, label: `${api} · ${tag} · ${abi}` });
      }
    }
  }
  return res;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function runningDirs(): string[] {
  return [
    path.join(os.homedir(), 'Library/Caches/TemporaryItems/avd/running'),
    path.join(process.env.XDG_RUNTIME_DIR ?? '', 'avd/running'),
    path.join(os.homedir(), '.android/avd/running'),
    path.join(os.tmpdir(), 'avd/running'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Temp/avd/running'),
  ];
}

/** Bearer token of an emulator started with -grpc-use-token (as Android Studio does). */
export function grpcTokenFor(serial: string): string | undefined {
  const consolePort = serial.replace('emulator-', '');
  for (const dir of runningDirs()) {
    if (!fs.existsSync(dir)) { continue; }
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ini'))) {
      const c = readConfig(path.join(dir, f));
      if (c['port.serial'] === consolePort) { return c['grpc.token'] || undefined; }
    }
  }
  return undefined;
}

/** gRPC port of a running emulator (only present when started with -grpc). */
export function grpcPortFor(serial: string): number | undefined {
  const consolePort = serial.replace('emulator-', '');
  for (const dir of runningDirs()) {
    if (!fs.existsSync(dir)) { continue; }
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ini'))) {
      const c = readConfig(path.join(dir, f));
      if (c['port.serial'] === consolePort && c['grpc.port']) { return Number(c['grpc.port']); }
    }
  }
  return undefined;
}
