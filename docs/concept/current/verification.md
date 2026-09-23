# 검증 절차

이 문서는 실행 방법과 검증 범위다. 과거 실행의 통과 개수를 현재 결과로 보증하지 않는다.
명령 정본은 [package.json](../../../package.json)이다.

## 서비스 없이 실행하는 검사

~~~sh
bun test
bun run check:protocol
bun run smoke
bun run test:traffic-v1
~~~

smoke 기본 모드는 시드 배치와 계획 경로를 확인한다. --live를 추가하면 서버에 명령을 보낸다.
프로토콜 통합 테스트는 protobuf, 메시지 처리, 컨트롤러와 상태 투영을 검증하지만
실제 TCP/HTTP2/WebSocket 전송 검증을 대체하지 않는다.

## 서비스가 필요한 검사

| 명령 | 전제·영향 |
| --- | --- |
| bun run check:editor | FMS 실행, 테스트 리소스 생성·수정 |
| bun run check:driving:resources | editor.sqlite에 drive-* 배치 필요 |
| bun run check:driving:live | FMS와 유휴 가상 로봇, 실제 이동·취소 |
| bun run check:driving:web | FMS·웹·로봇 및 Chromium, 실제 UI 주행 |
| bun run check:runtime:web | FMS·웹·유휴 로봇, 점유 해제·제외·재활성화 |
| bun run check:properties:web | 편집 저장·취소·삭제 확인 |
| bun run check:workspace:web | 검색·명령 도구·레이아웃 |

브라우저 검사는 루트 Playwright 의존성과 Chromium이 필요하다.
웹 검사 대상 주소는 ATLAS_WEB_URL로 지정할 수 있다.
운영 데이터가 있는 환경에서는 별도 복사본에서 검사하고, 라이브 검사는 순차 실행한다.

주행 배치 생성은 서버 시작 전에 bun run setup:driving으로 수행한다.
기존 편집 배치를 data/before-driving-*.json으로 백업하고 drive-* 목적지와 복도 존을 갱신한다.
이 명령은 데이터 변경 작업이며 일반 서버 기동의 필수 단계가 아니다.

대표 근거: [프로토콜 테스트](../../../scripts/protocol.integration.test.ts),
[세션 테스트](../../../scripts/robot_session.integration.test.ts),
[런타임 테스트](../../../scripts/runtime.integration.test.ts),
[웹 런타임 검사](../../../web-client/check_runtime.ts).

## 텔레포터 격리 통합 검사

각 명령이 임시 데이터 경로와 별도 포트에서 필요한 FMS·로봇·웹 프로세스를 실행하고 종료한다.
운영 DB를 사용하지 않는다. `E2E_PORT_OFFSET`으로 포트 충돌을 피할 수 있으며 서로 다른 검사는
서로 다른 오프셋을 사용해야 한다. 실패 시 출력된 임시 폴더에서 로그를 확인한다.

| 명령 | 확인 범위 |
| --- | --- |
| bun run scripts/check_teleporter_runtime.ts | 실제 왕복, 단일 소유권, 몸체 이탈 시 점유 해제와 이탈 지점 도착 완료 분리, SQLite 기록 |
| bun run scripts/check_teleporter_queue.ts | 두 로봇의 FIFO 등록과 명시적 취소 |
| bun run scripts/check_teleporter_queue_flow.ts | 두 로봇의 순차 이동, 출구 차단 시 입구 밖 대기, 장애 로봇 이동 후 자동 재개 |
| bun run scripts/check_teleporter_recovery.ts | 층간 이동과 일반 주행 후 로봇 및 목적지 FMS 재시작, 위치·세션·제어 동기화 복원 |
| bun run check:teleporter:web | 실제 Chromium에서 양 끝 배치, 폴리곤·헤딩·이탈점 편집, 맵 재접속, 저장·취소·삭제 |

`bun test`는 공통 모델·기하, 저장소 검증, 중복/오래된 요청, 연결 단절의 예약 보존,
운영 제외 유지, 맵 교체 실패와 컨트롤러 재개 및 빈 룸 재접속 회귀를 포함한다.
이는 실기 엘리베이터, 장시간 부하, 모든 장애 시점의 강제 종료 검증을 의미하지 않는다.

2026-09-16 실행 기록: 전체 `bun test` 110개 통과. 위 5개 격리 통합 검사 모두 통과했다.
감사에서 발견한 맵 전환 후 중복 명령, 빈 룸 재접속 상태, 공유 SQLite 쓰기 경합,
오래된 제어권 및 접근 취소 회귀를 수정·검증했다. 이후 변경 시 해당 검사를 다시 실행한다.

## 운영 제외 전체 복구 — PILOT-9 (2026-09-17)

- `bun test`: 115개 통과. 점유 전체 해제, 다른 로봇 보존, 공유 복구 세대 안정성과 오래된 이전 차단 회귀 포함.
- `bun run scripts/check_operator_disable.ts`: 임시 DB·포트에서 텔레포터 이탈 중 제외, 예약 해제, 위치 보고 유지, 로봇/목적 FMS 재시작, 명시적 재개와 새 이동 통과.
- `web-client/check_runtime.ts`: 별도 FMS·웹·로봇 환경과 Chromium으로 선택 해제, 전체 제외 확인/취소, 두 구역 점유 해제, 보고 유지, 운영 재개 통과. `FMS_PORT_OFFSET`과 `ATLAS_WEB_URL`을 함께 지정한다.

## 2026-09-21 맵 전환·운영 제어 회귀

- `bun test`: 136개 통과. `large_lab:robot-N` 레거시 ID 정규화, 맵 간 런타임 점유 정리와
  운영 제외 세대 전파를 포함한다.
- PM2 실환경: `fms-web`, 두 맵 FMS, `fms-robot-1/2`를 PM2로 기동하고, 두 로봇이
  Large Lab에 raw ID로 연결되는 것을 확인했다. Yard projection에는 중복 로봇이 없었다.
- `web-client/check_runtime.ts`를 Large Lab에서 실행해 운영 제외 중 테스트 위치 지정,
  disabled 유지, 명시적 운영 재개 동기화까지 통과했다.

실물 센싱 오류나 외부 안전 장치까지 검증한 결과는 아니다. 이력·감사·이벤트 메뉴는 PILOT-18 후속 논의다.

## 2026-09-21 PLAN-13 · 주행 실패 통합 검증

Luna high가 분리 구현하고 Codex가 변경 리뷰·프로토콜 통합·독립 회귀 검증을 수행했다.

| 명령 | 검증 범위 |
| --- | --- |
| `bun test` | 저장·조회/제한·과거 자산, 운용 ID·중복 요청, 채널·시계·seek, 계획 결과 폐기와 위치 ACK |
| `bun run check:blackbox:traffic` | 자체 임시 FMS·웹·로봇 2대, 새 좌표 지정/운영 재개 후 동시 이동 4회 완료·세션 유지·실제 기록 조회 |
| `bun run check:blackbox:web` | 자체 격리 서비스·Chromium, 동일 로봇 라이브 변경 중 replay 지도/카드 유지, 라이브 복귀·명령 차단·지연 자산·늦은 확인 |
| `bun run scripts/check_operator_disable.ts` | 텔레포터 이탈 중 제외·전체 점유 해제, FMS/로봇 재시작 뒤 disabled 유지와 명시적 재개 |

최종 Bun 계획 프로세스 구현 후 두 로봇 재검증: `/tmp/fms-blackbox-traffic-3uPq7y`, 후보 48건,
재생 사건 675건, 첫 운용 trace 607건. 최종 브라우저 독립 재검증: `/tmp/fms-blackbox-web-t1gJ1T`.
임시 로그는 진단용이며 영구 보존 자료가 아니다. 각 검사는 직접 생성한 프로세스만 종료한다.
웹 빌드는 임시 `FMS_WEB_PUBLIC_DIR`을 사용한다.

초기 Web Worker 분리 검사: Large Lab (3642,2305)→(2848,2499), 추가 존·동적 장애물 없는 입력에서
274점 경로, 약 744ms 동안 10ms 타이머 73회/최대 간격 11ms를 관측했다.
기존 운용 DB의 prefer/avoid를 포함한 입력과 같지 않으므로 과거 2452ms 계산과의 속도 비교값이 아니다.
추가 텔레포터 검사에서 Bun 1.3.13 Worker 시작/종료 경합으로 부모 segmentation fault가 발생했다
(`/tmp/fms-teleporter-check-1789956924060`). 최종 구현은 별도 Bun 계획 프로세스/IPC로 분리했고
빠른 취소·재시작 및 timeout 후 회복 검사를 추가했다. 앞의 수치는 최종 방식 성능 보증값이 아니다.
동일한 단순 입력을 최종 Bun 프로세스/IPC 방식으로 다시 검사한 결과는 274점 경로,
약 758ms, 타이머 74회/최대 간격 11ms였다. 단일 측정이며 장기 부하 보증이 아니다.

이번 코드에는 프로토콜 v3가 필요하다. 운영 PM2 프로세스는 재시작하지 않았고
주행 중 작업 중단 여부를 사용자에게 확인한 뒤 서버·로봇을 함께 적용해야 한다.
초기 검증은 공유 `web-client/public/app.js`를 갱신했다. 이후 임시 출력 경로로 분리했다.
기존 운영 웹 프로세스의 블랙박스 API는 아직 404이므로 버튼이 보여도 운영 배포 완료를 뜻하지 않는다.
웹까지 포함해 함께 적용한 뒤 새 기록으로 확인해야 한다.
24시간 장기 부하와 모든 운용 경로의 성공률 보장은 이번 검증에 포함되지 않는다.

최종 계획 프로세스 변경 후 `bun test` 184개 통과. `check_teleporter_runtime.ts`도 재실행해
왕복 이동·자동 이탈·영속 완료·점유 해제·맵 단일 소유권을 확인했다.


## 2026-09-22 운영 적용

사용자 재기동 요청에 따라 PM2의 가상 로봇 2대를 정지한 뒤 웹·Yard FMS·Large Lab FMS를
재기동하고 로봇 2대를 다시 기동했다. 5개 프로세스 모두 online이며 두 로봇이 저널의
Large Lab 위치를 복원하고 해당 FMS에 등록된 것을 확인했다. 웹 시작 시 최신 번들을 빌드했다.
웹 `/`와 두 맵의 `/api/blackbox/events`가 HTTP 200을 반환하고 재기동 이후 기록을 조회했다.
이는 위 9월 21일 운영 적용 보류 상태를 해소한 기록이다. 실제 웹 운용·리플레이 사용자 검수는
사용자가 직접 진행하며, 카드의 Review 상태와 최종 확인 전 Done 금지 원칙은 유지한다.


## 2026-09-22 PLAN-18 · 교통 STOP 복구 검증

`bun test virtual-robot/src server/src/traffic scripts/protocol.integration.test.ts scripts/trafficStop.integration.test.ts scripts/trafficStopSafety.integration.test.ts`
최종 84개 통과(12개 파일), 별도 runtime/session/teleporter 회귀 17개 통과(3개 파일).
Bun 서버·가상 로봇 시작 파일 번들링과 `git diff --check`를 통과했다.

[protobuf 왕복](../../../scripts/trafficStop.integration.test.ts)은 실제 직렬화와 양쪽 처리기,
1초 폴링, 해제 응답 누락, 새 충돌·지연된 이전 응답, 서버 상태 투영을 확인한다.
[독립 안전 검사](../../../scripts/trafficStopSafety.integration.test.ts)는 제3 로봇의 온라인/오프라인
몸체, 실제 몸체와 상대 경로, 오래된 관측 및 semantic 대기열의 해제 차단을 확인한다.
[다중 사유 검사](../../../server/src/traffic/policies/LocalPlanRecovery.test.ts)는 최신 토큰의 사유만
해소돼도 이전 사유가 남으면 정지하고, 모든 사유 해소 뒤 같은 최신 토큰을 해제함을 확인한다.

저장된 robot-2 정체 장면에 새 중재 정책을 격리 적용해 RESUME를 확인했다. 가상의 이전
교착과 실제 현재 좌표·단기 경로를 연결한 검증이며 과거 전체 재생이나 운영 주행 성공
검증과 구분한다. [계약·적용 결과](../../fms/current/traffic-stop-recovery.md)와 카드 첨부 참고.


프로토콜 v4 운영 적용: 사용자 기존 재기동 승인에 따라 두 맵 FMS와 가상 로봇 2대를
순차 재기동했다. 두 로봇의 위치 변화 0, 연결·제어 준비·enabled와 idle/stationary/traffic clear를
확인했다. 현재 명령은 빈 ID/idle이며 과거 명령을 재개하지 않는다. 웹은 기존 프로세스를
유지했다. 실제 이동 검수는 사용자 새 명령으로 진행한다.


## 2026-09-22 블랙박스 v2

Astra high가 설계·감독·독립 회귀를, Luna high가 서버·웹 구현을 담당했다.
전체 `bun test` 280개/49개 파일을 통과했다. 웹·웹 서버 빌드와 diff 검사도 통과했다.
`E2E_RESET=1 bun run scripts/check_blackbox_v2.ts`는 별도 데이터·포트·웹 출력 경로에서
실제 두 로봇을 이동·정지·재개하고 Large Lab 원본 기록을 Chromium으로 재생한다.
운영 기록은 삭제하지 않는다.

최종 결과 `/tmp/fms-blackbox-v2-nWAuEt/result.json`: 원본 PNG 실제 canvas 표시, 기록 frame과
좌표·상태 일치, 재생·일시정지·seek·배속, 라이브 제어 차단, 전체 삭제 취소·확인과 명령 보존,
기존 탭/cursor 무효화, 새 기록 재생, 실제 PNG 누락 오류와 복구를 통과했다.
page error 0건. 기록이 비동기이므로 최신 checkpoint가 실제 완료 시각에 도달했는지 기다린다.
측정 기록 반영 지연은 [기록 정책](../../fms/current/blackbox.md)에 남겼다.

기존 pause/events 실제 통합 검사도 `/tmp/fms-pause-console-vofhqR/result.json`에서
10개 검사·page error 0건으로 통과했다. 새 재생 기능이 운영 일시정지·재시작 복원·콘솔을
훼손하지 않았음을 확인한다. 임시 경로는 진단용이며 영구 근거는 관련 Vikunja 첨부를 사용한다.


## 2026-09-23 공통 코드·이벤트 표시

Astra high가 설계·감사를, Luna high가 공통 코드·이벤트·화면 구현을 수행했다.
최종 `bun test`: 300개 통과/51개 파일. 웹·FMS·로봇 시작 파일 번들 검증 통과.
`bun run scripts/check_operator_pause_console.ts`는 격리 데이터·포트·웹 출력에서
실제 서버·로봇 2대·Chromium으로 11개 항목을 통과했다. 목표 이름의 HTML 특수문자 표시,
명령 뒤 리소스 이름 변경에도 당시 이름 보존, 전체 commandId, JSON·복사·trace 및 기존
일시정지·재시작·과거 조회 회귀를 확인했다. 페이지 오류 0건.
근거: `/tmp/fms-pause-console-Oja9Ti/result.json`, 같은 폴더의 `event-console.png`.
이번 코드 변경을 운영 서비스에 재기동·배포하지 않았다.

별도 속성 검사가 실수로 기존 개발 서비스에서 수행되었다. 정상 종료 후 fixture 삭제 요청을
보냈으며 두 맵의 editor.sqlite를 읽기 전용으로 확인해 테스트 이름/ID의 잔여 리소스가
없는지 점검했다. 검증으로 생성된 운용 이력 자체는 삭제하지 않는다.


### 2026-09-23 자연어 콘솔 후속 보완

관련 검사 23개 통과와 격리 Chromium 12개 항목 통과·페이지 오류 0건을 확인했다.
이벤트 선택·관련 기록 조회로 JSON이 자동 노출되지 않고 별도 원문 뷰에서만 보이는지 검증했다.
웹 번들을 현재 제공 경로에 반영한 뒤 기존 Large Lab 서비스에서 조회만 수행해 확인했다.
근거: `/tmp/fms-pause-console-nT7QDI/result.json`, `/tmp/fms-natural-console-live.json`.
웹·FMS·로봇을 재기동하거나 기존 서비스 로봇에 운용 명령을 보내지 않았다.


## 2026-09-23 step-back 반복·배경맵

- 전체 `bun test`: 312개/52개 파일 통과. 최종 거리 변환·라벨·타입 보완 후 관련 검사 65개 및
  거리 변환/별도 step-back 생명주기 검사 16개 통과. 웹·FMS·로봇 번들 통과, diff 검사 통과.
- 후퇴: 원본 해상도 올림, 연속 구간,5초 대기, 장애물 대기, 실제 소진 경로,명령 취소/교체,
  수동 정지와 식별 STOP, 오래된 peer 데이터와 이동 흔적 소진을 검사했다.
- 격리 `scripts/check_blackbox_v2.ts`: 실제 Large Lab 두 로봇 기록·정지·재개, 지도 픽셀,
  시점 이동·배속·리사이즈·보관 PNG 누락·복구 통과. `/tmp/fms-blackbox-v2-sYOX3v/result.json`.
- 사용자 승인 후 가상 로봇2대 재기동. 현재 위치·방향 보존,연결·제어 준비·정지 확인.
  `/tmp/fms-stepback-after-restart.json`. 운영 로봇에 새 이동 명령을 보내지는 않았다.
- 웹 번들 갱신 후 실제 LAN 페이지에서 블랙박스 배경맵 표시를 읽기 전용 확인.
  `/tmp/fms-stepback-replay-live.json`. 사용자가 보고한 정확한 상황은 아직 미재현이다.
