import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import * as protoLoader from "../server/node_modules/@grpc/proto-loader/build/src/index.js";
import { Encoder, Decoder } from "../server/node_modules/@colyseus/schema/build/esm/index.mjs";
import { FloorRoom } from "../server/src/rooms/FloorRoom.ts";
import { FloorState, Waypoint } from "../server/src/schema.ts";
import { attachRobotSession, tickRobotSessions } from "../server/src/grpc/robotBridge.ts";
import { snapshotFromState } from "../web-client/src/snapshot.ts";
import { PROTOCOL_VERSION, SESSION_TIMEOUT_MS } from "../shared/robotProtocol.ts";
import { RobotController } from "../virtual-robot/src/controller.ts";
import { GrpcClient } from "../virtual-robot/src/grpcClient.ts";
import { LocalPlanExecutor } from "../virtual-robot/src/traffic/LocalPlanExecutor.ts";
import { clearSemanticZones } from "../shared/planner.ts";
import { setExtraBlocked } from "../shared/occupancy.ts";
import { RuntimeStore } from "../server/src/runtimeStore.ts";
import { TeleporterStore } from "../server/src/teleporterStore.ts";
import { defaultTeleporterOccupancyPolygon } from "../shared/teleporterRuntime.ts";

const definition = protoLoader.loadSync(new URL("../proto/robot.proto", import.meta.url).pathname, {
  keepCase: true, oneofs: true, defaults: true, longs: String, enums: String,
});
const wire = (definition["bgfms.RobotBridge"] as any).Session;

test("drive diagnostic context preserves target names and is optional on the wire", () => {
  const drive = { command_id: "display-1", kind: "move", x: 0, y: 2, theta: 0.9,
    event_context_json: JSON.stringify({ target: { id: "wp-1", kind: "waypoint", name: "포장 출구", mapId: "yard" } }) };
  expect(wire.responseDeserialize(wire.responseSerialize({ drive })).drive.event_context_json).toBe(drive.event_context_json);
  const legacy = wire.responseDeserialize(wire.responseSerialize({ drive: { command_id: "legacy", kind: "move", x: 1, y: 2, theta: 0 } }));
  expect(legacy.drive.event_context_json).toBe("");
  expect(legacy.drive.x).toBe(1);
});

class RobotStream extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  messages: any[] = [];
  onWrite?: (message: any) => void;
  write(message: unknown) {
    const decoded = wire.responseDeserialize(wire.responseSerialize(message));
    this.messages.push(decoded);
    this.onWrite?.(decoded);
    return true;
  }
  receive(message: any) {
    const operational = ["path", "command_state", "lease_request", "lease_release", "traffic_bid", "evasion_reply", "local_plan", "pose"];
    const key = operational.find(k => message?.[k]);
    const ready = this.messages.findLast(m => m.payload === "session_ready")?.session_ready;
    if (key && ready && message[key].session_id == null) {
      message = { ...message, [key]: { ...message[key], session_id: ready.session_id, control_epoch: ready.control_epoch, ...(key === "pose" ? { work_state: message[key].work_state ?? "idle", drive_state: message[key].drive_state ?? "stationary", drive_context_json: message[key].drive_context_json ?? "[]", reported_at: message[key].reported_at ?? Date.now() } : {}) } };
    }
    this.emit("data", wire.requestDeserialize(wire.requestSerialize(message)));
  }
  end() { if (this.writableEnded) return; this.writableEnded = true; this.emit("close"); }
  destroy() { this.destroyed = true; this.end(); }
}

function fixture() {
  const room = new FloorRoom();
  room.onCreate({ runtimeStore: new RuntimeStore(":memory:") });
  const stream = new RobotStream();
  attachRobotSession(stream as any);
  const encoder = new Encoder(room.state);
  const browserState = new FloorState();
  const decoder = new Decoder(browserState);
  decoder.decode(encoder.encodeAll());
  encoder.discardChanges();
  return {
    room, stream,
    fullSnapshot() { return encoder.encodeAll(); },
    browser() {
      decoder.decode(encoder.encode());
      encoder.discardChanges();
      return snapshotFromState(browserState as any).robots.find(r => r.id === "robot-1")!;
    },
    close() { stream.end(); room.onDispose(); room.clock.stop(); },
  };
}

test("FMS sends the authoritative waypoint name with a drive and preserves its recorded snapshot", () => {
  const f = fixture();
  try {
    const waypoint = Object.assign(new Waypoint(), { id: "event-target", name: "포장 출구", x: 280, y: 520, theta: 0 });
    f.room.state.waypoints.set(waypoint.id, waypoint);
    f.stream.receive({ register: { robot_id: "robot-1", protocol_version: PROTOCOL_VERSION } });
    f.stream.receive({ pose: { robot_id: "robot-1", x: 240, y: 520, theta: 0, status: "idle", motion: "IDLE" } });
    const ready = f.stream.messages.findLast(m => m.payload === "session_ready").session_ready;
    f.stream.receive({ control_ack: { robot_id: "robot-1", session_id: ready.session_id, control_epoch: ready.control_epoch, enabled: true, ready: true } });
    const errors: unknown[] = [];
    (f.room as any).commandRobot({ send: (type: string, payload: unknown) => { if (type === "error") errors.push(payload); } },
      { robotId: "robot-1", kind: "move", targetId: waypoint.id, target: { name: "untrusted client name" } });
    expect(errors).toEqual([]);
    const drive = f.stream.messages.findLast(m => m.payload === "drive").drive;
    waypoint.name = "새 이름";
    expect(JSON.parse(drive.event_context_json)).toMatchObject({ commandKind: "move", x: 280, y: 520, theta: 0,
      target: { id: "event-target", name: "포장 출구", kind: "waypoint", mapId: "yard" } });
  } finally { f.close(); }
});

test("pose override requires request-applied ACK followed by a new pose, never matching old coordinates alone", () => {
  const f = fixture();
  const replies: any[] = [];
  const operator = { sessionId: "pose-ack-test", send: (type: string, value: any) => replies.push({ type, value }) };
  try {
    f.stream.receive({ register: { robot_id: "robot-1", protocol_version: PROTOCOL_VERSION, supports_pose_override: true } });
    const ready = f.stream.messages.findLast(m => m.payload === "session_ready").session_ready;
    f.stream.receive({ pose: { robot_id: "robot-1", x: 240, y: 520, theta: 0, status: "idle", motion: "IDLE" } });
    f.stream.receive({ control_ack: { robot_id: "robot-1", session_id: ready.session_id, control_epoch: ready.control_epoch, enabled: true, ready: true } });
    (f.room as any).overrideRobotPose(operator, { testOnly: true, mapId: "yard", robotId: "robot-1", requestId: "same-position", expectedEpoch: f.room.state.robots.get("robot-1")!.controlEpoch, x: 240, y: 520, theta: 0 });
    const override = f.stream.messages.findLast(m => m.payload === "pose_override").pose_override;
    const pose = { robot_id: "robot-1", session_id: override.session_id, control_epoch: override.control_epoch,
      x: 240, y: 520, theta: 0, work_state: "idle", drive_state: "stationary", status: "idle", reported_at: Date.now() };
    f.stream.receive({ pose });
    expect(replies).toHaveLength(0);
    f.stream.receive({ pose_override_ack: { robot_id: "robot-1", request_id: "other-request", session_id: override.session_id, control_epoch: override.control_epoch, applied: true } });
    f.stream.receive({ pose });
    expect(replies).toHaveLength(0);
    f.stream.receive({ pose_override_ack: { robot_id: "robot-1", request_id: "same-position", session_id: override.session_id, control_epoch: override.control_epoch, applied: true, reason_code: "applied" } });
    expect(replies).toHaveLength(0);
    f.stream.receive({ pose });
    expect(replies.at(-1)?.value.accepted).toBe(true);
    expect(f.room.state.robots.get("robot-1")!.fmsControlState).toBe("disabled");
  } finally { f.close(); }
});

test("pose override local rejection cannot be confirmed by matching coordinates", () => {
  const f = fixture();
  const replies: any[] = [];
  try {
    f.stream.receive({ register: { robot_id: "robot-1", protocol_version: PROTOCOL_VERSION, supports_pose_override: true } });
    const ready = f.stream.messages.findLast(m => m.payload === "session_ready").session_ready;
    f.stream.receive({ pose: { robot_id: "robot-1", x: 240, y: 520, theta: 0, status: "idle" } });
    f.stream.receive({ control_ack: { robot_id: "robot-1", session_id: ready.session_id, control_epoch: ready.control_epoch, enabled: true, ready: true } });
    (f.room as any).overrideRobotPose({ sessionId: "reject-test", send: (_type: string, body: any) => replies.push(body) }, { testOnly: true, mapId: "yard", robotId: "robot-1", requestId: "reject", expectedEpoch: f.room.state.robots.get("robot-1")!.controlEpoch, x: 240, y: 520, theta: 0 });
    const override = f.stream.messages.findLast(m => m.payload === "pose_override").pose_override;
    f.stream.receive({ pose_override_ack: { robot_id: "robot-1", request_id: "reject", session_id: override.session_id, control_epoch: override.control_epoch, applied: false, reason_code: "local_pose_infeasible" } });
    expect(replies.at(-1)?.accepted).toBe(false);
    expect(replies.at(-1)?.reason).toContain("local_pose_infeasible");
    expect(f.room.state.robots.get("robot-1")!.controlEpoch).toBeGreaterThan(Number(override.control_epoch));
  } finally { f.close(); }
});

test("disabled robots still receive current peer observations and offline bodies retain no future path", () => {
  const f = fixture(); const peer = new RobotStream();
  try {
    f.stream.receive({ register: { robot_id: "robot-1", protocol_version: PROTOCOL_VERSION } });
    f.stream.receive({ pose: { robot_id: "robot-1", x: 240, y: 520, theta: 0, status: "idle" } });
    (f.room as any).setRobotControl({ sessionId: "disable-observation", send: () => {} }, { robotId: "robot-1", requestId: "disable", expectedEpoch: f.room.state.robots.get("robot-1")!.controlEpoch, enabled: false });
    attachRobotSession(peer as any);
    peer.receive({ register: { robot_id: "robot-2", protocol_version: PROTOCOL_VERSION } });
    peer.receive({ pose: { robot_id: "robot-2", x: 320, y: 520, theta: 0, status: "idle" } });
    peer.end();
    (f.room as any).lastFleetPlanMs = 0;
    (f.room as any).maybeBroadcastFleetLocalPlans();
    const packet = f.stream.messages.findLast(m => m.payload === "fleet_local_plans").fleet_local_plans;
    const body = packet.peers.find((p: any) => p.robot_id === "robot-2");
    expect(body.x).toBe(320); expect(body.points).toEqual([]);
    expect(Number(packet.control_epoch)).toBe(f.room.state.robots.get("robot-1")!.controlEpoch);
  } finally { peer.end(); f.close(); }
});

test("protobuf telemetry and command lifecycle reach an existing browser through Colyseus patches", () => {
  const f = fixture();
  try {
    expect(f.browser().connected).toBe(false);
    f.stream.receive({ register: { robot_id: "robot-1", protocol_version: PROTOCOL_VERSION } });
    expect(f.stream.messages.map(m => m.payload)).toContain("semantic_snapshot");
    expect(f.stream.messages.some(m => m.payload === "session_ready")).toBe(true);
    f.stream.receive({ pose: { robot_id: "robot-1", x: 240, y: 520, theta: 0, status: "idle", motion: "IDLE", traffic_status: "clear" } });
    const readyAck = f.stream.messages.findLast(m => m.payload === "session_ready").session_ready;
    f.stream.receive({ control_ack: { robot_id: "robot-1", session_id: readyAck.session_id, control_epoch: readyAck.control_epoch, enabled: true, ready: true } });
    expect(f.browser().connected).toBe(true);

    const errors: unknown[] = [];
    (f.room as any).commandRobot({ send: (type: string, value: unknown) => { if (type === "error") errors.push(value); } }, { robotId: "robot-1", kind: "move", x: 280, y: 520, theta: 0 });
    expect(errors).toEqual([]);
    const drive = f.stream.messages.findLast(m => m.payload === "drive").drive;
    expect(f.browser().commandId).toBe(drive.command_id);
    expect(f.browser().commandState).toBe("sent");
    for (const state of ["accepted", "running"]) {
      f.stream.receive({ command_state: { robot_id: "robot-1", command_id: drive.command_id, state, reason: "" } });
      expect(f.browser().commandState).toBe(state);
    }
    f.stream.receive({ command_state: { robot_id: "robot-1", command_id: drive.command_id, state: "accepted" } });
    expect(f.browser().commandState).toBe("running");
    f.stream.receive({ path: { robot_id: "robot-1", points: [{ x: 240, y: 520 }, { x: 280, y: 520 }] } });
    f.stream.receive({ local_plan: { robot_id: "robot-1", points: [{ x: 244, y: 520 }, { x: 260, y: 520 }], horizon_s: 5 } });
    f.stream.receive({ pose: { robot_id: "robot-1", x: 244, y: 520, theta: 0, status: "move", motion: "HOLD", traffic_status: "hold", head_room_px: 12, command_id: drive.command_id, command_state: "running" } });
    const moving = f.browser();
    expect(moving.x).toBe(244);
    expect(moving.path).toHaveLength(2);
    expect(moving.localPath).toHaveLength(2);
    expect(moving.localHorizonS).toBe(5);
    expect(moving.trafficStatus).toBe("hold");
    expect(moving.lastSeenAt).toBeGreaterThan(0);
    f.stream.receive({ pose: { robot_id: "robot-1", x: 280, y: 520, theta: 0, status: "idle", motion: "IDLE", command_id: drive.command_id, command_state: "completed" } });
    expect(f.browser().commandState).toBe("completed");
    // A reordered pose may not regress a completed command.
    f.stream.receive({ command_state: { robot_id: "robot-1", command_id: drive.command_id, state: "running" } });
    expect(f.browser().commandState).toBe("completed");
    // A newly joined browser gets the same terminal command without event history.
    const newBrowser = new FloorState();
    new Decoder(newBrowser).decode(f.fullSnapshot());
    expect(snapshotFromState(newBrowser as any).robots.find(r => r.id === "robot-1")!.commandState).toBe("completed");

    (f.room as any).commandRobot({ send: () => {} }, { robotId: "robot-1", kind: "move", x: 300, y: 520, theta: 0 });
    const second = f.stream.messages.findLast(m => m.payload === "drive").drive;
    expect(second.command_id).not.toBe(drive.command_id);
    f.stream.receive({ command_state: { robot_id: "robot-1", command_id: drive.command_id, state: "cancelled", reason: "late old command" } });
    expect(f.browser().commandId).toBe(second.command_id);
    expect(f.browser().commandState).toBe("sent");
    (f.room as any).cancelRobot({ send: () => {} }, { robotId: "robot-1" });
    expect(f.stream.messages.findLast(m => m.payload === "cancel").cancel.command_id).toBe(second.command_id);
    expect(f.browser().commandState).not.toBe("cancelled");
    f.stream.receive({ command_state: { robot_id: "robot-1", command_id: second.command_id, state: "cancelled", reason: "operator cancelled" } });
    expect(f.browser().commandState).toBe("cancelled");
    expect(f.browser().commandReason).toBe("operator cancelled");
  } finally { f.close(); }
});

test("browser command travels through both gRPC handlers, real robot motion and back to browser completion", () => {
  const f = fixture();
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.setConnectionReady(false);
  c.attachTraffic(new LocalPlanExecutor({ sendLeaseRequest: () => {}, sendLeaseRelease: () => {} }));
  const client = new GrpcClient({
    robotId: "robot-1", getPose: () => c.snapshot(), getPath: () => c.currentPath(), takePathDelta: () => c.takePathDelta(), getLocalPlan: () => c.currentLocalPlan(),
    onDrive: cmd => c.handleDrive(cmd), onCancel: id => c.handleCancel(id), onPlaceQuery: o => c.canPlace(o), onObstacles: o => c.setObstacles(o),
    onSemanticSnapshot: s => c.setSemanticSnapshot(s), onConnectionState: ready => c.setConnectionReady(ready), onControlState: state => c.setControlState(state), onZoneUpdate: (id, state) => c.onTrafficZoneUpdate(id, state),
  });
  (client as any).liveStream = { writable: true, write: (message: unknown) => f.stream.receive(message) };
  f.stream.onWrite = message => (client as any).handleServerMsg(message);
  c.setCommandStateSender(state => client.sendCommandState(state));
  const sendPose = () => {
    const p = c.snapshot();
    f.stream.receive({ pose: { robot_id: "robot-1", x: p.x, y: p.y, theta: p.theta, status: p.status, motion: p.motion, traffic_status: p.trafficStatus, command_id: p.commandId, command_state: p.commandState, command_reason: p.commandReason } });
  };
  try {
    f.stream.receive({ register: { robot_id: "robot-1", protocol_version: PROTOCOL_VERSION } });
    const ready = f.stream.messages.findLast(m => m.payload === "session_ready").session_ready;
    c.setControlState({ enabled: true, controlEpoch: Number(ready.control_epoch), sessionId: String(ready.session_id) });
    (client as any).sessionId = String(ready.session_id);
    (client as any).controlEpoch = Number(ready.control_epoch);
    (client as any).controlEnabled = true;
    (client as any).sessionReady = true;
    (client as any).snapshotReady = true;
    c.setConnectionReady(true);
    sendPose();
    (f.room as any).commandRobot({ send: () => {} }, { robotId: "robot-1", kind: "move", x: 264.49, y: 520.49, theta: Math.PI / 2 });
    expect(f.browser().commandState).toBe("running");
    const commandId = f.browser().commandId;
    for (let i = 0; i < 160 && c.snapshot().status !== "idle"; i++) { (c as any).tick(); sendPose(); }
    const done = f.browser();
    expect(done.commandId).toBe(commandId);
    expect(done.commandState).toBe("completed");
    expect(done.x).toBeCloseTo(264.49, 2);
    expect(done.y).toBeCloseTo(520.49, 2);
    expect(done.theta).toBeCloseTo(Math.PI / 2, 2);
    // Retrying the exact same completed command must replay its result, not move again.
    f.stream.write({ drive: { command_id: commandId, kind: "move", x: 264.49, y: 520.49, theta: Math.PI / 2 } });
    expect(c.snapshot().status).toBe("idle");
    expect(c.snapshot().commandState).toBe("completed");
    (f.room as any).commandRobot({ send: () => {} }, { robotId: "robot-1", kind: "move", x: 300, y: 520, theta: 0 });
    (c as any).tick();
    sendPose();
    (f.room as any).cancelRobot({ send: () => {} }, { robotId: "robot-1" });
    expect(c.snapshot().commandState).toBe("cancelled");
    expect(f.browser().commandState).toBe("cancelled");
    const stoppedX = c.snapshot().x;
    for (let i = 0; i < 10; i++) (c as any).tick();
    expect(c.snapshot().x).toBe(stoppedX);
  } finally { c.stop(); f.close(); clearSemanticZones(); setExtraBlocked(null); }
});

test("cancelling a reserved teleporter stops entry before releasing its ledger use", () => {
  const room = new FloorRoom();
  const ledger = new TeleporterStore(":memory:");
  const endpoint = { id: "source", mapId: "yard", position: { x: 240, y: 520 }, entryTheta: 0, exitTheta: 0, clearingPoint: { x: 280, y: 520 }, occupancyPolygon: defaultTeleporterOccupancyPolygon() };
  ledger.upsert({ id: "cancel-t", name: "cancel", enabled: true, revision: 1, endpoints: [endpoint, { ...endpoint, id: "destination", mapId: "large_lab", position: { x: 1300, y: 1300 }, clearingPoint: { x: 1340, y: 1300 } }] });
  room.onCreate({ runtimeStore: new RuntimeStore(":memory:"), teleporterStore: ledger });
  const stream = new RobotStream(); attachRobotSession(stream as any);
  try {
    stream.receive({ register: { robot_id: "robot-1", protocol_version: PROTOCOL_VERSION } });
    const ready = stream.messages.findLast(m => m.payload === "session_ready").session_ready;
    stream.receive({ pose: { robot_id: "robot-1", x: 300, y: 520, theta: 0, status: "move", motion: "MOVING", traffic_status: "clear", session_id: ready.session_id, control_epoch: ready.control_epoch } });
    stream.receive({ control_ack: { robot_id: "robot-1", session_id: ready.session_id, control_epoch: ready.control_epoch, enabled: true, ready: true } });
    const connectedRobot = room.state.robots.get("robot-1")!;
    connectedRobot.connected = true; connectedRobot.controlReady = true; connectedRobot.fmsControlState = "enabled"; connectedRobot.sessionId = ready.session_id;
    ledger.claimRobotOwner({ robotId: "robot-1", mapId: "yard", controlEpoch: ready.control_epoch, transferId: "cancel-transfer" });
    ledger.requestUse({ teleporterId: "cancel-t", robotId: "robot-1", fromEndpointId: "source", toEndpointId: "destination", requestId: "cancel-transfer", controlEpoch: ready.control_epoch });
    ledger.promoteNext("cancel-t", () => true);
    (room as any).teleporterTransfers.set("robot-1", { transferId: "cancel-transfer", teleporterId: "cancel-t", robotId: "robot-1", fromEndpointId: "source", toEndpointId: "destination", phase: "reserved", controlEpoch: ready.control_epoch, sourceMapId: "yard", destinationMapId: "large_lab", commandId: "cancel-transfer", reason: "" });
    const robot = room.state.robots.get("robot-1")!; robot.commandId = "cancel-transfer:entry"; robot.commandState = "running";
    (room as any).cancelRobot({ send: () => {} }, { robotId: "robot-1" });
    expect(stream.messages.findLast(m => m.payload === "cancel")?.cancel?.command_id).toBe("cancel-transfer:entry");
    expect(ledger.activeUse("cancel-t")).toBeNull();
    expect((room as any).teleporterTransfers.has("robot-1")).toBe(false);
  } finally { stream.end(); room.onDispose(); room.clock.stop(); ledger.close(); }
});

test("session identity isolation and timeout are reflected in browser state", () => {
  const f = fixture();
  try {
    f.stream.receive({ register: { robot_id: "robot-1", protocol_version: PROTOCOL_VERSION } });
    f.stream.receive({ pose: { robot_id: "robot-1", x: 260, y: 520, theta: 0, status: "move", command_id: "restored", command_state: "running" } });
    const readyAck = f.stream.messages.findLast(m => m.payload === "session_ready").session_ready;
    f.stream.receive({ control_ack: { robot_id: "robot-1", session_id: readyAck.session_id, control_epoch: readyAck.control_epoch, enabled: true, ready: true } });
    f.stream.receive({ pose: { robot_id: "robot-2", x: 1, y: 1, theta: 0, status: "idle" } });
    expect(f.room.state.robots.get("robot-2")!.x).not.toBe(1);
    tickRobotSessions(Date.now() + SESSION_TIMEOUT_MS + 1);
    const disconnected = f.browser();
    expect(disconnected.connected).toBe(false);
    expect(disconnected.x).toBe(260);
    expect(disconnected.commandState).toBe("interrupted");
    expect(disconnected.trafficStatus).toBe("lease_lost");
    const reconnect = new RobotStream();
    try {
      attachRobotSession(reconnect as any);
      reconnect.receive({ register: { robot_id: "robot-1", protocol_version: PROTOCOL_VERSION } });
      reconnect.receive({ pose: { robot_id: "robot-1", x: 260, y: 520, theta: 0, status: "move", command_id: "restored", command_state: "running" } });
      const reconnectReady = reconnect.messages.findLast(m => m.payload === "session_ready").session_ready;
      reconnect.receive({ control_ack: { robot_id: "robot-1", session_id: reconnectReady.session_id, control_epoch: reconnectReady.control_epoch, enabled: true, ready: true } });
      expect(f.browser().commandState).toBe("running");
      expect(f.browser().connected).toBe(true);
      reconnect.receive({ command_state: { robot_id: "robot-1", command_id: "restored", state: "completed" } });
      expect(f.browser().commandState).toBe("completed");
    } finally { reconnect.end(); }
  } finally { f.close(); }
});
