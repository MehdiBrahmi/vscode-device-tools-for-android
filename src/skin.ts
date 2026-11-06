import * as fs from 'fs';
import * as path from 'path';
import { listAvds, sdkRoot } from './sdk';

export interface Skin {
  dir: string;
  back: string;
  mask?: string;
  /** Whole frame size and the display rectangle inside it, in skin pixels. */
  lw: number; lh: number;
  dx: number; dy: number; dw: number; dh: number;
  radius: number;
}

type Block = { [k: string]: Block | string };

// The emulator skin "layout" file is a nested `name { key value ... }` format.
function parseLayout(text: string): Block {
  const root: Block = {};
  const stack: Block[] = [root];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) { continue; }
    if (line === '}') { stack.pop(); continue; }
    const open = line.match(/^(\S+)\s*\{$/);
    if (open) {
      const b: Block = {};
      stack[stack.length - 1][open[1]] = b;
      stack.push(b);
      continue;
    }
    const kv = line.match(/^(\S+)\s+(.+)$/);
    if (kv) { stack[stack.length - 1][kv[1]] = kv[2]; }
  }
  return root;
}

const num = (v: unknown) => Number(v) || 0;
const blk = (b: Block | string | undefined) => (typeof b === 'object' ? b : {}) as Block;

/** Portrait skin of the AVD (device frame image + display position), if it has one. */
export function skinForAvd(avdName?: string): Skin | undefined {
  const avd = avdName ? listAvds().find((a) => a.name === avdName) : undefined;
  if (!avd) { return undefined; }
  const name = avd.config['skin.name'];
  let dir = avd.config['skin.path'];
  if (!dir || !fs.existsSync(dir)) { dir = name ? path.join(sdkRoot(), 'skins', name) : ''; }
  const layoutFile = dir && path.join(dir, 'layout');
  if (!layoutFile || !fs.existsSync(layoutFile)) { return undefined; }
  try {
    const l = parseLayout(fs.readFileSync(layoutFile, 'utf8'));
    const parts = blk(l.parts), portrait = blk(parts.portrait), device = blk(blk(parts.device).display);
    const layout = blk(blk(l.layouts).portrait);
    const backImg = blk(portrait.background).image as string | undefined;
    if (!backImg || !layout.width) { return undefined; }
    const placed = (n: string) => Object.values(layout).map(blk).find((p) => p.name === n);
    const pos = placed('device') ?? {};
    const mask = blk(portrait.foreground).mask as string | undefined;
    const skin: Skin = {
      dir, back: path.join(dir, backImg), mask: mask ? path.join(dir, mask) : undefined,
      lw: num(layout.width), lh: num(layout.height),
      dx: num(pos.x), dy: num(pos.y), dw: num(device.width), dh: num(device.height),
      radius: num(device.corner_radius),
    };
    return skin.dw && skin.dh && fs.existsSync(skin.back) ? skin : undefined;
  } catch { return undefined; }
}
