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
  private controlEpoch = 0;
  private sessionId = "";
  private highestStopGeneration: bigint | null = null;
  private stopToken: { stopId: string; generation: bigint } | null = null;
  private lastStopCheckAt = Number.NEGATIVE_INFINITY;

  private generation(raw: unknown): bigint | null {
    try {
      if (typeof raw === "bigint") return raw >= 0n ? raw : null;
      const value = String(raw ?? "").trim();
      if (!/^\d+$/.test(value)) return null;
      return BigInt(value);
    } catch {
      return null;
    }
  }

  private hasStopToken(): boolean {
    return this.stopToken !== null;
  }

  private pollStopCheck(): void {
    const token = this.stopToken;
    if (!token || !this.hooks.sendTrafficStopCheck) return;
    const now = Date.now();
    if (now - this.lastStopCheckAt < 1_000) return;
    this.lastStopCheckAt = now;
    this.hooks.sendTrafficStopCheck({ stop_id: token.stopId, stop_generation: token.generation.toString() });
  }

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
    if (grant.sessionId !== undefined && grant.sessionId !== this.sessionId) return;
    if (grant.controlEpoch !== undefined && Number(grant.controlEpoch) !== this.controlEpoch) return;
    const stopId = String(grant.stopId ?? "");
    const stopGeneration = this.generation(grant.stopGeneration);
    if (grant.signal === "STOP") {
      // A tokenized STOP is authoritative even while the controller is
      // executing an evasion. Older grants must never replace its token.
      if (stopId && stopGeneration !== null) {
        if (this.highestStopGeneration !== null && stopGeneration < this.highestStopGeneration) return;
        if (this.highestStopGeneration !== null && stopGeneration === this.highestStopGeneration &&
            this.stopToken !== null && this.stopToken.stopId !== stopId) return;
        const changed = this.stopToken?.stopId !== stopId || this.stopToken?.generation !== stopGeneration;
        this.highestStopGeneration = stopGeneration;
        this.stopToken = { stopId, generation: stopGeneration };
        if (changed) this.lastStopCheckAt = Number.NEGATIVE_INFINITY;
      }
      this.currentLeaseId = grant.leaseId;
      this.status = "stop";
      return;
    }
    // Once FMS has identified a STOP, neither a lease renewal nor a zone
    // side-channel is allowed to resume it. Only traffic_stop_status RESUME
    // matching this exact token can clear it.
    if (this.hasStopToken()) return;
    this.currentLeaseId = grant.leaseId;
    if (this.status !== "evade") this.status = grant.signal === "PARTIAL" ? "partial" : "proceed";
  }

  onBidRequest(zoneId: string, _windowMs: number): void {
    this.hooks.sendTrafficBid?.(zoneId, Math.random() * 100);
  }

  onEvasionRequest(payload: Record<string, unknown>): void {
    this.status = this.hasStopToken() ? "stop" : "evade";
    this.hooks.onEvasionPlan?.(payload);
  }

  onZoneUpdate(_zoneId: string, state: string): void {
    const s = state.toLowerCase();
    if (s === "resume" || s === "peer_cleared" || s === "peer_action_done") {
      if (this.hasStopToken()) return;
      this.status = "proceed";
      return;
    }
    if (s === "hold" || s === "yield" || s === "wait") {
      if (this.status !== "evade") this.status = "stop";
    }
  }

  beginEvadeMotion(): void {
    this.status = this.hasStopToken() ? "stop" : "evade";
  }

  markHold(): void {
    if (this.hasStopToken() || this.status === "evade" || this.status === "stop") return;
    this.status = "hold";
  }

  latchFreeze(_x: number, _y: number): void {}

  onTick(snap: MotionSnapshot): void {
    if (!snap.avoidanceMode) {
      if (!this.hasStopToken()) this.status = "clear";
      else this.status = "stop";
      this.pollStopCheck();
      return;
    }
    if (this.hasStopToken()) {
      this.status = "stop";
      this.pollStopCheck();
      return;
    }
    if (this.status === "stop" || this.status === "evade") return;
    if (snap.phase === "idle") this.status = "clear";
    else if (this.status === "clear" || this.status === "hold") this.status = "proceed";
  }

  clear(): void {
    this.currentLeaseId = "";
    // Mission cancellation and evasion cleanup are not authoritative STOP
    // releases. Keep the latch until the matching status RESUME arrives.
    this.status = this.hasStopToken() ? "stop" : "clear";
  }

  setControlState(state: { controlEpoch: number; sessionId: string }): void {
    const boundary = this.sessionId !== state.sessionId || this.controlEpoch !== state.controlEpoch;
    this.controlEpoch = state.controlEpoch;
    this.sessionId = state.sessionId;
    if (boundary) {
      this.stopToken = null;
      this.highestStopGeneration = null;
      this.lastStopCheckAt = Number.NEGATIVE_INFINITY;
      this.status = "clear";
    }
  }

  onTrafficStopStatus(status: {
    stop_id: string;
    stop_generation: string | number | bigint;
    decision: string;
    reason?: string;
    control_epoch?: string | number | bigint;
    session_id?: string;
  }): void {
    const stopId = String(status.stop_id ?? "");
    const generation = this.generation(status.stop_generation);
    const decision = String(status.decision ?? "").toUpperCase();
    if (!stopId || generation === null || (decision !== "STOP" && decision !== "RESUME")) return;
    if (status.session_id !== undefined && String(status.session_id) !== this.sessionId) return;
    if (status.control_epoch !== undefined && Number(status.control_epoch) !== this.controlEpoch) return;
    if (this.highestStopGeneration !== null && generation < this.highestStopGeneration) return;

    if (decision === "STOP") {
      if (this.highestStopGeneration !== null && generation === this.highestStopGeneration &&
          this.stopToken !== null && this.stopToken.stopId !== stopId) return;
      const changed = this.stopToken?.stopId !== stopId || this.stopToken?.generation !== generation;
      this.highestStopGeneration = generation;
      this.stopToken = { stopId, generation };
      this.status = "stop";
      if (changed) this.lastStopCheckAt = Number.NEGATIVE_INFINITY;
      return;
    }

    // RESUME is deliberately exact-match. A newer generation belongs to a
    // different stop and cannot release the currently latched token.
    if (!this.stopToken || this.stopToken.stopId !== stopId || this.stopToken.generation !== generation) return;
    this.stopToken = null;
    this.status = "proceed";
    this.lastStopCheckAt = Number.NEGATIVE_INFINITY;
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
    stopId: String(msg.stop_id ?? ""),
    stopGeneration: msg.stop_generation ?? "",
    controlEpoch: msg.control_epoch,
    sessionId: msg.session_id ? String(msg.session_id) : undefined,
  };
}
