import { expect, test } from "bun:test";
import { formatEventLabel, formatEventMessage } from "./eventDisplay.ts";

test("command events show coordinates, historic target name, zero values, and full command id", () => {
  const event = {
    category: "operation",
    kind: "command.receive",
    robotId: "robot-1",
    commandId: "operation:command:with-a-long-id-1234567890",
    payload: {
      commandKind: "move",
      x: 0,
      y: 2,
      theta: 0.9,
      eventContext: { target: { id: "wp-1", kind: "waypoint", name: "포장 구역 입구", mapId: "yard" } },
    },
  };
  const message = formatEventMessage(event);
  expect(message).toContain("robot-1 이동 명령을 받음");
  expect(message).toContain("x:0 y:2 theta:0.9");
  expect(message).toContain("목표 포장 구역 입구");
  expect(message).toContain(`commandId=${event.commandId}`);
  expect(formatEventLabel(event, 1_700_000_000_000)).toContain(message);
});

test("planner and protocol events use available event payload without inventing values", () => {
  const planner = formatEventMessage({
    category: "planning", kind: "planner.failed", robotId: "robot-2", commandId: "c-1",
    payload: { phase: "failed", reason: "no_route", start: { x: 0, y: 0 }, goal: { x: 1, y: 2 }, durationMs: 12.5, resultPoints: 3 },
  });
  expect(planner).toContain("robot-2 경로 계획 실패");
  expect(planner).toContain("목적지까지 경로 없음");
  expect(planner).toContain("commandId=c-1");
  expect(planner).toContain("시작 (0, 0)");
  expect(planner).toContain("도착 (1, 2)");
  expect(planner).toContain("경로 점 3개");
  expect(planner).not.toContain("undefined");
  expect(planner).not.toContain("NaN");

  const protocol = formatEventMessage({
    category: "protocol", kind: "receive.drive", robotId: "robot-1",
    payload: { message: { drive: { kind: "move", x: 0, y: 4, theta: 0.5, command_id: "full-id" } } },
  });
  expect(protocol).toContain("robot-1 수신 주행 명령");
  expect(protocol).toContain("x:0 y:4 theta:0.5");
  expect(protocol).toContain("commandId=full-id");
});

test("unknown event codes stay visible and markup remains inert text", () => {
  const message = formatEventMessage({
    category: "future-category", kind: "future.<script>alert(1)</script>", robotId: "r1",
    payload: { reason: false },
  });
  expect(message).toContain("future-category · future.<script>alert(1)</script>");
  expect(message).toContain("false");
});

test("operation, state, pause, and protocol events describe their actual payload", () => {
  const operation = formatEventMessage({
    category: "operation", kind: "commandRobot.requested", robotId: "robot-1", operationId: "op-1",
    payload: { target: { id: "wp-2", kind: "waypoint", name: "적재 지점", mapId: "yard" }, request: { kind: "move", x: 0, y: 8, theta: 0.25 } },
  });
  expect(operation).toContain("로봇 명령 · 이동 요청");
  expect(operation).toContain("이동");
  expect(operation).toContain("x:0 y:8 theta:0.25");
  expect(operation).toContain("목표 적재 지점");

  const state = formatEventMessage({
    category: "connection", kind: "robot.state_changed", robotId: "robot-1",
    payload: { before: { driveState: "blocked", connectionState: "offline" }, after: { driveState: "normal", connectionState: "online" } },
  });
  expect(state).toContain("연결 오프라인 → 온라인");
  expect(state).toContain("주행 차단됨 → 차단 없음");

  expect(formatEventMessage({ category: "operation", kind: "motion_pause.applied", robotId: "robot-1", payload: { paused: false } })).toContain("주행 재개 요청 적용");
  expect(formatEventMessage({ category: "operation", kind: "motion_pause.rejected", robotId: "robot-1", payload: { paused: true, reasonCode: "operator_pause_rejected" } })).toContain("주행 일시정지 요청 거절");

  const protocol = formatEventMessage({
    category: "protocol", kind: "receive.command_state", robotId: "robot-1", commandId: "cmd-full",
    payload: { message: { command_state: { command_id: "cmd-full", state: "completed" } } },
  });
  expect(protocol).toContain("명령 상태 보고");
  expect(protocol.match(/commandId=cmd-full/g)).toHaveLength(1);
});

test("invalid numeric strings are omitted while zero coordinates remain", () => {
  const message = formatEventMessage({ category: "operation", kind: "command.receive", payload: { commandKind: "move", x: "NaN", y: 0, theta: undefined } });
  expect(message).toContain("y:0");
  expect(message).not.toContain("NaN");
  expect(message).not.toContain("undefined");
});

test("command progress, legacy target IDs, connection details, and FMS operation errors remain useful", () => {
  const progress = formatEventMessage({
    category: "operation", kind: "command.execute", robotId: "robot-1", commandId: "command-full-id",
    payload: { state: "running", eventContext: { commandKind: "move", x: 0, y: 1, theta: 0, target: { id: "wp-old", kind: "waypoint", name: "옛 이름", mapId: "yard" } } },
  });
  expect(progress).toContain("이동 명령");
  expect(progress).toContain("목표 옛 이름");
  expect(progress).toContain("commandId=command-full-id");

  const legacy = formatEventMessage({ category: "operation", kind: "commandRobot.requested", payload: { request: { targetId: "wp-legacy" } } });
  expect(legacy).toContain("wp-legacy");

  expect(formatEventMessage({ category: "connection", kind: "connection.attempt", robotId: "robot-1", payload: { target: "localhost:50062" } })).toContain("연결 대상 localhost:50062");

  const failure = formatEventMessage({ category: "error", kind: "commandRobot.error", robotId: "robot-1", payload: { response: { reason: "no_route" } } });
  expect(failure).toContain("로봇 명령");
  expect(failure).toContain("목적지까지 경로 없음");
});

test("resume with a remaining safety blocker is not described as actual motion", () => {
  const text = formatEventMessage({ category: "operation", kind: "motion_pause.applied", payload: { paused: false, reasonCode: "resumed_path_blocked" } });
  expect(text).toContain("재개 요청 적용");
  expect(text).toContain("경로가 막힘");
  expect(text).not.toContain("resumed_");
  expect(text).not.toContain("이동 중");
});

test("captured context precedes legacy target references and missing values remain unknown", () => {
  const text = formatEventMessage({ category: "operation", kind: "command.receive", payload: {
    targetId: "legacy-id", eventContext: { target: { id: "historic-id", name: "당시 이름" } },
  } });
  expect(text).toContain("당시 이름");
  expect(text).not.toContain("legacy-id");
  expect(text).not.toContain("명령 명령");
  expect(formatEventMessage({ category: "operation", kind: "toString", payload: {} })).toContain("toString");
  expect(formatEventMessage({ category: "error", kind: "error.session", payload: { reason: "", message: "연결 실패" } })).toContain("연결 실패");
});

test("old acknowledgements retain coordinates, target ID and full command ID in their descriptions", () => {
  const text = formatEventMessage({ category: "operation", kind: "commandRobot.commandAck", payload: {
    response: { commandId: "full-response-command-id", state: "sent", x: 0, y: 4, theta: 0, targetId: "wp-old" },
  } });
  expect(text).toContain("x:0 y:4 theta:0");
  expect(text).toContain("전송됨");
  expect(text).toContain("wp-old");
  expect(text).toContain("commandId=full-response-command-id");
});

test("wire enum names and discarded message reasons remain human readable", () => {
  const zone = formatEventMessage({ category: "protocol", kind: "receive.zone_update", payload: { message: { zone_update: { state: "STOP", zone_id: "zone-1" } } } });
  expect(zone).toContain("상태:정지");
  expect(zone).not.toContain("STOP");
  const grant = formatEventMessage({ category: "protocol", kind: "receive.lease_grant", payload: { message: { lease_grant: { signal: "SIGNAL_PROCEED" } } } });
  expect(grant).toContain("신호:진행");
  const evasion = formatEventMessage({ category: "protocol", kind: "receive.evasion_request", payload: { message: { evasion_request: { mode: "EVASION_VACATE" } } } });
  expect(evasion).toContain("회피:구역 비우기");
  const discarded = formatEventMessage({ category: "protocol", kind: "discard.command_state", payload: { reason: "session_changed", message: { command_state: { state: "running" } } } });
  expect(discarded).toContain("폐기 사유:연결 세션 변경");
});

test("rejected peer detours show measured distances, historic target, fallback, and full command ID", () => {
  const commandId = "operation:move:complete-command-id-1234567890";
  const message = formatEventMessage({
    category: "planning", kind: "navigation.detour_rejected", robotId: "robot-2", commandId,
    payload: {
      reason: "detour-too-long", baselineLengthM: 10, candidateLengthM: 28, allowedLengthM: 13,
      fallback: "step-back-request", stepBackDistanceM: 0.5, stepBackWaitMs: 5_000,
      eventContext: { target: { id: "wp-1", name: "당시 목표 이름" } },
    },
  });
  expect(message).toContain("robot-2 우회 경로 거절");
  expect(message).toContain("목표 당시 목표 이름");
  expect(message).toContain("우회 후보 경로가 허용 거리보다 김");
  expect(message).toContain("원래 남은 거리 10m");
  expect(message).toContain("우회 후보 28m");
  expect(message).toContain("허용 거리 13m");
  expect(message).toContain("지나온 경로로 0.5m 후퇴 시도 예정 (이동 후 5초 대기)");
  expect(message).toContain(`commandId=${commandId}`);
  expect(message).not.toContain("후퇴 시작");

  const waiting = formatEventMessage({
    category: "planning", kind: "navigation.detour_rejected", robotId: "robot-2",
    payload: { reason: "detour-reference-unavailable", baselineLengthM: null, candidateLengthM: null, allowedLengthM: null, fallback: "await-vacate" },
  });
  expect(waiting).toContain("우회 경로 길이를 비교할 기준 경로를 확인할 수 없음");
  expect(waiting).toContain("FMS의 후속 VACATE(구역 비우기) 요청을 기다림");
  expect(waiting).toContain("원래 남은 거리 확인 불가");
  expect(waiting).not.toContain("0m");
  expect(waiting).not.toContain("NaN");
  expect(waiting).not.toContain("Infinity");

  const missingFallbackSettings = formatEventMessage({
    category: "planning", kind: "navigation.detour_rejected",
    payload: { fallback: "step-back-request", stepBackDistanceM: null, stepBackWaitMs: null },
  });
  expect(missingFallbackSettings).toContain("알 수 없는 거리");
  expect(missingFallbackSettings).toContain("알 수 없는 시간");
});
