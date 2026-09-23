import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSeed } from "./occupancy.ts";
import { StationKinds } from "./config/index.ts";
import { ACTIVE_MAP, MAP_ID } from './constants.ts';
import {
  DEFAULT_EDGE_CORRIDOR,
  type GraphEdge,
  type GraphNode,
  type Portal,
  type Rail,
  type SceneCharger,
  type SceneObstacle,
  type SceneWaypoint,
  type SemanticSnapshot,
  type VdaStation,
  type ZoneResource,
} from "./semantic.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.FMS_DATA_ROOT ? join(process.env.FMS_DATA_ROOT, ACTIVE_MAP.dataDirectory) : join(here, '../data', ACTIVE_MAP.dataDirectory);
export const SQLITE_PATH = join(DATA_DIR, "editor.sqlite");

const MAP_VERSION = "1";

function now(): number {
  return Date.now();
}

export class EditorStore {
  private db: Database;

  constructor(path = SQLITE_PATH) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS waypoints (
        id TEXT PRIMARY KEY,
        x REAL NOT NULL, y REAL NOT NULL, theta REAL NOT NULL DEFAULT 0,
        name TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chargers (
        id TEXT PRIMARY KEY,
        x REAL NOT NULL, y REAL NOT NULL, theta REAL NOT NULL DEFAULT 0,
        name TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS obstacles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        x REAL NOT NULL, y REAL NOT NULL, theta REAL NOT NULL DEFAULT 0,
        size REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS zones (
        id TEXT PRIMARY KEY,
        family TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        polygon_json TEXT NOT NULL,
        theta REAL NOT NULL DEFAULT 0,
        params_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        x REAL NOT NULL, y REAL NOT NULL, theta REAL NOT NULL DEFAULT 0,
        name TEXT NOT NULL DEFAULT '',
        map_id TEXT NOT NULL DEFAULT '${MAP_ID}',
        allowed_dev_xy REAL,
        allowed_dev_theta REAL,
        actions_json TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        start_node_id TEXT NOT NULL,
        end_node_id TEXT NOT NULL,
        theta REAL NOT NULL DEFAULT 0,
        maximum_speed REAL,
        trajectory_json TEXT NOT NULL DEFAULT '[]',
        corridor_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stations (
        id TEXT PRIMARY KEY,
        x REAL NOT NULL, y REAL NOT NULL, theta REAL NOT NULL DEFAULT 0,
        name TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'other',
        interaction_json TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS portals (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        zone_id TEXT NOT NULL,
        ax REAL NOT NULL, ay REAL NOT NULL,
        bx REAL NOT NULL, by REAL NOT NULL,
        wait_json TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rails (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        zone_id TEXT NOT NULL,
        points_json TEXT NOT NULL,
        theta REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
    // Migrations for databases created before resource names were introduced.
    for (const [table, column] of [["obstacles", "name"], ["portals", "name"], ["rails", "name"]]) {
      const columns = this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!columns.some(c => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
    }
    this.db.exec("UPDATE obstacles SET name=id WHERE name='' OR name IS NULL; UPDATE portals SET name=id WHERE name='' OR name IS NULL; UPDATE rails SET name=id WHERE name='' OR name IS NULL;");
    const seeded = this.db.query("SELECT value FROM meta WHERE key = 'seeded'").get() as { value: string } | null;
    if (!seeded) {
      this.importSeed();
      this.db.query("INSERT INTO meta (key, value) VALUES ('seeded', '1'), ('map_id', ?), ('map_version', ?)").run(MAP_ID, MAP_VERSION);
    }
  }

  close(): void { this.db.close(); }

  private importSeed(): void {
    const seed = loadSeed();
    const t = now();
    const wp = this.db.prepare("INSERT INTO waypoints (id,x,y,theta,name,updated_at) VALUES (?,?,?,?,?,?)");
    const cs = this.db.prepare("INSERT INTO chargers (id,x,y,theta,name,updated_at) VALUES (?,?,?,?,?,?)");
    for (const w of seed.waypoints) wp.run(w.id, w.x, w.y, w.theta, w.id, t);
    for (const c of seed.chargingStations) cs.run(c.id, c.x, c.y, c.theta, c.id, t);
  }

  snapshot(): SemanticSnapshot {
    return {
      mapId: MAP_ID,
      mapVersion: MAP_VERSION,
      waypoints: this.db.query("SELECT id,x,y,theta,name FROM waypoints").all() as SceneWaypoint[],
      chargers: this.db.query("SELECT id,x,y,theta,name FROM chargers").all() as SceneCharger[],
      obstacles: this.db.query("SELECT id,name,kind,x,y,theta,size FROM obstacles").all() as SceneObstacle[],
      zones: (this.db.query("SELECT * FROM zones").all() as Record<string, unknown>[]).map(rowToZone),
      nodes: (this.db.query("SELECT * FROM nodes").all() as Record<string, unknown>[]).map(rowToNode),
      edges: (this.db.query("SELECT * FROM edges").all() as Record<string, unknown>[]).map(rowToEdge),
      stations: (this.db.query("SELECT * FROM stations").all() as Record<string, unknown>[]).map(rowToStation),
      portals: (this.db.query("SELECT * FROM portals").all() as Record<string, unknown>[]).map(rowToPortal),
      rails: (this.db.query("SELECT * FROM rails").all() as Record<string, unknown>[]).map(rowToRail),
    };
  }

  upsertWaypoint(row: SceneWaypoint): void {
    this.db.query(
      `INSERT INTO waypoints (id,x,y,theta,name,updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET x=excluded.x, y=excluded.y, theta=excluded.theta, name=excluded.name, updated_at=excluded.updated_at`,
    ).run(row.id, row.x, row.y, row.theta, row.name ?? "", now());
  }

  upsertCharger(row: SceneCharger): void {
    this.db.query(
      `INSERT INTO chargers (id,x,y,theta,name,updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET x=excluded.x, y=excluded.y, theta=excluded.theta, name=excluded.name, updated_at=excluded.updated_at`,
    ).run(row.id, row.x, row.y, row.theta, row.name ?? "", now());
  }

  upsertObstacle(row: SceneObstacle): void {
    this.db.query(
      `INSERT INTO obstacles (id,name,kind,x,y,theta,size,updated_at) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, x=excluded.x, y=excluded.y, theta=excluded.theta, size=excluded.size, updated_at=excluded.updated_at`,
    ).run(row.id, row.name ?? row.id, row.kind, row.x, row.y, row.theta, row.size, now());
  }

  upsertZone(row: ZoneResource): void {
    const params = {
      factor: row.factor,
      maximumSpeed: row.maximumSpeed,
      capacity: row.capacity,
      direction: row.direction,
      directedLimitation: row.directedLimitation,
      releaseLossBehavior: row.releaseLossBehavior,
    };
    this.db.query(
      `INSERT INTO zones (id,family,kind,name,polygon_json,theta,params_json,updated_at) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET family=excluded.family, kind=excluded.kind, name=excluded.name, polygon_json=excluded.polygon_json, theta=excluded.theta, params_json=excluded.params_json, updated_at=excluded.updated_at`,
    ).run(row.id, row.family, row.kind, row.name, JSON.stringify(row.polygon), row.theta, JSON.stringify(params), now());
  }

  upsertNode(row: GraphNode): void {
    this.db.query(
      `INSERT INTO nodes (id,x,y,theta,name,map_id,allowed_dev_xy,allowed_dev_theta,actions_json,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET x=excluded.x, y=excluded.y, theta=excluded.theta, name=excluded.name, map_id=excluded.map_id, allowed_dev_xy=excluded.allowed_dev_xy, allowed_dev_theta=excluded.allowed_dev_theta, actions_json=excluded.actions_json, updated_at=excluded.updated_at`,
    ).run(
      row.id,
      row.x,
      row.y,
      row.theta,
      row.name,
      row.mapId,
      row.allowedDeviationXY ?? null,
      row.allowedDeviationTheta ?? null,
      JSON.stringify(row.actions ?? []),
      now(),
    );
  }

  upsertEdge(row: GraphEdge): void {
    this.db.query(
      `INSERT INTO edges (id,name,start_node_id,end_node_id,theta,maximum_speed,trajectory_json,corridor_json,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, start_node_id=excluded.start_node_id, end_node_id=excluded.end_node_id, theta=excluded.theta, maximum_speed=excluded.maximum_speed, trajectory_json=excluded.trajectory_json, corridor_json=excluded.corridor_json, updated_at=excluded.updated_at`,
    ).run(
      row.id,
      row.name,
      row.startNodeId,
      row.endNodeId,
      row.theta,
      row.maximumSpeed ?? null,
      JSON.stringify(row.trajectory ?? []),
      JSON.stringify(row.corridor ?? DEFAULT_EDGE_CORRIDOR),
      now(),
    );
  }

  upsertStation(row: VdaStation): void {
    this.db.query(
      `INSERT INTO stations (id,x,y,theta,name,kind,interaction_json,updated_at) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET x=excluded.x, y=excluded.y, theta=excluded.theta, name=excluded.name, kind=excluded.kind, interaction_json=excluded.interaction_json, updated_at=excluded.updated_at`,
    ).run(row.id, row.x, row.y, row.theta, row.name, row.kind, JSON.stringify(row.interactionNodeIds ?? []), now());
  }

  upsertPortal(row: Portal): void {
    this.db.query(
      `INSERT INTO portals (id,name,zone_id,ax,ay,bx,by,wait_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, zone_id=excluded.zone_id, ax=excluded.ax, ay=excluded.ay, bx=excluded.bx, by=excluded.by, wait_json=excluded.wait_json, updated_at=excluded.updated_at`,
    ).run(row.id, row.name ?? row.id, row.zoneId, row.a.x, row.a.y, row.b.x, row.b.y, row.waitPose ? JSON.stringify(row.waitPose) : null, now());
  }

  upsertRail(row: Rail): void {
    this.db.query(
      `INSERT INTO rails (id,name,zone_id,points_json,theta,updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, zone_id=excluded.zone_id, points_json=excluded.points_json, theta=excluded.theta, updated_at=excluded.updated_at`,
    ).run(row.id, row.name ?? row.id, row.zoneId, JSON.stringify(row.points), row.theta, now());
  }

  delete(table: string, id: string): void {
    const allowed = new Set(["waypoints", "chargers", "obstacles", "zones", "nodes", "edges", "stations", "portals", "rails"]);
    if (!allowed.has(table)) throw new Error(`bad table ${table}`);
    this.db.query(`DELETE FROM ${table} WHERE id = ?`).run(id);
  }
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToZone(r: Record<string, unknown>): ZoneResource {
  const params = parseJson<Partial<ZoneResource>>(r.params_json, {});
  return {
    id: String(r.id),
    family: r.family === "vda" ? "vda" : "scene",
    kind: r.kind as ZoneResource["kind"],
    name: String(r.name ?? r.id),
    polygon: parseJson(r.polygon_json, []),
    theta: Number(r.theta) || 0,
    ...params,
  };
}

function rowToNode(r: Record<string, unknown>): GraphNode {
  return {
    id: String(r.id),
    x: Number(r.x),
    y: Number(r.y),
    theta: Number(r.theta) || 0,
    name: String(r.name ?? r.id),
    mapId: String(r.map_id ?? MAP_ID),
    allowedDeviationXY: r.allowed_dev_xy == null ? undefined : Number(r.allowed_dev_xy),
    allowedDeviationTheta: r.allowed_dev_theta == null ? undefined : Number(r.allowed_dev_theta),
    actions: parseJson(r.actions_json, []),
  };
}

function rowToEdge(r: Record<string, unknown>): GraphEdge {
  return {
    id: String(r.id),
    name: String(r.name ?? ""),
    startNodeId: String(r.start_node_id),
    endNodeId: String(r.end_node_id),
    theta: Number(r.theta) || 0,
    maximumSpeed: r.maximum_speed == null ? undefined : Number(r.maximum_speed),
    trajectory: parseJson(r.trajectory_json, []),
    corridor: parseJson(r.corridor_json, DEFAULT_EDGE_CORRIDOR),
  };
}

function rowToStation(r: Record<string, unknown>): VdaStation {
  return {
    id: String(r.id),
    x: Number(r.x),
    y: Number(r.y),
    theta: Number(r.theta) || 0,
    name: String(r.name ?? ""),
    kind: StationKinds.is(r.kind) ? r.kind : StationKinds.code.other,
    interactionNodeIds: parseJson(r.interaction_json, []),
  };
}

function rowToPortal(r: Record<string, unknown>): Portal {
  return {
    id: String(r.id), name: String(r.name ?? r.id),
    zoneId: String(r.zone_id),
    a: { x: Number(r.ax), y: Number(r.ay) },
    b: { x: Number(r.bx), y: Number(r.by) },
    waitPose: parseJson(r.wait_json, undefined),
  };
}

function rowToRail(r: Record<string, unknown>): Rail {
  return {
    id: String(r.id), name: String(r.name ?? r.id),
    zoneId: String(r.zone_id),
    points: parseJson(r.points_json, []),
    theta: Number(r.theta) || 0,
  };
}

let singleton: EditorStore | null = null;
export function editorStore(): EditorStore {
  singleton ??= new EditorStore();
  return singleton;
}
