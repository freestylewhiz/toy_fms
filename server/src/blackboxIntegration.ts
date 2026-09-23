import { EVENT_KINDS } from "../../shared/config/events.ts";
import { PROTOCOL_MESSAGES, PROTOCOL_DIRECTIONS } from "../../shared/config/messages.ts";
import { OPERATION_KINDS } from "../../shared/config/messages.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { BlackboxCategory, BlackboxRecorder } from "../../shared/blackbox.ts";

type Context = { operationId: string; kind: string; robotId?: string; requestId?: string; display: Record<string, unknown>; replies: { type: string; payload: unknown }[] };
const operations = new AsyncLocalStorage<Context>();
const forcedOperations = new Set<string>([OPERATION_KINDS.code.setRobotControl, OPERATION_KINDS.code.setVirtualRobotPose, OPERATION_KINDS.code.releaseResourceOccupancy]);
const commandOperations = new Set<string>([OPERATION_KINDS.code.commandRobot, OPERATION_KINDS.code.cancelRobot]);
export const currentOperationId = () => operations.getStore()?.operationId;
export function commandOperationId(commandId: string): string | undefined {
  return commandId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
}

/** Request scopes include validation failures and async replies. No UI input
 * is trusted as an operation ID; request IDs only deduplicate within a client. */
export class OperationTrace {
  private requests = new Map<string, Context>();
  private commandContexts = new Map<string, Record<string, unknown>>();
  constructor(readonly recorder: BlackboxRecorder, readonly capture: () => void,
    readonly resolveContext?: (kind: string, payload: any) => Record<string, unknown>) {}

  run(client: any, kind: string, payload: any, handler: (client: any, payload: any) => unknown, relatedOperationIds: string[] = []): unknown {
    const requestId = typeof payload?.clientRequestId === "string" ? payload.clientRequestId : typeof payload?.requestId === "string" ? payload.requestId : undefined;
    const key = requestId ? `${client.sessionId}:${kind}:${requestId}` : undefined;
    const previous = key ? this.requests.get(key) : undefined;
    if (previous) {
      this.event("protocol", EVENT_KINDS.code["operation.duplicate"], { ...previous, payload: { kind, requestId } });
      for (const reply of previous.replies) client.send(reply.type, reply.payload);
      return;
    }
    // Copy the resource name before execution/edits; history must not depend on
    // the current name of a resource, or whether it still exists.
    let display: Record<string, unknown> = {};
    try { display = structuredClone(this.resolveContext?.(kind, payload) ?? {}); } catch { /* diagnostics cannot reject a command */ }
    const context: Context = { operationId: randomUUID(), kind, robotId: typeof payload?.robotId === "string" ? payload.robotId : undefined, requestId, display, replies: [] };
    if (key) { this.requests.set(key, context); if (this.requests.size > 2048) this.requests.delete(this.requests.keys().next().value!); }
    const category: BlackboxCategory = forcedOperations.has(kind) ? "forced" : commandOperations.has(kind) ? "operation" : "environment";
    const proxy = new Proxy(client, { get: (target, property) => {
      if (property !== "send") return Reflect.get(target, property, target);
      return (type: string, value: any) => {
        const reply = value && typeof value === "object" ? { ...value, operationId: context.operationId } : value;
        context.replies.push({ type, payload: reply });
        this.capture();
        this.event(type === "error" || reply?.ok === false || reply?.accepted === false ? "error" : category, `${kind}.${type}`, { ...context, payload: { ...display, response: reply } });
        return target.send(type, reply);
      };
    } });
    this.capture();
    this.event(category, `${kind}.requested`, { ...context, payload: { ...display, request: payload, actorSessionId: client.sessionId, relatedOperationIds } });
    return operations.run(context, () => {
      try {
        const result = handler(proxy, payload);
        if (result && typeof (result as Promise<unknown>).then === "function") return Promise.resolve(result).finally(() => this.capture()).catch(error => { this.failure(context, error); throw error; });
        this.capture();
        return result;
      } catch (error) { this.failure(context, error); throw error; }
    });
  }

  private failure(context: Context, error: unknown) {
    this.event("error", EVENT_KINDS.code["operation.exception"], { ...context, payload: { reason: error instanceof Error ? error.message : String(error) } });
  }

  /** Preserve existing broadcast semantics while retaining an idempotent
   * reply for the initiating client's repeated request. */
  broadcastReply(type: string, payload: Record<string, unknown>): void {
    const context = operations.getStore();
    if (!context) return;
    context.replies.push({ type, payload });
    this.capture();
    this.event("operation", `${context.kind}.${type}`, { ...context, payload: { response: payload } });
  }

  event(category: BlackboxCategory, kind: string, input: { robotId?: string; operationId?: string; commandId?: string; requestId?: string; payload: Record<string, unknown> }): void {
    const commandContext = input.commandId ? this.commandContexts.get(input.commandId) : undefined;
    this.recorder.record({ ...input, payload: { ...operations.getStore()?.display, ...commandContext, ...input.payload }, timeMs: Date.now(), category, kind, operationId: input.operationId ?? currentOperationId() ?? (input.commandId ? commandOperationId(input.commandId) : undefined) });
  }

  protocol(direction: (typeof PROTOCOL_DIRECTIONS.values)[number], robotId: string, message: Record<string, any>, reason?: string): void {
    const kind = typeof message.payload === "string" ? message.payload : Object.keys(message).find(key => key !== "payload" && key !== "operation_id") ?? "unknown";
    if (kind === PROTOCOL_MESSAGES.code.heartbeat) return; // Normal heartbeat repeats are not meaningful records.
    const body = message[kind] ?? {};
    const commandId = body.command_id || body.transfer_id;
    if (direction === "send" && kind === PROTOCOL_MESSAGES.code.drive && commandId) {
      let context: Record<string, unknown> = {};
      try { const parsed = JSON.parse(body.event_context_json || "{}"); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) context = parsed; } catch { /* older messages lack context */ }
      this.commandContexts.set(commandId, { ...context, commandKind: body.kind, x: body.x, y: body.y, theta: body.theta });
      if (this.commandContexts.size > 2048) this.commandContexts.delete(this.commandContexts.keys().next().value!);
    }
    this.event("protocol", `${direction}.${kind}`, { robotId, commandId, requestId: body.request_id,
      operationId: message.operation_id || body.operation_id || (commandId ? commandOperationId(commandId) : undefined), payload: { direction, reason, message } });
  }
}
