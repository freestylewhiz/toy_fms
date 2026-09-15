/**
 * 테스트 야드 맵: 큰 직사각 홀 + 좁은 복도 하나 + 십자 교차로.
 * occupancy.bin / inflated / yard.png / occupancy.json 을 같이 쓴다.
 *
 * bun run scripts/generate_yard_map.ts
 */
import { writeFileSync } from "node:fs";
import { MAP_HEIGHT, MAP_WIDTH, PIXEL_CM, PLAN_INFLATE_PX } from "../shared/constants.ts";
import { MAP_PNG_PATH, OCCUPANCY_INFLATED_PATH, OCCUPANCY_JSON_PATH, OCCUPANCY_PATH } from "../shared/occupancy.ts";
import { encodePngRgba } from "./encode_png.ts";

/** 벽 두께 */
const WALL = 48;
/** 좁은 복도 폭 (px). 1px=5cm → 48px = 2.4m. 로봇 16×10 + inflate 8 이면 1대는 여유, 2대 교행은 빠듯. */
const CORRIDOR_W = 48;

function fill(occ: Uint8Array, x0: number, y0: number, x1: number, y1: number): void {
  const xa = Math.max(0, Math.floor(x0));
  const ya = Math.max(0, Math.floor(y0));
  const xb = Math.min(MAP_WIDTH, Math.ceil(x1));
  const yb = Math.min(MAP_HEIGHT, Math.ceil(y1));
  for (let y = ya; y < yb; y++) {
    const row = y * MAP_WIDTH;
    occ.fill(1, row + xa, row + xb);
  }
}

/** 홀(왼쪽) + 가로 복도 + 세로 복도 → 십자 교차. */
export function buildYardOccupancy(): Uint8Array {
  const occ = new Uint8Array(MAP_WIDTH * MAP_HEIGHT);

  const hallX0 = WALL;
  const hallY0 = WALL;
  const hallX1 = Math.floor(MAP_WIDTH * 0.55);
  const hallY1 = MAP_HEIGHT - WALL;
  fill(occ, hallX0, hallY0, hallX1, hallY1);

  const hMid = Math.floor(MAP_HEIGHT / 2);
  const h0 = hMid - Math.floor(CORRIDOR_W / 2);
  const h1 = h0 + CORRIDOR_W;
  fill(occ, hallX1 - 4, h0, MAP_WIDTH - WALL, h1);

  const vMid = Math.floor(MAP_WIDTH * 0.78);
  const v0 = vMid - Math.floor(CORRIDOR_W / 2);
  const v1 = v0 + CORRIDOR_W;
  fill(occ, v0, WALL, v1, MAP_HEIGHT - WALL);

  return occ;
}

function inflateDisk(occ: Uint8Array, radius: number): Uint8Array {
  const out = new Uint8Array(occ);
  const r2 = radius * radius;
  const offs: number[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= r2) offs.push(dy, dx);
    }
  }
  for (let y = 0; y < MAP_HEIGHT; y++) {
    const row = y * MAP_WIDTH;
    for (let x = 0; x < MAP_WIDTH; x++) {
      if (occ[row + x] === 1) continue;
      for (let i = 0; i < offs.length; i += 2) {
        const ny = y + offs[i];
        const nx = x + offs[i + 1];
        if (nx < 0 || ny < 0 || nx >= MAP_WIDTH || ny >= MAP_HEIGHT) continue;
        out[ny * MAP_WIDTH + nx] = 0;
      }
    }
  }
  return out;
}
function occupancyToRgba(occ: Uint8Array): Uint8Array {
  const px = new Uint8Array(MAP_WIDTH * MAP_HEIGHT * 4);
  for (let i = 0; i < occ.length; i++) {
    const o = i * 4;
    if (occ[i] === 1) {
      px[o] = 244;
      px[o + 1] = 246;
      px[o + 2] = 248;
      px[o + 3] = 255;
    } else {
      const x = i % MAP_WIDTH;
      const y = Math.floor(i / MAP_WIDTH);
      const hatch = ((x >> 3) + (y >> 3)) & 1;
      px[o] = hatch ? 36 : 28;
      px[o + 1] = hatch ? 44 : 35;
      px[o + 2] = hatch ? 58 : 48;
      px[o + 3] = 255;
    }
  }
  return px;
}

function main(): void {
  if (MAP_WIDTH < 1200 || MAP_HEIGHT < 900) {
    throw new Error(`yard map expects large canvas, got ${MAP_WIDTH}x${MAP_HEIGHT}`);
  }
  const occ = buildYardOccupancy();
  const inflated = inflateDisk(occ, PLAN_INFLATE_PX);
  const rgba = occupancyToRgba(occ);
  const png = encodePngRgba(MAP_WIDTH, MAP_HEIGHT, rgba);
  const free = occ.reduce((s, v) => s + v, 0);
  const safe = inflated.reduce((s, v) => s + v, 0);

  writeFileSync(OCCUPANCY_PATH, occ);
  writeFileSync(OCCUPANCY_INFLATED_PATH, inflated);
  writeFileSync(MAP_PNG_PATH, png);
  writeFileSync(
    OCCUPANCY_JSON_PATH,
    JSON.stringify(
      {
        width: MAP_WIDTH,
        height: MAP_HEIGHT,
        threshold: 230,
        inflateRadiusPx: PLAN_INFLATE_PX,
        freePixelCm: PIXEL_CM,
        freeCells: free,
        inflatedFreeCells: safe,
        source: "yard.png",
        corridorWidthPx: CORRIDOR_W,
        wallPx: WALL,
        note: "yard: left hall + 48px corridor + plus intersection. 1=free.",
      },
      null,
      2,
    ) + "\n",
  );

  console.log(`yard ${MAP_WIDTH}x${MAP_HEIGHT}  free ${free}/${occ.length} (${((free / occ.length) * 100).toFixed(1)}%)`);
  console.log(`inflated safe ${safe}  r=${PLAN_INFLATE_PX}`);
  console.log(`wrote ${MAP_PNG_PATH}`);
}

main();
