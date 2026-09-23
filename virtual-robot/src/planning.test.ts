import { expect, test } from "bun:test";
import { PlanningWorkerClient } from "./planning.ts";

test("planning worker returns a route without blocking the caller", async () => {
  const planner = new PlanningWorkerClient({ timeBudgetMs: 3000 });
  try {
    const result = await planner.request({ mapId: "yard", start: { x: 240, y: 520 }, goal: { x: 280, y: 520 }, zones: [], obstacles: [] }).promise;
    expect(result?.follow.at(-1)).toEqual({ x: 280, y: 520 });
  } finally {
    planner.close();
  }
});

test("a newer request cancels the previous worker and returns only the newest result", async () => {
  const planner = new PlanningWorkerClient({ timeBudgetMs: 3000 });
  try {
    const old = planner.request({ mapId: "yard", start: { x: 240, y: 520 }, goal: { x: 600, y: 520 }, zones: [], obstacles: [] });
    const current = planner.request({ mapId: "yard", start: { x: 240, y: 520 }, goal: { x: 280, y: 520 }, zones: [], obstacles: [] });
    expect(await old.promise).toBeNull();
    expect((await current.promise)?.follow.at(-1)).toEqual({ x: 280, y: 520 });
  } finally {
    planner.close();
  }
});

test("rapid replacement during planner startup remains isolated from the robot runtime", async () => {
  const planner = new PlanningWorkerClient({ timeBudgetMs: 3000 });
  try {
    const cancelled = Array.from({ length: 12 }, () => planner.request({ mapId: "large_lab", start: { x: 1400, y: 1300 }, goal: { x: 1460, y: 1300 }, zones: [], obstacles: [] }));
    const current = planner.request({ mapId: "yard", start: { x: 240, y: 520 }, goal: { x: 280, y: 520 }, zones: [], obstacles: [] });
    expect((await Promise.all(cancelled.map(handle => handle.promise))).every(result => result === null)).toBe(true);
    expect(cancelled.every(handle => handle.getFailure?.()?.kind === "cancelled")).toBe(true);
    expect((await current.promise)?.follow.at(-1)).toEqual({ x: 280, y: 520 });
  } finally { planner.close(); }
});

test("planner timeout is distinguished from no-route and the next request can recover", async () => {
  const planner = new PlanningWorkerClient();
  try {
    const timed = planner.request({ mapId: "large_lab", start: { x: 1400, y: 1300 }, goal: { x: 1460, y: 1300 }, zones: [], obstacles: [], timeBudgetMs: 1 });
    expect(await timed.promise).toBeNull();
    expect(timed.getFailure?.()?.kind).toBe("timeout");
    const next = planner.request({ mapId: "yard", start: { x: 240, y: 520 }, goal: { x: 280, y: 520 }, zones: [], obstacles: [] });
    expect((await next.promise)?.follow.at(-1)).toEqual({ x: 280, y: 520 });
  } finally { planner.close(); }
});
