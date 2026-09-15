import { Client, Room } from "@colyseus/core";
import { isFree, isInflatedFree, loadSeed } from "../../../shared/occupancy.ts";
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
  sendZoneUpdate,
  setBidSink,
  setDisconnectSink,
  setEvasionReplySink,
  setLeaseReleaseSink,
  setLeaseRequestSink,
  setCommandStateSink,
  setKnownRobotIds,
  setObstacleProvider,
  setSemanticProvider,
  setPoseSink,
  setRegisterSink,
  setLocalPlanSink,
  setControlProvider,
  setControlGuard,
  setControlAckSink,
  sendControlState,
  getRobotSessionId,
  type ControlAck,
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
  SIM_PEER_SENSING_DEFAULT,
  SIM_PEER_SENSING_HZ,
  TRAFFIC_POLICY_ID,
} from "../../../shared/constants.ts";
import { parseTrafficPolicyId, parseTrafficStatus, type TrafficStatus } from "../../../shared/traffic/types.ts";
import { isTerminalCommandState, SESSION_TIMEOUT_MS, type CommandState } from "../../../shared/robotProtocol.ts";
import { parseWorkState, parseDriveState, parseDriveContexts, type DriveContext, type ResourceOccupancy, type RuntimeAck } from "../../../shared/robotRuntime.ts";
import { projectCommandState } from "../commandProjection.ts";
import { isSemanticPoseBlocked } from "../../../shared/semanticNavigation.ts";
import { robotViewFromPose, TrafficController } from "../traffic/index.ts";
import { RuntimeStore, type RobotRuntime } from "../runtimeStore.ts";

type RobotTrafficExtras = {
  motion: string;
  avoidanceMode: boolean;
  headRoomPx: number;
  localPath: { x: number; y: number }[];
  reportedTrafficStatus: TrafficStatus;
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
};
type CancelPayload = { robotId?: unknown };
type ObstaclePayload = { kind?: unknown; x?: unknown; y?: unknown; size?: unknown; theta?: unknown };
type MoveObstaclePayload = { id?: unknown; x?: unknown; y?: unknown; size?: unknown; theta?: unknown };
type DeleteObstaclePayload = { id?: unknown };

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function deny(client: Client, message: string) {
  client.send("error", { message });
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
  private reports = new Map<string, { workState: string; driveState: string; contexts: DriveContext[]; epoch: number; sessionId: string; receivedAt: number }>();
  private occupancies: ResourceOccupancy[] = [];
  private activations = new Map<string, { client: Client; requestId: string; epoch: number; startedAt: number; timer: ReturnType<typeof setTimeout> }>();
  private runtimeReplies = new Map<string, RuntimeAck>();

  onCreate(options?: { runtimeStore?: RuntimeStore; runtimeDbPath?: string }) {
    this.runtimeStoreOwned = !options?.runtimeStore;
    this.runtimeStore = options?.runtimeStore ?? new RuntimeStore(options?.runtimeDbPath);
    const seed = loadSeed();
    hydrateEditor(this.state, editorStore().snapshot());
    for (const rb of seed.robots) {
      const item = new Robot();
      item.id = rb.id;
      item.x = rb.x;
      item.y = rb.y;
      item.theta = rb.theta;
      item.status = rb.status === "move" ? "move" : "idle";
      const saved = this.runtimeStore.getRobot(rb.id);
      if (saved) {
        item.x = saved.x ?? item.x; item.y = saved.y ?? item.y; item.theta = saved.theta ?? item.theta;
        item.workState = "unknown"; item.fmsControlState = saved.fmsControlState;
        item.connectionState = "offline"; item.connectionReason = "server restarted";
        item.driveState = "unknown"; item.driveContextJson = saved.driveContextJson;
        item.controlEpoch = saved.controlEpoch; item.controlReady = false; item.reportedAt = saved.reportedAt;
        item.stateChangedAt = saved.stateChangedAt; item.sessionId = saved.sessionId;
        item.navigationMode = saved.navigationMode; item.pathPlanningAuthority = saved.pathPlanningAuthority;
      }
      this.state.robots.set(rb.id, item);
      this.robotTraffic.set(rb.id, { motion: "", avoidanceMode: true, headRoomPx: 0, localPath: [], reportedTrafficStatus: "clear" });
      this.persistRobot(rb.id, true);
    }
    setKnownRobotIds(() => this.state.robots.keys());

    this.publishOccupancies(this.runtimeStore.listOccupancies());
    setControlProvider(id => ({ enabled: this.activations.has(id) || this.state.robots.get(id)?.fmsControlState === "enabled", controlEpoch: this.state.robots.get(id)?.controlEpoch ?? 0 }));
    setControlGuard(id => this.canControl(id));
    setControlAckSink((id, ack) => this.onControlAck(id, ack));
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
              fmsControlState: r.fmsControlState as "enabled" | "disabled",
              controlReady: r.controlReady,
              controlEpoch: r.controlEpoch,
              poseObserved: r.reportedAt > 0,
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
    setRegisterSink((robotId) => {
      if (this.activations.has(robotId)) this.failActivation(robotId, "새 연결이 시작되어 운영 재개를 취소했습니다.");
      this.traffic.onRobotConnected(robotId);
      const robot = this.state.robots.get(robotId);
      if (robot) {
        robot.connected = true; robot.connectionState = "online"; robot.connectionReason = "synchronizing";
        robot.controlReady = false; robot.lastSeenAt = 0; robot.sessionId = getRobotSessionId(robotId) ?? "";
        this.clearOperationalState(robot);
        this.reports.delete(robotId);
        this.persistRobot(robotId, true);
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
        };
        this.robotTraffic.set(pose.robotId, { ...prev, localPath: pose.localPath });
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
        sessionId: pose.sessionId ?? "", receivedAt: robot.lastSeenAt };
      this.reports.set(robot.id, report);
      robot.navigationMode = ["free_navigation", "graph_navigation"].includes(pose.navigationMode ?? "") ? pose.navigationMode! : "unknown";
      robot.pathPlanningAuthority = ["robot", "fms", "hybrid"].includes(pose.pathPlanningAuthority ?? "") ? pose.pathPlanningAuthority! : "unknown";
      const currentReport = report.epoch === robot.controlEpoch && report.sessionId === robot.sessionId;
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
      };
      this.robotTraffic.set(pose.robotId, {
        motion: pose.motion ?? prev.motion,
        avoidanceMode: pose.avoidanceMode ?? prev.avoidanceMode,
        headRoomPx: pose.headRoomPx ?? prev.headRoomPx,
        localPath: prev.localPath,
        reportedTrafficStatus: pose.trafficStatus !== undefined ? parseTrafficStatus(pose.trafficStatus) : prev.reportedTrafficStatus,
      });
      this.projectRuntime(robot);
      this.persistRobot(pose.robotId);
      const reported = this.robotTraffic.get(pose.robotId)?.reportedTrafficStatus;
      if (reported === "hold" && robot.trafficStatus !== "stop" && robot.trafficStatus !== "evade" && robot.trafficStatus !== "lease_lost") robot.trafficStatus = "hold";
      this.maybeBroadcastSensedPeers();
      this.maybeBroadcastFleetLocalPlans();
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
      robot.connectionState = "offline"; robot.connectionReason = "session_lost"; robot.controlReady = false;
      if (this.activations.has(robotId)) this.failActivation(robotId, "연결이 끊겨 운영 재개를 취소했습니다.");
      robot.trafficStatus = "lease_lost";
      if (robot.commandId && !isTerminalCommandState(robot.commandState as CommandState)) {
        robot.commandState = "interrupted";
        robot.commandReason = "robot session disconnected";
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
    });

    this.onMessage("placeWaypoint", (client, payload: PlacePayload) => {
      this.place(client, "waypoint", payload);
    });
    this.onMessage("placeCharger", (client, payload: PlacePayload) => {
      this.place(client, "charger", payload);
    });
    this.onMessage("moveAsset", (client, payload: MoveAssetPayload) => {
      this.moveAsset(client, payload);
    });
    this.onMessage("deleteAsset", (client, payload: { kind?: unknown; id?: unknown }) => {
      const kind = str(payload?.kind);
      const id = str(payload?.id);
      if ((kind !== "waypoint" && kind !== "charger") || !id) {
        deny(client, "invalid deleteAsset");
        return;
      }
      if (!persistDelete(this.state, kind, id)) deny(client, `unknown ${kind} ${id}`);
      else broadcastSemanticSnapshot();
    });
    this.onMessage("editorUpsert", async (client, payload: Record<string, unknown>) => {
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
        client.send("editorAck", { kind, id, action: "upsert" });
      }
    });
    this.onMessage("editorDelete", (client, payload: Record<string, unknown>) => {
      const body = payload ?? {};
      const kind = str(body.kind), id = str(body.id);
      const existed = id && kind ? persistDelete(this.state, kind, id) : false;
      if (!existed) { handleEditorDelete(this.state, client, body); return; }
      if (kind === "obstacle") this.pushObstacles();
      broadcastSemanticSnapshot();
      client.send("editorAck", { kind, id, action: "delete" });
    });
    this.onMessage("setRobotControl", (client, payload: Record<string, unknown>) => this.setRobotControl(client, payload));
    this.onMessage("releaseResourceOccupancy", (client, payload: Record<string, unknown>) => this.releaseResourceOccupancy(client, payload));
    this.onMessage("commandRobot", (client, payload: CommandPayload) => {
      this.commandRobot(client, payload);
    });
    this.onMessage("cancelRobot", (client, payload: CancelPayload) => {
      this.cancelRobot(client, payload);
    });
    this.onMessage("placeObstacle", (client, payload: ObstaclePayload) => {
      void this.placeObstacle(client, payload);
    });
    this.onMessage("moveObstacle", (client, payload: MoveObstaclePayload) => {
      void this.moveObstacle(client, payload);
    });
    this.onMessage("deleteObstacle", (client, payload: DeleteObstaclePayload) => {
      this.deleteObstacle(client, payload);
    });

    setObstacleProvider(() => this.obstacleList());
    setSemanticProvider(() => editorStore().snapshot());
    this.pushObstacles();
    this.traffic.start();

      console.log(
      `[floor] sqlite + seed: ${this.state.waypoints.size} wp, ${this.state.chargingStations.size} cs, ${seed.robots.length} robots, ${this.state.zones.size} zones, ${this.state.nodes.size} nodes`,
    );
  }

  onDispose() {
    this.traffic.stop();
    for (const id of [...this.activations.keys()]) this.failActivation(id, "서버 종료로 운영 재개를 취소했습니다.");
    setControlAckSink(null);
    setControlGuard(() => false);
    setControlProvider(() => ({ enabled: false, controlEpoch: 0 }));
    setPoseSink(null);
    setCommandStateSink(null);
    setKnownRobotIds(null);
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
    if (enabled && robot.fmsControlState === "enabled" && robot.controlReady) return this.replyRuntime(client, requestId, true, "이미 정상 운영 중입니다.");
    if (enabled && (!robot.connected || Date.now() - robot.lastSeenAt > SESSION_TIMEOUT_MS)) return this.replyRuntime(client, requestId, false, "연결된 로봇의 최신 위치 보고가 필요합니다.");
    // Persist disabled throughout the preparation phase. A crash or timeout may
    // never turn a pending activation into implicit permission to operate.
    robot.controlEpoch++; robot.fmsControlState = "disabled"; robot.controlReady = false; robot.stateChangedAt = Date.now();
    this.clearOperationalState(robot);
    this.traffic.onRobotDisconnected(robotId);
    this.persistRobot(robotId, true);
    this.runtimeStore.audit({ action: enabled ? "reactivate_requested" : "disable_requested", robotId, requestId, expectedEpoch, details: { enabled, controlEpoch: robot.controlEpoch, actor: client.sessionId } });
    if (!enabled) {
      sendControlState(robotId, { enabled: false, controlEpoch: robot.controlEpoch });
      this.projectRuntime(robot);
      return this.replyRuntime(client, requestId, true, "운영에서 제외했습니다. 남은 점유는 유지됩니다.");
    }
    const timer = setTimeout(() => this.failActivation(robotId, "상태 동기화 시간이 초과되어 운영 제외를 유지합니다."), SESSION_TIMEOUT_MS);
    this.activations.set(robotId, { client, requestId, epoch: robot.controlEpoch, startedAt: Date.now(), timer });
    if (!sendControlState(robotId, { enabled: true, controlEpoch: robot.controlEpoch })) this.failActivation(robotId, "로봇에 동기화 요청을 전송하지 못했습니다.");
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
    return !!r && r.fmsControlState === "enabled" && r.controlReady && r.connected && isRobotConnected(robotId) && Date.now() - r.lastSeenAt <= SESSION_TIMEOUT_MS;
  }

  private clearOperationalState(robot: Robot): void {
    robot.path.clear(); robot.localPath.clear(); robot.leaseId = ""; robot.localHorizonS = 0;
    const extras = this.robotTraffic.get(robot.id);
    if (extras) extras.localPath = [];
    // This is loss of command authority, not a claim that the physical robot stopped.
    if (robot.commandId && !isTerminalCommandState(robot.commandState as CommandState)) {
      robot.commandState = "interrupted"; robot.commandReason = "control synchronization required";
    }
  }

  private onControlAck(robotId: string, ack: ControlAck): void {
    const robot = this.state.robots.get(robotId), report = this.reports.get(robotId);
    if (!robot || ack.controlEpoch !== robot.controlEpoch || ack.sessionId !== robot.sessionId) return;
    const pending = this.activations.get(robotId);
    const synchronized = ack.ready && robot.connected && !!report && report.epoch === ack.controlEpoch &&
      report.sessionId === ack.sessionId && Date.now() - report.receivedAt <= SESSION_TIMEOUT_MS &&
      report.workState === "idle" && report.driveState === "stationary" && isFree(robot.x, robot.y);
    if (pending) {
      if (!ack.enabled || !synchronized || report!.receivedAt < pending.startedAt) {
        this.failActivation(robotId, "로봇의 최신 위치·정지·작업 정리를 확인하지 못했습니다."); return;
      }
      clearTimeout(pending.timer); this.activations.delete(robotId);
      robot.fmsControlState = "enabled"; robot.controlReady = true; robot.connectionReason = "";
      robot.stateChangedAt = Date.now();
      this.persistRobot(robotId, true);
      this.traffic.onRobotConnected(robotId);
      this.runtimeStore.audit({ action: "reactivated", robotId, requestId: pending.requestId, details: { actor: pending.client.sessionId, controlEpoch: robot.controlEpoch } });
      this.replyRuntime(pending.client, pending.requestId, true, "상태 동기화를 완료하고 운영을 재개했습니다.");
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
    this.runtimeStore.audit({ action: "reactivation_failed", robotId, requestId: pending.requestId, details: { reason: message, actor: pending.client.sessionId } });
    this.replyRuntime(pending.client, pending.requestId, false, message);
  }

  private replyRuntime(client: Client, requestId: string, ok: boolean, message: string): void {
    const reply = { requestId, ok, message };
    this.runtimeReplies.set(`${client.sessionId}:${requestId}`, reply);
    if (this.runtimeReplies.size > 512) this.runtimeReplies.delete(this.runtimeReplies.keys().next().value!);
    try { client.send("runtimeAck", reply); } catch { /* disconnected operator; state remains persisted */ }
  }
  private replayRuntimeReply(client: Client, requestId: string): boolean {
    const reply = this.runtimeReplies.get(`${client.sessionId}:${requestId}`);
    if (reply) { client.send("runtimeAck", reply); return true; }
    return [...this.activations.values()].some(p => p.client.sessionId === client.sessionId && p.requestId === requestId);
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
          contexts.push({ reasonCode: blockers.length ? "resource_occupied" : "permission_pending", source: "fms", target: entry.resourceRef,
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
    const value: RobotRuntime = { robotId, x: robot.x, y: robot.y, theta: robot.theta, workState: robot.workState as RobotRuntime["workState"], fmsControlState: robot.fmsControlState as RobotRuntime["fmsControlState"], connectionState: robot.connected ? "online" : "offline", connectionReason: robot.connectionReason, driveState: robot.driveState, driveContextJson: robot.driveContextJson, controlEpoch: robot.controlEpoch, controlReady: robot.controlReady, reportedAt: robot.reportedAt, stateChangedAt: robot.stateChangedAt, sessionId: robot.sessionId, navigationMode: robot.navigationMode, pathPlanningAuthority: robot.pathPlanningAuthority };
    this.runtimeStore.upsertRobot(value);
  }

  private place(client: Client, kind: "waypoint" | "charger", payload: PlacePayload) {
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
    const kind = str(payload?.kind);
    const targetId = str(payload?.targetId);
    if (!robotId || (kind !== "move" && kind !== "dock")) {
      deny(client, "invalid commandRobot");
      return;
    }
    if (!this.state.robots.has(robotId)) {
      deny(client, `unknown robot ${robotId}`);
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
    const commandId = crypto.randomUUID();
    if (robot) {
      robot.commandId = commandId;
      robot.commandState = "sent";
      robot.commandReason = "sent to robot";
      robot.workState = "busy";
    }
    const ok = sendDrive(robotId, {
      command_id: commandId,
      kind,
      x,
      y,
      theta,
    });
    if (!ok) {
      if (robot) { robot.commandState = "rejected"; robot.commandReason = "robot disconnected"; }
      deny(client, `robot ${robotId} is not connected`);
      return;
    }

    this.broadcast("commandAck", { robotId, kind, commandId, state: "sent", targetId: targetId || undefined, x, y, theta });
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
  }

  private cancelRobot(client: Client, payload: CancelPayload) {
    const robotId = str(payload?.robotId);
    if (!robotId) {
      deny(client, "robotId required");
      return;
    }
    const robot = this.state.robots.get(robotId);
    const ok = sendCancel(robotId, robot?.commandId || "");
    if (!ok) {
      deny(client, `robot ${robotId} is not connected`);
      return;
    }
    if (robot) {
      robot.commandReason = "cancel requested";
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
      if (!isRobotConnected(id)) return;
      peers.push({ robotId: id, x: r.x, y: r.y, theta: r.theta });
    });
    if (peers.length < 2) return;
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
    }[] = [];
    this.state.robots.forEach((r, id) => {
      const extras = this.robotTraffic.get(id);
      peers.push({
        robotId: id,
        x: r.x,
        y: r.y,
        theta: r.theta,
        points: !this.canControl(id)
          ? []
          : extras?.localPath?.length
          ? extras.localPath
          : [...r.path].slice(0, 12).map((p) => ({ x: p.x, y: p.y })),
      });
    });
    if (peers.length < 2) return;
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
    this.broadcast("obstacleAck", { id, kind });
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
    this.broadcast("obstacleAck", { id, kind });
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
