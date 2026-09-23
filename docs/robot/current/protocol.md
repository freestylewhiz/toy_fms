# 로봇 연결과 명령 계약

정본: [robot.proto](../../../proto/robot.proto), [버전·상태](../../../shared/robotProtocol.ts).
현재 저장소의 자체 프로토콜 버전은 5다. VDA나 MQTT가 아닌 gRPC 양방향 RobotBridge.Session을 사용한다.
가상 로봇 연결 대상은 맵 프로필에 따라 yard는 localhost:50062, large_lab은 localhost:50063이다.
서버와 로봇은 동일한 FMS_MAP_ID를 사용한다.

## 연결·제어 준비

1. 로봇이 register(robot_id, protocol_version)로 등록한다.
2. 서버가 장애물·시맨틱 스냅샷, session_ready, control_state를 보낸다.
3. 로봇이 과거 명령·허가를 정리하고 같은 세대의 최신 pose 다음 control_ack를 보낸다.
4. 서버가 연결·상태·제어 준비를 확인한 뒤 정상 명령을 허용한다.

등록 ID·프로토콜 버전과 스트림 소유권을 확인한다.
sessionId와 controlEpoch는 서로 다른 식별자이며 늦은 세션·세대의 제어 메시지를 거부한다.
서버 heartbeat는 500 ms, 세션 timeout은 3초다.
로봇은 heartbeat가 끊기면 주행을 보류하고 연결을 종료한 뒤 재연결한다.

## 상태와 명령

pose와 local_plan은 50 ms 주기로, path는 변경 시 보고한다.
명령은 idle → sent → accepted/running → completed/cancelled/rejected/failed 상태로 투영된다.
연결·제어권 상실은 interrupted로 표현할 수 있다. 모든 명령이 중간 상태를 순서대로 반드시 거친다는 뜻은 아니다.
다른 과거 명령 ID의 결과와 역행 보고는 현재 명령에 적용하지 않는다.

취소는 현재 command_id를 대상으로 하며 전송만으로 완료 처리하지 않는다.
완료 결과는 이후 pose에도 남긴다. 새 세션에서 과거 작업을 자동 재개하지 않는다.
운영 제외 중에도 위치·실제 상태 보고는 유지하지만 정상 경로·허가를 복원하지 않는다.
상세 운영 정책은 [FMS 복구](../../fms/current/runtime-recovery.md)에 따른다.

## 2026-09-21 위치 지정 ACK와 블랙박스

테스트 위치 지정은 `pose_override_ack(request_id, applied, reason_code, session_id, control_epoch)`로
적용/거절을 명시한다. 적용 ACK 이후의 새 pose가 같은 요청 위치·idle·stationary를 확인해야 서버가
성공 처리한다. 요청 전부터 좌표가 같아도 ACK 없는 일반 pose로 성공 처리하지 않는다.
거절/timeout 시 제어 세대를 올려 늦은 적용을 차단하며 운영 제외 상태를 유지한다.
로봇은 같은 세션·세대·요청의 적용 결과를 캐시해 재전송을 중복 적용하지 않는다.

disabled 로봇도 위치 검증용 peer 관측과 세대가 붙은 텔레포터 제약을 수신한다.
이는 주행 권한이 아니며 move/dock 등 운용 메시지의 제어 guard는 유지한다.
운영 제외·오프라인 peer는 마지막 관측 몸체를 장애물로 남기되 과거 미래 경로를 보내지 않는다.

양방향 envelope에 `operation_id`를 추가해 FMS·로봇의 파일 trace를 연결한다.
버전 2와 혼합 운용하지 않는다. 적용할 때 FMS와 로봇을 PM2로 함께 갱신해야 하며
진행 중 작업을 중단할 수 있으므로 운영 중 재시작은 별도 확인 후 수행한다.
[블랙박스 기록](../../fms/current/blackbox.md)을 참고한다.

근거: [로봇 gRPC](../../../virtual-robot/src/grpcClient.ts),
[서버 gRPC](../../../server/src/grpc/robotBridge.ts),
[명령 투영](../../../server/src/commandProjection.ts),
[통합 검사](../../../scripts/protocol.integration.test.ts).


## 2026-09-22 v4 — 교통 STOP 재평가

PLAN-18 / SRV-11 / ROBOT-10의 승인 범위다. `LeaseGrant`의 STOP은
`stop_id`, `stop_generation`으로 식별한다. 로봇은 정지 중 약 1초마다
`traffic_stop_check(robot_id, stop_id, stop_generation, control_epoch, session_id)`를 보내고,
FMS는 `traffic_stop_status(stop_id, stop_generation, decision, reason, control_epoch, session_id)`로 답한다.
`decision`은 STOP 또는 RESUME다. 통신 두절·응답 누락·시간 경과만으로 정지를 해제하지 않는다.

로봇은 현재 STOP 식별자·세대가 일치하는 RESUME만 수용한다. 이전 세대의 응답,
일반 PROCEED grant, zone resume, 명령 정리, 회피 설정 변경은 식별된 STOP을 해제하지 못한다.
동일 STOP 유지 응답을 반복 수신해도 폴링 주기가 짧아지지 않는다. session/controlEpoch가
바뀌면 과거 토큰과 우회 결과 캐시를 정리하며 과거 명령을 자동 재개하지 않는다.

우회 요청은 zone/round로 연관시킨다. 다른 계획을 계산 중이면 해당 계획을 취소하고
우회용 계산을 시작한다. 성공·실패·취소·두 차례 stale 결과에 종결 응답을 보내며,
같은 요청의 중복 수신에는 계산을 중복 실행하지 않고 이미 완료된 결과를 재전송한다.
VACATE도 진행 중 계산을 먼저 취소해 늦은 계산 결과가 후퇴 경로를 덮지 못하게 한다.

v3와 혼합 운용하지 않는다. 서버·가상 로봇을 함께 v4로 재기동해야 한다.
이번 변경의 운영 적용 여부와 최종 검증 근거는 [STOP 복구](../../fms/current/traffic-stop-recovery.md)에 기록한다.

## 2026-09-22 v5 — 운영 일시정지

`motion_pause(request_id, paused, session_id, control_epoch)`와
`motion_pause_ack(robot_id, request_id, paused, applied, reason_code, session_id, control_epoch)`를
추가했다. `ControlState.operator_paused`는 저장된 의도를 복원하고 pose/local plan은
적용 상태를 보고한다. 교통 STOP 프로토콜과 명령·점유·제어 세대는 독립적으로 유지한다.
`PeerLocalPlan.operator_paused`와 정지 몸체 예측으로 외부 미래 경로를 구분한다.
상세 계약·검증은 [운영 일시정지](../../concept/current/operator-motion-pause.md)를 따른다.
서버와 가상 로봇은 v5로 함께 갱신하며 v4와 혼합 운용하지 않는다.


## 2026-09-22 블랙박스 v2 기록 세대 호환

ROBOT-6의 기존 프로토콜·계획 계측은 그대로 공유 Recorder를 사용한다.
[블랙박스 세대·삭제 정책](../../fms/current/blackbox.md)의 최종 쓰기 잠금과 세대 변경을 함께 적용한다.
격리된 실제 두 로봇 검사에서 기록 삭제 중 실행 명령·좌표·경로·epoch·수동 정지를 보존하고
같은 명령의 재개 완료와 새 세대 기록 수집을 확인했다. 별도 prefer 교차 주행 진단은
이 호환성 검증만으로 완료 처리하지 않는다.


## 2026-09-23 이벤트 표시 컨텍스트

`DriveCommand.event_context_json`(필드 번호 8)은 대상 리소스의 ID·종류·이름·맵을 전달하는
선택적 진단 필드다. 서버가 명령 시점의 리소스 이름을 기록하고 로봇의 수신·실행·결과·계획
이벤트에 연결한다. 실제 명령 종류·좌표는 기존 주행 필드를 우선하며 진단 필드로 제어하지 않는다.

누락된 필드는 기존처럼 처리하며 프로토콜 버전은 5를 유지한다. 명령별 컨텍스트는 제한된
캐시에 보관해 늦게 종료된 계획도 원래 명령 ID·목표 이름으로 기록한다.
[프로토콜 통합 검사](../../../scripts/protocol.integration.test.ts)와
[로봇 기록 검사](../../../virtual-robot/src/grpcClient.test.ts)로 선택 필드 왕복·누락 호환과
명령 연결을 검증한다. 코드와 표시명은 [공통 카탈로그](../../concept/current/code-catalogs.md)를 따른다.
