import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { endpointPolygonContains, endpointPolygonOverlaps, validateTeleporter, type TeleporterDefinition, type TeleporterEndpoint } from "../../shared/teleporterRuntime.ts";
import { canonicalRobotId, ROBOT_IDS } from "../../shared/constants.ts";
import { RUNTIME_MAPS } from "../../shared/maps.ts";
import { TeleporterUseStates, type TeleporterEndpointBlockReason, type TeleporterUseState, type TeleporterTransferPhase } from "../../shared/config/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = process.env.FMS_DATA_ROOT || join(here, "../../data");
export const TELEPORTER_SQLITE_PATH = process.env.TELEPORTER_SQLITE_PATH || join(DATA_ROOT, "teleporters.sqlite");
export type StoredTeleporter = TeleporterDefinition & { name: string };

export type { TeleporterUseState } from "../../shared/config/index.ts";
export type TeleporterUse = {
  teleporterId: string; robotId: string; fromEndpointId: string; toEndpointId: string;
  requestId: string; controlEpoch: number; state: TeleporterUseState; createdAt: number; updatedAt: number;
};
export type TeleporterRobotOwner = { robotId: string; mapId: string; controlEpoch: number; transferId: string; updatedAt: number };
export type RobotAdministrativeControl = { robotId: string; disabled: boolean; controlEpoch: number; reason: string; updatedAt: number };
export type DurableTeleporterTransfer = { transferId: string; teleporterId: string; robotId: string; fromEndpointId: string; toEndpointId: string; phase: TeleporterTransferPhase; sourceMapId: string; destinationMapId: string; sourceEpoch: number; destinationEpoch: number; reason: string; updatedAt: number };

function rowToTeleporter(row: Record<string, unknown>, endpoints: Record<string, unknown>[]): StoredTeleporter {
  const result = {
    id: String(row.id), name: String(row.name), enabled: Boolean(row.enabled), revision: Number(row.revision),
    endpoints: endpoints.map(endpoint => ({ id: String(endpoint.id), mapId: String(endpoint.map_id), position: { x: Number(endpoint.x), y: Number(endpoint.y) }, entryTheta: Number(endpoint.entry_theta), exitTheta: Number(endpoint.exit_theta), occupancyPolygon: JSON.parse(String(endpoint.polygon_json)), clearingPoint: { x: Number(endpoint.clearing_x), y: Number(endpoint.clearing_y) } })) as [TeleporterEndpoint, TeleporterEndpoint],
  };
  const errors = validateTeleporter(result);
  if (errors.length) throw new Error(`invalid persisted teleporter: ${errors.join(", ")}`);
  return result;
}

function rowToUse(row: Record<string, unknown>): TeleporterUse {
  return { teleporterId: String(row.teleporter_id), robotId: String(row.robot_id), fromEndpointId: String(row.from_endpoint_id), toEndpointId: String(row.to_endpoint_id), requestId: String(row.request_id), controlEpoch: Number(row.control_epoch), state: TeleporterUseStates.is(row.state) ? row.state : TeleporterUseStates.code.queued, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}

function validateGeometry(value: StoredTeleporter): string[] {
  const errors: string[] = [];
  for (const endpoint of value.endpoints) {
    const map = RUNTIME_MAPS[endpoint.mapId as keyof typeof RUNTIME_MAPS];
    if (!map) continue;
    if (endpoint.position.x < 0 || endpoint.position.y < 0 || endpoint.position.x >= map.width || endpoint.position.y >= map.height) errors.push(`endpoint ${endpoint.id} position is outside map bounds`);
    if (endpoint.clearingPoint.x < 0 || endpoint.clearingPoint.y < 0 || endpoint.clearingPoint.x >= map.width || endpoint.clearingPoint.y >= map.height) errors.push(`endpoint ${endpoint.id} clearing point is outside map bounds`);
    if (Math.hypot(endpoint.clearingPoint.x - endpoint.position.x, endpoint.clearingPoint.y - endpoint.position.y) > 256) errors.push(`endpoint ${endpoint.id} clearing path is too long (maximum 256px)`);
    if (endpoint.occupancyPolygon.length > 64) errors.push(`endpoint ${endpoint.id} occupancy polygon has too many vertices`);
    const absolute = endpoint.occupancyPolygon.map(point => ({ x: point.x + endpoint.position.x, y: point.y + endpoint.position.y }));
    if (absolute.some(point => point.x < 0 || point.y < 0 || point.x >= map.width || point.y >= map.height)) errors.push(`endpoint ${endpoint.id} occupancy polygon is outside map bounds`);
    if (!endpointPolygonContains(endpoint, endpoint.position)) errors.push(`endpoint ${endpoint.id} occupancy polygon must contain its endpoint position`);
    if (endpointPolygonContains(endpoint, endpoint.clearingPoint)) errors.push(`endpoint ${endpoint.id} clearing point must be outside occupancy polygon`);
  }
  return errors;
}

/** Shared definition and cross-map use ledger. Both map FMS processes open this same DB. */
export class TeleporterStore {
  db: Database;
  constructor(path = TELEPORTER_SQLITE_PATH) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    // Configure the wait policy before WAL negotiation. Two map servers can
    // construct the shared store at the same time during startup.
    this.db.exec("PRAGMA busy_timeout=5000;");
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA foreign_keys=ON;");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS teleporters (id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS teleporter_endpoints (id TEXT PRIMARY KEY, teleporter_id TEXT NOT NULL REFERENCES teleporters(id) ON DELETE CASCADE, map_id TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, entry_theta REAL NOT NULL, exit_theta REAL NOT NULL, polygon_json TEXT NOT NULL, clearing_x REAL NOT NULL, clearing_y REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS teleporter_uses (teleporter_id TEXT PRIMARY KEY REFERENCES teleporters(id), robot_id TEXT NOT NULL, from_endpoint_id TEXT NOT NULL, to_endpoint_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, control_epoch INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS teleporter_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, teleporter_id TEXT NOT NULL REFERENCES teleporters(id), robot_id TEXT NOT NULL, from_endpoint_id TEXT NOT NULL, to_endpoint_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, control_epoch INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS teleporter_robot_owners (robot_id TEXT PRIMARY KEY, map_id TEXT NOT NULL, control_epoch INTEGER NOT NULL, transfer_id TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS robot_administrative_controls (robot_id TEXT PRIMARY KEY, disabled INTEGER NOT NULL DEFAULT 0, control_epoch INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS teleporter_transfers (transfer_id TEXT PRIMARY KEY, teleporter_id TEXT NOT NULL, robot_id TEXT NOT NULL, from_endpoint_id TEXT NOT NULL, to_endpoint_id TEXT NOT NULL, phase TEXT NOT NULL, source_map_id TEXT NOT NULL, destination_map_id TEXT NOT NULL, source_epoch INTEGER NOT NULL, destination_epoch INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS teleporter_map_world (map_id TEXT PRIMARY KEY, heartbeat_at INTEGER NOT NULL, robots_json TEXT NOT NULL DEFAULT '[]', readiness_json TEXT NOT NULL DEFAULT '{}');
      `);
      const worldColumns = this.db.query("PRAGMA table_info(teleporter_map_world)").all() as { name: string }[];
      if (!worldColumns.some(column => column.name === "readiness_json")) this.db.exec("ALTER TABLE teleporter_map_world ADD COLUMN readiness_json TEXT NOT NULL DEFAULT '{}'");
      const columns = this.db.query("PRAGMA table_info(teleporter_endpoints)").all() as { name: string }[];
      if (!columns.some(column => column.name === "clearing_x")) this.db.exec("ALTER TABLE teleporter_endpoints ADD COLUMN clearing_x REAL NOT NULL DEFAULT 0");
      if (!columns.some(column => column.name === "clearing_y")) this.db.exec("ALTER TABLE teleporter_endpoints ADD COLUMN clearing_y REAL NOT NULL DEFAULT 0");
      this.migrateLegacyRobotIds();
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* constructor failure */ }
      this.db.close();
      throw error;
    }
  }

  /** Remove map-local robot aliases left by the old Large Lab launch mode. */
  private migrateLegacyRobotIds(): void {
    for (const robotId of ROBOT_IDS) {
      const from = `large_lab:${robotId}`;
      const owner = this.db.query("SELECT control_epoch FROM teleporter_robot_owners WHERE robot_id=?").get(from) as { control_epoch?: number } | null;
      if (owner) {
        const current = this.db.query("SELECT control_epoch FROM teleporter_robot_owners WHERE robot_id=?").get(robotId) as { control_epoch?: number } | null;
        if (!current) this.db.query("UPDATE teleporter_robot_owners SET robot_id=? WHERE robot_id=?").run(robotId, from);
        else if (Number(owner.control_epoch ?? 0) > Number(current.control_epoch ?? 0)) {
          this.db.query("UPDATE teleporter_robot_owners SET map_id=(SELECT map_id FROM teleporter_robot_owners WHERE robot_id=?),control_epoch=(SELECT control_epoch FROM teleporter_robot_owners WHERE robot_id=?),transfer_id=(SELECT transfer_id FROM teleporter_robot_owners WHERE robot_id=?),updated_at=(SELECT updated_at FROM teleporter_robot_owners WHERE robot_id=?) WHERE robot_id=?").run(from, from, from, from, robotId);
          this.db.query("DELETE FROM teleporter_robot_owners WHERE robot_id=?").run(from);
        } else this.db.query("DELETE FROM teleporter_robot_owners WHERE robot_id=?").run(from);
      }

      const rawUse = this.db.query("SELECT 1 FROM teleporter_uses WHERE robot_id=? LIMIT 1").get(robotId);
      if (rawUse) this.db.query("DELETE FROM teleporter_uses WHERE robot_id=?").run(from);
      else this.db.query("UPDATE teleporter_uses SET robot_id=? WHERE robot_id=?").run(robotId, from);
      const rawQueue = this.db.query("SELECT 1 FROM teleporter_queue WHERE robot_id=? LIMIT 1").get(robotId);
      if (rawQueue) this.db.query("DELETE FROM teleporter_queue WHERE robot_id=?").run(from);
      else this.db.query("UPDATE teleporter_queue SET robot_id=? WHERE robot_id=?").run(robotId, from);
      this.db.query("UPDATE teleporter_transfers SET robot_id=? WHERE robot_id=?").run(robotId, from);

      const admin = this.db.query("SELECT control_epoch FROM robot_administrative_controls WHERE robot_id=?").get(from) as { control_epoch?: number } | null;
      if (admin) {
        const current = this.db.query("SELECT control_epoch FROM robot_administrative_controls WHERE robot_id=?").get(robotId) as { control_epoch?: number } | null;
        if (!current) this.db.query("UPDATE robot_administrative_controls SET robot_id=? WHERE robot_id=?").run(robotId, from);
        else if (Number(admin.control_epoch ?? 0) > Number(current.control_epoch ?? 0)) {
          this.db.query("UPDATE robot_administrative_controls SET disabled=(SELECT disabled FROM robot_administrative_controls WHERE robot_id=?),control_epoch=(SELECT control_epoch FROM robot_administrative_controls WHERE robot_id=?),reason=(SELECT reason FROM robot_administrative_controls WHERE robot_id=?),updated_at=(SELECT updated_at FROM robot_administrative_controls WHERE robot_id=?) WHERE robot_id=?").run(from, from, from, from, robotId);
          this.db.query("DELETE FROM robot_administrative_controls WHERE robot_id=?").run(from);
        } else this.db.query("DELETE FROM robot_administrative_controls WHERE robot_id=?").run(from);
      }
    }

    for (const row of this.db.query("SELECT map_id,robots_json FROM teleporter_map_world").all() as { map_id: string; robots_json: string }[]) {
      let parsed: unknown[];
      try { parsed = JSON.parse(String(row.robots_json)) as unknown[]; } catch { continue; }
      if (!Array.isArray(parsed)) continue;
      const dedup = new Map<string, unknown>();
      for (const value of parsed) {
        if (!value || typeof value !== "object") continue;
        const item = value as Record<string, unknown>;
        const id = canonicalRobotId(String(item.robotId ?? item.robot_id ?? ""));
        if (!id) continue;
        dedup.set(id, { ...item, robotId: id });
      }
      this.db.query("UPDATE teleporter_map_world SET robots_json=? WHERE map_id=?").run(JSON.stringify([...dedup.values()]), row.map_id);
    }
  }
  close(): void { this.db.close(); }
  private immediate<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ } throw error; }
  }

  getRobotOwner(robotId: string): TeleporterRobotOwner | null {
    const row = this.db.query("SELECT * FROM teleporter_robot_owners WHERE robot_id=?").get(robotId) as Record<string, unknown> | null;
    return row ? { robotId: String(row.robot_id), mapId: String(row.map_id), controlEpoch: Number(row.control_epoch), transferId: String(row.transfer_id), updatedAt: Number(row.updated_at) } : null;
  }

  getRobotAdministrativeControl(robotId: string): RobotAdministrativeControl | null {
    const row = this.db.query("SELECT * FROM robot_administrative_controls WHERE robot_id=?").get(robotId) as Record<string, unknown> | null;
    return row ? { robotId: String(row.robot_id), disabled: Boolean(row.disabled), controlEpoch: Number(row.control_epoch), reason: String(row.reason ?? ""), updatedAt: Number(row.updated_at) } : null;
  }

  setRobotAdministrativeDisabled(robotId: string, controlEpoch: number, reason = "operator_disabled"): void {
    this.db.query("INSERT INTO robot_administrative_controls(robot_id,disabled,control_epoch,reason,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(robot_id) DO UPDATE SET disabled=1,control_epoch=MAX(robot_administrative_controls.control_epoch,excluded.control_epoch),reason=excluded.reason,updated_at=excluded.updated_at").run(robotId, 1, controlEpoch, reason, Date.now());
  }

  clearRobotAdministrativeDisabled(robotId: string, controlEpoch: number): void {
    this.db.query("UPDATE robot_administrative_controls SET disabled=0,control_epoch=?,reason='',updated_at=? WHERE robot_id=? AND control_epoch<=?").run(controlEpoch, Date.now(), robotId, controlEpoch);
  }

  /** Claim a global robot identity without allowing two map servers to own it. */
  claimRobotOwner(input: { robotId: string; mapId: string; controlEpoch: number; transferId?: string; expectedMapId?: string }): boolean {
    const now = Date.now();
    const tx = () => this.immediate(() => {
      const current = this.getRobotOwner(input.robotId);
      if (current && current.mapId !== input.mapId && (input.expectedMapId == null || current.mapId !== input.expectedMapId)) return false;
      if (current && current.controlEpoch > input.controlEpoch) return false;
      const transferId = input.transferId ?? current?.transferId ?? "";
      this.db.query("INSERT INTO teleporter_robot_owners(robot_id,map_id,control_epoch,transfer_id,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(robot_id) DO UPDATE SET map_id=excluded.map_id,control_epoch=excluded.control_epoch,transfer_id=excluded.transfer_id,updated_at=excluded.updated_at").run(input.robotId, input.mapId, input.controlEpoch, transferId, now);
      return true;
    });
    return tx() as boolean;
  }

  /** Atomically moves the global owner and records the transfer commit. */
  commitTransfer(value: Omit<DurableTeleporterTransfer, "updatedAt">, owner: { robotId: string; mapId: string; controlEpoch: number; expectedMapId?: string }): boolean {
    const tx = () => this.immediate(() => {
      if (this.getRobotAdministrativeControl(owner.robotId)?.disabled || this.getTransfer(value.transferId)?.phase === "failed") return false;
      const current = this.getRobotOwner(owner.robotId);
      if (current && current.mapId !== owner.mapId && (owner.expectedMapId == null || current.mapId !== owner.expectedMapId)) return false;
      if (current && current.controlEpoch > owner.controlEpoch) return false;
      const now = Date.now();
      this.db.query("INSERT INTO teleporter_robot_owners(robot_id,map_id,control_epoch,transfer_id,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(robot_id) DO UPDATE SET map_id=excluded.map_id,control_epoch=excluded.control_epoch,transfer_id=excluded.transfer_id,updated_at=excluded.updated_at").run(owner.robotId, owner.mapId, owner.controlEpoch, value.transferId, now);
      this.db.query("INSERT INTO teleporter_transfers(transfer_id,teleporter_id,robot_id,from_endpoint_id,to_endpoint_id,phase,source_map_id,destination_map_id,source_epoch,destination_epoch,reason,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(transfer_id) DO UPDATE SET phase=excluded.phase,destination_epoch=excluded.destination_epoch,reason=excluded.reason,updated_at=excluded.updated_at").run(value.transferId, value.teleporterId, value.robotId, value.fromEndpointId, value.toEndpointId, value.phase, value.sourceMapId, value.destinationMapId, value.sourceEpoch, value.destinationEpoch, value.reason, now);
      return true;
    });
    return tx() as boolean;
  }

  releaseRobotOwner(robotId: string, mapId: string, controlEpoch: number, transferId: string): boolean {
    const result = this.db.query("DELETE FROM teleporter_robot_owners WHERE robot_id=? AND map_id=? AND control_epoch=? AND transfer_id=?").run(robotId, mapId, controlEpoch, transferId);
    return result.changes > 0;
  }

  /**
   * Administrative recovery boundary for a robot.  Remove both active and
   * queued teleporter claims, mark every nonterminal transfer failed, and
   * advance the durable owner epoch.  The historical transfer id remains
   * attached to the owner so a stale robot can reconnect once and receive the
   * disabled state; the failed transfer phase and administrative marker prevent
   * it from reclaiming the robot.
   */
  forceReleaseRobot(robotId: string, controlEpoch: number, reason = "operator_disabled"): { uses: number; queued: number; transfers: number; controlEpoch: number } {
    return this.immediate(() => {
      const now = Date.now();
      const owner = this.getRobotOwner(robotId);
      // If another map advanced ownership during a handoff, the source-side
      // recovery must create a strictly newer generation than that owner.
      const ownerEpoch = owner?.controlEpoch ?? -1;
      const previous = this.getRobotAdministrativeControl(robotId);
      // Replaying an outbox after a crash must reuse the committed generation.
      // A later enabled generation also supersedes any older pending recovery.
      if (previous && previous.controlEpoch >= controlEpoch && !previous.disabled) {
        return { uses: 0, queued: 0, transfers: 0, controlEpoch: previous.controlEpoch };
      }
      const effectiveEpoch = previous?.disabled && previous.controlEpoch >= controlEpoch
        ? previous.controlEpoch : Math.max(controlEpoch, ownerEpoch + 1);
      const uses = Number((this.db.query("SELECT COUNT(*) AS count FROM teleporter_uses WHERE robot_id=?").get(robotId) as { count?: number } | null)?.count ?? 0);
      const queued = Number((this.db.query("SELECT COUNT(*) AS count FROM teleporter_queue WHERE robot_id=?").get(robotId) as { count?: number } | null)?.count ?? 0);
      const transfers = Number((this.db.query("SELECT COUNT(*) AS count FROM teleporter_transfers WHERE robot_id=? AND phase NOT IN ('completed','failed')").get(robotId) as { count?: number } | null)?.count ?? 0);
      this.db.query("DELETE FROM teleporter_uses WHERE robot_id=?").run(robotId);
      this.db.query("DELETE FROM teleporter_queue WHERE robot_id=?").run(robotId);
      this.db.query("UPDATE teleporter_transfers SET phase='failed',reason=?,updated_at=? WHERE robot_id=? AND phase NOT IN ('completed','failed')").run(reason, now, robotId);
      this.db.query("UPDATE teleporter_robot_owners SET control_epoch=?,updated_at=? WHERE robot_id=?").run(effectiveEpoch, now, robotId);
      this.setRobotAdministrativeDisabled(robotId, effectiveEpoch, reason);
      return { uses, queued, transfers, controlEpoch: effectiveEpoch };
    });
  }

  saveTransfer(value: Omit<DurableTeleporterTransfer, "updatedAt">): DurableTeleporterTransfer {
    const updatedAt = Date.now();
    this.db.query("INSERT INTO teleporter_transfers(transfer_id,teleporter_id,robot_id,from_endpoint_id,to_endpoint_id,phase,source_map_id,destination_map_id,source_epoch,destination_epoch,reason,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(transfer_id) DO UPDATE SET phase=excluded.phase,destination_epoch=excluded.destination_epoch,reason=excluded.reason,updated_at=excluded.updated_at WHERE teleporter_transfers.phase NOT IN ('failed','completed') OR teleporter_transfers.phase=excluded.phase").run(value.transferId, value.teleporterId, value.robotId, value.fromEndpointId, value.toEndpointId, value.phase, value.sourceMapId, value.destinationMapId, value.sourceEpoch, value.destinationEpoch, value.reason, updatedAt);
    return this.getTransfer(value.transferId)!;
  }
  getTransfer(transferId: string): DurableTeleporterTransfer | null {
    const row = this.db.query("SELECT * FROM teleporter_transfers WHERE transfer_id=?").get(transferId) as Record<string, unknown> | null;
    return row ? { transferId: String(row.transfer_id), teleporterId: String(row.teleporter_id), robotId: String(row.robot_id), fromEndpointId: String(row.from_endpoint_id), toEndpointId: String(row.to_endpoint_id), phase: String(row.phase) as TeleporterTransferPhase, sourceMapId: String(row.source_map_id), destinationMapId: String(row.destination_map_id), sourceEpoch: Number(row.source_epoch), destinationEpoch: Number(row.destination_epoch), reason: String(row.reason), updatedAt: Number(row.updated_at) } : null;
  }
  publishMapWorld(mapId: string, robots: unknown[], readiness: Record<string, boolean> = {}): void {
    this.db.query("INSERT INTO teleporter_map_world(map_id,heartbeat_at,robots_json,readiness_json) VALUES(?,?,?,?) ON CONFLICT(map_id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at,robots_json=excluded.robots_json,readiness_json=excluded.readiness_json").run(mapId, Date.now(), JSON.stringify(robots), JSON.stringify(readiness));
  }
  mapWorld(mapId: string, maxAgeMs = 1500): { fresh: boolean; heartbeatAt: number; robots: unknown[]; readiness: Record<string, boolean> } {
    const row = this.db.query("SELECT * FROM teleporter_map_world WHERE map_id=?").get(mapId) as Record<string, unknown> | null;
    if (!row) return { fresh: false, heartbeatAt: 0, robots: [], readiness: {} };
    let robots: unknown[] = []; try { robots = JSON.parse(String(row.robots_json)) as unknown[]; } catch { /* corrupt world is unavailable */ }
    let readiness: Record<string, boolean> = {}; try { readiness = JSON.parse(String(row.readiness_json ?? "{}")) as Record<string, boolean>; } catch { /* unavailable */ }
    const heartbeatAt = Number(row.heartbeat_at); return { fresh: Date.now() - heartbeatAt <= maxAgeMs, heartbeatAt, robots, readiness };
  }

  list(): StoredTeleporter[] {
    const rows = this.db.query("SELECT * FROM teleporters ORDER BY id").all() as Record<string, unknown>[];
    return rows.map(row => rowToTeleporter(row, this.db.query("SELECT * FROM teleporter_endpoints WHERE teleporter_id=? ORDER BY id").all(row.id) as Record<string, unknown>[]));
  }
  get(id: string): StoredTeleporter | null {
    const row = this.db.query("SELECT * FROM teleporters WHERE id=?").get(id) as Record<string, unknown> | null;
    return row ? rowToTeleporter(row, this.db.query("SELECT * FROM teleporter_endpoints WHERE teleporter_id=? ORDER BY id").all(id) as Record<string, unknown>[]) : null;
  }
  upsert(input: StoredTeleporter, expectedRevision?: number): StoredTeleporter {
    const errors = validateTeleporter(input); if (errors.length) throw new Error(`invalid teleporter: ${errors.join(", ")}`);
    if (input.endpoints.some(endpoint => !Object.hasOwn(RUNTIME_MAPS, endpoint.mapId))) throw new Error("teleporter endpoint references unknown runtime map");
    const geometryErrors = validateGeometry(input); if (geometryErrors.length) throw new Error(`invalid teleporter geometry: ${geometryErrors.join(", ")}`);
    const tx = () => this.immediate(() => {
      if (this.hasBlockingUse(input.id)) throw new Error("teleporter is in use");
      const current = this.db.query("SELECT revision FROM teleporters WHERE id=?").get(input.id) as { revision?: number } | null;
      if (current && expectedRevision == null && input.revision === 0) throw new Error("teleporter already exists");
      if (expectedRevision != null && (!current || Number(current.revision) !== expectedRevision)) throw new Error("teleporter revision conflict");
      const revision = current ? Number(current.revision) + 1 : Math.max(1, input.revision); const t = Date.now();
      this.db.query("INSERT INTO teleporters(id,name,enabled,revision,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,revision=excluded.revision,updated_at=excluded.updated_at").run(input.id, input.name, input.enabled ? 1 : 0, revision, t);
      this.db.query("DELETE FROM teleporter_endpoints WHERE teleporter_id=?").run(input.id);
      for (const endpoint of input.endpoints) this.db.query("INSERT INTO teleporter_endpoints(id,teleporter_id,map_id,x,y,entry_theta,exit_theta,polygon_json,clearing_x,clearing_y) VALUES(?,?,?,?,?,?,?,?,?,?)").run(endpoint.id, input.id, endpoint.mapId, endpoint.position.x, endpoint.position.y, endpoint.entryTheta, endpoint.exitTheta, JSON.stringify(endpoint.occupancyPolygon), endpoint.clearingPoint.x, endpoint.clearingPoint.y);
    });
    tx(); return this.get(input.id)!;
  }
  delete(id: string): void { this.immediate(() => { if (this.hasBlockingUse(id)) throw new Error("teleporter is in use"); this.db.query("DELETE FROM teleporters WHERE id=?").run(id); }); }

  private hasBlockingUse(teleporterId: string): boolean {
    if (this.activeUse(teleporterId)) return true;
    if (this.db.query("SELECT 1 FROM teleporter_queue WHERE teleporter_id=? LIMIT 1").get(teleporterId)) return true;
    const durable = this.db.query("SELECT 1 FROM teleporter_transfers WHERE teleporter_id=? AND phase NOT IN ('completed','failed') LIMIT 1").get(teleporterId);
    return Boolean(durable);
  }

  activeUse(teleporterId: string): TeleporterUse | null {
    const row = this.db.query("SELECT * FROM teleporter_uses WHERE teleporter_id=?").get(teleporterId) as Record<string, unknown> | null;
    return row ? rowToUse(row) : null;
  }
  /**
   * Gate ordinary driving as well as teleporter commands. A reserved endpoint
   * is blocked for everyone; a robot pose touching the polygon is also blocked
   * until it fully leaves. Dynamic obstacles and map forbidden zones remain
   * the caller's responsibility because they live in each map's context.
   */
  endpointBlocked(input: { teleporterId: string; endpointId: string; robotPoses: { robotId: string; x: number; y: number; bodyPolygon?: { x: number; y: number }[] }[] }): { blocked: boolean; robotIds: string[]; reason: TeleporterEndpointBlockReason | null } {
    const definition = this.get(input.teleporterId); const endpoint = definition?.endpoints.find(item => item.id === input.endpointId);
    if (!definition || !endpoint) return { blocked: false, robotIds: [], reason: null };
    const active = this.activeUse(input.teleporterId);
    const reserved = active && (active.fromEndpointId === endpoint.id || active.toEndpointId === endpoint.id) ? [active.robotId] : [];
    const overlap = input.robotPoses.filter(pose => pose.bodyPolygon ? endpointPolygonOverlaps(endpoint, pose.bodyPolygon) : endpointPolygonContains(endpoint, pose)).map(pose => pose.robotId);
    const robotIds = [...new Set([...reserved, ...overlap])];
    return { blocked: robotIds.length > 0, robotIds, reason: reserved.length ? "reserved" : overlap.length ? "body_overlap" : null };
  }
  queue(teleporterId: string): TeleporterUse[] {
    return (this.db.query("SELECT * FROM teleporter_queue WHERE teleporter_id=? ORDER BY id").all(teleporterId) as Record<string, unknown>[]).map(row => ({ teleporterId: String(row.teleporter_id), robotId: String(row.robot_id), fromEndpointId: String(row.from_endpoint_id), toEndpointId: String(row.to_endpoint_id), requestId: String(row.request_id), controlEpoch: Number(row.control_epoch), state: "queued", createdAt: Number(row.created_at), updatedAt: Number(row.created_at) }));
  }
  /** FIFO logical ordering; reservation atomically owns both endpoint polygons. */
  requestUse(input: Omit<TeleporterUse, "state" | "createdAt" | "updatedAt">): TeleporterUse {
    const now = Date.now(); let result: TeleporterUse;
    const tx = () => this.immediate(() => {
      const teleporter = this.get(input.teleporterId); if (!teleporter || !teleporter.enabled) throw new Error("teleporter unavailable");
      const direction = teleporter.endpoints.find(endpoint => endpoint.id === input.fromEndpointId) && teleporter.endpoints.find(endpoint => endpoint.id === input.toEndpointId);
      if (!direction || input.fromEndpointId === input.toEndpointId) throw new Error("invalid teleporter direction");
      const existing = this.db.query("SELECT * FROM teleporter_uses WHERE request_id=?").get(input.requestId) as Record<string, unknown> | null;
      const queued = this.db.query("SELECT * FROM teleporter_queue WHERE request_id=?").get(input.requestId) as Record<string, unknown> | null;
      const replay = existing ?? queued;
      if (replay) {
        if (String(replay.teleporter_id) !== input.teleporterId || String(replay.robot_id) !== input.robotId || String(replay.from_endpoint_id) !== input.fromEndpointId || String(replay.to_endpoint_id) !== input.toEndpointId || Number(replay.control_epoch) !== input.controlEpoch) throw new Error("teleporter request id already belongs to another request");
        result = existing ? rowToUse(existing) : { ...input, state: "queued", createdAt: Number(replay.created_at), updatedAt: Number(replay.created_at) };
        return;
      }
      const otherActive = this.db.query("SELECT teleporter_id FROM teleporter_uses WHERE robot_id=? UNION SELECT teleporter_id FROM teleporter_queue WHERE robot_id=? LIMIT 1").get(input.robotId, input.robotId) as { teleporter_id?: string } | null;
      if (otherActive) throw new Error("robot already has an active teleporter request");
      const durable = this.db.query("SELECT 1 FROM teleporter_transfers WHERE robot_id=? AND phase NOT IN ('completed','failed') LIMIT 1").get(input.robotId);
      if (durable) throw new Error("robot already has an active teleporter transfer");
      const active = this.db.query("SELECT 1 FROM teleporter_uses WHERE teleporter_id=?").get(input.teleporterId);
      const waiting = this.db.query("SELECT 1 FROM teleporter_queue WHERE teleporter_id=? LIMIT 1").get(input.teleporterId);
      const state: TeleporterUseState = active || waiting ? "queued" : "reserved";
      if (state === "queued") this.db.query("INSERT INTO teleporter_queue(teleporter_id,robot_id,from_endpoint_id,to_endpoint_id,request_id,control_epoch,created_at) VALUES(?,?,?,?,?,?,?)").run(input.teleporterId, input.robotId, input.fromEndpointId, input.toEndpointId, input.requestId, input.controlEpoch, now);
      else this.db.query("INSERT INTO teleporter_uses(teleporter_id,robot_id,from_endpoint_id,to_endpoint_id,request_id,control_epoch,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(input.teleporterId, input.robotId, input.fromEndpointId, input.toEndpointId, input.requestId, input.controlEpoch, state, now, now);
      result = { ...input, state, createdAt: now, updatedAt: now };
    }); tx();
    return result!;
  }
  promoteNext(teleporterId: string, eligibleRobotIds?: Set<string> | ((request: { robotId: string; controlEpoch: number }) => boolean)): TeleporterUse | null {
    // Selection and promotion must share one IMMEDIATE SQLite transaction;
    // two map rooms poll the same queue concurrently.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.db.query("SELECT 1 FROM teleporter_uses WHERE teleporter_id=?").get(teleporterId);
      if (active) { this.db.exec("ROLLBACK"); return null; }
      const queued = this.db.query("SELECT * FROM teleporter_queue WHERE teleporter_id=? ORDER BY id").all(teleporterId) as Record<string, unknown>[];
      const next = queued.find(row => !eligibleRobotIds || (eligibleRobotIds instanceof Set ? eligibleRobotIds.has(String(row.robot_id)) : eligibleRobotIds({ robotId: String(row.robot_id), controlEpoch: Number(row.control_epoch) }))) ?? null;
      if (!next) { this.db.exec("ROLLBACK"); return null; }
      this.db.query("DELETE FROM teleporter_queue WHERE id=?").run(next.id);
      this.db.query("INSERT INTO teleporter_uses(teleporter_id,robot_id,from_endpoint_id,to_endpoint_id,request_id,control_epoch,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(next.teleporter_id,next.robot_id,next.from_endpoint_id,next.to_endpoint_id,next.request_id,next.control_epoch,"reserved",next.created_at,Date.now());
      this.db.exec("COMMIT");
      return this.activeUse(teleporterId);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }
  setState(teleporterId: string, state: Exclude<TeleporterUseState, "queued">, guard?: { robotId: string; requestId: string; controlEpoch: number }): TeleporterUse {
    const active = this.activeUse(teleporterId); if (!active) throw new Error("no active teleporter use");
    if (guard && (active.robotId !== guard.robotId || active.requestId !== guard.requestId || active.controlEpoch !== guard.controlEpoch)) throw new Error("teleporter ownership mismatch");
    const now = Date.now(); this.db.query("UPDATE teleporter_uses SET state=?,updated_at=? WHERE teleporter_id=? AND robot_id=? AND request_id=? AND control_epoch=?").run(state, now, teleporterId, active.robotId, active.requestId, active.controlEpoch); return this.activeUse(teleporterId)!;
  }
  /** Explicit completion only. Disconnects do not call this automatically. */
  complete(teleporterId: string, robotId: string, requestId: string, controlEpoch?: number, eligibleRobotIds?: Set<string> | ((request: { robotId: string; controlEpoch: number }) => boolean)): TeleporterUse | null {
    const active = this.activeUse(teleporterId); if (!active || active.robotId !== robotId || active.requestId !== requestId || (controlEpoch != null && active.controlEpoch !== controlEpoch)) return null; this.db.query("DELETE FROM teleporter_uses WHERE teleporter_id=? AND robot_id=? AND request_id=?").run(teleporterId, robotId, requestId); return this.promoteNext(teleporterId, eligibleRobotIds);
  }
  /** A queued request may be cancelled explicitly; active reservations require completion/recovery. */
  cancelQueued(teleporterId: string, robotId: string, requestId: string): boolean {
    const result = this.db.query("DELETE FROM teleporter_queue WHERE teleporter_id=? AND robot_id=? AND request_id=?").run(teleporterId, robotId, requestId);
    return result.changes > 0;
  }
  cancelReserved(teleporterId: string, robotId: string, requestId: string): boolean {
    const result = this.db.query("DELETE FROM teleporter_uses WHERE teleporter_id=? AND robot_id=? AND request_id=? AND state='reserved'").run(teleporterId, robotId, requestId);
    return result.changes > 0;
  }
  /** Release the physical endpoint reservation after the full body has left.
   * The durable transfer remains in `clearing` until the robot reaches its
   * clearing point, so reconnect/restart can still finish the command. */
  releaseOccupancy(teleporterId: string, robotId: string, requestId: string, eligibleRobotIds?: Set<string>): TeleporterUse | null {
    const active = this.activeUse(teleporterId);
    if (!active || active.robotId !== robotId || active.requestId !== requestId || !["occupied", "clearing"].includes(active.state)) return null;
    const removed = this.db.query("DELETE FROM teleporter_uses WHERE teleporter_id=? AND robot_id=? AND request_id=?").run(teleporterId, robotId, requestId);
    if (!removed.changes) return null;
    return this.promoteNext(teleporterId, eligibleRobotIds);
  }
}
