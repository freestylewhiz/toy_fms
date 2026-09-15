import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FREE_LUMA_THRESHOLD,
  MAP_HEIGHT,
  MAP_WIDTH,
  PLAN_INFLATE_PX,
  ROBOT_LENGTH_PX,
  ROBOT_WIDTH_PX,
} from "./constants.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const RESOURCES_DIR = join(here, "../resources");
export const MAP_PNG_PATH = join(RESOURCES_DIR, "maps/yard.png");
export const OCCUPANCY_PATH = join(RESOURCES_DIR, "maps/occupancy.bin");
export const OCCUPANCY_INFLATED_PATH = join(RESOURCES_DIR, "maps/occupancy_inflated.bin");
export const OCCUPANCY_JSON_PATH = join(RESOURCES_DIR, "maps/occupancy.json");
export const SEED_PATH = join(RESOURCES_DIR, "maps/seed.json");

export type Seed = {
  waypoints: { id: string; x: number; y: number; theta: number }[];
  chargingStations: { id: string; x: number; y: number; theta: number }[];
  robots: { id: string; x: number; y: number; theta: number; status: string; sprite: string }[];
};

let occ: Uint8Array | null = null;

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

export function setExtraBlocked(grid: Uint8Array | null): void {
  extraBlocked = grid;
}

export function isPlanFree(x: number, y: number): boolean {
  if (!isInflatedFree(x, y)) return false;
  if (!extraBlocked) return true;
  const ix = Math.round(x);
  const iy = Math.round(y);
  return extraBlocked[iy * MAP_WIDTH + ix] !== 1;
}
