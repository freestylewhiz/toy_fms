import {
  DriveContextSources, DriveStates, PermissionStates, ResourceKinds, WorkStates,
} from "./config/index.ts";
import type {
  ConnectionState as CatalogConnectionState,
  DriveContextSource,
  DriveState as CatalogDriveState,
  FmsControlState as CatalogFmsControlState,
  NavigationMode as CatalogNavigationMode,
  OccupancyState,
  PathPlanningAuthority as CatalogPathPlanningAuthority,
  PermissionState,
  ResourceKind,
  WorkState as CatalogWorkState,
} from "./config/index.ts";

/** Shared runtime vocabulary. Control policy belongs to FMS; motion is robot telemetry.
 * Times are milliseconds since Unix epoch. Resource references intentionally support
 * future graph resources without claiming that graph traffic is implemented today.
 */
export type WorkState = CatalogWorkState;
export type FmsControlState = CatalogFmsControlState;
export type ConnectionState = CatalogConnectionState;
export type DriveState = CatalogDriveState;
export type NavigationMode = CatalogNavigationMode;
export type PathPlanningAuthority = CatalogPathPlanningAuthority;
export type ResourceRef = { mapId: string; kind: ResourceKind; id: string; stepId?: string };
export type DriveContext = {
  reasonCode: string;
  source: DriveContextSource;
  target?: ResourceRef;
  blockingRobotIds?: string[];
  requestId?: string;
  permissionState?: PermissionState;
  since: number;
};
export type ResourceOccupancy = {
  resourceRef: ResourceRef;
  robotId: string;
  state: OccupancyState;
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
  return WorkStates.is(value) ? value : WorkStates.code.unknown;
}
export function parseDriveState(value: unknown): DriveState {
  return DriveStates.is(value) && value !== DriveStates.code.unknown ? value : DriveStates.code.unknown;
}
/** Boundary validation for JSON telemetry: malformed context never breaks the room/UI. */
export function parseDriveContexts(value: unknown): DriveContext[] {
  let raw = value;
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 32).flatMap((v): DriveContext[] => {
    if (!v || typeof v !== "object" || typeof v.reasonCode !== "string" ||
      !DriveContextSources.is(v.source) || !Number.isFinite(v.since)) return [];
    const context: DriveContext = { reasonCode: v.reasonCode.slice(0, 128), source: v.source, since: v.since };
    if (v.target && typeof v.target.mapId === "string" && typeof v.target.id === "string" &&
      ResourceKinds.is(v.target.kind)) context.target = {
      mapId: v.target.mapId, kind: v.target.kind, id: v.target.id,
      ...(typeof v.target.stepId === "string" ? { stepId: v.target.stepId } : {}),
    };
    if (Array.isArray(v.blockingRobotIds)) context.blockingRobotIds = v.blockingRobotIds.filter((id: unknown) => typeof id === "string").slice(0, 128);
    if (typeof v.requestId === "string") context.requestId = v.requestId;
    if (PermissionStates.is(v.permissionState)) context.permissionState = v.permissionState;
    return [context];
  });
}
