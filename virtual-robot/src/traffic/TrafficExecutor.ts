/**
 * Robot-side traffic executor interface — policy-swappable.
 * Controller asks the executor whether a pose is allowed (I2).
 */

import type { Capsule, Corridor } from "../../../shared/corridor.ts";
import type { TrafficSignal, TrafficStatus } from "../../../shared/traffic/types.ts";

export type TrafficGrant = {
  requestId: string;
  leaseId: string;
  signal: TrafficSignal;
  held: Corridor;
  leaseDurationMs: number;
  zoneId: string;
  reason: string;
};

export type TrafficExecutorHooks = {
  sendLeaseRequest: (body: {
    request_id: string;
    lease_id: string;
    wanted: Corridor;
    gain_px: number;
    urgent: boolean;
  }) => void;
  sendLeaseRelease: (body: {
    lease_id: string;
    freed: Corridor;
    retained: Corridor;
  }) => void;
  sendTrafficBid?: (zoneId: string, seed: number) => void;
  sendEvasionReply?: (body: Record<string, unknown>) => void;
  /** Controller handles E2/E3 path changes (REROUTE / VACATE). */
  onEvasionPlan?: (payload: Record<string, unknown>) => void;
};

export type MotionSnapshot = {
  x: number;
  y: number;
  theta: number;
  path: { x: number; y: number }[];
  pathIndex: number;
  phase: string;
  avoidanceMode: boolean;
};

/**
 * Invariant: poseAllowed enforces I2 for whatever policy is active.
 * Policy-specific: when to request/release, how to build corridors.
 */
export interface TrafficExecutor {
  readonly policyId: string;
  trafficStatus(): TrafficStatus;
  leaseId(): string;
  held(): Corridor;
  headRoomPx(): number;
  /** I2 — may the robot occupy this pose? */
  poseAllowed(x: number, y: number, theta: number): boolean;
  onGrant(grant: TrafficGrant): void;
  onBidRequest?(zoneId: string, windowMs: number): void;
  onEvasionRequest?(payload: Record<string, unknown>): void;
  onZoneUpdate?(zoneId: string, state: string): void;
  onTick(snap: MotionSnapshot): void;
  clear(): void;
  beginEvadeMotion?(): void;
  markHold?(): void;
  latchFreeze?(x: number, y: number): void;
  onPeerLocalPlans?(peers: {
    robotId: string;
    x: number;
    y: number;
    theta: number;
    points: { x: number; y: number }[];
  }[]): void;
}

export function parseCapsuleList(raw: any): Capsule[] {
  const segs = Array.isArray(raw?.segments) ? raw.segments : Array.isArray(raw) ? raw : [];
  return segs.map((s: any) => ({
    x1: Number(s.x1) || 0,
    y1: Number(s.y1) || 0,
    x2: Number(s.x2) || 0,
    y2: Number(s.y2) || 0,
    r: Number(s.r) || 0,
  }));
}
