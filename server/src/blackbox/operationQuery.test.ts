import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BLACKBOX_SCHEMA_VERSION, type BlackboxEvent } from "../../../shared/blackbox.ts";
import { OperationTraceQuery, OperationTraceQueryError } from "./operationQuery.ts";

function day(timeMs: number): string { return new Date(timeMs).toISOString().slice(0, 10); }
function event(input: Partial<BlackboxEvent> & Pick<BlackboxEvent, "eventId" | "timeMs" | "sequence" | "category" | "kind" | "mapId" | "source" | "bootId">): BlackboxEvent {
  return { schemaVersion: BLACKBOX_SCHEMA_VERSION, payload: {}, ...input } as BlackboxEvent;
}

async function indexedFixture(root: string, events: BlackboxEvent[], source = "fms"): Promise<void> {
  const dir = join(root, "streams", day(events[0]!.timeMs), source, events[0]!.bootId);
  await mkdir(dir, { recursive: true });
  let offset = 0;
  const raw: string[] = [], index: string[] = [];
  for (const item of events) {
    const line = JSON.stringify(item) + "\n";
    const length = Buffer.byteLength(line);
    raw.push(line);
    index.push(JSON.stringify({ eventId: item.eventId, timeMs: item.timeMs, sequence: item.sequence, offset, length, mapId: item.mapId, category: item.category, kind: item.kind, operationId: item.operationId, relatedOperationIds: item.payload.relatedOperationIds }) + "\n");
    offset += length;
  }
  await writeFile(join(dir, "segment-000001.events.ndjson"), raw.join(""));
  await writeFile(join(dir, "segment-000001.index.ndjson"), index.join(""));
}

async function legacyFixture(root: string, events: BlackboxEvent[]): Promise<void> {
  const dir = join(root, "streams", day(events[0]!.timeMs), "fms", events[0]!.bootId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "segment-000001.events.ndjson"), events.map(item => JSON.stringify(item)).join("\n") + "\n");
}

async function indexedSegment(root: string, events: BlackboxEvent[], number: number, source = "fms"): Promise<void> {
  const dir = join(root, "streams", day(events[0]!.timeMs), source, events[0]!.bootId);
  await mkdir(dir, { recursive: true });
  let offset = 0;
  const raw: string[] = [], index: string[] = [];
  for (const item of events) {
    const line = JSON.stringify(item) + "\n";
    const length = Buffer.byteLength(line);
    raw.push(line); index.push(JSON.stringify({ eventId: item.eventId, timeMs: item.timeMs, sequence: item.sequence, offset, length, mapId: item.mapId, category: item.category, kind: item.kind, operationId: item.operationId }) + "\n"); offset += length;
  }
  const prefix = `segment-${String(number).padStart(6, "0")}`;
  await writeFile(join(dir, `${prefix}.events.ndjson`), raw.join(""));
  await writeFile(join(dir, `${prefix}.index.ndjson`), index.join(""));
}

test("operation trace uses the bounded index and preserves related operation events", async () => {
  const root = `/tmp/operation-trace-${crypto.randomUUID()}`, now = Date.now();
  await indexedFixture(root, [
    event({ eventId: "unrelated", timeMs: now - 400, sequence: 1, category: "protocol", kind: "grpc.rx", mapId: "yard", source: "robot", bootId: "boot", payload: {} }),
    event({ eventId: "start", timeMs: now - 300, sequence: 2, category: "operation", kind: "move.requested", operationId: "op-1", mapId: "yard", source: "fms", bootId: "boot", payload: {} }),
    event({ eventId: "related", timeMs: now - 200, sequence: 3, category: "protocol", kind: "grpc.rx", mapId: "yard", source: "robot", bootId: "boot", payload: { relatedOperationIds: ["op-1"] } }),
    event({ eventId: "finish", timeMs: now - 100, sequence: 4, category: "error", kind: "move.failed", operationId: "op-1", mapId: "yard", source: "fms", bootId: "boot", payload: {} }),
  ], "fms");
  const result = await new OperationTraceQuery({ root, maxIndexBytes: 10_000 }).query({ operationId: "op-1", mapId: "yard", asOf: now });
  expect(result.events.map(item => item.eventId)).toEqual(["start", "related", "finish"]);
  expect(result.gap).toBe(false);
  expect(result.truncated).toBe(false);
});

test("trace pages carry generation and reject a cursor after reset", async () => {
  const root = `/tmp/operation-trace-cursor-${crypto.randomUUID()}`, now = Date.now();
  await indexedFixture(root, Array.from({ length: 3 }, (_, i) => event({ eventId: `event-${i}`, timeMs: now - 300 + i * 100, sequence: i, category: "operation", kind: "move.progress", operationId: "op", mapId: "yard", source: "fms", bootId: "boot", payload: {} })));
  const query = new OperationTraceQuery({ root });
  const first = await query.query({ operationId: "op", mapId: "yard", asOf: now, limit: 2 });
  expect(first.nextCursor).toBeTruthy();
  await writeFile(join(root, ".generation.json"), JSON.stringify({ id: "new-generation", createdAt: now }) + "\n");
  await expect(query.query({ operationId: "op", mapId: "yard", asOf: now, cursor: first.nextCursor })).rejects.toBeInstanceOf(OperationTraceQueryError);
  await expect(query.query({ operationId: "op", mapId: "yard", asOf: now, cursor: first.nextCursor })).rejects.toMatchObject({ code: "stale_operation_cursor", status: 409 });
});

test("index budget returns an explicit truncated result instead of scanning raw events", async () => {
  const root = `/tmp/operation-trace-budget-${crypto.randomUUID()}`, now = Date.now();
  await indexedFixture(root, [event({ eventId: "old", timeMs: now - 100, sequence: 1, category: "operation", kind: "move.requested", operationId: "op", mapId: "yard", source: "fms", bootId: "boot", payload: { large: "x".repeat(5_000) } })]);
  const result = await new OperationTraceQuery({ root, maxIndexBytes: 2 }).query({ operationId: "op", mapId: "yard", asOf: now });
  expect(result.events).toHaveLength(0);
  expect(result.truncated).toBe(true);
  expect(result.reason).toBe("index_scan_limit");
});

test("legacy event-only segments use a separately bounded raw fallback", async () => {
  const root = `/tmp/operation-trace-legacy-${crypto.randomUUID()}`, now = Date.now();
  await legacyFixture(root, [
    event({ eventId: "start", timeMs: now - 200, sequence: 1, category: "operation", kind: "move.requested", operationId: "operation-1", mapId: "yard", source: "fms", bootId: "boot", payload: {} }),
    event({ eventId: "protocol", timeMs: now - 100, sequence: 2, category: "protocol", kind: "grpc.rx", mapId: "yard", source: "robot", bootId: "boot", payload: { relatedOperationIds: ["operation-1"] } }),
  ]);
  const result = await new OperationTraceQuery({ root, maxRawBytes: 100_000 }).query({ operationId: "operation-1", mapId: "yard", asOf: now });
  expect(result.events.map(item => item.eventId)).toEqual(["start", "protocol"]);
  expect(result.gap).toBe(false);
});

test("cursor pins the initial segment set while newer append changes mtime ordering", async () => {
  const root = `/tmp/operation-trace-pinned-${crypto.randomUUID()}`, now = Date.now();
  const initial = Array.from({ length: 3 }, (_, i) => event({ eventId: `stable-${i}`, timeMs: now - 300 + i * 100, sequence: i, category: "operation", kind: "move.progress", operationId: "op", mapId: "yard", source: "fms", bootId: "boot", payload: {} }));
  await indexedFixture(root, initial);
  const query = new OperationTraceQuery({ root });
  const first = await query.query({ operationId: "op", mapId: "yard", asOf: now, limit: 2 });
  await indexedSegment(root, [event({ eventId: "late-order", timeMs: now - 350, sequence: 0, category: "operation", kind: "move.progress", operationId: "op", mapId: "yard", source: "fms", bootId: "boot", payload: {} })], 2);
  const second = await query.query({ operationId: "op", mapId: "yard", asOf: now, limit: 2, cursor: first.nextCursor });
  expect(first.events.map(item => item.eventId)).toEqual(["stable-0", "stable-1"]);
  expect(second.events.map(item => item.eventId)).toEqual(["stable-2"]);
});
