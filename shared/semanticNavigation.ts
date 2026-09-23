import {
  LINEAR_SPEED_PX_S,
  MAP_HEIGHT,
  MAP_WIDTH,
  PIXEL_CM,
  ROBOT_CIRCUMRADIUS_PX,
  SEMANTIC_NAVIGATION_GRID_CELL_LIMIT,
  SOFT_ZONE_AVOID_EDGE_WEIGHT,
  SOFT_ZONE_CENTER_DEPTH_PX,
  SOFT_ZONE_EFFECTIVE_RADIUS_PX,
} from "./constants.ts";
import type { Point, ZoneResource } from "./semantic.ts";

type Bounds = { x0: number; x1: number; y0: number; y1: number };
type PreparedZone = {
  zone: ZoneResource;
  hard: boolean;
  preferred: boolean;
  avoided: boolean;
  factor: number;
  bounds: Bounds;
  /** Gradient scale from the shortest axis-aligned span; conservative for arbitrary polygons. */
  centerDepth: number;
};

export type SemanticNavigation = {
  blocked: Uint8Array | null;
  costs: Float32Array | null;
  minimumCost: number;
  /** Used instead of a full-size grid on large maps. */
  isBlocked?: (point: Point) => boolean;
  /** Used instead of a full-size grid on large maps. */
  costAt?: (point: Point) => number;
};

export type SemanticNavigationDimensions = { width: number; height: number };

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

/**
 * Positive inside, negative outside. This is the point-to-boundary distance;
 * callers account for the robot envelope with SOFT_ZONE_EFFECTIVE_RADIUS_PX.
 */
export function signedDistanceToZoneBoundary(point: Point, polygon: Point[]): number {
  if (polygon.length < 3) return -Infinity;
  let nearest = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    nearest = Math.min(nearest, segmentDistance(point, polygon[i], polygon[(i + 1) % polygon.length]));
  }
  return pointInPolygon(point, polygon) ? nearest : -nearest;
}

export function zoneTouchesPoint(zone: Pick<ZoneResource, "polygon">, point: Point, radius = ROBOT_CIRCUMRADIUS_PX): boolean {
  if (zone.polygon.length < 3) return false;
  if (pointInPolygon(point, zone.polygon)) return true;
  return zone.polygon.some((a, i) => segmentDistance(point, a, zone.polygon[(i + 1) % zone.polygon.length]) <= radius);
}

export function isSemanticPoseBlocked(zones: ZoneResource[], point: Point): boolean {
  return zones.some(z => (z.kind === "forbidden" || z.kind === "blocked") && zoneTouchesPoint(z, point));
}

function smoothStep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function zoneBounds(polygon: Point[], padding: number): Bounds {
  return {
    x0: Math.min(...polygon.map((p) => p.x)) - padding,
    x1: Math.max(...polygon.map((p) => p.x)) + padding,
    y0: Math.min(...polygon.map((p) => p.y)) - padding,
    y1: Math.max(...polygon.map((p) => p.y)) + padding,
  };
}

function contains(bounds: Bounds, point: Point): boolean {
  return point.x >= bounds.x0 && point.x <= bounds.x1 && point.y >= bounds.y0 && point.y <= bounds.y1;
}

function prepareZone(zone: ZoneResource): PreparedZone | null {
  if (zone.polygon.length < 3 || zone.polygon.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  const hard = zone.kind === "forbidden" || zone.kind === "blocked";
  const preferred = zone.kind === "prefer" || zone.kind === "priority";
  const avoided = zone.kind === "avoid" || zone.kind === "penalty";
  if (!hard && !preferred && !avoided) return null;
  const rawFactor = preferred ? zone.factor ?? 0.4 : zone.factor ?? 3;
  if (!hard && !Number.isFinite(rawFactor)) return null;
  const factor = preferred ? Math.max(0.05, Math.min(1, rawFactor)) : Math.max(1, Math.min(100, rawFactor));
  const rawBounds = zoneBounds(zone.polygon, 0);
  const padding = hard
    ? ROBOT_CIRCUMRADIUS_PX + Math.SQRT1_2 // preserve the existing rounded-cell hard margin
    : avoided ? SOFT_ZONE_EFFECTIVE_RADIUS_PX : 0;
  const centerDepth = Math.max(
    SOFT_ZONE_CENTER_DEPTH_PX,
    Math.min(rawBounds.x1 - rawBounds.x0, rawBounds.y1 - rawBounds.y0) / 2,
  );
  return { zone, hard, preferred, avoided, factor, bounds: zoneBounds(zone.polygon, padding), centerDepth };
}

/**
 * A continuous, body-aware multiplier for one soft zone. Prefer rewards only
 * usable interior clearance; avoid gives a light edge buffer and grows toward
 * the interior. This lets a narrow prefer zone remain passable without making
 * its center a mandatory lane.
 */
function softZoneMultiplier(prepared: PreparedZone, point: Point): number {
  if (!contains(prepared.bounds, point)) return 1;
  const signed = signedDistanceToZoneBoundary(point, prepared.zone.polygon);
  if (prepared.preferred) {
    if (signed <= SOFT_ZONE_EFFECTIVE_RADIUS_PX) return 1;
    const centerWeight = smoothStep(
      (signed - SOFT_ZONE_EFFECTIVE_RADIUS_PX) /
      Math.max(1, prepared.centerDepth - SOFT_ZONE_EFFECTIVE_RADIUS_PX),
    );
    return 1 - (1 - prepared.factor) * centerWeight;
  }

  // The outer band is measured from the body envelope rather than treating a
  // center point on the polygon edge as safe. It is intentionally weaker than
  // deep use so an unavoidable edge crossing stays feasible.
  const influence = signed < 0
    // Outside: taper the small boundary buffer to zero one body-envelope
    // radius away from the zone.
    ? SOFT_ZONE_AVOID_EDGE_WEIGHT * smoothStep(
      (SOFT_ZONE_EFFECTIVE_RADIUS_PX + signed) / SOFT_ZONE_EFFECTIVE_RADIUS_PX,
    )
    // Inside: continue upward from the boundary band. Never create a cheap
    // contour just inside the edge, which would reproduce boundary hugging.
    : SOFT_ZONE_AVOID_EDGE_WEIGHT + (1 - SOFT_ZONE_AVOID_EDGE_WEIGHT) * smoothStep(
      signed / prepared.centerDepth,
    );
  return 1 + (prepared.factor - 1) * influence;
}

function softCostAt(zones: PreparedZone[], point: Point): number {
  let cost = 1;
  for (const zone of zones) cost = Math.max(0.05, Math.min(100, cost * softZoneMultiplier(zone, point)));
  return cost;
}

/**
 * Rasterize normal maps for fast A*. On maps larger than the configured cell
 * limit, retain only compact zone geometry and evaluate the same field lazily.
 * This avoids a 100M-cell Float32 cost allocation while leaving hard zones as
 * hard exclusions.
 */
export function buildSemanticNavigation(
  zones: ZoneResource[],
  dimensions: SemanticNavigationDimensions = { width: MAP_WIDTH, height: MAP_HEIGHT },
): SemanticNavigation {
  const prepared = zones.map(prepareZone).filter((zone): zone is PreparedZone => zone !== null);
  const hardZones = prepared.filter((zone) => zone.hard);
  const softZones = prepared.filter((zone) => zone.preferred || zone.avoided);
  const cells = dimensions.width * dimensions.height;
  const useGrid = Number.isSafeInteger(cells) && cells > 0 && cells <= SEMANTIC_NAVIGATION_GRID_CELL_LIMIT;
  const hardBlocked = hardZones.length
    ? (point: Point) => hardZones.some((zone) => zoneTouchesPoint(zone.zone, point, ROBOT_CIRCUMRADIUS_PX + Math.SQRT1_2))
    : undefined;
  const costAt = softZones.length ? (point: Point) => softCostAt(softZones, point) : undefined;

  if (!useGrid) {
    // Prefer multipliers form a conservative heuristic lower bound. A looser
    // bound costs a little search time but never changes route optimality.
    const minimumCost = Math.max(0.05, softZones.filter((zone) => zone.preferred)
      .reduce((minimum, zone) => minimum * zone.factor, 1));
    return { blocked: null, costs: null, minimumCost, isBlocked: hardBlocked, costAt };
  }

  const blocked: Uint8Array | null = hardZones.length ? new Uint8Array(cells) : null;
  const costs: Float32Array | null = softZones.length ? new Float32Array(cells).fill(1) : null;
  for (const zone of hardZones) {
    const x0 = Math.max(0, Math.floor(zone.bounds.x0));
    const x1 = Math.min(dimensions.width - 1, Math.ceil(zone.bounds.x1));
    const y0 = Math.max(0, Math.floor(zone.bounds.y0));
    const y1 = Math.min(dimensions.height - 1, Math.ceil(zone.bounds.y1));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (hardBlocked!({ x, y })) blocked![y * dimensions.width + x] = 1;
    }
  }
  for (const zone of softZones) {
    const x0 = Math.max(0, Math.floor(zone.bounds.x0));
    const x1 = Math.min(dimensions.width - 1, Math.ceil(zone.bounds.x1));
    const y0 = Math.max(0, Math.floor(zone.bounds.y0));
    const y1 = Math.min(dimensions.height - 1, Math.ceil(zone.bounds.y1));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const k = y * dimensions.width + x;
      costs![k] = Math.max(0.05, Math.min(100, costs![k] * softZoneMultiplier(zone, { x, y })));
    }
  }
  let minimumCost = 1;
  if (costs) for (const cost of costs) minimumCost = Math.min(minimumCost, cost);
  return { blocked, costs, minimumCost, isBlocked: hardBlocked, costAt };
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
