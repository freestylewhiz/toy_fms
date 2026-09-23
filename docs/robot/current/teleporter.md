# 텔레포터 로봇 런타임

현재 로봇은 텔레포터 handoff 중 목적지 지도를 검증하고 점유 컨텍스트를 교체한 뒤, 출구 pose에서 목적지 제어 세션을 다시 맺는다. 목적지 세션이 새 pose를 수신하고 control acknowledgement를 보낸 후 `destination_ready → arrived → clearing → completed` 순서로 clearing point까지 주행한다. 예약 polygon은 다른 로봇의 전체 footprint가 접촉하면 다음 이동을 보류하며, 동일한 제약 snapshot은 중복 재계획하지 않는다.

## 복구와 오류

`FMS_TRANSFER_STATE_FILE` 또는 `FMS_DATA_ROOT/robots` 아래 robot별 journal을 atomic rename으로 기록한다. journal에는 version, global robot ID, 현재 map, 유한한 pose, 마지막 transfer ID와 pending handoff가 포함된다. 재시작 시 map과 pose를 먼저 복원하고 목적지 gRPC에 재접속한다. 잘못된 JSON, 알 수 없는 map, 다른 robot ID, 비유한 좌표는 오류로 중단하며 native seed로 조용히 대체하지 않는다. 완료 journal도 삭제하지 않아 일반 주행 뒤 재시작해도 마지막 pose를 유지한다.

제어가 비활성화된 세션은 명령을 재개하지 않으며 pose telemetry만 계속 보낸다. 등록과 pose/control 메시지는 session ID와 control epoch로 fencing하고 stale 입력은 무시한다. 전송 중 지도 asset을 읽지 못하면 기존 context를 유지하고 실패 phase를 보고한다.

2026-09-17 · PILOT-9: 명시적 운영 제외로 제어가 비활성화되면 pending handoff와 재접속용
transfer identity를 제거하고 현재 맵·실제 보고 위치를 journal에 보존한다. 강제 종료된 이전을
재시작으로 되살리지 않으며 새 작업은 운영 재개 동기화 후에만 받는다. 서버는 공유 운영 제외
기록으로 양쪽 맵의 오래된 제어를 차단한다. 단순 연결 단절은 운영 제외와 구분한다.

기본 journal 경로는 실행 파일 기준 저장소의 `data/robots`이며, 공통 데이터 루트를 지정하면
`FMS_DATA_ROOT/robots`를 사용한다. 복구 harness는 실제 두 FMS와 Colyseus 상태를 사용해
텔레포트, 일반 주행 pose 저장, robot 재시작, lab FMS 재시작 후 새 session·control ready·pose
복원을 검증했다. clearing 중 연결이 끊기면 pending handoff를 보존하고 새 control synchronization
뒤 clearing을 재개한다. 2026-09-21에는 PM2 공통 `FMS_DATA_ROOT=data`에서 저널을 잘못 읽던
경로를 `data/robots`로 고정해 재시작 시 목적지 맵이 유지되도록 했다.
