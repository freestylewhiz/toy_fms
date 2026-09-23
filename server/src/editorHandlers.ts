import { MAP_ID } from "../../shared/constants.ts";
import { CorridorReferencePoints, EdgeReleaseLossBehaviors, FactorZoneKinds, StationKinds } from "../../shared/config/index.ts";
import type { Client } from "@colyseus/core";
import { isFree } from "../../shared/occupancy.ts";
import {
  DEFAULT_EDGE_CORRIDOR,
  SCENE_ZONE_KINDS,
  VDA_ZONE_KINDS,
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

const MAX_ZONE_VERTICES = 256;
const FACTOR_ZONE_KINDS = new Set<ZoneKind>(FactorZoneKinds.values);

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const n = Number(value);
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
  if (!Array.isArray(raw) || raw.length < 3 || raw.length > MAX_ZONE_VERTICES) return null;
  const out: Point[] = [];
  for (const p of raw) {
    const x = num((p as { x?: unknown })?.x);
    const y = num((p as { y?: unknown })?.y);
    if (x === null || y === null) return null;
    out.push({ x, y });
  }
  return out;
}

type ParsedZone = Omit<ZoneResource, "id" | "name">;
type ZoneParseResult = { zone: ParsedZone } | { error: string };

/**
 * Validate the wire representation before it becomes a durable semantic
 * snapshot.  The same snapshot is published to robots, so accepting values
 * which navigation later clamps or ignores would make editor state misleading.
 */
export function parseZoneUpsert(payload: Record<string, unknown>): ZoneParseResult {
  const rawPoly = points(payload.polygon);
  if (!rawPoly) return { error: `zone needs 3-${MAX_ZONE_VERTICES} finite vertices` };
  if (!isSimplePolygon(rawPoly)) return { error: "존이 접히면 안 돼. 꼭짓점을 다시 잡아" };
  const polygon = ensureCcw(rawPoly);
  if (Math.abs(polygon.reduce((a, p, i) => a + p.x * polygon[(i + 1) % polygon.length].y - polygon[(i + 1) % polygon.length].x * p.y, 0)) < 1e-6) {
    return { error: "zone area must be nonzero" };
  }

  const kind = str(payload.zoneKind) as ZoneKind;
  if (!kind) return { error: "zoneKind required" };
  const suppliedFamily = str(payload.family);
  if (suppliedFamily && suppliedFamily !== "scene" && suppliedFamily !== "vda") return { error: "invalid zone family" };
  // Older editor clients did not send family. Infer it from the stable kind
  // vocabulary so their persisted snapshot remains compatible.
  const family: ZoneResource["family"] = suppliedFamily === "vda" ? "vda" : suppliedFamily === "scene" ? "scene" : (VDA_ZONE_KINDS.includes(kind) ? "vda" : "scene");
  const allowedKinds = family === "scene" ? SCENE_ZONE_KINDS : VDA_ZONE_KINDS;
  if (!allowedKinds.includes(kind)) return { error: `invalid ${family} zoneKind` };

  const factor = num(payload.factor);
  if ("factor" in payload) {
    if (factor === null) return { error: "factor must be finite" };
    if (!FACTOR_ZONE_KINDS.has(kind)) return { error: "factor is only valid for prefer, avoid, priority, and penalty zones" };
    if (factor < 0) return { error: "factor must be nonnegative" };
  }
  const maximumSpeed = num(payload.maximumSpeed);
  if ("maximumSpeed" in payload && maximumSpeed === null) return { error: "maximumSpeed must be finite" };
  if (maximumSpeed !== null && maximumSpeed < 0) return { error: "maximumSpeed must be nonnegative" };
  const capacity = num(payload.capacity);
  if ("capacity" in payload && capacity === null) return { error: "capacity must be finite" };
  if (capacity !== null && capacity < 0) return { error: "capacity must be nonnegative" };

  return {
    zone: {
      family,
      kind,
      polygon,
      theta: num(payload.theta) ?? 0,
      factor: factor ?? undefined,
      maximumSpeed: maximumSpeed ?? undefined,
      capacity: capacity ?? undefined,
      direction: num(payload.direction) ?? undefined,
      directedLimitation: (str(payload.directedLimitation) as ZoneResource["directedLimitation"]) || undefined,
      releaseLossBehavior: (str(payload.releaseLossBehavior) as ZoneResource["releaseLossBehavior"]) || undefined,
    },
  };
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
    const parsed = parseZoneUpsert(payload);
    if ("error" in parsed) { deny(client, parsed.error); return null; }
    const id = str(payload.id) || newResourceId(parsed.zone.family === "vda" ? "vz" : "sz");
    const row: ZoneResource = {
      id,
      name: str(payload.name) || id,
      ...parsed.zone,
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
      mapId: MAP_ID,
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
        corridorReferencePoint: CorridorReferencePoints.is(corridorRaw.corridorReferencePoint)
          ? corridorRaw.corridorReferencePoint : CorridorReferencePoints.code.KINEMATIC_CENTER,
        releaseRequired: Boolean(corridorRaw.releaseRequired),
        releaseLossBehavior: EdgeReleaseLossBehaviors.is(corridorRaw.releaseLossBehavior)
          ? corridorRaw.releaseLossBehavior : EdgeReleaseLossBehaviors.code.STOP,
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
      kind: StationKinds.is(sk) ? sk : StationKinds.code.other,
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
