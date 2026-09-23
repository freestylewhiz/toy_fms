import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BlackboxHttpError, BlackboxQuery } from "./query.ts";
import { BLACKBOX_SCHEMA_VERSION, type BlackboxEvent } from "../../../shared/blackbox.ts";

function event(input: Partial<BlackboxEvent> & Pick<BlackboxEvent, "eventId" | "timeMs" | "sequence" | "category" | "kind" | "mapId" | "source" | "bootId">): BlackboxEvent {
  return { schemaVersion: BLACKBOX_SCHEMA_VERSION, payload: {}, ...input } as BlackboxEvent;
}

function utcDay(timeMs: number): string {
  return new Date(timeMs).toISOString().slice(0, 10);
}

async function writeIndexed(root: string, source: string, bootId: string, events: BlackboxEvent[]): Promise<void> {
  const stream = join(root, "streams", utcDay(events[0]!.timeMs), source, bootId);
  await mkdir(stream, { recursive: true });
  let offset = 0;
  const lines: string[] = [], indexes: string[] = [];
  for (const item of events) {
    const line = JSON.stringify(item) + "\n";
    const length = Buffer.byteLength(line);
    lines.push(line);
    indexes.push(JSON.stringify({ eventId: item.eventId, timeMs: item.timeMs, sequence: item.sequence, offset, length, mapId: item.mapId, category: item.category, kind: item.kind, operationId: item.operationId, relatedOperationIds: item.payload.relatedOperationIds }) + "\n");
    offset += length;
  }
  await writeFile(join(stream, "segment-000001.events.ndjson"), lines.join(""));
  await writeFile(join(stream, "segment-000001.index.ndjson"), indexes.join(""));
}

async function historicalAssets(root: string, hash = "c".repeat(64)) {
  const dir = join(root, "assets", hash);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "map.png"), "map");
  await writeFile(join(dir, "occupancy.bin"), "occupancy");
  await writeFile(join(dir, "inflated.bin"), "inflated");
  return { mapUrl: `/api/blackbox/assets/${hash}/map.png`, occupancyUrl: `/api/blackbox/assets/${hash}/occupancy.bin`, inflatedUrl: `/api/blackbox/assets/${hash}/inflated.bin`, width: 2, height: 2, pixelCm: 5 };
}

async function fixture(): Promise<{ root: string; query: BlackboxQuery; start: BlackboxEvent; end: BlackboxEvent }> {
  const root = `/tmp/blackbox-query-${crypto.randomUUID()}`;
  const now = Date.now();
  const stream = join(root, "streams", utcDay(now), "fms", "boot-1");
  await mkdir(stream, { recursive: true });
  const assetHash = "b".repeat(64);
  const assetDir = join(root, "assets", assetHash);
  await mkdir(assetDir, { recursive: true });
  await writeFile(join(assetDir, "map.png"), "map");
  await writeFile(join(assetDir, "occupancy.bin"), "occupancy");
  await writeFile(join(assetDir, "inflated.bin"), "inflated");
  const assets = { mapUrl: `/api/blackbox/assets/${assetHash}/map.png`, occupancyUrl: `/api/blackbox/assets/${assetHash}/occupancy.bin`, inflatedUrl: `/api/blackbox/assets/${assetHash}/inflated.bin`, width: 2, height: 2, pixelCm: 5 };
  const checkpoint = event({ eventId: "frame-1", timeMs: now - 10_000, sequence: 1, category: "frame", kind: "scene.snapshot", mapId: "yard", source: "fms", bootId: "boot-1", payload: { state: { robots: [] }, assets } });
  const start = event({ eventId: "op-1", timeMs: now - 5_000, sequence: 2, category: "operation", kind: "move.requested", operationId: "operation-1", mapId: "yard", source: "fms", bootId: "boot-1", payload: {} });
  const intermediate = event({ eventId: "frame-2", timeMs: now - 4_000, sequence: 3, category: "frame", kind: "scene.snapshot", mapId: "yard", source: "fms", bootId: "boot-1", payload: { state: { robots: [{ id: "robot-1" }] }, assets } });
  const raw = event({ eventId: "proto-1", timeMs: now - 3_500, sequence: 4, category: "protocol", kind: "grpc.rx", operationId: "operation-1", mapId: "yard", source: "robot-1", bootId: "robot-boot", payload: {} });
  const gap = event({ eventId: "gap-1", timeMs: now - 3_000, sequence: 5, category: "gap", kind: "recorder.queue_overflow", mapId: "yard", source: "fms", bootId: "boot-1", payload: { dropped: 2, detail: "test gap" } });
  const end = event({ eventId: "err-1", timeMs: now - 2_000, sequence: 6, category: "error", kind: "drive.failed", operationId: "operation-1", mapId: "yard", source: "fms", bootId: "boot-1", payload: {} });
  await writeFile(join(stream, "segment-000001.events.ndjson"), [checkpoint, start, intermediate, raw, gap, end].map((item) => JSON.stringify(item)).join("\n") + "\n");
  return { root, query: new BlackboxQuery(root), start, end };
}

test("meaningful events are recent, map-scoped, stable, and exclude raw protocol/frame events", async () => {
  const fixtureData = await fixture();
  const result = await fixtureData.query.listMeaningful({ mapId: "yard", asOf: Date.now() });
  expect(result.events.map((item) => item.eventId)).toEqual(["op-1", "err-1"]);
  expect((await fixtureData.query.operation("operation-1")).events.map((item) => item.eventId)).toEqual(["op-1", "proto-1", "err-1"]);
});

test("replay uses only authoritative FMS checkpoints and returns intermediate scene events plus gaps", async () => {
  const fixtureData = await fixture();
  const result = await fixtureData.query.replay({ mapId: "yard", startEventId: fixtureData.start.eventId, endEventId: fixtureData.end.eventId, asOf: Date.now() });
  expect(result.checkpoint.eventId).toBe("frame-1");
  expect(result.events.map((item) => item.eventId)).toEqual(["op-1", "frame-2", "gap-1", "err-1"]);
  expect(result.events.some((item) => item.category === "protocol")).toBe(false);
  expect(result.gaps.some((gap) => gap.kind === "recorder.queue_overflow")).toBe(true);
});

test("replay rejects reverse ranges and missing historical checkpoints/assets", async () => {
  const fixtureData = await fixture();
  await expect(fixtureData.query.replay({ mapId: "yard", startEventId: fixtureData.end.eventId, endEventId: fixtureData.start.eventId })).rejects.toMatchObject({ code: "reverse_range" });
  const root = `/tmp/blackbox-query-missing-${crypto.randomUUID()}`;
  const now = Date.now();
  const stream = join(root, "streams", utcDay(now), "fms", "boot");
  await mkdir(stream, { recursive: true });
  const frame = event({ eventId: "frame", timeMs: now - 1_000, sequence: 1, category: "frame", kind: "scene.snapshot", mapId: "yard", source: "fms", bootId: "boot", payload: { state: {}, assets: { mapUrl: `/api/blackbox/assets/${"a".repeat(64)}/map.png`, width: 1, height: 1, pixelCm: 5 } } });
  const op = event({ eventId: "operation", timeMs: now - 500, sequence: 2, category: "operation", kind: "move.requested", mapId: "yard", source: "fms", bootId: "boot", payload: {} });
  await writeFile(join(stream, "segment-000001.events.ndjson"), `${JSON.stringify(frame)}\n${JSON.stringify(op)}\n`);
  await expect(new BlackboxQuery(root).replay({ mapId: "yard", startEventId: op.eventId, endEventId: op.eventId })).rejects.toMatchObject({ code: "historical_asset_unavailable" });
});

test("truncated tail is surfaced as a gap instead of being silently accepted", async () => {
  const root = `/tmp/blackbox-query-tail-${crypto.randomUUID()}`;
  const now = Date.now();
  const stream = join(root, "streams", utcDay(now), "fms", "boot");
  await mkdir(stream, { recursive: true });
  const item = event({ eventId: "op", timeMs: now - 100, sequence: 1, category: "operation", kind: "move.requested", mapId: "yard", source: "fms", bootId: "boot", payload: {} });
  await writeFile(join(stream, "segment-000001.events.ndjson"), JSON.stringify(item) + "\n{\"broken\"");
  const result = await new BlackboxQuery(root).listMeaningful({ mapId: "yard" });
  expect(result.events).toHaveLength(1);
});

test("missing-index fallback reports an explicit scan limit instead of partial results", async () => {
  const fixtureData = await fixture();
  await expect(new BlackboxQuery(fixtureData.root, { maxScanBytes: 1 }).listMeaningful({ mapId: "yard" })).rejects.toMatchObject({ code: "scan_limit_exceeded" });
});

test("indexed recent query reads selected payloads without scanning unrelated raw protocol", async () => {
  const root = `/tmp/blackbox-query-indexed-large-${crypto.randomUUID()}`;
  const now = Date.now();
  const selected = event({ eventId: "selected", timeMs: now - 500, sequence: 1, category: "operation", kind: "move.requested", operationId: "op", mapId: "yard", source: "fms", bootId: "boot", payload: {} });
  const unrelated = event({ eventId: "raw-large", timeMs: now - 400, sequence: 2, category: "protocol", kind: "grpc.rx", mapId: "yard", source: "robot-1", bootId: "robot", payload: { raw: "x".repeat(200_000) } });
  await writeIndexed(root, "fms", "boot", [selected, unrelated]);
  const result = await new BlackboxQuery(root, { maxScanBytes: 2_000, maxIndexScanBytes: 100_000 }).listMeaningful({ mapId: "yard" });
  expect(result.events.map((item) => item.eventId)).toEqual(["selected"]);
});

test("checkpoint index keeps only the latest frame and does not consume retained-event budget", async () => {
  const root = `/tmp/blackbox-query-checkpoint-budget-${crypto.randomUUID()}`;
  const now = Date.now();
  const assets = await historicalAssets(root);
  const frames = Array.from({ length: 8 }, (_, index) => event({ eventId: `frame-${index}`, timeMs: now - 8_000 + index * 500, sequence: index + 1, category: "frame", kind: "scene.snapshot", mapId: "yard", source: "fms", bootId: "boot", payload: { state: { index }, assets } }));
  const operation = event({ eventId: "checkpoint-op", timeMs: now - 300, sequence: 20, category: "operation", kind: "move.requested", operationId: "checkpoint-op", mapId: "yard", source: "fms", bootId: "boot", payload: {} });
  await writeIndexed(root, "fms", "boot", [...frames, operation]);
  const result = await new BlackboxQuery(root, { maxRetainedEvents: 1 }).replay({ mapId: "yard", startEventId: operation.eventId, endEventId: operation.eventId });
  expect(result.checkpoint.eventId).toBe("frame-7");
});

test("same-millisecond checkpoint after the start sequence is excluded", async () => {
  const root = `/tmp/blackbox-query-same-ms-${crypto.randomUUID()}`;
  const now = Date.now();
  const start = event({ eventId: "same-start", timeMs: now - 500, sequence: 1, category: "operation", kind: "move.requested", operationId: "same-op", mapId: "yard", source: "fms", bootId: "boot", payload: {} });
  const futureFrame = event({ eventId: "same-future-frame", timeMs: start.timeMs, sequence: 2, category: "frame", kind: "scene.snapshot", mapId: "yard", source: "fms", bootId: "boot", payload: { state: {} } });
  const end = event({ eventId: "same-end", timeMs: now - 100, sequence: 3, category: "error", kind: "drive.failed", operationId: "same-op", mapId: "yard", source: "fms", bootId: "boot", payload: {} });
  await writeIndexed(root, "fms", "boot", [start, futureFrame, end]);
  await expect(new BlackboxQuery(root).replay({ mapId: "yard", startEventId: start.eventId, endEventId: end.eventId })).rejects.toMatchObject({ code: "checkpoint_unavailable" });
});

test("indexed replay rejects aggregate payloads before allocating them", async () => {
  const root = `/tmp/blackbox-query-payload-limit-${crypto.randomUUID()}`;
  const now = Date.now();
  const assets = await historicalAssets(root, "d".repeat(64));
  const checkpoint = event({ eventId: "payload-frame-0", timeMs: now - 3_000, sequence: 1, category: "frame", kind: "scene.snapshot", mapId: "yard", source: "fms", bootId: "boot", payload: { state: {}, assets } });
  const start = event({ eventId: "payload-start", timeMs: now - 2_000, sequence: 2, category: "operation", kind: "move.requested", operationId: "payload-op", mapId: "yard", source: "fms", bootId: "boot", payload: {} });
  const largeFrame = event({ eventId: "payload-frame-1", timeMs: now - 1_500, sequence: 3, category: "frame", kind: "scene.snapshot", mapId: "yard", source: "fms", bootId: "boot", payload: { state: { raw: "x".repeat(10_000) }, assets } });
  const end = event({ eventId: "payload-end", timeMs: now - 1_000, sequence: 4, category: "error", kind: "drive.failed", operationId: "payload-op", mapId: "yard", source: "fms", bootId: "boot", payload: {} });
  await writeIndexed(root, "fms", "boot", [checkpoint, start, largeFrame, end]);
  await expect(new BlackboxQuery(root, { maxScanBytes: 2_000 }).replay({ mapId: "yard", startEventId: start.eventId, endEventId: end.eventId })).rejects.toMatchObject({ code: "result_payload_limit_exceeded" });
});
