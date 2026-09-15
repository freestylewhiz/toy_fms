import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GRPC_PORT, LOOKAHEAD_S, TICK_MS, TRAFFIC_POLICY_ID } from "../../shared/constants.ts";
import { parseTrafficPolicyId } from "../../shared/traffic/types.ts";
import type { DriveCmd, PoseSnapshot } from "./controller.ts";
import { parseObstacleKind, type DynObstacle } from "../../shared/obstacles.ts";
import type { SemanticSnapshot } from "../../shared/semantic.ts";
import { PROTOCOL_VERSION, SESSION_TIMEOUT_MS } from "../../shared/robotProtocol.ts";


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
const TARGET = `localhost:${GRPC_PORT}`;

export type GrpcClientOptions = {
  robotId: string;
  getPose: () => PoseSnapshot;
  getPath: () => { x: number; y: number }[];
  takePathDelta: () => { x: number; y: number }[] | null;
  onDrive: (cmd: DriveCmd) => void;
  onCancel: (commandId?: string) => void;
  onPlaceQuery: (obs: DynObstacle) => { ok: boolean; reason: string };
  onObstacles: (items: DynObstacle[]) => void;
  onSemanticSnapshot?: (snapshot: Pick<SemanticSnapshot, "zones" | "obstacles">) => void;
  onConnectionState?: (ready: boolean) => void;
  onControlState?: (state: { enabled: boolean; controlEpoch: number; sessionId: string }) => void;
  onSensedPeers?: (peers: { robotId: string; x: number; y: number; theta: number }[]) => void;
  onLeaseGrant?: (msg: any) => void;
  onBidRequest?: (zoneId: string, windowMs: number) => void;
  onEvasionRequest?: (msg: any) => void;
  onZoneUpdate?: (zoneId: string, state: string) => void;
  getLocalPlan?: () => { x: number; y: number }[];
  onFleetLocalPlans?: (
    peers: { robotId: string; x: number; y: number; theta: number; points: { x: number; y: number }[] }[],
  ) => void;
};

export class GrpcClient {
  private readonly robotId: string;
  private readonly getPose: () => PoseSnapshot;
  private readonly getPath: () => { x: number; y: number }[];
  private readonly takePathDelta: () => { x: number; y: number }[] | null;
  private readonly onDrive: (cmd: DriveCmd) => void;
  private readonly onCancel: (commandId?: string) => void;
  private readonly onPlaceQuery: (obs: DynObstacle) => { ok: boolean; reason: string };
  private readonly onObstacles: (items: DynObstacle[]) => void;
  private readonly onSemanticSnapshot?: (snapshot: Pick<SemanticSnapshot, "zones" | "obstacles">) => void;
  private readonly onConnectionState?: (ready: boolean) => void;
  private readonly onControlState?: (state: { enabled: boolean; controlEpoch: number; sessionId: string }) => void;
  private readonly onSensedPeers?: (peers: { robotId: string; x: number; y: number; theta: number }[]) => void;
  private readonly onLeaseGrant?: (msg: any) => void;
  private readonly onBidRequest?: (zoneId: string, windowMs: number) => void;
  private readonly onEvasionRequest?: (msg: any) => void;
  private readonly onZoneUpdate?: (zoneId: string, state: string) => void;
  private readonly getLocalPlan?: () => { x: number; y: number }[];
  private readonly onFleetLocalPlans?: (
    peers: { robotId: string; x: number; y: number; theta: number; points: { x: number; y: number }[] }[],
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
  private pendingControlAck = false;

  constructor(opts: GrpcClientOptions) {
    this.robotId = opts.robotId;
    this.getPose = opts.getPose;
    this.getPath = opts.getPath;
    this.takePathDelta = opts.takePathDelta;
    this.onDrive = opts.onDrive;
    this.onCancel = opts.onCancel;
    this.onPlaceQuery = opts.onPlaceQuery;
    this.onObstacles = opts.onObstacles;
    this.onSemanticSnapshot = opts.onSemanticSnapshot;
    this.onConnectionState = opts.onConnectionState;
    this.onControlState = opts.onControlState;
    this.onSensedPeers = opts.onSensedPeers;
    this.onLeaseGrant = opts.onLeaseGrant;
    this.onBidRequest = opts.onBidRequest;
    this.onEvasionRequest = opts.onEvasionRequest;
    this.onZoneUpdate = opts.onZoneUpdate;
    this.getLocalPlan = opts.getLocalPlan;
    this.onFleetLocalPlans = opts.onFleetLocalPlans;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stub = new RobotBridge(TARGET, grpc.credentials.createInsecure());
    void this.connectLoop();
  }

  stop(): void {
    this.running = false;
    try { this.liveStream?.cancel(); } catch { /* already closed */ }
    this.liveStream = null;
    this.stub?.close();
    this.stub = null;
    this.sessionReady = false;
    this.snapshotReady = false;
    this.sessionId = "";
    this.controlEnabled = false;
    this.onConnectionState?.(false);
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
    this.writePayload({ command_state: { robot_id: this.robotId, command_id: body.command_id, state: body.state, reason: body.reason, ...this.envelope() } });
  }

  private envelope(): { control_epoch: number; session_id: string } {
    return { control_epoch: this.controlEpoch, session_id: this.sessionId };
  }

  private writePayload(msg: Record<string, unknown>): void {
    if (!this.controlEnabled && ["lease_request", "lease_release", "traffic_bid", "evasion_reply", "command_state", "local_plan"].some(k => msg[k])) return;
    const stream = this.liveStream;
    if (!stream || !stream.writable) return;
    try {
      stream.write(msg);
    } catch (err) {
      console.warn(`[${this.robotId}] stream write failed:`, err);
    }
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
        console.log(`[${this.robotId}] connecting ${TARGET}`);
        await this.waitReady(2000);
        opened = true;
        await this.runSession();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${this.robotId}] session: ${msg}`);
      }
      if (!this.running) return;
      this.onConnectionState?.(false);
      if (opened && Date.now() - started > 2000) delayMs = 500;
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
      let poseTimer: ReturnType<typeof setInterval> | null = null;
      const stream: grpc.ClientDuplexStream<any, any> = this.stub.Session();
      this.liveStream = stream;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (poseTimer) clearInterval(poseTimer);
        if (this.liveStream === stream) this.liveStream = null;
        this.sessionReady = false;
        this.snapshotReady = false;
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
        try {
          this.handleServerMsg(msg);
        } catch (err) {
          console.error(`[${this.robotId}] handleServerMsg:`, err);
        }
      });
      stream.on("error", (err: Error) => {
        const code = (err as any).code as number | undefined;
        if (code === grpc.status.CANCELLED) {
          finish();
          return;
        }
        finish(err);
      });
      stream.on("end", () => finish());
      stream.on("close", () => finish());

      try {
        this.lastHeartbeatMs = Date.now();
        stream.write({ register: { robot_id: this.robotId, protocol_version: PROTOCOL_VERSION } });
        console.log(`[${this.robotId}] registered`);
        // Telemetry is allowed before the authoritative control handshake; it is
        // also useful to make the physical starting pose immediately observable.
        const initial = this.getPose();
        stream.write({ pose: { robot_id: this.robotId, x: initial.x, y: initial.y, theta: initial.theta, status: initial.status, motion: initial.motion, command_id: initial.commandId, command_state: initial.commandState, command_reason: initial.commandReason } });
        stream.write({ path: { robot_id: this.robotId, points: this.getPath() } });
        if (this.policyId === "local_plan_v1" && this.getLocalPlan) stream.write({ local_plan: { robot_id: this.robotId, points: this.getLocalPlan(), horizon_s: LOOKAHEAD_S } });
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
    if (which === "session_ready") {
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
    if (which === "heartbeat") {
      this.lastHeartbeatMs = Date.now();
      return;
    }
    if (which === "control_state") {
      const c = msg.control_state ?? {};
      const sid = String(c.session_id ?? "");
      const epoch = Number(c.control_epoch);
      if (sid !== this.sessionId || !Number.isFinite(epoch) || epoch < this.controlEpoch) return;
      this.controlEpoch = epoch;
      this.controlEnabled = Boolean(c.enabled);
      this.pendingControlAck = true;
      this.onControlState?.({ enabled: this.controlEnabled, controlEpoch: epoch, sessionId: sid });
      if (this.snapshotReady) this.sendControlAck();
      return;
    }
    if (which === "drive") {
      if (!this.sessionReady || !this.snapshotReady || !this.controlEnabled || !this.validEnvelope(msg.drive)) return;
      const d = msg.drive ?? {};
      this.onDrive({
        command_id: d.command_id ?? "",
        kind: d.kind ?? "move",
        x: Number(d.x),
        y: Number(d.y),
        theta: Number(d.theta),
      });
      return;
    }
    if (which === "cancel") {
      if (!this.validEnvelope(msg.cancel)) return;
      this.onCancel(String(msg.cancel?.command_id ?? ""));
      return;
    }
    if (which === "semantic_snapshot") {
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
    if (which === "place_query") {
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
    if (which === "obstacles") {
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
    if (which === "sensed_peers") {
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
    if (which === "lease_grant") {
      if (!this.validEnvelope(msg.lease_grant)) return;
      this.onLeaseGrant?.(msg.lease_grant ?? {});
      return;
    }
    if (which === "bid_request") {
      const b = msg.bid_request ?? {};
      if (!this.validEnvelope(b)) return;
      this.onBidRequest?.(String(b.zone_id ?? ""), Number(b.window_ms) || 0);
      return;
    }
    if (which === "evasion_request") {
      if (!this.validEnvelope(msg.evasion_request)) return;
      this.onEvasionRequest?.(msg.evasion_request ?? {});
      return;
    }
    if (which === "zone_update") {
      const z = msg.zone_update ?? {};
      if (!this.validEnvelope(z)) return;
      this.onZoneUpdate?.(String(z.zone_id ?? ""), String(z.state ?? ""));
      return;
    }
    if (which === "fleet_local_plans") {
      if (!this.validEnvelope(msg.fleet_local_plans)) return;
      const peers = Array.isArray(msg.fleet_local_plans?.peers) ? msg.fleet_local_plans.peers : [];
      this.onFleetLocalPlans?.(
        peers.map((p: any) => ({
          robotId: String(p.robot_id ?? ""),
          x: Number(p.x) || 0,
          y: Number(p.y) || 0,
          theta: Number(p.theta) || 0,
          points: Array.isArray(p.points)
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
    stream.write({ pose: { robot_id: this.robotId, x: pose.x, y: pose.y, theta: pose.theta, status: pose.status, motion: pose.motion, avoidance_mode: pose.avoidanceMode, head_room_px: pose.headRoomPx, traffic_status: pose.trafficStatus, command_id: pose.commandId, command_state: pose.commandState, command_reason: pose.commandReason, work_state: pose.workState, drive_state: pose.driveState, drive_context_json: pose.driveContextJson, reported_at: pose.reportedAt, navigation_mode: pose.navigationMode, path_planning_authority: pose.pathPlanningAuthority, ...this.envelope() } });
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
