/**
 * Policy-agnostic traffic vocabulary shared by FMS, robot, and web UI.
 * Concrete policies (corridor lease, future zone mutex, …) map into these.
 */

import type { Capsule, Corridor } from "../corridor.ts";

/** Colyseus / UI traffic status shown on the robot. */
export type TrafficStatus =
  | "clear" // not under traffic control / free proceed
  | "proceed" // lease granted, moving under TC
  | "partial" // front of request only — approaching stop line
  | "hold" // waiting inside own lease for signal
  | "stop" // red — no grant, waiting
  | "evade" // computing / executing evasion
  | "lease_lost"; // lease expired / communication fail-safe

export const TRAFFIC_STATUSES: readonly TrafficStatus[] = [
  "clear",
  "proceed",
  "partial",
  "hold",
  "stop",
  "evade",
  "lease_lost",
] as const;

export function parseTrafficStatus(raw: unknown): TrafficStatus {
  const s = String(raw ?? "");
  return (TRAFFIC_STATUSES as readonly string[]).includes(s) ? (s as TrafficStatus) : "clear";
}

export type TrafficSignal = "STOP" | "PROCEED" | "PARTIAL";

export function parseTrafficSignal(raw: unknown): TrafficSignal {
  if (raw === 1 || raw === "1") return "PROCEED";
  if (raw === 2 || raw === "2") return "PARTIAL";
  if (raw === 0 || raw === "0") return "STOP";
  const s = String(raw ?? "").toUpperCase();
  if (s === "PROCEED" || s === "SIGNAL_PROCEED") return "PROCEED";
  if (s === "PARTIAL" || s === "SIGNAL_PARTIAL") return "PARTIAL";
  return "STOP";
}

export type LeaseId = string;
export type ZoneId = string;

export type LeaseSnapshot = {
  leaseId: LeaseId;
  signal: TrafficSignal;
  held: Corridor;
  /** Remaining lease duration in ms (robot clocks from receive time). */
  leaseDurationMs: number;
  zoneId: ZoneId;
  reason: string;
};

export type LeaseRequestBody = {
  requestId: string;
  leaseId: LeaseId;
  wanted: Corridor;
  gainPx: number;
  urgent: boolean;
};

export type LeaseReleaseBody = {
  leaseId: LeaseId;
  freed: Corridor;
  retained: Corridor;
};

export type EvasionMode = "REROUTE" | "VACATE";

export type TrafficPlanAction =
  | { kind: "grant"; robotId: string; grant: LeaseSnapshot }
  | { kind: "bid_request"; robotId: string; zoneId: ZoneId; windowMs: number }
  | {
      kind: "evasion_request";
      robotId: string;
      zoneId: ZoneId;
      roundId: string;
      leaseId: LeaseId;
      releaseHint: Corridor;
      mode: EvasionMode;
      breadcrumbHint: string[];
      deadlineMs: number;
    }
  | { kind: "zone_update"; robotId: string; zoneId: ZoneId; state: string }
  | { kind: "set_status"; robotId: string; trafficStatus: TrafficStatus };

/** Opaque policy id so FMS can swap implementations later. */
export type TrafficPolicyId = "corridor_lease_v0" | "local_plan_v1";

export function parseTrafficPolicyId(raw: unknown): TrafficPolicyId {
  const s = String(raw ?? "");
  if (s === "corridor_lease_v0" || s === "local_plan_v1") return s;
  return "local_plan_v1";
}

export type LocalPlanPoint = { x: number; y: number };

export type PeerLocalPlan = {
  robotId: string;
  x: number;
  y: number;
  theta: number;
  points: LocalPlanPoint[];
};

export type CapsuleWire = Capsule;
export type CorridorWire = Corridor;
