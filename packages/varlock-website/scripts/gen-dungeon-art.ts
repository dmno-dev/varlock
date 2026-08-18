/*
Generates the pixel-art assets for the landing page dungeon treatment.

Sprites are authored as ASCII pixel maps (one char = one pixel) and encoded
as RGBA PNGs with no external dependencies. Output is committed to
src/assets/pixel-art/dungeon/ - re-run this script only when tweaking art.

Usage:
  bun run scripts/gen-dungeon-art.ts [--preview <dir>]

--preview also writes 8x upscaled copies to <dir> for eyeballing.
*/

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// palette
// ---------------------------------------------------------------------------

type RGBA = [number, number, number, number];

const hex = (h: string, a = 255): RGBA => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
  a,
];

const PALETTE: Record<string, RGBA> = {
  '.': [0, 0, 0, 0], // transparent
  o: hex('#221d20'), // outline
  // warlock (palette sampled from the hero warlock GIFs)
  R: hex('#7c2226'), // cloak crimson
  r: hex('#521418'), // cloak shadow
  V: hex('#350d10'), // cloak deep shadow
  X: hex('#a13236'), // cloak highlight
  G: hex('#b0812f'), // gold buckles / trim
  d: hex('#1a1216'), // hood void / dark interior
  E: hex('#e05840'), // ember eye glow
  T: hex('#46333c'), // staff dark metal
  Q: hex('#ff4a52'), // orb bright red
  q: hex('#a3202c'), // orb dark red
  U: hex('#c07af5'), // key purple
  u: hex('#8b4fc0'), // key purple dark
  K: hex('#2e2226'), // boots / dark leather
  S: hex('#c9926a'), // hand gripping the staff
  // stone
  M: hex('#6b6673'), // stone mid
  m: hex('#565160'), // stone dark
  D: hex('#454049'), // stone darker (mortar)
  h: hex('#847e91'), // stone highlight
  F: hex('#4e4956'), // floor mid
  f: hex('#413c49'), // floor dark
  // torch / fire
  Y: hex('#ffe08a'), // flame bright
  O: hex('#f08a2e'), // flame orange
  Z: hex('#d1441f'), // flame red
  // door
  W: hex('#8a5a2b'), // door planks
  w: hex('#66401e'), // door plank shadow
  g: hex('#5a4a72'), // lit doorway glowish purple
  A: hex('#caa9ff'), // lit doorway bright edge
};

// ---------------------------------------------------------------------------
// tiny PNG encoder (RGBA8, filter 0)
// ---------------------------------------------------------------------------

/* eslint-disable no-bitwise -- CRC32 is inherently bitwise */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
/* eslint-enable no-bitwise */

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePng(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // scanlines with filter byte 0
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  }
  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// canvas helpers
// ---------------------------------------------------------------------------

class Canvas {
  px: Uint8Array;
  constructor(public width: number, public height: number) {
    this.px = new Uint8Array(width * height * 4);
  }

  set(x: number, y: number, rgba: RGBA) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    if (rgba[3] === 0) return;
    this.px.set(rgba, (y * this.width + x) * 4);
  }

  // paste an ASCII map with its top-left corner at (ox, oy)
  paste(map: Array<string>, ox: number, oy: number) {
    map.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        if (ch === '.' || ch === ' ') continue;
        const color = PALETTE[ch];
        if (!color) throw new Error(`unknown palette char '${ch}'`);
        this.set(ox + x, oy + y, color);
      }
    });
  }

  toPng() { return encodePng(this.px, this.width, this.height); }

  upscale(factor: number): Canvas {
    const out = new Canvas(this.width * factor, this.height * factor);
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const src = ((Math.floor(y / factor) * this.width) + Math.floor(x / factor)) * 4;
        out.px.set(this.px.subarray(src, src + 4), (y * out.width + x) * 4);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// wizard sprite - 32x32 frames
// front (south = walking down the page) and back (north) views share feet
// ---------------------------------------------------------------------------

// rows 0..27 - body without feet (32 chars wide)
// hooded crimson cloak, void face with ember eyes, dark staff with red
// keyhole orb; the floating purple key is pasted separately so it can bob
const WIZARD_FRONT_BODY = [
  '................................',
  '.................oo.............',
  '................oRRo............',
  '................oRRo............',
  '...............oRRRRo..........',
  '...............oRXRRo..........',
  '......oQo.....oRRRRRRo.........',
  '.....oQdQo....oRRRRRRo.........',
  '.....oqdqo...oRRRRRRRRo........',
  '......oqo....oRRXRRRRRo........',
  '.......oTo..oRRRRRRRRRRo.......',
  '.......oTo.oXRRRRRRRRRRro......',
  '.......oToooooooooooooooo......',
  '.......oTo..odddddddddo.........',
  '.......oTo..oddEdddEddo.........',
  '.......oTo..odddddddddo.........',
  '.......oTo.oRRrRRRRRrRRo........',
  '.......oTo.oRRRRGGRRRRRo........',
  '.......oTooRRrRRRRRRRRrRo.......',
  '.......oTooRRrRRGRRRRRrRo.......',
  '.......oGooRRrRRRRRRRRrRo.......',
  '.......oGooRRrRRRRRRRRrRo.......',
  '.......oTooRrRVRRRRRRVrRo.......',
  '.......oTooRrRVRRRRRRVrRo.......',
  '.......oTooRrRVRRRRRRVrRo.......',
  '.......oTooRrVVRRRRRRVVro.......',
  '.......oTooVrVVRRRRRRVVro.......',
  '..........oooooooooooooo........',
];

// back view: same hood, no face - full cloak back with dark center panel
const WIZARD_BACK_BODY = [
  '................................',
  '.................oo.............',
  '................oRRo............',
  '................oRRo............',
  '...............oRRRRo..........',
  '...............oRRXRo..........',
  '......oQo.....oRRRRRRo.........',
  '.....oQdQo....oRRRRRRo.........',
  '.....oqdqo...oRRRRRRRRo........',
  '......oqo....oRRRRXRRRo........',
  '.......oTo..oRRRRRRRRRRo.......',
  '.......oTo.oXRRRRRRRRRRro......',
  '.......oToooooooooooooooo......',
  '.......oTo..oRRRRRRRRRo.........',
  '.......oTo..oRrVVVVVrRo.........',
  '.......oTo..oRrVVVVVrRo.........',
  '.......oTo.oRRrVVVVVrRRo........',
  '.......oTo.oRRrVVVVVrRRo........',
  '.......oTooRRRrVVVVVrRRRo.......',
  '.......oTooRRRrVVVVVrRRRo.......',
  '.......oGooRRRrVVVVVrRRGo.......',
  '.......oGooRRRrVVVVVrRRGo.......',
  '.......oTooRrRrVVVVVrRRRo.......',
  '.......oTooRrRrVVVVVrRRRo.......',
  '.......oTooRrRrVVVVVrRRRo.......',
  '.......oTooRrRrVVVVVrRRRo.......',
  '.......oTooVrRrVVVVVrRVro.......',
  '..........oooooooooooooo........',
];

// feet variants, rows 28..31 (walk cycle: L forward, together, R forward, together)
const FEET_TOGETHER = [
  '...........oKKoooooKKo..........',
  '...........oooo...oooo..........',
  '................................',
  '................................',
];
const FEET_LEFT = [
  '..........oKKo....oKKo..........',
  '..........oooo....oKKo..........',
  '..................oooo..........',
  '................................',
];
const FEET_RIGHT = [
  '...........oKKo....oKKo.........',
  '...........oKKo....oooo.........',
  '...........oooo.................',
  '................................',
];

// side view, facing east (west is a CSS scaleX flip); staff held ahead,
// key trails behind
const WIZARD_EAST_BODY = [
  '................................',
  '..............oo................',
  '.............oRRo...............',
  '.............oRRo...............',
  '............oRRRRo..............',
  '............oRRXRo..............',
  '...........oRRRRRRo....oQo.....',
  '...........oRRRRRRo...oQdQo....',
  '..........oRRRRRRRRo..oqdqo....',
  '..........oRRXRRRRRo...oqo.....',
  '.........oRRRRRRRRRRo..oTo.....',
  '.........oXRRRRRRRRRo..oTo.....',
  '.........ooooooooooooo.oTo.....',
  '..........oRRRdddddo...oTo.....',
  '..........oRRRddEddo...oTo.....',
  '..........oRRRdddddo...oTo.....',
  '.........oRRRRRRRRRo...oTo.....',
  '.........oRRRGGRRRRo...oTo.....',
  '.........oRRrRRRRRRRo..oTo.....',
  '.........oRRrRRRRRSooooTo......',
  '.........oRRrRRRRRRo...oGo.....',
  '.........oRRrRRRRRRo...oTo.....',
  '.........oRrRVRRRRVo...oTo.....',
  '.........oRrRVRRRRVo...oTo.....',
  '.........oRrRVRRRRVo...oTo.....',
  '.........oRrVVRRRRVo...oTo.....',
  '.........oVrVVRRRRVo...oTo.....',
  '..........ooooooooo.............',
];

const FEET_E_TOGETHER = [
  '............oKKKKo..............',
  '............oooooo..............',
  '................................',
  '................................',
];
const FEET_E_STRIDE_A = [
  '..........oKKo...oKKo...........',
  '..........oooo...oooo...........',
  '................................',
  '................................',
];
const FEET_E_STRIDE_B = [
  '...........oKKKo................',
  '...........ooooo................',
  '................................',
  '................................',
];

// floating key (pasted separately so it can bob between frames)
const KEY_MAP = [
  '.ooo.',
  'oUUUo',
  'oUdUo',
  'oUUUo',
  '.oUo.',
  '.oUuo',
  '.ouo.',
];
const KEY_MAP_MIRRORED = KEY_MAP.map((row) => [...row].reverse().join(''));

function wizardFrame(body: Array<string>, feet: Array<string>): Array<string> {
  return [...body, ...feet];
}

function buildWizardSheet(): Canvas {
  const c = new Canvas(128, 128);
  const walkFeet = [FEET_LEFT, FEET_TOGETHER, FEET_RIGHT, FEET_TOGETHER];
  // key bobs 1px between alternating frames
  const keyY = (i: number) => 11 + (i % 2);
  // row 0: walk south (front, key floats at the viewer's right)
  walkFeet.forEach((feet, i) => {
    c.paste(wizardFrame(WIZARD_FRONT_BODY, feet), i * 32, 0);
    c.paste(KEY_MAP, i * 32 + 26, keyY(i));
  });
  // row 1: walk north (back, key mirrored to the viewer's left)
  walkFeet.forEach((feet, i) => {
    c.paste(wizardFrame(WIZARD_BACK_BODY, feet), i * 32, 32);
    c.paste(KEY_MAP_MIRRORED, i * 32 + 1, 32 + keyY(i));
  });
  // row 2: idle (front) - two frames, key bobs
  for (let i = 0; i < 2; i++) {
    c.paste(wizardFrame(WIZARD_FRONT_BODY, FEET_TOGETHER), i * 32, 64);
    c.paste(KEY_MAP, i * 32 + 26, 64 + keyY(i));
  }
  // row 3: walk east (side view, key trails behind)
  const eastFeet = [FEET_E_STRIDE_A, FEET_E_TOGETHER, FEET_E_STRIDE_B, FEET_E_TOGETHER];
  eastFeet.forEach((feet, i) => {
    c.paste(wizardFrame(WIZARD_EAST_BODY, feet), i * 32, 96);
    c.paste(KEY_MAP, i * 32 + 1, 96 + keyY(i));
  });
  return c;
}

// ---------------------------------------------------------------------------
// corridor floor tile - 32x32, tiles vertically, walls on both edges
// ---------------------------------------------------------------------------

function paintFloor(c: Canvas) {
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) c.set(x, y, PALETTE.F);
  }
  // stone slab pattern: mortar lines every 8px, offset every other row of slabs
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const rowBand = Math.floor(y / 8);
      const offset = (rowBand % 2) * 4;
      if (y % 8 === 7) c.set(x, y, PALETTE.f);
      else if ((x + offset) % 8 === 7) c.set(x, y, PALETTE.f);
      else if (y % 8 === 0 && (x + offset) % 8 === 0) c.set(x, y, PALETTE.h);
    }
  }
  // a few pebble accents (fixed, so the tile stays deterministic)
  const pebbles: Array<[number, number]> = [[5, 12], [18, 4], [26, 21], [11, 27]];
  for (const [x, y] of pebbles) c.set(x, y, PALETTE.f);
}

// 4px wall strips with an outline on the corridor side
function paintWallLeft(c: Canvas) {
  for (let y = 0; y < 32; y++) {
    const band = y % 6 < 3 ? PALETTE.m : PALETTE.D;
    for (const x of [0, 1, 2, 3]) c.set(x, y, x === 3 ? PALETTE.o : band);
  }
}
function paintWallRight(c: Canvas) {
  for (let y = 0; y < 32; y++) {
    const band = y % 6 < 3 ? PALETTE.D : PALETTE.m;
    for (const x of [28, 29, 30, 31]) c.set(x, y, x === 28 ? PALETTE.o : band);
  }
}
function paintWallTop(c: Canvas) {
  for (let x = 0; x < 32; x++) {
    const band = x % 6 < 3 ? PALETTE.m : PALETTE.D;
    for (const y of [0, 1, 2, 3]) c.set(x, y, y === 3 ? PALETTE.o : band);
  }
}
function paintWallBottom(c: Canvas) {
  for (let x = 0; x < 32; x++) {
    const band = x % 6 < 3 ? PALETTE.D : PALETTE.m;
    for (const y of [28, 29, 30, 31]) c.set(x, y, y === 28 ? PALETTE.o : band);
  }
}
// 4x4 corner block with outlines on its two corridor-facing edges,
// used where two corridor walls meet across an elbow's inner corner
function paintCornerBlock(c: Canvas, corner: 'tl' | 'tr' | 'bl' | 'br') {
  const xs = corner === 'tl' || corner === 'bl' ? [0, 1, 2, 3] : [28, 29, 30, 31];
  const ys = corner === 'tl' || corner === 'tr' ? [0, 1, 2, 3] : [28, 29, 30, 31];
  for (const y of ys) {
    for (const x of xs) c.set(x, y, y % 6 < 3 ? PALETTE.m : PALETTE.D);
  }
  const innerX = corner === 'tl' || corner === 'bl' ? 3 : 28;
  const innerY = corner === 'tl' || corner === 'tr' ? 3 : 28;
  for (const y of ys) c.set(innerX, y, PALETTE.o);
  for (const x of xs) c.set(x, innerY, PALETTE.o);
}

// vertical corridor segment (walls left + right, tiles vertically)
function buildCorridorTile(): Canvas {
  const c = new Canvas(32, 32);
  paintFloor(c);
  paintWallLeft(c);
  paintWallRight(c);
  return c;
}

// horizontal corridor segment (walls top + bottom, tiles horizontally)
function buildCorridorTileH(): Canvas {
  const c = new Canvas(32, 32);
  paintFloor(c);
  paintWallTop(c);
  paintWallBottom(c);
  return c;
}

// elbows, named by their two open sides (n/e/s/w)
function buildCorridorElbowNE(): Canvas {
  const c = new Canvas(32, 32);
  paintFloor(c);
  paintWallLeft(c);
  paintWallBottom(c);
  paintCornerBlock(c, 'tr');
  return c;
}
function buildCorridorElbowNW(): Canvas {
  const c = new Canvas(32, 32);
  paintFloor(c);
  paintWallRight(c);
  paintWallBottom(c);
  paintCornerBlock(c, 'tl');
  return c;
}
function buildCorridorElbowSE(): Canvas {
  const c = new Canvas(32, 32);
  paintFloor(c);
  paintWallLeft(c);
  paintWallTop(c);
  paintCornerBlock(c, 'br');
  return c;
}
function buildCorridorElbowSW(): Canvas {
  const c = new Canvas(32, 32);
  paintFloor(c);
  paintWallRight(c);
  paintWallTop(c);
  paintCornerBlock(c, 'bl');
  return c;
}

// dead-end caps for the horizontal branch
function buildCorridorEnd(): Canvas {
  const c = new Canvas(32, 32);
  paintFloor(c);
  paintWallTop(c);
  paintWallBottom(c);
  paintWallRight(c);
  return c;
}
function buildCorridorEndW(): Canvas {
  const c = new Canvas(32, 32);
  paintFloor(c);
  paintWallTop(c);
  paintWallBottom(c);
  paintWallLeft(c);
  return c;
}

// ---------------------------------------------------------------------------
// room border - 24x24 9-slice (8px slices) of stone blocks
// ---------------------------------------------------------------------------

function buildRoomBorder(): Canvas {
  const c = new Canvas(24, 24);
  // fill entire ring area with stone mid, leave center 8x8 transparent
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      const inCenter = x >= 8 && x < 16 && y >= 8 && y < 16;
      if (inCenter) continue;
      c.set(x, y, PALETTE.M);
    }
  }
  // block pattern: darker mortar seams
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      const inCenter = x >= 8 && x < 16 && y >= 8 && y < 16;
      if (inCenter) continue;
      if (x % 4 === 3 && y % 8 < 4) c.set(x, y, PALETTE.D);
      if ((x + 2) % 4 === 3 && y % 8 >= 4) c.set(x, y, PALETTE.D);
      if (y % 4 === 3) c.set(x, y, PALETTE.D);
      if (y % 4 === 0 && x % 4 === 0) c.set(x, y, PALETTE.h);
    }
  }
  // outlines: outer edge + inner edge of the ring
  for (let i = 0; i < 24; i++) {
    c.set(i, 0, PALETTE.o);
    c.set(i, 23, PALETTE.o);
    c.set(0, i, PALETTE.o);
    c.set(23, i, PALETTE.o);
  }
  for (let i = 7; i <= 16; i++) {
    c.set(i, 7, PALETTE.o);
    c.set(i, 16, PALETTE.o);
    c.set(7, i, PALETTE.o);
    c.set(16, i, PALETTE.o);
  }
  return c;
}

// ---------------------------------------------------------------------------
// door - three 16x32 frames side by side (closed / ajar / open). Each frame
// is a full corridor cross-section: 4px wall bands top and bottom and a
// 24px opening, so it lines up exactly with the corridor tiles and lanes.
// The swing plays as a stepped background-position transition.
// ---------------------------------------------------------------------------

type DoorState = 'closed' | 'ajar' | 'open';

function buildDoor(): Canvas {
  const c = new Canvas(48, 32);
  const drawDoor = (ox: number, state: DoorState) => {
    // wall bands matching the horizontal corridor walls (x-banded shading)
    for (let x = 0; x < 16; x++) {
      const bandTop = (ox + x) % 6 < 3 ? PALETTE.m : PALETTE.D;
      const bandBottom = (ox + x) % 6 < 3 ? PALETTE.D : PALETTE.m;
      for (const y of [0, 1, 2, 3]) c.set(ox + x, y, y === 3 ? PALETTE.o : bandTop);
      for (const y of [28, 29, 30, 31]) c.set(ox + x, y, y === 28 ? PALETTE.o : bandBottom);
    }
    // opening: rows 4..27, stone jambs on the outer columns
    for (let y = 4; y < 28; y++) {
      c.set(ox, y, PALETTE.o);
      c.set(ox + 15, y, PALETTE.o);
      for (let x = 1; x < 15; x++) c.set(ox + x, y, PALETTE.d);
    }
    // wooden leaf swings inward: full-width when closed, sliver when open
    const LEAF_RIGHT: Record<DoorState, number> = { closed: 14, ajar: 8, open: 2 };
    const leafRight = LEAF_RIGHT[state];
    for (let y = 4; y < 28; y++) {
      for (let x = 1; x <= leafRight; x++) {
        const plank = (x - 1) % 3 === 2 ? PALETTE.w : PALETTE.W;
        c.set(ox + x, y, plank);
      }
      if (leafRight < 14) c.set(ox + leafRight + 1, y, PALETTE.o); // leaf edge
    }
    // iron bands + handle on the closed leaf
    if (state === 'closed') {
      for (let x = 1; x <= 14; x++) {
        c.set(ox + x, 9, PALETTE.K);
        c.set(ox + x, 22, PALETTE.K);
      }
      c.set(ox + 12, 15, PALETTE.G);
      c.set(ox + 12, 16, PALETTE.G);
    }
    if (state === 'open') {
      // faint glow from inside the room
      for (let y = 6; y < 26; y++) c.set(ox + 13, y, PALETTE.g);
      for (let y = 10; y < 22; y++) c.set(ox + 12, y, PALETTE.g);
      c.set(ox + 13, 8, PALETTE.A);
      c.set(ox + 13, 24, PALETTE.A);
    }
  };
  drawDoor(0, 'closed');
  drawDoor(16, 'ajar');
  drawDoor(32, 'open');
  return c;
}

// ---------------------------------------------------------------------------
// torch - four 8x20 frames side by side (unlit + 3-frame flicker)
// ---------------------------------------------------------------------------

const TORCH_FRAMES = [
  [
    '........',
    '........',
    '........',
    '........',
    '........',
    '........',
    '........',
    '........',
    '...oo...',
    '..oddo..',
    '..oddo..',
    '...oo...',
    '..oWWo..',
    '..oWWo..',
    '..oWWo..',
    '.oMMMMo.',
    '.oMDDMo.',
    '..oMMo..',
    '...oo...',
    '........',
  ],
  [
    '........',
    '...oo...',
    '..oYYo..',
    '..oYYo..',
    '.oYYOYo.',
    '.oYOOYo.',
    '.oOOZOo.',
    '..oZZo..',
    '...oo...',
    '..oOOo..',
    '..oOOo..',
    '...oo...',
    '..oWWo..',
    '..oWWo..',
    '..oWWo..',
    '.oMMMMo.',
    '.oMDDMo.',
    '..oMMo..',
    '...oo...',
    '........',
  ],
  [
    '...oo...',
    '..oYYo..',
    '.oYYYYo.',
    '.oYOYYo.',
    '.oYOOYo.',
    '.oOOZOo.',
    '.oOZZOo.',
    '..oZZo..',
    '...oo...',
    '..oOOo..',
    '..oOOo..',
    '...oo...',
    '..oWWo..',
    '..oWWo..',
    '..oWWo..',
    '.oMMMMo.',
    '.oMDDMo.',
    '..oMMo..',
    '...oo...',
    '........',
  ],
  [
    '........',
    '...oo...',
    '..oYYo..',
    '.oYYYOo.',
    '.oYYOYo.',
    '.oYOOOo.',
    '.oOZZOo.',
    '..oZZo..',
    '...oo...',
    '..oOOo..',
    '..oOOo..',
    '...oo...',
    '..oWWo..',
    '..oWWo..',
    '..oWWo..',
    '.oMMMMo.',
    '.oMDDMo.',
    '..oMMo..',
    '...oo...',
    '........',
  ],
];

function buildTorch(): Canvas {
  const c = new Canvas(32, 20);
  TORCH_FRAMES.forEach((frame, i) => c.paste(frame, i * 8, 0));
  return c;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const OUT_DIR = path.join(import.meta.dir, '../src/assets/pixel-art/dungeon');
const previewFlagIdx = process.argv.indexOf('--preview');
const previewDir = previewFlagIdx > -1 ? process.argv[previewFlagIdx + 1] : undefined;

mkdirSync(OUT_DIR, { recursive: true });
if (previewDir) mkdirSync(previewDir, { recursive: true });

const assets: Record<string, Canvas> = {
  'wizard-walk.png': buildWizardSheet(),
  'corridor-tile.png': buildCorridorTile(),
  'corridor-tile-h.png': buildCorridorTileH(),
  'corridor-elbow.png': buildCorridorElbowNE(),
  'corridor-elbow-nw.png': buildCorridorElbowNW(),
  'corridor-elbow-se.png': buildCorridorElbowSE(),
  'corridor-elbow-sw.png': buildCorridorElbowSW(),
  'corridor-end.png': buildCorridorEnd(),
  'corridor-end-w.png': buildCorridorEndW(),
  'room-border.png': buildRoomBorder(),
  'door.png': buildDoor(),
  'torch.png': buildTorch(),
};

// assets ship pre-scaled 2x so the browser never scales them
// (image-rendering: pixelated is not reliably applied to border-image)
for (const [name, canvas] of Object.entries(assets)) {
  const scaled = canvas.upscale(2);
  const png = scaled.toPng();
  writeFileSync(path.join(OUT_DIR, name), png);
  console.log(`wrote ${name} (${scaled.width}x${scaled.height}, ${png.length} bytes)`);
  if (previewDir) {
    writeFileSync(path.join(previewDir, name.replace('.png', '@8x.png')), canvas.upscale(8).toPng());
  }
}
