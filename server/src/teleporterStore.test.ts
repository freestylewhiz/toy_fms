import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { defaultTeleporterOccupancyPolygon, type TeleporterDefinition } from "../../shared/teleporterRuntime.ts";
import { TeleporterStore } from "./teleporterStore.ts";

const paths: string[] = [];
function definition(): TeleporterDefinition & { name: string } {
  return {
    id: "t1", name: "lift", revision: 1, enabled: true,
    endpoints: [
      { id: "yard-end", mapId: "yard", position: { x: 100, y: 100 }, entryTheta: 0, exitTheta: Math.PI, occupancyPolygon: defaultTeleporterOccupancyPolygon(), clearingPoint: { x: 140, y: 100 } },
      { id: "lab-end", mapId: "large_lab", position: { x: 200, y: 200 }, entryTheta: Math.PI, exitTheta: 0, occupancyPolygon: defaultTeleporterOccupancyPolygon(), clearingPoint: { x: 240, y: 200 } },
    ],
  };
}
function store(): TeleporterStore { const path = `/tmp/teleporter-${crypto.randomUUID()}.sqlite`; paths.push(path); return new TeleporterStore(path); }
afterEach(() => { for (const path of paths.splice(0)) { try { unlinkSync(path); } catch {} try { unlinkSync(`${path}-wal`); } catch {} try { unlinkSync(`${path}-shm`); } catch {} } });

describe("TeleporterStore", () => {
  test("persists exactly two endpoints and increments definition revision", () => {
    const first = store();
    expect(first.upsert(definition()).revision).toBe(1);
    first.close();
    const second = new TeleporterStore(paths[0]);
    expect(second.get("t1")?.endpoints).toHaveLength(2);
    expect(second.upsert(definition()).revision).toBe(2);
    second.close();
  });

  test("uses optimistic revision checks for concurrent definition edits", () => {
    const db = store(); db.upsert(definition());
    expect(db.upsert({ ...definition(), name: "updated" }, 1).revision).toBe(2);
    expect(() => db.upsert({ ...definition(), name: "stale" }, 1)).toThrow("revision conflict");
    db.close();
  });

  test("rejects create collision with revision zero", () => {
    const db = store(); db.upsert(definition());
    expect(() => db.upsert({ ...definition(), revision: 0 })).toThrow("already exists");
    db.close();
  });

  test("locks edits and deletes while queued or durable transfer is clearing", () => {
    const db = store(); db.upsert(definition());
    db.requestUse({ teleporterId: "t1", robotId: "r1", fromEndpointId: "yard-end", toEndpointId: "lab-end", requestId: "active", controlEpoch: 1 });
    db.requestUse({ teleporterId: "t1", robotId: "r2", fromEndpointId: "lab-end", toEndpointId: "yard-end", requestId: "queued", controlEpoch: 1 });
    expect(() => db.delete("t1")).toThrow("in use");
    db.cancelReserved("t1", "r1", "active");
    expect(() => db.delete("t1")).toThrow("in use");
    db.cancelQueued("t1", "r2", "queued");
    db.saveTransfer({ transferId: "tx", teleporterId: "t1", robotId: "r1", fromEndpointId: "yard-end", toEndpointId: "lab-end", phase: "clearing", sourceMapId: "yard", destinationMapId: "large_lab", sourceEpoch: 1, destinationEpoch: 2, reason: "", });
    expect(() => db.delete("t1")).toThrow("in use");
    db.saveTransfer({ transferId: "tx", teleporterId: "t1", robotId: "r1", fromEndpointId: "yard-end", toEndpointId: "lab-end", phase: "failed", sourceMapId: "yard", destinationMapId: "large_lab", sourceEpoch: 1, destinationEpoch: 2, reason: "cancelled", });
    db.delete("t1");
    db.close();
  });

  test("reserves both endpoint identities and serves requests FIFO", () => {
    const db = store(); db.upsert(definition());
    const first = db.requestUse({ teleporterId: "t1", robotId: "r1", fromEndpointId: "yard-end", toEndpointId: "lab-end", requestId: "req-1", controlEpoch: 2 });
    const queued = db.requestUse({ teleporterId: "t1", robotId: "r2", fromEndpointId: "lab-end", toEndpointId: "yard-end", requestId: "req-2", controlEpoch: 1 });
    expect(first.state).toBe("reserved"); expect(queued.state).toBe("queued");
    expect(db.requestUse({ teleporterId: "t1", robotId: "r2", fromEndpointId: "lab-end", toEndpointId: "yard-end", requestId: "req-2", controlEpoch: 1 })).toMatchObject({ state: "queued", robotId: "r2" });
    expect(() => db.requestUse({ teleporterId: "t1", robotId: "other", fromEndpointId: "lab-end", toEndpointId: "yard-end", requestId: "req-2", controlEpoch: 1 })).toThrow("already belongs");
    expect(db.requestUse({ teleporterId: first.teleporterId, robotId: first.robotId, fromEndpointId: first.fromEndpointId, toEndpointId: first.toEndpointId, requestId: first.requestId, controlEpoch: first.controlEpoch })).toEqual(first);
    expect(() => db.delete("t1")).toThrow("in use");
    db.setState("t1", "clearing");
    expect(db.complete("t1", "r1", "req-1", undefined, new Set(["r9"])) ).toBeNull();
    expect(db.activeUse("t1")).toBeNull();
    expect(db.promoteNext("t1", new Set(["r2"]))?.robotId).toBe("r2");
    expect(db.activeUse("t1")?.state).toBe("reserved");
    db.close();
  });

  test("replays the same request but rejects a second request by the same robot", () => {
    const db = store(); db.upsert(definition());
    const first = db.requestUse({ teleporterId: "t1", robotId: "r1", fromEndpointId: "yard-end", toEndpointId: "lab-end", requestId: "same", controlEpoch: 1 });
    expect(db.requestUse({ teleporterId: "t1", robotId: "r1", fromEndpointId: "yard-end", toEndpointId: "lab-end", requestId: "same", controlEpoch: 1 })).toEqual(first);
    expect(() => db.requestUse({ teleporterId: "t1", robotId: "r1", fromEndpointId: "yard-end", toEndpointId: "lab-end", requestId: "new", controlEpoch: 1 })).toThrow("already has");
    db.cancelReserved("t1", "r1", "same");
    db.saveTransfer({ transferId: "tx", teleporterId: "t1", robotId: "r1", fromEndpointId: "yard-end", toEndpointId: "lab-end", phase: "clearing", sourceMapId: "yard", destinationMapId: "large_lab", sourceEpoch: 1, destinationEpoch: 2, reason: "" });
    expect(() => db.requestUse({ teleporterId: "t1", robotId: "r1", fromEndpointId: "yard-end", toEndpointId: "lab-end", requestId: "after-clearing", controlEpoch: 2 })).toThrow("active teleporter transfer");
    db.saveTransfer({ transferId: "tx", teleporterId: "t1", robotId: "r1", fromEndpointId: "yard-end", toEndpointId: "lab-end", phase: "completed", sourceMapId: "yard", destinationMapId: "large_lab", sourceEpoch: 1, destinationEpoch: 2, reason: "" });
    expect(db.requestUse({ teleporterId: "t1", robotId: "r1", fromEndpointId: "yard-end", toEndpointId: "lab-end", requestId: "after-complete", controlEpoch: 2 }).state).toBe("reserved");
    db.close();
  });

  test("rejects endpoint definitions for unknown runtime maps", () => {
    const db = store();
    expect(() => db.upsert({ ...definition(), endpoints: [{ ...definition().endpoints[0], mapId: "missing" }, definition().endpoints[1]] })).toThrow("unknown runtime map");
    db.close();
  });

  test("rejects out of bounds, endpoint-excluding, and occupied clearing geometry", () => {
    const db = store();
    expect(() => db.upsert({ ...definition(), endpoints: [{ ...definition().endpoints[0], position: { x: -100, y: 100 } }, definition().endpoints[1]] })).toThrow("outside map bounds");
    expect(() => db.upsert({ ...definition(), endpoints: [{ ...definition().endpoints[0], occupancyPolygon: [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }] }, definition().endpoints[1]] })).toThrow("must contain");
    expect(() => db.upsert({ ...definition(), endpoints: [{ ...definition().endpoints[0], clearingPoint: { x: 100, y: 100 } }, definition().endpoints[1]] })).toThrow("clearing point must be outside");
    db.close();
  });

  test("does not release an active reservation when a caller disappears", () => {
    const db = store(); db.upsert(definition());
    db.requestUse({ teleporterId: "t1", robotId: "r1", fromEndpointId: "yard-end", toEndpointId: "lab-end", requestId: "req-1", controlEpoch: 0 });
    expect(db.activeUse("t1")?.robotId).toBe("r1");
    expect(db.queue("t1")).toHaveLength(0);
    db.close();
  });

  test("blocks ordinary traffic when a robot body overlaps an endpoint", () => {
    const db = store(); db.upsert(definition());
    expect(db.endpointBlocked({ teleporterId: "t1", endpointId: "yard-end", robotPoses: [{ robotId: "r9", x: 100, y: 100, bodyPolygon: [{ x: 80, y: 80 }, { x: 120, y: 80 }, { x: 120, y: 120 }, { x: 80, y: 120 }] }] })).toMatchObject({ blocked: true, reason: "body_overlap", robotIds: ["r9"] });
    db.close();
  });

  test("keeps one global robot owner across map servers", () => {
    const path = `/tmp/teleporter-owner-${crypto.randomUUID()}.sqlite`; paths.push(path);
    const yard = new TeleporterStore(path); const lab = new TeleporterStore(path);
    expect(yard.claimRobotOwner({ robotId: "r1", mapId: "yard", controlEpoch: 4 })).toBe(true);
    expect(lab.claimRobotOwner({ robotId: "r1", mapId: "large_lab", controlEpoch: 4 })).toBe(false);
    expect(lab.claimRobotOwner({ robotId: "r1", mapId: "large_lab", controlEpoch: 5, expectedMapId: "yard", transferId: "tx-1" })).toBe(true);
    expect(yard.getRobotOwner("r1")?.mapId).toBe("large_lab");
    yard.close(); lab.close();
  });

  test("operator recovery aborts active, queued, and durable teleporter state", () => {
    const db = store(); db.upsert(definition());
    db.claimRobotOwner({ robotId: "r1", mapId: "yard", controlEpoch: 2, transferId: "tx" });
    db.requestUse({ teleporterId: "t1", robotId: "r1", fromEndpointId: "yard-end", toEndpointId: "lab-end", requestId: "active", controlEpoch: 2 });
    db.saveTransfer({ transferId: "tx", teleporterId: "t1", robotId: "r1", fromEndpointId: "yard-end", toEndpointId: "lab-end", phase: "clearing", sourceMapId: "yard", destinationMapId: "large_lab", sourceEpoch: 2, destinationEpoch: 3, reason: "" });
    db.requestUse({ teleporterId: "t1", robotId: "r2", fromEndpointId: "lab-end", toEndpointId: "yard-end", requestId: "queued", controlEpoch: 1 });
    const result = db.forceReleaseRobot("r1", 3);
    expect(result).toMatchObject({ uses: 1, queued: 0, transfers: 1, controlEpoch: 3 });
    expect(db.activeUse("t1")).toBeNull();
    expect(db.getTransfer("tx")).toMatchObject({ phase: "failed", reason: "operator_disabled" });
    expect(db.getRobotOwner("r1")).toMatchObject({ mapId: "yard", controlEpoch: 3, transferId: "tx" });
    expect(db.queue("t1").map(item => item.robotId)).toEqual(["r2"]);
    expect(db.forceReleaseRobot("r1", 3).controlEpoch).toBe(3);
    expect(db.getRobotOwner("r1")?.controlEpoch).toBe(3);
    db.saveTransfer({ ...db.getTransfer("tx")!, phase: "clearing" });
    expect(db.getTransfer("tx")?.phase).toBe("failed");
    db.clearRobotAdministrativeDisabled("r1", 4);
    db.forceReleaseRobot("r1", 3);
    expect(db.getRobotAdministrativeControl("r1")?.disabled).toBe(false);
    db.close();
  });

  test("administrative disabled marker survives reopening the shared ledger", () => {
    const path = `/tmp/teleporter-admin-${crypto.randomUUID()}.sqlite`; paths.push(path);
    const first = new TeleporterStore(path);
    first.setRobotAdministrativeDisabled("r1", 7, "operator_disabled");
    first.close();
    const second = new TeleporterStore(path);
    expect(second.getRobotAdministrativeControl("r1")).toMatchObject({ disabled: true, controlEpoch: 7, reason: "operator_disabled" });
    second.clearRobotAdministrativeDisabled("r1", 7);
    expect(second.getRobotAdministrativeControl("r1")?.disabled).toBe(false);
    second.close();
  });

  test("commits destination owner and transfer ledger atomically", () => {
    const db = store(); db.upsert(definition());
    db.claimRobotOwner({ robotId: "r1", mapId: "yard", controlEpoch: 0 });
    expect(db.commitTransfer({ transferId: "tx", teleporterId: "t1", robotId: "r1", fromEndpointId: "yard-end", toEndpointId: "lab-end", phase: "destination_loading", sourceMapId: "yard", destinationMapId: "large_lab", sourceEpoch: 0, destinationEpoch: 1, reason: "" }, { robotId: "r1", mapId: "large_lab", controlEpoch: 1, expectedMapId: "yard" })).toBe(true);
    expect(db.getRobotOwner("r1")?.mapId).toBe("large_lab"); expect(db.getTransfer("tx")?.destinationEpoch).toBe(1);
    db.close();
  });

  test("publishes a map heartbeat and rejects stale destination worlds", async () => {
    const db = store();
    expect(db.mapWorld("large_lab").fresh).toBe(false);
    db.publishMapWorld("large_lab", [{ robotId: "r1", x: 2, y: 3 }]);
    expect(db.mapWorld("large_lab").fresh).toBe(true);
    await Bun.sleep(5);
    expect(db.mapWorld("large_lab", 1).fresh).toBe(false);
    db.close();
  });
});
