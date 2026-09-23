import { deflateSync } from "node:zlib";

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const t = new TextEncoder().encode(type);
  const body = new Uint8Array(4 + data.length);
  body.set(t, 0);
  body.set(data, 4);
  const out = new Uint8Array(12 + data.length);
  out.set(u32(data.length), 0);
  out.set(body, 4);
  out.set(u32(crc32(body)), 8 + data.length);
  return out;
}

/** Grayscale map PNG avoids a 400 MB RGBA intermediate for 100M cells. */
export function encodeOccupancyPng(width: number, height: number, grid: Uint8Array): Uint8Array {
  if (grid.length !== width * height) throw new Error("Invalid occupancy size");
  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width + 1) + 1;
    for (let x = 0; x < width; x++) raw[row + x] = grid[y * width + x] ? 248 : 28;
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header[8] = 8;
  const parts = [new Uint8Array([137,80,78,71,13,10,26,10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const output = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const part of parts) { output.set(part, at); at += part.length; }
  return output;
}

/** 8-bit RGBA PNG, filter 0. */
export function encodePngRgba(width: number, height: number, pixels: Uint8Array): Uint8Array {
  if (pixels.length !== width * height * 4) {
    throw new Error(`pixels ${pixels.length}, expected ${width * height * 4}`);
  }
  const stride = width * 4;
  const raw = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const o = y * (1 + stride);
    raw[o] = 0;
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), o + 1);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
