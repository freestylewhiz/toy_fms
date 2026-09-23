import { ROBOT_LENGTH_PX, ROBOT_WIDTH_PX } from "../../shared/constants.ts";
import type { TeleporterEndpoint, TeleporterPoint } from "../../shared/teleporterRuntime.ts";

export type WorldRobotFootprint = {
  robotId: string;
  x: number;
  y: number;
  /** Absolute body polygon from the world snapshot. */
  bodyPolygon: TeleporterPoint[];
};

const sampleStep = 4;

function footprint(x: number, y: number, theta: number): TeleporterPoint[] {
  const hx = ROBOT_LENGTH_PX / 2, hy = ROBOT_WIDTH_PX / 2;
  const c = Math.cos(theta), s = Math.sin(theta);
  return [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([px, py]) => ({
    x: x + px * c - py * s,
    y: y + px * s + py * c,
  }));
}

function orientationDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function polygonsOverlap(a: TeleporterPoint[], b: TeleporterPoint[]): boolean {
  const inside = (p: TeleporterPoint, polygon: TeleporterPoint[]) => {
    let hit = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const x = polygon[i].x, y = polygon[i].y, px = polygon[j].x, py = polygon[j].y;
      if ((y > p.y) !== (py > p.y) && p.x < (px - x) * (p.y - y) / (py - y) + x) hit = !hit;
    }
    return hit;
  };
  const cross = (a1: TeleporterPoint, a2: TeleporterPoint, b1: TeleporterPoint, b2: TeleporterPoint) => {
    const turn = (p: TeleporterPoint, q: TeleporterPoint, r: TeleporterPoint) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const on = (p: TeleporterPoint, q: TeleporterPoint, r: TeleporterPoint) => Math.abs(turn(p, q, r)) < 1e-7 && r.x >= Math.min(p.x, q.x) - 1e-7 && r.x <= Math.max(p.x, q.x) + 1e-7 && r.y >= Math.min(p.y, q.y) - 1e-7 && r.y <= Math.max(p.y, q.y) + 1e-7;
    const ab = turn(a1, a2, b1), ac = turn(a1, a2, b2), ba = turn(b1, b2, a1), bc = turn(b1, b2, a2);
    return ab * ac < 0 && ba * bc < 0 || on(a1, a2, b1) || on(a1, a2, b2) || on(b1, b2, a1) || on(b1, b2, a2);
  };
  if (a.some(p => inside(p, b)) || b.some(p => inside(p, a))) return true;
  return a.some((p, i) => b.some((q, j) => cross(p, a[(i + 1) % a.length], q, b[(j + 1) % b.length])));
}

/** Conservative full-footprint overlap test reused by simulator pose placement. */
export function poseOverlapsRobotBodies(
  pose: { x: number; y: number; theta: number },
  worldRobots: readonly WorldRobotFootprint[],
  excludeRobotId?: string,
): boolean {
  const body = footprint(pose.x, pose.y, pose.theta);
  return worldRobots.some(robot => robot.robotId !== excludeRobotId &&
    (!Array.isArray(robot.bodyPolygon) || robot.bodyPolygon.length < 3 || polygonsOverlap(body, robot.bodyPolygon)));
}

/** Checks every <=4px pose on the endpoint-to-clearing path. */
export function endpointClearingPathBlocked(endpoint: TeleporterEndpoint, worldRobots: readonly WorldRobotFootprint[], excludeRobotId?: string): boolean {
  // A malformed world snapshot cannot prove the path is clear. The caller
  // still decides whether a stale source owner is filtered before this call.
  if (worldRobots.some(robot => robot.robotId !== excludeRobotId && (!Array.isArray(robot.bodyPolygon) || robot.bodyPolygon.length < 3))) return true;
  const dx = endpoint.clearingPoint.x - endpoint.position.x;
  const dy = endpoint.clearingPoint.y - endpoint.position.y;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / sampleStep));
  const travelHeading = Math.atan2(dy, dx);
  const check = (x: number, y: number, theta: number) => poseOverlapsRobotBodies({ x, y, theta }, worldRobots, excludeRobotId);
  const rotationSamples = (from: number, to: number, x: number, y: number) => {
    const delta = orientationDelta(from, to);
    for (let i = 0; i <= Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 12))); i++) if (check(x, y, from + delta * i / Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 12))))) return true;
    return false;
  };
  if (rotationSamples(endpoint.exitTheta, travelHeading, endpoint.position.x, endpoint.position.y)) return true;
  for (let i = 0; i <= steps; i++) if (check(endpoint.position.x + dx * i / steps, endpoint.position.y + dy * i / steps, travelHeading)) return true;
  if (rotationSamples(travelHeading, endpoint.exitTheta, endpoint.clearingPoint.x, endpoint.clearingPoint.y)) return true;
  return false;
}
