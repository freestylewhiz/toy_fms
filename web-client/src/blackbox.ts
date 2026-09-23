import { snapshotFromState, type Snapshot } from "./snapshot.ts";
import type {
  BlackboxAssetDescriptor,
  BlackboxCategory,
  BlackboxEvent,
  BlackboxEventQuery,
  BlackboxGap,
  BlackboxOperationQuery,
  BlackboxReplayQuery,
} from "../../shared/blackbox.ts";
import { BLACKBOX_CONFIRMATIONS, BLACKBOX_SCOPES, EVENT_CATEGORIES, ReplayStatuses, ViewSources, type ReplayStatus, type ViewSource } from "../../shared/config/index.ts";

export type { BlackboxAssetDescriptor, BlackboxCategory, BlackboxEvent, BlackboxGap } from "../../shared/blackbox.ts";
export type HistoricalAssets = BlackboxAssetDescriptor;

export type BlackboxUpdate = {
  source: Extract<ViewSource, "live" | "blackbox">;
  generation: number;
  snapshot?: Snapshot;
  assets?: HistoricalAssets;
  event?: BlackboxEvent;
  clockMs?: number;
  status?: ReplayStatus;
  error?: string;
};

export type BlackboxReplayResponse = BlackboxReplayQuery;
export type BlackboxCandidatesResponse = BlackboxEventQuery;
export type BlackboxOperationResponse = BlackboxOperationQuery;
export type BlackboxOperationTraceResponse = BlackboxOperationQuery & {
  generation?: string;
  gap?: boolean;
  truncated?: boolean;
  reason?: string;
  missingEvents?: number;
};
export type BlackboxWindowResponse = {
  asOf?: number;
  mapId?: string;
  fromMs?: number;
  toMs?: number;
  startEvent?: BlackboxEvent;
  endEvent?: BlackboxEvent;
  checkpoint?: BlackboxEvent;
  events?: BlackboxEvent[];
  gaps?: BlackboxGap[];
  nextCursor?: string;
  gap?: boolean;
  truncated?: boolean;
  assets?: HistoricalAssets;
};
export type BlackboxCatalogResponse = {
  asOf?: number;
  availableFrom?: number;
  availableTo?: number;
  generation?: { id?: string; createdAt?: number } | string;
  maps?: Array<{ mapId?: string; id?: string; latestTimeMs?: number; earliestTimeMs?: number; eventCount?: number }>;
  latest?: Record<string, unknown>;
};

export type ChannelListener = (update: BlackboxUpdate) => void;

export interface EventChannel {
  readonly source: Extract<ViewSource, "live" | "blackbox">;
  readonly generation: number;
  subscribe(listener: ChannelListener): () => void;
  dispose(): void;
}

const MEANINGFUL_CATEGORIES = new Set<BlackboxCategory>([
  EVENT_CATEGORIES.code.operation,
  EVENT_CATEGORIES.code.error,
  EVENT_CATEGORIES.code.forced,
  EVENT_CATEGORIES.code.environment,
  EVENT_CATEGORIES.code.connection,
]);

function eventOrder(a: BlackboxEvent, b: BlackboxEvent): number {
  return Number(a.timeMs ?? 0) - Number(b.timeMs ?? 0) || Number(a.sequence ?? 0) - Number(b.sequence ?? 0) || a.eventId.localeCompare(b.eventId);
}

function asError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function frameOf(event: BlackboxEvent): { snapshot?: Snapshot; assets?: HistoricalAssets } {
  if (event.category !== "frame" || !event.payload || typeof event.payload !== "object") return {};
  const state = event.payload.state;
  const stateAssets = state && typeof state === "object" ? (state as Record<string, unknown>).assets : undefined;
  const assets = event.payload.assets ?? stateAssets;
  return {
    snapshot: state && typeof state === "object" ? snapshotFromState(state as Record<string, unknown>) : undefined,
    assets: assets && typeof assets === "object" ? assets as HistoricalAssets : undefined,
  };
}

export function meaningfulBlackboxEvent(event: BlackboxEvent): boolean {
  return MEANINGFUL_CATEGORIES.has(event.category);
}

export class LiveEventChannel implements EventChannel {
  readonly source = ViewSources.code.live;
  private listeners = new Set<ChannelListener>();
  private _generation = 0;
  private _snapshot: Snapshot | undefined;

  get generation(): number { return this._generation; }
  get snapshot(): Snapshot | undefined { return this._snapshot; }

  subscribe(listener: ChannelListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(snapshot: Snapshot, status: BlackboxUpdate["status"] = ReplayStatuses.code.ready): void {
    this._snapshot = snapshot;
    const update: BlackboxUpdate = { source: ViewSources.code.live, generation: this._generation, snapshot, status };
    for (const listener of this.listeners) listener(update);
  }

  invalidate(): void {
    this._generation += 1;
  }

  dispose(): void {
    this._generation += 1;
    this.listeners.clear();
    this._snapshot = undefined;
  }
}

export class ReplayClock {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastWallMs = 0;
  private _cursorMs = 0;
  private _speed = 1;
  private _playing = false;

  get cursorMs(): number { return this._cursorMs; }
  get speed(): number { return this._speed; }
  get playing(): boolean { return this._playing; }

  set(cursorMs: number): void { this._cursorMs = Number.isFinite(cursorMs) ? cursorMs : 0; }
  setSpeed(speed: number): void { this._speed = Math.max(0.25, Math.min(4, speed)); }
  pause(): void { this._playing = false; if (this.timer) clearTimeout(this.timer); this.timer = null; }

  play(untilMs: number, tick: (cursorMs: number) => void, done: () => void): void {
    this.pause();
    this._playing = true;
    this.lastWallMs = performance.now();
    const loop = () => {
      if (!this._playing) return;
      const now = performance.now();
      this._cursorMs += (now - this.lastWallMs) * this._speed;
      this.lastWallMs = now;
      if (this._cursorMs >= untilMs) {
        this._cursorMs = untilMs;
        tick(this._cursorMs);
        this.pause();
        done();
        return;
      }
      tick(this._cursorMs);
      this.timer = setTimeout(loop, 33);
    };
    this.timer = setTimeout(loop, 0);
  }

  dispose(): void { this.pause(); }
}

export class BlackboxEventChannel implements EventChannel {
  readonly source = ViewSources.code.blackbox;
  private listeners = new Set<ChannelListener>();
  private _generation = 0;
  private _snapshot: Snapshot | undefined;
  private _assets: HistoricalAssets | undefined;
  private _events: BlackboxEvent[] = [];
  private _candidates: BlackboxEvent[] = [];
  private _gaps: BlackboxGap[] = [];
  private _cursorIndex = 0;
  private _replay: BlackboxReplayResponse | undefined;
  private _error = "";
  private cursor = "";
  private candidateGeneration = 0;
  private readonly clock = new ReplayClock();
  private _serverGenerationId = "";
  private replayFromMs = 0;
  private replayToMs = 0;

  constructor(private readonly apiBase = "/api/blackbox") {}

  get generation(): number { return this._generation; }
  get snapshot(): Snapshot | undefined { return this._snapshot; }
  get assets(): HistoricalAssets | undefined { return this._assets; }
  get error(): string { return this._error; }
  get gaps(): BlackboxGap[] { return this._gaps; }
  get replay(): BlackboxReplayResponse | undefined { return this._replay; }
  get clockMs(): number { return this.clock.cursorMs; }
  get replayStartMs(): number { return this.replayFromMs || Number(this._replay?.startEvent.timeMs ?? 0); }
  get replayEndMs(): number { return this.replayToMs || Number(this._replay?.endEvent.timeMs ?? this.replayStartMs); }
  get playing(): boolean { return this.clock.playing; }
  get events(): BlackboxEvent[] { return this._events; }
  get candidates(): BlackboxEvent[] { return this._candidates; }
  get hasMoreCandidates(): boolean { return Boolean(this.cursor); }
  get serverGenerationId(): string { return this._serverGenerationId; }

  subscribe(listener: ChannelListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(update: Omit<BlackboxUpdate, "source" | "generation"> = {}): void {
    const full: BlackboxUpdate = { source: ViewSources.code.blackbox, generation: this._generation, ...update };
    for (const listener of this.listeners) listener(full);
  }

  private beginGeneration(): number {
    this._generation += 1;
    this.clock.pause();
    this._error = "";
    return this._generation;
  }

  async loadCandidates(mapId: string, asOf = Date.now(), reset = false): Promise<{ asOf: number; events: BlackboxEvent[]; nextCursor?: string }> {
    if (reset) { this.candidateGeneration += 1; this.cursor = ""; this._candidates = []; }
    const candidateGeneration = this.candidateGeneration;
    const params = new URLSearchParams({ mapId, asOf: String(asOf) });
    if (this.cursor) params.set("cursor", this.cursor);
    const response = await fetch(`${this.apiBase}/events?${params}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`블랙박스 이벤트 조회 실패 (${response.status})`);
    const body = await response.json() as BlackboxCandidatesResponse;
    if (candidateGeneration !== this.candidateGeneration) return { asOf, events: this._candidates };
    const meaningful = (body.events ?? []).filter(meaningfulBlackboxEvent).sort(eventOrder);
    const ids = new Set(this._candidates.map(event => event.eventId));
    this._candidates.push(...meaningful.filter(event => !ids.has(event.eventId)));
    this._candidates.sort(eventOrder);
    this.cursor = body.nextCursor ?? "";
    return { asOf: Number(body.asOf ?? asOf), events: this._candidates, nextCursor: body.nextCursor };
  }

  async loadCatalog(mapId?: string, asOf = Date.now()): Promise<BlackboxCatalogResponse> {
    const params = new URLSearchParams({ asOf: String(asOf) });
    if (mapId) params.set("mapId", mapId);
    const response = await fetch(`${this.apiBase}/catalog?${params}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`블랙박스 기록 목록 조회 실패 (${response.status})`);
    const body = await response.json() as BlackboxCatalogResponse;
    const generation = typeof body.generation === "string" ? body.generation : body.generation?.id;
    if (generation) this._serverGenerationId = generation;
    return body;
  }

  async loadGeneration(): Promise<string> {
    const response = await fetch(`${this.apiBase}/generation`, { cache: "no-store" });
    if (!response.ok) throw new Error(`블랙박스 세대 조회 실패 (${response.status})`);
    const body = await response.json() as { generation?: { id?: string } | string };
    const generation = typeof body.generation === "string" ? body.generation : body.generation?.id;
    if (generation) this._serverGenerationId = generation;
    return this._serverGenerationId;
  }

  async loadWindow(mapId: string, fromMs: number | undefined, toMs: number, asOf = toMs, reset = true): Promise<{ asOf: number; events: BlackboxEvent[]; nextCursor?: string; replayAvailable: boolean }> {
    const generation = ++this.candidateGeneration;
    this.clock.pause();
    this._error = "";
    if (reset) {
      this.cursor = ""; this._candidates = [];
      this._snapshot = undefined; this._assets = undefined; this._replay = undefined; this._events = []; this._gaps = [];
      this.replayFromMs = 0; this.replayToMs = 0;
    }
    let cursor = !reset ? this.cursor : "";
    let body: BlackboxWindowResponse = {};
    let queryFromMs = fromMs;
    let queryToMs = toMs;
    const allEvents: BlackboxEvent[] = [];
    const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
    const MAX_EVENTS = 10_000;
    let responseBytes = 0;
    let serverGap = false;
    let serverTruncated = false;
    for (let page = 0; page < 64; page += 1) {
      const params = new URLSearchParams({ mapId, toMs: String(Math.max(0, Math.trunc(queryToMs))), asOf: String(Math.max(0, Math.trunc(asOf))), limit: "500" });
      if (queryFromMs != null) params.set("fromMs", String(Math.max(0, Math.trunc(queryFromMs))));
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`${this.apiBase}/window?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`블랙박스 시간 구간 조회 실패 (${response.status})`);
      const responseText = await response.text();
      responseBytes += responseText.length;
      if (responseBytes > MAX_RESPONSE_BYTES) throw new Error("블랙박스 시간 구간이 너무 큽니다. 더 짧은 구간을 선택하세요.");
      let pageBody: BlackboxWindowResponse;
      try { pageBody = JSON.parse(responseText) as BlackboxWindowResponse; }
      catch { throw new Error("블랙박스 시간 구간 응답을 해석할 수 없습니다."); }
      if (page === 0) body = pageBody;
      else body = { ...body, nextCursor: pageBody.nextCursor, gaps: [...(body.gaps ?? []), ...(pageBody.gaps ?? [])] };
      queryFromMs = pageBody.fromMs ?? queryFromMs;
      queryToMs = pageBody.toMs ?? queryToMs;
      if (generation !== this.candidateGeneration) return { asOf: Number(body.asOf ?? asOf), events: this._candidates, replayAvailable: Boolean(this._replay) };
      allEvents.push(...(pageBody.events ?? []));
      serverGap ||= pageBody.gap === true;
      serverTruncated ||= pageBody.truncated === true;
      if (allEvents.length > MAX_EVENTS) throw new Error("블랙박스 시간 구간에 프레임이 너무 많습니다. 더 짧은 구간을 선택하세요.");
      cursor = pageBody.nextCursor ?? "";
      if (!cursor) break;
    }
    if (cursor) serverTruncated = true;
    this.cursor = cursor;
    const uniqueEvents = new Map(allEvents.map(event => [event.eventId, event]));
    const orderedEvents = [...uniqueEvents.values()].sort(eventOrder);
    const meaningful = orderedEvents.filter(meaningfulBlackboxEvent);
    const ids = new Set(this._candidates.map(event => event.eventId));
    this._candidates.push(...meaningful.filter(event => !ids.has(event.eventId)));
    this._candidates.sort(eventOrder);
    this.cursor = body.nextCursor ?? "";
    const checkpoint = body.checkpoint ? frameOf(body.checkpoint) : {};
    const assets = checkpoint.assets ?? body.assets;
    if (body.checkpoint && checkpoint.snapshot && assets?.mapUrl) {
      const startEvent = body.startEvent ?? meaningful[0] ?? orderedEvents[0] ?? body.checkpoint;
      const endEvent = body.endEvent ?? meaningful.at(-1) ?? orderedEvents.at(-1) ?? startEvent;
      const gaps = [...(body.gaps ?? [])];
      if (serverGap || body.gap === true) gaps.push({ kind: "recorder_gap", mapId: body.mapId ?? mapId, detail: "블랙박스 기록에 공백이 포함되어 있습니다." });
      if (serverTruncated || body.truncated === true) gaps.push({ kind: "query_truncated", mapId: body.mapId ?? mapId, detail: "서버가 요청한 구간을 모두 반환하지 않았습니다." });
      this._replay = { schemaVersion: 1, mapId: body.mapId ?? mapId, startEvent, endEvent, checkpoint: body.checkpoint, events: orderedEvents, gaps };
      this._events = orderedEvents;
      this._gaps = gaps;
      this._snapshot = checkpoint.snapshot;
      this._assets = assets;
      this._cursorIndex = 0;
      this.replayFromMs = Number(body.fromMs ?? fromMs ?? Math.max(0, toMs - 30_000));
      this.replayToMs = Number(body.toMs ?? toMs);
      this.clock.set(this.replayFromMs);
      this.emit({ snapshot: this._snapshot, assets: this._assets, event: body.checkpoint, clockMs: this.clockMs, status: ReplayStatuses.code.paused });
    }
    if (!this._replay && (serverGap || serverTruncated || body.gap === true || body.truncated === true)) {
      this._gaps = [...(body.gaps ?? [])];
      if (serverGap || body.gap === true) this._gaps.push({ kind: "recorder_gap", mapId, detail: "블랙박스 기록에 공백이 포함되어 있습니다." });
      if (serverTruncated || body.truncated === true) this._gaps.push({ kind: "query_truncated", mapId, detail: "서버가 요청한 구간을 모두 반환하지 않았습니다." });
    }
    return { asOf: Number(body.asOf ?? asOf), events: this._candidates, nextCursor: body.nextCursor, replayAvailable: Boolean(this._replay) };
  }

  async clearAll(): Promise<{ ok: boolean; generation?: string; partial?: boolean; cleanupComplete: boolean; errors?: unknown[] }> {
    const response = await fetch(`${this.apiBase}/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmationToken: BLACKBOX_CONFIRMATIONS.code.BLACKBOX_RESET, scope: BLACKBOX_SCOPES.code.blackbox }), cache: "no-store" });
    let body: { ok?: boolean; cleared?: boolean; cleanupComplete?: boolean; generation?: { id?: string } | string; partial?: boolean; cleanupError?: string; cleanupErrors?: unknown[]; errors?: unknown[]; error?: unknown } = {};
    try { body = await response.json() as typeof body; } catch { /* preserve status below */ }
    if (!response.ok || body.ok === false || body.cleared === false) throw new Error(typeof body.errors?.[0] === "string" ? body.errors[0] : `블랙박스 기록 삭제 실패 (${response.status})`);
    this.invalidate();
    this._candidates = [];
    this._events = [];
    this._gaps = [];
    this._snapshot = undefined;
    this._assets = undefined;
    this._replay = undefined;
    const generation = typeof body.generation === "object" ? body.generation.id : body.generation;
    if (generation) this._serverGenerationId = generation;
    const cleanupComplete = body.cleanupComplete !== false && !(body.cleanupError || body.cleanupErrors?.length);
    const errors = [...(body.errors ?? []), ...(body.cleanupError ? [body.cleanupError] : []), ...(body.cleanupErrors ?? []), ...(body.error ? [body.error] : [])];
    if (!cleanupComplete && !errors.length) errors.push("이전 블랙박스 보관 자료를 모두 삭제하지 못했습니다.");
    return { ok: true, generation, partial: body.partial === true || !cleanupComplete, cleanupComplete, errors: errors.length ? errors : undefined };
  }

  async loadReplay(mapId: string, startEventId: string, endEventId: string, asOf: number): Promise<void> {
    const generation = this.beginGeneration();
    this._snapshot = undefined;
    this._assets = undefined;
    this._replay = undefined;
    this._gaps = [];
    this._cursorIndex = 0;
    this.emit({ status: ReplayStatuses.code.loading, clockMs: 0 });
    try {
      const params = new URLSearchParams({ mapId, startEventId, endEventId, asOf: String(asOf) });
      const response = await fetch(`${this.apiBase}/replay?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`블랙박스 리플레이 조회 실패 (${response.status})`);
      const replay = await response.json() as BlackboxReplayResponse;
      if (generation !== this._generation) return;
      if (!replay.checkpoint || replay.mapId !== mapId) throw new Error("블랙박스 checkpoint 또는 맵이 일치하지 않습니다.");
      const initial = frameOf(replay.checkpoint);
      if (!initial.snapshot || !initial.assets?.mapUrl) throw new Error("블랙박스 checkpoint에 화면 상태·맵 자산이 없습니다.");
      this._replay = replay;
      this._gaps = replay.gaps ?? [];
      this._events = [...(replay.events ?? [])].sort(eventOrder);
      this._snapshot = initial.snapshot;
      this._assets = initial.assets;
      this.clock.set(Number(replay.startEvent.timeMs ?? 0));
      this.replayFromMs = Number(replay.startEvent.timeMs ?? 0);
      this.replayToMs = Number(replay.endEvent.timeMs ?? this.replayFromMs);
      this.emit({ snapshot: this._snapshot, assets: this._assets, event: replay.checkpoint, clockMs: this.clockMs, status: ReplayStatuses.code.paused });
    } catch (error) {
      if (generation !== this._generation) return;
      this._error = asError(error);
      this.emit({ status: ReplayStatuses.code.error, error: this._error, clockMs: this.clockMs });
    }
  }

  async loadOperationTrace(operationId: string, cursor?: string, hints: { mapId?: string; fromMs?: number; toMs?: number; asOf?: number } = {}): Promise<BlackboxOperationTraceResponse> {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    if (hints.mapId) params.set("mapId", hints.mapId);
    if (hints.fromMs != null) params.set("fromMs", String(Math.trunc(hints.fromMs)));
    if (hints.toMs != null) params.set("toMs", String(Math.trunc(hints.toMs)));
    if (hints.asOf != null) params.set("asOf", String(Math.trunc(hints.asOf)));
    const query = params.toString();
    const response = await fetch(`${this.apiBase}/operations/${encodeURIComponent(operationId)}${query ? `?${query}` : ""}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`운용 operation trace 조회 실패 (${response.status})`);
    return response.json() as Promise<BlackboxOperationResponse>;
  }

  private applyUntil(cursorMs: number): void {
    while (this._cursorIndex < this._events.length && eventOrder(this._events[this._cursorIndex], { timeMs: cursorMs, sequence: Number.MAX_SAFE_INTEGER, eventId: "", schemaVersion: 1, source: "", bootId: "", mapId: "", category: "gap", kind: "", payload: {} }) <= 0) {
      const event = this._events[this._cursorIndex++];
      const frame = frameOf(event);
      if (frame.snapshot) this._snapshot = frame.snapshot;
      if (frame.assets) this._assets = frame.assets;
      this.emit({ snapshot: frame.snapshot, assets: frame.assets, event, clockMs: Number(event.timeMs ?? 0), status: ReplayStatuses.code.playing });
    }
    this.clock.set(cursorMs);
    this.emit({ snapshot: this._snapshot, assets: this._assets, clockMs: cursorMs, status: this.clock.playing ? ReplayStatuses.code.playing : ReplayStatuses.code.paused });
  }

  play(): void {
    if (!this._replay || this._error) return;
    const until = this.replayEndMs;
    this.clock.play(until, cursor => this.applyUntil(cursor), () => this.emit({ clockMs: this.clockMs, status: ReplayStatuses.code.complete }));
    this.emit({ clockMs: this.clockMs, status: ReplayStatuses.code.playing });
  }

  pause(): void { this.clock.pause(); this.emit({ clockMs: this.clockMs, status: ReplayStatuses.code.paused }); }

  step(direction: -1 | 1): void {
    if (!this._replay) return;
    this.clock.pause();
    const markerIndexes = this._events.flatMap((event, index) => meaningfulBlackboxEvent(event) ? [index] : []);
    if (direction > 0) {
      const next = markerIndexes.find(index => index >= this._cursorIndex);
      if (next != null) this.applyThroughIndex(next);
      else this.emit({ clockMs: this.clockMs, status: ReplayStatuses.code.complete });
      return;
    }
    const previous = [...markerIndexes].reverse().find(index => index < this._cursorIndex - 1);
    if (previous == null) {
      this.restoreCheckpoint();
      this.emit({ snapshot: this._snapshot, assets: this._assets, clockMs: this.clockMs, status: ReplayStatuses.code.paused });
      return;
    }
    this.restoreCheckpoint();
    this.applyThroughIndex(previous);
  }

  private restoreCheckpoint(): void {
    if (!this._replay) return;
    const initial = frameOf(this._replay.checkpoint);
    this._snapshot = initial.snapshot;
    this._assets = initial.assets;
    this._cursorIndex = 0;
    this.clock.set(this.replayStartMs);
  }

  private applyThroughIndex(targetIndex: number): void {
    while (this._cursorIndex <= targetIndex && this._cursorIndex < this._events.length) {
      const event = this._events[this._cursorIndex++];
      const frame = frameOf(event);
      if (frame.snapshot) this._snapshot = frame.snapshot;
      if (frame.assets) this._assets = frame.assets;
      this.clock.set(Number(event.timeMs ?? 0));
      this.emit({ snapshot: frame.snapshot, assets: frame.assets, event, clockMs: Number(event.timeMs ?? 0), status: ReplayStatuses.code.paused });
    }
    this.emit({ snapshot: this._snapshot, assets: this._assets, clockMs: this.clockMs, status: ReplayStatuses.code.paused });
  }

  seek(cursorMs: number): void {
    if (!this._replay) return;
    this._generation += 1;
    this.clock.pause();
    this.restoreCheckpoint();
    const startMs = this.replayStartMs;
    const endMs = this.replayEndMs;
    this.clock.set(Math.max(startMs, Math.min(endMs, cursorMs)));
    this.applyUntil(this.clockMs);
    this.emit({ clockMs: this.clockMs, status: ReplayStatuses.code.paused });
  }

  setSpeed(speed: number): void { this.clock.setSpeed(speed); this.emit({ clockMs: this.clockMs, status: this.clock.playing ? ReplayStatuses.code.playing : ReplayStatuses.code.paused }); }

  invalidate(): void {
    this.candidateGeneration += 1;
    this.beginGeneration();
    this._snapshot = undefined;
    this._assets = undefined;
    this._replay = undefined;
    this._events = [];
    this._candidates = [];
    this._gaps = [];
    this.cursor = "";
  }

  dispose(): void {
    this.beginGeneration();
    this.listeners.clear();
    this._snapshot = undefined;
    this._assets = undefined;
    this._replay = undefined;
  }

  fail(message: string): void {
    this._error = message;
    this.clock.pause();
    this.emit({ status: ReplayStatuses.code.error, error: message, clockMs: this.clockMs });
  }
}
