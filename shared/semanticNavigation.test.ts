import { describe, expect, test } from "bun:test";
import { MAP_WIDTH } from "./constants.ts";
import { buildSemanticNavigation, isSemanticPoseBlocked, pointInPolygon, speedLimitAt } from "./semanticNavigation.ts";
import type { ZoneResource } from "./semantic.ts";

const square = (kind: ZoneResource["kind"], extra = {}): ZoneResource => ({
  id: kind, kind, family: "scene", name: kind, theta: 0,
  polygon: [{ x: 100, y: 100 }, { x: 120, y: 100 }, { x: 120, y: 120 }, { x: 100, y: 120 }], ...extra,
});

describe("semantic navigation geometry", () => {
  test("hard zones include boundaries and the robot body outside the polygon", () => {
    const zone = square("forbidden");
    expect(pointInPolygon({ x: 100, y: 110 }, zone.polygon)).toBe(true);
    expect(isSemanticPoseBlocked([zone], { x: 92, y: 110 })).toBe(true);
    expect(isSemanticPoseBlocked([zone], { x: 85, y: 110 })).toBe(false);
    const nav = buildSemanticNavigation([zone, square("prefer")]);
    expect(nav.blocked![110 * MAP_WIDTH + 92]).toBe(1);
    expect(nav.blocked![110 * MAP_WIDTH + 85]).toBe(0);
  });
  test("costs have free-space defaults and deterministic overlap", () => {
    const a = square("avoid", { factor: 3 }), b = square("prefer", { factor: 0.4 });
    const nav = buildSemanticNavigation([a, b]);
    expect(nav.costs![110 * MAP_WIDTH + 110]).toBeCloseTo(1.2);
    expect(nav.costs![200 * MAP_WIDTH + 200]).toBe(1);
    expect(nav.minimumCost).toBe(1);
    expect(buildSemanticNavigation([b, a]).costs![110 * MAP_WIDTH + 110]).toBeCloseTo(1.2);
  });
  test("speed limits use metres per second and the strictest touching zone", () => {
    const zones = [square("speed_limit", { maximumSpeed: 0.2 }), square("speed_limit", { maximumSpeed: 0.1 })];
    expect(speedLimitAt(zones, { x: 110, y: 110 })).toBe(2);
    expect(speedLimitAt(zones, { x: 200, y: 200 })).toBe(12);
  });
});
