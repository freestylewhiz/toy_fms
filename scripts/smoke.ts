import { COLYSEUS_PORT, ROOM_NAME } from "../shared/constants.ts";
import { loadSeed, robotFootprintClear } from "../shared/occupancy.ts";
import { planDrive } from "../shared/planner.ts";

const seed = loadSeed();
let failed = 0;

function check(name: string, ok: boolean, extra = "") {
  if (ok) console.log(`ok  ${name}${extra ? "  " + extra : ""}`);
  else {
    failed++;
    console.error(`FAIL  ${name}${extra ? "  " + extra : ""}`);
  }
}

for (const r of seed.robots) {
  check(`spawn footprint ${r.id}`, robotFootprintClear(r.x, r.y, r.theta), `(${r.x},${r.y})`);
}

const r1 = seed.robots[0];
for (const wp of seed.waypoints) {
  const path = planDrive({ x: r1.x, y: r1.y }, { x: wp.x, y: wp.y });
  check(`plan ${r1.id} → ${wp.id}`, !!path && path.length > 1, path ? `${path.length} pts` : "null");
}
for (const cs of seed.chargingStations) {
  const path = planDrive({ x: r1.x, y: r1.y }, { x: cs.x, y: cs.y });
  check(`plan ${r1.id} → ${cs.id}`, !!path && path.length > 1, path ? `${path.length} pts` : "null");
}

const live = process.argv.includes("--live");
if (!live) {
  if (failed) process.exit(1);
  console.log("planner smoke passed");
  process.exit(0);
}

const { Client } = await import("../web-client/node_modules/colyseus.js/build/esm/index.mjs");
const client = new Client(`ws://127.0.0.1:${COLYSEUS_PORT}`);
const room = await client.joinOrCreate(ROOM_NAME);
await new Promise<void>((resolve) => {
  if (room.state?.robots?.get?.("robot-1")) {
    resolve();
    return;
  }
  room.onStateChange(() => {
    if (room.state?.robots?.get?.("robot-1")) resolve();
  });
  setTimeout(() => resolve(), 3000);
});
const robots = room.state.robots as Map<string, { x: number; y: number; status: string }>;
const start = robots?.get?.("robot-1");
check("joined floor", !!start, start ? `status=${(start as { status: string }).status}` : "");

room.send("commandRobot", { robotId: "robot-1", kind: "move", targetId: "wp-1" });

const deadline = Date.now() + 25000;
let moved = false;
const sx = (start as { x: number } | undefined)?.x ?? 0;
const sy = (start as { y: number } | undefined)?.y ?? 0;
while (Date.now() < deadline) {
  await Bun.sleep(200);
  const r = robots.get("robot-1") as { x: number; y: number; status: string } | undefined;
  if (!r) break;
  if (r.status === "move" || Math.hypot(r.x - sx, r.y - sy) > 2) {
    moved = true;
    break;
  }
}
check("robot-1 started moving", moved);

room.leave();
if (failed) process.exit(1);
console.log("live smoke passed");
