# 05 — 알고리즘

---

## 1. 회랑 기하

### 1.1 캡슐

```
Capsule = { x1, y1, x2, y2, r }
        = { p : dist(p, segment[(x1,y1),(x2,y2)]) ≤ r }
```

점 회랑은 `x1==x2 && y1==y2` (원판).

```ts
function pointInCapsule(px: number, py: number, c: Capsule): boolean {
  return distPointSegment(px, py, c.x1, c.y1, c.x2, c.y2) <= c.r;
}

function distPointSegment(px, py, ax, ay, bx, by): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 < 1e-9 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
```

### 1.2 경로 → 캡슐 체인

연속한 직선 구간을 하나의 캡슐로 합쳐 개수를 줄인다.

```ts
function chainCapsules(pts: Point[], r: number, tol = 1.5): Capsule[] {
  const out: Capsule[] = [];
  let a = 0;
  for (let b = 2; b <= pts.length; b++) {
    // pts[a..b-1] 이 하나의 직선으로 근사되는가?
    if (b === pts.length || maxDeviation(pts, a, b) > tol) {
      out.push({ x1: pts[a].x, y1: pts[a].y, x2: pts[b - 1].x, y2: pts[b - 1].y, r });
      a = b - 1;
    }
  }
  return out;
}
```

`tol = 1.5 px` 로 근사하면 캡슐이 실제 경로보다 조금 좁아질 수 있다.
따라서 **근사 오차를 반경에 흡수한다**: `r_effective = r + tol`.
회랑은 크게 잡아야 안전하다 (작게 잡으면 I2가 깨진다).

### 1.3 반경 하한

```
ROBOT_CIRCUMRADIUS = hypot(16, 10) / 2 = 9.434
CORRIDOR_MIN_RADIUS = 12        // 외접원 + 2.5 여유
```

로봇이 회랑 중심선 위에 정확히 있어도 몸이 삐져나가면 안 되므로,
반경은 반드시 외접원보다 커야 한다. 12 px 은 "겨우 지나갈 폭"이다.

---

## 2. disjoint 판정 — I1

### 2.1 캡슐 대 캡슐

두 캡슐이 겹치지 않을 조건:

```
segmentDistance(seg_a, seg_b) > r_a + r_b + CORRIDOR_GAP_PX
```

```ts
function capsulesDisjoint(a: Capsule, b: Capsule): boolean {
  return segSegDistance(a, b) > a.r + b.r + CORRIDOR_GAP_PX;
}
```

`segSegDistance` 는 두 선분 사이 최단거리. 표준 구현(끝점 4개 × 점-선분 거리 + 내부 교차 검사).
`CORRIDOR_GAP_PX = 4` 는 부동소수 오차와 캡슐 근사 오차에 대한 여유다.

### 2.2 회랑 대 원장

```ts
function canGrant(wanted: Corridor, robotId: string, ledger: LeaseLedger): boolean {
  for (const seg of wanted.segments) {
    for (const other of ledger.nearby(seg)) {        // spatial hash 로 후보 축소
      if (other.robotId === robotId) continue;       // 자기 것은 겹쳐도 됨
      for (const oseg of other.segments) {
        if (!capsulesDisjoint(seg, oseg)) return false;
      }
    }
  }
  return true;
}
```

**복잡도**: 로봇 R대, 로봇당 캡슐 K개. spatial hash 로 후보를 줄이면 실효 O(K × 소수).
R=5, K=5 라면 최악 25×25 = 625 쌍. 1 ms 미만.

### 2.3 승인 직전 원시 검사 (안전망)

상위 로직(순서 결정, Banker, 조정도표)이 전부 틀려도 여기서 걸린다.

```ts
function commitGrant(entry: LeaseEntry, ledger: LeaseLedger): boolean {
  // 원장 전체를 대상으로, 지름길 없이 전수 검사
  for (const other of ledger.all()) {
    if (other.robotId === entry.robotId) continue;
    for (const a of entry.segments) {
      for (const b of other.segments) {
        if (!capsulesDisjoint(a, b)) {
          metrics.violation++;
          haltAll("ledger disjoint violation");
          return false;
        }
      }
    }
  }
  ledger.put(entry);
  return true;
}
```

§2.2와 중복이지만 **의도적이다.** §2.2는 spatial hash 를 쓰므로 인덱스 버그에 취약하고,
여기는 전수 검사라 느리지만 확실하다. 로봇 5대 규모에서 전수 검사 비용은 무시할 만하다.

---

## 3. 부분 승인 (PARTIAL) 산출

요청 회랑 전체가 안 되면, **앞에서부터 잘라서** 최대한 승인한다.

```ts
function partialGrant(wanted: Corridor, robotId: string, ledger: LeaseLedger): Capsule[] {
  const ok: Capsule[] = [];
  for (const seg of wanted.segments) {
    if (canGrantSegment(seg, robotId, ledger)) {
      ok.push(seg);
      continue;
    }
    // 이 캡슐의 앞부분만 살릴 수 있나? 이분 탐색으로 절단점을 찾는다.
    const cut = binarySearchCut(seg, robotId, ledger);   // 8회 반복이면 충분
    if (cut) ok.push(cut);
    break;   // ★ 앞이 막히면 뒤는 의미 없다. 회랑은 연속이어야 한다
  }
  return ok;
}
```

`break` 가 중요하다. 앞이 막혔는데 뒤쪽만 승인하면 **로봇이 도달할 수 없는 영역**을
점유하게 되어 다른 로봇을 헛되이 막는다.

절단점은 `PROGRESS_EPSILON_PX = 2` 이상 전진이 생길 때만 승인한다.
그보다 작으면 STOP 을 보낸다 (의미 없는 찔끔 전진 방지).

---

## 4. L1 — 조정도표 (효율 계층)

> ⚠ **이건 안전 계층이 아니다.** 경로는 F1에 의해 예보일 뿐이다.
> 여기서 나온 결론이 틀려도 I1/I2가 충돌을 막는다.
> 목적은 **로봇이 교차로 앞에서 급정거하지 않게 미리 순서를 정해두는 것**이다.

### 4.1 도표 구성

로봇 쌍 (i, j) 의 보고된 경로 노드로 격자를 만든다.

```
C[a][b] = 1  if  dist(nodes_i[a], nodes_j[b]) < TRAFFIC_SEP_PX
```

`TRAFFIC_SEP_PX = 2 × CORRIDOR_MIN_RADIUS = 24`.
(최소 회랑끼리도 안 겹치려면 이만큼 떨어져야 하므로)

### 4.2 충돌 유형 분류

성분 내 셀들의 `(a, b)` 표본공분산 부호로 판별한다.

| 조건 | 유형 | 도표 모양 | 대응 |
|------|------|-----------|------|
| `cov > 0`, 길쭉 | 추종 | 대각 밴드 | 헤드웨이만 유지. 정지 불필요 |
| `cov < 0`, 길쭉 | **정면** | 반대각 장벽 | **대기로 못 풀림 → E2 예고** |
| 작고 뭉툭 | 교차 | 고립 덩어리 | 순서만 정하면 됨 |

```
   추종                    교차                    정면
 s_j                    s_j                    s_j
  ▲       ▨▨             ▲                      ▲▨
  │     ▨▨▨              │                      │▨▨
  │   ▨▨▨                │     ▨▨▨              │ ▨▨
  │ ▨▨▨                  │     ▨▨▨              │  ▨▨
  │▨▨                    │                      │   ▨▨
  └────────► s_i         └────────► s_i         └─────▨▨► s_i
```

### 4.3 단조 도달성 DP — 정면 조기 경보

로봇은 자기 경로를 되돌아가지 않으므로 도표 위 진행은 단조다.

```
R[a][b] = ¬C[a][b] ∧ ( R[a-1][b] ∨ R[a][b-1] )
R[a₀][b₀] = ¬C[a₀][b₀]                          // 현재 진행점에서 시작
```

- `R[m-1][n-1] == true` → 대기 조합으로 둘 다 도달 가능 → **E1로 충분**
- `R[m-1][n-1] == false` → 어떤 대기로도 불가능 → **E2 예고**

정지는 무한히 허용되므로 시간 축이 필요 없다. 순수 기하 판정이다.

**이게 왜 값진가**: "복도가 좁으니 우회시켜야겠다" 같은 지도 기반 휴리스틱 없이,
경로만으로 정면 상황을 판별한다. 임계값 튜닝이 없다.
다만 F1 때문에 **확정이 아니라 예보**다 — 경로가 바뀌면 결론도 바뀐다.

### 4.4 통과 순서 = 호모토피 클래스

교차 덩어리를 아래로 우회하는 계단 = i 먼저. 위로 = j 먼저.
둘 다 가능하면 **시드 추첨이 고른다**.

```
if   R_below(goal) and R_above(goal):  winner = argmax effectivePriority
elif R_below(goal):                    winner = i
elif R_above(goal):                    winner = j
else:                                  E2 예고 (정면)
```

### 4.5 캐시

도표는 **경로의 함수이지 시간의 함수가 아니다.**
`(plan_id_i, plan_id_j)` 를 키로 캐시하고, 경로가 바뀔 때만 재계산한다.
매 tick 은 진행점 커서만 옮긴다.

---

## 5. L2 — 교착 회피 (Banker)

### 5.1 왜 필요한가

```
robot-1 은 robot-2 의 회랑 때문에 대기
robot-2 는 robot-3 의 회랑 때문에 대기
robot-3 은 robot-1 의 회랑 때문에 대기
```

각 쌍은 개별적으로 합법이다. 그런데 전체는 영원히 멈춘다 (Coffman et al. 1971 의 순환 대기).

### 5.2 자원 추상화

- **자원** = 여러 로봇이 다투는 공간 영역. 실제로는 다툼이 발생한 캡슐 교차부를
  `TRAFFIC_CELL_PX = 20` 격자 셀로 이산화해 식별한다.
- **최대 요구량(max claim)** = 로봇의 남은 경로가 지나갈 모든 자원 셀.
  → 여기서 L1의 경로 예보를 쓴다. 예보가 틀리면 보수적이 될 뿐 안전은 무관.
- **현재 할당(allocation)** = 지금 임대로 쥔 자원 셀.

> **발급은 5초분씩(allocation), 안전 판정은 남은 경로 전체(max claim).**
> Banker's algorithm 이 요구하는 구조가 정확히 이것이다.

### 5.3 안전상태 검사

```ts
function isSafe(state: LedgerState): boolean {
  const work = new Set(state.freeResources);
  const finish = new Map([...state.robots].map((r) => [r, false]));
  for (;;) {
    const r = [...state.robots].find(
      (r) => !finish.get(r) && subset(diff(maxClaim(r), allocation(r)), work),
    );
    if (!r) break;
    for (const res of allocation(r)) work.add(res);   // 끝까지 가면 전부 반납
    finish.set(r, true);
  }
  return [...finish.values()].every(Boolean);
}
```

안전 상태에서 출발해 안전 상태로만 이동하면 교착이 불가능하다 (Dijkstra 1965).
보수적이다 — 실제로는 괜찮은 상태를 거절할 수 있다. 로봇 2~5대에서는 손해가 무시할 수준.

**복잡도** O(R² × K). R=5, K=20 이면 500 스텝. 10 Hz 에서 무시 가능.

### 5.4 검출 계층 (Banker 버그 대비)

```
존의 모든 멤버가 HOLD 이고
그 상태가 DEADLOCK_CONFIRM_MS = 2000 지속
  → 교착 확정
  → 최하위 우선순위에게 E3(VACATE) 강제
  → 그래도 안 풀리면 E5 (존 동결 + UI 경보)
```

대기 그래프 사이클 탐지보다 "전원 정지 + 타임아웃"이 구현이 단순하고 오탐이 없다.

---

## 6. L2 — 시드 추첨과 기아 방지

### 6.1 추첨

- 존이 `FORMING` 되면 FMS가 멤버에게 `BidRequest(zone_id)` 방송
- 로봇은 `[0, 100)` 실수를 `TrafficBid` 로 회신
- `BID_WINDOW_MS = 120` 안에 안 오면 FMS가 대신 뽑는다
- 우선순위 = 시드 내림차순, 동점은 `robot_id` 사전순

**왜 로봇이 뽑는가**: FMS가 뽑아도 기능은 같다. 그래도 로봇에게 맡기는 이유는
(1) 응답 자체가 생존 확인이고, (2) 실물 확장 시 배터리·임무 긴급도를 시드에 반영할
여지가 생기기 때문이다.

### 6.2 sticky — 라이브락 방지

**시드는 존 수명 동안 고정한다.** 매 tick 재추첨하면 우선순위가 뒤집히면서
서로 양보하다 둘 다 못 가는 라이브락이 생긴다. 존이 합병돼도 재추첨하지 않는다.

### 6.3 에이징 — 기아 방지

```
effectivePriority(i) = seed(i) + (100 / STARVATION_MS) × blockedMs(i)
```

`blockedMs` 는 `HOLD` 로 정지해 있던 누적 시간. 움직이기 시작하면 0으로 리셋.
`STARVATION_MS = 8000` 이면 8초 대기 시 최대 시드만큼 가산되어 반드시 역전된다.

---

## 7. 계층별 보장 요약

| 계층 | 보장 | 근거 | 틀리면 |
|------|------|------|--------|
| I1 (§2, §2.3) | **충돌 없음** (FMS 측) | 캡슐 disjoint 전수 검사 | 충돌 |
| I2 (`04_control_flow.md` §2.1) | **충돌 없음** (로봇 측) | footprint ⊆ 회랑 | 충돌 |
| 리스 (`04` §4.1) | 통신 실패 시 안전 | fail-safe 정지 | 충돌 위험 |
| 단조 DP (§4.3) | 정면 조기 경보 | 도표 도달성 | 급정거 |
| Banker (§5) | 전역 교착 없음 | 안전 상태 불변 | 멈춤 |
| 에이징 (§6.3) | 기아 없음 | 유한 시간 내 역전 | 한 대가 계속 대기 |
| 검출 계층 (§5.4) | 위 계층 버그의 최후 방어 | 타임아웃 | 멈춤 |
