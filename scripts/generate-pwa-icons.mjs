// Generates the PWA icon set from scratch (no image dependencies):
//   public/icons/icon-{192,512}.png           — rounded-square, purpose "any"
//   public/icons/icon-maskable-{192,512}.png  — full-bleed, safe-zone padded
//   app/apple-icon.png                        — 180px, apple-touch-icon
//
// Design: the app's brand gradient (deep brown #7C2D12 -> orange #F97316,
// diagonal) with a white geometric "K" mark — the same brand palette the
// member dashboard uses.
//
// Run: node scripts/generate-pwa-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- PNG writer ------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function writePng(path, size, pixels /* RGBA Uint8Array */) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // filter 0 per scanline
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    pixels.subarray(y * size * 4, (y + 1) * size * 4).forEach((v, i) => {
      raw[rowStart + 1 + i] = v;
    });
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png);
}

// ---- raster helpers ---------------------------------------------------------
const lerp = (a, b, t) => a + (b - a) * t;
function gradientAt(x, y, n) {
  // diagonal brand gradient #7C2D12 -> #F97316
  const t = Math.min(1, Math.max(0, (x + y) / (2 * (n - 1))));
  return [Math.round(lerp(124, 249, t)), Math.round(lerp(45, 115, t)), Math.round(lerp(18, 22, t))];
}
const insideRounded = (x, y, n, r) => {
  if (x >= r && x < n - r) return true;
  if (y >= r && y < n - r) return true;
  const dx = x < r ? r - x : x - (n - 1 - r);
  const dy = y < r ? r - y : y - (n - 1 - r);
  return dx * dx + dy * dy <= r * r;
};
function fillPolygon(px, pixels, n, poly) {
  // even-odd scanline fill; poly = [[x,y],...] in pixel coordinates
  const ys = poly.map((p) => p[1]);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(n - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    const xs = [];
    for (let i = 0; i < poly.length; i++) {
      const [xa, ya] = poly[i];
      const [xb, yb] = poly[(i + 1) % poly.length];
      if ((ya <= yc && yb > yc) || (yb <= yc && ya > yc)) {
        xs.push(xa + ((yc - ya) / (yb - ya)) * (xb - xa));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let x = Math.max(0, Math.ceil(xs[i])); x <= Math.min(n - 1, Math.floor(xs[i + 1])); x++) {
        const o = (y * n + x) * 4;
        pixels[o] = 255; pixels[o + 1] = 255; pixels[o + 2] = 255; pixels[o + 3] = 255;
      }
    }
  }
}

// ---- the K mark --------------------------------------------------------------
// A geometric K: a stem plus two diagonal strokes of equal width, drawn as
// quads offset perpendicular to the arm direction.
function drawK(pixels, n, glyphH) {
  const cx = n / 2;
  const cy = n / 2;
  const sw = glyphH * 0.235;            // stem width
  const armLen = glyphH * 0.46;         // horizontal reach of arms
  const stroke = glyphH * 0.215;        // arm stroke thickness
  const x0 = cx - armLen * 0.62;        // stem left edge
  const y0 = cy - glyphH / 2;

  // stem
  fillPolygon(0, pixels, n, [
    [x0, y0], [x0 + sw, y0], [x0 + sw, y0 + glyphH], [x0, y0 + glyphH],
  ]);

  const quad = (ax, ay, bx, by) => {
    // stroke from A to B with half-width stroke/2, offset perpendicular
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    const nx = (-dy / len) * (stroke / 2);
    const ny = (dx / len) * (stroke / 2);
    fillPolygon(0, pixels, n, [
      [ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny],
    ]);
  };
  const stemRight = x0 + sw;
  // arms start on the stem's right edge, slightly inside for a clean joint
  const jx = stemRight - sw * 0.1;
  quad(jx, cy, x0 + armLen, y0);                    // upper arm
  quad(jx, cy, x0 + armLen, y0 + glyphH);           // lower arm
}

function renderIcon(n, { maskable }) {
  const pixels = new Uint8Array(n * n * 4);
  const radius = maskable ? 0 : n * 0.225; // maskable icons are full-bleed
  const glyphH = n * (maskable ? 0.44 : 0.52);      // safe zone for maskable
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const o = (y * n + x) * 4;
      const [r, g, b] = gradientAt(x, y, n);
      const inside = radius === 0 || insideRounded(x, y, n, radius);
      pixels[o] = r; pixels[o + 1] = g; pixels[o + 2] = b;
      pixels[o + 3] = inside ? 255 : 0;
    }
  }
  // clip the K to the rounded shape too (non-maskable)
  drawK(pixels, n, glyphH);
  if (radius > 0) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!insideRounded(x, y, n, radius)) {
          const o = (y * n + x) * 4;
          pixels[o + 3] = 0;
        }
      }
    }
  }
  return pixels;
}

const targets = [
  ['public/icons/icon-192.png', 192, false],
  ['public/icons/icon-512.png', 512, false],
  ['public/icons/icon-maskable-192.png', 192, true],
  ['public/icons/icon-maskable-512.png', 512, true],
  ['app/apple-icon.png', 180, true],
];
for (const [rel, size, maskable] of targets) {
  writePng(join(ROOT, rel), size, renderIcon(size, { maskable }));
  console.log('wrote', rel, `${size}x${size}`, maskable ? '(maskable/full-bleed)' : '(any/rounded)');
}
