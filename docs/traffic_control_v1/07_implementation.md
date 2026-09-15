# v1 구현

## 정책 스위치

```ts
// shared/constants.ts
export const TRAFFIC_POLICY_ID = (process.env.TRAFFIC_POLICY_ID ?? "local_plan_v1") as TrafficPolicyId;
```

| 값 | FMS | 로봇 |
|----|-----|------|
| `local_plan_v1` | `LocalPlanPolicy` | `LocalPlanExecutor` |
| `corridor_lease_v0` | `CorridorLeasePolicy` | `CorridorLeaseExecutor` |

팩토리: `server/src/traffic/createPolicy.ts`, `virtual-robot/src/traffic/createExecutor.ts`.

## 모듈

```
shared/traffic/localPlan.ts     5초 샘플, 폴라인 겹침, trail 후퇴
server/.../policies/LocalPlanPolicy.ts
virtual-robot/.../LocalPlanExecutor.ts
proto  LocalPlanUpdate / FleetLocalPlans
```

## 테스트

```
bun test shared/traffic/localPlan.test.ts
bun test server/src/traffic/policies/LocalPlanPolicy.test.ts
bun run scripts/v1_overlap_sim.ts
```
