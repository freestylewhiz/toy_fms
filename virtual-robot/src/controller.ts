import {
  ANGULAR_SPEED_RAD_S,
  AVOIDANCE_MODE_DEFAULT,
  BREADCRUMB_MAX,
  BREADCRUMB_SPACING_PX,
  HEADING_TOLERANCE_RAD,
  LINEAR_SPEED_PX_S,
  LOOKAHEAD_S,
  PEER_OBSTACLE_RADIUS_PX,
  PLAN_INFLATE_PX,
  SIM_PEER_MOVE_REPLAN_PX,
  SIM_PEER_REPLAN_IMPROVE_PX,
  SIM_PEER_REPLAN_IMPROVE_RATIO,
  SIM_PEER_REPLAN_MIN_MS,
  SIM_PEER_SENSING_DEFAULT,
  SIM_PEER_STATIONARY_MS,
  TICK_MS,
  TRAFFIC_POLICY_ID,
  TRAFFIC_SEP_PX,
} from "../../shared/constants.ts";
import { setExtraBlocked } from "../../shared/occupancy.ts";
import {
  poseHitsAny,
  poseHitsObstacle,
  rasterizeObstacles,
  type DynObstacle,
} from "../../shared/obstacles.ts";
import { planRoute, poseFeasible, setSemanticSnapshot, type Point } from "../../shared/planner.ts";
import type { SemanticSnapshot } from "../../shared/semantic.ts";
import { isSemanticPoseBlocked, speedLimitAt, zoneTouchesPoint } from "../../shared/semanticNavigation.ts";
import {
  distToPlan,
  reverseAlongTrail,
  sampleLocalPlan,
} from "../../shared/traffic/localPlan.ts";
import { parseTrafficPolicyId } from "../../shared/traffic/types.ts";
import { isTerminalCommandState, type CommandState } from "../../shared/robotProtocol.ts";
import type { TrafficExecutor, TrafficGrant, MotionSnapshot } from "./traffic/TrafficExecutor.ts";

export type DriveCmd = {
  command_id: string;
  kind: string;
  x: number;
  y: number;
  theta: number;
};

export type PoseSnapshot = {
  x: number;
  y: number;
  theta: number;
  status: "idle" | "move";
  motion: string;
  leaseId: string;
  avoidanceMode: boolean;
  headRoomPx: number;
  trafficStatus: string;
  commandId: string;
  commandState: string;
  commandReason: string;
  workState?: string;
  driveState?: string;
  driveContextJson?: string;
  reportedAt?: number;
  navigationMode?: string;
  pathPlanningAuthority?: string;
};

type Phase = "idle" | "follow" | "rotate" | "hold" | "lease_lost" | "reverse";

const GOAL_REACH_PX = 0.5;

function wrapAngle(a: number): number {
  let t = a;
  while (t > Math.PI) t -= Math.PI * 2;
  while (t < -Math.PI) t += Math.PI * 2;
  return t;
}

function shortestDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

function steer(current: number, desired: number, maxStep: number): number {
  const delta = shortestDelta(current, desired);
  if (Math.abs(delta) <= maxStep) return wrapAngle(desired);
  return wrapAngle(current + Math.sign(delta) * maxStep);
}

export class RobotController {
  private x: number;
  private y: number;
  private theta: number;
  private status: "idle" | "move" = "idle";
  private phase: Phase = "idle";
  private path: Point[] = [];
  private pathIndex = 0;
  private displayPath: Point[] = [];
  private pathDirty = false;
  private goalTheta = 0;
  private goal: DriveCmd | null = null;
  private obstacles: DynObstacle[] = [];
  private uiObstacles: DynObstacle[] = [];
  /** Active peer occupancy used for collision / block checks. */
  private peerObstacles: DynObstacle[] = [];
  private peerBodyObstacles: DynObstacle[] = [];
  private peerPlanObstacles: DynObstacle[] = [];
  /** Temporary blocks from EvasionRequest.release_hint (winner corridor). */
  private evasionHintObstacles: DynObstacle[] = [];
  private lastPeerReplanMs = 0;
  /** Last seen peer pose + last time that peer translated (for parked detection). */
  private peerMotion = new Map<string, { x: number; y: number; lastMoveMs: number }>();
  private evasionResumeGoal: DriveCmd | null = null;
  private sendEvasionReply: ((body: Record<string, unknown>) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private traffic: TrafficExecutor | null = null;
  private avoidanceMode = AVOIDANCE_MODE_DEFAULT;
  private trail: Point[] = [];
  private reversing = false;
  private policyId = parseTrafficPolicyId(TRAFFIC_POLICY_ID);
  private connectionReady = true;
  private controlEnabled = true;
  private controlEpoch = 0;
  private sessionId = "";
  private contextSince = Date.now();
  private contextKey = "idle";
  private lastMotionAt = 0;
  private awaitingSnapshot = false;
  private semanticGates = new Map<string, { allow: boolean; updatedAt: number }>();
  private semanticZones: SemanticSnapshot["zones"] = [];
  private sessionReady = true;
  private snapshotReady = false;
  private commandState: CommandState = "idle";
  private lastCommandId = "";
  private commandReason = "";
  private sendCommandState: ((state: { command_id: string; state: CommandState; reason: string }) => void) | null = null;

  constructor(initial: { x: number; y: number; theta: number }) {
    this.x = initial.x;
    this.y = initial.y;
    this.theta = wrapAngle(initial.theta);
    this.trail = [{ x: this.x, y: this.y }];
  }

  attachTraffic(executor: TrafficExecutor): void {
    this.traffic = executor;
  }

  setConnectionReady(ready: boolean): void {
    this.sessionReady = ready;
    if (!ready) {
      this.awaitingSnapshot = true;
      this.semanticGates.clear();
    }
    this.connectionReady = ready && this.controlEnabled && this.snapshotReady && !this.awaitingSnapshot;
    if (!ready && this.phase !== "idle") {
      this.phase = "hold";
      this.status = "move";
      this.traffic?.clear();
    }
  }

  /** Apply the server owned operating control state. Disabled robots retain telemetry but cannot execute traffic. */
  setControlState(state: { enabled: boolean; controlEpoch: number; sessionId: string }): void {
    const wasEnabled = this.controlEnabled;
    const boundary = this.sessionId !== state.sessionId || this.controlEpoch !== state.controlEpoch;
    if (boundary && (this.goal || this.phase !== "idle")) {
      if (this.goal) this.publishCommand("cancelled", "control generation changed");
      this.goal = null;
      this.evasionResumeGoal = null;
      this.reversing = false;
      this.clearMotion();
      this.traffic?.clear();
    }
    this.controlEnabled = state.enabled;
    this.controlEpoch = state.controlEpoch;
    this.sessionId = state.sessionId;
    if (!state.enabled) {
      if (this.goal) this.publishCommand("cancelled", "fms control disabled");
      this.goal = null;
      this.evasionResumeGoal = null;
      this.reversing = false;
      this.clearMotion();
      this.traffic?.clear();
      this.connectionReady = false;
      return;
    }
    // Activation is a clean boundary: reconnect/enable never replays an old mission.
    if (!wasEnabled) this.connectionReady = this.sessionReady && this.snapshotReady && !this.awaitingSnapshot;
  }

  setCommandStateSender(fn: (state: { command_id: string; state: CommandState; reason: string }) => void): void { this.sendCommandState = fn; }

  private publishCommand(state: CommandState, reason = ""): void {
    this.commandState = state;
    this.commandReason = reason;
    const id = this.goal?.command_id === "vacate" ? (this.evasionResumeGoal?.command_id ?? this.lastCommandId) : (this.goal?.command_id ?? this.lastCommandId);
    if (id) this.sendCommandState?.({ command_id: id, state, reason });
  }

  setEvasionReplySender(fn: (body: Record<string, unknown>) => void): void {
    this.sendEvasionReply = fn;
  }

  getTraffic(): TrafficExecutor | null {
    return this.traffic;
  }

  onTrafficGrant(grant: TrafficGrant): void {
    this.traffic?.onGrant(grant);
  }

  onTrafficBidRequest(zoneId: string, windowMs: number): void {
    this.traffic?.onBidRequest?.(zoneId, windowMs);
  }

  onTrafficEvasionRequest(payload: Record<string, unknown>): void {
    this.traffic?.onEvasionRequest?.(payload);
  }

  onTrafficZoneUpdate(zoneId: string, state: string): void {
    if (zoneId.startsWith("semantic:")) {
      const allow = ["proceed", "resume", "clear", "open"].includes(state.toLowerCase());
      this.semanticGates.set(zoneId, { allow, updatedAt: Date.now() });
      if (!allow && this.phase !== "idle" && this.semanticGateRelevant(zoneId)) {
        this.phase = "hold";
        this.status = "move";
      }
      return;
    }
    this.traffic?.onZoneUpdate?.(zoneId, state);
    const s = state.toLowerCase();
    if (s === "resume" || s === "peer_cleared" || s === "peer_action_done") {
      // FMS told us the zone peer finished — leave HOLD if we were waiting.
      if (this.phase === "hold" || this.phase === "lease_lost") {
        this.phase = "follow";
        this.status = "move";
      }
    }
  }

  /**
   * E2 REROUTE / E3 VACATE — called from CorridorLeaseExecutor via hooks.
   * FMS asked us to leave the conflict; we replan around peers + release_hint.
   */
  handleEvasionPlan(payload: Record<string, unknown>): void {
    const modeRaw = String(payload.mode ?? "REROUTE").toUpperCase();
    const mode = modeRaw.includes("VACATE") ? "VACATE" : "REROUTE";
    const zoneId = String(payload.zone_id ?? "");
    const roundId = String(payload.round_id ?? "");
    this.evasionHintObstacles = corridorToHintObstacles(payload.release_hint ?? payload.releaseHint);
    this.applyMergedObstacles(false);
    this.traffic?.clear();
    this.traffic?.beginEvadeMotion?.();

    let ok = false;
    let result = "NONE";
    if (mode === "VACATE") {
      ok = this.planVacate();
      result = ok ? "VACATE" : "NONE";
    } else {
      ok = this.planReroute();
      result = ok ? "REROUTE" : "NONE";
    }

    console.log(`[controller] evasion ${mode} → ${result}`);
    this.sendEvasionReply?.({
      zone_id: zoneId,
      round_id: roundId,
      result,
      reason: ok ? "ok" : "no path",
    });

    if (!ok) {
      this.phase = "hold";
      this.evasionHintObstacles = [];
      this.applyMergedObstacles(false);
    }
  }

  private planReroute(): boolean {
    if (!this.goal) return false;
    const planned = planRoute({ x: this.x, y: this.y }, { x: this.goal.x, y: this.goal.y });
    if (!planned || planned.follow.length === 0) return false;
    this.commitPlan(planned.follow, planned.display, this.goal.theta, "e2-reroute");
    this.phase = "follow";
    this.status = "move";
    this.traffic?.beginEvadeMotion?.();
    return true;
  }

  private planVacate(): boolean {
    return this.startReverseAlongTrail("e3-vacate");
  }

  private startReverseAlongTrail(reason: string): boolean {
    if (!this.goal) return false;
    const back = reverseAlongTrail(this.trail, { x: this.x, y: this.y }, 72);
    if (back.length < 2) {
      console.log(`[controller] reverse failed (${reason}) trail=${this.trail.length}`);
      return false;
    }
    this.evasionResumeGoal = this.evasionResumeGoal ?? { ...this.goal };
    this.reversing = true;
    this.applyMergedObstacles(false);
    const last = back[back.length - 1];
    this.goal = { command_id: "vacate", kind: "move", x: last.x, y: last.y, theta: this.theta };
    this.commitPlan(back, back, this.theta, reason);
    this.phase = "reverse";
    this.status = "move";
    this.traffic?.beginEvadeMotion?.();
    return true;
  }

  private finishReverse(): void {
    this.reversing = false;
    this.phase = "hold";
    const g = this.evasionResumeGoal;
    this.evasionResumeGoal = null;
    this.evasionHintObstacles = [];
    this.applyMergedObstacles(false);
    if (g) {
      this.goal = g;
      this.applyPlan(g.x, g.y, g.theta);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  snapshot(): PoseSnapshot {
    const t = this.traffic;
    return {
      x: this.x,
      y: this.y,
      theta: this.theta,
      status: this.status,
      motion: this.phase.toUpperCase(),
      leaseId: t?.leaseId() ?? "",
      avoidanceMode: this.avoidanceMode,
      headRoomPx: t ? t.headRoomPx() : Number.POSITIVE_INFINITY,
      trafficStatus: !this.connectionReady || this.semanticGatesBlocked() ? "hold" : t?.trafficStatus() ?? "clear",
      commandId: this.lastCommandId,
      commandState: this.commandState,
      commandReason: this.commandReason,
      workState: this.goal ? "busy" : "idle",
      driveState: this.observedDriveState(),
      driveContextJson: JSON.stringify(this.driveContext()),
      reportedAt: Date.now(),
      navigationMode: "free_navigation",
      pathPlanningAuthority: "robot",
    };
  }

  private driveContext(): unknown[] {
    if (this.phase === "idle") return [];
    const blockedGate = this.semanticZones.find((zone) => {
      if (zone.kind !== "corridor" && zone.kind !== "complex" && zone.kind !== "release") return false;
      const gate = this.semanticGates.get(`semantic:${zone.id}`);
      return this.semanticGateRelevant(`semantic:${zone.id}`) && (!gate || !gate.allow || Date.now() - gate.updatedAt > 1000);
    });
    const trafficState = this.traffic?.trafficStatus();
    let reason: string | null = null;
    let target: Record<string, string> | undefined;
    let permissionState: string | undefined;
    if (!this.connectionReady || !this.controlEnabled || this.phase === "lease_lost") reason = "control_unavailable";
    else if (isSemanticPoseBlocked(this.semanticZones, { x: this.x, y: this.y }) || this.pathBlockedByPeers()) reason = "obstacle_detected";
    else if (blockedGate) {
      reason = "permission_pending";
      target = { mapId: "yard", kind: "zone", id: blockedGate.id };
      permissionState = "pending";
    } else if (trafficState === "stop" || trafficState === "hold" || trafficState === "partial") reason = "traffic_yield";
    else if (this.phase === "hold") reason = "permission_pending";
    if (!reason) { this.contextKey = "idle"; return []; }
    const key = `${reason}:${target?.id ?? ""}:${this.lastCommandId}`;
    if (key !== this.contextKey) { this.contextKey = key; this.contextSince = Date.now(); }
    return [{ reasonCode: reason, source: "robot", target, permissionState, requestId: this.lastCommandId || undefined, since: this.contextSince }];
  }

  private observedDriveState(): string {
    if (this.phase === "idle") return "stationary";
    if (Date.now() - this.lastMotionAt <= TICK_MS * 2) return "moving";
    if (this.phase === "hold" && (isSemanticPoseBlocked(this.semanticZones, { x: this.x, y: this.y }) || this.pathBlockedByPeers())) return "blocked";
    if (this.phase === "hold" || this.phase === "lease_lost") return "waiting";
    return "stationary";
  }

  takePathDelta(): Point[] | null {
    if (!this.pathDirty) return null;
    this.pathDirty = false;
    return this.displayPath.slice();
  }

  currentPath(): Point[] {
    return this.displayPath.slice();
  }

  currentLocalPlan(): Point[] {
    return sampleLocalPlan(this.path, this.pathIndex, { x: this.x, y: this.y });
  }

  /**
   * v1: FMS-synced peer pose + ~5s local plans → predicted occupancy.
   */
  setPeerLocalPlans(
    peers: { robotId: string; x: number; y: number; theta: number; points: Point[] }[],
  ): void {
    if (this.policyId !== "local_plan_v1") return;
    const bodies: DynObstacle[] = [];
    const plans: DynObstacle[] = [];
    for (const p of peers) {
      bodies.push({
        id: `peer:${p.robotId}`,
        kind: "circle",
        x: p.x,
        y: p.y,
        size: PEER_OBSTACLE_RADIUS_PX,
        theta: p.theta,
      });
      const pts = p.points.length ? p.points : [{ x: p.x, y: p.y }];
      for (let i = 0; i < pts.length; i += 2) {
        plans.push({
          id: `peerplan:${p.robotId}:${i}`,
          kind: "circle",
          x: pts[i].x,
          y: pts[i].y,
          size: PEER_OBSTACLE_RADIUS_PX,
          theta: 0,
        });
      }
    }
    this.peerBodyObstacles = bodies;
    this.peerPlanObstacles = plans;
    this.applyMergedObstacles(false);
    this.traffic?.onPeerLocalPlans?.(peers);

    if (!this.goal || this.phase === "idle") return;
    if (this.reversing) {
      const peerPlans = peers.flatMap((p) => (p.points.length ? p.points : [{ x: p.x, y: p.y }]));
      if (peerPlans.length && distToPlan({ x: this.x, y: this.y }, peerPlans) >= TRAFFIC_SEP_PX + 8) {
        this.finishReverse();
      }
      return;
    }
    if (this.traffic?.trafficStatus() === "stop") return;
    if (this.pathBlockedByPeers()) {
      const now = Date.now();
      if (now - this.lastPeerReplanMs < 800) return;
      this.lastPeerReplanMs = now;
      const planned = planRoute({ x: this.x, y: this.y }, { x: this.goal.x, y: this.goal.y });
      if (planned?.follow.length) {
        this.commitPlan(planned.follow, planned.display, this.goal.theta, "v1-detour");
        this.phase = "follow";
      } else {
        this.startReverseAlongTrail("blocked-no-detour");
      }
      return;
    }
    // Peer moved off our snapped short path — retry the real goal.
    if (!this.missionReached()) this.retryTrueGoal("v1-goal-retry");
  }

  setObstacles(items: DynObstacle[]): void {
    this.uiObstacles = items;
    this.applyMergedObstacles(true);
  }

  /** Apply a server-pushed map policy and resource snapshot atomically. */
  setSemanticSnapshot(snapshot: Pick<SemanticSnapshot, "zones" | "obstacles">): void {
    setSemanticSnapshot(snapshot);
    this.semanticZones = snapshot.zones;
    this.awaitingSnapshot = false;
    this.snapshotReady = true;
    if (isSemanticPoseBlocked(this.semanticZones, { x: this.x, y: this.y }) && this.phase !== "idle") {
      this.phase = "hold";
      this.status = "move";
    }
    // A reconnect must receive a fresh authoritative map before motion resumes.
    this.connectionReady = this.sessionReady && !this.awaitingSnapshot;
    this.uiObstacles = snapshot.obstacles.map((o) => ({
      id: o.id,
      kind: o.kind,
      x: o.x,
      y: o.y,
      size: o.size,
      theta: o.theta,
    }));
    this.applyMergedObstacles(Boolean(this.goal && this.phase !== "idle"));
    if (isSemanticPoseBlocked(this.semanticZones, { x: this.x, y: this.y }) && this.phase !== "idle") {
      this.phase = "hold";
      this.status = "move";
    }
  }

  /**
   * SIM_PEER_SENSING: FMS-forwarded peer poses → local circle obstacles.
   *
   * Path replan rules (avoid re-entering traffic deadlock):
   * - Always refresh occupancy.
   * - Never optimize while traffic signal is STOP (FMS is arbitrating).
   * - Force/optimize only when peers have left, or all peers look parked.
   * - Moving peers → hold if blocked; do not A*-fight the crossing.
   */
  setSensedPeers(peers: { robotId: string; x: number; y: number; theta: number }[]): void {
    if (this.policyId === "local_plan_v1") return;
    if (!SIM_PEER_SENSING_DEFAULT) {
      if (this.peerObstacles.length || this.peerBodyObstacles.length) {
        this.peerObstacles = [];
        this.peerBodyObstacles = [];
        this.peerPlanObstacles = [];
        this.peerMotion.clear();
        this.applyMergedObstacles(false);
        if (this.canOptimizeAgainstPeers()) this.maybeOptimizePath(true);
      }
      return;
    }
    const now = Date.now();
    const next = peers.map((p) => ({
      id: `peer:${p.robotId}`,
      kind: "circle" as const,
      x: p.x,
      y: p.y,
      size: PEER_OBSTACLE_RADIUS_PX,
      theta: p.theta,
    }));
    this.notePeerMotion(next, now);
    const hadPeers = this.peerBodyObstacles.length > 0;
    const peersLeft = hadPeers && next.length === 0;
    this.peerBodyObstacles = next;
    this.peerPlanObstacles = [];
    this.applyMergedObstacles(false);

    if (!this.goal || this.phase === "idle") return;

    const tc = this.traffic?.trafficStatus();
    // FMS STOP: occupancy only — never change path mid-arbitration.
    if (tc === "stop") return;

    const blocked = this.pathBlockedByPeers();
    const parked = this.peersLookParked(now);

    if (peersLeft) {
      this.maybeOptimizePath(true);
      return;
    }

    // partial/hold/lease_lost: let traffic finish; don't A*-detour into a new conflict.
    if (tc === "partial" || tc === "hold" || tc === "lease_lost") {
      if (blocked) this.phase = "hold";
      return;
    }

    if (blocked) {
      if (parked) this.maybeOptimizePath(true);
      else this.phase = "hold"; // moving peer — wait
      return;
    }
    if (parked) this.maybeOptimizePath(false);
  }

  private canOptimizeAgainstPeers(): boolean {
    const tc = this.traffic?.trafficStatus();
    // Active FMS arbitration — changing path re-requests corridors and deadlocks again.
    if (tc === "stop" || tc === "partial" || tc === "hold" || tc === "lease_lost") return false;
    return true;
  }

  private notePeerMotion(next: DynObstacle[], now: number): void {
    const seen = new Set<string>();
    for (const p of next) {
      seen.add(p.id);
      const prev = this.peerMotion.get(p.id);
      if (!prev) {
        this.peerMotion.set(p.id, { x: p.x, y: p.y, lastMoveMs: now });
        continue;
      }
      if (Math.hypot(p.x - prev.x, p.y - prev.y) > SIM_PEER_MOVE_REPLAN_PX) {
        this.peerMotion.set(p.id, { x: p.x, y: p.y, lastMoveMs: now });
      } else {
        this.peerMotion.set(p.id, { ...prev, x: p.x, y: p.y });
      }
    }
    for (const id of [...this.peerMotion.keys()]) {
      if (!seen.has(id)) this.peerMotion.delete(id);
    }
  }

  private peersLookParked(now: number): boolean {
    if (!this.peerObstacles.length) return true;
    for (const p of this.peerObstacles) {
      const m = this.peerMotion.get(p.id);
      if (!m) return false;
      if (now - m.lastMoveMs < SIM_PEER_STATIONARY_MS) return false;
    }
    return true;
  }

  private pathBlockedByPeers(): boolean {
    if (!this.peerObstacles.length || this.path.length === 0) return false;
    if (poseHitsAny(this.x, this.y, this.theta, this.peerObstacles)) return true;
    const horizon = Math.min(this.path.length, this.pathIndex + 12);
    let px = this.x;
    let py = this.y;
    for (let i = this.pathIndex; i < horizon; i++) {
      const t = this.path[i];
      const heading = Math.atan2(t.y - py, t.x - px);
      if (poseHitsAny(t.x, t.y, heading, this.peerObstacles)) return true;
      px = t.x;
      py = t.y;
    }
    return false;
  }

  private missionReached(): boolean {
    if (!this.goal) return true;
    return Math.hypot(this.x - this.goal.x, this.y - this.goal.y) < GOAL_REACH_PX;
  }

  /** If A* snapped short of the real goal (peer on the cell), wait or retry. */
  private retryTrueGoal(reason: string): void {
    if (!this.goal || this.reversing || this.missionReached()) return;
    const now = Date.now();
    if (now - this.lastPeerReplanMs < 800) {
      this.phase = "hold";
      this.status = "move";
      return;
    }
    this.lastPeerReplanMs = now;
    const planned = planRoute({ x: this.x, y: this.y }, { x: this.goal.x, y: this.goal.y });
    if (!planned?.follow.length) {
      this.phase = "hold";
      this.status = "move";
      return;
    }
    const end = planned.follow[planned.follow.length - 1];
    const newMiss = Math.hypot(end.x - this.goal.x, end.y - this.goal.y);
    const curEnd = this.path[this.path.length - 1];
    const curMiss = curEnd
      ? Math.hypot(curEnd.x - this.goal.x, curEnd.y - this.goal.y)
      : Number.POSITIVE_INFINITY;
    if (newMiss >= GOAL_REACH_PX && newMiss >= curMiss - 1) {
      this.phase = "hold";
      this.status = "move";
      return;
    }
    this.commitPlan(planned.follow, planned.display, this.goal.theta, reason);
  }

  private remainingPathLength(): number {
    let len = 0;
    let px = this.x;
    let py = this.y;
    for (let i = this.pathIndex; i < this.path.length; i++) {
      const t = this.path[i];
      len += Math.hypot(t.x - px, t.y - py);
      px = t.x;
      py = t.y;
    }
    return len;
  }

  private routeLengthFromHere(follow: Point[]): number {
    if (!follow.length) return Infinity;
    let len = Math.hypot(follow[0].x - this.x, follow[0].y - this.y);
    for (let i = 1; i < follow.length; i++) {
      len += Math.hypot(follow[i].x - follow[i - 1].x, follow[i].y - follow[i - 1].y);
    }
    return len;
  }

  /**
   * Try A* against current occupancy (incl. peers). Commit only if forced
   * (parked block / peers gone) or the candidate is clearly shorter.
   */
  private maybeOptimizePath(force: boolean): void {
    if (!this.goal) return;
    if (!this.canOptimizeAgainstPeers() && !force) return;
    // Even force must not run under FMS STOP — wait for signal.
    if (this.traffic?.trafficStatus() === "stop") return;

    const now = Date.now();
    const minGap = force ? Math.min(400, SIM_PEER_REPLAN_MIN_MS) : SIM_PEER_REPLAN_MIN_MS;
    if (now - this.lastPeerReplanMs < minGap) return;

    const planned = planRoute({ x: this.x, y: this.y }, { x: this.goal.x, y: this.goal.y });
    if (!planned || planned.follow.length === 0) {
      if (force) {
        this.lastPeerReplanMs = now;
        this.phase = "hold";
      }
      return;
    }

    const newLen = this.routeLengthFromHere(planned.follow);
    const curLen = this.remainingPathLength();
    const improve = curLen - newLen;
    const worth =
      force ||
      curLen <= 1e-3 ||
      improve >= SIM_PEER_REPLAN_IMPROVE_PX ||
      improve >= curLen * SIM_PEER_REPLAN_IMPROVE_RATIO;

    if (!worth) return;

    this.lastPeerReplanMs = now;
    // New geometry needs a fresh lease — drop old corridor so we don't follow
    // outside held and thrash hold/follow.
    this.traffic?.clear();
    this.commitPlan(planned.follow, planned.display, this.goal.theta, force ? "peer-force" : "peer-opt");
  }

  private applyMergedObstacles(replan: boolean): void {
    this.peerObstacles = this.reversing
      ? this.peerBodyObstacles
      : [...this.peerBodyObstacles, ...this.peerPlanObstacles];
    this.obstacles = [...this.uiObstacles, ...this.peerObstacles, ...this.evasionHintObstacles];
    setExtraBlocked(this.obstacles.length ? rasterizeObstacles(this.obstacles) : null);
    if (replan && this.goal && this.phase !== "idle") this.replan();
  }

  canPlace(candidate: DynObstacle): { ok: boolean; reason: string } {
    if (poseHitsObstacle(this.x, this.y, this.theta, candidate, PLAN_INFLATE_PX)) {
      return { ok: false, reason: "current" };
    }
    if (this.phase === "idle" || this.path.length === 0) return { ok: true, reason: "" };
    const horizon = LINEAR_SPEED_PX_S * LOOKAHEAD_S;
    let traveled = 0;
    let px = this.x;
    let py = this.y;
    for (let i = this.pathIndex; i < this.path.length; i++) {
      const t = this.path[i];
      const d = Math.hypot(t.x - px, t.y - py);
      const steps = Math.max(1, Math.ceil(d / 4));
      const heading = d < 1e-6 ? this.theta : Math.atan2(t.y - py, t.x - px);
      for (let s = 1; s <= steps; s++) {
        const u = s / steps;
        const x = px + (t.x - px) * u;
        const y = py + (t.y - py) * u;
        if (poseHitsObstacle(x, y, heading, candidate, PLAN_INFLATE_PX)) {
          return { ok: false, reason: "lookahead" };
        }
        traveled += d / steps;
        if (traveled >= horizon) return { ok: true, reason: "" };
      }
      px = t.x;
      py = t.y;
    }
    return { ok: true, reason: "" };
  }

  handleDrive(cmd: DriveCmd): void {
    if (!this.controlEnabled) return;
    if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y) || !Number.isFinite(cmd.theta)) {
      if (this.goal && this.commandState !== "completed" && this.commandState !== "cancelled" && this.commandState !== "rejected" && this.commandState !== "failed") {
        this.publishCommand("cancelled", "superseded by invalid command");
        this.goal = null;
        this.clearMotion();
      }
      if (cmd.command_id) {
        this.lastCommandId = cmd.command_id;
        this.commandState = "rejected";
        this.commandReason = "invalid pose";
        this.sendCommandState?.({ command_id: cmd.command_id, state: "rejected", reason: "invalid pose" });
      }
      return;
    }
    if (cmd.command_id && this.lastCommandId === cmd.command_id) {
      if (isTerminalCommandState(this.commandState)) this.sendCommandState?.({ command_id: cmd.command_id, state: this.commandState, reason: this.commandReason });
      return;
    }
    if (this.goal && this.commandState !== "idle" && this.commandState !== "completed" && this.commandState !== "cancelled" && this.commandState !== "rejected") {
      this.publishCommand("cancelled", "superseded");
    }
    this.goal = { ...cmd };
    if (cmd.command_id) this.lastCommandId = cmd.command_id;
    this.publishCommand("accepted");
    this.applyPlan(cmd.x, cmd.y, cmd.theta);
  }

  private replan(): void {
    if (!this.goal) return;
    this.applyPlan(this.goal.x, this.goal.y, this.goal.theta);
  }

  private applyPlan(x: number, y: number, theta: number): void {
    const planned = planRoute({ x: this.x, y: this.y }, { x, y });
    if (!planned || planned.follow.length === 0) {
      if (this.goal && this.commandState === "accepted") {
        this.publishCommand("rejected", "no path");
        this.goal = null;
        this.clearMotion();
        return;
      }
      if (this.goal) {
        console.log(`[controller] plan failed → hold  goal=(${x},${y})`);
        this.phase = "hold";
        this.status = "move";
        return;
      }
      console.log(`[controller] plan failed → idle  goal=(${x},${y})`);
      this.goal = null;
      this.goIdle();
      return;
    }
    this.commitPlan(planned.follow, planned.display, theta, "drive");
  }

  private commitPlan(follow: Point[], display: Point[], theta: number, reason: string): void {
    this.path = follow;
    this.displayPath = display;
    this.pathDirty = true;
    this.pathIndex = 0;
    this.goalTheta = theta;
    this.skipReachedPoints();
    if (this.pathIndex >= this.path.length) {
      this.phase = "rotate";
    } else if (
      this.policyId !== "local_plan_v1" &&
      this.traffic &&
      this.traffic.held().segments.length === 0
    ) {
      this.phase = "hold";
      this.traffic.markHold?.();
    } else if (this.reversing) {
      this.phase = "reverse";
    } else if (this.traffic?.trafficStatus() === "stop") {
      this.phase = "hold";
    } else {
      this.phase = "follow";
    }
    this.status = "move";
    this.publishCommand("running", reason);
    console.log(
      `[controller] plan points=${this.path.length} corners=${this.displayPath.length} phase=${this.phase} (${reason})`,
    );
  }

  handleCancel(commandId = ""): void {
    if (commandId && commandId !== this.goal?.command_id) return;
    if (this.goal) this.publishCommand("cancelled", "cancelled");
    this.goal = null;
    this.reversing = false;
    this.evasionResumeGoal = null;
    this.goIdle();
    console.log("[controller] cancel → idle");
  }

  private clearMotion(): void {
    this.path = [];
    this.pathIndex = 0;
    this.displayPath = [];
    this.pathDirty = true;
    this.phase = "idle";
    this.status = "idle";
  }

  private goIdle(): void {
    const resume = this.evasionResumeGoal;
    this.evasionResumeGoal = null;
    this.reversing = false;
    this.clearMotion();
    this.traffic?.clear();
    // After E3 vacate, resume original mission.
    if (resume) {
      this.evasionHintObstacles = [];
      this.applyMergedObstacles(false);
      this.handleDrive(resume);
    }
  }

  private skipReachedPoints(): void {
    const eps = 0.5;
    while (this.pathIndex < this.path.length) {
      const p = this.path[this.pathIndex];
      const tolerance = this.pathIndex === this.path.length - 1 ? 1e-6 : eps;
      if (Math.hypot(p.x - this.x, p.y - this.y) > tolerance) break;
      this.pathIndex++;
    }
  }

  private applyPose(x: number, y: number, theta: number): boolean {
    if (!poseFeasible(x, y, theta)) return false;
    if (isSemanticPoseBlocked(this.semanticZones, { x, y })) return false;
    if (poseHitsAny(x, y, theta, this.obstacles)) return false;
    if (this.traffic && !this.traffic.poseAllowed(x, y, theta)) return false;
    this.x = x;
    this.y = y;
    this.theta = wrapAngle(theta);
    this.lastMotionAt = Date.now();
    return true;
  }

  /** Prefer translate+steer; if that clips a wall, translate with old heading, then rotate in place. */
  private tryMove(nx: number, ny: number, ntheta: number): boolean {
    if (this.applyPose(nx, ny, ntheta)) return true;
    if (this.applyPose(nx, ny, this.theta)) return true;
    if (this.applyPose(this.x, this.y, ntheta)) return true;
    return false;
  }

  private abortInfeasible(): void {
    if (this.goal) this.publishCommand("failed", "infeasible pose");
    console.log("[controller] infeasible pose → idle");
    this.goIdle();
  }

  private motionSnap(): MotionSnapshot {
    return {
      x: this.x,
      y: this.y,
      theta: this.theta,
      path: this.path,
      pathIndex: this.pathIndex,
      phase: this.phase,
      avoidanceMode: this.avoidanceMode,
    };
  }

  /** Probe one step along the follow path — used to leave HOLD when lease grows. */
  private shouldResumeHold(): boolean {
    if (this.semanticGatesBlocked()) return false;
    if (!this.traffic) return true;
    const tc = this.traffic.trafficStatus();
    if (tc === "stop" || tc === "lease_lost") return false;
    if (this.reversing) return false;
    if (this.pathBlockedByPeers()) return false;
    if (this.pathIndex >= this.path.length && !this.missionReached()) return false;
    // Need an actual lease covering the next step — headRoom alone is not enough
    // when held is empty (freeze) or after a bad grant.
    if (this.policyId === "local_plan_v1") return true;
    if (this.traffic.held().segments.length === 0) return false;
    if (!this.traffic.poseAllowed(this.x, this.y, this.theta)) return false;
    if (this.pathIndex >= this.path.length) return true;
    const target = this.path[this.pathIndex];
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return true;
    const step = Math.min(dist, Math.max(1, LINEAR_SPEED_PX_S * (TICK_MS / 1000)));
    const nx = this.x + (dx / dist) * step;
    const ny = this.y + (dy / dist) * step;
    const heading = Math.atan2(dy, dx);
    return this.traffic.poseAllowed(nx, ny, heading);
  }

  private tick(): void {
    const dt = TICK_MS / 1000;
    this.recordTrail();
    if (!this.connectionReady || !this.controlEnabled) {
      return;
    }
    if (isSemanticPoseBlocked(this.semanticZones, { x: this.x, y: this.y })) {
      if (this.phase !== "idle") this.phase = "hold";
      this.status = this.phase === "idle" ? "idle" : "move";
      this.traffic?.onTick(this.motionSnap());
      return;
    }
    if (this.semanticGatesBlocked()) {
      this.phase = this.phase === "idle" ? "idle" : "hold";
      this.status = this.phase === "idle" ? "idle" : "move";
      this.traffic?.onTick(this.motionSnap());
      return;
    }

    // Drop release_hint blocks once we are proceeding on a fresh lease.
    if (
      this.evasionHintObstacles.length &&
      this.traffic &&
      (this.traffic.trafficStatus() === "proceed" || this.traffic.trafficStatus() === "clear")
    ) {
      this.evasionHintObstacles = [];
      this.applyMergedObstacles(false);
    }

    if (this.traffic && this.traffic.trafficStatus() === "lease_lost") {
      this.phase = "lease_lost";
      this.status = this.goal ? "move" : "idle";
      this.traffic.onTick(this.motionSnap());
      return;
    }

    // FMS STOP: hard freeze translation — do not resume via shouldResumeHold.
    if (this.traffic && this.traffic.trafficStatus() === "stop") {
      this.phase = "hold";
      this.traffic.latchFreeze?.(this.x, this.y);
      this.traffic.onTick(this.motionSnap());
      return;
    }

    if (this.phase === "hold" && this.shouldResumeHold()) {
      this.phase = "follow";
      this.status = "move";
    }

    if (this.phase === "idle" || this.phase === "hold" || this.phase === "lease_lost") {
      this.traffic?.onTick(this.motionSnap());
      return;
    }

    this.traffic?.onTick(this.motionSnap());

    if (this.phase === "follow" || this.phase === "reverse") {
      this.tickFollow(dt);
      return;
    }
    if (this.phase === "rotate") {
      this.tickRotate(dt);
    }
  }

  private semanticGatesBlocked(): boolean {
    const now = Date.now();
    // A gate heartbeat older than one second is fail-safe STOP.
    return this.semanticZones.some((zone) => {
      if (zone.kind !== "corridor" && zone.kind !== "complex" && zone.kind !== "release") return false;
      const id = `semantic:${zone.id}`;
      const gate = this.semanticGates.get(id);
      return this.semanticGateRelevant(id) && (!gate || !gate.allow || now - gate.updatedAt > 1000);
    });
  }

  private semanticGateRelevant(id: string): boolean {
    const zone = this.semanticZones.find((z) => `semantic:${z.id}` === id);
    if (!zone) return false;
    if (zoneTouchesPoint(zone, { x: this.x, y: this.y })) return true;
    // Gate only the next motion step. Looking far ahead causes a robot to
    // freeze before the portal while a different robot still occupies it.
    const next = this.path[this.pathIndex];
    return Boolean(next && zoneTouchesPoint(zone, next));
  }

  private recordTrail(): void {
    const last = this.trail[this.trail.length - 1];
    if (!last || Math.hypot(this.x - last.x, this.y - last.y) >= BREADCRUMB_SPACING_PX) {
      this.trail.push({ x: this.x, y: this.y });
      if (this.trail.length > BREADCRUMB_MAX) this.trail.shift();
    }
  }

  private tickFollow(dt: number): void {
    this.skipReachedPoints();
    if (this.pathIndex >= this.path.length) {
      if (this.reversing) {
        this.phase = "hold";
        this.status = "move";
        return;
      }
      if (!this.missionReached()) {
        this.retryTrueGoal("goal-retry");
        return;
      }
      this.phase = "rotate";
      this.status = "move";
      this.tickRotate(dt);
      return;
    }

    const target = this.path[this.pathIndex];
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const dist = Math.hypot(dx, dy);
    const maxLinear = speedLimitAt(this.semanticZones, { x: this.x, y: this.y }) * dt;
    const maxAngular = ANGULAR_SPEED_RAD_S * dt;
    const heading = dist < 1e-6 ? this.theta : Math.atan2(dy, dx);
    const nextTheta = steer(this.theta, heading, maxAngular);

    let nx: number;
    let ny: number;
    let reached = false;
    if (dist <= maxLinear || dist < 1e-6) {
      nx = target.x;
      ny = target.y;
      reached = true;
    } else {
      const u = maxLinear / dist;
      nx = this.x + dx * u;
      ny = this.y + dy * u;
    }

    // Lease / traffic block → HOLD (never abort the mission).
    if (this.traffic) {
      if (this.traffic.trafficStatus() === "stop") {
        this.phase = "hold";
        this.traffic.latchFreeze?.(this.x, this.y);
        return;
      }
      const currentOk = this.traffic.poseAllowed(this.x, this.y, this.theta);
      const nextOk = this.traffic.poseAllowed(nx, ny, nextTheta);
      if (!nextOk) {
        this.phase = "hold";
        this.traffic.latchFreeze?.(this.x, this.y);
        this.traffic.markHold?.();
        if (!currentOk) {
          // Current pose itself outside held — stay put and re-request.
          console.log("[controller] lease block (current outside held) → hold");
        }
        return;
      }
    }

    if (!this.tryMove(nx, ny, nextTheta)) {
      if (this.reversing) {
        this.phase = "hold";
        return;
      }
      // Peer body (sim sensing) or transient block — hold & replan later, don't drop mission.
      if (this.peerObstacles.length && poseHitsAny(nx, ny, nextTheta, this.peerObstacles)) {
        this.phase = "hold";
        // Only A*-around parked peers; moving peers are traffic's job.
        if (this.peersLookParked(Date.now()) && this.canOptimizeAgainstPeers()) {
          this.maybeOptimizePath(true);
        }
        return;
      }
      this.abortInfeasible();
      return;
    }

    if (reached && Math.hypot(this.x - target.x, this.y - target.y) < 0.5) {
      this.pathIndex++;
    }

    if (this.pathIndex >= this.path.length) {
      this.phase = this.reversing ? "hold" : this.missionReached() ? "rotate" : "hold";
      if (!this.reversing && !this.missionReached()) this.retryTrueGoal("goal-retry");
    }
    this.status = "move";
  }

  private tickRotate(dt: number): void {
    const maxAngular = ANGULAR_SPEED_RAD_S * dt;
    const delta = shortestDelta(this.theta, this.goalTheta);
    if (Math.abs(delta) < HEADING_TOLERANCE_RAD) {
      this.applyPose(this.x, this.y, this.goalTheta);
      if (!this.missionReached()) {
        this.retryTrueGoal("goal-retry");
        return;
      }
      this.publishCommand("completed");
      this.goIdle();
      return;
    }
    const nextTheta = steer(this.theta, this.goalTheta, maxAngular);
    if (!this.applyPose(this.x, this.y, nextTheta)) {
      // Prefer hold over abort when traffic forbids the final heading.
      if (this.traffic && this.traffic.poseAllowed(this.x, this.y, this.theta)) {
        this.phase = "hold";
        this.traffic.markHold?.();
        return;
      }
      this.abortInfeasible();
      return;
    }
    this.status = "move";
  }
}

function corridorToHintObstacles(raw: unknown): DynObstacle[] {
  const segs = Array.isArray((raw as any)?.segments)
    ? (raw as any).segments
    : Array.isArray(raw)
      ? raw
      : [];
  const out: DynObstacle[] = [];
  let i = 0;
  for (const s of segs) {
    const x1 = Number(s.x1) || 0;
    const y1 = Number(s.y1) || 0;
    const x2 = Number(s.x2) || 0;
    const y2 = Number(s.y2) || 0;
    const r = Math.max(PEER_OBSTACLE_RADIUS_PX, Number(s.r) || PEER_OBSTACLE_RADIUS_PX);
    const pts = [
      [x1, y1],
      [x2, y2],
      [(x1 + x2) / 2, (y1 + y2) / 2],
    ];
    for (const [x, y] of pts) {
      out.push({
        id: `hint:${i++}`,
        kind: "circle",
        x,
        y,
        size: r,
        theta: 0,
      });
    }
  }
  return out;
}
