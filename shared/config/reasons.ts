import { defineCodes } from './defineCodes.ts';

/** Machine-readable reasons only. Free-form exception messages remain diagnostic data. */
export const REASON_CODES = defineCodes({
  'step-back': '지나온 경로를 따라 다음 0.5m 후퇴 시도',
  'e3-vacate': '교착 해소 요청으로 후퇴 시작',
  'blocked-no-detour': '우회 경로를 찾지 못해 후퇴 시작',
  'detour-too-long': '우회 후보 경로가 허용 거리보다 김',
  'detour-reference-unavailable': '우회 경로 길이를 비교할 기준 경로를 확인할 수 없음',
  request_id_conflict: '이미 사용된 요청 ID', invalid_request: '잘못된 요청', control_epoch_mismatch: '제어 세대 불일치',
  wrong_map: '로봇이 다른 맵에 있음', teleporter_transition: '텔레포터 전환 중', request_pending: '이전 요청 처리 중',
  awaiting_robot_ack: '로봇 응답 대기', applied: '적용 완료', rejected: '요청 거절', already_applied: '이미 적용됨',
  paused: '일시정지됨', resumed: '재개됨', timeout: '응답 시간 초과', offline: '연결 끊김',
  transfer_in_progress: '맵 전환 중', control_unavailable: '제어할 수 없음', semantic_blocked: '진입 금지 구역',
  path_blocked: '경로가 막힘', peer_blocked: '다른 로봇이 경로를 막음', traffic_stop: '교통 제어로 정지',
  lease_lost: '통행권 만료', traffic_permission_pending: '통행 허가 대기', resource_occupied: '리소스 사용 중',
  permission_pending: '사용 허가 대기', obstacle_detected: '장애물 감지', route_update_pending: '경로 재계산 중',
  traffic_yield: '다른 로봇에 통행 양보', operator_paused: '사용자 일시정지', operator_pause_rejected: '일시정지 요청 거절',
  operator_pause_error: '일시정지 처리 오류', local_pose_infeasible: '로봇을 배치할 수 없는 위치',
  no_route: '목적지까지 경로 없음', worker_error: '경로 계산 프로세스 오류', cancelled: '취소됨', stale_context: '계산 중 주변 상황 변경',
  operator_disabled_reconcile: '운영 제외 복구 처리', operator_disabled: '사용자가 운영에서 제외함',
  session_changed: '연결 세션 변경', control_changed: '운영 제어 변경', server_disposed: '서버 종료',
  never_seen: '아직 연결된 적 없음', synchronizing: '제어 상태 동기화 중', session_lost: '연결 세션 종료',
  'invalid pose': '잘못된 위치 또는 방향',
  pose_override_failed: '테스트 위치 지정 실패',
  'server restarted': '서버 재시작', 'operator disabled': '사용자가 운영에서 제외함',
  'teleporter destination synchronizing': '텔레포터 목적지 제어 상태 동기화 중',
  'cancel requested': '명령 취소 요청', 'control synchronization required': '제어 상태 동기화 필요',
  'operator pose override': '사용자가 테스트 위치를 지정함', 'robot disconnected': '로봇 연결 끊김',
  'robot session disconnected': '로봇 세션 연결 끊김', 'sent to robot': '로봇에 명령 전송',
  'teleporter clearing completed': '텔레포터 이탈 완료', 'teleporter entry': '텔레포터 진입',
  'teleporter request cancelled': '텔레포터 요청 취소', 'teleporter reservation promoted': '텔레포터 이용 예약 확정',
  'teleporter waiting at approach boundary': '텔레포터 진입 경계에서 대기',
});

export const BLACKBOX_ERRORS = defineCodes({
  asset_not_found: '기록 자산을 찾을 수 없음', checkpoint_unavailable: '복원 기준 장면 없음',
  cursor_asof_mismatch: '조회 기준 시각 불일치', cursor_filter_mismatch: '조회 필터 불일치', cursor_query_mismatch: '조회 조건 불일치',
  event_not_found: '이벤트를 찾을 수 없음', event_unavailable: '이벤트 원문을 읽을 수 없음', generation_changed: '기록 세대 변경',
  historical_asset_unavailable: '과거 지도 자산 없음', historical_asset_copy_failed: '과거 지도 자산 저장 실패',
  invalid_as_of: '잘못된 조회 기준 시각', invalid_asset_path: '잘못된 자산 경로', invalid_cursor: '잘못된 조회 커서',
  invalid_limit: '잘못된 조회 개수', invalid_map_id: '잘못된 맵 ID', invalid_operation_cursor: '잘못된 운용 이력 커서',
  invalid_robot_id: '잘못된 로봇 ID', invalid_time_range: '잘못된 조회 기간', missing_operation_id: '운용 ID 누락',
  result_limit_exceeded: '조회 결과 개수 한도 초과', result_payload_limit_exceeded: '조회 결과 용량 한도 초과',
  reverse_range: '시작 시각이 종료 시각보다 늦음', scan_limit_exceeded: '기록 탐색 한도 초과',
  stale_cursor: '이전 기록 세대의 커서', stale_operation_cursor: '운용 이력 조회 조건 변경', stale_operation_generation: '운용 이력 기록 세대 변경',
});

export const QUERY_LIMIT_REASONS = defineCodes({
  index_scan_limit: '인덱스 탐색 한도 도달', event_limit: '이벤트 개수 한도 도달', missing_event: '이벤트 원문 누락', corrupt_index: '인덱스 손상',
});
