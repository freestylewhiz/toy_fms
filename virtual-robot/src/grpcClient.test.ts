import { expect, spyOn, test } from "bun:test";
import { GrpcClient } from "./grpcClient.ts";

const snapshot = () => ({
  x: 240, y: 520, theta: 0,
  status: "idle" as const, motion: "IDLE", leaseId: "", avoidanceMode: true,
  headRoomPx: Infinity, trafficStatus: "clear", commandId: "", commandState: "idle", commandReason: "",
});

test("pose override accepts the disabled current epoch and reports fresh telemetry", () => {
  let override: unknown = null;
  const client = new GrpcClient({
    robotId: "robot-1",
    getPose: snapshot,
    getPath: () => [],
    takePathDelta: () => null,
    onDrive: () => {},
    onCancel: () => {},
    onPoseOverride: (command) => { override = command; return true; },
    onPlaceQuery: () => ({ ok: true, reason: "" }),
    onObstacles: () => {},
  });
  const internal = client as any;
  internal.sessionReady = true;
  internal.snapshotReady = true;
  internal.sessionId = "session-1";
  internal.controlEpoch = 9;
  internal.controlEnabled = false;
  const telemetry = spyOn(internal, "sendInitialTelemetry").mockImplementation(() => {});

  internal.handleServerMsg({
    payload: "pose_override",
    pose_override: { request_id: "override-1", x: 320, y: 520, theta: Math.PI / 2, control_epoch: 9, session_id: "session-1" },
  });

  expect(override).toEqual({ requestId: "override-1", x: 320, y: 520, theta: Math.PI / 2 });
  expect(telemetry).toHaveBeenCalledTimes(1);
});

test("pose override rejects a stale envelope without changing pose state", () => {
  const onOverride = spyOn({ run: () => true }, "run");
  const client = new GrpcClient({
    robotId: "robot-1",
    getPose: snapshot,
    getPath: () => [],
    takePathDelta: () => null,
    onDrive: () => {},
    onCancel: () => {},
    onPoseOverride: onOverride,
    onPlaceQuery: () => ({ ok: true, reason: "" }),
    onObstacles: () => {},
  });
  const internal = client as any;
  internal.sessionReady = true;
  internal.snapshotReady = true;
  internal.sessionId = "session-1";
  internal.controlEpoch = 9;
  const telemetry = spyOn(internal, "sendInitialTelemetry").mockImplementation(() => {});

  internal.handleServerMsg({
    payload: "pose_override",
    pose_override: { request_id: "stale", x: 320, y: 520, theta: 0, control_epoch: 8, session_id: "session-1" },
  });
  internal.handleServerMsg({
    payload: "pose_override",
    pose_override: { request_id: "wrong-session", x: 320, y: 520, theta: 0, control_epoch: 9, session_id: "other" },
  });

  expect(onOverride).not.toHaveBeenCalled();
  expect(telemetry).not.toHaveBeenCalled();
});

test("local override rejection sends an idempotent negative request ACK and no confirming telemetry", () => {
  let calls = 0;
  const client = new GrpcClient({
    robotId: "robot-1", getPose: snapshot, getPath: () => [], takePathDelta: () => null,
    onDrive: () => {}, onCancel: () => {}, onPlaceQuery: () => ({ ok: true, reason: "" }), onObstacles: () => {},
    onPoseOverride: () => { calls += 1; return false; },
  });
  const internal = client as any;
  Object.assign(internal, { sessionReady: true, snapshotReady: true, sessionId: "session-1", controlEpoch: 9, controlEnabled: false });
  const sent: any[] = [];
  spyOn(internal, "writePayload").mockImplementation((value: any) => { sent.push(value); });
  const telemetry = spyOn(internal, "sendInitialTelemetry").mockImplementation(() => {});
  const message = { payload: "pose_override", pose_override: { request_id: "rejected", x: 240, y: 520, theta: 0, control_epoch: 9, session_id: "session-1" } };
  internal.handleServerMsg(message);
  internal.handleServerMsg(message);
  expect(calls).toBe(1);
  expect(sent).toHaveLength(2);
  expect(sent[0].pose_override_ack).toMatchObject({ robot_id: "robot-1", request_id: "rejected", applied: false, reason_code: "local_pose_infeasible", control_epoch: 9, session_id: "session-1" });
  expect(sent[1]).toEqual(sent[0]);
  expect(telemetry).not.toHaveBeenCalled();
});

test("traffic STOP status is envelope guarded and checks carry the current token", () => {
  const statuses: any[] = [];
  const client = new GrpcClient({
    robotId: "robot-1", getPose: snapshot, getPath: () => [], takePathDelta: () => null,
    onDrive: () => {}, onCancel: () => {}, onPlaceQuery: () => ({ ok: true, reason: "" }), onObstacles: () => {},
    onTrafficStopStatus: (status) => statuses.push(status),
  });
  const internal = client as any;
  Object.assign(internal, { sessionReady: true, snapshotReady: true, sessionId: "session-1", controlEpoch: 4, controlEnabled: true });
  const sent: any[] = [];
  spyOn(internal, "writePayload").mockImplementation((value: any) => sent.push(value));
  internal.handleServerMsg({ payload: "traffic_stop_status", traffic_stop_status: { stop_id: "s", stop_generation: "2", decision: "RESUME", control_epoch: 3, session_id: "session-1" } });
  internal.handleServerMsg({ payload: "traffic_stop_status", traffic_stop_status: { stop_id: "s", stop_generation: "2", decision: "RESUME", control_epoch: 4, session_id: "session-1" } });
  client.sendTrafficStopCheck({ stop_id: "s", stop_generation: "2" });
  expect(statuses).toHaveLength(1);
  expect(sent).toEqual([{ traffic_stop_check: { robot_id: "robot-1", stop_id: "s", stop_generation: "2", control_epoch: 4, session_id: "session-1" } }]);
});

test("drive target context enriches command and planner events without changing the motion command", () => {
  let received: unknown;
  const client = new GrpcClient({
    robotId: "robot-1", getPose: snapshot, getPath: () => [], takePathDelta: () => null,
    onDrive: (command) => { received = command; }, onCancel: () => {},
    onPlaceQuery: () => ({ ok: true, reason: "" }), onObstacles: () => {},
  });
  const internal = client as any;
  Object.assign(internal, { sessionReady: true, snapshotReady: true, sessionId: "session-1", controlEpoch: 4, controlEnabled: true });
  const events: any[] = [];
  internal.recordEvent = (event: any) => events.push(event);
  const context = { commandKind: "move", x: 0, y: 2, theta: 0.9, target: { id: "wp-1", kind: "waypoint", name: "입구", mapId: "yard" } };
  internal.handleServerMsg({
    payload: "drive", operation_id: "op-1",
    drive: { command_id: "op-1:move:complete-id-1234567890", kind: "move", x: 0, y: 2, theta: 0.9, event_context_json: JSON.stringify(context), control_epoch: 4, session_id: "session-1" },
  });
  client.tracePlanning({ phase: "requested" });
  client.sendCommandState({ command_id: "op-1:move:complete-id-1234567890", state: "completed", reason: "" });
  expect(received).toEqual({ command_id: "op-1:move:complete-id-1234567890", kind: "move", x: 0, y: 2, theta: 0.9 });
  expect(events[0].kind).toBe("command.receive");
  expect(events[0].payload).toMatchObject({ x: 0, y: 2, eventContext: context });
  expect(events[1].payload.eventContext).toEqual(context);
  expect(events[2].kind).toBe("command.complete");
  expect(events[2].payload.eventContext).toEqual(context);
  expect(internal.commandContexts.has("op-1:move:complete-id-1234567890")).toBe(true);
});

test("recognized navigation diagnostics keep their kind, payload, and active command correlation", () => {
  const client = new GrpcClient({
    robotId: "robot-2", getPose: snapshot, getPath: () => [], takePathDelta: () => null,
    onDrive: () => {}, onCancel: () => {}, onPlaceQuery: () => ({ ok: true, reason: "" }), onObstacles: () => {},
  });
  const internal = client as any;
  Object.assign(internal, { activeCommandId: "command-full-id", activeCommandOperationId: "operation-1" });
  internal.commandOperations.set("command-full-id", "operation-1");
  const events: any[] = [];
  internal.recordEvent = (event: any) => events.push(event);

  client.tracePlanning({
    kind: "navigation.detour_rejected", phase: "failed", level: "warn", commandId: "command-full-id",
    reason: "detour-too-long", baselineLengthM: 10, candidateLengthM: 28, allowedLengthM: 13,
    fallback: "step-back-request", stepBackDistanceM: 0.5, stepBackWaitMs: 5_000,
  });

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    category: "planning", kind: "navigation.detour_rejected", robotId: "robot-2",
    operationId: "operation-1", commandId: "command-full-id",
    payload: { reason: "detour-too-long", baselineLengthM: 10, candidateLengthM: 28, allowedLengthM: 13, fallback: "step-back-request", stepBackDistanceM: 0.5, stepBackWaitMs: 5_000, level: "warn" },
  });
});
