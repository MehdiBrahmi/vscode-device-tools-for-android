import * as fs from 'fs';
import * as path from 'path';
import { sdkRoot } from './sdk';

export interface EmulatorHandlers {
  onFrame(f: { w: number; h: number; rgba: Buffer }): void;
  onClose(reason?: string): void;
}

/** Native display size reported by the emulator, used to map touches. */
export interface NativeSize { w: number; h: number; }

export const protoPath = () => path.join(sdkRoot(), 'emulator', 'lib', 'emulator_controller.proto');
export const grpcSupported = () => fs.existsSync(protoPath());

function clientOptions(grpc: any, token?: string): Record<string, unknown> {
  if (!token) { return {}; }
  const interceptor = (opts: any, next: any) => new grpc.InterceptingCall(next(opts), {
    start(md: any, listener: any, nx: any) { md.set('authorization', `Bearer ${token}`); nx(md, listener); },
  });
  return { interceptors: [interceptor] };
}

let cachedPkg: any;
function controllerClass() {
  if (!cachedPkg) {
    // Loaded lazily so the extension still activates if the modules are missing.
    const grpc = require('@grpc/grpc-js');
    const loader = require('@grpc/proto-loader');
    const lib = path.dirname(protoPath());
    const def = loader.loadSync(protoPath(), { keepCase: false, longs: Number, enums: String, defaults: true, oneofs: true, includeDirs: [lib] });
    cachedPkg = { grpc, svc: grpc.loadPackageDefinition(def).android.emulation.control.EmulatorController };
  }
  return cachedPkg as { grpc: any; svc: any };
}

export class EmulatorSession {
  private client: any;
  private stream: any;
  private closed = false;
  native: NativeSize = { w: 0, h: 0 };

  constructor(private port: number, private h: EmulatorHandlers, private viewport: { w: number; h: number }, private token?: string) {}

  /** Ask the emulator for frames sized to the on-screen box (device pixels) so they are sharp without wasting bandwidth. */
  setViewport(v: { w: number; h: number }) {
    this.viewport = v;
    if (this.stream && !this.closed) {
      this.stream.removeAllListeners();
      this.stream.on('error', () => {});
      try { this.stream.cancel(); } catch { /* ignore */ }
      this.openStream();
    }
  }

  async start() {
    const { grpc, svc } = controllerClass();
    this.client = new svc(`127.0.0.1:${this.port}`, grpc.credentials.createInsecure(), {
      'grpc.max_receive_message_length': 128 * 1024 * 1024,
      ...clientOptions(grpc, this.token),
    });
    const status: any = await new Promise((res, rej) => {
      this.client.waitForReady(Date.now() + 5000, (e: Error) => (e ? rej(e) : res(undefined)));
    }).then(() => new Promise((res, rej) => this.client.getStatus({}, (e: Error, r: any) => (e ? rej(e) : res(r)))));
    const get = (k: string) => Number(status.hardwareConfig?.entry?.find((x: any) => x.key === k)?.value ?? 0);
    this.native = { w: get('hw.lcd.width'), h: get('hw.lcd.height') };
    this.openStream();
  }

  private openStream() {
    // Both dimensions are needed for the emulator to scale the frame; the aspect ratio is preserved.
    const nw = this.native.w || 1080, nh = this.native.h || 1920;
    const fit = (w: number, h: number) => Math.min(w, h) > 0 ? Math.min(this.viewport.w / w, this.viewport.h / h) : 1;
    // Either orientation may be shown after a rotation: size for the one that needs more pixels.
    const scale = Math.min(1, Math.max(fit(nw, nh), fit(nh, nw)));
    const req = (w: number, h: number) => ({ format: 'RGBA8888', width: Math.round(w * scale), height: Math.round(h * scale) });
    this.stream = this.client.streamScreenshot(req(this.native.w || 1080, this.native.h || 1920));
    this.stream.on('data', (m: any) => {
      const w = m.format.width, h = m.format.height;
      // Rotation changes the frame shape: keep the native size in sync so touches map correctly.
      this.quadrants = ['PORTRAIT', 'LANDSCAPE', 'REVERSE_PORTRAIT', 'REVERSE_LANDSCAPE'].indexOf(m.format.rotation?.rotation);
      if (this.quadrants < 0) { this.quadrants = 0; }
      this.lastScale = Math.max(this.native.w, this.native.h) / Math.max(w, h);
      this.h.onFrame({ w, h, rgba: m.image });
    });
    this.stream.on('error', (e: Error) => { if (!this.closed) { this.close(e.message); } });
    this.stream.on('end', () => this.close('stream ended'));
  }

  private lastScale = 1;
  private quadrants = 0;

  /** Same mechanism as Android Studio: drive the emulator's rotation sensor, which also rotates launchers that ignore the user-rotation setting. */
  rotate(dir: number) {
    const q = (this.quadrants + (dir < 0 ? 1 : 3)) & 3;
    const angle = [0, 90, -180, -90][q];
    this.client.setPhysicalModel({ target: 'ROTATION', value: { data: [0, 0, angle] } }, () => {});
  }

  /** Convert normalized (0..1) coordinates to the emulator's native pixel space. */
  private toNative(nx: number, ny: number, fw: number, fh: number) {
    const s = this.lastScale || 1;
    return { x: Math.round(nx * fw * s), y: Math.round(ny * fh * s) };
  }

  touch(action: number, nx: number, ny: number, fw: number, fh: number) {
    const { x, y } = this.toNative(nx, ny, fw, fh);
    this.client.sendTouch({ touches: [{ x, y, identifier: 0, pressure: action === 1 ? 0 : 1 }] }, () => {});
  }

  async swipe(nx: number, ny: number, nx2: number, ny2: number, fw: number, fh: number, ms: number) {
    const steps = 8;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.touch(i === steps ? 1 : 0, nx + (nx2 - nx) * t, ny + (ny2 - ny) * t, fw, fh);
      await new Promise((r) => setTimeout(r, ms / steps));
    }
  }

  /** key uses KeyboardEvent.key names ("a", "Enter", "Backspace", "ArrowUp"…). */
  key(key: string) {
    this.client.sendKey({ eventType: 'keypress', key }, () => {});
  }

  private close(reason?: string) {
    if (this.closed) { return; }
    this.closed = true;
    try { this.stream?.cancel(); } catch { /* ignore */ }
    try { this.client?.close(); } catch { /* ignore */ }
    this.h.onClose(reason);
  }

  stop() { this.close(); }
}

/** Opens the emulator's own Extended Controls window (needs the emulator to run with -qt-hide-window, not -no-window). */
export function showNativeExtendedControls(port: number, pane = 'LOCATION', token?: string): Promise<boolean> {
  const grpc = require('@grpc/grpc-js');
  const loader = require('@grpc/proto-loader');
  const lib = path.join(sdkRoot(), 'emulator', 'lib');
  const file = path.join(lib, 'ui_controller_service.proto');
  if (!fs.existsSync(file)) { return Promise.reject(new Error('ui_controller_service.proto not found')); }
  const def = loader.loadSync(file, { keepCase: false, enums: String, defaults: true, includeDirs: [lib] });
  const client = new (grpc.loadPackageDefinition(def).android.emulation.control.UiController)(`127.0.0.1:${port}`, grpc.credentials.createInsecure(), clientOptions(grpc, token));
  return new Promise((res, rej) => {
    client.showExtendedControls({ index: pane }, { deadline: Date.now() + 5000 }, (e: Error | null, r: any) => { client.close(); e ? rej(e) : res(!!r?.visibilityChanged); });
  });
}
