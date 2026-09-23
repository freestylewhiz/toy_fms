import { defineCodes } from "./defineCodes.ts";
import { REASON_CODES } from "./reasons.ts";

export const RobotPhases = defineCodes({ idle: "대기", follow: "추종", rotate: "회전", hold: "정지 대기", lease_lost: "점유권 만료", reverse: "후진" });
export type RobotPhase = (typeof RobotPhases.values)[number];

export const WorkStates = defineCodes({ idle: "대기", busy: "작업 중", unknown: "알 수 없음" });
export type WorkState = (typeof WorkStates.values)[number];
export const DriveStates = defineCodes({ stationary: "정지", moving: "이동 중", waiting: "대기 중", paused: "일시 정지", blocked: "차단됨", unknown: "알 수 없음" });
export type DriveState = (typeof DriveStates.values)[number];
export const NavigationModes = defineCodes({ free_navigation: "자유 주행", graph_navigation: "그래프 주행", unknown: "알 수 없음" });
export type NavigationMode = (typeof NavigationModes.values)[number];
export const PathPlanningAuthorities = defineCodes({ robot: "로봇", fms: "FMS", hybrid: "혼합", unknown: "알 수 없음" });
export type PathPlanningAuthority = (typeof PathPlanningAuthorities.values)[number];
export const CommandStates = defineCodes({ idle: "대기", sent: "전송됨", accepted: "수락됨", running: "실행 중", completed: "완료", cancelled: "취소됨", rejected: "거부됨", failed: "실패", interrupted: "중단됨" });
export type CommandState = (typeof CommandStates.values)[number];
export const PlanningPhases = defineCodes({ requested: "요청됨", completed: "완료", failed: "실패", discarded: "폐기됨" });
export type PlanningPhase = (typeof PlanningPhases.values)[number];
export const PlanningFailures = defineCodes({ no_route: REASON_CODES.labels.no_route, timeout: REASON_CODES.labels.timeout, worker_error: REASON_CODES.labels.worker_error, cancelled: REASON_CODES.labels.cancelled, stale_context: REASON_CODES.labels.stale_context });
export type PlanningFailure = (typeof PlanningFailures.values)[number];
export const RobotIds = defineCodes({ "robot-1": "로봇 1", "robot-2": "로봇 2" });
export type RobotId = (typeof RobotIds.values)[number];

export const PlannerModes = defineCodes({ coarse: "거친 탐색", fine: "정밀 탐색" });
export type PlannerMode = (typeof PlannerModes.values)[number];
export const CoarsePlanReasons = defineCodes({ blocked_endpoint: "시작점 또는 목적지가 차단됨", no_route: "경로 없음" });
export type CoarsePlanReason = (typeof CoarsePlanReasons.values)[number];
export const PlannerFallbackReasons = defineCodes({ blocked_endpoint: "시작점 또는 목적지가 차단됨", no_route: "거친 탐색 경로 없음", coarse_validation: "거친 경로 검증 실패", coarse_no_route: "거친 경로 없음" });
export type PlannerFallbackReason = (typeof PlannerFallbackReasons.values)[number];
export const ObstaclePlacementReasons = defineCodes({ current: "현재 로봇 위치", lookahead: "예상 주행 경로" });
export type ObstaclePlacementReason = (typeof ObstaclePlacementReasons.values)[number] | "";

export const RobotMotions = defineCodes({ IDLE: "대기", FOLLOW: "추종", ROTATE: "회전", HOLD: "정지 대기", LEASE_LOST: "점유권 만료", REVERSE: "후진", PAUSED: "일시 정지" });
export type RobotMotion = (typeof RobotMotions.values)[number];

export const RobotStatuses = defineCodes({ idle: "대기", move: "이동" });
export type RobotStatus = (typeof RobotStatuses.values)[number];

export const DriveCommandKinds = defineCodes({ move: "이동", dock: "충전 위치 정렬", teleporter: "텔레포터 이용", teleporter_entry: "텔레포터 진입", teleporter_clearing: "텔레포터 구역 비우기" });
export type DriveCommandKind = (typeof DriveCommandKinds.values)[number];
export const RobotCommandKinds = defineCodes({ ...DriveCommandKinds.labels, cancel: "취소", pose_override: "위치 재설정" });
export type RobotCommandKind = (typeof RobotCommandKinds.values)[number];

export const RobotCommandResults = defineCodes({ REROUTE: "경로 변경", VACATE: "구역 비우기", NONE: "실행 안 함", OK: "완료" });
export type RobotCommandResult = (typeof RobotCommandResults.values)[number];
