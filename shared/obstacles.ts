import {
  MAP_HEIGHT,
  MAP_WIDTH,
  OBSTACLE_MAX_SIZE,
  OBSTACLE_MIN_SIZE,
  DYNAMIC_PLAN_INFLATE_PX,
  ROBOT_LENGTH_PX,
  ROBOT_WIDTH_PX,
} from "./constants.ts";
import { ObstacleKinds } from "./config/index.ts";

export type ObstacleKind = (typeof ObstacleKinds.values)[number];

export type DynObstacle = {
  id: string;
  name?: string;
  kind: ObstacleKind;
  x: number;
  y: number;
  size: number;
  theta: number;
};

export function clampObstacleSize(size: number): number {
  if (!Number.isFinite(size)) return OBSTACLE_MIN_SIZE;
  return Math.min(OBSTACLE_MAX_SIZE, Math.max(OBSTACLE_MIN_SIZE, size));
}

export function clampObstaclePos(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.min(MAP_WIDTH - 0.5, Math.max(0.5, x)),
    y: Math.min(MAP_HEIGHT - 0.5, Math.max(0.5, y)),
  };
}

function wrap(a: number): number {
  let t = a;
  while (t > Math.PI) t -= Math.PI * 2;
  while (t < -Math.PI) t += Math.PI * 2;
  return t;
}

export function triangleVerts(o: DynObstacle): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < 3; i++) {
    const a = o.theta + (i * 2 * Math.PI) / 3;
    out.push([o.x + Math.cos(a) * o.size, o.y + Math.sin(a) * o.size]);
  }
  return out;
}

export function squareVerts(o: DynObstacle): [number, number][] {
  const hl = o.size;
  const c = Math.cos(o.theta);
  const s = Math.sin(o.theta);
  const local: [number, number][] = [
    [hl, hl],
    [hl, -hl],
    [-hl, -hl],
    [-hl, hl],
  ];
  return local.map(([lx, ly]) => [o.x + c * lx - s * ly, o.y + s * lx + c * ly]);
}

function pointInPoly(px: number, py: number, verts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const [xi, yi] = verts[i];
    const [xj, yj] = verts[j];
    const hit = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-9) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distToPoly(px: number, py: number, verts: [number, number][]): number {
  if (pointInPoly(px, py, verts)) return 0;
  let best = Infinity;
  for (let i = 0; i < verts.length; i++) {
    const [ax, ay] = verts[i];
    const [bx, by] = verts[(i + 1) % verts.length];
    best = Math.min(best, distToSeg(px, py, ax, ay, bx, by));
  }
  return best;
}

export function pointHitsObstacle(px: number, py: number, o: DynObstacle, inflate = 0): boolean {
  const pad = inflate;
  if (o.kind === "circle") {
    return Math.hypot(px - o.x, py - o.y) <= o.size + pad;
  }
  const verts = o.kind === "triangle" ? triangleVerts(o) : squareVerts(o);
  return distToPoly(px, py, verts) <= pad;
}

export function robotSamplePoints(cx: number, cy: number, theta: number): [number, number][] {
  const hl = ROBOT_LENGTH_PX / 2;
  const hw = ROBOT_WIDTH_PX / 2;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const local: [number, number][] = [
    [hl, hw],
    [hl, -hw],
    [-hl, hw],
    [-hl, -hw],
    [hl, 0],
    [-hl, 0],
    [0, hw],
    [0, -hw],
    [0, 0],
  ];
  return local.map(([lx, ly]) => [cx + c * lx - s * ly, cy + s * lx + c * ly]);
}

export function poseHitsObstacle(
  cx: number,
  cy: number,
  theta: number,
  o: DynObstacle,
  inflate = 0.5,
): boolean {
  for (const [x, y] of robotSamplePoints(cx, cy, theta)) {
    if (pointHitsObstacle(x, y, o, inflate)) return true;
  }
  return false;
}

export function poseHitsAny(cx: number, cy: number, theta: number, obstacles: DynObstacle[]): boolean {
  return obstacles.some((o) => poseHitsObstacle(cx, cy, theta, o));
}

export function rasterizeObstacles(obstacles: DynObstacle[], inflate = DYNAMIC_PLAN_INFLATE_PX): Uint8Array {
  const out = new Uint8Array(MAP_WIDTH * MAP_HEIGHT);
  return rasterizeObstaclesInto(obstacles, out, inflate);
}

/**
 * Fill a caller-owned dynamic obstacle mask.  The planner receives obstacle
 * snapshots frequently (up to the peer-plan rate), so callers that retain a
 * mask can reuse its storage instead of allocating a full map-sized array on
 * every update.  A dimension mismatch is rejected rather than silently
 * writing with the wrong row stride; use ObstacleMaskBuffer for map changes.
 */
export function rasterizeObstaclesInto(
  obstacles: DynObstacle[],
  out: Uint8Array,
  inflate = DYNAMIC_PLAN_INFLATE_PX,
): Uint8Array {
  if (out.length !== MAP_WIDTH * MAP_HEIGHT) {
    throw new Error(`obstacle mask size ${out.length}, expected ${MAP_WIDTH * MAP_HEIGHT}`);
  }
  out.fill(0);
  for (const o of obstacles) {
    const [x0, y0, x1, y1] = obstacleBounds(o, inflate);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (pointHitsObstacle(x, y, o, inflate)) out[y * MAP_WIDTH + x] = 1;
      }
    }
  }
  return out;
}

/** Reusable dynamic obstacle rasterizer that is safe across map switches. */
export class ObstacleMaskBuffer {
  private buffer: Uint8Array | null = null;
  private width = 0;
  private height = 0;
  private inflate = Number.NaN;
  private previous = new Map<string, { signature: string; bounds: [number, number, number, number] }>();

  rasterize(obstacles: DynObstacle[], inflate = DYNAMIC_PLAN_INFLATE_PX): Uint8Array {
    if (!this.buffer || this.width !== MAP_WIDTH || this.height !== MAP_HEIGHT) {
      this.width = MAP_WIDTH;
      this.height = MAP_HEIGHT;
      this.inflate = inflate;
      this.buffer = new Uint8Array(this.width * this.height);
      this.previous.clear();
      this.drawAll(obstacles, inflate);
      this.previous = this.snapshot(obstacles, inflate);
      return this.buffer;
    }
    if (this.inflate !== inflate) {
      this.inflate = inflate;
      this.buffer.fill(0);
      this.drawAll(obstacles, inflate);
      this.previous = this.snapshot(obstacles, inflate);
      return this.buffer;
    }

    const next = this.snapshot(obstacles, inflate);
    const dirty: [number, number, number, number][] = [];
    for (const [id, old] of this.previous) {
      const current = next.get(id);
      if (!current || current.signature !== old.signature) dirty.push(old.bounds);
    }
    for (const [id, current] of next) {
      const old = this.previous.get(id);
      if (!old || old.signature !== current.signature) dirty.push(current.bounds);
    }
    if (dirty.length) {
      for (const bounds of dirty) this.clearBounds(bounds);
      // Clearing a changed region can also clear a neighboring obstacle that
      // overlaps it. Redraw only obstacles touching the dirty regions.
      for (const obstacle of obstacles) {
        const bounds = next.get(obstacle.id)?.bounds;
        if (bounds && dirty.some((region) => intersects(region, bounds))) this.drawObstacle(obstacle, inflate);
      }
    }
    this.previous = next;
    return this.buffer;
  }

  clear(): void {
    this.buffer?.fill(0);
    this.previous.clear();
  }

  private snapshot(obstacles: DynObstacle[], inflate: number): Map<string, { signature: string; bounds: [number, number, number, number] }> {
    return new Map(obstacles.map((obstacle) => [
      obstacle.id,
      { signature: JSON.stringify([obstacle.kind, obstacle.x, obstacle.y, obstacle.size, obstacle.theta]), bounds: obstacleBounds(obstacle, inflate) },
    ]));
  }

  private drawAll(obstacles: DynObstacle[], inflate: number): void {
    for (const obstacle of obstacles) this.drawObstacle(obstacle, inflate);
  }

  private drawObstacle(obstacle: DynObstacle, inflate: number): void {
    const [x0, y0, x1, y1] = obstacleBounds(obstacle, inflate);
    if (x0 > x1 || y0 > y1) return;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (pointHitsObstacle(x, y, obstacle, inflate)) this.buffer![y * MAP_WIDTH + x] = 1;
      }
    }
  }

  private clearBounds([x0, y0, x1, y1]: [number, number, number, number]): void {
    if (x0 > x1 || y0 > y1) return;
    for (let y = y0; y <= y1; y++) this.buffer!.fill(0, y * MAP_WIDTH + x0, y * MAP_WIDTH + x1 + 1);
  }
}

function obstacleBounds(obstacle: DynObstacle, inflate: number): [number, number, number, number] {
  const margin = inflate + 2;
  let x0: number, y0: number, x1: number, y1: number;
  if (obstacle.kind === "circle") {
    const reach = obstacle.size + margin;
    x0 = obstacle.x - reach; y0 = obstacle.y - reach;
    x1 = obstacle.x + reach; y1 = obstacle.y + reach;
  } else {
    // size is the half extent/radius. A rotated square's axis-aligned reach
    // grows to size*(|cos θ|+|sin θ|); using its actual vertices keeps the
    // raster and dirty-region bounds identical for every polygon shape.
    const vertices = obstacle.kind === "triangle" ? triangleVerts(obstacle) : squareVerts(obstacle);
    x0 = Math.min(...vertices.map(([x]) => x)) - margin;
    y0 = Math.min(...vertices.map(([, y]) => y)) - margin;
    x1 = Math.max(...vertices.map(([x]) => x)) + margin;
    y1 = Math.max(...vertices.map(([, y]) => y)) + margin;
  }
  return [
    Math.max(0, Math.floor(x0)),
    Math.max(0, Math.floor(y0)),
    Math.min(MAP_WIDTH - 1, Math.ceil(x1)),
    Math.min(MAP_HEIGHT - 1, Math.ceil(y1)),
  ];
}

function intersects(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

export function parseObstacleKind(raw: string): ObstacleKind | null {
  return ObstacleKinds.is(raw) ? raw : null;
}

export function wrapTheta(a: number): number {
  return wrap(a);
}
