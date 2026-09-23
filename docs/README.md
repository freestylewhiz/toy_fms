# 개발 문서

기준일: 2026-09-23. 현재 저장소 코드와 사용자 확정 정책을 기준으로 정리한다.

| 컴포넌트 | 현재 구현·정책 | 논의할 주제 | 확정 작업 |
| --- | --- | --- | --- |
| concept: 통합 개념·공통 계약 | [구조](concept/current/architecture.md), [대형 테스트맵](concept/current/large-test-map.md), [문서 운영](concept/current/documentation-policy.md), [검증](concept/current/verification.md), [텔레포터 현재 정책](concept/current/teleporter.md), [운영 일시정지](concept/current/operator-motion-pause.md) | [통합 확장](concept/backlog/product-scope.md), [텔레포터 논의](concept/backlog/teleporter.md), [리소스 모델 논의](concept/backlog/resource-model.md), [DISC-001 물리 대기열](concept/backlog/DISC-001-teleporter-queue-management.md), [DISC-002 블랙박스](concept/backlog/DISC-002-blackbox-operation-replay.md) | concept/todo/ — 비어 있음 |
| fms: 서버·운영·트래픽 | [서버](fms/current/server.md), [운영 복구](fms/current/runtime-recovery.md), [트래픽](fms/current/traffic.md), [교통 STOP 복구](fms/current/traffic-stop-recovery.md), [블랙박스 기록](fms/current/blackbox.md) | [그래프·멀티맵](fms/backlog/maps-and-graph.md), [운영 이력](fms/backlog/operations.md), [트래픽 확장](fms/backlog/traffic-evolution.md) | fms/todo/ — 비어 있음 |
| web: 편집·모니터링 | [편집](web/current/editor.md), [운용](web/current/operations.md), [블랙박스 채널·재생](web/current/blackbox.md), [로봇 이벤트 콘솔](web/current/robot-event-console.md) | [편집 확장](web/backlog/editor-evolution.md), [블랙박스 기획 이력·후속](web/backlog/blackbox-replay-mode.md), [이벤트 콘솔 프리셋·관찰 UI 기획](web/backlog/robot-event-console-observation.md) | web/todo/ — 비어 있음 |
| robot: 가상 로봇·연동 | [주행](robot/current/navigation.md), [축소 격자 계획](robot/current/coarse-map-planning.md), [동적 장애물 복구](robot/current/dynamic-obstacle-recovery.md), [프로토콜](robot/current/protocol.md) | [실기·주행 모드](robot/backlog/integration.md) | robot/todo/ — 비어 있음 |

트래픽 존의 합의된 설계 기준과 구현 검증 기준은
[traffic-control](traffic-control/README.md)에 별도로 둔다. 현재 코드의 실제 동작은
`fms/current`, `robot/current` 문서를 우선한다.

current에는 구현된 동작과 유지할 정책만 기록한다. backlog는 미확정 제안이며 구현 지시가 아니다.
todo에는 사용자와 범위·완료 기준을 합의한 작업만 둔다. 완료되면 current로 반영하고 todo를 정리한다.
에이전트별 문서, 핸드오프, 과거 단계별 구현 지시는 관리하지 않는다.
실행 방법은 [저장소 README](../README.md)를 참고한다.
다른 PC의 공유 스킬·Vikunja 연결은 [에이전트 작업 환경](concept/current/agent-workflow.md)을 따른다.

텔레포터 상세: [공통 리소스 모델](concept/current/resource-model.md),
[FMS 점유·순서](fms/current/teleporter.md), [웹 편집](web/current/teleporter.md),
[로봇 전환·복구](robot/current/teleporter.md).

## 2026-09-22 검토 요청과 후속 승인

- [운영 일시정지·재개](concept/backlog/operator-motion-pause.md)
- [로봇 이벤트 콘솔](web/backlog/robot-event-console.md)
- [prefer 교차 주행 지연 진단](robot/backlog/prefer-crossing-diagnosis.md)
- [추가 동적 장애물 뒤 정체 진단](robot/backlog/dynamic-obstacle-stall-diagnosis.md)
- [우회 응답 누락·STOP 복구 구현](fms/current/traffic-stop-recovery.md)
- [패스 플래닝 최적화 알고리즘·튜닝 1차 조사](concept/backlog/path-planning-optimization-survey.md)
- [블랙박스 실제 기록 검수](web/backlog/blackbox-replay-mode.md)
- [블랙박스 전체 기록 삭제](fms/current/blackbox.md)

위 검토 요청 중 패스 플래닝의 축소 격자 방안만 후속으로 구현 승인되었다. [ROBOT-9 구현·검증](robot/current/coarse-map-planning.md)을 완료하고 Review에서 사용자 검토를 기다리며, 다른 알고리즘과 나머지 신규 기능의 구현은 미승인 상태다.

## 2026-09-22 동적 장애물 정체 수정 승인

사용자 운용검수에서 확인된 [동적 장애물 정체](robot/backlog/dynamic-obstacle-stall-diagnosis.md)는 수정·재기동을 승인받았다. [세 원인 수정·검증·재기동](robot/current/dynamic-obstacle-recovery.md)을 완료하고 ROBOT-9를 Review로 되돌렸다. 기존 축소 격자와 다른 알고리즘 보류 결정은 유지한다.


## 2026-09-22 교통 STOP 재평가 구현 승인

사용자가 STOP 폴링과 FMS 재판단·해제 구현을 승인했다. PLAN-18, SRV-11, ROBOT-10으로
분리하고 [교통 STOP 복구](fms/current/traffic-stop-recovery.md)에 현행 계약과 검증을 기록했다.
수동 일시정지 신규 기능과 다른 경로 탐색 알고리즘은 기존 후속 범위로 유지한다.

## 2026-09-22 일시정지·이벤트 콘솔 구현 승인

이후 사용자가 PLAN-14·PLAN-15 구현을 승인했다. 이전의 해당 기능 구현 미승인 표기는
과거 검토 이력이다. [운영 일시정지](concept/current/operator-motion-pause.md)와
[로봇 이벤트 콘솔](web/current/robot-event-console.md)에 WEB-6·7, SRV-9·10, ROBOT-7·8의 구현·검증을 기록했다. 함께 지정한 PLAN-18, ROBOT-9,
PLAN-11, PLAN-12는 기존 구현을 보존하고 회귀 검증한다.

최종 검증: `bun test` 259개 통과(45개 파일). 실제 두 로봇·브라우저 통합 검증에서
단일/복수 일시정지, 부분 실패, 재접속·재시작, 콘솔 필터·과거 조회·복사·trace·리플레이 차단을 확인했다.
구현 카드는 Review에서 사용자 검수를 기다리며 Done으로 확정하지 않았다.

## 2026-09-22 블랙박스 v2 재구성 승인

실제 기록에서 지도 미표시·재생 불가가 확인되어 PLAN-13·WEB-5·SRV-8을 v2로 재구성했다.
[블랙박스 기록·전체 삭제](fms/current/blackbox.md)와 [웹 재생](web/current/blackbox.md)에
최근 구간 자동 열기, 원본 지도·시간 재생, 전체 삭제의 세대 격리 및 실제 데이터 검증을 기록했다.
전체 280개 테스트와 실제 두 로봇·Large Lab 원본 PNG·Chromium 검증을 통과했다.
이벤트 콘솔 목적별 프리셋·관찰 UI 개선은 [별도 기획](web/backlog/robot-event-console-observation.md)
([PLAN-19](http://192.168.0.172:3456/tasks/48))으로만 등록했으며 구현 범위에 포함하지 않는다.

블랙박스 v2는 운영 PM2 5개 반영과 실제 운영 읽기 전용 브라우저 검증까지 완료했다.
PLAN-13·WEB-5·SRV-8은 Review에서 사용자 검수를 기다린다. PLAN-19는 기획 기록만 유지한다.


## 2026-09-23 공통 코드·이벤트 표시 리팩터링

사용자 승인으로 유한한 도메인 코드와 한국어 표시명을 `shared/config`의 카테고리별 파일로
통합했다. [공통 코드와 표시 문구](concept/current/code-catalogs.md)에 구성·확장 방법을,
[로봇 이벤트 콘솔](web/current/robot-event-console.md)에 payload 기반 문구와 대상 이름 보존을 기록했다.
전체 자동 검사 300개와 격리된 실제 서버·로봇 2대·Chromium 통합 검사를 통과했다.
이번 변경은 운영 서비스에 재기동·배포하지 않았다. 지도 렌더링·기간 조회 재설계는 별도 범위다.


같은 날 사용자 재검수에 따라 [콘솔 기본 자연어 보기와 JSON 뷰 분리](web/current/robot-event-console.md)를
보완하고 웹 번들을 현재 서비스에 반영했다. 기존 서비스의 읽기 전용 브라우저 검증을 통과했다.
서버·로봇 리팩터링의 운영 배포는 아직 별도이며, 이번 반영은 프로세스 재기동 없는 웹 갱신이다.


## 2026-09-23 짧은 후퇴·블랙박스 배경맵

사용자 승인으로 [step-back을 약0.5m 단위·5초 대기](robot/current/navigation.md)로 변경하고
[대형 기록 지도 표시](web/current/blackbox.md)의 비트맵 크기와 자산 요청 경합을 보완했다.
전체312개 검사와 격리 브라우저 검증 통과. 웹 반영과 사용자 승인 로봇2대 재기동을 완료했다.
