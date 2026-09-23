import { commitMapContext, inflatedGrid, loadOccupancy, loadSeed, prepareMapContext } from "../../shared/occupancy.ts";
import { canonicalRobotId, GRPC_PORT, MAP_ID } from "../../shared/constants.ts";
import { RobotController } from "./controller.ts";
import { PlanningWorkerClient } from "./planning.ts";
import { GrpcClient } from "./grpcClient.ts";
import { createTrafficExecutor, grantFromWire } from "./traffic/createExecutor.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeMap } from "../../shared/maps.ts";
import { readTransferJournal, settledPoseJournal, writeTransferJournal, type TransferJournal } from "./transferJournal.ts";

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

function parseTarget(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target" && argv[i + 1]) return argv[++i];
    if (arg.startsWith("--target=")) return arg.slice("--target=".length);
  }
  return undefined;
}
function parseGlobalId(argv: string[], rawId: string): string {
  let value = rawId;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--global-id" && argv[i + 1]) value = argv[++i];
    if (argv[i].startsWith("--global-id=")) value = argv[i].slice("--global-id=".length);
  }
  return canonicalRobotId(value);
}

type PendingTransfer = { exit: { x: number; y: number; theta: number }; clearing: { x: number; y: number }; transferId: string; destinationTarget: string; destinationMapId: string };
function transferJournalPath(robotId: string): string {
  // FMS_DATA_ROOT is the shared data root for servers (`data/`). Keep robot
  // journals in its dedicated subdirectory so PM2 can use one environment for
  // every process without making a restarted robot lose its current map.
  const root = process.env.FMS_DATA_ROOT
    ? join(process.env.FMS_DATA_ROOT, "robots")
    : join(dirname(fileURLToPath(import.meta.url)), "../../data", "robots");
  return process.env.FMS_TRANSFER_STATE_FILE || `${root}/robot-${robotId}.teleporter.json`;
}
function readJournal(robotId: string): TransferJournal | null {
  const path = transferJournalPath(robotId);
  return readTransferJournal(path, robotId);
}
function writeJournal(robotId: string, value: TransferJournal): void {
  const path = transferJournalPath(robotId);
  writeTransferJournal(path, value);
}

function main(): void {
  const rawRobotId = parseId(process.argv.slice(2));
  const robotId = parseGlobalId(process.argv.slice(2), rawRobotId);
  const target = parseTarget(process.argv.slice(2));
  const seed = loadSeed();
  const spawn = seed.robots.find((r) => r.id === rawRobotId);
  if (!spawn) {
    const known = seed.robots.map((r) => r.id).join(", ");
    throw new Error(`unknown robot id "${rawRobotId}" (seed has: ${known})`);
  }

  console.log(`[${robotId}] loading occupancy`);
  loadOccupancy();
  inflatedGrid();

  const journal = readJournal(robotId);
  const controller = new RobotController({
    x: spawn.x,
    y: spawn.y,
    theta: spawn.theta,
  });
  const planner = new PlanningWorkerClient();
  controller.setAsyncPlanner(planner);
  if (journal) {
    if (journal.currentMapId !== MAP_ID) commitMapContext(prepareMapContext(journal.currentMapId));
    controller.setMapPose(journal.pose);
    console.log(`[${robotId}] restored journal pose (${journal.pose.x}, ${journal.pose.y}) map=${journal.currentMapId}`);
  }
  controller.setConnectionReady(false);
  controller.start();

  let client!: GrpcClient;
  let pendingTransfer: PendingTransfer | null = journal?.pending ?? null;
  const journalTarget = journal ? `localhost:${runtimeMap(journal.currentMapId).grpcPort + Number(process.env.FMS_PORT_OFFSET || 0)}` : target;
  let hasJournal = Boolean(journal);
  let lastTransferId = journal?.lastTransferId ?? "";
  let destinationControlReady = false;
  let arrivalStarted = false;
  const maybeArrive = () => {
    if (controller.isOperatorPaused() || !destinationControlReady || !pendingTransfer || arrivalStarted) return;
    const transfer = pendingTransfer;
    arrivalStarted = true;
    // A resumed handoff already restored its last durable pose.  Reusing the
    // live pose avoids jumping back to the exit after a reconnect or restart.
    const exit = controller.snapshot();
    controller.setTeleporterArrival({ x: exit.x, y: exit.y, theta: exit.theta }, transfer.clearing, transfer.transferId);
    client.sendTeleporterTransferUpdate({ transferId: transfer.transferId, phase: "destination_ready", mapId: transfer.destinationMapId });
    client.sendTeleporterTransferUpdate({ transferId: transfer.transferId, phase: "arrived", mapId: transfer.destinationMapId });
    client.sendTeleporterTransferUpdate({ transferId: transfer.transferId, phase: "clearing", mapId: transfer.destinationMapId });
  };
  const traffic = createTrafficExecutor({
    sendLeaseRequest: (b) => client.sendLeaseRequest(b),
    sendLeaseRelease: (b) => client.sendLeaseRelease(b),
    sendTrafficBid: (z, s) => client.sendTrafficBid(z, s),
    sendTrafficStopCheck: (body) => client.sendTrafficStopCheck(body),
    sendEvasionReply: (b) => client.sendEvasionReply(b),
    onEvasionPlan: (payload) => controller.handleEvasionPlan(payload),
  });
  controller.attachTraffic(traffic);
  controller.setEvasionReplySender((b) => client.sendEvasionReply(b));
  controller.setCommandStateSender((b) => {
    client.sendCommandState(b);
    if (b.state === "completed" && pendingTransfer && b.command_id === pendingTransfer.transferId) {
      client.sendTeleporterTransferUpdate({ transferId: pendingTransfer.transferId, phase: "completed", mapId: pendingTransfer.destinationMapId });
      writeJournal(robotId, { version: 1, robotId, currentMapId: pendingTransfer.destinationMapId, pose: controller.snapshot(), lastTransferId: pendingTransfer.transferId, pending: undefined });
      pendingTransfer = null;
    }
    // Persist the terminal physical pose for ordinary commands as well.  A
    // periodic journal tick can otherwise capture an intermediate pose just
    // before the controller publishes completion.
    if (b.state === "completed" && hasJournal) {
      const pose = controller.snapshot();
      writeJournal(robotId, { version: 1, robotId, currentMapId: MAP_ID, pose: { x: pose.x, y: pose.y, theta: pose.theta }, ...(lastTransferId ? { lastTransferId } : {}), ...(pendingTransfer ? { pending: pendingTransfer } : {}) });
    }
  });

  client = new GrpcClient({
    robotId,
    target: pendingTransfer?.destinationTarget ?? journalTarget,
    transferId: pendingTransfer?.transferId ?? journal?.lastTransferId ?? "",
    getPose: () => controller.snapshot(),
    getPath: () => controller.currentPath(),
    takePathDelta: () => controller.takePathDelta(),
    getLocalPlan: () => controller.currentLocalPlan(),
    onDrive: (cmd) => controller.handleDrive(cmd),
    onCancel: (id) => controller.handleCancel(id),
    onPoseOverride: (command) => {
      // The server rejects transfers before issuing an override. Keep the
      // robot-side guard too: replacing a durable handoff would make its
      // restart journal ambiguous.
      if (pendingTransfer) {
        console.warn(`[${robotId}] rejected pose override during transfer ${pendingTransfer.transferId}`);
        return false;
      }
      if (!controller.applyOperatorPoseOverride(command)) {
        console.warn(`[${robotId}] rejected locally infeasible pose override ${command.requestId}`);
        return false;
      }
      arrivalStarted = false;
      lastTransferId = "";
      client.clearTeleporterTransferIdentity();
      hasJournal = true;
      const pose = controller.snapshot();
      // Persist before GrpcClient reports the fresh idle pose. A crash after
      // server confirmation must restore this override, never the old drive.
      writeJournal(robotId, settledPoseJournal(robotId, MAP_ID, pose));
      return true;
    },
    onPlaceQuery: (obs) => controller.canPlace(obs),
    onObstacles: (items) => controller.setObstacles(items),
    onSemanticSnapshot: (snapshot) => controller.setSemanticSnapshot(snapshot),
    onConnectionState: (ready) => {
      controller.setConnectionReady(ready);
      if (!ready) {
        destinationControlReady = false;
        // Keep the durable handoff, but allow the new control generation to
        // resume clearing after a mid-clearing reconnect.
        if (pendingTransfer) arrivalStarted = false;
      }
      maybeArrive();
    },
    onControlState: (state) => {
      controller.setControlState(state);
      if (!state.enabled) {
        // A forced operator recovery invalidates any durable handoff journal;
        // retaining it would cause a reconnect loop with the aborted transfer.
        pendingTransfer = null;
        arrivalStarted = false;
        lastTransferId = "";
        client.clearTeleporterTransferIdentity();
        if (hasJournal) {
          const pose = controller.snapshot();
          writeJournal(robotId, { version: 1, robotId, currentMapId: MAP_ID, pose });
        }
      }
    },
    onMotionPause: ({ paused }) => {
      if (paused && (pendingTransfer || arrivalStarted)) return { applied: false, reasonCode: "transfer_in_progress" };
      return controller.setOperatorPaused(paused);
    },
    onControlSynchronized: () => { destinationControlReady = true; maybeArrive(); },
    onTeleporterTransfer: (transfer) => {
      if (pendingTransfer) return;
      if (controller.isOperatorPaused()) {
        client.sendTeleporterTransferUpdate({ transferId: transfer.transferId, phase: "failed", reason: "operator paused", mapId: transfer.destinationMapId });
        return;
      }
      controller.setTeleporterTransferActive(true);
      // Read and validate the destination before dropping the source session.
      // A failed load leaves the source context untouched.
      try { commitMapContext(prepareMapContext(transfer.destinationMapId)); }
      catch (error) {
        controller.setTeleporterTransferActive(false);
        console.error(`[${robotId}] teleporter map load failed:`, error);
        client.sendTeleporterTransferUpdate({ transferId: transfer.transferId, phase: "failed", reason: "destination map load failed", mapId: transfer.destinationMapId });
        return;
      }
      controller.resetMapContext();
      controller.setMapPose(transfer.exit);
      destinationControlReady = false;
      arrivalStarted = false;
      pendingTransfer = { exit: transfer.exit, clearing: transfer.clearing, transferId: transfer.transferId, destinationTarget: transfer.destinationTarget, destinationMapId: transfer.destinationMapId };
      hasJournal = true;
      lastTransferId = transfer.transferId;
      writeJournal(robotId, { version: 1, robotId, currentMapId: transfer.destinationMapId, pose: transfer.exit, lastTransferId: transfer.transferId, pending: pendingTransfer });
      client.sendTeleporterTransferUpdate({ transferId: transfer.transferId, phase: "destination_loading", mapId: transfer.destinationMapId });
      if (transfer.destinationTarget) client.switchTarget(transfer.destinationTarget);
    },
    onTeleporterConstraints: (constraints) => controller.setTeleporterConstraints(constraints),
    onSensedPeers: (peers) => controller.setSensedPeers(peers),
    onFleetLocalPlans: (peers) => controller.setPeerLocalPlans(peers),
    onLeaseGrant: (msg) => traffic.onGrant(grantFromWire(msg)),
    onBidRequest: (zoneId, windowMs) => traffic.onBidRequest?.(zoneId, windowMs),
    onEvasionRequest: (msg) => {
      if (controller.isOperatorPaused()) {
        client.sendEvasionReply({ zone_id: msg.zone_id ?? "", round_id: msg.round_id ?? "", result: "NONE", reason: "operator_paused" });
        return;
      }
      traffic.onEvasionRequest?.(msg);
    },
    onTrafficStopStatus: (msg) => controller.onTrafficStopStatus(msg),
    onZoneUpdate: (zoneId, state) => controller.onTrafficZoneUpdate(zoneId, state),
  });
  // Planning diagnostics are emitted only after a real gRPC session/client
  // exists. The controller remains usable in isolated tests without a
  // recorder or transport, while runtime events inherit the current op ID in
  // GrpcClient.
  controller.setPlanningEventHandler((event) => client.tracePlanning(event as unknown as Record<string, unknown>));
  if (pendingTransfer) {
    try {
      commitMapContext(prepareMapContext(pendingTransfer.destinationMapId));
      controller.resetMapContext();
    } catch (error) {
      console.error(`[${robotId}] pending teleporter context load failed:`, error);
    }
  }
  client.start();
  // Keep the durable location current after a completed transfer too. This
  // prevents a later ordinary drive followed by restart from restoring the
  // stale arrival pose.
  const journalTicker = setInterval(() => {
    if (!hasJournal && !pendingTransfer) return;
    const pose = controller.snapshot();
    writeJournal(robotId, { version: 1, robotId, currentMapId: MAP_ID, pose: { x: pose.x, y: pose.y, theta: pose.theta }, ...(lastTransferId ? { lastTransferId } : {}), ...(pendingTransfer ? { pending: pendingTransfer } : {}) });
  }, 1000);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${robotId}] shutdown`);
    clearInterval(journalTicker);
    controller.stop();
    planner.close();
    try {
      // Await the recorder-backed stop so its final async flush completes
      // before the process exits. This also remains valid for the legacy
      // synchronous stop implementation during the transition.
      await client.stop();
    } catch (error) {
      console.error(`[${robotId}] shutdown flush failed:`, error);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const pose = controller.snapshot();
  console.log(
    `[${robotId}] spawn (${pose.x}, ${pose.y}, θ=${pose.theta.toFixed(3)}) → localhost:${GRPC_PORT}`,
  );
}

main();
