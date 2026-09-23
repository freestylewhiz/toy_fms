import type { Point } from "../../shared/semantic.ts";
import type { Snapshot } from "./snapshot.ts";

export type PoseCandidate = { robotId?: string; x: number; y: number; theta: number };

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distance(a: Point, b: Point): number { return Math.hypot(a.x - b.x, a.y - b.y); }

/** Conservative operator preview for the virtual robot's 16×10px body. */
export function poseConflicts(
  pose: PoseCandidate,
  snapshot: Snapshot,
  mapWidth: number,
  mapHeight: number,
  isFree: (x: number, y: number) => boolean,
): string[] {
  const reasons: string[] = [];
  const bodyRadius = 9.43;
  if (pose.x < bodyRadius || pose.y < bodyRadius || pose.x > mapWidth - bodyRadius || pose.y > mapHeight - bodyRadius) reasons.push("맵 경계");
  for (const sample of [{ x: pose.x, y: pose.y }, { x: pose.x + bodyRadius, y: pose.y }, { x: pose.x - bodyRadius, y: pose.y }, { x: pose.x, y: pose.y + bodyRadius }, { x: pose.x, y: pose.y - bodyRadius }]) {
    if (!isFree(sample.x, sample.y)) { reasons.push("정적 장애물"); break; }
  }
  if (snapshot.obstacles.some(obstacle => distance(pose, obstacle) <= bodyRadius + obstacle.size)) reasons.push("장애물 리소스");
  if (snapshot.zones.some(zone => (zone.kind === "blocked" || zone.kind === "forbidden") && pointInPolygon(pose, zone.polygon))) reasons.push("하드 존");
  if (snapshot.teleporters.some(teleporter => teleporter.endpoints.some(endpoint => {
    if (endpoint.mapId !== snapshot.mapId) return false;
    const polygon = endpoint.occupancyPolygon.map(point => ({ x: point.x + endpoint.x, y: point.y + endpoint.y }));
    return pointInPolygon(pose, polygon);
  }))) reasons.push("텔레포터 점유 영역");
  if (snapshot.robots.some(robot => robot.id !== pose.robotId && distance(pose, robot) < bodyRadius * 2)) reasons.push("다른 로봇 본체");
  return [...new Set(reasons)];
}
