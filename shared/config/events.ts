import { defineCodes, type CodeOf } from "./defineCodes.ts";

/** Stable blackbox event kind labels. Unknown kinds remain visible verbatim. */
export const EVENT_KINDS = defineCodes({
  "command.receive": "명령 수신",
  "command.execute": "명령 실행",
  "command.complete": "명령 완료",
  "command.reject": "명령 거부",
  "command.cancelled": "명령 취소",
  "motion_pause.received": "일시정지 요청 수신",
  "motion_pause.applied": "일시정지 적용",
  "motion_pause.rejected": "일시정지 적용 거부",
  "planner.requested": "경로 계획 요청",
  "planner.completed": "경로 계획 완료",
  "planner.failed": "경로 계획 실패",
  "planner.discarded": "경로 계획 결과 폐기",
  "navigation.detour_rejected": "우회 경로 거절",
  "connection.attempt": "연결 시도",
  "connection.retry": "재연결 대기",
  "error.session": "세션 오류",
  "error.connection": "연결 오류",
  "error.message_handler": "메시지 처리 오류",
  "error.motion_pause": "일시정지 오류",
  "operation.exception": "요청 처리 오류",
  "operation.duplicate": "중복 요청 재사용",
  "robot.state_changed": "로봇 상태 변경",
  "robot.map_departed": "로봇이 맵에서 이탈",
  "recorder.malformed_event": "손상된 이벤트 기록",
  "recorder.write_loss": "기록 저장 누락",
  "recorder.queue_overflow": "기록 대기열 초과",
  "scene.snapshot": "장면 상태 기록",
} as const);

export const EVENT_CATEGORIES = defineCodes({
  operation: "운용",
  error: "오류",
  forced: "강제 조치",
  environment: "환경",
  connection: "연결",
  frame: "장면",
  protocol: "프로토콜",
  planning: "계획",
  gap: "기록 공백",
} as const);

export const EVENT_SOURCES = defineCodes({
  fms: "FMS",
  "floor-room": "FMS room",
  robot: "로봇",
} as const);

export const EVENT_LEVELS = defineCodes({ info: "정보", warn: "경고", error: "오류" } as const);

/** Stable fallback codes emitted when a peer detour candidate is rejected. */
export const DetourFallbacks = defineCodes({
  "step-back-request": "지나온 경로로 {distance} 후퇴 시도 예정 (이동 후 {wait} 대기)",
  "await-vacate": "FMS의 후속 VACATE(구역 비우기) 요청을 기다림",
} as const);
export type DetourFallback = CodeOf<typeof DetourFallbacks>;
