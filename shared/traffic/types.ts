/**
 * Policy-agnostic traffic vocabulary shared by FMS, robot, and web UI.
 * Concrete policies (corridor lease, future zone mutex, …) map into these.
 */

import type { Capsule, Corridor } from "../corridor.ts";
import {
  EvasionModes,
  TrafficPlanActionKinds,
  TrafficPolicyIds,
  TrafficSignals,
  TrafficSignalWireNumbers,
  TrafficSignalWireNames,
  TrafficStatuses,
  type ZoneUpdateState,
  type EvasionMode as CatalogEvasionMode,
  type TrafficPolicyId as CatalogTrafficPolicyId,
  type TrafficSignal as CatalogTrafficSignal,
  type TrafficStatus as CatalogTrafficStatus,
  type TrafficStopDecision as CatalogTrafficStopDecision,
} from "../config/index.ts";

/** Colyseus / UI traffic status shown on the robot. */
export type TrafficStatus = CatalogTrafficStatus;

export const TRAFFIC_STATUSES: readonly TrafficStatus[] = TrafficStatuses.values;

export function parseTrafficStatus(raw: unknown): TrafficStatus {
  const s = String(raw ?? "");
  return TrafficStatuses.is(s) ? s : "clear";
}

export type TrafficSignal = CatalogTrafficSignal;

export function parseTrafficSignal(raw: unknown): TrafficSignal {
  if (raw === TrafficSignalWireNumbers.code.SIGNAL_PROCEED || raw === String(TrafficSignalWireNumbers.code.SIGNAL_PROCEED)) return "PROCEED";
  if (raw === TrafficSignalWireNumbers.code.SIGNAL_PARTIAL || raw === String(TrafficSignalWireNumbers.code.SIGNAL_PARTIAL)) return "PARTIAL";
  if (raw === TrafficSignalWireNumbers.code.SIGNAL_STOP || raw === String(TrafficSignalWireNumbers.code.SIGNAL_STOP)) return "STOP";
  const s = String(raw ?? "").toUpperCase();
  if (TrafficSignals.is(s)) return s;
  if (s === "PROCEED" || s === TrafficSignalWireNames.code.SIGNAL_PROCEED) return "PROCEED";
  if (s === "PARTIAL" || s === TrafficSignalWireNames.code.SIGNAL_PARTIAL) return "PARTIAL";
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
  /** Identity of the STOP decision this grant acknowledges, when present. */
  stopId?: string;
  stopGeneration?: number;
};

export type TrafficStopDecision = CatalogTrafficStopDecision;
export type TrafficStopCheck = {
  robotId: string;
  stopId: string;
  stopGeneration: number;
  controlEpoch: number;
  sessionId: string;
};
export type TrafficStopStatus = TrafficStopCheck & {
  decision: TrafficStopDecision;
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

export type EvasionMode = CatalogEvasionMode;

export type TrafficPlanAction =
  | { kind: typeof TrafficPlanActionKinds.code.grant; robotId: string; grant: LeaseSnapshot }
  | { kind: typeof TrafficPlanActionKinds.code.bid_request; robotId: string; zoneId: ZoneId; windowMs: number }
  | {
      kind: typeof TrafficPlanActionKinds.code.evasion_request;
      robotId: string;
      zoneId: ZoneId;
      roundId: string;
      leaseId: LeaseId;
      releaseHint: Corridor;
      mode: EvasionMode;
      breadcrumbHint: string[];
      deadlineMs: number;
    }
  | { kind: typeof TrafficPlanActionKinds.code.zone_update; robotId: string; zoneId: ZoneId; state: ZoneUpdateState }
  | { kind: typeof TrafficPlanActionKinds.code.set_status; robotId: string; trafficStatus: TrafficStatus };

/** Opaque policy id so FMS can swap implementations later. */
export type TrafficPolicyId = CatalogTrafficPolicyId;

export function parseTrafficPolicyId(raw: unknown): TrafficPolicyId {
  const s = String(raw ?? "");
  if (TrafficPolicyIds.is(s)) return s;
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
