import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BlackboxQuery } from "./query.ts";
import { Recorder } from "./recorder.ts";
import { BLACKBOX_SCHEMA_VERSION, type BlackboxEvent } from "../../../shared/blackbox.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "robot-console-")); roots.push(root); return { root, query: new BlackboxQuery(root) }; }
async function segment(root: string, events: BlackboxEvent[]) {
  const first = events[0]!;
  const dir = join(root, "streams", new Date(first.timeMs).toISOString().slice(0, 10), first.source, first.bootId);
  await mkdir(dir, { recursive: true });
  let offset = 0;
  const raw: string[] = [], index: string[] = [];
  for (const event of events) {
    const line = JSON.stringify(event) + "\n", length = Buffer.byteLength(line);
    raw.push(line); index.push(JSON.stringify({ ...event, payload: undefined, offset, length }) + "\n"); offset += length;
  }
  const path = join(dir, "segment-000001.events.ndjson");
  await writeFile(path, raw.join("")); await writeFile(path.replace("events.ndjson", "index.ndjson"), index.join(""));
  return path;
}
function event(id: string, timeMs: number, overrides: Partial<BlackboxEvent> = {}): BlackboxEvent {
  return { schemaVersion: BLACKBOX_SCHEMA_VERSION, eventId: id, timeMs, sequence: 1, source: "robot-robot-1", bootId: "boot", mapId: "yard", category: "operation", kind: "command.running", robotId: "robot-1", payload: { level: "info", summary: id }, ...overrides };
}

test("robot console selects robot/map, filters noise and levels, and preserves events without operation IDs", async () => {
  const { root, query } = await fixture(), now = Date.now() - 100;
  await segment(root, [event("a", now), event("b", now + 1, { category: "protocol", kind: "send.pose" }),
    event("c", now + 2, { robotId: "robot-2" }), event("d", now + 3, { mapId: "large_lab" }),
    event("e", now + 4, { category: "error", kind: "connection.error", payload: { level: "error", summary: "operationless error" } })]);
  const page = await query.robotEvents({ mapId: "yard", robotId: "robot-1", limit: 20 });
  expect(page.events.map(e => e.eventId)).toEqual(["a", "e"]);
  const errors = await query.robotEvents({ mapId: "yard", robotId: "robot-1", levels: ["error"] });
  expect(errors.events.map(e => e.eventId)).toEqual(["e"]);
  expect(errors.events[0]!.operationId).toBeUndefined();
});

test("equal-time cursor pages never repeat or omit distinct events", async () => {
  const { root, query } = await fixture(), now = Date.now() - 100;
  await segment(root, [event("a", now), event("b", now), event("c", now)]);
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {
    const page = await query.robotEvents({ mapId: "yard", robotId: "robot-1", limit: 1, cursor });
    seen.push(...page.events.map(e => e.eventId)); cursor = page.nextCursor;
    if (!cursor) break;
  }
  expect(seen.toSorted()).toEqual(["a", "b", "c"]);
});

test("a subsequent query observes newly appended records and masks structured secrets", async () => {
  const { root, query } = await fixture();
  const recorder = new Recorder({ root, source: "robot-robot-1", mapId: "yard" });
  try {
    recorder.record({ category: "operation", kind: "command.accepted", robotId: "robot-1", payload: { level: "info", password: "do-not-publish" } });
    await recorder.flush();
    const first = await query.robotEvents({ mapId: "yard", robotId: "robot-1" });
    expect(first.events).toHaveLength(1);
    expect(first.events[0]!.payload.password).toBe("[REDACTED]");
    recorder.record({ category: "planning", kind: "planner.completed", robotId: "robot-1", payload: { level: "info" } });
    await recorder.flush();
    const next = await query.robotEvents({ mapId: "yard", robotId: "robot-1" });
    expect(next.events.map(e => e.kind)).toContain("planner.completed");
  } finally { await recorder.close(); }
});

test("invalid robot console queries fail explicitly", async () => {
  const { query } = await fixture();
  for (const input of [{ robotId: "" }, { cursor: "not-json" }, { fromMs: 99, toMs: 1 }, { limit: Number.NaN }]) {
    await expect(query.robotEvents({ mapId: "yard", robotId: "robot-1", ...input })).rejects.toThrow();
  }
});

test("history cursor reaches records older than the initial bounded index tail", async () => {
  const { root, query } = await fixture(), now = Date.now() - 10_000;
  const events = Array.from({ length: 1800 }, (_, i) => event(`history-${String(i).padStart(4, "0")}`, now + i, { sequence: i + 1 }));
  await segment(root, events);
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let i = 0; i < 30; i++) {
    const page = await query.robotEvents({ mapId: "yard", robotId: "robot-1", limit: 100, cursor });
    if (i === 0) expect(page.events.at(-1)?.eventId).toBe("history-1799");
    for (const item of page.events) { expect(seen.has(item.eventId)).toBe(false); seen.add(item.eventId); }
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  expect(seen.size).toBe(1800);
});

test("routine-only tail does not hide an older error permanently", async () => {
  const { root, query } = await fixture(), now = Date.now() - 10_000;
  await segment(root, [event("old-error", now, { category: "error", payload: { level: "error" } }),
    ...Array.from({ length: 1800 }, (_, i) => event(`noise-${i}`, now + i + 1, { sequence: i + 2, category: "protocol", kind: "send.pose" }))]);
  let cursor: string | undefined, found = false;
  for (let i = 0; i < 20; i++) {
    const page = await query.robotEvents({ mapId: "yard", robotId: "robot-1", categories: ["error"], cursor, limit: 10 });
    found ||= page.events.some(e => e.eventId === "old-error"); cursor = page.nextCursor;
    if (!cursor) break;
  }
  expect(found).toBe(true);
});

test("history cursors cannot be replayed for another robot or changed filter", async () => {
  const { root, query } = await fixture(), now = Date.now() - 100;
  await segment(root, [event("a", now), event("b", now + 1), event("c", now + 2)]);
  const first = await query.robotEvents({ mapId: "yard", robotId: "robot-1", limit: 1 });
  expect(first.nextCursor).toBeDefined();
  await expect(query.robotEvents({ mapId: "yard", robotId: "robot-2", cursor: first.nextCursor, limit: 1 })).rejects.toThrow();
  await expect(query.robotEvents({ mapId: "yard", robotId: "robot-1", categories: ["error"], cursor: first.nextCursor, limit: 1 })).rejects.toThrow();
});

test("recorder gap markers without robotId are reported for the selected robot stream", async () => {
  const { root, query } = await fixture(), now = Date.now() - 100;
  await segment(root, [event("lost", now, { category: "gap", kind: "recorder.queue_overflow", robotId: undefined, payload: { dropped: 3 } }), event("after-gap", now + 1)]);
  const page = await query.robotEvents({ mapId: "yard", robotId: "robot-1" });
  expect(page.gap).toBe(true);
  expect(page.events.some(e => e.eventId === "after-gap")).toBe(true);
});

test("interleaved FMS and robot stream histories retain every event across tail boundaries", async () => {
  const { root, query } = await fixture(), now = Date.now() - 10_000;
  await segment(root, Array.from({ length: 1400 }, (_, i) => event(`robot-${i}`, now + i * 2, { sequence: i + 1 })));
  await segment(root, Array.from({ length: 1400 }, (_, i) => event(`fms-${i}`, now + i * 2 + 1, { source: "fms", bootId: "fms-boot", sequence: i + 1 })));
  const seen = new Set<string>(); let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await query.robotEvents({ mapId: "yard", robotId: "robot-1", limit: 100, cursor });
    for (const row of page.events) { expect(seen.has(row.eventId)).toBe(false); seen.add(row.eventId); }
    cursor = page.nextCursor; if (!cursor) break;
  }
  expect(seen.size).toBe(2800);
});

test("a newer busy unrelated robot stream cannot hide the selected robot's latest events", async () => {
  const { root, query } = await fixture(), now = Date.now() - 10_000;
  await segment(root, [event("selected-latest", now)]);
  await segment(root, Array.from({ length: 1800 }, (_, i) => event(`other-${i}`, now + i + 1, { robotId: "robot-2", source: "robot-robot-2", sequence: i + 1 })));
  const latest = await query.robotEvents({ mapId: "yard", robotId: "robot-1", limit: 100 });
  expect(latest.events.map(e => e.eventId)).toContain("selected-latest");
});

test("unequal stream time ranges do not lose newer unread events when moving to older byte windows", async () => {
  const { root, query } = await fixture(), now = Date.now() - 20_000;
  await segment(root, Array.from({ length: 3000 }, (_, i) => event(`recent-${i}`, now + 7000 + i, { sequence: i + 1 })));
  await segment(root, Array.from({ length: 3000 }, (_, i) => event(`older-${i}`, now + i, { source: "fms", bootId: "fms-boot", sequence: i + 1 })));
  const seen = new Set<string>(); let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const page = await query.robotEvents({ mapId: "yard", robotId: "robot-1", limit: 100, cursor });
    for (const row of page.events) { expect(seen.has(row.eventId)).toBe(false); seen.add(row.eventId); }
    cursor = page.nextCursor; if (!cursor) break;
  }
  expect(seen.size).toBe(6000);
}, 20_000);

test("append during history pagination cannot shift the pinned byte window and lose older records", async () => {
  const { root, query } = await fixture(), now = Date.now() - 10_000;
  const path = await segment(root, Array.from({ length: 1200 }, (_, i) => event(`pinned-${i}`, now + i, { sequence: i + 1 })));
  const first = await query.robotEvents({ mapId: "yard", robotId: "robot-1", limit: 100 });
  let offset = (await stat(path)).size;
  const raw: string[] = [], index: string[] = [];
  for (let i = 0; i < 2000; i++) {
    const item = event(`appended-${i}`, first.asOf + i + 1, { sequence: 1201 + i });
    const line = JSON.stringify(item) + "\n", length = Buffer.byteLength(line);
    raw.push(line); index.push(JSON.stringify({ ...item, payload: undefined, offset, length }) + "\n"); offset += length;
  }
  await appendFile(path, raw.join("")); await appendFile(path.replace("events.ndjson", "index.ndjson"), index.join(""));
  const seen = new Set(first.events.map(e => e.eventId)); let cursor = first.nextCursor;
  for (let i = 0; i < 30 && cursor; i++) {
    const page = await query.robotEvents({ mapId: "yard", robotId: "robot-1", limit: 100, cursor });
    for (const row of page.events) { expect(row.eventId.startsWith("pinned-")).toBe(true); expect(seen.has(row.eventId)).toBe(false); seen.add(row.eventId); }
    cursor = page.nextCursor;
  }
  expect(seen.size).toBe(1200);
}, 20_000);

test("default telemetry suppression keeps meaningful pose override requests and failures", async () => {
  const { root, query } = await fixture(), now = Date.now() - 100;
  await segment(root, [event("pose", now, { kind: "send.pose", category: "protocol" }),
    event("override", now + 1, { kind: "receive.pose_override", category: "protocol" }),
    event("failure", now + 2, { kind: "error.pose_override", category: "error", payload: { level: "error" } })]);
  const page = await query.robotEvents({ mapId: "yard", robotId: "robot-1" });
  expect(page.events.map(e => e.eventId)).toEqual(["override", "failure"]);
});
