# 참고문헌

서지사항은 웹 검색으로 확인했다 (2026-09 기준).

---

## 1. 확정안의 뼈대

### [R1] "영역 안에서는 무엇을 하든 안전하다" — I1/I2 의 이론적 근거

> Zhou, D., Wang, Z., Bandyopadhyay, S., & Schwager, M. (2017).
> **Fast, On-line Collision Avoidance for Dynamic Vehicles Using Buffered Voronoi Cells.**
> *IEEE Robotics and Automation Letters*, 2(2), 1047–1054.
> DOI: [10.1109/LRA.2017.2656241](https://doi.org/10.1109/LRA.2017.2656241)

각 로봇이 자기 **Buffered Voronoi Cell** 안에서만 계획하면, 셀이 disjoint 하므로
충돌 회피가 **보장**된다. 셀 안의 궤적이 무엇이든 상관없다는 게 핵심이다.

**본 설계와의 관계**: I1(회랑 disjoint) + I2(몸이 회랑 안) = BVC 의 보장 구조와 동일하다.
차이는 BVC 가 분산(각자 센싱으로 계산)인 반면 우리는 **FMS가 계산해서 각자에게 자기 것만** 준다는 점.
그래서 원칙 P1(로봇은 남의 경로를 모른다)이 유지된다.
또 BVC 는 Voronoi 분할이라 셀이 자동으로 disjoint 하지만, 우리는 요청–승인이라
FMS가 명시적으로 disjoint 를 강제해야 한다.

### [R2] 신호등 모델 — 구간 점유 기반 진로 제어

> 철도 **고정폐색(fixed block)** 및 연동장치(interlocking).
> 대비 개념: CBTC 이동폐색(moving block) — IEEE Std 1474.1,
> ERTMS/ETCS SUBSET-026 의 Movement Authority / Limit of Movement Authority.

고정폐색은 **구간 점유권**을 준다. 이동폐색은 **진행 한계점(1D 스칼라)** 을 준다.
이동폐색이 더 진보한 방식이지만, 그건 **열차가 레일을 벗어날 수 없다**는 전제 위에서다.

**본 설계와의 관계**: 자율주행 로봇은 레일이 없다(F1).
따라서 1D 권한이 성립하지 않고, **2D 구간 점유권 = 고정폐색 쪽이 맞는 모델**이다.
사용자의 "FMS는 신호등"이라는 직관이 정확히 이 결론이다.

관련: 항공 관제의 공역 블록/섹터 할당도 같은 구조다.

### [R3] 교착 회피

> Reveliotis, S. A. (2000). **Conflict Resolution in AGV Systems.**
> *IIE Transactions*, 32(7), 647–659.
> DOI: [10.1080/07408170008967423](https://doi.org/10.1080/07408170008967423)
>
> Reveliotis, S. A., & Roszkowska, E. (2011). **Conflict Resolution in Free-Ranging
> Multi-Vehicle Systems: A Resource Allocation Paradigm.**
> *IEEE Transactions on Robotics*, 27(2), 283–296.
>
> 원형: Dijkstra, E. W. (1965). **Banker's algorithm** (EWD-108).

자유주행 다차량 시스템을 **순차 자원할당 시스템(RAS)** 으로 모델링하고,
Banker's algorithm 으로 안전 상태만 유지해 교착을 사전 회피한다.
2011년 논문은 영역을 셀로 분할해 셀을 자원으로 취급한다.

**본 설계와의 관계**: 확정안이 공간 점유 방식이 되면서 **이 모델과 정확히 일치**하게 됐다.
자원 = 다툼이 발생한 공간 셀. `05_algorithms.md` §5.

> Coffman, E. G., Elphick, M., & Shoshani, A. (1971). **System Deadlocks.**
> *ACM Computing Surveys*, 3(2), 67–78.

상호배제 / 점유대기 / 비선점 / 순환대기 4조건. 순환대기를 Banker 로 사전 차단한다.

---

## 2. 효율 계층(L1)에 남은 것

### [R4] 조정도표

> Siméon, T., Leroy, S., & Laumond, J.-P. (2002). **Path Coordination for Multiple Mobile
> Robots: A Resolution-Complete Algorithm.** *IEEE T-RA*, 18(1).
> DOI: [10.1109/70.988973](https://doi.org/10.1109/70.988973)
>
> 선행: O'Donnell & Lozano-Pérez (1989), ICRA — 조정도표 최초 도입.
> Leroy, Laumond & Siméon (1999), IJCAI — 기하 알고리즘.
> LaValle & Hutchinson (1998), IEEE T-RA — n대 확장.

각 로봇의 경로 진행도 `s_i` 를 축으로 하는 공간. 충돌 영역을 피하는 단조 경로를 찾는다.
**지도 없이 경로만으로 그릴 수 있다.**

**본 설계에서의 위치**: 논문은 *"robots moving along **fixed** independent paths"* 를 가정한다.
F1 때문에 그 가정이 성립하지 않으므로, **안전 계층에서 효율 계층(L1)으로 강등**했다.
정면 상황 조기 경보와 통과 순서 예측에만 쓴다. `05_algorithms.md` §4.

### [R5] path-velocity decomposition

> Kant, K., & Zucker, S. W. (1986). **Toward Efficient Trajectory Planning: The
> Path-Velocity Decomposition.** *IJRR*, 5(3), 72–89.
> DOI: [10.1177/027836498600500304](https://doi.org/10.1177/027836498600500304)

`TPP => PPP + VPP`. 정적 장애물 회피 경로(PPP)와 이동 장애물 회피 속도(VPP)를 분리.

**본 설계에서의 위치**: 역할 분리(로봇=PPP, FMS=VPP)의 착상을 여기서 얻었다.
다만 VPP 도 "경로 고정"을 전제하므로, 확정안에서는 **역할 분리의 정신만 계승**하고
FMS의 산출물을 속도가 아니라 **공간**으로 바꿨다.

### [R6] trajectory envelope / critical section

> Pecora, F., Andreasson, H., Mansouri, M., & Petkov, V. (2018). **A Loosely-Coupled Approach
> for Multi-Robot Coordination, Motion Planning and Control.** *ICAPS 2018*, 28(1), 485–493.
> DOI: [10.1609/icaps.v28i1.13923](https://doi.org/10.1609/icaps.v28i1.13923)
> 구현: [`FedericoPecora/coordination_oru`](https://github.com/FedericoPecora/coordination_oru)

경로를 sweep 한 **trajectory envelope**, 교차부인 **critical section**,
주행 중 온라인 갱신되는 **precedence**, 각 로봇에게 주는 **critical point**.

논문이 내세우는 문장이 우리 원칙과 겹친다.
*"very few assumptions are made on robot controllers... can be used with **any motion
planning method**... Coordination is seen as a high-level control scheme for the entire fleet."*

**본 설계와의 관계**: envelope 개념과 "조정자는 환경을 모른다"는 태도를 가져왔다.
다만 critical point 는 경로 위 인덱스(1D)이므로 F1에 취약하다.
확정안은 이를 **2D 회랑 임대**로 바꿨다.

### [R7] 슬라이딩 예약 창

> ter Mors, A. W., Zutt, J., & Witteveen, C. (2007). **Context-Aware Logistic Routing
> and Scheduling.** *ICAPS 2007*.

자원별 **자유 시간창(free time window)** 그래프 탐색.
**본 설계에서**: 전체 시간창 탐색은 하지 않고, `PERMIT_HORIZON_S = 5` 만큼 계속 미는
슬라이딩 창으로 축소했다.

### [R8] 우선순위 계획 / 제약 발상

> Erdmann, M., & Lozano-Pérez (1987). **On Multiple Moving Objects.** *Algorithmica*, 2, 477–521.
> Silver, D. (2005). **Cooperative Pathfinding.** *AIIDE 2005*. (WHCA*, reservation table)
> Sharon, G. et al. (2015). **Conflict-Based Search for Optimal Multi-Agent Pathfinding.**
> *Artificial Intelligence*, 219, 40–66.

우선순위 개념과 "충돌 하나 → 제약 하나" 발상만 차용했다.
CBS 의 제약은 (에이전트, 셀, 시각)이라 공유 지도가 필요하고, 그건 P2 위반이다.
확정안의 제약은 **로봇 자기 임대의 부분집합**(`release_hint`)이다.

### [R9] 존/토큰 제어

> Egbelu, P. J., & Tanchoco, J. M. A. (1984). **Characterization of Automatic Guided
> Vehicle Dispatching Rules.** *IJPR*, 22(3), 359–374.

존 개념은 살렸지만 **공간 구획이 아니라 관계 그래프**(다툼 연결성분)로 정의했다.
사전 공간 구획은 레이아웃 지식을 요구하고, F2 때문에 그 지식은 신뢰할 수 없다.

### [R10] 지역 안전 계층

> ISO 3691-4:2020 — *Industrial trucks — Safety requirements and verification —
> Part 4: Driverless industrial trucks and their systems.*
> ANSI/ITSDF B56.5 — *Safety Standard for Driverless, Automatic Guided Industrial Vehicles.*

무인차량은 관제와 **독립적인** 차상 안전 정지 계층을 요구받는다.
"뭔가 가깝다"만 판정하므로 상대 경로가 필요 없고(P1 무관), FMS를 거치지 않는다(P2·지연 무관).
현재 시뮬레이터에는 미구현 — `06_safety_and_failures.md` §4.

---

## 3. 검토 후 기각

| 기법 | 기각 사유 |
|------|-----------|
| **경로 위 1D 진행 권한** (이동폐색형) | **F1 위반.** 로봇이 경로를 이탈하면 안전 논증이 무너진다. 이 설계의 출발점이 된 기각 |
| **ORCA / RVO** (van den Berg et al.) | 상대 속도·위치를 알아야 한다 → **P1 위반.** 게다가 이 시뮬레이터의 로봇은 서로를 감지조차 못 한다 |
| **WHCA\* 시공간 예약 테이블** (Silver 2005) | 셀×시간 예약에 공유 격자가 필요 → **P2 위반.** 게다가 시각 예약은 F1(경로 이탈)에 취약 |
| **CBS 풀 구현** (Sharon 2015) | 중앙에서 경로를 재계획 → **F3 위반** (FMS는 경로를 제공할 수 없다) |
| **Push-and-Swap / Push-and-Rotate** (Luna & Bekris 2011; de Wilde et al. 2013) | 중앙이 그래프(=지도)를 알아야 한다 → **P2/F3 위반** |
| **분산 CBS / 로봇 간 P2P 협상** | 로봇끼리 경로 교환 → **P1 위반** |
| **FMS가 대기·후퇴 좌표를 지정** | **F2 위반.** 맵에 없는 물건이 그 자리에 있을 수 있다 → `release_hint`(자기 임대 부분집합)로 대체 |
| **FMS가 통과 이력으로 지도를 역추정** (traversability map from fleet traces) | 기술적으로 가능하지만 F2의 책임 경계를 흐린다. 추정이 틀리면 FMS가 벽에 로봇을 세우고 안전 논증이 무너진다 → **실증된 점 집합(breadcrumb)까지만** 허용 |
| **익명 keep-out 으로 상대 회랑 전달** | 형식상 "남의 경로"가 아니지만 형상이 그대로 노출된다. **P1 의 실질적 위반**으로 판단해 거부 |
| **셀 격자 단위 할당** (Reveliotis 원형) | 원칙 위반은 아니다. 다만 FMS–로봇 간 공유 이산화를 요구해서 플래너 독립성이 깨진다 → 캡슐 체인으로 대체 (Banker 자원 식별에만 셀 사용) |
| **Siméon 2002 의 n차원 도표 탐색** | 로봇 2~5대 규모에 과하다. 쌍별 도표 + Banker 로 근사 |

---

## 4. 레포 내부 참조

| 위치 | 관계 |
|------|------|
| `virtual-robot/src/controller.ts` `applyPose()` | I2 구속 검사가 들어갈 자리 |
| `virtual-robot/src/controller.ts` `canPlace()` | 5초 지평(`LINEAR_SPEED_PX_S × LOOKAHEAD_S = 60 px`)의 출처 |
| `shared/planner.ts` `planRoute()` / `densify()` | 경로 → 캡슐 체인의 입력 |
| `shared/obstacles.ts` `robotSamplePoints()` | footprint 샘플. `poseInsideLease` 가 재사용 |
| `server/src/grpc/robotBridge.ts` `queryPlace()` | capability query 패턴의 원형 (FMS가 묻고 로봇이 기하로 답함) |
| `docs/traffic_control/v0/` | 1차 검토. Blue/Red 후보와 토론 기록 |
| `docs/traffic_control_by_agent/v0/` | 2차 검토. 원칙 P1/P2 도입, 경로 기반 안과 그 개정 기록 |
