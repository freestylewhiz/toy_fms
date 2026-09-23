import type { DynObstacle } from "../../shared/obstacles.ts";
import type { Point } from "../../shared/planner.ts";
import type { ZoneResource } from "../../shared/semantic.ts";
import { fileURLToPath } from "node:url";
import type { PlanningFailure as CatalogPlanningFailure, PlanningPhase } from "../../shared/config/index.ts";
import type { DetourFallback } from "../../shared/config/events.ts";

export type RoutePlan = { follow: Point[]; display: Point[] };

export type PlanningRequest = {
  requestId: number;
  mapId: string;
  start: Point;
  goal: Point;
  zones: ZoneResource[];
  obstacles: DynObstacle[];
  timeBudgetMs: number;
};

export type PlanningInput = Omit<PlanningRequest, "requestId" | "timeBudgetMs"> & Partial<Pick<PlanningRequest, "timeBudgetMs">>;

export type PlanningHandle = {
  promise: Promise<RoutePlan | null>;
  cancel: () => void;
  /** Optional diagnostics; existing planner implementations need not provide it. */
  getFailure?: () => PlanningFailure | undefined;
};

export type PlanningFailure = {
  kind: Exclude<CatalogPlanningFailure, "stale_context">;
  message?: string;
};

export type PlanningEvent = {
  /** Explicit diagnostic kind bypasses the default planner.<phase> mapping. */
  kind?: string;
  requestId: number;
  commandId?: string;
  phase: PlanningPhase;
  reason: string;
  mapId: string;
  start: Point;
  goal: Point;
  async: boolean;
  durationMs?: number;
  resultPoints?: number;
  error?: string;
  failureReason?: CatalogPlanningFailure;
  level?: "info" | "warn" | "error";
  baselineLengthM?: number | null;
  candidateLengthM?: number | null;
  allowedLengthM?: number | null;
  fallback?: DetourFallback;
  stepBackDistanceM?: number;
  stepBackWaitMs?: number;
};

export type AsyncRoutePlanner = {
  request(input: PlanningInput): PlanningHandle;
  close?: () => void;
};

type WorkerResponse = {
  requestId: number;
  route?: RoutePlan | null;
  error?: string;
  failure?: Extract<CatalogPlanningFailure, "timeout" | "worker_error">;
};

// The measured Large Lab route can take ~2.5s on the current map asset. The
// budget is deliberately above that worst observed case; the worker keeps
// this cost off the gRPC/tick loop, while cancellation still fences stale work.
const DEFAULT_TIME_BUDGET_MS = 5000;

/**
 * One latest-wins isolated Bun planning process. Bun 1.3.13 Web Worker
 * termination during module loading crashed the parent robot in the real
 * teleporter regression. A subprocess keeps that lifetime/isolate failure
 * outside the robot's gRPC/tick process and can be safely killed on cancel.
 * The legacy class name is retained for the controller's planner interface.
 */
export class PlanningWorkerClient implements AsyncRoutePlanner {
  private worker: Bun.Subprocess | null = null;
  private onWorkerMessage?: (message: WorkerResponse) => void;
  private onWorkerFailure?: (message: string) => void;
  private active: { requestId: number; cancel: () => void } | null = null;
  private nextRequestId = 1;
  private readonly timeBudgetMs: number;

  constructor(options: { timeBudgetMs?: number } = {}) {
    this.timeBudgetMs = Math.max(100, Math.floor(options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS));
  }

  request(input: PlanningInput): PlanningHandle {
    this.active?.cancel();
    const requestId = this.nextRequestId++;
    let worker: Bun.Subprocess;
    try { worker = this.ensureWorker(); }
    catch (error) {
      const failure: PlanningFailure = { kind: "worker_error", message: error instanceof Error ? error.message : String(error) };
      return { promise: Promise.resolve(null), cancel() {}, getFailure: () => failure };
    }
    let settled = false;
    let failure: PlanningFailure | undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let resolveResult!: (result: RoutePlan | null) => void;
    const promise = new Promise<RoutePlan | null>((resolve) => { resolveResult = resolve; });
    const finish = (result: RoutePlan | null, cause?: PlanningFailure, terminate = false) => {
      if (settled) return;
      settled = true;
      failure = cause;
      if (timer) clearTimeout(timer);
      if (this.active?.requestId === requestId) this.active = null;
      if (terminate && this.worker === worker) {
        this.worker = null;
        worker.kill("SIGKILL");
      }
      resolveResult(result);
    };
    const cancel = () => finish(null, { kind: "cancelled" }, true);
    this.active = { requestId, cancel };
    this.onWorkerMessage = (message: WorkerResponse) => {
      if (message.requestId !== requestId) return;
      if (message.error) {
        finish(null, { kind: message.failure ?? "worker_error", message: message.error });
      } else if (message.route) {
        finish(message.route);
      } else {
        finish(null, { kind: "no_route", message: "no path" });
      }
    };
    this.onWorkerFailure = (message) => finish(null, { kind: "worker_error", message }, true);
    timer = setTimeout(() => finish(null, { kind: "timeout", message: "planning time budget exceeded" }, true), input.timeBudgetMs ?? this.timeBudgetMs);
    try {
      worker.send({ ...input, requestId, timeBudgetMs: input.timeBudgetMs ?? this.timeBudgetMs });
    } catch (error) {
      finish(null, { kind: "worker_error", message: error instanceof Error ? error.message : String(error) }, true);
    }
    return { promise, cancel, getFailure: () => failure };
  }

  close(): void {
    this.active?.cancel();
    this.active = null;
    this.worker?.kill("SIGKILL");
    this.worker = null;
    this.onWorkerMessage = undefined;
    this.onWorkerFailure = undefined;
  }

  private ensureWorker(): Bun.Subprocess {
    if (this.worker) return this.worker;
    const worker = Bun.spawn([process.execPath, fileURLToPath(new URL("./planningWorker.ts", import.meta.url))], {
      stdin: "ignore", stdout: "ignore", stderr: "inherit",
      ipc: (message: WorkerResponse) => { if (this.worker === worker) this.onWorkerMessage?.(message); },
      onExit: (_process, code, signal, error) => {
        if (this.worker !== worker) return;
        this.onWorkerFailure?.(error?.message ?? `planning process exited (${code ?? signal})`);
        if (this.worker === worker) this.worker = null;
      },
    });
    this.worker = worker;
    return worker;
  }
}
