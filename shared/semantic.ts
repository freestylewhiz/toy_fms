import {
  CorridorReferencePoints, EdgeReleaseLossBehaviors, SceneZoneKinds, VdaZoneKinds,
} from "./config/index.ts";
import type {
  CorridorReferencePoint, DirectedLimitation, EdgeReleaseLossBehavior,
  ObstacleKind as CatalogObstacleKind, ResourceFamily as CatalogResourceFamily,
  SceneKind as CatalogSceneKind, StationKind, TeleporterKind, VdaKind as CatalogVdaKind,
  ZoneKind as CatalogZoneKind, ZoneReleaseLossBehavior,
} from "./config/index.ts";

export type Point = { x: number; y: number };
export type Pose = Point & { theta: number };
export type TeleporterEndpoint = { id: string; mapId: string; position: Point; entryTheta: number; exitTheta: number; occupancyPolygon: Point[]; clearingPoint: Point };
export type Teleporter = { id: string; type: TeleporterKind; name: string; endpoints: [TeleporterEndpoint, TeleporterEndpoint]; enabled: boolean; revision: number };

export type SceneKind = CatalogSceneKind;

export type VdaKind = CatalogVdaKind;

export type ResourceFamily = CatalogResourceFamily;

export type ObstacleKind = CatalogObstacleKind;

export type SceneWaypoint = Pose & { id: string; name?: string };
export type SceneCharger = Pose & { id: string; name?: string };
export type SceneObstacle = Pose & { id: string; name?: string; kind: ObstacleKind; size: number };

export type ZoneKind = CatalogZoneKind;

export type ZoneResource = {
  id: string;
  family: ResourceFamily;
  kind: ZoneKind;
  name: string;
  polygon: Point[];
  theta: number;
  /** prefer/avoid cost. VDA PRIORITY/PENALTY factor. */
  factor?: number;
  maximumSpeed?: number;
  capacity?: number;
  direction?: number;
  directedLimitation?: DirectedLimitation;
  releaseLossBehavior?: ZoneReleaseLossBehavior;
};

export type GraphNode = Pose & {
  id: string;
  name: string;
  mapId: string;
  allowedDeviationXY?: number;
  allowedDeviationTheta?: number;
  actions: { actionType: string; blockingType?: string }[];
};

export type EdgeCorridor = {
  leftWidth: number;
  rightWidth: number;
  corridorReferencePoint: CorridorReferencePoint;
  releaseRequired: boolean;
  releaseLossBehavior: EdgeReleaseLossBehavior;
};

export type GraphEdge = {
  id: string;
  name: string;
  startNodeId: string;
  endNodeId: string;
  theta: number;
  maximumSpeed?: number;
  trajectory: Point[];
  corridor: EdgeCorridor;
};

export type VdaStation = Pose & {
  id: string;
  name: string;
  kind: StationKind;
  interactionNodeIds: string[];
};

export type Portal = {
  id: string;
  name?: string;
  zoneId: string;
  a: Point;
  b: Point;
  waitPose?: Pose;
};

export type Rail = {
  id: string;
  name?: string;
  zoneId: string;
  points: Point[];
  theta: number;
};

export type SemanticSnapshot = {
  mapId: string;
  mapVersion: string;
  waypoints: SceneWaypoint[];
  chargers: SceneCharger[];
  obstacles: SceneObstacle[];
  zones: ZoneResource[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  stations: VdaStation[];
  portals: Portal[];
  rails: Rail[];
};

export const SCENE_ZONE_KINDS: ZoneKind[] = [...SceneZoneKinds.values];
export const VDA_ZONE_KINDS: ZoneKind[] = [...VdaZoneKinds.values];

export const DEFAULT_EDGE_CORRIDOR: EdgeCorridor = {
  leftWidth: 0.6,
  rightWidth: 0.6,
  corridorReferencePoint: CorridorReferencePoints.code.KINEMATIC_CENTER,
  releaseRequired: false,
  releaseLossBehavior: EdgeReleaseLossBehaviors.code.STOP,
};
