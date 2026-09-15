# 구현 모듈 분리

정책(`corridor_lease_v0` / `local_plan_v1`)을 나중에 갈아끼울 수 있도록 **불변 계층**과 **정책 계층**을 나눴다.

```
shared/                          ← 불변 (FMS·로봇·웹 공용)
  corridor.ts                    캡슐 기하, disjoint, footprint⊆회랑 (I1/I2 기하)
  traffic/types.ts               TrafficStatus, Signal, plan action, TrafficPolicyId
  traffic/localPlan.ts           v1: 5초 샘플 · 겹침 · trail 후퇴
  constants.ts                   TRAFFIC_POLICY_ID + 교통 상수

server/src/traffic/
  LeaseLedger.ts                 불변 원장 (지도 import 금지)
  TrafficPolicy.ts               정책 인터페이스 (swappable)
  createPolicy.ts                TRAFFIC_POLICY_ID → CorridorLeasePolicy | LocalPlanPolicy
  policies/CorridorLeasePolicy.ts  v0 정책: 승인/부분승인/시드 우선순위
  policies/LocalPlanPolicy.ts      v1 정책: 로컬플랜 겹침 교착 → REROUTE → VACATE
  index.ts (TrafficController)   실행기: gRPC↔정책 액션 적용, 10Hz tick

virtual-robot/src/traffic/
  TrafficExecutor.ts             로봇 측 실행 인터페이스 (I2)
  createExecutor.ts              TRAFFIC_POLICY_ID → CorridorLeaseExecutor | LocalPlanExecutor
  CorridorLeaseExecutor.ts       v0 실행기: 회랑 생성·요청·반납·구속
  LocalPlanExecutor.ts           v1 실행기: 회랑 없이 자율 주행, 교착 시에만 evade

web-client/
  Robot.trafficStatus 라벨       Colyseus 필드 모니터링
```

## 교체 방법

1. `TrafficPolicy` 구현체를 `policies/` 에 추가하고 `createPolicy.ts` 에 분기
2. 로봇 `TrafficExecutor` 구현체를 `createExecutor.ts` 에 분기
3. `TRAFFIC_POLICY_ID` (또는 env) 만 바꿔서 실행
4. `TrafficStatus` 어휘는 유지 (UI가 깨지지 않음)

## 상태 필드

| 필드 | 권한 | 의미 |
|------|------|------|
| `Robot.status` | 로봇 pose | idle / move |
| `Robot.trafficStatus` | **FMS** | clear / proceed / partial / hold / stop / evade / lease_lost |
