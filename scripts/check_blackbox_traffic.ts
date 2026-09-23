/** Isolated end-to-end regression. Never connects to production ports/data. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { Client } from "../web-client/node_modules/colyseus.js/build/esm/index.mjs";

const root = mkdtempSync(join(tmpdir(), "fms-blackbox-traffic-"));
const offset = Number(process.env.E2E_PORT_OFFSET || 9200);
assert(Number.isInteger(offset) && offset >= 1000 && offset < 15000, "isolated port offset required");
const env = { ...process.env, FMS_MAP_ID: "large_lab", FMS_PORT_OFFSET: String(offset), FMS_DATA_ROOT: root,
  TELEPORTER_SQLITE_PATH: join(root, "teleporters.sqlite"), FMS_BLACKBOX: "1", FMS_WEB_PUBLIC_DIR: join(root, "public") };
const children: Bun.Subprocess[] = [];
let room: any;
function spawn(name: string, file: string, args: string[] = []) {
  const child = Bun.spawn(["bun", file, ...args], { env, stdout: Bun.file(join(root, `${name}.log`)), stderr: Bun.file(join(root, `${name}.err`)) });
  children.push(child); return child;
}
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await Bun.sleep(50); }
  throw Error(`Timed out: ${label}; diagnostics ${root}`);
}
const replies: any[] = [];
const acknowledgements: any[] = [];
const r = (id: string) => room.state.robots.get(id);
async function runtime(id: string, type: string, body: Record<string, unknown>) {
  const requestId = crypto.randomUUID();
  room.send(type, { robotId: id, requestId, expectedEpoch: r(id).controlEpoch, ...body });
  await until(() => replies.some(x => x.requestId === requestId), `${type} ${id}`);
  const ack = replies.find(x => x.requestId === requestId);
  assert(ack.ok ?? ack.accepted, JSON.stringify(ack));
  assert(ack.operationId, "administrative operation ID is required");
  return ack;
}
const base = `http://127.0.0.1:${5174 + offset}`;
async function api(path: string) {
  const response = await fetch(base + path);
  const value = await response.json() as any;
  assert(response.ok, JSON.stringify({ status: response.status, path, value }));
  return value;
}
try {
  spawn("server", "server/src/index.ts");
  spawn("web", "web-client/src/server.ts");
  await until(async () => {
    try { room = await new Client(`ws://127.0.0.1:${2569 + offset}`).joinOrCreate("floor"); return true; }
    catch { return false; }
  }, "isolated FMS");
  room.onMessage("*", () => {});
  room.onMessage("runtimeAck", (value: any) => replies.push(value));
  room.onMessage("virtualRobotPoseAck", (value: any) => replies.push(value));
  room.onMessage("commandAck", (value: any) => acknowledgements.push(value));
  await until(() => room.state?.robots, "snapshot");
  for (const id of ["robot-1", "robot-2"]) spawn(id, "virtual-robot/src/index.ts", ["--id", id]);
  await until(() => ["robot-1", "robot-2"].every(id => r(id)?.connected && r(id)?.controlReady), "two robots ready", 30000);

  for (const [i, id] of ["robot-1", "robot-2"].entries()) {
    await runtime(id, "setRobotControl", { enabled: false });
    await runtime(id, "setVirtualRobotPose", { testOnly: true, mapId: "large_lab", x: 1400, y: 1300 + i * 150, theta: 0 });
    await until(() => Math.abs(r(id).x - 1400) < 0.5 && Math.abs(r(id).y - (1300 + i * 150)) < 0.5, "new test pose");
    assert.equal(r(id).fmsControlState, "disabled");
    await runtime(id, "setRobotControl", { enabled: true });
  }
  const sessions = [r("robot-1").sessionId, r("robot-2").sessionId];
  const opIds: string[] = [];
  for (const targetX of [1460, 1400]) {
    const before = acknowledgements.length;
    for (const [i, id] of ["robot-1", "robot-2"].entries()) room.send("commandRobot", {
      robotId: id, kind: "move", x: targetX, y: 1300 + i * 150, theta: 0, clientRequestId: crypto.randomUUID(),
    });
    await until(() => acknowledgements.length >= before + 2, "two command acks");
    const acks = acknowledgements.slice(before);
    assert(acks.every((a: any) => a.operationId && a.commandId === a.operationId));
    opIds.push(...acks.map((a: any) => a.operationId));
    await until(() => acks.every((a: any) => r(a.robotId).commandId === a.commandId && r(a.robotId).commandState === "completed"), "simultaneous two robot moves", 30000);
    for (const [i, id] of ["robot-1", "robot-2"].entries()) {
      assert(Math.abs(r(id).x - targetX) < 0.5);
      assert.equal(r(id).sessionId, sessions[i], "no heartbeat disconnect/re-registration during movement");
    }
  }
  await until(async () => { try { return (await fetch(base + "/runtime-config.json")).ok; } catch { return false; } }, "web/API");
  await Bun.sleep(500);
  const candidates: any[] = [];
  let cursor: string | undefined;
  let asOf: number | undefined;
  do {
    const page = await api(`/api/blackbox/events?mapId=large_lab${asOf ? `&asOf=${asOf}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    asOf = page.asOf; candidates.push(...page.events); cursor = page.nextCursor;
  } while (cursor);
  assert(candidates.length > 8, "real recorded meaningful events");
  assert(candidates.every(e => !["frame", "protocol", "planning"].includes(e.category)));
  const first = candidates.find(e => e.kind === "setVirtualRobotPose.requested");
  const last = candidates.findLast(e => e.kind === "robot.state_changed" && e.payload.after?.commandState === "completed");
  assert(first && last, "pose and movement outcome boundaries");
  const replay = await api(`/api/blackbox/replay?mapId=large_lab&startEventId=${first.eventId}&endEventId=${last.eventId}&asOf=${asOf}`);
  assert.equal(replay.checkpoint.category, "frame");
  assert(replay.events.some((e: any) => e.category === "frame"), "intermediate telemetry not filtered by candidates");
  assert(replay.checkpoint.payload.assets.mapUrl.startsWith("/api/blackbox/assets/"));
  assert((await fetch(base + replay.checkpoint.payload.assets.mapUrl)).ok, "archived map asset available");
  const traceEvents: any[] = [];
  cursor = undefined;
  do {
    const trace = await api(`/api/blackbox/operations/${opIds[0]}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    traceEvents.push(...trace.events); cursor = trace.nextCursor;
  } while (cursor);
  assert(traceEvents.some((e: any) => e.kind === "commandRobot.requested"));
  assert(traceEvents.some((e: any) => e.category === "protocol"));
  assert(traceEvents.some((e: any) => e.payload.after?.commandState === "completed"));
  console.log(JSON.stringify({ result: "PASS", root, twoRobots: true, newPosePlacement: true, simultaneousMoves: 4, stableSessions: true,
    candidates: candidates.length, replayEvents: replay.events.length, traceEvents: traceEvents.length, operationIds: opIds }));
} finally {
  try { await room?.leave(); } catch {}
  for (const child of children) { try { child.kill(); await child.exited; } catch {} }
  console.log(`Isolated diagnostics preserved: ${root}`);
}
