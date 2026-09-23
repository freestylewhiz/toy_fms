import { expect, test } from "bun:test";
import { OperationTrace, currentOperationId, commandOperationId } from "./blackboxIntegration.ts";
import type { BlackboxRecorder, BlackboxEventInput } from "../../shared/blackbox.ts";

function fixture(resolveContext?: (kind: string, payload: any) => Record<string, unknown>) {
  const events: BlackboxEventInput[] = [];
  const recorder: BlackboxRecorder = { record: input => { events.push(input); return undefined; }, frame: () => {}, flush: async () => {}, close: async () => {} };
  const replies: any[] = [];
  const client = { sessionId: "operator", send: (type: string, payload: any) => replies.push({ type, payload }) };
  return { events, replies, client, trace: new OperationTrace(recorder, () => {}, resolveContext) };
}

test("operation IDs cover rejected requests, async responses and idempotent client retries", async () => {
  const f = fixture(); let calls = 0; let id: string | undefined;
  const handler = async (client: any) => { calls++; id = currentOperationId(); await Promise.resolve(); client.send("error", { message: "not free" }); };
  await f.trace.run(f.client, "commandRobot", { robotId: "robot-1", clientRequestId: "request-1" }, handler);
  await f.trace.run(f.client, "commandRobot", { robotId: "robot-1", clientRequestId: "request-1" }, handler);
  expect(calls).toBe(1); expect(id).toBeTruthy();
  expect(f.events.filter(e => e.category === "error")).toHaveLength(1);
  expect(f.events[0].kind).toBe("commandRobot.requested");
  expect(f.events.every(e => e.operationId === id)).toBe(true);
  expect(f.replies[0].payload.operationId).toBe(id);
  expect(f.replies[1]).toEqual(f.replies[0]);
  expect(commandOperationId(`${id}:entry`)).toBe(id);
});

test("protocol traces retain direction/envelope and link transfer child command to operation", () => {
  const f = fixture(); const id = crypto.randomUUID();
  f.trace.protocol("send", "robot-2", { drive: { command_id: `${id}:entry`, control_epoch: 3, session_id: "session" } });
  expect(f.events[0].operationId).toBe(id);
  expect(f.events[0].payload.direction).toBe("send");
  expect(f.events[0].commandId).toBe(`${id}:entry`);
});

test("event descriptions snapshot the resource name before edits and retain it across async replies", async () => {
  const target = { id: "wp-1", kind: "waypoint", name: "포장 출구", mapId: "yard" };
  const f = fixture(() => ({ commandKind: "move", target }));
  await f.trace.run(f.client, "commandRobot", { robotId: "robot-1", targetId: target.id }, async client => {
    target.name = "변경된 이름";
    await Promise.resolve();
    client.send("commandAck", { ok: true });
  });
  expect(f.events).toHaveLength(2);
  for (const event of f.events) expect((event.payload.target as any).name).toBe("포장 출구");
});

test("drive context follows command state events after the request scope exits", () => {
  const f = fixture();
  const target = { id: "wp-1", kind: "waypoint", name: "포장 출구", mapId: "yard" };
  f.trace.protocol("send", "robot-1", { drive: { command_id: "c1", kind: "move", x: 0, y: 2, theta: 0,
    event_context_json: JSON.stringify({ target }) } });
  f.trace.event("operation", "robot.state_changed", { robotId: "robot-1", commandId: "c1", payload: { after: { commandState: "completed" } } });
  expect(f.events[1].payload).toMatchObject({ target, commandKind: "move", x: 0, y: 2, theta: 0 });
  f.trace.event("operation", "robot.state_changed", { robotId: "robot-2", commandId: "c2", payload: {} });
  expect(f.events[2].payload.target).toBeUndefined();
});
