import { afterEach, expect, spyOn, test } from "bun:test";
import * as protoLoader from "../server/node_modules/@grpc/proto-loader/build/src/index.js";
import { RobotController } from "../virtual-robot/src/controller.ts";
import { LocalPlanExecutor } from "../virtual-robot/src/traffic/LocalPlanExecutor.ts";
import { SemanticCapacityGate } from "../server/src/traffic/SemanticCapacityGate.ts";
import { robotViewFromPose } from "../server/src/traffic/index.ts";
import { clearSemanticZones } from "../shared/planner.ts";
import { setExtraBlocked } from "../shared/occupancy.ts";
import { zoneTouchesPoint } from "../shared/semanticNavigation.ts";
import type { SemanticSnapshot, ZoneResource } from "../shared/semantic.ts";

afterEach(() => { clearSemanticZones(); setExtraBlocked(null); });

const emptySnapshot = (zones: ZoneResource[]): SemanticSnapshot => ({ mapId: "yard", mapVersion: "1", zones, waypoints: [], chargers: [], obstacles: [], nodes: [], edges: [], stations: [], portals: [], rails: [] });
const rectangle = (kind: ZoneResource["kind"], x0: number, x1: number, extra = {}): ZoneResource => ({
  id: "safety", family: "scene", name: "safety", kind, theta: 0,
  polygon: [{ x: x0, y: 480 }, { x: x1, y: 480 }, { x: x1, y: 560 }, { x: x0, y: 560 }], ...extra,
});
const controllerAt = (x: number, zones: ZoneResource[]) => {
  const c = new RobotController({ x, y: 520, theta: 0 });
  c.attachTraffic(new LocalPlanExecutor({ sendLeaseRequest: () => {}, sendLeaseRelease: () => {}, sendTrafficBid: () => {}, sendEvasionReply: () => {} }));
  c.setSemanticSnapshot(emptySnapshot(zones));
  c.handleDrive({ command_id: "safety", kind: "move", x: 420, y: 520, theta: 0 });
  return c;
};

test("unknown gate authority cannot admit a robot, while unrelated denied zones do not freeze it", () => {
  const zone = rectangle("corridor", 300, 340, { capacity: 1 });
  const c = controllerAt(260, [zone]);
  for (let i = 0; i < 200; i++) (c as any).tick();
  expect(c.snapshot().x).toBeGreaterThan(260);
  expect(zoneTouchesPoint(zone, c.snapshot())).toBe(false);
  expect(c.snapshot().trafficStatus).toBe("hold");
});

test("expired gate heartbeat halts the current holder", () => {
  let now = 10_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const c = controllerAt(320, [rectangle("corridor", 300, 340)]);
    c.onTrafficZoneUpdate("semantic:safety", "PROCEED");
    (c as any).tick();
    expect(c.snapshot().x).toBeGreaterThan(320);
    const stoppedX = c.snapshot().x;
    now += 1500;
    for (let i = 0; i < 20; i++) (c as any).tick();
    expect(c.snapshot().x).toBe(stoppedX);
    expect(c.snapshot().trafficStatus).toBe("hold");
  } finally { clock.mockRestore(); }
});

test("speed zone limits actual controller translation to 0.1 m/s", () => {
  const c = controllerAt(260, [rectangle("speed_limit", 230, 450, { maximumSpeed: 0.1 })]);
  for (let i = 0; i < 20; i++) (c as any).tick();
  expect(c.snapshot().x - 260).toBeGreaterThan(1.5);
  expect(c.snapshot().x - 260).toBeLessThanOrEqual(2.01);
});

test("editing a forbidden zone over a robot stops translation until the exclusion is removed", () => {
  const c = controllerAt(260, []);
  (c as any).tick();
  const stoppedX = c.snapshot().x;
  c.setSemanticSnapshot(emptySnapshot([rectangle("forbidden", 250, 270)]));
  for (let i = 0; i < 20; i++) (c as any).tick();
  expect(c.snapshot().x).toBe(stoppedX);
  c.setSemanticSnapshot(emptySnapshot([]));
  for (let i = 0; i < 20; i++) (c as any).tick();
  expect(c.snapshot().x).toBeGreaterThan(stoppedX);
});

test("editor snapshot survives the actual protobuf wire contract", () => {
  const definition = protoLoader.loadSync(new URL("../proto/robot.proto", import.meta.url).pathname, { keepCase: true, oneofs: true });
  const service = definition["bgfms.RobotBridge"] as any;
  const json = JSON.stringify({ mapId: "yard", zones: [{ id: "gate", kind: "corridor", capacity: 1 }] });
  const bytes = service.Session.responseSerialize({ semantic_snapshot: { json } });
  const decoded = service.Session.responseDeserialize(bytes);
  expect(decoded.payload).toBe("semantic_snapshot");
  expect(decoded.semantic_snapshot.json).toBe(json);
});

test("server capacity grants drive a waiting robot through a zone after its occupant exits", () => {
  let now = 10_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const zone: ZoneResource = { id: "integration", family: "scene", kind: "corridor", name: "gate", theta: 0, capacity: 1,
    polygon: [{ x: 300, y: 480 }, { x: 340, y: 480 }, { x: 340, y: 560 }, { x: 300, y: 560 }] };
  const snapshot: SemanticSnapshot = { mapId: "yard", mapVersion: "1", zones: [zone], waypoints: [], chargers: [], obstacles: [], nodes: [], edges: [], stations: [], portals: [], rails: [] };
  const controller = new RobotController({ x: 260, y: 520, theta: 0 });
  controller.attachTraffic(new LocalPlanExecutor({ sendLeaseRequest: () => {}, sendLeaseRelease: () => {}, sendTrafficBid: () => {}, sendEvasionReply: () => {} }));
  controller.setSemanticSnapshot(snapshot);
  const gate = new SemanticCapacityGate();
  const tick = (occupantX: number) => {
    now += 50;
    const pose = controller.snapshot();
    const world = { nowMs: now, zones: [zone], robots: [
      robotViewFromPose("waiting", { ...pose, connected: true, path: controller.currentPath(), localPath: controller.currentLocalPlan() }),
      robotViewFromPose("occupant", { x: occupantX, y: 520, theta: 0, status: "idle", connected: true, path: [], localPath: [] }),
    ] };
    for (const action of gate.tick(world)) {
      if (action.kind === "zone_update" && action.robotId === "waiting") controller.onTrafficZoneUpdate(action.zoneId, action.state);
    }
    (controller as any).tick();
  };
  try {
    // Register physical occupancy before the contender asks for entry.
    tick(320);
    controller.handleDrive({ command_id: "integration", kind: "move", x: 380, y: 520, theta: 0 });
    for (let i = 0; i < 160; i++) {
      tick(320);
      expect(zoneTouchesPoint(zone, controller.snapshot())).toBe(false);
    }
    expect(controller.snapshot().x).toBeGreaterThan(260);
    expect(controller.snapshot().status).toBe("move");
    for (let i = 0; i < 500 && controller.snapshot().status !== "idle"; i++) tick(450);
    expect(controller.snapshot().x).toBeCloseTo(380, 0);
    expect(controller.snapshot().y).toBeCloseTo(520, 0);
    expect(controller.snapshot().status).toBe("idle");
  } finally { controller.stop(); clock.mockRestore(); }
});
