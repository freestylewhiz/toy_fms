import {
  CAPSULE_FIT_TOL_PX,
  CORRIDOR_GAP_PX,
  CORRIDOR_MAX_RADIUS,
  CORRIDOR_MIN_RADIUS,
  ROBOT_LENGTH_PX,
  ROBOT_WIDTH_PX,
} from "./constants.ts";
import { robotSamplePoints } from "./obstacles.ts";

/** Stadium / capsule: points within `r` of segment (x1,y1)-(x2,y2). */
export type Capsule = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  r: number;
};

export type Corridor = { segments: Capsule[] };
export type Point = { x: number; y: number };

export function clampCorridorRadius(r: number): number {
  if (!Number.isFinite(r)) return CORRIDOR_MIN_RADIUS;
  return Math.min(CORRIDOR_MAX_RADIUS, Math.max(CORRIDOR_MIN_RADIUS, r));
}

export function distPointSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

export function pointInCapsule(px: number, py: number, c: Capsule): boolean {
  return distPointSegment(px, py, c.x1, c.y1, c.x2, c.y2) <= c.r;
}

function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}

/** Shortest distance between two line segments. */
export function segSegDistance(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const cdx = dx - cx;
  const cdy = dy - cy;
  const acx = ax - cx;
  const acy = ay - cy;
  const ab2 = abx * abx + aby * aby;
  const cd2 = cdx * cdx + cdy * cdy;
  const abcd = abx * cdx + aby * cdy;

  let s: number;
  let t: number;
  if (ab2 < 1e-12 && cd2 < 1e-12) {
    return Math.hypot(ax - cx, ay - cy);
  }
  if (ab2 < 1e-12) {
    t = clamp01(-(acx * cdx + acy * cdy) / cd2);
    return Math.hypot(ax - (cx + t * cdx), ay - (cy + t * cdy));
  }
  if (cd2 < 1e-12) {
    s = clamp01((acx * abx + acy * aby) / ab2);
    return Math.hypot(cx - (ax + s * abx), cy - (ay + s * aby));
  }

  const denom = ab2 * cd2 - abcd * abcd;
  if (Math.abs(denom) < 1e-12) {
    // Parallel — fall back to endpoint distances.
    return Math.min(
      distPointSegment(ax, ay, cx, cy, dx, dy),
      distPointSegment(bx, by, cx, cy, dx, dy),
      distPointSegment(cx, cy, ax, ay, bx, by),
      distPointSegment(dx, dy, ax, ay, bx, by),
    );
  }
  s = clamp01((abcd * (acx * cdx + acy * cdy) - cd2 * (acx * abx + acy * aby)) / denom);
  t = clamp01((abcd * s + (acx * cdx + acy * cdy)) / cd2);
  // Re-clamp s after t clamp for endpoints.
  s = clamp01((abcd * t - (acx * abx + acy * aby)) / ab2);
  return Math.hypot(ax + s * abx - (cx + t * cdx), ay + s * aby - (cy + t * cdy));
}

export function capsulesDisjoint(a: Capsule, b: Capsule, gap = CORRIDOR_GAP_PX): boolean {
  return (
    segSegDistance(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1, b.x2, b.y2) > a.r + b.r + gap
  );
}

export function corridorsDisjoint(a: Corridor, b: Corridor, gap = CORRIDOR_GAP_PX): boolean {
  for (const sa of a.segments) {
    for (const sb of b.segments) {
      if (!capsulesDisjoint(sa, sb, gap)) return false;
    }
  }
  return true;
}

function maxDeviation(pts: Point[], a: number, b: number): number {
  if (b - a < 2) return 0;
  const ax = pts[a].x;
  const ay = pts[a].y;
  const bx = pts[b].x;
  const by = pts[b].y;
  let best = 0;
  for (let i = a + 1; i < b; i++) {
    best = Math.max(best, distPointSegment(pts[i].x, pts[i].y, ax, ay, bx, by));
  }
  return best;
}

/** Collapse nearly-collinear polyline into stadium capsules. Adds fit tol into radius. */
export function chainCapsules(
  pts: Point[],
  r: number,
  tol = CAPSULE_FIT_TOL_PX,
): Capsule[] {
  if (pts.length === 0) return [];
  const radius = clampCorridorRadius(r) + tol;
  if (pts.length === 1) {
    return [{ x1: pts[0].x, y1: pts[0].y, x2: pts[0].x, y2: pts[0].y, r: radius }];
  }
  const out: Capsule[] = [];
  let a = 0;
  for (let b = 2; b <= pts.length; b++) {
    if (b === pts.length || maxDeviation(pts, a, b) > tol) {
      const p0 = pts[a];
      const p1 = pts[b - 1];
      out.push({ x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, r: radius });
      a = b - 1;
    }
  }
  return out;
}

/** Sample path ahead of `startIndex` up to `horizonPx` arc length. */
export function samplePathAhead(
  path: Point[],
  startIndex: number,
  start: Point,
  horizonPx: number,
): Point[] {
  const out: Point[] = [{ x: start.x, y: start.y }];
  let traveled = 0;
  let px = start.x;
  let py = start.y;
  for (let i = Math.max(0, startIndex); i < path.length; i++) {
    const t = path[i];
    const d = Math.hypot(t.x - px, t.y - py);
    if (d < 1e-6) continue;
    if (traveled + d >= horizonPx) {
      const u = (horizonPx - traveled) / d;
      out.push({ x: px + (t.x - px) * u, y: py + (t.y - py) * u });
      return out;
    }
    out.push({ x: t.x, y: t.y });
    traveled += d;
    px = t.x;
    py = t.y;
  }
  return out;
}

export function corridorContainsFootprint(
  corridor: Corridor,
  x: number,
  y: number,
  theta: number,
): boolean {
  if (corridor.segments.length === 0) return false;
  for (const [sx, sy] of robotSamplePoints(x, y, theta)) {
    if (!corridor.segments.some((c) => pointInCapsule(sx, sy, c))) return false;
  }
  return true;
}

/** Approximate remaining travel distance still covered by corridor along path. */
export function headRoomAlongPath(
  corridor: Corridor,
  path: Point[],
  startIndex: number,
  start: Point,
  theta: number,
): number {
  if (!corridorContainsFootprint(corridor, start.x, start.y, theta)) return 0;
  let traveled = 0;
  let px = start.x;
  let py = start.y;
  let heading = theta;
  for (let i = Math.max(0, startIndex); i < path.length; i++) {
    const t = path[i];
    const d = Math.hypot(t.x - px, t.y - py);
    const steps = Math.max(1, Math.ceil(d / 4));
    for (let s = 1; s <= steps; s++) {
      const u = s / steps;
      const x = px + (t.x - px) * u;
      const y = py + (t.y - py) * u;
      heading = d < 1e-6 ? heading : Math.atan2(t.y - py, t.x - px);
      if (!corridorContainsFootprint(corridor, x, y, heading)) return traveled;
      traveled += d / steps;
    }
    px = t.x;
    py = t.y;
  }
  return traveled;
}

export function footprintAabb(x: number, y: number, theta: number): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const pts = robotSamplePoints(x, y, theta);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of pts) {
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  return { minX, minY, maxX, maxY };
}

/** Keep segment length for UI / progress epsilon checks. */
export function capsuleLength(c: Capsule): number {
  return Math.hypot(c.x2 - c.x1, c.y2 - c.y1);
}

export function robotHalfExtents(): { hl: number; hw: number } {
  return { hl: ROBOT_LENGTH_PX / 2, hw: ROBOT_WIDTH_PX / 2 };
}
