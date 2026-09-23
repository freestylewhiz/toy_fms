import { afterEach, expect, test, spyOn } from "bun:test";
import { RobotController } from "./controller.ts";
import { LocalPlanExecutor } from "./traffic/LocalPlanExecutor.ts";
import { poseHitsObstacle } from "../../shared/obstacles.ts";
import { clearSemanticZones } from "../../shared/planner.ts";
import { STEP_BACK_WAIT_MS } from "../../shared/constants.ts";
import type { AsyncRoutePlanner, PlanningFailure, PlanningHandle, PlanningInput, RoutePlan } from "./planning.ts";

const traffic = () => new LocalPlanExecutor({ sendLeaseRequest: () => {}, sendLeaseRelease: () => {} });
afterEach(() => clearSemanticZones());

class DeferredPlanner implements AsyncRoutePlanner {
  requests: { input: PlanningInput; resolve: (route: RoutePlan | null) => void; cancelled: boolean; failure?: PlanningFailure }[] = [];

  request(input: PlanningInput): PlanningHandle {
    let resolve!: (route: RoutePlan | null) => void;
    const promise = new Promise<RoutePlan | null>((done) => { resolve = done; });
    const request = { input, resolve, cancelled: false };
    this.requests.push(request);
    return {
      promise,
      cancel: () => { request.cancelled = true; },
      getFailure: () => request.failure,
    };
  }
}

test("late discarded plan reports the original command instead of its replacement", async () => {
  const planner = new DeferredPlanner();
  const controller = new RobotController({ x: 240, y: 520, theta: 0 });
  const events: any[] = [];
  controller.setAsyncPlanner(planner);
  controller.setPlanningEventHandler(event => events.push(event));
  controller.handleDrive({ command_id: "original", kind: "move", x: 280, y: 520, theta: 0 });
  controller.handleDrive({ command_id: "replacement", kind: "move", x: 300, y: 520, theta: 0 });
  planner.requests[0].resolve(null);
  await Promise.resolve();
  expect(events.find(event => event.phase === "discarded")).toMatchObject({ commandId: "original" });
  expect(events.findLast(event => event.phase === "requested")).toMatchObject({ commandId: "replacement" });
});

test("cancel preserves idle state and drops the mission", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.attachTraffic(traffic());
  c.handleDrive({ command_id: "a", kind: "move", x: 280, y: 520, theta: 0 });
  c.handleCancel();
  expect(c.snapshot().status).toBe("idle");
  expect(c.currentPath()).toEqual([]);
});

test("unchanged empty peer snapshots preserve a valid path and FOLLOW phase", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.attachTraffic(traffic());
  c.handleDrive({ command_id: "stable", kind: "move", x: 420, y: 520, theta: 0 });
  const path = c.currentPath();
  c.setPeerLocalPlans([]);
  c.setPeerLocalPlans([]);
  expect(c.currentPath()).toEqual(path);
  expect(c.snapshot().motion).toBe("FOLLOW");
});

test("moving unrelated peers do not cancel a pending route at the peer update rate", async () => {
  const planner = new DeferredPlanner();
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.setAsyncPlanner(planner);
  c.handleDrive({ command_id: "coalesce", kind: "move", x: 420, y: 520, theta: 0 });
  for (let i = 0; i < 10; i++) {
    c.setPeerLocalPlans([{ robotId: "remote", x: 1000 + i, y: 900, theta: 0, points: [{ x: 1000 + i, y: 900 }] }]);
  }
  expect(planner.requests).toHaveLength(1);
  expect(planner.requests[0].cancelled).toBe(false);
  planner.requests[0].resolve({ follow: [{ x: 420, y: 520 }], display: [{ x: 420, y: 520 }] });
  await Promise.resolve();
  expect(c.snapshot().motion).toBe("FOLLOW");
});

test("evasion without a committed reference rejects conservatively and answers each round once", async () => {
  const planner = new DeferredPlanner();
  const replies: Record<string, unknown>[] = [];
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.setAsyncPlanner(planner);
  const events: any[] = [];
  c.setPlanningEventHandler(event => events.push(event));
  c.setEvasionReplySender((reply) => replies.push(reply));
  c.handleDrive({ command_id: "ordinary", kind: "move", x: 420, y: 520, theta: 0 });
  c.handleEvasionPlan({ zone_id: "z", round_id: "round-1", mode: "REROUTE" });
  expect(planner.requests).toHaveLength(2);
  expect(planner.requests[0].cancelled).toBe(true);
  planner.requests[0].resolve({ follow: [{ x: 420, y: 520 }], display: [{ x: 420, y: 520 }] });
  planner.requests[1].resolve({ follow: [{ x: 240, y: 560 }, { x: 420, y: 560 }], display: [{ x: 240, y: 560 }, { x: 420, y: 560 }] });
  await Promise.resolve();
  expect(replies).toEqual([{ zone_id: "z", round_id: "round-1", result: "NONE", reason: "no path" }]);
  expect(c.currentPath()).toEqual([]);
  expect(events.find(event => event.kind === "navigation.detour_rejected")).toMatchObject({
    reason: "detour-reference-unavailable",
    fallback: "await-vacate",
  });
  c.handleEvasionPlan({ zone_id: "z", round_id: "round-1", mode: "REROUTE" });
  expect(replies).toHaveLength(2);
  expect(replies.at(-1)?.result).toBe("NONE");
});

test("evasion accepts a bounded detour after the original command route commits", async () => {
  const planner = new DeferredPlanner();
  const replies: Record<string, unknown>[] = [];
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.handleDrive({ command_id: "ordinary", kind: "move", x: 420, y: 520, theta: 0 });
  c.setAsyncPlanner(planner);
  c.setEvasionReplySender((reply) => replies.push(reply));
  c.handleEvasionPlan({ zone_id: "z", round_id: "round-bounded", mode: "REROUTE" });
  const route = [{ x: 240, y: 530 }, { x: 420, y: 530 }, { x: 420, y: 520 }];
  planner.requests[0].resolve({ follow: route, display: route });
  await Promise.resolve();
  expect(replies).toEqual([{ zone_id: "z", round_id: "round-bounded", result: "REROUTE", reason: "ok" }]);
  expect(c.currentPath()).toEqual(route);
});

test("cancelled or replaced evasion cannot commit a stale route", async () => {
  const planner = new DeferredPlanner();
  const replies: Record<string, unknown>[] = [];
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.setAsyncPlanner(planner);
  c.setEvasionReplySender((reply) => replies.push(reply));
  c.handleDrive({ command_id: "ordinary", kind: "move", x: 420, y: 520, theta: 0 });
  c.handleEvasionPlan({ zone_id: "z", round_id: "round-2", mode: "REROUTE" });
  expect(planner.requests).toHaveLength(2);
  c.handleDrive({ command_id: "replacement", kind: "move", x: 420, y: 600, theta: 0 });
  expect(replies).toEqual([{ zone_id: "z", round_id: "round-2", result: "NONE", reason: "no path" }]);
  planner.requests[1].resolve({ follow: [{ x: 240, y: 560 }, { x: 420, y: 560 }], display: [{ x: 240, y: 560 }, { x: 420, y: 560 }] });
  planner.requests[2].resolve({ follow: [{ x: 240, y: 600 }, { x: 420, y: 600 }], display: [{ x: 240, y: 600 }, { x: 420, y: 600 }] });
  await Promise.resolve();
  expect(c.snapshot().commandId).toBe("replacement");
  expect(c.currentPath()).toEqual([{ x: 240, y: 600 }, { x: 420, y: 600 }]);
  expect(replies).toHaveLength(1);
});

test("VACATE cancels a pending ordinary plan before reversing", async () => {
  const planner = new DeferredPlanner();
  const replies: Record<string, unknown>[] = [];
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.setAsyncPlanner(planner);
  c.setEvasionReplySender((reply) => replies.push(reply));
  (c as any).trail = [{ x: 220, y: 520 }, { x: 240, y: 520 }];
  c.handleDrive({ command_id: "ordinary", kind: "move", x: 420, y: 520, theta: 0 });
  c.handleEvasionPlan({ zone_id: "z", round_id: "vacate-1", mode: "VACATE" });
  expect(planner.requests[0].cancelled).toBe(true);
  expect(c.snapshot().motion).toBe("REVERSE");
  const reversePath = c.currentPath();
  planner.requests[0].resolve({ follow: [{ x: 420, y: 520 }], display: [{ x: 420, y: 520 }] });
  await Promise.resolve();
  expect(c.currentPath()).toEqual(reversePath);
  expect(replies).toEqual([{ zone_id: "z", round_id: "vacate-1", result: "VACATE", reason: "ok" }]);
});

test("VACATE retreats in 10px steps, waits for peer clearance, and keeps the original command", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.attachTraffic(traffic());
  c.handleDrive({ command_id: "original-drive", kind: "move", x: 420, y: 520, theta: 0 });
  const internal = c as any;
  internal.trail = [180, 200, 220, 240].map((x) => ({ x, y: 520 }));
  let now = 10_000;
  const originalNow = Date.now;
  Date.now = () => now;
  const peer = [{ robotId: "peer", x: 260, y: 520, theta: 0, points: [{ x: 260, y: 520 }] }];
  try {
    c.handleEvasionPlan({ zone_id: "crossing", round_id: "stepback", mode: "VACATE" });
    expect(c.snapshot().commandId).toBe("original-drive");
    expect(internal.path.at(-1).x).toBe(230);
    c.setPeerLocalPlans(peer);
    for (let i = 0; i < 30; i++) internal.tick();
    expect(c.snapshot().x).toBeCloseTo(230, 0);
    const reached = c.snapshot();
    internal.tick();
    expect(c.snapshot().motion).toBe("HOLD");
    expect(c.snapshot().x).toBe(reached.x);
    for (let i = 0; i < 15; i++) internal.tick();
    expect(c.snapshot().x).toBe(reached.x);

    for (const expectedX of [220]) {
      now += STEP_BACK_WAIT_MS;
      c.setPeerLocalPlans(peer); // identical snapshots refresh observation freshness
      internal.tick();
      expect(internal.path.at(-1).x).toBe(expectedX);
      for (let i = 0; i < 30; i++) internal.tick();
      expect(c.snapshot().x).toBeCloseTo(expectedX, 0);
      internal.tick(); // begin the next five-second peer check
    }
    now += STEP_BACK_WAIT_MS;
    c.setPeerLocalPlans(peer);
    internal.tick(); // 40px from the peer: original mission is replanned
    expect(internal.stepBack).toBeNull();
    expect(c.snapshot().commandId).toBe("original-drive");
    expect(c.snapshot().motion).toBe("FOLLOW");
    expect(internal.trail.at(-1).x).toBeCloseTo(c.snapshot().x, 5);
  } finally {
    Date.now = originalNow;
  }
});

test("VACATE retains a blocked partial step and retries it only after a wait", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.handleDrive({ command_id: "blocked-step", kind: "move", x: 420, y: 520, theta: 0 });
  const internal = c as any;
  internal.trail = [{ x: 220, y: 520 }, { x: 240, y: 520 }];
  let now = 20_000;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    c.handleEvasionPlan({ zone_id: "wall", round_id: "blocked-step", mode: "VACATE" });
    c.setObstacles([{ id: "block-backstep", kind: "square", x: 235, y: 520, size: 12, theta: 0 }]);
    c.setPeerLocalPlans([]);
    for (let i = 0; i < 5; i++) internal.tick();
    const blockedAt = c.snapshot();
    expect(blockedAt.x).toBe(240);
    expect(internal.stepBack.stepIndex).toBe(0);
    expect(internal.stepBack.retryAt).toBe(now + STEP_BACK_WAIT_MS);
    for (let i = 0; i < 10; i++) internal.tick();
    expect(c.snapshot().x).toBe(blockedAt.x);
    c.setObstacles([]);
    internal.tick();
    expect(c.snapshot().x).toBe(blockedAt.x);
    now += STEP_BACK_WAIT_MS;
    c.setPeerLocalPlans([]);
    internal.tick();
    for (let i = 0; i < 30; i++) internal.tick();
    expect(c.snapshot().x).toBeCloseTo(230, 0);
    expect(internal.stepBack.stepIndex).toBe(0);
  } finally {
    Date.now = originalNow;
  }
});

test("VACATE cancels a pending REROUTE and ignores its late result", async () => {
  const planner = new DeferredPlanner();
  const replies: Record<string, unknown>[] = [];
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.setAsyncPlanner(planner);
  c.setEvasionReplySender((reply) => replies.push(reply));
  (c as any).trail = [{ x: 220, y: 520 }, { x: 240, y: 520 }];
  c.handleDrive({ command_id: "ordinary", kind: "move", x: 420, y: 520, theta: 0 });
  planner.requests[0].resolve({ follow: [{ x: 240, y: 520 }, { x: 420, y: 520 }], display: [{ x: 240, y: 520 }, { x: 420, y: 520 }] });
  await Promise.resolve();
  c.handleEvasionPlan({ zone_id: "z", round_id: "reroute-1", mode: "REROUTE" });
  expect(planner.requests).toHaveLength(2);
  c.handleEvasionPlan({ zone_id: "z", round_id: "vacate-2", mode: "VACATE" });
  expect(planner.requests[1].cancelled).toBe(true);
  expect(c.snapshot().motion).toBe("REVERSE");
  const reversePath = c.currentPath();
  planner.requests[1].resolve({ follow: [{ x: 240, y: 560 }, { x: 420, y: 560 }], display: [{ x: 240, y: 560 }, { x: 420, y: 560 }] });
  await Promise.resolve();
  expect(c.currentPath()).toEqual(reversePath);
  expect(replies).toEqual([
    { zone_id: "z", round_id: "reroute-1", result: "NONE", reason: "no path" },
    { zone_id: "z", round_id: "vacate-2", result: "VACATE", reason: "ok" },
  ]);
});

test("a superseding E2 round keeps its own release hint after old cancellation", async () => {
  const planner = new DeferredPlanner();
  const replies: Record<string, unknown>[] = [];
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.setAsyncPlanner(planner);
  c.setEvasionReplySender((reply) => replies.push(reply));
  c.handleDrive({ command_id: "ordinary", kind: "move", x: 420, y: 520, theta: 0 });
  planner.requests[0].resolve({ follow: [{ x: 240, y: 520 }, { x: 420, y: 520 }], display: [{ x: 240, y: 520 }, { x: 420, y: 520 }] });
  await Promise.resolve();
  const hintA = { segments: [{ x1: 280, y1: 500, x2: 300, y2: 500, r: 10 }] };
  const hintB = { segments: [{ x1: 280, y1: 540, x2: 300, y2: 540, r: 10 }] };
  c.handleEvasionPlan({ zone_id: "z", round_id: "e2-a", mode: "REROUTE", release_hint: hintA });
  expect(planner.requests).toHaveLength(2);
  c.handleEvasionPlan({ zone_id: "z", round_id: "e2-b", mode: "REROUTE", release_hint: hintB });
  expect(planner.requests[1].cancelled).toBe(true);
  expect(planner.requests).toHaveLength(3);
  expect(planner.requests[2].input.obstacles.some((obstacle) => obstacle.x === 280 && obstacle.y === 540)).toBe(true);
  planner.requests[1].resolve({ follow: [{ x: 240, y: 500 }, { x: 420, y: 500 }], display: [{ x: 240, y: 500 }, { x: 420, y: 500 }] });
  planner.requests[2].resolve({ follow: [{ x: 240, y: 500 }, { x: 420, y: 500 }, { x: 420, y: 520 }], display: [{ x: 240, y: 500 }, { x: 420, y: 500 }, { x: 420, y: 520 }] });
  await Promise.resolve();
  expect(replies).toEqual([
    { zone_id: "z", round_id: "e2-a", result: "NONE", reason: "no path" },
    { zone_id: "z", round_id: "e2-b", result: "REROUTE", reason: "ok" },
  ]);
  expect(c.currentPath()).toEqual([{ x: 240, y: 500 }, { x: 420, y: 500 }, { x: 420, y: 520 }]);
});

test("semantic snapshot fences and reissues an initial pending plan", async () => {
  const planner = new DeferredPlanner();
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.setAsyncPlanner(planner);
  c.handleDrive({ command_id: "semantic-refresh", kind: "move", x: 420, y: 520, theta: 0 });
  c.setSemanticSnapshot({ zones: [], obstacles: [] });
  expect(planner.requests).toHaveLength(2);
  expect(planner.requests[0].cancelled).toBe(true);
  planner.requests[1].resolve({ follow: [{ x: 420, y: 520 }], display: [{ x: 420, y: 520 }] });
  await Promise.resolve();
  expect(c.snapshot().motion).toBe("FOLLOW");
});

test("a stale worker result is rejected against the latest peer body and refreshed", async () => {
  const planner = new DeferredPlanner();
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.setAsyncPlanner(planner);
  c.handleDrive({ command_id: "stale-peer", kind: "move", x: 420, y: 520, theta: 0 });
  c.setPeerLocalPlans([{ robotId: "remote", x: 300, y: 520, theta: 0, points: [] }]);
  planner.requests[0].resolve({ follow: [{ x: 300, y: 520 }, { x: 420, y: 520 }], display: [{ x: 300, y: 520 }, { x: 420, y: 520 }] });
  await Promise.resolve();
  expect(planner.requests).toHaveLength(2);
  expect(c.currentPath()).toEqual([]);
  planner.requests[1].resolve({ follow: [{ x: 240, y: 560 }, { x: 420, y: 560 }, { x: 420, y: 520 }], display: [{ x: 240, y: 560 }, { x: 420, y: 560 }, { x: 420, y: 520 }] });
  await Promise.resolve();
  expect(c.snapshot().motion).toBe("FOLLOW");
});

test("two stale UI-obstacle results never resume the old path and retries stay rate-limited", async () => {
  const planner = new DeferredPlanner();
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.setAsyncPlanner(planner);
  const command = { command_id: "ui-stale", kind: "move", x: 420, y: 520, theta: 0 };
  const oldRoute: RoutePlan = {
    follow: [{ x: 240, y: 520 }, { x: 420, y: 520 }],
    display: [{ x: 240, y: 520 }, { x: 420, y: 520 }],
  };
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    c.handleDrive(command);
    planner.requests[0].resolve(oldRoute);
    await Promise.resolve();
    expect(c.snapshot().motion).toBe("FOLLOW");

    c.setObstacles([{ id: "ui-wall", kind: "square", x: 330, y: 520, size: 20, theta: 0 }]);
    expect(planner.requests).toHaveLength(2);
    planner.requests[1].resolve(oldRoute);
    await Promise.resolve();
    expect(planner.requests).toHaveLength(3);
    planner.requests[2].resolve(oldRoute);
    await Promise.resolve();

    expect(c.snapshot().motion).toBe("HOLD");
    expect(c.snapshot().commandId).toBe(command.command_id);
    expect(c.snapshot().commandState).toBe("running");
    expect(c.snapshot().driveState).toBe("blocked");
    expect(JSON.parse(c.snapshot().driveContextJson!)[0].reasonCode).toBe("obstacle_detected");
    const heldPose = c.snapshot();

    // The first retry may happen on the next HOLD tick, but subsequent ticks
    // in the same 800ms window must not fan out more requests or resume the
    // stale path.
    (c as any).tick();
    expect(planner.requests).toHaveLength(4);
    for (let i = 0; i < 20; i++) (c as any).tick();
    expect(planner.requests).toHaveLength(4);
    expect(c.snapshot().motion).toBe("HOLD");
    expect(c.snapshot().x).toBe(heldPose.x);
    expect(c.snapshot().y).toBe(heldPose.y);
    planner.requests[3].resolve(null);
    await Promise.resolve();

    now += 799;
    (c as any).tick();
    expect(planner.requests).toHaveLength(4);
    now += 1;
    (c as any).tick();
    expect(planner.requests).toHaveLength(5);
    expect(c.snapshot().motion).toBe("HOLD");
  } finally {
    Date.now = originalNow;
  }
});

test("synchronous replanning receives UI obstacle geometry and follows a safe detour", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  const obstacle = { id: "sync-ui-wall", kind: "square" as const, x: 330, y: 520, size: 20, theta: 0 };
  c.setObstacles([obstacle]);
  c.handleDrive({ command_id: "sync-obstacle", kind: "move", x: 420, y: 520, theta: 0 });
  const display = c.currentPath();
  expect(display.length).toBeGreaterThan(2);
  for (let i = 1; i < display.length; i++) {
    const a = display[i - 1], b = display[i];
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const heading = distance > 1e-9 ? Math.atan2(b.y - a.y, b.x - a.x) : 0;
    const steps = Math.max(1, Math.ceil(distance));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      expect(poseHitsObstacle(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, heading, obstacle)).toBe(false);
    }
  }
  const before = c.snapshot();
  for (let i = 0; i < 20; i++) (c as any).tick();
  const after = c.snapshot();
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(0);
  expect(after.commandId).toBe("sync-obstacle");
  expect(after.commandState).toBe("running");
});

test("async replanning gates motion and rejects a result anchored at a drifted pose", async () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.attachTraffic(traffic());
  c.handleDrive({ command_id: "drift", kind: "move", x: 420, y: 520, theta: 0 });
  for (let i = 0; i < 20; i++) (c as any).tick();
  expect(c.snapshot().motion).toBe("FOLLOW");

  const planner = new DeferredPlanner();
  c.setAsyncPlanner(planner);
  c.setObstacles([]);
  expect(c.snapshot().motion).toBe("HOLD");
  const requestStart = planner.requests[0].input.start;

  // Simulate a physical pose report arriving while the delayed result is in
  // flight. The tick gate must not advance the old path, and the old result
  // must be refreshed from the new pose instead of backtracking.
  (c as any).x = requestStart.x + 5;
  (c as any).tick();
  expect(c.snapshot().x).toBe(requestStart.x + 5);
  planner.requests[0].resolve({ follow: [{ x: requestStart.x, y: requestStart.y }, { x: 420, y: 520 }], display: [{ x: requestStart.x, y: requestStart.y }, { x: 420, y: 520 }] });
  await Promise.resolve();
  expect(planner.requests).toHaveLength(2);
  expect(planner.requests[1].input.start.x).toBe(requestStart.x + 5);
  expect(c.snapshot().motion).toBe("HOLD");

  const refreshedStart = planner.requests[1].input.start;
  planner.requests[1].resolve({ follow: [{ ...refreshedStart }, { x: 420, y: 520 }], display: [{ ...refreshedStart }, { x: 420, y: 520 }] });
  await Promise.resolve();
  expect(c.snapshot().motion).toBe("FOLLOW");
  const beforeTick = c.snapshot().x;
  (c as any).tick();
  expect(c.snapshot().x).toBeGreaterThan(beforeTick);
});

test("drive context reports pending route updates, while an actual block wins", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.attachTraffic(traffic());
  c.handleDrive({ command_id: "context", kind: "move", x: 420, y: 520, theta: 0 });
  const planner = new DeferredPlanner();
  c.setAsyncPlanner(planner);
  c.setObstacles([]);
  expect(JSON.parse(c.snapshot().driveContextJson!)[0].reasonCode).toBe("route_update_pending");
  c.setPeerLocalPlans([{ robotId: "blocker", x: 250, y: 520, theta: 0, points: [] }]);
  expect(JSON.parse(c.snapshot().driveContextJson!)[0].reasonCode).toBe("obstacle_detected");
  c.handleCancel("context");
});

test("short blocked goal retries from HOLD after the peer clears", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.attachTraffic(traffic());
  c.handleDrive({ command_id: "short-goal", kind: "move", x: 420, y: 520, theta: 0 });
  c.setPeerLocalPlans([{ robotId: "goal-blocker", x: 420, y: 520, theta: 0, points: [] }]);
  // Reproduce the controller state after a planner snapped short of a
  // temporarily occupied goal. This keeps the test focused on HOLD retry,
  // independent of the exact detour chosen by the map A*.
  const internal = c as any;
  internal.path = [{ x: 260, y: 520 }];
  internal.displayPath = [{ x: 260, y: 520 }];
  internal.pathIndex = 1;
  internal.phase = "hold";
  internal.status = "move";
  internal.lastPeerReplanMs = Date.now();
  expect(c.snapshot().motion).toBe("HOLD");
  c.setPeerLocalPlans([]);
  expect(c.snapshot().motion).toBe("HOLD");
  internal.lastPeerReplanMs = 0;
  internal.tick();
  expect(["FOLLOW", "ROTATE"]).toContain(c.snapshot().motion);
  expect(c.snapshot().x).toBeLessThanOrEqual(420);
});

test("a cancelled async plan cannot commit after control disable", async () => {
  const planner = new DeferredPlanner();
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.setAsyncPlanner(planner);
  c.handleDrive({ command_id: "stale", kind: "move", x: 420, y: 520, theta: 0 });
  expect(planner.requests).toHaveLength(1);
  c.setControlState({ enabled: false, controlEpoch: 2, sessionId: "disabled" });
  planner.requests[0].resolve({ follow: [{ x: 420, y: 520 }], display: [{ x: 420, y: 520 }] });
  await Promise.resolve();
  expect(c.snapshot().status).toBe("idle");
  expect(c.currentPath()).toEqual([]);
});

test("planning diagnostics preserve timeout and no-route distinctions", async () => {
  const planner = new DeferredPlanner();
  const events: any[] = [];
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.setAsyncPlanner(planner);
  c.setPlanningEventHandler((event) => events.push(event));
  c.handleDrive({ command_id: "diagnostic-timeout", kind: "move", x: 420, y: 520, theta: 0 });
  planner.requests[0].failure = { kind: "timeout", message: "planning time budget exceeded" };
  planner.requests[0].resolve(null);
  await Promise.resolve();
  expect(events.at(-1)).toMatchObject({ phase: "failed", failureReason: "timeout", error: "planning time budget exceeded" });
  c.handleDrive({ command_id: "diagnostic-no-route", kind: "move", x: 420, y: 520, theta: 0 });
  planner.requests[1].failure = { kind: "no_route", message: "no path" };
  planner.requests[1].resolve(null);
  await Promise.resolve();
  expect(events.at(-1)).toMatchObject({ phase: "failed", failureReason: "no_route", error: "no path" });
});

test("explicit cancel fences an in-flight async route", async () => {
  const planner = new DeferredPlanner();
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.setAsyncPlanner(planner);
  c.handleDrive({ command_id: "cancel-stale", kind: "move", x: 420, y: 520, theta: 0 });
  c.handleCancel("cancel-stale");
  planner.requests[0].resolve({ follow: [{ x: 420, y: 520 }], display: [{ x: 420, y: 520 }] });
  await Promise.resolve();
  expect(c.snapshot().status).toBe("idle");
  expect(c.currentPath()).toEqual([]);
});

test("late async plan is fenced after pose reset and map-context reset", async () => {
  const planner = new DeferredPlanner();
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.setAsyncPlanner(planner);
  c.handleDrive({ command_id: "pose-stale", kind: "move", x: 420, y: 520, theta: 0 });
  c.setControlState({ enabled: false, controlEpoch: 3, sessionId: "pose-reset" });
  expect(c.applyOperatorPoseOverride({ x: 320, y: 520, theta: 0 })).toBe(true);
  planner.requests[0].resolve({ follow: [{ x: 420, y: 520 }], display: [{ x: 420, y: 520 }] });
  await Promise.resolve();
  expect(c.snapshot().x).toBe(320);
  expect(c.currentPath()).toEqual([]);

  c.resetMapContext();
  expect(c.snapshot().status).toBe("idle");
});

test("pose override ignores peer future-plan cells but rejects current peer body", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.setPeerLocalPlans([{ robotId: "peer", x: 600, y: 520, theta: 0, points: [{ x: 320, y: 520 }, { x: 360, y: 520 }] }]);
  expect(c.applyOperatorPoseOverride({ x: 320, y: 520, theta: 0 })).toBe(true);
  c.setMapPose({ x: 240, y: 520, theta: 0 });
  c.setPeerLocalPlans([{ robotId: "peer", x: 320, y: 520, theta: 0, points: [] }]);
  expect(c.applyOperatorPoseOverride({ x: 320, y: 520, theta: 0 })).toBe(false);
});

test("disconnect holds an active mission until a fresh snapshot arrives", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.attachTraffic(traffic());
  c.handleDrive({ command_id: "a", kind: "move", x: 280, y: 520, theta: 0 });
  c.setConnectionReady(false);
  (c as any).tick();
  expect(c.snapshot().motion).toBe("HOLD");
  c.setConnectionReady(true);
  (c as any).tick();
  expect(c.snapshot().motion).toBe("HOLD");
});

test("a relevant capacity zone with no permission fails closed", () => {
  const c = new RobotController({ x: 260, y: 520, theta: 0 });
  c.setSemanticSnapshot({ zones: [{ id: "g", family: "scene", kind: "corridor", name: "", polygon: [{ x: 300, y: 480 }, { x: 340, y: 480 }, { x: 340, y: 560 }, { x: 300, y: 560 }], theta: 0, capacity: 1 }], obstacles: [] });
  c.handleDrive({ command_id: "g", kind: "move", x: 380, y: 520, theta: 0 });
  for (let i = 0; i < 100; i++) (c as any).tick();
  expect(c.snapshot().x).toBeLessThan(300);
  expect(c.snapshot().trafficStatus).toBe("hold");
});

test("live forbidden update holds the mission and removal resumes it", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.handleDrive({ command_id: "f", kind: "move", x: 280, y: 520, theta: 0 });
  c.setSemanticSnapshot({ zones: [{ id: "f", family: "scene", kind: "forbidden", name: "", polygon: [{ x: 220, y: 500 }, { x: 270, y: 500 }, { x: 270, y: 540 }, { x: 220, y: 540 }], theta: 0 }], obstacles: [] });
  expect(c.snapshot().motion).toBe("HOLD");
  c.setSemanticSnapshot({ zones: [], obstacles: [] });
  expect(c.snapshot().motion).toBe("FOLLOW");
});

test("controller follows the prefer interior instead of the adjacent avoid boundary", () => {
  const c = new RobotController({ x: 240, y: 505, theta: 0 });
  c.setSemanticSnapshot({ zones: [
    { id: "prefer", family: "scene", kind: "prefer", name: "", polygon: [{ x: 250, y: 500 }, { x: 420, y: 500 }, { x: 420, y: 620 }, { x: 250, y: 620 }], theta: 0, factor: 0.35 },
    { id: "avoid", family: "scene", kind: "avoid", name: "", polygon: [{ x: 250, y: 470 }, { x: 420, y: 470 }, { x: 420, y: 500 }, { x: 250, y: 500 }], theta: 0, factor: 4 },
  ], obstacles: [] });
  c.handleDrive({ command_id: "interior", kind: "move", x: 430, y: 505, theta: 0 });
  expect(c.currentPath().some((point) => point.x > 320 && point.x < 380 && point.y > 540)).toBe(true);
});

test("invalid replacement cancels the active mission and reports the new rejection", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.handleDrive({ command_id: "active", kind: "move", x: 420, y: 520, theta: 0 });
  c.handleDrive({ command_id: "bad", kind: "move", x: Number.NaN, y: 520, theta: 0 });
  expect(c.snapshot().commandId).toBe("bad");
  expect(c.snapshot().commandState).toBe("rejected");
  expect(c.snapshot().motion).toBe("IDLE");
});

test("control generation cancels a mission, while duplicate state is idempotent", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.handleDrive({ command_id: "active", kind: "move", x: 420, y: 520, theta: 0 });
  c.setControlState({ enabled: true, controlEpoch: 2, sessionId: "new-session" });
  expect(c.snapshot().status).toBe("idle");
  expect(c.snapshot().commandState).toBe("cancelled");
  c.setControlState({ enabled: true, controlEpoch: 2, sessionId: "new-session" });
  expect(c.snapshot().status).toBe("idle");
});

test("operator pose override clears an active mission and stays stationary", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  const t = traffic();
  const clear = spyOn(t, "clear");
  c.attachTraffic(t);
  c.handleDrive({ command_id: "old-drive", kind: "move", x: 420, y: 520, theta: 0 });
  expect(c.currentPath()).not.toEqual([]);
  // Override commands arrive after FMS advances to a disabled epoch.
  c.setControlState({ enabled: false, controlEpoch: 1, sessionId: "override-epoch" });
  const clearsBeforeOverride = clear.mock.calls.length;

  expect(c.applyOperatorPoseOverride({ x: 320, y: 520, theta: Math.PI / 2 })).toBe(true);
  expect(clear.mock.calls.length).toBeGreaterThan(clearsBeforeOverride);
  expect(c.currentPath()).toEqual([]);
  expect(c.snapshot()).toMatchObject({
    x: 320,
    y: 520,
    theta: Math.PI / 2,
    status: "idle",
    motion: "IDLE",
    workState: "idle",
    driveState: "stationary",
    commandId: "",
    commandState: "idle",
  });
  (c as any).tick();
  expect(c.snapshot().x).toBe(320);
  expect(c.snapshot().y).toBe(520);
});

test("invalid operator override preserves the active mission", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.handleDrive({ command_id: "old-drive", kind: "move", x: 420, y: 520, theta: 0 });
  const before = c.snapshot();
  const path = c.currentPath();
  expect(c.applyOperatorPoseOverride({ x: Number.NaN, y: 520, theta: 0 })).toBe(false);
  expect(c.snapshot().x).toBe(before.x);
  expect(c.currentPath()).toEqual(path);
  expect(c.snapshot().commandId).toBe("old-drive");
});

test("disabled control ignores motion and traffic grants while telemetry remains physical", () => {
  let requests = 0;
  const t = new LocalPlanExecutor({ sendLeaseRequest: () => requests++, sendLeaseRelease: () => {} });
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.attachTraffic(t);
  c.setControlState({ enabled: false, controlEpoch: 1, sessionId: "s" });
  c.handleDrive({ command_id: "blocked", kind: "move", x: 420, y: 520, theta: 0 });
  c.onTrafficGrant({ requestId: "r", leaseId: "l", signal: "PROCEED", held: { segments: [] }, leaseDurationMs: 1000, zoneId: "z", reason: "" });
  for (let i = 0; i < 20; i++) (c as any).tick();
  expect(c.snapshot().x).toBe(240);
  expect(c.snapshot().workState).toBe("idle");
  expect(requests).toBe(0);
});

test("rotation reports moving consistently across repeated snapshots", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.handleDrive({ command_id: "turn", kind: "move", x: 240, y: 520, theta: Math.PI / 2 });
  (c as any).tick();
  const a = c.snapshot();
  const b = c.snapshot();
  expect(a.driveState).toBe("moving");
  expect(b.driveState).toBe("moving");
});

test("distinguishes rotation-only progress from a completely unchanged pose", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  const internal = c as any;
  internal.lastMotionAt = 0;
  expect(internal.tryMove(240, 520, 0)).toBe(false);
  expect(internal.lastMotionAt).toBe(0);
  expect(c.snapshot().driveState).toBe("stationary");

  expect(internal.tryMove(240, 520, Math.PI / 2)).toBe(true);
  expect(c.snapshot().x).toBe(240);
  expect(c.snapshot().y).toBe(520);
  expect(c.snapshot().theta).toBeCloseTo(Math.PI / 2);
  expect(internal.lastMotionAt).toBeGreaterThan(0);
});

test("FMS STOP freezes an obstacle hold without bypassing traffic arbitration", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  const t = traffic();
  c.attachTraffic(t);
  c.handleDrive({ command_id: "stop-freeze", kind: "move", x: 420, y: 520, theta: 0 });
  t.onGrant({ requestId: "stop", leaseId: "lease-stop", signal: "STOP", held: { segments: [] }, leaseDurationMs: 1_000, zoneId: "z", reason: "test" });
  const before = c.snapshot();
  for (let i = 0; i < 40; i++) (c as any).tick();
  const after = c.snapshot();
  expect(after.motion).toBe("HOLD");
  expect(after.trafficStatus).toBe("stop");
  expect(after.x).toBe(before.x);
  expect(after.y).toBe(before.y);
  expect(after.commandId).toBe("stop-freeze");
});

test("semantic permission context names its zone and keeps a stable since time", () => {
  const c = new RobotController({ x: 320, y: 520, theta: 0 });
  c.setSemanticSnapshot({ zones: [{ id: "gate", family: "scene", kind: "corridor", name: "", polygon: [{ x: 300, y: 480 }, { x: 340, y: 480 }, { x: 340, y: 560 }, { x: 300, y: 560 }], theta: 0, capacity: 1 }], obstacles: [] });
  c.handleDrive({ command_id: "wait", kind: "move", x: 380, y: 520, theta: 0 });
  c.onTrafficZoneUpdate("semantic:gate", "STOP");
  const first = JSON.parse(c.snapshot().driveContextJson!)[0];
  const second = JSON.parse(c.snapshot().driveContextJson!)[0];
  expect(first.target).toEqual({ mapId: "yard", kind: "zone", id: "gate" });
  expect(first.permissionState).toBe("pending");
  expect(second.since).toBe(first.since);
});

test("teleporter constraints stop full body at a reserved endpoint and resume when released", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.setTeleporterConstraints({ blocked: [{ id: "t:b", polygon: [{ x: 245, y: 500 }, { x: 290, y: 500 }, { x: 290, y: 540 }, { x: 245, y: 540 }] }] });
  c.handleDrive({ command_id: "cross", kind: "move", x: 340, y: 520, theta: 0 });
  for (let i = 0; i < 100; i++) (c as any).tick();
  expect(c.snapshot().x).toBeLessThan(245);
  expect(c.snapshot().motion).toBe("HOLD");
  c.setTeleporterConstraints({ blocked: [] });
  for (let i = 0; i < 100; i++) (c as any).tick();
  expect(c.snapshot().x).toBeGreaterThan(245);
});

test("repeated identical teleporter snapshots do not restart a rotation", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  const constraints = { blocked: [{ id: "t", polygon: [{ x: 600, y: 500 }, { x: 640, y: 500 }, { x: 640, y: 540 }, { x: 600, y: 540 }] }] };
  c.handleDrive({ command_id: "turn", kind: "move", x: 240, y: 520, theta: Math.PI / 2 });
  c.setTeleporterConstraints(constraints);
  for (let i = 0; i < 5; i++) (c as any).tick();
  const before = c.snapshot().theta;
  for (let i = 0; i < 20; i++) c.setTeleporterConstraints(constraints);
  expect(c.snapshot().theta).toBe(before);
});

test("teleporter clearing resumes after control reset but ignores active and terminal duplicates", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.setTeleporterArrival({ x: 240, y: 520, theta: 0 }, { x: 280, y: 520 }, "handoff");
  const first = c.snapshot().commandState;
  c.setTeleporterArrival({ x: 240, y: 520, theta: 0 }, { x: 280, y: 520 }, "handoff");
  expect(c.snapshot().commandState).toBe(first);
  c.setControlState({ enabled: true, controlEpoch: 2, sessionId: "reconnected" });
  c.setTeleporterArrival({ x: 240, y: 520, theta: 0 }, { x: 280, y: 520 }, "handoff");
  expect(["accepted", "running"]).toContain(c.snapshot().commandState);
  const beforeResume = c.snapshot().x;
  (c as any).tick();
  expect(c.snapshot().x).toBeGreaterThan(beforeResume);

  const completed = new RobotController({ x: 240, y: 520, theta: 0 });
  completed.setTeleporterArrival({ x: 240, y: 520, theta: 0 }, { x: 280, y: 520 }, "finished");
  for (let i = 0; i < 300 && completed.snapshot().commandState !== "completed"; i++) (completed as any).tick();
  expect(completed.snapshot().commandState).toBe("completed");
  const terminalPose = completed.snapshot();
  completed.setTeleporterArrival({ x: 240, y: 520, theta: 0 }, { x: 280, y: 520 }, "finished");
  expect(completed.snapshot().commandState).toBe("completed");
  expect(completed.snapshot().x).toBe(terminalPose.x);
  expect(completed.snapshot().y).toBe(terminalPose.y);
});
