import { describe, expect, test } from "bun:test";
import { stepBackDistancePx } from "../constants.ts";
import {
  distToPlan,
  distanceAlongPathToClosestPoint,
  plansOverlap,
  pathAfterDistance,
  pathLength,
  reverseAlongTrail,
  sampleLocalPlan,
  splitPathIntoSteps,
} from "./localPlan.ts";

describe("sampleLocalPlan", () => {
  test("starts at pose and stops near horizon", () => {
    const path = Array.from({ length: 40 }, (_, i) => ({ x: 10 + i * 3, y: 10 }));
    const sample = sampleLocalPlan(path, 0, { x: 10, y: 10 }, 30);
    expect(sample[0]).toEqual({ x: 10, y: 10 });
    const len = sample.reduce((n, p, i) => {
      if (i === 0) return 0;
      return n + Math.hypot(p.x - sample[i - 1].x, p.y - sample[i - 1].y);
    }, 0);
    expect(len).toBeGreaterThan(25);
    expect(len).toBeLessThanOrEqual(31);
  });
});

describe("plansOverlap", () => {
  test("head-on corridor overlap", () => {
    const a = [
      { x: 0, y: 0 },
      { x: 80, y: 0 },
    ];
    const b = [
      { x: 80, y: 0 },
      { x: 0, y: 0 },
    ];
    expect(plansOverlap(a, b, 24)).toBe(true);
  });

  test("parallel far lanes do not overlap", () => {
    const a = [
      { x: 0, y: 0 },
      { x: 80, y: 0 },
    ];
    const b = [
      { x: 0, y: 80 },
      { x: 80, y: 80 },
    ];
    expect(plansOverlap(a, b, 24)).toBe(false);
  });

  test("crossing paths overlap", () => {
    const a = [
      { x: 0, y: 40 },
      { x: 80, y: 40 },
    ];
    const b = [
      { x: 40, y: 0 },
      { x: 40, y: 80 },
    ];
    expect(plansOverlap(a, b, 24)).toBe(true);
  });
});

describe("reverseAlongTrail", () => {
  test("walks toward older breadcrumbs", () => {
    const trail = Array.from({ length: 20 }, (_, i) => ({ x: i * 5, y: 0 }));
    const pose = { x: 95, y: 0 };
    const back = reverseAlongTrail(trail, pose, 30);
    expect(back.length).toBeGreaterThan(1);
    expect(back[0].x).toBeCloseTo(95, 0);
    expect(back[back.length - 1].x).toBeLessThan(80);
  });

  test("a single older breadcrumb still provides a real short retreat route", () => {
    const back = reverseAlongTrail([{ x: 100, y: 0 }], { x: 112, y: 0 }, 10);
    expect(back).toEqual([{ x: 112, y: 0 }, { x: 102, y: 0 }]);
  });
});

describe("step-back route geometry", () => {
  test("splits at half-metre pixels while preserving corners and the short final segment", () => {
    const path = [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 6 }, { x: 6, y: 9 }];
    const steps = splitPathIntoSteps(path, 10);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual([{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 4 }]);
    expect(steps[1]).toEqual([{ x: 6, y: 4 }, { x: 6, y: 6 }, { x: 6, y: 9 }]);
    expect(pathLength(steps[0])).toBeCloseTo(10);
    expect(pathLength(steps[1])).toBeCloseTo(5);
  });

  test("half-metre retreat rounds up to the next source-map pixel", () => {
    expect(stepBackDistancePx(5)).toBe(10);
    expect(stepBackDistancePx(3)).toBe(17); // 0.51m at 3cm/px
    expect(stepBackDistancePx(7)).toBe(8); // 0.56m at 7cm/px
    expect(() => stepBackDistancePx(0)).toThrow();
  });

  test("trimming after partial progress keeps only the unconsumed historic prefix", () => {
    const route = [{ x: 30, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }];
    const partial = [{ x: 30, y: 0 }, { x: 20, y: 0 }];
    const progress = distanceAlongPathToClosestPoint(partial, { x: 24, y: 0 });
    expect(progress).toBeCloseTo(6);
    expect(pathAfterDistance(route, progress)).toEqual([{ x: 24, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }]);
  });
});

describe("distToPlan", () => {
  test("point on the line is near zero", () => {
    const plan = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    expect(distToPlan({ x: 40, y: 0 }, plan)).toBeLessThan(1);
    expect(distToPlan({ x: 40, y: 50 }, plan)).toBeGreaterThan(40);
  });
});
