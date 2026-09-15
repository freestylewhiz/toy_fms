import { inflatedGrid, loadOccupancy, loadSeed } from "../../shared/occupancy.ts";
import { GRPC_PORT } from "../../shared/constants.ts";
import { RobotController } from "./controller.ts";
import { GrpcClient } from "./grpcClient.ts";
import { createTrafficExecutor, grantFromWire } from "./traffic/createExecutor.ts";

function parseId(argv: string[]): string {
  let id = "robot-1";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--id" && argv[i + 1]) {
      id = argv[++i];
    } else if (arg.startsWith("--id=")) {
      id = arg.slice("--id=".length);
    }
  }
  return id;
}

function main(): void {
  const robotId = parseId(process.argv.slice(2));
  const seed = loadSeed();
  const spawn = seed.robots.find((r) => r.id === robotId);
  if (!spawn) {
    const known = seed.robots.map((r) => r.id).join(", ");
    throw new Error(`unknown robot id "${robotId}" (seed has: ${known})`);
  }

  console.log(`[${robotId}] loading occupancy`);
  loadOccupancy();
  inflatedGrid();

  const controller = new RobotController({
    x: spawn.x,
    y: spawn.y,
    theta: spawn.theta,
  });
  controller.setConnectionReady(false);
  controller.start();

  let client!: GrpcClient;
  const traffic = createTrafficExecutor({
    sendLeaseRequest: (b) => client.sendLeaseRequest(b),
    sendLeaseRelease: (b) => client.sendLeaseRelease(b),
    sendTrafficBid: (z, s) => client.sendTrafficBid(z, s),
    sendEvasionReply: (b) => client.sendEvasionReply(b),
    onEvasionPlan: (payload) => controller.handleEvasionPlan(payload),
  });
  controller.attachTraffic(traffic);
  controller.setEvasionReplySender((b) => client.sendEvasionReply(b));
  controller.setCommandStateSender((b) => client.sendCommandState(b));

  client = new GrpcClient({
    robotId,
    getPose: () => controller.snapshot(),
    getPath: () => controller.currentPath(),
    takePathDelta: () => controller.takePathDelta(),
    getLocalPlan: () => controller.currentLocalPlan(),
    onDrive: (cmd) => controller.handleDrive(cmd),
    onCancel: (id) => controller.handleCancel(id),
    onPlaceQuery: (obs) => controller.canPlace(obs),
    onObstacles: (items) => controller.setObstacles(items),
    onSemanticSnapshot: (snapshot) => controller.setSemanticSnapshot(snapshot),
    onConnectionState: (ready) => controller.setConnectionReady(ready),
    onControlState: (state) => controller.setControlState(state),
    onSensedPeers: (peers) => controller.setSensedPeers(peers),
    onFleetLocalPlans: (peers) => controller.setPeerLocalPlans(peers),
    onLeaseGrant: (msg) => traffic.onGrant(grantFromWire(msg)),
    onBidRequest: (zoneId, windowMs) => traffic.onBidRequest?.(zoneId, windowMs),
    onEvasionRequest: (msg) => traffic.onEvasionRequest?.(msg),
    onZoneUpdate: (zoneId, state) => controller.onTrafficZoneUpdate(zoneId, state),
  });
  client.start();

  const shutdown = () => {
    console.log(`[${robotId}] shutdown`);
    client.stop();
    controller.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const pose = controller.snapshot();
  console.log(
    `[${robotId}] spawn (${pose.x}, ${pose.y}, θ=${pose.theta.toFixed(3)}) → localhost:${GRPC_PORT}`,
  );
}

main();
