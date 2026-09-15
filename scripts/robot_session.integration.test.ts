import { EventEmitter } from "node:events";
import { expect, spyOn, test } from "bun:test";
import { GrpcClient } from "../virtual-robot/src/grpcClient.ts";
import { PROTOCOL_VERSION, SESSION_TIMEOUT_MS } from "../shared/robotProtocol.ts";

test("robot session requires both handshake and map, publishes initial state, and stops on missing heartbeat", async () => {
  let now = 10_000;
  let scheduled: (() => void) | null = null;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) => { scheduled = fn; return 123456; }) as any);
  const clears = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  const readiness: boolean[] = [];
  const drives: string[] = [];
  const output: any[] = [];
  class Stream extends EventEmitter {
    writable = true;
    write(message: any) { output.push(message); return true; }
    cancel() { this.writable = false; this.emit("close"); }
  }
  const stream = new Stream();
  const client = new GrpcClient({
    robotId: "robot-1",
    getPose: () => ({ x: 240, y: 520, theta: 0, status: "idle", motion: "IDLE", leaseId: "", avoidanceMode: true, headRoomPx: 0, trafficStatus: "clear", commandId: "last", commandState: "completed", commandReason: "" }),
    getPath: () => [], takePathDelta: () => null, getLocalPlan: () => [], onDrive: cmd => drives.push(cmd.command_id), onCancel: () => {},
    onPlaceQuery: () => ({ ok: true, reason: "" }), onObstacles: () => {}, onSemanticSnapshot: () => {}, onConnectionState: ready => readiness.push(ready),
  });
  (client as any).stub = { Session: () => stream };
  const done = (client as any).runSession().then(() => null, (error: Error) => error);
  try {
    expect(output[0].register.protocol_version).toBe(PROTOCOL_VERSION);
    expect(output.some(m => m.pose?.command_id === "last" && m.pose.command_state === "completed")).toBe(true);
    expect(output.some(m => m.path)).toBe(true);
    expect(output.some(m => m.local_plan)).toBe(true);
    const drive = { payload: "drive", drive: { command_id: "go", kind: "move", x: 260, y: 520, theta: 0, session_id: "s1", control_epoch: 1 } };
    stream.emit("data", drive);
    expect(drives).toEqual([]);
    stream.emit("data", { payload: "session_ready", session_ready: { robot_id: "robot-2", protocol_version: PROTOCOL_VERSION } });
    stream.emit("data", drive);
    expect(drives).toEqual([]);
    stream.emit("data", { payload: "session_ready", session_ready: { robot_id: "robot-1", protocol_version: PROTOCOL_VERSION, session_id: "s1", control_epoch: 1, enabled: true } });
    stream.emit("data", { payload: "control_state", control_state: { session_id: "s1", control_epoch: 1, enabled: true } });
    stream.emit("data", drive);
    expect(drives).toEqual([]);
    stream.emit("data", { payload: "semantic_snapshot", semantic_snapshot: { json: JSON.stringify({ zones: [], obstacles: [] }) } });
    expect(readiness.at(-1)).toBe(true);
    stream.emit("data", drive);
    expect(drives).toEqual(["go"]);
    now += SESSION_TIMEOUT_MS - 100;
    stream.emit("data", { payload: "heartbeat", heartbeat: { server_time_ms: now } });
    scheduled!();
    expect(stream.writable).toBe(true);
    now += SESSION_TIMEOUT_MS + 1;
    scheduled!();
    expect(stream.writable).toBe(false);
    expect(readiness.at(-1)).toBe(false);
    expect((await done)?.message).toContain("heartbeat timeout");
  } finally {
    stream.cancel(); await done;
    interval.mockRestore(); clears.mockRestore(); clock.mockRestore();
  }
});
