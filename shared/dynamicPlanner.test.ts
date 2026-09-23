import { afterEach, expect, test } from "bun:test";
import { commitMapContext, prepareMapContext, setExtraBlocked } from "./occupancy.ts";
import { ObstacleMaskBuffer, poseHitsAny, type DynObstacle } from "./obstacles.ts";
import { clearPlanningObstacles, clearSemanticZones, planRoute, setPlanningObstacles } from "./planner.ts";

const yard = prepareMapContext("yard");
const evidenceObstacles: DynObstacle[] = [
  { id: "circle", kind: "circle", x: 3263.397705078125, y: 2614.787109375, size: 80, theta: 0.7278063893 },
  { id: "square-a", kind: "square", x: 3165.06298828125, y: 2853.576904296875, size: 80, theta: 0.2263952196 },
  { id: "triangle", kind: "triangle", x: 3432.3193359375, y: 2567.675537109375, size: 50.3380012512, theta: -0.2919884324 },
  { id: "square-b", kind: "square", x: 3325.333740234375, y: 2764.072509765625, size: 80, theta: 0.2839999795 },
];
const goal = { x: 3144.238167039468, y: 3112.491943359375 };

afterEach(() => {
  clearPlanningObstacles();
  clearSemanticZones();
  setExtraBlocked(null);
  commitMapContext(yard);
});

test("exact dynamic geometry validates both recorded starts", () => {
  const large = prepareMapContext("large_lab");
  commitMapContext(large);
  const mask = new ObstacleMaskBuffer();
  setExtraBlocked(mask.rasterize(evidenceObstacles));
  setPlanningObstacles(evidenceObstacles);
  for (const start of [
    { x: 3343.435302734375, y: 2676.635986328125 },
    { x: 3362.919603832, y: 2575.3180600736355 },
  ]) {
    const route = planRoute(start, goal);
    expect(route).not.toBeNull();
    expect(route!.display[0]).toEqual(start);
    expect(route!.display.at(-1)).toEqual(goal);
    for (let i = 1; i < route!.follow.length; i++) {
      const a = route!.follow[i - 1], b = route!.follow[i];
      expect(poseHitsAny(b.x, b.y, Math.atan2(b.y - a.y, b.x - a.x), evidenceObstacles)).toBe(false);
    }
  }
});

test("geometry is invalidated by a mask refresh and raw-mask-only planning remains supported", () => {
  const mask = new ObstacleMaskBuffer();
  const obstacle: DynObstacle = { id: "small", kind: "square", x: 330, y: 520, size: 20, theta: Math.PI / 4 };
  setExtraBlocked(mask.rasterize([obstacle]));
  setPlanningObstacles([obstacle]);
  expect(planRoute({ x: 240, y: 520 }, { x: 420, y: 520 })).not.toBeNull();
  // A newer mask revision makes the previous geometry ineligible. Clearing
  // both snapshots then restores the mask-only baseline without stale state.
  setExtraBlocked(null);
  expect(planRoute({ x: 240, y: 520 }, { x: 420, y: 520 })).not.toBeNull();
  clearPlanningObstacles();
  expect(planRoute({ x: 240, y: 520 }, { x: 420, y: 520 })).not.toBeNull();
});
