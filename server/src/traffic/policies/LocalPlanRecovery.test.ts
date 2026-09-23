import { expect, test } from "bun:test";
import { DEADLOCK_CONFIRM_MS } from "../../../../shared/constants.ts";
import type { TrafficPolicyContext, TrafficWorldSnapshot } from "../TrafficPolicy.ts";
import { LocalPlanPolicy } from "./LocalPlanPolicy.ts";

function fakeContext(): TrafficPolicyContext {
  return {
    canGrant: () => true,
    partialGrant: (_robotId, wanted) => wanted,
    commit: () => true,
    release: () => true,
    getHeld: () => null,
    clearRobot: () => {},
  };
}

function robot(
  robotId: string,
  x: number,
  y: number,
  localPath: { x: number; y: number }[],
  nowMs: number,
): TrafficWorldSnapshot["robots"][number] {
  return {
    robotId,
    x,
    y,
    theta: 0,
    status: "move",
    motion: "HOLD",
    avoidanceMode: true,
    headRoomPx: Infinity,
    trafficStatus: "proceed",
    path: localPath,
    localPath,
    planId: "",
    connected: true,
    fmsControlState: "enabled",
    controlReady: true,
    controlEpoch: 1,
    poseObserved: true,
    observedAtMs: nowMs,
    localPlanObservedAtMs: nowMs,
    sessionId: `${robotId}-session`,
  };
}

function world(nowMs: number, robots: TrafficWorldSnapshot["robots"]): TrafficWorldSnapshot {
  return { nowMs, robots };
}

function stopActions(actions: ReturnType<LocalPlanPolicy["tick"]>, robotId: string) {
  return actions.filter((action) => action.kind === "grant" && action.robotId === robotId && action.grant.signal === "STOP");
}

function evadeActions(actions: ReturnType<LocalPlanPolicy["tick"]>, robotId: string) {
  return actions.filter((action) => action.kind === "evasion_request" && action.robotId === robotId);
}

test("latest stop token stays latched while its pair clears, then resumes that same token after all pairs clear", () => {
  const policy = new LocalPlanPolicy(fakeContext());
  const initial = [
    // c has the largest seed, so it wins both independent conflicts.
    robot("a", 100, 20, [{ x: 100, y: 20 }, { x: 0, y: 20 }], 0),
    robot("b", 0, -20, [{ x: 0, y: -20 }, { x: 100, y: -20 }], 0),
    robot("c", 0, 0, [{ x: 0, y: 0 }, { x: 100, y: 0 }], 0),
  ];
  policy.tick(world(0, initial));
  const actions = policy.tick(world(DEADLOCK_CONFIRM_MS + 50, initial));
  const stops = stopActions(actions, "c");
  expect(stops).toHaveLength(2);
  if (stops[0].kind !== "grant" || stops[1].kind !== "grant") throw new Error("expected stop grants");
  const latest = stops.reduce((a, b) => (Number(a.grant.stopGeneration) > Number(b.grant.stopGeneration) ? a : b));
  const older = stops.find((action) => action !== latest)!;
  if (older.kind !== "grant" || latest.kind !== "grant") throw new Error("expected tokenized grants");
  const latestCheck = {
    robotId: "c",
    stopId: latest.grant.stopId!,
    stopGeneration: latest.grant.stopGeneration!,
    controlEpoch: 1,
    sessionId: "c-session",
  };

  // b|c clears, while a|c remains overlapped. The latest token must remain
  // STOP so the robot continues polling for the older active reason.
  const latestPairCleared = [
    robot("a", 100, 20, [{ x: 100, y: 20 }, { x: 0, y: 20 }], 1000),
    robot("b", 0, -100, [{ x: 0, y: -100 }], 1000),
    robot("c", 0, 0, [{ x: 0, y: 0 }, { x: 100, y: 0 }], 1000),
  ];
  const stillStopped = policy.onTrafficStopCheck!("c", latestCheck, world(1000, latestPairCleared));
  expect(stillStopped.decision).toBe("STOP");
  expect(stillStopped.stopId).toBe(latestCheck.stopId);
  expect(stillStopped.stopGeneration).toBe(latestCheck.stopGeneration);
  expect(stillStopped.reason).toContain("pair:a|c");

  // Once the older pair clears too, RESUME must carry the original newest
  // token, allowing the robot to accept it without a generation jump.
  const allClear = [
    robot("a", 0, 100, [{ x: 0, y: 100 }], 2000),
    robot("b", 0, -100, [{ x: 0, y: -100 }], 2000),
    robot("c", 0, 0, [{ x: 0, y: 0 }], 2000),
  ];
  const resumed = policy.onTrafficStopCheck!("c", latestCheck, world(2000, allClear));
  expect(resumed).toMatchObject({ decision: "RESUME", stopId: latestCheck.stopId, stopGeneration: latestCheck.stopGeneration });
  expect(older.grant.stopGeneration).toBeLessThan(latest.grant.stopGeneration!);
});

test("missing or old evasion round replies do not progress the target", () => {
  const policy = new LocalPlanPolicy(fakeContext());
  const robots = [
    robot("a", 0, 0, [{ x: 0, y: 0 }, { x: 100, y: 0 }], 0),
    robot("b", 0, 20, [{ x: 0, y: 20 }, { x: 100, y: 20 }], 0),
  ];
  policy.tick(world(0, robots));
  const actions = policy.tick(world(DEADLOCK_CONFIRM_MS + 50, robots));
  const evade = evadeActions(actions, "a")[0];
  if (evade.kind !== "evasion_request") throw new Error("expected evasion request");
  const oldReply = policy.onEvasionReply("a", {
    result: "REROUTE",
    zone_id: evade.zoneId,
    round_id: "old-round",
    control_epoch: 1,
    session_id: "a-session",
  });
  expect(oldReply).toEqual([]);
  const valid = policy.onEvasionReply("a", {
    result: "REROUTE",
    zone_id: evade.zoneId,
    round_id: evade.roundId,
    control_epoch: 1,
    session_id: "a-session",
  });
  expect(valid.some((action) => action.kind === "set_status" && action.robotId === "a" && action.trafficStatus === "evade")).toBe(true);
});

test("the same robot may accept valid replies for two independent pair rounds", () => {
  const policy = new LocalPlanPolicy(fakeContext());
  const robots = [
    robot("a", 0, 0, [{ x: 0, y: 0 }, { x: 100, y: 0 }], 0),
    robot("b", 0, 20, [{ x: 0, y: 20 }, { x: 100, y: 20 }], 0),
    robot("c", 0, -20, [{ x: 0, y: -20 }, { x: 100, y: -20 }], 0),
  ];
  policy.tick(world(0, robots));
  const actions = policy.tick(world(DEADLOCK_CONFIRM_MS + 50, robots));
  const rounds = evadeActions(actions, "a");
  expect(rounds).toHaveLength(2);
  if (rounds[1].kind !== "evasion_request") throw new Error("expected second evasion request");
  const accepted = policy.onEvasionReply("a", {
    result: "REROUTE",
    zone_id: rounds[1].zoneId,
    round_id: rounds[1].roundId,
    control_epoch: 1,
    session_id: "a-session",
  });
  expect(accepted.some((action) => action.kind === "set_status" && action.robotId === "a" && action.trafficStatus === "evade")).toBe(true);
});
