/**
 * 1st_floor.png → occupancy.bin / occupancy_inflated.bin / occupancy.json
 *
 * occupancy: luma >= FREE_LUMA_THRESHOLD 인 픽셀만 free(1)
 * inflated: 반경 PLAN_INFLATE_PX 디스크 안이 전부 free여야 로봇 안전(1)
 *
 * bun run scripts/generate_occupancy.ts
 */
import { writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import {
  FREE_LUMA_THRESHOLD,
  MAP_HEIGHT,
  MAP_WIDTH,
  PIXEL_CM,
  PLAN_INFLATE_PX,
} from "../shared/constants.ts";
import {
  buildInflated,
  MAP_PNG_PATH,
  OCCUPANCY_INFLATED_PATH,
  OCCUPANCY_JSON_PATH,
  OCCUPANCY_PATH,
} from "../shared/occupancy.ts";

type PngRgba = { width: number; height: number; pixels: Uint8Array };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePngRgba(data: Uint8Array): PngRgba {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (data[i] !== sig[i]) throw new Error("not a PNG");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idats: Uint8Array[] = [];
  let offset = 8;

  while (offset + 12 <= data.length) {
    const view = new DataView(data.buffer, data.byteOffset + offset, 8);
    const len = view.getUint32(0);
    const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
    const chunk = data.subarray(offset + 8, offset + 8 + len);
    offset += 12 + len;
    if (type === "IHDR") {
      const ihdr = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      width = ihdr.getUint32(0);
      height = ihdr.getUint32(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
    } else if (type === "IDAT") {
      idats.push(chunk);
    } else if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`expected 8-bit RGBA PNG, got bitDepth=${bitDepth} colorType=${colorType}`);
  }

  const raw = inflateSync(Buffer.concat(idats.map((c) => Buffer.from(c))));
  const bpp = 4;
  const stride = width * bpp;
  const pixels = new Uint8Array(width * height * 4);
  let src = 0;
  const prev = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = Uint8Array.from(raw.subarray(src, src + stride));
    src += stride;
    if (filter === 1) {
      for (let x = 0; x < stride; x++) {
        row[x] = (row[x] + (x >= bpp ? row[x - bpp] : 0)) & 255;
      }
    } else if (filter === 2) {
      for (let x = 0; x < stride; x++) row[x] = (row[x] + prev[x]) & 255;
    } else if (filter === 3) {
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? row[x - bpp] : 0;
        row[x] = (row[x] + ((a + prev[x]) >> 1)) & 255;
      }
    } else if (filter === 4) {
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? row[x - bpp] : 0;
        const c = x >= bpp ? prev[x - bpp] : 0;
        row[x] = (row[x] + paeth(a, prev[x], c)) & 255;
      }
    } else if (filter !== 0) {
      throw new Error(`unsupported PNG filter ${filter}`);
    }
    pixels.set(row, y * stride);
    prev.set(row);
  }

  return { width, height, pixels };
}

function occupancyFromRgba(png: PngRgba, threshold: number): Uint8Array {
  const { width, height, pixels } = png;
  const occ = new Uint8Array(width * height);
  for (let i = 0; i < occ.length; i++) {
    const o = i * 4;
    const luma = (pixels[o] + pixels[o + 1] + pixels[o + 2]) / 3;
    occ[i] = luma >= threshold ? 1 : 0;
  }
  return occ;
}

async function main(): Promise<void> {
  const png = decodePngRgba(new Uint8Array(await Bun.file(MAP_PNG_PATH).bytes()));
  if (png.width !== MAP_WIDTH || png.height !== MAP_HEIGHT) {
    throw new Error(`map size ${png.width}x${png.height}, expected ${MAP_WIDTH}x${MAP_HEIGHT}`);
  }

  const occ = occupancyFromRgba(png, FREE_LUMA_THRESHOLD);
  const inflated = buildInflated(PLAN_INFLATE_PX, occ);
  const free = occ.reduce((s, v) => s + v, 0);
  const safe = inflated.reduce((s, v) => s + v, 0);

  writeFileSync(OCCUPANCY_PATH, occ);
  writeFileSync(OCCUPANCY_INFLATED_PATH, inflated);
  writeFileSync(
    OCCUPANCY_JSON_PATH,
    JSON.stringify(
      {
        width: MAP_WIDTH,
        height: MAP_HEIGHT,
        threshold: FREE_LUMA_THRESHOLD,
        inflateRadiusPx: PLAN_INFLATE_PX,
        freePixelCm: PIXEL_CM,
        freeCells: free,
        inflatedFreeCells: safe,
        source: "1st_floor.png",
        note: "1=free(white), 0=blocked. inflated = disk inflate for robot clearance.",
      },
      null,
      2,
    ) + "\n",
  );

  console.log(`occupancy.bin          free ${free}/${occ.length}  (${((free / occ.length) * 100).toFixed(1)}%)`);
  console.log(`occupancy_inflated.bin safe ${safe}/${inflated.length}  r=${PLAN_INFLATE_PX}px`);
  console.log(`wrote`);
  console.log(`  ${OCCUPANCY_PATH}`);
  console.log(`  ${OCCUPANCY_INFLATED_PATH}`);
  console.log(`  ${OCCUPANCY_JSON_PATH}`);
}

await main();
