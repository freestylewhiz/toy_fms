# 블랙박스 운용 기록

2026-09-22 v2: PLAN-13·SRV-8·WEB-5를 실제 누적 기록 조회·시간 재생·전체 삭제 기준으로 재구성했다.
ROBOT-6의 기존 계측을 재사용하며 공유 Recorder의 세대 호환성을 검증한다.
2026-09-21 v1의 운용 ID·프로토콜 기록 계약은 유지한다.
이 문서는 코드의 동작이며 운영 PM2 적용 여부는 카드의 검증 기록을 확인한다.

## 기록과 상관관계

웹 운용·편집 요청은 검증 전에 서버가 UUID `operationId`를 부여한다. 거절·예외도 기록한다.
같은 클라이언트 세션·요청 종류·`clientRequestId` 또는 `requestId`의 재전송은 최근 2048건
범위에서 중복 실행하지 않고 같은 ID/응답을 사용한다. 프로세스 재시작을 넘는 영구 dedup은 아니다.
일반 명령 ID는 operation ID이며 텔레포터 접근 명령은 `operationId:entry`로 연결된다.
취소·강제 제어 변경은 별도 operation과 이전 operation 참조를 남긴다.

FMS와 로봇의 프로토콜 송수신, 서버의 거부 사유, 로봇 계획 요청·완료·폐기,
상태 전환과 맵 장면을 기록한다. 반복 heartbeat는 제외한다. 프로토콜 자체의
session ID·control epoch·request ID·command ID는 payload에 보존한다.
FMS 장면은 변경이 있을 때 100ms 주기와 운용 경계에서 기록한다. 완료 직후 다음 명령이
들어와도 완료 상태가 사라지지 않도록 명령 상태 변경 시 즉시 장면을 캡처한다.

정본 계약: [shared/blackbox.ts](../../../shared/blackbox.ts).
필드: schemaVersion, eventId, timeMs, source, bootId, sequence, mapId, category, kind,
robotId/operationId/commandId/requestId(선택), payload.
순서는 timeMs·sequence·eventId로 결정한다. 다른 프로세스의 시계 오차까지 교정하는
분산 인과관계 재현이나 시뮬레이션 재실행은 아니다.

## 파일과 보존

기본 루트는 `$FMS_DATA_ROOT/blackbox`이며 미지정 시 저장소 `data/blackbox`다.

```text
blackbox/
  .generation.json
  .mutation-lock/                # 최종 쓰기·삭제의 프로세스 공통 잠금
  generations/<generationId>/    # 삭제 이후 현재 세대의 streams·assets
  streams/YYYY-MM-DD/<source>/<bootId>/segment-NNNNNN.events.ndjson
  streams/YYYY-MM-DD/<source>/<bootId>/segment-NNNNNN.index.ndjson
  streams/.active/<source>/<bootId>
  assets/<sha256>/<original-filename>
```

source는 `fms-yard`, `fms-large_lab`, `robot-robot-1` 등이다. 프로세스별 파일이므로
서로 같은 파일에 append하지 않는다. index는 event ID·시각·맵·분류·운용 ID와 바이트 위치를 담는다.
하나의 operation별 별도 파일을 중복 생성하지 않고 operation 조회로 여러 source 기록을 연결한다.
환경은 raw FloorState 장면에, 지도 PNG·occupancy·inflated는 내용 해시 기반 복사본에 보존한다.
로컬 자산 캐시는 경로·mtime·크기·revision을 확인한다. 비밀 관련 키는 `[REDACTED]` 처리한다.

큐는 최대 4096건, segment는 64MiB 또는 10,000건에서 회전한다.
기록은 비동기이므로 운용 완료 응답이 즉시 파일 flush를 뜻하지 않는다. 실제 통합 검증 중
최신 checkpoint가 완료 시각을 따라잡기까지 5.856~7.907초가 측정되었다. 재생 검증은 고정 sleep 대신
checkpoint 기록 시각을 확인한다. 이 통합 부하 측정은 최대 지연 보장이 아니다.
source별 닫힌 segment 원본/index 쌍은 7일 또는 2GiB 한도에서 오래된 순으로 정리한다.
정리는 시작 및 segment 회전 시 최소 60초 간격으로 실행하고 쓰는 중인 segment는 보호한다.
현재 구현은 전체 저장소 10GiB 강제 제한이나 자산 garbage collection이 아니다.
용량 제한 때문에 임의 기간 전체 보존을 보장하지 않는다. v2의 시간 선택은 남아 있는 기록과
해당 구간을 복원할 checkpoint·자산의 가용 범위를 따른다.
강제 종료/디스크 장애에 대한 무손실 fsync 보장은 없다. 큐 초과·쓰기 손실은 가능한 시점에 gap을 남긴다.
자산 복사 실패는 불완전 기록으로 표시하며 라이브 자산으로 대체하지 않는다.
`FMS_BLACKBOX=0`으로 기록을 끌 수 있다. 기록되지 않은 과거 운용을 소급 복구할 수는 없다.

## v2 조회 API

웹 Bun 서버의 기본 조회는 최근 짧은 시간 구간이다. 구형 24시간 사건 목록을 모두 읽고 나서
화면을 여는 경로를 제거했다. 기존 `/events`·`/replay` API는 호환용으로 남긴다.

| 경로 | 용도 |
| --- | --- |
| `GET /api/blackbox/generation` | `{generation:{id,createdAt}}`; 다른 탭의 삭제 세대 감지 |
| `GET /api/blackbox/catalog?mapId=&asOf=` | 최신 checkpoint·과거 자산·조회한 기록 범위와 gap/truncated |
| `GET /api/blackbox/window?mapId=&fromMs=&toMs=&asOf=&cursor=&limit=` | 시각 구간 checkpoint와 중간 frame·사건 페이지 |
| `GET /api/blackbox/operations/:id?mapId=&fromMs=&toMs=&cursor=&limit=` | operationId/relatedOperationIds에 연결된 여러 출처의 trace |
| `GET /api/blackbox/assets/:hash/:filename` | 현재 기록 세대의 복사된 과거 자산 |
| `POST /api/blackbox/reset` | 명시 확인 후 모든 맵·출처의 블랙박스 기록 삭제 |

`window`는 기본 최근 약 30초, 기본 250개·최대 1000개 이벤트를 반환한다.
FMS checkpoint를 우선하고 segment 시간 범위 및 바이트 탐색을 이용해 인덱스 읽기를 제한한다.
창의 파일 끝 위치와 세대·조회 시각을 cursor에 고정하여 새 append가 페이지를 밀지 않게 한다.
종료 시각과 같은 밀리초의 모든 사건을 포함한다. 조회 예산을 넘거나 기록이 부족하면
`gap`·`truncated`로 알리고 현재 상태로 보충하지 않는다. 반환 직전에도 세대를 재검사한다.
삭제된 세대 cursor와 조회 중 세대 변경은 409이며 누락 checkpoint·과거 자산은 명시 오류다.
삭제 직후 첫 checkpoint보다 이른 기본 시작 시각은 실제 가용 시작으로 조정한다.

operation trace는 필요한 index와 선택 payload를 제한해 읽고 원본 전체를 매번 스캔하지 않는다.
index가 없는 legacy 파일만 제한된 원본 읽기를 허용한다. 한도·손상·누락은
`gap`·`truncated`·`reason`·`missingEvents`로 표시한다. cursor는 최초 파일 범위와 세대를 고정한다.
긴 재생 구간의 웹 적재 상한은 64 MiB·10,000 frame이며 필요하면 더 짧은 기간을 선택한다.

## 전체 기록 삭제와 기록 세대

요청 body는 `{confirmationToken:"BLACKBOX_RESET",scope:"blackbox"}`다.
웹 관리 화면은 모든 맵·FMS·로봇 출처의 이벤트·index·과거 자산 삭제임을 확인하고 취소할 수 있다.
편집·운영 DB, 로봇 위치 저널, 실행 중 명령·좌표·epoch·경로·수동 정지·점유는 대상이 아니다.

기록 세대별 저장 경로를 사용하며 최종 자산 쓰기와 event/index append, 삭제는 동일한
프로세스 공통 mutation lock으로 직렬화한다. 자산 다운로드·해시 계산은 잠금 밖에서 수행하고,
최종 쓰기 때 작업 시작 세대를 다시 확인한다. 오래된 큐나 진행 중 복사가 새 세대에 섞이지 않는다.
다른 프로세스의 기록기도 세대 변경을 감지하며 진행 중 작업 경계에서 전환하고 마지막 장면을
다시 기록한다. 대기 중 로봇도 삭제 후 새 checkpoint·과거 자산을 확보한다.
살아 있는 소유자의 잠금은 강제 탈취하지 않으며 종료한 소유자와 오래된 불완전 잠금은 회복한다.

응답의 `cleared:true`는 세대 전환을 뜻하고 `cleanupComplete`가 실제 이전 파일 정리 완료를 구분한다.
정리 미완료는 HTTP 207과 `cleanupError`로 전달하고 웹에서도 부분 실패·원인을 표시한다.
리플레이는 세대 변경 시 정지하고 이전 화면·사건·trace를 무효화한다. 새 기록은 계속 수집한다.
실제 운영 기록 삭제는 이번 검증에서 수행하지 않았다.

## 검증과 후속 경계

- `bun test server/src/blackbox server/src/blackboxIntegration.test.ts`: 저장·조회·제한·중복 요청·운용 연결,
  큰 인덱스의 이전 시각·동일 ms 경계, append cursor, 별도 프로세스의 늦은 자산 복사, 반복 삭제와 idle checkpoint.
- `scripts/check_blackbox_v2.ts`: 실제 두 로봇과 원본 Large Lab 기록의 지도·좌표·재생, 삭제 경계와 운영 상태 보존.
- `bun run scripts/check_blackbox_traffic.ts`: 임시 데이터/별도 포트의 두 로봇을 새 위치로 배치,
  명시적 운영 재개, 동시 이동 4회 완료, 세션 유지, 실제 파일 후보/재생/자산/운용 trace 확인.
- `bun run scripts/check_operator_disable.ts`: 텔레포터 이탈 중 전체 해제·재시작·명시적 재개 회귀.

24시간 실제 부하/장기 디스크 운용, 전체 용량 및 자산 GC, 영구 요청 dedup,
build ID·clock-skew 분석, 인증된 사용자 감사, 독립 export 패키지는 후속 검토다.
[기획 이력](../../concept/backlog/DISC-002-blackbox-operation-replay.md)과 현재 구현을 구분한다.

근거: [기록기](../../../server/src/blackbox/recorder.ts), [조회](../../../server/src/blackbox/query.ts),
[운용 연결](../../../server/src/blackboxIntegration.ts), [FloorRoom](../../../server/src/rooms/FloorRoom.ts),
[웹 사용](../../web/current/blackbox.md).

## 2026-09-22 v2 최종 검증

- 전체 `bun test`: 280개 통과, 49개 파일. 웹·웹 서버 번들과 diff 검사를 통과했다.
- 실제 Large Lab·두 로봇·Chromium 검사: 1,753개 기록 frame, 원본 10000×10000 PNG 실제 그리기,
  paused/completed 위치 일치, 재생·정지·배속·seek와 라이브 송신 차단을 통과했다.
- 격리된 전체 삭제: 취소 무변경, 진행 중 명령·좌표·경로·epoch·수동 정지 보존, 다른 탭의 재생 무효화,
  과거 cursor 409, 새 checkpoint·지도 재생, 같은 명령 재개 완료를 통과했다.
- 실제 과거 PNG를 임시로 제거했을 때 오류를 표시하고 파일 복구 후 다시 재생되는 것을 확인했다.
- 누적 운영 기록의 읽기 전용 조회도 검증했다. 측정 catalog 약 0.16~0.37초, 최근 window 약 1.26~1.37초,
  실제 HTTP 다음 페이지와 과거 시각 조회가 통과했다. 이는 특정 환경의 측정값이다.
- 최종 격리 결과: `/tmp/fms-blackbox-v2-nWAuEt/result.json`; 재현 절차는
  `E2E_RESET=1 bun run scripts/check_blackbox_v2.ts`다. 결과·화면은 Vikunja 카드에 첨부한다.

2026-09-22 운영 반영: 웹·두 FMS·두 로봇의 PM2 프로세스 5개를 재기동했다.
두 로봇의 좌표는 전후 완전히 동일하며 enabled·connected·controlReady·idle을 확인했다.
운영 기록을 삭제하지 않았다. 실제 운영 누적 기록을 읽는 Chromium 검사에서
10000×10000 과거 PNG 표시 3.798초, 로봇 2대, 최근 30초·4배속·seek·정지를 확인했고
API는 모두 200, page error는 0건이었다. 근거는 관련 v2 카드에 첨부한다.
