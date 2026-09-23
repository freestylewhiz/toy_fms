import { PIXEL_CM } from "../constants.ts";
import type { Point } from "../planner.ts";

/** Peer detours may add at most 30%, with a 1m floor and 5m ceiling. */
export const DETOUR_BUDGET_RATIO = 0.3;
export const DETOUR_BUDGET_MIN_M = 1;
export const DETOUR_BUDGET_MAX_M = 5;

export type DetourBudgetResult = {
  available: true;
  baselineLengthM: number;
  candidateLengthM: number;
  allowedLengthM: number;
  accepted: boolean;
} | {
  available: false;
  baselineLengthM: null;
  candidateLengthM: number | null;
  allowedLengthM: null;
  accepted: false;
};

export type PolylineProjection = { point: Point; progressPx: number; distancePx: number; segmentIndex: number };

function finitePoint(p: Point): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

export function projectPointOnPolyline(points: Point[], pose: Point, minProgressPx = 0, preferredProgressPx = minProgressPx): PolylineProjection | null {
  if (points.length < 2 || !finitePoint(pose) || points.some((p) => !finitePoint(p))) return null;
  let best: PolylineProjection | null = null;
  let traversed = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) continue;
    const segmentStartProgress = traversed;
    const segmentEndProgress = traversed + length;
    if (segmentEndProgress + 1e-6 < minProgressPx) { traversed = segmentEndProgress; continue; }
    const projectedT = ((pose.x - a.x) * dx + (pose.y - a.y) * dy) / (length * length);
    const minT = Math.max(0, (minProgressPx - segmentStartProgress) / length);
    const t = Math.max(minT, Math.min(1, projectedT));
    const progressPx = traversed + length * t;
    const projected = { x: a.x + dx * t, y: a.y + dy * t };
    const distancePx = Math.hypot(pose.x - projected.x, pose.y - projected.y);
    if (progressPx + 1e-6 >= minProgressPx && (!best || distancePx < best.distancePx - 1e-6 ||
      (Math.abs(distancePx - best.distancePx) <= 1e-6 && Math.abs(progressPx - preferredProgressPx) < Math.abs(best.progressPx - preferredProgressPx)))) {
      best = { point: projected, progressPx, distancePx, segmentIndex: i };
    }
    traversed += length;
  }
  return best;
}

function tailAfter(points: Point[], projection: PolylineProjection): Point[] {
  return [projection.point, ...points.slice(projection.segmentIndex + 1)];
}

function lengthPx(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return total;
}

/**
 * Compare an alternative physical route with the unmodified command route.
 * `referenceRoute` starts at the command's original pose; candidate and current
 * pose are in map pixels. The caller validates the connector and reference
 * tail against static/current map constraints before passing `referenceValid`.
 */
export function evaluateDetourBudget(input: {
  referenceRoute: Point[] | null;
  currentPose: Point;
  candidateRoute: Point[];
  referenceValid: (connector: Point[], remainingReference: Point[]) => boolean;
  pixelCm?: number;
  minProgressPx?: number;
  goal?: Point;
}): DetourBudgetResult {
  const pixelCm = input.pixelCm ?? PIXEL_CM;
  const validCandidate = input.candidateRoute.length > 0 && finitePoint(input.currentPose) && input.candidateRoute.every(finitePoint);
  const candidateLengthM = Number.isFinite(pixelCm) && pixelCm > 0 && validCandidate
    ? lengthPx([input.currentPose, ...input.candidateRoute]) * pixelCm / 100
    : null;
  const unavailable = (): DetourBudgetResult => ({ available: false, baselineLengthM: null, candidateLengthM, allowedLengthM: null, accepted: false });
  if (!Number.isFinite(pixelCm) || pixelCm <= 0 || !input.referenceRoute || input.referenceRoute.length < 2 ||
      !finitePoint(input.currentPose) || !input.referenceRoute.every(finitePoint) || candidateLengthM === null) return unavailable();
  const projection = projectPointOnPolyline(input.referenceRoute, input.currentPose, input.minProgressPx ?? 0);
  if (!projection) return unavailable();
  const candidateEnd = input.candidateRoute.at(-1)!;
  if (input.goal && Math.hypot(candidateEnd.x - input.goal.x, candidateEnd.y - input.goal.y) > 1) return unavailable();
  const remainingReference = tailAfter(input.referenceRoute, projection);
  const connector = [input.currentPose, projection.point];
  // A route that A* snapped short of the requested goal is not a valid budget
  // reference: its missing tail must not make peer detours appear cheap.
  const referenceEnd = input.referenceRoute.at(-1)!;
  if (input.goal && Math.hypot(referenceEnd.x - input.goal.x, referenceEnd.y - input.goal.y) > 1) return unavailable();
  if (!input.referenceValid(connector, remainingReference)) return unavailable();
  const baselineLengthM = (projection.distancePx + lengthPx(remainingReference)) * pixelCm / 100;
  const allowedLengthM = baselineLengthM + Math.min(DETOUR_BUDGET_MAX_M, Math.max(DETOUR_BUDGET_MIN_M, baselineLengthM * DETOUR_BUDGET_RATIO));
  return { available: true, baselineLengthM, candidateLengthM, allowedLengthM, accepted: candidateLengthM <= allowedLengthM + 1e-9 };
}
