import { afterEach, expect, test, spyOn } from "bun:test";
import { RobotController } from "./controller.ts";
import { LocalPlanExecutor } from "./traffic/LocalPlanExecutor.ts";
import { clearSemanticZones } from "../../shared/planner.ts";

const traffic = () => new LocalPlanExecutor({ sendLeaseRequest: () => {}, sendLeaseRelease: () => {} });
afterEach(() => clearSemanticZones());

test("cancel preserves idle state and drops the mission", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.attachTraffic(traffic());
  c.handleDrive({ command_id: "a", kind: "move", x: 280, y: 520, theta: 0 });
  c.handleCancel();
  expect(c.snapshot().status).toBe("idle");
  expect(c.currentPath()).toEqual([]);
});

test("disconnect holds an active mission until a fresh snapshot arrives", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.attachTraffic(traffic());
  c.handleDrive({ command_id: "a", kind: "move", x: 280, y: 520, theta: 0 });
  c.setConnectionReady(false);
  (c as any).tick();
  expect(c.snapshot().motion).toBe("HOLD");
  c.setConnectionReady(true);
  (c as any).tick();
  expect(c.snapshot().motion).toBe("HOLD");
});

test("a relevant capacity zone with no permission fails closed", () => {
  const c = new RobotController({ x: 260, y: 520, theta: 0 });
  c.setSemanticSnapshot({ zones: [{ id: "g", family: "scene", kind: "corridor", name: "", polygon: [{ x: 300, y: 480 }, { x: 340, y: 480 }, { x: 340, y: 560 }, { x: 300, y: 560 }], theta: 0, capacity: 1 }], obstacles: [] });
  c.handleDrive({ command_id: "g", kind: "move", x: 380, y: 520, theta: 0 });
  for (let i = 0; i < 100; i++) (c as any).tick();
  expect(c.snapshot().x).toBeLessThan(300);
  expect(c.snapshot().trafficStatus).toBe("hold");
});

test("live forbidden update holds the mission and removal resumes it", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.handleDrive({ command_id: "f", kind: "move", x: 280, y: 520, theta: 0 });
  c.setSemanticSnapshot({ zones: [{ id: "f", family: "scene", kind: "forbidden", name: "", polygon: [{ x: 220, y: 500 }, { x: 270, y: 500 }, { x: 270, y: 540 }, { x: 220, y: 540 }], theta: 0 }], obstacles: [] });
  expect(c.snapshot().motion).toBe("HOLD");
  c.setSemanticSnapshot({ zones: [], obstacles: [] });
  expect(c.snapshot().motion).toBe("FOLLOW");
});

test("invalid replacement cancels the active mission and reports the new rejection", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.handleDrive({ command_id: "active", kind: "move", x: 420, y: 520, theta: 0 });
  c.handleDrive({ command_id: "bad", kind: "move", x: Number.NaN, y: 520, theta: 0 });
  expect(c.snapshot().commandId).toBe("bad");
  expect(c.snapshot().commandState).toBe("rejected");
  expect(c.snapshot().motion).toBe("IDLE");
});

test("control generation cancels a mission, while duplicate state is idempotent", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.handleDrive({ command_id: "active", kind: "move", x: 420, y: 520, theta: 0 });
  c.setControlState({ enabled: true, controlEpoch: 2, sessionId: "new-session" });
  expect(c.snapshot().status).toBe("idle");
  expect(c.snapshot().commandState).toBe("cancelled");
  c.setControlState({ enabled: true, controlEpoch: 2, sessionId: "new-session" });
  expect(c.snapshot().status).toBe("idle");
});

test("disabled control ignores motion and traffic grants while telemetry remains physical", () => {
  let requests = 0;
  const t = new LocalPlanExecutor({ sendLeaseRequest: () => requests++, sendLeaseRelease: () => {} });
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.attachTraffic(t);
  c.setControlState({ enabled: false, controlEpoch: 1, sessionId: "s" });
  c.handleDrive({ command_id: "blocked", kind: "move", x: 420, y: 520, theta: 0 });
  c.onTrafficGrant({ requestId: "r", leaseId: "l", signal: "PROCEED", held: { segments: [] }, leaseDurationMs: 1000, zoneId: "z", reason: "" });
  for (let i = 0; i < 20; i++) (c as any).tick();
  expect(c.snapshot().x).toBe(240);
  expect(c.snapshot().workState).toBe("idle");
  expect(requests).toBe(0);
});

test("rotation reports moving consistently across repeated snapshots", () => {
  const c = new RobotController({ x: 240, y: 520, theta: 0 });
  c.handleDrive({ command_id: "turn", kind: "move", x: 240, y: 520, theta: Math.PI / 2 });
  (c as any).tick();
  const a = c.snapshot();
  const b = c.snapshot();
  expect(a.driveState).toBe("moving");
  expect(b.driveState).toBe("moving");
});

test("semantic permission context names its zone and keeps a stable since time", () => {
  const c = new RobotController({ x: 320, y: 520, theta: 0 });
  c.setSemanticSnapshot({ zones: [{ id: "gate", family: "scene", kind: "corridor", name: "", polygon: [{ x: 300, y: 480 }, { x: 340, y: 480 }, { x: 340, y: 560 }, { x: 300, y: 560 }], theta: 0, capacity: 1 }], obstacles: [] });
  c.handleDrive({ command_id: "wait", kind: "move", x: 380, y: 520, theta: 0 });
  c.onTrafficZoneUpdate("semantic:gate", "STOP");
  const first = JSON.parse(c.snapshot().driveContextJson!)[0];
  const second = JSON.parse(c.snapshot().driveContextJson!)[0];
  expect(first.target).toEqual({ mapId: "yard", kind: "zone", id: "gate" });
  expect(first.permissionState).toBe("pending");
  expect(second.since).toBe(first.since);
});
