import { describe, expect, test } from "bun:test";
import { SemanticCapacityGate } from "./SemanticCapacityGate.ts";
import type { TrafficWorldSnapshot } from "./TrafficPolicy.ts";
import { RuntimeStore } from "../runtimeStore.ts";

const zone = { id: "drive", family: "vda" as const, kind: "corridor" as const, name: "drive", polygon: [{ x: 40, y: -10 }, { x: 60, y: -10 }, { x: 60, y: 10 }, { x: 40, y: 10 }], theta: 0, capacity: 1 };
function world(robots: TrafficWorldSnapshot["robots"]): TrafficWorldSnapshot { return { nowMs: 0, robots, zones: [zone] }; }
function robot(robotId: string, x: number, connected = true) { return { robotId, x, y: 0, theta: 0, status: "move", motion: "", avoidanceMode: true, headRoomPx: 0, trafficStatus: "clear" as const, path: [{ x, y: 0 }, { x: 50, y: 0 }], localPath: [{ x, y: 0 }, { x: 50, y: 0 }], planId: "", connected }; }

describe("SemanticCapacityGate", () => {
  test("persisted reservation changes to physical occupancy once; unchanged ticks do not write DB", () => {
    const store = new RuntimeStore(":memory:");
    try {
      const gate = new SemanticCapacityGate(store);
      gate.tick({ ...world([{ ...robot("r1", 0), controlEpoch: 7 }]), nowMs: 1000 });
      const reserved = store.listOccupancies()[0];
      expect(reserved.state).toBe("reserved");
      expect(reserved.controlEpoch).toBe(7);
      gate.tick({ ...world([{ ...robot("r1", 50), controlEpoch: 7 }]), nowMs: 2000 });
      expect(store.listOccupancies()[0]).toMatchObject({ state: "occupied", createdAt: 1000, updatedAt: 2000 });
      const changes = () => (store.db.query("SELECT total_changes() AS n").get() as {n:number}).n;
      const before = changes();
      gate.tick({ ...world([{ ...robot("r1", 50), controlEpoch: 7 }]), nowMs: 3000 });
      expect(changes()).toBe(before);
    } finally { store.close(); }
  });

  test("a seed-only pose cannot acquire physical occupancy and an unready robot receives no grant", () => {
    const gate = new SemanticCapacityGate();
    const actions = gate.tick(world([{ ...robot("r1", 50), poseObserved: false, controlReady: false }]));
    expect(gate.snapshot()).toHaveLength(0);
    expect(actions).toHaveLength(0);
  });
  test("FIFO grants one and stops the contender, then releases after path clears", () => {
    const gate = new SemanticCapacityGate();
    const first = gate.tick(world([robot("r1", 0), robot("r2", 0)]));
    expect(first.filter((a) => a.kind === "zone_update" && a.state === "PROCEED").map((a) => a.robotId)).toEqual(["r1"]);
    expect(first.some((a) => a.kind === "zone_update" && a.robotId === "r2" && a.state === "STOP")).toBe(true);
    const cleared = robot("r1", 100);
    cleared.path = [];
    cleared.localPath = [];
    const released = gate.tick(world([cleared, robot("r2", 0)]));
    expect(released.some((a) => a.kind === "zone_update" && a.robotId === "r2" && a.state === "PROCEED")).toBe(true);
  });

  test("offline holder remains reserved", () => {
    const gate = new SemanticCapacityGate();
    gate.tick(world([robot("r1", 50), robot("r2", 0)]));
    const actions = gate.tick(world([robot("r1", 50, false), robot("r2", 0)]));
    expect(actions.some((a) => a.kind === "zone_update" && a.robotId === "r2" && a.state === "PROCEED")).toBe(false);
  });

  test("emits a PROCEED heartbeat for an existing holder", () => {
    const gate = new SemanticCapacityGate();
    gate.tick(world([robot("r1", 50)]));
    const heartbeat = gate.tick(world([robot("r1", 50)]));
    expect(heartbeat).toContainEqual({ kind: "zone_update", robotId: "r1", zoneId: "semantic:drive", state: "PROCEED" });
  });

  test("offline occupant on the first observation blocks an entrant", () => {
    const gate = new SemanticCapacityGate();
    const actions = gate.tick(world([robot("offline", 50, false), robot("r2", 0)]));
    expect(actions).toContainEqual({ kind: "zone_update", robotId: "r2", zoneId: "semantic:drive", state: "STOP" });
    expect(actions.some((a) => a.kind === "zone_update" && a.state === "PROCEED" && a.robotId === "r2")).toBe(false);
  });

  test("revokes a holder whose goal no longer enters the zone", () => {
    const gate = new SemanticCapacityGate();
    gate.tick(world([robot("r1", 0)]));
    const cleared = robot("r1", 0);
    cleared.path = [];
    cleared.localPath = [];
    const actions = gate.tick(world([cleared]));
    expect(actions).toContainEqual({ kind: "zone_update", robotId: "r1", zoneId: "semantic:drive", state: "STOP" });
  });

  test("restores queued and reserved records with stable timestamps", () => {
    const path = `/tmp/gate-${crypto.randomUUID()}.sqlite`, store = new RuntimeStore(path);
    const first = new SemanticCapacityGate(store);
    first.tick(world([robot("r1", 50), robot("r2", 0)]));
    const before = store.listOccupancies();
    expect(before.map((x) => [x.robotId, x.state])).toEqual([["r1", "occupied"], ["r2", "queued"]]);
    const created = new Map(before.map((x) => [x.robotId, x.createdAt]));
    store.close();
    const restarted = new RuntimeStore(path), second = new SemanticCapacityGate(restarted);
    second.tick(world([robot("r1", 50, false), robot("r2", 0)]));
    expect(restarted.listOccupancies().map((x) => x.robotId)).toEqual(["r1", "r2"]);
    expect(restarted.listOccupancies().every((x) => x.createdAt === created.get(x.robotId))).toBe(true);
    restarted.close();
  });

  test("disabled robot cannot acquire a new reservation but keeps an existing hold", () => {
    const gate = new SemanticCapacityGate();
    gate.tick(world([robot("r1", 50), robot("r2", 0)]));
    const held = { ...robot("r1", 50), fmsControlState: "disabled" as const, controlEpoch: 4 };
    const actions = gate.tick(world([held, robot("r2", 0)]));
    expect(actions.some((a) => a.kind === "zone_update" && a.robotId === "r2" && a.state === "PROCEED")).toBe(false);
    expect(gate.snapshot()[0]).toMatchObject({ robotId: "r1", state: "occupied", controlEpoch: 4 });
    gate.release("r1", "drive");
    expect(gate.snapshot().map((x) => [x.robotId, x.state])).toEqual([["r2", "queued"]]);
  });
});
