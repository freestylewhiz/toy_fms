import { matchMaker, Server } from "@colyseus/core";
import { BunWebSockets } from "@colyseus/bun-websockets";
import { COLYSEUS_PORT, GRPC_PORT, ROOM_NAME } from "../../shared/constants.ts";
import { startRobotBridge } from "./grpc/robotBridge.ts";
import { FloorRoom } from "./rooms/FloorRoom.ts";

async function startColyseus(): Promise<Server> {
  try {
    const gameServer = new Server({
      transport: new BunWebSockets(),
    });
    attachHello(gameServer);
    gameServer.define(ROOM_NAME, FloorRoom);
    await gameServer.listen(COLYSEUS_PORT, "0.0.0.0");
    return gameServer;
  } catch (err) {
    console.warn("[colyseus] BunWebSockets failed, falling back to ws-transport:", err);
    const { WebSocketTransport } = await import("@colyseus/ws-transport");
    const { createServer } = await import("node:http");
    const httpServer = createServer();
    const gameServer = new Server({
      transport: new WebSocketTransport({
        server: httpServer,
      }),
    });
    attachHello(gameServer);
    gameServer.define(ROOM_NAME, FloorRoom);
    await gameServer.listen(COLYSEUS_PORT, "0.0.0.0");
    return gameServer;
  }
}

function attachHello(gameServer: Server) {
  const app = (gameServer.transport as { expressApp?: { get: Function } } | undefined)?.expressApp;
  if (!app) return;
  app.get("/hello", (_req: unknown, res: { json: (body: unknown) => void }) => {
    res.json({ hello: "bg_fms" });
  });
}

await startColyseus();
await matchMaker.createRoom(ROOM_NAME, {});
await startRobotBridge(GRPC_PORT);

console.log(`Colyseus room "${ROOM_NAME}"  0.0.0.0:${COLYSEUS_PORT}`);
console.log(`gRPC RobotBridge              0.0.0.0:${GRPC_PORT}`);
