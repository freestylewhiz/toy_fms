import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIVE_MAP, canonicalRobotId, MAP_ID } from '../../shared/constants.ts';
import { runtimeMap } from '../../shared/maps.ts';
import { ConnectionStates, FmsControlStates, NavigationModes, OccupancyStates, PathPlanningAuthorities, ResourceKinds, RuntimeAuditActions, type RuntimeAuditAction, type ConnectionState, type DriveState, type FmsControlState, type NavigationMode, type PathPlanningAuthority, type WorkState } from '../../shared/config/index.ts';
import { parseDriveState, parseWorkState, type ResourceOccupancy } from '../../shared/robotRuntime.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const RUNTIME_DATA_DIR = process.env.FMS_DATA_ROOT ? join(process.env.FMS_DATA_ROOT, ACTIVE_MAP.dataDirectory) : join(here, '../../data', ACTIVE_MAP.dataDirectory);
export const RUNTIME_SQLITE_PATH = join(RUNTIME_DATA_DIR, "runtime.sqlite");

export function runtimeSqlitePathForMap(mapId: string): string {
  const root = process.env.FMS_DATA_ROOT || join(here, '../../data');
  return join(root, runtimeMap(mapId).dataDirectory, "runtime.sqlite");
}

export type RobotRuntime = {
  robotId: string;
  x?: number; y?: number; theta?: number;
  workState: WorkState;
  fmsControlState: FmsControlState;
  connectionState: ConnectionState;
  connectionReason: string;
  driveState: DriveState;
  driveContextJson: string;
  controlEpoch: number;
  controlReady: boolean;
  reportedAt: number;
  stateChangedAt: number;
  sessionId: string;
  navigationMode: NavigationMode;
  pathPlanningAuthority: PathPlanningAuthority;
  /** Durable desired motion pause latch; actual application is session/ACK scoped. */
  operatorPaused?: boolean;
};

export type RuntimeOccupancy = ResourceOccupancy & {
  queuePosition?: number;
  releasedAt?: number;
  releaseReason?: string;
  releasedBy?: string;
};

export type RuntimeAudit = {
  action: RuntimeAuditAction;
  robotId: string;
  resourceKind?: string;
  resourceId?: string;
  requestId?: string;
  expectedEpoch?: number;
  details?: Record<string, unknown>;
};
export type RuntimeRecoveryPending = { robotId: string; controlEpoch: number; createdAt: number };

function rowRuntime(row: Record<string, unknown>): RobotRuntime {
  return {
    robotId: String(row.robot_id), x: Number(row.x ?? 0), y: Number(row.y ?? 0), theta: Number(row.theta ?? 0), workState: parseWorkState(row.work_state),
    fmsControlState: FmsControlStates.is(row.fms_control_state) ? row.fms_control_state : FmsControlStates.code.enabled,
    connectionState: ConnectionStates.is(row.connection_state) ? row.connection_state : ConnectionStates.code.offline,
    connectionReason: String(row.connection_reason ?? ""), driveState: parseDriveState(row.drive_state),
    driveContextJson: String(row.drive_context_json ?? "{}"), controlEpoch: Number(row.control_epoch ?? 0),
    controlReady: Boolean(row.control_ready), reportedAt: Number(row.reported_at ?? 0),
    stateChangedAt: Number(row.state_changed_at ?? 0), sessionId: String(row.session_id ?? ""),
    navigationMode: NavigationModes.is(row.navigation_mode) ? row.navigation_mode : NavigationModes.code.unknown,
    pathPlanningAuthority: PathPlanningAuthorities.is(row.path_planning_authority) ? row.path_planning_authority : PathPlanningAuthorities.code.unknown, operatorPaused: Boolean(row.operator_paused),
  };
}

function rowOccupancy(row: Record<string, unknown>): RuntimeOccupancy {
  return {
    resourceRef: { mapId: String(row.map_id ?? MAP_ID), kind: ResourceKinds.is(row.resource_kind) ? row.resource_kind : ResourceKinds.code.zone, id: String(row.resource_id), ...(row.step_id ? { stepId: String(row.step_id) } : {}) }, robotId: String(row.robot_id),
    queuePosition: row.queue_position == null ? undefined : Number(row.queue_position),
    state: OccupancyStates.is(row.state) ? row.state : OccupancyStates.code.reserved, requestId: String(row.request_id ?? ""),
    controlEpoch: Number(row.control_epoch ?? 0), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    releasedAt: row.released_at == null ? undefined : Number(row.released_at),
    releaseReason: row.release_reason == null ? undefined : String(row.release_reason),
    releasedBy: row.released_by == null ? undefined : String(row.released_by),
  };
}

export class RuntimeStore {
  readonly db: Database;
  constructor(path = RUNTIME_SQLITE_PATH) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS robot_runtime (
        robot_id TEXT PRIMARY KEY, x REAL NOT NULL DEFAULT 0, y REAL NOT NULL DEFAULT 0, theta REAL NOT NULL DEFAULT 0, work_state TEXT NOT NULL DEFAULT 'unknown',
        fms_control_state TEXT NOT NULL DEFAULT 'enabled', connection_state TEXT NOT NULL DEFAULT 'offline',
        connection_reason TEXT NOT NULL DEFAULT '', drive_state TEXT NOT NULL DEFAULT 'unknown',
        drive_context_json TEXT NOT NULL DEFAULT '{}', control_epoch INTEGER NOT NULL DEFAULT 0,
        control_ready INTEGER NOT NULL DEFAULT 0, reported_at INTEGER NOT NULL DEFAULT 0,
        state_changed_at INTEGER NOT NULL DEFAULT 0, session_id TEXT NOT NULL DEFAULT '',
        navigation_mode TEXT NOT NULL DEFAULT 'unknown', path_planning_authority TEXT NOT NULL DEFAULT 'unknown', operator_paused INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS runtime_occupancies (
        map_id TEXT NOT NULL DEFAULT '${MAP_ID}', resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, step_id TEXT, robot_id TEXT NOT NULL,
        state TEXT NOT NULL, request_id TEXT NOT NULL DEFAULT '', control_epoch INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, released_at INTEGER,
        release_reason TEXT, released_by TEXT, PRIMARY KEY(resource_kind, resource_id, robot_id)
      );
      CREATE TABLE IF NOT EXISTS runtime_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, robot_id TEXT NOT NULL,
        resource_kind TEXT, resource_id TEXT, request_id TEXT, expected_epoch INTEGER,
        details_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_recovery_pending (
        robot_id TEXT PRIMARY KEY, control_epoch INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    this.additiveMigrations();
    this.migrateLegacyRobotIds();
  }

  private additiveMigrations(): void {
    const add = (table: string, column: string, definition: string) => {
      const columns = this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!columns.some((x) => x.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    for (const [name, definition] of [
      ["x", "REAL NOT NULL DEFAULT 0"], ["y", "REAL NOT NULL DEFAULT 0"], ["theta", "REAL NOT NULL DEFAULT 0"],
      ["work_state", "TEXT NOT NULL DEFAULT 'unknown'"], ["fms_control_state", "TEXT NOT NULL DEFAULT 'enabled'"],
      ["connection_state", "TEXT NOT NULL DEFAULT 'offline'"], ["connection_reason", "TEXT NOT NULL DEFAULT ''"],
      ["drive_state", "TEXT NOT NULL DEFAULT 'unknown'"], ["drive_context_json", "TEXT NOT NULL DEFAULT '{}'"],
      ["control_epoch", "INTEGER NOT NULL DEFAULT 0"], ["control_ready", "INTEGER NOT NULL DEFAULT 0"],
      ["reported_at", "INTEGER NOT NULL DEFAULT 0"], ["state_changed_at", "INTEGER NOT NULL DEFAULT 0"],
      ["session_id", "TEXT NOT NULL DEFAULT ''"], ["navigation_mode", "TEXT NOT NULL DEFAULT 'unknown'"],
      ["path_planning_authority", "TEXT NOT NULL DEFAULT 'unknown'"],
      ["operator_paused", "INTEGER NOT NULL DEFAULT 0"],
    ] as const) add("robot_runtime", name, definition);
    add("runtime_occupancies", "map_id", `TEXT NOT NULL DEFAULT '${MAP_ID}'`);
    add("runtime_occupancies", "step_id", "TEXT");
    add("runtime_occupancies", "queue_position", "INTEGER");
  }

  /** Collapse the pre-teleporter Large Lab-prefixed simulator identities. */
  private migrateLegacyRobotIds(): void {
    const rows = this.db.query("SELECT robot_id FROM robot_runtime WHERE robot_id LIKE 'large_lab:%'").all() as { robot_id: string }[];
    if (!rows.length) return;
    this.db.transaction(() => {
      for (const row of rows) {
        const from = String(row.robot_id);
        const to = canonicalRobotId(from);
        if (!to || to === from) continue;
        const legacy = this.db.query("SELECT control_epoch,reported_at FROM robot_runtime WHERE robot_id=?").get(from) as { control_epoch?: number; reported_at?: number } | null;
        const current = this.db.query("SELECT control_epoch,reported_at FROM robot_runtime WHERE robot_id=?").get(to) as { control_epoch?: number; reported_at?: number } | null;
        if (!current) {
          this.db.query("UPDATE robot_runtime SET robot_id=? WHERE robot_id=?").run(to, from);
        } else {
          const legacyWins = Number(legacy?.control_epoch ?? 0) > Number(current.control_epoch ?? 0) ||
            (Number(legacy?.control_epoch ?? 0) === Number(current.control_epoch ?? 0) && Number(legacy?.reported_at ?? 0) > Number(current.reported_at ?? 0));
          if (legacyWins) {
            this.db.query(`UPDATE robot_runtime SET x=(SELECT x FROM robot_runtime WHERE robot_id=?),y=(SELECT y FROM robot_runtime WHERE robot_id=?),theta=(SELECT theta FROM robot_runtime WHERE robot_id=?),work_state=(SELECT work_state FROM robot_runtime WHERE robot_id=?),fms_control_state=(SELECT fms_control_state FROM robot_runtime WHERE robot_id=?),connection_state=(SELECT connection_state FROM robot_runtime WHERE robot_id=?),connection_reason=(SELECT connection_reason FROM robot_runtime WHERE robot_id=?),drive_state=(SELECT drive_state FROM robot_runtime WHERE robot_id=?),drive_context_json=(SELECT drive_context_json FROM robot_runtime WHERE robot_id=?),control_epoch=(SELECT control_epoch FROM robot_runtime WHERE robot_id=?),control_ready=(SELECT control_ready FROM robot_runtime WHERE robot_id=?),reported_at=(SELECT reported_at FROM robot_runtime WHERE robot_id=?),state_changed_at=(SELECT state_changed_at FROM robot_runtime WHERE robot_id=?),session_id=(SELECT session_id FROM robot_runtime WHERE robot_id=?),navigation_mode=(SELECT navigation_mode FROM robot_runtime WHERE robot_id=?),path_planning_authority=(SELECT path_planning_authority FROM robot_runtime WHERE robot_id=?),operator_paused=(SELECT operator_paused FROM robot_runtime WHERE robot_id=?) WHERE robot_id=?`).run(...Array(17).fill(from), to);
          }
          this.db.query("DELETE FROM robot_runtime WHERE robot_id=?").run(from);
        }
        this.db.query("DELETE FROM runtime_occupancies WHERE robot_id=? AND EXISTS (SELECT 1 FROM runtime_occupancies current WHERE current.robot_id=? AND current.resource_kind=runtime_occupancies.resource_kind AND current.resource_id=runtime_occupancies.resource_id)").run(from, to);
        this.db.query("UPDATE runtime_occupancies SET robot_id=? WHERE robot_id=?").run(to, from);
        this.db.query("UPDATE runtime_audit SET robot_id=? WHERE robot_id=?").run(to, from);
        const pending = this.db.query("SELECT control_epoch FROM runtime_recovery_pending WHERE robot_id=?").get(from) as { control_epoch?: number } | null;
        const pendingCurrent = this.db.query("SELECT control_epoch FROM runtime_recovery_pending WHERE robot_id=?").get(to) as { control_epoch?: number } | null;
        if (pending && (!pendingCurrent || Number(pending.control_epoch ?? 0) > Number(pendingCurrent.control_epoch ?? 0))) {
          this.db.query("INSERT INTO runtime_recovery_pending(robot_id,control_epoch,created_at) VALUES(?,?,?) ON CONFLICT(robot_id) DO UPDATE SET control_epoch=excluded.control_epoch,created_at=excluded.created_at").run(to, Number(pending.control_epoch ?? 0), Date.now());
        }
        this.db.query("DELETE FROM runtime_recovery_pending WHERE robot_id=?").run(from);
      }
    })();
  }

  getRobot(robotId: string): RobotRuntime | null {
    const row = this.db.query("SELECT * FROM robot_runtime WHERE robot_id = ?").get(robotId) as Record<string, unknown> | null;
    return row ? rowRuntime(row) : null;
  }

  ensureRobot(robotId: string): RobotRuntime {
    const existing = this.getRobot(robotId);
    if (existing) return existing;
    const value: RobotRuntime = { robotId, workState: "unknown", fmsControlState: "enabled", connectionState: "offline", connectionReason: "never_seen", driveState: "unknown", driveContextJson: "[]", controlEpoch: 0, controlReady: false, reportedAt: 0, stateChangedAt: Date.now(), sessionId: "", navigationMode: "unknown", pathPlanningAuthority: "unknown", operatorPaused: false };
    this.upsertRobot(value);
    return value;
  }

  listRobots(): RobotRuntime[] { return (this.db.query("SELECT * FROM robot_runtime ORDER BY robot_id").all() as Record<string, unknown>[]).map(rowRuntime); }

  upsertRobot(value: RobotRuntime): void {
    this.db.query(`INSERT INTO robot_runtime (robot_id,x,y,theta,work_state,fms_control_state,connection_state,connection_reason,drive_state,drive_context_json,control_epoch,control_ready,reported_at,state_changed_at,session_id,navigation_mode,path_planning_authority,operator_paused)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(robot_id) DO UPDATE SET x=excluded.x,y=excluded.y,theta=excluded.theta,work_state=excluded.work_state,fms_control_state=excluded.fms_control_state,connection_state=excluded.connection_state,connection_reason=excluded.connection_reason,drive_state=excluded.drive_state,drive_context_json=excluded.drive_context_json,control_epoch=excluded.control_epoch,control_ready=excluded.control_ready,reported_at=excluded.reported_at,state_changed_at=excluded.state_changed_at,session_id=excluded.session_id,navigation_mode=excluded.navigation_mode,path_planning_authority=excluded.path_planning_authority,operator_paused=excluded.operator_paused`).run(value.robotId, value.x ?? 0, value.y ?? 0, value.theta ?? 0, value.workState, value.fmsControlState, value.connectionState, value.connectionReason, value.driveState, value.driveContextJson, value.controlEpoch, value.controlReady ? 1 : 0, value.reportedAt, value.stateChangedAt, value.sessionId, value.navigationMode, value.pathPlanningAuthority, value.operatorPaused ? 1 : 0);
  }

  setOperatorPaused(robotId: string, paused: boolean): RobotRuntime | null {
    this.db.query("UPDATE robot_runtime SET operator_paused=? WHERE robot_id=?").run(paused ? 1 : 0, robotId);
    return this.getRobot(robotId);
  }

  listOccupancies(includeReleased = false): RuntimeOccupancy[] {
    const sql = includeReleased ? "SELECT * FROM runtime_occupancies ORDER BY created_at" : "SELECT * FROM runtime_occupancies WHERE released_at IS NULL ORDER BY created_at";
    return (this.db.query(sql).all() as Record<string, unknown>[]).map(rowOccupancy);
  }

  listRecoveryPending(): RuntimeRecoveryPending[] {
    return (this.db.query("SELECT * FROM runtime_recovery_pending ORDER BY created_at").all() as Record<string, unknown>[]).map(row => ({ robotId: String(row.robot_id), controlEpoch: Number(row.control_epoch), createdAt: Number(row.created_at) }));
  }

  clearRecoveryPending(robotId: string, controlEpoch: number): void {
    this.db.query("DELETE FROM runtime_recovery_pending WHERE robot_id=? AND control_epoch<=?").run(robotId, controlEpoch);
  }

  /** Apply a committed shared recovery without creating another epoch/outbox event. */
  applyAdministrativeDisable(robotId: string, controlEpoch: number): RuntimeOccupancy[] {
    return this.db.transaction(() => {
      const current = this.getRobot(robotId);
      if (current?.controlEpoch && current.controlEpoch > controlEpoch) return [];
      const released = this.listOccupancies().filter(item => item.robotId === robotId);
      const now = Date.now();
      this.db.query("UPDATE robot_runtime SET fms_control_state='disabled',control_ready=0,control_epoch=?,state_changed_at=? WHERE robot_id=?").run(Math.max(controlEpoch, current?.controlEpoch ?? controlEpoch), now, robotId);
      this.db.query("UPDATE runtime_occupancies SET released_at=?,updated_at=?,release_reason='operator_disabled',released_by='shared_operator_recovery',control_epoch=? WHERE robot_id=? AND released_at IS NULL").run(now, now, controlEpoch, robotId);
      this.clearRecoveryPending(robotId, controlEpoch);
      return released;
    })();
  }

  upsertOccupancy(value: RuntimeOccupancy): void {
    this.db.query(`INSERT INTO runtime_occupancies (map_id,resource_kind,resource_id,step_id,robot_id,state,request_id,control_epoch,created_at,updated_at,released_at,release_reason,released_by,queue_position) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(resource_kind,resource_id,robot_id) DO UPDATE SET map_id=excluded.map_id,step_id=excluded.step_id,state=excluded.state,request_id=excluded.request_id,control_epoch=excluded.control_epoch,created_at=excluded.created_at,queue_position=excluded.queue_position,updated_at=excluded.updated_at,released_at=excluded.released_at,release_reason=excluded.release_reason,released_by=excluded.released_by`).run(value.resourceRef.mapId, value.resourceRef.kind, value.resourceRef.id, value.resourceRef.stepId ?? null, value.robotId, value.state, value.requestId, value.controlEpoch, value.createdAt, value.updatedAt, value.releasedAt ?? null, value.releaseReason ?? null, value.releasedBy ?? null, value.queuePosition ?? null);
  }

  /** Disable the robot and release exactly one selected resource in one transaction. */
  releaseResourceAndDisable(input: { resourceKind: string; resourceId: string; robotId: string; requestId?: string; expectedEpoch?: number; releasedBy?: string }): { ok: boolean; message: string; controlEpoch?: number } {
    const tx = this.db.transaction(() => {
      const current = this.getRobot(input.robotId);
      if (!current) return { ok: false, message: "unknown robot" };
      if (input.expectedEpoch != null && current.controlEpoch !== input.expectedEpoch) return { ok: false, message: "control epoch mismatch" };
      const occ = this.db.query("SELECT * FROM runtime_occupancies WHERE resource_kind=? AND resource_id=? AND robot_id=? AND released_at IS NULL").get(input.resourceKind, input.resourceId, input.robotId);
      if (!occ) return { ok: false, message: "occupancy not found" };
      const epoch = current.controlEpoch + 1, now = Date.now();
      this.db.query("UPDATE robot_runtime SET fms_control_state='disabled',control_ready=0,control_epoch=?,state_changed_at=? WHERE robot_id=?").run(epoch, now, input.robotId);
      this.db.query("UPDATE runtime_occupancies SET released_at=?,updated_at=?,release_reason='manual_release',released_by=? WHERE resource_kind=? AND resource_id=? AND robot_id=? AND released_at IS NULL").run(now, now, input.releasedBy ?? "", input.resourceKind, input.resourceId, input.robotId);
      this.audit({ action: RuntimeAuditActions.code.manual_release_disable, robotId: input.robotId, resourceKind: input.resourceKind, resourceId: input.resourceId, requestId: input.requestId, expectedEpoch: input.expectedEpoch, details: { controlEpoch: epoch, actor: input.releasedBy ?? "", reason: "manual_release" } });
      return { ok: true, message: "released and disabled", controlEpoch: epoch };
    });
    return tx() as { ok: boolean; message: string; controlEpoch?: number };
  }

  /**
   * Operator recovery boundary: disable the robot and close every logical
   * occupancy owned by it in one durable transaction.  The physical pose is
   * deliberately left untouched; it remains telemetry and an obstacle to the
   * rest of the fleet.  Advancing the control epoch invalidates late command,
   * lease, and transfer messages.
   */
  disableAndReleaseAll(input: { robotId: string; expectedEpoch?: number; requestId?: string; releasedBy?: string }): { ok: boolean; message: string; controlEpoch?: number; released: RuntimeOccupancy[] } {
    const tx = this.db.transaction(() => {
      const current = this.getRobot(input.robotId);
      if (!current) return { ok: false, message: "unknown robot", released: [] as RuntimeOccupancy[] };
      if (input.expectedEpoch != null && current.controlEpoch !== input.expectedEpoch) return { ok: false, message: "control epoch mismatch", released: [] as RuntimeOccupancy[] };
      const released = (this.db.query("SELECT * FROM runtime_occupancies WHERE robot_id=? AND released_at IS NULL ORDER BY created_at").all(input.robotId) as Record<string, unknown>[]).map(rowOccupancy);
      const epoch = current.controlEpoch + 1, now = Date.now();
      this.db.query("UPDATE robot_runtime SET fms_control_state='disabled',control_ready=0,control_epoch=?,state_changed_at=? WHERE robot_id=?").run(epoch, now, input.robotId);
      this.db.query("UPDATE runtime_occupancies SET released_at=?,updated_at=?,release_reason='operator_disabled',released_by=?,control_epoch=? WHERE robot_id=? AND released_at IS NULL").run(now, now, input.releasedBy ?? "", epoch, input.robotId);
      this.db.query("INSERT INTO runtime_recovery_pending(robot_id,control_epoch,created_at) VALUES(?,?,?) ON CONFLICT(robot_id) DO UPDATE SET control_epoch=excluded.control_epoch,created_at=excluded.created_at").run(input.robotId, epoch, now);
      this.audit({ action: RuntimeAuditActions.code.operator_disable_release_all, robotId: input.robotId, requestId: input.requestId, expectedEpoch: input.expectedEpoch, details: { controlEpoch: epoch, releasedCount: released.length, actor: input.releasedBy ?? "", reason: "operator_disabled" } });
      return { ok: true, message: "all logical occupancy released and robot disabled", controlEpoch: epoch, released };
    });
    return tx() as { ok: boolean; message: string; controlEpoch?: number; released: RuntimeOccupancy[] };
  }

  audit(value: RuntimeAudit): void {
    this.db.query("INSERT INTO runtime_audit (action,robot_id,resource_kind,resource_id,request_id,expected_epoch,details_json,created_at) VALUES (?,?,?,?,?,?,?,?)").run(value.action, value.robotId, value.resourceKind ?? null, value.resourceId ?? null, value.requestId ?? null, value.expectedEpoch ?? null, JSON.stringify(value.details ?? {}), Date.now());
  }
  close(): void { this.db.close(); }
}
