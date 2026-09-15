import { strict as assert } from "node:assert";
import { Client } from "../web-client/node_modules/colyseus.js/build/esm/index.mjs";
import { COLYSEUS_PORT, ROOM_NAME } from "../shared/constants.ts";
import { isInflatedFree } from "../shared/occupancy.ts";

const room = await new Client(`ws://127.0.0.1:${COLYSEUS_PORT}`).joinOrCreate(ROOM_NAME);
const errors: string[] = [];
room.onMessage("error", (e: { message: string }) => errors.push(e.message));
room.onMessage("commandAck", () => {});
room.onMessage("obstacleAck", () => {});
async function until(check: () => boolean, timeout: number, label: string) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return; await Bun.sleep(50); }
  throw new Error(`Timed out: ${label}. Server errors: ${errors.join("; ")}`);
}
let robotId = "";
try {
  await until(() => [...(room.state?.robots?.values?.() ?? [])].some((r: any) => r.connected), 5000, "connected robot");
  const robot: any = [...room.state.robots.values()].find((r: any) => r.connected && r.status === "idle");
  assert(robot, "An idle connected robot is required for the live check");
  robotId = robot.id;
  const x = robot.x, y = robot.y;
  // Short nearby command keeps the live check bounded at the normal 0.6 m/s.
  const target = [{ x: x + 24, y }, { x: x - 24, y }, { x, y: y + 24 }, { x, y: y - 24 }]
    .find(p => isInflatedFree(p.x, p.y));
  assert(target, "No nearby free test destination");
  room.send("commandRobot", { robotId, kind: "move", ...target, theta: Math.PI / 2 });
  await until(() => Math.hypot(robot.x - x, robot.y - y) > 1, 5000, "motion begins");
  await until(() => robot.commandState === "completed" && robot.status === "idle" && Math.hypot(robot.x - target.x, robot.y - target.y) < 0.5, 15000, "robot-reported completion and exact arrival");
  assert(Math.abs(Math.atan2(Math.sin(robot.theta - Math.PI / 2), Math.cos(robot.theta - Math.PI / 2))) < 0.06, "final heading");
  room.send("commandRobot", { robotId, kind: "move", x, y, theta: 0 });
  await until(() => robot.status === "move", 5000, "return begins");
  room.send("cancelRobot", { robotId });
  await until(() => robot.commandState === "cancelled" && robot.status === "idle", 3000, "cancel acknowledged by robot");
  const stopped = { x: robot.x, y: robot.y };
  await Bun.sleep(300);
  assert(Math.hypot(robot.x - stopped.x, robot.y - stopped.y) < 0.7, "robot stays stopped");
  assert.deepEqual(errors, []);
  console.log("Live driving passed: connected robot, exact arrival/heading, cancellation and stable stop.");
} finally {
  if (robotId) room.send("cancelRobot", { robotId });
  await room.leave();
}
