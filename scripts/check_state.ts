import { Client } from "../web-client/node_modules/colyseus.js/build/esm/index.mjs";

const client = new Client("ws://127.0.0.1:2567");
const room = await client.joinOrCreate("floor");
await Bun.sleep(500);
const r = room.state.robots.get("robot-1");
const wp = room.state.waypoints.get("wp-1");
console.log("robot-1", { x: r?.x, y: r?.y, theta: r?.theta, status: r?.status });
console.log("wp-1", { x: wp?.x, y: wp?.y, theta: wp?.theta });
if (r && wp) {
  console.log("dist", Math.hypot(r.x - wp.x, r.y - wp.y), "dtheta", Math.abs(r.theta - wp.theta));
}

let err = "";
room.onMessage("error", (p: { message?: string } | string) => {
  err = typeof p === "string" ? p : p.message ?? "";
});
room.send("placeWaypoint", { x: 10, y: 10, theta: 0 });
await Bun.sleep(400);
console.log("gray place error:", err || "(none)");

room.send("placeWaypoint", { x: 300, y: 360, theta: 0.5 });
await Bun.sleep(400);
const ids: string[] = [];
room.state.waypoints.forEach((_v: unknown, k: string) => ids.push(k));
console.log("waypoints", ids.sort().join(","));

room.leave();
