import { MAP_HEIGHT, MAP_WIDTH } from "./constants.ts";
import { inflatedGrid, isPlanFree, robotFootprintClear } from "./occupancy.ts";
import type { SemanticSnapshot, ZoneResource } from "./semantic.ts";
import { buildSemanticNavigation, isSemanticPoseBlocked } from "./semanticNavigation.ts";

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

/** Replace the active map policy. Safe to call on every semantic snapshot. */
export function setSemanticZones(zones: ZoneResource[]): void {
  semanticZones = zones.filter((z) => Array.isArray(z.polygon) && z.polygon.length >= 3).map((z) => ({ ...z, polygon: z.polygon.map((p) => ({ x: Number(p.x), y: Number(p.y) })) }));
  const nav = buildSemanticNavigation(semanticZones);
  semanticBlocked = nav.blocked;
  semanticCosts = nav.costs;
  semanticMinimumCost = nav.minimumCost;
}

export function setSemanticSnapshot(snapshot: Pick<SemanticSnapshot, "zones"> | null): void {
  setSemanticZones(snapshot?.zones ?? []);
}

export function clearSemanticZones(): void { semanticZones = []; semanticBlocked = null; semanticCosts = null; semanticMinimumCost = 1; }

function semanticFree(x: number, y: number): boolean {
  const ix = Math.round(x), iy = Math.round(y);
  return ix >= 0 && iy >= 0 && ix < MAP_WIDTH && iy < MAP_HEIGHT && semanticBlocked?.[iy * MAP_WIDTH + ix] !== 1;
}

function semanticCost(x: number, y: number): number {
  return semanticCosts?.[Math.round(y) * MAP_WIDTH + Math.round(x)] ?? 1;
}

function key(x: number, y: number): number {
  return y * MAP_WIDTH + x;
}

function snapSafe(x: number, y: number): Point | null {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (isPlanFree(ix, iy) && semanticFree(ix, iy)) return { x: ix, y: iy };
  for (let r = 1; r <= 24; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (isPlanFree(ix + dx, iy + dy) && semanticFree(ix + dx, iy + dy)) return { x: ix + dx, y: iy + dy };
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
    if (!isPlanFree(a.x + dx * t, a.y + dy * t) || !semanticFree(a.x + dx * t, a.y + dy * t)) return false;
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

export function astar(start: Point, goal: Point): Point[] | null {
  if (isSemanticPoseBlocked(semanticZones, goal)) return null;
  const s = snapSafe(start.x, start.y);
  const g = snapSafe(goal.x, goal.y);
  if (!s || !g) return null;
  const grid = inflatedGrid();
  const startK = key(s.x, s.y);
  const goalK = key(g.x, g.y);
  const came = new Int32Array(MAP_WIDTH * MAP_HEIGHT).fill(-1);
  const gScore = new Float64Array(MAP_WIDTH * MAP_HEIGHT).fill(Infinity);
  gScore[startK] = 0;
  const open = new MinHeap();
  open.push(startK, Math.hypot(g.x - s.x, g.y - s.y) * semanticMinimumCost);
  const inOpen = new Uint8Array(MAP_WIDTH * MAP_HEIGHT);
  inOpen[startK] = 1;

  while (open.data.length) {
    const cur = open.pop()!;
    if (cur === goalK) {
      const path: Point[] = [];
      let k = cur;
      while (k !== startK) {
        path.push({ x: k % MAP_WIDTH, y: Math.floor(k / MAP_WIDTH) });
        k = came[k];
      }
      path.push(s);
      path.reverse();
      path[path.length - 1] = g;
      return stringPull(path);
    }
    const cx = cur % MAP_WIDTH;
    const cy = Math.floor(cur / MAP_WIDTH);
    const cg = gScore[cur];
    for (const [dx, dy, cost] of NEIGHBORS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= MAP_WIDTH || ny >= MAP_HEIGHT) continue;
      const nk = key(nx, ny);
      if (grid[nk] !== 1 || !semanticFree(nx, ny)) continue;
      if (!isPlanFree(nx, ny)) continue;
      const ng = cg + cost * semanticCost(nx, ny);
      if (ng >= gScore[nk]) continue;
      gScore[nk] = ng;
      came[nk] = cur;
      open.push(nk, ng + Math.hypot(g.x - nx, g.y - ny) * semanticMinimumCost);
    }
  }
  return null;
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

export function planDrive(start: Point, goal: Point): Point[] | null {
  return planRoute(start, goal)?.follow ?? null;
}

export function planRoute(start: Point, goal: Point): { follow: Point[]; display: Point[] } | null {
  const display = astar(start, goal);
  if (!display) return null;
  const end = display[display.length - 1];
  // A* searches integer cells; preserve a reachable fractional command target.
  // Keep a blocked target snapped so the controller can wait/replan safely.
  if (end && (end.x !== goal.x || end.y !== goal.y) && lineClear(end, goal)) {
    display.push({ ...goal });
  }
  return { display, follow: densify(display, 3) };
}

export function poseFeasible(x: number, y: number, theta: number): boolean {
  return robotFootprintClear(x, y, theta);
}
