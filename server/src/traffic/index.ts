/**
 * TrafficController — executes TrafficPolicy plans over gRPC + Colyseus.
 * Swappable policy; ledger is the invariant store.
 */

import { AUTHORITY_HZ, LEASE_MS } from "../../../shared/constants.ts";
import type { Capsule, Corridor } from "../../../shared/corridor.ts";
import {
  parseTrafficStatus,
  type LeaseRequestBody,
  type TrafficPlanAction,
  type TrafficStatus,
} from "../../../shared/traffic/types.ts";
import { LeaseLedger } from "./LeaseLedger.ts";
import { SemanticCapacityGate } from "./SemanticCapacityGate.ts";
import type { RuntimeStore } from "../runtimeStore.ts";
import type { ResourceOccupancy } from "../../../shared/robotRuntime.ts";
import { createTrafficPolicy } from "./createPolicy.ts";
import type {
  RobotTrafficView,
  TrafficPolicy,
  TrafficPolicyContext,
  TrafficWorldSnapshot,
} from "./TrafficPolicy.ts";

export type TrafficOutbound = {
  sendLeaseGrant: (
    robotId: string,
    payload: {
      request_id: string;
      lease_id: string;
      signal: string;
      held: Corridor;
      lease_until_ms: number;
      zone_id: string;
      reason: string;
    },
  ) => void;
  sendBidRequest?: (robotId: string, zoneId: string, windowMs: number) => void;
  sendEvasionRequest?: (robotId: string, payload: Record<string, unknown>) => void;
  sendZoneUpdate?: (robotId: string, zoneId: string, state: string) => void;
  setRobotTrafficStatus: (robotId: string, status: TrafficStatus) => void;
};

export type TrafficInboundHooks = {
  getWorld: () => TrafficWorldSnapshot;
  onRuntimeOccupancies?: (records: ResourceOccupancy[]) => void;
};

function parseCorridor(raw: any): Corridor {
  const segs = Array.isArray(raw?.segments) ? raw.segments : [];
  return {
    segments: segs
      .map((s: any): Capsule | null => {
        const values = [s?.x1, s?.y1, s?.x2, s?.y2, s?.r].map(Number);
        if (!values.every(Number.isFinite) || values[4] < 0) return null;
        return { x1: values[0], y1: values[1], x2: values[2], y2: values[3], r: values[4] };
      })
      .filter((s: Capsule | null): s is Capsule => s !== null),
  };
}

export class TrafficController {
  readonly ledger = new LeaseLedger();
  private policy: TrafficPolicy;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingRequestId = new Map<string, string>();
  private readonly capacityGate: SemanticCapacityGate;

  constructor(
    private readonly outbound: TrafficOutbound,
    private readonly hooks: TrafficInboundHooks,
    policyFactory?: (ctx: TrafficPolicyContext) => TrafficPolicy,
    runtimeStore?: RuntimeStore,
  ) {
    const ctx = this.makeContext();
    this.capacityGate = new SemanticCapacityGate(runtimeStore);
    this.policy = policyFactory
      ? policyFactory(ctx)
      : createTrafficPolicy(ctx, () => this.ledger.all().map((e) => e.robotId));
  }

  start(): void {
    if (this.timer) return;
    const period = Math.max(20, Math.floor(1000 / AUTHORITY_HZ));
    this.timer = setInterval(() => this.tick(), period);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  onRobotConnected(robotId: string): void {
    this.policy.onRobotConnected(robotId);
  }

  onRobotDisconnected(robotId: string): void {
    this.policy.onRobotDisconnected(robotId);
    this.outbound.setRobotTrafficStatus(robotId, "clear");
  }

  releaseSemanticOccupancy(robotId: string, zoneId: string): void {
    this.capacityGate.release(robotId, zoneId);
  }

  handleLeaseRequest(robotId: string, msg: any): void {
    if (!this.isOperational(robotId)) return;
    const requestId = String(msg?.request_id ?? "").trim();
    const leaseId = String(msg?.lease_id ?? "").trim();
    const gainPx = Number(msg?.gain_px);
    if (!requestId || !leaseId || !Number.isFinite(gainPx) || gainPx < 0) {
      this.outbound.setRobotTrafficStatus(robotId, "stop");
      this.outbound.sendLeaseGrant(robotId, {
        request_id: requestId,
        lease_id: leaseId,
        signal: "SIGNAL_STOP",
        held: { segments: [] },
        lease_until_ms: 0,
        zone_id: "",
        reason: "invalid lease request",
      });
      return;
    }
    const req: LeaseRequestBody = {
      requestId,
      leaseId,
      wanted: parseCorridor(msg.wanted),
      gainPx,
      urgent: Boolean(msg.urgent),
    };
    if (!this.isOperational(robotId)) {
      this.outbound.setRobotTrafficStatus(robotId, "stop");
      this.outbound.sendLeaseGrant(robotId, { request_id: req.requestId, lease_id: req.leaseId, signal: "SIGNAL_STOP", held: { segments: [] }, lease_until_ms: 0, zone_id: "", reason: "robot control unavailable" });
      return;
    }
    this.pendingRequestId.set(robotId, req.requestId);
    const actions = this.policy.onLeaseRequest(robotId, req, this.hooks.getWorld());
    this.applyActions(actions);
  }

  handleLeaseRelease(robotId: string, msg: any): void {
    if (!this.isOperational(robotId)) return;
    const actions = this.policy.onLeaseRelease(
      robotId,
      String(msg.lease_id ?? ""),
      parseCorridor(msg.freed),
      parseCorridor(msg.retained),
    );
    this.applyActions(actions);
  }

  handleBid(robotId: string, msg: any): void {
    if (!this.isOperational(robotId)) return;
    const actions = this.policy.onBid(robotId, String(msg.zone_id ?? ""), Number(msg.seed) || 0);
    this.applyActions(actions);
  }

  handleEvasionReply(robotId: string, msg: any): void {
    if (!this.isOperational(robotId)) return;
    const actions = this.policy.onEvasionReply(robotId, msg ?? {});
    this.applyActions(actions);
  }

  private tick(): void {
    const now = Date.now();
    this.ledger.expireBefore(now);
    const world = this.hooks.getWorld();
    const actions = this.policy.tick({ ...world, robots: world.robots.filter(r => r.connected && r.fmsControlState !== "disabled" && r.controlReady !== false) });
    const semanticActions = this.capacityGate.tick(world);
    this.hooks.onRuntimeOccupancies?.(this.capacityGate.snapshot() as ResourceOccupancy[]);
    this.applyActions([...actions, ...semanticActions]);
  }

  private applyActions(actions: TrafficPlanAction[]): void {
    for (const a of actions) {
      if (!this.isOperational(a.robotId)) continue;
      if (a.kind === "set_status") {
        this.outbound.setRobotTrafficStatus(a.robotId, a.trafficStatus);
        continue;
      }
      if (a.kind === "grant") {
        const reqId =
          this.pendingRequestId.get(a.robotId) ??
          (a.grant.reason.includes("|") ? a.grant.reason.split("|")[0] : a.grant.reason);
        const reason = a.grant.reason.includes("|")
          ? a.grant.reason.slice(a.grant.reason.indexOf("|") + 1)
          : a.grant.reason;
        this.outbound.sendLeaseGrant(a.robotId, {
          request_id: reqId || `grant-${Date.now()}`,
          lease_id: a.grant.leaseId,
          signal:
            a.grant.signal === "PROCEED"
              ? "SIGNAL_PROCEED"
              : a.grant.signal === "PARTIAL"
                ? "SIGNAL_PARTIAL"
                : "SIGNAL_STOP",
          held: a.grant.held,
          lease_until_ms: a.grant.leaseDurationMs || LEASE_MS,
          zone_id: a.grant.zoneId,
          reason,
        });
        continue;
      }
      if (a.kind === "bid_request") {
        this.outbound.sendBidRequest?.(a.robotId, a.zoneId, a.windowMs);
        continue;
      }
      if (a.kind === "evasion_request") {
        this.outbound.sendEvasionRequest?.(a.robotId, {
          zone_id: a.zoneId,
          round_id: a.roundId,
          lease_id: a.leaseId,
          release_hint: a.releaseHint,
          mode: a.mode === "VACATE" ? "EVASION_VACATE" : "EVASION_REROUTE",
          breadcrumb_hint: a.breadcrumbHint,
          deadline_ms: a.deadlineMs,
        });
        continue;
      }
      if (a.kind === "zone_update") {
        this.outbound.sendZoneUpdate?.(a.robotId, a.zoneId, a.state);
      }
    }
  }

  private isOperational(robotId: string): boolean {
    const robot = this.hooks.getWorld().robots.find((r) => r.robotId === robotId);
    return !!robot && robot.connected && robot.fmsControlState !== "disabled" && robot.controlReady !== false && robot.poseObserved !== false;
  }

  private makeContext(): TrafficPolicyContext {
    return {
      canGrant: (robotId, wanted) => this.ledger.canGrant(robotId, wanted),
      partialGrant: (robotId, wanted) => this.ledger.partialGrant(robotId, wanted),
      commit: (robotId, leaseId, held, leaseUntilMs, zoneId) =>
        this.ledger.commit(robotId, leaseId, held, leaseUntilMs, zoneId),
      release: (robotId, leaseId, freed, retained) =>
        this.ledger.release(robotId, leaseId, freed, retained),
      getHeld: (robotId) => this.ledger.getHeld(robotId),
      clearRobot: (robotId) => this.ledger.clearRobot(robotId),
    };
  }
}

export function robotViewFromPose(
  robotId: string,
  pose: {
    x: number;
    y: number;
    theta: number;
    status: string;
    motion?: string;
    avoidanceMode?: boolean;
    headRoomPx?: number;
    trafficStatus?: string;
    path?: { x: number; y: number }[];
    localPath?: { x: number; y: number }[];
    planId?: string;
    connected?: boolean;
    fmsControlState?: "enabled" | "disabled";
    controlReady?: boolean;
    controlEpoch?: number;
    poseObserved?: boolean;
  },
): RobotTrafficView {
  return {
    robotId,
    x: pose.x,
    y: pose.y,
    theta: pose.theta,
    status: pose.status,
    motion: pose.motion ?? "",
    avoidanceMode: pose.avoidanceMode ?? true,
    headRoomPx: pose.headRoomPx ?? 0,
    trafficStatus: parseTrafficStatus(pose.trafficStatus),
    path: pose.path ?? [],
    localPath: pose.localPath,
    planId: pose.planId ?? "",
    connected: pose.connected ?? true,
    fmsControlState: pose.fmsControlState,
    controlReady: pose.controlReady,
    controlEpoch: pose.controlEpoch,
    poseObserved: pose.poseObserved,
  };
}
