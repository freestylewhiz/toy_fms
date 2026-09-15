/**
 * Corridor-lease policy v0 (L0 safety + sticky seed priority).
 * Map-blind: only uses corridors / poses reported by robots.
 *
 * Critical rules:
 * - Zone winner is sticky (seed only) — no starvation flip while the zone lives.
 * - Yield strips overlapping ahead held; never force a bodyDisk that blocks the winner.
 * - STOP renew re-centers body only when held is already body-only / empty-safe.
 */

import {
  CORRIDOR_MIN_RADIUS,
  DEADLOCK_CONFIRM_MS,
  EVASION_DEADLINE_MS,
  LEASE_MS,
  MAX_REROUTE_ROUNDS,
  PROGRESS_EPSILON_PX,
} from "../../../../shared/constants.ts";
import {
  capsuleLength,
  clampCorridorRadius,
  corridorsDisjoint,
  type Capsule,
  type Corridor,
} from "../../../../shared/corridor.ts";
import type {
  LeaseRequestBody,
  TrafficPlanAction,
  TrafficSignal,
  TrafficStatus,
  ZoneId,
} from "../../../../shared/traffic/types.ts";
import type {
  TrafficPolicy,
  TrafficPolicyContext,
  TrafficWorldSnapshot,
} from "../TrafficPolicy.ts";

type ZoneState = {
  id: ZoneId;
  members: Set<string>;
  seeds: Map<string, number>;
  /** Sticky ranking snapshot — first conflict locks order until zone dies. */
  stickyRank: string[];
  /** When mutual no-progress started (E2 watch). */
  stuckSinceMs: number | null;
  /** Pending E2/E3 round for this zone (0 = none). */
  evasionRound: number;
  evasionTargetId: string | null;
};

type LastGrant = {
  signal: TrafficSignal;
  zoneId: ZoneId;
};

type PoseSample = { x: number; y: number; atMs: number };

function emptyCorridor(): Corridor {
  return { segments: [] };
}

function corridorLen(c: Corridor): number {
  return c.segments.reduce((sum, seg) => sum + capsuleLength(seg), 0);
}

function hashSeed(robotId: string): number {
  let h = 0;
  for (let i = 0; i < robotId.length; i++) h = (h * 31 + robotId.charCodeAt(i)) >>> 0;
  return (h % 10000) / 100;
}

function bodyDisk(x: number, y: number, r = CORRIDOR_MIN_RADIUS + 2): Corridor {
  const radius = clampCorridorRadius(r);
  const seg: Capsule = { x1: x, y1: y, x2: x, y2: y, r: radius };
  return { segments: [seg] };
}

function signalToStatus(signal: TrafficSignal): TrafficStatus {
  if (signal === "PROCEED") return "proceed";
  if (signal === "PARTIAL") return "partial";
  return "stop";
}

/** Keep a continuous prefix of `held` that stays disjoint from `anchor`. */
function stripOverlapping(held: Corridor, anchor: Corridor): Corridor {
  if (!held.segments.length) return emptyCorridor();
  if (!anchor.segments.length) return { segments: held.segments.map((s) => ({ ...s })) };
  const kept: Capsule[] = [];
  for (const seg of held.segments) {
    if (corridorsDisjoint({ segments: [seg] }, anchor)) {
      kept.push({ ...seg });
      continue;
    }
    const cut = longestDisjointPrefix(seg, anchor);
    if (cut) kept.push(cut);
    break;
  }
  return { segments: kept };
}

function longestDisjointPrefix(seg: Capsule, anchor: Corridor): Capsule | null {
  const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
  if (len < 1e-6) {
    return corridorsDisjoint({ segments: [seg] }, anchor) ? { ...seg } : null;
  }
  let lo = 0;
  let hi = 1;
  let best: Capsule | null = null;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    const cut: Capsule = {
      x1: seg.x1,
      y1: seg.y1,
      x2: seg.x1 + (seg.x2 - seg.x1) * mid,
      y2: seg.y1 + (seg.y2 - seg.y1) * mid,
      r: seg.r,
    };
    if (corridorsDisjoint({ segments: [cut] }, anchor)) {
      best = cut;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  if (!best) return null;
  return capsuleLength(best) >= 2 ? best : null;
}

export class CorridorLeasePolicy implements TrafficPolicy {
  readonly id = "corridor_lease_v0" as const;
  private zones = new Map<ZoneId, ZoneState>();
  private lastGrant = new Map<string, LastGrant>();
  private lastPose = new Map<string, PoseSample>();
  private zoneSeq = 0;
  private evasionSeq = 0;
  listHeldRobotIds: () => string[] = () => [];

  constructor(private readonly ctx: TrafficPolicyContext) {}

  onRobotConnected(_robotId: string): void {}

  onRobotDisconnected(robotId: string): void {
    this.ctx.clearRobot(robotId);
    this.lastGrant.delete(robotId);
    this.lastPose.delete(robotId);
    for (const z of this.zones.values()) {
      z.members.delete(robotId);
      z.seeds.delete(robotId);
      z.stickyRank = z.stickyRank.filter((id) => id !== robotId);
      if (z.evasionTargetId === robotId) {
        z.evasionTargetId = null;
        z.evasionRound = 0;
        z.stuckSinceMs = null;
      }
    }
    this.pruneZones();
  }

  onLeaseRequest(
    robotId: string,
    req: LeaseRequestBody,
    world: TrafficWorldSnapshot,
  ): TrafficPlanAction[] {
    const robot = world.robots.find((r) => r.robotId === robotId);
    if (robot && !robot.avoidanceMode) {
      return this.grantReplace(robotId, req.requestId, req.wanted, world.nowMs, "", "PROCEED", "avoidance off");
    }

    if (req.wanted.segments.length === 0) {
      const current = this.ctx.getHeld(robotId) ?? emptyCorridor();
      return [this.statusAction(robotId, current.segments.length ? "proceed" : "clear")];
    }

    if (this.ctx.canGrant(robotId, req.wanted)) {
      const merged = this.mergeHeld(robotId, req.wanted);
      const actions = this.grantReplace(
        robotId,
        req.requestId,
        merged,
        world.nowMs,
        "",
        "PROCEED",
        "ok",
      );
      const held = this.ctx.getHeld(robotId);
      if (held) actions.push(...this.forceYieldOverlapping(robotId, held, world));
      return actions;
    }

    const conflictIds = this.findConflicts(robotId, req.wanted);
    const zone = this.ensureZone(robotId, conflictIds);
    const ranked = this.rankMembers(zone);
    const isWinner = ranked[0] === robotId;

    if (!isWinner) {
      // Loser: peel self against sticky winner held, freeze at boundary.
      const winnerId = ranked[0];
      const winnerHeld = (winnerId && this.ctx.getHeld(winnerId)) || emptyCorridor();
      const pose = this.poseOf(robotId, world);
      const current = this.ctx.getHeld(robotId) ?? emptyCorridor();
      let retained = stripOverlapping(current, winnerHeld);
      if (retained.segments.length === 0) {
        const body = bodyDisk(pose.x, pose.y);
        if (this.ctx.canGrant(robotId, body) && corridorsDisjoint(body, winnerHeld)) {
          retained = body;
        }
      }
      return this.grantReplace(
        robotId,
        req.requestId,
        retained,
        world.nowMs,
        zone.id,
        "STOP",
        "yield",
      );
    }

    // Winner: take safe prefix; peel losers' overlapping ahead.
    const partial = this.ctx.partialGrant(robotId, req.wanted);
    const pose = this.poseOf(robotId, world);
    const body = bodyDisk(pose.x, pose.y);
    const held: Corridor = {
      segments: [...body.segments, ...partial.segments],
    };
    const current = this.ctx.getHeld(robotId) ?? emptyCorridor();

    if (corridorLen(partial) >= PROGRESS_EPSILON_PX && this.ctx.canGrant(robotId, held)) {
      const actions = this.grantReplace(
        robotId,
        req.requestId,
        held,
        world.nowMs,
        zone.id,
        "PARTIAL",
        "winner partial",
      );
      actions.push(...this.forceYieldOverlapping(robotId, held, world));
      return actions;
    }

    // No new progress — keep existing held if still useful; do not downgrade to body STOP.
    if (current.segments.length > 0 && this.ctx.canGrant(robotId, current)) {
      const actions = this.grantReplace(
        robotId,
        req.requestId,
        current,
        world.nowMs,
        zone.id,
        this.lastGrant.get(robotId)?.signal === "PROCEED" ? "PROCEED" : "PARTIAL",
        "winner hold progress",
      );
      actions.push(...this.forceYieldOverlapping(robotId, current, world));
      return actions;
    }

    // Truly blocked — STOP at body only if it does not fight losers after peel attempt.
    const peelFirst = this.forceYieldOverlapping(robotId, body, world);
    if (this.ctx.canGrant(robotId, body)) {
      return [
        ...this.grantReplace(robotId, req.requestId, body, world.nowMs, zone.id, "STOP", "winner frozen"),
        ...peelFirst,
      ];
    }

    // Keep whatever we have; signal STOP without wiping peers via clearRobot.
    const fallback = current.segments.length ? current : emptyCorridor();
    return [
      ...this.grantReplace(
        robotId,
        req.requestId,
        fallback,
        world.nowMs,
        zone.id,
        "STOP",
        "winner blocked",
      ),
      ...peelFirst,
    ];
  }

  onLeaseRelease(
    robotId: string,
    leaseId: string,
    freed: Corridor,
    retained: Corridor,
  ): TrafficPlanAction[] {
    const ok = this.ctx.release(robotId, leaseId, freed, retained);
    if (!ok) return [this.statusAction(robotId, "stop")];
    const held = this.ctx.getHeld(robotId);
    if (!held || held.segments.length === 0) {
      this.lastGrant.delete(robotId);
      return [this.statusAction(robotId, "clear")];
    }
    return [this.statusAction(robotId, signalToStatus(this.lastGrant.get(robotId)?.signal ?? "PROCEED"))];
  }

  onBid(robotId: string, zoneId: ZoneId, seed: number): TrafficPlanAction[] {
    const z = this.zones.get(zoneId);
    if (!z || !z.members.has(robotId)) return [];
    if (!z.seeds.has(robotId)) z.seeds.set(robotId, seed);
    // Do not reshuffle stickyRank after first lock.
    return [];
  }

  onEvasionReply(robotId: string, payload: Record<string, unknown>): TrafficPlanAction[] {
    const result = String(payload.result ?? payload.Result ?? "").toUpperCase();
    const zoneId = String(payload.zone_id ?? payload.zoneId ?? "");
    const actions: TrafficPlanAction[] = [];
    const worldNow = Date.now();

    // Successful evade: notify sticky winners that the peer action finished, then detach loser.
    if (result === "REROUTE" || result === "VACATE" || result === "OK") {
      const z =
        (zoneId && this.zones.get(zoneId)) ||
        [...this.zones.values()].find((x) => x.members.has(robotId) || x.evasionTargetId === robotId);
      const winners = z ? this.rankMembers(z).filter((id) => id !== robotId) : [];
      this.detachFromZones(robotId);
      this.lastGrant.delete(robotId);
      // Loser vacated ledger occupancy so winners can expand.
      if (!(this.ctx.getHeld(robotId)?.segments.length)) {
        /* already empty */
      }
      actions.push(this.statusAction(robotId, "evade"));
      for (const wid of winners) {
        actions.push(...this.resumePriorityRobot(wid, z?.id ?? zoneId, worldNow, "peer_action_done"));
      }
      console.log(
        `[traffic] evade ${result} from ${robotId} → resume winners=[${winners.join(",")}]`,
      );
      return actions;
    }

    // NONE → escalate E2→E3 once, then freeze zone.
    const z = zoneId ? this.zones.get(zoneId) : [...this.zones.values()].find((x) => x.members.has(robotId));
    if (!z) {
      actions.push(this.statusAction(robotId, "stop"));
      return actions;
    }
    if (z.evasionRound < MAX_REROUTE_ROUNDS) {
      z.evasionRound += 1;
      z.evasionTargetId = robotId;
      const winnerId = this.rankMembers(z)[0];
      const hint = (winnerId && this.ctx.getHeld(winnerId)) || emptyCorridor();
      const leaseId = this.ctx.getHeld(robotId) ? `lease-${robotId}-held` : "";
      actions.push({
        kind: "evasion_request",
        robotId,
        zoneId: z.id,
        roundId: `e${++this.evasionSeq}`,
        leaseId,
        releaseHint: hint,
        mode: "VACATE",
        breadcrumbHint: [],
        deadlineMs: EVASION_DEADLINE_MS * 4,
      });
      actions.push(this.statusAction(robotId, "evade"));
      return actions;
    }

    // E5-lite: hold everyone in zone.
    for (const id of z.members) {
      actions.push(this.statusAction(id, "stop"));
    }
    return actions;
  }

  /**
   * Priority robot is told the peer finished E2/E3 — flip STOP/PARTIAL → PROCEED
   * and push zone_update so the robot clears local freeze.
   */
  private resumePriorityRobot(
    robotId: string,
    zoneId: string,
    nowMs: number,
    reason: string,
  ): TrafficPlanAction[] {
    const pose = this.lastPose.get(robotId);
    const held = this.ctx.getHeld(robotId) ?? (pose ? bodyDisk(pose.x, pose.y) : emptyCorridor());
    const leaseId = `lease-${robotId}-resume-${nowMs}`;
    const actions: TrafficPlanAction[] = [];
    if (held.segments.length && this.ctx.commit(robotId, leaseId, held, nowMs + LEASE_MS, zoneId)) {
      this.lastGrant.set(robotId, { signal: "PROCEED", zoneId });
      actions.push(
        this.grantAction(robotId, `resume-${nowMs}`, leaseId, "PROCEED", held, zoneId, reason),
      );
    } else {
      // Still promote signal even if commit fails — next request can expand.
      this.lastGrant.set(robotId, { signal: "PROCEED", zoneId });
    }
    actions.push(this.statusAction(robotId, "proceed"));
    actions.push({ kind: "zone_update", robotId, zoneId, state: "resume" });
    return actions;
  }

  tick(world: TrafficWorldSnapshot): TrafficPlanAction[] {
    const actions: TrafficPlanAction[] = [];
    this.updatePoseProgress(world);

    for (const r of world.robots) {
      if (!r.connected || !r.avoidanceMode) continue;
      const held = this.ctx.getHeld(r.robotId);
      if (!held || held.segments.length === 0) continue;
      const prev = this.lastGrant.get(r.robotId);
      let signal: TrafficSignal = prev?.signal ?? "PROCEED";

      // Conflict cleared (peer left / released) but we were still STOP — auto-resume.
      if ((signal === "STOP" || signal === "PARTIAL") && this.findConflicts(r.robotId, held).length === 0) {
        signal = "PROCEED";
        this.lastGrant.set(r.robotId, { signal: "PROCEED", zoneId: prev?.zoneId ?? "" });
        actions.push({
          kind: "zone_update",
          robotId: r.robotId,
          zoneId: prev?.zoneId ?? "",
          state: "resume",
        });
      }

      const renewHeld =
        signal === "STOP" && held.segments.length === 1 && capsuleLength(held.segments[0]) < 1e-6
          ? bodyDisk(r.x, r.y, held.segments[0].r)
          : { segments: held.segments.map((s) => ({ ...s })) };
      const leaseId = `lease-${r.robotId}-held`;
      if (!this.ctx.commit(r.robotId, leaseId, renewHeld, world.nowMs + LEASE_MS, prev?.zoneId ?? "")) {
        continue;
      }
      actions.push(
        this.grantAction(
          r.robotId,
          `renew-${world.nowMs}`,
          leaseId,
          signal,
          renewHeld,
          prev?.zoneId ?? "",
          "renew",
        ),
      );
      actions.push(this.statusAction(r.robotId, signalToStatus(signal)));
    }

    actions.push(...this.watchDeadlockAndEscalate(world));
    this.pruneZones();
    return actions;
  }

  private updatePoseProgress(world: TrafficWorldSnapshot): void {
    for (const r of world.robots) {
      if (!r.connected) continue;
      const prev = this.lastPose.get(r.robotId);
      if (!prev) {
        this.lastPose.set(r.robotId, { x: r.x, y: r.y, atMs: world.nowMs });
        continue;
      }
      if (Math.hypot(r.x - prev.x, r.y - prev.y) >= PROGRESS_EPSILON_PX) {
        this.lastPose.set(r.robotId, { x: r.x, y: r.y, atMs: world.nowMs });
      }
    }
  }

  /**
   * E2: if a zone is mutually stuck (no progress) longer than DEADLOCK_CONFIRM_MS,
   * ask the sticky loser to REROUTE. Waiting alone cannot clear a head-on.
   */
  private watchDeadlockAndEscalate(world: TrafficWorldSnapshot): TrafficPlanAction[] {
    const actions: TrafficPlanAction[] = [];
    for (const z of this.zones.values()) {
      if (z.members.size < 2) {
        z.stuckSinceMs = null;
        continue;
      }
      if (z.evasionTargetId) continue; // already waiting on a reply

      const members = [...z.members];
      const allStuck = members.every((id) => {
        const pose = this.lastPose.get(id);
        if (!pose) return false;
        return world.nowMs - pose.atMs >= DEADLOCK_CONFIRM_MS;
      });
      // Head-on / mutual freeze: no progress. STOP or PARTIAL both count as conflicted.
      const anyConflicted = members.some((id) => {
        const s = this.lastGrant.get(id)?.signal;
        return s === "STOP" || s === "PARTIAL";
      });
      if (!allStuck || !anyConflicted) {
        z.stuckSinceMs = null;
        continue;
      }
      // Fire E2 on first confirmed stuck window (do not wait a second full period).
      if (z.stuckSinceMs == null) z.stuckSinceMs = world.nowMs - DEADLOCK_CONFIRM_MS;

      const ranked = this.rankMembers(z);
      const loserId = ranked[ranked.length - 1];
      const winnerId = ranked[0];
      if (!loserId || loserId === winnerId) continue;

      z.evasionRound = 1;
      z.evasionTargetId = loserId;
      const hint = this.ctx.getHeld(winnerId) ?? emptyCorridor();
      const leaseId = `lease-${loserId}-held`;
      console.log(`[traffic] E2 REROUTE → ${loserId} zone=${z.id}`);
      actions.push({
        kind: "evasion_request",
        robotId: loserId,
        zoneId: z.id,
        roundId: `e${++this.evasionSeq}`,
        leaseId,
        releaseHint: hint,
        mode: "REROUTE",
        breadcrumbHint: [],
        deadlineMs: EVASION_DEADLINE_MS * 4,
      });
      actions.push(this.statusAction(loserId, "evade"));
    }
    return actions;
  }

  private detachFromZones(robotId: string): void {
    for (const z of this.zones.values()) {
      z.members.delete(robotId);
      z.seeds.delete(robotId);
      z.stickyRank = z.stickyRank.filter((id) => id !== robotId);
      if (z.evasionTargetId === robotId) {
        z.evasionTargetId = null;
        z.evasionRound = 0;
        z.stuckSinceMs = null;
      }
    }
  }

  private grantReplace(
    robotId: string,
    requestId: string,
    held: Corridor,
    nowMs: number,
    zoneId: ZoneId,
    signal: TrafficSignal,
    reason: string,
  ): TrafficPlanAction[] {
    const leaseId = `lease-${robotId}-${nowMs}`;
    if (!this.ctx.commit(robotId, leaseId, held, nowMs + LEASE_MS, zoneId)) {
      // Do NOT clearRobot — keep previous footprint in the ledger.
      const prev = this.ctx.getHeld(robotId) ?? emptyCorridor();
      this.lastGrant.set(robotId, { signal: "STOP", zoneId });
      return [
        this.grantAction(robotId, requestId, leaseId, "STOP", prev, zoneId, `${reason}|disjoint keep`),
        this.statusAction(robotId, "stop"),
      ];
    }
    this.lastGrant.set(robotId, { signal, zoneId });
    return [
      this.grantAction(robotId, requestId, leaseId, signal, held, zoneId, reason),
      this.statusAction(robotId, signalToStatus(signal)),
    ];
  }

  private mergeHeld(robotId: string, wanted: Corridor): Corridor {
    const current = this.ctx.getHeld(robotId) ?? emptyCorridor();
    return { segments: [...current.segments, ...wanted.segments] };
  }

  /**
   * Peel peers whose held overlaps `anchor`: strip overlapping prefix, STOP.
   * Never replace with a bodyDisk that intersects the winner corridor.
   */
  private forceYieldOverlapping(
    anchorId: string,
    anchorHeld: Corridor,
    world: TrafficWorldSnapshot,
  ): TrafficPlanAction[] {
    const actions: TrafficPlanAction[] = [];
    for (const id of this.listHeldRobotIds()) {
      if (id === anchorId) continue;
      const held = this.ctx.getHeld(id);
      if (!held || held.segments.length === 0) continue;
      if (corridorsDisjoint(held, anchorHeld)) continue;

      const pose = this.poseOf(id, world);
      let retained = stripOverlapping(held, anchorHeld);
      if (retained.segments.length === 0) {
        const body = bodyDisk(pose.x, pose.y);
        if (corridorsDisjoint(body, anchorHeld) && this.ctx.canGrant(id, body)) {
          retained = body;
        }
      }

      const leaseId = `lease-${id}-yield-${world.nowMs}`;
      if (!this.ctx.commit(id, leaseId, retained, world.nowMs + LEASE_MS, "")) {
        // Keep previous held; still tell robot to STOP (motion freeze).
        this.lastGrant.set(id, { signal: "STOP", zoneId: "" });
        actions.push(
          this.grantAction(id, `yield-${world.nowMs}`, leaseId, "STOP", held, "", "yield keep"),
        );
      } else {
        this.lastGrant.set(id, { signal: "STOP", zoneId: "" });
        actions.push(
          this.grantAction(id, `yield-${world.nowMs}`, leaseId, "STOP", retained, "", "yield strip"),
        );
      }
      actions.push(this.statusAction(id, "stop"));
    }
    return actions;
  }

  private poseOf(robotId: string, world: TrafficWorldSnapshot): { x: number; y: number } {
    const r = world.robots.find((x) => x.robotId === robotId);
    return { x: r?.x ?? 0, y: r?.y ?? 0 };
  }

  private findConflicts(robotId: string, wanted: Corridor): string[] {
    const hits: string[] = [];
    for (const id of this.listHeldRobotIds()) {
      if (id === robotId) continue;
      const held = this.ctx.getHeld(id);
      if (!held) continue;
      if (!corridorsDisjoint(wanted, held)) hits.push(id);
    }
    return hits;
  }

  private ensureZone(robotId: string, others: string[]): ZoneState {
    for (const z of this.zones.values()) {
      if (z.members.has(robotId) || others.some((id) => z.members.has(id))) {
        z.members.add(robotId);
        for (const id of others) z.members.add(id);
        for (const m of z.members) {
          if (!z.seeds.has(m)) z.seeds.set(m, hashSeed(m));
        }
        // Extend sticky rank with new members at the end (do not reshuffle).
        for (const m of z.members) {
          if (!z.stickyRank.includes(m)) z.stickyRank.push(m);
        }
        return z;
      }
    }
    const id = `tz-${++this.zoneSeq}`;
    const members = new Set([robotId, ...others]);
    const seeds = new Map<string, number>();
    for (const m of members) seeds.set(m, hashSeed(m));
    const stickyRank = [...members].sort((a, b) => {
      const sa = seeds.get(a) ?? 0;
      const sb = seeds.get(b) ?? 0;
      if (sb !== sa) return sb - sa;
      return a.localeCompare(b);
    });
    const z: ZoneState = {
      id,
      members,
      seeds,
      stickyRank,
      stuckSinceMs: null,
      evasionRound: 0,
      evasionTargetId: null,
    };
    this.zones.set(id, z);
    return z;
  }

  private rankMembers(z: ZoneState): string[] {
    // Sticky order only — no starvation aging (prevents cross stutter / winner flip).
    const live = z.stickyRank.filter((id) => z.members.has(id));
    for (const m of z.members) {
      if (!live.includes(m)) live.push(m);
    }
    return live;
  }

  private pruneZones(): void {
    for (const [id, z] of [...this.zones.entries()]) {
      if (z.members.size <= 1) {
        this.zones.delete(id);
        continue;
      }
      // Dissolve when all member held pairs are disjoint (conflict cleared).
      const ids = [...z.members];
      let conflict = false;
      for (let i = 0; i < ids.length && !conflict; i++) {
        const a = this.ctx.getHeld(ids[i]);
        if (!a?.segments.length) continue;
        for (let j = i + 1; j < ids.length; j++) {
          const b = this.ctx.getHeld(ids[j]);
          if (!b?.segments.length) continue;
          if (!corridorsDisjoint(a, b)) {
            conflict = true;
            break;
          }
        }
      }
      if (!conflict) this.zones.delete(id);
    }
  }

  private grantAction(
    robotId: string,
    requestId: string,
    leaseId: string,
    signal: TrafficSignal,
    held: Corridor,
    zoneId: string,
    reason: string,
  ): TrafficPlanAction {
    return {
      kind: "grant",
      robotId,
      grant: {
        leaseId,
        signal,
        held: { segments: held.segments.map((s) => ({ ...s })) },
        leaseDurationMs: LEASE_MS,
        zoneId,
        reason: `${requestId}|${reason}`,
      },
    };
  }

  private statusAction(robotId: string, trafficStatus: TrafficStatus): TrafficPlanAction {
    return { kind: "set_status", robotId, trafficStatus };
  }
}
