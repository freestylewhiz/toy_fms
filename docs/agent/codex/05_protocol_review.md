# gRPC·브라우저 상태 연동 검토 — 2026-09-15

사용자 요청: 가상 로봇과 FMS의 gRPC 프로토콜 및 브라우저 상태 연동 구현.
서버·로봇·웹은 기존 서브 에이전트에 분담하고 총괄이 공유 규격과 통합 테스트를
구현·검토했다. 규격과 실행 방법은 [상태 연동 안내](../../robot-state-sync.md)를 참조한다.

## 변경

- protobuf에 버전 등록, session_ready, heartbeat, command_state 및 pose 명령 필드 추가.
- FMS 룸 준비 후 gRPC 시작, 세션 ID 검증과 3초 watchdog, 500ms heartbeat.
- 명령 전송과 로봇 수락/실행/완료를 구분하고 취소는 현재 명령 ID로 전달.
- terminal 결과 유지, 오래된 명령·역행 이벤트 무시, interrupted 명령 재연결 복구.
- 실제 Robot Schema에 명령 결과·수신시각·단기경로·임대 정보를 저장.
- 브라우저가 모든 Colyseus 패치 뒤 갱신하고 연결 단절 시 명령 잠금·재연결.
- 루트 테스트에서도 Colyseus decorator 규격을 적용하도록 tsconfig 추가.

## 통합 리뷰에서 수정한 문제

취소가 새 임의 ID를 보내 무시되던 문제, 전송만으로 성공/취소를 표시하던 문제,
종료된 명령 ID가 로봇에서 사라지던 문제, 재연결 후 interrupted에서 복구되지
않던 문제, 과거 명령 결과가 새 명령을 덮어쓰던 문제, 중첩 Robot 변경을 UI가
놓칠 수 있던 구독 방식, 단 한 번만 재시도하던 브라우저 재연결을 수정했다.

## 검증

- `bun test`: **47개 통과**, 13개 파일.
- `bun run check:protocol`: 실제 protobuf 양방향 직렬화, 양쪽 gRPC 처리기,
  로봇 이동·최종각도·취소, FMS 룸, Colyseus Encoder/Decoder, 브라우저 snapshot,
  동일 명령 재시도, 늦은 상태, 새 브라우저 전체 snapshot, 세션 만료·재연결 확인.
- 가짜 시간/스트림으로 handshake 전 주행 차단과 heartbeat 만료 정지 확인.
- 서버·가상 로봇·웹·라이브 검사 스크립트 Bun 빌드 통과.
- 최초 검토 시 실제 TCP/HTTP2/WebSocket 및 브라우저 화면 E2E는 미실행. 당시 sandbox에서
  loopback listen이 실패하며 권한 확대를 요청할 수 없는 환경이다.

테스트의 in-process 스트림을 실제 네트워크 검증으로 간주하지 않는다. 별도 실행
환경에서는 `check:driving:live`로 로봇 보고 completed/cancelled까지 확인할 수 있다.

## 후속 실제 E2E — 2026-09-15

- loopback 임시 포트 listen·HTTP 응답과 Playwright Chromium 153.0.8010.12 실행 성공.
- 2568/50062/5174를 점유한 이전 서버·웹은 같은 저장소 프로세스였다.
  최신 가상 로봇이 등록 후 heartbeat timeout을 반복해, 서버·웹을 최신 코드로
  재시작했다. 가상 로봇 2대 연결 후 실제 라이브 주행 검사가 통과했다.
- 웹 검사의 `data-detail=fleet` 선택자가 aside와 button을 동시에 선택하는 실패를
  수정했다. 고정 화면 좌표·일시적 ACK 문구 대신 로봇 근처 목적지, 실제 pointer
  좌표, gRPC 결과가 반영된 Colyseus 상태와 UI 결과를 함께 검사한다.
- 실제 UI 수정: 50ms 패치마다 로봇 카드 DOM을 교체하던 동작을 ID별 버튼 유지로
  변경해 클릭 대상과 키보드 포커스를 보존한다. 닫힌 연결에 leave를 보내 발생한
  Chromium 콘솔 오류는 connection.isOpen 검사로 수정했다.
- 웹 E2E 범위: 클릭→주행→완료→UI 표시, 새로고침 후 결과 복원,
  UI 취소→로봇 cancelled→정지, 실제 WebSocket 종료·재접속과 명령 잠금,
  미리보기 편집 차단, 카드 포커스 유지. 화면 `/tmp/bg-fms-driving-e2e.png`.
- 반복 라이브 검사에서 소수점 목적지를 A* 정수 셀로 반올림하고 마지막 점을
  건너뛰어 완료 위치가 어긋나는 문제를 발견했다. 안전한 마지막 구간에 원래
  목적지를 추가하고 마지막 점은 정확히 따라가며 완료 허용 거리를 0.5px로
  맞췄다. 소수점 경로 회귀 테스트와 양방향 프로토콜 이동 검사를 추가·강화했다.
- `bun test` 48개 및 프로토콜 테스트 4개 통과. 주행 리소스 검사는
  로봇 2대 × 목적지 7곳, 총 14개 경로 통과.

로봇 heartbeat의 실제 무응답 장애 주입 및 주행 중 서버 재시작 복구는 이번
브라우저 E2E 범위에 포함하지 않았다. 기존 in-process 테스트와 구분한다.
