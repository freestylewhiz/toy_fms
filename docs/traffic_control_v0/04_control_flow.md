# 04 — 제어 흐름

---

## 1. 두 개의 루프

| 루프 | 주기 | 주체 | 하는 일 |
|------|------|------|---------|
| **로봇 tick** | `TICK_MS = 50 ms` (20 Hz) | `RobotController.tick()` | 이동, 회랑 구속 검사, 반납 판단, 요청 판단 |
| **FMS 임대 루프** | `1000/AUTHORITY_HZ = 100 ms` (10 Hz) | `TrafficController` | 대기 중인 요청 처리, 존 관리, 교착 검사, 리스 갱신 |

로봇 tick 이 FMS 루프보다 빠른 게 중요하다.
**로봇은 FMS 응답을 기다리지 않고도 안전하다** — 이미 쥔 회랑 안에서 움직이므로.

---

## 2. 로봇 tick — 안전의 로봇 측 절반

현재 `virtual-robot/src/controller.ts` 의 `tick()` 에 회랑 구속을 끼워 넣는다.

```
tick()
  │
  ├─ phase == "idle" → return
  │
  ├─ ★ 리스 검사
  │    if (now > leaseUntil && avoidanceMode)
  │        phase = "lease_lost";  return;        // PI5. 어떤 이동도 안 함
  │
  ├─ phase == "hold" → 이동 없음. 반납/요청 판단만 하고 return
  │
  ├─ phase == "follow" → tickFollow(dt)
  └─ phase == "rotate" → tickRotate(dt)


tickFollow(dt)
  │
  ├─ 다음 pose (nx, ny, nθ) 계산            ← 기존 로직 그대로
  │
  ├─ tryMove(nx, ny, nθ)
  │    ├─ applyPose(nx, ny, nθ)
  │    │    ├─ poseFeasible()          정적 장애물 + 인플레이트   (기존)
  │    │    ├─ poseHitsAny(obstacles)  동적 장애물                (기존)
  │    │    └─ ★ poseInsideLease()     회랑 구속 — I2            (신규)
  │    ├─ 실패 → 헤딩 유지하고 재시도 / 제자리 회전 재시도  (기존)
  │    └─ 전부 실패
  │         ├─ 회랑 때문이면  → phase = "hold"        ★ 정지, 목표 유지
  │         └─ 장애물 때문이면 → abortInfeasible()    (기존)
  │
  ├─ 반납 판단: 몸이 RELEASE_HYSTERESIS_PX 이상 벗어난 캡슐 → LeaseRelease
  │
  └─ 요청 판단: head_room_px < LEASE_REQUEST_AHEAD_S × LINEAR_SPEED_PX_S
                → LeaseRequest
```

### 2.1 `poseInsideLease` — 이 한 함수가 I2다

```ts
function poseInsideLease(x: number, y: number, theta: number): boolean {
  if (!avoidanceMode) return true;
  for (const [sx, sy] of robotSamplePoints(x, y, theta)) {   // OBB 코너 + 변 샘플
    if (!held.some((c) => pointInCapsule(sx, sy, c))) return false;
  }
  return true;
}
```

`robotSamplePoints` 는 동적 장애물 판정(`shared/obstacles.ts`)에서 이미 쓰는 것과 같은 함수다.
**footprint 전체**를 검사해야 한다. 중심점만 보면 몸이 삐져나간다.

### 2.2 `hold` 페이즈

기존 `Phase = "idle" | "follow" | "rotate"` 에 `"hold"` 와 `"lease_lost"` 를 추가한다.

- `hold` — 회랑이 모자라 멈춤. **목표(`goal`)는 유지.** 회랑이 늘면 `follow` 로 복귀.
- `lease_lost` — 리스 만료. 이상 상태이므로 UI 경보. 리스 재수신 시 복귀.

둘 다 "안 움직임"이지만 의미가 다르다. `hold` 는 정상 운영, `lease_lost` 는 장애다.

### 2.3 회랑 생성 — 로봇이 반경을 정한다

```ts
function buildCorridorRequest(): Corridor {
  const ahead = LINEAR_SPEED_PX_S * PERMIT_HORIZON_S;   // 60 px = 5초분
  const pts = samplePathAhead(this.path, this.pathIndex, ahead);
  const r = chooseRadius();
  return { segments: chainCapsules(pts, r) };           // 연속 점들을 캡슐로
}

function chooseRadius(): number {
  // 넓게 빌리면 회피 기동이 쉽지만 거절 확률이 오른다.
  // 이 트레이드오프는 로봇만 판단할 수 있다 — 여기 통로가 얼마나 좁은지,
  // 사람이 지나다니는 곳인지는 로봇의 센싱/occupancy 만 안다.
  const clearance = localClearance();                   // 자기 occupancy 로 측정
  return clamp(clearance * 0.8, CORRIDOR_MIN_RADIUS, CORRIDOR_MAX_RADIUS);
}
```

캡슐 개수를 줄이려면 연속한 직선 구간을 하나의 캡슐로 합친다 (`05_algorithms.md` §1.2).
5초분이면 보통 캡슐 3~5개다.

---

## 3. 로봇 상태기계

```
                        ┌────────┐
                   ┌───▶│  IDLE  │
                   │    └───┬────┘
                   │        │ DriveCommand
                   │        ▼
                   │   ┌──────────┐   계획 실패
                   │   │ PLANNING │──────────────▶ IDLE (+ 로그)
                   │   └────┬─────┘
                   │        │ 계획 성공 → PathUpdate + LeaseRequest
                   │        ▼
                   │   ┌──────────────┐
                   │   │ AWAITING_    │  아직 회랑 없음 → 이동 금지
                   │   │ LEASE        │
                   │   └────┬─────────┘
                   │        │ LeaseGrant(PROCEED | PARTIAL)
                   │        ▼
                   │   ┌─────────────────────────┐
                   │   │       FOLLOWING         │◀────┐
                   │   │  회랑 안에서 경로 추종    │     │ 회랑 확장
                   │   └──┬──────┬──────┬────────┘     │
                   │      │      │      │              │
    목적지 도달     │      │      │      │ 리스 만료     │
    ◀──────────────┘      │      │      ▼              │
                          │      │  ┌────────────┐     │
                          │      │  │ LEASE_LOST │─────┤ 리스 재수신
                          │      │  │ (이상상태)  │     │
                          │      │  └────────────┘     │
                          │      │                     │
              회랑 경계    │      │ EvasionRequest      │
                          ▼      ▼                     │
                    ┌────────┐ ┌──────────┐            │
                    │  HOLD  │ │ EVADING  │            │
                    │ 목표유지 │ │ 대체회랑  │            │
                    └───┬────┘ │ 계산중    │            │
                        │      └────┬─────┘            │
                        └───────────┼──────────────────┘
                                    │ 새 계획 성공
                                    ▼
                                 PLANNING (새 plan_id)
```

**`FOLLOWING` 에서 replan 이 일어나도 상태가 바뀌지 않는다.**
새 경로가 `held` 안에 들어가면 그냥 계속 간다. 이게 회랑 방식의 이점이다.

---

## 4. FMS 임대 루프 (10 Hz)

```
tick()  ── 매 100 ms
  │
  ├─ (1) 만료된 리스 회수
  │      원장에서 lease_until 지난 항목 제거
  │      → 그 로봇은 이미 스스로 멈췄다 (PI5)
  │
  ├─ (2) 연결 끊긴 로봇 처리
  │      마지막 pose 주변 DISCONNECT_HALO_PX 를 영구 점유로 등록
  │
  ├─ (3) 대기 큐의 LeaseRequest 처리
  │      우선순위 순 (시드 + 에이징)
  │      for each req:
  │          signal, granted = evaluate(req)     ← 03_flowcharts §2
  │          ★ 승인 직전 원시 disjoint 검사 (I1)
  │          원장 기록 + LeaseGrant 송신
  │
  ├─ (4) 트래픽 존 갱신
  │      다툼 그래프 연결성분 재계산
  │      FORMING → BidRequest 방송
  │      멤버 이탈/파기 판정 (히스테리시스 적용)
  │
  ├─ (5) L1 조정도표 갱신 (경로 바뀐 쌍만)
  │      통과 순서 예보, 정면 조기 경보
  │
  ├─ (6) 교착 검사
  │      전원 HOLD 가 DEADLOCK_CONFIRM_MS 지속 → E3 강제 → E5
  │
  ├─ (7) 기아 검사
  │      blocked_ms 로 에이징 갱신
  │
  ├─ (8) 리스 갱신 송신
  │      변화 없어도 held 스냅샷 재송신 (리스 연장)
  │
  └─ (9) Colyseus 상태 반영 (UI)
```

### 4.1 왜 (8)에서 변화가 없어도 보내는가

리스는 **하트비트**다. 보내지 않으면 로봇이 `LEASE_MS` 후 멈춘다.
FMS가 죽거나 네트워크가 끊기면 자동으로 전 차량이 정지한다 — fail-safe.

`LEASE_MS = 400 ms` = 발급 주기 4회분. 3회 연속 유실까지 견딘다.

### 4.2 원장 자료구조

```ts
type LeaseEntry = {
  robotId: string;
  leaseId: string;
  segments: Capsule[];
  leaseUntil: number;
  zoneId: string | null;
};

class LeaseLedger {
  private byRobot = new Map<string, LeaseEntry>();
  private index = new SpatialHash(TRAFFIC_CELL_PX);   // 조회 가속용. 판정용 아님
  //  ↑ 셀은 인덱스일 뿐. disjoint 판정은 항상 정확한 캡슐 기하로 한다.
}
```

---

## 5. 타이밍 예산

로봇 한 대가 12 px/s 로 움직이므로 한 tick(50 ms)에 **0.6 px** 이동한다.

| 구간 | 예산 | 근거 |
|------|------|------|
| 로봇 tick | 50 ms | `TICK_MS` |
| FMS 임대 루프 1회 | **< 30 ms** | 100 ms 주기의 30% |
| ├ 원장 disjoint 검사 (로봇 5대) | < 1 ms | 캡슐 5×5개, spatial hash |
| ├ Banker 안전검사 | < 1 ms | R=5, 자원 20개 → 500 스텝 |
| ├ L1 조정도표 (경로 변경 시에만) | < 20 ms | 300×300 격자, 캐시됨 |
| └ 나머지 | < 8 ms | |
| gRPC 왕복 (로컬) | < 5 ms | |
| `LEASE_MS` | 400 ms | 발급 주기 × 4 |
| 리스 만료 → 전 차량 정지 | ≤ 400 ms | 그 사이 최대 이동 4.8 px (안전 — 이미 승인된 회랑 안) |

### 5.1 FMS가 예산을 못 지키면

리스가 만료되어 로봇들이 멈춘다. **처리량은 죽지만 안전은 유지된다.**
이게 의도한 열화 방향이다.

### 5.2 L1이 무거운 이유와 대응

조정도표는 O(m×n) = 90,000 셀이다. 대응:

- **경로가 바뀔 때만 계산한다** (`plan_id` 캐시 키). 도표는 시간의 함수가 아니라 경로의 함수다.
- AABB 사전 검사로 안 겹치는 쌍은 통째로 스킵.
- 예산 초과 시 L1을 **건너뛴다.** L1은 효율 계층이므로 스킵해도 안전하다.
  (건너뛰면 로봇이 교차로 앞에서 급정거할 뿐이다)

이 "스킵해도 안전"이 계층 분리의 실질적 이득이다.

---

## 6. 동적 장애물 시스템과의 접점

기존 `place_query` / `obstacles` 흐름과 교통 제어가 만나는 지점.

```
UI 에서 장애물 배치
      │
      ▼
FloorRoom.placeObstacle → queryPlace() 로 전 로봇에게 place_query
      │
      ▼
로봇: canPlace() 로 자기 pose + 5초 경로 검사 → place_reply
      │
      ▼
전원 OK → 생성 → broadcastObstacles
      │
      ▼
로봇: setObstacles() → setExtraBlocked() → replan()
      │
      ▼
★ 여기서 교통 제어와 만난다
      ├─ 새 경로가 held 안 → 그냥 계속 주행. FMS 개입 없음
      └─ 새 경로가 held 밖 → 회랑 경계에서 hold → LeaseRequest
```

**교통 제어는 장애물 정보를 입력으로 쓰지 않는다.**
현재 FMS는 UI가 놓은 장애물을 알고 있지만, 실물에서는 FMS가 모르는 장애물이 존재한다(F2).
그래서 교통 제어 코드는 장애물 자료구조를 참조하지 않는다 —
로봇이 알아서 replan 하고, 그 결과가 회랑 요청으로 나타날 뿐이다.

`07_implementation.md` §2 에서 이걸 lint 규칙으로 강제한다.
