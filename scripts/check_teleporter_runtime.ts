import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";

const root = `/tmp/fms-teleporter-check-${Date.now()}`;
mkdirSync(root, { recursive: true });
const offset = Number(process.env.E2E_PORT_OFFSET || 15000);
const yardWeb = 2568 + offset;
const yardGrpc = 50062 + offset;
const labWeb = 2569 + offset;
const labGrpc = 50063 + offset;
const procs: Bun.Subprocess[] = [];
let passed = false;
function start(cmd: string[], env: Record<string, string>, label: string): Bun.Subprocess {
  const p = Bun.spawn(cmd, { cwd: process.cwd(), env: { ...process.env, ...env }, stdout: Bun.file(join(root, `${label}.stdout.log`)), stderr: Bun.file(join(root, `${label}.stderr.log`)) });
  procs.push(p); return p;
}
async function wait(ms: number) { await Bun.sleep(ms); }
async function stop() { for (const p of procs) p.kill(); await wait(300); if (passed) rmSync(root, { recursive: true, force: true }); else console.error(`teleporter harness logs preserved at ${root}`); }
function fail(message: string): never { throw new Error(message); }

const common = { FMS_PORT_OFFSET: String(offset), FMS_DATA_ROOT: root, TELEPORTER_SQLITE_PATH: join(root, "teleporters.sqlite") };
const yard = start(["bun", "server/src/index.ts"], { ...common, FMS_MAP_ID: "yard" }, "yard-server");
const lab = start(["bun", "server/src/index.ts"], { ...common, FMS_MAP_ID: "large_lab" }, "lab-server");
await wait(3500);
const robot = start(["bun", "virtual-robot/src/index.ts", "--id", "robot-1", "--target", `127.0.0.1:${yardGrpc}`], { ...common, FMS_MAP_ID: "yard" }, "robot");
await wait(3000);

try {
  const { Client } = await import("../web-client/node_modules/colyseus.js/build/esm/index.mjs");
  const client = new Client(`ws://127.0.0.1:${yardWeb}`);
  const labClient = new Client(`ws://127.0.0.1:${labWeb}`);
  const room = await client.joinOrCreate("floor");
  const labRoom = await labClient.joinOrCreate("floor");
  for (const current of [room, labRoom]) {
    current.onMessage("teleporterSnapshot", () => {});
    current.onMessage("teleporterAck", () => {});
  }
  const ledger = new Database(join(root, "teleporters.sqlite"), { readonly: true });
  const verifyCompleted = (mapId: string, epoch: number) => {
    const owner = ledger.query("SELECT * FROM teleporter_robot_owners WHERE robot_id='robot-1'").get() as any;
    assert.equal(owner?.map_id, mapId, "exactly one authoritative map owns the robot");
    assert.equal(owner?.control_epoch, epoch, "each handoff advances the control epoch");
    assert.equal(ledger.query("SELECT * FROM teleporter_uses WHERE teleporter_id='e2e-teleporter'").get(), null, "full exit releases the reservation");
    const transfer = ledger.query("SELECT * FROM teleporter_transfers WHERE transfer_id=?").get(owner.transfer_id) as any;
    assert.equal(transfer?.phase, "completed", "completion is durable, not only a UI projection");
  };
  room.onMessage("commandAck", (value: unknown) => console.log("commandAck", JSON.stringify(value)));
  room.onMessage("error", (value: unknown) => console.log("yardError", JSON.stringify(value)));
  labRoom.onMessage("error", (value: unknown) => console.log("labError", JSON.stringify(value)));
  const state = room.state as any;
  const beforeCommandId = String(state.robots?.get?.("robot-1")?.commandId ?? "");
  const teleporter = {
    id: "e2e-teleporter", type: "teleporter", name: "e2e",
    enabled: true, revision: 1,
    endpoints: [
      { id: "yard-end", mapId: "yard", position: { x: 240, y: 520 }, entryTheta: 0, exitTheta: 0, clearingPoint: { x: 320, y: 520 }, occupancyPolygon: [{ x: -20, y: -20 }, { x: 20, y: -20 }, { x: 20, y: 20 }, { x: -20, y: 20 }] },
      { id: "lab-end", mapId: "large_lab", position: { x: 1300, y: 1300 }, entryTheta: Math.PI, exitTheta: Math.PI, clearingPoint: { x: 1380, y: 1300 }, occupancyPolygon: [{ x: -20, y: -20 }, { x: 20, y: -20 }, { x: 20, y: 20 }, { x: -20, y: 20 }] },
    ],
  };
  room.send("teleporterUpsert", { requestId: "e2e-upsert", definition: teleporter });
  await wait(500);
  room.send("commandRobot", { robotId: "robot-1", kind: "teleporter", targetId: "e2e-teleporter", endpointId: "yard-end" });
  const phases: string[] = [];
  let releasedBeforeArrival = false;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await wait(250);
    const robotState = state.robots?.get?.("robot-1");
    if (robotState?.commandReason && !phases.includes(String(robotState.commandReason))) phases.push(String(robotState.commandReason));
    const labNow = (labRoom.state as any).robots?.get?.("robot-1");
    if (labNow?.connected && labNow.x > 1340 && labNow.x < 1370 && labNow.commandState !== "completed" && ledger.query("SELECT 1 FROM teleporter_uses WHERE teleporter_id='e2e-teleporter'").get() === null) releasedBeforeArrival = true;
    if (labNow?.connected && labNow.controlReady && labNow.commandState === "completed" && Math.hypot(Number(labNow.x) - 1380, Number(labNow.y) - 1300) <= 0.5) break;
  }
  const labRobot = (labRoom.state as any).robots?.get?.("robot-1");
  const final = state.robots?.get?.("robot-1");
  console.log(JSON.stringify({ phases, yard: final ? { x: final.x, y: final.y, commandState: final.commandState } : null, lab: labRobot ? { x: labRobot.x, y: labRobot.y, commandState: labRobot.commandState } : null }));
  if (!labRobot || !labRobot.connected || !labRobot.controlReady || labRobot.commandState !== "completed" || Math.hypot(Number(labRobot.x) - 1380, Number(labRobot.y) - 1300) > 0.5) fail(`teleporter did not arrive and clear in lab: ${JSON.stringify({ phases, labRobot })}`);
  assert(releasedBeforeArrival, "body exit releases occupancy before the separate clearing-point completion");
  verifyCompleted("large_lab", 1);
  assert(!final?.connected && !final?.controlReady, "source cannot remain active after handoff");
  labRoom.send("commandRobot", { robotId: "robot-1", kind: "teleporter", targetId: "e2e-teleporter", endpointId: "lab-end" });
  const returnDeadline = Date.now() + 30000;
  while (Date.now() < returnDeadline) {
    await wait(250);
    const returnedNow = (room.state as any).robots?.get?.("robot-1");
    if (returnedNow?.connected && returnedNow.controlReady && returnedNow.commandState === "completed" && Math.hypot(Number(returnedNow.x) - 320, Number(returnedNow.y) - 520) <= 0.5) break;
  }
  const returned = (room.state as any).robots?.get?.("robot-1");
  if (!returned || !returned.connected || !returned.controlReady || returned.commandState !== "completed" || Math.hypot(Number(returned.x) - 320, Number(returned.y) - 520) > 0.5) fail(`teleporter did not return to yard: ${JSON.stringify({ returned })}`);
  verifyCompleted("yard", 2);
  const oldLabRobot = (labRoom.state as any).robots?.get?.("robot-1");
  assert(!oldLabRobot?.connected && !oldLabRobot?.controlReady, "return fences the former destination");
  ledger.close();
  console.log("PASS: bidirectional travel, automatic clearing, durable completion, reservation release, single map ownership");
  room.leave();
  labRoom.leave();
  passed = true;
} finally { await stop(); }
