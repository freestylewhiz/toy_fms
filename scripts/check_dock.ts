import { Client } from "../web-client/node_modules/colyseus.js/build/esm/index.mjs";

const client = new Client("ws://127.0.0.1:2567");
const room = await client.joinOrCreate("floor");
await Bun.sleep(400);

room.send("commandRobot", { robotId: "robot-2", kind: "dock", targetId: "cs-1" });
const start = Date.now();
let last = "";
while (Date.now() - start < 40000) {
  await Bun.sleep(500);
  const r = room.state.robots.get("robot-2");
  const cs = room.state.chargingStations.get("cs-1");
  last = JSON.stringify({
    x: r?.x,
    y: r?.y,
    theta: r?.theta,
    status: r?.status,
    dist: r && cs ? Math.hypot(r.x - cs.x, r.y - cs.y) : null,
  });
  if (r?.status === "idle" && r && cs && Math.hypot(r.x - cs.x, r.y - cs.y) < 2) break;
}
console.log("robot-2 dock", last);
room.leave();
