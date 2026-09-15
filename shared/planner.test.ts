import { describe, expect, test, afterEach } from "bun:test";
import { clearSemanticZones, planRoute, setSemanticZones } from "./planner.ts";

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
});
