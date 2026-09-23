import { describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { RuntimeStore, type RobotRuntime } from "./runtimeStore.ts";
import { Database } from "bun:sqlite";

function robot(id = "r1"): RobotRuntime {
  return { robotId: id, x: 1, y: 2, theta: 0, workState: "idle", fmsControlState: "enabled" as const, connectionState: "offline" as const, connectionReason: "", driveState: "unknown", driveContextJson: "[]", controlEpoch: 0, controlReady: false, reportedAt: 0, stateChangedAt: 0, sessionId: "", navigationMode: "unknown", pathPlanningAuthority: "unknown" };
}

test("runtime records survive restart and release exactly one selected hold atomically", () => {
  const path = `/tmp/runtime-store-${crypto.randomUUID()}.sqlite`;
  const first = new RuntimeStore(path);
  first.upsertRobot(robot());
  first.upsertOccupancy({ resourceRef: { mapId: "yard", kind: "zone", id: "z1" }, robotId: "r1", state: "occupied", requestId: "a", controlEpoch: 0, createdAt: 10, updatedAt: 10 });
  first.upsertOccupancy({ resourceRef: { mapId: "yard", kind: "zone", id: "z2" }, robotId: "r1", state: "reserved", requestId: "b", controlEpoch: 0, createdAt: 11, updatedAt: 11 });
  first.close();
  const second = new RuntimeStore(path);
  expect(second.listOccupancies().map((x) => x.resourceRef.id)).toEqual(["z1", "z2"]);
  expect(second.releaseResourceAndDisable({ resourceKind: "zone", resourceId: "z1", robotId: "r1", expectedEpoch: 0, releasedBy: "session" }).ok).toBe(true);
  expect(second.listOccupancies().map((x) => x.resourceRef.id)).toEqual(["z2"]);
  expect(second.getRobot("r1")?.fmsControlState).toBe("disabled");
  expect(second.getRobot("r1")?.controlEpoch).toBe(1);
  second.close();
  unlinkSync(path); try { unlinkSync(`${path}-wal`); } catch { /* optional */ } try { unlinkSync(`${path}-shm`); } catch { /* optional */ }
});

test("existing pre-runtime database receives additive migrations", () => {
  const path = `/tmp/runtime-old-${crypto.randomUUID()}.sqlite`;
  const db = new Database(path);
  db.exec("CREATE TABLE robot_runtime (robot_id TEXT PRIMARY KEY, work_state TEXT NOT NULL DEFAULT 'unknown')");
  db.exec("CREATE TABLE runtime_occupancies (resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, robot_id TEXT NOT NULL, state TEXT NOT NULL, request_id TEXT NOT NULL DEFAULT '', control_epoch INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, released_at INTEGER, release_reason TEXT, released_by TEXT, PRIMARY KEY(resource_kind,resource_id,robot_id))");
  db.close();
  const store = new RuntimeStore(path);
  store.ensureRobot("legacy");
  expect(store.getRobot("legacy")?.controlEpoch).toBe(0);
  store.close();
  unlinkSync(path); try { unlinkSync(`${path}-wal`); } catch { /* optional */ } try { unlinkSync(`${path}-shm`); } catch { /* optional */ }
});

test("operator disable releases every logical claim and advances the epoch", () => {
  const path = `/tmp/runtime-force-${crypto.randomUUID()}.sqlite`;
  const store = new RuntimeStore(path);
  store.upsertRobot(robot());
  store.upsertOccupancy({ resourceRef: { mapId: "yard", kind: "zone", id: "z1" }, robotId: "r1", state: "occupied", requestId: "a", controlEpoch: 0, createdAt: 1, updatedAt: 1 });
  store.upsertOccupancy({ resourceRef: { mapId: "yard", kind: "edge", id: "e1" }, robotId: "r1", state: "queued", requestId: "b", controlEpoch: 0, createdAt: 2, updatedAt: 2 });
  const result = store.disableAndReleaseAll({ robotId: "r1", expectedEpoch: 0, releasedBy: "operator" });
  expect(result.ok).toBe(true);
  expect(result.released).toHaveLength(2);
  expect(store.listOccupancies()).toHaveLength(0);
  expect(store.getRobot("r1")).toMatchObject({ fmsControlState: "disabled", controlReady: false, controlEpoch: 1 });
  expect(store.listOccupancies(true).every(item => item.releaseReason === "operator_disabled")).toBe(true);
  store.close();
  unlinkSync(path); try { unlinkSync(`${path}-wal`); } catch {} try { unlinkSync(`${path}-shm`); } catch {}
});
