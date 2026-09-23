import { COARSE_CELL_SIZE_PX, MAP_HEIGHT, MAP_WIDTH, ROBOT_CIRCUMRADIUS_PX } from "./constants.ts";
import { extraBlockedState, inflatedGrid } from "./occupancy.ts";
import { pointInPolygon } from "./semanticNavigation.ts";
import type { Point } from "./planner.ts";
import type { ZoneResource } from "./semantic.ts";
import type { CoarsePlanReason } from "./config/index.ts";

export type CoarseCell = { x: number; y: number };
export type CoarseSearchResult = {
  path: Point[] | null;
  expanded: number;
  reason?: CoarsePlanReason;
};

type CoarseMask = { width: number; height: number; blocked: Uint8Array };
type MaskCache = Map<string, CoarseMask>;

// The inflated asset is immutable for a map context. WeakMap makes a map
// switch naturally discard the old coarse raster while allowing warm requests
// to reuse the 100M-pixel scan. Dimensions remain in the key because tests and
// map contexts can replace the active grid without changing its identity.
const staticCache = new WeakMap<Uint8Array, MaskCache>();

function cacheKey(width: number, height: number, cellSize: number): string {
  return `${width}x${height}@${cellSize}`;
}

function coarseDimensions(width: number, height: number, cellSize: number): { width: number; height: number } {
  return { width: Math.ceil(width / cellSize), height: Math.ceil(height / cellSize) };
}

function rasterCoarse(grid: Uint8Array, width: number, height: number, cellSize: number): CoarseMask {
  const dimensions = coarseDimensions(width, height, cellSize);
  const blocked = new Uint8Array(dimensions.width * dimensions.height);
  // Pixel centres are integer coordinates. Thus cell c owns the continuous
  // extent [c*size-.5, (c+1)*size-.5], including every integer pixel from
  // c*size through (c+1)*size-1. Any blocked source pixel blocks the cell.
  for (let cy = 0; cy < dimensions.height; cy++) {
    const y0 = cy * cellSize;
    const y1 = Math.min(height, (cy + 1) * cellSize);
    for (let cx = 0; cx < dimensions.width; cx++) {
      const x0 = cx * cellSize;
      const x1 = Math.min(width, (cx + 1) * cellSize);
      let hit = false;
      for (let y = y0; y < y1 && !hit; y++) {
        const row = y * width;
        for (let x = x0; x < x1; x++) {
          if (grid[row + x] !== 1) { hit = true; break; }
        }
      }
      blocked[cy * dimensions.width + cx] = hit ? 1 : 0;
    }
  }
  return { ...dimensions, blocked };
}

function staticMask(cellSize: number): CoarseMask {
  const source = inflatedGrid();
  let cache = staticCache.get(source);
  if (!cache) { cache = new Map(); staticCache.set(source, cache); }
  const key = cacheKey(MAP_WIDTH, MAP_HEIGHT, cellSize);
  let mask = cache.get(key);
  if (!mask) { mask = rasterCoarse(source, MAP_WIDTH, MAP_HEIGHT, cellSize); cache.set(key, mask); }
  return mask;
}

export function coarseCellCenter(cell: CoarseCell, cellSize = COARSE_CELL_SIZE_PX): Point {
  const x0 = cell.x * cellSize;
  const y0 = cell.y * cellSize;
  return {
    x: Math.min(MAP_WIDTH - 0.5, x0 + Math.min(cellSize, MAP_WIDTH - x0) / 2 - 0.5),
    y: Math.min(MAP_HEIGHT - 0.5, y0 + Math.min(cellSize, MAP_HEIGHT - y0) / 2 - 0.5),
  };
}

function pointInBox(point: Point, x0: number, y0: number, x1: number, y1: number): boolean {
  return point.x >= x0 && point.x <= x1 && point.y >= y0 && point.y <= y1;
}

function segmentIntersectsBox(a: Point, b: Point, x0: number, y0: number, x1: number, y1: number): boolean {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, a.x - x0) && clip(dx, x1 - a.x) && clip(-dy, a.y - y0) && clip(dy, y1 - a.y);
}

/** Test polygon/expanded-cell intersection, including tiny fractional zones. */
function hardZoneTouchesCell(zone: ZoneResource, cell: CoarseCell, cellSize: number): boolean {
  if (zone.polygon.length < 3) return false;
  const x0 = cell.x * cellSize - 0.5;
  const y0 = cell.y * cellSize - 0.5;
  const x1 = Math.min(MAP_WIDTH - 0.5, (cell.x + 1) * cellSize - 0.5);
  const y1 = Math.min(MAP_HEIGHT - 0.5, (cell.y + 1) * cellSize - 0.5);
  // Hard zones use the same circumscribed body envelope as semantic navigation.
  // Expanding the cell is the one body clearance operation; the source
  // occupancy is already inflated and is deliberately not inflated again here.
  const r = ROBOT_CIRCUMRADIUS_PX;
  const ex0 = x0 - r, ey0 = y0 - r, ex1 = x1 + r, ey1 = y1 + r;
  if (zone.polygon.some((point) => pointInBox(point, ex0, ey0, ex1, ey1))) return true;
  const corners: Point[] = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  if (corners.some((point) => pointInPolygon(point, zone.polygon))) return true;
  for (let i = 0; i < zone.polygon.length; i++) {
    const a = zone.polygon[i], b = zone.polygon[(i + 1) % zone.polygon.length];
    if (segmentIntersectsBox(a, b, ex0, ey0, ex1, ey1)) return true;
  }
  return false;
}

function cellKey(x: number, y: number, width: number): number { return y * width + x; }

function cellIsBlocked(
  x: number,
  y: number,
  staticGrid: CoarseMask,
  dynamicGrid: Uint8Array | null,
  dynamicCells: Map<number, boolean>,
  hardZones: ZoneResource[],
  cellSize: number,
): boolean {
  const k = cellKey(x, y, staticGrid.width);
  if (staticGrid.blocked[k]) return true;
  if (dynamicGrid) {
    const old = dynamicCells.get(k);
    if (old !== undefined) { if (old) return true; }
    else {
      const x0 = x * cellSize, x1 = Math.min(MAP_WIDTH, (x + 1) * cellSize);
      const y0 = y * cellSize, y1 = Math.min(MAP_HEIGHT, (y + 1) * cellSize);
      let hit = false;
      for (let py = y0; py < y1 && !hit; py++) for (let px = x0; px < x1; px++) {
        if (dynamicGrid[py * MAP_WIDTH + px] === 1) { hit = true; break; }
      }
      dynamicCells.set(k, hit);
      if (hit) return true;
    }
  }
  const cell = { x, y };
  return hardZones.some((zone) => hardZoneTouchesCell(zone, cell, cellSize));
}

function cellCenterCost(
  cell: CoarseCell,
  cellSize: number,
  costAt: (point: Point) => number,
): number {
  // Five-point quadrature approximates the continuous prefer/avoid field without
  // evaluating polygons over every source pixel. It is a cost average only;
  // soft zones never become coarse hard exclusions.
  const x0 = cell.x * cellSize;
  const y0 = cell.y * cellSize;
  const width = Math.min(cellSize, MAP_WIDTH - x0);
  const height = Math.min(cellSize, MAP_HEIGHT - y0);
  const cx = x0 + width / 2 - 0.5, cy = y0 + height / 2 - 0.5;
  const points = [
    { x: cx, y: cy },
    { x: x0 + width * 0.25 - 0.5, y: y0 + height * 0.25 - 0.5 },
    { x: x0 + width * 0.75 - 0.5, y: y0 + height * 0.25 - 0.5 },
    { x: x0 + width * 0.25 - 0.5, y: y0 + height * 0.75 - 0.5 },
    { x: x0 + width * 0.75 - 0.5, y: y0 + height * 0.75 - 0.5 },
  ];
  let total = 0;
  for (const point of points) total += Math.max(0.05, Math.min(100, costAt(point)));
  return total / points.length;
}

export type CoarseAstarOptions = {
  cellSizePx?: number;
  semanticZones: ZoneResource[];
  semanticCost: (point: Point) => number;
  minimumCost?: number;
  /** Allow an exact, body-clear endpoint to enter a conservatively padded dynamic cell. */
  dynamicEndpointFree?: (point: Point) => boolean;
  segmentClear: (a: Point, b: Point) => boolean;
};

/** Semantic-cost A* over a conservative coarse occupancy raster. */
export function coarseAstar(start: Point, goal: Point, options: CoarseAstarOptions): CoarseSearchResult {
  const requestedCellSize = options.cellSizePx ?? COARSE_CELL_SIZE_PX;
  if (!Number.isFinite(requestedCellSize) || !Number.isInteger(requestedCellSize) || requestedCellSize < 1) {
    return { path: null, expanded: 0, reason: "no_route" };
  }
  const cellSize = requestedCellSize;
  if (cellSize <= 1) return { path: null, expanded: 0, reason: "no_route" };
  const staticGrid = staticMask(cellSize);
  const dynamicGrid = extraBlockedState().grid;
  const dynamicCells = new Map<number, boolean>();
  const hardZones = options.semanticZones.filter((zone) => zone.kind === "forbidden" || zone.kind === "blocked");
  const toCell = (point: Point): CoarseCell => ({
    x: Math.max(0, Math.min(staticGrid.width - 1, Math.floor(Math.round(point.x) / cellSize))),
    y: Math.max(0, Math.min(staticGrid.height - 1, Math.floor(Math.round(point.y) / cellSize))),
  });
  const s = toCell(start), g = toCell(goal);
  const endpointBlocked = (cell: CoarseCell, point: Point): boolean => {
    if (!cellIsBlocked(cell.x, cell.y, staticGrid, dynamicGrid, dynamicCells, hardZones, cellSize)) return false;
    if (!options.dynamicEndpointFree?.(point)) return true;
    // Static and semantic blocks remain hard. Only a dynamic raster-only hit
    // may be relaxed for an exact body-clear connector.
    return cellIsBlocked(cell.x, cell.y, staticGrid, null, dynamicCells, hardZones, cellSize);
  };
  if (endpointBlocked(s, start) || endpointBlocked(g, goal)) {
    return { path: null, expanded: 0, reason: "blocked_endpoint" };
  }
  const key = (x: number, y: number) => cellKey(x, y, staticGrid.width);
  const gScore = new Map<number, number>();
  const came = new Map<number, number>();
  const costs = new Map<number, number>();
  const cellCost = (x: number, y: number): number => {
    const k = key(x, y);
    const old = costs.get(k);
    if (old !== undefined) return old;
    const value = cellCenterCost({ x, y }, cellSize, options.semanticCost);
    costs.set(k, value);
    return value;
  };
  const heuristic = (x: number, y: number) => Math.hypot(g.x - x, g.y - y) * Math.max(0.05, Math.min(100, options.minimumCost ?? 0.05));
  const heap: { k: number; f: number }[] = [];
  const push = (k: number, f: number) => {
    heap.push({ k, f });
    let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p].f <= heap[i].f) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = (): number | undefined => {
    if (!heap.length) return undefined;
    const result = heap[0].k, last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) { let m = i, l = i * 2 + 1, r = l + 1; if (l < heap.length && heap[l].f < heap[m].f) m = l; if (r < heap.length && heap[r].f < heap[m].f) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; }
    }
    return result;
  };
  const startKey = key(s.x, s.y), goalKey = key(g.x, g.y);
  gScore.set(startKey, 0); push(startKey, heuristic(s.x, s.y));
  let expanded = 0;
  const neighbours: [number, number, number][] = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  while (heap.length) {
    const current = pop()!;
    expanded++;
    if (current === goalKey) {
      const cells: CoarseCell[] = [];
      let cursor = current;
      while (cursor !== startKey) { cells.push({ x: cursor % staticGrid.width, y: Math.floor(cursor / staticGrid.width) }); cursor = came.get(cursor)!; }
      cells.push(s); cells.reverse();
      const points = cells.map((cell) => coarseCellCenter(cell, cellSize));
      const refined: Point[] = [start];
      if (!options.segmentClear(start, points[0])) return { path: null, expanded, reason: "no_route" };
      if (Math.hypot(points[0].x - start.x, points[0].y - start.y) > 1e-9) refined.push(points[0]);
      for (let i = 1; i < points.length; i++) {
        if (!options.segmentClear(points[i - 1], points[i])) return { path: null, expanded, reason: "no_route" };
        refined.push(points[i]);
      }
      if (!options.segmentClear(points[points.length - 1], goal)) return { path: null, expanded, reason: "no_route" };
      if (Math.hypot(points.at(-1)!.x - goal.x, points.at(-1)!.y - goal.y) > 1e-9) refined.push(goal);
      return { path: refined, expanded };
    }
    const cx = current % staticGrid.width, cy = Math.floor(current / staticGrid.width);
    const currentScore = gScore.get(current)!;
    for (const [dx, dy, step] of neighbours) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= staticGrid.width || ny >= staticGrid.height) continue;
      if (dx && dy) {
        if (cellIsBlocked(cx + dx, cy, staticGrid, dynamicGrid, dynamicCells, hardZones, cellSize) || cellIsBlocked(cx, cy + dy, staticGrid, dynamicGrid, dynamicCells, hardZones, cellSize)) continue;
      }
      if (cellIsBlocked(nx, ny, staticGrid, dynamicGrid, dynamicCells, hardZones, cellSize)) continue;
      const nk = key(nx, ny), next = currentScore + step * cellCost(nx, ny);
      if (next >= (gScore.get(nk) ?? Infinity)) continue;
      gScore.set(nk, next); came.set(nk, current); push(nk, next + heuristic(nx, ny));
    }
  }
  return { path: null, expanded, reason: "no_route" };
}
