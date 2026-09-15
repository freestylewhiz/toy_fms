import {
  MAP_HEIGHT,
  MAP_WIDTH,
  OBSTACLE_MAX_SIZE,
  OBSTACLE_MIN_SIZE,
  PLAN_INFLATE_PX,
  ROBOT_LENGTH_PX,
  ROBOT_WIDTH_PX,
} from "./constants.ts";

export type ObstacleKind = "triangle" | "square" | "circle";

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

export function rasterizeObstacles(obstacles: DynObstacle[], inflate = PLAN_INFLATE_PX): Uint8Array {
  const out = new Uint8Array(MAP_WIDTH * MAP_HEIGHT);
  for (const o of obstacles) {
    const reach = o.size + inflate + 2;
    const x0 = Math.max(0, Math.floor(o.x - reach));
    const x1 = Math.min(MAP_WIDTH - 1, Math.ceil(o.x + reach));
    const y0 = Math.max(0, Math.floor(o.y - reach));
    const y1 = Math.min(MAP_HEIGHT - 1, Math.ceil(o.y + reach));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (pointHitsObstacle(x, y, o, inflate)) out[y * MAP_WIDTH + x] = 1;
      }
    }
  }
  return out;
}

export function parseObstacleKind(raw: string): ObstacleKind | null {
  if (raw === "triangle" || raw === "square" || raw === "circle") return raw;
  return null;
}

export function wrapTheta(a: number): number {
  return wrap(a);
}
