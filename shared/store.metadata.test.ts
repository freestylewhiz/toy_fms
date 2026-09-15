import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { EditorStore } from "./store.ts";
import { newResourceId } from "../server/src/editorHandlers.ts";

describe("resource metadata persistence", () => {
  test("preserves names and editable geometry for obstacle, portal and rail", () => {
    const path = `/tmp/editor-metadata-${crypto.randomUUID()}.sqlite`;
    const store = new EditorStore(path);
    store.upsertObstacle({ id: "ob-old", name: "Safety wall", kind: "square", x: 4, y: 5, theta: 0.5, size: 12 });
    store.upsertPortal({ id: "portal-old", name: "North gate", zoneId: "prefer-old", a: { x: 1, y: 2 }, b: { x: 3, y: 4 }, waitPose: { x: 2, y: 3, theta: 1.2 } });
    store.upsertRail({ id: "rail-old", name: "Main rail", zoneId: "corridor-old", points: [{ x: 0, y: 0 }, { x: 8, y: 1 }], theta: 0.25 });
    store.close();
    const reopened = new EditorStore(path);
    const snap = reopened.snapshot();
    expect(snap.obstacles[0]).toMatchObject({ id: "ob-old", name: "Safety wall", size: 12 });
    expect(snap.portals[0]).toMatchObject({ id: "portal-old", name: "North gate", waitPose: { x: 2, y: 3, theta: 1.2 } });
    expect(snap.rails[0]).toMatchObject({ id: "rail-old", name: "Main rail", theta: 0.25 });
    reopened.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  });

  test("upgrades an existing unnamed obstacle without changing its ID or geometry", () => {
    const path = `/tmp/editor-legacy-${crypto.randomUUID()}.sqlite`;
    const legacy = new Database(path);
    legacy.exec("CREATE TABLE obstacles (id TEXT PRIMARY KEY, kind TEXT, x REAL, y REAL, theta REAL, size REAL, updated_at INTEGER)");
    legacy.query("INSERT INTO obstacles VALUES (?, ?, ?, ?, ?, ?, ?)").run('ob-7', 'circle', 100, 200, 0.75, 22, 1);
    legacy.close();
    const store = new EditorStore(path);
    try {
      expect(store.snapshot().obstacles).toContainEqual({ id: 'ob-7', name: 'ob-7', kind: 'circle', x: 100, y: 200, theta: 0.75, size: 22 });
      store.upsertObstacle({ id: 'ob-7', name: 'Renamed circle', kind: 'circle', x: 100, y: 200, theta: 0.75, size: 30 });
      expect(store.snapshot().obstacles).toHaveLength(1);
      expect(store.snapshot().obstacles[0]).toMatchObject({ id: 'ob-7', name: 'Renamed circle', size: 30 });
    } finally {
      store.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });

  test("new IDs are prefixed UUIDs and do not reuse the old ID", () => {
    const first = newResourceId("wp");
    const second = newResourceId("wp");
    expect(first).toMatch(/^wp-[0-9a-f-]{36}$/);
    expect(second).toMatch(/^wp-[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });
});
