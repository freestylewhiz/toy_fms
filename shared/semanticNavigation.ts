import { LINEAR_SPEED_PX_S, MAP_HEIGHT, MAP_WIDTH, PIXEL_CM, ROBOT_CIRCUMRADIUS_PX } from "./constants.ts";
import type { Point, ZoneResource } from "./semantic.ts";

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t = length2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Polygon boundaries count as inside. Coordinates are map pixels. */
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if (segmentDistance(point, a, b) < 1e-8) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function zoneTouchesPoint(zone: Pick<ZoneResource, "polygon">, point: Point, radius = ROBOT_CIRCUMRADIUS_PX): boolean {
  if (zone.polygon.length < 3) return false;
  if (pointInPolygon(point, zone.polygon)) return true;
  return zone.polygon.some((a, i) => segmentDistance(point, a, zone.polygon[(i + 1) % zone.polygon.length]) <= radius);
}

export function isSemanticPoseBlocked(zones: ZoneResource[], point: Point): boolean {
  return zones.some(z => (z.kind === "forbidden" || z.kind === "blocked") && zoneTouchesPoint(z, point));
}

/** Cost multipliers combine multiplicatively; hard exclusions always take precedence. */
export function buildSemanticNavigation(zones: ZoneResource[]): { blocked: Uint8Array | null; costs: Float32Array | null; minimumCost: number } {
  let blocked: Uint8Array | null = null;
  let costs: Float32Array | null = null;
  for (const zone of zones) {
    if (zone.polygon.length < 3 || zone.polygon.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) continue;
    const hard = zone.kind === "forbidden" || zone.kind === "blocked";
    const preferred = zone.kind === "prefer" || zone.kind === "priority";
    const avoided = zone.kind === "avoid" || zone.kind === "penalty";
    if (!hard && !preferred && !avoided) continue;
    const factor = preferred ? Math.max(0.05, Math.min(1, zone.factor ?? 0.4)) : Math.max(1, Math.min(100, zone.factor ?? 3));
    if (!hard && !Number.isFinite(factor)) continue;
    if (hard) blocked ??= new Uint8Array(MAP_WIDTH * MAP_HEIGHT);
    else costs ??= new Float32Array(MAP_WIDTH * MAP_HEIGHT).fill(1);
    // Half-pixel margin covers rounding of continuous poses to grid cells.
    const radius = hard ? ROBOT_CIRCUMRADIUS_PX + Math.SQRT1_2 : 0;
    const x0 = Math.max(0, Math.floor(Math.min(...zone.polygon.map(p => p.x)) - radius));
    const x1 = Math.min(MAP_WIDTH - 1, Math.ceil(Math.max(...zone.polygon.map(p => p.x)) + radius));
    const y0 = Math.max(0, Math.floor(Math.min(...zone.polygon.map(p => p.y)) - radius));
    const y1 = Math.min(MAP_HEIGHT - 1, Math.ceil(Math.max(...zone.polygon.map(p => p.y)) + radius));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (!zoneTouchesPoint(zone, { x, y }, radius)) continue;
      const k = y * MAP_WIDTH + x;
      if (hard) blocked![k] = 1;
      else costs![k] = Math.max(0.05, Math.min(100, costs![k] * factor));
    }
  }
  let minimumCost = 1;
  if (costs) for (const cost of costs) minimumCost = Math.min(minimumCost, cost);
  return { blocked, costs, minimumCost };
}

/** maximumSpeed is m/s in the editor; controller velocities are px/s. */
export function speedLimitAt(zones: ZoneResource[], point: Point): number {
  let limit = LINEAR_SPEED_PX_S;
  for (const zone of zones) {
    if (zone.kind === "speed_limit" && Number.isFinite(zone.maximumSpeed) && zone.maximumSpeed! > 0 && zoneTouchesPoint(zone, point)) {
      limit = Math.min(limit, zone.maximumSpeed! * 100 / PIXEL_CM);
    }
  }
  return limit;
}
