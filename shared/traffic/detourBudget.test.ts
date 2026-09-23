import { expect, test } from "bun:test";
import { evaluateDetourBudget } from "./detourBudget.ts";

const valid = () => true;

test("peer detour budget uses the remaining original route and the 30 percent allowance", () => {
  const result = evaluateDetourBudget({
    referenceRoute: [{ x: 0, y: 0 }, { x: 200, y: 0 }],
    currentPose: { x: 100, y: 0 },
    candidateRoute: [{ x: 100, y: 15 }, { x: 200, y: 15 }, { x: 200, y: 0 }],
    goal: { x: 200, y: 0 },
    referenceValid: valid,
  });
  expect(result).toMatchObject({ available: true, baselineLengthM: 5, candidateLengthM: 6.5, allowedLengthM: 6.5, accepted: true });
});

test("peer detour candidate snapped short of the goal has no valid length admission", () => {
  const result = evaluateDetourBudget({
    referenceRoute: [{ x: 0, y: 0 }, { x: 200, y: 0 }],
    currentPose: { x: 0, y: 0 },
    candidateRoute: [{ x: 150, y: 0 }],
    goal: { x: 200, y: 0 },
    referenceValid: valid,
  });
  expect(result).toMatchObject({ available: false, candidateLengthM: 7.5, accepted: false });
});

test("peer detour budget uses the one metre floor and five metre cap", () => {
  const floor = evaluateDetourBudget({
    referenceRoute: [{ x: 0, y: 0 }, { x: 40, y: 0 }],
    currentPose: { x: 0, y: 0 },
    candidateRoute: [{ x: 20, y: 22.360679775 }, { x: 40, y: 0 }],
    goal: { x: 40, y: 0 },
    pixelCm: 5,
    referenceValid: valid,
  });
  expect(floor).toMatchObject({ available: true, baselineLengthM: 2, allowedLengthM: 3, accepted: true });

  const cap = evaluateDetourBudget({
    referenceRoute: [{ x: 0, y: 0 }, { x: 400, y: 0 }],
    currentPose: { x: 0, y: 0 },
    candidateRoute: [{ x: 200, y: 150 }, { x: 400, y: 0 }],
    goal: { x: 400, y: 0 },
    pixelCm: 5,
    referenceValid: valid,
  });
  expect(cap).toMatchObject({ available: true, baselineLengthM: 20, candidateLengthM: 25, allowedLengthM: 25, accepted: true });
});
