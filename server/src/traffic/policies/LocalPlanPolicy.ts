/**
 * Local-plan policy v1.
 * FMS syncs 5s local plans (broadcast is in FloorRoom).
 * This policy only arbitrates deadlock: overlapping local plans + no progress
 * → EvasionRequest REROUTE, then VACATE (reverse along own trail).
 * The overlap winner waits (STOP) until the loser has a detour or has vacated.
 */

import {
  DEADLOCK_CONFIRM_MS,
  EVASION_DEADLINE_MS,
  LEASE_MS,
  MAX_REROUTE_ROUNDS,
  PROGRESS_EPSILON_PX,
  TRAFFIC_SEP_PX,
} from "../../../../shared/constants.ts";
import { distToPlan, plansOverlap, sampleLocalPlan } from "../../../../shared/traffic/localPlan.ts";
import type { Corridor } from "../../../../shared/corridor.ts";
import type {
  LeaseRequestBody,
  TrafficPlanAction,
  TrafficStatus,
  ZoneId,
} from "../../../../shared/traffic/types.ts";
import type {
  TrafficPolicy,
  TrafficPolicyContext,
  TrafficWorldSnapshot,
} from "../TrafficPolicy.ts";

type PairKey = string;

function pairKey(a: string, b: string): PairKey {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function hashSeed(robotId: string): number {
  let h = 0;
  for (let i = 0; i < robotId.length; i++) h = (h * 31 + robotId.charCodeAt(i)) >>> 0;
  return (h % 10000) / 100;
}

function localOf(r: TrafficWorldSnapshot["robots"][number]): { x: number; y: number }[] {
  if (r.localPath && r.localPath.length) return r.localPath;
  return sampleLocalPlan(r.path, 0, { x: r.x, y: r.y });
}

function emptyHeld(): Corridor {
  return { segments: [] };
}

export class LocalPlanPolicy implements TrafficPolicy {
  readonly id = "local_plan_v1" as const;
  private lastPose = new Map<string, { x: number; y: number; atMs: number }>();
  private stuckSince = new Map<PairKey, number>();
  private evasionTarget = new Map<PairKey, { robotId: string; round: number }>();
  /** After VACATE starts, keep the winner stopped until the loser's pose clears the winner plan. */
  private vacating = new Map<PairKey, { loser: string; winner: string }>();
  private evasionSeq = 0;

  constructor(private readonly ctx: TrafficPolicyContext) {}

  onRobotConnected(_robotId: string): void {}

  onRobotDisconnected(robotId: string): void {
    this.ctx.clearRobot(robotId);
    this.lastPose.delete(robotId);
    for (const k of [...this.stuckSince.keys()]) {
      if (k.split("|").includes(robotId)) {
        this.stuckSince.delete(k);
        this.evasionTarget.delete(k);
        this.vacating.delete(k);
      }
    }
  }

  onLeaseRequest(
    robotId: string,
    req: LeaseRequestBody,
    world: TrafficWorldSnapshot,
  ): TrafficPlanAction[] {
    // v1 does not lease space. Always PROCEED so leftover v0 clients keep moving.
    const leaseId = `open-${robotId}`;
    this.ctx.commit(robotId, leaseId, req.wanted, world.nowMs + LEASE_MS, "");
    return [
      {
        kind: "grant",
        robotId,
        grant: {
          leaseId,
          signal: "PROCEED",
          held: req.wanted,
          leaseDurationMs: LEASE_MS,
          zoneId: "",
          reason: `${req.requestId}|v1 open`,
        },
      },
      { kind: "set_status", robotId, trafficStatus: "proceed" },
    ];
  }

  onLeaseRelease(robotId: string, leaseId: string, freed: any, retained: any): TrafficPlanAction[] {
    this.ctx.release(robotId, leaseId, freed, retained);
    return [{ kind: "set_status", robotId, trafficStatus: "clear" }];
  }

  onBid(_robotId: string, _zoneId: ZoneId, _seed: number): TrafficPlanAction[] {
    return [];
  }

  onEvasionReply(robotId: string, payload: Record<string, unknown>): TrafficPlanAction[] {
    const result = String(payload.result ?? "").toUpperCase();
    const actions: TrafficPlanAction[] = [];
    let pair: PairKey | undefined;
    for (const [k, t] of this.evasionTarget) {
      if (t.robotId === robotId) {
        pair = k;
        break;
      }
    }
    const others = pair ? pair.split("|").filter((id) => id !== robotId) : [];

    if (result === "REROUTE" || result === "OK") {
      if (pair) {
        this.evasionTarget.delete(pair);
        this.stuckSince.delete(pair);
        this.vacating.delete(pair);
      }
      actions.push({ kind: "set_status", robotId, trafficStatus: "evade" });
      for (const wid of others) actions.push(...this.resumePeer(wid, pair ?? ""));
      console.log(`[traffic-v1] evade ${result} from ${robotId} → resume ${others.join(",")}`);
      return actions;
    }

    if (result === "VACATE") {
      if (pair) {
        this.evasionTarget.delete(pair);
        this.stuckSince.delete(pair);
        const winner = others[0];
        if (winner) this.vacating.set(pair, { loser: robotId, winner });
      }
      actions.push({ kind: "set_status", robotId, trafficStatus: "evade" });
      console.log(`[traffic-v1] VACATE rolling ${robotId} pair=${pair ?? ""}`);
      return actions;
    }

    // NONE → VACATE once, then freeze pair.
    if (pair) {
      const cur = this.evasionTarget.get(pair);
      const round = (cur?.round ?? 1) + 1;
      if (round <= MAX_REROUTE_ROUNDS) {
        this.evasionTarget.set(pair, { robotId, round });
        actions.push({
          kind: "evasion_request",
          robotId,
          zoneId: pair,
          roundId: `e${++this.evasionSeq}`,
          leaseId: "",
          releaseHint: emptyHeld(),
          mode: "VACATE",
          breadcrumbHint: [],
          deadlineMs: EVASION_DEADLINE_MS * 6,
        });
        actions.push({ kind: "set_status", robotId, trafficStatus: "evade" });
        console.log(`[traffic-v1] E3 VACATE → ${robotId} pair=${pair}`);
        return actions;
      }
    }
    actions.push({ kind: "set_status", robotId, trafficStatus: "stop" });
    return actions;
  }

  tick(world: TrafficWorldSnapshot): TrafficPlanAction[] {
    this.updateProgress(world);
    const actions = [...this.watchVacateClearance(world), ...this.watchDeadlock(world)];
    const busy = new Set<string>();
    for (const t of this.evasionTarget.values()) busy.add(t.robotId);
    for (const v of this.vacating.values()) {
      busy.add(v.loser);
      busy.add(v.winner);
    }
    for (const a of actions) {
      if ("robotId" in a) busy.add(a.robotId);
    }
    for (const r of world.robots) {
      if (!r.connected || busy.has(r.robotId)) continue;
      if (r.status === "move" && (r.trafficStatus === "clear" || r.trafficStatus === "hold")) {
        actions.push({ kind: "set_status", robotId: r.robotId, trafficStatus: "proceed" });
      } else if (r.status === "idle" && r.trafficStatus !== "clear") {
        actions.push({ kind: "set_status", robotId: r.robotId, trafficStatus: "clear" });
      }
    }
    return actions;
  }

  private updateProgress(world: TrafficWorldSnapshot): void {
    for (const r of world.robots) {
      if (!r.connected) continue;
      const prev = this.lastPose.get(r.robotId);
      if (!prev || Math.hypot(r.x - prev.x, r.y - prev.y) >= PROGRESS_EPSILON_PX) {
        this.lastPose.set(r.robotId, { x: r.x, y: r.y, atMs: world.nowMs });
      }
    }
  }

  private watchVacateClearance(world: TrafficWorldSnapshot): TrafficPlanAction[] {
    const actions: TrafficPlanAction[] = [];
    const byId = new Map(world.robots.map((r) => [r.robotId, r]));
    for (const [key, v] of [...this.vacating]) {
      const loser = byId.get(v.loser);
      const winner = byId.get(v.winner);
      if (!loser || !winner || !loser.connected) {
        if (winner?.connected) actions.push(...this.resumePeer(v.winner, key));
        this.vacating.delete(key);
        continue;
      }
      const winnerPlan = localOf(winner);
      const clear =
        distToPlan({ x: loser.x, y: loser.y }, winnerPlan) >= TRAFFIC_SEP_PX + 8 ||
        !plansOverlap(localOf(loser), winnerPlan, TRAFFIC_SEP_PX);
      if (!clear) continue;
      actions.push(...this.resumePeer(v.winner, key));
      this.vacating.delete(key);
      console.log(`[traffic-v1] VACATE cleared ${v.loser} → resume ${v.winner}`);
    }
    return actions;
  }

  private watchDeadlock(world: TrafficWorldSnapshot): TrafficPlanAction[] {
    const actions: TrafficPlanAction[] = [];
    const live = world.robots.filter((r) => r.connected && r.avoidanceMode);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i];
        const b = live[j];
        const key = pairKey(a.robotId, b.robotId);
        const pa = localOf(a);
        const pb = localOf(b);
        const overlap = plansOverlap(pa, pb, TRAFFIC_SEP_PX);
        const stuckA = this.isStuck(a.robotId, world.nowMs);
        const stuckB = this.isStuck(b.robotId, world.nowMs);
        if (!overlap || !stuckA || !stuckB) {
          this.stuckSince.delete(key);
          continue;
        }
        if (this.evasionTarget.has(key) || this.vacating.has(key)) continue;
        if (!this.stuckSince.has(key)) {
          this.stuckSince.set(key, world.nowMs);
        }
        const loser = hashSeed(a.robotId) <= hashSeed(b.robotId) ? a.robotId : b.robotId;
        const winner = loser === a.robotId ? b.robotId : a.robotId;
        this.evasionTarget.set(key, { robotId: loser, round: 1 });
        console.log(`[traffic-v1] E2 REROUTE → ${loser} pair=${key}`);
        actions.push({
          kind: "evasion_request",
          robotId: loser,
          zoneId: key,
          roundId: `e${++this.evasionSeq}`,
          leaseId: "",
          releaseHint: emptyHeld(),
          mode: "REROUTE",
          breadcrumbHint: [],
          deadlineMs: EVASION_DEADLINE_MS * 6,
        });
        actions.push({ kind: "set_status", robotId: loser, trafficStatus: "evade" });
        actions.push(...this.holdPeer(winner, key));
      }
    }
    return actions;
  }

  private holdPeer(robotId: string, pair: PairKey): TrafficPlanAction[] {
    return [
      {
        kind: "grant",
        robotId,
        grant: {
          leaseId: `open-${robotId}`,
          signal: "STOP",
          held: emptyHeld(),
          leaseDurationMs: LEASE_MS,
          zoneId: pair,
          reason: `hold|v1 yield`,
        },
      },
      { kind: "set_status", robotId, trafficStatus: "stop" },
      { kind: "zone_update", robotId, zoneId: pair, state: "hold" },
    ];
  }

  private resumePeer(robotId: string, pair: PairKey): TrafficPlanAction[] {
    return [
      {
        kind: "grant",
        robotId,
        grant: {
          leaseId: `open-${robotId}`,
          signal: "PROCEED",
          held: emptyHeld(),
          leaseDurationMs: LEASE_MS,
          zoneId: pair,
          reason: `resume|v1`,
        },
      },
      { kind: "set_status", robotId, trafficStatus: "proceed" },
      { kind: "zone_update", robotId, zoneId: pair, state: "resume" },
    ];
  }

  private isStuck(robotId: string, nowMs: number): boolean {
    const p = this.lastPose.get(robotId);
    if (!p) return false;
    return nowMs - p.atMs >= DEADLOCK_CONFIRM_MS;
  }
}

export function statusOf(_s: TrafficStatus): TrafficStatus {
  return _s;
}
