import { describe, expect, test, afterEach } from "bun:test";
import { clearSemanticZones, planRoute, setSemanticZones } from "./planner.ts";
import { pointInPolygon } from "./semanticNavigation.ts";

const zone = (kind: "forbidden" | "prefer" | "avoid", polygon: { x: number; y: number }[], factor?: number) => ({
  id: `${kind}-test`, family: "scene" as const, kind, name: kind, polygon, theta: 0, factor,
});

afterEach(() => clearSemanticZones());

describe("semantic-aware planner", () => {
  test("preserves a fractional destination beyond the integer A* cell", () => {
    const goal = { x: 264.49, y: 520.49 };
    const route = planRoute({ x: 240.1, y: 520.1 }, goal);
    expect(route?.display.at(-1)).toEqual(goal);
    expect(route?.follow.at(-1)).toEqual(goal);
  });
  test("rejects a forbidden goal instead of snapping into it", () => {
    setSemanticZones([zone("forbidden", [{ x: 230, y: 500 }, { x: 270, y: 500 }, { x: 270, y: 540 }, { x: 230, y: 540 }])]);
    expect(planRoute({ x: 400, y: 520 }, { x: 240, y: 520 })).toBeNull();
  });

  test("keeps a route around a forbidden chord", () => {
    setSemanticZones([zone("forbidden", [{ x: 300, y: 500 }, { x: 360, y: 500 }, { x: 360, y: 540 }, { x: 300, y: 540 }])]);
    const route = planRoute({ x: 240, y: 520 }, { x: 420, y: 520 });
    expect(route).not.toBeNull();
    expect(route!.display.some((p) => p.y < 490 || p.y > 550)).toBe(true);
  });

  test("uses the interior of a prefer zone instead of its shared avoid boundary", () => {
    setSemanticZones([
      zone("prefer", [{ x: 250, y: 500 }, { x: 420, y: 500 }, { x: 420, y: 620 }, { x: 250, y: 620 }], 0.35),
      zone("avoid", [{ x: 250, y: 470 }, { x: 420, y: 470 }, { x: 420, y: 500 }, { x: 250, y: 500 }], 4),
    ]);
    const route = planRoute({ x: 240, y: 505 }, { x: 430, y: 505 });
    expect(route).not.toBeNull();
    // Regression for the attached boundary-hugging layout: the long middle
    // section belongs near the 560px centerline, not the y=500 shared edge.
    expect(route!.display.some((p) => p.x > 320 && p.x < 380 && p.y > 540)).toBe(true);
  });

  test("cost-preserving smoothing does not cut a high-cost avoid detour", () => {
    const avoid = [{ x: 300, y: 500 }, { x: 360, y: 500 }, { x: 360, y: 540 }, { x: 300, y: 540 }];
    setSemanticZones([zone("avoid", avoid, 100)]);
    const route = planRoute({ x: 240, y: 520 }, { x: 420, y: 520 });
    expect(route).not.toBeNull();
    expect(route!.display.some((p) => p.y < 490 || p.y > 550)).toBe(true);
    for (let i = 1; i < route!.display.length; i++) {
      const a = route!.display[i - 1], b = route!.display[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
      for (let step = 0; step <= steps; step++) {
        const t = step / steps;
        expect(pointInPolygon({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, avoid)).toBe(false);
      }
    }
  });
});
