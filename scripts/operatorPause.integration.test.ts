import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import * as protoLoader from "../server/node_modules/@grpc/proto-loader/build/src/index.js";
import { FloorRoom } from "../server/src/rooms/FloorRoom.ts";
import { RuntimeStore } from "../server/src/runtimeStore.ts";
import { TeleporterStore } from "../server/src/teleporterStore.ts";
import { attachRobotSession } from "../server/src/grpc/robotBridge.ts";
import { RobotController } from "../virtual-robot/src/controller.ts";
import { GrpcClient } from "../virtual-robot/src/grpcClient.ts";
import { PROTOCOL_VERSION } from "../shared/robotProtocol.ts";
import { clearPlanningObstacles, clearSemanticZones } from "../shared/planner.ts";
import { setExtraBlocked } from "../shared/occupancy.ts";

const definition = protoLoader.loadSync(new URL("../proto/robot.proto", import.meta.url).pathname, { keepCase: true, oneofs: true, defaults: true, longs: String, enums: String });
const wire = (definition["bgfms.RobotBridge"] as any).Session;
class Stream extends EventEmitter {
  messages: any[] = []; incoming: any[] = []; writableEnded = false; destroyed = false; dropPauseAck = false;
  onWrite?: (message: any) => void;
  write(message: any) { const decoded = wire.responseDeserialize(wire.responseSerialize(message)); this.messages.push(decoded); this.onWrite?.(decoded); return true; }
  receive(message: any) { const decoded = wire.requestDeserialize(wire.requestSerialize(message)); this.incoming.push(decoded); if (!(this.dropPauseAck && decoded.motion_pause_ack)) this.emit("data", decoded); }
  end() { if (!this.writableEnded) { this.writableEnded = true; this.emit("close"); } }
  destroy() { this.destroyed = true; this.end(); }
}
function fixture(paused = false) {
  const store = new RuntimeStore(":memory:"), ledger = new TeleporterStore(":memory:");
  store.ensureRobot("robot-1");
  store.setOperatorPaused("robot-1", paused);
  const room = new FloorRoom(); room.onCreate({ runtimeStore: store, teleporterStore: ledger });
  (room as any).traffic.stop();
  const c = new RobotController({ x: 240, y: 520, theta: 0 }), stream = new Stream();
  const client = new GrpcClient({ robotId: "robot-1", getPose: () => c.snapshot(), getPath: () => c.currentPath(), getLocalPlan: () => c.currentLocalPlan(), takePathDelta: () => c.takePathDelta(),
    onDrive: command => c.handleDrive(command), onCancel: id => c.handleCancel(id), onPlaceQuery: o => c.canPlace(o), onObstacles: o => c.setObstacles(o),
    onSemanticSnapshot: s => c.setSemanticSnapshot(s), onConnectionState: ready => c.setConnectionReady(ready), onControlState: state => c.setControlState(state),
    onMotionPause: state => c.setOperatorPaused(state.paused), onPoseOverride: pose => c.applyOperatorPoseOverride(pose),
  });
  (client as any).liveStream = { writable: true, write: (message: any) => stream.receive(message) };
  stream.onWrite = message => (client as any).handleServerMsg(message);
  c.setCommandStateSender(state => client.sendCommandState(state));
  attachRobotSession(stream as any);
  stream.receive({ register: { robot_id: "robot-1", protocol_version: PROTOCOL_VERSION, supports_pose_override: true } });
  const replies: any[] = [], browser = { sessionId: "operator", send(type: string, data: any) { replies.push({ type, ...data }); } };
  const robot = () => room.state.robots.get("robot-1")!;
  const request = (id: string, value: boolean, extra = {}) => (room as any).requestMotionPause(browser, { robotId: "robot-1", requestId: id, paused: value, expectedEpoch: robot().controlEpoch, ...extra });
  return { room, c, client, stream, store, replies, browser, robot, request,
    report() { (client as any).sendInitialTelemetry(); },
    close() { stream.end(); room.onDispose(); room.clock.stop(); ledger.close(); clearSemanticZones(); clearPlanningObstacles(); setExtraBlocked(null); },
  };
}

test("protobuf pause ACK preserves command, epoch and intended local plan while dispatching no new motion", () => {
  const f = fixture();
  try {
    expect(f.robot().controlReady).toBe(true);
    (f.room as any).commandRobot(f.browser, { robotId: "robot-1", kind: "move", x: 420, y: 520, theta: 0 });
    (f.c as any).tick(); f.report();
    const commandId = f.robot().commandId, epoch = f.robot().controlEpoch, path = [...f.robot().localPath].map(p => ({ x: p.x, y: p.y }));
    expect(path.length).toBeGreaterThan(0);
    f.request("pause", true);
    expect(f.replies.find(r => r.requestId === "pause")).toMatchObject({ ok: true, applied: true });
    expect(f.robot().operatorPaused).toBe(true);
    expect(f.robot().operatorPausePending).toBe(false);
    expect(f.store.getRobot("robot-1")!.operatorPaused).toBe(true);
    const x = f.c.snapshot().x;
    for (let i = 0; i < 10; i++) (f.c as any).tick();
    f.report();
    expect(f.c.snapshot().x).toBe(x);
    expect(f.robot().controlEpoch).toBe(epoch);
    expect(f.robot().commandId).toBe(commandId);
    expect([...f.robot().localPath].map(p => ({ x: p.x, y: p.y }))).toEqual(path);
    (f.room as any).commandRobot(f.browser, { robotId: "robot-1", kind: "move", x: 300, y: 540, theta: 0 });
    expect(f.robot().commandId).toBe(commandId);
    f.request("resume", false);
    expect(f.robot().operatorPaused).toBe(false);
    (f.c as any).tick(); expect(f.c.snapshot().x).toBeGreaterThan(x);
  } finally { f.close(); }
});

test("matching pose alone cannot acknowledge pause, and stale ACK/session cannot complete pending request", () => {
  const f = fixture();
  try {
    f.stream.dropPauseAck = true;
    f.request("await", true);
    expect(f.robot().operatorPausePending).toBe(true);
    expect(f.replies.some(r => r.requestId === "await" && r.ok)).toBe(false);
    const ack = f.stream.incoming.findLast(m => m.motion_pause_ack?.request_id === "await").motion_pause_ack;
    f.stream.dropPauseAck = false;
    f.stream.receive({ motion_pause_ack: { ...ack, session_id: "old" } });
    expect(f.robot().operatorPausePending).toBe(true);
    f.stream.receive({ motion_pause_ack: ack });
    expect(f.robot().operatorPausePending).toBe(false);
    expect(f.replies.find(r => r.requestId === "await")).toMatchObject({ ok: true });
  } finally { f.close(); }
});

test("a persisted pause is restored and explicitly acknowledged during a fresh control handshake", async () => {
  const f = fixture(true);
  try {
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(f.c.snapshot().operatorPaused).toBe(true);
    expect(f.robot().controlReady).toBe(true);
    expect(f.robot().operatorPausePending).toBe(false);
    expect(f.robot().operatorPaused).toBe(true);
    expect(f.stream.incoming.some(m => m.motion_pause_ack?.applied && m.motion_pause_ack?.paused)).toBe(true);
  } finally { f.close(); }
});

test("paused robot retains semantic reservations but broadcasts only stationary occupancy to peers", () => {
  const f = fixture(), peer = new Stream();
  try {
    const traffic = (f.room as any).traffic, original = traffic.hooks.getWorld;
    traffic.hooks.getWorld = () => ({ ...original(), zones: [{ id: "pause-reservation", family: "scene", name: "reserve", kind: "corridor", theta: 0, capacity: 1,
      polygon: [{ x: 270, y: 490 }, { x: 320, y: 490 }, { x: 320, y: 550 }, { x: 270, y: 550 }] }] });
    (f.room as any).commandRobot(f.browser, { robotId: "robot-1", kind: "move", x: 420, y: 520, theta: 0 });
    f.report(); traffic.tick();
    const claims = f.store.listOccupancies().filter(o => o.robotId === "robot-1");
    expect(claims.length).toBeGreaterThan(0);
    f.request("reserve-pause", true); f.report(); traffic.tick();
    expect(f.store.listOccupancies().filter(o => o.robotId === "robot-1").map(o => ({ resource: o.resourceRef, status: o.status })))
      .toEqual(claims.map(o => ({ resource: o.resourceRef, status: o.status })));
    const view = traffic.hooks.getWorld().robots.find((r: any) => r.id === "robot-1" || r.robotId === "robot-1");
    expect(view.operatorPaused).toBe(true);
    expect(view.localPath.length).toBeGreaterThan(1);
    attachRobotSession(peer as any); peer.receive({ register: { robot_id: "robot-2", protocol_version: PROTOCOL_VERSION } });
    (f.room as any).lastFleetPlanMs = 0;
    (f.room as any).maybeBroadcastFleetLocalPlans();
    const observed = peer.messages.findLast(m => m.fleet_local_plans)?.fleet_local_plans.peers.find((r: any) => r.robot_id === "robot-1");
    expect(observed).toBeDefined();
    expect(observed.points).toHaveLength(0);
    expect(observed).toMatchObject({ x: f.robot().x, y: f.robot().y, operator_paused: true });
  } finally { peer.end(); f.close(); }
});

test("operating disable and reactivation preserve pause intent while clearing the old mission", () => {
  const f = fixture();
  try {
    (f.room as any).commandRobot(f.browser, { robotId: "robot-1", kind: "move", x: 420, y: 520, theta: 0 });
    f.request("before-disable", true);
    const at = f.c.snapshot();
    (f.room as any).setRobotControl(f.browser, { robotId: "robot-1", requestId: "disable", expectedEpoch: f.robot().controlEpoch, enabled: false });
    expect(f.robot().fmsControlState).toBe("disabled");
    expect(f.c.snapshot().operatorPaused).toBe(true);
    f.report();
    (f.room as any).setRobotControl(f.browser, { robotId: "robot-1", requestId: "enable", expectedEpoch: f.robot().controlEpoch, enabled: true });
    expect(f.robot().fmsControlState).toBe("enabled");
    expect(f.robot().controlReady).toBe(true);
    expect(f.c.snapshot().operatorPaused).toBe(true);
    expect(f.c.snapshot().workState).toBe("idle");
    expect(f.c.currentPath()).toEqual([]);
    for (let i = 0; i < 10; i++) (f.c as any).tick();
    expect(f.c.snapshot()).toMatchObject({ x: at.x, y: at.y, theta: at.theta });
  } finally { f.close(); }
});

test("explicit actuator rejection rolls back desired intent and conflicting request IDs cannot flip it", () => {
  const f = fixture();
  try {
    (f.c as any).teleporterTransferActive = true;
    f.request("rejected", true);
    expect(f.replies.find(r => r.requestId === "rejected")).toMatchObject({ ok: false, reasonCode: "transfer_in_progress" });
    expect(f.robot().operatorPauseDesired).toBe(false);
    expect(f.store.getRobot("robot-1")!.operatorPaused).toBe(false);
    (f.c as any).teleporterTransferActive = false;
    f.request("applied", true);
    f.request("applied", false);
    expect(f.replies.at(-1)).toMatchObject({ ok: false, reasonCode: "request_id_conflict" });
    expect(f.robot().operatorPauseDesired).toBe(true);
    expect(f.c.snapshot().operatorPaused).toBe(true);
  } finally { f.close(); }
});

test("explicit test positioning confirms its ACK while preserving an existing manual pause", () => {
  const f = fixture();
  try {
    f.request("position-pause", true);
    (f.room as any).overrideRobotPose(f.browser, { testOnly: true, mapId: "yard", robotId: "robot-1", requestId: "position", expectedEpoch: f.robot().controlEpoch, x: 320, y: 520, theta: Math.PI / 2 });
    expect(f.replies.find(r => r.requestId === "position")).toMatchObject({ accepted: true });
    expect(f.robot().fmsControlState).toBe("disabled");
    expect(f.c.snapshot()).toMatchObject({ operatorPaused: true, x: 320, y: 520, theta: Math.PI / 2 });
  } finally { f.close(); }
});
