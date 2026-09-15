# 07 — 구현

---

## 1. 파라미터

`shared/constants.ts` 에 추가한다. 기존 값은 그대로 쓴다.

```ts
// ── 회랑 기하 ──────────────────────────────────────────────
/** 로봇 외접원 = hypot(16,10)/2 = 9.434. 회랑 반경은 반드시 이보다 커야 한다. */
export const ROBOT_CIRCUMRADIUS_PX = Math.hypot(ROBOT_LENGTH_PX, ROBOT_WIDTH_PX) / 2;
export const CORRIDOR_MIN_RADIUS = 12;      // 겨우 지나갈 폭
export const CORRIDOR_MAX_RADIUS = 26;      // 회피 기동 여유가 넉넉한 폭
export const CORRIDOR_GAP_PX = 4;           // 임대 간 최소 이격 (부동소수 + 근사 오차)
export const CAPSULE_FIT_TOL_PX = 1.5;      // 경로→캡슐 근사 허용오차 (반경에 가산)

// ── 임대 수명 ──────────────────────────────────────────────
export const PERMIT_HORIZON_S = LOOKAHEAD_S;     // 5 — 한 번에 빌리는 주행 시간
export const LEASE_REQUEST_AHEAD_S = 2;          // 이만큼 남으면 선제 요청
export const AUTHORITY_HZ = 10;                  // FMS 임대 루프 주기
export const LEASE_MS = 400;                     // 리스 수명 = 발급 주기 × 4
export const RELEASE_HYSTERESIS_PX = 8;          // 이만큼 확실히 벗어나야 반납

// ── 우선순위 / 존 ──────────────────────────────────────────
export const BID_WINDOW_MS = 120;
export const STARVATION_MS = 8000;               // 이 시간 대기하면 최대 시드만큼 승격
export const ZONE_HYSTERESIS_MS = 500;
export const DEADLOCK_CONFIRM_MS = 2000;

// ── 에스컬레이션 ───────────────────────────────────────────
export const EVASION_DEADLINE_MS = 800;
export const MAX_REROUTE_ROUNDS = 2;
export const MAX_REVERSAL = 1;
export const PROGRESS_EPSILON_PX = 2;            // 이보다 작은 전진은 승인 안 함

// ── L1 조정도표 (효율 계층) ────────────────────────────────
export const COORD_SAMPLE_PX = 4;
export const TRAFFIC_SEP_PX = 2 * CORRIDOR_MIN_RADIUS;   // 24
export const TRAFFIC_CELL_PX = 20;               // spatial hash / Banker 자원 해상도

// ── 실패 처리 ──────────────────────────────────────────────
export const DISCONNECT_HALO_PX = LINEAR_SPEED_PX_S * LOOKAHEAD_S;  // 60
export const DISCONNECT_FREEZE_MS = 3000;
export const WATCHDOG_TOLERANCE_PX = 2;

// ── 기타 ───────────────────────────────────────────────────
export const AVOIDANCE_MODE_DEFAULT = true;
export const BREADCRUMB_SPACING_PX = 20;
export const BREADCRUMB_MAX = 64;
```

### 상수 간 지켜야 할 부등식

컴파일 타임 단정문으로 고정한다.

```ts
// 회랑이 로봇을 담을 수 있어야 한다 (I2)
static_assert(CORRIDOR_MIN_RADIUS > ROBOT_CIRCUMRADIUS_PX);
// 이격이 한 tick 이동량보다 충분히 커야 한다
static_assert(CORRIDOR_GAP_PX > LINEAR_SPEED_PX_S * TICK_MS / 1000 * 4);
// 도표 샘플이 이격보다 촘촘해야 샘플 사이로 빠져나가지 않는다
static_assert(COORD_SAMPLE_PX < TRAFFIC_SEP_PX / 2);
// 리스가 발급 주기보다 충분히 길어야 정상 상태에서 안 끊긴다
static_assert(LEASE_MS >= 3 * (1000 / AUTHORITY_HZ));
```

---

## 2. 코드 배치

```
shared/
  ├─ constants.ts            // 위 상수 추가
  └─ corridor.ts             // 신규. Capsule 기하 (양쪽 공용)
       · pointInCapsule, segSegDistance, capsulesDisjoint
       · chainCapsules (경로 → 캡슐 체인)
       · corridorContainsFootprint

server/src/traffic/          // ★ 이 디렉터리는 지도를 모른다
  ├─ LeaseLedger.ts          // 원장 + spatial hash + 전수 disjoint 검사
  ├─ LeaseArbiter.ts         // 요청 평가, PROCEED/PARTIAL/STOP 산출
  ├─ TrafficZone.ts          // 존 수명주기, 시드, 에이징
  ├─ Banker.ts               // 안전상태 검사
  ├─ Escalator.ts            // E2~E5, propose–verify 루프
  ├─ CoordinationDiagram.ts  // L1. 도표 구성 + 캐시
  ├─ MonotoneReach.ts        // L1. 단조 도달성 DP
  └─ TrafficController.ts    // 10 Hz 루프 오케스트레이션

virtual-robot/src/
  ├─ controller.ts           // hold/lease_lost 페이즈, poseInsideLease, 회랑 생성
  └─ leaseClient.ts          // 신규. 요청/반납 타이밍, 회피 응답 생성
```

### 2.1 지도 무지를 코드로 강제

```json
// eslint 또는 tsconfig path 제약
"no-restricted-imports": {
  "patterns": [{
    "group": ["**/shared/occupancy*", "**/shared/obstacles*", "**/shared/planner*"],
    "message": "traffic/ 은 지도를 모른다 (F2/P2). 로봇이 보고한 것만 쓸 것."
  }]
}
```

적용 대상: `server/src/traffic/**`.
`06_safety_and_failures.md` §8 체크리스트의 항목 하나가 이걸로 자동 검증된다.

---

## 3. `controller.ts` 변경점

현재 코드 기준의 구체적 diff 방향.

```ts
// Phase 확장
type Phase = "idle" | "follow" | "rotate" | "hold" | "lease_lost";

// 신규 필드
private leaseId = "";
private held: Capsule[] = [];
private leaseUntil = 0;
private avoidanceMode = AVOIDANCE_MODE_DEFAULT;
```

### 3.1 `applyPose` 에 구속 검사 추가

```ts
private applyPose(x: number, y: number, theta: number): boolean {
  if (!poseFeasible(x, y, theta)) return false;              // 기존: 정적
  if (poseHitsAny(x, y, theta, this.obstacles)) return false; // 기존: 동적
  if (!this.poseInsideLease(x, y, theta)) return false;       // ★ 신규: I2
  this.x = x; this.y = y; this.theta = wrapAngle(theta);
  return true;
}
```

`tryMove` 는 그대로 둔다. 3단계 폴백(직진+조향 → 직진만 → 제자리회전)이
회랑 구속에도 자연스럽게 적용된다.

### 3.2 `tick` 앞에 리스 검사

```ts
private tick(): void {
  if (this.avoidanceMode && Date.now() > this.leaseUntil) {
    this.phase = "lease_lost";
    return;                                    // PI5: 어떤 이동도 안 함
  }
  if (this.phase === "idle" || this.phase === "hold" || this.phase === "lease_lost") {
    this.maybeReleaseAndRequest();
    return;
  }
  // ... 기존 follow / rotate
}
```

### 3.3 이동 실패 시 `hold` 로

```ts
if (!this.tryMove(nx, ny, nextTheta)) {
  if (this.poseInsideLease(this.x, this.y, this.theta) &&
      !this.poseInsideLease(nx, ny, nextTheta)) {
    this.phase = "hold";        // ★ 회랑이 모자란 것. 목표는 유지
    return;
  }
  this.abortInfeasible();       // 기존: 장애물 때문이면 계획 포기
}
```

**`hold` 와 `abortInfeasible` 을 구분하는 게 중요하다.**
회랑이 모자란 건 정상 운영이고 곧 풀린다. 장애물로 막힌 건 재계획 사안이다.

### 3.4 `setObstacles` 는 거의 그대로

```ts
setObstacles(items: DynObstacle[]): void {
  this.obstacles = items;
  setExtraBlocked(items.length ? rasterizeObstacles(items) : null);
  if (this.goal && this.phase !== "idle") this.replan();
  // ★ replan 후에도 멈추지 않는다.
  //   새 경로가 held 안이면 계속 간다. 밖이면 다음 tick 에 hold 로 떨어진다.
}
```

경로 기반 방식이었다면 여기서 권한을 무효화하고 정지해야 했다. 회랑 방식의 이점.

---

## 4. 웹 UI

| 항목 | 렌더 |
|------|------|
| 임대 회랑 | 반투명 캡슐 오버레이. 로봇 색상. **가장 중요한 디버깅 시각화** |
| 신호 상태 | 로봇 배지에 🟢 PROCEED / 🟡 PARTIAL / 🔴 STOP |
| 회랑 경계 | 진행 방향 끝단에 정지선 표시 |
| 트래픽 존 | 멤버를 잇는 얇은 선 + `zone_id` 라벨 |
| 로봇 상태 | `FOLLOW` / `HOLD` / `EVADE` / `LEASE_LOST` |
| `avoidanceMode` | 로봇별 토글. **"디버깅 전용" 경고 문구 필수** |
| (개발자 패널) 조정도표 | 두 로봇 선택 시 도표 + 진행점 커서. 정면 상황 원인 파악용 |
| (개발자 패널) 원장 | 캡슐 목록과 최소 이격거리 실시간 |

---

## 5. 구현 단계

| 단계 | 내용 | 완료 기준 |
|------|------|-----------|
| **S1** | `shared/corridor.ts` 기하 + 단위 테스트 | `segSegDistance` 가 평행/교차/끝점 케이스 전부 통과 |
| **S2** | 로봇: `held` 수신, `poseInsideLease`, `hold`/`lease_lost`, 리스 만료 정지 | 수동으로 회랑을 꽂아 정확히 경계에서 서는지. footprint 가 절대 안 삐져나감 |
| **S3** | FMS: 원장 + 전수 disjoint + **무조건 보수적 승인**(겹치면 무조건 STOP) | **교차 시나리오에서 두 대가 절대 안 부딪힘.** 처리량은 나빠도 됨 |
| **S4** | PARTIAL 산출, 반납/재요청 사이클 | 교차에서 한 대가 대기 후 자동 통과 |
| **S5** | 존 + 시드 추첨 + 에이징 + Banker | 3대 순환 대기에서 안 막힘 |
| **S6** | L1 조정도표 + 정면 조기 경보 | 교차로 앞 급정거가 사라짐 |
| **S7** | E2/E3 propose–verify + breadcrumb | 좁은 복도 정면에서 우회/대피 성립 |
| **S8** | UI 오버레이, 개발자 패널 | 육안 검증 |

> **S3 가 안전의 전부다.** S4 이후는 전부 처리량 최적화다.
> **S3 를 깨는 변경은 어떤 처리량 이득이 있어도 받지 않는다.**

---

## 6. 테스트 시나리오

모든 통합 테스트는 `min_pair_distance_px > 0` 을 단정한다.

| # | 배치 | 기대 |
|---|------|------|
| **T1** | 직교 교차 | 시드 승자 통과, 패자 회랑 경계에서 HOLD 후 통과 |
| **T2** | 같은 방향 추종 | 뒷차가 간격 유지. 충돌 없음, 정지 없음 |
| **T3** | 넓은 홀 정면 | 회랑이 서로 안 겹치게 잡혀서 그냥 지나감 |
| **T4** | 좁은 복도 정면 | 단조 DP 조기 경보 → E2 → 우회 성립 |
| **T5** | 막힌 복도 정면 | E2 실패 → E3 대피 → 통과 후 복귀 |
| **T6** | 3대 순환 대기 | Banker 사전 차단. 교착 없음 |
| **T7** | **주행 중 로봇이 경로 이탈** (강제로 옆으로 밀기) | 회랑 안이면 아무 일 없음. 밖이면 `applyPose` 가 거부 |
| **T8** | 주행 중 FMS 강제 종료 | 전 차량 `LEASE_MS` 내 정지 |
| **T9** | 주행 중 로봇 1대 연결 끊김 | 남은 로봇이 halo 앞에서 정지 |
| **T10** | 주행 중 동적 장애물 배치 | replan 후 회랑 안이면 무정지 통과, 밖이면 hold → 재요청 |
| **T11** | `avoidanceMode = false` 1대 | 그 로봇은 자유 주행, 나머지가 전 경로를 회피 |
| **T12** | 반납 메시지 유실 | 해당 회랑이 리스 만료로 회수됨. 교착 없음 |
| **T13** | `LeaseGrant` 순서 뒤바뀜 | `request_id` 매칭으로 옛 것 폐기. 원장 정합 유지 |

**T7 과 T10 이 이 설계의 핵심 주장을 검증한다.**
경로 이탈과 재계획이 안전에 영향을 주지 않는다는 것 — F1의 해소.

**T4 는 두 시스템(동적 장애물 / 교통)의 접점이라 가장 깨지기 쉽다.** 우선 작성할 것.

---

## 7. 마이그레이션 순서

기존 시스템을 멈추지 않고 넣는 방법.

1. **S1~S2 를 `avoidanceMode = false` 기본값으로** 머지한다.
   회랑 코드가 들어가지만 아무 동작도 하지 않는다 (`poseInsideLease` 가 항상 `true`).
2. **S3 를 넣고 로봇 1대만** `avoidanceMode = true` 로 켠다.
   혼자면 다툼이 없으므로 항상 PROCEED. 회랑 발급/반납 사이클만 검증된다.
3. **2대를 켠다.** T1/T2 통과 확인.
4. S4 이후를 순차 적용. 각 단계에서 `min_pair_distance_px` 회귀 확인.
5. 전부 안정되면 `AVOIDANCE_MODE_DEFAULT = true` 로 전환.
