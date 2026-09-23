import { expect, test } from "bun:test";
import { GrpcClient } from "./grpcClient.ts";
import { RobotController } from "./controller.ts";

function fixture() {
  const controller = new RobotController({ x: 240, y: 520, theta: 0 });
  let applications = 0;
  const client = new GrpcClient({ robotId: "robot-1", getPose: () => controller.snapshot(), getPath: () => controller.currentPath(),
    getLocalPlan: () => controller.currentLocalPlan(), takePathDelta: () => null, onDrive: c => controller.handleDrive(c),
    onCancel: () => controller.handleCancel(), onPlaceQuery: () => ({ ok: true, reason: "" }), onObstacles: () => {},
    onMotionPause: c => { applications++; return controller.setOperatorPaused(c.paused); },
  });
  const internal = client as any, writes: any[] = [];
  Object.assign(internal, { sessionReady: true, snapshotReady: true, controlEnabled: true, sessionId: "current", controlEpoch: 8,
    liveStream: { writable: true, write: (message: any) => { writes.push(message); return true; } },
  });
  const request = (id: string, paused: boolean, extra: Record<string, unknown> = {}) => internal.handleServerMsg({ payload: "motion_pause", motion_pause: { request_id: id, paused, session_id: "current", control_epoch: 8, ...extra } });
  return { controller, client, internal, writes, request, applications: () => applications };
}

test("pause ACK follows application, duplicates apply once, stale sessions cannot mutate motion latch", () => {
  const f = fixture();
  f.request("pause", true);
  expect(f.controller.snapshot().operatorPaused).toBe(true);
  expect(f.writes.find(m => m.motion_pause_ack)?.motion_pause_ack).toMatchObject({ request_id: "pause", paused: true, applied: true, session_id: "current", control_epoch: 8 });
  expect(f.writes.find(m => m.pose)?.pose.operator_paused).toBe(true);
  f.request("pause", true);
  expect(f.applications()).toBe(1);
  f.request("old", false, { session_id: "old" });
  f.request("future", false, { control_epoch: 9 });
  expect(f.applications()).toBe(1);
  expect(f.controller.snapshot().operatorPaused).toBe(true);
  f.request("resume", false);
  expect(f.controller.snapshot().operatorPaused).toBe(false);
});

test("a logging failure cannot prevent an applied pause or its ACK", () => {
  const f = fixture();
  f.internal.recorder = { record() { throw new Error("disk recorder failed"); } };
  expect(() => f.request("pause", true)).not.toThrow();
  expect(f.controller.snapshot().operatorPaused).toBe(true);
  expect(f.writes.some(m => m.motion_pause_ack?.applied)).toBe(true);
});

test("robot structured planning events carry severity and command/session correlation without an operation", () => {
  const f = fixture(), events: any[] = [];
  f.internal.recorder = { record(event: any) { events.push(event); } };
  f.client.tracePlanning({ phase: "failed", reason: "worker_error", error: "worker unavailable", requestId: 17 });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ robotId: "robot-1", category: "planning", payload: { level: "error", sessionId: "current" } });
  expect(events[0].operationId).toBeUndefined();
});

test("a pause operation cannot steal correlation from the mission it preserves", () => {
  const f = fixture(), events: any[] = [];
  f.internal.recorder = { record(event: any) { events.push(event); } };
  f.internal.handleServerMsg({ payload: "drive", operation_id: "operation-drive", drive: { command_id: "mission", kind: "move", x: 420, y: 520, theta: 0, session_id: "current", control_epoch: 8 } });
  f.internal.handleServerMsg({ payload: "motion_pause", operation_id: "operation-pause", motion_pause: { request_id: "pause", paused: true, session_id: "current", control_epoch: 8 } });
  expect(events.find(e => e.kind === "motion_pause.applied").operationId).toBe("operation-pause");
  f.client.tracePlanning({ phase: "completed", requestId: 18 });
  expect(events.at(-1)).toMatchObject({ operationId: "operation-drive", commandId: "mission" });
  f.client.sendCommandState({ command_id: "mission", state: "running", reason: "" });
  expect(events.findLast(e => e.commandId === "mission" && e.category === "operation").operationId).toBe("operation-drive");
});
