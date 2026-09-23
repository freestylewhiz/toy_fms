import { afterEach, expect, test } from "bun:test";
import { RobotController } from "./controller.ts";
import { LocalPlanExecutor } from "./traffic/LocalPlanExecutor.ts";
import { clearPlanningObstacles, clearSemanticZones } from "../../shared/planner.ts";
import type { AsyncRoutePlanner, PlanningHandle, PlanningInput, RoutePlan } from "./planning.ts";

afterEach(() => { clearSemanticZones(); clearPlanningObstacles(); });
const step = (c: RobotController, n = 1) => { for (let i = 0; i < n; i++) (c as any).tick(); };
const position = (c: RobotController) => { const { x, y, theta } = c.snapshot(); return { x, y, theta }; };
const retained = (c: RobotController) => ({ path: c.currentPath(), local: c.currentLocalPlan(), index: (c as any).pathIndex, goal: (c as any).goal, commandId: c.snapshot().commandId });
const pause = (c: RobotController, paused: boolean) => (c as any).setOperatorPaused(paused);

test("operator pause freezes translation and rotation while preserving command and both paths", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.handleDrive({ command_id: "preserved", kind: "move", x: 420, y: 520, theta: Math.PI / 2 });
  step(c, 3);
  const before = position(c), route = retained(c);
  pause(c, true);
  step(c, 100);
  expect(position(c)).toEqual(before);
  expect(retained(c)).toEqual(route);
  expect(c.snapshot().driveState).toBe("paused");
  pause(c, false);
  step(c, 4);
  expect(c.snapshot().x).toBeGreaterThan(before.x);
  expect(c.snapshot().commandId).toBe("preserved");

  const rotation = new RobotController({ x: 240, y: 520, theta: 0 });
  rotation.handleDrive({ command_id: "rotation", kind: "move", x: 240, y: 520, theta: Math.PI / 2 });
  step(rotation, 2);
  const at = position(rotation);
  pause(rotation, true); step(rotation, 40);
  expect(position(rotation)).toEqual(at);
  pause(rotation, false); step(rotation, 2);
  expect(rotation.snapshot().theta).toBeGreaterThan(at.theta);
});

test("paused obstacle and peer updates preserve route, but resume never moves into a new obstacle", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.handleDrive({ command_id: "environment", kind: "move", x: 420, y: 520, theta: 0 });
  step(c, 3); pause(c, true);
  const before = position(c), route = retained(c);
  c.setObstacles([{ id: "new-body", kind: "circle", x: before.x, y: before.y, size: 25, theta: 0 }]);
  c.setPeerLocalPlans([{ robotId: "peer", x: 300, y: 520, theta: 0, points: [{ x: 300, y: 520 }] }]);
  step(c, 10);
  expect(retained(c)).toEqual(route);
  expect(position(c)).toEqual(before);
  pause(c, false); step(c, 10);
  expect(c.snapshot().operatorPaused).toBe(false);
  expect(position(c)).toEqual(before);
});

test("traffic grants cannot release operator pause, and operator resume cannot release traffic STOP", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  const traffic = new LocalPlanExecutor({ sendLeaseRequest: () => {}, sendLeaseRelease: () => {} });
  c.attachTraffic(traffic);
  c.handleDrive({ command_id: "independent", kind: "move", x: 420, y: 520, theta: 0 });
  pause(c, true);
  const before = position(c);
  traffic.onGrant({ requestId: "clear", leaseId: "clear", signal: "PROCEED", held: { segments: [] }, leaseDurationMs: 1_000, zoneId: "z", reason: "test" });
  step(c, 4); expect(position(c)).toEqual(before);
  traffic.onGrant({ requestId: "stop", leaseId: "stop", signal: "STOP", held: { segments: [] }, leaseDurationMs: 1_000, zoneId: "z", reason: "test" });
  pause(c, false); step(c, 4);
  expect(c.snapshot().operatorPaused).toBe(false);
  expect(position(c)).toEqual(before);
  expect(traffic.trafficStatus()).toBe("stop");
});

test("a route calculation completing during pause is retained without changing route until resume", async () => {
  let resolve!: (route: RoutePlan | null) => void;
  let cancelled = false;
  const planner: AsyncRoutePlanner = { request(_input: PlanningInput): PlanningHandle { return {
    promise: new Promise(done => { resolve = done; }), cancel() { cancelled = true; }, getFailure: () => undefined,
  }; } };
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.setAsyncPlanner(planner);
  c.handleDrive({ command_id: "pending", kind: "move", x: 420, y: 520, theta: 0 });
  pause(c, true);
  const route = retained(c), before = position(c);
  resolve({ follow: [{ x: 420, y: 520 }], display: [{ x: 420, y: 520 }] });
  await Promise.resolve(); await Promise.resolve();
  step(c, 5);
  expect(cancelled).toBe(false);
  expect(retained(c)).toEqual(route);
  expect(position(c)).toEqual(before);
  pause(c, false); await Promise.resolve(); step(c, 4);
  expect(c.currentPath().length).toBeGreaterThan(0);
  expect(c.snapshot().x).toBeGreaterThan(before.x);
});

test("new motion does not replace a paused mission, while explicit cancel remains effective", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.handleDrive({ command_id: "retained", kind: "move", x: 420, y: 520, theta: 0 });
  pause(c, true);
  const route = retained(c);
  c.handleDrive({ command_id: "replacement", kind: "move", x: 240, y: 600, theta: 0 });
  expect(retained(c)).toEqual(route);
  c.handleCancel();
  expect(c.snapshot().commandState).toBe("cancelled");
  expect(c.currentPath()).toEqual([]);
  expect(c.snapshot().operatorPaused).toBe(true);
});

test("cancelling after a reroute result was deferred during pause sends a terminal evasion reply", async () => {
  let resolve!: (route: RoutePlan | null) => void;
  const planner: AsyncRoutePlanner = { request(): PlanningHandle { return { promise: new Promise(done => { resolve = done; }), cancel() {}, getFailure: () => undefined }; } };
  const c = new RobotController({ x: 240, y: 520, theta: 0 }), replies: any[] = [];
  c.handleDrive({ command_id: "evasion", kind: "move", x: 420, y: 520, theta: 0 });
  c.setAsyncPlanner(planner);
  c.setEvasionReplySender(reply => replies.push(reply));
  c.handleEvasionPlan({ mode: "REROUTE", zone_id: "z", round_id: "r", release_hint: [] });
  pause(c, true);
  resolve({ follow: [{ x: 420, y: 520 }], display: [{ x: 420, y: 520 }] });
  await Promise.resolve(); await Promise.resolve();
  expect(replies).toHaveLength(0);
  c.handleCancel();
  expect(replies).toHaveLength(1);
  expect(replies[0]).toMatchObject({ zone_id: "z", round_id: "r", result: "NONE" });
});
