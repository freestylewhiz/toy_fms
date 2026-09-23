# FMS

FMS 테스트 야드는 Bun 기반의 웹 클라이언트, Colyseus/gRPC 서버, 가상 로봇으로 구성된 로컬 실행 프로젝트다. 브라우저는 Colyseus로 FMS 상태를 받고, 로봇 프로세스는 gRPC RobotBridge에 연결한다. MQTT는 사용하지 않는다.

## 실행 환경
- OS: Linux 기준
- 런타임: Bun 1.3.13 이상
- 패키지 관리자: Bun (bun.lock)
- 데이터베이스: Bun SQLite (외부 DB 없음)
- 작업 경로: /project/workspace/fms (/project_workspace/fms의 심볼릭 링크)

## 저장소 구성
- web-client/: 맵 에디터와 정적 파일 서버
- server/: Colyseus floor 룸, 주행·트래픽 로직, gRPC RobotBridge
- virtual-robot/: gRPC 시뮬레이터 로봇
- shared/: 포트와 공유 타입·저장소
- resources/: 맵 이미지·점유 맵·로봇 리소스
- data/: SQLite 운영·편집 데이터
- scripts/: 맵 생성 및 검증 스크립트
- docs/: 사용자 안내와 설계 기록

## 서비스와 포트
포트는 shared/constants.ts에 정의되어 있다.

| 서비스 | 바인드 | 포트 | 용도 |
| --- | --- | ---: | --- |
| 웹 클라이언트 | 0.0.0.0 | 5174 | HTTP 정적 서버 |
| Colyseus | 0.0.0.0 | 2568 | WebSocket 룸 floor |
| RobotBridge | 0.0.0.0 | 50062 | 로봇 gRPC |
| Large Lab Colyseus | 0.0.0.0 | 2569 | 대형 맵 WebSocket |
| Large Lab RobotBridge | 0.0.0.0 | 50063 | 대형 맵 로봇 gRPC |

원본 bg_fms 포트(5173/2567/50061)와 함께 실행할 수 있도록 분리되어 있다.

## 실행

새 체크아웃에서는 의존성과 Large Lab 점유맵을 먼저 준비한다. 100MB씩인 Large Lab
점유맵 바이너리 두 개는 Git에 포함하지 않으며 생성 스크립트로 복원한다.

~~~sh
bun install
bun install --cwd server
bun install --cwd web-client
bun install --cwd virtual-robot
bun run maps:large-lab
~~~

개발 중에도 서비스 데몬은 PM2가 관리한다. systemd는 사용하지 않는다.
PM2가 설치되어 있지 않으면 `bun install --global pm2`로 준비한다.

~~~sh
# 전체 시작: 웹, 두 맵 FMS, Yard에서 시작하는 가상 로봇 2대
bun run pm2:start

# 상태·로그·재시작·종료
pm2 status
pm2 logs fms-yard-server
bun run pm2:restart
bun run pm2:stop
~~~

브라우저에서 http://localhost:5174 를 연다. 가상 로봇은 localhost:50062에 접속한다.
텔레포터로 Large Lab으로 이동하면 같은 가상 로봇 프로세스가 목적지 FMS로 연결을 전환한다. Large Lab 전용 가상 로봇 프로세스를 별도로 실행하지 않는다.

## 환경 변수
| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| TRAFFIC_POLICY_ID | local_plan_v1 | 트래픽 정책 선택 |
| ATLAS_WEB_URL | http://127.0.0.1:5174 | 웹 검증 스크립트 주소 |
| FMS_MAP_ID | yard | 단독 Bun 실행 또는 격리 검사의 시작 맵. PM2 로봇은 저널의 현재 맵을 우선 복원 |
| FMS_DATA_ROOT | 저장소의 data/ | 편집·운영 DB 루트. 두 FMS는 같은 루트를 사용한다 |
| TELEPORTER_SQLITE_PATH | data/teleporters.sqlite | 두 층이 공유하는 텔레포터 정의·예약·이전 기록 |
| FMS_PORT_OFFSET | 0 | 웹·두 맵 WS/gRPC 포트에 더할 정수(0~15472). 격리 검증용 |
| FMS_TRANSFER_STATE_FILE | data/robots/robot-<ID>.teleporter.json | 가상 로봇의 맵·위치·이전 복구 기록 파일. 지정하지 않으면 `FMS_DATA_ROOT/robots` 아래에 저장 |

## 데이터와 리소스
- data/editor.sqlite: 맵·웨이포인트·충전소 편집 데이터
- data/runtime.sqlite: 운영 제외, 점유·예약·대기열, 복구 감사 기록
- data/large_lab/{editor,runtime}.sqlite: Large Lab의 맵별 데이터
- data/teleporters.sqlite: 맵 간 공유 리소스 정본과 로봇 소유권·이전 기록
- data/robots/: 가상 로봇별 이전 복구 JSON. FMS_DATA_ROOT를 지정하면 해당 루트의 `robots/` 아래에 저장
- data/before-driving-*.json: 주행 전 백업 스냅샷
- resources/maps/: PNG 및 occupancy JSON/BIN 맵 자산

SQLite 파일은 실행 중 변경되므로 삭제 전 백업한다. 맵 생성은 bun run occupancy, bun run maps:floor-assets를 사용한다.
`data/` 전체와 로그·빌드 결과물·로컬 환경 설정은 Git에서 제외한다. 실행 데이터는 별도로 백업해야 한다.

## 검증과 테스트
~~~sh
bun test
bun run smoke
bun run check:editor
bun run check:protocol
bun run check:runtime:web
bun run check:driving:resources
bun run check:driving:web
~~~

## Docker 상태
현재 저장소에는 Dockerfile이나 docker-compose.yml이 없다. 공식 실행 경로는 호스트에서 Bun 프로세스를 직접 실행하는 방식이며 Docker 이미지·컨테이너·볼륨·포트 매핑은 제공하지 않는다. Docker 배포가 필요하면 5174, 2568, 50062 포트와 data/ SQLite 영속 볼륨을 기준으로 별도 구성을 추가한다.

## 문서와 운영

[문서 목차](docs/README.md)에서 컴포넌트별 현재 구현과 논의 주제를 확인한다.

- [공통 구조](docs/concept/current/architecture.md) · [문서 관리 규칙](docs/concept/current/documentation-policy.md)
- [FMS 운영·점유 복구](docs/fms/current/runtime-recovery.md) · [트래픽](docs/fms/current/traffic.md)
- [웹 편집](docs/web/current/editor.md) · [웹 운용](docs/web/current/operations.md)
- [블랙박스 기록](docs/fms/current/blackbox.md) · [블랙박스 재생](docs/web/current/blackbox.md)
- [운영 일시정지](docs/concept/current/operator-motion-pause.md) · [로봇 이벤트 콘솔](docs/web/current/robot-event-console.md)
- [로봇 주행](docs/robot/current/navigation.md) · [통신 계약](docs/robot/current/protocol.md)
- [검증 절차](docs/concept/current/verification.md)

문서는 `docs/{concept,fms,web,robot}/{current,backlog,todo}/` 구조를 유지한다.
`current`는 구현·현행 정책, `backlog`는 논의 후보, `todo`는 합의한 구현 작업이다.
진행 중인 합의 작업은 해당 컴포넌트의 `todo`에서 확인한다. 새 체크아웃에서 빈 폴더를 복원하려면 다음을 실행한다.

```sh
mkdir -p docs/{concept,fms,web,robot}/todo
```

개발 아이템·칸반 상태·첨부 파일은 `/project_management`의 Vikunja로 관리한다.
`http://192.168.0.172:3456`에서 FMS 아래 `planning`, `web`, `server`, `robot` 프로젝트를 사용한다.
Backlog.md 서비스와 이관 원본은 2026-09-18에 제거했다.

## 작업 시작
~~~sh
cd /project/workspace/fms
~~~

원본 백업은 /home/dyhwang23/workspace/jsearch_rebuild_repo/working_directory/image_search/bg_fms_v1_new_ui에 보존되어 있다.

## 대형 테스트맵 — Large Lab

[구성·정책·검증](docs/concept/current/large-test-map.md). 10,000×10,000픽셀(500×500m), 중앙 원형 기둥·회랑과 네 개의 벽체 방이다.

```sh
bun run maps:large-lab     # 새 체크아웃 또는 자산을 다시 생성할 때
bun run pm2:start          # Large Lab FMS도 함께 시작
```

웹에서 **Large Lab**을 선택하거나 http://localhost:5174/?map=large_lab 로 접속한다.
`FMS_MAP_ID=large_lab` 프로필은 `data/large_lab/`에 데이터를 저장한다. 기본값은 `yard`다.
대형 맵의 통로·벽 판정은 1억 셀 원해상도이며 화면 텍스처는 메모리 사용을 줄인 축소본이다.

## 텔레포터 개발·검증

[공통 계약](docs/concept/current/teleporter.md) · [웹 사용법](docs/web/current/teleporter.md).

양쪽 맵의 FMS를 실행한 상태에서 웹 텔레포터 도구로 입출구를 배치한다.
Yard에서 시작한 `robot-1`은 층을 이동해도 `robot-1` ID를 유지한다. 맵은 로봇 ID가 아니라 공유 텔레포터 소유권과 전환 기록으로 구분한다.
기존 `large_lab:robot-1` 형식의 저장 행은 서버 시작 시 `robot-1`로 통합한다.

```sh
bun run scripts/check_teleporter_runtime.ts  # 격리된 FMS·로봇으로 왕복/자동 이탈/DB 확인
bun run scripts/check_teleporter_queue.ts   # 다중 요청과 취소
bun run scripts/check_teleporter_queue_flow.ts # 출구 차단 대기·FIFO 이동·자동 재개
bun run scripts/check_teleporter_recovery.ts # 일반 주행 후 로봇·목적지 FMS 재시작
bun run check:teleporter:web                # 실제 브라우저 양 끝 편집·저장·취소·삭제
```

검증 스크립트는 임시 데이터 루트와 별도 포트를 사용한다. 실행 중인 서비스에 코드 변경을 적용하려면
해당 Bun 프로세스를 재시작하고 브라우저를 새로고침한다.
