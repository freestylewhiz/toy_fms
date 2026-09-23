import { readFileSync } from "node:fs";

type Point = { x: number; y: number };
type Snapshot = {
  state: {
    mapId?: string;
    robots: Record<string, any>;
    obstacles: Record<string, any>;
    zones: Record<string, any>;
  };
};

const inputPath = process.env.FMS_STALL_SNAPSHOT ?? "/tmp/fms-robot1-stuck-current.json";
const outputPath = process.env.FMS_STALL_REPRO_OUT ?? "/tmp/fms-stuck-controller-repro-fixed.json";
const ticks = Math.max(1, Number(process.env.FMS_STALL_TICKS ?? 120));
const captured = JSON.parse(readFileSync(inputPath, "utf8")) as Snapshot;
const state = captured.state;
const robot = state.robots["robot-1"];
if (!robot) throw new Error("snapshot does not contain robot-1");

// Set the map before loading controller/planner modules. This process only
// replays a snapshot and never attaches a transport or sends a robot command.
process.env.FMS_MAP_ID = String(state.mapId ?? "large_lab");
const { RobotController } = await import("../virtual-robot/src/controller.ts");
const { LocalPlanExecutor } = await import("../virtual-robot/src/traffic/LocalPlanExecutor.ts");
const { poseHitsAny } = await import("../shared/obstacles.ts");
const { PEER_OBSTACLE_RADIUS_PX } = await import("../shared/constants.ts");

const zones = Object.values(state.zones ?? {}).map((raw: any) => ({
  ...raw,
  ...JSON.parse(raw.paramsJson ?? "{}"),
  polygon: JSON.parse(raw.polygonJson),
}));
const obstacles = Object.values(state.obstacles ?? {}).map((raw: any) => ({
  id: String(raw.id),
  kind: raw.kind,
  x: Number(raw.x),
  y: Number(raw.y),
  size: Number(raw.size),
  theta: Number(raw.theta ?? 0),
}));
const recordedPath = (robot.localPath ?? []).map((point: Point) => ({ x: Number(point.x), y: Number(point.y) }));
const goalPath = (robot.path ?? []).map((point: Point) => ({ x: Number(point.x), y: Number(point.y) }));
const goalPoint: Point = goalPath.at(-1) ?? recordedPath.at(-1) ?? { x: Number(robot.x), y: Number(robot.y) };
const command = { command_id: `snapshot-repro-${robot.commandId ?? "stuck"}`, kind: "move", x: goalPoint.x, y: goalPoint.y, theta: 0 };
const peer = state.robots["robot-2"];
const peerPlans = peer ? [{
  robotId: "robot-2",
  x: Number(peer.x),
  y: Number(peer.y),
  theta: Number(peer.theta),
  points: (peer.localPath ?? []).map((point: Point) => ({ x: Number(point.x), y: Number(point.y) })),
}] : [];
const peerSafetyObstacles = peer ? [
  {
    id: "peer:robot-2",
    kind: "circle",
    x: Number(peer.x),
    y: Number(peer.y),
    size: PEER_OBSTACLE_RADIUS_PX,
    theta: Number(peer.theta ?? 0),
  },
  ...((peer.localPath?.length ? peer.localPath : [{ x: peer.x, y: peer.y }]) as Point[])
    .filter((_, index) => index % 2 === 0)
    .map((point, index) => ({
      id: `peerplan:robot-2:${index * 2}`,
      kind: "circle",
      x: Number(point.x),
      y: Number(point.y),
      size: PEER_OBSTACLE_RADIUS_PX,
      theta: 0,
    })),
] : [];
const safetyObstacles = [...obstacles, ...peerSafetyObstacles];
const makeController = (events: any[] = []) => {
  const controller = new RobotController({ x: Number(robot.x), y: Number(robot.y), theta: Number(robot.theta) });
  controller.attachTraffic(new LocalPlanExecutor({ sendLeaseRequest: () => {}, sendLeaseRelease: () => {} }));
  controller.setPlanningEventHandler((event) => events.push(event));
  controller.setSemanticSnapshot({ zones: zones as any, obstacles: obstacles as any });
  controller.setPeerLocalPlans(peerPlans);
  return controller;
};

function routeSafe(points: Point[]): boolean {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const heading = distance > 1e-9 ? Math.atan2(b.y - a.y, b.x - a.x) : 0;
    const steps = Math.max(1, Math.ceil(distance));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      if (poseHitsAny(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, heading, safetyObstacles as any)) return false;
    }
  }
  return true;
}

// First let the current controller/planner stack generate a fresh route and
// run it for the same isolated tick budget. This is the new-route safety and
// progress check; no transport is attached.
const plannedEvents: any[] = [];
const plannedController = makeController(plannedEvents);
plannedController.handleDrive(command);
const plannedBefore = plannedController.snapshot();
const plannedPath = plannedController.currentPath();
const plannedSamples = [plannedBefore];
for (let i = 0; i < ticks; i++) {
  (plannedController as any).tick();
  plannedSamples.push(plannedController.snapshot());
}
const plannedAfter = plannedController.snapshot();

// Separately replay the exact local path reported by the snapshot. This
// isolates old-path HOLD/replan behavior from a new planner result while
// retaining the captured pose, obstacle geometry, and goal.
const replayEvents: any[] = [];
const controller = makeController(replayEvents);
controller.handleDrive(command);

// Replay the exact local path reported by the snapshot. This isolates the
// controller's HOLD/replan behavior from a new planner result while retaining
// the captured pose, obstacle geometry, and goal.
const internal = controller as any;
if (recordedPath.length > 1) {
  internal.goal = command;
  internal.lastCommandId = command.command_id;
  internal.commandState = "running";
  internal.commandReason = "snapshot-replay";
  internal.path = recordedPath.slice(1);
  internal.displayPath = recordedPath.slice(1);
  internal.pathIndex = 0;
  internal.pathInvalidated = false;
  internal.phase = "follow";
  internal.status = "move";
}

const before = controller.snapshot();
const samples = [before];
for (let i = 0; i < ticks; i++) {
  internal.tick();
  samples.push(controller.snapshot());
}
const after = samples.at(-1)!;
const replayPoseSafe = samples.every((sample) => !poseHitsAny(sample.x, sample.y, sample.theta, safetyObstacles as any));
const newRoutePoseSafe = plannedSamples.every((sample) => !poseHitsAny(sample.x, sample.y, sample.theta, safetyObstacles as any));
const replayFirstHoldTick = samples.findIndex((sample) => sample.motion === "HOLD");
const replayProgress = Math.hypot(after.x - before.x, after.y - before.y);
const replayCurrentRouteSafe = routeSafe(controller.currentPath());
const replayRequests = replayEvents.filter((event) => event.phase === "requested").length;
const replayBlockedReplan = replayEvents.some((event) => event.reason === "obstacle-retry");
const result = {
  inputPath,
  mapId: state.mapId,
  ticks,
  command,
  obstacleCount: obstacles.length,
  peerSafetyObstacleCount: peerSafetyObstacles.length,
  recordedPathPoints: recordedPath.length,
  before: { x: before.x, y: before.y, theta: before.theta, motion: before.motion, driveState: before.driveState },
  after: { x: after.x, y: after.y, theta: after.theta, motion: after.motion, driveState: after.driveState, commandId: after.commandId, commandState: after.commandState },
  translationPx: Math.hypot(after.x - before.x, after.y - before.y),
  rotationRad: Math.abs(after.theta - before.theta),
  pathRetained: controller.currentPath().length > 0,
  newRoute: {
    pathPoints: plannedPath.length,
    before: { x: plannedBefore.x, y: plannedBefore.y, motion: plannedBefore.motion, driveState: plannedBefore.driveState },
    after: { x: plannedAfter.x, y: plannedAfter.y, motion: plannedAfter.motion, driveState: plannedAfter.driveState },
    translationPx: Math.hypot(plannedAfter.x - plannedBefore.x, plannedAfter.y - plannedBefore.y),
    commandId: plannedAfter.commandId,
    commandState: plannedAfter.commandState,
    routeSafe: routeSafe(plannedPath),
    poseSafe: newRoutePoseSafe,
    progress: Math.hypot(plannedAfter.x - plannedBefore.x, plannedAfter.y - plannedBefore.y),
  },
  replaySafety: {
    recordedRouteSafe: routeSafe(recordedPath),
    currentRouteSafe: replayCurrentRouteSafe,
    poseSafe: replayPoseSafe,
    firstHoldTick: replayFirstHoldTick,
    blockedReplanRequested: replayBlockedReplan,
    replannedAfterBlockedPath: replayBlockedReplan && replayCurrentRouteSafe,
    commandRetained: after.commandId === command.command_id,
    requestedPlans: replayRequests,
    bounded: replayRequests <= 4,
  },
  pass: plannedPath.length > 0 && plannedAfter.commandId === command.command_id && plannedAfter.commandState === "running" && Math.hypot(plannedAfter.x - plannedBefore.x, plannedAfter.y - plannedBefore.y) > 0 && routeSafe(plannedPath) && newRoutePoseSafe && !routeSafe(recordedPath) && replayCurrentRouteSafe && replayBlockedReplan && replayProgress > 0 && after.commandId === command.command_id && replayPoseSafe && replayRequests <= 4,
  samples: samples.filter((_, index) => index === 0 || index === samples.length - 1 || index % 20 === 0).map((sample) => ({
    x: sample.x,
    y: sample.y,
    theta: sample.theta,
    motion: sample.motion,
    driveState: sample.driveState,
    commandId: sample.commandId,
  })),
};
await Bun.write(outputPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
