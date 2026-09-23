import { afterEach, expect, test } from "bun:test";
import { DYNAMIC_PLAN_INFLATE_PX, MAP_HEIGHT, MAP_WIDTH, switchActiveMap } from "./constants.ts";
import { ObstacleMaskBuffer, pointHitsObstacle, poseHitsObstacle, rasterizeObstaclesInto, type DynObstacle } from "./obstacles.ts";

const obstacle: DynObstacle = { id: "o", kind: "circle", x: 240, y: 520, size: 10, theta: 0 };

afterEach(() => switchActiveMap("yard"));

test("reuses a dynamic obstacle mask and clears cells from the previous snapshot", () => {
  const buffer = new ObstacleMaskBuffer();
  const first = buffer.rasterize([obstacle]);
  const second = buffer.rasterize([]);
  expect(second).toBe(first);
  expect(second.some(Boolean)).toBe(false);
});

test("changed bounds remove stale disjoint cells without clearing the whole map", () => {
  const buffer = new ObstacleMaskBuffer();
  const first = buffer.rasterize([
    obstacle,
    { ...obstacle, id: "moving", x: 500, y: 520 },
  ]);
  expect(first[520 * MAP_WIDTH + 240]).toBe(1);
  expect(first[520 * MAP_WIDTH + 500]).toBe(1);
  const second = buffer.rasterize([
    obstacle,
    { ...obstacle, id: "moving", x: 500, y: 700 },
  ]);
  expect(second[520 * MAP_WIDTH + 240]).toBe(1);
  expect(second[520 * MAP_WIDTH + 500]).toBe(0);
  expect(second[700 * MAP_WIDTH + 500]).toBe(1);
});

test("reallocates safely when the active map dimensions change", () => {
  const buffer = new ObstacleMaskBuffer();
  const yard = buffer.rasterize([obstacle]);
  switchActiveMap("large_lab");
  const large = buffer.rasterize([{ ...obstacle, x: 500, y: 500 }]);
  expect(large).not.toBe(yard);
  expect(large.length).toBe(MAP_WIDTH * MAP_HEIGHT);
  expect(yard.length).toBe(1600 * 1200);
});

test("rejects a caller buffer with stale dimensions", () => {
  expect(() => rasterizeObstaclesInto([], new Uint8Array(1))).toThrow(/expected/);
});

test("rotated square raster bounds include its actual vertices and margin", () => {
  const out = new Uint8Array(MAP_WIDTH * MAP_HEIGHT);
  const rotated: DynObstacle = { id: "rotated", kind: "square", x: 500, y: 500, size: 80, theta: Math.PI / 4 };
  rasterizeObstaclesInto([rotated], out);
  // The old axis-aligned size+inflate bound stopped at x=590. The rotated
  // vertex reaches about x=613, and the raster must cover that geometry.
  expect(out[500 * MAP_WIDTH + 610]).toBe(1);
});

test("rotated square raster agrees with the point collision oracle", () => {
  const out = new Uint8Array(MAP_WIDTH * MAP_HEIGHT);
  const rotated: DynObstacle = { id: "rotated", kind: "square", x: 500, y: 500, size: 80, theta: Math.PI / 4 };
  rasterizeObstaclesInto([rotated], out);
  for (let y = 375; y <= 625; y += 5) for (let x = 375; x <= 625; x += 5) {
    expect(out[y * MAP_WIDTH + x]).toBe(pointHitsObstacle(x, y, rotated, DYNAMIC_PLAN_INFLATE_PX) ? 1 : 0);
  }
});

test("dirty refresh follows a rotated move and preserves overlapping obstacles", () => {
  const buffer = new ObstacleMaskBuffer();
  const moving: DynObstacle = { id: "moving", kind: "square", x: 500, y: 500, size: 80, theta: 0 };
  const fixed: DynObstacle = { id: "fixed", kind: "square", x: 560, y: 500, size: 30, theta: Math.PI / 8 };
  buffer.rasterize([moving, fixed]);
  const moved = { ...moving, x: 530, y: 520, theta: Math.PI / 4 };
  const actual = buffer.rasterize([moved, fixed]);
  const expected = rasterizeObstaclesInto([moved, fixed], new Uint8Array(MAP_WIDTH * MAP_HEIGHT));
  for (let y = 360; y <= 650; y += 7) for (let x = 360; x <= 700; x += 7) {
    expect(actual[y * MAP_WIDTH + x]).toBe(expected[y * MAP_WIDTH + x]);
  }
});

test("exact dynamic body collision remains distinct from the planning mask", () => {
  const rotated: DynObstacle = { id: "rotated", kind: "square", x: 500, y: 500, size: 80, theta: Math.PI / 4 };
  expect(poseHitsObstacle(500, 500, 0, rotated)).toBe(true);
  expect(poseHitsObstacle(350, 350, 0, rotated)).toBe(false);
});
