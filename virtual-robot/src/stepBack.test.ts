import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { RobotController } from "./controller.ts";
import { LocalPlanExecutor } from "./traffic/LocalPlanExecutor.ts";
import { STEP_BACK_WAIT_MS, TICK_MS } from "../../shared/constants.ts";
import { clearSemanticZones } from "../../shared/planner.ts";

afterEach(() => { mock.restore(); clearSemanticZones(); });

function retreat(trail = [{ x: 180, y: 520 }, { x: 240, y: 520 }]) {
  let now = 100_000;
  spyOn(Date, "now").mockImplementation(() => now);
  const controller = new RobotController({ x: 240, y: 520, theta: Math.PI });
  const traffic = new LocalPlanExecutor({ sendLeaseRequest: () => {}, sendLeaseRelease: () => {} });
  controller.attachTraffic(traffic);
  controller.handleDrive({ command_id: "mission", kind: "move", x: 420, y: 520, theta: 0 });
  const state = controller as any;
  state.trail = trail;
  controller.handleEvasionPlan({ zone_id: "crossing", round_id: "first", mode: "VACATE" });
  const peers = [{ robotId: "peer", x: 400, y: 700, theta: 0, points: [{ x: 240, y: 400 }, { x: 240, y: 700 }] }];
  const tick = (count = 1, fresh = true) => {
    for (let i = 0; i < count; i++) {
      if (fresh) controller.setPeerLocalPlans(peers);
      state.tick();
      now += TICK_MS;
    }
  };
  const reachWait = () => {
    for (let i = 0; i < 100 && state.stepBack?.waitUntil == null; i++) tick();
    expect(state.stepBack?.waitUntil).not.toBeNull();
  };
  return { controller, traffic, state, tick, reachWait, jump: (time: number) => { now = time; } };
}

test("each retreat trial holds five seconds even with unchanged live peer snapshots", () => {
  const r = retreat();
  expect(STEP_BACK_WAIT_MS).toBe(5000);
  r.reachWait();
  expect(r.controller.snapshot().x).toBeCloseTo(230, 6);
  const deadline = r.state.stepBack.waitUntil;
  r.jump(deadline - 1);
  r.tick();
  expect(r.controller.snapshot().x).toBeCloseTo(230, 6);
  r.jump(deadline);
  r.tick();
  expect(r.state.stepBack.stepIndex).toBe(1);
  expect(r.controller.snapshot().x).toBeLessThan(230);
  expect(r.controller.currentPath().at(-1)?.x).toBeCloseTo(220, 6);
  expect(r.controller.snapshot().commandId).toBe("mission");
});

test("original command cancellation during the wait retains the actual unconsumed trail", () => {
  const r = retreat([{ x: 220, y: 500 }, { x: 220, y: 520 }, { x: 240, y: 520 }]);
  r.reachWait();
  r.controller.handleCancel("mission");
  expect(r.controller.snapshot().commandState).toBe("cancelled");
  expect(r.state.stepBack).toBeNull();
  expect(r.state.trail).toContainEqual({ x: 220, y: 520 });
  expect(r.state.trail.at(-1)).toEqual({ x: 230, y: 520 });
  const pose = r.controller.snapshot();
  r.tick(150);
  expect(r.controller.snapshot().x).toBe(pose.x);
  expect(r.controller.currentPath()).toEqual([]);
});

test("new evasion rounds preserve the active segment and wait; replacement mission clears retreat", () => {
  const r = retreat();
  r.tick(4);
  const active = r.state.stepBack;
  const path = r.controller.currentPath();
  r.controller.handleEvasionPlan({ zone_id: "another", round_id: "second", mode: "VACATE" });
  r.controller.handleEvasionPlan({ zone_id: "third", round_id: "third", mode: "REROUTE" });
  expect(r.state.stepBack).toBe(active);
  expect(r.controller.currentPath()).toEqual(path);
  r.controller.handleDrive({ command_id: "replacement", kind: "move", x: 340, y: 570, theta: 0 });
  expect(r.state.stepBack).toBeNull();
  expect(r.controller.snapshot().commandId).toBe("replacement");
});

test("manual pause and tokenized STOP freeze a partial retreat without consuming its route", () => {
  const r = retreat();
  r.tick(3);
  const x = r.controller.snapshot().x;
  const step = r.state.stepBack.stepIndex;
  r.controller.setOperatorPaused(true);
  r.tick(120);
  expect(r.controller.snapshot().x).toBe(x);
  r.controller.setOperatorPaused(false);
  r.traffic.onGrant({ leaseId: "stop", signal: "STOP", held: { segments: [] }, leaseDurationMs: 400, zoneId: "crossing", reason: "conflict", stopId: "stop-1", stopGeneration: "1" });
  r.tick(120);
  expect(r.controller.snapshot().x).toBe(x);
  expect(r.state.stepBack.stepIndex).toBe(step);
  r.controller.onTrafficStopStatus({ stop_id: "stop-1", stop_generation: "1", decision: "RESUME" });
  r.tick();
  expect(r.controller.snapshot().x).toBeLessThan(x);
});

test("exhausted breadcrumbs do not invent further retreat or reverse forward", () => {
  const r = retreat([{ x: 220, y: 520 }]);
  r.tick(500);
  expect(r.controller.snapshot().x).toBeCloseTo(220, 6);
  expect(r.controller.snapshot().motion).toBe("HOLD");
  expect(r.state.stepBack).not.toBeNull();
  expect(r.controller.snapshot().commandId).toBe("mission");
});

test("a stale peer snapshot cannot authorize the next trial", () => {
  const r = retreat();
  r.reachWait();
  r.jump(r.state.stepBack.waitUntil);
  r.tick(1, false);
  expect(r.state.stepBack.stepIndex).toBe(0);
  expect(r.controller.snapshot().x).toBeCloseTo(230, 6);
});
