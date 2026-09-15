import { ArraySchema, MapSchema, Schema, type } from "@colyseus/schema";

export class Waypoint extends Schema {
  @type("string") id = "";
  @type("string") name = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") theta = 0;
}

export class ChargingStation extends Schema {
  @type("string") id = "";
  @type("string") name = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") theta = 0;
}

export class PathPoint extends Schema {
  @type("number") x = 0;
  @type("number") y = 0;
}

export class Robot extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") theta = 0;
  @type("string") status: "idle" | "move" = "idle";
  @type("boolean") connected = false;
  @type("string") motion = "";
  @type("string") commandId = "";
  @type("string") commandState = "idle";
  @type("string") commandReason = "";
  @type([PathPoint]) localPath = new ArraySchema<PathPoint>();
  @type("number") localHorizonS = 0;
  @type("string") leaseId = "";
  @type("number") headRoomPx = 0;
  @type("number") lastSeenAt = 0;
  /** Traffic-control status: clear|proceed|partial|hold|stop|evade|lease_lost */
  @type("string") trafficStatus = "clear";
  @type([PathPoint]) path = new ArraySchema<PathPoint>();
  @type("string") workState = "unknown";
  @type("string") fmsControlState = "enabled";
  @type("string") connectionState = "offline";
  @type("string") connectionReason = "";
  @type("string") driveState = "unknown";
  @type("string") driveContextJson = "[]";
  @type("number") controlEpoch = 0;
  @type("boolean") controlReady = false;
  @type("number") reportedAt = 0;
  @type("number") stateChangedAt = 0;
  @type("string") sessionId = "";
  @type("string") navigationMode = "unknown";
  @type("string") pathPlanningAuthority = "unknown";
}

export class Obstacle extends Schema {
  @type("string") id = "";
  @type("string") name = "";
  @type("string") kind = "circle";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") size = 16;
  @type("number") theta = 0;
}

export class Zone extends Schema {
  @type("string") id = "";
  @type("string") family = "scene";
  @type("string") kind = "forbidden";
  @type("string") name = "";
  @type("string") polygonJson = "[]";
  @type("number") theta = 0;
  @type("string") paramsJson = "{}";
}

export class GraphNode extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") theta = 0;
  @type("string") name = "";
  @type("string") mapId = "yard";
  @type("number") allowedDeviationXY = 0;
  @type("number") allowedDeviationTheta = 0;
  @type("string") actionsJson = "[]";
}

export class GraphEdge extends Schema {
  @type("string") id = "";
  @type("string") name = "";
  @type("string") startNodeId = "";
  @type("string") endNodeId = "";
  @type("number") theta = 0;
  @type("number") maximumSpeed = 0;
  @type("string") trajectoryJson = "[]";
  @type("string") corridorJson = "{}";
}

export class VdaStation extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") theta = 0;
  @type("string") name = "";
  @type("string") kind = "other";
  @type("string") interactionJson = "[]";
}

export class Portal extends Schema {
  @type("string") id = "";
  @type("string") name = "";
  @type("string") zoneId = "";
  @type("number") ax = 0;
  @type("number") ay = 0;
  @type("number") bx = 0;
  @type("number") by = 0;
  @type("number") theta = 0;
  @type("string") waitPoseJson = "";
}

export class Rail extends Schema {
  @type("string") id = "";
  @type("string") name = "";
  @type("string") zoneId = "";
  @type("string") pointsJson = "[]";
  @type("number") theta = 0;
}

export class FloorState extends Schema {
  @type({ map: Waypoint }) waypoints = new MapSchema<Waypoint>();
  @type({ map: ChargingStation }) chargingStations = new MapSchema<ChargingStation>();
  @type({ map: Robot }) robots = new MapSchema<Robot>();
  @type({ map: Obstacle }) obstacles = new MapSchema<Obstacle>();
  @type({ map: Zone }) zones = new MapSchema<Zone>();
  @type({ map: GraphNode }) nodes = new MapSchema<GraphNode>();
  @type({ map: GraphEdge }) edges = new MapSchema<GraphEdge>();
  @type({ map: VdaStation }) stations = new MapSchema<VdaStation>();
  @type({ map: Portal }) portals = new MapSchema<Portal>();
  @type({ map: Rail }) rails = new MapSchema<Rail>();
  @type("string") runtimeOccupanciesJson = "[]";
}
