# v1 설계 — 로컬 패스 플랜 동기화

## 1. 역할

**로봇**
- 자기 occupancy + 동기화된 상대 몸/로컬플랜으로 A* 한다.
- 매 tick, 남은 경로에서 `LOOKAHEAD_S`(기본 5초)만큼을 `LocalPlanUpdate` 로 보낸다.
- 상대 로컬 플랜은 예측 장애물이다. 평시 FMS 허가 없이 달린다.
- 우회가 안 나오면 **breadcrumb 궤적을 거꾸로** 따라가 상대 로컬 플랜과 떨어질 때까지 공간을 비운다.

**FMS**
- 같은 맵 로봇의 pose + local plan 을 브로드캐스트 (`FleetLocalPlans`). 경로를 만들지 않는다.
- 로컬 플랜 쌍이 `TRAFFIC_SEP_PX` 안으로 겹치고, 양쪽이 `DEADLOCK_CONFIRM_MS` 동안 진행이 없으면 교착.
- 교착이면 sticky 패자에게 `EvasionRequest(REROUTE)` — 우회 **기회**.
- `NONE` 이면 `VACATE`: 지나온 길로 후퇴해 상대 플랜이 비울 때까지 확보.

## 2. 정보 흐름

```
robot-i  LocalPlanUpdate (~5s) ──▶ FMS ──▶ FleetLocalPlans (i 제외) ──▶ robot-j
robot-j  LocalPlanUpdate        ──▶ FMS ──▶ FleetLocalPlans          ──▶ robot-i
                                         │
                                         └── overlap + stuck ──▶ EvasionRequest
```

FMS는 맵 장애물로 안전을 판정하지 않는다. 겹침은 **보고된 로컬 플랜 기하**만 본다.

## 3. 교착 처리

1. **자율**: 로봇이 상대 플랜을 occupancy에 넣고 우회 재계획.
2. **FMS REROUTE**: 그래도 양쪽 정지 → 패자에게 우회 기회. 승자는 대기했다가 `zone_update(resume)`.
3. **후퇴 VACATE**: 우회 경로 없음(긴 복도). 패자가 trail 을 거꾸로 따라가 상대 플랜과 `TRAFFIC_SEP_PX` 이상 떨어지면 정지. 승자 통과 후 패자 원 목적지 재개.

후퇴 목표는 FMS가 좌표를 발명하지 않는다. 로봇의 **자기 breadcrumb** 부분집합이다.
