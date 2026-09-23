import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  commitMapContext,
  isPlanFree,
  prepareMapContext,
  setExtraBlocked,
  type MapContext,
} from "./occupancy.ts";
import { clearSemanticZones, planRoute, setSemanticZones } from "./planner.ts";
import { isSemanticPoseBlocked } from "./semanticNavigation.ts";

const COARSE = 16; // 80cm at the current 5cm source-pixel resolution.
const YARD = prepareMapContext("yard");
const W = YARD.width;
const H = YARD.height;

type P = { x: number; y: number };
type ZoneKind = "forbidden" | "prefer" | "avoid";

const zone = (kind: ZoneKind, polygon: P[], factor?: number) => ({
  id: `${kind}-coarse-test`,
  family: "scene" as const,
  kind,
  name: kind,
  polygon,
  theta: 0,
  factor,
});

function blankContext(): MapContext {
  const occupancy = new Uint8Array(W * H).fill(1);
  const inflated = new Uint8Array(W * H).fill(1);
  // Keep a real map boundary so a detour cannot use an out-of-bounds corner.
  for (let x = 0; x < W; x++) {
    occupancy[x] = inflated[x] = 0;
    occupancy[(H - 1) * W + x] = inflated[(H - 1) * W + x] = 0;
  }
  for (let y = 0; y < H; y++) {
    occupancy[y * W] = inflated[y * W] = 0;
    occupancy[y * W + W - 1] = inflated[y * W + W - 1] = 0;
  }
  return { id: "yard", width: W, height: H, occupancy, inflated };
}

function installBlank(): void {
  commitMapContext(blankContext());
  clearSemanticZones();
  setExtraBlocked(null);
}

function maskWithCells(cells: Array<[number, number, number, number]>): Uint8Array {
  const mask = new Uint8Array(W * H);
  for (const [x0, y0, x1, y1] of cells) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * W + x] = 1;
  }
  return mask;
}

function routeSamples(route: { display: P[] }): P[] {
  const out: P[] = [];
  for (let i = 1; i < route.display.length; i++) {
    const a = route.display[i - 1];
    const b = route.display[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
    for (let step = 0; step <= n; step++) {
      const t = step / n;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

function routeAvoids(route: { display: P[] }, x0: number, y0: number, x1: number, y1: number): boolean {
  return routeSamples(route).every((p) => p.x < x0 || p.x >= x1 || p.y < y0 || p.y >= y1);
}

function routeLength(route: { display: P[] }): number {
  let total = 0;
  for (let i = 1; i < route.display.length; i++) total += Math.hypot(route.display[i].x - route.display[i - 1].x, route.display[i].y - route.display[i - 1].y);
  return total;
}

beforeEach(installBlank);
afterEach(() => {
  clearSemanticZones();
  setExtraBlocked(null);
  installBlank();
});
afterAll(() => commitMapContext(YARD));

describe("coarse multi-resolution planner", () => {
  test("restores original coordinates and exact fractional endpoints", () => {
    const start = { x: 180.25, y: 319.75 };
    const goal = { x: 435.625, y: 319.125 };
    const route = planRoute(start, goal, { coarseCellSizePx: COARSE });
    expect(route).not.toBeNull();
    expect(route!.display.at(0)).toEqual(start);
    expect(route!.display.at(-1)).toEqual(goal);
    expect(route!.follow.at(0)).toEqual(start);
    expect(route!.follow.at(-1)).toEqual(goal);
    expect(route!.follow.every((p) => p.x >= 0 && p.x < W && p.y >= 0 && p.y < H)).toBe(true);
  });

  test("keeps a fractional goal when start and goal share one coarse cell", () => {
    const start = { x: 200.125, y: 300.25 };
    const goal = { x: 207.75, y: 307.625 };
    const route = planRoute(start, goal, { coarseCellSizePx: COARSE });
    expect(route).not.toBeNull();
    expect(route!.display.at(-1)).toEqual(goal);
    expect(route!.follow.at(-1)).toEqual(goal);
  });

  test("does not detour through a coarse cell center for same-cell or one-pixel moves", () => {
    const start = { x: 300.25, y: 300.25 };
    const same = planRoute(start, start, { coarseCellSizePx: COARSE });
    expect(same).not.toBeNull();
    expect(routeLength(same!)).toBeLessThan(1e-6);
    const nearbyGoal = { x: 301.25, y: 300.25 };
    const nearby = planRoute(start, nearbyGoal, { coarseCellSizePx: COARSE });
    expect(nearby).not.toBeNull();
    expect(routeLength(nearby!)).toBeLessThanOrEqual(1 + 1e-6);
  });

  test("conservatively blocks a subcell forbidden polygon on a coarse boundary", () => {
    // The one-pixel polygon straddles x=256, a coarse-cell boundary. Both
    // overlapping cells must be treated as hard blocked by the coarse pass.
    const hardZone = zone("forbidden", [
      { x: 255.25, y: 398 }, { x: 256.75, y: 398 },
      { x: 256.75, y: 402 }, { x: 255.25, y: 402 },
    ]);
    setSemanticZones([hardZone]);
    const route = planRoute({ x: 200, y: 400 }, { x: 320, y: 400 }, { coarseCellSizePx: COARSE });
    expect(route).not.toBeNull();
    expect(route!.diagnostics?.mode).toBe("coarse");
    // The refinement may traverse free subpixels of a conservatively blocked
    // cell, but it must keep the robot body clear of the actual hard zone.
    expect(routeSamples(route!).every((point) => !isSemanticPoseBlocked([hardZone], point))).toBe(true);
  });

  test("falls back when a tiny hard zone touches a far corner of the start cell", () => {
    // The start pose is physically clear at the opposite corner. A centre-only
    // coarse raster would miss this polygon and incorrectly report a coarse
    // route; any-overlap rasterization must attempt fine planning instead.
    const hardZone = zone("forbidden", [
      { x: 271.4, y: 415.4 }, { x: 271.8, y: 415.4 },
      { x: 271.8, y: 415.8 }, { x: 271.4, y: 415.8 },
    ]);
    setSemanticZones([hardZone]);
    const route = planRoute({ x: 256, y: 400 }, { x: 360, y: 400 }, { coarseCellSizePx: COARSE });
    expect(route).not.toBeNull();
    expect(route!.diagnostics?.coarseFallback).toBe(true);
    expect(routeSamples(route!).every((point) => !isSemanticPoseBlocked([hardZone], point))).toBe(true);
  });

  test("treats a raw occupancy obstacle as a hard coarse cell", () => {
    const context = blankContext();
    const obstacleX = 263;
    const obstacleY = 400;
    context.occupancy[obstacleY * W + obstacleX] = 0;
    // This is the source obstacle's conservative body-clearance raster. The
    // raw obstacle remains one pixel while its inflated footprint fills the
    // coarse cell, so the assertion checks both layers without requiring a
    // route to avoid unrelated free subcells.
    for (let y = 384; y < 416; y++) for (let x = 256; x < 272; x++) context.inflated[y * W + x] = 0;
    commitMapContext(context);
    const route = planRoute({ x: 200, y: obstacleY }, { x: 320, y: obstacleY }, { coarseCellSizePx: COARSE });
    expect(route).not.toBeNull();
    expect(routeAvoids(route!, 256, 384, 272, 416)).toBe(true);
  });

  test("preserves weighted prefer/avoid behavior at coarse resolution", () => {
    setSemanticZones([
      zone("prefer", [{ x: 240, y: 500 }, { x: 352, y: 500 }, { x: 352, y: 620 }, { x: 240, y: 620 }], 0.35),
      zone("avoid", [{ x: 240, y: 470 }, { x: 352, y: 470 }, { x: 352, y: 500 }, { x: 240, y: 500 }], 20),
    ]);
    const route = planRoute({ x: 220, y: 505 }, { x: 372, y: 505 }, { coarseCellSizePx: COARSE });
    expect(route).not.toBeNull();
    expect(route!.display.some((p) => p.x > 260 && p.x < 332 && p.y > 525)).toBe(true);
    expect(route!.display.some((p) => p.x > 260 && p.x < 332 && p.y >= 470 && p.y <= 500)).toBe(false);
  });

  test("does not cut a diagonal corner between blocked coarse cells", () => {
    const context = blankContext();
    // Two diagonal blocked cells form the corner that an 8-neighbor search
    // must not cross in one diagonal step.
    for (let y = 384; y < 400; y++) for (let x = 256; x < 272; x++) context.inflated[y * W + x] = 0;
    for (let y = 400; y < 416; y++) for (let x = 272; x < 288; x++) context.inflated[y * W + x] = 0;
    commitMapContext(context);
    const route = planRoute({ x: 220, y: 370 }, { x: 330, y: 450 }, { coarseCellSizePx: COARSE });
    expect(route).not.toBeNull();
    expect(routeAvoids(route!, 256, 384, 272, 400)).toBe(true);
    expect(routeAvoids(route!, 272, 400, 288, 416)).toBe(true);
    expect(routeSamples(route!).every((point) => isPlanFree(point.x, point.y))).toBe(true);
  });

  test("falls back to fine planning when a narrow passage makes a coarse cell look blocked", () => {
    // The coarse cell contains a wall on every row except the exact narrow
    // physical gap. Coarse search has no route, while fine search can cross
    // the gap and must retain the original physical line.
    setExtraBlocked(maskWithCells([[256, 1, 272, 399], [256, 401, 272, H - 1]]));
    const route = planRoute({ x: 220, y: 400 }, { x: 330, y: 400 }, { coarseCellSizePx: COARSE });
    expect(route).not.toBeNull();
    expect(route!.display.every((p) => Math.abs(p.y - 400) < 3)).toBe(true);
  });

  test("falls back when the coarse endpoint cell is blocked but the exact goal is free", () => {
    setExtraBlocked(maskWithCells([[256, 1, 272, 399], [256, 401, 272, H - 1]]));
    const goal = { x: 263.5, y: 400.25 };
    const route = planRoute({ x: 220.25, y: 400.25 }, goal, { coarseCellSizePx: COARSE });
    expect(route).not.toBeNull();
    expect(route!.follow.at(-1)).toEqual(goal);
  });

  test("invalidates dynamic and semantic coarse caches after updates", () => {
    const start = { x: 200, y: 500 };
    const goal = { x: 380, y: 500 };
    const clear = planRoute(start, goal, { coarseCellSizePx: COARSE });
    expect(clear).not.toBeNull();
    setExtraBlocked(maskWithCells([[280, 488, 296, 512]]));
    const blocked = planRoute(start, goal, { coarseCellSizePx: COARSE });
    expect(blocked).not.toBeNull();
    expect(routeAvoids(blocked!, 280, 488, 296, 512)).toBe(true);
    setExtraBlocked(null);
    setSemanticZones([zone("avoid", [{ x: 280, y: 488 }, { x: 296, y: 488 }, { x: 296, y: 512 }, { x: 280, y: 512 }], 20)]);
    const semantic = planRoute(start, goal, { coarseCellSizePx: COARSE });
    expect(semantic).not.toBeNull();
    expect(semantic!.display.some((p) => p.y > 520)).toBe(true);
    clearSemanticZones();
    const restored = planRoute(start, goal, { coarseCellSizePx: COARSE });
    expect(restored).not.toBeNull();
    expect(restored!.display.every((p) => Math.abs(p.y - 500) < 6)).toBe(true);
  });

  test("invalidates static coarse state when switching map contexts", () => {
    const large = prepareMapContext("large_lab");
    commitMapContext(large);
    clearSemanticZones();
    const largeRoute = planRoute({ x: 8000.25, y: 2000.25 }, { x: 8200.75, y: 2000.75 }, { coarseCellSizePx: COARSE });
    expect(largeRoute).not.toBeNull();
    expect(largeRoute!.display.at(-1)).toEqual({ x: 8200.75, y: 2000.75 });
    installBlank();
    const yardRoute = planRoute({ x: 200.25, y: 300.25 }, { x: 400.75, y: 300.75 }, { coarseCellSizePx: COARSE });
    expect(yardRoute).not.toBeNull();
    expect(yardRoute!.display.at(-1)).toEqual({ x: 400.75, y: 300.75 });
  });

  test("keeps baseline fine resolution available for safety comparison", () => {
    const start = { x: 200.25, y: 600.25 };
    const goal = { x: 430.75, y: 600.75 };
    const fine = planRoute(start, goal, { coarseCellSizePx: 1 });
    const coarse = planRoute(start, goal, { coarseCellSizePx: COARSE });
    expect(fine).not.toBeNull();
    expect(coarse).not.toBeNull();
    expect(fine!.display.at(-1)).toEqual(goal);
    expect(coarse!.display.at(-1)).toEqual(goal);
  });

  test("handles a partial edge cell with a non-divisible coarse factor", () => {
    // 1600 is not divisible by 17. The final two-pixel coarse column must be
    // bounded safely even though this physically valid route ends just before
    // the robot-clearance boundary.
    const start = { x: 1500.25, y: 300.25 };
    const goal = { x: 1590.25, y: 300.25 };
    const route = planRoute(start, goal, { coarseCellSizePx: 17 });
    expect(route).not.toBeNull();
    expect(route!.display.at(0)).toEqual(start);
    expect(route!.display.at(-1)).toEqual(goal);
    expect(route!.follow.every((point) => point.x >= 0 && point.x < W && point.y >= 0 && point.y < H)).toBe(true);
  });

  test("refreshes a coarse dynamic mask after mutating and re-registering its buffer", () => {
    const mask = new Uint8Array(W * H);
    const start = { x: 220, y: 500 };
    const goal = { x: 380, y: 500 };
    setExtraBlocked(mask);
    const clear = planRoute(start, goal, { coarseCellSizePx: COARSE });
    expect(clear).not.toBeNull();
    for (let y = 488; y < 512; y++) for (let x = 280; x < 296; x++) mask[y * W + x] = 1;
    setExtraBlocked(mask);
    const changed = planRoute(start, goal, { coarseCellSizePx: COARSE });
    expect(changed).not.toBeNull();
    expect(routeAvoids(changed!, 280, 488, 296, 512)).toBe(true);
  });
});
