/**
 * v1 local-path helpers — policy-agnostic geometry.
 * Sample a ~LOOKAHEAD_S horizon, test pairwise overlap, reverse along a trail.
 */

import { LINEAR_SPEED_PX_S, LOOKAHEAD_S, TRAFFIC_SEP_PX } from "../constants.ts";
import type { LocalPlanPoint } from "./types.ts";

export type PlanPoint = LocalPlanPoint;

export function localHorizonPx(horizonS = LOOKAHEAD_S): number {
  return LINEAR_SPEED_PX_S * horizonS;
}

/** Prefix of the remaining follow-path covering about `horizonPx` of travel. */
export function sampleLocalPlan(
  path: PlanPoint[],
  pathIndex: number,
  pose: PlanPoint,
  horizonPx = localHorizonPx(),
): PlanPoint[] {
  const out: PlanPoint[] = [{ x: pose.x, y: pose.y }];
  if (!path.length || pathIndex >= path.length) return out;
  let traveled = 0;
  let px = pose.x;
  let py = pose.y;
  for (let i = Math.max(0, pathIndex); i < path.length; i++) {
    const t = path[i];
    const d = Math.hypot(t.x - px, t.y - py);
    if (d < 1e-6) continue;
    if (traveled + d > horizonPx && d > 0) {
      const u = Math.max(0, (horizonPx - traveled) / d);
      out.push({ x: px + (t.x - px) * u, y: py + (t.y - py) * u });
      break;
    }
    out.push({ x: t.x, y: t.y });
    traveled += d;
    px = t.x;
    py = t.y;
    if (traveled >= horizonPx) break;
  }
  return out;
}

function minDistPointSeg(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function minDistSegSeg(
  a1: PlanPoint,
  a2: PlanPoint,
  b1: PlanPoint,
  b2: PlanPoint,
): number {
  if (segmentsIntersect(a1, a2, b1, b2)) return 0;
  return Math.min(
    minDistPointSeg(a1.x, a1.y, b1.x, b1.y, b2.x, b2.y),
    minDistPointSeg(a2.x, a2.y, b1.x, b1.y, b2.x, b2.y),
    minDistPointSeg(b1.x, b1.y, a1.x, a1.y, a2.x, a2.y),
    minDistPointSeg(b2.x, b2.y, a1.x, a1.y, a2.x, a2.y),
  );
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function segmentsIntersect(a1: PlanPoint, a2: PlanPoint, b1: PlanPoint, b2: PlanPoint): boolean {
  const d1 = orient(b1.x, b1.y, b2.x, b2.y, a1.x, a1.y);
  const d2 = orient(b1.x, b1.y, b2.x, b2.y, a2.x, a2.y);
  const d3 = orient(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y);
  const d4 = orient(a1.x, a1.y, a2.x, a2.y, b2.x, b2.y);
  if ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) {
    if ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)) return true;
  }
  return false;
}

/** True when two polylines come closer than `sepPx`. */
export function plansOverlap(a: PlanPoint[], b: PlanPoint[], sepPx = TRAFFIC_SEP_PX): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length === 1 && b.length === 1) {
    return Math.hypot(a[0].x - b[0].x, a[0].y - b[0].y) < sepPx;
  }
  const segs = (p: PlanPoint[]) => {
    if (p.length === 1) return [[p[0], p[0]] as const];
    const out: (readonly [PlanPoint, PlanPoint])[] = [];
    for (let i = 1; i < p.length; i++) out.push([p[i - 1], p[i]]);
    return out;
  };
  const as = segs(a);
  const bs = segs(b);
  for (const [u, v] of as) {
    for (const [p, q] of bs) {
      if (minDistSegSeg(u, v, p, q) < sepPx) return true;
    }
  }
  return false;
}

export function pathLength(pts: PlanPoint[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return n;
}

/**
 * Walk `trail` (oldest → newest, last ≈ current) backwards until `distancePx`
 * of travel is accumulated. Returns a follow-path from current toward the past.
 */
export function reverseAlongTrail(
  trail: PlanPoint[],
  pose: PlanPoint,
  distancePx: number,
): PlanPoint[] {
  if (trail.length < 1 || distancePx <= 0) return [];
  const out: PlanPoint[] = [{ x: pose.x, y: pose.y }];
  let traveled = 0;
  let px = pose.x;
  let py = pose.y;
  for (let i = trail.length - 1; i >= 0; i--) {
    const t = trail[i];
    const d = Math.hypot(t.x - px, t.y - py);
    if (d < 1.5) continue;
    if (traveled + d >= distancePx) {
      const u = (distancePx - traveled) / d;
      out.push({ x: px + (t.x - px) * u, y: py + (t.y - py) * u });
      return out;
    }
    out.push({ x: t.x, y: t.y });
    traveled += d;
    px = t.x;
    py = t.y;
  }
  return out.length > 1 ? out : [];
}

/** Split a polyline into consecutive trials no longer than `stepPx`, preserving corners. */
export function splitPathIntoSteps(path: PlanPoint[], stepPx: number): PlanPoint[][] {
  if (path.length < 2 || !Number.isFinite(stepPx) || stepPx <= 0) return [];
  const steps: PlanPoint[][] = [];
  let current: PlanPoint[] = [{ ...path[0] }];
  let remaining = stepPx;
  for (let i = 1; i < path.length; i++) {
    let start = path[i - 1];
    const end = path[i];
    let segment = Math.hypot(end.x - start.x, end.y - start.y);
    if (segment < 1e-9) continue;
    while (segment >= remaining - 1e-9) {
      const u = remaining / segment;
      const split = { x: start.x + (end.x - start.x) * u, y: start.y + (end.y - start.y) * u };
      current.push(split);
      steps.push(current);
      current = [{ ...split }];
      start = split;
      segment = Math.hypot(end.x - start.x, end.y - start.y);
      remaining = stepPx;
    }
    if (segment > 1e-9) {
      current.push({ ...end });
      remaining -= segment;
    }
  }
  if (current.length > 1) steps.push(current);
  return steps;
}

/** Return the unconsumed older portion of a newest-to-oldest route. */
export function pathAfterDistance(path: PlanPoint[], distancePx: number): PlanPoint[] {
  if (path.length < 2) return [];
  let remaining = Math.max(0, distancePx);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-9) continue;
    if (remaining < length) {
      const u = remaining / length;
      return [{ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }, ...path.slice(i)];
    }
    remaining -= length;
  }
  return [];
}

/** Distance from the start of a polyline to its closest point to `pose`. */
export function distanceAlongPathToClosestPoint(path: PlanPoint[], pose: PlanPoint): number {
  let prefix = 0;
  let bestDistance = Infinity;
  let bestAlong = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    const length = Math.sqrt(length2);
    if (length < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((pose.x - a.x) * dx + (pose.y - a.y) * dy) / length2));
    const distance = Math.hypot(pose.x - (a.x + dx * t), pose.y - (a.y + dy * t));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestAlong = prefix + length * t;
    }
    prefix += length;
  }
  return bestAlong;
}

/** Distance from pose to closest point on polyline. */
export function distToPlan(pose: PlanPoint, plan: PlanPoint[]): number {
  if (!plan.length) return Infinity;
  if (plan.length === 1) return Math.hypot(pose.x - plan[0].x, pose.y - plan[0].y);
  let best = Infinity;
  for (let i = 1; i < plan.length; i++) {
    best = Math.min(best, minDistPointSeg(pose.x, pose.y, plan[i - 1].x, plan[i - 1].y, plan[i].x, plan[i].y));
  }
  return best;
}
