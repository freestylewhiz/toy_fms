import { defineCodes } from "./defineCodes.ts";

export const FmsControlStates = defineCodes({ enabled: "활성", disabled: "비활성" });
export type FmsControlState = (typeof FmsControlStates.values)[number];
export const DriveContextSources = defineCodes({ robot: "로봇", fms: "FMS", transport: "통신" });
export type DriveContextSource = (typeof DriveContextSources.values)[number];
export const PermissionStates = defineCodes({ queued: "대기열", granted: "허가됨", denied: "거부됨", pending: "확인 중" });
export type PermissionState = (typeof PermissionStates.values)[number];
export const OccupancyStates = defineCodes({ occupied: "점유", reserved: "예약", queued: "대기열" });
export type OccupancyState = (typeof OccupancyStates.values)[number];
export const TeleporterUseStates = defineCodes({ queued: "대기열", reserved: "예약", occupied: "점유", clearing: "통과 중" });
export type TeleporterUseState = (typeof TeleporterUseStates.values)[number];
export const TeleporterTransferPhases = defineCodes({ requested: "요청됨", reserved: "예약됨", entry_approach: "진입 접근", entry_aligned: "진입 정렬", destination_loading: "목적지 로딩", destination_ready: "목적지 준비", arrived: "도착", clearing: "구역 비우기", completed: "완료", failed: "실패" });
export type TeleporterTransferPhase = (typeof TeleporterTransferPhases.values)[number];

export const TrafficStatuses = defineCodes({
  clear: "통제 없음", proceed: "진행", partial: "일부 허가", hold: "대기", stop: "정지", evade: "회피", lease_lost: "점유권 만료",
});
export type TrafficStatus = (typeof TrafficStatuses.values)[number];
export const TrafficStatusDetails = defineCodes({
  clear: "교통 제어상 제한 없음", proceed: "현재 경로로 진행 가능", partial: "앞쪽 정지선까지 진행",
  hold: "교통 제어 신호를 기다리는 중", stop: "안전을 위해 즉시 정지", evade: "교착을 풀기 위해 우회 중",
  lease_lost: "교통 권한이 끊겨 정지 대기",
});

export const TrafficSignals = defineCodes({ STOP: "정지", PROCEED: "진행", PARTIAL: "일부 진행" });
export type TrafficSignal = (typeof TrafficSignals.values)[number];
export const TrafficSignalWireNames = defineCodes({ SIGNAL_STOP: "정지", SIGNAL_PROCEED: "진행", SIGNAL_PARTIAL: "일부 진행" });
export const TrafficSignalWireNumbers = Object.freeze({
  code: Object.freeze({ SIGNAL_STOP: 0, SIGNAL_PROCEED: 1, SIGNAL_PARTIAL: 2 } as const),
  values: Object.freeze([0, 1, 2] as const),
});
export const EvasionWireNames = defineCodes({ EVASION_REROUTE: "경로 변경", EVASION_VACATE: "구역 비우기" });
export const EvasionWireNumbers = Object.freeze({ code: Object.freeze({ EVASION_REROUTE: 0, EVASION_VACATE: 1 } as const), values: Object.freeze([0, 1] as const) });

export const TrafficStopDecisions = defineCodes({ STOP: "정지", RESUME: "재개" });
export type TrafficStopDecision = (typeof TrafficStopDecisions.values)[number];

export const EvasionModes = defineCodes({ REROUTE: "경로 변경", VACATE: "구역 비우기" });
export type EvasionMode = (typeof EvasionModes.values)[number];

export const TrafficPolicyIds = defineCodes({ corridor_lease_v0: "복도 점유 v0", local_plan_v1: "공유 경로 v1" });
export type TrafficPolicyId = (typeof TrafficPolicyIds.values)[number];

export const TrafficPlanActionKinds = defineCodes({ grant: "허가", bid_request: "입찰 요청", evasion_request: "회피 요청", zone_update: "구역 갱신", set_status: "상태 설정" });
export type TrafficPlanActionKind = (typeof TrafficPlanActionKinds.values)[number];

export const ZoneUpdateStates = defineCodes({ hold: "대기", resume: "재개", peer_cleared: "다른 로봇 통과 완료", peer_action_done: "다른 로봇 작업 완료", yield: "양보", wait: "대기", proceed: "진행", clear: "통제 없음", open: "개방", PROCEED: "진행 허가", STOP: "정지" });
export type ZoneUpdateState = (typeof ZoneUpdateStates.values)[number];
export const TeleporterEndpointBlockReasons = defineCodes({ reserved: "텔레포터 예약됨", body_overlap: "로봇이 구역에 있음" });
export type TeleporterEndpointBlockReason = (typeof TeleporterEndpointBlockReasons.values)[number];
export const RuntimeAuditActions = defineCodes({ manual_release_disable: "운영 제외로 점유 해제", operator_disable_release_all: "로봇 운영 제외", reactivate_requested: "운영 재참여 요청", reactivated: "운영 재참여 완료", reactivation_failed: "운영 재참여 실패", pose_override_requested: "로봇 위치 변경 요청", pose_override_pose_confirmed: "로봇 위치 변경 확인", pose_override_failed: "로봇 위치 변경 실패" });
export type RuntimeAuditAction = (typeof RuntimeAuditActions.values)[number];
