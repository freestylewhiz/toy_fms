import { NavigationModes, PathPlanningAuthorities } from "../../../shared/config/robot.ts";
import { RuntimeAuditActions } from "../../../shared/config/fms.ts";
import type { FmsControlState } from "../../../shared/robotRuntime.ts";
import { EVENT_KINDS } from "../../../shared/config/events.ts";
import { REASON_CODES } from "../../../shared/config/reasons.ts";
import { ZoneKinds, SceneKinds } from "../../../shared/config/resource.ts";
import { REPLY_KINDS } from "../../../shared/config/messages.ts";
import { OPERATION_KINDS } from "../../../shared/config/messages.ts";
import { Client, Room } from "@colyseus/core";
import { existsSync } from "node:fs";
import { Recorder } from "../blackbox/recorder.ts";
import { BlackboxQuery, BlackboxHttpError } from "../blackbox/query.ts";
import { OperationTrace, currentOperationId, commandOperationId } from "../blackboxIntegration.ts";
import type { BlackboxRecorder } from "../../../shared/blackbox.ts";
import type { BlackboxCategory } from "../../../shared/blackbox.ts";
import { invalidateEmptyRoomSnapshot } from "../serializer/FreshSchemaSerializer.ts";
import { isFree, isInflatedFree, loadSeed, robotFootprintClear } from "../../../shared/occupancy.ts";
import { editorStore } from "../../../shared/store.ts";
import {
  broadcastObstacles,
  broadcastSensedPeers,
  broadcastFleetLocalPlans,
  broadcastSemanticSnapshot,
  isRobotConnected,
  queryPlace,
  sendBidRequest,
  sendCancel,
  sendDrive,
  sendEvasionRequest,
  sendLeaseGrant,
  sendTrafficStopStatus,
  sendZoneUpdate,
  setBidSink,
  setDisconnectSink,
  setEvasionReplySink,
  setTrafficStopCheckSink,
  setLeaseReleaseSink,
  setLeaseRequestSink,
  setCommandStateSink,
  setKnownRobotIds,
  setObstacleProvider,
  setSemanticProvider,
  setPoseSink,
  setRegisterSink,
  setRegisterGuard,
  setLocalPlanSink,
  setControlProvider,
  setControlGuard,
  setControlAckSink,
  setMotionPauseAckSink,
  setPoseOverrideAckSink,
  setProtocolTrace,
  setTeleporterTransferSink,
  sendControlState,
  sendMotionPause,
  sendPoseOverride,
  sendTeleporterTransfer,
  sendCommittedTeleporterTransfer,
  sendTeleporterConstraints,
  getRobotSessionId,
  type ControlAck,
  type MotionPauseAck,
  type PoseOverrideAck,
} from "../grpc/robotBridge.ts";
import { FloorState, Obstacle, PathPoint, Robot } from "../schema.ts";
import { hydrateEditor, persistAndSetCharger, persistAndSetObstacle, persistAndSetWaypoint, persistDelete } from "../editorSync.ts";
import { handleEditorDelete, handleEditorUpsert } from "../editorHandlers.ts";
import {
  clampObstaclePos,
  clampObstacleSize,
  parseObstacleKind,
  type DynObstacle,
  poseHitsAny,
} from "../../../shared/obstacles.ts";
import {
  MAP_ID,
  FMS_PORT_OFFSET,
  ROBOT_LENGTH_PX,
  ROBOT_WIDTH_PX,
  PIXEL_CM,
  SIM_PEER_SENSING_DEFAULT,
  SIM_PEER_SENSING_HZ,
  TRAFFIC_POLICY_ID,
} from "../../../shared/constants.ts";
import { parseTrafficPolicyId, parseTrafficStatus, type TrafficStatus } from "../../../shared/traffic/types.ts";
import { isTerminalCommandState, SESSION_TIMEOUT_MS, type CommandState } from "../../../shared/robotProtocol.ts";
import { endpointClearingPathBlocked, poseOverlapsRobotBodies } from "../teleporterSafety.ts";
import { parseWorkState, parseDriveState, parseDriveContexts, type DriveContext, type ResourceOccupancy, type RuntimeAck } from "../../../shared/robotRuntime.ts";
import { projectCommandState } from "../commandProjection.ts";
import { isSemanticPoseBlocked } from "../../../shared/semanticNavigation.ts";
import { robotViewFromPose, TrafficController } from "../traffic/index.ts";
import { RuntimeStore, runtimeSqlitePathForMap, type RobotRuntime } from "../runtimeStore.ts";
import { TeleporterStore, type StoredTeleporter } from "../teleporterStore.ts";
import { advanceTeleporterTransfer, endpointFor, endpointPolygonOverlaps, oppositeEndpoint, type TeleporterTransfer } from "../../../shared/teleporterRuntime.ts";
import { RUNTIME_MAPS } from "../../../shared/maps.ts";

type RobotTrafficExtras = {
  motion: string;
  avoidanceMode: boolean;
  headRoomPx: number;
  localPath: { x: number; y: number }[];
  reportedTrafficStatus: TrafficStatus;
  localPlanUpdatedAt: number;
};

type PlacePayload = { id?: unknown; name?: unknown; x?: unknown; y?: unknown; theta?: unknown };
type MoveAssetPayload = {
  kind?: unknown;
  id?: unknown;
  x?: unknown;
  y?: unknown;
  theta?: unknown;
};
type CommandPayload = {
  robotId?: unknown;
  kind?: unknown;
  targetId?: unknown;
  x?: unknown;
  y?: unknown;
  theta?: unknown;
  endpointId?: unknown;
};
type CancelPayload = { robotId?: unknown };
type PoseOverridePayload = { testOnly?: unknown; robotId?: unknown; mapId?: unknown; requestId?: unknown; expectedEpoch?: unknown; x?: unknown; y?: unknown; theta?: unknown };
type ObstaclePayload = { kind?: unknown; x?: unknown; y?: unknown; size?: unknown; theta?: unknown };
type MoveObstaclePayload = { id?: unknown; x?: unknown; y?: unknown; size?: unknown; theta?: unknown };
type DeleteObstaclePayload = { id?: unknown };
type MotionPausePayload = { robotId?: unknown; requestId?: unknown; paused?: unknown; expectedEpoch?: unknown };

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function deny(client: Client, message: string) {
  client.send(REPLY_KINDS.code.error, { message });
}

export class FloorRoom extends Room<FloorState> {
  state = new FloorState();
  patchRate = 50;
  maxClients = 32;
  autoDispose = false;

  private traffic!: TrafficController;
  private robotTraffic = new Map<string, RobotTrafficExtras>();
  private lastSensedPeersMs = 0;
  private lastFleetPlanMs = 0;
  private runtimeStore!: RuntimeStore;
  private runtimeStoreOwned = false;
  private runtimeWriteAt = new Map<string, number>();
  private reportSequence = 0;
  private reports = new Map<string, { workState: string; driveState: string; contexts: DriveContext[]; epoch: number; sessionId: string; receivedAt: number; sequence: number }>();
  private occupancies: ResourceOccupancy[] = [];
  private activations = new Map<string, { client: Client; requestId: string; epoch: number; startedAt: number; timer: ReturnType<typeof setTimeout>; poseOverride?: boolean }>();
  private poseOverrides = new Map<string, { client: Client; requestId: string; epoch: number; x: number; y: number; theta: number; startedAt: number; timer: ReturnType<typeof setTimeout>; ackAfterSequence?: number }>();
  private poseOverrideCapable = new Set<string>();
  private runtimeReplies = new Map<string, RuntimeAck>();
  private poseOverrideReplies = new Map<string, { requestId: string; accepted: boolean; reason: string; pose?: { mapId: string; x: number; y: number; theta: number }; controlEpoch?: number }>();
  private motionPausePending = new Map<string, { client?: Client; requestId: string; paused: boolean; previousDesired: boolean; epoch: number; sessionId: string; timer: ReturnType<typeof setTimeout> }>();
  private motionPauseReplies = new Map<string, Record<string, unknown>>();
  private teleporterStore!: TeleporterStore;
  private teleporterEnabled = false;
  private teleporterPoller?: ReturnType<typeof setInterval>;
  private teleporterTransfers = new Map<string, TeleporterTransfer>();
  private trace?: OperationTrace;
  private traceTimer?: ReturnType<typeof setInterval>;
  private traceRobotStates = new Map<string, string>();
  private traceFrame = "";
  private blackboxQuery!: BlackboxQuery;
  private disposed = false;

  onCreate(options?: { runtimeStore?: RuntimeStore; runtimeDbPath?: string; teleporterStore?: TeleporterStore; teleporterDbPath?: string; blackbox?: BlackboxRecorder }) {
    this.state.mapId = MAP_ID;
    const recorder = options?.blackbox ?? (!options?.runtimeStore && process.env.FMS_BLACKBOX !== "0" ? new Recorder({ source: `fms-${MAP_ID}`, mapId: MAP_ID }) : undefined);
    if (recorder) this.trace = new OperationTrace(recorder, () => this.captureBlackbox(), (kind, payload) => this.eventContext(kind, payload));
    const traceMessage = (kind: string, handler: (client: any, payload: any) => unknown) => this.onMessage(kind, (client, payload) =>
      this.trace ? this.trace.run(client, kind, payload, handler, (() => {
        const id = commandOperationId(this.state.robots.get(str((payload as any)?.robotId))?.commandId ?? "");
        return id ? [id] : [];
      })()) : handler(client, payload));
    setProtocolTrace(this.trace ? (direction, robotId, message, reason) => this.trace?.protocol(direction, robotId, message, reason) : null);
    // Colyseus 0.16 drops empty-room patches without invalidating its cached
    // full state. Preserve the existing encoder/reference IDs and refresh only
    // the full-state cache for the next visitor.
    this.onBeforePatch = () => invalidateEmptyRoomSnapshot(this);
    const teleporterEnabled = !options?.runtimeStore || Boolean(options.teleporterStore || options.teleporterDbPath);
    this.teleporterEnabled = teleporterEnabled;
    this.runtimeStoreOwned = !options?.runtimeStore;
    this.runtimeStore = options?.runtimeStore ?? new RuntimeStore(options?.runtimeDbPath);
    this.blackboxQuery = new BlackboxQuery();
    this.teleporterStore = options?.teleporterStore ?? new TeleporterStore(options?.teleporterDbPath ?? (options?.runtimeStore ? ":memory:" : undefined));
    // Reconcile a crash between the local runtime transaction and the shared
    // teleporter ledger. Disabled robots must not retain a stale claim.
    for (const pending of this.runtimeStore.listRecoveryPending()) {
      this.teleporterStore.forceReleaseRobot(pending.robotId, pending.controlEpoch, "operator_disabled_reconcile");
      this.runtimeStore.clearRecoveryPending(pending.robotId, pending.controlEpoch);
    }
    if (teleporterEnabled) {
      this.refreshTeleporters();
      this.teleporterPoller = setInterval(() => this.refreshTeleporters(), 500);
      this.teleporterPoller.unref();
    }
    const seed = loadSeed();
    hydrateEditor(this.state, editorStore().snapshot());
    for (const rb of seed.robots) {
      // The robot is the same physical identity before and after a
      // teleporter handoff. Map prefixes create a second native row at the
      // destination and leave the transferred row visible beside it.
      const robotId = rb.id;
      const item = new Robot();
      item.id = robotId;
      item.x = rb.x;
      item.y = rb.y;
      item.theta = rb.theta;
      item.status = rb.status === "move" ? "move" : "idle";
      const saved = this.runtimeStore.getRobot(robotId) ?? this.runtimeStore.getRobot(rb.id);
      if (saved && saved.robotId !== robotId) this.runtimeStore.upsertRobot({ ...saved, robotId });
      if (saved) {
        item.x = saved.x ?? item.x; item.y = saved.y ?? item.y; item.theta = saved.theta ?? item.theta;
        item.workState = "unknown"; item.fmsControlState = saved.fmsControlState;
        item.connectionState = "offline"; item.connectionReason = REASON_CODES.code['server restarted'];
        item.driveState = "unknown"; item.driveContextJson = saved.driveContextJson;
        item.controlEpoch = saved.controlEpoch; item.controlReady = false; item.reportedAt = saved.reportedAt;
        item.stateChangedAt = saved.stateChangedAt; item.sessionId = saved.sessionId;
        item.navigationMode = saved.navigationMode; item.pathPlanningAuthority = saved.pathPlanningAuthority;
        item.operatorPauseDesired = saved.operatorPaused === true; item.operatorPaused = false;
      }
      this.state.robots.set(robotId, item);
      this.robotTraffic.set(robotId, { motion: "", avoidanceMode: true, headRoomPx: 0, localPath: [], reportedTrafficStatus: "clear", localPlanUpdatedAt: 0 });
      this.persistRobot(robotId, true);
    }
    // A transferred robot may not exist in this map's native seed. Hydrate it
    // from the durable runtime row only when the shared owner says this map is
    // the current owner; this preserves disabled state and control epoch.
    for (const saved of this.runtimeStore.listRobots()) {
      if (this.state.robots.has(saved.robotId)) continue;
      const owner = this.teleporterStore.getRobotOwner(saved.robotId);
      if (!owner || owner.mapId !== MAP_ID) continue;
      const item = new Robot();
      item.id = saved.robotId; item.x = saved.x ?? 0; item.y = saved.y ?? 0; item.theta = saved.theta ?? 0;
      item.workState = "unknown"; item.fmsControlState = saved.fmsControlState; item.connectionState = "offline"; item.connectionReason = REASON_CODES.code['server restarted'];
      item.driveState = "unknown"; item.driveContextJson = saved.driveContextJson; item.controlEpoch = saved.controlEpoch; item.controlReady = false;
      item.reportedAt = saved.reportedAt; item.stateChangedAt = saved.stateChangedAt; item.sessionId = saved.sessionId; item.navigationMode = saved.navigationMode; item.pathPlanningAuthority = saved.pathPlanningAuthority;
      item.operatorPauseDesired = saved.operatorPaused === true; item.operatorPaused = false;
      this.state.robots.set(item.id, item);
      this.robotTraffic.set(item.id, { motion: "", avoidanceMode: true, headRoomPx: 0, localPath: [], reportedTrafficStatus: "clear", localPlanUpdatedAt: 0 });
    }
    for (const robot of this.state.robots.values()) this.applyAdministrativeControl(robot);
    setKnownRobotIds(() => this.state.robots.keys());
    setRegisterGuard((robotId, mapId, transferId) => this.allowTransferredRegistration(robotId, mapId, transferId));

    this.publishOccupancies(this.runtimeStore.listOccupancies());
    setControlProvider(id => ({ enabled: this.activations.has(id) || this.state.robots.get(id)?.fmsControlState === "enabled", controlEpoch: this.state.robots.get(id)?.controlEpoch ?? 0, operatorPaused: this.state.robots.get(id)?.operatorPauseDesired === true }));
    setControlGuard(id => this.canControl(id));
    setControlAckSink((id, ack) => this.onControlAck(id, ack));
    setMotionPauseAckSink((id, ack) => this.onMotionPauseAck(id, ack));
    setPoseOverrideAckSink((id, ack) => this.onPoseOverrideAck(id, ack));
    if (teleporterEnabled) setTeleporterTransferSink(update => this.onTeleporterTransferUpdate(update));
    this.traffic = new TrafficController(
      {
        sendLeaseGrant: (robotId, payload) => {
          sendLeaseGrant(robotId, payload);
        },
        sendBidRequest: (robotId, zoneId, windowMs) => {
          sendBidRequest(robotId, { zone_id: zoneId, window_ms: windowMs });
        },
        sendEvasionRequest: (robotId, payload) => {
          sendEvasionRequest(robotId, payload);
        },
        sendTrafficStopStatus: (robotId, payload) => {
          sendTrafficStopStatus(robotId, payload);
        },
        sendZoneUpdate: (robotId, zoneId, state) => {
          sendZoneUpdate(robotId, { zone_id: zoneId, state });
        },
        setRobotTrafficStatus: (robotId, status) => {
          const robot = this.state.robots.get(robotId);
          if (!robot) return;
          if (!robot.connected) {
            robot.trafficStatus = "lease_lost";
            return;
          }
          const reported = this.robotTraffic.get(robotId)?.reportedTrafficStatus;
          robot.trafficStatus = reported === "hold" && status !== "stop" && status !== "evade" && status !== "lease_lost" ? "hold" : status;
        },
      },
      {
        onRuntimeOccupancies: records => this.publishOccupancies(records),
        getWorld: () => ({
          nowMs: Date.now(),
          robots: [...this.state.robots.entries()].map(([id, r]) => {
            const extras = this.robotTraffic.get(id);
            return robotViewFromPose(id, {
              x: r.x,
              y: r.y,
              theta: r.theta,
              status: r.status,
              trafficStatus: r.trafficStatus,
              path: [...r.path].map((p) => ({ x: p.x, y: p.y })),
              connected: isRobotConnected(id),
              fmsControlState: r.fmsControlState as FmsControlState,
              controlReady: r.controlReady,
              controlEpoch: r.controlEpoch,
              poseObserved: r.reportedAt > 0,
              observedAtMs: r.lastSeenAt,
              localPlanObservedAtMs: extras?.localPlanUpdatedAt,
              sessionId: r.sessionId,
              operatorPaused: r.operatorPaused,
              motion: extras?.motion ?? "",
              avoidanceMode: extras?.avoidanceMode ?? true,
              headRoomPx: extras?.headRoomPx ?? 0,
          localPath: extras?.localPath ?? [],
            });
          }),
          zones: editorStore().snapshot().zones,
        }),
      },
      undefined,
      this.runtimeStore,
    );

    setLeaseRequestSink((robotId, msg) => this.traffic.handleLeaseRequest(robotId, msg));
    setLeaseReleaseSink((robotId, msg) => this.traffic.handleLeaseRelease(robotId, msg));
    setBidSink((robotId, msg) => this.traffic.handleBid(robotId, msg));
    setEvasionReplySink((robotId, msg) => this.traffic.handleEvasionReply(robotId, msg));
    setTrafficStopCheckSink((robotId, msg) => this.traffic.handleTrafficStopCheck(robotId, msg));
    setRegisterSink((robotId, capabilities) => {
      if (this.activations.has(robotId)) this.failActivation(robotId, "새 연결이 시작되어 운영 재개를 취소했습니다.");
      if (this.poseOverrides.has(robotId)) this.failPoseOverride(robotId, "새 연결이 시작되어 테스트 위치 지정을 취소했습니다.");
      if (capabilities.supportsPoseOverride) this.poseOverrideCapable.add(robotId);
      else this.poseOverrideCapable.delete(robotId);
      this.traffic.onRobotConnected(robotId);
      const robot = this.state.robots.get(robotId);
      if (robot) {
        robot.connected = true; robot.connectionState = "online"; robot.connectionReason = REASON_CODES.code.synchronizing;
        robot.controlReady = false; robot.lastSeenAt = 0; robot.sessionId = getRobotSessionId(robotId) ?? "";
        robot.operatorPauseDesired = this.runtimeStore.getRobot(robotId)?.operatorPaused ?? robot.operatorPauseDesired;
        robot.operatorPausePending = false; robot.operatorPauseReason = REASON_CODES.code.synchronizing;
        this.clearOperationalState(robot);
        this.reports.delete(robotId);
        this.persistRobot(robotId, true);
        this.publishTeleporterConstraints(robotId);
        // RobotBridge emits session_ready/control_state immediately after this
        // callback. Queue the actuator request behind that bootstrap envelope.
        const sync = setTimeout(() => this.syncMotionPause(robotId), 0); sync.unref?.();
      }
    });

    setPoseSink((pose) => {
      const robot = this.state.robots.get(pose.robotId);
      if (!robot) return;
      if (pose.localPath !== undefined) {
        const prev = this.robotTraffic.get(pose.robotId) ?? {
          motion: "",
          avoidanceMode: true,
          headRoomPx: 0,
          localPath: [],
          reportedTrafficStatus: "clear" as TrafficStatus,
          localPlanUpdatedAt: 0,
        };
        this.robotTraffic.set(pose.robotId, { ...prev, localPath: pose.localPath, localPlanUpdatedAt: Date.now() });
        robot.localPath.clear();
        for (const p of pose.localPath) { const pt = new PathPoint(); pt.x = p.x; pt.y = p.y; robot.localPath.push(pt); }
        if (pose.localHorizonS !== undefined) robot.localHorizonS = pose.localHorizonS;
        this.maybeBroadcastFleetLocalPlans();
        return;
      }
      if (pose.path !== undefined) {
        robot.path.clear();
        for (const p of pose.path) {
          const pt = new PathPoint();
          pt.x = p.x;
          pt.y = p.y;
          robot.path.push(pt);
        }
        return;
      }
      robot.x = pose.x;
      robot.y = pose.y;
      robot.theta = pose.theta;
      robot.connected = true;
      robot.lastSeenAt = Date.now();
      robot.connectionState = "online";
      robot.connectionReason = robot.controlReady || robot.fmsControlState === "disabled" ? "" : "synchronizing";
      robot.reportedAt = pose.reportedAt || robot.lastSeenAt;
      const report = { workState: parseWorkState(pose.workState), driveState: parseDriveState(pose.driveState),
        contexts: parseDriveContexts(pose.driveContextJson), epoch: pose.controlEpoch ?? -1,
        sessionId: pose.sessionId ?? "", receivedAt: robot.lastSeenAt, sequence: ++this.reportSequence };
      this.reports.set(robot.id, report);
      robot.navigationMode = ["free_navigation", "graph_navigation"].includes(pose.navigationMode ?? "") ? pose.navigationMode! : "unknown";
      robot.pathPlanningAuthority = ["robot", "fms", "hybrid"].includes(pose.pathPlanningAuthority ?? "") ? pose.pathPlanningAuthority! : "unknown";
      const currentReport = report.epoch === robot.controlEpoch && report.sessionId === robot.sessionId;
      if (pose.operatorPaused !== undefined && currentReport) robot.operatorPaused = pose.operatorPaused;
      if (currentReport && pose.commandId && pose.commandState) this.applyCommandState(robot, pose.commandId, pose.commandState, pose.commandReason ?? "");
      if (pose.motion !== undefined) robot.motion = pose.motion;
      if (currentReport && robot.fmsControlState === "enabled" && pose.leaseId !== undefined) robot.leaseId = pose.leaseId;
      if (pose.headRoomPx !== undefined) robot.headRoomPx = pose.headRoomPx;
      robot.status = pose.status === "move" ? "move" : "idle";
      if (robot.status === "idle" && robot.path.length) robot.path.clear();

      const prev = this.robotTraffic.get(pose.robotId) ?? {
        motion: "",
        avoidanceMode: true,
        headRoomPx: 0,
        localPath: [],
        reportedTrafficStatus: "clear" as TrafficStatus,
        localPlanUpdatedAt: 0,
      };
      this.robotTraffic.set(pose.robotId, {
        motion: pose.motion ?? prev.motion,
        avoidanceMode: pose.avoidanceMode ?? prev.avoidanceMode,
        headRoomPx: pose.headRoomPx ?? prev.headRoomPx,
        localPath: prev.localPath,
        reportedTrafficStatus: pose.trafficStatus !== undefined ? parseTrafficStatus(pose.trafficStatus) : prev.reportedTrafficStatus,
        localPlanUpdatedAt: prev.localPlanUpdatedAt,
      });
      this.projectRuntime(robot);
      this.maybeStartTeleporterTransfer(robot);
      this.maybeReleaseTeleporterOccupancy(robot);
      this.persistRobot(pose.robotId);
      const reported = this.robotTraffic.get(pose.robotId)?.reportedTrafficStatus;
      if (reported === "hold" && robot.trafficStatus !== "stop" && robot.trafficStatus !== "evade" && robot.trafficStatus !== "lease_lost") robot.trafficStatus = "hold";
      this.maybeBroadcastSensedPeers();
      this.maybeBroadcastFleetLocalPlans();
      this.publishTeleporterConstraints(pose.robotId);
      this.maybeConfirmPoseOverride(robot);
    });
    setCommandStateSink((update) => {
      const robot = this.state.robots.get(update.robotId);
      if (robot) this.applyCommandState(robot, update.commandId, update.commandState, update.commandReason);
    });

    setDisconnectSink((robotId) => {
      this.traffic.onRobotDisconnected(robotId);
      const robot = this.state.robots.get(robotId);
      if (!robot) return;
      robot.connected = false;
      robot.connectionState = "offline"; robot.connectionReason = REASON_CODES.code.session_lost; robot.controlReady = false;
      if (this.activations.has(robotId)) this.failActivation(robotId, "연결이 끊겨 운영 재개를 취소했습니다.");
      if (this.poseOverrides.has(robotId)) this.failPoseOverride(robotId, "연결이 끊겨 테스트 위치 지정을 취소했습니다.");
      this.poseOverrideCapable.delete(robotId);
      robot.trafficStatus = "lease_lost";
      if (robot.commandId && !isTerminalCommandState(robot.commandState as CommandState)) {
        robot.commandState = "interrupted";
        robot.commandReason = REASON_CODES.code['robot session disconnected'];
      }
      robot.status = "idle";
      robot.path.clear();
      const extras = this.robotTraffic.get(robotId);
      if (extras) extras.localPath = [];
      robot.localPath.clear();
      robot.localHorizonS = 0;
      this.projectRuntime(robot);
      this.persistRobot(robotId, true);
      console.log(`[floor] ${robotId} disconnected, status idle`);
      this.captureBlackbox();
    });

    traceMessage(OPERATION_KINDS.code.placeWaypoint, (client, payload: PlacePayload) => {
      this.place(client, "waypoint", payload);
    });
    traceMessage(OPERATION_KINDS.code.placeCharger, (client, payload: PlacePayload) => {
      this.place(client, "charger", payload);
    });
    traceMessage(OPERATION_KINDS.code.moveAsset, (client, payload: MoveAssetPayload) => {
      this.moveAsset(client, payload);
    });
    traceMessage(OPERATION_KINDS.code.deleteAsset, (client, payload: { kind?: unknown; id?: unknown }) => {
      const kind = str(payload?.kind);
      const id = str(payload?.id);
      if ((kind !== "waypoint" && kind !== "charger") || !id) {
        deny(client, "invalid deleteAsset");
        return;
      }
      if (!persistDelete(this.state, kind, id)) deny(client, `unknown ${kind} ${id}`);
      else broadcastSemanticSnapshot();
    });
    traceMessage(OPERATION_KINDS.code.editorUpsert, async (client, payload: Record<string, unknown>) => {
      const body = payload ?? {};
      // Property edits obey the same robot placement veto as canvas placement.
      if (body.kind === 'obstacle') {
        const shape = parseObstacleKind(str(body.obstacleKind));
        const x = num(body.x), y = num(body.y), size = num(body.size), theta = num(body.theta);
        if (!shape || x === null || y === null || size === null || theta === null || size < 10 || size > 80) { deny(client, 'invalid obstacle properties'); return; }
        const bounded = clampObstaclePos(x, y);
        if (bounded.x !== x || bounded.y !== y) { deny(client, 'obstacle outside map'); return; }
        const { ok, denied } = await queryPlace({ id: str(body.id) || 'pending', kind: shape, x, y, size, theta });
        if (!ok) { deny(client, `obstacle blocked (${denied.join(', ')})`); return; }
      }
      const id = handleEditorUpsert(this.state, client, body);
      if (id) {
        const kind = str(body.kind);
        if (kind === "obstacle") { this.pushObstacles(); }
        broadcastSemanticSnapshot();
        client.send(REPLY_KINDS.code.editorAck, { kind, id, action: "upsert" });
      }
    });
    traceMessage(OPERATION_KINDS.code.teleporterUpsert, (client, payload: Record<string, unknown>) => this.upsertTeleporter(client, payload));
    traceMessage(OPERATION_KINDS.code.teleporterDelete, (client, payload: Record<string, unknown>) => this.deleteTeleporter(client, payload));
    traceMessage(OPERATION_KINDS.code.editorDelete, (client, payload: Record<string, unknown>) => {
      const body = payload ?? {};
      const kind = str(body.kind), id = str(body.id);
      const existed = id && kind ? persistDelete(this.state, kind, id) : false;
      if (!existed) { handleEditorDelete(this.state, client, body); return; }
      if (kind === "obstacle") this.pushObstacles();
      broadcastSemanticSnapshot();
      client.send(REPLY_KINDS.code.editorAck, { kind, id, action: "delete" });
    });
    traceMessage(OPERATION_KINDS.code.setRobotControl, (client, payload: Record<string, unknown>) => this.setRobotControl(client, payload));
    traceMessage(OPERATION_KINDS.code.robot_motion_pause, (client, payload: MotionPausePayload) => this.requestMotionPause(client, payload));
    this.onMessage(OPERATION_KINDS.code.robot_events_query, async (client, payload: Record<string, unknown>) => this.queryRobotEvents(client, payload));
    traceMessage(OPERATION_KINDS.code.setVirtualRobotPose, (client, payload: PoseOverridePayload) => this.overrideRobotPose(client, payload));
    traceMessage(OPERATION_KINDS.code.releaseResourceOccupancy, (client, payload: Record<string, unknown>) => this.releaseResourceOccupancy(client, payload));
    traceMessage(OPERATION_KINDS.code.commandRobot, (client, payload: CommandPayload) => {
      this.commandRobot(client, payload);
    });
    traceMessage(OPERATION_KINDS.code.cancelRobot, (client, payload: CancelPayload) => {
      this.cancelRobot(client, payload);
    });
    traceMessage(OPERATION_KINDS.code.placeObstacle, (client, payload: ObstaclePayload) => {
      return this.placeObstacle(client, payload);
    });
    traceMessage(OPERATION_KINDS.code.moveObstacle, (client, payload: MoveObstaclePayload) => {
      return this.moveObstacle(client, payload);
    });
    traceMessage(OPERATION_KINDS.code.deleteObstacle, (client, payload: DeleteObstaclePayload) => {
      this.deleteObstacle(client, payload);
    });

    setObstacleProvider(() => this.obstacleList());
    setSemanticProvider(() => editorStore().snapshot());
    this.pushObstacles();
    this.traffic.start();
    if (this.trace) {
      this.captureBlackbox();
      this.traceTimer = setInterval(() => this.captureBlackbox(), 100);
      this.traceTimer.unref();
    }

      console.log(
      `[floor] sqlite + seed: ${this.state.waypoints.size} wp, ${this.state.chargingStations.size} cs, ${seed.robots.length} robots, ${this.state.zones.size} zones, ${this.state.nodes.size} nodes`,
    );
  }

  onJoin() {
    // A map room can stay alive while the other map edits the shared ledger.
    // Refresh before Colyseus serializes this visitor's initial snapshot.
    this.refreshTeleporters();
    invalidateEmptyRoomSnapshot({ clients: [], _serializer: (this as any)._serializer } as any);
  }

  /** Resolve display metadata from authoritative resources at request time. */
  private eventContext(operation: string, payload: any): Record<string, unknown> {
    const commandKind = operation === OPERATION_KINDS.code.commandRobot ? str(payload?.kind) : undefined;
    const resourceKind = commandKind === "move" ? "waypoint" : commandKind === "dock" ? "charger"
      : commandKind === "teleporter" ? "teleporter" : str(payload?.resourceRef?.kind || payload?.resourceKind || payload?.kind);
    const id = str(payload?.targetId || payload?.resourceRef?.id || payload?.resourceId || payload?.zoneId || payload?.id);
    const collections: Record<string, any> = { waypoint: this.state.waypoints, charger: this.state.chargingStations,
      obstacle: this.state.obstacles, node: this.state.nodes, edge: this.state.edges, station: this.state.stations,
      portal: this.state.portals, rail: this.state.rails, zone: this.state.zones };
    const resource = id ? resourceKind === "teleporter" ? this.teleporterStore?.get(id)
      : ZoneKinds.is(resourceKind) ? this.state.zones.get(id) : collections[resourceKind]?.get(id) : undefined;
    return {
      ...(commandKind ? { commandKind } : {}),
      ...(id ? { target: { id, kind: resourceKind || "zone", mapId: MAP_ID, ...(resource?.name ? { name: resource.name } : {}) } } : {}),
      ...(commandKind && resource && Number.isFinite(resource.x) ? { x: resource.x, y: resource.y, theta: resource.theta } : {}),
    };
  }

  private captureBlackbox(): void {
    if (!this.trace) return;
    const map = RUNTIME_MAPS[MAP_ID as keyof typeof RUNTIME_MAPS];
    const state = { ...this.state.toJSON(), mapId: MAP_ID, assets: {
      mapUrl: `/resources/maps/${map.image}`, occupancyUrl: `/resources/maps/${map.prefix}occupancy.bin`,
      inflatedUrl: `/resources/maps/${map.prefix}occupancy_inflated.bin`, width: map.width, height: map.height, pixelCm: PIXEL_CM,
    } };
    const serialized = JSON.stringify(state);
    if (serialized === this.traceFrame) return;
    this.traceFrame = serialized;
    this.trace.recorder.frame(state);
    for (const robot of this.state.robots.values()) {
      const state = { connectionState: robot.connectionState, fmsControlState: robot.fmsControlState, operatorPaused: robot.operatorPaused, operatorPauseDesired: robot.operatorPauseDesired,
        commandId: robot.commandId, commandState: robot.commandState, commandReason: robot.commandReason, controlEpoch: robot.controlEpoch,
        driveState: robot.driveState === "blocked" ? "blocked" : "normal" };
      const value = JSON.stringify(state), previous = this.traceRobotStates.get(robot.id);
      if (previous === value) continue;
      this.traceRobotStates.set(robot.id, value);
      const before = previous ? JSON.parse(previous) : undefined;
      const category = ["failed", "rejected", "interrupted"].includes(robot.commandState) || state.driveState === "blocked" ? "error"
        : before?.connectionState !== state.connectionState ? "connection"
        : before?.fmsControlState !== state.fmsControlState ? "forced" : "operation";
      this.trace.event(category, EVENT_KINDS.code["robot.state_changed"], { robotId: robot.id, commandId: robot.commandId,
        payload: { before, after: state, sessionId: robot.sessionId, reason: robot.commandReason || robot.connectionReason } });
    }
    for (const id of this.traceRobotStates.keys()) if (!this.state.robots.has(id)) {
      this.traceRobotStates.delete(id);
      this.trace.event("environment", EVENT_KINDS.code["robot.map_departed"], { robotId: id, payload: { mapId: MAP_ID } });
    }
  }

  onDispose() {
    this.disposed = true;
    if (this.traceTimer) clearInterval(this.traceTimer);
    for (const pending of this.motionPausePending.values()) clearTimeout(pending.timer);
    this.motionPausePending.clear();
    setProtocolTrace(null);
    this.traffic.stop();
    for (const id of [...this.activations.keys()]) this.failActivation(id, "서버 종료로 운영 재개를 취소했습니다.");
    for (const id of [...this.poseOverrides.keys()]) this.failPoseOverride(id, "서버 종료로 테스트 위치 지정을 취소했습니다.");
    this.captureBlackbox();
    const flushed = this.trace?.recorder.close();
    setControlAckSink(null);
    setMotionPauseAckSink(null);
    setPoseOverrideAckSink(null);
    if (this.teleporterEnabled) setTeleporterTransferSink(null);
    setControlGuard(() => false);
    setControlProvider(() => ({ enabled: false, controlEpoch: 0 }));
    setPoseSink(null);
    setCommandStateSink(null);
    setKnownRobotIds(null);
    setRegisterGuard(null);
    setLocalPlanSink(null);
    setDisconnectSink(null);
    setRegisterSink(null);
    setLeaseRequestSink(null);
    setLeaseReleaseSink(null);
    setBidSink(null);
    setEvasionReplySink(null);
    setObstacleProvider(() => []);
    setSemanticProvider(() => null);
    if (this.runtimeStoreOwned) this.runtimeStore?.close();
    if (this.teleporterPoller) clearInterval(this.teleporterPoller);
    this.teleporterStore?.close();
    return flushed;
  }

  private requestMotionPause(client: Client, payload: MotionPausePayload): void {
    const robotId = str(payload?.robotId), requestId = str(payload?.requestId);
    const paused = payload?.paused === true;
    const expectedEpoch = num(payload?.expectedEpoch);
    const key = `${client.sessionId}:${requestId}`;
    const previous = requestId ? this.motionPauseReplies.get(key) : undefined;
    if (previous) {
      if (previous.robotId === robotId && previous.desired === paused) client.send(REPLY_KINDS.code.robot_motion_pause_result, previous);
      else client.send(REPLY_KINDS.code.robot_motion_pause_result, { requestId, robotId, desired: paused, applied: false, pending: false, ok: false, reasonCode: REASON_CODES.code.request_id_conflict });
      return;
    }
    const robot = this.state.robots.get(robotId);
    if (!robot || !requestId || typeof payload?.paused !== "boolean" || !Number.isSafeInteger(expectedEpoch)) {
      this.replyMotionPause(client, { requestId, robotId, desired: paused, applied: false, pending: false, ok: false, reasonCode: REASON_CODES.code.invalid_request }); return;
    }
    if (robot.controlEpoch !== expectedEpoch) {
      this.replyMotionPause(client, { requestId, robotId, desired: paused, applied: false, pending: false, ok: false, reasonCode: REASON_CODES.code.control_epoch_mismatch, controlEpoch: robot.controlEpoch }); return;
    }
    const owner = this.teleporterStore?.getRobotOwner(robotId);
    if (owner && owner.mapId !== MAP_ID) {
      this.replyMotionPause(client, { requestId, robotId, desired: paused, applied: false, pending: false, ok: false, reasonCode: REASON_CODES.code.wrong_map, controlEpoch: robot.controlEpoch }); return;
    }
    if (this.hasActiveTeleporterTransfer(robotId)) {
      this.replyMotionPause(client, { requestId, robotId, desired: paused, applied: false, pending: false, ok: false, reasonCode: REASON_CODES.code.teleporter_transition }); return;
    }
    const existing = this.motionPausePending.get(robotId);
    if (existing) {
      this.replyMotionPause(client, { requestId, robotId, desired: paused, applied: false, pending: true, ok: false, reasonCode: REASON_CODES.code.request_pending, controlEpoch: robot.controlEpoch }); return;
    }
    const previousDesired = robot.operatorPauseDesired;
    this.runtimeStore.setOperatorPaused(robotId, paused);
    robot.operatorPauseDesired = paused;
    robot.operatorPausePending = true;
    robot.operatorPauseReason = REASON_CODES.code.awaiting_robot_ack;
    this.persistRobot(robotId, true);
    this.beginMotionPause(robotId, requestId, paused, client, previousDesired);
  }

  private beginMotionPause(robotId: string, requestId: string, paused: boolean, client?: Client, previousDesired = paused): void {
    const robot = this.state.robots.get(robotId);
    if (!robot) return;
    const sessionId = getRobotSessionId(robotId) ?? robot.sessionId;
    const timer = setTimeout(() => this.failMotionPause(robotId, requestId, "timeout"), SESSION_TIMEOUT_MS);
    this.motionPausePending.set(robotId, { client, requestId, paused, previousDesired, epoch: robot.controlEpoch, sessionId, timer });
    const sent = sendMotionPause(robotId, { requestId, paused, controlEpoch: robot.controlEpoch });
    if (!sent) this.failMotionPause(robotId, requestId, "offline");
  }

  private syncMotionPause(robotId: string): void {
    if (this.disposed) return;
    const robot = this.state.robots.get(robotId);
    if (!robot || this.motionPausePending.has(robotId)) return;
    const desired = this.runtimeStore.getRobot(robotId)?.operatorPaused ?? robot.operatorPauseDesired;
    robot.operatorPauseDesired = desired;
    robot.operatorPausePending = true;
    robot.operatorPauseReason = REASON_CODES.code.synchronizing;
    this.beginMotionPause(robotId, `pause-sync-${crypto.randomUUID()}`, desired, undefined, desired);
  }

  private onMotionPauseAck(robotId: string, ack: MotionPauseAck): void {
    const robot = this.state.robots.get(robotId), pending = this.motionPausePending.get(robotId);
    if (!robot || !pending || pending.requestId !== ack.requestId || pending.epoch !== robot.controlEpoch || pending.sessionId !== ack.sessionId || ack.controlEpoch !== pending.epoch || ack.paused !== pending.paused) return;
    clearTimeout(pending.timer); this.motionPausePending.delete(robotId);
    robot.operatorPausePending = false;
    robot.operatorPauseReason = ack.applied ? "" : (ack.reasonCode || "rejected");
    if (ack.applied) robot.operatorPaused = ack.paused;
    else {
      // A robot rejection is authoritative for this request only; restore the
      // previous durable intent so a reconnect does not replay a rejected edge.
      robot.operatorPauseDesired = pending.previousDesired;
      this.runtimeStore.setOperatorPaused(robotId, pending.previousDesired);
    }
    this.persistRobot(robotId, true);
    const reply = { requestId: pending.requestId, robotId, desired: pending.paused, applied: ack.applied && robot.operatorPaused === pending.paused, pending: false, ok: ack.applied && robot.operatorPaused === pending.paused, reasonCode: ack.applied ? REASON_CODES.code.applied : (ack.reasonCode || REASON_CODES.code.rejected), controlEpoch: robot.controlEpoch, sessionId: ack.sessionId };
    if (pending.client) this.replyMotionPause(pending.client, reply);
  }

  private failMotionPause(robotId: string, requestId: string, reasonCode: string): void {
    const pending = this.motionPausePending.get(robotId), robot = this.state.robots.get(robotId);
    if (!pending || pending.requestId !== requestId || !robot) return;
    clearTimeout(pending.timer); this.motionPausePending.delete(robotId);
    robot.operatorPausePending = false; robot.operatorPauseReason = reasonCode;
    this.persistRobot(robotId, true);
    if (pending.client) this.replyMotionPause(pending.client, { requestId, robotId, desired: pending.paused, applied: false, pending: false, ok: false, reasonCode, controlEpoch: robot.controlEpoch });
  }

  private replyMotionPause(client: Client, reply: Record<string, unknown>): void {
    const requestId = String(reply.requestId ?? "");
    this.motionPauseReplies.set(`${client.sessionId}:${requestId}`, reply);
    if (this.motionPauseReplies.size > 512) this.motionPauseReplies.delete(this.motionPauseReplies.keys().next().value!);
    client.send(REPLY_KINDS.code.robot_motion_pause_result, reply);
  }

  private async queryRobotEvents(client: Client, payload: Record<string, unknown>): Promise<void> {
    const requestId = str(payload?.requestId), robotId = str(payload?.robotId);
    try {
      const categories = Array.isArray(payload?.categories) ? payload.categories.filter((value): value is BlackboxCategory => typeof value === "string") : undefined;
      const result = await this.blackboxQuery.robotEvents({ mapId: MAP_ID, robotId, fromMs: num(payload?.fromMs) ?? undefined, toMs: num(payload?.toMs) ?? undefined, asOf: num(payload?.asOf) ?? undefined, cursor: str(payload?.cursor) || undefined, limit: num(payload?.limit) ?? undefined, levels: Array.isArray(payload?.levels) ? payload.levels.filter((value): value is string => typeof value === "string") : undefined, categories, includePose: payload?.includePose === true });
      client.send(REPLY_KINDS.code.robot_events_result, { requestId, robotId, ok: true, ...result });
    } catch (error) {
      const detail = error instanceof BlackboxHttpError ? { code: error.code, message: error.message } : { code: "query_failed", message: error instanceof Error ? error.message : String(error) };
      client.send(REPLY_KINDS.code.robot_events_result, { requestId, robotId, ok: false, error: detail, events: [], gap: true, truncated: false });
    }
  }

  private setRobotControl(client: Client, payload: Record<string, unknown>) {
    const robotId = str(payload?.robotId), requestId = str(payload?.requestId);
    if (this.replayRuntimeReply(client, requestId)) return;
    const enabled = payload?.enabled === true;
    const expectedEpoch = num(payload?.expectedEpoch);
    const robot = this.state.robots.get(robotId);
    if (!robot || !requestId || typeof payload?.enabled !== "boolean" || !Number.isSafeInteger(expectedEpoch)) return this.replyRuntime(client, requestId, false, "로봇·요청 ID·현재 제어 상태를 확인해주세요.");
    if (robot.controlEpoch !== expectedEpoch) return this.replyRuntime(client, requestId, false, "로봇 상태가 변경되었습니다. 최신 상태에서 다시 시도해주세요.");
    if (this.activations.has(robotId)) return this.replyRuntime(client, requestId, false, "이미 운영 재개를 확인하고 있습니다.");
    const currentOwner = this.teleporterStore?.getRobotOwner(robotId);
    if (enabled && currentOwner && currentOwner.mapId !== MAP_ID) return this.replyRuntime(client, requestId, false, "현재 소유 맵에서 운영 재개를 요청해주세요.");
    if (enabled && robot.fmsControlState === "enabled" && robot.controlReady) return this.replyRuntime(client, requestId, true, "이미 정상 운영 중입니다.");
    if (enabled && (!robot.connected || Date.now() - robot.lastSeenAt > SESSION_TIMEOUT_MS)) return this.replyRuntime(client, requestId, false, "연결된 로봇의 최신 위치 보고가 필요합니다.");
    if (!enabled) {
      // Disabling is an operator recovery boundary. Release every logical
      // claim, including shared teleporter state, and advance the durable
      // control generation before replying to the UI.
      // A transferred robot can be represented by a newer in-memory room
      // epoch while this map's runtime row is still at the source epoch.
      // Persist that observed epoch before applying the atomic recovery fence.
      const persisted = this.runtimeStore.getRobot(robotId);
      if (persisted && persisted.controlEpoch < robot.controlEpoch) this.persistRobot(robotId, true);
      const result = this.disableRobotAcrossRuntimeStores({ robotId, requestId, expectedEpoch, releasedBy: client.sessionId });
      if (!result.ok) return this.replyRuntime(client, requestId, false, result.message);
      const teleporterResult = this.teleporterStore?.forceReleaseRobot(robotId, result.controlEpoch ?? expectedEpoch, "operator_disabled");
      robot.controlEpoch = Math.max(result.controlEpoch ?? robot.controlEpoch, teleporterResult?.controlEpoch ?? robot.controlEpoch);
      this.runtimeStore.clearRecoveryPending(robotId, robot.controlEpoch);
      robot.fmsControlState = "disabled"; robot.controlReady = false; robot.stateChangedAt = Date.now();
      this.teleporterTransfers.delete(robotId);
      this.clearOperationalState(robot);
      this.traffic.onRobotDisconnected(robotId);
      for (const item of result.released) if (item.resourceRef.kind === "zone") this.traffic.releaseSemanticOccupancy(robotId, item.resourceRef.id);
      this.persistRobot(robotId, true);
      this.publishOccupancies(this.runtimeStore.listOccupancies());
      sendControlState(robotId, { enabled: false, controlEpoch: robot.controlEpoch });
      this.projectRuntime(robot);
      return this.replyRuntime(client, requestId, true, `운영에서 제외했습니다. 논리 점유 ${result.released.length}건과 텔레포터 예약을 강제 해제했습니다.`);
    }
    // Persist disabled throughout the preparation phase. A crash or timeout may
    // never turn a pending activation into implicit permission to operate.
    robot.controlEpoch++; robot.fmsControlState = "disabled"; robot.controlReady = false; robot.stateChangedAt = Date.now();
    const owner = this.teleporterStore?.getRobotOwner(robotId);
    if (owner && owner.mapId === MAP_ID) this.teleporterStore.claimRobotOwner({ robotId, mapId: MAP_ID, controlEpoch: robot.controlEpoch, transferId: owner.transferId });
    this.clearOperationalState(robot);
    this.traffic.onRobotDisconnected(robotId);
    this.persistRobot(robotId, true);
    this.runtimeStore.audit({ action: RuntimeAuditActions.code.reactivate_requested, robotId, requestId, expectedEpoch, details: { enabled, controlEpoch: robot.controlEpoch, actor: client.sessionId } });
    const timer = setTimeout(() => this.failActivation(robotId, "상태 동기화 시간이 초과되어 운영 제외를 유지합니다."), SESSION_TIMEOUT_MS);
    this.activations.set(robotId, { client, requestId, epoch: robot.controlEpoch, startedAt: Date.now(), timer });
    if (!sendControlState(robotId, { enabled: true, controlEpoch: robot.controlEpoch })) this.failActivation(robotId, "로봇에 동기화 요청을 전송하지 못했습니다.");
  }

  /**
   * A handoff can leave a logical claim in the previous map's runtime DB.
   * Release both map-local stores at the same control generation before the
   * operator request is acknowledged.
   */
  private disableRobotAcrossRuntimeStores(input: { robotId: string; expectedEpoch?: number; requestId?: string; releasedBy?: string }): { ok: boolean; message: string; controlEpoch?: number; released: ResourceOccupancy[] } {
    const local = this.runtimeStore.disableAndReleaseAll(input);
    if (!local.ok) return local;
    let controlEpoch = local.controlEpoch ?? input.expectedEpoch ?? 0;
    const released = [...local.released] as ResourceOccupancy[];
    if (!this.runtimeStoreOwned) return { ...local, controlEpoch, released };
    for (const mapId of Object.keys(RUNTIME_MAPS)) {
      if (mapId === MAP_ID) continue;
      const path = runtimeSqlitePathForMap(mapId);
      if (!existsSync(path)) continue;
      const remote = new RuntimeStore(path);
      try {
        const saved = remote.getRobot(input.robotId);
        const epoch = Math.max(controlEpoch, saved?.controlEpoch ?? controlEpoch);
        released.push(...remote.applyAdministrativeDisable(input.robotId, epoch) as ResourceOccupancy[]);
        controlEpoch = epoch;
      } finally {
        remote.close();
      }
    }
    return { ...local, controlEpoch, released };
  }

  /** Simulator-only operator pose placement. The UI reply is intentionally delayed until the robot reports the requested pose and completes the normal control handshake. */
  private overrideRobotPose(client: Client, payload: PoseOverridePayload) {
    const robotId = str(payload?.robotId), requestId = str(payload?.requestId), mapId = str(payload?.mapId);
    if (this.replayPoseOverrideReply(client, requestId)) return;
    const expectedEpoch = num(payload?.expectedEpoch), x = num(payload?.x), y = num(payload?.y), theta = num(payload?.theta);
    const robot = this.state.robots.get(robotId);
    if (payload?.testOnly !== true || !robot || !requestId || mapId !== MAP_ID || !Number.isSafeInteger(expectedEpoch) || x === null || y === null || theta === null) {
      return this.replyPoseOverride(client, requestId, false, "테스트 전용 로봇·맵·요청 ID·위치·현재 제어 상태를 확인해주세요.");
    }
    if (robot.controlEpoch !== expectedEpoch) return this.replyPoseOverride(client, requestId, false, "로봇 상태가 변경되었습니다. 최신 상태에서 다시 시도해주세요.");
    if (!this.poseOverrideCapable.has(robotId)) return this.replyPoseOverride(client, requestId, false, "가상 로봇만 테스트 위치를 지정할 수 있습니다.");
    const poseControlReady = robot.fmsControlState === "disabled" || this.canControl(robotId);
    if (!robot.connected || !isRobotConnected(robotId) || Date.now() - robot.lastSeenAt > SESSION_TIMEOUT_MS || !poseControlReady) {
      return this.replyPoseOverride(client, requestId, false, "연결·상태 동기화가 완료된 가상 로봇만 지정할 수 있습니다.");
    }
    if (this.activations.has(robotId) || this.poseOverrides.has(robotId)) return this.replyPoseOverride(client, requestId, false, "현재 제어 상태 변경을 확인하고 있습니다.");
    if (this.hasActiveTeleporterTransfer(robotId)) return this.replyPoseOverride(client, requestId, false, "텔레포터 전환·예약 중에는 테스트 위치를 지정할 수 없습니다.");
    const blocked = this.poseOverrideBlocked(robotId, x, y, theta);
    if (blocked) return this.replyPoseOverride(client, requestId, false, blocked);

    // Fence the previous command while the old generation is still permitted.
    // Do not clear durable claims if the live virtual robot cannot receive it.
    if (robot.fmsControlState === "enabled" && !sendCancel(robotId, robot.commandId || "")) return this.replyPoseOverride(client, requestId, false, "기존 명령 취소를 가상 로봇에 전송하지 못했습니다.");
    const persisted = this.runtimeStore.getRobot(robotId);
    if (persisted && persisted.controlEpoch < robot.controlEpoch) this.persistRobot(robotId, true);
    const released = this.disableRobotAcrossRuntimeStores({ robotId, requestId, expectedEpoch, releasedBy: client.sessionId });
    if (!released.ok) return this.replyPoseOverride(client, requestId, false, released.message);
    const teleporter = this.teleporterStore.forceReleaseRobot(robotId, released.controlEpoch ?? robot.controlEpoch, "operator_pose_override");
    robot.controlEpoch = Math.max(released.controlEpoch ?? robot.controlEpoch, teleporter.controlEpoch);
    this.runtimeStore.clearRecoveryPending(robotId, robot.controlEpoch);
    robot.fmsControlState = "disabled";
    robot.controlReady = false;
    robot.stateChangedAt = Date.now();
    this.teleporterTransfers.delete(robotId);
    this.clearOperationalState(robot);
    robot.commandState = "cancelled";
    robot.commandReason = REASON_CODES.code['operator pose override'];
    robot.workState = "idle";
    this.traffic.onRobotDisconnected(robotId);
    for (const item of released.released) if (item.resourceRef.kind === "zone") this.traffic.releaseSemanticOccupancy(robotId, item.resourceRef.id);
    this.persistRobot(robotId, true);
    this.publishOccupancies(this.runtimeStore.listOccupancies());
    this.projectRuntime(robot);
    this.runtimeStore.audit({ action: RuntimeAuditActions.code.pose_override_requested, robotId, requestId, expectedEpoch, details: { actor: client.sessionId, mapId, x, y, theta, controlEpoch: robot.controlEpoch, releasedCount: released.released.length } });

    const startedAt = Date.now();
    const timer = setTimeout(() => this.failPoseOverride(robotId, "가상 로봇의 새 위치 확인 시간이 초과되었습니다."), SESSION_TIMEOUT_MS);
    this.poseOverrides.set(robotId, { client, requestId, epoch: robot.controlEpoch, x, y, theta, startedAt, timer });
    const controlSent = sendControlState(robotId, { enabled: false, controlEpoch: robot.controlEpoch });
    // These are observations, not motion grants. Order fresh validation
    // context before the administrative command in the new disabled epoch.
    this.lastFleetPlanMs = 0; this.lastSensedPeersMs = 0;
    this.maybeBroadcastFleetLocalPlans(); this.maybeBroadcastSensedPeers();
    this.publishTeleporterConstraints(robotId);
    if (!controlSent || !sendPoseOverride(robotId, { requestId, x, y, theta, controlEpoch: robot.controlEpoch })) {
      this.failPoseOverride(robotId, "가상 로봇에 테스트 위치 지정 요청을 전송하지 못했습니다.");
    }
  }

  private poseOverrideBlocked(robotId: string, x: number, y: number, theta: number): string | null {
    if (!robotFootprintClear(x, y, theta) || !isInflatedFree(x, y)) return "맵 경계 또는 정적 장애물과 충돌합니다.";
    if (poseHitsAny(x, y, theta, this.obstacleList())) return "정적 장애물과 충돌합니다.";
    if (isSemanticPoseBlocked(editorStore().snapshot().zones, { x, y })) return "blocked 또는 forbidden 존과 충돌합니다.";
    const body = this.poseBodyPolygon(x, y, theta);
    for (const definition of this.teleporterStore.list()) for (const endpoint of definition.endpoints) {
      if (endpoint.mapId === MAP_ID && endpointPolygonOverlaps(endpoint, body)) return "텔레포터 점유 영역과 충돌합니다.";
    }
    const robots = [...this.state.robots.values()].map(robot => ({ robotId: robot.id, x: robot.x, y: robot.y, bodyPolygon: this.robotBodyPolygon(robot) }));
    if (poseOverlapsRobotBodies({ x, y, theta }, robots, robotId)) return "다른 로봇 몸체와 충돌합니다.";
    return null;
  }

  private hasActiveTeleporterTransfer(robotId: string): boolean {
    if (this.teleporterTransfers.has(robotId)) return true;
    const requested = this.teleporterStore.list().some(definition => {
      const active = this.teleporterStore.activeUse(definition.id);
      return active?.robotId === robotId || this.teleporterStore.queue(definition.id).some(item => item.robotId === robotId);
    });
    return requested || Boolean(this.teleporterStore.db.query("SELECT 1 FROM teleporter_transfers WHERE robot_id=? AND phase NOT IN ('completed','failed') LIMIT 1").get(robotId));
  }

  private onPoseOverrideAck(robotId: string, ack: PoseOverrideAck): void {
    const robot = this.state.robots.get(robotId), pending = this.poseOverrides.get(robotId);
    if (!robot || !pending || pending.requestId !== ack.requestId || pending.epoch !== ack.controlEpoch || robot.sessionId !== ack.sessionId) return;
    if (!ack.applied) { this.failPoseOverride(robotId, `가상 로봇이 위치 지정을 거절했습니다: ${ack.reasonCode}`); return; }
    if (pending.ackAfterSequence === undefined) pending.ackAfterSequence = this.reportSequence;
  }

  private maybeConfirmPoseOverride(robot: Robot): void {
    const pending = this.poseOverrides.get(robot.id), report = this.reports.get(robot.id);
    if (!pending || !report || pending.ackAfterSequence === undefined || report.sequence <= pending.ackAfterSequence ||
      report.epoch !== pending.epoch || report.sessionId !== robot.sessionId || report.receivedAt < pending.startedAt ||
      report.workState !== "idle" || (report.driveState !== "stationary" && !(robot.operatorPauseDesired && report.driveState === "paused")) || Math.hypot(robot.x - pending.x, robot.y - pending.y) > 0.5 ||
      Math.abs(Math.atan2(Math.sin(robot.theta - pending.theta), Math.cos(robot.theta - pending.theta))) > 0.01) return;
    clearTimeout(pending.timer);
    this.poseOverrides.delete(robot.id);
    this.runtimeStore.audit({ action: RuntimeAuditActions.code.pose_override_pose_confirmed, robotId: robot.id, requestId: pending.requestId, details: { x: pending.x, y: pending.y, theta: pending.theta, controlEpoch: robot.controlEpoch } });
    // Test placement is an administrative operation. It must not implicitly
    // re-enable a robot that the operator deliberately excluded.
    robot.fmsControlState = "disabled";
    robot.controlReady = false;
    robot.connectionReason = REASON_CODES.code['operator disabled'];
    robot.stateChangedAt = Date.now();
    this.persistRobot(robot.id, true);
    this.projectRuntime(robot);
    this.replyPoseOverride(pending.client, pending.requestId, true, "테스트 위치를 지정했습니다. 로봇은 운영 제외 상태를 유지합니다.", robot);
  }

  private failPoseOverride(robotId: string, message: string): void {
    const pending = this.poseOverrides.get(robotId), robot = this.state.robots.get(robotId);
    if (!pending || !robot) return;
    clearTimeout(pending.timer);
    this.poseOverrides.delete(robotId);
    robot.fmsControlState = "disabled";
    robot.controlReady = false;
    robot.connectionReason = REASON_CODES.code.pose_override_failed;
    // A late queued override must not move the robot after a timeout/rejection.
    robot.controlEpoch++;
    robot.stateChangedAt = Date.now();
    this.persistRobot(robotId, true);
    sendControlState(robotId, { enabled: false, controlEpoch: robot.controlEpoch });
    this.runtimeStore.audit({ action: RuntimeAuditActions.code.pose_override_failed, robotId, requestId: pending.requestId, details: { reason: message, actor: pending.client.sessionId, controlEpoch: robot.controlEpoch } });
    this.replyPoseOverride(pending.client, pending.requestId, false, message);
  }

  private releaseResourceOccupancy(client: Client, payload: Record<string, unknown>) {
    const robotId = str(payload?.robotId), resourceId = str(payload?.resourceId), requestId = str(payload?.requestId);
    if (this.replayRuntimeReply(client, requestId)) return;
    const expectedEpoch = num(payload?.expectedEpoch);
    if (str(payload?.resourceKind) !== "zone" || !robotId || !resourceId || !requestId || !Number.isSafeInteger(expectedEpoch)) return this.replyRuntime(client, requestId, false, "점유 해제 대상과 현재 제어 상태를 확인해주세요.");
    if (this.activations.has(robotId)) return this.replyRuntime(client, requestId, false, "운영 재개 확인 중에는 점유를 해제할 수 없습니다.");
    const result = this.runtimeStore.releaseResourceAndDisable({ resourceKind: "zone", resourceId, robotId, requestId, expectedEpoch: expectedEpoch === null ? undefined : expectedEpoch, releasedBy: client.sessionId });
    if (result.ok) {
      const robot = this.state.robots.get(robotId);
      if (robot) {
        robot.fmsControlState = "disabled"; robot.controlReady = false; robot.controlEpoch = result.controlEpoch ?? robot.controlEpoch; robot.stateChangedAt = Date.now();
        this.clearOperationalState(robot);
        this.traffic.onRobotDisconnected(robotId);
        sendControlState(robotId, { enabled: false, controlEpoch: robot.controlEpoch });
        this.projectRuntime(robot);
      }
      this.traffic.releaseSemanticOccupancy(robotId, resourceId);
      this.publishOccupancies(this.runtimeStore.listOccupancies());
    }
    this.replyRuntime(client, requestId, result.ok, result.ok ? "선택한 점유를 해제하고 로봇을 운영에서 제외했습니다." : result.message);
  }

  private canControl(robotId: string): boolean {
    const r = this.state.robots.get(robotId);
    const owner = this.teleporterStore?.getRobotOwner(robotId);
    return !!r && (!owner || owner.mapId === MAP_ID && owner.controlEpoch === r.controlEpoch) && r.fmsControlState === "enabled" && r.controlReady && r.connected && isRobotConnected(robotId) && Date.now() - r.lastSeenAt <= SESSION_TIMEOUT_MS;
  }

  private clearOperationalState(robot: Robot): void {
    robot.path.clear(); robot.localPath.clear(); robot.leaseId = ""; robot.localHorizonS = 0;
    const extras = this.robotTraffic.get(robot.id);
    if (extras) extras.localPath = [];
    // This is loss of command authority, not a claim that the physical robot stopped.
    if (robot.commandId && !isTerminalCommandState(robot.commandState as CommandState)) {
      robot.commandState = "interrupted"; robot.commandReason = REASON_CODES.code['control synchronization required'];
    }
  }

  private onControlAck(robotId: string, ack: ControlAck): void {
    const robot = this.state.robots.get(robotId), report = this.reports.get(robotId);
    if (!robot || ack.controlEpoch !== robot.controlEpoch || ack.sessionId !== robot.sessionId) return;
    const pending = this.activations.get(robotId);
    const synchronized = ack.ready && robot.connected && !!report && report.epoch === ack.controlEpoch &&
      report.sessionId === ack.sessionId && Date.now() - report.receivedAt <= SESSION_TIMEOUT_MS &&
      report.workState === "idle" && (report.driveState === "stationary" || (robot.operatorPauseDesired && report.driveState === "paused")) && isFree(robot.x, robot.y);
    if (pending) {
      const administrative = this.teleporterStore?.getRobotAdministrativeControl(robotId);
      if (administrative?.disabled && administrative.controlEpoch >= ack.controlEpoch) {
        this.applyAdministrativeControl(robot); return;
      }
      if (!ack.enabled || !synchronized || report!.receivedAt < pending.startedAt) {
        this.failActivation(robotId, "로봇의 최신 위치·정지·작업 정리를 확인하지 못했습니다."); return;
      }
      clearTimeout(pending.timer); this.activations.delete(robotId);
      robot.fmsControlState = "enabled"; robot.controlReady = true; robot.connectionReason = "";
      robot.stateChangedAt = Date.now();
      this.teleporterStore?.clearRobotAdministrativeDisabled(robotId, robot.controlEpoch);
      this.persistRobot(robotId, true);
      this.traffic.onRobotConnected(robotId);
      this.runtimeStore.audit({ action: RuntimeAuditActions.code.reactivated, robotId, requestId: pending.requestId, details: { actor: pending.client.sessionId, controlEpoch: robot.controlEpoch } });
      if (pending.poseOverride) this.replyPoseOverride(pending.client, pending.requestId, true, "테스트 위치를 확인하고 운영을 재개했습니다.", robot);
      else this.replyRuntime(pending.client, pending.requestId, true, "상태 동기화를 완료하고 운영을 재개했습니다.");
    } else {
      robot.controlReady = robot.fmsControlState === "enabled" && ack.enabled && synchronized;
      robot.connectionReason = robot.controlReady || robot.fmsControlState === "disabled" ? "" : "synchronizing";
      this.persistRobot(robotId, true);
    }
    this.projectRuntime(robot);
  }

  private failActivation(robotId: string, message: string): void {
    const pending = this.activations.get(robotId), robot = this.state.robots.get(robotId);
    if (!pending || !robot) return;
    clearTimeout(pending.timer); this.activations.delete(robotId);
    robot.fmsControlState = "disabled"; robot.controlReady = false; robot.controlEpoch++; robot.stateChangedAt = Date.now();
    this.persistRobot(robotId, true);
    sendControlState(robotId, { enabled: false, controlEpoch: robot.controlEpoch });
    this.runtimeStore.audit({ action: RuntimeAuditActions.code.reactivation_failed, robotId, requestId: pending.requestId, details: { reason: message, actor: pending.client.sessionId } });
    if (pending.poseOverride) this.replyPoseOverride(pending.client, pending.requestId, false, message);
    else this.replyRuntime(pending.client, pending.requestId, false, message);
  }

  private replyRuntime(client: Client, requestId: string, ok: boolean, message: string): void {
    const reply = { requestId, ok, message };
    this.runtimeReplies.set(`${client.sessionId}:${requestId}`, reply);
    if (this.runtimeReplies.size > 512) this.runtimeReplies.delete(this.runtimeReplies.keys().next().value!);
    try { client.send(REPLY_KINDS.code.runtimeAck, reply); } catch { /* disconnected operator; state remains persisted */ }
  }
  private replyPoseOverride(client: Client, requestId: string, accepted: boolean, reason: string, robot?: Robot): void {
    const reply = {
      requestId,
      ok: accepted,
      accepted,
      reason,
      ...(robot ? { pose: { mapId: MAP_ID, x: robot.x, y: robot.y, theta: robot.theta }, controlEpoch: robot.controlEpoch } : {}),
    };
    this.poseOverrideReplies.set(`${client.sessionId}:${requestId}`, reply);
    if (this.poseOverrideReplies.size > 512) this.poseOverrideReplies.delete(this.poseOverrideReplies.keys().next().value!);
    try { client.send(REPLY_KINDS.code.virtualRobotPoseAck, reply); } catch { /* disconnected operator; state remains persisted */ }
  }
  private replayPoseOverrideReply(client: Client, requestId: string): boolean {
    const reply = this.poseOverrideReplies.get(`${client.sessionId}:${requestId}`);
    if (reply) { client.send(REPLY_KINDS.code.virtualRobotPoseAck, reply); return true; }
    return [...this.poseOverrides.values()].some(p => p.client.sessionId === client.sessionId && p.requestId === requestId) ||
      [...this.activations.values()].some(p => p.poseOverride && p.client.sessionId === client.sessionId && p.requestId === requestId);
  }
  private replayRuntimeReply(client: Client, requestId: string): boolean {
    const reply = this.runtimeReplies.get(`${client.sessionId}:${requestId}`);
    if (reply) { client.send(REPLY_KINDS.code.runtimeAck, reply); return true; }
    return [...this.activations.values()].some(p => p.client.sessionId === client.sessionId && p.requestId === requestId) ||
      [...this.poseOverrides.values()].some(p => p.client.sessionId === client.sessionId && p.requestId === requestId);
  }

  private publishOccupancies(records: ResourceOccupancy[]): void {
    this.occupancies = records;
    const json = JSON.stringify(records);
    if (this.state.runtimeOccupanciesJson !== json) this.state.runtimeOccupanciesJson = json;
    for (const robot of this.state.robots.values()) this.projectRuntime(robot);
  }
  private projectRuntime(robot: Robot): void {
    const report = this.reports.get(robot.id);
    let contexts: DriveContext[] = report?.contexts.slice() ?? [];
    const previous = `${robot.workState}|${robot.driveState}|${robot.driveContextJson}`;
    if (!robot.connected || !report) {
      robot.workState = "unknown"; robot.driveState = "unknown";
    } else {
      robot.workState = report.workState;
      if (robot.fmsControlState === "enabled" && ["sent", "accepted", "running"].includes(robot.commandState)) robot.workState = "busy";
      robot.driveState = report.driveState;
      if (robot.fmsControlState === "enabled") {
        for (const entry of this.occupancies.filter(o => o.robotId === robot.id && o.state === "queued")) {
          const blockers = this.occupancies.filter(o => o.resourceRef.id === entry.resourceRef.id && o.resourceRef.kind === entry.resourceRef.kind && o.state !== "queued" && o.robotId !== robot.id).map(o => o.robotId);
          contexts.push({ reasonCode: blockers.length ? REASON_CODES.code.resource_occupied : REASON_CODES.code.permission_pending, source: "fms", target: entry.resourceRef,
            blockingRobotIds: blockers, requestId: entry.requestId, permissionState: "queued", since: entry.createdAt });
        }
      }
    }
    robot.driveContextJson = JSON.stringify(contexts);
    if (previous !== `${robot.workState}|${robot.driveState}|${robot.driveContextJson}`) robot.stateChangedAt = Date.now();
  }

  private persistRobot(robotId: string, force = false): void {
    const robot = this.state.robots.get(robotId); if (!robot) return;
    const now = Date.now(); const previous = this.runtimeWriteAt.get(robotId) ?? 0;
    if (!force && now - previous < 1000) return;
    this.runtimeWriteAt.set(robotId, now);
    const value: RobotRuntime = { robotId, x: robot.x, y: robot.y, theta: robot.theta, workState: robot.workState as RobotRuntime["workState"], fmsControlState: robot.fmsControlState as RobotRuntime["fmsControlState"], connectionState: robot.connected ? "online" : "offline", connectionReason: robot.connectionReason, driveState: parseDriveState(robot.driveState), driveContextJson: robot.driveContextJson, controlEpoch: robot.controlEpoch, controlReady: robot.controlReady, reportedAt: robot.reportedAt, stateChangedAt: robot.stateChangedAt, sessionId: robot.sessionId, navigationMode: NavigationModes.is(robot.navigationMode) ? robot.navigationMode : NavigationModes.code.unknown, pathPlanningAuthority: PathPlanningAuthorities.is(robot.pathPlanningAuthority) ? robot.pathPlanningAuthority : PathPlanningAuthorities.code.unknown, operatorPaused: robot.operatorPauseDesired };
    this.runtimeStore.upsertRobot(value);
  }

  private place(client: Client, kind: typeof SceneKinds.code.waypoint | typeof SceneKinds.code.charger, payload: PlacePayload) {
    const x = num(payload?.x);
    const y = num(payload?.y);
    const theta = num(payload?.theta) ?? 0;
    if (x === null || y === null) {
      deny(client, "x,y required");
      return;
    }
    if (!isFree(x, y)) {
      deny(client, "not free");
      return;
    }

    if (kind === "waypoint") {
      const id = str(payload && "id" in payload ? (payload as { id?: unknown }).id : "") || `wp-${crypto.randomUUID()}`;
      persistAndSetWaypoint(this.state, { id, x, y, theta, name: str(payload.name) || id });
      broadcastSemanticSnapshot();
      return;
    }

    const id = str(payload.id) || `cs-${crypto.randomUUID()}`;
    persistAndSetCharger(this.state, { id, x, y, theta, name: str(payload.name) || id });
    broadcastSemanticSnapshot();
  }

  private moveAsset(client: Client, payload: MoveAssetPayload) {
    const kind = str(payload?.kind);
    const id = str(payload?.id);
    const x = num(payload?.x);
    const y = num(payload?.y);
    const theta = num(payload?.theta);
    if ((kind !== "waypoint" && kind !== "charger") || !id || x === null || y === null) {
      deny(client, "invalid moveAsset");
      return;
    }
    if (!isFree(x, y)) {
      deny(client, "not free");
      return;
    }

    if (kind === "waypoint") {
      const item = this.state.waypoints.get(id);
      if (!item) {
        deny(client, `unknown waypoint ${id}`);
        return;
      }
      persistAndSetWaypoint(this.state, {
        id,
        x,
        y,
        theta: theta !== null ? theta : item.theta,
        name: item.name || id,
      });
      broadcastSemanticSnapshot();
      return;
    }

    const item = this.state.chargingStations.get(id);
    if (!item) {
      deny(client, `unknown charger ${id}`);
      return;
    }
    persistAndSetCharger(this.state, {
      id,
      x,
      y,
      theta: theta !== null ? theta : item.theta,
      name: item.name || id,
    });
    broadcastSemanticSnapshot();
  }

  private commandRobot(client: Client, payload: CommandPayload) {
    const robotId = str(payload?.robotId);
    if (!this.canControl(robotId)) { deny(client, "로봇의 연결·운영 상태와 제어 동기화를 확인해주세요."); return; }
    const motionRobot = this.state.robots.get(robotId);
    if (motionRobot?.operatorPaused || motionRobot?.operatorPauseDesired || motionRobot?.operatorPausePending) { deny(client, "로봇이 일시정지 중이거나 일시정지 상태를 동기화하고 있습니다."); return; }
    const kind = str(payload?.kind);
    const targetId = str(payload?.targetId);
    if (kind === "teleporter") {
      this.commandTeleporter(client, robotId, targetId, str(payload?.endpointId));
      return;
    }
    if (!robotId || (kind !== "move" && kind !== "dock")) {
      deny(client, "invalid commandRobot");
      return;
    }
    if (!this.state.robots.has(robotId)) {
      deny(client, `unknown robot ${robotId}`);
      return;
    }
    // A teleporter transfer owns the robot until it is explicitly cancelled
    // or reaches a terminal durable phase. Ordinary move/dock must not
    // overwrite its entry, arrival, or clearing command.
    const teleporterUse = this.teleporterStore?.list().some(definition => {
      const active = this.teleporterStore.activeUse(definition.id);
      return active?.robotId === robotId || this.teleporterStore.queue(definition.id).some(item => item.robotId === robotId);
    });
    const durableTransfer = Boolean(this.teleporterStore?.db.query("SELECT 1 FROM teleporter_transfers WHERE robot_id=? AND phase NOT IN ('completed','failed') LIMIT 1").get(robotId));
    if (teleporterUse || durableTransfer) {
      deny(client, "robot has a teleporter transfer in progress; cancel it first");
      return;
    }

    let x: number;
    let y: number;
    let theta: number;

    if (targetId) {
      const target =
        kind === "move"
          ? this.state.waypoints.get(targetId)
          : this.state.chargingStations.get(targetId);
      if (!target) {
        deny(client, `unknown target ${targetId}`);
        return;
      }
      x = target.x;
      y = target.y;
      theta = target.theta;
    } else if (kind === "move") {
      const px = num(payload?.x);
      const py = num(payload?.y);
      if (px === null || py === null) {
        deny(client, "move needs targetId or x,y");
        return;
      }
      if (!isFree(px, py)) {
        deny(client, "not free");
        return;
      }
      if (!isInflatedFree(px, py)) {
        deny(client, "too close to wall");
        return;
      }
      x = px;
      y = py;
      const rawTheta = num(payload?.theta);
      if ("theta" in (payload ?? {}) && rawTheta === null) {
        deny(client, "theta must be finite");
        return;
      }
      theta = rawTheta ?? 0;
    } else {
      deny(client, "dock needs a charging station");
      return;
    }

    if (![x, y, theta].every(Number.isFinite)) {
      deny(client, "command coordinates must be finite");
      return;
    }
    if (!isFree(x, y)) {
      deny(client, "not free");
      return;
    }
    if (!isInflatedFree(x, y)) {
      deny(client, "too close to wall");
      return;
    }
    if (poseHitsAny(x, y, theta, this.obstacleList())) {
      deny(client, "target intersects obstacle");
      return;
    }
    // Hard semantic zones are an execution gate as well as a planner hint.
    // Check the persisted snapshot so editor and robot consumers share one source.
    if (isSemanticPoseBlocked(editorStore().snapshot().zones, { x, y })) {
      deny(client, "target is inside a forbidden/blocked zone");
      return;
    }

    const robot = this.state.robots.get(robotId);
    const commandId = currentOperationId() ?? crypto.randomUUID();
    if (robot) {
      robot.commandId = commandId;
      robot.commandState = "sent";
      robot.commandReason = REASON_CODES.code['sent to robot'];
      robot.workState = "busy";
    }
    const ok = sendDrive(robotId, {
      command_id: commandId,
      kind,
      x,
      y,
      theta,
      event_context_json: JSON.stringify({ ...this.eventContext(OPERATION_KINDS.code.commandRobot, payload), commandKind: kind, x, y, theta }),
    });
    if (!ok) {
      if (robot) { robot.commandState = "rejected"; robot.commandReason = REASON_CODES.code['robot disconnected']; }
      deny(client, `robot ${robotId} is not connected`);
      return;
    }

    const acknowledgement = { robotId, kind, commandId, operationId: currentOperationId() ?? commandId, state: "sent", targetId: targetId || undefined, x, y, theta };
    this.trace?.broadcastReply(REPLY_KINDS.code.commandAck, acknowledgement);
    this.broadcast(REPLY_KINDS.code.commandAck, acknowledgement);
  }

  private refreshTeleporters(): void {
    if (!this.teleporterStore) return;
    // Apply the shared generation to historical rows as well as live projections.
    // Reconciliation never creates a new recovery operation or control epoch.
    let changedClaims = false;
    for (const saved of this.runtimeStore.listRobots()) {
      const control = this.teleporterStore.getRobotAdministrativeControl(saved.robotId);
      if (!control?.disabled || saved.controlEpoch > control.controlEpoch) continue;
      const claims = this.runtimeStore.listOccupancies().filter(item => item.robotId === saved.robotId);
      if (saved.fmsControlState === "disabled" && saved.controlEpoch === control.controlEpoch && claims.length === 0) continue;
      const released = this.runtimeStore.applyAdministrativeDisable(saved.robotId, control.controlEpoch);
      for (const item of released) if (item.resourceRef.kind === "zone") this.traffic?.releaseSemanticOccupancy(saved.robotId, item.resourceRef.id);
      changedClaims ||= released.length > 0;
    }
    if (changedClaims) this.publishOccupancies(this.runtimeStore.listOccupancies());
    for (const robot of this.state.robots.values()) this.applyAdministrativeControl(robot);
    for (const [robotId, transfer] of this.teleporterTransfers) {
      const durable = this.teleporterStore.getTransfer(transfer.transferId);
      if (durable?.phase === "failed" || durable?.phase === "completed") this.teleporterTransfers.delete(robotId);
    }
    // After destination arrival, remove the former map's live projection so
    // it no longer appears as a body or controllable fleet member there.
    for (const [robotId] of this.state.robots) {
      const owner = this.teleporterStore.getRobotOwner(robotId);
      const transfer = owner?.transferId && this.teleporterStore.getTransfer(owner.transferId);
      if (owner && owner.mapId !== MAP_ID && transfer && ["arrived", "clearing", "completed"].includes(transfer.phase)) {
        this.state.robots.delete(robotId); this.robotTraffic.delete(robotId); this.reports.delete(robotId);
      }
    }
    this.teleporterStore.publishMapWorld(MAP_ID, [...this.state.robots.values()].map(robot => ({ robotId: robot.id, x: robot.x, y: robot.y, theta: robot.theta, bodyPolygon: this.robotBodyPolygon(robot), connected: robot.connected, controlEpoch: robot.controlEpoch, fmsControlState: robot.fmsControlState, controlReady: robot.controlReady })), this.teleporterReadiness());
    this.syncTeleporterTransfers();
    const useProjection: unknown[] = [];
    const json = JSON.stringify(this.teleporterStore.list().map(definition => {
      const active = this.teleporterStore.activeUse(definition.id); const queued = this.teleporterStore.queue(definition.id);
      if (active) for (const endpointId of [active.fromEndpointId, active.toEndpointId]) useProjection.push({ teleporterId: definition.id, endpointId, state: active.state, robotId: active.robotId, reason: active.state });
      for (const queuedUse of queued) for (const endpointId of [queuedUse.fromEndpointId, queuedUse.toEndpointId]) useProjection.push({ teleporterId: definition.id, endpointId, state: "queued", robotId: queuedUse.robotId, reason: "permission_pending" });
      return { ...definition, endpoints: definition.endpoints.map(endpoint => ({ ...endpoint, occupancyState: active && (active.fromEndpointId === endpoint.id || active.toEndpointId === endpoint.id) ? active.state : queued.some(item => item.fromEndpointId === endpoint.id || item.toEndpointId === endpoint.id) ? "queued" : "free", occupancyRobotId: active && (active.fromEndpointId === endpoint.id || active.toEndpointId === endpoint.id) ? active.robotId : undefined, occupancyReason: active ? active.state : queued.length ? "permission_pending" : undefined })) };
    }));
    this.state.teleporterUsesJson = JSON.stringify(useProjection);
    if (json !== this.state.teleportersJson) { this.state.teleportersJson = json; this.broadcast("teleporterSnapshot", { teleporters: JSON.parse(json) }); }
  }

  /** Apply a shared operator recovery marker to every map-room projection. */
  private applyAdministrativeControl(robot: Robot): void {
    const control = this.teleporterStore?.getRobotAdministrativeControl(robot.id);
    if (!control?.disabled || control.controlEpoch < robot.controlEpoch) return;
    if (robot.fmsControlState === "disabled" && robot.controlEpoch === control.controlEpoch && !robot.controlReady) return;
    const released = this.runtimeStore.applyAdministrativeDisable(robot.id, control.controlEpoch);
    const pending = this.activations.get(robot.id);
    if (pending) {
      clearTimeout(pending.timer); this.activations.delete(robot.id);
      this.replyRuntime(pending.client, pending.requestId, false, "다른 운영 제외 요청으로 재개를 취소했습니다.");
    }
    robot.controlEpoch = control.controlEpoch;
    robot.fmsControlState = "disabled"; robot.controlReady = false; robot.stateChangedAt = Date.now();
    this.teleporterTransfers.delete(robot.id);
    this.clearOperationalState(robot);
    this.traffic?.onRobotDisconnected(robot.id);
    for (const item of released) if (item.resourceRef.kind === "zone") this.traffic?.releaseSemanticOccupancy(robot.id, item.resourceRef.id);
    this.persistRobot(robot.id, true);
    if (isRobotConnected(robot.id)) sendControlState(robot.id, { enabled: false, controlEpoch: robot.controlEpoch });
  }

  private publishTeleporterConstraints(robotId: string): void {
    if (!this.teleporterEnabled || !isRobotConnected(robotId)) return;
    const robots = [...this.state.robots.values()].map(robot => ({ robotId: robot.id, x: robot.x, y: robot.y, bodyPolygon: this.robotBodyPolygon(robot) }));
    const blocked: { id: string; polygon: { x: number; y: number }[] }[] = [];
    for (const definition of this.teleporterStore.list()) for (const endpoint of definition.endpoints) {
      if (endpoint.mapId !== MAP_ID) continue;
      const status = this.teleporterStore.endpointBlocked({ teleporterId: definition.id, endpointId: endpoint.id, robotPoses: robots });
      const active = this.teleporterStore.activeUse(definition.id);
      const owner = this.teleporterStore.getRobotOwner(robotId);
      const opposite = endpointFor(definition, endpoint.id === definition.endpoints[0].id ? definition.endpoints[1].id : definition.endpoints[0].id);
      const remoteWorld = opposite && opposite.mapId !== MAP_ID ? this.teleporterStore.mapWorld(opposite.mapId) : null;
      const remotePathBlocked = Boolean(opposite && remoteWorld?.fresh && endpointClearingPathBlocked(opposite, (remoteWorld.robots as { robotId: string; x: number; y: number; bodyPolygon?: { x: number; y: number }[] }[]).map(peer => ({ ...peer, bodyPolygon: peer.bodyPolygon ?? [] })), robotId));
      const isSource = active?.fromEndpointId === endpoint.id;
      const localReady = this.teleporterReadiness()[`${definition.id}:${endpoint.id}`] === true;
      const sourceEnvironmentReady = !isSource || Boolean(remoteWorld?.fresh && remoteWorld.readiness[`${definition.id}:${opposite?.id}`] === true && localReady && !remotePathBlocked);
      // An owner may leave its destination endpoint even while the opposite
      // map is unavailable. Entering from the source requires both worlds'
      // readiness and a clear destination path.
      const ownPermit = active?.robotId === robotId && owner?.mapId === MAP_ID && sourceEnvironmentReady;
      // A robot already standing in an endpoint must be able to leave it.
      // Only another body, or another robot's reservation, keeps the gate
      // closed.  An owner permit does not mask a second physical body.
      const otherBody = status.robotIds.some(id => id !== robotId);
      const otherReservation = Boolean(active && !ownPermit);
      const pathBlocked = endpointClearingPathBlocked(endpoint, robots.map(robot => ({ ...robot, bodyPolygon: robot.bodyPolygon ?? [] })), robotId);
      if (otherBody || otherReservation || pathBlocked) blocked.push({ id: `${definition.id}:${endpoint.id}`, polygon: endpoint.occupancyPolygon.map(point => ({ x: point.x + endpoint.position.x, y: point.y + endpoint.position.y })) });
    }
    sendTeleporterConstraints(robotId, { blocked });
  }

  private robotBodyPolygon(robot: Robot): { x: number; y: number }[] {
    return this.poseBodyPolygon(robot.x, robot.y, robot.theta);
  }

  private poseBodyPolygon(x: number, y: number, theta: number): { x: number; y: number }[] {
    const hx = ROBOT_LENGTH_PX / 2, hy = ROBOT_WIDTH_PX / 2;
    const c = Math.cos(theta), s = Math.sin(theta);
    return [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([px, py]) => ({ x: x + px * c - py * s, y: y + px * s + py * c }));
  }

  private teleporterReadiness(): Record<string, boolean> {
    const readiness: Record<string, boolean> = {};
    const zones = editorStore().snapshot().zones;
    for (const definition of this.teleporterStore.list()) for (const endpoint of definition.endpoints) {
      if (endpoint.mapId !== MAP_ID) continue;
      const polygon = endpoint.occupancyPolygon.map(point => ({ x: point.x + endpoint.position.x, y: point.y + endpoint.position.y }));
      let ready = isFree(endpoint.position.x, endpoint.position.y) && isInflatedFree(endpoint.position.x, endpoint.position.y) && !isSemanticPoseBlocked(zones, endpoint.position) && !poseHitsAny(endpoint.position.x, endpoint.position.y, endpoint.entryTheta, this.obstacleList());
      for (const point of polygon) ready = ready && isFree(point.x, point.y) && isInflatedFree(point.x, point.y);
      const dx = endpoint.clearingPoint.x - endpoint.position.x, dy = endpoint.clearingPoint.y - endpoint.position.y;
      const distance = Math.hypot(dx, dy);
      // Keep the swept-path check bounded and dense enough that a wall or
      // forbidden cell cannot be skipped between samples.
      const steps = Math.ceil(distance / 4);
      if (distance > 256 || steps > 64) ready = false;
      for (let i = 1; i <= steps; i++) { const x = endpoint.position.x + dx * i / steps, y = endpoint.position.y + dy * i / steps; ready = ready && isFree(x, y) && isInflatedFree(x, y) && !isSemanticPoseBlocked(zones, { x, y }) && !poseHitsAny(x, y, endpoint.exitTheta, this.obstacleList()); }
      readiness[`${definition.id}:${endpoint.id}`] = ready;
    }
    return readiness;
  }

  /** Allow a robot absent from this map's seed only when a durable transfer owns it. */
  private allowTransferredRegistration(robotId: string, mapId: string, transferId: string): boolean {
    if (!transferId) {
      const owner = this.teleporterStore.getRobotOwner(robotId);
      const robot = this.state.robots.get(robotId);
      if (robot) this.applyAdministrativeControl(robot);
      return (!mapId || mapId === MAP_ID) && this.state.robots.has(robotId) && (!owner || owner.mapId === MAP_ID);
    }
    const owner = this.teleporterStore.getRobotOwner(robotId);
    const transfer = this.teleporterStore.getTransfer(transferId);
    // An operator may abort a transfer while the robot still has its pending
    // journal. Let that stale session reconnect once to receive the durable
    // disabled control state and clear its local journal; otherwise it would
    // retry the same rejected registration forever.
    if (transfer?.phase === "failed") {
      if (transfer.robotId !== robotId || owner?.robotId !== robotId || owner.mapId !== MAP_ID || (mapId && mapId !== MAP_ID)) return false;
      let saved = this.runtimeStore.getRobot(robotId);
      if (!saved) {
        saved = this.runtimeStore.ensureRobot(robotId);
        this.runtimeStore.upsertRobot({ ...saved, fmsControlState: "disabled", controlEpoch: Math.max(saved.controlEpoch, owner.controlEpoch), controlReady: false, connectionState: "offline", connectionReason: "operator disabled" });
        saved = this.runtimeStore.getRobot(robotId);
      }
      if (!saved || saved.fmsControlState !== "disabled") return false;
      if (!this.state.robots.has(robotId)) {
        const definition = this.teleporterStore.get(transfer.teleporterId);
        const endpoint = definition && endpointFor(definition, transfer.toEndpointId);
        const restored = new Robot(); restored.id = robotId; restored.x = saved.x ?? endpoint?.position.x ?? 0; restored.y = saved.y ?? endpoint?.position.y ?? 0; restored.theta = saved.theta ?? endpoint?.exitTheta ?? 0;
        restored.controlEpoch = Math.max(saved.controlEpoch, owner.controlEpoch); restored.fmsControlState = "disabled"; restored.controlReady = false; restored.connectionState = "offline"; restored.connectionReason = REASON_CODES.code['operator disabled'];
        this.state.robots.set(robotId, restored); this.robotTraffic.set(robotId, { motion: "", avoidanceMode: true, headRoomPx: 0, localPath: [], reportedTrafficStatus: "clear", localPlanUpdatedAt: 0 });
      }
      const restored = this.state.robots.get(robotId)!;
      restored.fmsControlState = "disabled"; restored.controlReady = false;
      restored.controlEpoch = Math.max(saved.controlEpoch, owner.controlEpoch);
      this.clearOperationalState(restored);
      this.persistRobot(robotId, true);
      return true;
    }
    if (!owner || !transfer || transfer.robotId !== robotId || transfer.destinationMapId !== MAP_ID || owner.mapId !== MAP_ID || owner.transferId !== transferId || (mapId && mapId !== MAP_ID && mapId !== transfer.sourceMapId)) return false;
    if (transfer.phase === "completed") {
      if (!this.state.robots.has(robotId)) {
        const saved = this.runtimeStore.getRobot(robotId);
        if (saved) {
          const restored = new Robot(); restored.id = robotId; restored.x = saved.x ?? 0; restored.y = saved.y ?? 0; restored.theta = saved.theta ?? 0; restored.controlEpoch = saved.controlEpoch; restored.fmsControlState = saved.fmsControlState; restored.controlReady = false; restored.connectionState = "offline"; restored.connectionReason = REASON_CODES.code['server restarted'];
          this.state.robots.set(robotId, restored); this.robotTraffic.set(robotId, { motion: "", avoidanceMode: true, headRoomPx: 0, localPath: [], reportedTrafficStatus: "clear", localPlanUpdatedAt: 0 });
        }
      }
      return this.state.robots.has(robotId);
    }
    const definition = this.teleporterStore.get(transfer.teleporterId); const endpoint = definition && endpointFor(definition, transfer.toEndpointId);
    if (!endpoint) return false;
    let robot = this.state.robots.get(robotId);
    if (!robot) {
      robot = new Robot(); robot.id = robotId; robot.x = endpoint.position.x; robot.y = endpoint.position.y; robot.theta = endpoint.exitTheta; robot.controlEpoch = owner.controlEpoch; robot.fmsControlState = "enabled"; robot.connectionState = "offline"; robot.connectionReason = REASON_CODES.code['teleporter destination synchronizing']; robot.controlReady = false;
      this.state.robots.set(robotId, robot); this.robotTraffic.set(robotId, { motion: "", avoidanceMode: true, headRoomPx: 0, localPath: [], reportedTrafficStatus: "clear", localPlanUpdatedAt: 0 });
    } else if (robot.controlEpoch > owner.controlEpoch) return false;
    else {
      // A source room keeps its stale Robot row for safety; hydrate that row
      // with the authoritative destination pose before accepting the new stream.
      robot.x = endpoint.position.x; robot.y = endpoint.position.y; robot.theta = endpoint.exitTheta;
      robot.controlEpoch = owner.controlEpoch; robot.controlReady = false; robot.connectionState = "offline"; robot.connectionReason = REASON_CODES.code['teleporter destination synchronizing'];
    }
    this.teleporterTransfers.set(robotId, { transferId, teleporterId: transfer.teleporterId, robotId, fromEndpointId: transfer.fromEndpointId, toEndpointId: transfer.toEndpointId, phase: "destination_loading", controlEpoch: owner.controlEpoch, sourceMapId: transfer.sourceMapId, destinationMapId: transfer.destinationMapId, commandId: transferId, reason: "destination registration" });
    robot.commandId = transferId; robot.commandState = "running"; robot.commandReason = REASON_CODES.code['teleporter destination synchronizing']; robot.workState = "busy";
    return true;
  }

  private upsertTeleporter(client: Client, payload: Record<string, unknown>): void {
    try {
      const raw = (payload.definition && typeof payload.definition === "object" ? payload.definition : payload.teleporter && typeof payload.teleporter === "object" ? payload.teleporter : payload) as StoredTeleporter;
      const expectedRevision = num(payload.expectedRevision);
      const saved = this.teleporterStore.upsert(raw, expectedRevision ?? undefined);
      this.refreshTeleporters(); client.send(REPLY_KINDS.code.teleporterAck, { requestId: str(payload.requestId), ok: true, action: "upsert", id: saved.id, revision: saved.revision });
    } catch (error) { deny(client, error instanceof Error ? error.message : "invalid teleporter"); }
  }

  private deleteTeleporter(client: Client, payload: Record<string, unknown>): void {
    const id = str(payload.id);
    if (!id) { deny(client, "teleporter id required"); return; }
    try { this.teleporterStore.delete(id); this.refreshTeleporters(); client.send(REPLY_KINDS.code.teleporterAck, { requestId: str(payload.requestId), ok: true, action: "delete", id }); }
    catch (error) { deny(client, error instanceof Error ? error.message : "teleporter cannot be deleted"); }
  }

  private commandTeleporter(client: Client, robotId: string, teleporterId: string, endpointId: string): void {
    if (!robotId || !teleporterId || !endpointId) { deny(client, "teleporter needs targetId and endpointId"); return; }
    const definition = this.teleporterStore.get(teleporterId);
    const from = definition && endpointFor(definition, endpointId);
    const to = definition && oppositeEndpoint(definition, endpointId);
    if (!definition || !from || !to || from.mapId !== MAP_ID) { deny(client, "teleporter endpoint is not on this map"); return; }
    const entryPolygon = from.occupancyPolygon.map(point => ({ x: point.x + from.position.x, y: point.y + from.position.y }));
    if (!isFree(from.position.x, from.position.y) || !isInflatedFree(from.position.x, from.position.y) || entryPolygon.some(point => !isFree(point.x, point.y) || !isInflatedFree(point.x, point.y)) || poseHitsAny(from.position.x, from.position.y, from.entryTheta, this.obstacleList()) || isSemanticPoseBlocked(editorStore().snapshot().zones, from.position)) { deny(client, "teleporter entry is blocked"); return; }
    if (!isFree(from.clearingPoint.x, from.clearingPoint.y) || !isInflatedFree(from.clearingPoint.x, from.clearingPoint.y) || poseHitsAny(from.clearingPoint.x, from.clearingPoint.y, from.exitTheta, this.obstacleList()) || isSemanticPoseBlocked(editorStore().snapshot().zones, from.clearingPoint)) { deny(client, "teleporter clearing point is blocked"); return; }
    const robot = this.state.robots.get(robotId); if (!robot || !this.canControl(robotId)) { deny(client, "robot is not ready"); return; }
    const destinationWorld = this.teleporterStore.mapWorld(to.mapId);
    if (!destinationWorld.fresh) { deny(client, "destination map is unavailable"); return; }
    // A reachable destination with a temporarily blocked endpoint is a valid
    // request: keep the robot approaching the source boundary and let the
    // durable FIFO reservation wait until readiness becomes true.
      // A transferred robot's stale row remains in its previous map until the
      // destination handshake; that same physical body must not block its own
      // return endpoint.
    // A physically occupied destination delays the request in the logical FIFO;
    // it does not reject the approaching robot or create a fixed waiting pose.
    const requestId = currentOperationId() ?? crypto.randomUUID();
    let use;
    try {
      if (!this.teleporterStore.claimRobotOwner({ robotId, mapId: from.mapId, controlEpoch: robot.controlEpoch })) throw new Error("robot is owned by another map");
      use = this.teleporterStore.requestUse({ teleporterId, robotId, fromEndpointId: from.id, toEndpointId: to.id, requestId, controlEpoch: robot.controlEpoch });
    }
    catch (error) { deny(client, error instanceof Error ? error.message : "teleporter unavailable"); return; }
    const initialTransfer = { transferId: requestId, teleporterId, robotId, fromEndpointId: from.id, toEndpointId: to.id, phase: use.state === "queued" ? "requested" : "reserved", controlEpoch: robot.controlEpoch, sourceMapId: from.mapId, destinationMapId: to.mapId, commandId: requestId, reason: use.state === "queued" ? "waiting for teleporter" : "" } satisfies TeleporterTransfer;
    this.teleporterTransfers.set(robotId, initialTransfer);
    this.persistTransfer(initialTransfer);
    const commandId = `${requestId}:entry`; robot.commandId = commandId; robot.commandState = "sent"; robot.workState = "busy";
    if (!sendDrive(robotId, { command_id: commandId, kind: "teleporter_entry", x: from.position.x, y: from.position.y, theta: from.entryTheta,
      event_context_json: JSON.stringify({ target: { id: definition.id, kind: "teleporter", name: definition.name, mapId: MAP_ID } }) })) { deny(client, "robot disconnected"); return; }
    if (use.state === "queued") robot.commandReason = REASON_CODES.code['teleporter waiting at approach boundary'];
    client.send(REPLY_KINDS.code.commandAck, { robotId, kind: "teleporter", commandId, state: use.state === "queued" ? "queued" : "sent", targetId: teleporterId });
  }

  private onTeleporterTransferUpdate(update: { robotId: string; transferId: string; phase: string; reason: string; mapId: string; controlEpoch: number; sessionId: string }): void {
    // A different map room may still have the pre-abort transfer in memory.
    // The shared ledger is authoritative after operator recovery; never let a
    // late source/destination event resurrect its failed transfer row.
    const durableBefore = this.teleporterStore.getTransfer(update.transferId);
    if (durableBefore?.phase === "failed") return;
    let transfer = this.teleporterTransfers.get(update.robotId);
    if (!transfer || transfer.transferId !== update.transferId) {
      const active = this.teleporterStore.list().map(item => this.teleporterStore.activeUse(item.id)).find(use => use?.robotId === update.robotId && use.requestId === update.transferId);
      if (!active) return;
      const definition = this.teleporterStore.get(active.teleporterId); const from = definition && endpointFor(definition, active.fromEndpointId); const to = definition && endpointFor(definition, active.toEndpointId);
      if (!from || !to) return;
      transfer = { transferId: active.requestId, teleporterId: active.teleporterId, robotId: active.robotId, fromEndpointId: from.id, toEndpointId: to.id, phase: "entry_aligned", controlEpoch: active.controlEpoch, sourceMapId: from.mapId, destinationMapId: to.mapId, commandId: active.requestId, reason: "recovered from durable ledger" };
    }
    const next = update.phase as TeleporterTransfer["phase"];
    if (next === "completed") {
      const robot = this.state.robots.get(update.robotId); const definition = this.teleporterStore.get(transfer.teleporterId); const endpoint = definition && endpointFor(definition, transfer.toEndpointId);
      if (!robot || !endpoint || Date.now() - robot.reportedAt > SESSION_TIMEOUT_MS || Math.hypot(robot.x - endpoint.clearingPoint.x, robot.y - endpoint.clearingPoint.y) > 3 || endpointPolygonOverlaps(endpoint, this.robotBodyPolygon(robot))) return;
    }
    if (next === "destination_ready" && transfer.destinationMapId === MAP_ID && !this.teleporterStore.claimRobotOwner({ robotId: update.robotId, mapId: MAP_ID, controlEpoch: update.controlEpoch, expectedMapId: transfer.sourceMapId, transferId: update.transferId })) return;
    const advanced = advanceTeleporterTransfer(transfer, next, { transferId: update.transferId, robotId: update.robotId, controlEpoch: update.controlEpoch });
    this.teleporterTransfers.set(update.robotId, { ...advanced, reason: update.reason || advanced.reason });
    this.persistTransfer({ ...advanced, destinationEpoch: update.controlEpoch });
    const projectedRobot = this.state.robots.get(update.robotId);
    if (projectedRobot) {
      projectedRobot.commandId = advanced.transferId;
      if (advanced.phase === "completed") { projectedRobot.commandState = "completed"; projectedRobot.commandReason = REASON_CODES.code['teleporter clearing completed']; projectedRobot.workState = "idle"; projectedRobot.status = "idle"; }
      else if (advanced.phase === "failed") { projectedRobot.commandState = "failed"; projectedRobot.commandReason = update.reason || "teleporter transfer failed"; projectedRobot.workState = "idle"; }
      else { projectedRobot.commandState = "running"; projectedRobot.commandReason = advanced.phase; projectedRobot.workState = "busy"; }
      this.persistRobot(update.robotId, true);
    }
    const durableEpoch = this.teleporterStore.getTransfer(advanced.transferId)?.sourceEpoch ?? transfer.controlEpoch;
    const stateGuard = { robotId: advanced.robotId, requestId: advanced.transferId, controlEpoch: durableEpoch };
    if (["destination_loading", "destination_ready", "arrived"].includes(advanced.phase)) { try { this.teleporterStore.setState(advanced.teleporterId, "occupied", stateGuard); } catch { /* stale event or a newer holder */ } }
    if (advanced.phase === "clearing") { try { this.teleporterStore.setState(advanced.teleporterId, "clearing", stateGuard); } catch { /* stale event or a newer holder */ } }
    if (advanced.phase === "completed") {
      const eligible = new Set<string>();
      for (const mapId of Object.keys(RUNTIME_MAPS)) for (const candidate of this.teleporterStore.mapWorld(mapId).robots as { robotId?: string; connected?: boolean; fmsControlState?: string; controlReady?: boolean }[]) if (candidate.connected && candidate.fmsControlState === "enabled" && candidate.controlReady !== false && candidate.robotId) eligible.add(candidate.robotId);
      const durable = this.teleporterStore.getTransfer(advanced.transferId);
      const completionDefinition = this.teleporterStore.get(advanced.teleporterId);
      this.teleporterStore.complete(advanced.teleporterId, advanced.robotId, advanced.transferId, durable?.sourceEpoch ?? transfer.controlEpoch, (request) => {
        if (!eligible.has(request.robotId)) return false;
        const owner = this.teleporterStore.getRobotOwner(request.robotId);
        return !owner || owner.controlEpoch === request.controlEpoch;
      }); this.teleporterTransfers.delete(update.robotId);
    }
  }

  private persistTransfer(transfer: TeleporterTransfer & { destinationEpoch?: number }): void {
    // The in-memory control epoch advances at the destination. Preserve the
    // original source epoch in the ledger so completion/recovery guards can
    // still authenticate the source handoff.
    const existing = this.teleporterStore.getTransfer(transfer.transferId);
    this.teleporterStore.saveTransfer({ transferId: transfer.transferId, teleporterId: transfer.teleporterId, robotId: transfer.robotId, fromEndpointId: transfer.fromEndpointId, toEndpointId: transfer.toEndpointId, phase: transfer.phase, sourceMapId: transfer.sourceMapId, destinationMapId: transfer.destinationMapId, sourceEpoch: existing?.sourceEpoch ?? transfer.controlEpoch, destinationEpoch: transfer.destinationEpoch ?? transfer.controlEpoch, reason: transfer.reason });
  }

  private syncTeleporterTransfers(): void {
    if (!this.teleporterStore || !this.state) return;
    // Promotion is durable and raced safely in TeleporterStore.  Each map
    // advertises only robots it can actually operate, so a disconnected or
    // disabled head of the queue remains queued while another map room may
    // promote an eligible request.
    const eligible = new Set<string>();
    for (const mapId of Object.keys(RUNTIME_MAPS)) {
      const world = this.teleporterStore.mapWorld(mapId);
      if (!world.fresh) continue;
      for (const candidate of world.robots as { robotId?: string; connected?: boolean; fmsControlState?: string; controlReady?: boolean }[]) {
        if (candidate.robotId && candidate.connected && candidate.fmsControlState === "enabled" && candidate.controlReady !== false) eligible.add(candidate.robotId);
      }
    }
    const eligibleRequest = (request: { robotId: string; controlEpoch: number }) => {
      if (!eligible.has(request.robotId)) return false;
      const owner = this.teleporterStore.getRobotOwner(request.robotId);
      return !owner || (owner.mapId === MAP_ID && owner.controlEpoch === request.controlEpoch);
    };
    for (const definition of this.teleporterStore.list()) {
      if (this.teleporterStore.activeUse(definition.id)) continue;
      // A room may promote only a request whose source endpoint is on this
      // map. The global eligible set still lets us skip disconnected heads
      // without allowing a later local request to jump an eligible remote
      // request.
      const next = this.teleporterStore.queue(definition.id).find(item => eligibleRequest({ robotId: item.robotId, controlEpoch: item.controlEpoch }));
      const source = next && endpointFor(definition, next.fromEndpointId);
      if (next && source?.mapId === MAP_ID) this.teleporterStore.promoteNext(definition.id, eligibleRequest);
    }
    for (const [robotId] of this.state.robots) {
      for (const definition of this.teleporterStore.list()) {
        const active = this.teleporterStore.activeUse(definition.id);
        if (!active || active.robotId !== robotId) continue;
        const from = endpointFor(definition, active.fromEndpointId); const to = endpointFor(definition, active.toEndpointId);
        if (!from || !to || from.mapId !== MAP_ID && to.mapId !== MAP_ID) continue;
        const existing = this.teleporterTransfers.get(robotId);
        // A queued request already has a local requested record.  Once the
        // store promotes it, replace that state with the durable reservation
        // and issue the approach command exactly once.
        if (existing?.transferId === active.requestId && existing.phase === "requested") {
          const promoted = { ...existing, phase: "reserved" as const, reason: "teleporter reservation promoted" };
          this.teleporterTransfers.set(robotId, promoted);
          this.persistTransfer(promoted);
          const robot = this.state.robots.get(robotId);
          if (robot) {
            // The queued request's transfer ID is reused for the eventual
            // destination handoff. Give the approach command its own ID so a
            // completed queued approach cannot suppress clearing at arrival.
            robot.commandId = `${active.requestId}:entry`;
            robot.commandState = "running";
            robot.commandReason = REASON_CODES.code['teleporter reservation promoted'];
          }
        } else if (existing && existing.transferId === active.requestId) break;
        const phase = active.state === "clearing" ? "clearing" : active.state === "occupied" ? "arrived" : active.state === "reserved" ? "reserved" : "requested";
        const recovered = { transferId: active.requestId, teleporterId: active.teleporterId, robotId, fromEndpointId: from.id, toEndpointId: to.id, phase, controlEpoch: active.controlEpoch, sourceMapId: from.mapId, destinationMapId: to.mapId, commandId: active.requestId, reason: "recovered from durable ledger" } satisfies TeleporterTransfer;
        if (!this.teleporterTransfers.has(robotId)) this.teleporterTransfers.set(robotId, recovered);
        if (phase === "reserved" && from.mapId === MAP_ID && this.canControl(robotId)) {
          const entryCommandId = `${active.requestId}:entry`;
          const robot = this.state.robots.get(robotId);
          if (robot) { robot.commandId = entryCommandId; robot.commandState = "running"; robot.commandReason = REASON_CODES.code['teleporter entry']; }
          void sendDrive(robotId, { command_id: entryCommandId, kind: "teleporter_entry", x: from.position.x, y: from.position.y, theta: from.entryTheta,
            event_context_json: JSON.stringify({ target: { id: definition.id, kind: "teleporter", name: definition.name, mapId: MAP_ID } }) });
        }
        break;
      }
    }
  }

  private maybeStartTeleporterTransfer(robot: Robot): void {
    const transfer = this.teleporterTransfers.get(robot.id); if (!transfer || !["reserved", "entry_approach"].includes(transfer.phase)) return;
    const definition = this.teleporterStore.get(transfer.teleporterId); const from = definition && endpointFor(definition, transfer.fromEndpointId); const to = definition && endpointFor(definition, transfer.toEndpointId);
    if (!from || !to) return;
    const distance = Math.hypot(robot.x - from.position.x, robot.y - from.position.y);
    if (distance > 2 || Math.abs(Math.atan2(Math.sin(robot.theta - from.entryTheta), Math.cos(robot.theta - from.entryTheta))) > 0.12) return;
    const approached = transfer.phase === "reserved" ? advanceTeleporterTransfer(transfer, "entry_approach", { transferId: transfer.transferId, robotId: robot.id, controlEpoch: robot.controlEpoch }) : transfer;
    const advanced = advanceTeleporterTransfer(approached, "entry_aligned", { transferId: transfer.transferId, robotId: robot.id, controlEpoch: robot.controlEpoch });
    if (advanced.phase !== "entry_aligned") return;
    const target = `localhost:${((RUNTIME_MAPS as Record<string, { grpcPort: number }>)[to.mapId]?.grpcPort ?? 0) + FMS_PORT_OFFSET}`;
    const destinationEpoch = robot.controlEpoch + 1;
    const destinationWorld = this.teleporterStore.mapWorld(to.mapId);
    const targetWorldBlocked = this.teleporterStore.endpointBlocked({ teleporterId: transfer.teleporterId, endpointId: to.id, robotPoses: destinationWorld.robots as { robotId: string; x: number; y: number; bodyPolygon?: { x: number; y: number }[] }[] });
    const targetPathBlocked = endpointClearingPathBlocked(to, (destinationWorld.robots as { robotId: string; x: number; y: number; bodyPolygon?: { x: number; y: number }[] }[]).map(peer => ({ ...peer, bodyPolygon: peer.bodyPolygon ?? [] })), robot.id);
    const activeUse = this.teleporterStore.activeUse(transfer.teleporterId);
    if (!destinationWorld.fresh || destinationWorld.readiness[`${transfer.teleporterId}:${to.id}`] !== true || targetWorldBlocked.robotIds.some(id => id !== robot.id) || targetPathBlocked || (activeUse && activeUse.robotId !== robot.id)) return;
    const nextTransfer = { ...advanced, phase: "destination_loading" as const, destinationEpoch };
    if (!this.teleporterStore.commitTransfer({ transferId: nextTransfer.transferId, teleporterId: nextTransfer.teleporterId, robotId: nextTransfer.robotId, fromEndpointId: nextTransfer.fromEndpointId, toEndpointId: nextTransfer.toEndpointId, phase: nextTransfer.phase, sourceMapId: nextTransfer.sourceMapId, destinationMapId: nextTransfer.destinationMapId, sourceEpoch: nextTransfer.controlEpoch, destinationEpoch, reason: nextTransfer.reason }, { robotId: robot.id, mapId: to.mapId, controlEpoch: destinationEpoch, expectedMapId: from.mapId })) return;
    this.teleporterTransfers.set(robot.id, nextTransfer);
    if (!sendCommittedTeleporterTransfer(robot.id, { transfer_id: transfer.transferId, teleporter_id: transfer.teleporterId, from_endpoint_id: from.id, to_endpoint_id: to.id, destination_map_id: to.mapId, destination_target: target, entry_x: from.position.x, entry_y: from.position.y, entry_theta: from.entryTheta, exit_x: to.position.x, exit_y: to.position.y, exit_theta: to.exitTheta, clearing_x: to.clearingPoint.x, clearing_y: to.clearingPoint.y, control_epoch: robot.controlEpoch })) return;
  }

  private maybeReleaseTeleporterOccupancy(robot: Robot): void {
    const transfer = this.teleporterTransfers.get(robot.id);
    if (!transfer || transfer.phase !== "clearing") return;
    const definition = this.teleporterStore.get(transfer.teleporterId);
    const endpoint = definition && [transfer.fromEndpointId, transfer.toEndpointId]
      .map(id => endpointFor(definition, id)).find(item => item?.mapId === MAP_ID);
    if (!endpoint || endpointPolygonOverlaps(endpoint, this.robotBodyPolygon(robot))) return;
    const eligible = new Set([...this.state.robots.values()]
      .filter(candidate => candidate.connected && candidate.fmsControlState === "enabled" && candidate.controlReady !== false)
      .map(candidate => candidate.id));
    this.teleporterStore.releaseOccupancy(transfer.teleporterId, robot.id, transfer.transferId, eligible);
  }

  private applyCommandState(robot: Robot, commandId: string, state: CommandState, reason: string): void {
    const current = { commandId: robot.commandId, commandState: robot.commandState as CommandState, commandReason: robot.commandReason };
    const next = projectCommandState(current, commandId, state, reason);
    if (next === current) return;
    robot.commandId = next.commandId;
    robot.commandState = next.commandState;
    robot.commandReason = next.commandReason;
    if (isTerminalCommandState(next.commandState) || next.commandState === "interrupted") {
      robot.status = "idle";
    }
    // Terminal transitions can be followed by another command before the
    // periodic frame tick. Capture every lifecycle boundary synchronously.
    this.captureBlackbox();
  }

  private cancelRobot(client: Client, payload: CancelPayload) {
    const robotId = str(payload?.robotId);
    if (!robotId) {
      deny(client, "robotId required");
      return;
    }
    const robot = this.state.robots.get(robotId);
    const transfer = this.teleporterTransfers.get(robotId);
    if (transfer && ["requested", "reserved", "entry_approach"].includes(transfer.phase)) {
      const definition = this.teleporterStore.get(transfer.teleporterId); const from = definition && endpointFor(definition, transfer.fromEndpointId);
      const bodyInside = !!robot && !!from && endpointPolygonOverlaps(from, this.robotBodyPolygon(robot));
      const entryCommandId = robot?.commandId || `${transfer.transferId}:entry`;
      // Fence the physical command before changing durable occupancy. A live
      // robot with an unwriteable stream keeps its reservation for retry.
      if (!bodyInside && robot?.connected && !sendCancel(robotId, entryCommandId)) {
        deny(client, "robot disconnected while cancelling teleporter entry");
        return;
      }
      if (this.teleporterStore.cancelQueued(transfer.teleporterId, robotId, transfer.transferId) || (!bodyInside && this.teleporterStore.cancelReserved(transfer.teleporterId, robotId, transfer.transferId))) {
        this.persistTransfer({ ...transfer, phase: "failed", reason: "cancelled by operator" });
        this.teleporterTransfers.delete(robotId); if (robot) { robot.commandState = "cancelled"; robot.commandReason = REASON_CODES.code['teleporter request cancelled']; robot.workState = "idle"; }
        client.send(REPLY_KINDS.code.commandAck, { robotId, kind: "teleporter", commandId: transfer.transferId, state: "cancelled" }); return;
      }
    }
    const ok = sendCancel(robotId, robot?.commandId || "");
    if (!ok) {
      deny(client, `robot ${robotId} is not connected`);
      return;
    }
    if (robot) {
      robot.commandReason = REASON_CODES.code['cancel requested'];
    }
  }

  private maybeBroadcastSensedPeers(): void {
    // SIM_PEER_SENSING: FMS forwards peer poses as a sim sensor proxy (see constants).
    if (!SIM_PEER_SENSING_DEFAULT) return;
    const now = Date.now();
    const minPeriod = Math.max(20, Math.floor(1000 / SIM_PEER_SENSING_HZ));
    if (now - this.lastSensedPeersMs < minPeriod) return;
    this.lastSensedPeersMs = now;
    const peers: { robotId: string; x: number; y: number; theta: number }[] = [];
    this.state.robots.forEach((r, id) => {
      // Loss of communication does not remove a physical body. Retain the
      // last observed pose but never advertise its obsolete future path.
      if (!isRobotConnected(id) && r.reportedAt <= 0) return;
      peers.push({ robotId: id, x: r.x, y: r.y, theta: r.theta });
    });
    broadcastSensedPeers(peers);
  }

  private maybeBroadcastFleetLocalPlans(): void {
    if (parseTrafficPolicyId(TRAFFIC_POLICY_ID) !== "local_plan_v1") return;
    const now = Date.now();
    const minPeriod = Math.max(20, Math.floor(1000 / SIM_PEER_SENSING_HZ));
    if (now - this.lastFleetPlanMs < minPeriod) return;
    this.lastFleetPlanMs = now;
    const peers: {
      robotId: string;
      x: number;
      y: number;
      theta: number;
      points: { x: number; y: number }[];
      operatorPaused?: boolean;
    }[] = [];
    this.state.robots.forEach((r, id) => {
      if (!isRobotConnected(id) && r.reportedAt <= 0) return;
      const extras = this.robotTraffic.get(id);
      peers.push({
        robotId: id,
        x: r.x,
        y: r.y,
        theta: r.theta,
        points: r.operatorPaused || !this.canControl(id)
          ? []
          : extras?.localPath?.length
          ? extras.localPath
          : [...r.path].slice(0, 12).map((p) => ({ x: p.x, y: p.y })),
        operatorPaused: r.operatorPaused,
      });
    });
    broadcastFleetLocalPlans(peers);
  }

  private obstacleList(): DynObstacle[] {
    const out: DynObstacle[] = [];
    this.state.obstacles.forEach((o) => {
      const kind = parseObstacleKind(o.kind);
      if (!kind) return;
      out.push({ id: o.id, kind, x: o.x, y: o.y, size: o.size, theta: o.theta });
    });
    return out;
  }

  private pushObstacles(): void {
    broadcastObstacles(this.obstacleList());
  }

  private async placeObstacle(client: Client, payload: ObstaclePayload) {
    const kind = parseObstacleKind(str(payload?.kind));
    const rawX = num(payload?.x);
    const rawY = num(payload?.y);
    const size = clampObstacleSize(num(payload?.size) ?? 16);
    const theta = num(payload?.theta) ?? 0;
    if (!kind || rawX === null || rawY === null) {
      deny(client, "invalid placeObstacle");
      return;
    }
    const { x, y } = clampObstaclePos(rawX, rawY);
    const candidate: DynObstacle = { id: "pending", kind, x, y, size, theta };
    console.log(`[floor] placeObstacle ${kind} (${x.toFixed(1)},${y.toFixed(1)}) size=${size}`);
    const { ok, denied } = await queryPlace(candidate);
    if (!ok) {
      console.log(`[floor] placeObstacle denied: ${denied.join(", ")}`);
      deny(client, `obstacle blocked (${denied.join(", ") || "robots"})`);
      return;
    }
    const id = `ob-${crypto.randomUUID()}`;
    const item = new Obstacle();
    item.id = id;
    item.name = id;
    item.kind = kind;
    item.x = x;
    item.y = y;
    item.size = size;
    item.theta = theta;
    this.state.obstacles.set(id, item);
    persistAndSetObstacle(this.state, { id, name: id, kind, x, y, size, theta });
    this.pushObstacles();
    broadcastSemanticSnapshot();
    this.broadcast(REPLY_KINDS.code.obstacleAck, { id, kind });
  }

  private async moveObstacle(client: Client, payload: MoveObstaclePayload) {
    const id = str(payload?.id);
    const item = this.state.obstacles.get(id);
    const kind = item ? parseObstacleKind(item.kind) : null;
    const rawX = num(payload?.x);
    const rawY = num(payload?.y);
    if (!item || !kind || rawX === null || rawY === null) {
      deny(client, "invalid moveObstacle");
      return;
    }
    const { x, y } = clampObstaclePos(rawX, rawY);
    const size = clampObstacleSize(num(payload?.size) ?? item.size);
    const theta = num(payload?.theta) ?? item.theta;
    const candidate: DynObstacle = { id, kind, x, y, size, theta };
    const { ok, denied } = await queryPlace(candidate);
    if (!ok) {
      deny(client, `obstacle blocked (${denied.join(", ") || "robots"})`);
      return;
    }
    item.x = x;
    item.y = y;
    item.size = size;
    item.theta = theta;
    persistAndSetObstacle(this.state, { id, name: item.name || id, kind, x, y, size, theta });
    this.pushObstacles();
    broadcastSemanticSnapshot();
    this.broadcast(REPLY_KINDS.code.obstacleAck, { id, kind });
  }

  private deleteObstacle(client: Client, payload: DeleteObstaclePayload) {
    const id = str(payload?.id);
    if (!id || !this.state.obstacles.has(id)) {
      deny(client, "unknown obstacle");
      return;
    }
    persistDelete(this.state, "obstacle", id);
    this.pushObstacles();
    broadcastSemanticSnapshot();
  }
}
