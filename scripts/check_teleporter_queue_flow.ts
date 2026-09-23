import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { endpointPolygonOverlaps } from "../shared/teleporterRuntime.ts";
import { ROBOT_LENGTH_PX, ROBOT_WIDTH_PX } from "../shared/constants.ts";
const root = mkdtempSync("/tmp/fms-teleporter-flow-");
const cwd = resolve(import.meta.dir, "..");
const offset = Number(process.env.E2E_PORT_OFFSET || 12500);
const env = { ...process.env, FMS_PORT_OFFSET: String(offset), FMS_DATA_ROOT: root, TELEPORTER_SQLITE_PATH: join(root, "teleporters.sqlite") };
const processes: Bun.Subprocess[] = []; const rooms: any[] = []; let passed = false;
function start(args: string[], map: string, label: string) {
  const process = Bun.spawn(["bun", ...args], { cwd, env: { ...env, FMS_MAP_ID: map }, stdout: Bun.file(join(root, `${label}.log`)), stderr: Bun.file(join(root, `${label}.err`)) });
  processes.push(process); return process;
}
async function until(check: () => boolean, message: string, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await Bun.sleep(100); }
  throw new Error(message);
}
try {
  start(["server/src/index.ts"], "yard", "yard"); start(["server/src/index.ts"], "large_lab", "lab");
  await Bun.sleep(3000);
  for (const id of ["robot-1", "robot-2"]) start(["virtual-robot/src/index.ts", "--id", id], "yard", id);
  const { Client } = await import("../web-client/node_modules/colyseus.js/build/esm/index.mjs");
  for (const port of [2568, 2569]) {
    const room = await new Client(`ws://127.0.0.1:${port + offset}`).joinOrCreate("floor");
    for (const type of ["teleporterSnapshot", "teleporterAck", "commandAck"]) room.onMessage(type, () => {});
    room.onMessage("error", (body: unknown) => console.log("server error", JSON.stringify(body)));
    rooms.push(room);
  }
  const [yard, lab] = rooms;
  await until(() => ["robot-1", "robot-2"].every(id => yard.state.robots.get(id)?.controlReady), "both robots must synchronize");
  const polygon = [{ x: -20, y: -20 }, { x: 20, y: -20 }, { x: 20, y: 20 }, { x: -20, y: 20 }];
  const source = { id: "source", mapId: "yard", position: { x: 360, y: 520 }, entryTheta: 0, exitTheta: 0, occupancyPolygon: polygon, clearingPoint: { x: 400, y: 520 } };
  yard.send("teleporterUpsert", { definition: { id: "flow", name: "flow", revision: 1, enabled: true, endpoints: [source, { ...source, id: "destination", mapId: "large_lab", position: { x: 1300, y: 1300 }, clearingPoint: { x: 1340, y: 1300 } }] } });
  await until(() => JSON.parse(lab.state.teleportersJson || "[]").some((d: any) => d.id === "flow"), "definition reaches destination");
  const db = new Database(join(root, "teleporters.sqlite"), { readonly: true });
  yard.send("commandRobot", { robotId: "robot-1", kind: "teleporter", targetId: "flow", endpointId: "source" });
  await until(() => !!db.query("SELECT 1 FROM teleporter_uses WHERE robot_id='robot-1'").get(), "first robot reserves teleporter");
  yard.send("commandRobot", { robotId: "robot-2", kind: "teleporter", targetId: "flow", endpointId: "source" });
  await until(() => !!db.query("SELECT 1 FROM teleporter_queue WHERE robot_id='robot-2'").get(), "second robot joins FIFO");
  await until(() => lab.state.robots.get("robot-1")?.commandState === "completed", "first robot completes clearing");
  await Bun.sleep(2000);
  assert(!lab.state.robots.get("robot-2")?.connected, "occupied clearing point prevents the next transfer");
  const waiting = yard.state.robots.get("robot-2");
  assert(waiting, "waiting robot stays in source map");
  const c = Math.cos(waiting.theta), s = Math.sin(waiting.theta);
  const hx = ROBOT_LENGTH_PX / 2, hy = ROBOT_WIDTH_PX / 2;
  const body = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([x, y]) => ({ x: waiting.x + x * c - y * s, y: waiting.y + x * s + y * c }));
  assert(!endpointPolygonOverlaps(source, body), "waiting body stays outside the source endpoint");
  lab.send("commandRobot", { robotId: "robot-1", kind: "move", x: 1420, y: 1300, theta: 0 });
  await until(() => lab.state.robots.get("robot-1")?.x > 1400, "first robot vacates the clearing corridor");
  await until(() => lab.state.robots.get("robot-2")?.commandState === "completed", "second robot resumes and completes after space clears", 45000);
  assert.equal((db.query("SELECT phase FROM teleporter_transfers WHERE robot_id='robot-2' ORDER BY updated_at DESC LIMIT 1").get() as any)?.phase, "completed");
  db.close(); passed = true;
  console.log("PASS: FIFO service, occupied exit waiting outside entry, automatic resume after departure");
} finally {
  for (const room of rooms) await room.leave().catch(() => {});
  for (const process of processes) try { process.kill(); } catch {}
  await Promise.all(processes.map(process => process.exited));
  if (passed) rmSync(root, { recursive: true, force: true }); else console.error(`flow logs preserved: ${root}`);
}
