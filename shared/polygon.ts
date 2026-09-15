import type { Point } from "./semantic.ts";

const EPS = 1e-9;

function orient(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  return (
    Math.min(a.x, b.x) - EPS <= p.x && p.x <= Math.max(a.x, b.x) + EPS &&
    Math.min(a.y, b.y) - EPS <= p.y && p.y <= Math.max(a.y, b.y) + EPS
  );
}

/** Proper or overlapping intersection. Shared endpoints of adjacent edges are ignored by callers. */
export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 * o2 < -EPS && o3 * o4 < -EPS) return true;
  if (Math.abs(o1) < EPS && onSegment(a, b, c) && hypot2(c, a) > EPS && hypot2(c, b) > EPS) return true;
  if (Math.abs(o2) < EPS && onSegment(a, b, d) && hypot2(d, a) > EPS && hypot2(d, b) > EPS) return true;
  if (Math.abs(o3) < EPS && onSegment(c, d, a) && hypot2(a, c) > EPS && hypot2(a, d) > EPS) return true;
  if (Math.abs(o4) < EPS && onSegment(c, d, b) && hypot2(b, c) > EPS && hypot2(b, d) > EPS) return true;
  return false;
}

function hypot2(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function edgesAdjacent(i: number, j: number, n: number): boolean {
  if (i === j) return true;
  if ((i + 1) % n === j || (j + 1) % n === i) return true;
  return false;
}

/** Closed ring with no self-crossing edges (bowtie / hourglass rejected). */
export function isSimplePolygon(poly: Point[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    if (hypot2(a, b) < EPS) return false;
    for (let j = i + 1; j < n; j++) {
      if (edgesAdjacent(i, j, n)) continue;
      const c = poly[j];
      const d = poly[(j + 1) % n];
      if (segmentsIntersect(a, b, c, d)) return false;
    }
  }
  return true;
}

/** New open-chain vertex: last→p must not cross earlier edges (except the one into last). */
export function canAppendVertex(poly: Point[], p: Point): boolean {
  if (poly.length === 0) return true;
  const last = poly[poly.length - 1];
  if (hypot2(last, p) < 1) return false;
  if (poly.length === 1) return true;
  for (let i = 0; i < poly.length - 2; i++) {
    if (segmentsIntersect(poly[i], poly[i + 1], last, p)) return false;
  }
  return true;
}

export function signedArea(poly: Point[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += (poly[j].x * poly[i].y - poly[i].x * poly[j].y);
  }
  return a / 2;
}

export function ensureCcw(poly: Point[]): Point[] {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly.slice();
}

/** Area-weighted centroid; falls back to vertex mean for degenerate rings. */
export function centroid(poly: Point[]): Point {
  if (!poly.length) return { x: 0, y: 0 };
  const a = signedArea(poly);
  if (Math.abs(a) < 1e-6) {
    let x = 0;
    let y = 0;
    for (const p of poly) {
      x += p.x;
      y += p.y;
    }
    return { x: x / poly.length, y: y / poly.length };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const cross = poly[j].x * poly[i].y - poly[i].x * poly[j].y;
    cx += (poly[j].x + poly[i].x) * cross;
    cy += (poly[j].y + poly[i].y) * cross;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export function translatePoly(poly: Point[], dx: number, dy: number): Point[] {
  return poly.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

export function replaceVertex(poly: Point[], index: number, p: Point): Point[] {
  return poly.map((q, i) => (i === index ? { x: p.x, y: p.y } : q));
}

export function insertVertex(poly: Point[], afterIndex: number, p: Point): Point[] {
  const next = poly.slice();
  next.splice(afterIndex + 1, 0, { x: p.x, y: p.y });
  return next;
}

export function removeVertex(poly: Point[], index: number): Point[] | null {
  if (poly.length <= 3) return null;
  return poly.filter((_, i) => i !== index);
}

export function edgeMid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function labelMetrics(text: string, worldPerPx: number): { w: number; h: number } {
  const w = (Math.max(48, text.length * 7.2 + 18)) * worldPerPx;
  const h = 18 * worldPerPx;
  return { w, h };
}

export function pointInLabel(px: number, py: number, c: Point, text: string, worldPerPx: number): boolean {
  const { w, h } = labelMetrics(text, worldPerPx);
  return px >= c.x - w / 2 && px <= c.x + w / 2 && py >= c.y - h / 2 && py <= c.y + h / 2;
}
