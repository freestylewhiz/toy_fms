# 공통 코드와 표시 문구

2026-09-23 사용자 요청으로 유한한 도메인 코드와 한국어 표시명을 `shared/config`로 통합했다.
동일 코드의 타입·검증 목록·화면 라벨을 별도로 정의하면서 생기는 불일치를 줄이고,
로봇 이벤트를 원문 JSON을 열기 전에도 이해할 수 있게 하기 위한 변경이다.

## 정의 위치

정본 진입점은 [shared/config/index.ts](../../../shared/config/index.ts)다.

| 파일 | 관리하는 코드 |
| --- | --- |
| `global.ts` | 연결 상태, 고정 맵 식별자 |
| `robot.ts` | 작업·주행·명령 상태, 명령 종류, 제어기 단계, 경로 계획·결과 |
| `fms.ts` | 운영 제어, 허가·점유, 트래픽 정책·신호·회피, 텔레포터 상태 |
| `resource.ts` | 리소스 종류·분류, 장애물 모양, 존·스테이션 종류, 방향·해제 정책 |
| `web.ts` | 화면·편집·재생 모드, 도구·편집 핸들, 기간 경계 |
| `events.ts` | 기록 이벤트 종류·분류·출처 |
| `messages.ts` | 로봇 프로토콜, 운용 요청·응답, 통신 방향 |
| `reasons.ts` | 동작 사유, 조회 오류와 불완전 결과 사유 |
| `blackbox.ts` | 블랙박스 삭제 확인 코드·범위, 탐색 제한 종류 |
| `eventMessages.ts` | payload를 한국어 이벤트 설명으로 조합하는 규칙 |

`defineCodes`는 코드와 표시명으로부터 `code`, `labels`, `values`, `options`, `is`를 만든다.
타입은 `CodeOf<typeof Catalog>` 또는 `typeof Catalog.values[number]`로 파생한다.
기존 통신·저장 코드 문자열은 유지한다. protobuf 필드·enum 숫자는 `.proto`의 통신 스키마이며
TypeScript 카탈로그와의 대응을 검사한다. 임의의 로봇·리소스 ID, UUID, 사용자 입력 이름,
자유 형식 오류 메시지는 유한한 enum으로 제한하지 않는다.

```ts
DriveCommandKinds.code.move       // "move"
DriveCommandKinds.labels.move     // "이동"
DriveCommandKinds.options         // { value, label }[]
DriveCommandKinds.is(input)       // 경계 검증과 타입 좁히기
```

## 이벤트 표시와 이름 보존

[공개 formatter](../../../shared/eventDisplay.ts)는 브라우저와 테스트에서 함께 사용한다.
목록의 주 설명은 시각과 자연어이며 명령 종류·좌표·전체 명령 ID, 경로 계산 결과, 실제로
변경된 상태, 일시정지/재개 여부 등 해당 사건의 주요 값을 조합한다. 상세 JSON은 보존한다.
화면에는 `textContent`로 넣어 리소스 이름의 HTML 특수문자가 마크업으로 해석되지 않게 한다.

서버는 리소스의 이름을 명령 시점에 조회해 `target: {id, kind, name?, mapId}`를 기록한다.
주행 명령에는 선택적 `event_context_json`을 붙여 이 정보를 로봇의 수신·실행·결과·계획 기록까지
연결한다. 주행 좌표와 권한 판단은 기존 필드를 사용하며 진단 메타데이터로 변경하지 않는다.
리소스를 나중에 수정·삭제해도 기록된 이름을 유지한다. 이름이 없는 과거 기록은 확인 가능한
원래 ID를 표시하며 현재 다른 리소스의 이름을 임의로 붙이지 않는다.

알 수 없는 이벤트·사유는 원래 코드를 보여준다. 표시명이 없다는 이유로 기록을 버리지 않는다.
프로토콜 송수신과 운용 요청/응답의 이벤트 이름은 구성 요소의 카탈로그로 해석한다.

## 검증 근거

- [통신 카탈로그 검사](../../../shared/config/protocolCatalog.test.ts): RobotBridge의 모든 메시지 종류에 표시명이 존재하는지 검사.
- [운용 기록 검사](../../../server/src/blackboxIntegration.test.ts): 대상 이름 스냅샷, 비동기 응답, 명령 이후의 상태 기록 연결.
- [프로토콜 통합 검사](../../../scripts/protocol.integration.test.ts): 선택적 진단 필드의 직렬화와 기존 메시지 호환, 서버 리소스 이름 전달.
- [이벤트 콘솔 통합 검사](../../../scripts/check_operator_pause_console.ts): 격리된 두 로봇과 브라우저에서 명령 수행 후 리소스를 변경하고 과거 이름·자연어 목록·JSON 상세를 확인.

블랙박스 지도 렌더링·기간 조회의 재설계는 별도 범위다.

2026-09-23 최종 검증: `bun test` 300개/51개 파일 통과, 웹·FMS·로봇 시작 파일 번들 통과.
격리 Chromium 검증 11개 항목과 페이지 오류 0건을 확인했다.
근거: `/tmp/fms-pause-console-Oja9Ti/result.json`, 같은 폴더의 `event-console.png`.
임시 자료는 장기 보존 대상이 아니다. 이번 변경은 운영 서비스를 재기동하지 않았다.
