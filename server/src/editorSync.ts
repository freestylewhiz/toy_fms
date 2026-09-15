import type { FloorState } from "./schema.ts";
import {
  ChargingStation,
  GraphEdge,
  GraphNode,
  Obstacle,
  Portal,
  Rail,
  VdaStation,
  Waypoint,
  Zone,
} from "./schema.ts";
import { editorStore } from "../../shared/store.ts";
import {
  DEFAULT_EDGE_CORRIDOR,
  type GraphEdge as EdgeRow,
  type GraphNode as NodeRow,
  type Portal as PortalRow,
  type Rail as RailRow,
  type SceneCharger,
  type SceneObstacle,
  type SceneWaypoint,
  type SemanticSnapshot,
  type VdaStation as StationRow,
  type ZoneResource,
} from "../../shared/semantic.ts";

export function hydrateEditor(state: FloorState, snap: SemanticSnapshot): void {
  state.waypoints.clear();
  state.chargingStations.clear();
  state.obstacles.clear();
  state.zones.clear();
  state.nodes.clear();
  state.edges.clear();
  state.stations.clear();
  state.portals.clear();
  state.rails.clear();

  for (const w of snap.waypoints) state.waypoints.set(w.id, toWaypoint(w));
  for (const c of snap.chargers) state.chargingStations.set(c.id, toCharger(c));
  for (const o of snap.obstacles) state.obstacles.set(o.id, toObstacle(o));
  for (const z of snap.zones) state.zones.set(z.id, toZone(z));
  for (const n of snap.nodes) state.nodes.set(n.id, toNode(n));
  for (const e of snap.edges) state.edges.set(e.id, toEdge(e));
  for (const s of snap.stations) state.stations.set(s.id, toStation(s));
  for (const p of snap.portals) state.portals.set(p.id, toPortal(p));
  for (const r of snap.rails) state.rails.set(r.id, toRail(r));
}

export function persistAndSetWaypoint(state: FloorState, row: SceneWaypoint): void {
  editorStore().upsertWaypoint(row);
  state.waypoints.set(row.id, toWaypoint(row));
}
export function persistAndSetCharger(state: FloorState, row: SceneCharger): void {
  editorStore().upsertCharger(row);
  state.chargingStations.set(row.id, toCharger(row));
}
export function persistAndSetObstacle(state: FloorState, row: SceneObstacle): void {
  editorStore().upsertObstacle(row);
  state.obstacles.set(row.id, toObstacle(row));
}
export function persistAndSetZone(state: FloorState, row: ZoneResource): void {
  editorStore().upsertZone(row);
  state.zones.set(row.id, toZone(row));
}
export function persistAndSetNode(state: FloorState, row: NodeRow): void {
  editorStore().upsertNode(row);
  state.nodes.set(row.id, toNode(row));
}
export function persistAndSetEdge(state: FloorState, row: EdgeRow): void {
  editorStore().upsertEdge(row);
  state.edges.set(row.id, toEdge(row));
}
export function persistAndSetStation(state: FloorState, row: StationRow): void {
  editorStore().upsertStation(row);
  state.stations.set(row.id, toStation(row));
}
export function persistAndSetPortal(state: FloorState, row: PortalRow): void {
  editorStore().upsertPortal(row);
  state.portals.set(row.id, toPortal(row));
}
export function persistAndSetRail(state: FloorState, row: RailRow): void {
  editorStore().upsertRail(row);
  state.rails.set(row.id, toRail(row));
}

const TABLE: Record<string, string> = {
  waypoint: "waypoints",
  charger: "chargers",
  obstacle: "obstacles",
  zone: "zones",
  node: "nodes",
  edge: "edges",
  station: "stations",
  portal: "portals",
  rail: "rails",
  forbidden: "zones",
  prefer: "zones",
  avoid: "zones",
  corridor: "zones",
  complex: "zones",
};

export function persistDelete(state: FloorState, kind: string, id: string): boolean {
  const table = TABLE[kind];
  if (!table) return false;
  editorStore().delete(table, id);
  const maps: Record<string, { delete: (id: string) => void; has: (id: string) => boolean }> = {
    waypoint: state.waypoints,
    charger: state.chargingStations,
    obstacle: state.obstacles,
    zone: state.zones,
    node: state.nodes,
    edge: state.edges,
    station: state.stations,
    portal: state.portals,
    rail: state.rails,
  };
  const m = maps[kind] ?? (TABLE[kind] === "zones" ? maps.zone : undefined);
  if (!m?.has(id)) return false;
  m.delete(id);
  return true;
}

function toWaypoint(w: SceneWaypoint): Waypoint {
  const item = new Waypoint();
  item.id = w.id;
  item.name = w.name ?? w.id;
  item.x = w.x;
  item.y = w.y;
  item.theta = w.theta;
  return item;
}
function toCharger(c: SceneCharger): ChargingStation {
  const item = new ChargingStation();
  item.id = c.id;
  item.name = c.name ?? c.id;
  item.x = c.x;
  item.y = c.y;
  item.theta = c.theta;
  return item;
}
function toObstacle(o: SceneObstacle): Obstacle {
  const item = new Obstacle();
  item.id = o.id;
  item.name = o.name ?? o.id;
  item.kind = o.kind;
  item.x = o.x;
  item.y = o.y;
  item.size = o.size;
  item.theta = o.theta;
  return item;
}
function toZone(z: ZoneResource): Zone {
  const item = new Zone();
  item.id = z.id;
  item.family = z.family;
  item.kind = z.kind;
  item.name = z.name;
  item.polygonJson = JSON.stringify(z.polygon);
  item.theta = z.theta;
  item.paramsJson = JSON.stringify({
    factor: z.factor,
    maximumSpeed: z.maximumSpeed,
    capacity: z.capacity,
    direction: z.direction,
    directedLimitation: z.directedLimitation,
    releaseLossBehavior: z.releaseLossBehavior,
  });
  return item;
}
function toNode(n: NodeRow): GraphNode {
  const item = new GraphNode();
  item.id = n.id;
  item.x = n.x;
  item.y = n.y;
  item.theta = n.theta;
  item.name = n.name;
  item.mapId = n.mapId;
  item.allowedDeviationXY = n.allowedDeviationXY ?? 0;
  item.allowedDeviationTheta = n.allowedDeviationTheta ?? 0;
  item.actionsJson = JSON.stringify(n.actions ?? []);
  return item;
}
function toEdge(e: EdgeRow): GraphEdge {
  const item = new GraphEdge();
  item.id = e.id;
  item.name = e.name;
  item.startNodeId = e.startNodeId;
  item.endNodeId = e.endNodeId;
  item.theta = e.theta;
  item.maximumSpeed = e.maximumSpeed ?? 0;
  item.trajectoryJson = JSON.stringify(e.trajectory ?? []);
  item.corridorJson = JSON.stringify(e.corridor ?? DEFAULT_EDGE_CORRIDOR);
  return item;
}
function toStation(s: StationRow): VdaStation {
  const item = new VdaStation();
  item.id = s.id;
  item.x = s.x;
  item.y = s.y;
  item.theta = s.theta;
  item.name = s.name;
  item.kind = s.kind;
  item.interactionJson = JSON.stringify(s.interactionNodeIds ?? []);
  return item;
}
function toPortal(p: PortalRow): Portal {
  const item = new Portal();
  item.id = p.id;
  item.name = p.name ?? p.id;
  item.zoneId = p.zoneId;
  item.ax = p.a.x;
  item.ay = p.a.y;
  item.bx = p.b.x;
  item.by = p.b.y;
  item.theta = p.waitPose?.theta ?? 0;
  item.waitPoseJson = p.waitPose ? JSON.stringify(p.waitPose) : "";
  return item;
}
function toRail(r: RailRow): Rail {
  const item = new Rail();
  item.id = r.id;
  item.name = r.name ?? r.id;
  item.zoneId = r.zoneId;
  item.pointsJson = JSON.stringify(r.points);
  item.theta = r.theta;
  return item;
}
