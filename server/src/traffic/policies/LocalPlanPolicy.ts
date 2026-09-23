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
  TrafficStopCheck,
  TrafficStopStatus,
} from "../../../../shared/traffic/types.ts";
import type {
  TrafficPolicy,
  TrafficPolicyContext,
  TrafficWorldSnapshot,
} from "../TrafficPolicy.ts";

type PairKey = string;
type StopRecord = { stopId: string; generation: number; reason: string; pair?: PairKey; createdAt: number };
type CompletedStop = { record: StopRecord; sessionId: string; controlEpoch: number };
type EvasionTarget = { robotId: string; round: number; roundId: string; deadlineAt: number; controlEpoch?: number; sessionId?: string };

function pairKey(a: string, b: string): PairKey {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function hashSeed(robotId: string): number {
  let h = 0;
  for (let i = 0; i < robotId.length; i++) h = (h * 31 + robotId.charCodeAt(i)) >>> 0;
  return (h % 10000) / 100;
}

function localOf(r: TrafficWorldSnapshot["robots"][number]): { x: number; y: number }[] {
  if (r.operatorPaused) return [{ x: r.x, y: r.y }];
  if (r.localPath && r.localPath.length) return r.localPath;
  return sampleLocalPlan(r.path, 0, { x: r.x, y: r.y });
}

function currentLocalOf(r: TrafficWorldSnapshot["robots"][number]): { x: number; y: number }[] | null {
  return r.localPath && r.localPath.length ? r.localPath : null;
}

function emptyHeld(): Corridor {
  return { segments: [] };
}

export class LocalPlanPolicy implements TrafficPolicy {
  readonly id = "local_plan_v1" as const;
  private lastPose = new Map<string, { x: number; y: number; atMs: number }>();
  private lastPlan = new Map<string, string>();
  private stuckSince = new Map<PairKey, number>();
  private evasionTarget = new Map<PairKey, EvasionTarget>();
  /** After VACATE starts, keep the winner stopped until the loser's pose clears the winner plan. */
  private vacating = new Map<PairKey, { loser: string; winner: string; requirePlanChange?: boolean; previousPlan?: string }>();
  private evasionSeq = 0;
  private stopSeq = 0;
  private stopGeneration = new Map<string, number>();
  private activeStops = new Map<string, Map<string, StopRecord>>();
  private completedStops = new Map<string, CompletedStop[]>();

  constructor(private readonly ctx: TrafficPolicyContext) {}

  onRobotConnected(robotId: string): void {
    // A new authenticated session must never inherit a prior token. Pair
    // state remains, so the next request/tick recreates a fresh generation.
    this.activeStops.delete(robotId);
    this.completedStops.delete(robotId);
  }

  onRobotDisconnected(robotId: string): void {
    this.ctx.clearRobot(robotId);
    this.lastPose.delete(robotId);
    // Keep pair STOP records and the last body as an obstacle. A session loss
    // cannot prove that the physical body cleared the conflict.
  }

  onLeaseRequest(
    robotId: string,
    req: LeaseRequestBody,
    world: TrafficWorldSnapshot,
  ): TrafficPlanAction[] {
    let heldStop = this.activeStops.get(robotId);
    if (!heldStop?.size) {
      for (const [pair, v] of this.vacating) {
        if (v.winner === robotId) {
          this.ensureStop(robotId, `pair:${pair}`, pair);
          break;
        }
      }
      if (!this.activeStops.get(robotId)?.size) {
        for (const [pair, v] of this.evasionTarget) {
          const winner = pair.split("|").find((id) => id !== v.robotId);
          if (winner === robotId) {
            this.ensureStop(robotId, `pair:${pair}`, pair);
            break;
          }
        }
      }
      heldStop = this.activeStops.get(robotId);
    }
    if (heldStop?.size) {
      const stop = [...heldStop.values()][0];
      return [this.stopGrant(robotId, stop, req.requestId), { kind: "set_status", robotId, trafficStatus: "stop" }];
    }
    // v1 does not lease space when no active STOP reason exists.
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
    const suppliedZone = String(payload.zone_id ?? "");
    const suppliedRound = String(payload.round_id ?? "");
    const target = this.evasionTarget.get(suppliedZone);
    const pair = target?.robotId === robotId ? suppliedZone : undefined;
    if (!pair || !target || suppliedRound !== target.roundId ||
      (target.sessionId != null && String(payload.session_id ?? "") !== target.sessionId) ||
      (target.controlEpoch != null && Number(payload.control_epoch) !== target.controlEpoch)) return [];
    const others = pair.split("|").filter((id) => id !== robotId);

    if (result === "REROUTE" || result === "OK") {
      if (pair) {
        const loser = robotId;
        const winner = pair.split("|").find((id) => id !== robotId) ?? "";
        this.vacating.set(pair, {
          loser,
          winner,
          requirePlanChange: true,
          previousPlan: this.planFingerprint(loser),
        });
        this.evasionTarget.delete(pair);
      }
      actions.push({ kind: "set_status", robotId, trafficStatus: "evade" });
      // A reply acknowledges the request only. Current pose and local-plan
      // telemetry must prove clearance before the winner is resumed.
      console.log(`[traffic-v1] evade ${result} from ${robotId}; awaiting fresh clearance`);
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
        const roundId = `e${++this.evasionSeq}`;
        const prior = this.evasionTarget.get(pair);
        this.evasionTarget.set(pair, { robotId, round, roundId, deadlineAt: Date.now() + EVASION_DEADLINE_MS * 6, controlEpoch: prior?.controlEpoch, sessionId: prior?.sessionId });
        actions.push({
          kind: "evasion_request",
          robotId,
          zoneId: pair,
          roundId,
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
    const actions = [...this.restorePairStops(world), ...this.watchEvasionTimeouts(world), ...this.watchVacateClearance(world), ...this.watchDeadlock(world)];
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
      this.lastPlan.set(r.robotId, JSON.stringify(r.localPath ?? []));
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
      if (!loser || !winner || !loser.connected || !winner.connected) {
        // A disconnected peer remains an unknown physical obstacle.
        continue;
      }
      const winnerPlan = currentLocalOf(winner);
      if (!winnerPlan) continue;
      const clear = this.isPairClear(key, world) &&
        distToPlan({ x: loser.x, y: loser.y }, winnerPlan) >= TRAFFIC_SEP_PX + 8 &&
        (!v.requirePlanChange || this.planFingerprint(v.loser) !== v.previousPlan);
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
        const roundId = `e${++this.evasionSeq}`;
        this.evasionTarget.set(key, { robotId: loser, round: 1, roundId, deadlineAt: world.nowMs + EVASION_DEADLINE_MS * 6,
          controlEpoch: a.robotId === loser ? a.controlEpoch : b.controlEpoch,
          sessionId: a.robotId === loser ? a.sessionId : b.sessionId });
        console.log(`[traffic-v1] E2 REROUTE → ${loser} pair=${key}`);
        actions.push({
          kind: "evasion_request",
          robotId: loser,
          zoneId: key,
          roundId,
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
    const stop = this.ensureStop(robotId, `pair:${pair}`, pair);
    return [
      this.stopGrant(robotId, stop, "hold"),
      { kind: "set_status", robotId, trafficStatus: "stop" },
      { kind: "zone_update", robotId, zoneId: pair, state: "hold" },
    ];
  }

  private resumePeer(robotId: string, pair: PairKey): TrafficPlanAction[] {
    const active = this.activeStops.get(robotId);
    if (active?.size) {
      const stop = [...active.values()][0];
      // Keep the token alive until the robot's authenticated poll receives
      // RESUME. A generic PROCEED grant cannot recover a dropped status.
      return [this.stopGrant(robotId, stop, "hold"), { kind: "set_status", robotId, trafficStatus: "stop" }, { kind: "zone_update", robotId, zoneId: pair, state: "resume" }];
    }
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

  onTrafficStopCheck(robotId: string, check: TrafficStopCheck, world: TrafficWorldSnapshot): TrafficStopStatus {
    const active = this.activeStops.get(robotId);
    const matching = [...(active?.values() ?? [])].find((s) => s.stopId === check.stopId && s.generation === check.stopGeneration);
    for (const stop of [...(active?.values() ?? [])]) {
      if (stop.pair && this.isPairClear(stop.pair, world)) {
        this.rememberCompleted(robotId, stop, check);
        this.clearStop(robotId, stop.reason);
        this.clearPairState(stop.pair);
      }
    }
    const remaining = this.activeStops.get(robotId);
    if (remaining?.size) {
      const latest = [...remaining.values()].sort((a, b) => b.generation - a.generation)[0];
      const token = latest.generation > check.stopGeneration ? { stopId: latest.stopId, stopGeneration: latest.generation } : check;
      return { ...check, ...token, decision: "STOP", reason: [...remaining.values()].map((s) => s.reason).join(",") || "active traffic stop" };
    }
    const completed = this.completedStops.get(robotId)?.find((x) => x.record.stopId === check.stopId && x.record.generation === check.stopGeneration && x.sessionId === check.sessionId && x.controlEpoch === check.controlEpoch);
    if (completed?.record.pair && !this.isPairClear(completed.record.pair, world)) {
      const stop = this.ensureStop(robotId, completed.record.reason, completed.record.pair);
      return { ...check, stopId: stop.stopId, stopGeneration: stop.generation, decision: "STOP", reason: "conflict returned; new stop generation" };
    }
    if (matching || completed) return { ...check, decision: "RESUME", reason: "stop cleared after current scene check" };
    // An unknown token cannot authorize motion. Keep the exact token in the
    // response so the robot can discard it and poll with its current grant.
    return { ...check, decision: "STOP", reason: "unknown stop identity" };
  }

  getTrafficStopGrant(robotId: string): TrafficPlanAction | undefined {
    const active = this.activeStops.get(robotId);
    const stop = active && [...active.values()].sort((a, b) => b.generation - a.generation)[0];
    return stop ? this.stopGrant(robotId, stop, "recovery") : undefined;
  }

  private ensureStop(robotId: string, reason: string, pair?: PairKey): StopRecord {
    const existing = this.activeStops.get(robotId)?.get(reason);
    if (existing) return existing;
    const generation = (this.stopGeneration.get(robotId) ?? 0) + 1;
    this.stopGeneration.set(robotId, generation);
    const record = { stopId: `stop-${robotId}-${++this.stopSeq}`, generation, reason, pair, createdAt: Date.now() };
    const map = this.activeStops.get(robotId) ?? new Map<string, StopRecord>();
    map.set(reason, record);
    this.activeStops.set(robotId, map);
    return record;
  }

  private clearStop(robotId: string, reason: string): void {
    const map = this.activeStops.get(robotId);
    map?.delete(reason);
    if (map && map.size === 0) this.activeStops.delete(robotId);
  }

  private rememberCompleted(robotId: string, record: StopRecord, check: TrafficStopCheck): void {
    const entries = this.completedStops.get(robotId) ?? [];
    entries.push({ record, sessionId: check.sessionId, controlEpoch: check.controlEpoch });
    while (entries.length > 16) entries.shift();
    this.completedStops.set(robotId, entries);
  }

  private stopGrant(robotId: string, stop: StopRecord, requestId: string): TrafficPlanAction {
    return { kind: "grant", robotId, grant: { leaseId: `open-${robotId}`, signal: "STOP", held: emptyHeld(), leaseDurationMs: LEASE_MS, zoneId: stop.pair ?? "", reason: `${requestId}|${stop.reason}`, stopId: stop.stopId, stopGeneration: stop.generation } };
  }

  private planFingerprint(robotId: string): string {
    return this.lastPlan.get(robotId) ?? "";
  }

  private freshForClearance(world: TrafficWorldSnapshot, r: TrafficWorldSnapshot["robots"][number]): boolean {
    const maxAge = EVASION_DEADLINE_MS * 6;
    if (r.observedAtMs == null || r.localPlanObservedAtMs == null) return false;
    if (!Number.isFinite(r.observedAtMs) || !Number.isFinite(r.localPlanObservedAtMs)) return false;
    if (r.observedAtMs != null && world.nowMs - r.observedAtMs > maxAge) return false;
    if (r.localPlanObservedAtMs != null && world.nowMs - r.localPlanObservedAtMs > maxAge) return false;
    return true;
  }

  private isPairClear(pair: PairKey, world: TrafficWorldSnapshot): boolean {
    const [aId, bId] = pair.split("|");
    const a = world.robots.find((r) => r.robotId === aId);
    const b = world.robots.find((r) => r.robotId === bId);
    if (!a || !b || !a.connected || !b.connected || a.fmsControlState === "disabled" || b.fmsControlState === "disabled" ||
      a.controlReady === false || b.controlReady === false || a.poseObserved === false || b.poseObserved === false) return false;
    if (!this.freshForClearance(world, a) || !this.freshForClearance(world, b)) return false;
    const pa = currentLocalOf(a), pb = currentLocalOf(b);
    if (!pa || !pb) return false;
    if (!this.validPlan(a, pa) || !this.validPlan(b, pb)) return false;
    if (Math.hypot(a.x - b.x, a.y - b.y) < TRAFFIC_SEP_PX + 8 ||
      distToPlan({ x: a.x, y: a.y }, pb) < TRAFFIC_SEP_PX + 8 ||
      distToPlan({ x: b.x, y: b.y }, pa) < TRAFFIC_SEP_PX + 8 ||
      plansOverlap(pa, pb, TRAFFIC_SEP_PX)) return false;
    for (const other of world.robots) {
      if (other.robotId === aId || other.robotId === bId) continue;
      if (other.poseObserved === false) continue;
      if (![other.x, other.y].every(Number.isFinite)) return false;
      if (other.connected && !this.freshForClearance(world, other)) return false;
      const bodyNear = Math.min(Math.hypot(other.x - a.x, other.y - a.y), Math.hypot(other.x - b.x, other.y - b.y)) <= TRAFFIC_SEP_PX + 16;
      const routeNear = Math.min(distToPlan({ x: other.x, y: other.y }, pa), distToPlan({ x: other.x, y: other.y }, pb)) <= TRAFFIC_SEP_PX + 8;
      const po = currentLocalOf(other);
      if (!other.connected && (bodyNear || routeNear)) return false;
      if (other.connected && (bodyNear || routeNear || !po || !this.validPlan(other, po) || plansOverlap(po, pa, TRAFFIC_SEP_PX) || plansOverlap(po, pb, TRAFFIC_SEP_PX))) return false;
    }
    return true;
  }

  private validPlan(r: TrafficWorldSnapshot["robots"][number], plan: { x: number; y: number }[]): boolean {
    return plan.length > 0 && plan.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)) &&
      Math.hypot(plan[0].x - r.x, plan[0].y - r.y) <= TRAFFIC_SEP_PX;
  }

  private restorePairStops(world: TrafficWorldSnapshot): TrafficPlanAction[] {
    const actions: TrafficPlanAction[] = [];
    const restore = (pair: PairKey, winner: string) => {
      if (!this.activeStops.get(winner)?.size) actions.push(...this.holdPeer(winner, pair));
    };
    for (const [pair, target] of this.evasionTarget) {
      const winner = pair.split("|").find((id) => id !== target.robotId);
      if (winner && world.robots.some(r => r.robotId === winner)) restore(pair, winner);
    }
    for (const [pair, state] of this.vacating) restore(pair, state.winner);
    return actions;
  }

  private clearPairState(pair: PairKey): void {
    this.evasionTarget.delete(pair);
    this.vacating.delete(pair);
    this.stuckSince.delete(pair);
  }

  private watchEvasionTimeouts(world: TrafficWorldSnapshot): TrafficPlanAction[] {
    const actions: TrafficPlanAction[] = [];
    for (const [pair, target] of [...this.evasionTarget]) {
      if (world.nowMs < target.deadlineAt) continue;
      this.evasionTarget.delete(pair);
      const winner = pair.split("|").find((id) => id !== target.robotId);
      if (winner) actions.push(...this.holdPeer(winner, pair));
      // Leaving stuckSince intact causes the next tick to re-evaluate and send
      // a fresh round instead of freezing the pair forever.
    }
    return actions;
  }
}

export function statusOf(_s: TrafficStatus): TrafficStatus {
  return _s;
}
