import { defineCodes } from './defineCodes.ts';

/** RobotBridge oneof field names; protobuf remains the wire schema authority. */
export const PROTOCOL_MESSAGES = defineCodes({
  register: '로봇 등록', pose: '위치 보고', path: '전체 경로 보고', place_reply: '장애물 배치 응답',
  lease_request: '통행권 요청', lease_release: '통행권 반납', traffic_bid: '통행 우선순위 응답',
  evasion_reply: '회피 결과', breadcrumb: '이동 흔적 보고', local_plan: '단기 경로 보고',
  command_state: '명령 상태 보고', control_ack: '운영 제어 확인', teleporter_transfer: '텔레포터 전환',
  pose_override_ack: '테스트 위치 지정 결과', traffic_stop_check: '교통 정지 재평가 요청',
  motion_pause_ack: '일시정지·재개 결과', drive: '주행 명령', cancel: '명령 취소',
  place_query: '장애물 배치 확인', obstacles: '장애물 목록', lease_grant: '통행권 허가',
  bid_request: '통행 우선순위 요청', evasion_request: '회피 요청', zone_update: '구역 상태 갱신',
  sensed_peers: '주변 로봇 관측', fleet_local_plans: '다른 로봇의 단기 경로',
  semantic_snapshot: '리소스 정보 갱신', session_ready: '세션 준비 완료', heartbeat: '연결 상태 확인',
  control_state: '운영 제어 상태', teleporter_constraints: '텔레포터 제약',
  pose_override: '테스트 위치 지정', traffic_stop_status: '교통 정지 재평가 결과', motion_pause: '일시정지·재개 요청',
});

export const OPERATION_KINDS = defineCodes({
  placeWaypoint: '웨이포인트 배치', placeCharger: '충전소 배치', moveAsset: '리소스 이동', deleteAsset: '리소스 삭제',
  editorUpsert: '리소스 저장', editorDelete: '리소스 삭제', teleporterUpsert: '텔레포터 저장', teleporterDelete: '텔레포터 삭제',
  setRobotControl: '로봇 운영 참여 변경', robot_motion_pause: '로봇 일시정지·재개', robot_events_query: '로봇 이벤트 조회',
  setVirtualRobotPose: '테스트 위치 지정', releaseResourceOccupancy: '리소스 점유 해제',
  commandRobot: '로봇 명령', cancelRobot: '로봇 명령 취소', placeObstacle: '장애물 배치',
  moveObstacle: '장애물 이동', deleteObstacle: '장애물 삭제',
});

export const REPLY_KINDS = defineCodes({
  commandAck: '명령 처리 결과', runtimeAck: '운영 제어 결과', editorAck: '리소스 편집 결과', obstacleAck: '장애물 편집 결과',
  teleporterAck: '텔레포터 편집 결과', robot_motion_pause_result: '일시정지·재개 처리 결과',
  robot_events_result: '로봇 이벤트 조회 결과', virtualRobotPoseAck: '테스트 위치 지정 결과', error: '요청 오류',
});

export const PROTOCOL_DIRECTIONS = defineCodes({ send: '송신', receive: '수신', discard: '폐기' });
