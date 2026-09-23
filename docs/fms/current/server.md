# FMS 서버와 데이터

FMS는 server/에 있다. 서버는 floor 룸을 준비한 뒤 RobotBridge를 연다.
yard의 Colyseus는 2568, gRPC는 50062이고 large_lab은 각각 2569, 50063이다.
맵별 별도 프로세스의 단일 floor 룸을 사용하며 패치 주기는 50 ms다.
Colyseus 전송은 BunWebSockets를 우선 사용하고 실패하면 ws-transport로 폴백한다.

## 리소스와 메시지

편집 상태에는 웨이포인트, 충전소, 장애물, 존, 노드, 엣지, 스테이션, 포털, 레일이 있다.
메시지별 정확한 필드·검증 규칙은 룸과 편집 핸들러를 기준으로 한다.

| 메시지 | 역할 |
| --- | --- |
| placeWaypoint / placeCharger / moveAsset / deleteAsset | 기본 리소스 편집 |
| editorUpsert / editorDelete | 편집 리소스 저장·삭제 |
| placeObstacle / moveObstacle / deleteObstacle | 장애물과 로봇 스냅샷 갱신 |
| commandRobot / cancelRobot | 이동·도킹·취소 |
| setRobotControl / releaseResourceOccupancy | 운영 참여·수동 점유 복구 |

서버 확인은 editorAck, obstacleAck, commandAck, runtimeAck 및 error로 전달한다.
commandAck는 전송 확인이고 실제 완료는 로봇 보고로 반영한다.

장애물 생성·이동·크기 변경은 연결 로봇의 배치 허용 응답을 확인한다.
거부나 timeout이면 저장하지 않는다. 연결 로봇이 없으면 투표를 생략한다.
DB에서 기존 장애물을 복원할 때는 투표하지 않는다.

## 저장

| 파일 | 내용 |
| --- | --- |
| data/editor.sqlite | 편집 리소스와 속성 |
| data/runtime.sqlite | 로봇 운영 설정·최근 보고, 점유·대기열, 감사 기록 |

런타임과 편집 DB를 혼용하지 않는다. 현재 명령 결과의 Colyseus 투영은 영구 작업 이력 DB가 아니다.
운영 설정은 즉시 저장하고 로봇 위치 보고는 최대 1초 단위로 묶어 저장한다.

근거: [서버 시작](../../../server/src/index.ts), [FloorRoom](../../../server/src/rooms/FloorRoom.ts),
[Schema](../../../server/src/schema.ts), [편집 핸들러](../../../server/src/editorHandlers.ts),
[편집 저장소](../../../shared/store.ts), [런타임 저장소](../../../server/src/runtimeStore.ts).

FMS_MAP_ID=large_lab이면 data/large_lab/ 아래에 편집·운영 DB를 분리한다.
[맵별 실행](../../concept/current/large-test-map.md)을 참고한다.

## 데몬 실행

개발·검증 데몬은 `ecosystem.config.cjs`를 통해 PM2가 관리한다. `bun run pm2:start`로
웹, 두 맵 FMS, Yard에서 시작하는 가상 로봇 두 프로세스를 함께 실행하며, 텔레포터가
로봇 프로세스의 목적지 FMS 연결을 전환한다. systemd 유닛은 실행 경로에 포함하지 않는다.

## 2026-09-22 운영 일시정지와 로봇 이벤트 조회

PLAN-14의 저장된 정지 의도·적용 ACK·점유 보존은 [공통 일시정지 계약](../../concept/current/operator-motion-pause.md)을 따른다.
PLAN-15의 `robot_events_query/result`는 기존 블랙박스 인덱스를 제한된 창으로 조회하고
로봇·시간·수준·종류·커서·공백을 전달한다. [콘솔 계약·검증](../../web/current/robot-event-console.md) 참고.
