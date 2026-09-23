import { afterEach, expect, test } from "bun:test";
import { LocalPlanExecutor } from "./LocalPlanExecutor.ts";

const snap = (avoidanceMode = true) => ({
  x: 100, y: 100, theta: 0, path: [{ x: 100, y: 100 }, { x: 180, y: 100 }],
  pathIndex: 1, phase: "hold", avoidanceMode,
});

afterEach(() => {
  // Tests that freeze time restore it before returning; this is a guard for
  // failed assertions so later traffic tests retain normal clock behavior.
  Date.now = originalNow;
});

const originalNow = Date.now;

test("tokenized STOP survives evade, grants, zone resume, clear, and disabled avoidance", () => {
  let now = 10_000;
  Date.now = () => now;
  const checks: unknown[] = [];
  const executor = new LocalPlanExecutor({
    sendLeaseRequest: () => {}, sendLeaseRelease: () => {},
    sendTrafficStopCheck: (body) => checks.push(body),
  });
  executor.setControlState({ controlEpoch: 7, sessionId: "session-7" });
  executor.onGrant({ requestId: "r", leaseId: "l", signal: "STOP", held: { segments: [] }, leaseDurationMs: 1_000, zoneId: "z", reason: "", stopId: "stop-1", stopGeneration: "4", controlEpoch: 7, sessionId: "session-7" });
  executor.onEvasionRequest({ mode: "REROUTE" });
  executor.onGrant({ requestId: "renew", leaseId: "l2", signal: "PROCEED", held: { segments: [] }, leaseDurationMs: 1_000, zoneId: "z", reason: "" });
  executor.onZoneUpdate("z", "resume");
  executor.clear();
  executor.onTick(snap(false));
  expect(executor.trafficStatus()).toBe("stop");
  expect(checks).toEqual([{ stop_id: "stop-1", stop_generation: "4" }]);
  now += 999;
  executor.onTick(snap(true));
  expect(checks).toHaveLength(1);
  now += 1;
  executor.onTick(snap(true));
  expect(checks).toHaveLength(2);
});

test("STOP and RESUME reject older generations and resume requires exact token", () => {
  const executor = new LocalPlanExecutor({ sendLeaseRequest: () => {}, sendLeaseRelease: () => {} });
  executor.setControlState({ controlEpoch: 3, sessionId: "s" });
  executor.onTrafficStopStatus({ stop_id: "stop-2", stop_generation: "8", decision: "STOP", control_epoch: 3, session_id: "s" });
  executor.onTrafficStopStatus({ stop_id: "stop-2", stop_generation: "7", decision: "RESUME", control_epoch: 3, session_id: "s" });
  expect(executor.trafficStatus()).toBe("stop");
  executor.onTrafficStopStatus({ stop_id: "stop-2", stop_generation: "9", decision: "RESUME", control_epoch: 3, session_id: "s" });
  expect(executor.trafficStatus()).toBe("stop");
  executor.onTrafficStopStatus({ stop_id: "stop-2", stop_generation: "8", decision: "RESUME", control_epoch: 3, session_id: "s" });
  expect(executor.trafficStatus()).toBe("proceed");
  executor.onTrafficStopStatus({ stop_id: "stop-2", stop_generation: "8", decision: "STOP", control_epoch: 2, session_id: "s" });
  expect(executor.trafficStatus()).toBe("proceed");
});

test("missing stop response never expires the latch", () => {
  const executor = new LocalPlanExecutor({ sendLeaseRequest: () => {}, sendLeaseRelease: () => {} });
  executor.setControlState({ controlEpoch: 1, sessionId: "s" });
  executor.onGrant({ requestId: "r", leaseId: "l", signal: "STOP", held: { segments: [] }, leaseDurationMs: 1, zoneId: "z", reason: "", stopId: "stop", stopGeneration: 1, controlEpoch: 1, sessionId: "s" });
  executor.onTick(snap());
  executor.onTick(snap());
  expect(executor.trafficStatus()).toBe("stop");
});
