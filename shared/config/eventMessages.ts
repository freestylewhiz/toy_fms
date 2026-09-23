import { DetourFallbacks, EVENT_CATEGORIES, EVENT_KINDS, EVENT_SOURCES } from "./events.ts";
import { PROTOCOL_DIRECTIONS, PROTOCOL_MESSAGES, OPERATION_KINDS, REPLY_KINDS } from "./messages.ts";
import { REASON_CODES } from "./reasons.ts";
import { ConnectionStates } from "./global.ts";
import { FmsControlStates, TeleporterTransferPhases, TrafficSignals, TrafficStopDecisions, EvasionModes, ZoneUpdateStates,
  TrafficSignalWireNames, TrafficSignalWireNumbers, EvasionWireNames, EvasionWireNumbers } from "./fms.ts";
import {
  CommandStates, DriveCommandKinds, RobotCommandKinds, DriveStates, NavigationModes, PathPlanningAuthorities,
  PlanningPhases, WorkStates,
} from "./robot.ts";

export type DisplayEvent = {
  category: string;
  kind: string;
  robotId?: string;
  commandId?: string;
  requestId?: string;
  operationId?: string;
  source?: string;
  payload?: Record<string, unknown>;
};

const has = (value: unknown): boolean => value !== undefined && value !== null && value !== "";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const display = (value: unknown): string => typeof value === "string" ? value : String(value);
const finiteNumber = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return undefined;
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};
const coordinate = (value: unknown): string => {
  const number = finiteNumber(value);
  if (number === undefined) return "";
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(4)));
};
const label = (catalog: { labels: Record<string, string> }, value: unknown): string | undefined =>
  typeof value === "string" ? catalog.labels[value] : undefined;

function wireLabel(names: { labels: Record<string, string> }, numbers: { code: Record<string, number> }, value: unknown): string | undefined {
  const name = Object.keys(numbers.code).find(key => value === numbers.code[key] || value === String(numbers.code[key]));
  return label(names, name ?? value);
}

function targetOf(payload: Record<string, unknown>): Record<string, unknown> {
  // Event-time target is authoritative, even if the resource was later renamed/deleted.
  const direct = record(payload.target);
  if (Object.keys(direct).length) return direct;
  const contextTarget = record(record(payload.eventContext).target);
  if (Object.keys(contextTarget).length) return contextTarget;
  const request = record(payload.request);
  const requestTarget = record(request.target);
  if (Object.keys(requestTarget).length) return requestTarget;
  const response = record(payload.response);
  const legacyId = payload.targetId ?? request.targetId ?? request.target_id ?? response.targetId ?? payload.resourceId ?? request.resourceId;
  if (has(legacyId)) return { id: legacyId, kind: payload.targetKind ?? request.targetKind ?? payload.resourceKind ?? request.resourceKind };
  return {};
}

function targetText(payload: Record<string, unknown>): string {
  const target = targetOf(payload);
  if (has(target.name)) return `목표 ${display(target.name)}`;
  if (has(target.id)) return `목표 ${display(target.id)}`;
  return "";
}

function coordsText(payload: Record<string, unknown>): string {
  const context = record(payload.eventContext);
  const request = record(payload.request);
  const values = [payload.x ?? context.x ?? request.x, payload.y ?? context.y ?? request.y, payload.theta ?? context.theta ?? request.theta];
  if (!values.some(has)) return "";
  const names = ["x", "y", "theta"] as const;
  return names.map((name, index) => {
    const value = finiteNumber(values[index]);
    return value === undefined ? "" : `${name}:${coordinate(value)}`;
  }).filter(Boolean).join(" ");
}

function localizedReason(value: unknown): string {
  if (!has(value)) return "";
  if (typeof value === "string") {
    if (REASON_CODES.is(value)) return REASON_CODES.labels[value];
    if (value.startsWith("resumed_")) {
      const suffix = value.slice("resumed_".length);
      if (REASON_CODES.is(suffix)) return `재개 요청 적용 · ${REASON_CODES.labels[suffix]}`;
    }
  }
  return display(value);
}

function reasonText(payload: Record<string, unknown>): string {
  return localizedReason([payload.failureReason, payload.failure_reason, payload.reason, payload.reasonCode, payload.reason_code, payload.error, payload.message, payload.outcome].find(has));
}

function commandKindOf(payload: Record<string, unknown>, fallback = "command"): string {
  const context = record(payload.eventContext);
  const request = record(payload.request);
  const value = payload.commandKind ?? payload.command_kind ?? context.commandKind ?? context.command_kind ?? request.kind;
  return label(RobotCommandKinds, value) ?? label(DriveCommandKinds, value) ?? (has(value) ? display(value) : fallback);
}

function protocolText(event: DisplayEvent, payload: Record<string, unknown>): string {
  const [direction, ...rest] = event.kind.split(".");
  const messageKind = rest.join(".");
  const directionLabel = label(PROTOCOL_DIRECTIONS, direction) ?? direction;
  const messageLabel = label(PROTOCOL_MESSAGES, messageKind) ?? messageKind;
  const message = record(payload.message);
  const body = record(message[messageKind]);
  const fields: string[] = [];
  if (has(body.state)) fields.push(`상태:${label(messageKind === PROTOCOL_MESSAGES.code.zone_update ? ZoneUpdateStates : CommandStates, body.state) ?? label(DriveStates, body.state) ?? (body.state === "normal" ? "정상" : display(body.state))}`);
  if (has(body.phase)) fields.push(`단계:${label(messageKind === "teleporter_transfer" ? TeleporterTransferPhases : PlanningPhases, body.phase) ?? display(body.phase)}`);
  if (has(body.signal)) fields.push(`신호:${label(TrafficSignals, body.signal) ?? wireLabel(TrafficSignalWireNames, TrafficSignalWireNumbers, body.signal) ?? display(body.signal)}`);
  if (has(body.decision)) fields.push(`판단:${label(TrafficStopDecisions, body.decision) ?? display(body.decision)}`);
  if (has(body.mode)) fields.push(`회피:${label(EvasionModes, body.mode) ?? wireLabel(EvasionWireNames, EvasionWireNumbers, body.mode) ?? display(body.mode)}`);
  if (has(body.zone_id)) fields.push(`구역:${display(body.zone_id)}`);
  if (has(body.kind)) fields.push(`종류:${label(RobotCommandKinds, body.kind) ?? label(DriveCommandKinds, body.kind) ?? display(body.kind)}`);
  if (has(body.reason ?? body.reason_code)) fields.push(`사유:${localizedReason(body.reason ?? body.reason_code)}`);
  if (has(body.applied)) fields.push(`적용:${body.applied ? "예" : "아니요"}`);
  if (has(body.paused)) fields.push(`일시정지:${body.paused ? "예" : "아니요"}`);
  const coords = coordsText({ x: body.x, y: body.y, theta: body.theta });
  if (coords) fields.push(coords);
  // Parent operation events flatten their captured target onto payload.target;
  // virtual-robot raw protocol events carry the same capture in eventContext.
  const target = targetText(payload) || targetText(body);
  if (target) fields.push(target);
  if (direction === PROTOCOL_DIRECTIONS.code.discard && has(payload.reason)) fields.push(`폐기 사유:${localizedReason(payload.reason)}`);
  return `${directionLabel} ${messageLabel}${fields.length ? ` · ${fields.join(" · ")}` : ""}`;
}

function plannerText(event: DisplayEvent, payload: Record<string, unknown>, robot: string): string {
  const phaseValue = payload.phase ?? event.kind.slice("planner.".length);
  const phase = label(PlanningPhases, phaseValue) ?? (has(phaseValue) ? display(phaseValue) : label(EVENT_KINDS, event.kind) ?? event.kind);
  const start = record(payload.start), goal = record(payload.goal);
  const startText = finiteNumber(start.x) !== undefined && finiteNumber(start.y) !== undefined ? `시작 (${coordinate(start.x)}, ${coordinate(start.y)})` : "";
  const goalText = finiteNumber(goal.x) !== undefined && finiteNumber(goal.y) !== undefined ? `도착 (${coordinate(goal.x)}, ${coordinate(goal.y)})` : "";
  const duration = finiteNumber(payload.durationMs);
  const resultPoints = finiteNumber(payload.resultPoints);
  const details = [startText, goalText, duration !== undefined ? `${coordinate(duration)}ms` : "", resultPoints !== undefined ? `경로 점 ${coordinate(resultPoints)}개` : "", targetText(payload), reasonText(payload)].filter(Boolean);
  return `${robot}경로 계획 ${phase}${details.length ? ` · ${details.join(" · ")}` : ""}`;
}

function meters(value: unknown): string | undefined {
  const number = finiteNumber(value);
  return number === undefined || number < 0 ? undefined : `${coordinate(number)}m`;
}

function duration(value: unknown): string | undefined {
  const number = finiteNumber(value);
  if (number === undefined || number < 0) return undefined;
  return number % 1000 === 0 ? `${coordinate(number / 1000)}초` : `${coordinate(number)}ms`;
}

function detourFallbackText(payload: Record<string, unknown>): string {
  if (typeof payload.fallback !== "string") return "";
  if (DetourFallbacks.is(payload.fallback)) {
    const label = DetourFallbacks.labels[payload.fallback];
    if (payload.fallback === DetourFallbacks.code["step-back-request"]) {
      return label
        .replace("{distance}", meters(payload.stepBackDistanceM) ?? "알 수 없는 거리")
        .replace("{wait}", duration(payload.stepBackWaitMs) ?? "알 수 없는 시간");
    }
    return label;
  }
  return `후속 처리 ${payload.fallback}`;
}

function detourRejectedText(event: DisplayEvent, payload: Record<string, unknown>, robot: string): string {
  const baseline = meters(payload.baselineLengthM);
  const candidate = meters(payload.candidateLengthM);
  const allowed = meters(payload.allowedLengthM);
  const details = [
    targetText(payload),
    reasonText(payload),
    baseline ? `원래 남은 거리 ${baseline}` : "원래 남은 거리 확인 불가",
    candidate ? `우회 후보 ${candidate}` : "우회 후보 거리 확인 불가",
    allowed ? `허용 거리 ${allowed}` : "허용 거리 확인 불가",
    detourFallbackText(payload),
  ].filter(Boolean);
  return `${robot}${label(EVENT_KINDS, event.kind) ?? event.kind}${details.length ? ` · ${details.join(" · ")}` : ""}`;
}

function stateChanges(payload: Record<string, unknown>): string[] {
  const before = record(payload.before), after = record(payload.after);
  const fields: Array<[string, string, { labels: Record<string, string> }]> = [
    ["connectionState", "연결", ConnectionStates],
    ["fmsControlState", "운영", FmsControlStates],
    ["workState", "작업", WorkStates],
    ["driveState", "주행", DriveStates],
    ["commandState", "명령", CommandStates],
    ["navigationMode", "주행 방식", NavigationModes],
    ["pathPlanningAuthority", "계획 담당", PathPlanningAuthorities],
  ];
  const changed = fields.flatMap(([key, name, catalog]) => {
    const from = before[key], to = after[key];
    if (!has(to) || from === to) return [];
    const fromLabel = from === "normal" ? "차단 없음" : label(catalog, from) ?? display(from ?? "없음");
    const toLabel = to === "normal" ? "차단 없음" : label(catalog, to) ?? display(to);
    return [`${name} ${fromLabel} → ${toLabel}`];
  });
  if (before.controlReady !== after.controlReady && typeof after.controlReady === "boolean") changed.push(`제어 ${after.controlReady ? "준비됨" : "사용 불가"}`);
  if (before.operatorPaused !== after.operatorPaused && typeof after.operatorPaused === "boolean") changed.push(`사용자 일시정지 ${after.operatorPaused ? "적용" : "해제"}`);
  return changed;
}

function operationText(event: DisplayEvent, payload: Record<string, unknown>, robot: string): string | undefined {
  const dot = event.kind.lastIndexOf(".");
  if (dot < 0) return undefined;
  const operationCode = event.kind.slice(0, dot);
  const replyCode = event.kind.slice(dot + 1);
  const operationLabel = label(OPERATION_KINDS, operationCode);
  const replyLabel = label(REPLY_KINDS, replyCode);
  if (!operationLabel && !replyLabel) return undefined;
  const request = record(payload.request);
  const response = record(payload.response);
  const action = operationCode === OPERATION_KINDS.code.commandRobot ? commandKindOf(payload, "") || commandKindOf(request, "") : "";
  const labelText = operationLabel
    ? `${operationLabel}${action ? ` · ${action}` : ""}${replyCode === "requested" ? " 요청" : replyLabel ? ` · ${replyLabel}` : ` · ${replyCode}`}`
    : replyLabel!;
  const coordinates = coordsText({ ...response, ...request, ...payload });
  const target = targetText(payload) || targetText(request);
  const reason = reasonText(response) || reasonText(payload);
  const outcome = has(response.accepted) ? `수락:${response.accepted ? "예" : "아니요"}` : has(response.ok) ? `성공:${response.ok ? "예" : "아니요"}` : "";
  const state = has(response.state) ? `상태:${label(CommandStates, response.state) ?? display(response.state)}` : "";
  const details = [coordinates, target, state, outcome, reason].filter(Boolean);
  return `${robot}${labelText}${details.length ? ` · ${details.join(" · ")}` : ""}`;
}

/** Human-readable Korean text. Event JSON is kept intact for the detail panel. */
export function formatEventMessage(event: DisplayEvent): string {
  const payload = record(event.payload);
  const kindLabel = label(EVENT_KINDS, event.kind);
  const robot = has(event.robotId) ? `${event.robotId} ` : "";
  const reason = reasonText(payload);
  let message: string;

  if (event.kind.startsWith("send.") || event.kind.startsWith("receive.") || event.kind.startsWith("discard.")) {
    message = `${robot}${protocolText(event, payload)}`;
  } else if (event.kind === "navigation.detour_rejected") {
    message = detourRejectedText(event, payload, robot);
  } else if (event.kind === "command.receive") {
    const action = commandKindOf(payload, "");
    const coordinates = coordsText(payload);
    const target = targetText(payload);
    message = `${robot}${action ? `${action} ` : ""}명령을 받음${coordinates ? ` ${coordinates}` : ""}${target ? ` · ${target}` : ""}`;
  } else if (event.kind.startsWith("command.")) {
    const state = has(payload.state) ? label(CommandStates, payload.state) ?? display(payload.state) : "";
    const action = commandKindOf(payload, "");
    const target = targetText(payload);
    const coordinates = coordsText(payload);
    const head = state ? `명령 ${state}` : kindLabel ?? event.kind;
    message = `${robot}${action ? `${action} ` : ""}${head}${coordinates ? ` · ${coordinates}` : ""}${target ? ` · ${target}` : ""}${reason ? ` · ${reason}` : ""}`;
  } else if (event.kind.startsWith("planner.")) {
    message = plannerText(event, payload, robot);
  } else if ([EVENT_KINDS.code["motion_pause.received"], EVENT_KINDS.code["motion_pause.applied"], EVENT_KINDS.code["motion_pause.rejected"]].includes(event.kind as any)) {
    const action = payload.paused === false ? "재개" : payload.paused === true ? "일시정지" : "일시정지·재개";
    const outcome = event.kind.endsWith(".received") ? "요청 수신" : event.kind.endsWith(".rejected") ? "요청 거절" : "요청 적용";
    const cause = reason && !reason.includes("요청 거절") ? ` · ${reason}` : "";
    message = `${robot}주행 ${action} ${outcome}${cause}`;
  } else if (event.kind === "robot.state_changed") {
    const changes = stateChanges(payload);
    const target = targetText(payload);
    message = `${robot}${changes.length ? changes.join(" · ") : kindLabel ?? event.kind}${target ? ` · ${target}` : ""}${reason ? ` · ${reason}` : ""}`;
  } else if (event.kind === "connection.attempt" || event.kind === "connection.retry") {
    const endpoint = typeof payload.target === "string" && payload.target ? `연결 대상 ${payload.target}` : "";
    const delay = finiteNumber(payload.delayMs);
    message = `${robot}${kindLabel ?? event.kind}${endpoint ? ` · ${endpoint}` : ""}${delay !== undefined ? ` · ${coordinate(delay)}ms 후` : ""}${reason ? ` · ${reason}` : ""}`;
  } else if (operationText(event, payload, robot)) {
    message = operationText(event, payload, robot)!;
  } else if (event.category === "error" || event.kind.startsWith("error.")) {
    message = `${robot}${kindLabel ?? event.kind}${reason ? ` · ${reason}` : ""}`;
  } else {
    message = operationText(event, payload, robot) ?? `${robot}${kindLabel ?? `${label(EVENT_CATEGORIES, event.category) ?? event.category} · ${event.kind}`}${reason ? ` · ${reason}` : ""}`;
  }

  const response = record(payload.response);
  const wireMessage = record(payload.message);
  const body = record(wireMessage[event.kind.slice(event.kind.indexOf(".") + 1)]);
  const commandId = event.commandId ?? payload.commandId ?? response.commandId ?? body.command_id;
  const requestId = event.requestId ?? payload.requestId ?? response.requestId ?? body.request_id;
  const ids = [has(commandId) ? `commandId=${display(commandId)}` : "", has(requestId) ? `requestId=${display(requestId)}` : ""].filter(Boolean);
  return `${message}${ids.length ? ` · ${ids.join(" · ")}` : ""}`;
}

export function formatEventSource(source: string): string {
  if (source.startsWith("robot-")) return `로봇 기록 (${source.slice("robot-".length)})`;
  return label(EVENT_SOURCES, source) ?? source;
}

export function formatEventTime(timeMs: number): string {
  return Number.isFinite(timeMs) && timeMs >= 0 ? new Date(timeMs).toLocaleTimeString() : "—";
}

export function formatEventLabel(event: DisplayEvent, timeMs: number): string {
  const time = formatEventTime(timeMs);
  return `${time} · ${formatEventMessage(event)}`;
}
