/** Shared runtime vocabulary. Control policy belongs to FMS; motion is robot telemetry.
 * Times are milliseconds since Unix epoch. Resource references intentionally support
 * future graph resources without claiming that graph traffic is implemented today.
 */
export type WorkState = "idle" | "busy" | "unknown";
export type FmsControlState = "enabled" | "disabled";
export type ConnectionState = "online" | "offline";
export type DriveState = "stationary" | "moving" | "waiting" | "paused" | "blocked" | "unknown";
export type NavigationMode = "free_navigation" | "graph_navigation" | "unknown";
export type PathPlanningAuthority = "robot" | "fms" | "hybrid" | "unknown";
export type ResourceRef = { mapId: string; kind: "zone" | "node" | "edge"; id: string; stepId?: string };
export type DriveContext = {
  reasonCode: string;
  source: "robot" | "fms" | "transport";
  target?: ResourceRef;
  blockingRobotIds?: string[];
  requestId?: string;
  permissionState?: "queued" | "granted" | "denied" | "pending";
  since: number;
};
export type ResourceOccupancy = {
  resourceRef: ResourceRef;
  robotId: string;
  state: "occupied" | "reserved" | "queued";
  requestId: string;
  controlEpoch: number;
  createdAt: number;
  updatedAt: number;
  /** FIFO position applies only to queued records. */
  queuePosition?: number;
};
export type RobotControl = { enabled: boolean; controlEpoch: number };
export type RuntimeAck = { requestId: string; ok: boolean; message: string };

export function parseWorkState(value: unknown): WorkState {
  return value === "idle" || value === "busy" ? value : "unknown";
}
export function parseDriveState(value: unknown): DriveState {
  return ["stationary", "moving", "waiting", "paused", "blocked"].includes(String(value))
    ? value as DriveState : "unknown";
}
/** Boundary validation for JSON telemetry: malformed context never breaks the room/UI. */
export function parseDriveContexts(value: unknown): DriveContext[] {
  let raw = value;
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 32).flatMap((v): DriveContext[] => {
    if (!v || typeof v !== "object" || typeof v.reasonCode !== "string" ||
      !["robot", "fms", "transport"].includes(v.source) || !Number.isFinite(v.since)) return [];
    const context: DriveContext = { reasonCode: v.reasonCode.slice(0, 128), source: v.source, since: v.since };
    if (v.target && typeof v.target.mapId === "string" && typeof v.target.id === "string" &&
      ["zone", "node", "edge"].includes(v.target.kind)) context.target = {
      mapId: v.target.mapId, kind: v.target.kind, id: v.target.id,
      ...(typeof v.target.stepId === "string" ? { stepId: v.target.stepId } : {}),
    };
    if (Array.isArray(v.blockingRobotIds)) context.blockingRobotIds = v.blockingRobotIds.filter((id: unknown) => typeof id === "string").slice(0, 128);
    if (typeof v.requestId === "string") context.requestId = v.requestId;
    if (["queued", "granted", "denied", "pending"].includes(v.permissionState)) context.permissionState = v.permissionState;
    return [context];
  });
}
