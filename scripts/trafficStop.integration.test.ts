import { EventEmitter } from "node:events";
import { expect, spyOn, test } from "bun:test";
import * as protoLoader from "../server/node_modules/@grpc/proto-loader/build/src/index.js";
import { FloorRoom } from "../server/src/rooms/FloorRoom.ts";
import { attachRobotSession } from "../server/src/grpc/robotBridge.ts";
import { RuntimeStore } from "../server/src/runtimeStore.ts";
import { TeleporterStore } from "../server/src/teleporterStore.ts";
import { GrpcClient } from "../virtual-robot/src/grpcClient.ts";
import { LocalPlanExecutor, grantFromProtoV1 } from "../virtual-robot/src/traffic/LocalPlanExecutor.ts";
import { PROTOCOL_VERSION } from "../shared/robotProtocol.ts";
import { DEADLOCK_CONFIRM_MS } from "../shared/constants.ts";

const definition = protoLoader.loadSync(new URL("../proto/robot.proto", import.meta.url).pathname, {
  keepCase: true, oneofs: true, defaults: true, longs: String, enums: String,
});
const wire = (definition["bgfms.RobotBridge"] as any).Session;

/** In-memory transport still serializes both directions with the production proto. */
class RobotStream extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  messages: any[] = [];
  incoming: any[] = [];
  dropResume = false;
  onWrite?: (message: any) => void;
  write(message: unknown) {
    const decoded = wire.responseDeserialize(wire.responseSerialize(message));
    this.messages.push(decoded);
    if (!(this.dropResume && decoded.traffic_stop_status?.decision === "RESUME")) this.onWrite?.(decoded);
    return true;
  }
  receive(message: any) {
    const decoded = wire.requestDeserialize(wire.requestSerialize(message));
    this.incoming.push(decoded);
    this.emit("data", decoded);
  }
  end() { if (!this.writableEnded) { this.writableEnded = true; this.emit("close"); } }
  destroy() { this.destroyed = true; this.end(); }
}

function fixture() {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const room = new FloorRoom();
  const runtime = new RuntimeStore(":memory:");
  const teleporter = new TeleporterStore(":memory:");
  room.onCreate({ runtimeStore: runtime, teleporterStore: teleporter });
  const authority = (room as any).traffic;
  authority.stop();
  // Test ordinary open space, isolated from editor resources on the developer machine.
  const originalWorld = authority.hooks.getWorld;
  authority.hooks.getWorld = () => ({ ...originalWorld(), zones: [] });
  const robots = ["robot-1", "robot-2"].map((id, i) => {
    const stream = new RobotStream();
    let x = 240 + i * 80, y = 520;
    let status: "idle" | "move" = "idle";
    let path = [{ x, y }];
    let client: GrpcClient;
    const executor = new LocalPlanExecutor({
      sendLeaseRequest: () => {}, sendLeaseRelease: () => {},
      sendTrafficStopCheck: body => client.sendTrafficStopCheck(body),
    });
    const snapshot = () => ({ x, y, theta: 0, status, motion: "HOLD", leaseId: executor.leaseId(), avoidanceMode: true,
      headRoomPx: Infinity, trafficStatus: executor.trafficStatus(), commandId: "", commandState: "idle", commandReason: "",
      workState: status === "idle" ? "idle" : "busy", driveState: "stationary", driveContextJson: "[]", reportedAt: now,
    });
    client = new GrpcClient({
      robotId: id, getPose: snapshot, getPath: () => path, takePathDelta: () => null, getLocalPlan: () => path,
      onDrive: () => {}, onCancel: () => {}, onPlaceQuery: () => ({ ok: true, reason: "" }), onObstacles: () => {},
      onControlState: state => executor.setControlState(state),
      onLeaseGrant: msg => executor.onGrant(grantFromProtoV1(msg)),
      onTrafficStopStatus: msg => executor.onTrafficStopStatus(msg),
      onZoneUpdate: (zone, state) => executor.onZoneUpdate(zone, state),
    });
    (client as any).liveStream = { writable: true, write: (message: unknown) => stream.receive(message) };
    stream.onWrite = message => (client as any).handleServerMsg(message);
    attachRobotSession(stream as any);
    stream.receive({ register: { robot_id: id, protocol_version: PROTOCOL_VERSION } });
    const report = () => (client as any).sendInitialTelemetry();
    return { id, stream, client, executor, snapshot, report,
      place(nx: number, ny: number, points: { x: number; y: number }[]) { x = nx; y = ny; path = points; status = "move"; report(); },
      poll() { executor.onTick({ x, y, theta: 0, path, pathIndex: 0, phase: "hold", avoidanceMode: true }); },
    };
  });
  const [a, b] = robots;
  a.place(240, 520, [{ x: 240, y: 520 }, { x: 320, y: 520 }]);
  b.place(320, 520, [{ x: 320, y: 520 }, { x: 240, y: 520 }]);
  authority.tick();
  now += DEADLOCK_CONFIRM_MS + 50;
  robots.forEach(r => r.report());
  authority.tick();
  return { room, robots, a, b, authority,
    advance(ms: number) { now += ms; robots.forEach(r => r.report()); },
    close() { robots.forEach(r => r.stream.end()); room.onDispose(); room.clock.stop(); teleporter.close(); clock.mockRestore(); },
  };
}

test("protobuf STOP polling retains conflict, recovers a dropped RESUME, and rejects old control envelopes", () => {
  const f = fixture();
  try {
    const stopped = f.robots.find(r => r.executor.trafficStatus() === "stop")!;
    expect(stopped).toBeDefined();
    const peer = f.robots.find(r => r !== stopped)!;
    const grant = stopped.stream.messages.findLast(m => m.lease_grant?.signal === "SIGNAL_STOP").lease_grant;
    expect(grant.stop_id).not.toBe("");
    expect(Number(grant.stop_generation)).toBeGreaterThan(0);
    stopped.poll();
    expect(stopped.stream.incoming.at(-1).payload).toBe("traffic_stop_check");
    expect(stopped.stream.messages.at(-1).traffic_stop_status.decision).toBe("STOP");
    expect(stopped.executor.trafficStatus()).toBe("stop");
    const checks = stopped.stream.incoming.filter(m => m.traffic_stop_check).length;
    f.advance(500);
    stopped.poll();
    expect(stopped.stream.incoming.filter(m => m.traffic_stop_check)).toHaveLength(checks);

    // A stale session must not be interpreted as a reevaluation request.
    const sent = stopped.stream.messages.length;
    const validCheck = stopped.stream.incoming.findLast(m => m.traffic_stop_check).traffic_stop_check;
    stopped.stream.receive({ traffic_stop_check: { ...validCheck, session_id: "old-session" } });
    stopped.stream.receive({ traffic_stop_check: { ...validCheck, control_epoch: Number(validCheck.control_epoch) + 1 } });
    expect(stopped.stream.messages).toHaveLength(sent);

    peer.place(600, 600, [{ x: 600, y: 600 }]);
    stopped.stream.dropResume = true;
    f.advance(1100);
    stopped.poll();
    const release = stopped.stream.messages.findLast(m => m.traffic_stop_status)?.traffic_stop_status;
    expect(release.decision).toBe("RESUME");
    expect(release.stop_id).toBe(grant.stop_id);
    expect(release.stop_generation).toBe(grant.stop_generation);
    expect(stopped.executor.trafficStatus()).toBe("stop");
    stopped.stream.dropResume = false;
    f.advance(1100);
    stopped.poll();
    expect(stopped.executor.trafficStatus()).toBe("proceed");
    expect(f.room.state.robots.get(stopped.id)!.trafficStatus).toBe("proceed");
  } finally { f.close(); }
});

test("a dropped release is reevaluated against a newly conflicting peer before it is resent", () => {
  const f = fixture();
  try {
    const stopped = f.robots.find(r => r.executor.trafficStatus() === "stop")!;
    const peer = f.robots.find(r => r !== stopped)!;
    const originalGrant = stopped.stream.messages.findLast(m => m.lease_grant?.signal === "SIGNAL_STOP").lease_grant;
    const peerInitial = peer.snapshot();
    peer.place(600, 600, [{ x: 600, y: 600 }]);
    stopped.stream.dropResume = true;
    stopped.poll();
    const delayedResume = stopped.stream.messages.findLast(m => m.traffic_stop_status?.decision === "RESUME");
    expect(delayedResume).toBeDefined();
    peer.place(peerInitial.x, peerInitial.y, [{ x: peerInitial.x, y: peerInitial.y }]);
    stopped.stream.dropResume = false;
    f.advance(1100);
    stopped.poll();
    expect(stopped.executor.trafficStatus()).toBe("stop");
    const newestGrant = stopped.stream.messages.findLast(m => m.lease_grant?.signal === "SIGNAL_STOP").lease_grant;
    expect(Number(newestGrant.stop_generation)).toBeGreaterThan(Number(originalGrant.stop_generation));
    (stopped.client as any).handleServerMsg(delayedResume);
    expect(stopped.executor.trafficStatus()).toBe("stop");
  } finally { f.close(); }
});


test("periodic clearance after a correlated reroute preserves the STOP identity until robot acknowledgement", () => {
  const f = fixture();
  try {
    const stopped = f.robots.find(r => r.executor.trafficStatus() === "stop")!;
    const peer = f.robots.find(r => r !== stopped)!;
    const request = peer.stream.messages.findLast(m => m.evasion_request)?.evasion_request;
    expect(request).toBeDefined();
    peer.client.sendEvasionReply({ zone_id: request.zone_id, round_id: request.round_id, result: "REROUTE", reason: "test detour" });
    peer.place(600, 600, [{ x: 600, y: 600 }]);
    f.authority.tick();
    stopped.poll();
    expect(stopped.executor.trafficStatus()).toBe("proceed");
    const release = stopped.stream.messages.findLast(m => m.traffic_stop_status)?.traffic_stop_status;
    expect(release.decision).toBe("RESUME");
  } finally { f.close(); }
});
