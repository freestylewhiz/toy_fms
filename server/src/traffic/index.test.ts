import { describe, expect, test } from "bun:test";
import { TrafficController, robotViewFromPose } from "./index.ts";
import type { TrafficPolicy } from "./TrafficPolicy.ts";

function harness() {
  const grants: unknown[] = [];
  const statuses: unknown[] = [];
  let policyCalls = 0;
  const policy: TrafficPolicy = {
    id: "local_plan_v1",
    onRobotConnected: () => {},
    onRobotDisconnected: () => {},
    onLeaseRequest: () => {
      policyCalls++;
      return [];
    },
    onLeaseRelease: () => [],
    onBid: () => [],
    onEvasionReply: () => [],
    tick: () => [],
  };
  const controller = new TrafficController(
    {
      sendLeaseGrant: (_id, payload) => grants.push(payload),
      setRobotTrafficStatus: (_id, status) => statuses.push(status),
    },
    { getWorld: () => ({ nowMs: 0, robots: [robotViewFromPose("robot-1", { x: 0, y: 0, theta: 0, status: "idle", connected: true })] }) },
    () => policy,
  );
  return { controller, grants, statuses, get policyCalls() { return policyCalls; } };
}

describe("TrafficController input validation", () => {
  test("malformed lease request is fail-safe STOP and does not reach policy", () => {
    const h = harness();
    h.controller.handleLeaseRequest("robot-1", {
      request_id: "",
      lease_id: "lease-1",
      gain_px: Number.NaN,
      wanted: { segments: [{ x1: 0, y1: 0, x2: 1, y2: 0, r: -1 }] },
    });
    expect(h.policyCalls).toBe(0);
    expect(h.statuses).toEqual(["stop"]);
    expect(h.grants[0]).toMatchObject({ signal: "SIGNAL_STOP", lease_until_ms: 0 });
  });
});
