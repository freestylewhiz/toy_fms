import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { RobotController } from "./controller.ts";
import { clearSemanticZones } from "../../shared/planner.ts";
import type { AsyncRoutePlanner, PlanningInput, RoutePlan } from "./planning.ts";

afterEach(() => { mock.restore(); clearSemanticZones(); });

class ReviewPlanner implements AsyncRoutePlanner {
  requests: Array<{ input: PlanningInput; resolve: (plan: RoutePlan | null) => void }> = [];
  request(input: PlanningInput) {
    let resolve!: (plan: RoutePlan | null) => void;
    const promise = new Promise<RoutePlan | null>((done) => { resolve = done; });
    this.requests.push({ input, resolve });
    return { promise, cancel() {} };
  }
}

async function mission() {
  const controller = new RobotController({ x: 240, y: 520, theta: 0 });
  const planner = new ReviewPlanner();
  const replies: any[] = [], events: any[] = [];
  controller.setAsyncPlanner(planner);
  controller.setEvasionReplySender(reply => replies.push(reply));
  controller.setPlanningEventHandler(event => events.push(event));
  controller.handleDrive({ command_id: "budget-review", kind: "move", x: 440, y: 520, theta: 0 });
  planner.requests.at(-1)!.resolve({ follow: [{ x: 340, y: 520 }, { x: 440, y: 520 }], display: [{ x: 440, y: 520 }] });
  await Promise.resolve();
  return { controller, planner, replies, events };
}

test("successive accepted and rejected REROUTEs keep the original 10m baseline", async () => {
  const r = await mission();
  const reroute = async (round: string, offset: number) => {
    r.controller.handleEvasionPlan({ zone_id: "review", round_id: round, mode: "REROUTE" });
    const points = [{ x: 240, y: 520 + offset }, { x: 440, y: 520 + offset }, { x: 440, y: 520 }];
    r.planner.requests.at(-1)!.resolve({ follow: points, display: points });
    await Promise.resolve();
  };
  await reroute("accepted", 30); // 13m exactly
  expect(r.replies.at(-1)?.result).toBe("REROUTE");
  await reroute("rejected", 40); // 14m, even though 13m was just accepted
  expect(r.replies.at(-1)?.result).toBe("NONE");
  expect(r.events.findLast(event => event.kind === "navigation.detour_rejected")).toMatchObject({
    commandId: "budget-review", baselineLengthM: 10, candidateLengthM: 14, allowedLengthM: 13,
    reason: "detour-too-long", fallback: "await-vacate", level: "warn",
  });
});

test("cancel during reroute prevents late candidate and rejection diagnostics from changing the command", async () => {
  const r = await mission();
  r.controller.handleEvasionPlan({ zone_id: "review", round_id: "cancel", mode: "REROUTE" });
  const request = r.planner.requests.at(-1)!;
  r.controller.handleCancel("budget-review");
  const points = [{ x: 240, y: 620 }, { x: 440, y: 620 }, { x: 440, y: 520 }];
  request.resolve({ follow: points, display: points });
  await Promise.resolve();
  expect(r.controller.snapshot().commandState).toBe("cancelled");
  expect(r.controller.currentPath()).toEqual([]);
  expect(r.events.filter(event => event.kind === "navigation.detour_rejected")).toEqual([]);
});

test("the frozen reference is detached from the planner result array", async () => {
  const r = await mission();
  const internal = r.controller as any;
  const reference = JSON.stringify(internal.originalCommandRoute);
  internal.path[0].y += 100;
  expect(JSON.stringify(internal.originalCommandRoute)).toBe(reference);
});

test("an unchanged environment snapshot cannot bypass a rejected peer detour", async () => {
  const r = await mission();
  const points = [{ x: 240, y: 620 }, { x: 440, y: 620 }, { x: 440, y: 520 }];
  r.controller.handleEvasionPlan({ zone_id: "review", round_id: "snapshot", mode: "REROUTE" });
  r.planner.requests.at(-1)!.resolve({ follow: points, display: points });
  await Promise.resolve();
  expect(r.replies.at(-1)?.result).toBe("NONE");
  const count = r.planner.requests.length;
  r.controller.setSemanticSnapshot({ zones: [], obstacles: [] });
  if (r.planner.requests.length > count) {
    r.planner.requests.at(-1)!.resolve({ follow: points, display: points });
    await Promise.resolve();
  }
  expect(r.controller.currentPath()).not.toEqual(points);
});

test("resuming after direct VACATE still checks the original budget", async () => {
  const r = await mission();
  const internal = r.controller as any;
  internal.trail = [{ x: 220, y: 520 }, { x: 240, y: 520 }];
  r.controller.handleEvasionPlan({ zone_id: "review", round_id: "vacate", mode: "VACATE" });
  internal.finishReverse();
  const points = [{ x: 240, y: 620 }, { x: 440, y: 620 }, { x: 440, y: 520 }];
  r.planner.requests.at(-1)!.resolve({ follow: points, display: points });
  await Promise.resolve();
  expect(r.controller.currentPath()).not.toEqual(points);
  expect(r.events.findLast(event => event.kind === "navigation.detour_rejected")?.reason).toBe("detour-too-long");
});

test("an accepted detour does not lose its budget on unchanged environment refresh", async () => {
  const r = await mission();
  r.controller.handleEvasionPlan({ zone_id: "review", round_id: "bounded", mode: "REROUTE" });
  const small = [{ x: 240, y: 540 }, { x: 440, y: 540 }, { x: 440, y: 520 }];
  r.planner.requests.at(-1)!.resolve({ follow: small, display: small });
  await Promise.resolve();
  expect(r.replies.at(-1)?.result).toBe("REROUTE");
  const count = r.planner.requests.length;
  r.controller.setSemanticSnapshot({ zones: [], obstacles: [] });
  const large = [{ x: 240, y: 620 }, { x: 440, y: 620 }, { x: 440, y: 520 }];
  if (r.planner.requests.length > count) {
    r.planner.requests.at(-1)!.resolve({ follow: large, display: large });
    await Promise.resolve();
  }
  expect(r.controller.currentPath()).not.toEqual(large);
});

test("local peer detour rejection retreats 0.5m and holds the five second observation window", async () => {
  let now = 100_000;
  spyOn(Date, "now").mockImplementation(() => now);
  const r = await mission();
  const internal = r.controller as any;
  internal.trail = [{ x: 180, y: 520 }, { x: 240, y: 520 }];
  const peers = [{ robotId: "crossing", x: 340, y: 600, theta: 0, points: [{ x: 340, y: 520 }] }];
  r.controller.setPeerLocalPlans(peers);
  expect(r.planner.requests).toHaveLength(2);
  const large = [{ x: 240, y: 420 }, { x: 440, y: 420 }, { x: 440, y: 520 }];
  r.planner.requests.at(-1)!.resolve({ follow: large, display: large });
  await Promise.resolve();
  expect(r.events.findLast(event => event.kind === "navigation.detour_rejected")).toMatchObject({
    fallback: "step-back-request", reason: "detour-too-long", stepBackDistanceM: 0.5, stepBackWaitMs: 5000,
  });
  expect(internal.stepBack).not.toBeNull();
  for (let tick = 0; tick < 200 && internal.stepBack?.waitUntil == null; tick++) {
    r.controller.setPeerLocalPlans(peers);
    internal.tick();
    now += 50;
  }
  expect(r.controller.snapshot().x).toBeCloseTo(230, 6);
  const deadline = internal.stepBack.waitUntil;
  expect(deadline).toBeGreaterThan(now);
  now = deadline - 1;
  r.controller.setPeerLocalPlans(peers);
  internal.tick();
  expect(r.controller.snapshot().x).toBeCloseTo(230, 6);
  expect(internal.stepBack.stepIndex).toBe(0);
});

test("a real fixed obstacle change allows the separate environment replan", async () => {
  const r = await mission();
  const large = [{ x: 240, y: 420 }, { x: 440, y: 420 }, { x: 440, y: 520 }];
  r.controller.handleEvasionPlan({ zone_id: "review", round_id: "before-wall", mode: "REROUTE" });
  r.planner.requests.at(-1)!.resolve({ follow: large, display: large });
  await Promise.resolve();
  expect(r.replies.at(-1)?.result).toBe("NONE");
  r.controller.setObstacles([{ id: "new-wall", kind: "circle", x: 340, y: 520, size: 15, theta: 0 }]);
  r.planner.requests.at(-1)!.resolve({ follow: large, display: large });
  await Promise.resolve();
  expect(r.controller.currentPath()).toEqual(large);
});
