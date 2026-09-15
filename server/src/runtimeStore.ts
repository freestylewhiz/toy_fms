import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const RUNTIME_DATA_DIR = join(here, "../../data");
export const RUNTIME_SQLITE_PATH = join(RUNTIME_DATA_DIR, "runtime.sqlite");

export type RobotRuntime = {
  robotId: string;
  x?: number; y?: number; theta?: number;
  workState: string;
  fmsControlState: "enabled" | "disabled";
  connectionState: "online" | "offline";
  connectionReason: string;
  driveState: string;
  driveContextJson: string;
  controlEpoch: number;
  controlReady: boolean;
  reportedAt: number;
  stateChangedAt: number;
  sessionId: string;
  navigationMode: string;
  pathPlanningAuthority: string;
};

export type RuntimeOccupancy = {
  resourceRef: { mapId: string; kind: "zone" | "node" | "edge"; id: string; stepId?: string };
  robotId: string;
  state: "reserved" | "occupied" | "queued";
  requestId: string;
  controlEpoch: number;
  createdAt: number;
  updatedAt: number;
  queuePosition?: number;
  releasedAt?: number;
  releaseReason?: string;
  releasedBy?: string;
};

export type RuntimeAudit = {
  action: string;
  robotId: string;
  resourceKind?: string;
  resourceId?: string;
  requestId?: string;
  expectedEpoch?: number;
  details?: Record<string, unknown>;
};

function rowRuntime(row: Record<string, unknown>): RobotRuntime {
  return {
    robotId: String(row.robot_id), x: Number(row.x ?? 0), y: Number(row.y ?? 0), theta: Number(row.theta ?? 0), workState: String(row.work_state),
    fmsControlState: row.fms_control_state === "disabled" ? "disabled" : "enabled",
    connectionState: row.connection_state === "offline" ? "offline" : "online",
    connectionReason: String(row.connection_reason ?? ""), driveState: String(row.drive_state ?? "unknown"),
    driveContextJson: String(row.drive_context_json ?? "{}"), controlEpoch: Number(row.control_epoch ?? 0),
    controlReady: Boolean(row.control_ready), reportedAt: Number(row.reported_at ?? 0),
    stateChangedAt: Number(row.state_changed_at ?? 0), sessionId: String(row.session_id ?? ""),
    navigationMode: String(row.navigation_mode ?? "unknown"), pathPlanningAuthority: String(row.path_planning_authority ?? "unknown"),
  };
}

function rowOccupancy(row: Record<string, unknown>): RuntimeOccupancy {
  return {
    resourceRef: { mapId: String(row.map_id ?? "yard"), kind: (String(row.resource_kind) as "zone" | "node" | "edge"), id: String(row.resource_id), ...(row.step_id ? { stepId: String(row.step_id) } : {}) }, robotId: String(row.robot_id),
    queuePosition: row.queue_position == null ? undefined : Number(row.queue_position),
    state: row.state === "occupied" ? "occupied" : row.state === "queued" ? "queued" : "reserved", requestId: String(row.request_id ?? ""),
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
        navigation_mode TEXT NOT NULL DEFAULT 'unknown', path_planning_authority TEXT NOT NULL DEFAULT 'unknown'
      );
      CREATE TABLE IF NOT EXISTS runtime_occupancies (
        map_id TEXT NOT NULL DEFAULT 'yard', resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, step_id TEXT, robot_id TEXT NOT NULL,
        state TEXT NOT NULL, request_id TEXT NOT NULL DEFAULT '', control_epoch INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, released_at INTEGER,
        release_reason TEXT, released_by TEXT, PRIMARY KEY(resource_kind, resource_id, robot_id)
      );
      CREATE TABLE IF NOT EXISTS runtime_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, robot_id TEXT NOT NULL,
        resource_kind TEXT, resource_id TEXT, request_id TEXT, expected_epoch INTEGER,
        details_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
      );
    `);
    this.additiveMigrations();
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
    ] as const) add("robot_runtime", name, definition);
    add("runtime_occupancies", "map_id", "TEXT NOT NULL DEFAULT 'yard'");
    add("runtime_occupancies", "step_id", "TEXT");
    add("runtime_occupancies", "queue_position", "INTEGER");
  }

  getRobot(robotId: string): RobotRuntime | null {
    const row = this.db.query("SELECT * FROM robot_runtime WHERE robot_id = ?").get(robotId) as Record<string, unknown> | null;
    return row ? rowRuntime(row) : null;
  }

  ensureRobot(robotId: string): RobotRuntime {
    const existing = this.getRobot(robotId);
    if (existing) return existing;
    const value: RobotRuntime = { robotId, workState: "unknown", fmsControlState: "enabled", connectionState: "offline", connectionReason: "never_seen", driveState: "unknown", driveContextJson: "[]", controlEpoch: 0, controlReady: false, reportedAt: 0, stateChangedAt: Date.now(), sessionId: "", navigationMode: "unknown", pathPlanningAuthority: "unknown" };
    this.upsertRobot(value);
    return value;
  }

  listRobots(): RobotRuntime[] { return (this.db.query("SELECT * FROM robot_runtime ORDER BY robot_id").all() as Record<string, unknown>[]).map(rowRuntime); }

  upsertRobot(value: RobotRuntime): void {
    this.db.query(`INSERT INTO robot_runtime (robot_id,x,y,theta,work_state,fms_control_state,connection_state,connection_reason,drive_state,drive_context_json,control_epoch,control_ready,reported_at,state_changed_at,session_id,navigation_mode,path_planning_authority)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(robot_id) DO UPDATE SET x=excluded.x,y=excluded.y,theta=excluded.theta,work_state=excluded.work_state,fms_control_state=excluded.fms_control_state,connection_state=excluded.connection_state,connection_reason=excluded.connection_reason,drive_state=excluded.drive_state,drive_context_json=excluded.drive_context_json,control_epoch=excluded.control_epoch,control_ready=excluded.control_ready,reported_at=excluded.reported_at,state_changed_at=excluded.state_changed_at,session_id=excluded.session_id,navigation_mode=excluded.navigation_mode,path_planning_authority=excluded.path_planning_authority`).run(value.robotId, value.x ?? 0, value.y ?? 0, value.theta ?? 0, value.workState, value.fmsControlState, value.connectionState, value.connectionReason, value.driveState, value.driveContextJson, value.controlEpoch, value.controlReady ? 1 : 0, value.reportedAt, value.stateChangedAt, value.sessionId, value.navigationMode, value.pathPlanningAuthority);
  }

  listOccupancies(includeReleased = false): RuntimeOccupancy[] {
    const sql = includeReleased ? "SELECT * FROM runtime_occupancies ORDER BY created_at" : "SELECT * FROM runtime_occupancies WHERE released_at IS NULL ORDER BY created_at";
    return (this.db.query(sql).all() as Record<string, unknown>[]).map(rowOccupancy);
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
      this.audit({ action: "manual_release_disable", robotId: input.robotId, resourceKind: input.resourceKind, resourceId: input.resourceId, requestId: input.requestId, expectedEpoch: input.expectedEpoch, details: { controlEpoch: epoch, actor: input.releasedBy ?? "", reason: "manual_release" } });
      return { ok: true, message: "released and disabled", controlEpoch: epoch };
    });
    return tx() as { ok: boolean; message: string; controlEpoch?: number };
  }

  audit(value: RuntimeAudit): void {
    this.db.query("INSERT INTO runtime_audit (action,robot_id,resource_kind,resource_id,request_id,expected_epoch,details_json,created_at) VALUES (?,?,?,?,?,?,?,?)").run(value.action, value.robotId, value.resourceKind ?? null, value.resourceId ?? null, value.requestId ?? null, value.expectedEpoch ?? null, JSON.stringify(value.details ?? {}), Date.now());
  }
  close(): void { this.db.close(); }
}
