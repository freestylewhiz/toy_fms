import { expect, test } from "bun:test";
import { FloorRoom } from "../server/src/rooms/FloorRoom.ts";
import { RuntimeStore } from "../server/src/runtimeStore.ts";
import { TeleporterStore } from "../server/src/teleporterStore.ts";
import { defaultTeleporterOccupancyPolygon } from "../shared/teleporterRuntime.ts";
import { EventEmitter } from "node:events";
import { attachRobotSession } from "../server/src/grpc/robotBridge.ts";
import { PROTOCOL_VERSION } from "../shared/robotProtocol.ts";

function fixture() {
  const runtime = new RuntimeStore(":memory:");
  const ledger = new TeleporterStore(":memory:");
  ledger.upsert({ id: "audit", name: "audit", enabled: true, revision: 1, endpoints: [
    { id: "source", mapId: "large_lab", position: { x: 1300, y: 1300 }, entryTheta: 0, exitTheta: 0, occupancyPolygon: defaultTeleporterOccupancyPolygon(), clearingPoint: { x: 1340, y: 1300 } },
    { id: "destination", mapId: "yard", position: { x: 240, y: 520 }, entryTheta: 0, exitTheta: 0, occupancyPolygon: defaultTeleporterOccupancyPolygon(), clearingPoint: { x: 280, y: 520 } },
  ] });
  ledger.claimRobotOwner({ robotId: "robot-1", mapId: "yard", controlEpoch: 1, transferId: "audit-transfer" });
  ledger.saveTransfer({ transferId: "audit-transfer", teleporterId: "audit", robotId: "robot-1", fromEndpointId: "source", toEndpointId: "destination", phase: "completed", sourceMapId: "large_lab", destinationMapId: "yard", sourceEpoch: 0, destinationEpoch: 1, reason: "" });
  const room = new FloorRoom();
  room.onCreate({ runtimeStore: runtime, teleporterStore: ledger });
  return { room, ledger, runtime, close() { room.onDispose(); room.clock.stop(); runtime.close(); } };
}

test("completed handoff registration never resurrects a running transfer", () => {
  const f = fixture();
  try {
    const robot = f.room.state.robots.get("robot-1")!;
    robot.controlEpoch = 1; robot.x = 320; robot.y = 520;
    robot.commandId = "audit-transfer"; robot.commandState = "completed";
    expect((f.room as any).allowTransferredRegistration("robot-1", "yard", "audit-transfer")).toBe(true);
    expect(robot.commandState).not.toBe("running");
    expect((f.room as any).teleporterTransfers.has("robot-1")).toBe(false);
  } finally { f.close(); }
});

test("transferred robot reconnect preserves explicit operating exclusion", () => {
  const f = fixture();
  try {
    const robot = f.room.state.robots.get("robot-1")!;
    robot.controlEpoch = 1; robot.fmsControlState = "disabled";
    expect((f.room as any).allowTransferredRegistration("robot-1", "yard", "audit-transfer")).toBe(true);
    expect(robot.fmsControlState).toBe("disabled");
    expect(robot.controlReady).toBe(false);
  } finally { f.close(); }
});

test("former source rejects native registration once another map owns the identity", () => {
  const f = fixture();
  try {
    expect(f.ledger.claimRobotOwner({ robotId: "robot-1", mapId: "large_lab", controlEpoch: 2, expectedMapId: "yard", transferId: "next" })).toBe(true);
    expect((f.room as any).allowTransferredRegistration("robot-1", "yard", "")).toBe(false);
  } finally { f.close(); }
});

test("server restart restores a transferred non-native robot's disabled runtime", () => {
  const f = fixture();
  try {
    f.runtime.upsertRobot({ ...f.runtime.getRobot("robot-1")!, robotId: "mobile-robot", x: 320, y: 520, theta: 0, controlEpoch: 3, fmsControlState: "disabled" });
    f.ledger.claimRobotOwner({ robotId: "mobile-robot", mapId: "yard", controlEpoch: 3, transferId: "mobile-transfer" });
    f.ledger.saveTransfer({ ...f.ledger.getTransfer("audit-transfer")!, transferId: "mobile-transfer", robotId: "mobile-robot", destinationEpoch: 3 });
    expect((f.room as any).allowTransferredRegistration("mobile-robot", "yard", "mobile-transfer")).toBe(true);
    const robot = f.room.state.robots.get("mobile-robot")!;
    expect(robot.fmsControlState).toBe("disabled");
    expect(robot.controlEpoch).toBe(3);
    expect(robot.x).toBe(320);
  } finally { f.close(); }
});

test("deleting a completed teleporter never prevents its robot from reconnecting", () => {
  const f = fixture();
  try {
    f.ledger.delete("audit");
    expect((f.room as any).allowTransferredRegistration("robot-1", "yard", "audit-transfer")).toBe(true);
  } finally { f.close(); }
});

test("completed transfer proofs still enforce robot identity and current owner", () => {
  const f = fixture();
  try {
    expect((f.room as any).allowTransferredRegistration("robot-2", "yard", "audit-transfer")).toBe(false);
    f.ledger.claimRobotOwner({ robotId: "robot-1", mapId: "large_lab", controlEpoch: 2, expectedMapId: "yard", transferId: "new-transfer" });
    expect((f.room as any).allowTransferredRegistration("robot-1", "yard", "audit-transfer")).toBe(false);
  } finally { f.close(); }
});

test("operating exclusion fences transferred ownership at the new control epoch", () => {
  const f = fixture();
  try {
    const robot = f.room.state.robots.get("robot-1")!;
    robot.controlEpoch = 1;
    (f.room as any).setRobotControl({ sessionId: "audit-operator", send() {} }, { robotId: "robot-1", enabled: false, requestId: "exclude", expectedEpoch: 1 });
    expect(robot.fmsControlState).toBe("disabled");
    expect(robot.controlEpoch).toBeGreaterThan(1);
    expect(f.ledger.getRobotOwner("robot-1")?.controlEpoch).toBe(robot.controlEpoch);
    expect(f.ledger.getRobotOwner("robot-1")?.transferId).toBe("audit-transfer");
  } finally { f.close(); }
});

test("ordinary commands cannot overwrite a live teleporter transfer", () => {
  const f = fixture();
  const errors: string[] = [];
  try {
    const robot = f.room.state.robots.get("robot-1")!;
    robot.connected = true; robot.controlReady = true; robot.fmsControlState = "enabled";
    (f.room as any).canControl = () => true;
    const client = { send(type: string, body: unknown) { if (type === "error") errors.push(String((body as any).message ?? body)); } };
    f.ledger.requestUse({ teleporterId: "audit", robotId: "robot-1", fromEndpointId: "destination", toEndpointId: "source", requestId: "guard-active", controlEpoch: 1 });
    (f.room as any).commandRobot(client, { robotId: "robot-1", kind: "move", x: 280, y: 520, theta: 0 });
    expect(errors.at(-1)).toContain("teleporter transfer in progress");
    f.ledger.cancelReserved("audit", "robot-1", "guard-active");
    expect(() => (f.room as any).commandRobot(client, { robotId: "robot-1", kind: "move", x: 280, y: 520, theta: 0 })).not.toThrow();
    expect(errors.at(-1)).not.toContain("teleporter transfer in progress");
  } finally { f.close(); }
});

test("losing the live robot session preserves its teleporter reservation", () => {
  const f = fixture();
  class Stream extends EventEmitter {
    writableEnded = false;
    destroyed = false;
    write() { return true; }
    end() { if (!this.writableEnded) { this.writableEnded = true; this.emit("close"); } }
  }
  const stream = new Stream();
  try {
    f.room.state.robots.get("robot-1")!.controlEpoch = 1;
    f.ledger.requestUse({ teleporterId: "audit", robotId: "robot-1", fromEndpointId: "destination", toEndpointId: "source", requestId: "next-use", controlEpoch: 1 });
    attachRobotSession(stream as any);
    stream.emit("data", { register: { robot_id: "robot-1", protocol_version: PROTOCOL_VERSION, map_id: "yard", transfer_id: "audit-transfer" } });
    stream.end();
    expect(f.room.state.robots.get("robot-1")?.connected).toBe(false);
    expect(f.ledger.activeUse("audit")?.requestId).toBe("next-use");
  } finally { stream.end(); f.close(); }
});

test("confirmed arrival removes the former source body from active map and world", () => {
  const f = fixture();
  try {
    f.ledger.claimRobotOwner({ robotId: "robot-1", mapId: "large_lab", controlEpoch: 2, expectedMapId: "yard", transferId: "next-transfer" });
    f.ledger.saveTransfer({ ...f.ledger.getTransfer("audit-transfer")!, transferId: "next-transfer", sourceMapId: "yard", destinationMapId: "large_lab", fromEndpointId: "destination", toEndpointId: "source", sourceEpoch: 1, destinationEpoch: 2, phase: "arrived" });
    (f.room as any).refreshTeleporters();
    expect(f.room.state.robots.has("robot-1")).toBe(false);
    expect((f.ledger.mapWorld("yard").robots as any[]).some(robot => robot.robotId === "robot-1")).toBe(false);
  } finally { f.close(); }
});


test("shared operator recovery releases historical rows without epoch ping-pong or stale resurrection", () => {
  const f = fixture();
  try {
    const addClaim = (id: string, robotId: string) => f.runtime.upsertOccupancy({ resourceRef: { mapId: "yard", kind: "edge", id }, robotId, state: "reserved", requestId: id, controlEpoch: 0, createdAt: 1, updatedAt: 1 });
    addClaim("former-source", "robot-1"); addClaim("other", "robot-2");
    f.room.state.robots.delete("robot-1"); // departed robot still has a runtime row
    f.ledger.forceReleaseRobot("robot-1", 2);
    for (let i = 0; i < 8; i++) (f.room as any).refreshTeleporters();
    expect(f.ledger.getRobotOwner("robot-1")?.controlEpoch).toBe(2);
    expect(f.runtime.getRobot("robot-1")).toMatchObject({ fmsControlState: "disabled", controlEpoch: 2 });
    expect(f.runtime.listOccupancies().map(item => item.robotId)).toEqual(["robot-2"]);
    expect(f.runtime.listRecoveryPending()).toHaveLength(0);
    expect(f.room.state.robots.has("robot-1")).toBe(false);
    // A later explicit activation elsewhere supersedes this historical row.
    f.ledger.clearRobotAdministrativeDisabled("robot-1", 3);
    for (let i = 0; i < 3; i++) (f.room as any).refreshTeleporters();
    expect(f.ledger.getRobotAdministrativeControl("robot-1")?.disabled).toBe(false);
  } finally { f.close(); }
});

test("repeated shared recovery projection has a stable generation", () => {
  const f = fixture();
  try {
    f.ledger.forceReleaseRobot("robot-1", 2);
    for (let i = 0; i < 8; i++) (f.room as any).refreshTeleporters();
    expect(f.room.state.robots.get("robot-1")?.controlEpoch).toBe(2);
    expect(f.ledger.getRobotOwner("robot-1")?.controlEpoch).toBe(2);
    expect(f.runtime.listRecoveryPending()).toHaveLength(0);
  } finally { f.close(); }
});
