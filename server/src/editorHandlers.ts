import type { Client } from "@colyseus/core";
import { isFree } from "../../shared/occupancy.ts";
import {
  DEFAULT_EDGE_CORRIDOR,
  type GraphEdge,
  type GraphNode,
  type Point,
  type Portal,
  type Rail,
  type SceneObstacle,
  type VdaStation,
  type ZoneKind,
  type ZoneResource,
} from "../../shared/semantic.ts";
import { centroid as polyCentroid, ensureCcw, isSimplePolygon } from "../../shared/polygon.ts";
import type { FloorState } from "./schema.ts";
import {
  persistAndSetCharger,
  persistAndSetObstacle,
  persistAndSetEdge,
  persistAndSetNode,
  persistAndSetPortal,
  persistAndSetRail,
  persistAndSetStation,
  persistAndSetWaypoint,
  persistAndSetZone,
  persistDelete,
} from "./editorSync.ts";

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function deny(client: Client, message: string) {
  client.send("error", { message });
}

export function nextId(prefix: string, used: Iterable<string>): string {
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const id of used) {
    const m = id.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${max + 1}`;
}

/** IDs supplied by old maps remain untouched; new resources use non-reusable UUIDs. */
export function newResourceId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function points(raw: unknown): Point[] | null {
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const out: Point[] = [];
  for (const p of raw) {
    const x = num((p as { x?: unknown })?.x);
    const y = num((p as { y?: unknown })?.y);
    if (x === null || y === null) return null;
    out.push({ x, y });
  }
  return out;
}

export function handleEditorUpsert(state: FloorState, client: Client, payload: Record<string, unknown>): string | null {
  const kind = str(payload.kind);
  for (const key of ["x", "y", "theta", "size", "factor", "maximumSpeed", "capacity", "direction", "allowedDeviationXY", "allowedDeviationTheta"]) {
    if (key in payload && num(payload[key]) === null) { deny(client, `${key} must be finite`); return null; }
  }
  if (kind === "waypoint" || kind === "charger") {
    const x = num(payload.x);
    const y = num(payload.y);
    const theta = num(payload.theta) ?? 0;
    if (x === null || y === null) {
      deny(client, "x,y required");
      return null;
    }
    if (!isFree(x, y)) {
      deny(client, "not free");
      return null;
    }
    if (kind === "waypoint") {
      const id = str(payload.id) || newResourceId("wp");
      persistAndSetWaypoint(state, { id, x, y, theta, name: str(payload.name) || id });
      return id;
    }
    const id = str(payload.id) || newResourceId("cs");
    persistAndSetCharger(state, { id, x, y, theta, name: str(payload.name) || id });
    return id;
  }

  if (kind === "obstacle") {
    const x = num(payload.x), y = num(payload.y), theta = num(payload.theta) ?? 0;
    const size = num(payload.size) ?? 16;
    if (x === null || y === null || !Number.isFinite(size) || size <= 0) { deny(client, "obstacle needs valid x,y,size"); return null; }
    const obstacleKind = str(payload.obstacleKind || payload.kindName) as SceneObstacle["kind"];
    const validKind = obstacleKind === "triangle" || obstacleKind === "square" || obstacleKind === "circle" ? obstacleKind : "square";
    const id = str(payload.id) || newResourceId("ob");
    persistAndSetObstacle(state, { id, name: str(payload.name) || id, kind: validKind, x, y, theta, size });
    return id;
  }

  if (kind === "zone") {
    const rawPoly = points(payload.polygon);
    if (!rawPoly) {
      deny(client, "zone needs ≥3 vertices");
      return null;
    }
    if (!isSimplePolygon(rawPoly)) {
      deny(client, "존이 접히면 안 돼. 꼭짓점을 다시 잡아");
      return null;
    }
    const polygon = ensureCcw(rawPoly);
    const zKind = str(payload.zoneKind) as ZoneKind;
    if (!zKind) {
      deny(client, "zoneKind required");
      return null;
    }
    if (!(["forbidden", "prefer", "avoid", "corridor", "complex", "blocked", "release", "line_guided", "speed_limit", "priority", "penalty", "directed", "bidirected", "replanning", "action_zone"] as string[]).includes(zKind)) { deny(client, "invalid zoneKind"); return null; }
    if (Math.abs(polygon.reduce((a, p, i) => a + p.x * polygon[(i + 1) % polygon.length].y - polygon[(i + 1) % polygon.length].x * p.y, 0)) < 1e-6) { deny(client, "zone area must be nonzero"); return null; }
    if (num(payload.factor) !== null && (num(payload.factor)! < 0)) { deny(client, "factor must be nonnegative"); return null; }
    if (num(payload.maximumSpeed) !== null && num(payload.maximumSpeed)! < 0) { deny(client, "maximumSpeed must be nonnegative"); return null; }
    if (num(payload.capacity) !== null && num(payload.capacity)! < 0) { deny(client, "capacity must be nonnegative"); return null; }
    const family = str(payload.family) === "vda" ? "vda" : "scene";
    const id = str(payload.id) || newResourceId(family === "vda" ? "vz" : "sz");
    const row: ZoneResource = {
      id,
      family,
      kind: zKind,
      name: str(payload.name) || id,
      polygon,
      theta: num(payload.theta) ?? 0,
      factor: num(payload.factor) ?? undefined,
      maximumSpeed: num(payload.maximumSpeed) ?? undefined,
      capacity: num(payload.capacity) ?? undefined,
      direction: num(payload.direction) ?? undefined,
      directedLimitation: (str(payload.directedLimitation) as ZoneResource["directedLimitation"]) || undefined,
      releaseLossBehavior: (str(payload.releaseLossBehavior) as ZoneResource["releaseLossBehavior"]) || undefined,
    };
    persistAndSetZone(state, row);
    return id;
  }

  if (kind === "node") {
    const x = num(payload.x);
    const y = num(payload.y);
    const theta = num(payload.theta) ?? 0;
    if (x === null || y === null) {
      deny(client, "node x,y required");
      return null;
    }
    if (!isFree(x, y)) {
      deny(client, "not free");
      return null;
    }
    const id = str(payload.id) || newResourceId("n");
    const row: GraphNode = {
      id,
      x,
      y,
      theta,
      name: str(payload.name) || id,
      mapId: str(payload.mapId) || "yard",
      allowedDeviationXY: num(payload.allowedDeviationXY) ?? undefined,
      allowedDeviationTheta: num(payload.allowedDeviationTheta) ?? undefined,
      actions: Array.isArray(payload.actions) ? (payload.actions as GraphNode["actions"]) : [],
    };
    persistAndSetNode(state, row);
    return id;
  }

  if (kind === "edge") {
    const startNodeId = str(payload.startNodeId);
    const endNodeId = str(payload.endNodeId);
    if (!startNodeId || !endNodeId || startNodeId === endNodeId) {
      deny(client, "edge needs two distinct nodes");
      return null;
    }
    if (!state.nodes.has(startNodeId) || !state.nodes.has(endNodeId)) {
      deny(client, "unknown node");
      return null;
    }
    const id = str(payload.id) || newResourceId("e");
    const traj = Array.isArray(payload.trajectory) ? (payload.trajectory as Point[]) : [];
    const corridorRaw = payload.corridor && typeof payload.corridor === "object" ? (payload.corridor as Record<string, unknown>) : {};
    for (const value of [payload.maximumSpeed, corridorRaw.leftWidth, corridorRaw.rightWidth]) {
      if (value != null && (num(value) === null || Number(value) < 0)) { deny(client, 'edge speed and widths must be non-negative'); return null; }
    }
    if (traj.some(p => !Number.isFinite(p?.x) || !Number.isFinite(p?.y))) { deny(client, 'trajectory needs finite points'); return null; }
    const row: GraphEdge = {
      id,
      name: str(payload.name) || id,
      startNodeId,
      endNodeId,
      theta: num(payload.theta) ?? 0,
      maximumSpeed: num(payload.maximumSpeed) ?? undefined,
      trajectory: traj,
      corridor: {
        leftWidth: num(corridorRaw.leftWidth) ?? DEFAULT_EDGE_CORRIDOR.leftWidth,
        rightWidth: num(corridorRaw.rightWidth) ?? DEFAULT_EDGE_CORRIDOR.rightWidth,
        corridorReferencePoint:
          corridorRaw.corridorReferencePoint === "CONTOUR" ? "CONTOUR" : "KINEMATIC_CENTER",
        releaseRequired: Boolean(corridorRaw.releaseRequired),
        releaseLossBehavior: corridorRaw.releaseLossBehavior === "RETURN" ? "RETURN" : "STOP",
      },
    };
    persistAndSetEdge(state, row);
    return id;
  }

  if (kind === "station") {
    const x = num(payload.x);
    const y = num(payload.y);
    const theta = num(payload.theta) ?? 0;
    if (x === null || y === null) {
      deny(client, "station x,y required");
      return null;
    }
    if (!isFree(x, y)) {
      deny(client, "not free");
      return null;
    }
    const id = str(payload.id) || newResourceId("st");
    const sk = str(payload.stationKind);
    const row: VdaStation = {
      id,
      x,
      y,
      theta,
      name: str(payload.name) || id,
      kind: sk === "charger" || sk === "pick_drop" || sk === "wait" || sk === "other" ? sk : "other",
      interactionNodeIds: Array.isArray(payload.interactionNodeIds)
        ? payload.interactionNodeIds.map((v) => String(v))
        : [],
    };
    persistAndSetStation(state, row);
    return id;
  }

  if (kind === "portal") {
    const ax = num(payload.ax);
    const ay = num(payload.ay);
    const bx = num(payload.bx);
    const by = num(payload.by);
    const zoneId = str(payload.zoneId);
    if (ax === null || ay === null || bx === null || by === null || !zoneId) {
      deny(client, "portal needs zone + segment");
      return null;
    }
    const id = str(payload.id) || newResourceId("pt");
    const waitPose = payload.waitPose && typeof payload.waitPose === "object" ? payload.waitPose as Portal["waitPose"] : undefined;
    const row: Portal = { id, name: str(payload.name) || id, zoneId, a: { x: ax, y: ay }, b: { x: bx, y: by }, waitPose };
    persistAndSetPortal(state, row);
    return id;
  }

  if (kind === "rail") {
    const zoneId = str(payload.zoneId);
    const pts = Array.isArray(payload.points) ? (payload.points as Point[]) : [];
    if (!zoneId || pts.length < 2) {
      deny(client, "rail needs zone + ≥2 points");
      return null;
    }
    if (pts.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) { deny(client, "rail points must be finite"); return null; }
    const id = str(payload.id) || newResourceId("rl");
    const row: Rail = { id, name: str(payload.name) || id, zoneId, points: pts, theta: num(payload.theta) ?? 0 };
    persistAndSetRail(state, row);
    return id;
  }

  deny(client, `unknown editor kind ${kind}`);
  return null;
}

export function handleEditorDelete(state: FloorState, client: Client, payload: Record<string, unknown>): void {
  const kind = str(payload.kind);
  const id = str(payload.id);
  if (!kind || !id) {
    deny(client, "kind+id required");
    return;
  }
  if (!persistDelete(state, kind, id)) deny(client, `cannot delete ${kind} ${id}`);
}

export function zoneCentroidHint(polygon: Point[]): Point {
  return polyCentroid(polygon);
}
