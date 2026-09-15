# 맵 에디터 — 시맨틱 리소스

**구현하지 않는다.** VDA 5050 V3.0.0 FMS가 occupancy 위에 무엇을 사람이 그려야 하는가.

리소스 필드·VDA 매핑은 [`05_semantic_resources.md`](./05_semantic_resources.md).
존 운영 문법(우리 카탈로그)은 [`../../user_defined_traffic_zone/`](../../user_defined_traffic_zone/README.md).

---

## 한 줄

> VDA 로봇은 occupancy PNG를 읽지 않는다. 읽는 것은 **order의 node–edge**, **edge.corridor**, **zoneSet 폴리곤**, **station(액션 점)** 이다.
> 맵 에디터의 본체는 바닥을 칠하는 페인터가 아니라 **시맨틱 리소스 에디터**다.

지금 bg_fms 웹은 웨이포인트·충전소·동적 장애물만 둔다. 그걸로 A→B 시뮬은 되지만, VDA 플릿·사용자 트래픽 존은 성립하지 않는다.

---

## 1. occupancy 와 시맨틱은 다른 레이어

VDA/VDMA가 가정하는 입력은 세 갈래다.

| 레이어 | 누가 만드나 | VDA가 실어 나르는가 | 에디터 |
|--------|-------------|---------------------|--------|
| **기하 맵** (occupancy / SLAM) | 센서·이미지 파이프 | `downloadMap` 링크로 로봇 내비에 배포. MQTT JSON이 아님 | 가져오기·정렬·버전. **픽셀을 그리지 않음** |
| **라우팅 그래프** (node, edge, trajectory, corridor 폭) | 운영/통합사. LIF로 교환 가능 | order에 조각만. 전체 그래프는 플릿이 보유 | 그래프 툴 |
| **시맨틱 존** (`zoneSet`) | 운영 | `zoneSet` 토픽 + `enableZoneSet` | 폴리곤 툴 |
| **스테이션** (충전·픽/드롭) | 운영. LIF `station` | 노드 액션으로만 전달 | 점 툴 (이미 충전소와 닮음) |

에디터가 **그리지 않는 것**

- `intermediatePath` / `plannedPath` — 로봇이 state로 올림
- `released` base/horizon — 런타임 교통
- v2 FMS 힌트 폴리라인 — 분쟁 중 일시 레이어 ([`../04_fms_hints.md`](../04_fms_hints.md))
- 동적 장애물 — 이미 별도 툴. 맵 정책이 아님

---

## 2. 회랑이 두 종류다 (같은 이름, 다른 도구)

스펙·우리 문서 모두 `corridor` 를 쓰지만 **객체가 다르다.** 에디터에서 한 브러시로 합치지 않는다.

| | **TrafficZone `corridor`** | **VDA `edge.corridor`** |
|--|---------------------------|-------------------------|
| 무엇 | 사용자가 칠한 **영역** + 용량 + (선택) 레일 | 그래프 **엣지**에 붙는 좌/우 폭 |
| 그리는 법 | 폴리곤, 포탈, optional polyline rail | 엣지 선택 후 `leftWidth` / `rightWidth` 리본 |
| 누구를 위해 | 자유주행·운영 규칙 (한 대씩, 또는 2레일 교행) | 라인 가이드가 궤적에서 얼마나 벗어날 수 있나 |
| VDA 송신 | `zoneSet` (`RELEASE` 또는 `LINE_GUIDED`) | order `edge.corridor` |
| 우리 문서 | [`user_defined_traffic_zone`](../../user_defined_traffic_zone/01_types.md) | [`02_data.md`](./02_data.md) §2.4 |

전자가 **시맨틱 리소스**. 후자는 **그래프 속성**.
자유주행만 있는 시뮬 단계에서는 전자만 있으면 된다. 실기 라인 가이드를 붙일 때 후자가 생긴다.

폭 0으로 두는 것은 “회랑 없음”이다. 스펙도 그렇게 쓰라고 한다.

---

## 3. 에디터가 필요한 이유 (프로토콜 쪽)

플릿이 런타임에 발명하면 안 되는 것들.

- **node / edge** — 주문은 이 그래프의 부분 경로. 없으면 자유주행도 goal을 가짜 노드 하나로 때워야 한다 ([`03_bg_fms_interface.md`](./03_bg_fms_interface.md) §3.2).
- **edge.trajectory + corridor** — 라인 가이드·`LINE_GUIDED` 존의 기준 궤적과 이탈 띠. 로봇이 올리는 게 아님.
- **zone 폴리곤** — 맵당 활성 `zoneSet` 하나. 정점 ≥ 3, **단순 폴리곤**, **반시계**, 맵 밖으로 나가면 안 됨 (스펙 §7.6).
- **station ↔ node** — 충전·pick/drop 은 스테이션이 아니라, 스테이션에 묶인 **인터랙션 노드 + 액션**.
- **mapId / mapVersion** — 노드 위치·존셋이 어느 층인지. 로봇 `downloadMap` / `enableMap` 과 같아야 함.
- **vehicleType 제한** — LIF. “이 엣지는 이 차급만”. 로봇에게는 안 보내고, 플릿이 order에 넣지 않음.

LIF(VDMA 2024-03)는 **그래프+스테이션 교환 파일**이지 MQTT 토픽이 아니다.
에디터는 LIF를 **가져오기/내보내기** 할 수 있으면 되고, 런타임 진실은 우리 `SemanticMap` 이다.

---

## 4. 기능 목록 (시맨틱 리소스 모드)

현재 툴바(Select / Waypoint / Charger / Move / Dock / Obstacle / Grid)에 **레이어를 얹는다.** 별도 앱이 아니다.

### 4.1 레이어 토글

| 레이어 | 기본 | 보는 것 |
|--------|------|---------|
| floor image | on | `1st_floor.png` |
| occupancy / inflated | 기존 Grid | free / 못 가는 여유 |
| **zones** | on | 타입별 색. 겹치면 해치 |
| **portals** | zone 선택 시 | corridor/complex 입구 세그먼트 |
| **rails** | zone 선택 시 | 추종 폴리라인 |
| **graph** | off (P1) | node 점, edge, trajectory |
| **edge corridor ribbon** | graph on 일 때 | 궤적 ± left/right |
| **stations** | on | 충전소·픽드롭. 기존 charger와 동일 계열 |
| runtime | 항상 | 로봇, 로컬 플랜, 동적 장애물, FMS 힌트. **편집 불가** |

### 4.2 도구 (P0 — 존)

| 도구 | 하는 일 |
|------|---------|
| Zone polygon | 클릭으로 정점. 닫으면 단순 폴리곤 검사. 시계방향이면 저장 시 반시계로 뒤집음 |
| Zone kind | `forbidden` `corridor` `complex` `avoid` `prefer` (+ 고급: VDA 원형 타입) |
| Portal | corridor/complex 경계 위 선분. 자동 제안(자유공간과 맞닿는 변) + 수동 수정 |
| Rail | corridor 안 폴리라인. 용량 2면 레일 2개 강제 |
| Inspector | id, name, kind별 파라미터 ([`05`](./05_semantic_resources.md)) |
| Snap | occupancy free / 벽. forbidden은 벽에 붙이기 |
| Measure | 두 점 거리(m). 복도 폭 vs `TRAFFIC_SEP`·로봇 풋프린트 |

기존 Obstacle 과 구분: 장애물은 일시 물체, forbidden은 **맵 정책**.

### 4.3 도구 (P1 — 그래프, VDA order/LIF)

| 도구 | 하는 일 |
|------|---------|
| Place node | pose (x,y,θ), `nodeId`, `mapId`, 통과 허용 편차, 기본 액션 |
| Connect edge | 두 노드. 단방향이 기본(LIF). 양방향은 엣지 두 개 또는 `BIDIRECTED` 존 |
| Trajectory | 엣지 위 폴리라인 (내부). 내보낼 때만 NURBS |
| Edge corridor | 선택 엣지의 left/right m, referencePoint, `releaseRequired` |
| Station | 기존 charger/waypoint를 station으로 승격. `interactionNodeIds` 연결 |
| Vehicle filter | 이 엣지/노드를 쓸 수 있는 `vehicleTypeId` (LIF). UI에 “이 차급만 표시” |

자유주행만이면 그래프는 **스테이션·골 노드만** 있어도 된다. 복도를 레일로 강제할 때 엣지+trajectory+`LINE_GUIDED` 존이 따라온다.

### 4.4 검사 (저장·배포 전)

- 존: 정점 ≥ 3, self-intersection 없음, CCW, `mapId` 경계 안.
- `DIRECTED` ∩ `BIDIRECTED` 겹침 금지 (스펙).
- `forbidden` ∩ 다른 존 → 경고 후 forbidden 승 (우리 배치 규칙과 동일).
- `avoid` ∩ `prefer` → 경고.
- corridor 용량 2 인데 rail < 2 → 저장 거부.
- 포탈이 존 한가운데만 있으면 거부 ([`02_placement.md`](../../user_defined_traffic_zone/02_placement.md)).
- 노드가 inflated occupancy 밖이면 거부.
- edge corridor 리본이 벽을 뚫으면 경고 (라인 가이드 풋프린트).
- `SPEED_LIMIT.maximumSpeed` 등 타입 필수 필드 누락 거부.

### 4.5 배포

에디터 저장 ≠ 로봇 배포.

```
SemanticMap (내부 JSON, px + m 병기)
    ├─ 시뮬 로봇: 존 레이어 브로드캐스트 (기존 장애물 스냅샷과 같은 채널이거나 별도)
    └─ VDA 실기: compile → zoneSet (m, CCW)
                  compile → order 조각에 쓸 그래프 (플릿 보유)
                  optional LIF export
```

존이 바뀌면 **새 `zoneSetId`**. 맵 기하가 바뀌면 `mapVersion`.
존셋은 맵 버전과 1:1일 필요 없다 (스펙: 같은 존셋을 여러 mapVersion에 쓸 수 있음).
맵당 로봇이 켜는 존셋은 **하나** (`enableZoneSet`).

좌표: 캔버스는 px (1 px = 5 cm). VDA/LIF 는 **미터**, 프로젝트 원점 동일.
원점·축(y-down vs 수학)은 `SemanticMap.frame` 한곳에만 둔다. 존 정점을 두 번 뒤집지 않는다.

---

## 5. 지금 UI에서 무엇이 부족한가

| 있음 | 시맨틱으로 부족한 점 |
|------|----------------------|
| Waypoint | 노드가 될 수 있음. `nodeId`·액션·편차 없음 |
| Charger | station + `startCharging` 액션 노드로 승격 가능. LIF `interactionNodeIds` 없음 |
| Obstacle | 런타임. zoneSet 아님 |
| Grid | occupancy 확인용. 존/그래프 없음 |
| 바닥 클릭 Move | 자유주행 goal. VDA로 나가면 **임시 노드 하나짜리 order** |

P0만 넣어도 v2 + 사용자 존 설계와 맞다.
P1은 VDA 어댑터·라인 가이드를 붙일 때.

---

## 6. 우선순위 (구현 시)

| 단계 | 범위 | 왜 |
|------|------|----|
| **P0** | 존 폴리곤, kind, 포탈, rail, 겹침 검사, 내부 브로드캐스트 | 운영자가 복도·금지를 선언. VDA `zoneSet`의 원천 |
| **P1** | node/edge, edge corridor 리본, station↔node, m 변환 | 이기종 order, LIF, `LINE_GUIDED` |
| **P2** | LIF import/export, mapId 다중 층, `downloadMap` 파이프, vehicleType 필터 | 현장 통합 |

가상 로봇 2대 단계에서는 P0 스키마만 확정하면 된다. MQTT `zoneSet` 송신은 어댑터와 같이.

---

## 7. 하지 말 것

- occupancy를 브러시로 고치기. 맵 파이프(`generate_occupancy`)가 있다.
- 런타임 회랑 캡슐(v0 I1)을 맵 에셋으로 저장하기. 그건 주행 중 임대.
- FMS가 복도 레일을 자동 추출해 저장하기. 오탐이 운영 규칙과 어긋난다. 사용자가 그린다.
- 모든 흰 바닥에 노드를 깔기. 자유공간은 v2. 그래프는 스테이션·게이트·라인 구간에만.
