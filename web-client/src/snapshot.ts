import { parseObstacleKind, type DynObstacle, type ObstacleKind } from "../../shared/obstacles.ts";
import { DEFAULT_EDGE_CORRIDOR, type EdgeCorridor, type Point, type ZoneKind } from "../../shared/semantic.ts";
import { parseDriveContexts, parseDriveState, parseWorkState, type ResourceOccupancy } from "../../shared/robotRuntime.ts";

export type Waypoint = { id: string; name?: string; x: number; y: number; theta: number };
export type Charger = Waypoint;
export type Robot = Waypoint & {
  status: string;
  trafficStatus: string;
  connected: boolean;
  motion: string;
  commandId: string;
  commandState: string;
  commandReason: string;
  lastSeenAt: number;
  localPath: Point[];
  localHorizonS: number;
  leaseId: string;
  headRoomPx: number;
  path: Point[];
  workState: "idle" | "busy" | "unknown";
  fmsControlState: "enabled" | "disabled";
  connectionState: "online" | "offline";
  connectionReason: string;
  driveState: "stationary" | "moving" | "waiting" | "paused" | "blocked" | "unknown";
  driveContexts: ReturnType<typeof parseDriveContexts>;
  controlEpoch: number;
  controlReady: boolean;
  reportedAt: number;
  stateChangedAt: number;
  sessionId: string;
  navigationMode: "free_navigation" | "graph_navigation" | "unknown";
  pathPlanningAuthority: "robot" | "fms" | "hybrid" | "unknown";
};
export type Obstacle = DynObstacle & { name?: string };
export type Zone = {
  id: string;
  family: string;
  kind: ZoneKind | string;
  name: string;
  polygon: Point[];
  theta: number;
  factor?: number;
  maximumSpeed?: number;
  capacity?: number;
  direction?: number;
  directedLimitation?: string;
  releaseLossBehavior?: string;
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
export type StationR = { id: string; x: number; y: number; theta: number; name: string; kind: string; interactionNodeIds?: string[] };
export type PortalR = { id: string; name?: string; zoneId: string; ax: number; ay: number; bx: number; by: number; waitPose?: { x: number; y: number; theta: number } };
export type RailR = { id: string; name?: string; zoneId: string; points: Point[]; theta: number };

export type Snapshot = {
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
  runtimeOccupancies: ResourceOccupancy[];
};

export function canDispatchRobot(robot: Pick<Robot, "connected"> & Partial<Pick<Robot, "fmsControlState" | "controlReady">> | undefined): boolean {
  return robot?.connected === true && robot.fmsControlState === "enabled" && robot.controlReady === true;
}

export function projectTransport(snapshot: Snapshot, transportConnected: boolean): Snapshot {
  return {
    ...snapshot,
    robots: snapshot.robots.map((robot) => transportConnected && robot.connected ? robot : ({
      ...robot, connected: false, connectionState: "offline", controlReady: false,
      connectionReason: transportConnected ? robot.connectionReason : "monitor_disconnected",
      workState: "unknown", driveState: "unknown",
    })),
  };
}

function collect<T>(map: unknown, mapFn: (v: Record<string, unknown>, key: string) => T | null): T[] {
  const out: T[] = [];
  if (!map || typeof (map as { forEach?: unknown }).forEach !== "function") return out;
  (map as { forEach: (cb: (v: Record<string, unknown>, key: string) => void) => void }).forEach((v, key) => {
    const item = mapFn(v, key);
    if (item) out.push(item);
  });
  return out;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function snapshotFromState(state: Record<string, unknown> | undefined): Snapshot {
  return {
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
      const raw = v.path as { forEach?: (cb: (p: { x?: number; y?: number }) => void) => void } | undefined;
      raw?.forEach?.((p) => {
        const x = Number(p.x);
        const y = Number(p.y);
        if (Number.isFinite(x) && Number.isFinite(y)) path.push({ x, y });
      });
      const localPath: Point[] = [];
      const localRaw = v.localPath as { forEach?: (cb: (p: { x?: number; y?: number }) => void) => void } | undefined;
      localRaw?.forEach?.((p) => {
        const x = Number(p.x);
        const y = Number(p.y);
        if (Number.isFinite(x) && Number.isFinite(y)) localPath.push({ x, y });
      });
      const navValue = String(v.navigationMode);
      const authorityValue = String(v.pathPlanningAuthority);
      const navigationMode: Robot["navigationMode"] = navValue === "free_navigation" || navValue === "graph_navigation" ? navValue : "unknown";
      const pathPlanningAuthority: Robot["pathPlanningAuthority"] = authorityValue === "robot" || authorityValue === "fms" || authorityValue === "hybrid" ? authorityValue : "unknown";
      return {
        id: String(v.id ?? key),
        x: Number(v.x),
        y: Number(v.y),
        theta: Number(v.theta),
        status: String(v.status ?? "idle"),
        trafficStatus: String(v.trafficStatus ?? "clear"),
        // Unknown connectivity fails closed so an old schema cannot enable commands.
        connected: v.connected === true,
        motion: String(v.motion ?? ""),
        commandId: String(v.commandId ?? ""),
        commandState: String(v.commandState ?? "idle"),
        commandReason: String(v.commandReason ?? ""),
        lastSeenAt: Number(v.lastSeenAt ?? 0),
        localPath,
        localHorizonS: Number(v.localHorizonS ?? 5),
        leaseId: String(v.leaseId ?? ""),
        headRoomPx: Number(v.headRoomPx ?? 0),
        path,
        workState: parseWorkState(v.workState),
        fmsControlState: v.fmsControlState === "enabled" ? "enabled" : "disabled",
        connectionState: v.connectionState === "online" ? "online" : "offline",
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
      };
    }),
    obstacles: collect(state?.obstacles, (v, key) => ({
      id: String(v.id ?? key),
      name: String(v.name ?? v.id ?? key),
      kind: (parseObstacleKind(String(v.kind ?? "")) ?? "square") as ObstacleKind,
      x: Number(v.x),
      y: Number(v.y),
      theta: Number(v.theta),
      size: Number(v.size) || 16,
    })),
    zones: collect(state?.zones, (v, key) => {
      const params = parseJson<Record<string, unknown>>(v.paramsJson, {});
      return {
        id: String(v.id ?? key),
        family: String(v.family ?? "scene"),
        kind: String(v.kind ?? "forbidden"),
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
      kind: String(v.kind ?? "other"),
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
    runtimeOccupancies: (() => {
      const raw = parseJson<unknown>(state?.runtimeOccupanciesJson, []);
      return Array.isArray(raw) ? raw.filter((item): item is ResourceOccupancy => Boolean(item && typeof item === "object" && (item as any).robotId && (item as any).resourceRef)) : [];
    })(),
  };
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
