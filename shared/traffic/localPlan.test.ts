import { describe, expect, test } from "bun:test";
import {
  distToPlan,
  plansOverlap,
  reverseAlongTrail,
  sampleLocalPlan,
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
