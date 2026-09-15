import { Client } from "../web-client/node_modules/colyseus.js/build/esm/index.mjs";

const client = new Client("ws://127.0.0.1:2567");
const room = await client.joinOrCreate("floor");
await Bun.sleep(400);

let err = "";
room.onMessage("error", (p: { message?: string } | string) => {
  err = typeof p === "string" ? p : p.message ?? "";
});

room.send("commandRobot", { robotId: "robot-1", kind: "move", x: 10, y: 10, theta: 0 });
await Bun.sleep(300);
console.log("gray goto:", err || "(none)");

err = "";
room.send("commandRobot", { robotId: "robot-1", kind: "move", x: 180, y: 340, theta: 0 });
const start = Date.now();
let moved = false;
while (Date.now() - start < 8000) {
  await Bun.sleep(200);
  const r = room.state.robots.get("robot-1") as { x: number; y: number; status: string } | undefined;
  if (r?.status === "move") {
    moved = true;
    console.log("started", { x: r.x, y: r.y, status: r.status });
    break;
  }
}
console.log("white goto error:", err || "(none)", "moved:", moved);
room.leave();
if (!moved) process.exit(1);
