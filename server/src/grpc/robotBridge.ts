import { PROTOCOL_MESSAGES, PROTOCOL_DIRECTIONS } from "../../../shared/config/messages.ts";
import * as grpc from "@grpc/grpc-js";
import { currentOperationId, commandOperationId } from "../blackboxIntegration.ts";
import * as protoLoader from "@grpc/proto-loader";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GRPC_PORT,
  PLACE_QUERY_TIMEOUT_MS,
  SIM_PEER_SENSING_DEFAULT,
  TRAFFIC_POLICY_ID,
} from "../../../shared/constants.ts";
import { HEARTBEAT_MS, PROTOCOL_VERSION, SESSION_TIMEOUT_MS, parseCommandState, type CommandState } from "../../../shared/robotProtocol.ts";
import { parseTrafficPolicyId } from "../../../shared/traffic/types.ts";
import type { DynObstacle } from "../../../shared/obstacles.ts";

const PROTO_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../proto/robot.proto");

const pack = grpc.loadPackageDefinition(
  protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  }),
) as any;

const RobotBridge = pack.bgfms.RobotBridge;

export type PoseUpdate = {
  robotId: string;
  x: number;
  y: number;
  theta: number;
  status: string;
  path?: { x: number; y: number }[];
  leaseId?: string;
  motion?: string;
  avoidanceMode?: boolean;
  headRoomPx?: number;
  trafficStatus?: string;
  localPath?: { x: number; y: number }[];
  localHorizonS?: number;
  commandId?: string;
  commandState?: CommandState;
  commandReason?: string;
  workState?: string;
  driveState?: string;
  driveContextJson?: string;
  reportedAt?: number;
  controlEpoch?: number;
  sessionId?: string;
  navigationMode?: string;
  pathPlanningAuthority?: string;
  operatorPaused?: boolean;
};
export type CommandStateUpdate = { robotId: string; commandId: string; commandState: CommandState; commandReason: string };

export type DriveCommand = {
  command_id: string;
  kind: string;
  x: number;
  y: number;
  theta: number;
  event_context_json?: string;
};

type PoseSink = (pose: PoseUpdate) => void;
type LocalPlanSink = (
  robotId: string,
  points: { x: number; y: number }[],
  horizonS: number,
) => void;
type DisconnectSink = (robotId: string) => void;
type RegisterSink = (robotId: string, capabilities: { supportsPoseOverride: boolean }) => void;
type RegisterGuard = (robotId: string, mapId: string, transferId: string) => boolean;
type CommandStateSink = (update: CommandStateUpdate) => void;
type LeaseRequestSink = (robotId: string, msg: any) => void;
type LeaseReleaseSink = (robotId: string, msg: any) => void;
type BidSink = (robotId: string, msg: any) => void;
type EvasionReplySink = (robotId: string, msg: any) => void;
type TrafficStopCheckSink = (robotId: string, msg: any) => void;
export type MotionPauseAck = { requestId: string; paused: boolean; applied: boolean; reasonCode: string; controlEpoch: number; sessionId: string };
type MotionPauseAckSink = (robotId: string, ack: MotionPauseAck) => void;
type StreamCall = grpc.ServerDuplexStream<any, any>;
type ObstacleProvider = () => DynObstacle[];
type SemanticProvider = () => unknown;
export type ControlState = { enabled: boolean; controlEpoch: number; operatorPaused?: boolean };
export type ControlAck = ControlState & { ready: boolean; sessionId: string };
export type PoseOverrideCommand = { requestId: string; x: number; y: number; theta: number; controlEpoch: number };
export type PoseOverrideAck = { requestId: string; applied: boolean; reasonCode: string; controlEpoch: number; sessionId: string };
type ControlProvider = (robotId: string) => ControlState;
type ControlAckSink = (robotId: string, ack: ControlAck) => void;
type ControlGuard = (robotId: string) => boolean;
export type TeleporterTransferUpdate = { robotId: string; transferId: string; phase: string; reason: string; mapId: string; controlEpoch: number; sessionId: string };
type TeleporterTransferSink = (update: TeleporterTransferUpdate) => void;

const sessions = new Map<string, StreamCall>();
const lastSeen = new Map<StreamCall, number>();
let watchdog: ReturnType<typeof setInterval> | null = null;
let poseSink: PoseSink | null = null;
let localPlanSink: LocalPlanSink | null = null;
let disconnectSink: DisconnectSink | null = null;
let registerSink: RegisterSink | null = null;
let registerGuard: RegisterGuard | null = null;
let commandStateSink: CommandStateSink | null = null;
let knownRobotIds: (() => Iterable<string>) | null = null;
let leaseRequestSink: LeaseRequestSink | null = null;
let leaseReleaseSink: LeaseReleaseSink | null = null;
let bidSink: BidSink | null = null;
let evasionReplySink: EvasionReplySink | null = null;
let trafficStopCheckSink: TrafficStopCheckSink | null = null;
let motionPauseAckSink: MotionPauseAckSink | null = null;
let obstacleProvider: ObstacleProvider = () => [];
let semanticProvider: SemanticProvider = () => null;
let controlProvider: ControlProvider = () => ({ enabled: true, controlEpoch: 0 });
let controlAckSink: ControlAckSink | null = null;
let poseOverrideAckSink: ((robotId: string, ack: PoseOverrideAck) => void) | null = null;
type ProtocolTrace = (direction: (typeof PROTOCOL_DIRECTIONS.values)[number], robotId: string, message: Record<string, any>, reason?: string) => void;
let protocolTrace: ProtocolTrace | null = null;
export function setProtocolTrace(trace: ProtocolTrace | null) { protocolTrace = trace; }
let controlGuard: ControlGuard = () => true;
let teleporterTransferSink: TeleporterTransferSink | null = null;
const sessionIds = new Map<string, string>();
const sessionEpochs = new Map<string, number>();

type PendingQuery = {
  remaining: Set<string>;
  denied: string[];
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: { ok: boolean; denied: string[] }) => void;
};
const pending = new Map<string, PendingQuery>();

export function setPoseSink(fn: PoseSink | null) {
  poseSink = fn;
}

export function setLocalPlanSink(fn: LocalPlanSink | null) {
  localPlanSink = fn;
}

export function setDisconnectSink(fn: DisconnectSink | null) {
  disconnectSink = fn;
}

export function setRegisterSink(fn: RegisterSink | null) {
  registerSink = fn;
}
export function setRegisterGuard(fn: RegisterGuard | null) { registerGuard = fn; }
export function setCommandStateSink(fn: CommandStateSink | null) { commandStateSink = fn; }
export function setKnownRobotIds(fn: (() => Iterable<string>) | null) { knownRobotIds = fn; }

export function setLeaseRequestSink(fn: LeaseRequestSink | null) {
  leaseRequestSink = fn;
}

export function setLeaseReleaseSink(fn: LeaseReleaseSink | null) {
  leaseReleaseSink = fn;
}

export function setBidSink(fn: BidSink | null) {
  bidSink = fn;
}

export function setEvasionReplySink(fn: EvasionReplySink | null) {
  evasionReplySink = fn;
}
export function setTrafficStopCheckSink(fn: TrafficStopCheckSink | null) {
  trafficStopCheckSink = fn;
}
export function setMotionPauseAckSink(fn: MotionPauseAckSink | null) { motionPauseAckSink = fn; }

export function setObstacleProvider(fn: ObstacleProvider) {
  obstacleProvider = fn;
}

/** Semantic map is delivered once on registration and after editor changes. */
export function setSemanticProvider(fn: SemanticProvider) {
  semanticProvider = fn;
}
export function setControlProvider(fn: ControlProvider) { controlProvider = fn; }
export function setControlAckSink(fn: ControlAckSink | null) { controlAckSink = fn; }
export function setPoseOverrideAckSink(fn: ((robotId: string, ack: PoseOverrideAck) => void) | null) { poseOverrideAckSink = fn; }
export function setControlGuard(fn: ControlGuard) { controlGuard = fn; }
export function setTeleporterTransferSink(fn: TeleporterTransferSink | null) { teleporterTransferSink = fn; }

export function sendTeleporterTransfer(robotId: string, command: Record<string, unknown>): boolean {
  return writeOperational(robotId, PROTOCOL_MESSAGES.code.teleporter_transfer, { robot_id: robotId, ...command });
}
/** Transfer handoff is sent after the durable owner CAS. It may cross the normal
 * source control fence once, but remains bound to the current authenticated
 * session and epoch. */
export function sendCommittedTeleporterTransfer(robotId: string, command: Record<string, unknown>): boolean {
  const epoch = Number(command.control_epoch);
  if (!Number.isFinite(epoch) || epoch !== (sessionEpochs.get(robotId) ?? controlProvider(robotId).controlEpoch)) return false;
  return writeTo(robotId, { teleporter_transfer: envelope(robotId, { robot_id: robotId, ...command }) });
}
export function sendTeleporterConstraints(robotId: string, constraints: { blocked: { id: string; polygon: { x: number; y: number }[] }[] }): boolean {
  return writeTo(robotId, { teleporter_constraints: envelope(robotId, { json: JSON.stringify(constraints) }) });
}

export function sendControlState(robotId: string, state: ControlState): boolean {
  const sessionId = sessionIds.get(robotId);
  if (!sessionId) return false;
  sessionEpochs.set(robotId, state.controlEpoch);
  const operatorPaused = state.operatorPaused ?? controlProvider(robotId).operatorPaused === true;
  return writeTo(robotId, { control_state: { enabled: state.enabled, control_epoch: state.controlEpoch, session_id: sessionId, operator_paused: operatorPaused } });
}

/** Independent actuator request; it remains sendable while FMS control is disabled. */
export function sendMotionPause(robotId: string, request: { requestId: string; paused: boolean; controlEpoch: number }): boolean {
  const sessionId = sessionIds.get(robotId);
  if (!sessionId || !request.requestId || sessionEpochs.get(robotId) !== request.controlEpoch) return false;
  return writeTo(robotId, { motion_pause: { request_id: request.requestId, paused: request.paused, control_epoch: request.controlEpoch, session_id: sessionId } });
}

/**
 * Simulator-only administrative command. It deliberately bypasses the normal
 * operational guard because the server sends it while control is disabled.
 */
export function sendPoseOverride(robotId: string, command: PoseOverrideCommand): boolean {
  const sessionId = sessionIds.get(robotId);
  if (!sessionId || !Number.isSafeInteger(command.controlEpoch) || sessionEpochs.get(robotId) !== command.controlEpoch) return false;
  return writeTo(robotId, { pose_override: {
    request_id: command.requestId,
    x: command.x,
    y: command.y,
    theta: command.theta,
    control_epoch: command.controlEpoch,
    session_id: sessionId,
  } });
}

export function broadcastSemanticSnapshot(): void {
  const snapshot = semanticProvider();
  if (snapshot == null) return;
  const json = JSON.stringify(snapshot);
  for (const id of connectedRobotIds()) writeTo(id, { semantic_snapshot: { json } });
}

export function connectedRobotIds(): string[] {
  return [...sessions.keys()].filter((id) => isRobotConnected(id));
}

export function isRobotConnected(robotId: string): boolean {
  const call = sessions.get(robotId);
  return !!call && !call.destroyed;
}
export function getRobotSessionId(robotId: string): string | null { return sessionIds.get(robotId) ?? null; }

function writeTo(robotId: string, msg: Record<string, unknown>): boolean {
  const call = sessions.get(robotId);
  if (!call || call.destroyed || call.writableEnded) return false;
  try {
    const body = Object.values(msg).find(v => v && typeof v === "object") as any;
    const operationId = currentOperationId() ?? commandOperationId(String(body?.command_id || body?.transfer_id || ""));
    const traced = operationId ? { ...msg, operation_id: operationId } : msg;
    protocolTrace?.("send", robotId, traced);
    call.write(traced);
    return true;
  } catch (err) {
    console.warn(`[grpc] write failed for ${robotId}:`, err);
    return false;
  }
}

export function sendDrive(robotId: string, cmd: DriveCommand): boolean {
  return writeOperational(robotId, PROTOCOL_MESSAGES.code.drive, cmd);
}

export function sendCancel(robotId: string, command_id = ""): boolean {
  return writeOperational(robotId, PROTOCOL_MESSAGES.code.cancel, { command_id });
}

export function sendLeaseGrant(robotId: string, payload: Record<string, unknown>): boolean {
  return writeOperational(robotId, PROTOCOL_MESSAGES.code.lease_grant, payload);
}

export function sendTrafficStopStatus(robotId: string, payload: Record<string, unknown>): boolean {
  return writeOperational(robotId, PROTOCOL_MESSAGES.code.traffic_stop_status, payload);
}

export function sendBidRequest(robotId: string, payload: Record<string, unknown>): boolean {
  return writeOperational(robotId, PROTOCOL_MESSAGES.code.bid_request, payload);
}

export function sendEvasionRequest(robotId: string, payload: Record<string, unknown>): boolean {
  return writeOperational(robotId, PROTOCOL_MESSAGES.code.evasion_request, payload);
}

export function sendZoneUpdate(robotId: string, payload: Record<string, unknown>): boolean {
  return writeOperational(robotId, PROTOCOL_MESSAGES.code.zone_update, payload);
}

function envelope(robotId: string, body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, control_epoch: sessionEpochs.get(robotId) ?? controlProvider(robotId).controlEpoch, session_id: sessionIds.get(robotId) ?? "" };
}
function writeOperational(robotId: string, key: string, body: Record<string, unknown>): boolean {
  if (!controlGuard(robotId)) { protocolTrace?.("discard", robotId, { [key]: body }, "control_not_ready"); return false; }
  return writeTo(robotId, { [key]: envelope(robotId, body) });
}

function shapeOf(o: DynObstacle) {
  return { id: o.id, kind: o.kind, x: o.x, y: o.y, size: o.size, theta: o.theta };
}

export function broadcastObstacles(items: DynObstacle[]): void {
  const payload = { obstacles: { items: items.map(shapeOf) } };
  for (const id of connectedRobotIds()) writeTo(id, payload);
}

export type SensedPeerPose = { robotId: string; x: number; y: number; theta: number };

/**
 * Push peer poses to each robot (self excluded). Gated by SIM_PEER_SENSING_DEFAULT —
 * sim-only sensor proxy; traffic lease code must not consume this.
 */
export function broadcastSensedPeers(peers: SensedPeerPose[]): void {
  if (!SIM_PEER_SENSING_DEFAULT) return;
  if (parseTrafficPolicyId(TRAFFIC_POLICY_ID) === "local_plan_v1") return;
  for (const id of connectedRobotIds()) {
    const others = peers
      .filter((p) => p.robotId !== id)
      .map((p) => ({
        robot_id: p.robotId,
        x: p.x,
        y: p.y,
        theta: p.theta,
      }));
    // Observations remain available while administratively disabled. They do
    // not grant motion authority, but keep test pose validation current.
    writeTo(id, { sensed_peers: envelope(id, { peers: others }) });
  }
}

export type FleetPeerPlan = {
  robotId: string;
  x: number;
  y: number;
  theta: number;
  points: { x: number; y: number }[];
  operatorPaused?: boolean;
};

/** Push pose + ~5s local plans to every other robot on this map (v1). */
export function broadcastFleetLocalPlans(peers: FleetPeerPlan[]): void {
  if (parseTrafficPolicyId(TRAFFIC_POLICY_ID) !== "local_plan_v1") return;
  for (const id of connectedRobotIds()) {
    const others = peers
      .filter((p) => p.robotId !== id)
      .map((p) => ({
        robot_id: p.robotId,
        x: p.x,
        y: p.y,
        theta: p.theta,
        points: p.points,
        operator_paused: p.operatorPaused === true,
      }));
    writeTo(id, { fleet_local_plans: envelope(id, { peers: others }) });
  }
}

export function tickRobotSessions(now = Date.now()): void {
  for (const [call, seen] of lastSeen) {
    if (now - seen <= SESSION_TIMEOUT_MS) continue;
    const id = [...sessions.entries()].find(([, c]) => c === call)?.[0] ?? null;
    dropSession(id, call);
    try { call.end(); } catch { /* ignore */ }
  }
  for (const id of connectedRobotIds()) writeTo(id, { heartbeat: { server_time_ms: now } });
}

function finishQuery(queryId: string, ok: boolean) {
  const p = pending.get(queryId);
  if (!p) return;
  pending.delete(queryId);
  clearTimeout(p.timer);
  p.resolve({ ok, denied: p.denied });
}

export function queryPlace(obstacle: DynObstacle): Promise<{ ok: boolean; denied: string[] }> {
  const ids = connectedRobotIds();
  if (!ids.length) return Promise.resolve({ ok: true, denied: [] });
  const query_id = crypto.randomUUID();
  return new Promise((resolve) => {
    const remaining = new Set(ids);
    const denied: string[] = [];
    const timer = setTimeout(() => {
      const p = pending.get(query_id);
      if (!p) return;
      for (const id of p.remaining) p.denied.push(`${id}:timeout`);
      finishQuery(query_id, false);
    }, PLACE_QUERY_TIMEOUT_MS);
    pending.set(query_id, { remaining, denied, timer, resolve });
    for (const id of ids) {
      const sent = writeTo(id, { place_query: { query_id, obstacle: shapeOf(obstacle) } });
      if (!sent) {
        remaining.delete(id);
        denied.push(`${id}:offline`);
      }
    }
    if (remaining.size === 0) finishQuery(query_id, denied.length === 0);
  });
}

function dropSession(robotId: string | null, call: StreamCall) {
  lastSeen.delete(call);
  if (!robotId) return;
  if (sessions.get(robotId) !== call) return;
  sessions.delete(robotId);
  disconnectSink?.(robotId);
}

function resolveRobotId(msgRobotId: unknown, sessionId: string | null): string {
  return String(msgRobotId || sessionId || "").trim();
}

function operationalMessageValid(robotId: string, body: any): boolean {
  const sid = String(body?.session_id ?? "");
  const epoch = Number(body?.control_epoch);
  const valid = sid === sessionIds.get(robotId) && Number.isFinite(epoch) && epoch === (sessionEpochs.get(robotId) ?? controlProvider(robotId).controlEpoch) && controlGuard(robotId);
  if (!valid) protocolTrace?.("discard", robotId, { stale: body }, "session_epoch_or_control_mismatch");
  return valid;
}
function telemetryMessageValid(robotId: string, body: any): boolean {
  const sid = String(body?.session_id ?? "");
  const epoch = Number(body?.control_epoch);
  return sid === sessionIds.get(robotId) && Number.isFinite(epoch) && epoch === (sessionEpochs.get(robotId) ?? controlProvider(robotId).controlEpoch);
}

function session(call: StreamCall) {
  let robotId: string | null = null;
  // Only the one bootstrap pose may omit the authenticated envelope. Every
  // subsequent pose is bound to the current session and control generation.
  let initialPoseAccepted = false;
  lastSeen.set(call, Date.now());

  call.on("data", (msg: any) => {
    lastSeen.set(call, Date.now());
    const which = msg?.payload;
    protocolTrace?.("receive", robotId ?? String(msg?.register?.robot_id ?? ""), msg);
    if (which === PROTOCOL_MESSAGES.code.register || msg?.register) {
      const id = String(msg.register?.robot_id ?? "").trim();
      if (!id) return;
      if (robotId && robotId !== id) return;
      const version = Number(msg.register?.protocol_version ?? 0);
      const mapId = String(msg.register?.map_id ?? "");
      const transferId = String(msg.register?.transfer_id ?? "");
      const known = !knownRobotIds || [...knownRobotIds()].includes(id);
      if (version !== PROTOCOL_VERSION || !(registerGuard ? registerGuard(id, mapId, transferId) : known)) {
        try { call.end(); } catch { /* ignore */ }
        return;
      }
      robotId = id;
      const prev = sessions.get(id);
      sessions.set(id, call);
      const sid = crypto.randomUUID();
      sessionIds.set(id, sid);
      console.log(`[grpc] registered ${id}`);
      // Do not prev.end() immediately — kicking the old stream makes the same
      // robot process reconnect and fight itself in a register loop.
      if (prev && prev !== call && !prev.destroyed) {
        try {
          prev.removeAllListeners("data");
        } catch {
          /* ignore */
        }
      }
      registerSink?.(id, { supportsPoseOverride: msg.register?.supports_pose_override === true });
      const control = controlProvider(id);
      sessionEpochs.set(id, control.controlEpoch);
      writeTo(id, { obstacles: { items: obstacleProvider().map(shapeOf) } });
      const semantic = semanticProvider();
      if (semantic != null) writeTo(id, { semantic_snapshot: { json: JSON.stringify(semantic) } });
      writeTo(id, { session_ready: { robot_id: id, protocol_version: PROTOCOL_VERSION, heartbeat_ms: HEARTBEAT_MS, session_id: sid, control_epoch: control.controlEpoch, enabled: control.enabled } });
      sendControlState(id, control);
      return;
    }

    // Every payload after registration is bound to the authenticated stream.
    if (!robotId) return;

    if (which === PROTOCOL_MESSAGES.code.pose || msg?.pose) {
      const p = msg.pose ?? {};
      const id = resolveRobotId(p.robot_id, robotId);
      if (!id) return;
      if (id !== robotId) return;
      if (!p.session_id && !initialPoseAccepted) initialPoseAccepted = true;
      else if (!telemetryMessageValid(robotId, p)) return;
      const x = Number(p.x);
      const y = Number(p.y);
      const theta = Number(p.theta);
      if (![x, y, theta].every(Number.isFinite)) return;
      const headRoom = Number(p.head_room_px);
      poseSink?.({
        robotId: id,
        x: Number.isFinite(x) ? x : 0,
        y: Number.isFinite(y) ? y : 0,
        theta: Number.isFinite(theta) ? theta : 0,
        status: p.status === "move" ? "move" : "idle",
        leaseId: p.lease_id != null ? String(p.lease_id) : undefined,
        motion: p.motion != null ? String(p.motion) : undefined,
        avoidanceMode: typeof p.avoidance_mode === "boolean" ? p.avoidance_mode : undefined,
        headRoomPx: Number.isFinite(headRoom) ? headRoom : undefined,
        trafficStatus: p.traffic_status != null ? String(p.traffic_status) : undefined,
        commandId: p.command_id ? String(p.command_id) : undefined,
        commandState: parseCommandState(p.command_state) ?? undefined,
        commandReason: p.command_reason ? String(p.command_reason) : undefined,
        workState: p.work_state ? String(p.work_state) : undefined,
        driveState: p.drive_state ? String(p.drive_state) : undefined,
        driveContextJson: p.drive_context_json ? String(p.drive_context_json) : undefined,
        reportedAt: Number.isFinite(Number(p.reported_at)) ? Number(p.reported_at) : undefined,
        controlEpoch: Number.isFinite(Number(p.control_epoch)) ? Number(p.control_epoch) : undefined,
        sessionId: p.session_id ? String(p.session_id) : undefined,
        navigationMode: p.navigation_mode ? String(p.navigation_mode) : undefined,
        pathPlanningAuthority: p.path_planning_authority ? String(p.path_planning_authority) : undefined,
        operatorPaused: typeof p.operator_paused === "boolean" ? p.operator_paused : undefined,
      });
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.pose_override_ack || msg?.pose_override_ack) {
      const a = msg.pose_override_ack ?? {};
      if (String(a.robot_id ?? robotId) !== robotId || !telemetryMessageValid(robotId, a) || !a.request_id) return;
      poseOverrideAckSink?.(robotId, { requestId: String(a.request_id), applied: a.applied === true,
        reasonCode: String(a.reason_code ?? ""), controlEpoch: Number(a.control_epoch), sessionId: String(a.session_id) });
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.control_ack || msg?.control_ack) {
      const a = msg.control_ack ?? {};
      const epoch = Number(a.control_epoch);
      const sid = String(a.session_id ?? "");
      if (String(a.robot_id ?? robotId) !== robotId || sid !== sessionIds.get(robotId) || epoch !== sessionEpochs.get(robotId)) return;
      controlAckSink?.(robotId, { controlEpoch: epoch, enabled: Boolean(a.enabled), ready: Boolean(a.ready), sessionId: sid });
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.motion_pause_ack || msg?.motion_pause_ack) {
      const a = msg.motion_pause_ack ?? {};
      if (String(a.robot_id ?? robotId) !== robotId || !telemetryMessageValid(robotId, a) || !String(a.request_id ?? "")) return;
      motionPauseAckSink?.(robotId, {
        requestId: String(a.request_id), paused: a.paused === true, applied: a.applied === true,
        reasonCode: String(a.reason_code ?? ""), controlEpoch: Number(a.control_epoch), sessionId: String(a.session_id),
      });
      return;
    }

    if (which === PROTOCOL_MESSAGES.code.heartbeat || msg?.heartbeat) return;
    if (which === PROTOCOL_MESSAGES.code.teleporter_transfer || msg?.teleporter_transfer) {
      const t = msg.teleporter_transfer ?? {};
      if (!operationalMessageValid(robotId, t)) return;
      if (String(t.robot_id ?? robotId) !== robotId || !String(t.transfer_id ?? "")) return;
      teleporterTransferSink?.({ robotId, transferId: String(t.transfer_id), phase: String(t.phase ?? ""), reason: String(t.reason ?? ""), mapId: String(t.map_id ?? ""), controlEpoch: Number(t.control_epoch), sessionId: String(t.session_id ?? "") });
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.command_state || msg?.command_state) {
      const r = msg.command_state ?? {};
      if (!operationalMessageValid(robotId, r)) return;
      const id = resolveRobotId(r.robot_id, robotId);
      const state = parseCommandState(r.state);
      const commandId = String(r.command_id ?? "").trim();
      if (!id || id !== robotId || !commandId || !state) return;
      commandStateSink?.({ robotId: id, commandId, commandState: state, commandReason: String(r.reason ?? "") });
      return;
    }

    if (which === PROTOCOL_MESSAGES.code.path || msg?.path) {
      const p = msg.path ?? {};
      if (!operationalMessageValid(robotId, p)) return;
      const id = resolveRobotId(p.robot_id, robotId);
      if (!id || id !== robotId) return;
      const raw = Array.isArray(p.points) ? p.points : [];
      const path = raw
        .map((pt: { x?: number; y?: number }) => ({ x: Number(pt?.x), y: Number(pt?.y) }))
        .filter((pt: { x: number; y: number }) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
      poseSink?.({
        robotId: id,
        x: 0,
        y: 0,
        theta: 0,
        status: "",
        path,
      });
      return;
    }

    if (which === PROTOCOL_MESSAGES.code.place_reply || msg?.place_reply) {
      const r = msg.place_reply ?? {};
      const queryId = String(r.query_id ?? "");
      const p = pending.get(queryId);
      if (!p) return;
      const id = resolveRobotId(r.robot_id, robotId);
      if (!id || !p.remaining.has(id)) return;
      p.remaining.delete(id);
      if (!r.ok) p.denied.push(`${id}:${r.reason || "blocked"}`);
      if (p.remaining.size === 0) finishQuery(queryId, p.denied.length === 0);
      return;
    }

    if (which === PROTOCOL_MESSAGES.code.lease_request || msg?.lease_request) {
      const r = msg.lease_request ?? {};
      if (!operationalMessageValid(robotId, r)) return;
      const id = resolveRobotId(r.robot_id, robotId);
      if (!id || id !== robotId) return;
      leaseRequestSink?.(id, r);
      return;
    }

    if (which === PROTOCOL_MESSAGES.code.lease_release || msg?.lease_release) {
      const r = msg.lease_release ?? {};
      if (!operationalMessageValid(robotId, r)) return;
      const id = resolveRobotId(r.robot_id, robotId);
      if (!id) return;
      leaseReleaseSink?.(id, r);
      return;
    }

    if (which === PROTOCOL_MESSAGES.code.traffic_bid || msg?.traffic_bid) {
      const r = msg.traffic_bid ?? {};
      if (!operationalMessageValid(robotId, r)) return;
      const id = resolveRobotId(null, robotId);
      if (!id) return;
      bidSink?.(id, r);
      return;
    }

    if (which === PROTOCOL_MESSAGES.code.evasion_reply || msg?.evasion_reply) {
      const r = msg.evasion_reply ?? {};
      if (!operationalMessageValid(robotId, r)) return;
      const id = resolveRobotId(null, robotId);
      if (!id) return;
      evasionReplySink?.(id, r);
      return;
    }

    if (which === PROTOCOL_MESSAGES.code.traffic_stop_check || msg?.traffic_stop_check) {
      const r = msg.traffic_stop_check ?? {};
      if (!operationalMessageValid(robotId, r)) return;
      if (resolveRobotId(r.robot_id, robotId) !== robotId || !String(r.stop_id ?? "") || Number(r.stop_generation) < 1) return;
      trafficStopCheckSink?.(robotId, r);
      return;
    }

    if (which === PROTOCOL_MESSAGES.code.local_plan || msg?.local_plan) {
      const p = msg.local_plan ?? {};
      if (!operationalMessageValid(robotId, p)) return;
      const id = resolveRobotId(p.robot_id, robotId);
      if (!id) return;
      const raw = Array.isArray(p.points) ? p.points : [];
      const points = raw
        .map((pt: { x?: number; y?: number }) => ({ x: Number(pt?.x), y: Number(pt?.y) }))
        .filter((pt: { x: number; y: number }) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
      const horizonS = Number(p.horizon_s);
      localPlanSink?.(id, points, Number.isFinite(horizonS) ? horizonS : 5);
      poseSink?.({
        robotId: id,
        x: 0,
        y: 0,
        theta: 0,
        status: "",
        localPath: points,
        localHorizonS: Number.isFinite(horizonS) ? horizonS : 5,
        operatorPaused: typeof p.operator_paused === "boolean" ? p.operator_paused : undefined,
      });
      return;
    }
  });

  const cleanup = () => dropSession(robotId, call);
  call.on("end", () => {
    cleanup();
    try {
      call.end();
    } catch {
      /* already ended */
    }
  });
  call.on("error", () => cleanup());
  call.on("cancelled", () => cleanup());
  call.on("close", () => cleanup());
}

export function startRobotBridge(port = GRPC_PORT): Promise<grpc.Server> {
  return new Promise((resolve, reject) => {
    const server = new grpc.Server();
    server.addService(RobotBridge.service, {
      Session: session,
      session,
    });
    server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, bound) => {
      if (err) {
        reject(err);
        return;
      }
      console.log(`gRPC RobotBridge.Session  0.0.0.0:${bound}`);
      if (!watchdog) {
        watchdog = setInterval(() => tickRobotSessions(), HEARTBEAT_MS);
        watchdog.unref();
      }
      resolve(server);
    });
  });
}

/** In-process hook used by protocol integration tests and embedded transports. */
export function attachRobotSession(call: StreamCall): void { session(call); }
