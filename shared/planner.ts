import { COARSE_CELL_SIZE_PX, MAP_HEIGHT, MAP_WIDTH, MIN_SMOOTHING_RADIUS_PX, SEMANTIC_NAVIGATION_GRID_CELL_LIMIT } from "./constants.ts";
import { coarseAstar } from "./coarse.ts";
import { extraBlockedState, inflatedGrid, isInflatedFree, isPlanFree, robotFootprintClear } from "./occupancy.ts";
import { poseHitsAny } from "./obstacles.ts";
import type { DynObstacle } from "./obstacles.ts";
import type { SemanticSnapshot, ZoneResource } from "./semantic.ts";
import { buildSemanticNavigation, isSemanticPoseBlocked } from "./semanticNavigation.ts";
import type { PlannerMode, PlannerFallbackReason } from "./config/index.ts";

export type Point = { x: number; y: number };

const NEIGHBORS: [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

// Semantic policy is deliberately kept here (rather than in occupancy): dynamic
// obstacles use occupancy's extra mask, while map policy survives obstacle
// refreshes and is shared by every route request.
let semanticZones: ZoneResource[] = [];
let semanticBlocked: Uint8Array | null = null;
let semanticCosts: Float32Array | null = null;
let semanticMinimumCost = 1;
let semanticIsBlocked: ((point: Point) => boolean) | undefined;
let semanticCostAt: ((point: Point) => number) | undefined;
let planningObstacles: DynObstacle[] = [];
let planningObstacleRevision = -1;
let planningEscapeStart: Point | null = null;

/**
 * Supply exact dynamic geometry after refreshing setExtraBlocked(mask). The
 * revision binding prevents an older geometry snapshot from relaxing a newer
 * conservative mask.
 */
export function setPlanningObstacles(obstacles: DynObstacle[]): void {
  planningObstacles = obstacles.map((obstacle) => ({ ...obstacle }));
  planningObstacleRevision = extraBlockedState().revision;
}

export function clearPlanningObstacles(): void { planningObstacles = []; planningObstacleRevision = -1; }

function currentPlanningObstacles(): DynObstacle[] {
  return planningObstacleRevision === extraBlockedState().revision ? planningObstacles : [];
}

/** Replace the active map policy. Safe to call on every semantic snapshot. */
export function setSemanticZones(zones: ZoneResource[]): void {
  semanticZones = zones.filter((z) => Array.isArray(z.polygon) && z.polygon.length >= 3).map((z) => ({ ...z, polygon: z.polygon.map((p) => ({ x: Number(p.x), y: Number(p.y) })) }));
  const nav = buildSemanticNavigation(semanticZones);
  semanticBlocked = nav.blocked;
  semanticCosts = nav.costs;
  semanticMinimumCost = nav.minimumCost;
  semanticIsBlocked = nav.isBlocked;
  semanticCostAt = nav.costAt;
}

export function setSemanticSnapshot(snapshot: Pick<SemanticSnapshot, "zones"> | null): void {
  setSemanticZones(snapshot?.zones ?? []);
}

export function clearSemanticZones(): void {
  semanticZones = [];
  semanticBlocked = null;
  semanticCosts = null;
  semanticMinimumCost = 1;
  semanticIsBlocked = undefined;
  semanticCostAt = undefined;
}

function semanticFree(x: number, y: number): boolean {
  const ix = Math.round(x), iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= MAP_WIDTH || iy >= MAP_HEIGHT) return false;
  if (semanticBlocked) return semanticBlocked[iy * MAP_WIDTH + ix] !== 1;
  return !semanticIsBlocked?.({ x: ix, y: iy });
}

function semanticCost(x: number, y: number): number {
  return semanticCosts?.[Math.round(y) * MAP_WIDTH + Math.round(x)] ?? semanticCostAt?.({ x, y }) ?? 1;
}

/** Dynamic masks remain a conservative search hint; exact geometry is final. */
function planningCellFree(x: number, y: number, allowDynamicGeometry = false): boolean {
  const obstacles = currentPlanningObstacles();
  if (!obstacles.length) return isPlanFree(x, y);
  if (!allowDynamicGeometry && planningEscapeStart && Math.hypot(x - planningEscapeStart.x, y - planningEscapeStart.y) <= 32 && isInflatedFree(x, y) && !poseHitsAny(x, y, 0, obstacles)) return true;
  if (!allowDynamicGeometry) return isPlanFree(x, y);
  if (!isInflatedFree(x, y)) return false;
  return !poseHitsAny(x, y, 0, obstacles);
}

function key(x: number, y: number): number {
  return y * MAP_WIDTH + x;
}

function snapSafe(x: number, y: number, allowDynamicGeometry = false): Point | null {
  const ix = Math.round(x);
  const iy = Math.round(y);
    if (planningCellFree(ix, iy, allowDynamicGeometry) && semanticFree(ix, iy)) return { x: ix, y: iy };
  for (let r = 1; r <= 24; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (planningCellFree(ix + dx, iy + dy, allowDynamicGeometry) && semanticFree(ix + dx, iy + dy)) return { x: ix + dx, y: iy + dy };
      }
    }
  }
  return null;
}

function lineCost(a: Point, b: Point): number {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(d));
  let total = 0;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    total += semanticCost(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  }
  return (d / n) * total;
}

function lineClear(a: Point, b: Point): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const n = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (!planningCellFree(a.x + dx * t, a.y + dy * t) || !semanticFree(a.x + dx * t, a.y + dy * t)) return false;
  }
  return true;
}

/** Check the new curved corner at the same body level as controller motion. */
function poseSegmentClear(a: Point, b: Point): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const heading = d < 1e-8 ? 0 : Math.atan2(dy, dx);
  const n = Math.max(1, Math.ceil(d));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = a.x + dx * t;
    const y = a.y + dy * t;
    if (!isInflatedFree(x, y) || !semanticFree(x, y) || !robotFootprintClear(x, y, heading)) return false;
    const obstacles = currentPlanningObstacles();
    if (obstacles.length && poseHitsAny(x, y, heading, obstacles)) return false;
    if (!obstacles.length && !isPlanFree(x, y)) return false;
  }
  return true;
}

function stringPull(path: Point[]): Point[] {
  if (path.length <= 2) return path;
  const out: Point[] = [path[0]];
  let i = 0;
  while (i < path.length - 1) {
    let best = i + 1;
    for (let j = path.length - 1; j > i + 1; j--) {
      if (lineClear(path[i], path[j])) {
        // Smoothing must respect semantic costs. A geometrically shorter chord
        // is useful only when it is no more expensive than the retained chain.
        let retained = 0;
        for (let k = i + 1; k <= j; k++) retained += lineCost(path[k - 1], path[k]);
        if (lineCost(path[i], path[j]) > retained + 1e-6) continue;
        best = j;
        break;
      }
    }
    out.push(path[best]);
    i = best;
  }
  return out;
}

/**
 * Replace a sufficiently spacious polyline corner with a small circular arc.
 * We retain the original corner whenever the arc would reduce clearance or
 * increase semantic cost, leaving the controller's safe slow-turn fallback.
 */
function roundedCorner(a: Point, b: Point, c: Point): Point[] | null {
  const inX = b.x - a.x, inY = b.y - a.y;
  const outX = c.x - b.x, outY = c.y - b.y;
  const inLength = Math.hypot(inX, inY);
  const outLength = Math.hypot(outX, outY);
  if (inLength < 1e-6 || outLength < 1e-6) return null;
  const ux = inX / inLength, uy = inY / inLength;
  const vx = outX / outLength, vy = outY / outLength;
  const dot = Math.max(-1, Math.min(1, ux * vx + uy * vy));
  const cross = ux * vy - uy * vx;
  const turn = Math.atan2(Math.abs(cross), dot);
  if (turn < 0.08 || turn > Math.PI - 0.08) return null;
  const trim = MIN_SMOOTHING_RADIUS_PX * Math.tan(turn / 2);
  if (trim < 2 || trim > Math.min(inLength / 2, outLength / 2)) return null;

  const start = { x: b.x - ux * trim, y: b.y - uy * trim };
  const end = { x: b.x + vx * trim, y: b.y + vy * trim };
  const turnSign = Math.sign(cross);
  if (!turnSign) return null;
  const center = { x: start.x - turnSign * uy * MIN_SMOOTHING_RADIUS_PX, y: start.y + turnSign * ux * MIN_SMOOTHING_RADIUS_PX };
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  let sweep = Math.atan2(end.y - center.y, end.x - center.x) - startAngle;
  if (turnSign > 0 && sweep < 0) sweep += 2 * Math.PI;
  if (turnSign < 0 && sweep > 0) sweep -= 2 * Math.PI;
  if (Math.abs(Math.abs(sweep) - turn) > 1e-4) return null;

  const steps = Math.max(2, Math.ceil(MIN_SMOOTHING_RADIUS_PX * turn / 3));
  const arc: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const angle = startAngle + sweep * i / steps;
    arc.push({ x: center.x + MIN_SMOOTHING_RADIUS_PX * Math.cos(angle), y: center.y + MIN_SMOOTHING_RADIUS_PX * Math.sin(angle) });
  }
  const replacedCost = arc.slice(1).reduce((total, point, i) => total + lineCost(arc[i], point), 0);
  const retainedCost = lineCost(start, b) + lineCost(b, end);
  if (replacedCost > retainedCost + 1e-6) return null;
  for (let i = 1; i < arc.length; i++) {
    if (!poseSegmentClear(arc[i - 1], arc[i])) return null;
  }
  return arc;
}

function roundCorners(path: Point[]): Point[] {
  if (path.length <= 2) return path;
  const out: Point[] = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const arc = roundedCorner(path[i - 1], path[i], path[i + 1]);
    if (arc) out.push(...arc);
    else out.push(path[i]);
  }
  out.push(path[path.length - 1]);
  return out;
}

class MinHeap {
  data: { k: number; f: number }[] = [];
  push(k: number, f: number) {
    this.data.push({ k, f });
    this.up(this.data.length - 1);
  }
  pop(): number | undefined {
    if (!this.data.length) return;
    const top = this.data[0].k;
    const last = this.data.pop()!;
    if (this.data.length) {
      this.data[0] = last;
      this.down(0);
    }
    return top;
  }
  up(i: number) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.data[p].f <= this.data[i].f) break;
      [this.data[p], this.data[i]] = [this.data[i], this.data[p]];
      i = p;
    }
  }
  down(i: number) {
    for (;;) {
      let m = i;
      const l = i * 2 + 1;
      const r = l + 1;
      if (l < this.data.length && this.data[l].f < this.data[m].f) m = l;
      if (r < this.data.length && this.data[r].f < this.data[m].f) m = r;
      if (m === i) break;
      [this.data[m], this.data[i]] = [this.data[i], this.data[m]];
      i = m;
    }
  }
}

function astarSearch(start: Point, goal: Point): { path: Point[] | null; expanded: number } {
  planningEscapeStart = start;
  if (isSemanticPoseBlocked(semanticZones, goal)) return { path: null, expanded: 0 };
  const s = snapSafe(start.x, start.y, true);
  const g = snapSafe(goal.x, goal.y);
  if (!s || !g) return { path: null, expanded: 0 };
  const grid = inflatedGrid();
  const startK = key(s.x, s.y);
  const goalK = key(g.x, g.y);
  // A 100M-cell map otherwise allocates >1.2 GB for every route request.
  // Keep the existing exact grid search but allocate only visited cells on large maps.
  const sparse = MAP_WIDTH * MAP_HEIGHT > SEMANTIC_NAVIGATION_GRID_CELL_LIMIT;
  const came = sparse ? new Map<number, number>() : new Int32Array(MAP_WIDTH * MAP_HEIGHT).fill(-1);
  const gScore = sparse ? new Map<number, number>() : new Float64Array(MAP_WIDTH * MAP_HEIGHT).fill(Infinity);
  const score = (k: number) => gScore instanceof Map ? (gScore.get(k) ?? Infinity) : gScore[k];
  const setScore = (k: number, v: number) => { if (gScore instanceof Map) gScore.set(k, v); else gScore[k] = v; };
  const parent = (k: number) => came instanceof Map ? came.get(k)! : came[k];
  const setParent = (k: number, v: number) => { if (came instanceof Map) came.set(k, v); else came[k] = v; };
  setScore(startK, 0);
  const open = new MinHeap();
  open.push(startK, Math.hypot(g.x - s.x, g.y - s.y) * semanticMinimumCost);

  let expanded = 0;
  while (open.data.length) {
    const cur = open.pop()!;
    expanded++;
    if (cur === goalK) {
      const path: Point[] = [];
      let k = cur;
      while (k !== startK) {
        path.push({ x: k % MAP_WIDTH, y: Math.floor(k / MAP_WIDTH) });
        k = parent(k);
      }
      path.push(s);
      path.reverse();
      path[path.length - 1] = g;
      return { path: roundCorners(stringPull(path)), expanded };
    }
    const cx = cur % MAP_WIDTH;
    const cy = Math.floor(cur / MAP_WIDTH);
    const cg = score(cur);
    for (const [dx, dy, cost] of NEIGHBORS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= MAP_WIDTH || ny >= MAP_HEIGHT) continue;
      const nk = key(nx, ny);
      if (grid[nk] !== 1 || !semanticFree(nx, ny)) continue;
      if (!planningCellFree(nx, ny)) continue;
      const ng = cg + cost * semanticCost(nx, ny);
      if (ng >= score(nk)) continue;
      setScore(nk, ng);
      setParent(nk, cur);
      open.push(nk, ng + Math.hypot(g.x - nx, g.y - ny) * semanticMinimumCost);
    }
  }
  return { path: null, expanded };
}

export function astar(start: Point, goal: Point): Point[] | null {
  return astarSearch(start, goal).path;
}

export function densify(path: Point[], spacing = 4): Point[] {
  if (path.length === 0) return path;
  const out: Point[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(d / spacing));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

export type PlanRouteOptions = { coarseCellSizePx?: number };
export type PlanDiagnostics = {
  mode: PlannerMode;
  coarseAttempted: boolean;
  coarseFallback: boolean;
  coarseExpanded: number;
  fineExpanded: number;
  expanded: number;
  durationMs: number;
  fallbackReason?: PlannerFallbackReason;
};
export type RoutePlan = { follow: Point[]; display: Point[]; diagnostics?: PlanDiagnostics };

function validPoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0 && point.x < MAP_WIDTH && point.y < MAP_HEIGHT;
}

function attachExactEndpoints(path: Point[], start: Point, goal: Point): Point[] | null {
  if (!path.length) return null;
  const out = path.map((point) => ({ ...point }));
  if (Math.hypot(out[0].x - start.x, out[0].y - start.y) > 1e-9) {
    // A padded dynamic mask can reject the first snapped cell even though the
    // exact body is clear. Find the first restored point with a safe source
    // resolution connector and discard only the rejected prefix; this keeps
    // the actual pose as the route origin without an unsafe snapped jump.
    let connector = -1;
    for (let i = 0; i < out.length; i++) {
      if (poseSegmentClear(start, out[i])) { connector = i; break; }
    }
    if (connector >= 0) {
      out.splice(0, connector);
      out.unshift({ ...start });
    }
  }
  const end = out[out.length - 1];
  if (Math.hypot(end.x - goal.x, end.y - goal.y) > 1e-9) {
    // The same rule applies to a temporarily occupied goal. Forbidden goals
    // are rejected earlier by astar; a dynamic block retains the safe snapped
    // endpoint for the normal HOLD/replan flow.
    if (poseSegmentClear(end, goal)) out.push({ ...goal });
  }
  return out;
}

function pathSegmentsClear(path: Point[]): boolean {
  for (let i = 1; i < path.length; i++) if (!poseSegmentClear(path[i - 1], path[i])) return false;
  return true;
}

export function planDrive(start: Point, goal: Point, options?: PlanRouteOptions): Point[] | null {
  return planRoute(start, goal, options)?.follow ?? null;
}

export function planRoute(start: Point, goal: Point, options: PlanRouteOptions = {}): RoutePlan | null {
  const started = performance.now();
  planningEscapeStart = null;
  if (!validPoint(start) || !validPoint(goal)) return null;
  if (options.coarseCellSizePx !== undefined &&
      (!Number.isFinite(options.coarseCellSizePx) || !Number.isInteger(options.coarseCellSizePx) || options.coarseCellSizePx < 1)) {
    throw new RangeError("coarseCellSizePx must be a positive integer");
  }
  const coarseRequested = (options.coarseCellSizePx ?? COARSE_CELL_SIZE_PX) > 1;
  let coarseExpanded = 0;
  let fallbackReason: PlannerFallbackReason | undefined;
  if (coarseRequested) {
    const coarse = coarseAstar(start, goal, {
      cellSizePx: options.coarseCellSizePx ?? COARSE_CELL_SIZE_PX,
      semanticZones,
      semanticCost: (point) => semanticCostAt?.(point) ?? semanticCost(point.x, point.y),
      minimumCost: semanticMinimumCost,
      dynamicEndpointFree: currentPlanningObstacles().length
        ? (point) => !poseHitsAny(point.x, point.y, 0, currentPlanningObstacles())
        : undefined,
      segmentClear: poseSegmentClear,
    });
    coarseExpanded = coarse.expanded;
    if (coarse.path) {
      const smoothed = roundCorners(stringPull(coarse.path));
      // Restore at source resolution and apply the same body-level check used
      // by controller motion. A physically safe chord may use free space in a
      // conservatively blocked coarse cell; the final source-resolution check
      // is the authority for that refinement.
      const candidate = pathSegmentsClear(smoothed) ? smoothed : coarse.path;
      const display = attachExactEndpoints(candidate, start, goal);
      if (display) {
        const diagnostics: PlanDiagnostics = {
          mode: "coarse", coarseAttempted: true, coarseFallback: false,
          coarseExpanded, fineExpanded: 0, expanded: coarseExpanded,
          durationMs: performance.now() - started,
        };
        return { display, follow: densify(display, 3), diagnostics };
      }
      fallbackReason = "coarse_validation";
    } else {
      fallbackReason = coarse.reason ?? "coarse_no_route";
    }
  }
  const fine = astarSearch(start, goal);
  if (!fine.path) return null;
  const display = attachExactEndpoints(fine.path, start, goal);
  if (!display || !pathSegmentsClear(display)) return null;
  const diagnostics: PlanDiagnostics = {
    mode: "fine", coarseAttempted: coarseRequested, coarseFallback: coarseRequested,
    coarseExpanded, fineExpanded: fine.expanded, expanded: coarseExpanded + fine.expanded,
    durationMs: performance.now() - started, fallbackReason,
  };
  return { display, follow: densify(display, 3), diagnostics };
}

export function poseFeasible(x: number, y: number, theta: number): boolean {
  return robotFootprintClear(x, y, theta);
}
