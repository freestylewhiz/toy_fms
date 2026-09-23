import { describe, expect, test } from "bun:test";
import { MAP_WIDTH } from "./constants.ts";
import { buildSemanticNavigation, isSemanticPoseBlocked, pointInPolygon, signedDistanceToZoneBoundary, speedLimitAt } from "./semanticNavigation.ts";
import type { ZoneResource } from "./semantic.ts";

const square = (kind: ZoneResource["kind"], extra = {}): ZoneResource => ({
  id: kind, kind, family: "scene", name: kind, theta: 0,
  polygon: [{ x: 100, y: 100 }, { x: 120, y: 100 }, { x: 120, y: 120 }, { x: 100, y: 120 }], ...extra,
});

const rectangle = (kind: ZoneResource["kind"], factor?: number): ZoneResource => ({
  id: `${kind}-wide`, kind, family: "scene", name: kind, theta: 0, factor,
  polygon: [{ x: 100, y: 100 }, { x: 240, y: 100 }, { x: 240, y: 240 }, { x: 100, y: 240 }],
});

const costAt = (nav: ReturnType<typeof buildSemanticNavigation>, point: { x: number; y: number }, width = 300) =>
  nav.costs?.[point.y * width + point.x] ?? nav.costAt?.(point) ?? 1;

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
  test("prefer rewards usable interior clearance while avoid rises from a boundary buffer", () => {
    const prefer = buildSemanticNavigation([rectangle("prefer", 0.4)], { width: 300, height: 300 });
    const preferCenter = costAt(prefer, { x: 170, y: 170 });
    const preferInner = costAt(prefer, { x: 170, y: 113 });
    const preferEdge = costAt(prefer, { x: 170, y: 109 });
    expect(preferCenter).toBeLessThan(preferInner);
    expect(preferInner).toBeLessThan(preferEdge);
    expect(preferEdge).toBe(1);

    const avoid = buildSemanticNavigation([rectangle("avoid", 3)], { width: 300, height: 300 });
    const farOutside = costAt(avoid, { x: 170, y: 80 });
    const nearOutside = costAt(avoid, { x: 170, y: 90 });
    const boundary = costAt(avoid, { x: 170, y: 100 });
    const shallowInside = costAt(avoid, { x: 170, y: 113 });
    const deepInside = costAt(avoid, { x: 170, y: 170 });
    expect(farOutside).toBe(1);
    expect(nearOutside).toBeGreaterThan(farOutside);
    expect(boundary).toBeGreaterThan(nearOutside);
    expect(shallowInside).toBeGreaterThan(boundary);
    expect(deepInside).toBeGreaterThan(shallowInside);
    expect(signedDistanceToZoneBoundary({ x: 170, y: 170 }, rectangle("avoid").polygon)).toBe(70);
    expect(signedDistanceToZoneBoundary({ x: 170, y: 80 }, rectangle("avoid").polygon)).toBe(-20);
  });

  test("narrow prefer zones stay passable and soft overlaps remain deterministic", () => {
    const narrow = square("prefer", { factor: 0.4 });
    const narrowNav = buildSemanticNavigation([narrow]);
    expect(narrowNav.costs![110 * MAP_WIDTH + 110]).toBe(1);

    const avoid = rectangle("avoid", 3), prefer = rectangle("prefer", 0.4);
    const a = buildSemanticNavigation([avoid, prefer], { width: 300, height: 300 });
    const b = buildSemanticNavigation([prefer, avoid], { width: 300, height: 300 });
    expect(costAt(a, { x: 170, y: 170 })).toBeCloseTo(1.2);
    expect(costAt(b, { x: 170, y: 170 })).toBeCloseTo(costAt(a, { x: 170, y: 170 }));
    expect(costAt(a, { x: 280, y: 280 })).toBe(1);
  });

  test("large maps keep semantic fields lazy without weakening hard zones", () => {
    const avoid = rectangle("avoid", 3);
    const blocked = rectangle("blocked");
    const nav = buildSemanticNavigation([avoid, blocked], { width: 10_000, height: 10_000 });
    expect(nav.costs).toBeNull();
    expect(nav.blocked).toBeNull();
    expect(nav.costAt?.({ x: 170, y: 170 })).toBeGreaterThan(1);
    expect(nav.isBlocked?.({ x: 170, y: 170 })).toBe(true);
    expect(nav.isBlocked?.({ x: 80, y: 170 })).toBe(false);
  });
  test("speed limits use metres per second and the strictest touching zone", () => {
    const zones = [square("speed_limit", { maximumSpeed: 0.2 }), square("speed_limit", { maximumSpeed: 0.1 })];
    expect(speedLimitAt(zones, { x: 110, y: 110 })).toBe(2);
    expect(speedLimitAt(zones, { x: 200, y: 200 })).toBe(12);
  });
});
