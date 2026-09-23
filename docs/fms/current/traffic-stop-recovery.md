# 교통 STOP 재평가와 우회 응답 복구

2026-09-22 사용자 구현 승인. [PLAN-18](http://192.168.0.172:3456/tasks/45),
[SRV-11](http://192.168.0.172:3456/tasks/46), [ROBOT-10](http://192.168.0.172:3456/tasks/47).
Luna high가 robot/server를 구현하고 Astra high가 계약 조율·감사·통합 검증을 담당했다.
기존 ROBOT-9의 축소 격자·장애물 경로 검증과 구분하는 교통 통신·중재 작업이다.

## 변경 배경

robot-2가 (3311.4806, 2514.9238)에서 FMS STOP을 유지하던 장면을 분석했다.
13:38:34 FMS는 robot-1에 REROUTE를 요청하고 robot-2를 정지시켰다. robot-1의 일반
경로 계산이 이미 진행 중이면 새 우회 호출은 비동기 접수로 반환했지만 완료 응답 처리를
연결하지 않았다. FMS도 우회 deadline과 경로 분리 상황으로 이 대기를 복구하지 않았다.

분석 당시 두 로봇은 약 22.56m 떨어져 있었고 단기 경로는 겹치지 않았다. 저장 장면에서
robot-2 경로를 따로 계산하면 약 97ms에 생성되며 451개 자세에 동적 충돌이 없었다.
이는 당시 영구 정지의 직접 원인이 남은 STOP임을 뒷받침한다. 최초 stale_context의
당시 정확 충돌점까지 복원한 검증은 아니다. robot-1 목적지가 사각 장애물 내부인 별도
주행 불가 사유도 있었지만 robot-2의 무기한 STOP을 정당화하지 않는다.

## 통신과 로봇 정지 유지

프로토콜 v4에서 STOP에 식별자와 증가하는 세대를 붙인다. 로봇은 STOP 중에도 약 1초마다
해당 토큰의 재평가를 요청한다. 응답 누락·시간 경과만으로 정지를 풀지 않으며 현재 토큰과
session/controlEpoch가 일치하는 RESUME만 수용한다. 같은 STOP 유지 응답은 폴링 간격을
초기화하지 않는다. 일반 PROCEED, zone resume, 명령 정리, 회피 설정 변경은 이 정지를
우회하지 못한다. 정상 연결·제어 준비 전에는 요청·주행을 실행하지 않는다.

FMS는 요청을 받을 때 최신 위치·단기 경로와 정지 사유를 다시 판단한다. 해제 응답이
누락된 경우에도 다음 요청에서 현재 장면을 다시 판단한다. 해제 후 충돌이 다시 생기면
새 STOP 세대를 발행해 이전 RESUME가 새 정지를 풀지 못하게 한다. semantic 용량·점유
허가도 해제 판단에 반영한다. 여러 정지 사유 중 하나만 해소된 것으로 이동을 허가하지 않는다.

수동 일시정지 신규 기능은 PLAN-14의 별도 미구현 범위다. 이번 변경은 교통 STOP과
기존 제어 제외·semantic 주행 제한을 다루며 수동 일시정지 기능을 추가하지 않는다.

## 우회 요청 생명주기

FMS는 pair/round와 요청 deadline을 추적한다. 늦은 다른 round 응답은 진행 상태를
변경하지 못한다. 무응답 deadline은 재평가·재요청 계기이며 자동 PROCEED 조건이 아니다.
REROUTE 성공 응답만으로 상대를 풀지 않고 현재 관측을 통해 공간이 확보됐는지 판단한다.

로봇은 기존 일반 계획을 계산 중이더라도 우회 전용 요청과 응답 책임을 만든다.
진행 중 계산을 취소한 후 새 우회 문맥을 설치하고, 성공·실패·취소·반복 stale 결과를
한 번의 종결 결과로 묶는다. 중복 round에는 진행 중 계산을 다시 시작하지 않고 완료 결과를
재전송한다. VACATE 전에도 계산을 취소해 늦은 결과가 후퇴 경로를 덮지 못하게 한다.
연결·제어 세대 변경은 과거 round를 무효화하며 새 세션으로 과거 응답을 보내지 않는다.

## 검증과 운영 적용

회귀 검증은 운영 로봇에 명령을 보내지 않는 메모리 저장소·프로토콜 왕복·저장 장면을 사용한다.
- 최종 관련 회귀: 84개 통과 / 0개 실패 / 525개 assertion, 12개 파일. 로봇 51개 검사와 FMS 정책·다중 사유·protobuf 왕복·제3 로봇·점유 검증을 포함한다.
- 별도 runtime/session/teleporter 회귀: 17개 통과 / 0개 실패, 3개 파일.
- 실제 서버·로봇 시작 파일을 Bun으로 번들링했다(45개 모듈). `git diff --check` 통과.
- 저장 장면 검증: 가상의 이전 교착으로 STOP 토큰을 만든 다음 실제 기록의 robot-1/2 위치·단기 경로로 교체해 동일 토큰의 RESUME를 확인했다. 과거 전체 이벤트의 재생이나 실제 로봇 이동 검증은 아니다.
- 재기동 전 조회에서 두 로봇의 위치 변화 0, 기존 running 명령과 robot-1 evade / robot-2 stop 상태 보존을 확인했다.

원시 근거는 카드 첨부로 보관한다. 임시 작업 파일은 `/tmp/fms-stop-recovery-focused.log`,
`/tmp/fms-stop-recovery-runtime-regression.log`, `/tmp/fms-stop-recorded-check-result.json`이다.
현재 검사에는 실제 TCP/HTTP2 패킷 손실, 실기 안전 제어, 장시간·대규모 부하 검증이 포함되지 않는다.

운영 적용 완료: 사용자 기존 재기동 승인에 따라 가상 로봇 2대를 정지하고 Yard/Large Lab
서버를 재기동한 뒤 로봇 2대를 기동했다. 서버 PID는 3959512 / 3959611, 로봇 PID는
3960201 / 3960203이다. 웹 프로세스는 유지했다.

재기동 뒤 두 로봇 모두 connected / controlReady / enabled이며 IDLE / stationary /
traffic clear다. 위치 변화는 각각 0이다. 현재 commandId는 빈 값, commandState는 idle이며
기존 명령을 자동 재개하지 않았다. 사용자는 새 이동 명령으로 운용 검수를 진행한다.
운영 로봇에 테스트 이동 명령이나 수동 STOP 해제는 보내지 않았다.
재기동 후 실제 상태 근거: `/tmp/fms-stop-recovery-after-restart.json`,
`/tmp/fms-stop-recovery-pm2-after.json`. 세 카드는 Review로 제출하며 Done은 사용자 검토 후 확정한다.

코드 근거: [FMS 정책](../../../server/src/traffic/policies/LocalPlanPolicy.ts),
[교통 제어·점유 게이트](../../../server/src/traffic/index.ts),
[로봇 STOP 실행기](../../../virtual-robot/src/traffic/LocalPlanExecutor.ts),
[로봇 제어기](../../../virtual-robot/src/controller.ts), [프로토콜](../../robot/current/protocol.md).
검증 근거: [실제 protobuf 왕복](../../../scripts/trafficStop.integration.test.ts),
[제3 로봇·점유 독립 검증](../../../scripts/trafficStopSafety.integration.test.ts).
