import * as net from 'net';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { adb, adbPath, freePort, sdkRoot } from './sdk';

// Must match the bundled resources/scrcpy-server.jar
export const SCRCPY_VERSION = '3.3.4';
const REMOTE_JAR = '/data/local/tmp/scrcpy-server-vscode.jar';
const POINTER_MOUSE = 0xffffffffffffffffn;

export type PacketKind = 'config' | 'key' | 'delta';

export interface ScrcpyHandlers {
  onPacket(kind: PacketKind, data: Buffer): void;
  onClose(reason?: string): void;
}

function connectWithRetry(port: number, isStopped: () => boolean, attempts = 100): Promise<{ sock: net.Socket; first: Buffer }> {
  return new Promise((resolve, reject) => {
    let n = 0;
    const attempt = () => {
      if (isStopped()) { return reject(new Error('stopped')); }
      const sock = net.connect(port, '127.0.0.1');
      let got = false;
      sock.once('data', (d: Buffer) => { got = true; resolve({ sock, first: d }); });
      sock.on('error', () => { /* retried on close */ });
      sock.on('close', () => {
        if (got) { return; }
        if (++n >= attempts) { reject(new Error('scrcpy server did not start')); } else { setTimeout(attempt, 100); }
      });
    };
    attempt();
  });
}

export class ScrcpySession {
  private proc?: ChildProcess;
  private video?: net.Socket;
  private control?: net.Socket;
  private stopped = false;
  private port = 0;
  private log = '';

  constructor(private serial: string, private jarPath: string, private h: ScrcpyHandlers) {}

  async start() {
    const scid = Math.floor(Math.random() * 0x7fffffff).toString(16).padStart(8, '0');
    await adb(this.serial, 'push', this.jarPath, REMOTE_JAR);
    this.port = await freePort();
    await adb(this.serial, 'forward', `tcp:${this.port}`, `localabstract:scrcpy_${scid}`);

    this.proc = spawn(adbPath(), ['-s', this.serial, 'shell',
      `CLASSPATH=${REMOTE_JAR}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', SCRCPY_VERSION,
      `scid=${scid}`, 'log_level=info', 'tunnel_forward=true', 'audio=false', 'control=true', 'cleanup=false',
      'max_size=1920', 'video_bit_rate=8000000', 'max_fps=60', 'stay_awake=false'],
      { env: { ...process.env, ANDROID_HOME: sdkRoot() } });
    const collect = (d: Buffer) => { this.log = (this.log + d.toString()).slice(-2000); };
    this.proc.stdout?.on('data', collect);
    this.proc.stderr?.on('data', collect);
    this.proc.on('exit', () => this.close(this.log.trim() || 'scrcpy server exited'));

    const { sock, first } = await connectWithRetry(this.port, () => this.stopped);
    this.video = sock;
    // first connection = video (after the dummy byte), second = control
    const ctl = net.connect(this.port, '127.0.0.1');
    this.control = ctl;
    ctl.on('data', () => { /* device messages (clipboard…) ignored */ });
    ctl.on('error', () => {});
    this.readVideo(sock, first.subarray(1));
  }

  private readVideo(sock: net.Socket, initial: Buffer) {
    let buf = initial;
    let metaDone = false;
    const parse = () => {
      if (!metaDone) {
        if (buf.length < 76) { return; } // 64 name + 4 codec + 4 w + 4 h
        buf = buf.subarray(76);
        metaDone = true;
      }
      while (buf.length >= 12) {
        const hi = buf.readUInt32BE(0);
        const size = buf.readUInt32BE(8);
        if (buf.length < 12 + size) { return; }
        const kind: PacketKind = hi & 0x80000000 ? 'config' : hi & 0x40000000 ? 'key' : 'delta';
        this.h.onPacket(kind, Buffer.from(buf.subarray(12, 12 + size)));
        buf = buf.subarray(12 + size);
      }
    };
    sock.on('data', (d: Buffer) => { buf = buf.length ? Buffer.concat([buf, d]) : d; parse(); });
    sock.on('close', () => this.close('video stream closed'));
    sock.on('error', () => {});
    parse();
  }

  private send(b: Buffer) { if (this.control && !this.control.destroyed) { this.control.write(b); } }

  key(code: number) {
    for (const action of [0, 1]) {
      const b = Buffer.alloc(14);
      b.writeUInt8(0, 0); b.writeUInt8(action, 1); b.writeUInt32BE(code, 2);
      this.send(b);
    }
  }

  text(t: string) {
    const body = Buffer.from(t, 'utf8');
    const b = Buffer.alloc(5 + body.length);
    b.writeUInt8(1, 0); b.writeUInt32BE(body.length, 1); body.copy(b, 5);
    this.send(b);
  }

  /** action: 0=down 1=up 2=move */
  touch(action: number, x: number, y: number, w: number, h: number) {
    const b = Buffer.alloc(32);
    b.writeUInt8(2, 0); b.writeUInt8(action, 1); b.writeBigUInt64BE(POINTER_MOUSE, 2);
    b.writeInt32BE(Math.round(x), 10); b.writeInt32BE(Math.round(y), 14);
    b.writeUInt16BE(w, 18); b.writeUInt16BE(h, 20);
    b.writeUInt16BE(action === 1 ? 0 : 0xffff, 22);
    b.writeUInt32BE(1, 24); // action button: primary
    b.writeUInt32BE(action === 1 ? 0 : 1, 28);
    this.send(b);
  }

  scroll(x: number, y: number, w: number, h: number, vscroll: number) {
    const b = Buffer.alloc(21);
    b.writeUInt8(3, 0); b.writeInt32BE(Math.round(x), 1); b.writeInt32BE(Math.round(y), 5);
    b.writeUInt16BE(w, 9); b.writeUInt16BE(h, 11);
    b.writeInt16BE(0, 13);
    b.writeInt16BE(Math.max(-0x8000, Math.min(0x7fff, Math.round(vscroll * 0x8000))), 15);
    this.send(b);
  }

  rotate() { this.send(Buffer.from([11])); }
  expandNotifications() { this.send(Buffer.from([5])); }

  private close(reason?: string) {
    if (this.stopped) { return; }
    this.stopped = true;
    this.video?.destroy(); this.control?.destroy();
    this.proc?.kill();
    if (this.port) { adb(this.serial, 'forward', '--remove', `tcp:${this.port}`).catch(() => {}); }
    this.h.onClose(reason);
  }

  stop() { this.close(); }
}

export const bundledJar = (extPath: string) => path.join(extPath, 'resources', 'scrcpy-server.jar');
