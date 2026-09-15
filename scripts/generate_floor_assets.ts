/**
 * Generate occupancy assets for the legacy 1st_floor map without changing
 * the active yard map constants used by the FMS runtime.
 *
 * bun run maps:floor-assets
 */
import { inflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLAN_INFLATE_PX, PIXEL_CM, FREE_LUMA_THRESHOLD } from "../shared/constants.ts";

type Png = { width: number; height: number; pixels: Uint8Array };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(data: Uint8Array): Png {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idats: Uint8Array[] = [];
  let offset = 8;
  while (offset + 12 <= data.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
    if (type === "IHDR") {
      const h = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      width = h.getUint32(0);
      height = h.getUint32(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
    } else if (type === "IDAT") idats.push(chunk);
    else if (type === "IEND") break;
  }
  if (bitDepth !== 8 || colorType !== 6) throw new Error("expected 8-bit RGBA PNG");

  const raw = inflateSync(Buffer.concat(idats.map((x) => Buffer.from(x))));
  const stride = width * 4;
  const pixels = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = Uint8Array.from(raw.subarray(src, src + stride));
    src += stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? row[x - 4] : 0;
      const up = previous[x];
      const upLeft = x >= 4 ? previous[x - 4] : 0;
      if (filter === 1) row[x] = (row[x] + left) & 255;
      else if (filter === 2) row[x] = (row[x] + up) & 255;
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) row[x] = (row[x] + paeth(left, up, upLeft)) & 255;
      else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
    }
    pixels.set(row, y * stride);
    previous.set(row);
  }
  return { width, height, pixels };
}

function inflate(occ: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(occ.length);
  const r2 = radius * radius;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let safe = true;
      for (let dy = -radius; dy <= radius && safe; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > r2) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height || occ[ny * width + nx] !== 1) {
            safe = false;
            break;
          }
        }
      }
      out[y * width + x] = safe ? 1 : 0;
    }
  }
  return out;
}

const root = new URL("../resources/maps/", import.meta.url).pathname;
const source = join(root, "1st_floor.png");
const png = decodePng(new Uint8Array(await Bun.file(source).bytes()));
const occupancy = new Uint8Array(png.width * png.height);
for (let i = 0; i < occupancy.length; i++) {
  const p = i * 4;
  occupancy[i] = (png.pixels[p] + png.pixels[p + 1] + png.pixels[p + 2]) / 3 >= FREE_LUMA_THRESHOLD ? 1 : 0;
}
const inflated = inflate(occupancy, png.width, png.height, PLAN_INFLATE_PX);
writeFileSync(join(root, "1st_floor.occupancy.bin"), occupancy);
writeFileSync(join(root, "1st_floor.occupancy_inflated.bin"), inflated);
writeFileSync(join(root, "1st_floor.occupancy.json"), JSON.stringify({
  width: png.width,
  height: png.height,
  threshold: FREE_LUMA_THRESHOLD,
  inflateRadiusPx: PLAN_INFLATE_PX,
  freePixelCm: PIXEL_CM,
  source: "1st_floor.png",
}, null, 2) + "\n");
console.log(`1st_floor ${png.width}x${png.height} assets written`);
