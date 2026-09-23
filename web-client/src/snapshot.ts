import { parseObstacleKind, type DynObstacle, type ObstacleKind } from "../../shared/obstacles.ts";
import { DEFAULT_EDGE_CORRIDOR, type EdgeCorridor, type Point, type ResourceFamily, type ZoneKind } from "../../shared/semantic.ts";
import { parseDriveContexts, parseDriveState, parseWorkState, type ResourceOccupancy } from "../../shared/robotRuntime.ts";
import {
  CommandStates, ConnectionStates, DriveStates, FmsControlStates, NavigationModes, WorkStates,
  PathPlanningAuthorities, RobotStatuses, TrafficStatuses,
  DirectedLimitations, ObstacleKinds, ResourceFamilies, StationKinds, TeleporterKinds,
  ZoneKinds, ZoneReleaseLossBehaviors,
  type CommandState, type ConnectionState, type DriveState, type FmsControlState,
  type NavigationMode, type PathPlanningAuthority, type RobotStatus, type TrafficStatus,
} from "../../shared/config/index.ts";
import type { WorkState } from "../../shared/robotRuntime.ts";

type OpenCode<C extends string> = C | (string & {});

export type Waypoint = { id: string; name?: string; x: number; y: number; theta: number };
export type Charger = Waypoint;
export type Robot = Waypoint & {
  status: OpenCode<RobotStatus>;
  trafficStatus: OpenCode<TrafficStatus>;
  connected: boolean;
  motion: string;
  commandId: string;
  commandState: OpenCode<CommandState>;
  commandReason: string;
  lastSeenAt: number;
  localPath: Point[];
  localHorizonS: number;
  leaseId: string;
  headRoomPx: number;
  path: Point[];
  workState: WorkState;
  fmsControlState: FmsControlState;
  connectionState: ConnectionState;
  connectionReason: string;
  driveState: DriveState;
  driveContexts: ReturnType<typeof parseDriveContexts>;
  controlEpoch: number;
  controlReady: boolean;
  reportedAt: number;
  stateChangedAt: number;
  sessionId: string;
  navigationMode: NavigationMode;
  pathPlanningAuthority: PathPlanningAuthority;
  operatorPaused: boolean;
  operatorPauseDesired: boolean;
  operatorPausePending: boolean;
  operatorPauseReason: string;
};
export type Obstacle = DynObstacle & { name?: string };
export type Zone = {
  id: string;
  family: OpenCode<ResourceFamily>;
  kind: OpenCode<ZoneKind>;
  name: string;
  polygon: Point[];
  theta: number;
  factor?: number;
  maximumSpeed?: number;
  capacity?: number;
  direction?: number;
  directedLimitation?: OpenCode<(typeof DirectedLimitations.values)[number]>;
  releaseLossBehavior?: OpenCode<(typeof ZoneReleaseLossBehaviors.values)[number]>;
};
export type NodeR = { id: string; x: number; y: number; theta: number; name: string; mapId?: string; allowedDeviationXY?: number; allowedDeviationTheta?: number; actions?: {actionType:string; blockingType?:string}[] };
export type EdgeR = {
  id: string;
  name: string;
  startNodeId: string;
  endNodeId: string;
  trajectory: Point[];
  corridor: EdgeCorridor;
  maximumSpeed: number;
  theta?: number;
};
export type StationR = { id: string; x: number; y: number; theta: number; name: string; kind: OpenCode<(typeof StationKinds.values)[number]>; interactionNodeIds?: string[] };
export type PortalR = { id: string; name?: string; zoneId: string; ax: number; ay: number; bx: number; by: number; waitPose?: { x: number; y: number; theta: number } };
export type RailR = { id: string; name?: string; zoneId: string; points: Point[]; theta: number };
export type TeleporterEndpointR = { id: string; mapId: string; x: number; y: number; entryTheta: number; exitTheta: number; occupancyPolygon: Point[]; clearingPoint?: Point; occupancyState?: string; occupancyRobotId?: string; occupancyReason?: string };
export type TeleporterR = { id: string; name: string; type: (typeof TeleporterKinds.values)[number]; endpoints: TeleporterEndpointR[]; enabled: boolean; revision: number };

export type Snapshot = {
  mapId: string;
  waypoints: Waypoint[];
  chargers: Charger[];
  robots: Robot[];
  obstacles: Obstacle[];
  zones: Zone[];
  nodes: NodeR[];
  edges: EdgeR[];
  stations: StationR[];
  portals: PortalR[];
  rails: RailR[];
  teleporters: TeleporterR[];
  runtimeOccupancies: ResourceOccupancy[];
};

export function canDispatchRobot(robot: Pick<Robot, "connected"> & Partial<Pick<Robot, "fmsControlState" | "controlReady">> | undefined): boolean {
  return robot?.connected === true && robot.fmsControlState === FmsControlStates.code.enabled && robot.controlReady === true;
}

export function projectTransport(snapshot: Snapshot, transportConnected: boolean): Snapshot {
  return {
    ...snapshot,
    robots: snapshot.robots.map((robot) => transportConnected && robot.connected ? robot : ({
      ...robot, connected: false, connectionState: ConnectionStates.code.offline, controlReady: false,
      connectionReason: transportConnected ? robot.connectionReason : "monitor_disconnected",
      workState: WorkStates.code.unknown, driveState: DriveStates.code.unknown,
    })),
  };
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function entriesOf(map: unknown): [string, Record<string, unknown>][] {
  if (!map) return [];
  if (typeof (map as { forEach?: unknown }).forEach === "function") {
    const out: [string, Record<string, unknown>][] = [];
    (map as { forEach: (cb: (v: unknown, key: unknown) => void) => void }).forEach((value, key) => {
      const row = plainRecord(value);
      if (row) out.push([String(key), row]);
    });
    return out;
  }
  if (Array.isArray(map)) return map.flatMap((value, index) => {
    const row = plainRecord(value);
    return row ? [[String(index), row] as [string, Record<string, unknown>]] : [];
  });
  if (typeof map === "object") return Object.entries(map as Record<string, unknown>).flatMap(([key, value]) => {
    const row = plainRecord(value);
    return row ? [[key, row] as [string, Record<string, unknown>]] : [];
  });
  return [];
}

function collect<T>(map: unknown, mapFn: (v: Record<string, unknown>, key: string) => T | null): T[] {
  const out: T[] = [];
  for (const [key, v] of entriesOf(map)) {
    const item = mapFn(v, key);
    if (item) out.push(item);
  }
  return out;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw && typeof raw === "object") return raw as T;
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function snapshotFromState(state: Record<string, unknown> | undefined): Snapshot {
  const teleporterJson = parseJson<unknown[]>(state?.teleportersJson, []);
  const teleporterUsesJson = parseJson<any[]>(state?.teleporterUsesJson, []);
  // FloorRoom's JSON projection is authoritative. The legacy Schema map can
  // retain a deleted definition until its next patch, so merging both would
  // resurrect stale outliner rows after a cross-map delete.
  const hasTeleporterJson = typeof state?.teleportersJson === "string";
  return {
    mapId: String(state?.mapId ?? "yard"),
    waypoints: collect(state?.waypoints, (v, key) => ({
      id: String(v.id ?? key),
      name: String(v.name ?? v.id ?? key),
      x: Number(v.x),
      y: Number(v.y),
      theta: Number(v.theta),
    })),
    chargers: collect(state?.chargingStations, (v, key) => ({
      id: String(v.id ?? key),
      name: String(v.name ?? v.id ?? key),
      x: Number(v.x),
      y: Number(v.y),
      theta: Number(v.theta),
    })),
    robots: collect(state?.robots, (v, key) => {
      const path: Point[] = [];
      for (const [, p] of entriesOf(v.path)) {
        const x = Number(p.x);
        const y = Number(p.y);
        if (Number.isFinite(x) && Number.isFinite(y)) path.push({ x, y });
      }
      const localPath: Point[] = [];
      for (const [, p] of entriesOf(v.localPath)) {
        const x = Number(p.x);
        const y = Number(p.y);
        if (Number.isFinite(x) && Number.isFinite(y)) localPath.push({ x, y });
      }
      const navValue = String(v.navigationMode);
      const authorityValue = String(v.pathPlanningAuthority);
      const navigationMode: NavigationMode = NavigationModes.is(navValue) ? navValue : NavigationModes.code.unknown;
      const pathPlanningAuthority: PathPlanningAuthority = PathPlanningAuthorities.is(authorityValue) ? authorityValue : PathPlanningAuthorities.code.unknown;
      return {
        id: String(v.id ?? key),
        x: Number(v.x),
        y: Number(v.y),
        theta: Number(v.theta),
        status: String(v.status ?? RobotStatuses.code.idle),
        trafficStatus: String(v.trafficStatus ?? TrafficStatuses.code.clear),
        // Unknown connectivity fails closed so an old schema cannot enable commands.
        connected: v.connected === true,
        motion: String(v.motion ?? ""),
        commandId: String(v.commandId ?? ""),
        commandState: String(v.commandState ?? CommandStates.code.idle),
        commandReason: String(v.commandReason ?? ""),
        lastSeenAt: Number(v.lastSeenAt ?? 0),
        localPath,
        localHorizonS: Number(v.localHorizonS ?? 5),
        leaseId: String(v.leaseId ?? ""),
        headRoomPx: Number(v.headRoomPx ?? 0),
        path,
        workState: parseWorkState(v.workState),
        fmsControlState: FmsControlStates.is(v.fmsControlState) ? v.fmsControlState : FmsControlStates.code.disabled,
        connectionState: ConnectionStates.is(v.connectionState) ? v.connectionState : ConnectionStates.code.offline,
        connectionReason: String(v.connectionReason ?? ""),
        driveState: parseDriveState(v.driveState ?? v.motion),
        driveContexts: parseDriveContexts(v.driveContextJson ?? v.driveContext),
        controlEpoch: Number(v.controlEpoch ?? 0),
        controlReady: v.controlReady === true,
        reportedAt: Number(v.reportedAt ?? v.lastSeenAt ?? 0),
        stateChangedAt: Number(v.stateChangedAt ?? 0),
        sessionId: String(v.sessionId ?? ""),
        navigationMode,
        pathPlanningAuthority,
        operatorPaused: v.operatorPaused === true,
        operatorPauseDesired: v.operatorPauseDesired === true,
        operatorPausePending: v.operatorPausePending === true,
        operatorPauseReason: String(v.operatorPauseReason ?? ""),
      };
    }),
    obstacles: collect(state?.obstacles, (v, key) => ({
      id: String(v.id ?? key),
      name: String(v.name ?? v.id ?? key),
      kind: parseObstacleKind(String(v.kind ?? "")) ?? ObstacleKinds.code.square,
      x: Number(v.x),
      y: Number(v.y),
      theta: Number(v.theta),
      size: Number(v.size) || 16,
    })),
    zones: collect(state?.zones, (v, key) => {
      const params = parseJson<Record<string, unknown>>(v.paramsJson, {});
      return {
        id: String(v.id ?? key),
        family: String(v.family ?? ResourceFamilies.code.scene),
        kind: String(v.kind ?? ZoneKinds.code.forbidden),
        name: String(v.name ?? v.id ?? key),
        polygon: parseJson<Point[]>(v.polygonJson, []),
        theta: Number(v.theta) || 0,
        factor: params.factor as number | undefined,
        maximumSpeed: params.maximumSpeed as number | undefined,
        capacity: params.capacity as number | undefined,
        direction: params.direction as number | undefined,
        directedLimitation: params.directedLimitation as string | undefined,
        releaseLossBehavior: params.releaseLossBehavior as string | undefined,
      };
    }),
    nodes: collect(state?.nodes, (v, key) => ({
      id: String(v.id ?? key),
      x: Number(v.x),
      y: Number(v.y),
      theta: Number(v.theta),
      name: String(v.name ?? v.id ?? key),
      mapId: String(v.mapId ?? "yard"),
      allowedDeviationXY: Number(v.allowedDeviationXY) || undefined,
      allowedDeviationTheta: Number(v.allowedDeviationTheta) || undefined,
      actions: parseJson(v.actionsJson, []),
    })),
    edges: collect(state?.edges, (v, key) => ({
      id: String(v.id ?? key),
      name: String(v.name ?? v.id ?? key),
      startNodeId: String(v.startNodeId ?? ""),
      endNodeId: String(v.endNodeId ?? ""),
      trajectory: parseJson<Point[]>(v.trajectoryJson, []),
      corridor: { ...DEFAULT_EDGE_CORRIDOR, ...parseJson<Partial<EdgeCorridor>>(v.corridorJson, {}) },
      maximumSpeed: Number(v.maximumSpeed) || 0,
      theta: Number(v.theta) || 0,
    })),
    stations: collect(state?.stations, (v, key) => ({
      id: String(v.id ?? key),
      x: Number(v.x),
      y: Number(v.y),
      theta: Number(v.theta),
      name: String(v.name ?? v.id ?? key),
      kind: String(v.kind ?? StationKinds.code.other),
      interactionNodeIds: parseJson<string[]>(v.interactionJson, []),
    })),
    portals: collect(state?.portals, (v, key) => ({
      id: String(v.id ?? key),
      name: String(v.name ?? v.id ?? key),
      zoneId: String(v.zoneId ?? ""),
      ax: Number(v.ax),
      ay: Number(v.ay),
      bx: Number(v.bx),
      by: Number(v.by),
      waitPose: parseJson(v.waitPoseJson, undefined),
    })),
    rails: collect(state?.rails, (v, key) => ({
      id: String(v.id ?? key),
      name: String(v.name ?? v.id ?? key),
      zoneId: String(v.zoneId ?? ""),
      points: parseJson<Point[]>(v.pointsJson, []),
      theta: Number(v.theta) || 0,
    })),
    teleporters: (hasTeleporterJson ? [] : collect<TeleporterR>(state?.teleporters, (v, key) => {
      const endpoints: TeleporterEndpointR[] = [];
      const raw = v.endpoints as any;
      if (Array.isArray(raw)) raw.forEach((p, i) => endpoints.push(parseTeleporterEndpoint(p, String(i))));
      else if (raw && typeof raw.forEach === "function") raw.forEach((p: Record<string, unknown>, k: string) => endpoints.push(parseTeleporterEndpoint(p, k)));
      const uses = state?.teleporterUses as any;
      if (uses && typeof uses.forEach === "function") uses.forEach((u: any) => { const endpointId = String(u.endpointId ?? u.endpoint_id ?? ""); const ep = endpoints.find(e => e.id === endpointId); if (ep) applyTeleporterUse(ep, u); });
      return { id: String(v.id ?? key), name: String(v.name ?? v.id ?? key), type: TeleporterKinds.code.teleporter, endpoints, enabled: v.enabled !== false, revision: Number(v.revision ?? 0) };
    })).concat(teleporterJson.map((v, i) => {
      const t = parseTeleporterDefinition(v as Record<string, unknown>, String(i));
      for (const use of teleporterUsesJson) { const ep = t.endpoints.find(e => e.id === String(use.endpointId ?? use.endpoint_id)); if (ep) applyTeleporterUse(ep, use); }
      return t;
    })),
    runtimeOccupancies: (() => {
      const raw = parseJson<unknown>(state?.runtimeOccupanciesJson, []);
      return Array.isArray(raw) ? raw.filter((item): item is ResourceOccupancy => Boolean(item && typeof item === "object" && (item as any).robotId && (item as any).resourceRef)) : [];
    })(),
  };
}

function parseTeleporterDefinition(v: Record<string, unknown>, key: string): TeleporterR {
  const raw = Array.isArray(v.endpoints) ? v.endpoints : [];
  return { id: String(v.id ?? key), name: String(v.name ?? v.id ?? key), type: TeleporterKinds.code.teleporter, endpoints: raw.map((ep, i) => parseTeleporterEndpoint(ep as Record<string, unknown>, String(i))), enabled: v.enabled !== false, revision: Number(v.revision ?? 0) };
}

function applyTeleporterUse(ep: TeleporterEndpointR, use: Record<string, unknown>): void {
  const state = String(use.state ?? use.status ?? "free");
  // A queued projection may accompany an active projection for the same
  // endpoint. Keep the active reservation visible regardless of ordering.
  const rank = (value: string) => value === "queued" ? 1 : value === "free" ? 0 : 2;
  if (rank(state) < rank(ep.occupancyState ?? "free")) return;
  ep.occupancyState = state;
  ep.occupancyRobotId = String(use.robotId ?? use.robot_id ?? "");
  ep.occupancyReason = String(use.reason ?? "");
}

function parseTeleporterEndpoint(v: Record<string, unknown>, key: string): TeleporterEndpointR {
  const pos = (v.position as Record<string, unknown> | undefined) ?? v;
  const polygon = v.occupancyPolygon ?? v.occupancy_polygon;
  const clearing = v.clearingPoint as Record<string, unknown> | undefined;
  return { id: String(v.id ?? key), mapId: String(v.mapId ?? v.map_id ?? ""), x: Number(pos.x ?? 0), y: Number(pos.y ?? 0), entryTheta: Number(v.entryTheta ?? v.entry_theta ?? 0), exitTheta: Number(v.exitTheta ?? v.exit_theta ?? 0), occupancyPolygon: Array.isArray(polygon) ? polygon as Point[] : parseJson<Point[]>(polygon, []), clearingPoint: clearing && Number.isFinite(Number(clearing.x)) && Number.isFinite(Number(clearing.y)) ? { x: Number(clearing.x), y: Number(clearing.y) } : undefined, occupancyState: String(v.occupancyState ?? v.occupancy_state ?? "free"), occupancyRobotId: String(v.occupancyRobotId ?? v.occupancy_robot_id ?? ""), occupancyReason: String(v.occupancyReason ?? v.occupancy_reason ?? "") };
}

export function pointInPoly(x: number, y: number, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

export function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-6) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function metersToPx(m: number, pixelCm: number): number {
  return (m * 100) / pixelCm;
}
