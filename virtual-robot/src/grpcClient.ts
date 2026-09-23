import { PROTOCOL_MESSAGES, PROTOCOL_DIRECTIONS } from "../../shared/config/messages.ts";
import { REASON_CODES } from "../../shared/config/reasons.ts";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GRPC_PORT, LOOKAHEAD_S, MAP_ID, TICK_MS, TRAFFIC_POLICY_ID } from "../../shared/constants.ts";
import { parseTrafficPolicyId } from "../../shared/traffic/types.ts";
import type { DriveCmd, PoseSnapshot } from "./controller.ts";
import { parseObstacleKind, type DynObstacle } from "../../shared/obstacles.ts";
import type { SemanticSnapshot } from "../../shared/semantic.ts";
import { PROTOCOL_VERSION, SESSION_TIMEOUT_MS } from "../../shared/robotProtocol.ts";
import { Recorder } from "../../server/src/blackbox/recorder.ts";
import { EVENT_KINDS } from "../../shared/config/events.ts";


const protoPath = join(dirname(fileURLToPath(import.meta.url)), "../../proto/robot.proto");

const pack = grpc.loadPackageDefinition(
  protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  }),
) as any;

const RobotBridge = pack.bgfms.RobotBridge as grpc.ServiceClientConstructor;
const DEFAULT_TARGET = `localhost:${GRPC_PORT}`;

export type GrpcClientOptions = {
  robotId: string;
  transferId?: string;
  target?: string;
  getPose: () => PoseSnapshot;
  getPath: () => { x: number; y: number }[];
  takePathDelta: () => { x: number; y: number }[] | null;
  onDrive: (cmd: DriveCmd) => void;
  onCancel: (commandId?: string) => void;
  onPoseOverride?: (command: { requestId: string; x: number; y: number; theta: number }) => boolean;
  onPlaceQuery: (obs: DynObstacle) => { ok: boolean; reason: string };
  onObstacles: (items: DynObstacle[]) => void;
  onSemanticSnapshot?: (snapshot: Pick<SemanticSnapshot, "zones" | "obstacles">) => void;
  onConnectionState?: (ready: boolean) => void;
  onControlState?: (state: { enabled: boolean; controlEpoch: number; sessionId: string; operatorPaused?: boolean }) => void;
  onMotionPause?: (command: { requestId: string; paused: boolean }) => { applied: boolean; reasonCode?: string };
  onControlSynchronized?: () => void;
  onSensedPeers?: (peers: { robotId: string; x: number; y: number; theta: number }[]) => void;
  onLeaseGrant?: (msg: any) => void;
  onBidRequest?: (zoneId: string, windowMs: number) => void;
  onEvasionRequest?: (msg: any) => void;
  onTrafficStopStatus?: (msg: any) => void;
  onZoneUpdate?: (zoneId: string, state: string) => void;
  onTeleporterTransfer?: (command: {
    robotId: string; transferId: string; teleporterId: string; fromEndpointId: string; toEndpointId: string;
    destinationMapId: string; destinationTarget: string; entry: { x: number; y: number; theta: number };
    exit: { x: number; y: number; theta: number }; clearing: { x: number; y: number };
    controlEpoch: number; sessionId: string;
  }) => void;
  onTeleporterConstraints?: (constraints: { blocked: { id: string; polygon: { x: number; y: number }[] }[] }) => void;
  getLocalPlan?: () => { x: number; y: number }[];
  onFleetLocalPlans?: (
    peers: { robotId: string; x: number; y: number; theta: number; points: { x: number; y: number }[]; operatorPaused?: boolean }[],
  ) => void;
};

export class GrpcClient {
  private readonly robotId: string;
  private target: string;
  private readonly getPose: () => PoseSnapshot;
  private readonly getPath: () => { x: number; y: number }[];
  private readonly takePathDelta: () => { x: number; y: number }[] | null;
  private readonly onDrive: (cmd: DriveCmd) => void;
  private readonly onCancel: (commandId?: string) => void;
  private readonly onPoseOverride?: GrpcClientOptions["onPoseOverride"];
  private readonly onPlaceQuery: (obs: DynObstacle) => { ok: boolean; reason: string };
  private readonly onObstacles: (items: DynObstacle[]) => void;
  private readonly onSemanticSnapshot?: (snapshot: Pick<SemanticSnapshot, "zones" | "obstacles">) => void;
  private readonly onConnectionState?: (ready: boolean) => void;
  private readonly onControlState?: (state: { enabled: boolean; controlEpoch: number; sessionId: string; operatorPaused?: boolean }) => void;
  private readonly onMotionPause?: GrpcClientOptions["onMotionPause"];
  private readonly onControlSynchronized?: () => void;
  private readonly onSensedPeers?: (peers: { robotId: string; x: number; y: number; theta: number }[]) => void;
  private readonly onLeaseGrant?: (msg: any) => void;
  private readonly onBidRequest?: (zoneId: string, windowMs: number) => void;
  private readonly onEvasionRequest?: (msg: any) => void;
  private readonly onTrafficStopStatus?: (msg: any) => void;
  private readonly onZoneUpdate?: (zoneId: string, state: string) => void;
  private readonly onTeleporterTransfer?: GrpcClientOptions["onTeleporterTransfer"];
  private readonly onTeleporterConstraints?: GrpcClientOptions["onTeleporterConstraints"];
  private readonly getLocalPlan?: () => { x: number; y: number }[];
  private readonly onFleetLocalPlans?: (
    peers: { robotId: string; x: number; y: number; theta: number; points: { x: number; y: number }[]; operatorPaused?: boolean }[],
  ) => void;
  private readonly policyId = parseTrafficPolicyId(TRAFFIC_POLICY_ID);
  private running = false;
  private stub: InstanceType<typeof RobotBridge> | null = null;
  private liveStream: grpc.ClientDuplexStream<any, any> | null = null;
  private sessionReady = false;
  private snapshotReady = false;
  private lastHeartbeatMs = 0;
  private sessionId = "";
  private controlEpoch = 0;
  private controlEnabled = false;
  private transferId = "";
  private pendingControlAck = false;
  private poseOverrideResults = new Map<string, { applied: boolean; reason_code: string }>();
  private motionPauseResults = new Map<string, { paused: boolean; applied: boolean; reason_code: string }>();
  private recorder?: Recorder;
  private recorderMapId = "";
  /** Recent command correlations keep asynchronous planner events on the
   * mission operation even when a pause/pose request arrives in between. */
  private commandOperations = new Map<string, string>();
  /** Diagnostic-only command context supplied by FMS; never passed to motion execution. */
  private commandContexts = new Map<string, Record<string, unknown>>();
  private activeCommandId = "";
  private activeCommandOperationId = "";

  private recordEvent(input: any): void {
    try { this.recorder?.record(input); } catch { /* diagnostics must never affect motion */ }
  }

  tracePlanning(event: Record<string, unknown>): void {
    const commandId = String(typeof event.commandId === "string" ? event.commandId : this.getPose().commandId || this.activeCommandId || "");
    const operationId = commandId ? this.commandOperations.get(commandId) : this.activeCommandOperationId;
    const phaseKind = `planner.${String(event.phase ?? "requested")}`;
    const kind = typeof event.kind === "string" && EVENT_KINDS.is(event.kind) ? event.kind : EVENT_KINDS.is(phaseKind) ? phaseKind : String(event.kind ?? phaseKind);
    this.recordEvent({ timeMs: Date.now(), category: "planning", kind, robotId: this.robotId,
      operationId: operationId || undefined, commandId: commandId || undefined, payload: { level: event.phase === "failed" ? "error" : "info", sessionId: this.sessionId || undefined, ...event, ...this.contextPayload(commandId) } });
  }

  private contextPayload(commandId?: string): Record<string, unknown> {
    const context = commandId ? this.commandContexts.get(commandId) : undefined;
    return context ? { eventContext: context } : {};
  }

  private parseEventContext(raw: unknown): Record<string, unknown> | undefined {
    if (typeof raw !== "string" || !raw.trim()) return undefined;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch { return undefined; }
  }

  private traceRuntime(kind: string, payload: Record<string, unknown>): void {
    this.recordEvent({ timeMs: Date.now(), category: kind.startsWith("error.") ? "error" : "connection", kind, robotId: this.robotId,
      operationId: this.activeCommandOperationId || undefined, payload: { level: kind.startsWith("error.") ? "error" : "info", sessionId: this.sessionId || undefined, ...payload } });
  }

  private traceCommand(kind: string, commandId: string | undefined, requestId: string | undefined, payload: Record<string, unknown>, operationId?: string | null): void {
    const correlatedOperation = operationId === null ? undefined : operationId || (commandId ? this.commandOperations.get(commandId) : undefined) || this.activeCommandOperationId || undefined;
    this.recordEvent({ timeMs: Date.now(), category: "operation", kind, robotId: this.robotId,
      operationId: correlatedOperation, commandId: commandId || undefined, requestId: requestId || undefined,
      payload: { level: kind.includes("reject") ? "warn" : "info", sessionId: this.sessionId || undefined, ...this.contextPayload(commandId), ...payload } });
  }

  private traceProtocol(direction: Exclude<(typeof PROTOCOL_DIRECTIONS.values)[number], typeof PROTOCOL_DIRECTIONS.code.discard>, message: any): void {
    const kind = typeof message?.payload === "string" ? message.payload : Object.keys(message ?? {}).find(k => k !== "operation_id") ?? "unknown";
    if ([PROTOCOL_MESSAGES.code.heartbeat, PROTOCOL_MESSAGES.code.pose, PROTOCOL_MESSAGES.code.path, PROTOCOL_MESSAGES.code.local_plan, PROTOCOL_MESSAGES.code.breadcrumb].includes(kind)) return;
    const body = message?.[kind] ?? {};
    const commandId = body.command_id || body.transfer_id || undefined;
    const eventContext = kind === PROTOCOL_MESSAGES.code.drive ? this.parseEventContext(body.event_context_json)
      : commandId ? this.commandContexts.get(String(commandId)) : undefined;
    this.recordEvent({ timeMs: Date.now(), category: "protocol", kind: `${direction}.${kind}`, robotId: this.robotId,
      operationId: message.operation_id || (commandId ? this.commandOperations.get(String(commandId)) : undefined) || this.activeCommandOperationId || undefined, commandId,
      requestId: body.request_id || undefined, payload: { level: "info", direction, sessionId: this.sessionId || undefined, message, ...(eventContext ? { eventContext } : {}) } });
  }

  constructor(opts: GrpcClientOptions) {
    this.robotId = opts.robotId;
    this.transferId = opts.transferId ?? "";
    this.target = opts.target ?? DEFAULT_TARGET;
    this.getPose = opts.getPose;
    this.getPath = opts.getPath;
    this.takePathDelta = opts.takePathDelta;
    this.onDrive = opts.onDrive;
    this.onCancel = opts.onCancel;
    this.onPoseOverride = opts.onPoseOverride;
    this.onPlaceQuery = opts.onPlaceQuery;
    this.onObstacles = opts.onObstacles;
    this.onSemanticSnapshot = opts.onSemanticSnapshot;
    this.onConnectionState = opts.onConnectionState;
    this.onControlState = opts.onControlState;
    this.onMotionPause = opts.onMotionPause;
    this.onControlSynchronized = opts.onControlSynchronized;
    this.onSensedPeers = opts.onSensedPeers;
    this.onLeaseGrant = opts.onLeaseGrant;
    this.onBidRequest = opts.onBidRequest;
    this.onEvasionRequest = opts.onEvasionRequest;
    this.onTrafficStopStatus = opts.onTrafficStopStatus;
    this.onZoneUpdate = opts.onZoneUpdate;
    this.onTeleporterTransfer = opts.onTeleporterTransfer;
    this.onTeleporterConstraints = opts.onTeleporterConstraints;
    this.getLocalPlan = opts.getLocalPlan;
    this.onFleetLocalPlans = opts.onFleetLocalPlans;
  }

  /** Switch map FMS while retaining the global robot id and normal handshake. */
  switchTarget(target: string): void {
    const normalized = String(target).trim();
    if (!normalized || normalized === this.target) return;
    this.target = normalized;
    try { this.liveStream?.cancel(); } catch { /* already closed */ }
    this.liveStream = null;
    try { this.stub?.close(); } catch { /* already closed */ }
    this.stub = new RobotBridge(this.target, grpc.credentials.createInsecure());
    this.sessionReady = false;
    this.snapshotReady = false;
    this.controlEnabled = false;
    this.onConnectionState?.(false);
  }

  /** Forget a transfer identity after an operator aborts it. */
  clearTeleporterTransferIdentity(): void {
    this.transferId = "";
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stub = new RobotBridge(this.target, grpc.credentials.createInsecure());
    void this.connectLoop();
  }

  stop(): Promise<void> {
    this.running = false;
    try { this.liveStream?.cancel(); } catch { /* already closed */ }
    this.liveStream = null;
    this.stub?.close();
    this.stub = null;
    this.sessionReady = false;
    this.snapshotReady = false;
    this.sessionId = "";
    this.controlEnabled = false;
    this.commandOperations.clear();
    this.commandContexts.clear();
    this.activeCommandId = "";
    this.activeCommandOperationId = "";
    this.onConnectionState?.(false);
    const flushed = this.recorder?.close() ?? Promise.resolve();
    this.recorder = undefined;
    return flushed;
  }

  sendLeaseRequest(body: {
    request_id: string;
    lease_id: string;
    wanted: { segments: unknown[] };
    gain_px: number;
    urgent: boolean;
  }): void {
    this.writePayload({
      lease_request: {
        robot_id: this.robotId,
        request_id: body.request_id,
        lease_id: body.lease_id,
        wanted: body.wanted,
        gain_px: body.gain_px,
        urgent: body.urgent,
        ...this.envelope(),
      },
    });
  }

  sendLeaseRelease(body: {
    lease_id: string;
    freed: { segments: unknown[] };
    retained: { segments: unknown[] };
  }): void {
    this.writePayload({
      lease_release: {
        robot_id: this.robotId,
        lease_id: body.lease_id,
        freed: body.freed,
      retained: body.retained,
      ...this.envelope(),
      },
    });
  }

  sendTrafficBid(zoneId: string, seed: number): void {
    this.writePayload({
      traffic_bid: {
        zone_id: zoneId,
        seed,
        ...this.envelope(),
      },
    });
  }

  sendTrafficStopCheck(body: { stop_id: string; stop_generation: string }): void {
    this.writePayload({
      traffic_stop_check: {
        robot_id: this.robotId,
        stop_id: body.stop_id,
        stop_generation: body.stop_generation,
        ...this.envelope(),
      },
    });
  }

  sendEvasionReply(body: Record<string, unknown>): void {
    this.writePayload({
      evasion_reply: {
        zone_id: body.zone_id ?? "",
        round_id: body.round_id ?? "",
        result: body.result ?? "NONE",
        reason: body.reason ?? "",
        ...this.envelope(),
      },
    });
  }

  sendCommandState(body: { command_id: string; state: string; reason: string }): void {
    const kind = body.state === "completed" ? EVENT_KINDS.code["command.complete"]
      : body.state === "cancelled" ? EVENT_KINDS.code["command.cancelled"]
      : body.state === "rejected" || body.state === "failed" ? EVENT_KINDS.code["command.reject"]
      : body.state === "running" || body.state === "accepted" ? EVENT_KINDS.code["command.execute"]
      : `command.${body.state}`;
    const operationId = this.commandOperations.get(body.command_id) || (body.command_id === this.activeCommandId ? this.activeCommandOperationId : undefined);
    this.traceCommand(kind, body.command_id, undefined, { state: body.state, reason: body.reason, ...this.contextPayload(body.command_id) }, operationId);
    this.writePayload({ command_state: { robot_id: this.robotId, command_id: body.command_id, state: body.state, reason: body.reason, ...this.envelope() } });
    if (["completed", "cancelled", "rejected", "failed"].includes(body.state) && body.command_id === this.activeCommandId) {
      this.activeCommandId = "";
      this.activeCommandOperationId = "";
    }
  }

  sendTeleporterTransferUpdate(body: { transferId: string; phase: string; reason?: string; mapId?: string }): void {
    this.transferId = body.transferId;
    // The terminal update must be preceded by the latest pose on the same
    // HTTP/2 stream.  FMS uses that pose to validate the clearing point.
    if (body.phase === "completed") this.sendInitialTelemetry();
    this.writePayload({ teleporter_transfer: { robot_id: this.robotId, transfer_id: body.transferId, phase: body.phase, reason: body.reason ?? "", map_id: body.mapId ?? "", ...this.envelope() } });
  }

  private envelope(): { control_epoch: number; session_id: string } {
    return { control_epoch: this.controlEpoch, session_id: this.sessionId };
  }

  private writePayload(msg: Record<string, unknown>): void {
    if (!this.controlEnabled && [PROTOCOL_MESSAGES.code.lease_request, PROTOCOL_MESSAGES.code.lease_release, PROTOCOL_MESSAGES.code.traffic_bid, PROTOCOL_MESSAGES.code.traffic_stop_check, PROTOCOL_MESSAGES.code.evasion_reply, PROTOCOL_MESSAGES.code.command_state, PROTOCOL_MESSAGES.code.local_plan].some(k => msg[k])) return;
    const stream = this.liveStream;
    if (!stream || !stream.writable) return;
    try {
      const operationId = msg.operation_id || this.operationForOutgoingMessage(msg);
      const traced = operationId ? { ...msg, operation_id: operationId } : msg;
      stream.write(traced);
    } catch (err) {
      console.warn(`[${this.robotId}] stream write failed:`, err);
    }
  }

  private operationForOutgoingMessage(message: Record<string, unknown>): string | undefined {
    const command = message.command_state as Record<string, unknown> | undefined;
    const cancel = message.cancel as Record<string, unknown> | undefined;
    const commandId = command?.command_id ?? cancel?.command_id;
    if (commandId != null) return this.commandOperations.get(String(commandId));
    return this.activeCommandOperationId || undefined;
  }

  private waitReady(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.stub) {
        reject(new Error("grpc stub missing"));
        return;
      }
      this.stub.waitForReady(Date.now() + timeoutMs, (err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async connectLoop(): Promise<void> {
    let delayMs = 500;
    while (this.running) {
      const started = Date.now();
      let opened = false;
      try {
        this.traceRuntime(EVENT_KINDS.code["connection.attempt"], { target: this.target });
        console.log(`[${this.robotId}] connecting ${this.target}`);
        await this.waitReady(2000);
        opened = true;
        await this.runSession();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.traceRuntime(EVENT_KINDS.code["error.session"], { message: msg });
        console.error(`[${this.robotId}] session: ${msg}`);
      }
      if (!this.running) return;
      this.onConnectionState?.(false);
      if (opened && Date.now() - started > 2000) delayMs = 500;
      this.traceRuntime(EVENT_KINDS.code["connection.retry"], { delayMs });
      console.log(`[${this.robotId}] reconnect in ${delayMs}ms`);
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 10_000);
    }
  }

  private runSession(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.stub) {
        reject(new Error("grpc stub missing"));
        return;
      }

      let settled = false;
      this.sessionReady = false;
      this.snapshotReady = false;
      this.commandOperations.clear();
      this.commandContexts.clear();
      this.activeCommandId = "";
      this.activeCommandOperationId = "";
      let poseTimer: ReturnType<typeof setInterval> | null = null;
      const stream: grpc.ClientDuplexStream<any, any> = this.stub.Session();
      if (process.env.FMS_BLACKBOX !== "0" && (!this.recorder || this.recorderMapId !== MAP_ID)) {
        void this.recorder?.close();
        this.recorder = new Recorder({ source: `robot-${this.robotId}`, mapId: MAP_ID });
        this.recorderMapId = MAP_ID;
      }
      const write = stream.write.bind(stream);
      stream.write = ((message: any, ...args: any[]) => {
        const operationId = message?.operation_id || this.operationForOutgoingMessage(message);
        const traced = operationId ? { ...message, operation_id: operationId } : message;
        this.traceProtocol("send", traced);
        return (write as any)(traced, ...args);
      }) as typeof stream.write;
      this.liveStream = stream;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (poseTimer) clearInterval(poseTimer);
        if (this.liveStream === stream) this.liveStream = null;
        this.sessionReady = false;
        this.snapshotReady = false;
        this.commandOperations.clear();
        this.commandContexts.clear();
        this.activeCommandId = "";
        this.activeCommandOperationId = "";
        this.onConnectionState?.(false);
        try {
          stream.cancel();
        } catch {
          // already closed
        }
        if (err) reject(err);
        else resolve();
      };

      stream.on("data", (msg: any) => {
        this.traceProtocol("receive", msg);
        try {
          this.handleServerMsg(msg);
        } catch (err) {
          this.traceRuntime(EVENT_KINDS.code["error.message_handler"], { message: err instanceof Error ? err.message : String(err) });
          console.error(`[${this.robotId}] handleServerMsg:`, err);
        }
      });
      stream.on("error", (err: Error) => {
        const code = (err as any).code as number | undefined;
        if (code === grpc.status.CANCELLED) {
          finish();
          return;
        }
        this.traceRuntime(EVENT_KINDS.code["error.connection"], { message: err.message, code });
        finish(err);
      });
      stream.on("end", () => finish());
      stream.on("close", () => finish());

      try {
        this.lastHeartbeatMs = Date.now();
        stream.write({ register: { robot_id: this.robotId, protocol_version: PROTOCOL_VERSION, map_id: MAP_ID, transfer_id: this.transferId, supports_pose_override: true } });
        console.log(`[${this.robotId}] registered`);
        // Telemetry is allowed before the authoritative control handshake; it is
        // also useful to make the physical starting pose immediately observable.
        const initial = this.getPose();
        stream.write({ pose: { robot_id: this.robotId, x: initial.x, y: initial.y, theta: initial.theta, status: initial.status, motion: initial.motion, command_id: initial.commandId, command_state: initial.commandState, command_reason: initial.commandReason, operator_paused: initial.operatorPaused } });
        stream.write({ path: { robot_id: this.robotId, points: this.getPath() } });
        if (this.policyId === "local_plan_v1" && this.getLocalPlan) stream.write({ local_plan: { robot_id: this.robotId, points: this.getLocalPlan(), horizon_s: LOOKAHEAD_S, operator_paused: Boolean(initial.operatorPaused) } });
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      poseTimer = setInterval(() => {
        if (settled || !stream.writable) return;
        if (Date.now() - this.lastHeartbeatMs > SESSION_TIMEOUT_MS) {
          finish(new Error("server heartbeat timeout"));
          return;
        }
        try {
          const pose = this.getPose();
          stream.write({
            pose: {
              robot_id: this.robotId,
              x: pose.x,
              y: pose.y,
              theta: pose.theta,
              status: pose.status,
              lease_id: pose.leaseId,
              motion: pose.motion,
              avoidance_mode: pose.avoidanceMode,
              head_room_px: pose.headRoomPx,
              traffic_status: pose.trafficStatus,
              command_id: pose.commandId,
              command_state: pose.commandState,
              command_reason: pose.commandReason,
              work_state: pose.workState,
              drive_state: pose.driveState,
              drive_context_json: pose.driveContextJson,
              reported_at: pose.reportedAt, navigation_mode: pose.navigationMode, path_planning_authority: pose.pathPlanningAuthority,
              operator_paused: pose.operatorPaused,
              ...this.envelope(),
            },
          });
          const path = this.takePathDelta();
          if (path) {
            stream.write({
              path: {
                robot_id: this.robotId,
                points: path,
                ...this.envelope(),
              },
            });
          }
          if (this.policyId === "local_plan_v1" && this.getLocalPlan) {
            stream.write({
              local_plan: {
                robot_id: this.robotId,
                points: this.getLocalPlan(),
                horizon_s: LOOKAHEAD_S,
                operator_paused: Boolean(pose.operatorPaused),
                ...this.envelope(),
              },
            });
          }
        } catch (err) {
          console.warn(`[${this.robotId}] pose write failed:`, err);
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      }, TICK_MS);
    });
  }

  private handleServerMsg(msg: any): void {
    const which = msg.payload as string | undefined;
    if (which === PROTOCOL_MESSAGES.code.session_ready) {
      const ready = msg.session_ready ?? {};
      if (String(ready.robot_id ?? "") !== this.robotId || Number(ready.protocol_version ?? PROTOCOL_VERSION) !== PROTOCOL_VERSION) return;
      this.sessionReady = true;
      this.sessionId = String(ready.session_id ?? "");
      this.controlEpoch = Number(ready.control_epoch ?? 0);
      this.controlEnabled = Boolean(ready.enabled);
      this.sendInitialTelemetry();
      if (this.snapshotReady) this.onConnectionState?.(true);
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.teleporter_transfer) {
      const t = msg.teleporter_transfer ?? {};
      if (String(t.robot_id ?? this.robotId) !== this.robotId || !this.validEnvelope(t)) return;
      this.onTeleporterTransfer?.({
        robotId: this.robotId, transferId: String(t.transfer_id ?? ""), teleporterId: String(t.teleporter_id ?? ""),
        fromEndpointId: String(t.from_endpoint_id ?? ""), toEndpointId: String(t.to_endpoint_id ?? ""),
        destinationMapId: String(t.destination_map_id ?? ""), destinationTarget: String(t.destination_target ?? ""),
        entry: { x: Number(t.entry_x), y: Number(t.entry_y), theta: Number(t.entry_theta) },
        exit: { x: Number(t.exit_x), y: Number(t.exit_y), theta: Number(t.exit_theta) },
        clearing: { x: Number(t.clearing_x), y: Number(t.clearing_y) },
        controlEpoch: Number(t.control_epoch), sessionId: String(t.session_id ?? ""),
      });
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.teleporter_constraints) {
      if (!this.validEnvelope(msg.teleporter_constraints)) return;
      try {
        const value = JSON.parse(String(msg.teleporter_constraints?.json ?? "{}"));
        if (Array.isArray(value.blocked)) this.onTeleporterConstraints?.({ blocked: value.blocked });
      } catch { /* malformed snapshots are ignored */ }
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.heartbeat) {
      this.lastHeartbeatMs = Date.now();
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.control_state) {
      const c = msg.control_state ?? {};
      const sid = String(c.session_id ?? "");
      const epoch = Number(c.control_epoch);
      if (sid !== this.sessionId || !Number.isFinite(epoch) || epoch < this.controlEpoch) return;
      this.controlEpoch = epoch;
      this.controlEnabled = Boolean(c.enabled);
      this.pendingControlAck = true;
      this.onControlState?.({ enabled: this.controlEnabled, controlEpoch: epoch, sessionId: sid, operatorPaused: Boolean(c.operator_paused) });
      if (this.snapshotReady) this.sendControlAck();
      if (this.snapshotReady && this.controlEnabled) this.onControlSynchronized?.();
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.motion_pause) {
      const pause = msg.motion_pause ?? {};
      if (String(pause.robot_id ?? this.robotId) !== this.robotId || !this.sessionReady || !this.snapshotReady || !this.controlEnabled || !this.validEnvelope(pause)) return;
      const requestId = String(pause.request_id ?? "");
      if (!requestId) return;
      const paused = Boolean(pause.paused);
      const operationId = msg.operation_id ? String(msg.operation_id) : undefined;
      this.traceCommand(EVENT_KINDS.code["motion_pause.received"], undefined, requestId, { paused }, operationId ?? null);
      const key = `${this.sessionId}:${this.controlEpoch}:${requestId}`;
      let result = this.motionPauseResults.get(key);
      if (!result) {
        let applied = false;
        let reasonCode: string = REASON_CODES.code.operator_pause_rejected;
        try {
          const response = this.onMotionPause?.({ requestId, paused });
          applied = response?.applied === true;
          reasonCode = response?.reasonCode || (applied ? (paused ? REASON_CODES.code.paused : REASON_CODES.code.resumed) : reasonCode);
        } catch (error) {
          reasonCode = REASON_CODES.code.operator_pause_error;
          this.traceRuntime(EVENT_KINDS.code["error.motion_pause"], { requestId, message: error instanceof Error ? error.message : String(error) });
        }
        result = { paused, applied, reason_code: reasonCode };
        this.motionPauseResults.set(key, result);
        if (this.motionPauseResults.size > 128) this.motionPauseResults.delete(this.motionPauseResults.keys().next().value!);
      }
      this.writePayload({ ...(operationId ? { operation_id: operationId } : {}), motion_pause_ack: { robot_id: this.robotId, request_id: requestId, paused: result.paused, applied: result.applied, reason_code: result.reason_code, ...this.envelope() } });
      this.traceCommand(result.applied ? EVENT_KINDS.code["motion_pause.applied"] : EVENT_KINDS.code["motion_pause.rejected"], undefined, requestId, { paused: result.paused, reasonCode: result.reason_code }, operationId ?? null);
      if (result.applied) this.sendInitialTelemetry();
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.pose_override) {
      const override = msg.pose_override ?? {};
      // The server first advances to a disabled epoch. An override must still
      // be accepted in that epoch, but only after the usual session/snapshot
      // fence has made its map state authoritative.
      if (!this.sessionReady || !this.snapshotReady || !this.validEnvelope(override)) return;
      const operationId = msg.operation_id ? String(msg.operation_id) : undefined;
      const command = {
        requestId: String(override.request_id ?? ""),
        x: Number(override.x),
        y: Number(override.y),
        theta: Number(override.theta),
      };
      if (!command.requestId || ![command.x, command.y, command.theta].every(Number.isFinite)) return;
      const key = `${this.sessionId}:${this.controlEpoch}:${command.requestId}`;
      let result = this.poseOverrideResults.get(key);
      if (!result) {
        let applied = false;
        try { applied = this.onPoseOverride?.(command) === true; } catch { /* report explicit rejection */ }
        result = { applied, reason_code: applied ? REASON_CODES.code.applied : REASON_CODES.code.local_pose_infeasible };
        this.poseOverrideResults.set(key, result);
        if (this.poseOverrideResults.size > 128) this.poseOverrideResults.delete(this.poseOverrideResults.keys().next().value!);
      }
      this.writePayload({ ...(operationId ? { operation_id: operationId } : {}), pose_override_ack: { robot_id: this.robotId, request_id: command.requestId, ...result, ...this.envelope() } });
      if (result.applied) {
        // Explicit request ACK first, then a fresh pose on the same stream.
        // A pre-existing matching pose can never acknowledge the request.
        this.sendInitialTelemetry();
      }
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.drive) {
      if (!this.sessionReady || !this.snapshotReady || !this.controlEnabled || !this.validEnvelope(msg.drive)) return;
      const d = msg.drive ?? {};
      const commandId = String(d.command_id ?? "");
      const operationId = String(msg.operation_id || commandId.split(":")[0] || "");
      const parsedContext = this.parseEventContext(d.event_context_json);
      const eventContext = { ...(parsedContext ?? {}), commandKind: String(d.kind ?? parsedContext?.commandKind ?? "move"),
        x: d.x !== undefined && d.x !== null ? Number.isFinite(Number(d.x)) ? Number(d.x) : undefined : parsedContext?.x,
        y: d.y !== undefined && d.y !== null ? Number.isFinite(Number(d.y)) ? Number(d.y) : undefined : parsedContext?.y,
        theta: d.theta !== undefined && d.theta !== null ? Number.isFinite(Number(d.theta)) ? Number(d.theta) : undefined : parsedContext?.theta };
      if (commandId && operationId) {
        this.commandOperations.set(commandId, operationId);
        this.commandContexts.set(commandId, eventContext);
        while (this.commandOperations.size > 128) {
          const oldest = this.commandOperations.keys().next().value!;
          this.commandOperations.delete(oldest);
          this.commandContexts.delete(oldest);
        }
        this.activeCommandId = commandId;
        this.activeCommandOperationId = operationId;
      }
      const num = (value: unknown): number | undefined => value === "" || value == null || !Number.isFinite(Number(value)) ? undefined : Number(value);
      this.traceCommand(EVENT_KINDS.code["command.receive"], commandId, undefined, { commandKind: String(d.kind ?? "move"), x: num(d.x), y: num(d.y), theta: num(d.theta), ...this.contextPayload(commandId) }, operationId || undefined);
      this.onDrive({
        command_id: d.command_id ?? "",
        kind: d.kind ?? "move",
        x: Number(d.x),
        y: Number(d.y),
        theta: Number(d.theta),
      });
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.cancel) {
      if (!this.validEnvelope(msg.cancel)) return;
      const commandId = String(msg.cancel?.command_id ?? "");
      this.traceCommand(EVENT_KINDS.code["command.receive"], commandId, undefined, { commandKind: PROTOCOL_MESSAGES.code.cancel }, this.commandOperations.get(commandId));
      this.onCancel(String(msg.cancel?.command_id ?? ""));
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.semantic_snapshot) {
      const raw = msg.semantic_snapshot?.json;
      if (typeof raw !== "string" || !raw) return;
      try {
        const snapshot = JSON.parse(raw) as Partial<SemanticSnapshot>;
        if (Array.isArray(snapshot.zones) && Array.isArray(snapshot.obstacles)) {
          this.snapshotReady = true;
          this.onSemanticSnapshot?.({ zones: snapshot.zones, obstacles: snapshot.obstacles });
          if (this.sessionReady) this.onConnectionState?.(true);
          if (this.pendingControlAck) this.sendControlAck();
        }
      } catch (err) {
        console.warn(`[${this.robotId}] invalid semantic snapshot:`, err);
      }
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.place_query) {
      const q = msg.place_query ?? {};
      const o = q.obstacle ?? {};
      const result = this.onPlaceQuery({
        id: String(o.id ?? ""),
        kind: parseObstacleKind(String(o.kind ?? "")) ?? "triangle",
        x: Number(o.x) || 0,
        y: Number(o.y) || 0,
        size: Number(o.size) || 10,
        theta: Number(o.theta) || 0,
      });
      if (this.liveStream && this.liveStream.writable) {
        this.liveStream.write({
          place_reply: {
            query_id: q.query_id ?? "",
            robot_id: this.robotId,
            ok: result.ok,
            reason: result.reason,
          },
        });
      }
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.obstacles) {
      const items = Array.isArray(msg.obstacles?.items) ? msg.obstacles.items : [];
      this.onObstacles(
        items.map((o: any) => ({
          id: String(o.id ?? ""),
          kind: parseObstacleKind(String(o.kind ?? "")) ?? "triangle",
          x: Number(o.x) || 0,
          y: Number(o.y) || 0,
          size: Number(o.size) || 10,
          theta: Number(o.theta) || 0,
        })),
      );
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.sensed_peers) {
      if (!this.validEnvelope(msg.sensed_peers)) return;
      // SIM_PEER_SENSING proxy — see shared/constants.ts
      const peers = Array.isArray(msg.sensed_peers?.peers) ? msg.sensed_peers.peers : [];
      this.onSensedPeers?.(
        peers.map((p: any) => ({
          robotId: String(p.robot_id ?? ""),
          x: Number(p.x) || 0,
          y: Number(p.y) || 0,
          theta: Number(p.theta) || 0,
        })),
      );
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.lease_grant) {
      if (!this.validEnvelope(msg.lease_grant)) return;
      this.onLeaseGrant?.(msg.lease_grant ?? {});
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.bid_request) {
      const b = msg.bid_request ?? {};
      if (!this.validEnvelope(b)) return;
      this.onBidRequest?.(String(b.zone_id ?? ""), Number(b.window_ms) || 0);
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.evasion_request) {
      if (!this.validEnvelope(msg.evasion_request)) return;
      this.onEvasionRequest?.(msg.evasion_request ?? {});
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.traffic_stop_status) {
      if (!this.validEnvelope(msg.traffic_stop_status)) return;
      this.onTrafficStopStatus?.(msg.traffic_stop_status ?? {});
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.zone_update) {
      const z = msg.zone_update ?? {};
      if (!this.validEnvelope(z)) return;
      this.onZoneUpdate?.(String(z.zone_id ?? ""), String(z.state ?? ""));
      return;
    }
    if (which === PROTOCOL_MESSAGES.code.fleet_local_plans) {
      if (!this.validEnvelope(msg.fleet_local_plans)) return;
      const peers = Array.isArray(msg.fleet_local_plans?.peers) ? msg.fleet_local_plans.peers : [];
      this.onFleetLocalPlans?.(
        peers.map((p: any) => ({
          robotId: String(p.robot_id ?? ""),
          x: Number(p.x) || 0,
          y: Number(p.y) || 0,
          theta: Number(p.theta) || 0,
          operatorPaused: Boolean(p.operator_paused),
          points: Array.isArray(p.points) && !Boolean(p.operator_paused)
            ? p.points
                .map((pt: any) => ({ x: Number(pt.x), y: Number(pt.y) }))
                .filter((pt: { x: number; y: number }) => Number.isFinite(pt.x) && Number.isFinite(pt.y))
            : [],
        })),
      );
    }
  }

  private validEnvelope(body: any): boolean {
    return String(body?.session_id ?? "") === this.sessionId && Number(body?.control_epoch) === this.controlEpoch;
  }

  private sendInitialTelemetry(): void {
    const stream = this.liveStream;
    if (!stream?.writable || !this.sessionId) return;
    const pose = this.getPose();
    stream.write({ pose: { robot_id: this.robotId, x: pose.x, y: pose.y, theta: pose.theta, status: pose.status, motion: pose.motion, avoidance_mode: pose.avoidanceMode, head_room_px: pose.headRoomPx, traffic_status: pose.trafficStatus, command_id: pose.commandId, command_state: pose.commandState, command_reason: pose.commandReason, work_state: pose.workState, drive_state: pose.driveState, drive_context_json: pose.driveContextJson, reported_at: pose.reportedAt, navigation_mode: pose.navigationMode, path_planning_authority: pose.pathPlanningAuthority, operator_paused: pose.operatorPaused, ...this.envelope() } });
    stream.write({ path: { robot_id: this.robotId, points: this.getPath(), ...this.envelope() } });
    if (this.policyId === "local_plan_v1" && this.getLocalPlan) stream.write({ local_plan: { robot_id: this.robotId, points: this.getLocalPlan(), horizon_s: LOOKAHEAD_S, ...this.envelope() } });
  }

  private sendControlAck(): void {
    if (!this.pendingControlAck || !this.liveStream?.writable || !this.sessionId) return;
    this.pendingControlAck = false;
    // Acknowledgement is ordered after a new pose in this control generation,
    // so FMS can verify that the previous mission was cleared before enabling.
    this.sendInitialTelemetry();
    this.liveStream.write({ control_ack: { robot_id: this.robotId, control_epoch: this.controlEpoch, enabled: this.controlEnabled, ready: true, session_id: this.sessionId } });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
