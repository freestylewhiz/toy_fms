/**
 * Corridor-lease executor v0 — builds corridors, enforces I2, requests/releases leases.
 */

import {
  AVOIDANCE_MODE_DEFAULT,
  CORRIDOR_MIN_RADIUS,
  CORRIDOR_MAX_RADIUS,
  LEASE_MS,
  LEASE_REQUEST_AHEAD_S,
  LINEAR_SPEED_PX_S,
  PERMIT_HORIZON_S,
  RELEASE_HYSTERESIS_PX,
} from "../../../shared/constants.ts";
import {
  chainCapsules,
  clampCorridorRadius,
  corridorContainsFootprint,
  headRoomAlongPath,
  pointInCapsule,
  samplePathAhead,
  type Capsule,
  type Corridor,
} from "../../../shared/corridor.ts";
import { parseTrafficSignal, type TrafficStatus } from "../../../shared/traffic/types.ts";
import {
  parseCapsuleList,
  type MotionSnapshot,
  type TrafficExecutor,
  type TrafficExecutorHooks,
  type TrafficGrant,
} from "./TrafficExecutor.ts";

function empty(): Corridor {
  return { segments: [] };
}

export class CorridorLeaseExecutor implements TrafficExecutor {
  readonly policyId = "corridor_lease_v0";
  private heldCorridor: Corridor = empty();
  private currentLeaseId = "";
  private leaseUntil = 0;
  private status: TrafficStatus = "clear";
  private lastRequestAt = 0;
  private pendingRequestId = "";
  private avoidanceMode = AVOIDANCE_MODE_DEFAULT;
  private chooseRadius = Math.min(CORRIDOR_MAX_RADIUS, CORRIDOR_MIN_RADIUS + 6);

  constructor(private readonly hooks: TrafficExecutorHooks) {}

  setAvoidanceMode(on: boolean): void {
    this.avoidanceMode = on;
  }

  trafficStatus(): TrafficStatus {
    if (!this.avoidanceMode) return "clear";
    if (Date.now() > this.leaseUntil && this.heldCorridor.segments.length > 0) {
      return "lease_lost";
    }
    return this.status;
  }

  leaseId(): string {
    return this.currentLeaseId;
  }

  held(): Corridor {
    return { segments: this.heldCorridor.segments.map((s) => ({ ...s })) };
  }

  headRoomPx(): number {
    return this.lastHeadRoom;
  }

  private lastHeadRoom = 0;
  /** Locked XY while SIGNAL_STOP — must not track pose (renew body-disk would otherwise creep). */
  private freezePose: { x: number; y: number } | null = null;
  /** Max translation from freezePose under STOP (≪ one tick step ≈ 0.6px). */
  private static readonly FREEZE_EPS_PX = 0.15;

  getHeadRoom(): number {
    return this.lastHeadRoom;
  }

  poseAllowed(x: number, y: number, theta: number): boolean {
    if (!this.avoidanceMode) return true;
    // Hard stop: SIGNAL_STOP freezes translation regardless of residual held geometry.
    // Do NOT use the renewing body-disk as a movable envelope — that lets losers creep.
    if (this.status === "stop") {
      const ax = this.freezePose?.x ?? x;
      const ay = this.freezePose?.y ?? y;
      return Math.hypot(x - ax, y - ay) <= CorridorLeaseExecutor.FREEZE_EPS_PX;
    }
    if (this.heldCorridor.segments.length === 0) {
      if (!this.freezePose) return true;
      return (
        Math.hypot(x - this.freezePose.x, y - this.freezePose.y) <=
        CorridorLeaseExecutor.FREEZE_EPS_PX
      );
    }
    if (Date.now() > this.leaseUntil) return false;
    return corridorContainsFootprint(this.heldCorridor, x, y, theta);
  }

  onGrant(grant: TrafficGrant): void {
    this.heldCorridor = {
      segments: grant.held.segments.map((s) => ({ ...s })),
    };
    this.currentLeaseId = grant.leaseId;
    this.leaseUntil = Date.now() + Math.max(50, grant.leaseDurationMs || LEASE_MS);
    if (grant.signal === "PROCEED") {
      this.freezePose = null;
      this.status = this.heldCorridor.segments.length ? "proceed" : "clear";
    } else if (grant.signal === "PARTIAL") {
      this.freezePose = null;
      this.status = "partial";
    } else if (this.status === "evade") {
      // Ignore STOP while executing E2/E3 — renews must not re-freeze the detour.
      this.heldCorridor = empty();
      this.freezePose = null;
    } else {
      // STOP: lock freeze pose once. Later STOP renews must not move the anchor.
      this.status = "stop";
      if (!this.freezePose) {
        if (this.heldCorridor.segments.length === 1) {
          const s = this.heldCorridor.segments[0];
          this.freezePose = { x: s.x1, y: s.y1 };
        }
      }
    }
    if (grant.requestId && grant.requestId === this.pendingRequestId) {
      this.pendingRequestId = "";
    }
  }

  onBidRequest(zoneId: string, _windowMs: number): void {
    const seed = Math.random() * 100;
    this.hooks.sendTrafficBid?.(zoneId, seed);
  }

  onEvasionRequest(payload: Record<string, unknown>): void {
    this.status = "evade";
    this.freezePose = null;
    // Drop held so motion is not frozen on an old corridor while replanning.
    this.heldCorridor = empty();
    this.leaseUntil = 0;
    this.hooks.onEvasionPlan?.(payload);
  }

  /** After a successful evade plan, allow follow without lease briefly until re-grant. */
  beginEvadeMotion(): void {
    this.status = "evade";
    this.freezePose = null;
  }

  onZoneUpdate(zoneId: string, state: string): void {
    const s = state.toLowerCase();
    if (s === "resume" || s === "peer_cleared" || s === "peer_action_done") {
      // Priority robot: peer finished evade — clear STOP freeze and allow follow.
      if (this.status === "stop" || this.status === "hold") {
        this.freezePose = null;
        this.status = this.heldCorridor.segments.length ? "proceed" : "clear";
      }
      console.log(`[traffic] zone ${zoneId} ${state} → resume motion`);
    }
  }

  onTick(snap: MotionSnapshot): void {
    this.avoidanceMode = snap.avoidanceMode;
    if (!this.avoidanceMode) {
      this.status = "clear";
      this.lastHeadRoom = Infinity;
      this.freezePose = null;
      return;
    }

    // Under STOP: latch freeze once, never follow the pose (that was the creep bug).
    // Evade is exempt — robot must move onto the new path.
    if (this.status === "stop") {
      if (!this.freezePose) this.freezePose = { x: snap.x, y: snap.y };
      this.lastHeadRoom = 0;
      this.maybeRequest(snap);
      return;
    }

    if (this.status === "evade") {
      this.freezePose = null;
      this.lastHeadRoom = headRoomAlongPath(
        this.heldCorridor,
        snap.path,
        snap.pathIndex,
        { x: snap.x, y: snap.y },
        snap.theta,
      );
      this.maybeRequest(snap);
      return;
    }

    if (this.heldCorridor.segments.length === 0) {
      if (!this.freezePose) this.freezePose = { x: snap.x, y: snap.y };
    } else if (this.status !== "hold") {
      this.freezePose = null;
    }

    if (Date.now() > this.leaseUntil && this.heldCorridor.segments.length > 0) {
      this.status = "lease_lost";
      this.lastHeadRoom = 0;
      return;
    }

    this.lastHeadRoom = headRoomAlongPath(
      this.heldCorridor,
      snap.path,
      snap.pathIndex,
      { x: snap.x, y: snap.y },
      snap.theta,
    );

    this.maybeRelease(snap);
    this.maybeRequest(snap);
  }

  clear(): void {
    if (this.heldCorridor.segments.length && this.currentLeaseId) {
      this.hooks.sendLeaseRelease({
        lease_id: this.currentLeaseId,
        freed: this.heldCorridor,
        retained: empty(),
      });
    }
    this.heldCorridor = empty();
    this.currentLeaseId = "";
    this.leaseUntil = 0;
    this.status = "clear";
    this.pendingRequestId = "";
    this.lastHeadRoom = 0;
    this.freezePose = null;
  }

  /** When controller enters hold because pose was rejected by lease. */
  markHold(): void {
    if (!this.avoidanceMode) return;
    // Never overwrite FMS STOP / lease_lost — UI + resume logic must keep seeing stop.
    if (this.status === "stop" || this.status === "lease_lost") return;
    this.status = "hold";
    if (!this.freezePose) {
      // Latch current XY so empty/body-only held can't creep via renew.
      // Controller will call this while still at the blocked pose.
    }
  }

  /** Latch freeze at the robot's current pose (called from controller on lease block). */
  latchFreeze(x: number, y: number): void {
    if (!this.freezePose) this.freezePose = { x, y };
  }

  private maybeRequest(snap: MotionSnapshot): void {
    if (snap.phase === "idle" || snap.path.length === 0) return;
    const need =
      this.heldCorridor.segments.length === 0 ||
      this.lastHeadRoom < LINEAR_SPEED_PX_S * LEASE_REQUEST_AHEAD_S;
    if (!need) return;
    if (Date.now() - this.lastRequestAt < 80) return;

    const ahead = samplePathAhead(
      snap.path,
      snap.pathIndex,
      { x: snap.x, y: snap.y },
      LINEAR_SPEED_PX_S * PERMIT_HORIZON_S,
    );
    const r = clampCorridorRadius(this.chooseRadius);
    // Always cover current footprint with a disk so grant can't leave the body outside held.
    const bodyDisk: Capsule = {
      x1: snap.x,
      y1: snap.y,
      x2: snap.x,
      y2: snap.y,
      r: clampCorridorRadius(r),
    };
    const wanted = { segments: [bodyDisk, ...chainCapsules(ahead, r)] };
    // Only request segments not already covered by held
    const fresh = wanted.segments.filter(
      (seg) => !this.segmentMostlyInside(seg, this.heldCorridor),
    );
    if (fresh.length === 0 && this.heldCorridor.segments.length > 0) return;

    const requestId = `req-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    this.pendingRequestId = requestId;
    this.lastRequestAt = Date.now();
    this.hooks.sendLeaseRequest({
      request_id: requestId,
      lease_id: this.currentLeaseId,
      wanted: { segments: fresh.length ? fresh : wanted.segments },
      gain_px: LINEAR_SPEED_PX_S * PERMIT_HORIZON_S,
      urgent: this.lastHeadRoom < LINEAR_SPEED_PX_S * 0.5,
    });
  }

  private maybeRelease(snap: MotionSnapshot): void {
    if (!this.heldCorridor.segments.length || !this.currentLeaseId) return;

    // Only free a prefix the robot has fully passed. Never free "not currently
    // occupied" segments ahead — that was releasing the reservation and letting
    // peers drive into our path.
    let cut = 0;
    while (cut < this.heldCorridor.segments.length) {
      const seg = this.heldCorridor.segments[cut];
      if (!this.segmentFullyPassed(snap, seg)) break;
      cut++;
    }
    if (cut === 0) return;

    const freed = this.heldCorridor.segments.slice(0, cut);
    const retained = this.heldCorridor.segments.slice(cut);
    this.hooks.sendLeaseRelease({
      lease_id: this.currentLeaseId,
      freed: { segments: freed },
      retained: { segments: retained },
    });
    this.heldCorridor = { segments: retained };
    if (retained.length === 0) {
      this.currentLeaseId = "";
      this.status = "clear";
    }
  }

  /** True when the robot is past both endpoints of the capsule (behind travel). */
  private segmentFullyPassed(snap: MotionSnapshot, seg: Capsule): boolean {
    if (!this.robotClearOfCapsule(snap.x, snap.y, snap.theta, seg)) return false;
    const fx = Math.cos(snap.theta);
    const fy = Math.sin(snap.theta);
    const margin = RELEASE_HYSTERESIS_PX;
    const behind = (x: number, y: number) => (x - snap.x) * fx + (y - snap.y) * fy < -margin;
    return behind(seg.x1, seg.y1) && behind(seg.x2, seg.y2);
  }

  private robotClearOfCapsule(x: number, y: number, theta: number, seg: Capsule): boolean {
    // Require footprint samples to be RELEASE_HYSTERESIS beyond capsule.
    if (seg.r <= RELEASE_HYSTERESIS_PX) {
      return !pointInCapsule(x, y, { ...seg, r: RELEASE_HYSTERESIS_PX });
    }
    const inflated: Capsule = { ...seg, r: Math.max(0, seg.r - RELEASE_HYSTERESIS_PX) };
    return !corridorContainsFootprint({ segments: [inflated] }, x, y, theta);
  }

  private segmentMostlyInside(seg: Capsule, held: Corridor): boolean {
    if (!held.segments.length) return false;
    const samples = [
      [seg.x1, seg.y1],
      [seg.x2, seg.y2],
      [(seg.x1 + seg.x2) / 2, (seg.y1 + seg.y2) / 2],
    ];
    return samples.every(([x, y]) => held.segments.some((h) => pointInCapsule(x, y, h)));
  }
}

export function grantFromProto(msg: any): TrafficGrant {
  return {
    requestId: String(msg.request_id ?? ""),
    leaseId: String(msg.lease_id ?? ""),
    signal: parseTrafficSignal(msg.signal),
    held: { segments: parseCapsuleList(msg.held) },
    leaseDurationMs: Number(msg.lease_until_ms) || LEASE_MS,
    zoneId: String(msg.zone_id ?? ""),
    reason: String(msg.reason ?? ""),
  };
}

// silence unused import warning for CORRIDOR_MAX_RADIUS in case of lint
void CORRIDOR_MAX_RADIUS;
