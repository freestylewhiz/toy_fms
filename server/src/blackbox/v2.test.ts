import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlackboxQuery } from "./query.ts";
import type { BlackboxEvent } from "../../../shared/blackbox.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "blackbox-v2-query-")); roots.push(root);
  const hash = "b".repeat(64), dir = join(root, "assets", hash);
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, "map.png"), "historical-png");
  return { root, assets: { mapUrl: `/api/blackbox/assets/${hash}/map.png`, width: 10000, height: 10000, pixelCm: 5 } };
}
function event(id: string, timeMs: number, source = "fms-yard", mapId = "yard", category: BlackboxEvent["category"] = "frame", payload: Record<string, unknown> = {}): BlackboxEvent {
  return { schemaVersion: 1, eventId: id, timeMs, sequence: timeMs, source, bootId: "boot", mapId, category, kind: category === "frame" ? "scene.snapshot" : "command.changed", payload };
}
async function writer(root: string, source: string, events: BlackboxEvent[], boot = "boot") {
  const dir = join(root, "streams", new Date(events[0]!.timeMs).toISOString().slice(0, 10), source, boot);
  await mkdir(dir, { recursive: true }); let offset = 0;
  const append = async (values: BlackboxEvent[]) => {
    const lines: string[] = [], indexes: string[] = [];
    for (const item of values) {
      const line = JSON.stringify(item) + "\n", length = Buffer.byteLength(line);
      lines.push(line); indexes.push(JSON.stringify({ eventId: item.eventId, timeMs: item.timeMs, sequence: item.sequence, offset, length, mapId: item.mapId, category: item.category, kind: item.kind }) + "\n"); offset += length;
    }
    await appendFile(join(dir, "segment-000001.events.ndjson"), lines.join(""));
    await appendFile(join(dir, "segment-000001.index.ndjson"), indexes.join(""));
  };
  await append(events); return append;
}

test("v2 catalog opens a map with only authoritative frames and no meaningful operation", async () => {
  const { root, assets } = await fixture(), now = Date.now() - 1000;
  await writer(root, "fms-yard", [event("checkpoint", now, "fms-yard", "yard", "frame", { state: { robots: [{ id: "robot-1", x: 7 }] }, assets })]);
  await writer(root, "robot-robot-1", [event("robot-frame", now + 1, "robot-robot-1", "yard", "frame", { state: { robots: [{ id: "robot-1", x: 999 }] }, assets })]);
  const catalog = await new BlackboxQuery(root).catalog({ mapId: "yard" });
  expect(catalog.latestCheckpoint?.eventId).toBe("checkpoint"); expect(catalog.assets?.width).toBe(10000);
  expect(catalog.availableTo).toBeGreaterThanOrEqual(now);
});

test("v2 replay can select an older range inside a large current-day index", async () => {
  const { root, assets } = await fixture(), start = Date.now() - 1_000_000;
  const frames = Array.from({ length: 5000 }, (_, i) => event(`f-${i}`, start + i * 100, "fms-yard", "yard", "frame", { state: { robots: [{ id: "robot-1", x: i }] }, assets }));
  await writer(root, "fms-yard", frames);
  const result = await new BlackboxQuery(root).window({ mapId: "yard", fromMs: start + 1000, toMs: start + 2000, asOf: start + 500_000, limit: 100 });
  expect(result.checkpoint.timeMs).toBeLessThanOrEqual(start + 1000);
  expect(result.events.map(item => item.eventId)).toContain("f-20");
  expect(result.events.every(item => item.timeMs >= start + 1000 && item.timeMs <= start + 2000)).toBe(true);
});

test("v2 replay pages are stable while a large newer tail is appended", async () => {
  const { root, assets } = await fixture(), start = Date.now() - 100_000;
  const values = Array.from({ length: 600 }, (_, i) => event(`f-${i}`, start + i * 100, "fms-yard", "yard", "frame", { state: { robots: [{ id: "robot-1", x: i }] }, assets }));
  const append = await writer(root, "fms-yard", values), query = new BlackboxQuery(root);
  const input = { mapId: "yard", fromMs: start + 100, toMs: start + 59_900, asOf: start + 59_900, limit: 40 };
  let page = await query.window(input); const ids = page.events.map(item => item.eventId);
  expect(page.nextCursor).toBeDefined();
  await append(Array.from({ length: 4000 }, (_, i) => event(`new-${i}`, start + 60_000 + i, "fms-yard", "yard", "operation")));
  for (let i = 0; page.nextCursor && i < 100; i++) {
    page = await query.window({ ...input, cursor: page.nextCursor }); ids.push(...page.events.map(item => item.eventId));
  }
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual(values.slice(1).map(item => item.eventId));
});

test("v2 time window rejects reversed ranges and never replaces missing recorded maps", async () => {
  const { root, assets } = await fixture(), now = Date.now() - 1000;
  await writer(root, "fms-yard", [event("checkpoint", now, "fms-yard", "yard", "frame", { state: {}, assets })]);
  const query = new BlackboxQuery(root);
  await expect(query.window({ mapId: "yard", fromMs: now + 10, toMs: now })).rejects.toMatchObject({ code: "invalid_time_range" });
  await rm(join(root, "assets"), { recursive: true });
  await expect(query.window({ mapId: "yard", fromMs: now, toMs: now })).rejects.toMatchObject({ code: "historical_asset_unavailable" });
});


test("v2 replay cursor refuses a reset and cannot cross maps or time ranges", async () => {
  const { root, assets } = await fixture(), start = Date.now() - 10_000;
  await writer(root, "fms-yard", Array.from({ length: 10 }, (_, i) => event(`f-${i}`, start + i * 100, "fms-yard", "yard", "frame", { state: {}, assets })));
  const query = new BlackboxQuery(root), input = { mapId: "yard", fromMs: start, toMs: start + 900, asOf: start + 900, limit: 2 };
  const page = await query.window(input); expect(page.nextCursor).toBeDefined();
  await expect(query.window({ ...input, fromMs: start + 1, cursor: page.nextCursor })).rejects.toMatchObject({ code: "cursor_query_mismatch" });
  await expect(query.window({ ...input, mapId: "large_lab", cursor: page.nextCursor })).rejects.toMatchObject({ code: "stale_cursor" });
  await writeFile(join(root, ".generation.json"), JSON.stringify({ id: "reset-new-generation", createdAt: Date.now() }));
  await expect(query.window({ ...input, cursor: page.nextCursor })).rejects.toMatchObject({ code: "stale_cursor" });
});


test("v2 an older same-day boot is searchable behind several newer large indexes", async () => {
  const { root, assets } = await fixture(), start = Date.now() - 8_000_000;
  for (let boot = 0; boot < 7; boot++) {
    const values = Array.from({ length: 5000 }, (_, i) => ({ ...event(`b${boot}-f${i}`, start + boot * 1_000_000 + i * 100, "fms-yard", "yard", "frame", { state: { robots: [{ id: "robot-1", x: i }] }, assets }), bootId: `boot-${boot}` }));
    await writer(root, "fms-yard", values, `boot-${boot}`);
  }
  const result = await new BlackboxQuery(root).window({ mapId: "yard", fromMs: start + 1000, toMs: start + 2000, asOf: Date.now(), limit: 100 });
  expect(result.events.map(item => item.eventId)).toContain("b0-f20");
  expect(result.checkpoint.timeMs).toBeLessThanOrEqual(start + 1000);
});


test("v2 time lookup seeks into a segment larger than the per-query index budget", async () => {
  const { root, assets } = await fixture(), start = Date.now() - 3_000_000;
  const values = Array.from({ length: 20_000 }, (_, i) => event(`large-${i}`, start + i * 100, "fms-yard", "yard", "frame", { state: { robots: [{ id: "robot-1", x: i }] }, assets }));
  values.splice(21, 0,
    { ...event("end-tie-1", start + 2000, "fms-yard", "yard", "frame", { state: { robots: [{ id: "robot-1", x: 21 }] }, assets }), sequence: start + 2001 },
    { ...event("end-tie-2", start + 2000, "fms-yard", "yard", "frame", { state: { robots: [{ id: "robot-1", x: 22 }] }, assets }), sequence: start + 2002 });
  await writer(root, "fms-yard", values);
  const query = new BlackboxQuery(root, { maxIndexScanBytes: 256 * 1024 });
  const page = await query.window({ mapId: "yard", fromMs: start + 1000, toMs: start + 2000, asOf: Date.now(), limit: 100 });
  expect(page.events.map(item => item.eventId)).toContain("large-20");
  expect(page.events.map(item => item.eventId)).toContain("end-tie-1");
  expect(page.events.map(item => item.eventId)).toContain("end-tie-2");
  expect(page.checkpoint.timeMs).toBeLessThanOrEqual(start + 1000);
});
