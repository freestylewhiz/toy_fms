import { QUERY_LIMIT_REASONS } from "../../../shared/config/reasons.ts";
import { BLACKBOX_ERRORS } from "../../../shared/config/reasons.ts";
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { readGeneration } from "./generation.ts";
import type { BlackboxEvent, BlackboxOperationQuery } from "../../../shared/blackbox.ts";

/**
 * The operation endpoint used to scan every event segment.  This module keeps
 * the query independent from the general replay query and reads only the
 * bounded index window needed to find a recent operation trace.
 */
export type OperationTraceQueryOptions = {
  root: string;
  maxIndexBytes?: number;
  maxIndexLines?: number;
  maxSegments?: number;
  maxEvents?: number;
  maxEventBytes?: number;
  maxRawBytes?: number;
  maxRawLines?: number;
};

export type OperationTraceInput = {
  operationId: string;
  mapId?: string;
  fromMs?: number;
  toMs?: number;
  asOf?: number;
  cursor?: string;
  limit?: number;
};

export type OperationTraceResult = BlackboxOperationQuery & {
  generation: string;
  gap: boolean;
  truncated: boolean;
  /** A stable reason lets the HTTP layer explain bounded partial results. */
  reason?: (typeof QUERY_LIMIT_REASONS.values)[number];
  missingEvents?: number;
};

export class OperationTraceQueryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "OperationTraceQueryError";
  }
}

type IndexRef = {
  eventId: string;
  timeMs: number;
  sequence: number;
  source: string;
  bootId: string;
  mapId: string;
  operationId?: string;
  relatedOperationIds?: string[];
  offset: number;
  length: number;
  eventsPath: string;
};

type Cursor = {
  generation: string;
  operationId: string;
  mapId: string;
  fromMs?: number;
  toMs?: number;
  asOf: number;
  offset: number;
  legacy?: boolean;
  segments?: Array<{ path: string; size: number; mtimeMs: number }>;
};

type Segment = { indexPath: string; eventsPath: string; mtimeMs: number; size: number };

function compare(a: { timeMs: number; sequence: number; eventId: string }, b: { timeMs: number; sequence: number; eventId: string }): number {
  return a.timeMs - b.timeMs || a.sequence - b.sequence || a.eventId.localeCompare(b.eventId);
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): Cursor | undefined {
  if (!value) return undefined;
  try {
    const item = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    const offset = Number(item.offset);
    if (typeof item.generation !== "string" || typeof item.operationId !== "string" || typeof item.mapId !== "string" || !Number.isFinite(item.asOf) || !Number.isInteger(offset) || offset < 0) throw new Error();
    if (item.fromMs != null && !Number.isFinite(item.fromMs)) throw new Error();
    if (item.toMs != null && !Number.isFinite(item.toMs)) throw new Error();
    return { ...item, offset } as Cursor;
  } catch {
    throw new OperationTraceQueryError(400, BLACKBOX_ERRORS.code.invalid_operation_cursor, "operation cursor is invalid");
  }
}

function streamRoot(root: string, generation: string): string {
  return generation === "legacy" ? join(root, "streams") : join(root, "generations", generation, "streams");
}

async function* walk(root: string): AsyncGenerator<string> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try { entries = await readdir(root, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean }>; } catch { return; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".index.ndjson")) yield path;
  }
}

async function* walkEvents(root: string): AsyncGenerator<string> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try { entries = await readdir(root, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean }>; } catch { return; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walkEvents(path);
    else if (entry.name.endsWith(".events.ndjson")) yield path;
  }
}

function segmentPaths(indexPath: string): { eventsPath: string; source?: string; bootId?: string } {
  const eventsPath = indexPath.replace(/\.index\.ndjson$/, ".events.ndjson");
  const parts = eventsPath.split(/[\\/]/);
  const streamsIndex = parts.lastIndexOf("streams");
  const source = streamsIndex >= 0 ? parts[streamsIndex + 2] : undefined;
  const bootId = streamsIndex >= 0 ? parts[streamsIndex + 3] : undefined;
  return { eventsPath, source, bootId };
}

function parseIndex(value: unknown, segment: Segment): IndexRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const paths = segmentPaths(segment.indexPath);
  const eventId = typeof item.eventId === "string" ? item.eventId : undefined;
  const mapId = typeof item.mapId === "string" ? item.mapId : undefined;
  const timeMs = Number(item.timeMs), sequence = Number(item.sequence), offset = Number(item.offset), length = Number(item.length);
  if (!eventId || !mapId || !paths.source || !paths.bootId || !Number.isFinite(timeMs) || !Number.isFinite(sequence) || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 2) return undefined;
  const related = Array.isArray(item.relatedOperationIds) ? item.relatedOperationIds.filter((value): value is string => typeof value === "string") : undefined;
  return {
    eventId, mapId, timeMs, sequence, source: paths.source, bootId: paths.bootId, offset, length, eventsPath: paths.eventsPath,
    ...(typeof item.operationId === "string" ? { operationId: item.operationId } : {}),
    ...(related?.length ? { relatedOperationIds: related } : {}),
  };
}

function parseEvent(value: unknown): BlackboxEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as Record<string, unknown>;
  if (typeof event.eventId !== "string" || typeof event.timeMs !== "number" || typeof event.sequence !== "number" || typeof event.mapId !== "string" || typeof event.category !== "string" || typeof event.kind !== "string" || !event.payload || typeof event.payload !== "object") return undefined;
  return event as unknown as BlackboxEvent;
}

async function readEvent(ref: IndexRef, maxEventBytes: number): Promise<BlackboxEvent | undefined> {
  if (ref.length > maxEventBytes) return undefined;
  let handle;
  try { handle = await open(ref.eventsPath, "r"); } catch { return undefined; }
  try {
    const buffer = Buffer.alloc(ref.length);
    const result = await handle.read(buffer, 0, ref.length, ref.offset);
    if (result.bytesRead <= 0) return undefined;
    return parseEvent(JSON.parse(buffer.subarray(0, result.bytesRead).toString("utf8")));
  } catch { return undefined; }
  finally { await handle.close(); }
}

export class OperationTraceQuery {
  readonly root: string;
  readonly maxIndexBytes: number;
  readonly maxIndexLines: number;
  readonly maxSegments: number;
  readonly maxEvents: number;
  readonly maxEventBytes: number;
  readonly maxRawBytes: number;
  readonly maxRawLines: number;

  constructor(options: OperationTraceQueryOptions) {
    this.root = options.root;
    this.maxIndexBytes = options.maxIndexBytes ?? 64 * 1024 * 1024;
    this.maxIndexLines = options.maxIndexLines ?? 500_000;
    this.maxSegments = options.maxSegments ?? 256;
    this.maxEvents = options.maxEvents ?? 5_000;
    this.maxEventBytes = options.maxEventBytes ?? 4 * 1024 * 1024;
    this.maxRawBytes = options.maxRawBytes ?? 64 * 1024 * 1024;
    this.maxRawLines = options.maxRawLines ?? 500_000;
    if (![this.maxIndexBytes, this.maxIndexLines, this.maxSegments, this.maxEvents, this.maxEventBytes, this.maxRawBytes, this.maxRawLines].every(value => Number.isInteger(value) && value > 0)) throw new Error("operation trace query limits must be positive integers");
  }

  private matches(event: BlackboxEvent, input: OperationTraceInput, operationId: string, asOf: number, fromMs: number | undefined, toMs: number): boolean {
    if (input.mapId && event.mapId !== input.mapId) return false;
    if (event.timeMs > asOf || event.timeMs > toMs || event.timeMs < (fromMs ?? 0)) return false;
    return event.operationId === operationId || event.payload.relatedOperationIds instanceof Array && (event.payload.relatedOperationIds as unknown[]).includes(operationId);
  }

  private async legacyQuery(input: OperationTraceInput, generation: string, cursor: Cursor | undefined, operationId: string, asOf: number, fromMs: number | undefined, toMs: number): Promise<OperationTraceResult> {
    const events: BlackboxEvent[] = [], ids = new Set<string>();
    let bytes = 0, lines = 0, truncated = false, gap = false;
    for await (const eventsPath of walkEvents(streamRoot(this.root, generation))) {
      if (bytes >= this.maxRawBytes || lines >= this.maxRawLines) { truncated = true; break; }
      const stream = createReadStream(eventsPath, { encoding: "utf8" });
      const reader = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of reader) {
          bytes += Buffer.byteLength(line) + 1; lines += 1;
          if (bytes > this.maxRawBytes || lines > this.maxRawLines) { truncated = true; break; }
          let event: BlackboxEvent | undefined;
          try { event = parseEvent(JSON.parse(line)); } catch { gap = true; continue; }
          if (event && this.matches(event, input, operationId, asOf, fromMs, toMs) && !ids.has(event.eventId)) { ids.add(event.eventId); events.push(event); }
        }
      } catch { gap = true; }
      finally { reader.close(); stream.destroy(); }
      if (truncated) break;
    }
    events.sort(compare);
    if (events.length > this.maxEvents) { events.length = this.maxEvents; truncated = true; }
    const offset = cursor?.offset ?? 0;
    const page = events.slice(offset, offset + Math.min(Math.max(Math.trunc(input.limit ?? 200), 1), 500));
    const result: OperationTraceResult = { operationId, events: page, generation, gap, truncated, ...(truncated ? { reason: QUERY_LIMIT_REASONS.code.index_scan_limit } : {}) };
    if (offset + page.length < events.length) result.nextCursor = encodeCursor({ generation, operationId, mapId: input.mapId ?? "", fromMs, toMs, asOf, offset: offset + page.length, legacy: true });
    return result;
  }

  async query(input: OperationTraceInput): Promise<OperationTraceResult> {
    const operationId = input.operationId.trim();
    if (!operationId) throw new OperationTraceQueryError(400, BLACKBOX_ERRORS.code.missing_operation_id, "operation id is required");
    const generation = await readGeneration(this.root);
    const cursor = decodeCursor(input.cursor);
    const mapId = input.mapId ?? "";
    const asOf = Number.isFinite(input.asOf) ? Number(input.asOf) : Date.now();
    const fromMs = input.fromMs == null ? undefined : Math.max(0, Math.trunc(input.fromMs));
    const toMs = input.toMs == null ? asOf : Math.min(asOf, Math.trunc(input.toMs));
    if (!Number.isFinite(asOf) || !Number.isFinite(toMs) || (fromMs != null && fromMs > toMs)) throw new OperationTraceQueryError(400, BLACKBOX_ERRORS.code.invalid_time_range, "operation trace time range is invalid");
    if (cursor && (cursor.generation !== generation.id || cursor.operationId !== operationId || cursor.mapId !== mapId || cursor.asOf !== asOf || cursor.fromMs !== fromMs || cursor.toMs !== toMs)) throw new OperationTraceQueryError(409, BLACKBOX_ERRORS.code.stale_operation_cursor, "operation trace generation or query has changed");
    if (input.limit != null && (!Number.isFinite(input.limit) || input.limit < 1)) throw new OperationTraceQueryError(400, BLACKBOX_ERRORS.code.invalid_limit, "limit must be a positive number");
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 200), 1), 500);

    const discoveredSegments: Segment[] = [];
    for await (const indexPath of walk(streamRoot(this.root, generation.id))) {
      try {
        const item = await stat(indexPath);
        discoveredSegments.push({ indexPath, eventsPath: indexPath.replace(/\.index\.ndjson$/, ".events.ndjson"), mtimeMs: item.mtimeMs, size: item.size });
      } catch { /* segment may rotate while querying */ }
    }
    discoveredSegments.sort((a, b) => b.mtimeMs - a.mtimeMs || basename(b.indexPath).localeCompare(basename(a.indexPath)));
    if (!discoveredSegments.length || cursor?.legacy) {
      const result = await this.legacyQuery(input, generation.id, cursor, operationId, asOf, fromMs, toMs);
      const latest = await readGeneration(this.root);
      if (latest.id !== generation.id) throw new OperationTraceQueryError(409, BLACKBOX_ERRORS.code.stale_operation_generation, "blackbox generation changed during operation trace query");
      return result;
    }
    const streamRootPath = resolve(streamRoot(this.root, generation.id));
    const segments: Segment[] = cursor?.segments?.length
      ? cursor.segments.map(item => {
        const path = resolve(item.path);
        if (!path.startsWith(`${streamRootPath}/`) || !path.endsWith(".index.ndjson")) throw new OperationTraceQueryError(400, BLACKBOX_ERRORS.code.invalid_operation_cursor, "operation cursor segment is invalid");
        return { indexPath: path, eventsPath: path.replace(/\.index\.ndjson$/, ".events.ndjson"), size: item.size, mtimeMs: item.mtimeMs };
      })
      : discoveredSegments.slice(0, this.maxSegments);
    const refs: IndexRef[] = [];
    const refIds = new Set<string>();
    let indexBytes = 0, indexLines = 0, incomplete = false, truncated = false, corrupt = false;
    for (const segment of segments) {
      if (indexBytes >= this.maxIndexBytes || indexLines >= this.maxIndexLines) { truncated = true; break; }
      const stream = createReadStream(segment.indexPath, { encoding: "utf8" });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          indexBytes += Buffer.byteLength(line) + 1; indexLines += 1;
          if (indexBytes > this.maxIndexBytes || indexLines > this.maxIndexLines) { truncated = true; break; }
          let ref: IndexRef | undefined;
          try { ref = parseIndex(JSON.parse(line), segment); } catch { corrupt = true; continue; }
          if (!ref || ref.mapId !== mapId && mapId) continue;
          if (ref.timeMs > asOf || ref.timeMs < (fromMs ?? 0) || ref.timeMs > toMs) continue;
          if (ref.operationId !== operationId && !ref.relatedOperationIds?.includes(operationId)) continue;
          if (!refIds.has(ref.eventId)) { refIds.add(ref.eventId); refs.push(ref); }
        }
      } catch { incomplete = true; }
      finally { lines.close(); stream.destroy(); }
      if (truncated) break;
    }
    if (discoveredSegments.length > this.maxSegments && !cursor?.segments?.length && !truncated) truncated = true;
    refs.sort(compare);
    if (refs.length > this.maxEvents) { refs.length = this.maxEvents; truncated = true; }
    const offset = cursor?.offset ?? 0;
    const pageRefs = refs.slice(offset, offset + limit);
    const events: BlackboxEvent[] = [];
    let missingEvents = 0;
    for (const ref of pageRefs) {
      const event = await readEvent(ref, this.maxEventBytes);
      if (!event) { missingEvents += 1; continue; }
      if (event.operationId !== operationId && !(event.payload.relatedOperationIds instanceof Array && (event.payload.relatedOperationIds as unknown[]).includes(operationId))) continue;
      events.push(event);
    }
    events.sort(compare);
    const result: OperationTraceResult = {
      operationId, events, generation: generation.id,
      gap: incomplete || corrupt || missingEvents > 0,
      truncated: truncated || missingEvents > 0,
      ...(corrupt ? { reason: QUERY_LIMIT_REASONS.code.corrupt_index } : missingEvents ? { reason: QUERY_LIMIT_REASONS.code.missing_event, missingEvents } : truncated ? { reason: refs.length >= this.maxEvents ? QUERY_LIMIT_REASONS.code.event_limit : QUERY_LIMIT_REASONS.code.index_scan_limit } : {}),
    };
    if (offset + pageRefs.length < refs.length) result.nextCursor = encodeCursor({ generation: generation.id, operationId, mapId, fromMs, toMs, asOf, offset: offset + pageRefs.length, segments: segments.map(item => ({ path: item.indexPath, size: item.size, mtimeMs: item.mtimeMs })) });
    const latest = await readGeneration(this.root);
    if (latest.id !== generation.id) throw new OperationTraceQueryError(409, BLACKBOX_ERRORS.code.stale_operation_generation, "blackbox generation changed during operation trace query");
    return result;
  }
}
