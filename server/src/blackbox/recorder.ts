import { EVENT_KINDS } from "../../../shared/config/events.ts";
import { BLACKBOX_CONFIRMATIONS, BLACKBOX_SCOPES } from "../../../shared/config/blackbox.ts";
import { BLACKBOX_ERRORS } from "../../../shared/config/reasons.ts";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLACKBOX_SCHEMA_VERSION,
  type BlackboxAssetDescriptor,
  type BlackboxEvent,
  type BlackboxEventInput,
  type BlackboxFramePayload,
  type BlackboxRecorder,
  type BlackboxRecorderOptions,
  type BlackboxGeneration,
  type BlackboxResetConfirmation,
  type BlackboxResetResult,
} from "../../../shared/blackbox.ts";
import { LEGACY_GENERATION, newGeneration, readGeneration, withMutationLock, writeGeneration } from "./generation.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(here, "../../..");
const DEFAULT_DATA_ROOT = process.env.FMS_DATA_ROOT || join(PROJECT_ROOT, "data");
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 7 * DAY_MS;
// Quota is deliberately 2 GiB per source's closed stream segments. There is
// no racy global 10 GiB hard limit here: copied assets are shared immutable
// resources and are not pruned by an individual recorder.
const MAX_PROCESS_STREAM_BYTES = 2 * 1024 * 1024 * 1024;
const PRUNE_INTERVAL_MS = 60 * 1000;
const SECRET_KEY = /(password|passwd|token|secret|authorization|cookie|privatekey|api[_-]?key)/i;

type Segment = {
  date: string;
  number: number;
  eventsPath: string;
  indexPath: string;
  bytes: number;
  events: number;
};
type QueuedEvent = { event: BlackboxEvent; generation: string };
const recorders = new Set<Recorder>();

export type RecorderHealth = {
  source: string;
  bootId: string;
  queued: number;
  written: number;
  dropped: number;
  lastError?: string;
  closed: boolean;
};

function slug(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

function cloneJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return undefined;
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);
  try {
    if (Array.isArray(value)) return value.map((item) => cloneJson(item, seen));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : cloneJson(item, seen);
    }
    return out;
  } finally {
    // Only an object on the current recursion path is a cycle. Repeated
    // references in sibling fields are valid data and must be cloned twice.
    seen.delete(value as object);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isAssetDescriptor(value: unknown): value is BlackboxAssetDescriptor {
  const item = asRecord(value);
  return !!item && typeof item.mapUrl === "string" && Number.isFinite(Number(item.width)) && Number.isFinite(Number(item.height)) && Number.isFinite(Number(item.pixelCm));
}

function assetDescriptorFromState(state: Record<string, unknown>): BlackboxAssetDescriptor | undefined {
  const candidates = [state.assets, state.mapAssets, state.assetDescriptor];
  return candidates.find(isAssetDescriptor);
}

function datePart(timeMs: number): string {
  return new Date(timeMs).toISOString().slice(0, 10);
}

function fileNameFromUrl(value: string, fallback: string): string {
  try {
    const pathname = value.startsWith("file:") ? new URL(value).pathname : value.split("?")[0].split("#")[0];
    const name = pathname.split(/[\\/]/).pop() || fallback;
    const clean = name.replace(/[^a-zA-Z0-9._-]/g, "_");
    return clean || fallback;
  } catch {
    return fallback;
  }
}

async function sourceBytes(value: string): Promise<Uint8Array> {
  if (/^https?:\/\//i.test(value)) {
    const response = await fetch(value);
    if (!response.ok) throw new Error(`asset fetch failed: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  return new Uint8Array(await readFile(localSourcePath(value)));
}

function localSourcePath(value: string): string {
  if (value.startsWith("file:")) return fileURLToPath(value);
  if (value.startsWith("/resources/")) return join(PROJECT_ROOT, value.slice(1));
  if (value.startsWith("resources/")) return join(PROJECT_ROOT, value);
  return value.startsWith("/") ? value : resolve(PROJECT_ROOT, value);
}

async function assetCacheKey(value: string, mapRevision?: string): Promise<string> {
  if (/^https?:\/\//i.test(value)) return `remote|${value}|${mapRevision || ""}`;
  const path = localSourcePath(value);
  const info = await stat(path);
  return `file|${path}|${info.mtimeMs}|${info.size}|${mapRevision || ""}`;
}

function relatedOperationIdsForIndex(event: BlackboxEvent): string[] | undefined {
  const direct = event.payload.relatedOperationIds;
  const request = asRecord(event.payload.request)?.relatedOperationIds;
  const values = Array.isArray(direct) ? direct : Array.isArray(request) ? request : undefined;
  const ids = values?.filter((value): value is string => typeof value === "string");
  return ids?.length ? ids : undefined;
}

export class Recorder implements BlackboxRecorder {
  readonly source: string;
  readonly mapId: string;
  readonly bootId = randomUUID();
  readonly root: string;

  private readonly maxQueue = 4096;
  private readonly maxSegmentBytes = 64 * 1024 * 1024;
  private readonly maxSegmentEvents = 10_000;
  private sequence = 0;
  private queue: QueuedEvent[] = [];
  private running = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private ready: Promise<void>;
  private segment: Segment | undefined;
  private dropped = 0;
  private written = 0;
  private lastError: string | undefined;
  private idleWaiters: Array<() => void> = [];
  private readonly assetCopies = new Map<string, Promise<string>>();
  private activeMarker: string;
  private generation: BlackboxGeneration = LEGACY_GENERATION;
  private lastFrameState: Record<string, unknown> | undefined;
  private streamRoot: string;
  private assetRoot: string;
  private generationWatchTimer: ReturnType<typeof setInterval> | undefined;
  private pendingGeneration: BlackboxGeneration | undefined;
  private lastPruneMs = 0;

  constructor(options: BlackboxRecorderOptions) {
    this.source = slug(options.source);
    this.mapId = options.mapId;
    this.root = options.root || join(DEFAULT_DATA_ROOT, "blackbox");
    this.streamRoot = join(this.root, "streams");
    this.assetRoot = join(this.root, "assets");
    this.activeMarker = join(this.streamRoot, ".active", this.source, this.bootId);
    recorders.add(this);
    this.ready = this.initialize();
  }

  record(input: BlackboxEventInput): BlackboxEvent | undefined {
    if (this.closed) return undefined;
    const timeMs = input.timeMs ?? Date.now();
    if (!input || !Number.isFinite(timeMs) || !input.category || !input.kind || !input.payload) return undefined;
    if (this.queue.length >= this.maxQueue) {
      this.dropped += 1;
      return undefined;
    }
    // A pending overflow marker must be assigned and enqueued before the
    // next accepted event, otherwise its larger sequence would appear before
    // the event that has the smaller sequence. Leave the marker pending when
    // only one queue slot remains so the accepted event never exceeds bounds.
    this.enqueueGapIfNeeded(timeMs);
    const event: BlackboxEvent = {
      schemaVersion: BLACKBOX_SCHEMA_VERSION,
      eventId: randomUUID(),
      timeMs: Math.trunc(timeMs),
      sequence: ++this.sequence,
      source: this.source,
      bootId: this.bootId,
      mapId: this.mapId,
      category: input.category,
      kind: input.kind,
      ...(input.robotId ? { robotId: input.robotId } : {}),
      ...(input.operationId ? { operationId: input.operationId } : {}),
      ...(input.commandId ? { commandId: input.commandId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      payload: (cloneJson(input.payload) || {}) as Record<string, unknown>,
    };
    this.queue.push({ event, generation: this.generation.id });
    this.pump();
    return event;
  }

  frame(state: Record<string, unknown>): void {
    const safeState = (cloneJson(state) || {}) as Record<string, unknown>;
    this.lastFrameState = safeState;
    const assets = assetDescriptorFromState(safeState);
    const payload: BlackboxFramePayload = { state: safeState };
    if (assets) payload.assets = assets;
    this.record({ timeMs: Date.now(), category: "frame", kind: EVENT_KINDS.code["scene.snapshot"], payload });
  }

  health(): RecorderHealth {
    return {
      source: this.source,
      bootId: this.bootId,
      queued: this.queue.length,
      written: this.written,
      dropped: this.dropped,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      closed: this.closed,
    };
  }

  async flush(): Promise<void> {
    await this.ready;
    this.pump();
    if (!this.running && this.queue.length === 0) return;
    await new Promise<void>((resolvePromise) => this.idleWaiters.push(resolvePromise));
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      await this.ready;
      await this.flush();
      this.closed = true;
      if (this.generationWatchTimer) clearInterval(this.generationWatchTimer);
      if (this.dropped > 0) {
        const dropped = this.dropped;
        this.dropped = 0;
        this.queue.push({ event: {
          schemaVersion: BLACKBOX_SCHEMA_VERSION,
          eventId: randomUUID(),
          timeMs: Date.now(),
          sequence: ++this.sequence,
          source: this.source,
          bootId: this.bootId,
          mapId: this.mapId,
          category: "gap",
          kind: EVENT_KINDS.code["recorder.write_loss"],
          payload: { dropped, detail: this.lastError || "events could not be persisted" },
        }, generation: this.generation.id });
        this.pump();
      }
      await this.flush();
      await unlink(this.activeMarker).catch(() => undefined);
      recorders.delete(this);
    })();
    return this.closePromise;
  }

  private enqueueGapIfNeeded(timeMs: number): void {
    if (!this.dropped || this.queue.length >= this.maxQueue - 1) return;
    const dropped = this.dropped;
    this.dropped = 0;
    this.queue.push({ event: {
      schemaVersion: BLACKBOX_SCHEMA_VERSION,
      eventId: randomUUID(),
      timeMs,
      sequence: ++this.sequence,
      source: this.source,
      bootId: this.bootId,
      mapId: this.mapId,
      category: "gap",
      kind: EVENT_KINDS.code["recorder.queue_overflow"],
      payload: { dropped, detail: "events dropped while recorder queue was full" },
    }, generation: this.generation.id });
  }

  private pump(): void {
    if (this.running) return;
    this.running = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    try {
      await this.ready;
      while (this.queue.length) {
        const queued = this.queue.shift()!;
        try {
          const current = await readGeneration(this.root);
          if (current.id !== queued.generation) {
            this.requestGeneration(current);
            continue;
          }
          const taskAssetRoot = this.assetRoot;
          const prepared = await this.prepareEvent(queued.event, queued.generation, taskAssetRoot);
          // Asset capture can take seconds. Recheck the generation after it
          // completes so an in-flight old frame cannot be appended after reset.
          const afterPrepare = await readGeneration(this.root);
          if (afterPrepare.id !== queued.generation) {
            this.requestGeneration(afterPrepare);
            continue;
          }
          await this.writeEvent(prepared, queued.generation);
          this.written += 1;
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.dropped += 1;
        }
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.dropped += this.queue.length;
      this.queue = [];
    } finally {
      this.running = false;
      if (this.pendingGeneration && this.pendingGeneration.id !== this.generation.id) {
        const pending = this.pendingGeneration;
        this.pendingGeneration = undefined;
        this.invalidateGeneration(pending);
      }
      if (this.queue.length) this.pump();
      else {
        const waiters = this.idleWaiters.splice(0);
        for (const resolvePromise of waiters) resolvePromise();
      }
    }
  }

  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    this.generation = await readGeneration(this.root);
    this.setStorageRoots();
    await mkdir(this.streamRoot, { recursive: true });
    await mkdir(this.assetRoot, { recursive: true });
    await mkdir(dirname(this.activeMarker), { recursive: true });
    await this.updateActiveMarker();
    this.generationWatchTimer = setInterval(() => { void this.watchGeneration(); }, 250);
    this.generationWatchTimer.unref?.();
    await this.pruneRetentionIfDue(true);
  }

  private async watchGeneration(): Promise<void> {
    if (this.closed) return;
    const current = await readGeneration(this.root);
    if (current.id !== this.generation.id) this.requestGeneration(current);
  }

  private setStorageRoots(): void {
    const base = this.generation.id === LEGACY_GENERATION.id ? this.root : join(this.root, "generations", this.generation.id);
    this.streamRoot = join(base, "streams");
    this.assetRoot = join(base, "assets");
    this.activeMarker = join(this.streamRoot, ".active", this.source, this.bootId);
  }

  /** Reset invalidation is called only after the reset barrier has drained. */
  invalidateGeneration(generation: BlackboxGeneration): void {
    this.generation = generation;
    this.segment = undefined;
    this.queue = [];
    this.assetCopies.clear();
    this.setStorageRoots();
    // A reset must leave the new generation replayable even when the room has
    // not emitted a state change since the previous checkpoint.
    if (this.lastFrameState && !this.closed) this.frame(this.lastFrameState);
  }

  requestGeneration(generation: BlackboxGeneration): void {
    if (this.running) { this.pendingGeneration = generation; return; }
    this.invalidateGeneration(generation);
  }

  private async prepareEvent(event: BlackboxEvent, generation: string, assetRoot: string): Promise<BlackboxEvent> {
    if (event.category !== "frame") return event;
    const payload = (cloneJson(event.payload) || {}) as Record<string, unknown>;
    const state = asRecord(payload.state);
    const descriptor = isAssetDescriptor(payload.assets) ? payload.assets : state && assetDescriptorFromState(state);
    if (descriptor) {
      // FloorState.toJSON() may carry the same live /resources URLs under the
      // raw state as well as payload.assets. Keep the raw scene state clean;
      // the only asset source exposed to replay is the copied descriptor.
      if (state) {
        delete state.assets;
        delete state.mapAssets;
        delete state.assetDescriptor;
      }
      try {
        payload.assets = await this.copyAssets(descriptor, generation, assetRoot);
      } catch {
        // Never leave a live /resources URL in a replay checkpoint. The
        // query layer treats this marker as an unavailable historical asset.
        delete payload.assets;
        payload.assetCaptureError = BLACKBOX_ERRORS.code.historical_asset_copy_failed;
        payload.assetCaptureGap = true;
      }
    }
    return { ...event, payload };
  }

  private async copyAssets(descriptor: BlackboxAssetDescriptor, generation: string, assetRoot: string): Promise<BlackboxAssetDescriptor> {
    const copy = async (url: string, fallback: string): Promise<string> => {
      const key = await assetCacheKey(url, descriptor.mapRevision);
      const cached = this.assetCopies.get(key);
      if (cached) return cached;
      const pending = (async () => {
        const initialGeneration = await readGeneration(this.root);
        if (initialGeneration.id !== generation) throw new Error("blackbox generation changed");
        const bytes = await sourceBytes(url);
        const hash = createHash("sha256").update(bytes).digest("hex");
        const name = fileNameFromUrl(url, fallback);
        return await withMutationLock(this.root, async () => {
          const currentGeneration = await readGeneration(this.root);
          if (currentGeneration.id !== generation) throw new Error("blackbox generation changed");
          const dir = join(assetRoot, hash);
          const target = join(dir, name);
          await mkdir(dir, { recursive: true });
          try { await writeFile(target, bytes, { flag: "wx" }); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
          await writeFile(join(dir, "manifest.json"), JSON.stringify({ hash, filename: name, bytes: bytes.byteLength }) + "\n", { flag: "wx" }).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          });
          return `/api/blackbox/assets/${hash}/${name}`;
        });
      })();
      this.assetCopies.set(key, pending);
      try {
        return await pending;
      } catch (error) {
        if (this.assetCopies.get(key) === pending) this.assetCopies.delete(key);
        throw error;
      }
    };
    const result: BlackboxAssetDescriptor = {
      ...descriptor,
      mapUrl: await copy(descriptor.mapUrl, "map" + (extname(descriptor.mapUrl) || ".bin")),
    };
    if (descriptor.occupancyUrl) result.occupancyUrl = await copy(descriptor.occupancyUrl, "occupancy.bin");
    if (descriptor.inflatedUrl) result.inflatedUrl = await copy(descriptor.inflatedUrl, "inflated.bin");
    return result;
  }

  private async writeEvent(event: BlackboxEvent, generation: string): Promise<void> {
    await withMutationLock(this.root, async () => {
      const current = await readGeneration(this.root);
      if (current.id !== generation) throw new Error("blackbox generation changed");
      const date = datePart(event.timeMs);
      if (!this.segment || this.segment.date !== date || this.segment.events >= this.maxSegmentEvents || this.segment.bytes >= this.maxSegmentBytes) {
        this.segment = await this.nextSegment(date);
      }
      const line = JSON.stringify(event) + "\n";
      const bytes = Buffer.byteLength(line);
      const offset = this.segment.bytes;
      await appendFile(this.segment.eventsPath, line, "utf8");
      await appendFile(this.segment.indexPath, JSON.stringify({ eventId: event.eventId, timeMs: event.timeMs, sequence: event.sequence, offset, length: bytes, mapId: event.mapId, category: event.category, kind: event.kind, robotId: event.robotId, level: typeof event.payload.level === "string" ? event.payload.level : undefined, operationId: event.operationId, relatedOperationIds: relatedOperationIdsForIndex(event) }) + "\n", "utf8");
      this.segment.bytes += bytes;
      this.segment.events += 1;
    });
  }

  private async nextSegment(date: string): Promise<Segment> {
    await this.pruneRetentionIfDue();
    const dir = join(this.streamRoot, date, this.source, this.bootId);
    await mkdir(dir, { recursive: true });
    const entries = await readdir(dir);
    const numbers = entries.map((entry) => /^segment-(\d{6})\.events\.ndjson$/.exec(entry)?.[1]).filter(Boolean).map(Number);
    const number = (numbers.length ? Math.max(...numbers) + 1 : 1);
    const prefix = `segment-${String(number).padStart(6, "0")}`;
    const eventsPath = join(dir, `${prefix}.events.ndjson`);
    const indexPath = join(dir, `${prefix}.index.ndjson`);
    await this.updateActiveMarker(eventsPath);
    return { date, number, eventsPath, indexPath, bytes: 0, events: 0 };
  }

  private async updateActiveMarker(activeSegment?: string): Promise<void> {
    const temporary = `${this.activeMarker}.tmp`;
    await mkdir(dirname(this.activeMarker), { recursive: true });
    await writeFile(temporary, JSON.stringify({ source: this.source, bootId: this.bootId, pid: process.pid, createdAt: Date.now(), activeSegment: activeSegment || null }) + "\n");
    await rename(temporary, this.activeMarker);
  }

  private async pruneRetentionIfDue(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastPruneMs < PRUNE_INTERVAL_MS) return;
    this.lastPruneMs = now;
    const cutoff = Date.now() - RETENTION_MS;
    const files: Array<{ path: string; mtimeMs: number; size: number; pair: string }> = [];
    const activeSegments = new Set<string>();
    const protectedBoots = new Set<string>();
    try {
      const entries = await readdir(join(this.streamRoot, ".active", this.source), { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean }>;
      for (const entry of entries) {
        if (entry.isDirectory()) continue;
        const marker = join(this.streamRoot, ".active", this.source, entry.name);
        try {
          const content = JSON.parse(await readFile(marker, "utf8")) as { activeSegment?: unknown };
          if (typeof content.activeSegment === "string" && content.activeSegment) activeSegments.add(resolve(content.activeSegment));
          else protectedBoots.add(entry.name);
        } catch {
          // A stale/corrupt marker is protected conservatively until operator
          // cleanup; never prune another worker's possibly-open segment.
          protectedBoots.add(entry.name);
        }
      }
    } catch { /* no active marker directory yet */ }
    const visit = async (dir: string): Promise<void> => {
      let entries: Array<{ name: string; isDirectory(): boolean }>;
      try { entries = await readdir(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean }>; } catch { return; }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.name.endsWith(".events.ndjson") || entry.name.endsWith(".index.ndjson")) {
          const owner = /[\\/]streams[\\/]\d{4}-\d{2}-\d{2}[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/]/.exec(path);
          if (!owner || owner[1] !== this.source) continue;
          const normalized = resolve(path);
          const pair = path.replace(/\.(events|index)\.ndjson$/, ".segment");
          const activePair = [...activeSegments].some((segment) => segment.replace(/\.events\.ndjson$/, ".segment") === pair || segment.replace(/\.index\.ndjson$/, ".segment") === pair);
          if (activePair || protectedBoots.has(owner[2])) continue;
          const info = await stat(path);
          files.push({ path, mtimeMs: info.mtimeMs, size: info.size, pair });
        }
      }
    };
    await visit(this.streamRoot);
    const groups = new Map<string, typeof files>();
    for (const file of files) groups.set(file.pair, [...(groups.get(file.pair) || []), file]);
    const removeGroup = async (group: typeof files): Promise<void> => { for (const file of group) await unlink(file.path).catch(() => undefined); };
    for (const group of groups.values()) if (group.every((file) => file.mtimeMs < cutoff)) await removeGroup(group);
    const remaining = [...groups.values()].filter((group) => group.some((file) => file.mtimeMs >= cutoff)).sort((a, b) => Math.min(...a.map((file) => file.mtimeMs)) - Math.min(...b.map((file) => file.mtimeMs)));
    let total = remaining.reduce((sum, group) => sum + group.reduce((groupTotal, file) => groupTotal + file.size, 0), 0);
    for (const group of remaining) {
      if (total <= MAX_PROCESS_STREAM_BYTES) break;
      await removeGroup(group);
      total -= group.reduce((groupTotal, file) => groupTotal + file.size, 0);
    }
  }
}

/**
 * Atomically starts a new blackbox generation. Generation scoped paths are the
 * visibility and writer barrier: old processes can finish in their old tree,
 * but neither readers nor new writers can observe it as current.
 */
export async function resetBlackbox(root: string, confirmation: BlackboxResetConfirmation): Promise<BlackboxResetResult> {
  if (!confirmation || confirmation.confirmationToken !== BLACKBOX_CONFIRMATIONS.code.BLACKBOX_RESET || confirmation.scope !== BLACKBOX_SCOPES.code.blackbox) {
    throw new Error("explicit blackbox confirmation is required");
  }
  const target = resolve(root);
  const owned = [...recorders].filter(recorder => resolve(recorder.root) === target);
  return withMutationLock(target, async () => {
    const generation = newGeneration();
    // Advance visibility while holding the same lock used by final asset and
    // event writes. Stale writers can finish downloads, but cannot commit.
    await writeGeneration(target, generation);
    const archive = join(target, `.reset-${Date.now()}-${randomUUID()}`);
    await mkdir(archive, { recursive: true });
    const moveIfPresent = async (from: string, to: string): Promise<void> => {
      try { await rename(from, to); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };
    await moveIfPresent(join(target, "streams"), join(archive, "streams"));
    await moveIfPresent(join(target, "assets"), join(archive, "assets"));
    await rm(join(target, "generations"), { recursive: true, force: true });
    await mkdir(join(target, "generations", generation.id, "streams"), { recursive: true });
    await mkdir(join(target, "generations", generation.id, "assets"), { recursive: true });
    for (const recorder of owned) recorder.requestGeneration(generation);
    let cleanupComplete = true;
    let cleanupError: string | undefined;
    try { await rm(archive, { recursive: true, force: true }); } catch (error) { cleanupComplete = false; cleanupError = error instanceof Error ? error.message : String(error); }
    return { generation, cleared: true, cleanupComplete, ...(cleanupError ? { cleanupError } : {}) };
  });
}

export { DEFAULT_DATA_ROOT };
