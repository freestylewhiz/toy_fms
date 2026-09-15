/**
 * v1 robot executor — no corridor freeze.
 * Motion is gated by occupancy + peer local plans on the controller.
 * FMS evasion still flows through onEvasionRequest → controller replan/reverse.
 */

import { parseTrafficSignal, type TrafficStatus } from "../../../shared/traffic/types.ts";
import type {
  MotionSnapshot,
  TrafficExecutor,
  TrafficExecutorHooks,
  TrafficGrant,
} from "./TrafficExecutor.ts";
import type { Corridor } from "../../../shared/corridor.ts";

export class LocalPlanExecutor implements TrafficExecutor {
  readonly policyId = "local_plan_v1";
  private status: TrafficStatus = "clear";
  private currentLeaseId = "";

  constructor(private readonly hooks: TrafficExecutorHooks) {}

  trafficStatus(): TrafficStatus {
    return this.status;
  }

  leaseId(): string {
    return this.currentLeaseId;
  }

  held(): Corridor {
    return { segments: [] };
  }

  headRoomPx(): number {
    return Infinity;
  }

  poseAllowed(_x: number, _y: number, _theta: number): boolean {
    return true;
  }

  onGrant(grant: TrafficGrant): void {
    this.currentLeaseId = grant.leaseId;
    if (grant.signal === "STOP" && this.status !== "evade") this.status = "stop";
    else if (this.status !== "evade") this.status = grant.signal === "PARTIAL" ? "partial" : "proceed";
  }

  onBidRequest(zoneId: string, _windowMs: number): void {
    this.hooks.sendTrafficBid?.(zoneId, Math.random() * 100);
  }

  onEvasionRequest(payload: Record<string, unknown>): void {
    this.status = "evade";
    this.hooks.onEvasionPlan?.(payload);
  }

  onZoneUpdate(_zoneId: string, state: string): void {
    const s = state.toLowerCase();
    if (s === "resume" || s === "peer_cleared" || s === "peer_action_done") {
      this.status = "proceed";
      return;
    }
    if (s === "hold" || s === "yield" || s === "wait") {
      if (this.status !== "evade") this.status = "stop";
    }
  }

  beginEvadeMotion(): void {
    this.status = "evade";
  }

  markHold(): void {
    if (this.status !== "evade" && this.status !== "stop") this.status = "hold";
  }

  latchFreeze(_x: number, _y: number): void {}

  onTick(snap: MotionSnapshot): void {
    if (!snap.avoidanceMode) {
      this.status = "clear";
      return;
    }
    if (this.status === "stop" || this.status === "evade") return;
    if (snap.phase === "idle") this.status = "clear";
    else if (this.status === "clear" || this.status === "hold") this.status = "proceed";
  }

  clear(): void {
    this.currentLeaseId = "";
    this.status = "clear";
  }
}

export function grantFromProtoV1(msg: any): TrafficGrant {
  return {
    requestId: String(msg.request_id ?? ""),
    leaseId: String(msg.lease_id ?? ""),
    signal: parseTrafficSignal(msg.signal),
    held: { segments: [] },
    leaseDurationMs: Number(msg.lease_until_ms) || 400,
    zoneId: String(msg.zone_id ?? ""),
    reason: String(msg.reason ?? ""),
  };
}
