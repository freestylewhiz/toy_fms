# 시맨틱 리소스 카탈로그

맵 에디터가 다루는 **저장 객체**. 구현 없음.
에디터 UX·레이어는 [`04_map_editor.md`](./04_map_editor.md).

내부 단위는 맵 픽셀이어도 된다. VDA/LIF로 나갈 때만 미터·반시계 폴리곤으로 compile 한다.

---

## 0. 루트

```
SemanticMap {
  mapId: string              // VDA nodePosition.mapId, zoneSet.mapId
  mapVersion: string         // downloadMap / enableMap
  frame: {
    pixelCm: 5,              // 지금 occupancy
    origin: { x_m, y_m },    // 프로젝트 원점
    yDown: true              // 캔버스. compile 때 뒤집거나 그대로 계약
  }
  occupancyRef: string       // occupancy.bin 경로. 에디터가 그리지 않음
  zones: TrafficZone[]
  nodes: GraphNode[]         // P1
  edges: GraphEdge[]         // P1
  stations: Station[]        // 충전소 승격. P0에서도 charger와 공존 가능
}
```

배포 시:

| 내부 | 시뮬 | VDA 3.0 | LIF |
|------|------|---------|-----|
| zones[] | 존 레이어 브로드캐스트 | `zoneSet.zones[]` | (LIF에 존 없음. 플릿 자산) |
| nodes/edges | 선택. 자유주행은 goal 노드만 | order 조각, 플릿 그래프 | `layout.nodes/edges` |
| stations | 기존 ChargingStation | 노드 `actions[]` | `layout.stations` |
| edge.corridor | 리본 표시 | `order.edge.corridor` | 엣지 속성과 동일 의미 |

런타임 전용(저장 안 함): 로봇 pose, local plan, 동적 장애물, v2 힌트, base `released`.

---

## 1. TrafficZone — P0 본체

[`user_defined_traffic_zone/01_types.md`](../../user_defined_traffic_zone/01_types.md) 와 같은 축.
에디터 kind는 **운영자 언어**이고, compile이 VDA `zoneType` 을 고른다.

```
TrafficZone {
  id, name
  kind: forbidden | corridor | complex | avoid | prefer
          | speed_limit | directed | replanning   // 고급, 우리 카탈로그 확장
  polygon: Point[]          // 닫힌 단순 폴리곤
  portals?: Segment[]       // corridor, complex
  // kind별 아래
}
```

### 1.1 kind → VDA zoneSet

한 존이 **존셋 객체 하나 이상**이 될 수 있다. (복도 = 영역 게이트 + 선택적 레일 강제)

| kind | 필수 필드 | compile (권장) |
|------|-----------|----------------|
| `forbidden` | | `BLOCKED` |
| `complex` | `capacity` (기본 1), `portals`, `releaseLossBehavior` | `RELEASE`. 용량은 플릿 카운터 (VDA에 capacity 필드 없음) |
| `corridor` 용량 1, rail 없음 | `capacity`, `portals` | `RELEASE` |
| `corridor` + rail | `rails[]`, 용량 1 또는 2 | `LINE_GUIDED` + 그래프 엣지 trajectory (± edge.corridor). 입구는 추가로 `RELEASE` 가능 |
| `prefer` | `cost_scale` < 1 또는 `priorityFactor` 0..1 | `PRIORITY` |
| `avoid` | `cost_scale` > 1 또는 `penaltyFactor` 0..1 | `PENALTY` |
| `speed_limit` | `maximumSpeed` m/s | `SPEED_LIMIT` |
| `directed` | `direction` rad, limitation | `DIRECTED` 또는 `BIDIRECTED` |
| `replanning` | | `COORDINATED_REPLANNING` |

`ACTION` 존(진입/통과/이탈 액션)은 P2. 스테이션 액션으로 먼저 푼다.

플릿만 아는 필드 (로봇 zoneSet에 안 넣음):

- `capacity` — VDA에 없음. `RELEASE` GRANTED 개수로 구현
- `portals` — 토큰 요청 위치. 로봇은 폴리곤만 받고, 들어가기 전 ACCESS
- `rails` — 추종 기하. VDA로는 edge trajectory (또는 LINE_GUIDED + 그래프)

### 1.2 에디터 인스펙터

| kind | UI 필드 |
|------|---------|
| 공통 | id, name, 정점 표, 면적, `mapId` |
| forbidden | (없음). occupancy lethal 미리보기 |
| corridor | capacity 1\|2, rails(폴리라인 편집), portals, 폭 측정값 |
| complex | capacity(기본 1), portals, `releaseLossBehavior`: STOP / CONTINUE / EVACUATE |
| avoid / prefer | factor 슬라이더. 내부 `cost_scale` ↔ VDA 0..1 식은 플릿이 정함 ([`03`](./03_bg_fms_interface.md) §7) |
| speed_limit | maximumSpeed |
| directed | 화살표 헤딩, SOFT / RESTRICTED / STRICT, 단방향 vs 양방향 |

### 1.3 포탈 · 레일

```
Portal { id, segment: [Point, Point], waitPose?: {x,y,theta} }
Rail   { id, points: Point[], headingMode: path_tangent | fixed_theta }
```

- 토큰 요청은 포탈 앞 `LOOKAHEAD_S`. 존 중심에서 요청 금지.
- 용량 2 교행: rail 2, 각자 자기 레일. 레일 이탈 = 존 문법 위반 (v0 F1을 여기서만 끔).
- 레일은 **TrafficZone 안**에만. 전 맵 레일 금지.

---

## 2. GraphNode / GraphEdge — P1

VDA order · LIF 의 원천. 자유주행 FMS가 “가짜 goal 노드”만 쓸 때도 같은 스키마.

```
GraphNode {
  nodeId
  x, y, theta
  mapId
  allowedDeviationXY?, allowedDeviationTheta?
  actions[]                 // startCharging, pick, drop, finePositioning, …
}

GraphEdge {
  edgeId
  startNodeId, endNodeId    // 단방향. 역방향은 엣지 하나 더
  maximumSpeed?
  length?                   // 없으면 궤적 길이
  trajectory?: Point[]      // 내부 폴리라인
  corridor?: {
    leftWidth, rightWidth   // m
    corridorReferencePoint: KINEMATIC_CENTER | CONTOUR
    releaseRequired: bool
    releaseLossBehavior: STOP | RETURN
  }
  vehicleTypeIds?: string[] // 비면 전원. LIF. 로봇에게 안 보냄
}
```

### 2.1 edge.corridor 를 맵에 그리는 법

폴리곤이 아니다.

1. 엣지 trajectory (없으면 노드 직선)를 중심선으로
2. 진행 방향 기준 왼쪽 `leftWidth`, 오른쪽 `rightWidth` 오프셋 리본
3. `CONTOUR` 이면 로봇 반폭을 리본 **안쪽**에 이미 넣었는지 인스펙터에 명시
4. `releaseRequired` 체크 → 이탈 전 `edgeRequest` (런타임). 에셋 플래그만 저장

리본이 벽·forbidden과 겹치면 경고.
폭 둘 다 0 또는 필드 생략 = 이탈 금지(라인에 붙음).

우리 TrafficZone.corridor 폴리곤과 **겹쳐 보여도 다른 객체**다. 선택 하이라이트 색을 나눈다.

### 2.2 언제 그래프가 필요한가

| 플릿 | 최소 그래프 |
|------|-------------|
| 가상 로봇만, 존 없음 | 스테이션 노드 + 클릭 goal 임시 노드 |
| 가상 로봇 + 사용자 존 | 위 + 존은 폴리곤만. 복도 rail은 존 필드 |
| 라인 가이드 실기 | 전 구간 노드–엣지 + trajectory + edge.corridor |
| 혼합 (자유 + 라인) | 교차·복도는 그래프 게이트. 자유공간은 노드 듬성 |

전 흰 칸을 노드로 채우지 않는다.

---

## 3. Station

지금 `ChargingStation` / `Waypoint` 의 VDA·LIF 승격.

```
Station {
  stationId
  name
  x, y, theta
  interactionNodeIds[]      // GraphNode. 보통 1
  kind: charger | pick_drop | wait | other
}
```

목적(충전 vs 피킹)은 LIF가 말하듯 **노드 액션**으로 구분한다.
charger → 인터랙션 노드에 `startCharging`.
에디터는 kind 아이콘만 바꾸고, 저장 시 액션 템플릿을 붙인다.

Waypoint는 “사람이 누를 목표”이지 반드시 station이 아니다.
VDA로 보낼 때만 `GraphNode` 가 된다 (액션 없는 경유 점).

---

## 4. 맵 자체 (에디터가 그리지 않지만 들고 있어야 하는 메타)

| 필드 | 왜 |
|------|-----|
| mapId, mapVersion | order 노드·zoneSet·로봇 `maps[]` 일치 |
| occupancy / 이미지 해시 | 존이 옛 맵에 남으면 안 됨 |
| 원점·축·pixelCm | m 변환 |
| 활성 zoneSetId | 배포 후 `enableZoneSet` |

기하 맵 파일은 VDA JSON이 아니다. 로봇은 `mapDownloadLink` 로 받는다.
에디터는 링크·버전만 관리하면 된다.

---

## 5. compile 스케치 (존)

```
for z in SemanticMap.zones:
  vertices = toMetersCCW(z.polygon)
  emit Zone { zoneId: z.id, zoneType: mapKind(z), vertices, typeFields… }
  if z.kind == corridor and z.rails:
     ensure GraphEdge per rail with trajectory = rail
     emit extra LINE_GUIDED covering z.polygon   # 또는 rail 버퍼
  if z.capacity:
     FmsMutex { zoneId, capacity }               # zoneSet 밖, 플릿만
```

`supportedZones`에 없는 타입은 그 로봇에게 보내지 않거나, 플릿이 base를 안 풀어 대신 게이트한다 ([`03`](./03_bg_fms_interface.md) §3.3).

---

## 6. 기존 seed.json 과의 관계

지금 seed: waypoint 3, charger 3, robot 2.

| seed | SemanticMap |
|------|-------------|
| waypoint | GraphNode (P1) 또는 그냥 UI 북마크 (P0) |
| charger | Station + charging 액션 노드 |
| robot spawn | 시맨틱 아님. 시뮬 전용 |
| (없음) | zones[] ← **새로 필요** |
| (없음) | edges[] / corridor ribbon ← P1 |

P0 저장 파일은 `seed.json` 을 확장하거나 `resources/maps/semantic.json` 을 옆에 둔다.
occupancy.bin 은 그대로.
