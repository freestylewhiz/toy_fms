import { MAP_ID, PIXEL_CM } from "../../shared/constants.ts";
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
  STEP_BACK_DISTANCE_PX,
  STEP_BACK_WAIT_MS,
  SIM_PEER_SENSING_HZ,
  TICK_MS,
  TRAFFIC_POLICY_ID,
  TRAFFIC_SEP_PX,
} from "../../shared/constants.ts";
import { setExtraBlocked } from "../../shared/occupancy.ts";
import {
  poseHitsAny,
  poseHitsObstacle,
  ObstacleMaskBuffer,
  type DynObstacle,
} from "../../shared/obstacles.ts";
import { clearPlanningObstacles, planRoute, poseFeasible, setPlanningObstacles, setSemanticSnapshot, type Point } from "../../shared/planner.ts";
import type { SemanticSnapshot } from "../../shared/semantic.ts";
import { isSemanticPoseBlocked, speedLimitAt, zoneTouchesPoint } from "../../shared/semanticNavigation.ts";
import {
  distToPlan,
  distanceAlongPathToClosestPoint,
  reverseAlongTrail,
  pathAfterDistance,
  pathLength,
  sampleLocalPlan,
  splitPathIntoSteps,
} from "../../shared/traffic/localPlan.ts";
import { parseTrafficPolicyId } from "../../shared/traffic/types.ts";
import { evaluateDetourBudget, projectPointOnPolyline } from "../../shared/traffic/detourBudget.ts";
import { DetourFallbacks, type DetourFallback } from "../../shared/config/events.ts";
import { isTerminalCommandState, type CommandState } from "../../shared/robotProtocol.ts";
import { ObstaclePlacementReasons, REASON_CODES, RobotCommandResults, RobotMotions, RobotStatuses, TrafficStatuses, type DriveCommandKind, type ObstaclePlacementReason, type RobotMotion, type RobotPhase, type RobotStatus } from "../../shared/config/index.ts";
import type { TrafficExecutor, TrafficGrant, MotionSnapshot } from "./traffic/TrafficExecutor.ts";
import type { AsyncRoutePlanner, PlanningEvent, PlanningHandle, PlanningRequest, RoutePlan } from "./planning.ts";

export type DriveCmd = {
  command_id: string;
  kind: DriveCommandKind;
  x: number;
  y: number;
  theta: number;
};

export type PoseSnapshot = {
  x: number;
  y: number;
  theta: number;
  status: RobotStatus;
  motion: RobotMotion;
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
  operatorPaused?: boolean;
};

type Phase = RobotPhase;
type TeleporterBlock = { id: string; polygon: Point[] };

const GOAL_REACH_PX = 0.5;
const PLANNING_START_DRIFT_TOLERANCE_PX = 1;

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

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function orientation(a: Point, b: Point, c: Point): number { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const ab = orientation(a, b, c), ab2 = orientation(a, b, d), cd = orientation(c, d, a), cd2 = orientation(c, d, b);
  return ((ab >= 0 && ab2 <= 0) || (ab <= 0 && ab2 >= 0)) && ((cd >= 0 && cd2 <= 0) || (cd <= 0 && cd2 >= 0));
}
function robotFootprint(cx: number, cy: number, theta: number): Point[] {
  const hl = 8, hw = 5, c = Math.cos(theta), s = Math.sin(theta);
  return [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw]].map(([x, y]) => ({ x: cx + c * x - s * y, y: cy + s * x + c * y }));
}
function footprintTouchesPolygon(cx: number, cy: number, theta: number, polygon: Point[]): boolean {
  if (polygon.length < 3) return false;
  const body = robotFootprint(cx, cy, theta);
  if (body.some(point => pointInPolygon(point, polygon)) || polygon.some(point => pointInPolygon(point, body))) return true;
  return body.some((a, i) => polygon.some((b, j) => segmentsCross(a, body[(i + 1) % body.length], b, polygon[(j + 1) % polygon.length])));
}

export class RobotController {
  private x: number;
  private y: number;
  private theta: number;
  private status: RobotStatus = RobotStatuses.code.idle;
  private phase: Phase = "idle";
  private path: Point[] = [];
  /** First committed command route; detours never replace this budget reference. */
  private originalCommandRoute: Point[] | null = null;
  private originalCommandStaticContext: string | null = null;
  private originalRouteProgressPx = 0;
  private activePathIsOriginal = false;
  private peerDetourRejected = false;
  private rejectedDetourStaticContext: string | null = null;
  private peerDetourBudgetActive = false;
  private peerBudgetStaticContext: string | null = null;
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
  private stepBack: { route: Point[]; steps: Point[][]; stepIndex: number; consumedPx: number; stepConsumed: boolean; waitUntil: number | null; retryAt: number | null } | null = null;
  private reversePeerPlans: { x: number; y: number; points: Point[] }[] = [];
  private reversePeerObservedAt = 0;
  private policyId = parseTrafficPolicyId(TRAFFIC_POLICY_ID);
  private connectionReady = true;
  private controlEnabled = true;
  private controlEpoch = 0;
  private sessionId = "";
  private contextSince = Date.now();
  private contextKey = "idle";
  private lastMotionAt = 0;
  /** A rejected/stale route must never be resumed from HOLD. */
  private pathInvalidated = false;
  private lastBlockedReplanMs = 0;
  private awaitingSnapshot = false;
  private semanticGates = new Map<string, { allow: boolean; updatedAt: number }>();
  private semanticZones: SemanticSnapshot["zones"] = [];
  private teleporterBlocks: TeleporterBlock[] = [];
  private sessionReady = true;
  private snapshotReady = false;
  private commandState: CommandState = "idle";
  private lastCommandId = "";
  private teleporterClearingActive = false;
  private teleporterTransferActive = false;
  private operatorPaused = false;
  private deferredPlanResult: (() => void) | null = null;
  private deferredPlanCancel: (() => void) | null = null;
  private commandReason = "";
  private sendCommandState: ((state: { command_id: string; state: CommandState; reason: string }) => void) | null = null;
  private readonly obstacleMask = new ObstacleMaskBuffer();
  private asyncPlanner: AsyncRoutePlanner | null = null;
  private pendingPlan: { generation: number; handle: PlanningHandle; onCancel?: () => void } | null = null;
  private planningGeneration = 0;
  private peerPlansKey = "";
  private semanticSnapshotZones: SemanticSnapshot["zones"] = [];
  private planningEventHandler: ((event: PlanningEvent) => void) | null = null;
  private evasionRounds = new Map<string, { result?: string; reason?: string }>();

  constructor(initial: { x: number; y: number; theta: number }) {
    this.x = initial.x;
    this.y = initial.y;
    this.theta = wrapAngle(initial.theta);
    this.trail = [{ x: this.x, y: this.y }];
  }

  attachTraffic(executor: TrafficExecutor): void {
    this.traffic = executor;
  }

  /** Runtime robots use the worker; tests may leave this unset for sync A*. */
  setAsyncPlanner(planner: AsyncRoutePlanner | null): void {
    this.cancelPendingPlan();
    this.asyncPlanner = planner;
  }

  setPlanningEventHandler(handler: ((event: PlanningEvent) => void) | null): void {
    this.planningEventHandler = handler;
  }

  setConnectionReady(ready: boolean): void {
    this.sessionReady = ready;
    if (!ready) {
      this.evasionRounds.clear();
      this.cancelPendingPlan();
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

  setTeleporterConstraints(value: { blocked: TeleporterBlock[] }): void {
    const next = value.blocked.filter(block => block && typeof block.id === "string" && Array.isArray(block.polygon) && block.polygon.length >= 3);
    const oldKey = JSON.stringify(this.teleporterBlocks);
    const nextKey = JSON.stringify(next);
    if (oldKey === nextKey) return;
    this.teleporterBlocks = next;
    if (!this.operatorPaused && !this.reversing && this.goal && (this.phase !== "idle" || this.pendingPlan !== null)) this.replan();
  }

  /** The FMS-owned transfer gate prevents changing map context mid-atomic handoff. */
  setTeleporterTransferActive(active: boolean): void {
    this.teleporterTransferActive = active;
  }

  isOperatorPaused(): boolean {
    return this.operatorPaused;
  }

  /**
   * Apply the independent operator motion latch. This deliberately keeps the
   * mission, path, path index, local plan and traffic reservation untouched.
   */
  setOperatorPaused(paused: boolean): { applied: boolean; reasonCode: string } {
    if (paused === this.operatorPaused) return { applied: true, reasonCode: REASON_CODES.code.already_applied };
    if (paused && (this.teleporterTransferActive || this.teleporterClearingActive)) {
      return { applied: false, reasonCode: REASON_CODES.code.transfer_in_progress };
    }
    const safety = paused ? { ok: true, reasonCode: "" } : this.operatorResumeSafety();
    this.operatorPaused = paused;
    if (!paused) {
      if (!safety.ok) {
        if (safety.reasonCode === "path_blocked" || safety.reasonCode === "peer_blocked") this.pathInvalidated = true;
        if (this.goal) {
          this.phase = "hold";
          this.status = "move";
        }
      }
      const deferred = this.deferredPlanResult;
      this.deferredPlanResult = null;
      this.deferredPlanCancel = null;
      deferred?.();
    }
    return { applied: true, reasonCode: paused ? "paused" : (safety.ok ? "resumed" : `resumed_${safety.reasonCode}`) };
  }

  private operatorResumeSafety(): { ok: boolean; reasonCode: string } {
    if (!this.controlEnabled || !this.connectionReady) return { ok: false, reasonCode: REASON_CODES.code.control_unavailable };
    if (isSemanticPoseBlocked(this.semanticZones, { x: this.x, y: this.y })) return { ok: false, reasonCode: REASON_CODES.code.semantic_blocked };
    if (this.path.length > this.pathIndex) {
      if (!this.routeValidAgainstCurrentContext(this.path.slice(this.pathIndex))) return { ok: false, reasonCode: REASON_CODES.code.path_blocked };
      // An obstacle can be present and then removed while paused. Re-evaluate
      // the retained route instead of making the stale-context flag sticky.
      this.pathInvalidated = false;
    }
    if (this.pathBlockedByPeers()) return { ok: false, reasonCode: REASON_CODES.code.peer_blocked };
    const trafficState = this.traffic?.trafficStatus();
    if (trafficState === TrafficStatuses.code.stop) return { ok: false, reasonCode: REASON_CODES.code.traffic_stop };
    if (trafficState === TrafficStatuses.code.lease_lost) return { ok: false, reasonCode: REASON_CODES.code.lease_lost };
    if (this.traffic && !this.traffic.poseAllowed(this.x, this.y, this.theta)) {
      return { ok: false, reasonCode: REASON_CODES.code.traffic_permission_pending };
    }
    return { ok: true, reasonCode: "" };
  }

  /** Clear all map-owned navigation state at a teleporter boundary. */
  resetMapContext(): void {
    this.evasionRounds.clear();
    this.cancelPendingPlan();
    this.goal = null;
    this.evasionResumeGoal = null;
    this.trimTrailAfterStepBack();
    this.reversing = false;
    this.stepBack = null;
    this.reversePeerPlans = [];
    this.reversePeerObservedAt = 0;
    this.path = [];
    this.originalCommandRoute = null;
    this.originalCommandStaticContext = null;
    this.originalRouteProgressPx = 0;
    this.activePathIsOriginal = false;
    this.clearPeerDetourBudget();
    this.displayPath = [];
    this.pathIndex = 0;
    this.peerObstacles = [];
    this.peerBodyObstacles = [];
    this.peerPlanObstacles = [];
    this.peerMotion.clear();
    this.peerPlansKey = "";
    this.pathInvalidated = false;
    this.lastBlockedReplanMs = 0;
    this.evasionHintObstacles = [];
    this.semanticGates.clear();
    this.semanticZones = [];
    this.teleporterBlocks = [];
    setSemanticSnapshot(null);
    clearPlanningObstacles();
    setExtraBlocked(null);
    this.traffic?.clear();
    this.obstacleMask.clear();
    this.phase = "idle";
    this.status = "idle";
  }

  /** Apply the destination pose only after the destination session is ready. */
  setTeleporterArrival(exit: { x: number; y: number; theta: number }, clearing: { x: number; y: number }, transferId: string): void {
    if (this.operatorPaused) return;
    if (this.lastCommandId === transferId) {
      if (this.goal) return; // duplicate while the same clearing goal is active
      if (!this.teleporterClearingActive) return; // terminal duplicate
      // A control-generation reset cleared the goal, so authorize one resume
      // of the durable clearing mission despite the command ID being reused.
      this.lastCommandId = "";
    }
    this.x = exit.x;
    this.y = exit.y;
    this.theta = wrapAngle(exit.theta);
    this.teleporterClearingActive = true;
    this.teleporterTransferActive = true;
    this.handleDrive({ command_id: transferId, kind: "teleporter_clearing", x: clearing.x, y: clearing.y, theta: exit.theta });
  }

  setMapPose(pose: { x: number; y: number; theta: number }): void {
    this.cancelPendingPlan();
    this.reversing = false;
    this.stepBack = null;
    this.reversePeerPlans = [];
    this.reversePeerObservedAt = 0;
    this.x = pose.x; this.y = pose.y; this.theta = wrapAngle(pose.theta);
    this.originalCommandRoute = null;
    this.originalCommandStaticContext = null;
    this.originalRouteProgressPx = 0;
    this.activePathIsOriginal = false;
    this.clearPeerDetourBudget();
    this.trail = [{ x: this.x, y: this.y }];
    this.clearMotion();
  }

  /**
   * Apply an FMS-verified virtual-robot pose override. This is a hard mission
   * boundary: an interrupted drive, evasion, lease, and its old path cannot
   * resume after the next control generation is enabled.
   */
  applyOperatorPoseOverride(pose: { x: number; y: number; theta: number }): boolean {
    if (![pose.x, pose.y, pose.theta].every(Number.isFinite)) return false;
    const theta = wrapAngle(pose.theta);
    // FMS performs the authoritative fleet check. Keep a local body-level
    // guard for stale UI obstacles, hard zones, and endpoint reservations.
    if (!poseFeasible(pose.x, pose.y, theta)) return false;
    if (isSemanticPoseBlocked(this.semanticZones, { x: pose.x, y: pose.y })) return false;
    // Future peer trajectories are planning context, not physical occupancy.
    // Placement remains safe against static obstacles and latest peer bodies.
    if (poseHitsAny(pose.x, pose.y, theta, [...this.uiObstacles, ...this.peerBodyObstacles])) return false;
    if (this.teleporterBlocksPose(pose.x, pose.y, theta)) return false;

    if (this.goal && !isTerminalCommandState(this.commandState)) {
      this.publishCommand("cancelled", "operator pose override");
    }
    this.goal = null;
    this.originalCommandRoute = null;
    this.originalCommandStaticContext = null;
    this.originalRouteProgressPx = 0;
    this.activePathIsOriginal = false;
    this.clearPeerDetourBudget();
    this.cancelPendingPlan();
    this.evasionResumeGoal = null;
    this.trimTrailAfterStepBack();
    this.reversing = false;
    this.stepBack = null;
    this.reversePeerPlans = [];
    this.reversePeerObservedAt = 0;
    this.evasionHintObstacles = [];
    this.semanticGates.clear();
    this.applyMergedObstacles(false);
    this.traffic?.clear();
    this.x = pose.x;
    this.y = pose.y;
    this.theta = theta;
    this.trail = [{ x: this.x, y: this.y }];
    this.lastCommandId = "";
    this.commandState = "idle";
    this.commandReason = "";
    this.clearMotion();
    return true;
  }

  /** Apply the server owned operating control state. Disabled robots retain telemetry but cannot execute traffic. */
  setControlState(state: { enabled: boolean; controlEpoch: number; sessionId: string; operatorPaused?: boolean }): void {
    const wasEnabled = this.controlEnabled;
    const boundary = this.sessionId !== state.sessionId || this.controlEpoch !== state.controlEpoch;
    if (boundary) this.evasionRounds.clear();
    this.traffic?.setControlState?.(state);
    if (boundary && (this.goal || this.phase !== "idle")) {
      this.cancelPendingPlan();
      if (this.goal) this.publishCommand("cancelled", "control generation changed");
      this.goal = null;
      this.originalCommandRoute = null;
      this.originalCommandStaticContext = null;
      this.originalRouteProgressPx = 0;
      this.activePathIsOriginal = false;
      this.clearPeerDetourBudget();
      this.evasionResumeGoal = null;
      this.trimTrailAfterStepBack();
      this.reversing = false;
      this.stepBack = null;
      this.reversePeerPlans = [];
      this.reversePeerObservedAt = 0;
      this.clearMotion();
      this.traffic?.clear();
    }
    this.controlEnabled = state.enabled;
    this.controlEpoch = state.controlEpoch;
    this.sessionId = state.sessionId;
    if (typeof state.operatorPaused === "boolean") this.operatorPaused = state.operatorPaused;
    if (!state.enabled) {
      this.cancelPendingPlan();
      if (this.goal) this.publishCommand("cancelled", "fms control disabled");
      this.goal = null;
      this.originalCommandRoute = null;
      this.originalCommandStaticContext = null;
      this.originalRouteProgressPx = 0;
      this.activePathIsOriginal = false;
      this.clearPeerDetourBudget();
      this.evasionResumeGoal = null;
      this.trimTrailAfterStepBack();
      this.reversing = false;
      this.stepBack = null;
      this.reversePeerPlans = [];
      this.reversePeerObservedAt = 0;
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

  onTrafficStopStatus(status: {
    stop_id: string;
    stop_generation: string | number | bigint;
    decision: string;
    reason?: string;
    control_epoch?: string | number | bigint;
    session_id?: string;
  }): void {
    this.traffic?.onTrafficStopStatus?.(status);
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
      if ((this.phase === "hold" || this.phase === "lease_lost") && this.traffic?.trafficStatus() !== "stop") {
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
    if (this.operatorPaused) {
      this.sendEvasionReply?.({ zone_id: zoneId, round_id: roundId, result: RobotCommandResults.code.NONE, reason: REASON_CODES.code.operator_paused });
      return;
    }
    const roundGoal = this.goal;
    const roundKey = `${zoneId}:${roundId}`;
    const previous = this.evasionRounds.get(roundKey);
    if (previous) {
      if (previous.result !== undefined) {
        this.sendEvasionReply?.({ zone_id: zoneId, round_id: roundId, result: previous.result, reason: previous.reason ?? "" });
      }
      return;
    }
    if (this.reversing) {
      const result = mode === "VACATE" ? "VACATE" : "NONE";
      const reason = mode === "VACATE" ? "ok" : "no path";
      this.evasionRounds.set(roundKey, { result, reason });
      if (this.evasionRounds.size > 128) this.evasionRounds.delete(this.evasionRounds.keys().next().value!);
      this.sendEvasionReply?.({ zone_id: zoneId, round_id: roundId, result, reason });
      return;
    }
    this.evasionRounds.set(roundKey, {});
    // Complete cancellation cleanup for a superseded round before installing
    // this round's release hint, so the old callback cannot erase new state.
    if (this.pendingPlan) this.cancelPendingPlan();
    const finish = (result: string, reason: string): void => {
      const current = this.evasionRounds.get(roundKey);
      if (!current || current.result !== undefined) return;
      current.result = result;
      current.reason = reason;
      if (this.evasionRounds.size > 128) this.evasionRounds.delete(this.evasionRounds.keys().next().value!);
      this.sendEvasionReply?.({ zone_id: zoneId, round_id: roundId, result, reason });
      if (result === "NONE" && roundGoal && this.goal === roundGoal) {
        this.phase = "hold";
        this.evasionHintObstacles = [];
        this.applyMergedObstacles(false);
      }
    };
    this.evasionHintObstacles = corridorToHintObstacles(payload.release_hint ?? payload.releaseHint);
    this.applyMergedObstacles(false);
    this.traffic?.clear();
    this.traffic?.beginEvadeMotion?.();

    let ok = false;
    let result = "NONE";
    if (mode === "VACATE") {
      // VACATE owns the physical reverse path. An ordinary route or a prior
      // REROUTE worker result must not be allowed to commit after it starts.
      this.markPeerDetourRejected();
      ok = this.planVacate();
      result = ok ? "VACATE" : "NONE";
      finish(result, ok ? "ok" : "no path");
    } else {
      this.planReroute((success) => {
        const asyncResult = success ? "REROUTE" : "NONE";
        console.log(`[controller] evasion ${mode} → ${asyncResult}`);
        finish(asyncResult, success ? "ok" : "no path");
      });
      return;
    }
    console.log(`[controller] evasion ${mode} → ${result}`);
  }

  private planReroute(onResult: (ok: boolean) => void): boolean {
    if (!this.goal) {
      onResult(false);
      return false;
    }
    this.activatePeerDetourBudget();
    const expectedGoal = this.goal;
    const requestedAsync = this.requestCurrentGoalPlan("e2-reroute", (planned) => {
      if (!planned?.follow.length || !this.goal || this.goal !== expectedGoal) {
        onResult(false);
        return;
      }
      const budget = this.evaluatePeerDetour(planned.follow);
      if (!budget.accepted) {
        this.markPeerDetourRejected();
        this.emitDetourRejected(budget, DetourFallbacks.code["await-vacate"]);
        this.phase = "hold";
        this.status = "move";
        onResult(false);
        return;
      }
      this.commitPlan(planned.follow, planned.display, this.goal.theta, "e2-reroute");
      this.clearPeerDetourRejection();
      this.phase = "follow";
      this.status = "move";
      this.traffic?.beginEvadeMotion?.();
      onResult(true);
    }, () => onResult(false));
    return requestedAsync;
  }

  private planVacate(): boolean {
    return this.startReverseAlongTrail("e3-vacate");
  }

  private startReverseAlongTrail(reason: string): boolean {
    if (!this.goal) return false;
    const newest = this.trail[this.trail.length - 1];
    const available = (newest ? Math.hypot(this.x - newest.x, this.y - newest.y) : 0) + pathLength(this.trail);
    const back = reverseAlongTrail(this.trail, { x: this.x, y: this.y }, available);
    if (back.length < 2) {
      console.log(`[controller] reverse failed (${reason}) trail=${this.trail.length}`);
      return false;
    }
    this.cancelPendingPlan();
    this.evasionResumeGoal = null;
    this.reversing = true;
    this.stepBack = {
      route: back.map((point) => ({ ...point })),
      steps: splitPathIntoSteps(back, STEP_BACK_DISTANCE_PX),
      stepIndex: 0,
      consumedPx: 0,
      stepConsumed: false,
      waitUntil: null,
      retryAt: null,
    };
    this.applyMergedObstacles(false);
    if (!this.stepBack.steps.length) {
      this.finishReverse();
      return false;
    }
    this.activateReverseStep(reason);
    this.traffic?.beginEvadeMotion?.();
    return true;
  }

  private activateReverseStep(reason: string): void {
    const state = this.stepBack;
    if (!state) return;
    const step = state.steps[state.stepIndex];
    if (!step) {
      this.phase = "hold";
      this.status = "move";
      return;
    }
    state.waitUntil = null;
    state.retryAt = null;
    this.commitPlan(step, step, this.theta, reason);
    this.phase = "reverse";
  }

  private reversePeersClear(): boolean {
    const limit = TRAFFIC_SEP_PX + 8;
    return this.reversePeerPlans.every((peer) => {
      if (Math.hypot(this.x - peer.x, this.y - peer.y) < limit) return false;
      return distToPlan({ x: this.x, y: this.y }, peer.points) >= limit;
    });
  }

  private reverseObservationFresh(): boolean {
    return Date.now() - this.reversePeerObservedAt <= Math.max(1000, 3 * (1000 / SIM_PEER_SENSING_HZ));
  }

  private tickStepBack(dt: number): void {
    const state = this.stepBack;
    if (!state) return;
    this.traffic?.onTick(this.motionSnap());
    if (state.waitUntil !== null) {
      if (Date.now() < state.waitUntil) {
        this.phase = "hold";
        this.status = "move";
        return;
      }
      if (!this.reverseObservationFresh()) {
        state.waitUntil = Date.now() + STEP_BACK_WAIT_MS;
        this.phase = "hold";
        this.status = "move";
        return;
      }
      if (this.reversePeersClear()) {
        this.finishReverse();
        return;
      }
      if (state.stepIndex + 1 >= state.steps.length) {
        // Recheck at the configured trial interval after exhausting the trail.
        state.waitUntil = Date.now() + STEP_BACK_WAIT_MS;
        this.phase = "hold";
        this.status = "move";
        return;
      }
      state.stepIndex++;
      state.stepConsumed = false;
      this.activateReverseStep(REASON_CODES.code["step-back"]);
    }
    if (state.retryAt !== null) {
      if (Date.now() < state.retryAt) {
        this.phase = "hold";
        this.status = "move";
        return;
      }
      if (!this.reverseObservationFresh()) {
        state.retryAt = Date.now() + STEP_BACK_WAIT_MS;
        this.phase = "hold";
        this.status = "move";
        return;
      }
      state.retryAt = null;
    }
    if (this.pathIndex >= this.path.length) {
      if (state.waitUntil === null) {
        if (!state.stepConsumed) {
          state.consumedPx += pathLength(state.steps[state.stepIndex]);
          state.stepConsumed = true;
        }
        state.waitUntil = Date.now() + STEP_BACK_WAIT_MS;
      }
      this.phase = "hold";
      this.status = "move";
      return;
    }
    // Continue the frozen segment from the actual pose after a temporary block.
    this.phase = "reverse";
    this.tickFollow(dt);
    // tickFollow can change phase while trying the physical move.
    if ((this.phase as Phase) === "hold" && this.pathIndex < this.path.length) {
      state.retryAt = Date.now() + STEP_BACK_WAIT_MS;
    }
  }

  private finishReverse(): void {
    this.reversing = false;
    this.trimTrailAfterStepBack();
    this.stepBack = null;
    this.phase = "hold";
    this.evasionHintObstacles = [];
    this.applyMergedObstacles(false);
    if (this.goal) {
      const enforceBudget = Boolean(this.originalCommandRoute && this.originalCommandStaticContext === this.staticNavigationContextKey()) || this.peerDetourBudgetStillApplies();
      if (!enforceBudget && this.peerDetourRejected) {
        // VACATE without an accepted command route has no safe length
        // reference. Stay still until peers clear or static context changes.
        this.phase = "hold";
        this.status = "move";
        return;
      }
      this.applyPlan(this.goal.x, this.goal.y, this.goal.theta, enforceBudget);
    }
  }

  private trimTrailAfterStepBack(): void {
    const state = this.stepBack;
    if (!state) return;
    const currentStep = state.steps[state.stepIndex];
    const progress = currentStep && !state.stepConsumed
      ? distanceAlongPathToClosestPoint(currentStep, { x: this.x, y: this.y })
      : 0;
    const remaining = pathAfterDistance(state.route, state.consumedPx + progress);
    this.trail = [...remaining.reverse(), { x: this.x, y: this.y }].slice(-BREADCRUMB_MAX);
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
      motion: this.operatorPaused ? RobotMotions.code.PAUSED : RobotMotions.code[this.phase.toUpperCase() as keyof typeof RobotMotions.code],
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
      operatorPaused: this.operatorPaused,
    };
  }

  private driveContext(): unknown[] {
    if (this.phase === "idle" && !this.pendingPlan && !this.operatorPaused) return [];
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
    else if (isSemanticPoseBlocked(this.semanticZones, { x: this.x, y: this.y }) || this.pathBlockedByPeers() || this.pathBlockedByCurrentContext()) reason = "obstacle_detected";
    else if (this.pendingPlan) reason = "route_update_pending";
    else if (blockedGate) {
      reason = "permission_pending";
      target = { mapId: MAP_ID, kind: "zone", id: blockedGate.id };
      permissionState = "pending";
    } else if (trafficState === "stop" || trafficState === "hold" || trafficState === "partial") reason = "traffic_yield";
    else if (this.phase === "hold") reason = "permission_pending";
    if (this.operatorPaused) reason = "operator_paused";
    if (!reason) { this.contextKey = "idle"; return []; }
    const key = `${reason}:${target?.id ?? ""}:${this.lastCommandId}`;
    if (key !== this.contextKey) { this.contextKey = key; this.contextSince = Date.now(); }
    return [{ reasonCode: reason, source: "robot", target, permissionState, requestId: this.lastCommandId || undefined, since: this.contextSince }];
  }

  private observedDriveState(): string {
    if (this.operatorPaused) return "paused";
    if (this.phase === "idle") return "stationary";
    if (Date.now() - this.lastMotionAt <= TICK_MS * 2) return "moving";
    if (this.phase === "hold" && (isSemanticPoseBlocked(this.semanticZones, { x: this.x, y: this.y }) || this.pathBlockedByPeers() || this.pathBlockedByCurrentContext())) return "blocked";
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
    peers: { robotId: string; x: number; y: number; theta: number; points: Point[]; operatorPaused?: boolean }[],
  ): void {
    if (this.policyId !== "local_plan_v1") return;
    const peerKey = JSON.stringify(peers.map((p) => ({
      robotId: p.robotId,
      x: p.x,
      y: p.y,
      theta: p.theta,
      operatorPaused: Boolean(p.operatorPaused),
      points: p.points,
    })));
    this.reversePeerPlans = peers.map((p) => ({
      x: p.x,
      y: p.y,
      points: (p.operatorPaused ? [{ x: p.x, y: p.y }] : (p.points.length ? p.points : [{ x: p.x, y: p.y }])).map((point) => ({ ...point })),
    }));
    this.reversePeerObservedAt = Date.now();
    if (peerKey === this.peerPlansKey) return;
    this.peerPlansKey = peerKey;
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
      // A paused peer retains and reports its local path for semantic
      // ownership, but its external forecast is stationary at its body.
      const pts = p.operatorPaused ? [{ x: p.x, y: p.y }] : (p.points.length ? p.points : [{ x: p.x, y: p.y }]);
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
    if (!peers.length && !this.originalCommandRoute && this.peerDetourRejected && !this.reversing) {
      // With every peer gone, a fresh ordinary route is no longer a peer
      // detour. Fence any older peer-context plan before clearing the guard.
      this.cancelPendingPlan();
      this.clearPeerDetourBudget();
    }
    this.traffic?.onPeerLocalPlans?.(peers);

    // While operator-paused, peer updates remain collision context only. They
    // must not replan, finish VACATE, or alter the retained route.
    if (this.operatorPaused) return;

    if (!this.goal) return;
    // Keep an initial worker request stable while peer snapshots arrive. Its
    // copied obstacle snapshot is checked against the latest context when the
    // result returns, so unrelated peer movement does not starve planning.
    if (this.phase === "idle") {
      return;
    }
    if (this.reversing) return;
    if (this.traffic?.trafficStatus() === "stop") return;
    if (this.pathBlockedByPeers()) {
      const now = Date.now();
      if (now - this.lastPeerReplanMs < 800) return;
      this.lastPeerReplanMs = now;
      this.activatePeerDetourBudget();
      this.requestCurrentGoalPlan("v1-detour", (planned) => {
      if (planned?.follow.length && this.goal) {
          const budget = this.evaluatePeerDetour(planned.follow);
          if (!budget.accepted) {
            this.markPeerDetourRejected();
            this.emitDetourRejected(budget, DetourFallbacks.code["step-back-request"]);
            this.startReverseAlongTrail(REASON_CODES.code["detour-too-long"]);
            return;
          }
          this.commitPlan(planned.follow, planned.display, this.goal.theta, "v1-detour");
          this.clearPeerDetourRejection();
          this.phase = "follow";
        } else {
          this.startReverseAlongTrail("blocked-no-detour");
        }
      });
      return;
    }
    // A valid path must remain valid when an unchanged/empty peer snapshot is
    // repeated. Retry only when the current route really ends short because a
    // peer still occupies the true goal area.
    if (this.goalNeedsRetry()) this.retryTrueGoal("v1-goal-retry");
  }

  setObstacles(items: DynObstacle[]): void {
    this.uiObstacles = items;
    this.applyMergedObstacles(true);
  }

  /** Apply a server-pushed map policy and resource snapshot atomically. */
  setSemanticSnapshot(snapshot: Pick<SemanticSnapshot, "zones" | "obstacles">): void {
    setSemanticSnapshot(snapshot);
    this.semanticZones = snapshot.zones;
    this.semanticSnapshotZones = snapshot.zones;
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
    // A semantic snapshot can arrive while the initial worker plan is still
    // pending. It changes the planning context even though no path was
    // committed yet, so fence and reissue that request as well.
    this.applyMergedObstacles(Boolean(!this.operatorPaused && this.goal && (this.phase !== "idle" || this.pendingPlan)));
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
    this.reversePeerPlans = peers.map((p) => ({ x: p.x, y: p.y, points: [{ x: p.x, y: p.y }] }));
    this.reversePeerObservedAt = now;
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

    if (this.operatorPaused) return;

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
      return;
    }
    this.lastPeerReplanMs = now;
    if (this.pathBlockedByPeers()) this.activatePeerDetourBudget();
    this.requestCurrentGoalPlan(reason, (planned) => {
      if (!this.goal || !planned?.follow.length) {
        this.phase = "hold";
        this.status = "move";
        return;
      }
      if (this.peerDetourBudgetStillApplies() || this.pathBlockedByPeers()) {
        const budget = this.evaluatePeerDetour(planned.follow);
        if (!budget.accepted) {
          this.markPeerDetourRejected();
          this.emitDetourRejected(budget, DetourFallbacks.code["step-back-request"]);
          this.startReverseAlongTrail(REASON_CODES.code["detour-too-long"]);
          return;
        }
        this.clearPeerDetourRejection();
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
    });
  }

  private goalNeedsRetry(): boolean {
    if (!this.goal || this.missionReached() || this.pathIndex < this.path.length) return false;
    const end = this.path.at(-1);
    if (end && Math.hypot(end.x - this.goal.x, end.y - this.goal.y) < GOAL_REACH_PX) return false;
    // A short path can be a temporary peer blockage. Once the peer clears,
    // the route must still be retried; waiting for another peer transition is
    // not sufficient because HOLD ticks do not advance the path index.
    return true;
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

  private evaluatePeerDetour(candidate: Point[]): ReturnType<typeof evaluateDetourBudget> {
    const reference = this.originalCommandRoute;
    const goal = this.goal ? { x: this.goal.x, y: this.goal.y } : undefined;
    return evaluateDetourBudget({
      referenceRoute: reference,
      currentPose: { x: this.x, y: this.y },
      candidateRoute: candidate,
      goal,
      minProgressPx: this.originalRouteProgressPx,
      pixelCm: PIXEL_CM,
      referenceValid: (connector, remaining) =>
        this.routeValidAgainstObstacles(connector, this.uiObstacles) &&
        this.routeValidAgainstObstacles(remaining, this.uiObstacles),
    });
  }

  private staticNavigationContextKey(): string {
    const obstacles = this.uiObstacles.map(({ kind, x, y, size, theta }) => ({ kind, x, y, size, theta }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const zones = this.semanticZones.map(({ id, family, kind, polygon, theta, factor, maximumSpeed, capacity, direction, directedLimitation, releaseLossBehavior }) =>
      ({ id, family, kind, polygon, theta, factor, maximumSpeed, capacity, direction, directedLimitation, releaseLossBehavior }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const teleporterBlocks = this.teleporterBlocks.map(({ polygon }) => polygon)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return JSON.stringify({ mapId: MAP_ID, obstacles, zones, teleporterBlocks });
  }

  private activatePeerDetourBudget(): void {
    this.peerDetourBudgetActive = true;
    this.peerBudgetStaticContext = this.staticNavigationContextKey();
  }

  private markPeerDetourRejected(): void {
    this.activatePeerDetourBudget();
    this.peerDetourRejected = true;
    this.rejectedDetourStaticContext = this.staticNavigationContextKey();
  }

  private clearPeerDetourRejection(): void {
    this.peerDetourRejected = false;
    this.rejectedDetourStaticContext = null;
  }

  private clearPeerDetourBudget(): void {
    this.clearPeerDetourRejection();
    this.peerDetourBudgetActive = false;
    this.peerBudgetStaticContext = null;
  }

  /** Keep retry paths budgeted until real static navigation context changes. */
  private peerDetourBudgetStillApplies(): boolean {
    if (!this.peerDetourBudgetActive && !this.peerDetourRejected) return false;
    const current = this.staticNavigationContextKey();
    if ((this.peerDetourBudgetActive && this.peerBudgetStaticContext !== current) ||
        (this.peerDetourRejected && this.rejectedDetourStaticContext !== current)) {
      this.clearPeerDetourBudget();
      return false;
    }
    return true;
  }

  private emitDetourRejected(
    budget: ReturnType<typeof evaluateDetourBudget>,
    fallback: DetourFallback,
  ): void {
    const reason = budget.available
      ? REASON_CODES.code["detour-too-long"]
      : REASON_CODES.code["detour-reference-unavailable"];
    const commandId = this.goal?.command_id ?? this.lastCommandId;
    this.planningEventHandler?.({
      requestId: this.planningGeneration,
      commandId,
      kind: "navigation.detour_rejected",
      phase: "failed",
      level: "warn",
      reason,
      mapId: MAP_ID,
      start: { x: this.x, y: this.y },
      goal: this.goal ? { x: this.goal.x, y: this.goal.y } : { x: this.x, y: this.y },
      async: false,
      baselineLengthM: budget.baselineLengthM,
      candidateLengthM: budget.candidateLengthM,
      allowedLengthM: budget.allowedLengthM,
      fallback,
      ...(fallback === DetourFallbacks.code["step-back-request"] ? {
        stepBackDistanceM: STEP_BACK_DISTANCE_PX * PIXEL_CM / 100,
        stepBackWaitMs: STEP_BACK_WAIT_MS,
      } : {}),
    });
  }

  private routeValidAgainstObstacles(follow: Point[], obstacles: DynObstacle[]): boolean {
    if (!follow.length) return false;
    let px = this.x;
    let py = this.y;
    for (const point of follow) {
      const dx = point.x - px;
      const dy = point.y - py;
      const distance = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.ceil(distance / 4));
      const theta = distance < 1e-6 ? this.theta : Math.atan2(dy, dx);
      for (let step = 1; step <= steps; step++) {
        const u = step / steps;
        const x = px + dx * u;
        const y = py + dy * u;
        if (!poseFeasible(x, y, theta) || poseHitsAny(x, y, theta, obstacles) || isSemanticPoseBlocked(this.semanticZones, { x, y }) || this.teleporterBlocksPose(x, y, theta)) return false;
      }
      px = point.x;
      py = point.y;
    }
    return true;
  }

  private routeLengthFromHere(follow: Point[]): number {
    if (!follow.length) return Infinity;
    let len = Math.hypot(follow[0].x - this.x, follow[0].y - this.y);
    for (let i = 1; i < follow.length; i++) {
      len += Math.hypot(follow[i].x - follow[i - 1].x, follow[i].y - follow[i - 1].y);
    }
    return len;
  }

  private routeValidAgainstCurrentContext(follow: Point[]): boolean {
    if (!follow.length) return false;
    let px = this.x;
    let py = this.y;
    for (const point of follow) {
      const dx = point.x - px;
      const dy = point.y - py;
      const distance = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.ceil(distance / 4));
      const theta = distance < 1e-6 ? this.theta : Math.atan2(dy, dx);
      for (let step = 1; step <= steps; step++) {
        const u = step / steps;
        const x = px + dx * u;
        const y = py + dy * u;
        if (
          poseHitsAny(x, y, theta, this.obstacles) ||
          isSemanticPoseBlocked(this.semanticZones, { x, y }) ||
          this.teleporterBlocksPose(x, y, theta)
        ) return false;
      }
      px = point.x;
      py = point.y;
    }
    return true;
  }

  private pathBlockedByCurrentContext(): boolean {
    return this.pathInvalidated;
  }

  /**
   * Try A* against current occupancy (incl. peers). Commit only if forced
   * (parked block / peers gone) or the candidate is clearly shorter.
   */
  private maybeOptimizePath(force: boolean): void {
    if (this.operatorPaused) return;
    if (!this.goal) return;
    if (!this.canOptimizeAgainstPeers() && !force) return;
    // Even force must not run under FMS STOP — wait for signal.
    if (this.traffic?.trafficStatus() === "stop") return;

    const now = Date.now();
    const minGap = force ? Math.min(400, SIM_PEER_REPLAN_MIN_MS) : SIM_PEER_REPLAN_MIN_MS;
    if (now - this.lastPeerReplanMs < minGap) return;

    this.lastPeerReplanMs = now;
    if (this.pathBlockedByPeers()) this.activatePeerDetourBudget();
    this.requestCurrentGoalPlan(force ? "peer-force" : "peer-opt", (planned) => {
      if (!planned?.follow.length || !this.goal) {
        if (force) this.phase = "hold";
        return;
      }
      if (this.peerDetourBudgetStillApplies() || this.pathBlockedByPeers()) {
        const budget = this.evaluatePeerDetour(planned.follow);
        if (!budget.accepted) {
          this.markPeerDetourRejected();
          this.emitDetourRejected(budget, DetourFallbacks.code["step-back-request"]);
          this.startReverseAlongTrail(REASON_CODES.code["detour-too-long"]);
          return;
        }
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
      // New geometry needs a fresh lease — drop old corridor so we don't follow
      // outside held and thrash hold/follow.
      this.traffic?.clear();
      this.commitPlan(planned.follow, planned.display, this.goal.theta, force ? "peer-force" : "peer-opt");
    });
  }

  private applyMergedObstacles(replan: boolean): void {
    // A true static-map change separates an environment replan from the
    // peer-detour decision. Identical snapshots leave the rejection in force.
    this.peerDetourBudgetStillApplies();
    this.peerObstacles = this.reversing
      ? this.peerBodyObstacles
      : [...this.peerBodyObstacles, ...this.peerPlanObstacles];
    this.obstacles = [...this.uiObstacles, ...this.peerObstacles, ...this.evasionHintObstacles];
    setExtraBlocked(this.obstacles.length ? this.obstacleMask.rasterize(this.obstacles) : null);
    // Bind exact geometry after publishing the matching raster revision. The
    // planner uses this ordering to reject stale geometry/mask combinations.
    setPlanningObstacles(this.obstacles);
    // Peer snapshots arrive at the sensing rate and have their own bounded
    // path check. Run the full remaining-route geometry check when a UI/map
    // snapshot explicitly requests a replan, avoiding an O(path × obstacle)
    // scan on every peer heartbeat.
    if (replan && this.goal && this.path.length > this.pathIndex && !this.routeValidAgainstCurrentContext(this.path.slice(this.pathIndex))) {
      this.pathInvalidated = true;
    }
    if (!this.operatorPaused && !this.reversing && replan && this.goal && (this.phase !== "idle" || this.pendingPlan !== null)) this.replan();
  }

  canPlace(candidate: DynObstacle): { ok: boolean; reason: ObstaclePlacementReason } {
    if (poseHitsObstacle(this.x, this.y, this.theta, candidate, PLAN_INFLATE_PX)) {
      return { ok: false, reason: ObstaclePlacementReasons.code.current };
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
          return { ok: false, reason: ObstaclePlacementReasons.code.lookahead };
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
    if (cmd.command_id && this.lastCommandId === cmd.command_id) {
      this.sendCommandState?.({ command_id: cmd.command_id, state: this.commandState, reason: this.commandReason });
      return;
    }
    if (this.operatorPaused) {
      if (cmd.command_id) this.sendCommandState?.({ command_id: cmd.command_id, state: "rejected", reason: REASON_CODES.code.operator_paused });
      return;
    }
    if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y) || !Number.isFinite(cmd.theta)) {
      if (this.goal && this.commandState !== "completed" && this.commandState !== "cancelled" && this.commandState !== "rejected" && this.commandState !== "failed") {
        this.publishCommand("cancelled", "superseded by invalid command");
        this.goal = null;
        this.trimTrailAfterStepBack();
        this.reversing = false;
        this.stepBack = null;
        this.reversePeerPlans = [];
        this.clearMotion();
      }
      if (cmd.command_id) {
        this.lastCommandId = cmd.command_id;
        this.commandState = "rejected";
        this.commandReason = REASON_CODES.code["invalid pose"];
        this.sendCommandState?.({ command_id: cmd.command_id, state: "rejected", reason: REASON_CODES.code["invalid pose"] });
      }
      return;
    }
    if (this.goal && this.commandState !== "idle" && this.commandState !== "completed" && this.commandState !== "cancelled" && this.commandState !== "rejected") {
      this.publishCommand("cancelled", "superseded");
    }
    this.trimTrailAfterStepBack();
    this.reversing = false;
    this.stepBack = null;
    this.evasionResumeGoal = null;
    this.goal = { ...cmd };
    this.originalCommandRoute = null;
    this.originalCommandStaticContext = null;
    this.originalRouteProgressPx = 0;
    this.activePathIsOriginal = false;
    this.clearPeerDetourBudget();
    this.pathInvalidated = false;
    this.lastBlockedReplanMs = 0;
    if (cmd.command_id) this.lastCommandId = cmd.command_id;
    this.publishCommand("accepted");
    this.applyPlan(cmd.x, cmd.y, cmd.theta);
  }

  private replan(): void {
    if (!this.goal) return;
    this.applyPlan(this.goal.x, this.goal.y, this.goal.theta, this.peerDetourBudgetStillApplies());
  }

  private applyPlan(x: number, y: number, theta: number, enforcePeerBudget = false): void {
    this.requestPlan({ x: this.x, y: this.y }, { x, y }, "drive", (planned) => {
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
      if (enforcePeerBudget) {
        const budget = this.evaluatePeerDetour(planned.follow);
        if (!budget.accepted) {
          this.markPeerDetourRejected();
          this.emitDetourRejected(budget, DetourFallbacks.code["step-back-request"]);
          this.startReverseAlongTrail(REASON_CODES.code["detour-too-long"]);
          return;
        }
        this.clearPeerDetourRejection();
      }
      this.commitPlan(planned.follow, planned.display, theta, "drive");
    });
  }

  private requestCurrentGoalPlan(reason: string, onResult: (planned: RoutePlan | null) => void, onCancel?: () => void): boolean {
    if (!this.goal) return false;
    // Tick-driven retry checks can run while a worker is still calculating.
    // Keep the first request; repeatedly cancelling/restarting it recreates
    // the original replan storm without changing the route.
    if (this.pendingPlan) return true;
    return this.requestPlan({ x: this.x, y: this.y }, { x: this.goal.x, y: this.goal.y }, reason, onResult, onCancel);
  }

  private requestPlan(start: Point, goal: Point, reason: string, onResult: (planned: RoutePlan | null) => void, onCancel?: () => void): boolean {
    this.cancelPendingPlan();
    const requestId = this.planningGeneration;
    const commandId = this.lastCommandId;
    const input: Omit<PlanningRequest, "requestId" | "timeBudgetMs"> = {
      mapId: MAP_ID,
      start: { ...start },
      goal: { ...goal },
      zones: this.semanticSnapshotZones.map((zone) => ({ ...zone, polygon: zone.polygon.map((p) => ({ ...p })) })),
      obstacles: this.obstacles.map((obstacle) => ({ ...obstacle })),
    };
    const started = performance.now();
    const emit = (event: PlanningEvent) => this.planningEventHandler?.({ ...event, commandId });
    emit({ requestId, phase: "requested", reason, mapId: input.mapId, start: input.start, goal: input.goal, async: Boolean(this.asyncPlanner) });
    if (!this.asyncPlanner) {
      let planned: RoutePlan | null = null;
      let error: string | undefined;
      try { planned = planRoute(start, goal); }
      catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
      emit({ requestId, phase: planned ? "completed" : "failed", reason, mapId: input.mapId, start: input.start, goal: input.goal, async: false, durationMs: performance.now() - started, resultPoints: planned?.follow.length, error, failureReason: planned ? undefined : (error ? "worker_error" : "no_route") });
      onResult(planned);
      return false;
    }
    const generation = this.planningGeneration;
    // A route result is anchored at `start`. Freeze an already moving robot
    // while it is pending so the committed path cannot begin behind the
    // robot and command it to backtrack to the old request pose.
    if (this.phase === "follow" || this.phase === "reverse" || this.phase === "rotate") {
      this.phase = "hold";
      this.status = "move";
    }
    const handle = this.asyncPlanner.request(input);
    this.pendingPlan = { generation, handle, onCancel };
    void handle.promise.then((planned) => {
      if (!this.pendingPlan || this.pendingPlan.generation !== generation || this.planningGeneration !== generation) {
        const failure = handle.getFailure?.();
        emit({ requestId, phase: "discarded", reason, mapId: input.mapId, start: input.start, goal: input.goal, async: true, durationMs: performance.now() - started, error: failure?.message, failureReason: failure?.kind });
        return;
      }
      this.pendingPlan = null;
      // Preserve the worker outcome while paused. Evaluating stale geometry
      // or committing a replacement path here would violate the pause latch;
      // resume flushes this exact callback after its safety checks.
      if (this.operatorPaused) {
        this.deferredPlanResult = () => {
          if (!this.goal || this.planningGeneration !== generation) return;
          this.finishPlanResult(planned, handle, requestId, commandId, reason, input, start, goal, onResult, onCancel, started, generation);
        };
        this.deferredPlanCancel = onCancel ?? null;
        return;
      }
      this.finishPlanResult(planned, handle, requestId, commandId, reason, input, start, goal, onResult, onCancel, started, generation);
    });
    return true;
  }

  private finishPlanResult(
    planned: RoutePlan | null,
    handle: PlanningHandle,
    requestId: number,
    commandId: string,
    reason: string,
    input: Omit<PlanningRequest, "requestId" | "timeBudgetMs">,
    start: Point,
    goal: Point,
    onResult: (planned: RoutePlan | null) => void,
    onCancel: (() => void) | undefined,
    started: number,
    generation: number,
  ): void {
      const emit = (event: PlanningEvent) => this.planningEventHandler?.({ ...event, commandId });
      const failure = handle.getFailure?.();
      const poseDrift = Math.hypot(this.x - start.x, this.y - start.y);
      const routeStale = planned && (poseDrift > PLANNING_START_DRIFT_TOLERANCE_PX || !this.routeValidAgainstCurrentContext(planned.follow));
      if (routeStale) {
        this.pathInvalidated = true;
        const error = poseDrift > PLANNING_START_DRIFT_TOLERANCE_PX
          ? `robot pose moved ${poseDrift.toFixed(2)}px while planning`
          : "latest obstacle context invalidated route";
        emit({ requestId, phase: "discarded", reason: `${reason}:stale-context`, mapId: input.mapId, start: input.start, goal: input.goal, async: true, durationMs: performance.now() - started, error, failureReason: "stale_context" });
        // One immediate refresh uses the latest peer/environment snapshot.
        // If that result is also stale, leave the mission in HOLD and let the
        // normal tick retry path provide coalescing/back-pressure.
        if (!reason.endsWith(":refresh") && this.goal) {
          const currentGoal = { x: this.goal.x, y: this.goal.y };
          if (!this.operatorPaused) this.requestPlan({ x: this.x, y: this.y }, currentGoal, `${reason}:refresh`, onResult, onCancel);
        } else {
          if (this.goal) {
            this.phase = "hold";
            this.status = "move";
          }
          // A stale terminal result is still a conclusion for its caller;
          // evasion rounds use this to send exactly one NONE response.
          onResult(null);
        }
        return;
      }
      emit({ requestId, phase: planned ? "completed" : "failed", reason, mapId: input.mapId, start: input.start, goal: input.goal, async: true, durationMs: performance.now() - started, resultPoints: planned?.follow.length, error: planned ? undefined : (failure?.message ?? failure?.kind ?? "no_route"), failureReason: planned ? undefined : (failure?.kind ?? "no_route") });
      onResult(planned);
  }

  private cancelPendingPlan(): void {
    this.planningGeneration += 1;
    this.deferredPlanResult = null;
    const deferredCancel = this.deferredPlanCancel;
    this.deferredPlanCancel = null;
    deferredCancel?.();
    const pending = this.pendingPlan;
    this.pendingPlan = null;
    pending?.handle.cancel();
    pending?.onCancel?.();
  }

  private commitPlan(follow: Point[], display: Point[], theta: number, reason: string): void {
    if (!this.originalCommandRoute && reason === "drive" && this.goal) {
      const start = { x: this.x, y: this.y };
      this.originalCommandRoute = [start, ...follow.filter((point, index) => index > 0 || Math.hypot(point.x - start.x, point.y - start.y) > 1e-6).map((point) => ({ ...point }))];
      this.originalCommandStaticContext = this.staticNavigationContextKey();
      this.originalRouteProgressPx = 0;
      this.activePathIsOriginal = true;
    } else {
      this.activePathIsOriginal = false;
    }
    this.path = follow;
    this.displayPath = display;
    this.pathDirty = true;
    this.pathIndex = 0;
    this.pathInvalidated = false;
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
    this.cancelPendingPlan();
    if (this.goal) this.publishCommand("cancelled", "cancelled");
    this.goal = null;
    this.originalCommandRoute = null;
    this.originalCommandStaticContext = null;
    this.originalRouteProgressPx = 0;
    this.activePathIsOriginal = false;
    this.clearPeerDetourBudget();
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
    this.trimTrailAfterStepBack();
    this.reversing = false;
    this.stepBack = null;
    this.clearMotion();
    this.traffic?.clear();
    if (!resume) {
      this.originalCommandRoute = null;
      this.originalCommandStaticContext = null;
      this.originalRouteProgressPx = 0;
      this.activePathIsOriginal = false;
      this.clearPeerDetourBudget();
    }
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
    if (this.teleporterBlocks.some(block => footprintTouchesPolygon(x, y, theta, block.polygon))) return false;
    if (this.traffic && !this.traffic.poseAllowed(x, y, theta)) return false;
    const changed = Math.hypot(x - this.x, y - this.y) > 1e-9 || Math.abs(shortestDelta(this.theta, theta)) > 1e-9;
    if (!changed) return false;
    const traveled = Math.hypot(x - this.x, y - this.y);
    this.x = x;
    this.y = y;
    this.theta = wrapAngle(theta);
    if (this.reversing && this.originalCommandRoute) {
      const projection = projectPointOnPolyline(this.originalCommandRoute, { x, y }, 0, this.originalRouteProgressPx);
      if (projection && projection.distancePx <= 3 && Math.abs(projection.progressPx - this.originalRouteProgressPx) <= Math.max(2, traveled * 2)) {
        this.originalRouteProgressPx = projection.progressPx;
      }
    } else if (this.activePathIsOriginal && this.originalCommandRoute) {
      const projection = projectPointOnPolyline(this.originalCommandRoute, { x, y }, this.originalRouteProgressPx);
      // Only count progress while tracking the original path closely. An
      // off-route projection during a detour must not ratchet the reference.
      if (projection && projection.distancePx <= 3) this.originalRouteProgressPx = Math.max(this.originalRouteProgressPx, projection.progressPx);
    }
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

  /** Replan a route invalidated by a current obstacle, with back-pressure. */
  private retryInvalidPath(reason = "obstacle-retry"): void {
    if (!this.goal || this.pendingPlan || this.reversing) return;
    if (this.traffic?.trafficStatus() === "stop") return;
    const now = Date.now();
    if (now - this.lastBlockedReplanMs < 800) return;
    this.lastBlockedReplanMs = now;
    if (this.pathBlockedByPeers()) this.activatePeerDetourBudget();
    this.requestCurrentGoalPlan(reason, (planned) => {
      if (!this.goal || !planned?.follow.length || !this.routeValidAgainstCurrentContext(planned.follow)) {
        this.pathInvalidated = true;
        this.phase = "hold";
        this.status = "move";
        return;
      }
      if (this.pathBlockedByPeers() || this.peerDetourBudgetStillApplies()) {
        const budget = this.evaluatePeerDetour(planned.follow);
        if (!budget.accepted) {
          this.markPeerDetourRejected();
          this.emitDetourRejected(budget, DetourFallbacks.code["step-back-request"]);
          this.startReverseAlongTrail(REASON_CODES.code["detour-too-long"]);
          return;
        }
        this.clearPeerDetourRejection();
      }
      this.commitPlan(planned.follow, planned.display, this.goal.theta, reason);
    });
  }

  private teleporterBlocksPose(x: number, y: number, theta: number): boolean {
    return this.teleporterBlocks.some(block => footprintTouchesPolygon(x, y, theta, block.polygon));
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
    if (this.pathBlockedByCurrentContext()) return false;
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
    if (this.operatorPaused) {
      // Keep telemetry, local-plan publication and traffic STOP polling alive,
      // while preventing both translation and rotation from this tick.
      this.status = this.goal ? "move" : "idle";
      this.traffic?.onTick(this.motionSnap());
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
      this.phase = this.goal ? "hold" : "idle";
      this.status = this.goal ? "move" : "idle";
      this.traffic.latchFreeze?.(this.x, this.y);
      this.traffic.onTick(this.motionSnap());
      return;
    }

    // VACATE uses a frozen breadcrumb route in timed, map-resolution-aligned
    // trials. This runs before generic HOLD/replan logic so repeated snapshots
    // cannot skip the configured observation window or A*-shortcut the route.
    if (this.stepBack) {
      this.tickStepBack(dt);
      return;
    }

    // Do not resume the old path while an async replanning result is pending.
    // The result is anchored at the request pose; moving on the old route
    // would make its first point a backtracking command.
    if (this.pendingPlan) {
      this.phase = this.goal ? "hold" : "idle";
      this.status = this.goal ? "move" : "idle";
      this.traffic?.onTick(this.motionSnap());
      return;
    }

    if (this.phase === "hold" && this.pathIndex >= this.path.length && !this.missionReached()) {
      this.retryTrueGoal("goal-retry");
    }

    if (this.phase === "hold" && this.pathBlockedByCurrentContext()) {
      this.pathInvalidated = true;
      this.retryInvalidPath();
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
    if (this.reversing) return;
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

    const beforeX = this.x;
    const beforeY = this.y;
    const moved = this.tryMove(nx, ny, nextTheta);
    // A rotation-only fallback is valid when the target itself is a pure
    // heading change. During translation, however, it means the requested
    // motion was blocked; treating it as progress leaves the robot turning in
    // place forever while the old path remains active.
    if (moved && dist > 1e-6 && Math.hypot(this.x - beforeX, this.y - beforeY) <= 1e-9) {
      this.pathInvalidated = true;
      this.phase = "hold";
      this.status = "move";
      this.retryInvalidPath();
      return;
    }
    if (!moved) {
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
      if (this.teleporterBlocksPose(nx, ny, nextTheta)) {
        this.phase = "hold";
        this.status = "move";
        return;
      }
      if (poseHitsAny(nx, ny, nextTheta, this.obstacles)) {
        this.pathInvalidated = true;
        this.phase = "hold";
        this.status = "move";
        this.retryInvalidPath();
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
      if (this.goal?.kind === "teleporter_clearing") {
        this.teleporterClearingActive = false;
        this.teleporterTransferActive = false;
      }
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
