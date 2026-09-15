import { describe, expect, test } from "bun:test";
import { DEADLOCK_CONFIRM_MS } from "../../../../shared/constants.ts";
import type { Corridor } from "../../../../shared/corridor.ts";
import type { TrafficPolicyContext, TrafficWorldSnapshot } from "../TrafficPolicy.ts";
import { LocalPlanPolicy } from "./LocalPlanPolicy.ts";

function fakeCtx(): TrafficPolicyContext {
  return {
    canGrant: () => true,
    partialGrant: (_id, wanted) => wanted,
    commit: () => true,
    release: () => true,
    getHeld: () => null,
    clearRobot: () => {},
  };
}

function robot(
  id: string,
  x: number,
  y: number,
  localPath: { x: number; y: number }[],
): TrafficWorldSnapshot["robots"][number] {
  return {
    robotId: id,
    x,
    y,
    theta: 0,
    status: "move",
    motion: "",
    avoidanceMode: true,
    headRoomPx: 0,
    trafficStatus: "proceed",
    path: localPath,
    localPath,
    planId: "",
    connected: true,
  };
}

function world(nowMs: number, robots: TrafficWorldSnapshot["robots"]): TrafficWorldSnapshot {
  return { nowMs, robots };
}

describe("LocalPlanPolicy", () => {
  test("lease requests always PROCEED", () => {
    const p = new LocalPlanPolicy(fakeCtx());
    const wanted: Corridor = { segments: [{ x1: 0, y1: 0, x2: 10, y2: 0, r: 12 }] };
    const actions = p.onLeaseRequest(
      "robot-1",
      { requestId: "r1", leaseId: "l1", wanted, gainPx: 4, urgent: false },
      world(0, []),
    );
    const grant = actions.find((a) => a.kind === "grant");
    expect(grant?.kind).toBe("grant");
    if (grant?.kind === "grant") expect(grant.grant.signal).toBe("PROCEED");
  });

  test("overlapping stuck plans → REROUTE loser and STOP winner", () => {
    const p = new LocalPlanPolicy(fakeCtx());
    const a = robot("robot-1", 0, 0, [
      { x: 0, y: 0 },
      { x: 80, y: 0 },
    ]);
    const b = robot("robot-2", 80, 0, [
      { x: 80, y: 0 },
      { x: 0, y: 0 },
    ]);
    p.tick(world(0, [a, b]));
    const actions = p.tick(world(DEADLOCK_CONFIRM_MS + 50, [a, b]));
    const evade = actions.filter((x) => x.kind === "evasion_request");
    expect(evade.length).toBe(1);
    if (evade[0].kind !== "evasion_request") throw new Error("expected evasion");
    expect(evade[0].mode).toBe("REROUTE");
    const loser = evade[0].robotId;
    const winner = loser === "robot-1" ? "robot-2" : "robot-1";
    const stopGrant = actions.find((x) => x.kind === "grant" && x.robotId === winner);
    expect(stopGrant?.kind).toBe("grant");
    if (stopGrant?.kind === "grant") expect(stopGrant.grant.signal).toBe("STOP");
  });

  test("NONE after REROUTE → VACATE", () => {
    const p = new LocalPlanPolicy(fakeCtx());
    const a = robot("robot-1", 0, 0, [
      { x: 0, y: 0 },
      { x: 80, y: 0 },
    ]);
    const b = robot("robot-2", 80, 0, [
      { x: 80, y: 0 },
      { x: 0, y: 0 },
    ]);
    p.tick(world(0, [a, b]));
    const first = p.tick(world(DEADLOCK_CONFIRM_MS + 50, [a, b]));
    const evade = first.find((x) => x.kind === "evasion_request");
    if (evade?.kind !== "evasion_request") throw new Error("expected evasion");
    const next = p.onEvasionReply(evade.robotId, { result: "NONE" });
    const vacate = next.find((x) => x.kind === "evasion_request");
    expect(vacate?.kind).toBe("evasion_request");
    if (vacate?.kind === "evasion_request") expect(vacate.mode).toBe("VACATE");
  });

  test("REROUTE success resumes the winner", () => {
    const p = new LocalPlanPolicy(fakeCtx());
    const a = robot("robot-1", 0, 0, [
      { x: 0, y: 0 },
      { x: 80, y: 0 },
    ]);
    const b = robot("robot-2", 80, 0, [
      { x: 80, y: 0 },
      { x: 0, y: 0 },
    ]);
    p.tick(world(0, [a, b]));
    const first = p.tick(world(DEADLOCK_CONFIRM_MS + 50, [a, b]));
    const evade = first.find((x) => x.kind === "evasion_request");
    if (evade?.kind !== "evasion_request") throw new Error("expected evasion");
    const loser = evade.robotId;
    const winner = loser === "robot-1" ? "robot-2" : "robot-1";
    const replies = p.onEvasionReply(loser, { result: "REROUTE" });
    const resume = replies.find((x) => x.kind === "zone_update" && x.robotId === winner);
    expect(resume?.kind).toBe("zone_update");
    if (resume?.kind === "zone_update") expect(resume.state).toBe("resume");
  });

  test("VACATE keeps winner stopped until loser clears the plan", () => {
    const p = new LocalPlanPolicy(fakeCtx());
    const a = robot("robot-1", 0, 0, [
      { x: 0, y: 0 },
      { x: 80, y: 0 },
    ]);
    const b = robot("robot-2", 80, 0, [
      { x: 80, y: 0 },
      { x: 0, y: 0 },
    ]);
    p.tick(world(0, [a, b]));
    const first = p.tick(world(DEADLOCK_CONFIRM_MS + 50, [a, b]));
    const evade = first.find((x) => x.kind === "evasion_request");
    if (evade?.kind !== "evasion_request") throw new Error("expected evasion");
    const loser = evade.robotId;
    const winner = loser === "robot-1" ? "robot-2" : "robot-1";
    const afterNone = p.onEvasionReply(loser, { result: "NONE" });
    const vacateReq = afterNone.find((x) => x.kind === "evasion_request");
    if (vacateReq?.kind !== "evasion_request") throw new Error("expected vacate");
    const vacateAck = p.onEvasionReply(loser, { result: "VACATE" });
    expect(vacateAck.some((x) => x.kind === "zone_update" && x.robotId === winner)).toBe(false);

    const stillOverlap = p.tick(
      world(DEADLOCK_CONFIRM_MS + 200, [
        robot("robot-1", 0, 0, [
          { x: 0, y: 0 },
          { x: 80, y: 0 },
        ]),
        robot("robot-2", 80, 0, [
          { x: 80, y: 0 },
          { x: 0, y: 0 },
        ]),
      ]),
    );
    expect(stillOverlap.some((x) => x.kind === "zone_update" && x.state === "resume")).toBe(false);

    const loserPose = loser === "robot-1" ? { x: -40, y: 0 } : { x: 120, y: 0 };
    const cleared = p.tick(
      world(DEADLOCK_CONFIRM_MS + 400, [
        robot(
          "robot-1",
          loser === "robot-1" ? loserPose.x : 80,
          0,
          loser === "robot-1" ? [loserPose] : [
            { x: 80, y: 0 },
            { x: 0, y: 0 },
          ],
        ),
        robot(
          "robot-2",
          loser === "robot-2" ? loserPose.x : 0,
          0,
          loser === "robot-2" ? [loserPose] : [
            { x: 0, y: 0 },
            { x: 80, y: 0 },
          ],
        ),
      ]),
    );
    const resume = cleared.find((x) => x.kind === "zone_update" && x.robotId === winner);
    expect(resume?.kind).toBe("zone_update");
  });
});
