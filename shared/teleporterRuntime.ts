/** Runtime contract for a bidirectional teleporter transfer.
 *
 * The transfer is deliberately independent from a map server process.  A
 * transfer is only committed after both endpoints have been reserved and the
 * destination context has been loaded.  This makes reconnect/replay safe: a
 * duplicate message can be folded into the same transfer id and a stale
 * control epoch cannot advance it.
 */
import { TeleporterTransferPhases, type TeleporterTransferPhase as CatalogTeleporterTransferPhase } from "./config/index.ts";

export type TeleporterPoint = { x: number; y: number };

export type TeleporterEndpoint = {
  id: string;
  mapId: string;
  position: TeleporterPoint;
  entryTheta: number;
  exitTheta: number;
  /** Polygon in endpoint-local coordinates. */
  occupancyPolygon: TeleporterPoint[];
  /** Point reached after the body has left the endpoint polygon. */
  clearingPoint: TeleporterPoint;
};

export const DEFAULT_TELEPORTER_OCCUPANCY_SIZE = 40;

export function defaultTeleporterOccupancyPolygon(size = DEFAULT_TELEPORTER_OCCUPANCY_SIZE): TeleporterPoint[] {
  if (!Number.isFinite(size) || size <= 0) throw new Error("occupancy size must be positive");
  const half = size / 2;
  return [{ x: -half, y: -half }, { x: half, y: -half }, { x: half, y: half }, { x: -half, y: half }];
}

export type TeleporterDefinition = {
  id: string;
  revision: number;
  enabled: boolean;
  endpoints: [TeleporterEndpoint, TeleporterEndpoint];
};

export type TeleporterTransferPhase = CatalogTeleporterTransferPhase;

export type TeleporterTransfer = {
  transferId: string;
  teleporterId: string;
  robotId: string;
  fromEndpointId: string;
  toEndpointId: string;
  phase: TeleporterTransferPhase;
  controlEpoch: number;
  sourceMapId: string;
  destinationMapId: string;
  commandId: string;
  reason: string;
};

const transitions: Record<TeleporterTransferPhase, readonly TeleporterTransferPhase[]> = {
  requested: ["reserved", "failed"],
  reserved: ["entry_approach", "failed"],
  entry_approach: ["entry_aligned", "failed"],
  entry_aligned: ["destination_loading", "failed"],
  destination_loading: ["destination_ready", "failed"],
  destination_ready: ["arrived", "failed"],
  arrived: ["clearing", "failed"],
  clearing: ["completed", "failed"],
  completed: [],
  failed: [],
};

export function endpointFor(definition: TeleporterDefinition, id: string): TeleporterEndpoint | null {
  return definition.endpoints.find((endpoint) => endpoint.id === id) ?? null;
}

export function oppositeEndpoint(definition: TeleporterDefinition, id: string): TeleporterEndpoint | null {
  return definition.endpoints.find((endpoint) => endpoint.id !== id) ?? null;
}

export function validateTeleporter(definition: TeleporterDefinition): string[] {
  const errors: string[] = [];
  if (!definition.id || !Number.isInteger(definition.revision) || definition.revision < 0) errors.push("invalid identity");
  if (definition.endpoints.length !== 2) errors.push("teleporter requires exactly two endpoints");
  const ids = new Set<string>();
  const maps = new Set<string>();
  for (const endpoint of definition.endpoints) {
    if (!endpoint.id || ids.has(endpoint.id)) errors.push("endpoint ids must be unique");
    ids.add(endpoint.id);
    if (!endpoint.mapId || maps.has(endpoint.mapId)) errors.push("endpoints must use different maps");
    maps.add(endpoint.mapId);
    const numbers = [endpoint.position.x, endpoint.position.y, endpoint.entryTheta, endpoint.exitTheta, endpoint.clearingPoint.x, endpoint.clearingPoint.y];
    if (numbers.some((value) => !Number.isFinite(value))) errors.push(`endpoint ${endpoint.id}: invalid pose`);
    if (endpoint.occupancyPolygon.length < 3) errors.push(`endpoint ${endpoint.id}: polygon requires three points`);
    if (endpoint.occupancyPolygon.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) errors.push(`endpoint ${endpoint.id}: invalid polygon`);
    if (endpoint.occupancyPolygon.length >= 3 && (!isSimplePolygon(endpoint.occupancyPolygon) || Math.abs(signedArea(endpoint.occupancyPolygon)) <= 1e-9)) errors.push(`endpoint ${endpoint.id}: polygon must be simple and non-empty`);
  }
  return [...new Set(errors)];
}

export function advanceTeleporterTransfer(
  transfer: TeleporterTransfer,
  next: TeleporterTransferPhase,
  context: { transferId: string; robotId: string; controlEpoch: number },
): TeleporterTransfer {
  if (transfer.transferId !== context.transferId || transfer.robotId !== context.robotId) return transfer;
  if (transfer.controlEpoch !== context.controlEpoch) return transfer;
  if (!TeleporterTransferPhases.is(transfer.phase) || !transitions[transfer.phase].includes(next)) return transfer;
  return { ...transfer, phase: next, reason: "" };
}

export function isTerminalTeleporterPhase(phase: TeleporterTransferPhase): boolean {
  return phase === "completed" || phase === "failed";
}

export function polygonContainsPoint(polygon: TeleporterPoint[], point: TeleporterPoint): boolean {
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    const within = point.x >= Math.min(a.x, b.x) - 1e-9 && point.x <= Math.max(a.x, b.x) + 1e-9 && point.y >= Math.min(a.y, b.y) - 1e-9 && point.y <= Math.max(a.y, b.y) + 1e-9;
    if (Math.abs(cross) <= 1e-9 && within) return true;
  }
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    const crosses = (a.y > point.y) !== (b.y > point.y);
    if (crosses && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function endpointPolygonContains(endpoint: TeleporterEndpoint, point: TeleporterPoint): boolean {
  return polygonContainsPoint(endpoint.occupancyPolygon, { x: point.x - endpoint.position.x, y: point.y - endpoint.position.y });
}

function segmentsCross(a: TeleporterPoint, b: TeleporterPoint, c: TeleporterPoint, d: TeleporterPoint): boolean {
  const orient = (p: TeleporterPoint, q: TeleporterPoint, r: TeleporterPoint) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const on = (p: TeleporterPoint, q: TeleporterPoint, r: TeleporterPoint) => Math.abs(orient(p, q, r)) <= 1e-9 && r.x >= Math.min(p.x, q.x) - 1e-9 && r.x <= Math.max(p.x, q.x) + 1e-9 && r.y >= Math.min(p.y, q.y) - 1e-9 && r.y <= Math.max(p.y, q.y) + 1e-9;
  const a1 = orient(a, b, c), a2 = orient(a, b, d), b1 = orient(c, d, a), b2 = orient(c, d, b);
  return a1 * a2 < 0 && b1 * b2 < 0 || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
}

/** Robot body polygons use absolute map coordinates and count boundary contact as occupied. */
export function endpointPolygonOverlaps(endpoint: TeleporterEndpoint, bodyPolygon: TeleporterPoint[]): boolean {
  if (bodyPolygon.length < 3) return false;
  const area = endpoint.occupancyPolygon.map(point => ({ x: point.x + endpoint.position.x, y: point.y + endpoint.position.y }));
  if (bodyPolygon.some(point => polygonContainsPoint(area, point)) || area.some(point => polygonContainsPoint(bodyPolygon, point))) return true;
  for (let i = 0; i < area.length; i++) for (let j = 0; j < bodyPolygon.length; j++) if (segmentsCross(area[i], area[(i + 1) % area.length], bodyPolygon[j], bodyPolygon[(j + 1) % bodyPolygon.length])) return true;
  return false;
}
import { isSimplePolygon, signedArea } from "./polygon.ts";
