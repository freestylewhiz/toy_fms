import { Client } from "../web-client/node_modules/colyseus.js/build/esm/index.mjs";
import { COLYSEUS_PORT, ROOM_NAME } from "../shared/constants.ts";

const client = new Client(`ws://127.0.0.1:${COLYSEUS_PORT}`);
const room = await client.joinOrCreate(ROOM_NAME);
await Bun.sleep(300);

let err = "";
room.onMessage("error", (p: { message?: string } | string) => {
  err = typeof p === "string" ? p : p.message ?? "";
});

room.send("editorUpsert", {
  kind: "zone",
  family: "scene",
  zoneKind: "forbidden",
  name: "test-forbidden",
  polygon: [
    { x: 200, y: 200 },
    { x: 280, y: 200 },
    { x: 280, y: 280 },
    { x: 200, y: 280 },
  ],
});
await Bun.sleep(200);

room.send("editorUpsert", { kind: "node", x: 300, y: 400, theta: 0, name: "n-test" });
await Bun.sleep(200);

const state = room.state as {
  zones: { size: number };
  nodes: { size: number };
  waypoints: { size: number };
};
console.log({
  err: err || "(none)",
  zones: state.zones.size,
  nodes: state.nodes.size,
  waypoints: state.waypoints.size,
});
room.leave();
if (err || state.zones.size < 1 || state.nodes.size < 1) process.exit(1);
