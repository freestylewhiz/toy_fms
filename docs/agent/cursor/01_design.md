# FMS 테스트 UI — 정보 구조·리소스·맵·영속화

원본 `bg_fms` 웹은 Select / Waypoint / Charger / Move / Dock / Obstacle / Grid 를 **한 툴바**에 섞는다.
이 문서는 그 혼합을 깨고, **시맨틱 리소스를 효율히 심는 테스트 환경**의 정보 구조를 고정한다.

구현하지 않는다. 픽셀·클래스명·위젯 스펙이 아니다.

통신은 지금과 같다. **MQTT 없음.** 브라우저 ↔ FMS 는 Colyseus WS, FMS ↔ 가상 로봇은 gRPC.

원천 문서: [`../../traffic_control_v2/vda5050/04_map_editor.md`](../../traffic_control_v2/vda5050/04_map_editor.md), [`../../traffic_control_v2/vda5050/05_semantic_resources.md`](../../traffic_control_v2/vda5050/05_semantic_resources.md), [`../../user_defined_traffic_zone/01_types.md`](../../user_defined_traffic_zone/01_types.md).

---

## 한 줄

> 작업은 **운용 / 현장 배치 / VDA 배치** 세 모드로만 한다.
> 로봇 명령과 맵 에셋은 같은 팔레트에 두지 않는다.
> 바닥 occupancy 는 그리지 않는다. 그리는 것은 점·폴리곤·그래프다.
> 맵 에셋의 진실은 SQLite (`bun:sqlite`) 이고, Colyseus 는 세션 투영이며, occupancy PNG/bin 은 기하만 담당한다.

---

## 1. 세 모드 정보 구조

모드는 **배타적 작업 공간**이다. 레이어 토글(바닥·occupancy·존·그래프·런타임)은 모든 모드에서 볼 수 있다. 편집 권한만 모드가 가른다.

공통 동사(모든 맵 리소스): **놓기 · 옮기기 · 회전 · 속성 편집 · 삭제**.
회전이 의미 없는 도형(원 장애물, 무방향 폴리곤)은 회전 핸들을 제공하지 않는다. 폴리곤은 정점 편집이 회전을 대체한다.

### 1.1 운용

플릿을 **돌리는** 모드. 맵을 바꾸지 않는다.

| 속함 | 하지 않음 |
|------|-----------|
| 로봇 선택 | 웨이포인트·충전소·존·노드·엣지 생성/이동/삭제 |
| 바닥 클릭 또는 웨이포인트로 **이동** | 장애물 배치(현장 모드) |
| 충전소 **도킹** | occupancy 칠하기 |
| 주행 취소 | VDA 그래프·zoneSet 편집 |
| occupancy / 존 / 그래프 **보기**(Grid 포함) | |
| 런타임 경로·로컬 플랜·힌트 **보기** | 힌트를 맵 에셋으로 저장 |

운용에서 보이는 충전소·웨이포인트는 현장 모드가 심어 둔 **읽기 전용 표적**이다. 클릭은 명령 타깃이지 에셋 편집이 아니다.

### 1.2 현장 배치

지금 시뮬이 이미 이해하는 **장면 언어**. 테스트 맵을 빨리 채운다.

| 속함 | 하지 않음 |
|------|-----------|
| 웨이포인트 (점 + θ) | Move / Dock / Cancel |
| 충전소 (점 + θ) | node–edge 그래프, `edge.corridor` 리본 |
| 동적 장애물 (△/□/○) | TrafficZone `corridor` / `complex` |
| 존: `forbidden` / `prefer` / `avoid` | VDA 원형 타입 (`SPEED_LIMIT`, `DIRECTED`, `ACTION`, …) |
| 선택·스냅·거리 측정 | LIF station 승격, `interactionNodeIds` |

현장 존 세 종류는 운영자 언어 그대로다 (`01_types.md`). compile 하면 VDA `BLOCKED` / `PRIORITY` / `PENALTY` 가 되지만, **이 모드의 정체성은 VDA가 아니다.** 테스트 장면의 금지·선호·비선호일 뿐이다.

### 1.3 VDA 배치

VDA 5050 v3 order / `zoneSet` 과 LIF 레이아웃의 **원천**을 그린다. 가상 로봇이 아직 VDA를 말하지 않아도, 맵에 그 객체가 있어야 나중에 어댑터가 컴파일할 수 있다.

| 속함 | 하지 않음 |
|------|-----------|
| 그래프 노드·엣지·궤적·`edge.corridor` | Move / Dock |
| LIF 스테이션 (충전·픽/드롭·대기) 및 인터랙션 노드 연결 | 동적 장애물 |
| 사용자 존 전체 (`corridor`, `complex` 포함) + VDA 원형 존 | occupancy 페인트 |
| 포탈·레일 | 런타임 `released` / 힌트 저장 |
| `vehicleTypeId` 필터 (LIF, 로봇에 안 보냄) | MQTT 배포 |

현장의 충전소·웨이포인트와 VDA 스테이션·노드는 **같은 SQLite 행을 다른 편집 면으로 보는 것**이 기본이다. 두 벌로 저장하지 않는다. 승격(북마크 → `GraphNode`, 충전소 → `Station` + `startCharging` 액션)은 VDA 모드 인스펙터에서만 한다.

### 1.4 절대 섞지 말 것

| 금지 | 이유 |
|------|------|
| 운용 팔레트에 배치 도구 | 지금 툴바의 실패 모드. 실수로 맵을 바꿈 |
| 배치 모드에서 로봇 명령 | 에셋을 클릭했는데 로봇이 출발함 |
| 현장 모드에 `TrafficZone.corridor` 와 `edge.corridor` 를 나란히 | 같은 한글 “회랑/복도”. §3 |
| 현장 모드에 그래프 노드 | 웨이포인트와 점이 겹쳐 보임. 무엇이 order 원천인지 모호 |
| VDA 모드에 동적 장애물 | 장애물은 맵 정책이 아님 (`04_map_editor.md` §1) |
| 세 모드 공유 “그리기 브러시” 하나 | occupancy · 존 · 엣지 리본이 한 도구로 합쳐짐 |
| Colyseus 패치를 SQLite 없이 맵 에셋의 정본으로 | 새로고침하면 장면이 사라지거나, 반대로 세션 노이즈가 파일에 남음 |

모드 전환 시 **선택 중인 편집 도구는 리셋**한다. 레이어 가시성과 선택 객체는 유지해도 된다. 운용이 아닌 모드에서는 로봇 클릭이 명령을 시작하지 않는다.

---

## 2. 리소스 카탈로그

세 집합은 저장 위치가 다르다. UI 팔레트도 이 경계를 따른다.

### 2.1 장면 리소스 (현장 배치) — SQLite 에 맵 에셋으로 저장

동적 장애물만 예외: **런타임** (§2.3). 팔레트는 현장에 두되 디스크의 맵 파일에는 넣지 않는다.

| 리소스 | 기하 | 편집 | 시뮬 의미 | VDA/LIF 로 나갈 때 |
|--------|------|------|-----------|---------------------|
| **웨이포인트** | 점 + θ | 놓기·이동·회전·id | 사람이 누를 목표. Dock 아님 | 승격 시 `GraphNode` (액션 없는 경유). 미승격이면 UI 북마크만 |
| **충전소** | 점 + θ | 동일. θ = 도킹 진입 | `commandRobot dock` 타깃 | 승격 시 `Station.kind=charger` + 인터랙션 노드 `startCharging` |
| **forbidden** | 단순 폴리곤 | 정점 편집. 벽에 스냅 | 계획 occupancy lethal. 벽과 같음 | `zoneSet` `BLOCKED` |
| **prefer** | 단순 폴리곤 | 정점, `cost_scale` < 1 | A* 비용 ↓. 강제 추종 아님 | `PRIORITY` + `priorityFactor` |
| **avoid** | 단순 폴리곤 | 정점, `cost_scale` > 1 | A* 비용 ↑. 막지는 않음 | `PENALTY` + `penaltyFactor` |
| **동적 장애물** | △/□/○, size, θ(원 제외) | 놓기·이동·크기·회전·삭제 | 일시 물체. gRPC `place_query` | **안 나감.** zoneSet 아님 |

현장 존 겹침은 기존 배치 규칙: `forbidden` > (corridor/complex는 현장에 없음) > `avoid` / `prefer`. `avoid` ∩ `prefer` 는 경고, 해석이 필요하면 avoid 우선.

### 2.2 VDA·LIF 리소스 (VDA 배치) — SQLite `SemanticMap`

맵에 **사람이 그려야** 플릿이 런타임에 발명하지 않는 것. VDA 5050 v3 + LIF(VDMA 2024-03) 기준 **전부**. 내부 단위는 px, compile 때만 m · CCW.

루트는 기존 스케치와 같다: `mapId`, `mapVersion`, `frame`, `occupancyRef`, `zones[]`, `nodes[]`, `edges[]`, `stations[]`. 활성 `zoneSetId` 는 배포 식별자이지 도형이 아니다.

#### 2.2.1 맵 메타 (도형 아님, 들고 있어야 함)

| 필드 | 역할 |
|------|------|
| `mapId` / `mapVersion` | order 노드 · zoneSet · (장래) `enableMap` 일치 |
| `frame.pixelCm` = 5, `origin`, `yDown` | compile 축. 존 정점을 두 번 뒤집지 않음 |
| `occupancyRef` + 기하 해시 | 존이 옛 바닥에 남는 것을 방지 |
| 활성 `zoneSetId` | 내용이 바뀌면 **새 id**. 맵 버전과 1:1 강제 아님 |

기하 파일 자체(PNG/bin)는 VDA JSON이 아니다. 에디터는 링크·버전만 관리한다. **픽셀을 그리지 않는다.**

#### 2.2.2 라우팅 그래프 (VDA `order` 원천, LIF `layout.nodes/edges`)

자유주행이어도 목적·경유는 노드다. 엣지는 논리 연결이다.

| 리소스 | 맵에 그리는 법 | 저장 필드 (요지) |
|--------|----------------|------------------|
| **GraphNode** | 점 + θ | `nodeId`, `x,y,theta`, `mapId`, `allowedDeviationXY/Theta`, `actions[]` |
| **GraphEdge** | 두 노드를 잇는 단방향 호. 양방향 = 엣지 둘 또는 `BIDIRECTED` 존 | `edgeId`, `startNodeId`, `endNodeId`, `maximumSpeed`, `length`, `orientation` / `orientationType` (`GLOBAL` \| `TANGENTIAL`), `actions[]`, `vehicleTypeIds[]` |
| **edge.trajectory** | 엣지 위 **폴리라인** (내부). 내보내기 때만 NURBS | `degree` 기본 1에 해당하는 제어점. knot 는 시간 아님 |
| **edge.corridor** | 폴리곤이 **아님**. 궤적(없으면 현) 기준 좌 `leftWidth` / 우 `rightWidth` **리본** | `corridorReferencePoint`: `KINEMATIC_CENTER` \| `CONTOUR`; `releaseRequired`; `releaseLossBehavior`: `STOP` \| `RETURN`. 폭 둘 다 0 또는 생략 = 이탈 금지 |

노드 기본 액션 템플릿(맵 객체 아님, 인스펙터): `startCharging`, `pick`, `drop`, `finePositioning` 등. 스테이션 목적은 LIF가 말하듯 **노드 액션**으로 구분한다.

LIF `vehicleTypeIds`: 이 엣지/노드를 쓸 차급. **로봇에게 보내지 않음.** 플릿이 order에 넣지 않는 필터. 차급 목록은 참조 테이블(도형 아님).

전 흰 칸에 노드를 깔지 않는다. 스테이션·게이트·교차·라인 구간에만 둔다.

#### 2.2.3 스테이션 (LIF `layout.stations`)

| kind | 기하 | 필수 연결 |
|------|------|-----------|
| `charger` | 점 + θ | `interactionNodeIds[]` (보통 1). 노드에 `startCharging` |
| `pick_drop` | 점 + θ | 노드에 `pick` / `drop` |
| `wait` | 점 + θ | 대기 노드. 액션 없을 수 있음 |
| `other` | 점 + θ | 현장 특수. 액션은 인스펙터 |

현장 **충전소**와 `kind=charger` 는 동일 레코드다. VDA 모드에서만 인터랙션 노드를 묶는다. 웨이포인트는 반드시 스테이션이 아니다.

#### 2.2.4 시맨틱 존 (VDA `zoneSet.zones[]`) — LIF 에는 존이 없음

존은 맵당 활성 셋 하나. 정점 ≥ 3, 단순 폴리곤, 저장 시 반시계, 맵 밖 금지. 컨투어 기준 타입이 있고 기구학 중심 타입이 있다 (`01_protocol.md` §7).

에디터 **kind**(운영자 언어)와 VDA `zoneType` 을 같이 적는다. 한 존이 compile 시 존셋 객체 하나 이상이 될 수 있다.

| kind (우리) | 맵 기하 | 필수·선택 필드 | compile (권장) |
|-------------|---------|----------------|----------------|
| `forbidden` | 폴리곤 | (없음) | `BLOCKED` |
| `corridor` | 폴리곤 + **포탈** + (선택) **레일** | `capacity` 1\|2, `portals[]`, `rails[]` | 레일 없음 → `RELEASE`. 레일 있음 → `LINE_GUIDED` + 그래프 엣지 trajectory. 입구에 `RELEASE` 추가 가능 |
| `complex` | 폴리곤 + 포탈. 레일 없음이 기본 | `capacity`(기본 1), `releaseLossBehavior`: `STOP` \| `CONTINUE` \| `EVACUATE` | `RELEASE`. capacity 는 VDA 필드 없음 → 플릿 뮤텍스 |
| `prefer` | 폴리곤 | `cost_scale` < 1 또는 `priorityFactor` 0..1 | `PRIORITY` |
| `avoid` | 폴리곤 | `cost_scale` > 1 또는 `penaltyFactor` 0..1 | `PENALTY` |
| `speed_limit` | 폴리곤 | `maximumSpeed` m/s | `SPEED_LIMIT` |
| `directed` | 폴리곤 + 방향 화살 | `direction` rad, `SOFT` \| `RESTRICTED` \| `STRICT`, 단방향 vs 양방향 | `DIRECTED` 또는 `BIDIRECTED` |
| `replanning` | 폴리곤 | (없음) | `COORDINATED_REPLANNING` |
| `action` | 폴리곤 | 진입/통과/이탈 `actions[]` | `ACTION`. 스테이션 액션으로 먼저 풀 수 있음 (구현 후순위) |

VDA 원형 타입을 에디터에 **직접** 둘 수도 있다. 그때도 기하 규칙은 같다. `DIRECTED` ∩ `BIDIRECTED` 겹침은 스펙 금지.

존 하위 기하 (별도 팔레트 항목, 부모 존에 종속):

| 하위 | 그리는 법 | 누구 것인가 |
|------|-----------|-------------|
| **Portal** | corridor/complex 경계 위 선분. 대기 pose 선택 | 플릿만. 로봇 zoneSet 에는 폴리곤만. 토큰은 포탈 앞에서 |
| **Rail** | 존 **안** 폴리라인. 용량 2면 레일 2 강제 | 플릿. VDA로는 edge trajectory / `LINE_GUIDED`. 전 맵 레일 금지 |

플릿만 알고 로봇 zoneSet에 안 넣는 필드: `capacity`, `portals`, `rails`.

#### 2.2.5 이 카탈로그에 없는 VDA 필드 (그리지 않음)

order `released`, `orderId` / `sequenceId`, `headerId`, factsheet, `instantActions`, `state` 경로, `visualization`, `zoneRequests` / `edgeRequests` / `responses`, `downloadMap` 파일 바이트.

### 2.3 런타임 전용 — 맵 에셋으로 저장하지 않음

Colyseus(및 gRPC) 세션에만 산다. 새로고침·룸 재생성 후 사라져도 맵이 깨지지 않아야 한다.

| 객체 | 이유 |
|------|------|
| 로봇 pose, status, 스프라이트 | 시뮬 생명체. spawn 초기값만 별도 시뮬 테이블에 둘 수 있음 (SemanticMap 아님) |
| 계획 경로 / 로컬 플랜 / `intermediatePath` / `plannedPath` | 로봇이 올리는 관측 |
| 동적 장애물 | 일시 물체. 맵 정책 아님 |
| v2 FMS 힌트 폴리라인 | 분쟁 중 일시 prefer. 사용자 에셋 아님 |
| v0 회랑 캡슐·임대 | 주행 중 권한. 맵에 저장 금지 (`04` §7) |
| order `released` base/horizon | 런타임 교통 |
| `zoneRequest` / `edgeRequest` / lease | 허가 대화 |
| 브라우저 선택·고스트·측정 고무줄 | UI 상태 |

장애물을 테스트 시나리오로 남기고 싶으면 **세션 덤프**(별 파일)이지 occupancy·SemanticMap 이 아니다. 이번 스프린트 비목표.

---

## 3. 회랑이 두 종류인 문제

스펙과 우리 문서가 둘 다 `corridor` 를 쓴다. **객체가 다르다.** 한 브러시로 합치지 않는다 (`04_map_editor.md` §2).

| | **TrafficZone `corridor`** | **VDA `edge.corridor`** |
|--|---------------------------|-------------------------|
| 무엇 | 사용자가 칠한 **영역** + 용량 + (선택) 레일 | 그래프 **엣지**에 붙는 좌/우 폭 |
| 그리는 법 | 폴리곤, 포탈, optional polyline rail | 엣지 선택 후 리본. 폴리곤 도구 아님 |
| 누구를 위해 | 자유주행 운영 규칙 (한 대씩, 또는 2레일 교행) | 라인 가이드가 궤적에서 얼마나 벗어날 수 있나 |
| 송신 | `zoneSet` (`RELEASE` 또는 `LINE_GUIDED`) | order `edge.corridor` |
| 문서 | `user_defined_traffic_zone/01_types.md` | `vda5050/02_data.md` §2.4 |

모드가 혼동을 막는 방법:

1. **현장 배치**에는 TrafficZone `corridor` 를 두지 않는다. 현장의 통로 언어는 `prefer` / `avoid` / `forbidden` 뿐이다. “복도에 비용만 주고 싶다”는 현장, “복도를 용량 게이트로 선언한다”는 VDA.
2. **VDA 배치** 팔레트를 두 칸으로 가른다. **존** 칸에 TrafficZone `corridor`(폴리곤). **그래프** 칸에 엣지 속성 `corridor`(리본). 선택 하이라이트 색을 나눈다.
3. 이름: UI 라벨은 `복도 존` vs `엣지 이탈 폭`. 내부 id 만 `corridor` 를 공유해도 된다.
4. 겹쳐 보여도 다른 객체다. 복도 존 폴리곤 위에 리본이 올라가는 것은 정상(라인 강제 시). 하나를 지우면 다른 하나가 따라 지워지지 않는다. 레일을 엣지 trajectory 로 compile 하는 것은 배포 단계다. 편집 중에 두 객체를 하나로 합치지 않는다.

자유주행 시뮬만 있는 동안은 복도 존만 있으면 장면이 성립한다. 리본은 그래프가 생긴 뒤, 라인 가이드를 가정할 때 의미가 있다. 그래도 팔레트에서 리본을 숨기지 말고 **비활성·설명**으로 둔다. 숨기면 다시 한 도구로 합치게 된다.

---

## 4. 맵 토폴로지

스케일: **1 px = 5 cm** (기존과 동일). 로봇 바디 **16 × 10 px = 0.80 × 0.50 m**. inflate 반경 **8 px**. `TRAFFIC_SEP` = 24 px (로컬 플랜 겹침). 스프라이트는 맵 픽셀 1:1.

목표는 “단순한 큰 바닥 + 좁은 복도 하나 + 교차 하나”이고, 이후 로봇을 더 넣어도 홀이 포화하지 않게 한다. 현행 720×560 (36 m × 28 m) 은 홀·복도·여유 스폰을 동시에 못 담는다.

### 4.1 캔버스

| | 값 | 실측 |
|--|-----|------|
| 이미지 / occupancy | **1600 × 960 px** | **80.0 m × 48.0 m** |
| 외벽 두께 | 24 px | 1.20 m |
| 내부 유효 | 1552 × 912 px | 77.6 m × 45.6 m |

면적은 현행의 약 3.8배. 브라우저 1:1 도 가능하고, contain 스케일도 가능하다. 더 키우면 occupancy 그리드·A* 만 커지고 토폴로지 이득은 적다.

### 4.2 폭 결정 (복도 vs 로봇)

한 대가 길이 방향으로 복도를 지날 때 필요한 자유폭 하한은 대략 **몸 폭 10 px + 양쪽 inflate 8+8**. 여유를 더해 **32 px = 1.60 m** 을 협폭 복도로 둔다.

| 질문 | 32 px 복도 | 근거 |
|------|------------|------|
| 1대 통과 | 가능 | 계획 자유폭 ≈ 32−16 = 16 px. 중심선 주행 |
| 2대 교행 | 불가 (의도) | 몸 둘 10+10, `TRAFFIC_SEP` 24 → 나란히 서려면 ~44 px 급. 32 px 는 capacity-1 테스트 |
| 제자리 회전 | 복도 안에서는 빡빡 | 교차부는 별도 확폭 |

교차 상자 **48 × 48 px = 2.40 m**: 외접원 지름 ≈ 19 px 인 로봇이 한 대는 돈다. 두 대가 교차에 같이 들어가면 `complex` 용량 1 로 막는다. 기하가 아니라 정책이 병목이게 하려는 크기이다.

홀은 교행이 기하적으로 되는 폭이다. `prefer` / `avoid` 를 칠할 여백이 있다.

### 4.3 평면 (T자 교차 1개)

자유공간(흰 픽셀)만 적는다. 좌표는 이미지 원점, x 오른쪽+, y 아래+.

```
외곽 1600×960, 벽 24px

[대형 홀]  (48, 48) – (1104, 912)     1056×864 px  = 52.8 m × 43.2 m
           테스트의 본체. 스폰·충전 열·prefer/avoid·다수 로봇

           홀 동벽 개구: 중심 y ≈ 480, 높이 = 복도 폭 32px

[협폭 복도] (1104, 464) – (1472, 496)  368×32 px   = 18.4 m × 1.60 m
           우회 없음. A* 실패를 기다리지 말고 사용자가 corridor 존을 선언하는 자리

[T 교차]    복도 중간 x ∈ [1272, 1320], 상자 48×48
           수평 복도가 상자를 관통. 남쪽으로만 가지

[남쪽 가지] (1280, 512) – (1312, 672)  32×160 px   = 1.60 m × 8.0 m

[포켓 룸]   (1200, 672) – (1392, 912)  192×240 px  = 9.6 m × 12.0 m
           픽/드롭·대기 스테이션. 교차 `complex` 의 목적지
```

교차 타입은 **T (ㅗ를 시계 반대 또는 남쪽 가지 T)** 로 고정한다. +자 4방향은 노드·엣지가 늘고, “교차 하나” 테스트에 비해 이득이 없다. 홀↔복도 입구가 사실상 두 번째 게이트이므로, 그래프를 심을 때는 최소 노드를 이렇게 둔다.

| 노드 후보 (VDA 모드, 전 칸 도배 금지) | 역할 |
|----------------------------------------|------|
| 홀 내부 임의 골 (임시 노드로도 됨) | 자유주행 goal |
| 홀–복도 포탈 | 복도 존 ACCESS 앞 |
| T 상자 중심 | 교차 게이트 |
| 포켓 룸 | 스테이션 인터랙션 |

현장 시드 스케치: 충전소는 홀 **서·남 벽**에 열, 웨이포인트는 홀 중앙·복도 입구·포켓. 로봇 spawn 은 홀 서쪽. 복도와 교차에는 시드 로봇을 두지 않는다.

### 4.4 occupancy 생성

바닥 PNG 를 그리고 `generate_occupancy` 가 bin 을 만든다. 에디터는 흰/벽을 브러시로 고치지 않는다. 복도 폭을 바꾸고 싶으면 **PNG 를 교체**한 뒤 occupancy 를 재생성한다. 존 폴리곤은 새 해시에 묶인다.

---

## 5. 영속화 — SQLite 를 쓴다

후보는 SQLite 와 DuckDB 였다. 사용자 기울기는 DuckDB. **이 제품의 쓰기 패턴과 bun 런타임에는 SQLite가 맞다.** DuckDB 는 정본으로 채택하지 않는다.

### 5.1 결정

**저장소: SQLite, 드라이버: `bun:sqlite`, 파일 하나, WAL.**

맵 에셋 CRUD 는 OLTP 다. 폴리곤 정점 하나, 노드 θ, 스테이션 승격이 잦다. 행 수는 존·노드·엣지를 다 넣어도 수천이다. 분석용 컬럼나르·Parquet 가 필요한 규모가 아니다.

### 5.2 bun 과 맞물리는 이유

| | `bun:sqlite` | DuckDB (npm `duckdb` 등) |
|--|--------------|---------------------------|
| 런타임 | bun 내장. 네이티브 애드온 협상 없음 | Node N-API 애드온. bun 호환이 부가 조건 |
| API | 동기, 트랜잭션, 자리표시자. 서버 틱과 잘 맞음 | OLAP 세션. 단건 UPDATE 가 설계 중심이 아님 |
| 의존 | 패키지 0 | 바이너리·spatial 확장 버전 고정 |
| 동시성 | WAL 로 웹 프로세스 읽기 + 룸 쓰기 | 임베디드 쓰기 락 모델이 다름 |
| 공간 질의 | 이번 검사는 **프로세스 안** 폴리곤 알고리즘 | `ST_Intersects` 는 매력적이나 저장 직후 검증을 SQL 에 맡길 이유가 없음 |

겹침·단순성·CCW·포탈 위치는 저장 직전 인메모리 검사다 (`04` §4.4). DB 가 GIS 엔진일 필요가 없다.

### 5.3 DuckDB 를 쓰지 않는 이유 (기울기에 대한 답)

DuckDB 가 강한 지점은 **대량 스캔·집계·공간 조인·파일 레이크** 다. 테스트 FMS 의 병목은 그게 아니라 (1) 편집 한 건의 왕복, (2) bun 위에서 네이티브 모듈이 깨지지 않는 것, (3) git-ignore 된 파일 하나로 맵을 스냅샷하는 것이다.

장래에 존 겹침 히트맵·로그 분석을 붙이면 DuckDB 가 SQLite 파일을 **첨부해 읽거나** 내보내기를 받으면 된다. 그 때도 정본은 SQLite 다.

### 5.4 스키마 철 (구현 아님)

논리 테이블만 고정한다. 정규화 정도는 구현자가 정한다.

- `map_meta` — id, version, frame, occupancy 경로·해시, 활성 zoneSetId
- `waypoints` / `stations` — 현장·VDA 가 공유. `promoted_node_id` 등
- `zones`, `zone_vertices`, `portals`, `rails`
- `nodes`, `node_actions`, `edges`, `edge_trajectory_points`, `edge_corridor`
- `vehicle_types` — LIF 필터 참조
- `sim_spawns` — 로봇 초기 pose. SemanticMap 이 아님

동적 장애물은 테이블에 넣지 않는다.

저장 ≠ 로봇 배포. 저장은 SQLite 커밋 + Colyseus 투영 갱신이다. VDA `zoneSet` 바이트를 이 스프린트에 만들지 않는다.

---

## 6. 진실의 원천

세 층이 한 파일을 나눠 가지면 안 된다.

```
floor PNG  ──generate──►  occupancy.bin     기하 SoT (갈 수 있는 픽셀)
                          occupancy_inflated.bin   계획용 파생. 정본 아님

SQLite SemanticMap  ──hydrate──►  Colyseus FloorState
        ▲ 맵 에셋 SoT                 │ 세션 투영 + 런타임
        └──── 현장/VDA 저장 ──────────┘

gRPC Session  ◄──►  virtual-robot pose/path/command
        │
        └─► Colyseus robots[]  (브라우저 표시)
```

| 질문 | 정본 | 정본이 아닌 것 |
|------|------|----------------|
| 이 픽셀이 벽인가 | occupancy.bin (PNG 파생) | Colyseus, SQLite 존 |
| 이 폴리곤이 금지인가 | SQLite `zones` | 캔버스 오버레이, 룸 패치 |
| 노드 좌표·엣지 리본 | SQLite | order JSON (아직 없음), LIF 파일 (비목표) |
| 충전소 pose | SQLite `stations` | 시드 JSON 은 이전 세대. 마이그레이션 후 폐기 가능 |
| 로봇이 어디인가 | gRPC 가 올린 pose → Colyseus | SQLite |
| 장애물이 어디인가 | Colyseus `obstacles` | 맵 DB |
| 계획 경로 | 로봇 → Colyseus | 어디에도 persist 하지 않음 |

규칙:

1. 현장/VDA 편집의 성공 커밋은 **SQLite 먼저**, 그다음 룸 스키마. 룸만 바뀌고 DB 가 안 바뀌면 새로고침에 롤백되는 것이 맞다.
2. occupancy 를 SQLite blob 으로 넣지 않는다. 경로와 해시만. 큰 그리드는 bin 이 맞고, 에디터가 그리지 않는다.
3. Colyseus 스키마는 브라우저 동기화용이다. 존·그래프가 커지면 스키마에 전부를 복제하지 말고, **표시용 요약 + 정적 fetch**(SQLite → JSON) 를 나눌 수 있다. 지금 규모(홀+복도+교차)는 복제해도 된다. 정본 지위는 스키마에 주지 않는다.
4. `seed.json` 은 부트스트랩 입력일 수 있다. 한 번 SQLite 로 들어가면 정본이 이동한다.

---

## 7. 이번 스프린트 비목표

하지 않는다. 설계에 이름이 나와도 구현하지 말라는 뜻이다.

- **MQTT** 브로커, VDA 토픽 (`order`, `zoneSet`, `state`, …)
- **실기 VDA 로봇** 및 factsheet 어댑터. 가상 로봇은 지금처럼 gRPC
- **occupancy 페인트** (브러시로 바닥을 고침). 파이프가 있다
- LIF 파일 가져오기/보내기
- `downloadMap` / `enableMap` / 다중 `mapId` 층
- `ACTION` 존 편집의 완성도 (카탈로그에는 올려 둠)
- 궤적 NURBS 내보내기 (내부 폴리라인만)
- 런타임 힌트·임대 캡슐을 맵에 저장
- 복도 자동 추출
- 동적 장애물 시나리오 파일
- DuckDB 도입

P0 에 해당하는 것(다음 구현 스프린트가 받아도 되는 범위): 세 모드 IA, 대형 T맵 occupancy, 현장 리소스 + forbidden/prefer/avoid, SQLite 저장, Colyseus 투영, 기존 Move/Dock/gRPC.

VDA 그래프·복도 존·엣지 리본은 카탈로그와 모드 칸이 **열려 있어야** 하고, 그래프 편집 자체는 P1 로 미뤄도 된다. 다만 현장 모드에 복도 존을 몰래 넣지 않는다.

---

## 합의 요청

슈퍼바이저가 수락/거절할 항목.

- 작업 모드는 **운용 / 현장 배치 / VDA 배치** 세 개뿐. 로봇 명령과 배치 팔레트는 공존하지 않음.
- 현장 리소스 = 웨이포인트, 충전소, 동적 장애물, `forbidden` / `prefer` / `avoid`. TrafficZone `corridor`/`complex` 는 현장에 넣지 않음.
- VDA 모드 카탈로그는 §2.2 를 닫힌 목록으로 봄 (노드·엣지·리본·스테이션·존 전부 + 포탈/레일). `action` 존은 목록에만 있고 이 스프린트 비목표.
- 두 corridor 는 라벨 `복도 존` vs `엣지 이탈 폭` 으로 분리. 현장에는 둘 다 없음.
- 맵 **1600×960 px**, 홀 1056×864, 복도 **32 px**, T교차 **48×48**, 남쪽 포켓. 1 px = 5 cm.
- 교차는 **T자 하나**. +자 4방향은 이번 맵에 없음.
- 영속화는 **`bun:sqlite`**. DuckDB 는 정본이 아님.
- 기하 정본 = occupancy bin, 에셋 정본 = SQLite, 세션 정본 = Colyseus(+gRPC). 장애물·경로는 SQLite 에 안 넣음.
- MQTT / 실기 VDA / occupancy 페인트 / LIF I/O 는 비목표. 통신은 Colyseus + gRPC 유지.
- 충전소·웨이포인트는 현장/VDA 가 **같은 행**을 봄. 이중 저장 없음.
