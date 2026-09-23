# 트래픽과 시맨틱 존

기본 TRAFFIC_POLICY_ID는 local_plan_v1이다. corridor_lease_v0도 선택할 수 있다.
정책을 바꿀 때 서버와 가상 로봇에 같은 값을 적용한다.

## 구현된 정책

local_plan_v1은 약 5초 단기 경로를 공유한다. 겹치는 경로와 진행 정체를 확인하면
FMS가 우회(REROUTE)를 요청하고 필요 시 자신의 이동 흔적을 따라 후퇴(VACATE)하도록 요청한다.
상대 로봇은 공간이 확보될 때까지 대기한다. 실제 경로 계획과 후퇴 실행은 로봇 책임이다.

corridor_lease_v0는 동적 회랑 lease, 진입 허가·반납과 교착 처리를 사용하는 별도 구현이다.
사용자가 편집하는 semantic corridor 존과 동적 lease 회랑은 같은 데이터가 아니다.

## 존별 현재 효과

| 존 | 실행 의미 |
| --- | --- |
| forbidden / blocked | 몸체 여유를 반영한 진입 금지 |
| prefer / priority | 몸체가 경계에서 충분히 떨어진 내부일수록 경로 비용 감소, 강제 추종 아님 |
| avoid / penalty | 바깥 완충 띠부터 비용을 적용하고 내부 깊이·통과 길이에 따라 비용 증가, 통과 가능 |
| speed_limit | maximumSpeed(m/s)를 px/s로 바꾸어 주행 상한 적용 |
| corridor / complex / release | capacity 기반 예약·점유·대기열 |

비용 계수는 겹칠 때 곱하며 상하한을 적용한다. 소프트 존 거리 판단에는 로봇 외접 반경과
2px 경계 여유를 사용한다. 금지 영역은 비용보다 우선한다.
용량 존은 접근 경로로 예약하고 몸체·진입 예정 경로가 벗어나면 해제한다.
존 안에 정차한 로봇은 점유를 유지한다. 복구 정책은 [런타임 정책](runtime-recovery.md)을 따른다.

방향 존, 액션, rail/portal 및 그래프 속성의 편집 가능 여부를 실행 보장으로 해석하지 않는다.
시공간 예약·ORCA·일시 prefer 힌트는 현재 구현이 아니다.

2026-09-21 ROBOT-6: 정상 경로의 반복 HOLD/재계획과 동기 계산에 의한 heartbeat 지연을
수정했다. 정책 알고리즘 자체를 바꾼 것이 아니라 로봇의 실행/재계획 처리 결함 수정이다.
disabled에도 최신 peer 관측을 공급하고 오프라인 peer의 마지막 몸체는 장애물로 유지한다.
상세는 [로봇 주행](../../robot/current/navigation.md), 운용별 재현 근거는
[블랙박스](blackbox.md)에 기록한다.

`prefer`의 내부 중심 유도와 `avoid`의 침범 깊이·경계 완충은 2026-09-18에 구현했다.
경로 단순화 뒤에는 12px 반경의 코너 완화를 시도하며, 몸체·하드 존·비용 검사를 통과하지
못하면 기존 안전 경로와 저속·제자리 회전을 사용한다. 정책·검증 기준은
[트래픽 존 정책](../../traffic-control/README.md)을 참고한다.

근거: [정책 팩토리](../../../server/src/traffic/createPolicy.ts),
[v1 중재](../../../server/src/traffic/policies/LocalPlanPolicy.ts),
[v0 중재](../../../server/src/traffic/policies/CorridorLeasePolicy.ts),
[정원 게이트](../../../server/src/traffic/SemanticCapacityGate.ts),
[주행 존 처리](../../../shared/semanticNavigation.ts).


2026-09-22 PLAN-18 / SRV-11 / ROBOT-10: 교통 STOP에 식별자·세대를 붙이고 로봇이
약 1초마다 재평가를 요청한다. FMS는 최신 몸체·단기 경로·관측 신선도·여러 정지 사유와
semantic 점유를 확인해 유지 또는 해제를 답한다. 우회 응답 누락·늦은 round·해제 응답
누락을 복구하며 시간 초과만으로 이동을 허가하지 않는다.
[STOP 복구 계약·검증](traffic-stop-recovery.md), [프로토콜 v4](../../robot/current/protocol.md) 참고.


2026-09-23: 로봇의 VACATE 실행을 지도 해상도로 올림한 약 0.5m 시도와 5초 대기로 변경했다.
FMS의 교착 판단·STOP 해제 조건은 유지하며 후퇴의 상세 상태·검증은
[로봇 주행](../../robot/current/navigation.md)의 짧은 step-back 반복을 따른다.

2026-09-23: 상대 경로 회피의 우회 후보는 원래 명령 경로의 현재 남은 거리 대비
`min(5m, max(1m, 남은 거리 × 0.3))`만큼의 추가 거리까지만 로봇이 채택한다. REROUTE 후보가 이 한도를
초과하거나 유효한 기준 경로가 없으면 NONE 응답으로 기존 VACATE 단계에 연결한다.
서버 중재·STOP 해제 조건은 변경하지 않았다. 기준 보존, 재시도와 실제 환경 변경의 구분,
거절 이벤트는 [로봇 주행](../../robot/current/navigation.md)의 우회 거리 제한을 따른다.
