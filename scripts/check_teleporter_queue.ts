import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const root = `/tmp/fms-teleporter-queue-${Date.now()}`;
const offset = Number(process.env.E2E_PORT_OFFSET || 13000);
const yardWeb = 2568 + offset, yardGrpc = 50062 + offset, labWeb = 2569 + offset;
mkdirSync(root, { recursive: true });
const common = { FMS_PORT_OFFSET: String(offset), FMS_DATA_ROOT: root, TELEPORTER_SQLITE_PATH: join(root, "teleporters.sqlite") };
const processes: Bun.Subprocess[] = [];
const start = (args: string[], extra: Record<string, string>) => {
  const label = `${extra.FMS_MAP_ID}-${processes.length}`;
  const p = Bun.spawn(args, { cwd: process.cwd(), env: { ...process.env, ...common, ...extra }, stdout: Bun.file(join(root, `${label}.log`)), stderr: Bun.file(join(root, `${label}.err`)) }); processes.push(p); return p;
};
const stop = async () => { for (const p of processes) { try { p.kill(); } catch {} } await Promise.all(processes.map(p => p.exited)); };
const fail = (message: string): never => { throw new Error(message); };

start(["bun", "server/src/index.ts"], { FMS_MAP_ID: "yard" });
start(["bun", "server/src/index.ts"], { FMS_MAP_ID: "large_lab" });
await Bun.sleep(3500);
start(["bun", "virtual-robot/src/index.ts", "--id", "robot-1", "--target", `127.0.0.1:${yardGrpc}`], { FMS_MAP_ID: "yard" });
start(["bun", "virtual-robot/src/index.ts", "--id", "robot-2", "--target", `127.0.0.1:${yardGrpc}`], { FMS_MAP_ID: "yard" });
await Bun.sleep(3500);

try {
  const { Client } = await import("../web-client/node_modules/colyseus.js/build/esm/index.mjs");
  const room = await new Client(`ws://127.0.0.1:${yardWeb}`).joinOrCreate("floor");
  const acks: unknown[] = [];
  room.onMessage("commandAck", (message: unknown) => acks.push(message));
  room.onMessage("error", (message: unknown) => acks.push(message));
  const teleporter = { id: "queue-test", type: "teleporter", name: "queue-test", enabled: true, revision: 1, endpoints: [
    { id: "yard-end", mapId: "yard", position: { x: 240, y: 520 }, entryTheta: 0, exitTheta: 0, clearingPoint: { x: 280, y: 520 }, occupancyPolygon: [{ x: -20, y: -20 }, { x: 20, y: -20 }, { x: 20, y: 20 }, { x: -20, y: 20 }] },
    { id: "lab-end", mapId: "large_lab", position: { x: 1300, y: 1300 }, entryTheta: Math.PI, exitTheta: Math.PI, clearingPoint: { x: 1340, y: 1300 }, occupancyPolygon: [{ x: -20, y: -20 }, { x: 20, y: -20 }, { x: 20, y: 20 }, { x: -20, y: 20 }] },
  ] };
  room.send("teleporterUpsert", { requestId: "queue-upsert", definition: teleporter });
  await Bun.sleep(500);
  room.send("commandRobot", { robotId: "robot-1", kind: "teleporter", targetId: "queue-test", endpointId: "yard-end" });
  // Submit the second request while the first robot still owns the gate.
  // Keeping this short also makes the assertion independent of controller
  // speed and tests the real FIFO path rather than two sequential commands.
  await Bun.sleep(100);
  room.send("commandRobot", { robotId: "robot-2", kind: "teleporter", targetId: "queue-test", endpointId: "yard-end" });
  await Bun.sleep(700);
  const db = new Database(join(root, "teleporters.sqlite"));
  const queued = db.query("SELECT robot_id FROM teleporter_queue WHERE teleporter_id='queue-test'").all() as { robot_id: string }[];
  if (!queued.some(row => row.robot_id === "robot-2")) fail(`robot-2 was not queued: ${JSON.stringify(queued)} acks=${JSON.stringify(acks)}`);
  room.send("cancelRobot", { robotId: "robot-2" });
  await Bun.sleep(500);
  const remaining = db.query("SELECT robot_id FROM teleporter_queue WHERE teleporter_id='queue-test'").all();
  if (remaining.length !== 0) fail(`cancelled queue entry remains: ${JSON.stringify(remaining)}`);
  db.close(); room.leave(); await stop(); rmSync(root, { recursive: true, force: true });
  console.log("PASS: multi-robot FIFO queue and explicit cancellation");
} catch (error) { await stop(); console.error(`queue harness logs: ${root}`); throw error; }
