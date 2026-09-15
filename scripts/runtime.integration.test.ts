import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import * as protoLoader from "../server/node_modules/@grpc/proto-loader/build/src/index.js";
import { Encoder, Decoder } from "../server/node_modules/@colyseus/schema/build/esm/index.mjs";
import { FloorRoom } from "../server/src/rooms/FloorRoom.ts";
import { FloorState } from "../server/src/schema.ts";
import { attachRobotSession } from "../server/src/grpc/robotBridge.ts";
import { RuntimeStore } from "../server/src/runtimeStore.ts";
import { PROTOCOL_VERSION } from "../shared/robotProtocol.ts";
import { snapshotFromState, canDispatchRobot } from "../web-client/src/snapshot.ts";
import { RobotController } from "../virtual-robot/src/controller.ts";
import { GrpcClient } from "../virtual-robot/src/grpcClient.ts";
import { clearSemanticZones } from "../shared/planner.ts";
import { setExtraBlocked } from "../shared/occupancy.ts";

const definition = protoLoader.loadSync(new URL("../proto/robot.proto", import.meta.url).pathname,
  { keepCase: true, oneofs: true, defaults: true, longs: String, enums: String });
const wire = (definition["bgfms.RobotBridge"] as any).Session;
class Stream extends EventEmitter {
  constructor(readonly robotId = "robot-1") { super(); }
  destroyed = false;
  writableEnded = false;
  messages: any[] = [];
  onWrite?: (message: any) => void;
  write(message: unknown) { const decoded = wire.responseDeserialize(wire.responseSerialize(message)); this.messages.push(decoded); this.onWrite?.(decoded); return true; }
  receive(message: unknown) { this.emit("data", wire.requestDeserialize(wire.requestSerialize(message))); }
  end() { if (this.writableEnded) return; this.writableEnded = true; this.emit("close"); }
  get control() { return this.messages.findLast(m => m.payload === "control_state").control_state; }
  pose(extra: Record<string, unknown> = {}) {
    this.receive({ pose: { robot_id: this.robotId, x: 240, y: 520, theta: 0, status: "idle",
      motion: "IDLE", work_state: "idle", drive_state: "stationary", drive_context_json: "[]",
      reported_at: Date.now(), control_epoch: this.control.control_epoch, session_id: this.control.session_id, ...extra } });
  }
  sync() {
    this.pose();
    this.receive({ control_ack: { robot_id: this.robotId, ...this.control, ready: true } });
  }
}

function fixture(path: string) {
  const store = new RuntimeStore(path);
  const room = new FloorRoom();
  room.onCreate({ runtimeStore: store } as any);
  const encoder = new Encoder(room.state);
  const streams: Stream[] = [];
  const output: { type: string; body: any }[] = [];
  const client = { sessionId: "runtime-test-operator", send: (type: string, body: any) => output.push({ type, body }) };
  return {
    room, store, client, output,
    connect(robotId = "robot-1", setup?: (stream: Stream) => void) {
      const stream = new Stream(robotId); streams.push(stream); setup?.(stream); attachRobotSession(stream as any);
      stream.receive({ register: { robot_id: robotId, protocol_version: PROTOCOL_VERSION } });
      return stream;
    },
    browser(robotId = "robot-1") {
      const decoded = new FloorState();
      new Decoder(decoded).decode(encoder.encodeAll());
      return snapshotFromState(decoded as any).robots.find(r => r.id === robotId)!;
    },
    close() { for (const stream of streams) stream.end(); room.onDispose(); room.clock.stop(); store.close(); },
  };
}

test("disabled control survives telemetry, reconnect and room restart; explicit synchronized enable restores dispatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fms-runtime-integration-"));
  const path = join(dir, "runtime.sqlite");
  let f = fixture(path);
  try {
    let stream = f.connect(); stream.sync();
    expect(canDispatchRobot(f.browser())).toBe(true);
    const oldEpoch = f.browser().controlEpoch;
    const oldSession = stream.control.session_id;
    await (f.room as any).setRobotControl(f.client, { robotId: "robot-1", enabled: false, requestId: "disable", expectedEpoch: oldEpoch });
    stream.sync();
    expect(f.browser().fmsControlState).toBe("disabled");
    expect(canDispatchRobot(f.browser())).toBe(false);
    expect(f.browser().controlEpoch).toBeGreaterThan(oldEpoch);
    stream.pose({ x: 248, status: "move", work_state: "busy", drive_state: "moving" });
    expect(f.browser().x).toBe(248);
    expect(f.browser().driveState).toBe("moving");
    expect(f.browser().fmsControlState).toBe("disabled");
    const driveCount = stream.messages.filter(m => m.payload === "drive").length;
    (f.room as any).commandRobot(f.client, { robotId: "robot-1", kind: "move", x: 280, y: 520, theta: 0 });
    expect(stream.messages.filter(m => m.payload === "drive")).toHaveLength(driveCount);
    stream.receive({ path: { robot_id: "robot-1", points: [{ x: 248, y: 520 }, { x: 280, y: 520 }], control_epoch: oldEpoch, session_id: oldSession } });
    expect(f.browser().path).toHaveLength(0);
    stream.end(); stream = f.connect(); stream.sync();
    expect(stream.control.enabled).toBe(false);
    expect(f.browser().fmsControlState).toBe("disabled");
    f.close(); f = fixture(path);
    expect(f.browser().fmsControlState).toBe("disabled");
    expect(canDispatchRobot(f.browser())).toBe(false);
    await (f.room as any).setRobotControl(f.client, { robotId: "robot-1", enabled: true, requestId: "offline-enable", expectedEpoch: f.browser().controlEpoch });
    expect(f.output.find(o => o.type === "runtimeAck" && o.body.requestId === "offline-enable")?.body.ok).toBe(false);
    stream = f.connect(); stream.sync();
    const enabling = (f.room as any).setRobotControl(f.client, { robotId: "robot-1", enabled: true, requestId: "enable", expectedEpoch: f.browser().controlEpoch });
    expect(f.browser().fmsControlState).toBe("disabled");
    stream.sync();
    await enabling;
    expect(f.browser().fmsControlState).toBe("enabled");
    expect(canDispatchRobot(f.browser())).toBe(true);
    expect(f.browser().workState).toBe("idle");
  } finally { f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("real virtual robot control handler publishes a fresh cleared pose before each activation acknowledgement", () => {
  const f = fixture(":memory:");
  const controller = new RobotController({ x: 240, y: 520, theta: 0 });
  controller.setConnectionReady(false);
  const robotClient = new GrpcClient({ robotId: "robot-1", getPose: () => controller.snapshot(), getPath: () => controller.currentPath(), takePathDelta: () => controller.takePathDelta(), getLocalPlan: () => controller.currentLocalPlan(),
    onDrive: cmd => controller.handleDrive(cmd), onCancel: id => controller.handleCancel(id), onPlaceQuery: o => controller.canPlace(o), onObstacles: o => controller.setObstacles(o),
    onSemanticSnapshot: s => controller.setSemanticSnapshot(s), onConnectionState: ready => controller.setConnectionReady(ready), onControlState: state => controller.setControlState(state) });
  try {
    f.connect("robot-1", stream => {
      (robotClient as any).liveStream = { writable: true, write: (message: unknown) => stream.receive(message) };
      stream.onWrite = message => (robotClient as any).handleServerMsg(message);
    });
    expect(canDispatchRobot(f.browser())).toBe(true);
    (f.room as any).setRobotControl(f.client, { robotId: "robot-1", enabled: false, requestId: "real-disable", expectedEpoch: f.browser().controlEpoch });
    expect(f.browser().fmsControlState).toBe("disabled");
    (f.room as any).setRobotControl(f.client, { robotId: "robot-1", enabled: true, requestId: "real-enable", expectedEpoch: f.browser().controlEpoch });
    expect(f.output.find(o => o.body.requestId === "real-enable")?.body.ok).toBe(true);
    expect(canDispatchRobot(f.browser())).toBe(true);
    expect(controller.snapshot().workState).toBe("idle");
  } finally { controller.stop(); f.close(); clearSemanticZones(); setExtraBlocked(null); }
});

test("activation timeout stays disabled and fences a delayed success acknowledgement", async () => {
  const f = fixture(":memory:");
  try {
    const stream = f.connect(); stream.sync();
    (f.room as any).setRobotControl(f.client, { robotId: "robot-1", enabled: false, requestId: "timeout-disable", expectedEpoch: f.browser().controlEpoch });
    stream.sync();
    (f.room as any).setRobotControl(f.client, { robotId: "robot-1", enabled: true, requestId: "timeout-enable", expectedEpoch: f.browser().controlEpoch });
    const staleControl = { ...stream.control };
    expect(f.store.getRobot("robot-1")?.fmsControlState).toBe("disabled");
    await Bun.sleep(3100);
    expect(f.output.find(o => o.body.requestId === "timeout-enable")?.body.ok).toBe(false);
    stream.receive({ control_ack: { robot_id: "robot-1", ...staleControl, ready: true } });
    expect(f.browser().fmsControlState).toBe("disabled");
    expect(canDispatchRobot(f.browser())).toBe(false);
    expect(f.browser().controlEpoch).toBeGreaterThan(Number(staleControl.control_epoch));
  } finally { f.close(); }
});

test("capacity wait identifies its resource and blocker; manual recovery preserves other holds and cannot resurrect released occupancy", () => {
  const dir = mkdtempSync(join(tmpdir(), "fms-runtime-capacity-"));
  const f = fixture(join(dir, "runtime.sqlite"));
  const traffic = (f.room as any).traffic;
  const originalWorld = traffic.hooks.getWorld;
  const zone = (id: string) => ({ id, family: "scene", name: id, kind: "corridor", theta: 0, capacity: 1,
    polygon: [{x:260,y:490},{x:300,y:490},{x:300,y:550},{x:260,y:550}] });
  traffic.hooks.getWorld = () => ({ ...originalWorld(), zones: [zone("runtime-a"), zone("runtime-b")] });
  try {
    const occupant = f.connect(); occupant.sync(); occupant.pose({ x: 280 });
    traffic.tick();
    const contender = f.connect("robot-2"); contender.sync();
    contender.receive({ local_plan: { robot_id: "robot-2", points: [{x:240,y:520},{x:280,y:520}], horizon_s: 5,
      control_epoch: contender.control.control_epoch, session_id: contender.control.session_id } });
    contender.pose({ status: "move", work_state: "busy", drive_state: "waiting" });
    traffic.tick();
    const waiting = f.browser("robot-2");
    expect(waiting.workState).toBe("busy");
    expect(waiting.driveState).toBe("waiting");
    expect(waiting.driveContexts.some(c => c.target?.id === "runtime-a" && c.reasonCode === "resource_occupied" && c.blockingRobotIds?.includes("robot-1"))).toBe(true);
    occupant.end(); traffic.tick();
    expect(f.store.listOccupancies().filter(o => o.robotId === "robot-1")).toHaveLength(2);
    (f.room as any).releaseResourceOccupancy(f.client, { resourceKind: "zone", resourceId: "runtime-a", robotId: "robot-1", requestId: "release-one", expectedEpoch: f.browser().controlEpoch });
    expect(f.browser().fmsControlState).toBe("disabled");
    traffic.tick();
    expect(f.store.listOccupancies().some(o => o.resourceRef.id === "runtime-a" && o.robotId === "robot-1")).toBe(false);
    expect(f.store.listOccupancies().some(o => o.resourceRef.id === "runtime-b" && o.robotId === "robot-1")).toBe(true);
    const reconnected = f.connect(); reconnected.sync(); reconnected.pose({ x: 280 }); traffic.tick();
    expect(f.store.listOccupancies().some(o => o.resourceRef.id === "runtime-a" && o.robotId === "robot-1")).toBe(false);
    expect(f.store.getRobot("robot-1")?.fmsControlState).toBe("disabled");
    // Repeating the request returns its original outcome without advancing control generation.
    const epoch = f.browser().controlEpoch;
    (f.room as any).releaseResourceOccupancy(f.client, { resourceKind: "zone", resourceId: "runtime-a", robotId: "robot-1", requestId: "release-one", expectedEpoch: epoch - 1 });
    expect(f.browser().controlEpoch).toBe(epoch);
  } finally { f.close(); rmSync(dir, { recursive: true, force: true }); }
});
