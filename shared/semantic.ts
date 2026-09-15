export type Point = { x: number; y: number };
export type Pose = Point & { theta: number };

export type SceneKind = "waypoint" | "charger" | "obstacle" | "forbidden" | "prefer" | "avoid" | "corridor" | "complex";

export type VdaKind =
  | "node"
  | "edge"
  | "station"
  | "blocked"
  | "release"
  | "line_guided"
  | "speed_limit"
  | "priority"
  | "penalty"
  | "directed"
  | "bidirected"
  | "replanning"
  | "action_zone"
  | "portal"
  | "rail";

export type ResourceFamily = "scene" | "vda";

export type ObstacleKind = "triangle" | "square" | "circle";

export type SceneWaypoint = Pose & { id: string; name?: string };
export type SceneCharger = Pose & { id: string; name?: string };
export type SceneObstacle = Pose & { id: string; name?: string; kind: ObstacleKind; size: number };

export type ZoneKind =
  | "forbidden"
  | "prefer"
  | "avoid"
  | "blocked"
  | "release"
  | "line_guided"
  | "speed_limit"
  | "priority"
  | "penalty"
  | "directed"
  | "bidirected"
  | "replanning"
  | "action_zone"
  | "corridor"
  | "complex";

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
  directedLimitation?: "SOFT" | "RESTRICTED" | "STRICT";
  releaseLossBehavior?: "STOP" | "CONTINUE" | "EVACUATE";
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
  corridorReferencePoint: "KINEMATIC_CENTER" | "CONTOUR";
  releaseRequired: boolean;
  releaseLossBehavior: "STOP" | "RETURN";
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
  kind: "charger" | "pick_drop" | "wait" | "other";
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

export const SCENE_ZONE_KINDS: ZoneKind[] = ["forbidden", "prefer", "avoid", "corridor", "complex"];
export const VDA_ZONE_KINDS: ZoneKind[] = [
  "blocked",
  "release",
  "line_guided",
  "speed_limit",
  "priority",
  "penalty",
  "directed",
  "bidirected",
  "replanning",
  "action_zone",
];

export const DEFAULT_EDGE_CORRIDOR: EdgeCorridor = {
  leftWidth: 0.6,
  rightWidth: 0.6,
  corridorReferencePoint: "KINEMATIC_CENTER",
  releaseRequired: false,
  releaseLossBehavior: "STOP",
};
