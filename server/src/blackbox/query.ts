import { ScanLimitKinds, type ScanLimitKind } from "../../../shared/config/blackbox.ts";
import { EVENT_KINDS } from "../../../shared/config/events.ts";
import { BLACKBOX_ERRORS } from "../../../shared/config/reasons.ts";
import { createReadStream } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  BLACKBOX_SCHEMA_VERSION,
  isAuthoritativeBlackboxFrameSource,
  type BlackboxEvent,
  type BlackboxEventQuery,
  type BlackboxGap,
  type BlackboxCatalog,
  type BlackboxWindowQuery,
  type BlackboxWindowQueryInput,
  type BlackboxOperationQuery,
  type BlackboxReplayQuery,
  type RobotEventQuery,
  type RobotEventQueryInput,
} from "../../../shared/blackbox.ts";
import { DEFAULT_DATA_ROOT, resetBlackbox } from "./recorder.ts";
import { readGeneration } from "./generation.ts";
import { OperationTraceQuery, OperationTraceQueryError } from "./operationQuery.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SCAN_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_SCAN_LINES = 2_000_000;
const DEFAULT_MAX_RETAINED_EVENTS = 250_000;
const MEANINGFUL = new Set<BlackboxEvent["category"]>(["operation", "error", "forced", "environment", "connection"]);
const REPLAY = new Set<BlackboxEvent["category"]>(["operation", "error", "forced", "environment", "connection", "frame", "planning", "gap"]);

export class BlackboxHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "BlackboxHttpError";
  }
}

type ScanBudget = { bytes: number; lines: number };
type ScanEventCallback = (event: BlackboxEvent, file: string) => void;
type ScanGapCallback = (gap: BlackboxGap) => void;
type QueryOptions = { root?: string; maxScanBytes?: number; maxScanLines?: number; maxIndexScanBytes?: number; maxIndexScanLines?: number; maxRetainedEvents?: number };
type IndexRef = { eventId: string; timeMs: number; sequence: number; source: string; bootId: string; mapId: string; category: BlackboxEvent["category"]; kind: string; robotId?: string; level?: string; operationId?: string; relatedOperationIds?: string[]; offset: number; length: number; eventsPath: string };

function compare(a: BlackboxEvent, b: BlackboxEvent): number {
  return a.timeMs - b.timeMs || a.sequence - b.sequence || a.eventId.localeCompare(b.eventId) || a.source.localeCompare(b.source) || a.bootId.localeCompare(b.bootId);
}

function compareIndex(a: { timeMs: number; sequence: number; eventId: string }, b: { timeMs: number; sequence: number; eventId: string }): number {
  return a.timeMs - b.timeMs || a.sequence - b.sequence || a.eventId.localeCompare(b.eventId);
}

function compareCursorRef(ref: IndexRef, cursor: RobotKey): number {
  return ref.timeMs - cursor.timeMs || ref.sequence - cursor.sequence || ref.eventId.localeCompare(cursor.eventId) || ref.source.localeCompare(cursor.source) || ref.bootId.localeCompare(cursor.bootId);
}
function compareRefIndex(a: IndexRef, b: IndexRef): number {
  return a.timeMs - b.timeMs || a.sequence - b.sequence || a.eventId.localeCompare(b.eventId) || a.source.localeCompare(b.source) || a.bootId.localeCompare(b.bootId);
}

function isRoutineRobotEvent(event: BlackboxEvent): boolean {
  const kind = event.kind.toLowerCase();
  return isRoutineKind(kind) || kind === "grpc.rx" && typeof event.payload.message === "object" && Object.prototype.hasOwnProperty.call(event.payload.message as object, "pose");
}
function isRoutineKind(kind: string): boolean {
  const value = kind.toLowerCase();
  return value === "pose" || value === "send.pose" || value === "receive.pose" || value === "heartbeat" || value === "send.heartbeat" || value === "receive.heartbeat";
}

function encodeCursor(value: { asOf: number; offset: number }): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): { asOf: number; offset: number } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { asOf?: unknown; offset?: unknown };
    const asOf = Number(parsed.asOf);
    const offset = Number(parsed.offset);
    if (!Number.isFinite(asOf) || !Number.isInteger(offset) || offset < 0) throw new Error("invalid cursor");
    return { asOf, offset };
  } catch {
    throw new BlackboxHttpError(400, BLACKBOX_ERRORS.code.invalid_cursor, "cursor is invalid");
  }
}

type RobotKey = { timeMs: number; sequence: number; eventId: string; source: string; bootId: string };
type ScanPosition = { path: string; endOffset: number };
type RobotCursor = RobotKey & { generation: string; asOf: number; mapId: string; robotId: string; fromMs: number; toMs: number; categories: string[]; levels: string[]; includePose: boolean; before?: RobotKey; scan?: ScanPosition[] };
type WindowCursor = { generation: string; mapId: string; asOf: number; fromMs: number; toMs: number; offset: number; ends: Array<{ path: string; endOffset: number }> };
function encodeRobotCursor(value: RobotCursor): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function decodeRobotCursor(value: string | undefined): RobotCursor | undefined {
  if (!value) return undefined;
  try {
    const item = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<RobotCursor>;
    if (!item.generation || !Number.isFinite(item.asOf) || !Number.isFinite(item.timeMs) || !Number.isInteger(item.sequence) || !item.eventId || !item.source || !item.bootId || !item.mapId || !item.robotId || !Array.isArray(item.categories) || !Array.isArray(item.levels)) throw new Error();
    return item as RobotCursor;
  } catch { throw new BlackboxHttpError(400, BLACKBOX_ERRORS.code.invalid_cursor, "cursor is invalid"); }
}

function encodeWindowCursor(value: WindowCursor): string { return gzipSync(Buffer.from(JSON.stringify(value), "utf8")).toString("base64url"); }
function decodeWindowCursor(value: string | undefined): WindowCursor | undefined {
  if (!value) return undefined;
  try {
    const item = JSON.parse(gunzipSync(Buffer.from(value, "base64url")).toString("utf8")) as Partial<WindowCursor>;
    const offset = Number(item.offset);
    if (!item.generation || !item.mapId || !Number.isFinite(item.asOf) || !Number.isFinite(item.fromMs) || !Number.isFinite(item.toMs) || !Number.isInteger(offset) || offset < 0 || !Array.isArray(item.ends)) throw new Error();
    return { ...item, offset, ends: item.ends.filter((entry): entry is { path: string; endOffset: number } => !!entry && typeof entry.path === "string" && Number.isInteger(entry.endOffset) && entry.endOffset >= 0) } as WindowCursor;
  } catch { throw new BlackboxHttpError(400, BLACKBOX_ERRORS.code.invalid_cursor, "cursor is invalid"); }
}

function parseEvent(value: unknown): BlackboxEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== BLACKBOX_SCHEMA_VERSION || typeof item.eventId !== "string" || typeof item.timeMs !== "number" || !Number.isFinite(item.timeMs) || typeof item.sequence !== "number" || typeof item.source !== "string" || typeof item.bootId !== "string" || typeof item.mapId !== "string" || typeof item.category !== "string" || typeof item.kind !== "string" || !item.payload || typeof item.payload !== "object") return undefined;
  return item as unknown as BlackboxEvent;
}

function eventGap(event: BlackboxEvent): BlackboxGap | undefined {
  if (event.category !== "gap") return undefined;
  const payload = event.payload as Record<string, unknown>;
  return {
    kind: event.kind,
    source: event.source,
    bootId: event.bootId,
    mapId: event.mapId,
    timeMs: event.timeMs,
    fromSequence: Number.isFinite(Number(payload.fromSequence)) ? Number(payload.fromSequence) : undefined,
    toSequence: Number.isFinite(Number(payload.toSequence)) ? Number(payload.toSequence) : undefined,
    detail: typeof payload.detail === "string" ? payload.detail : undefined,
  };
}

async function* walk(root: string): AsyncGenerator<string> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try { entries = await readdir(root, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean }>; } catch { return; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".events.ndjson")) yield path;
  }
}

async function streamsRoot(root: string): Promise<string> {
  const generation = await readGeneration(root);
  return generation.id === "legacy" ? join(root, "streams") : join(root, "generations", generation.id, "streams");
}

function segmentDay(path: string): number | undefined {
  const match = /[\\/]streams[\\/](\d{4}-\d{2}-\d{2})[\\/]/.exec(path);
  if (!match) return undefined;
  const value = Date.parse(`${match[1]}T00:00:00.000Z`);
  return Number.isFinite(value) ? value : undefined;
}

function segmentSource(path: string): string | undefined {
  const match = /[\\/]streams[\\/]\d{4}-\d{2}-\d{2}[\\/]([^\\/]+)[\\/]/.exec(path);
  return match?.[1];
}

function overlaps(path: string, lower?: number, upper?: number): boolean {
  const day = segmentDay(path);
  if (day == null) return true;
  const end = day + DAY_MS - 1;
  return (lower == null || end >= lower) && (upper == null || day <= upper);
}

function indexPath(eventsPath: string): string {
  return eventsPath.replace(/\.events\.ndjson$/, ".index.ndjson");
}

function scanLimitError(kind: ScanLimitKind, value: number): BlackboxHttpError {
  return new BlackboxHttpError(413, BLACKBOX_ERRORS.code.scan_limit_exceeded, `blackbox scan ${kind} limit exceeded (${value})`);
}

function parseIndex(value: unknown, eventsPath: string, source: string | undefined): IndexRef | undefined {
  if (!value || typeof value !== "object" || !source) return undefined;
  const item = value as Record<string, unknown>;
  const eventId = typeof item.eventId === "string" ? item.eventId : undefined;
  const mapId = typeof item.mapId === "string" ? item.mapId : undefined;
  const category = typeof item.category === "string" ? item.category as BlackboxEvent["category"] : undefined;
  const kind = typeof item.kind === "string" ? item.kind : undefined;
  const timeMs = Number(item.timeMs), sequence = Number(item.sequence), offset = Number(item.offset), length = Number(item.length);
  const boot = /[\\/]streams[\\/]\d{4}-\d{2}-\d{2}[\\/][^\\/]+[\\/]([^\\/]+)[\\/]/.exec(eventsPath)?.[1];
  if (!eventId || !mapId || !category || !kind || !boot || !Number.isFinite(timeMs) || !Number.isFinite(sequence) || !Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 2) return undefined;
  const relatedOperationIds = Array.isArray(item.relatedOperationIds) ? item.relatedOperationIds.filter((value): value is string => typeof value === "string") : undefined;
  return { eventId, timeMs, sequence, source, bootId: boot, mapId, category, kind, ...(typeof item.robotId === "string" ? { robotId: item.robotId } : {}), ...(typeof item.level === "string" ? { level: item.level.toLowerCase() } : {}), ...(typeof item.operationId === "string" ? { operationId: item.operationId } : {}), ...(relatedOperationIds?.length ? { relatedOperationIds } : {}), offset, length, eventsPath };
}

function compareRef(a: IndexRef, b: IndexRef): number {
  return a.timeMs - b.timeMs || a.sequence - b.sequence || a.eventId.localeCompare(b.eventId) || a.source.localeCompare(b.source) || a.bootId.localeCompare(b.bootId);
}

export class BlackboxQuery {
  readonly root: string;
  readonly maxScanBytes: number;
  readonly maxScanLines: number;
  readonly maxIndexScanBytes: number;
  readonly maxIndexScanLines: number;
  readonly maxRetainedEvents: number;

  constructor(rootOrOptions: string | QueryOptions = join(DEFAULT_DATA_ROOT, "blackbox"), options: QueryOptions = {}) {
    const input = typeof rootOrOptions === "string" ? { ...options, root: rootOrOptions } : rootOrOptions;
    this.root = input.root || join(DEFAULT_DATA_ROOT, "blackbox");
    this.maxScanBytes = input.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES;
    this.maxScanLines = input.maxScanLines ?? DEFAULT_MAX_SCAN_LINES;
    this.maxIndexScanBytes = input.maxIndexScanBytes ?? Math.max(DEFAULT_MAX_SCAN_BYTES * 8, 2 * 1024 * 1024 * 1024);
    this.maxIndexScanLines = input.maxIndexScanLines ?? Math.max(DEFAULT_MAX_SCAN_LINES * 8, 20_000_000);
    this.maxRetainedEvents = input.maxRetainedEvents ?? DEFAULT_MAX_RETAINED_EVENTS;
    if (![this.maxScanBytes, this.maxScanLines, this.maxIndexScanBytes, this.maxIndexScanLines, this.maxRetainedEvents].every((value) => Number.isInteger(value) && value > 0)) throw new Error("blackbox query limits must be positive integers");
  }

  async listMeaningful(input: { mapId: string; asOf?: number; cursor?: string; limit?: number }): Promise<BlackboxEventQuery> {
    this.assertMap(input.mapId);
    const asOf = this.asOf(input.asOf);
    const cursor = decodeCursor(input.cursor);
    if (cursor && cursor.asOf !== asOf) throw new BlackboxHttpError(400, BLACKBOX_ERRORS.code.cursor_asof_mismatch, "cursor belongs to another asOf");
    if (input.limit != null && (!Number.isFinite(input.limit) || input.limit < 1)) throw new BlackboxHttpError(400, BLACKBOX_ERRORS.code.invalid_limit, "limit must be a positive number");
    const from = asOf - DAY_MS;
    const offset = cursor?.offset ?? 0;
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 200), 1), 500);
    const indexed = await this.indexRefs((path) => overlaps(path, from, asOf), (ref) => ref.mapId === input.mapId && MEANINGFUL.has(ref.category) && ref.timeMs >= from && ref.timeMs <= asOf);
    if (!indexed.incomplete) {
      indexed.refs.sort(compareRef);
      const pageRefs = indexed.refs.slice(offset, offset + limit);
      const page = await this.readIndexedEvents(pageRefs);
      return { asOf, events: page, ...(offset + page.length < indexed.refs.length ? { nextCursor: encodeCursor({ asOf, offset: offset + page.length }) } : {}) };
    }
    const candidates: BlackboxEvent[] = [], ids = new Set<string>();
    await this.scanFiles((path) => overlaps(path, from, asOf), (event) => {
      if (event.mapId === input.mapId && MEANINGFUL.has(event.category) && event.timeMs >= from && event.timeMs <= asOf) this.retain(candidates, ids, event);
    });
    candidates.sort(compare);
    const page = candidates.slice(offset, offset + limit);
    return { asOf, events: page, ...(offset + page.length < candidates.length ? { nextCursor: encodeCursor({ asOf, offset: offset + page.length }) } : {}) };
  }

  async replay(input: { mapId: string; startEventId: string; endEventId: string; asOf?: number }): Promise<BlackboxReplayQuery> {
    this.assertMap(input.mapId);
    const asOf = this.asOf(input.asOf);
    const from = asOf - DAY_MS;
    const candidateIndex = await this.indexRefs((path) => overlaps(path, from, asOf), (ref) => ref.mapId === input.mapId && MEANINGFUL.has(ref.category) && ref.timeMs >= from && ref.timeMs <= asOf);
    let start: BlackboxEvent | undefined;
    let end: BlackboxEvent | undefined;
    if (!candidateIndex.incomplete) {
      const startRef = candidateIndex.refs.find((ref) => ref.eventId === input.startEventId);
      const endRef = candidateIndex.refs.find((ref) => ref.eventId === input.endEventId);
      if (startRef) start = await this.readIndexedEvent(startRef);
      if (endRef) end = await this.readIndexedEvent(endRef);
    } else {
      const candidates: BlackboxEvent[] = [], ids = new Set<string>();
      await this.scanFiles((path) => overlaps(path, from, asOf), (event) => {
        if (event.mapId === input.mapId && MEANINGFUL.has(event.category) && event.timeMs >= from && event.timeMs <= asOf) this.retain(candidates, ids, event);
      });
      candidates.sort(compare);
      start = candidates.find((event) => event.eventId === input.startEventId);
      end = candidates.find((event) => event.eventId === input.endEventId);
    }
    if (!start || !end) throw new BlackboxHttpError(404, BLACKBOX_ERRORS.code.event_not_found, "startEventId and endEventId must be meaningful events in the recent 24 hours");
    if (compare(start, end) > 0) throw new BlackboxHttpError(400, BLACKBOX_ERRORS.code.reverse_range, "start event must not be after end event");

    const gaps: BlackboxGap[] = [];
    const events: BlackboxEvent[] = [];
    const boundaryRef = this.refFromEvent(start);
    const checkpointIndex = await this.latestIndexRef((path) => overlaps(path, undefined, start!.timeMs), (ref) => ref.mapId === input.mapId && ref.category === "frame" && isAuthoritativeBlackboxFrameSource(ref.source) && compareRef(ref, boundaryRef) <= 0);
    let checkpoint: BlackboxEvent | undefined;
    if (!checkpointIndex.incomplete) {
      if (checkpointIndex.ref) checkpoint = await this.readIndexedEvent(checkpointIndex.ref);
    } else {
      await this.scanFiles((path) => overlaps(path, undefined, start.timeMs), (event) => {
        if (event.mapId === input.mapId && event.category === "frame" && isAuthoritativeBlackboxFrameSource(event.source) && compare(event, start!) <= 0 && (!checkpoint || compare(event, checkpoint) > 0)) checkpoint = event;
      }, (gap) => { if (gap.timeMs == null || gap.timeMs <= start.timeMs) gaps.push(gap); });
    }
    if (!checkpoint) throw new BlackboxHttpError(424, BLACKBOX_ERRORS.code.checkpoint_unavailable, "no historical checkpoint is available before the selected range");
    await this.assertHistoricalAssets(checkpoint);
    const rangeIndex = await this.indexRefs((path) => overlaps(path, start!.timeMs, end!.timeMs), (ref) => ref.mapId === input.mapId && replayRef(ref) && compareRef(ref, this.refFromEvent(start!)) >= 0 && compareRef(ref, this.refFromEvent(end!)) <= 0);
    if (!rangeIndex.incomplete) {
      rangeIndex.refs.sort(compareRef);
      for (const event of await this.readIndexedEvents(rangeIndex.refs)) {
        events.push(event);
        const gap = eventGap(event);
        if (gap) gaps.push(gap);
      }
    } else {
      const ids = new Set<string>();
      await this.scanFiles((path) => overlaps(path, start!.timeMs, end!.timeMs), (event) => {
        if (event.mapId !== input.mapId || !replayEvent(event) || compare(event, start!) < 0 || compare(event, end!) > 0) return;
        this.retain(events, ids, event);
        const gap = eventGap(event);
        if (gap) gaps.push(gap);
      }, (gap) => { if (gap.timeMs == null || (gap.timeMs >= start!.timeMs && gap.timeMs <= end!.timeMs)) gaps.push(gap); });
    }
    events.sort(compare);
    for (const event of events) if (event.category === "frame") await this.assertHistoricalAssets(event);
    return { schemaVersion: BLACKBOX_SCHEMA_VERSION, mapId: input.mapId, startEvent: start, endEvent: end, checkpoint, events, gaps };
  }

  /**
   * Return cheap metadata for the selected map. This intentionally reads only
   * bounded index tails; callers can use window() for the actual replay page.
   */
  async catalog(input: { mapId: string; asOf?: number }): Promise<BlackboxCatalog> {
    this.assertMap(input.mapId);
    const generation = await readGeneration(this.root);
    const asOf = this.asOf(input.asOf);
    const scan = await this.boundedIndexRefs((path) => overlaps(path, undefined, asOf), ref => ref.mapId === input.mapId && ref.timeMs <= asOf);
    const refs = scan.refs.sort(compareRef);
    const checkpointRef = [...refs].reverse().find(ref => ref.category === "frame" && isAuthoritativeBlackboxFrameSource(ref.source));
    const latestCheckpoint = checkpointRef ? await this.readIndexedEvent(checkpointRef) : undefined;
    if (latestCheckpoint) await this.assertHistoricalAssets(latestCheckpoint);
    await this.assertGeneration(generation.id);
    const result: BlackboxCatalog = {
      schemaVersion: BLACKBOX_SCHEMA_VERSION,
      mapId: input.mapId,
      generation,
      ...(refs[0] ? { availableFrom: refs[0].timeMs } : {}),
      ...(refs.at(-1) ? { availableTo: refs.at(-1)!.timeMs } : {}),
      ...(latestCheckpoint ? { latestCheckpoint, assets: (latestCheckpoint.payload as Record<string, unknown>).assets as BlackboxCatalog["assets"] } : {}),
      gap: scan.incomplete,
      truncated: scan.truncated,
    };
    return result;
  }

  async generation() {
    return { generation: await readGeneration(this.root) };
  }

  async reset(confirmation: import("../../../shared/blackbox.ts").BlackboxResetConfirmation): Promise<import("../../../shared/blackbox.ts").BlackboxResetResult> {
    return resetBlackbox(this.root, confirmation);
  }

  /**
   * Bounded time-window replay for the map timeline. The cursor pins the
   * generation and read horizon, so reset or append cannot silently alter a
   * page sequence.
   */
  async window(input: BlackboxWindowQueryInput): Promise<BlackboxWindowQuery> {
    this.assertMap(input.mapId);
    const generation = await readGeneration(this.root);
    const cursor = decodeWindowCursor(input.cursor);
    if (cursor && (cursor.generation !== generation.id || cursor.mapId !== input.mapId)) throw new BlackboxHttpError(409, BLACKBOX_ERRORS.code.stale_cursor, "blackbox generation has changed");
    if (input.limit != null && (!Number.isFinite(input.limit) || input.limit < 1)) throw new BlackboxHttpError(400, BLACKBOX_ERRORS.code.invalid_limit, "limit must be a positive number");
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 250), 1), 1000);
    const probe = await this.boundedIndexRefs((path) => overlaps(path), ref => ref.mapId === input.mapId);
    const latestTime = probe.refs.reduce((latest, ref) => Math.max(latest, ref.timeMs), 0);
    const asOf = this.asOf(input.asOf ?? cursor?.asOf ?? (latestTime || undefined));
    let from = input.fromMs == null ? Math.max(0, asOf - 30_000) : Math.max(0, Math.trunc(input.fromMs));
    if (input.fromMs == null) {
      const firstCheckpoint = probe.refs.filter(ref => ref.category === "frame" && isAuthoritativeBlackboxFrameSource(ref.source)).sort(compareRef)[0];
      if (firstCheckpoint && firstCheckpoint.timeMs > from) from = firstCheckpoint.timeMs;
    }
    const to = Math.min(asOf, input.toMs == null ? asOf : Math.trunc(input.toMs));
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new BlackboxHttpError(400, BLACKBOX_ERRORS.code.invalid_time_range, "time range is invalid");
    if (cursor && (cursor.asOf !== asOf || cursor.fromMs !== from || cursor.toMs !== to)) throw new BlackboxHttpError(400, BLACKBOX_ERRORS.code.cursor_query_mismatch, "cursor belongs to another window");
    const fixedWindowEnds = cursor?.ends;
    const scan = await this.boundedIndexRefs((path) => overlaps(path, from, to), ref => ref.mapId === input.mapId && ref.timeMs >= from && ref.timeMs <= to && replayRef(ref), fixedWindowEnds, { from, to });
    const windowEnds = cursor?.ends ?? scan.ends;
    const refs = scan.refs.sort(compareRef);
    const offset = cursor?.offset ?? 0;
    const pageRefs = refs.slice(offset, offset + limit);
    const page = await this.readIndexedEvents(pageRefs);
    const checkpointScan = await this.boundedIndexRefs((path) => overlaps(path, undefined, from), ref => ref.mapId === input.mapId && ref.timeMs <= from && ref.category === "frame" && isAuthoritativeBlackboxFrameSource(ref.source), windowEnds, { to: from });
    const checkpointRef = checkpointScan.refs.sort(compareRef).at(-1);
    if (!checkpointRef) throw new BlackboxHttpError(424, BLACKBOX_ERRORS.code.checkpoint_unavailable, "no historical checkpoint is available before the selected range");
    const checkpoint = await this.readIndexedEvent(checkpointRef);
    await this.assertHistoricalAssets(checkpoint);
    await this.assertGeneration(generation.id);
    const gaps = page.flatMap(event => { const gap = eventGap(event); return gap ? [gap] : []; });
    const nextOffset = offset + page.length;
    return {
      schemaVersion: BLACKBOX_SCHEMA_VERSION,
      mapId: input.mapId,
      generation,
      asOf,
      fromMs: from,
      toMs: to,
      ...(scan.refs[0] ? { availableFrom: scan.refs[0].timeMs } : {}),
      ...(scan.refs.at(-1) ? { availableTo: scan.refs.at(-1)!.timeMs } : {}),
      checkpoint,
      events: page,
      gaps,
      assets: (checkpoint.payload as Record<string, unknown>).assets as BlackboxWindowQuery["assets"],
      ...(nextOffset < refs.length ? { nextCursor: encodeWindowCursor({ generation: generation.id, mapId: input.mapId, asOf, fromMs: from, toMs: to, offset: nextOffset, ends: windowEnds }) } : {}),
      gap: scan.incomplete || checkpointScan.incomplete || gaps.length > 0,
      truncated: scan.truncated || checkpointScan.truncated,
    };
  }

  private async assertGeneration(id: string): Promise<void> {
    if ((await readGeneration(this.root)).id !== id) throw new BlackboxHttpError(409, BLACKBOX_ERRORS.code.generation_changed, "blackbox generation changed during query");
  }

  async operation(operationId: string, input: { mapId?: string; fromMs?: number; toMs?: number; asOf?: number; cursor?: string; limit?: number } = {}): Promise<BlackboxOperationQuery> {
    try {
      const bounded = await new OperationTraceQuery({ root: this.root }).query({ operationId, ...input });
      // Legacy fixtures and pre-index streams remain readable. Once an index
      // yields data or an explicit bounded condition, preserve its metadata.
      if (bounded.events.length || bounded.gap || bounded.truncated) return bounded;
    } catch (error) {
      if (error instanceof OperationTraceQueryError) throw new BlackboxHttpError(error.status, error.code, error.message);
      throw error;
    }
    return this.operationLegacy(operationId, input);
  }

  private async operationLegacy(operationId: string, input: { cursor?: string; limit?: number } = {}): Promise<BlackboxOperationQuery> {
    if (!operationId.trim()) throw new BlackboxHttpError(400, BLACKBOX_ERRORS.code.missing_operation_id, "operation id is required");
    const cursor = decodeCursor(input.cursor);
    if (cursor && cursor.asOf !== 0) throw new BlackboxHttpError(400, BLACKBOX_ERRORS.code.invalid_operation_cursor, "cursor does not belong to an operation trace");
    if (input.limit != null && (!Number.isFinite(input.limit) || input.limit < 1)) throw new BlackboxHttpError(400, BLACKBOX_ERRORS.code.invalid_limit, "limit must be a positive number");
    const offset = cursor?.offset ?? 0;
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 200), 1), 500);
    const indexed = await this.indexRefs(() => true, (ref) => ref.operationId === operationId || ref.relatedOperationIds?.includes(operationId) === true);
    if (!indexed.incomplete) {
      indexed.refs.sort(compareRef);
      const pageRefs = indexed.refs.slice(offset, offset + limit);
      const events = await this.readIndexedEvents(pageRefs);
      return { operationId, events, ...(offset + events.length < indexed.refs.length ? { nextCursor: encodeCursor({ asOf: 0, offset: offset + events.length }) } : {}) };
    }
    const allEvents: BlackboxEvent[] = [], ids = new Set<string>();
    await this.scanFiles(() => true, (event) => {
      if (event.operationId === operationId || event.payload.relatedOperationIds instanceof Array && (event.payload.relatedOperationIds as unknown[]).includes(operationId)) this.retain(allEvents, ids, event);
    });
    allEvents.sort(compare);
    const events = allEvents.slice(offset, offset + limit);
    return { operationId, events, ...(offset + events.length < allEvents.length ? { nextCursor: encodeCursor({ asOf: 0, offset: offset + events.length }) } : {}) };
  }

  /** Bounded, indexed robot console query. Pose/heartbeat records are hidden by default. */
  async robotEvents(input: RobotEventQueryInput): Promise<RobotEventQuery> {
    this.assertMap(input.mapId);
    if (!input.robotId || input.robotId.length > 120 || /[\r\n]/.test(input.robotId)) throw new BlackboxHttpError(400, BLACKBOX_ERRORS.code.invalid_robot_id, "robotId is required");
    const cursor = decodeRobotCursor(input.cursor);
    const generation = await readGeneration(this.root);
    if (cursor && cursor.generation !== generation.id) throw new BlackboxHttpError(409, BLACKBOX_ERRORS.code.stale_cursor, "blackbox generation has changed");
    // Cursor pages pin the read horizon, so live polling can reconnect without
    // invalidating a cursor as new events arrive.
    const asOf = this.asOf(input.asOf ?? cursor?.asOf);
    const from = input.fromMs == null ? asOf - 15 * 60 * 1000 : Math.max(0, Math.trunc(input.fromMs));
    const to = Math.min(asOf, input.toMs == null ? asOf : Math.trunc(input.toMs));
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new BlackboxHttpError(400, BLACKBOX_ERRORS.code.invalid_time_range, "time range is invalid");
    if (cursor && (cursor.asOf !== asOf || cursor.mapId !== input.mapId || cursor.robotId !== input.robotId || cursor.fromMs !== from || cursor.toMs !== to)) throw new BlackboxHttpError(400, BLACKBOX_ERRORS.code.cursor_query_mismatch, "cursor belongs to another robot query");
    if (input.limit != null && (!Number.isFinite(input.limit) || input.limit < 1)) throw new BlackboxHttpError(400, BLACKBOX_ERRORS.code.invalid_limit, "limit must be a positive number");
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), 500);
    const levels = new Set((input.levels ?? []).filter(value => typeof value === "string").map(value => value.toLowerCase()));
    const categories = new Set((input.categories ?? []).filter(value => typeof value === "string"));
    const includePose = input.includePose === true;
    const categoryKeys = [...categories].sort();
    const levelKeys = [...levels].sort();
    if (cursor && (JSON.stringify(cursor.categories) !== JSON.stringify(categoryKeys) || JSON.stringify(cursor.levels) !== JSON.stringify(levelKeys) || cursor.includePose !== includePose)) throw new BlackboxHttpError(400, BLACKBOX_ERRORS.code.cursor_filter_mismatch, "cursor belongs to another filter");
    const scan = await this.robotEventRefs(input.robotId, from, to, cursor?.scan, ref =>
      ref.mapId === input.mapId && ref.timeMs >= from && ref.timeMs <= to && (!ref.robotId || ref.robotId === input.robotId) && (!categories.size || categories.has(ref.category)) && (!cursor?.before || compareCursorRef(ref, cursor.before) < 0));
    scan.refs.sort((a, b) => compareRefIndex(b, a));
    const events: BlackboxEvent[] = [];
    let observedGap = false;
    let moreInWindow = false;
    for (const ref of scan.refs) {
      if (ref.category === "frame") continue;
      if (!includePose && isRoutineKind(ref.kind)) continue;
      if (levels.size && ref.level && !levels.has(ref.level)) continue;
      const event = await this.readIndexedEvent(ref);
      if (event.category === "gap") observedGap = true;
      if (event.robotId !== input.robotId && event.category !== "gap") continue;
      if (!includePose && isRoutineRobotEvent(event)) continue;
      const level = typeof event.payload.level === "string" ? event.payload.level.toLowerCase() : event.category === "error" ? "error" : "info";
      if (levels.size && !levels.has(level)) continue;
      if (events.length >= limit) { moreInWindow = true; break; }
      events.push(event);
    }
    events.sort(compare);
    await this.assertGeneration(generation.id);
    let nextCursor: string | undefined;
    if (moreInWindow && events.length) {
      const oldest = events[0]!;
      nextCursor = encodeRobotCursor({ generation: generation.id, asOf, mapId: input.mapId, robotId: input.robotId, fromMs: from, toMs: to, categories: categoryKeys, levels: levelKeys, includePose, timeMs: oldest.timeMs, sequence: oldest.sequence, eventId: oldest.eventId, source: oldest.source, bootId: oldest.bootId, before: { timeMs: oldest.timeMs, sequence: oldest.sequence, eventId: oldest.eventId, source: oldest.source, bootId: oldest.bootId }, scan: cursor?.scan ?? scan.windowScan });
    } else if (scan.nextScan) {
      const oldest = events[0];
      nextCursor = encodeRobotCursor({ generation: generation.id, asOf, mapId: input.mapId, robotId: input.robotId, fromMs: from, toMs: to, categories: categoryKeys, levels: levelKeys, includePose, timeMs: oldest?.timeMs ?? 0, sequence: oldest?.sequence ?? 0, eventId: oldest?.eventId ?? "scan", source: oldest?.source ?? "scan", bootId: oldest?.bootId ?? "scan", scan: scan.nextScan });
    }
    return {
      asOf,
      events,
      ...(nextCursor ? { nextCursor } : {}),
      gap: scan.incomplete || observedGap,
      truncated: scan.incomplete || scan.truncated,
    };
  }

  /**
   * Read only bounded tails of the newest index segments for robot-console
   * polling. Generic replay/operation queries keep their historical semantics;
   * the live console must not retain every historical index entry in memory.
   */
  private async robotEventRefs(robotId: string, from: number, to: number, scan: ScanPosition[] | undefined, predicate: (ref: IndexRef) => boolean): Promise<{ refs: IndexRef[]; incomplete: boolean; truncated: boolean; nextScan?: ScanPosition[]; windowScan: ScanPosition[] }> {
    const paths: Array<{ path: string; mtimeMs: number; size: number }> = [];
    const root = await streamsRoot(this.root);
    // The source directory is the cheap first-stage robot filter. FMS sources
    // still contain robot-scoped operation records, so retain those too.
    for await (const eventsPath of walk(root)) {
      if (!overlaps(eventsPath, from, to)) continue;
      const source = segmentSource(eventsPath);
      if (!source || (source !== robotId && source !== `robot-${robotId}` && !source.startsWith("fms") && !source.startsWith("floor-room"))) continue;
      const path = indexPath(eventsPath);
      try { const info = await stat(path); paths.push({ path, mtimeMs: info.mtimeMs, size: info.size }); } catch { /* index may still be flushing */ }
    }
    paths.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
    const maxBytes = 4 * 1024 * 1024, tailBytes = 256 * 1024, maxRefs = Math.min(this.maxRetainedEvents, 32_000);
    let budget = 0, incomplete = false, truncated = false;
    const refs: IndexRef[] = [], ids = new Set<string>();
    const positions: ScanPosition[] = scan ? scan.map(item => ({ ...item })) : paths.map(item => ({ path: item.path, endOffset: item.size }));
    const windowScan = positions.map(item => ({ ...item }));
    const pathInfo = new Map(paths.map(item => [item.path, item]));
    for (let i = 0; i < positions.length && budget < maxBytes; i++) {
      const position = positions[i]!;
      const item = pathInfo.get(position.path);
      if (!item) { position.endOffset = 0; continue; }
      const eventsPath = item.path.replace(/\.index\.ndjson$/, ".events.ndjson");
      const source = segmentSource(eventsPath);
      if (!source) { incomplete = true; continue; }
      let endOffset = Math.min(item.size, Math.max(0, position.endOffset));
      if (endOffset <= 0) continue;
      const length = Math.min(tailBytes, endOffset, maxBytes - budget), offset = endOffset - length;
      if (length <= 0) break;
      let handle;
      try { handle = await open(item.path, "r"); } catch { incomplete = true; continue; }
      try {
        // Overlap chunk boundaries so a line split by the bounded window is
        // seen by one of the two windows; eventId de-duplication is stable.
        const readOffset = Math.max(0, offset - 64 * 1024), readLength = length + (offset - readOffset);
        const buffer = Buffer.alloc(readLength), read = await handle.read(buffer, 0, readLength, readOffset);
        budget += read.bytesRead;
        const bytes = buffer.subarray(0, read.bytesRead);
        let cursorByte = 0;
        if (readOffset > 0) {
          const firstNewline = bytes.indexOf(10);
          cursorByte = firstNewline < 0 ? bytes.length : firstNewline + 1;
        }
        while (cursorByte < bytes.length) {
          const newline = bytes.indexOf(10, cursorByte);
          if (newline < 0) break;
          const lineEnd = readOffset + newline;
          const line = bytes.subarray(cursorByte, newline).toString("utf8");
          cursorByte = newline + 1;
          // The prior chunk owns complete lines ending at/before its frontier;
          // a line crossing the frontier belongs to this older chunk.
          if (lineEnd <= offset || !line.trim()) continue;
          let ref: IndexRef | undefined;
          try { ref = parseIndex(JSON.parse(line), eventsPath, source); } catch { ref = undefined; }
          if (!ref) { incomplete = true; continue; }
          if (predicate(ref) && !ids.has(ref.eventId)) {
            if (refs.length >= maxRefs) { truncated = true; break; }
            ids.add(ref.eventId); refs.push(ref);
          }
        }
      } catch { incomplete = true; }
      finally { await handle.close(); }
      // Continue the same large segment from an older byte range before moving
      // to older files. This makes routine-only tails eventually reveal errors.
      position.endOffset = offset;
    }
    if (budget >= maxBytes) truncated = true;
    const nextScan = positions.some(item => item.endOffset > 0) ? positions.filter(item => item.endOffset > 0) : undefined;
    if (nextScan) truncated = true;
    return { refs, incomplete, truncated, nextScan, windowScan };
  }

  async assetPath(hash: string, filename: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(hash) || !/^[a-zA-Z0-9._-]+$/.test(filename) || filename === "." || filename === "..") throw new BlackboxHttpError(400, BLACKBOX_ERRORS.code.invalid_asset_path, "asset path is invalid");
    const generation = await readGeneration(this.root);
    const base = generation.id === "legacy" ? this.root : join(this.root, "generations", generation.id);
    const root = resolve(base, "assets", hash);
    const path = resolve(root, filename);
    if (path !== join(root, filename) || !path.startsWith(`${root}/`)) throw new BlackboxHttpError(400, BLACKBOX_ERRORS.code.invalid_asset_path, "asset path is invalid");
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error("not a file");
    } catch {
      throw new BlackboxHttpError(404, BLACKBOX_ERRORS.code.asset_not_found, "historical asset is not available");
    }
    return path;
  }

  private refFromEvent(event: BlackboxEvent): IndexRef {
    return { eventId: event.eventId, timeMs: event.timeMs, sequence: event.sequence, source: event.source, bootId: event.bootId, mapId: event.mapId, category: event.category, kind: event.kind, ...(event.operationId ? { operationId: event.operationId } : {}), offset: 0, length: 0, eventsPath: "" };
  }

  private async indexRefs(fileFilter: (path: string) => boolean, predicate: (ref: IndexRef) => boolean): Promise<{ refs: IndexRef[]; incomplete: boolean }> {
    const refs: IndexRef[] = [];
    const ids = new Set<string>();
    const budget: ScanBudget = { bytes: 0, lines: 0 };
    let incomplete = false;
    for await (const eventsPath of walk(await streamsRoot(this.root))) {
      if (!fileFilter(eventsPath)) continue;
      const source = segmentSource(eventsPath);
      if (!source) { incomplete = true; continue; }
      const path = indexPath(eventsPath);
      let input;
      try { input = createReadStream(path, { encoding: "utf8" }); } catch { incomplete = true; continue; }
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const rawLine of lines) {
          const line = String(rawLine);
          budget.lines += 1;
          budget.bytes += Buffer.byteLength(line, "utf8") + 1;
          if (budget.lines > this.maxIndexScanLines) throw scanLimitError(ScanLimitKinds.code.lines, budget.lines);
          if (budget.bytes > this.maxIndexScanBytes) throw scanLimitError(ScanLimitKinds.code.bytes, budget.bytes);
          if (!line.trim()) continue;
          let ref: IndexRef | undefined;
          try { ref = parseIndex(JSON.parse(line), eventsPath, source); } catch { ref = undefined; }
          if (!ref) { incomplete = true; continue; }
          if (predicate(ref) && !ids.has(ref.eventId)) {
            if (refs.length >= this.maxRetainedEvents) throw new BlackboxHttpError(413, BLACKBOX_ERRORS.code.result_limit_exceeded, "blackbox result retention limit exceeded");
            ids.add(ref.eventId);
            refs.push(ref);
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") incomplete = true;
        else throw error;
      } finally {
        lines.close();
        input.destroy();
      }
    }
    return { refs, incomplete };
  }

  /** Read newest index tails with a hard aggregate budget. */
  private async boundedIndexRefs(fileFilter: (path: string) => boolean, predicate: (ref: IndexRef) => boolean, fixedEnds?: Array<{ path: string; endOffset: number }>, range?: { from?: number; to?: number }): Promise<{ refs: IndexRef[]; incomplete: boolean; truncated: boolean; ends: Array<{ path: string; endOffset: number }> }> {
    const paths: Array<{ eventsPath: string; indexPath: string; size: number; mtimeMs: number; source: string }> = [];
    for await (const eventsPath of walk(await streamsRoot(this.root))) {
      if (!fileFilter(eventsPath)) continue;
      const source = segmentSource(eventsPath);
      if (!source) continue;
      const path = indexPath(eventsPath);
      try {
        const info = await stat(path);
        paths.push({ eventsPath, indexPath: path, size: info.size, mtimeMs: info.mtimeMs, source });
      } catch { /* a segment can be visible before its index is flushed */ }
    }
    const fixed = new Map((fixedEnds ?? []).map(item => [item.path, item.endOffset]));
    if (range) {
      const selected: typeof paths = [];
      for (const item of paths) {
        const bounds = await this.indexTimeBounds(item.indexPath);
        if (!bounds || (range.from != null && bounds.max < range.from) || (range.to != null && bounds.min > range.to)) continue;
        selected.push(item);
      }
      paths.splice(0, paths.length, ...selected);
    }
    // FMS checkpoints are the authoritative replay source. Read those tails
    // first so a busy robot stream cannot consume the bounded budget.
    paths.sort((a, b) => Number(!isAuthoritativeBlackboxFrameSource(a.source)) - Number(!isAuthoritativeBlackboxFrameSource(b.source)) || b.mtimeMs - a.mtimeMs || b.indexPath.localeCompare(a.indexPath));
    const refs: IndexRef[] = [];
    const ids = new Set<string>();
    const maxBytes = Math.min(4 * 1024 * 1024, this.maxIndexScanBytes);
    const perFile = 256 * 1024;
    let consumed = 0, incomplete = false, truncated = false;
    const ends: Array<{ path: string; endOffset: number }> = [];
    for (const item of paths) {
      let endOffset = Math.min(item.size, Math.max(0, fixed.get(item.indexPath) ?? item.size));
      if (fixed.get(item.indexPath) == null && range?.to != null) endOffset = await this.seekIndexEnd(item.indexPath, range.to);
      ends.push({ path: item.indexPath, endOffset });
    }
    for (const item of paths) {
      if (consumed >= maxBytes) { truncated = true; break; }
      if (item.size === 0) continue;
      let endOffset = ends.find(entry => entry.path === item.indexPath)?.endOffset ?? 0;
      while (endOffset > 0 && consumed < maxBytes) {
        const length = Math.min(perFile, endOffset, maxBytes - consumed);
        const offset = endOffset - length;
        try {
          const handle = await open(item.indexPath, "r");
          const readOffset = Math.max(0, offset - 64 * 1024);
          const buffer = Buffer.alloc(endOffset - readOffset);
          const result = await handle.read(buffer, 0, buffer.length, readOffset);
          await handle.close();
          consumed += Math.max(0, result.bytesRead - (offset - readOffset));
          if (offset > 0) truncated = true;
          let start = 0;
          if (readOffset > 0) {
            const firstNewline = buffer.indexOf(10);
            if (firstNewline < 0) { endOffset = offset; continue; }
            start = firstNewline + 1;
          }
          while (start < result.bytesRead) {
            const newline = buffer.indexOf(10, start);
            if (newline < 0) break;
            const lineEnd = readOffset + newline + 1;
            const raw = buffer.subarray(start, newline).toString("utf8");
            start = newline + 1;
            if (lineEnd > endOffset || !raw.trim()) continue;
            let ref: IndexRef | undefined;
            try { ref = parseIndex(JSON.parse(raw), item.eventsPath, item.source); } catch { ref = undefined; }
            if (!ref) { incomplete = true; continue; }
            if (predicate(ref) && !ids.has(ref.eventId)) {
              if (refs.length >= Math.min(this.maxRetainedEvents, 32_000)) { truncated = true; break; }
              ids.add(ref.eventId);
              refs.push(ref);
            }
          }
          endOffset = offset;
        } catch { incomplete = true; break; }
      }
    }
    return { refs, incomplete, truncated, ends };
  }

  private async indexTimeBounds(path: string): Promise<{ min: number; max: number } | undefined> {
    try {
      const info = await stat(path);
      if (!info.size) return undefined;
      const handle = await open(path, "r");
      const read = async (offset: number, length: number): Promise<number[]> => {
        const buffer = Buffer.alloc(length);
        const result = await handle.read(buffer, 0, length, offset);
        const values: number[] = [];
        for (const raw of buffer.subarray(0, result.bytesRead).toString("utf8").split("\n")) {
          try { const time = Number((JSON.parse(raw) as Record<string, unknown>).timeMs); if (Number.isFinite(time)) values.push(time); } catch { /* partial line */ }
        }
        return values;
      };
      const head = await read(0, Math.min(8192, info.size));
      const tail = info.size > 8192 ? await read(Math.max(0, info.size - 8192), Math.min(8192, info.size)) : [];
      await handle.close();
      const values = [...head, ...tail];
      return values.length ? { min: Math.min(...values), max: Math.max(...values) } : undefined;
    } catch { return undefined; }
  }

  /** Seek to the first index line at or after a timestamp without reading the
   * whole NDJSON file. The replay scanner then walks backward from that byte. */
  private async seekIndexEnd(path: string, target: number): Promise<number> {
    try {
      const size = (await stat(path)).size;
      const handle = await open(path, "r");
      let low = 0, high = size, best = size;
      for (let attempt = 0; attempt < 24 && low < high; attempt++) {
        const midpoint = Math.floor((low + high) / 2);
        const length = Math.min(8192, size - midpoint);
        if (!length) break;
        const buffer = Buffer.alloc(length);
        const result = await handle.read(buffer, 0, length, midpoint);
        const firstNewline = buffer.indexOf(10);
        const start = firstNewline < 0 ? result.bytesRead : firstNewline + 1;
        let found = false;
        for (let cursor = start; cursor < result.bytesRead; ) {
          const newline = buffer.indexOf(10, cursor);
          if (newline < 0) break;
          try {
            const row = JSON.parse(buffer.subarray(cursor, newline).toString("utf8")) as Record<string, unknown>;
            const timeMs = Number(row.timeMs), offset = midpoint + cursor;
            if (Number.isFinite(timeMs)) {
              found = true;
              // Use an upper bound: all rows equal to the requested endpoint
              // must remain readable before the final time predicate filters.
              if (timeMs > target) { best = Math.min(best, midpoint + newline + 1); high = offset; }
              else low = midpoint + newline + 1;
              break;
            }
          } catch { /* malformed sample; advance to the next line */ }
          cursor = newline + 1;
        }
        if (!found) low = Math.min(size, midpoint + Math.max(1, result.bytesRead));
      }
      await handle.close();
      return best;
    } catch { return 0; }
  }

  private async readIndexedEvent(ref: IndexRef): Promise<BlackboxEvent> {
    if (!ref.length || ref.length > 64 * 1024 * 1024) throw new BlackboxHttpError(424, BLACKBOX_ERRORS.code.event_unavailable, "indexed event length is unavailable");
    const handle = await open(ref.eventsPath, "r").catch(() => { throw new BlackboxHttpError(424, BLACKBOX_ERRORS.code.event_unavailable, "indexed event file is unavailable"); });
    try {
      const buffer = Buffer.alloc(ref.length);
      const result = await handle.read(buffer, 0, ref.length, ref.offset);
      if (result.bytesRead !== ref.length) throw new BlackboxHttpError(424, BLACKBOX_ERRORS.code.event_unavailable, "indexed event is truncated");
      const event = parseEvent(JSON.parse(buffer.toString("utf8")));
      if (!event || event.eventId !== ref.eventId) throw new BlackboxHttpError(424, BLACKBOX_ERRORS.code.event_unavailable, "indexed event does not match its offset");
      return event;
    } catch (error) {
      if (error instanceof BlackboxHttpError) throw error;
      throw new BlackboxHttpError(424, BLACKBOX_ERRORS.code.event_unavailable, "indexed event cannot be decoded");
    } finally {
      await handle.close();
    }
  }

  private async readIndexedEvents(refs: IndexRef[]): Promise<BlackboxEvent[]> {
    const totalBytes = refs.reduce((sum, ref) => sum + ref.length, 0);
    if (totalBytes > this.maxScanBytes) throw new BlackboxHttpError(413, BLACKBOX_ERRORS.code.result_payload_limit_exceeded, "selected blackbox payload is too large");
    const events: BlackboxEvent[] = [];
    for (const ref of refs) events.push(await this.readIndexedEvent(ref));
    return events.sort(compare);
  }

  private async latestIndexRef(fileFilter: (path: string) => boolean, predicate: (ref: IndexRef) => boolean): Promise<{ ref?: IndexRef; incomplete: boolean }> {
    let latest: IndexRef | undefined;
    const budget: ScanBudget = { bytes: 0, lines: 0 };
    let incomplete = false;
    for await (const eventsPath of walk(await streamsRoot(this.root))) {
      if (!fileFilter(eventsPath)) continue;
      const source = segmentSource(eventsPath);
      if (!source) { incomplete = true; continue; }
      const path = indexPath(eventsPath);
      let input;
      try { input = createReadStream(path, { encoding: "utf8" }); } catch { incomplete = true; continue; }
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const rawLine of lines) {
          const line = String(rawLine);
          budget.lines += 1;
          budget.bytes += Buffer.byteLength(line, "utf8") + 1;
          if (budget.lines > this.maxIndexScanLines) throw scanLimitError(ScanLimitKinds.code.lines, budget.lines);
          if (budget.bytes > this.maxIndexScanBytes) throw scanLimitError(ScanLimitKinds.code.bytes, budget.bytes);
          if (!line.trim()) continue;
          let ref: IndexRef | undefined;
          try { ref = parseIndex(JSON.parse(line), eventsPath, source); } catch { ref = undefined; }
          if (!ref) { incomplete = true; continue; }
          if (predicate(ref) && (!latest || compareRef(ref, latest) > 0)) latest = ref;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") incomplete = true;
        else throw error;
      } finally {
        lines.close();
        input.destroy();
      }
    }
    return { ref: latest, incomplete };
  }

  private async scanFiles(fileFilter: (path: string) => boolean, onEvent: ScanEventCallback, onGap: ScanGapCallback = () => undefined): Promise<void> {
    const budget: ScanBudget = { bytes: 0, lines: 0 };
    for await (const file of walk(await streamsRoot(this.root))) {
      if (!fileFilter(file)) continue;
      const input = createReadStream(file, { encoding: "utf8" });
      const lines = createInterface({ input, crlfDelay: Infinity });
      let lineNumber = 0;
      try {
        for await (const rawLine of lines) {
          const line = String(rawLine);
          budget.lines += 1;
          budget.bytes += Buffer.byteLength(line, "utf8") + 1;
          if (budget.lines > this.maxScanLines) throw scanLimitError(ScanLimitKinds.code.lines, budget.lines);
          if (budget.bytes > this.maxScanBytes) throw scanLimitError(ScanLimitKinds.code.bytes, budget.bytes);
          lineNumber += 1;
          if (!line.trim()) continue;
          let event: BlackboxEvent | undefined;
          try { event = parseEvent(JSON.parse(line)); } catch { event = undefined; }
          if (!event) {
            onGap({ kind: EVENT_KINDS.code["recorder.malformed_event"], detail: `${basename(file)}:${lineNumber}` });
            continue;
          }
          // Callback failures, including explicit result/scan limits, must
          // reach the HTTP layer and must never become fake malformed gaps.
          onEvent(event, file);
        }
      } finally {
        lines.close();
        input.destroy();
      }
    }
  }

  private retain(target: BlackboxEvent[], ids: Set<string>, event: BlackboxEvent): void {
    if (ids.has(event.eventId)) return;
    if (target.length >= this.maxRetainedEvents) throw new BlackboxHttpError(413, BLACKBOX_ERRORS.code.result_limit_exceeded, "blackbox result retention limit exceeded");
    ids.add(event.eventId);
    target.push(event);
  }

  private assertMap(mapId: string): void {
    if (!mapId || mapId.length > 120 || /[\r\n]/.test(mapId)) throw new BlackboxHttpError(400, BLACKBOX_ERRORS.code.invalid_map_id, "mapId is required");
  }

  private asOf(value?: number): number {
    const now = Date.now();
    if (value == null) return now;
    if (!Number.isFinite(value) || value < 0) throw new BlackboxHttpError(400, BLACKBOX_ERRORS.code.invalid_as_of, "asOf must be a non-negative millisecond timestamp");
    return Math.min(Math.trunc(value), now);
  }

  private async assertHistoricalAssets(checkpoint: BlackboxEvent): Promise<void> {
    const payload = checkpoint.payload as Record<string, unknown>;
    if (typeof payload.assetCaptureError === "string" || payload.assetCaptureGap === true) throw new BlackboxHttpError(424, BLACKBOX_ERRORS.code.historical_asset_unavailable, "historical frame asset capture failed");
    const descriptor = payload.assets;
    if (!descriptor || typeof descriptor !== "object") throw new BlackboxHttpError(424, BLACKBOX_ERRORS.code.historical_asset_unavailable, "historical frame assets are missing");
    const item = descriptor as Record<string, unknown>;
    if (typeof item.mapUrl !== "string") throw new BlackboxHttpError(424, BLACKBOX_ERRORS.code.historical_asset_unavailable, "historical map asset is missing");
    for (const url of [item.mapUrl, item.occupancyUrl, item.inflatedUrl].filter((value): value is string => typeof value === "string")) {
      const match = /^\/api\/blackbox\/assets\/([a-f0-9]{64})\/([a-zA-Z0-9._-]+)$/.exec(url);
      if (!match) throw new BlackboxHttpError(424, BLACKBOX_ERRORS.code.historical_asset_unavailable, "checkpoint does not reference a copied historical asset");
      try {
        await this.assetPath(match[1], match[2]);
      } catch (error) {
        if (error instanceof BlackboxHttpError && error.code === BLACKBOX_ERRORS.code.asset_not_found) throw new BlackboxHttpError(424, BLACKBOX_ERRORS.code.historical_asset_unavailable, "historical checkpoint asset is missing");
        throw error;
      }
    }
  }
}

function replayEvent(event: BlackboxEvent): boolean {
  return REPLAY.has(event.category) && (event.category !== "frame" || isAuthoritativeBlackboxFrameSource(event.source));
}

function replayRef(ref: IndexRef): boolean {
  return REPLAY.has(ref.category) && (ref.category !== "frame" || isAuthoritativeBlackboxFrameSource(ref.source));
}

export { DAY_MS, DEFAULT_MAX_SCAN_BYTES, DEFAULT_MAX_SCAN_LINES, MEANINGFUL };
