#!/usr/bin/env node
/**
 * 앱 아이콘 생성기 — 외부 라이브러리 없이 PNG 를 직접 그립니다.
 *   public/icons/icon-192.png, icon-512.png, maskable-512.png, apple-touch-icon.png
 *
 *  흰색 장바구니 글리프 + 보라색 그라데이션 배경. 4배 슈퍼샘플링으로 가장자리를 부드럽게 만듭니다.
 *
 *  ⚠️ v2.3.6 부터 실제 홈 화면 아이콘은 파스텔 바구니 그림(v2.3.7 부터 연보라 배경)입니다.
 *     이 스크립트를 실행하면 그 그림이 옛 보라색 장바구니로 되돌아갑니다.
 *     정말 되돌리려면 `node scripts/make-icons.mjs --force` 로 실행하세요.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--force')) {
  console.error(
    '[make-icons] v2.3.6 부터 아이콘은 파스텔 그림입니다. 실행하면 그 그림을 덮어씁니다.\n' +
      '[make-icons] 정말 옛 보라색 아이콘으로 되돌리려면 --force 를 붙여 실행하세요.'
  );
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'public', 'icons');

/* ─────────────── PNG 인코더 ─────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ─────────────── 그리기 ─────────────── */

class Canvas {
  constructor(size) {
    this.size = size;
    this.data = new Float32Array(size * size * 4); // r,g,b,a (0..255)
  }

  blend(x, y, [r, g, b], a = 1) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size || a <= 0) return;
    const i = (y * this.size + x) * 4;
    const d = this.data;
    const sa = Math.min(1, a);
    const da = d[i + 3] / 255;
    const outA = sa + da * (1 - sa);
    if (outA <= 0) return;
    d[i] = (r * sa + d[i] * da * (1 - sa)) / outA;
    d[i + 1] = (g * sa + d[i + 1] * da * (1 - sa)) / outA;
    d[i + 2] = (b * sa + d[i + 2] * da * (1 - sa)) / outA;
    d[i + 3] = outA * 255;
  }

  /** 전체 배경 그라데이션 */
  gradient(from, to) {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        const t = (x / this.size) * 0.35 + (y / this.size) * 0.65;
        const r = from[0] + (to[0] - from[0]) * t;
        const g = from[1] + (to[1] - from[1]) * t;
        const b = from[2] + (to[2] - from[2]) * t;
        const i = (y * this.size + x) * 4;
        this.data[i] = r;
        this.data[i + 1] = g;
        this.data[i + 2] = b;
        this.data[i + 3] = 255;
      }
    }
  }

  circle(cx, cy, radius, color, alpha = 1) {
    const r2 = radius * radius;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(this.size - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(this.size - 1, Math.ceil(cy + radius));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) this.blend(x, y, color, alpha);
      }
    }
  }

  roundRect(x, y, w, h, radius, color, alpha = 1) {
    const r = Math.min(radius, w / 2, h / 2);
    for (let py = Math.max(0, Math.floor(y)); py <= Math.min(this.size - 1, Math.ceil(y + h)); py += 1) {
      for (let px = Math.max(0, Math.floor(x)); px <= Math.min(this.size - 1, Math.ceil(x + w)); px += 1) {
        const cx = px + 0.5;
        const cy = py + 0.5;
        if (cx < x || cx > x + w || cy < y || cy > y + h) continue;
        const nearestX = Math.min(Math.max(cx, x + r), x + w - r);
        const nearestY = Math.min(Math.max(cy, y + r), y + h - r);
        const dx = cx - nearestX;
        const dy = cy - nearestY;
        if (dx * dx + dy * dy <= r * r + 0.0001) this.blend(px, py, color, alpha);
      }
    }
  }

  polygon(points, color, alpha = 1) {
    const ys = points.map((p) => p[1]);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(this.size - 1, Math.ceil(Math.max(...ys)));
    for (let py = y0; py <= y1; py += 1) {
      const cy = py + 0.5;
      const xs = [];
      for (let i = 0; i < points.length; i += 1) {
        const [ax, ay] = points[i];
        const [bx, by] = points[(i + 1) % points.length];
        if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) {
          xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xa = Math.max(0, Math.ceil(xs[i] - 0.5));
        const xb = Math.min(this.size - 1, Math.floor(xs[i + 1] - 0.5));
        for (let px = xa; px <= xb; px += 1) this.blend(px, py, color, alpha);
      }
    }
  }

  /** 굵기가 있는 선분 (양끝 둥글게) */
  segment(x1, y1, x2, y2, width, color, alpha = 1) {
    const r = width / 2;
    const minX = Math.max(0, Math.floor(Math.min(x1, x2) - r));
    const maxX = Math.min(this.size - 1, Math.ceil(Math.max(x1, x2) + r));
    const minY = Math.max(0, Math.floor(Math.min(y1, y2) - r));
    const maxY = Math.min(this.size - 1, Math.ceil(Math.max(y1, y2) + r));
    const vx = x2 - x1;
    const vy = y2 - y1;
    const len2 = vx * vx + vy * vy || 1;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5 - x1;
        const py = y + 0.5 - y1;
        let t = (px * vx + py * vy) / len2;
        t = Math.max(0, Math.min(1, t));
        const dx = px - vx * t;
        const dy = py - vy * t;
        if (dx * dx + dy * dy <= r * r + 0.0001) this.blend(x, y, color, alpha);
      }
    }
  }

  downsample(factor) {
    const outSize = this.size / factor;
    const out = Buffer.alloc(outSize * outSize * 4);
    const n = factor * factor;
    for (let y = 0; y < outSize; y += 1) {
      for (let x = 0; x < outSize; x += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let dy = 0; dy < factor; dy += 1) {
          for (let dx = 0; dx < factor; dx += 1) {
            const i = ((y * factor + dy) * this.size + (x * factor + dx)) * 4;
            r += this.data[i];
            g += this.data[i + 1];
            b += this.data[i + 2];
            a += this.data[i + 3];
          }
        }
        const o = (y * outSize + x) * 4;
        out[o] = Math.round(r / n);
        out[o + 1] = Math.round(g / n);
        out[o + 2] = Math.round(b / n);
        out[o + 3] = Math.round(a / n);
      }
    }
    return { size: outSize, data: out };
  }
}

/* ─────────────── 아이콘 그리기 ─────────────── */

const WHITE = [255, 255, 255];
const PURPLE_TOP = [124, 31, 162]; // #7C1FA2
const PURPLE_BOTTOM = [74, 0, 102]; // #4A0066

/**
 * @param {number} size 최종 픽셀 크기
 * @param {number} scale 글리프 배율 (maskable 은 작게)
 */
function drawIcon(size, glyphScale = 1) {
  const SS = 4;
  const canvas = new Canvas(size * SS);
  canvas.gradient(PURPLE_TOP, PURPLE_BOTTOM);

  // 부드러운 하이라이트 (왼쪽 위) — 거리 기반 감쇠로 가장자리가 보이지 않게
  const S0 = canvas.size;
  const hx = S0 * 0.26;
  const hy = S0 * 0.18;
  const hr = S0 * 0.62;
  for (let y = 0; y < S0; y += 1) {
    for (let x = 0; x < S0; x += 1) {
      const dx = x - hx;
      const dy = y - hy;
      const t = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / hr);
      const a = t * t * 0.16;
      if (a <= 0) continue;
      const i = (y * S0 + x) * 4;
      canvas.data[i] += (255 - canvas.data[i]) * a;
      canvas.data[i + 1] += (255 - canvas.data[i + 1]) * a;
      canvas.data[i + 2] += (255 - canvas.data[i + 2]) * a;
    }
  }

  const S = canvas.size;
  const c = S / 2;
  // 글리프 좌표계: 0..1 을 글리프 배율만큼 줄여 중앙에 놓습니다.
  const g = (v) => c + (v - 0.5) * S * glyphScale;
  const u = (v) => v * S * glyphScale;

  // 장바구니 손잡이
  canvas.segment(g(0.2), g(0.29), g(0.34), g(0.29), u(0.055), WHITE);
  canvas.segment(g(0.34), g(0.29), g(0.4), g(0.39), u(0.055), WHITE);

  // 바구니 위쪽 테두리
  canvas.roundRect(g(0.19), g(0.36), u(0.66), u(0.075), u(0.037), WHITE);

  // 바구니 몸통 (아래로 살짝 좁아지는 사다리꼴)
  canvas.polygon(
    [
      [g(0.225), g(0.435)],
      [g(0.815), g(0.435)],
      [g(0.735), g(0.72)],
      [g(0.305), g(0.72)],
    ],
    WHITE
  );

  // 바구니 안쪽 홈 (보라색 두 줄 — 담긴 물건 느낌)
  canvas.roundRect(g(0.32), g(0.51), u(0.1), u(0.045), u(0.022), PURPLE_BOTTOM, 0.5);
  canvas.roundRect(g(0.47), g(0.51), u(0.1), u(0.045), u(0.022), PURPLE_BOTTOM, 0.5);
  canvas.roundRect(g(0.62), g(0.51), u(0.1), u(0.045), u(0.022), PURPLE_BOTTOM, 0.5);

  // 바퀴
  canvas.circle(g(0.395), g(0.8), u(0.062), WHITE);
  canvas.circle(g(0.675), g(0.8), u(0.062), WHITE);

  const small = canvas.downsample(SS);
  return encodePng(small.size, small.size, small.data);
}

/* ─────────────── 저장 ─────────────── */

fs.mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['apple-touch-icon.png', 180, 1],
  ['maskable-512.png', 512, 0.72],
];

for (const [name, size, scale] of targets) {
  const png = drawIcon(size, scale);
  fs.writeFileSync(path.join(OUT_DIR, name), png);
  console.log(`✓ ${name} (${size}×${size}, ${(png.length / 1024).toFixed(1)}KB)`);
}
