/**
 * Policy-agnostic traffic control interfaces.
 *
 * Invariant layer (LeaseLedger, corridor geometry) never imports occupancy/maps.
 * Policy layer decides grants / escalations; executor on the robot enforces I2.
 */

import type { Corridor } from "../../../shared/corridor.ts";
import type {
  LeaseRequestBody,
  LeaseSnapshot,
  TrafficPlanAction,
  TrafficPolicyId,
  TrafficStatus,
  ZoneId,
} from "../../../shared/traffic/types.ts";
import type { ZoneResource } from "../../../shared/semantic.ts";

export type RobotTrafficView = {
  robotId: string;
  x: number;
  y: number;
  theta: number;
  status: string;
  motion: string;
  avoidanceMode: boolean;
  headRoomPx: number;
  trafficStatus: TrafficStatus;
  path: { x: number; y: number }[];
  localPath?: { x: number; y: number }[];
  planId: string;
  connected: boolean;
  fmsControlState?: "enabled" | "disabled";
  controlReady?: boolean;
  controlEpoch?: number;
  poseObserved?: boolean;
};

export type TrafficWorldSnapshot = {
  nowMs: number;
  robots: RobotTrafficView[];
  zones?: ZoneResource[];
};

export type TrafficPolicyContext = {
  /** True if `wanted` is disjoint from every other robot's held corridor. */
  canGrant(robotId: string, wanted: Corridor): boolean;
  /** Prefix of `wanted` that is still safe (may be empty). */
  partialGrant(robotId: string, wanted: Corridor): Corridor;
  /** Commit held corridor for robot (must pass disjoint check). */
  commit(robotId: string, leaseId: string, held: Corridor, leaseUntilMs: number, zoneId: ZoneId): boolean;
  /** Drop freed segments; returns false on desync. */
  release(robotId: string, leaseId: string, freed: Corridor, retained: Corridor): boolean;
  getHeld(robotId: string): Corridor | null;
  clearRobot(robotId: string): void;
};

/**
 * Pure planning interface — swappable without touching gRPC / Colyseus wiring.
 * Implementations live under `policies/`.
 */
export interface TrafficPolicy {
  readonly id: TrafficPolicyId;
  onRobotConnected(robotId: string): void;
  onRobotDisconnected(robotId: string): void;
  onLeaseRequest(robotId: string, req: LeaseRequestBody, world: TrafficWorldSnapshot): TrafficPlanAction[];
  onLeaseRelease(robotId: string, leaseId: string, freed: Corridor, retained: Corridor): TrafficPlanAction[];
  onBid(robotId: string, zoneId: ZoneId, seed: number): TrafficPlanAction[];
  onEvasionReply(robotId: string, payload: Record<string, unknown>): TrafficPlanAction[];
  /** Periodic tick — renew leases, zone lifecycle, deadlock watch. */
  tick(world: TrafficWorldSnapshot): TrafficPlanAction[];
}

export type { LeaseSnapshot, TrafficPlanAction };
