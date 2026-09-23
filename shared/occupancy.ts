import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FREE_LUMA_THRESHOLD,
  ACTIVE_MAP,
  MAP_HEIGHT,
  MAP_WIDTH,
  PLAN_INFLATE_PX,
  ROBOT_LENGTH_PX,
  ROBOT_WIDTH_PX,
  switchActiveMap,
} from "./constants.ts";
import { runtimeMap } from "./maps.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const RESOURCES_DIR = join(here, "../resources");
export let MAP_PNG_PATH = join(RESOURCES_DIR, 'maps', `${ACTIVE_MAP.image}`);
export let OCCUPANCY_PATH = join(RESOURCES_DIR, 'maps', `${ACTIVE_MAP.prefix}occupancy.bin`);
export let OCCUPANCY_INFLATED_PATH = join(RESOURCES_DIR, 'maps', `${ACTIVE_MAP.prefix}occupancy_inflated.bin`);
export let OCCUPANCY_JSON_PATH = join(RESOURCES_DIR, 'maps', `${ACTIVE_MAP.prefix}occupancy.json`);
export let SEED_PATH = join(RESOURCES_DIR, 'maps', `${ACTIVE_MAP.prefix}seed.json`);

export type Seed = {
  waypoints: { id: string; x: number; y: number; theta: number }[];
  chargingStations: { id: string; x: number; y: number; theta: number }[];
  robots: { id: string; x: number; y: number; theta: number; status: string; sprite: string }[];
};

let occ: Uint8Array | null = null;

export type MapContext = { id: string; width: number; height: number; occupancy: Uint8Array; inflated: Uint8Array };

/** Read and validate a destination context without changing the active map. */
export function prepareMapContext(id: string): MapContext {
  const map = runtimeMap(id);
  const occupancyPath = join(RESOURCES_DIR, 'maps', `${map.prefix}occupancy.bin`);
  const inflatedPath = join(RESOURCES_DIR, 'maps', `${map.prefix}occupancy_inflated.bin`);
  const raw = new Uint8Array(readFileSync(occupancyPath));
  if (raw.length !== map.width * map.height) throw new Error(`occupancy.bin size ${raw.length}, expected ${map.width * map.height}`);
  let inflated: Uint8Array;
  if (existsSync(inflatedPath)) {
    const value = new Uint8Array(readFileSync(inflatedPath));
    if (value.length !== map.width * map.height) throw new Error(`inflated occupancy size ${value.length}, expected ${map.width * map.height}`);
    inflated = value;
  } else throw new Error(`missing inflated occupancy asset for ${map.id}`);
  return { id: map.id, width: map.width, height: map.height, occupancy: raw, inflated };
}

export function commitMapContext(context: MapContext): void {
  const current = runtimeMap(context.id);
  switchActiveMap(current.id);
  MAP_PNG_PATH = join(RESOURCES_DIR, 'maps', current.image);
  OCCUPANCY_PATH = join(RESOURCES_DIR, 'maps', `${current.prefix}occupancy.bin`);
  OCCUPANCY_INFLATED_PATH = join(RESOURCES_DIR, 'maps', `${current.prefix}occupancy_inflated.bin`);
  OCCUPANCY_JSON_PATH = join(RESOURCES_DIR, 'maps', `${current.prefix}occupancy.json`);
  SEED_PATH = join(RESOURCES_DIR, 'maps', `${current.prefix}seed.json`);
  occ = context.occupancy;
  inflatedCache = context.inflated;
  extraBlocked = null;
  extraBlockedRevision++;
}

export function switchMapContext(id: string): void { commitMapContext(prepareMapContext(id)); }

export function loadOccupancy(): Uint8Array {
  if (occ) return occ;
  const buf = readFileSync(OCCUPANCY_PATH);
  if (buf.length !== MAP_WIDTH * MAP_HEIGHT) {
    throw new Error(`occupancy.bin size ${buf.length}, expected ${MAP_WIDTH * MAP_HEIGHT}`);
  }
  occ = new Uint8Array(buf);
  return occ;
}

export function loadSeed(): Seed {
  return JSON.parse(readFileSync(SEED_PATH, "utf8")) as Seed;
}

export function isFree(x: number, y: number, grid = loadOccupancy()): boolean {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= MAP_WIDTH || iy >= MAP_HEIGHT) return false;
  return grid[iy * MAP_WIDTH + ix] === 1;
}

export function isFreeLumaFallback(_luma: number): boolean {
  return _luma >= FREE_LUMA_THRESHOLD;
}

/** Disk inflate: a cell is safe iff all pixels within radius r are free. */
export function buildInflated(radius = PLAN_INFLATE_PX, grid = loadOccupancy()): Uint8Array {
  const out = new Uint8Array(MAP_WIDTH * MAP_HEIGHT);
  const r2 = radius * radius;
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      let ok = true;
      for (let dy = -radius; dy <= radius && ok; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > r2) continue;
          if (!isFree(x + dx, y + dy, grid)) {
            ok = false;
            break;
          }
        }
      }
      out[y * MAP_WIDTH + x] = ok ? 1 : 0;
    }
  }
  return out;
}

function robotCorners(cx: number, cy: number, theta: number): [number, number][] {
  const hl = ROBOT_LENGTH_PX / 2;
  const hw = ROBOT_WIDTH_PX / 2;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  // theta 0 = +x. Image y is down; world y-up would use -sin on y.
  // Map y grows down, so rotation in pixel space: x' = c*x - s*y, y' = s*x + c*y
  const local: [number, number][] = [
    [hl, hw],
    [hl, -hw],
    [-hl, hw],
    [-hl, -hw],
  ];
  return local.map(([lx, ly]) => [cx + c * lx - s * ly, cy + s * lx + c * ly]);
}

export function robotFootprintClear(cx: number, cy: number, theta: number, grid = loadOccupancy()): boolean {
  const corners = robotCorners(cx, cy, theta);
  for (const [x, y] of corners) {
    if (!isFree(x, y, grid)) return false;
  }
  // edge samples
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[(i + 1) % 4];
    for (let t = 0; t <= 4; t++) {
      const u = t / 4;
      if (!isFree(ax + (bx - ax) * u, ay + (by - ay) * u, grid)) return false;
    }
  }
  return isFree(cx, cy, grid);
}

let inflatedCache: Uint8Array | null = null;
export function inflatedGrid(): Uint8Array {
  if (inflatedCache) return inflatedCache;
  if (existsSync(OCCUPANCY_INFLATED_PATH)) {
    const buf = readFileSync(OCCUPANCY_INFLATED_PATH);
    if (buf.length === MAP_WIDTH * MAP_HEIGHT) {
      inflatedCache = new Uint8Array(buf);
      return inflatedCache;
    }
  }
  inflatedCache = buildInflated();
  return inflatedCache;
}

export function isInflatedFree(x: number, y: number): boolean {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= MAP_WIDTH || iy >= MAP_HEIGHT) return false;
  return inflatedGrid()[iy * MAP_WIDTH + ix] === 1;
}

let extraBlocked: Uint8Array | null = null;
let extraBlockedRevision = 0;

export function setExtraBlocked(grid: Uint8Array | null): void {
  if (grid && grid.length !== MAP_WIDTH * MAP_HEIGHT) {
    throw new Error(`extra blocked mask size ${grid.length}, expected ${MAP_WIDTH * MAP_HEIGHT}`);
  }
  extraBlocked = grid;
  extraBlockedRevision++;
}

/** Current dynamic mask and a monotonically increasing refresh token. */
export function extraBlockedState(): { grid: Uint8Array | null; revision: number } {
  return { grid: extraBlocked, revision: extraBlockedRevision };
}

export function isPlanFree(x: number, y: number): boolean {
  if (!isInflatedFree(x, y)) return false;
  if (!extraBlocked) return true;
  const ix = Math.round(x);
  const iy = Math.round(y);
  return extraBlocked[iy * MAP_WIDTH + ix] !== 1;
}
