import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = `/tmp/fms-teleporter-recovery-${Date.now()}`;
mkdirSync(root, { recursive: true });
const offset = Number(process.env.E2E_PORT_OFFSET || 14000);
const env = { ...process.env, FMS_MAP_ID: "yard", FMS_PORT_OFFSET: String(offset), FMS_DATA_ROOT: root, TELEPORTER_SQLITE_PATH: join(root, "teleporters.sqlite") };
const journal = join(root, "robot-robot-1.teleporter.json");
async function main() {
let robot: Bun.Subprocess | undefined;
let second: Bun.Subprocess | undefined;
let yardServer: Bun.Subprocess | undefined;
let labServer: Bun.Subprocess | undefined;
let passed = false;
try {
const common = { FMS_PORT_OFFSET: String(offset), FMS_DATA_ROOT: root, TELEPORTER_SQLITE_PATH: join(root, "teleporters.sqlite") };
yardServer = Bun.spawn(["bun", "server/src/index.ts"], { env: { ...process.env, ...common, FMS_MAP_ID: "yard" }, stdout: Bun.file(join(root, "yard-server.log")), stderr: Bun.file(join(root, "yard-server.err")) });
labServer = Bun.spawn(["bun", "server/src/index.ts"], { env: { ...process.env, ...common, FMS_MAP_ID: "large_lab" }, stdout: Bun.file(join(root, "lab-server.log")), stderr: Bun.file(join(root, "lab-server.err")) });
await Bun.sleep(3500);
robot = Bun.spawn(["bun", "virtual-robot/src/index.ts", "--id", "robot-1", "--global-id", "robot-1", "--target", `127.0.0.1:${50062 + offset}`], { env, stdout: Bun.file(join(root, "robot.log")), stderr: Bun.file(join(root, "robot.err")) });
await Bun.sleep(4500);
const { Client } = await import("../web-client/node_modules/colyseus.js/build/esm/index.mjs");
const yard = await new Client(`ws://127.0.0.1:${2568 + offset}`).joinOrCreate("floor");
const lab = await new Client(`ws://127.0.0.1:${2569 + offset}`).joinOrCreate("floor");
yard.onMessage("teleporterAck", (value: unknown) => console.log("teleporterAck", JSON.stringify(value)));
yard.onMessage("error", (value: unknown) => console.log("yardError", JSON.stringify(value)));
lab.onMessage("error", (value: unknown) => console.log("labError", JSON.stringify(value)));
const definition = { id: "recovery-t", type: "teleporter", name: "recovery", enabled: true, revision: 1, endpoints: [{ id: "yard", mapId: "yard", position: { x: 240, y: 520 }, entryTheta: 0, exitTheta: 0, clearingPoint: { x: 280, y: 520 }, occupancyPolygon: [{ x: -20, y: -20 }, { x: 20, y: -20 }, { x: 20, y: 20 }, { x: -20, y: 20 }] }, { id: "lab", mapId: "large_lab", position: { x: 1300, y: 1300 }, entryTheta: 0, exitTheta: 0, clearingPoint: { x: 1340, y: 1300 }, occupancyPolygon: [{ x: -20, y: -20 }, { x: 20, y: -20 }, { x: 20, y: 20 }, { x: -20, y: 20 }] }] };
yard.send("teleporterUpsert", { requestId: "recovery-upsert", definition });
const connectDeadline = Date.now() + 10000;
while (Date.now() < connectDeadline && !(yard.state as any).robots?.get?.("robot-1")?.connected) await Bun.sleep(250);
if (!(yard.state as any).robots?.get?.("robot-1")?.connected) throw new Error(`robot did not connect to yard; logs preserved at ${root}`);
await Bun.sleep(700); yard.send("commandRobot", { robotId: "robot-1", kind: "teleporter", targetId: "recovery-t", endpointId: "yard" });
const labRobots = (lab.state as any).robots;
const deadline = Date.now() + 30000;
while (Date.now() < deadline) { await Bun.sleep(250); const r = labRobots?.get?.("robot-1"); if (r?.connected && r.controlReady && r.commandState === "completed" && Math.hypot(r.x - 1340, r.y - 1300) <= 0.5) break; }
const arrived = labRobots?.get?.("robot-1");
if (!arrived?.connected || !arrived.controlReady || arrived.commandState !== "completed" || Math.hypot(arrived.x - 1340, arrived.y - 1300) > 0.5) throw new Error(`transfer recovery setup failed; logs preserved at ${root}`);
const oldSessionId = String(arrived.sessionId ?? "");
robot.kill(); await Bun.sleep(700);
second = Bun.spawn(["bun", "virtual-robot/src/index.ts", "--id", "robot-1", "--global-id", "robot-1", "--target", `127.0.0.1:${50062 + offset}`], { env, stdout: Bun.file(join(root, "robot-restart.log")), stderr: Bun.file(join(root, "robot-restart.err")) });
const restartDeadline = Date.now() + 15000;
while (Date.now() < restartDeadline) { await Bun.sleep(250); const r = labRobots?.get?.("robot-1"); if (r?.connected && r.controlReady && Math.hypot(r.x - 1340, r.y - 1300) <= 0.5) break; }
const restored = labRobots?.get?.("robot-1");
if (!restored?.connected || !restored.controlReady || !restored.sessionId || restored.sessionId === oldSessionId || Math.hypot(restored.x - 1340, restored.y - 1300) > 0.5) throw new Error(`journal recovery failed; logs preserved at ${root}`);
// Prove ordinary motion updates the durable pose after handoff.
lab.send("commandRobot", { robotId: "robot-1", kind: "move", x: 1380, y: 1300, theta: 0 });
const driveDeadline = Date.now() + 15000;
while (Date.now() < driveDeadline) {
  await Bun.sleep(250);
  const current = labRobots?.get?.("robot-1");
  if (current?.connected && current.controlReady && current.commandState === "completed" && Math.hypot(current.x - 1380, current.y - 1300) <= 0.5) break;
}
const driven = labRobots?.get?.("robot-1");
if (!driven?.connected || !driven.controlReady || driven.commandState !== "completed" || Math.hypot(driven.x - 1380, driven.y - 1300) > 0.5) throw new Error(`ordinary post-transfer drive failed; logs preserved at ${root}`);
const drivenSessionId = String(driven.sessionId ?? "");
second.kill(); await second.exited; lab.leave();
labServer.kill(); await labServer.exited;
labServer = Bun.spawn(["bun", "server/src/index.ts"], { env: { ...process.env, ...common, FMS_MAP_ID: "large_lab" }, stdout: Bun.file(join(root, "lab-server-restart.log")), stderr: Bun.file(join(root, "lab-server-restart.err")) });
await Bun.sleep(3500);
const restartedLab = await new Client(`ws://127.0.0.1:${2569 + offset}`).joinOrCreate("floor");
restartedLab.onMessage("error", (value: unknown) => console.log("labRestartError", JSON.stringify(value)));
robot = Bun.spawn(["bun", "virtual-robot/src/index.ts", "--id", "robot-1", "--global-id", "robot-1", "--target", `127.0.0.1:${50062 + offset}`], { env, stdout: Bun.file(join(root, "robot-fms-restart.log")), stderr: Bun.file(join(root, "robot-fms-restart.err")) });
const fmsRestartDeadline = Date.now() + 15000;
while (Date.now() < fmsRestartDeadline) {
  await Bun.sleep(250);
  const restartedRobots = (restartedLab.state as any).robots;
  const current = restartedRobots?.get?.("robot-1");
  if (current?.connected && current.controlReady && String(current.sessionId) !== drivenSessionId && Math.hypot(current.x - 1380, current.y - 1300) <= 0.5) break;
}
const restartedRobots = (restartedLab.state as any).robots;
const fmsRestored = restartedRobots?.get?.("robot-1");
restartedLab.leave(); yard.leave();
if (!fmsRestored?.connected || !fmsRestored.controlReady || !fmsRestored.sessionId || String(fmsRestored.sessionId) === drivenSessionId || Math.hypot(fmsRestored.x - 1380, fmsRestored.y - 1300) > 0.5) throw new Error(`FMS restart journal recovery failed: ${JSON.stringify(fmsRestored ? { connected: fmsRestored.connected, controlReady: fmsRestored.controlReady, fmsControlState: fmsRestored.fmsControlState, sessionId: fmsRestored.sessionId, x: fmsRestored.x, y: fmsRestored.y, epoch: fmsRestored.controlEpoch } : null)}; logs preserved at ${root}`);
console.log("teleporter journal recovery passed: transfer, ordinary drive, robot restart, and lab FMS restart");
passed = true;
} finally {
  for (const process of [robot, second, yardServer, labServer].filter(Boolean)) {
    try { process.kill(); } catch {}
    await process.exited;
  }
  if (passed) rmSync(root, { recursive: true, force: true }); else console.error(`recovery logs preserved at ${root}`);
}
}
await main();
