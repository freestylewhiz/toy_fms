import { PIXEL_CM } from "../../shared/constants.ts";
import { squareVerts, triangleVerts, type DynObstacle } from "../../shared/obstacles.ts";
import {
  centroid,
  edgeMid,
  labelMetrics,
  pointInLabel,
} from "../../shared/polygon.ts";
import type { Point } from "../../shared/semantic.ts";
import { dist, distToSeg, metersToPx, pointInPoly, type EdgeR, type Snapshot } from "./snapshot.ts";

export const ZONE_FILL: Record<string, string> = {
  forbidden: "rgba(248,113,113,0.28)",
  blocked: "rgba(239,68,68,0.32)",
  prefer: "rgba(52,211,153,0.22)",
  priority: "rgba(74,222,128,0.22)",
  avoid: "rgba(251,191,36,0.22)",
  penalty: "rgba(250,204,21,0.22)",
  release: "rgba(167,139,250,0.22)",
  line_guided: "rgba(56,189,248,0.22)",
  speed_limit: "rgba(251,146,60,0.22)",
  directed: "rgba(129,140,248,0.22)",
  bidirected: "rgba(165,180,252,0.22)",
  replanning: "rgba(244,114,182,0.22)",
  action_zone: "rgba(45,212,191,0.18)",
  corridor: "rgba(125,211,252,0.2)",
  complex: "rgba(192,132,252,0.2)",
};

const OBS_FILL = "rgba(244, 114, 182, 0.38)";
const OBS_STROKE = "#f472b6";
const ROBOT_COLOR: Record<string, string> = { "robot-1": "#fb923c", "robot-2": "#34d399" };
const WORK_LABEL: Record<string, string> = { idle: "유휴", busy: "작업", unknown: "확인 불가" };
const DRIVE_LABEL: Record<string, string> = { stationary: "정지", moving: "주행 중", waiting: "대기", paused: "일시정지", blocked: "주행 불가", unknown: "상태 확인 중" };

function drawRobotRuntime(ctx: CanvasRenderingContext2D, r: Snapshot["robots"][number], selected: boolean, px = 1): void {
  const offline = r.connectionState === "offline";
  const disabled = r.fmsControlState === "disabled";
  const color = disabled ? "#fbbf24" : offline ? "#fb7185" : ROBOT_COLOR[r.id] ?? "#a3e635";
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = (selected ? 2.4 : 1.5) * px;
  if (offline || disabled) ctx.setLineDash(disabled ? [2 * px, 3 * px] : [6 * px, 4 * px]);
  ctx.beginPath(); ctx.arc(r.x, r.y, Math.max(15, 10 * px), 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = color; ctx.font = `bold ${11 * px}px ui-monospace, monospace`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(disabled ? "⊘" : offline ? "!" : "●", r.x, r.y - Math.max(24, 19 * px));
  const work = WORK_LABEL[r.workState] ?? "확인 불가";
  const drive = DRIVE_LABEL[r.driveState] ?? "상태 확인 중";
  ctx.font = `${10 * px}px ui-monospace, monospace`;
  ctx.fillStyle = "rgba(7, 11, 20, .82)";
  const label = `${work} · ${drive}`; const width = ctx.measureText(label).width + 8 * px;
  ctx.fillRect(r.x - width / 2, r.y + Math.max(18, 14 * px), width, 16 * px);
  ctx.fillStyle = "#e2e8f0"; ctx.fillText(label, r.x, r.y + Math.max(18, 14 * px) + 8 * px);
  ctx.restore();
}

export function drawPoly(ctx: CanvasRenderingContext2D, pts: Point[], fill: string, stroke: string, line = 1.5): void {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = line;
  ctx.stroke();
}

function drawObstacle(ctx: CanvasRenderingContext2D, o: DynObstacle): void {
  ctx.save();
  ctx.fillStyle = OBS_FILL;
  ctx.strokeStyle = OBS_STROKE;
  ctx.lineWidth = 1.5;
  if (o.kind === "circle") {
    ctx.beginPath();
    ctx.arc(o.x, o.y, o.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    const verts = o.kind === "triangle" ? triangleVerts(o) : squareVerts(o);
    ctx.beginPath();
    ctx.moveTo(verts[0][0], verts[0][1]);
    for (let i = 1; i < verts.length; i++) ctx.lineTo(verts[i][0], verts[i][1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawHeading(ctx: CanvasRenderingContext2D, x: number, y: number, theta: number, color: string, len = 18): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + Math.cos(theta) * len, y + Math.sin(theta) * len);
  ctx.stroke();
}

function edgePoints(edge: EdgeR, snap: Snapshot): Point[] {
  if (edge.trajectory.length >= 2) return edge.trajectory;
  const a = snap.nodes.find((n) => n.id === edge.startNodeId);
  const b = snap.nodes.find((n) => n.id === edge.endNodeId);
  if (!a || !b) return [];
  return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
}

function ribbon(pts: Point[], left: number, right: number): Point[] {
  if (pts.length < 2) return [];
  const lefts: Point[] = [];
  const rights: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    lefts.push({ x: pts[i].x + nx * left, y: pts[i].y + ny * left });
    rights.push({ x: pts[i].x - nx * right, y: pts[i].y - ny * right });
  }
  return [...lefts, ...rights.reverse()];
}

export type DrawOpts = {
  mapWidth: number;
  mapHeight: number;
  layers: { zones: boolean; graph: boolean; corridor: boolean; scene: boolean; robots: boolean };
  selectedId?: string;
  selectedVertex?: number;
  draftPoly?: Point[];
  draftCursor?: Point;
  draftInvalid?: boolean;
  draftLine?: Point[];
  /** world units per screen pixel (1 / camera.scale) */
  px?: number;
  zonePreview?: { id: string; polygon: Point[] };
  /** soft-dim non-focused scene while editing */
  dimOthers?: boolean;
  hideId?: string;
};

export const POSE_ROTATE_R = 34;

export function drawPoseEditor(
  ctx: CanvasRenderingContext2D,
  pose: { x: number; y: number; theta: number; size?: number },
  px: number,
  opts?: { obstacle?: boolean; shape?: "triangle" | "square" | "circle" },
): void {
  const r = POSE_ROTATE_R;
  ctx.save();
  ctx.strokeStyle = "rgba(251, 191, 36, 0.55)";
  ctx.lineWidth = 1.2 * px;
  ctx.setLineDash([5 * px, 4 * px]);
  ctx.beginPath();
  ctx.arc(pose.x, pose.y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = "#fbbf24";
  ctx.fillStyle = "rgba(251, 191, 36, 0.2)";
  ctx.lineWidth = 2 * px;
  ctx.beginPath();
  ctx.arc(pose.x, pose.y, 7 * px, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  const hx = pose.x + Math.cos(pose.theta) * r;
  const hy = pose.y + Math.sin(pose.theta) * r;
  ctx.beginPath();
  ctx.moveTo(pose.x, pose.y);
  ctx.lineTo(hx, hy);
  ctx.strokeStyle = "#fde68a";
  ctx.lineWidth = 2.2 * px;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(hx, hy, 6 * px, 0, Math.PI * 2);
  ctx.fillStyle = "#fbbf24";
  ctx.fill();
  ctx.strokeStyle = "#0f172a";
  ctx.lineWidth = 1.2 * px;
  ctx.stroke();

  if (opts?.obstacle && pose.size != null) {
    ctx.strokeStyle = "rgba(244, 114, 182, 0.9)";
    ctx.fillStyle = "rgba(244, 114, 182, 0.25)";
    ctx.lineWidth = 1.5 * px;
    if (opts.shape === "circle") {
      ctx.beginPath();
      ctx.arc(pose.x, pose.y, pose.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      const verts = opts.shape === "triangle"
        ? triangleVerts({ ...pose, size: pose.size, kind: "triangle", id: "draft" })
        : squareVerts({ ...pose, size: pose.size, kind: "square", id: "draft" });
      ctx.beginPath();
      ctx.moveTo(verts[0][0], verts[0][1]);
      for (let i = 1; i < verts.length; i++) ctx.lineTo(verts[i][0], verts[i][1]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function hitPoseEditor(
  pose: { x: number; y: number; theta: number },
  x: number,
  y: number,
  px: number,
): "rotate" | "body" | null {
  const hx = pose.x + Math.cos(pose.theta) * POSE_ROTATE_R;
  const hy = pose.y + Math.sin(pose.theta) * POSE_ROTATE_R;
  if (dist(x, y, hx, hy) <= 10 * px) return "rotate";
  if (dist(x, y, pose.x, pose.y) <= 14 * px) return "body";
  return null;
}

export type ZoneHandle =
  | { type: "vertex"; id: string; index: number }
  | { type: "mid"; id: string; index: number }
  | { type: "label"; id: string };

export function drawWorld(
  ctx: CanvasRenderingContext2D,
  snap: Snapshot,
  images: {
    map: CanvasImageSource;
    waypoint: HTMLImageElement;
    charger: HTMLImageElement;
    robots: Record<string, HTMLImageElement>;
    occ?: HTMLCanvasElement | null;
  },
  opts: DrawOpts,
): void {
  ctx.drawImage(images.map, 0, 0, opts.mapWidth, opts.mapHeight);
  if (images.occ) ctx.drawImage(images.occ, 0, 0);

  if (opts.dimOthers) {
    ctx.fillStyle = "rgba(7, 11, 20, 0.42)";
    ctx.fillRect(0, 0, opts.mapWidth, opts.mapHeight);
  }

  const hide = opts.hideId;

  if (opts.layers.zones) {
    for (const z of snap.zones) {
      if (hide && z.id === hide) continue;
      const fill = ZONE_FILL[z.kind] ?? "rgba(148,163,184,0.2)";
      const poly = opts.zonePreview?.id === z.id ? opts.zonePreview.polygon : z.polygon;
      const sel = z.id === opts.selectedId;
      const alphaFill = opts.dimOthers && !sel ? fill.replace(/[\d.]+\)$/, "0.12)") : fill;
      drawPoly(ctx, poly, alphaFill, sel ? "#f8fafc" : "rgba(226,232,240,0.45)", sel ? 2.4 : 1);
    }
    const orphan = opts.zonePreview && !snap.zones.some((z) => z.id === opts.zonePreview!.id) ? opts.zonePreview : null;
    if (orphan && orphan.polygon.length >= 3) {
      drawPoly(ctx, orphan.polygon, "rgba(251, 191, 36, 0.22)", "#fbbf24", 2);
      drawZoneLabel(ctx, orphan.polygon, "draft", true, opts.px ?? 1);
      drawZoneHandles(ctx, orphan.polygon, opts.selectedVertex, opts.px ?? 1);
    }
    for (const z of snap.zones) {
      if (hide && z.id === hide) continue;
      const poly = opts.zonePreview?.id === z.id ? opts.zonePreview.polygon : z.polygon;
      if (poly.length < 3) continue;
      drawZoneLabel(ctx, poly, zoneLabel(z), z.id === opts.selectedId, opts.px ?? 1);
      if (z.id === opts.selectedId || (opts.zonePreview?.id === z.id)) {
        drawZoneHandles(ctx, poly, opts.selectedVertex, opts.px ?? 1);
      }
    }
  }

  if (opts.layers.graph) {
    for (const e of snap.edges) {
      const pts = edgePoints(e, snap);
      if (opts.layers.corridor && e.corridor) {
        const lp = metersToPx(e.corridor.leftWidth, PIXEL_CM);
        const rp = metersToPx(e.corridor.rightWidth, PIXEL_CM);
        const rib = ribbon(pts, lp, rp);
        if (rib.length) drawPoly(ctx, rib, "rgba(56,189,248,0.16)", "rgba(56,189,248,0.5)", 1);
      }
      if (pts.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.strokeStyle = e.id === opts.selectedId ? "#e0f2fe" : "#38bdf8";
        ctx.lineWidth = e.id === opts.selectedId ? 3 : 2;
        ctx.stroke();
      }
    }
    for (const n of snap.nodes) {
      if (hide && n.id === hide) continue;
      ctx.beginPath();
      ctx.arc(n.x, n.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = n.id === opts.selectedId ? "#e0f2fe" : "#22d3ee";
      ctx.globalAlpha = opts.dimOthers && n.id !== opts.selectedId ? 0.35 : 1;
      ctx.fill();
      ctx.strokeStyle = "#0e7490";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
      drawHeading(ctx, n.x, n.y, n.theta, "#a5f3fc", 16);
    }
  }

  for (const r of snap.rails) {
    if (r.points.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(r.points[0].x, r.points[0].y);
    for (let i = 1; i < r.points.length; i++) ctx.lineTo(r.points[i].x, r.points[i].y);
    ctx.strokeStyle = r.id === opts.selectedId ? "#fde68a" : "#fbbf24";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const p of snap.portals) {
    ctx.strokeStyle = p.id === opts.selectedId ? "#f5d0fe" : "#e879f9";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(p.ax, p.ay);
    ctx.lineTo(p.bx, p.by);
    ctx.stroke();
  }

  if (opts.layers.scene) {
    for (const o of snap.obstacles) {
      if (hide && o.id === hide) continue;
      ctx.globalAlpha = opts.dimOthers && o.id !== opts.selectedId ? 0.3 : 1;
      drawObstacle(ctx, o);
      ctx.globalAlpha = 1;
    }
    for (const w of snap.waypoints) {
      if (hide && w.id === hide) continue;
      ctx.globalAlpha = opts.dimOthers && w.id !== opts.selectedId ? 0.3 : 1;
      drawIcon(ctx, images.waypoint, w.x, w.y, w.theta, 24, w.id === opts.selectedId);
      ctx.globalAlpha = 1;
    }
    for (const c of snap.chargers) {
      if (hide && c.id === hide) continue;
      ctx.globalAlpha = opts.dimOthers && c.id !== opts.selectedId ? 0.3 : 1;
      drawIcon(ctx, images.charger, c.x, c.y, c.theta, 24, c.id === opts.selectedId);
      ctx.globalAlpha = 1;
    }
  }
  for (const s of snap.stations) {
    if (hide && s.id === hide) continue;
    ctx.globalAlpha = opts.dimOthers && s.id !== opts.selectedId ? 0.35 : 1;
    ctx.beginPath();
    ctx.rect(s.x - 10, s.y - 10, 20, 20);
    ctx.strokeStyle = s.id === opts.selectedId ? "#fff" : "#c4b5fd";
    ctx.lineWidth = 2;
    ctx.stroke();
    drawHeading(ctx, s.x, s.y, s.theta, "#ddd6fe", 16);
    ctx.globalAlpha = 1;
  }

  if (opts.layers.robots) {
    for (const r of snap.robots) {
      if (r.localPath.length > 1) {
        ctx.beginPath();
        ctx.moveTo(r.localPath[0].x, r.localPath[0].y);
        for (let i = 1; i < r.localPath.length; i++) ctx.lineTo(r.localPath[i].x, r.localPath[i].y);
        ctx.strokeStyle = "#fbbf24";
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (r.path.length > 1) {
        ctx.beginPath();
        ctx.moveTo(r.path[0].x, r.path[0].y);
        for (let i = 1; i < r.path.length; i++) ctx.lineTo(r.path[i].x, r.path[i].y);
        ctx.strokeStyle = ROBOT_COLOR[r.id] ?? "#94a3b8";
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const img = images.robots[r.id];
      if (img) drawIcon(ctx, img, r.x, r.y, r.theta, 20, r.id === opts.selectedId);
      drawRobotRuntime(ctx, r, r.id === opts.selectedId, opts.px ?? 1);
    }
  }

  if (opts.draftPoly && opts.draftPoly.length) {
    const invalid = Boolean(opts.draftInvalid);
    const stroke = invalid ? "#f87171" : "#f8fafc";
    const pts = opts.draftCursor ? [...opts.draftPoly, opts.draftCursor] : opts.draftPoly;
    if (pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.6;
      ctx.setLineDash(invalid ? [5, 4] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (opts.draftPoly.length >= 3 && !opts.draftCursor) {
      drawPoly(ctx, opts.draftPoly, "rgba(226,232,240,0.12)", stroke, 1.5);
    } else if (opts.draftPoly.length >= 3 && opts.draftCursor && !invalid) {
      drawPoly(ctx, [...opts.draftPoly, opts.draftCursor], "rgba(226,232,240,0.08)", stroke, 1);
    }
    const px = opts.px ?? 1;
    const r = 4 * px;
    for (let i = 0; i < opts.draftPoly.length; i++) {
      const p = opts.draftPoly[i];
      ctx.fillStyle = i === 0 ? "#2dd4bf" : "#fff";
      ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
    }
  }
  if (opts.draftLine && opts.draftLine.length) {
    ctx.beginPath();
    ctx.moveTo(opts.draftLine[0].x, opts.draftLine[0].y);
    for (let i = 1; i < opts.draftLine.length; i++) ctx.lineTo(opts.draftLine[i].x, opts.draftLine[i].y);
    ctx.strokeStyle = "#f8fafc";
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function zoneLabel(z: { name?: string; kind: string }): string {
  const name = z.name?.trim() || z.kind;
  return name.length > 24 ? name.slice(0, 23) + '…' : name;
}

function drawZoneLabel(ctx: CanvasRenderingContext2D, poly: Point[], kind: string, selected: boolean, px: number): void {
  const c = centroid(poly);
  const { w, h } = labelMetrics(kind, px);
  ctx.save();
  ctx.fillStyle = selected ? "rgba(15, 23, 42, 0.92)" : "rgba(15, 23, 42, 0.72)";
  ctx.strokeStyle = selected ? "#f8fafc" : "rgba(226,232,240,0.55)";
  ctx.lineWidth = 1 * px;
  const x = c.x - w / 2;
  const y = c.y - h / 2;
  const r = 4 * px;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = selected ? "#f8fafc" : "#cbd5e1";
  ctx.font = `${11 * px}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(kind, c.x, c.y);
  ctx.restore();
}

function drawZoneHandles(ctx: CanvasRenderingContext2D, poly: Point[], selectedVertex: number | undefined, px: number): void {
  const vr = 5 * px;
  const mr = 3.2 * px;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const m = edgeMid(a, b);
    ctx.fillStyle = "rgba(15,23,42,0.85)";
    ctx.strokeStyle = "#94a3b8";
    ctx.lineWidth = 1 * px;
    ctx.beginPath();
    ctx.arc(m.x, m.y, mr, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    ctx.fillStyle = i === selectedVertex ? "#2dd4bf" : "#f8fafc";
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 1 * px;
    ctx.fillRect(p.x - vr, p.y - vr, vr * 2, vr * 2);
    ctx.strokeRect(p.x - vr, p.y - vr, vr * 2, vr * 2);
  }
}

export function hitZoneHandle(
  snap: Snapshot,
  x: number,
  y: number,
  selectedId: string | undefined,
  px: number,
  preview?: { id: string; polygon: Point[] },
): ZoneHandle | null {
  const hitR = Math.max(8 * px, 6);
  if (selectedId) {
    const z = snap.zones.find((w) => w.id === selectedId);
    const poly = preview?.id === selectedId ? preview.polygon : z?.polygon;
    if (poly && poly.length >= 3) {
      for (let i = 0; i < poly.length; i++) {
        if (dist(x, y, poly[i].x, poly[i].y) <= hitR) return { type: "vertex", id: selectedId, index: i };
      }
      for (let i = 0; i < poly.length; i++) {
        const m = edgeMid(poly[i], poly[(i + 1) % poly.length]);
        if (dist(x, y, m.x, m.y) <= hitR * 0.85) return { type: "mid", id: selectedId, index: i };
      }
    }
  }
  for (const z of [...snap.zones].reverse()) {
    const poly = preview?.id === z.id ? preview.polygon : z.polygon;
    if (poly.length < 3) continue;
    const c = centroid(poly);
    if (pointInLabel(x, y, c, zoneLabel(z), px)) return { type: "label", id: z.id };
  }
  return null;
}

function drawIcon(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  theta: number,
  size: number,
  selected: boolean,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(theta + Math.PI / 2);
  ctx.drawImage(img, -size / 2, -size / 2, size, size);
  ctx.restore();
  if (selected) {
    ctx.strokeStyle = "#f8fafc";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x - size / 2 - 2, y - size / 2 - 2, size + 4, size + 4);
  }
}

export function nearPoint(x: number, y: number, px: number, py: number, r = 12): boolean {
  return dist(x, y, px, py) <= r;
}

export type Hit =
  | { kind: string; id: string }
  | null;

export function hitTest(snap: Snapshot, x: number, y: number): Hit {
  for (const r of snap.robots) if (nearPoint(x, y, r.x, r.y, 12)) return { kind: "robot", id: r.id };
  for (const n of snap.nodes) if (nearPoint(x, y, n.x, n.y, 10)) return { kind: "node", id: n.id };
  for (const s of snap.stations) if (nearPoint(x, y, s.x, s.y, 12)) return { kind: "station", id: s.id };
  for (const w of snap.waypoints) if (nearPoint(x, y, w.x, w.y, 13)) return { kind: "waypoint", id: w.id };
  for (const c of snap.chargers) if (nearPoint(x, y, c.x, c.y, 13)) return { kind: "charger", id: c.id };
  for (const o of snap.obstacles) if (nearPoint(x, y, o.x, o.y, o.size + 2)) return { kind: "obstacle", id: o.id };
  for (const p of snap.portals) {
    if (distToSeg(x, y, p.ax, p.ay, p.bx, p.by) < 6) return { kind: "portal", id: p.id };
  }
  for (const e of snap.edges) {
    const a = snap.nodes.find((n) => n.id === e.startNodeId);
    const b = snap.nodes.find((n) => n.id === e.endNodeId);
    if (!a || !b) continue;
    if (distToSeg(x, y, a.x, a.y, b.x, b.y) < 8) return { kind: "edge", id: e.id };
  }
  for (const z of [...snap.zones].reverse()) {
    if (z.polygon.length >= 3 && pointInPoly(x, y, z.polygon)) return { kind: "zone", id: z.id };
  }
  return null;
}
