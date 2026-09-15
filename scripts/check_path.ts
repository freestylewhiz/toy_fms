import { Client } from "../web-client/node_modules/colyseus.js/build/esm/index.mjs";

const client = new Client("ws://127.0.0.1:2567");
const room = await client.joinOrCreate("floor");
await Bun.sleep(400);

room.send("commandRobot", { robotId: "robot-1", kind: "move", x: 180, y: 340, theta: 0 });

let n = 0;
for (let i = 0; i < 25; i++) {
  await Bun.sleep(120);
  const r = room.state.robots.get("robot-1") as { status?: string; path?: { length: number } };
  n = r?.path?.length ?? 0;
  if ((r?.status === "move" || n > 0) && n > 1) {
    console.log("path points", n, "status", r?.status);
    room.leave();
    process.exit(0);
  }
}
console.log("no path yet, last n=", n);
room.leave();
process.exit(1);
