import { expect, test } from "bun:test";
import { DEADLOCK_CONFIRM_MS, TRAFFIC_SEP_PX } from "../shared/constants.ts";
import type { TrafficStopCheck } from "../shared/traffic/types.ts";
import { RuntimeStore } from "../server/src/runtimeStore.ts";
import { TrafficController, robotViewFromPose } from "../server/src/traffic/index.ts";
import { LocalPlanPolicy } from "../server/src/traffic/policies/LocalPlanPolicy.ts";
import type { TrafficPolicyContext, TrafficWorldSnapshot } from "../server/src/traffic/TrafficPolicy.ts";

const context: TrafficPolicyContext = {
  canGrant: () => true, partialGrant: (_id, wanted) => wanted,
  commit: () => true, release: () => true, getHeld: () => null, clearRobot: () => {},
};

function scene() {
  const now = Date.now();
  const robot = (id: string, x: number, y: number, points: { x: number; y: number }[]) =>
    robotViewFromPose(id, { x, y, theta: 0, status: "move", motion: "HOLD",
      path: points, localPath: points, connected: true, controlReady: true,
      fmsControlState: "enabled", controlEpoch: 1, sessionId: `session-${id}`,
      poseObserved: true, observedAtMs: now, localPlanObservedAtMs: now });
  const a = robot("robot-1", 240, 520, [{ x: 240, y: 520 }, { x: 320, y: 520 }]);
  const b = robot("robot-2", 320, 520, [{ x: 320, y: 520 }, { x: 240, y: 520 }]);
  const world: TrafficWorldSnapshot = { nowMs: now, robots: [a, b], zones: [] };
  return { a, b, world, robot };
}

function establishStop(policy: LocalPlanPolicy, world: TrafficWorldSnapshot): TrafficStopCheck {
  policy.tick(world);
  world.nowMs += DEADLOCK_CONFIRM_MS + 50;
  for (const r of world.robots) r.observedAtMs = r.localPlanObservedAtMs = world.nowMs;
  const actions = policy.tick(world);
  const stop = actions.find(a => a.kind === "grant" && a.robotId === "robot-2" && a.grant.signal === "STOP");
  if (stop?.kind !== "grant" || !stop.grant.stopId || !stop.grant.stopGeneration) throw new Error("Expected correlated STOP");
  return { robotId: "robot-2", stopId: stop.grant.stopId, stopGeneration: stop.grant.stopGeneration,
    controlEpoch: 1, sessionId: "session-robot-2" };
}

function clearOriginalPeer(a: TrafficWorldSnapshot["robots"][number]) {
  a.x = 600; a.y = 600;
  a.localPath = a.path = [{ x: a.x, y: a.y }];
}

test("a slightly offset reported path cannot hide a peer body on the stopped robot route", () => {
  const { a, world } = scene();
  const policy = new LocalPlanPolicy(context);
  const check = establishStop(policy, world);
  // The reported route is geometrically disjoint and just within the accepted
  // anchor tolerance, but the actual body still lies on robot-2's route.
  a.localPath = a.path = [{ x: a.x, y: a.y + TRAFFIC_SEP_PX }, { x: a.x - 80, y: a.y + TRAFFIC_SEP_PX }];
  expect(policy.onTrafficStopCheck("robot-2", check, world).decision).toBe("STOP");
});

test("stale third-robot telemetry is not proof that the remaining scene is clear", () => {
  const { a, world, robot } = scene();
  const policy = new LocalPlanPolicy(context);
  const check = establishStop(policy, world);
  clearOriginalPeer(a);
  const third = robot("robot-3", 800, 800, [{ x: 800, y: 800 }]);
  third.observedAtMs = third.localPlanObservedAtMs = world.nowMs - 60_000;
  world.robots.push(third);
  const held = policy.onTrafficStopCheck("robot-2", check, world);
  expect(held.decision).toBe("STOP");
  third.observedAtMs = third.localPlanObservedAtMs = world.nowMs;
  expect(policy.onTrafficStopCheck("robot-2", { ...check,
    stopId: held.stopId, stopGeneration: held.stopGeneration }, world).decision).toBe("RESUME");
});

for (const connected of [true, false]) {
  test(`cleared original pair cannot resume through a third ${connected ? "online" : "offline"} robot body`, () => {
    const { a, world, robot } = scene();
    const policy = new LocalPlanPolicy(context);
    const check = establishStop(policy, world);
    clearOriginalPeer(a);
    const third = robot("robot-3", 280, 520, [{ x: 280, y: 520 }]);
    third.connected = connected;
    third.observedAtMs = third.localPlanObservedAtMs = world.nowMs;
    if (!connected) third.localPath = [];
    world.robots.push(third);
    const blocked = policy.onTrafficStopCheck("robot-2", check, world);
    expect(blocked.decision).toBe("STOP");

    // A new confirmed observation outside the route makes the whole scene clear.
    third.connected = true; third.x = 800; third.y = 800;
    third.path = third.localPath = [{ x: 800, y: 800 }];
    const cleared = policy.onTrafficStopCheck("robot-2", { ...check,
      stopId: blocked.stopId, stopGeneration: blocked.stopGeneration }, world);
    expect(cleared.decision).toBe("RESUME");
  });
}

test("STOP poll cannot bypass a queued semantic occupancy after the original pair clears", () => {
  const { a, world } = scene();
  const store = new RuntimeStore(":memory:");
  world.zones = [{ id: "capacity-corridor", family: "scene", kind: "corridor", name: "capacity",
    theta: 0, capacity: 1, polygon: [{ x: 270, y: 490 }, { x: 290, y: 490 }, { x: 290, y: 550 }, { x: 270, y: 550 }] }];
  for (const [id, state] of [["offline-holder", "occupied"], ["robot-2", "queued"]] as const) {
    store.upsertOccupancy({ resourceRef: { mapId: "yard", kind: "zone", id: "capacity-corridor" },
      robotId: id, state, requestId: id, controlEpoch: 1, createdAt: world.nowMs, updatedAt: world.nowMs,
      ...(state === "queued" ? { queuePosition: 1 } : {}) });
  }
  let policy!: LocalPlanPolicy;
  const responses: any[] = [];
  const controller = new TrafficController({ sendLeaseGrant: () => {}, setRobotTrafficStatus: () => {},
    sendTrafficStopStatus: (_id, status) => responses.push(status) },
  { getWorld: () => world }, ctx => policy = new LocalPlanPolicy(ctx), store);
  try {
    const check = establishStop(policy, world);
    clearOriginalPeer(a);
    const poll = () => controller.handleTrafficStopCheck("robot-2", {
      stop_id: check.stopId, stop_generation: check.stopGeneration, control_epoch: 1, session_id: check.sessionId,
    });
    poll();
    expect(responses.at(-1)?.decision).toBe("STOP");
    expect(responses.at(-1)?.reason).toMatch(/semantic|capacity|occupancy/i);

    // Explicitly release only this isolated fixture's occupancy, then reevaluate.
    controller.releaseSemanticOccupancy("offline-holder", "capacity-corridor");
    controller.releaseSemanticOccupancy("robot-2", "capacity-corridor");
    poll();
    expect(responses.at(-1)?.decision).toBe("RESUME");
  } finally { controller.stop(); store.close(); }
});
