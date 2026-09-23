import { expect, test } from "bun:test";
import { evaluateDetourBudget, projectPointOnPolyline } from "./detourBudget.ts";

test("remaining distance uses the original route after progress, with inclusive budget boundary", () => {
  const referenceRoute = [{ x: 0, y: 0 }, { x: 1000, y: 0 }];
  const evaluate = (height: number) => evaluateDetourBudget({
    referenceRoute, currentPose: { x: 800, y: 0 },
    candidateRoute: [{ x: 800, y: height }, { x: 1000, y: height }, { x: 1000, y: 0 }],
    referenceValid: () => true, pixelCm: 5, goal: { x: 1000, y: 0 },
  });
  expect(evaluate(30)).toMatchObject({ available: true, baselineLengthM: 10, candidateLengthM: 13, allowedLengthM: 13, accepted: true });
  expect(evaluate(30.01).accepted).toBe(false);
});

test("backing behind saved progress includes the connector without jumping to the segment end", () => {
  const projection = projectPointOnPolyline([{ x: 0, y: 0 }, { x: 100, y: 0 }], { x: 40, y: 0 }, 50);
  expect(projection?.point).toEqual({ x: 50, y: 0 });
  expect(projection?.distancePx).toBe(10);
});

test("invalid reference connector refuses the candidate instead of counting a wall shortcut", () => {
  let inspected = false;
  const result = evaluateDetourBudget({
    referenceRoute: [{ x: 0, y: 0 }, { x: 200, y: 0 }], currentPose: { x: 100, y: 40 },
    candidateRoute: [{ x: 200, y: 40 }, { x: 200, y: 0 }],
    referenceValid: (connector) => { inspected = true; expect(connector).toEqual([{ x: 100, y: 40 }, { x: 100, y: 0 }]); return false; },
  });
  expect(inspected).toBe(true);
  expect(result).toMatchObject({ available: false, accepted: false, baselineLengthM: null, allowedLengthM: null });
});

test("invalid numeric inputs never produce non-finite diagnostic lengths", () => {
  for (const pixelCm of [NaN, Infinity, 0, -5]) {
    const result = evaluateDetourBudget({
      referenceRoute: [{ x: 0, y: 0 }, { x: 100, y: 0 }], currentPose: { x: 0, y: 0 },
      candidateRoute: [{ x: 100, y: 0 }], referenceValid: () => true, pixelCm,
    });
    expect(result.accepted).toBe(false);
    expect(result.candidateLengthM).toBeNull();
  }
});
