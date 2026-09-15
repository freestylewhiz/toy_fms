# 03. 구현 스펙 — FMS 테스트 UI

앱 코드는 이 문서 합의 후에 작성합니다. 대상 트리: `bg_fms_v1_new_ui/` (bun + TypeScript + Colyseus + gRPC 가상 로봇, `bg_fms` 복사본).

브라우저 ↔ FMS는 **Colyseus**, 가상 로봇 ↔ FMS는 **gRPC**를 유지합니다. MQTT는 추가하지 않습니다.

---

## 0. 결정 요약

| 항목 | 결정 |
|------|------|
| DB | **SQLite** (`bun:sqlite`). DuckDB 채택하지 않음 |
| 맵 픽셀 | **1280×800** (현 720×560 대체). `occupancy.bin` 길이 = `MAP_WIDTH * MAP_HEIGHT` = 1,024,000 |
| 맵 생성 | bun에서 **절차적 RGBA PNG** 작성 → 기존 luma 파이프로 `occupancy.bin` / `occupancy_inflated.bin` |
| 기하 저장 | 폴리곤·포탈·레일·궤적 = **JSON TEXT**. pose 에셋은 정규화 컬럼 |
| Colyseus 중첩 | 존/노드/엣지/스테이션의 가변 기하는 **JSON 문자열 필드**. `ArraySchema<Point>` 중첩 금지 |
| 포트 | Colyseus **2568**, gRPC **50062**, web-client **5174** |
| 장애물 기동 | SQLite에서 복원 시 **gRPC `place_query` 투표 없음**. LIVE place/move만 투표 |
| P0 범위 | 맵 + DB + 스키마 + 룸 persist + 존 편집 UI. 트래픽 정책·존 lethal 래스터는 넣지 않음 |

---

## 1. 현재 트리 (복사본 기준)

```
bg_fms_v1_new_ui/
  shared/
    constants.ts          MAP_WIDTH=720 MAP_HEIGHT=560, ports 2567/50061/5173
    occupancy.ts          MAP_PNG_PATH → resources/maps/1st_floor.png
    planner.ts / obstacles.ts / corridor.ts / traffic/
  server/src/
    schema.ts             Waypoint, ChargingStation, Robot, Obstacle, FloorState
    rooms/FloorRoom.ts    seed.json 로드, place/move/obstacle, gRPC 브리지
    grpc/robotBridge.ts
    traffic/              LocalPlanPolicy / CorridorLeasePolicy (이번 작업에서 수정 금지)
    index.ts
  web-client/src/main.ts  ~1479줄 단일 파일
  virtual-robot/          occupancy.bin + seed.json spawn
  resources/maps/
    1st_floor.png, occupancy.bin, occupancy_inflated.bin, occupancy.json, seed.json
  scripts/generate_occupancy.ts
```

`web-client/src/main.ts` 현재 블록:

| 줄 대역 | 역할 |
|---------|------|
| 1–194 | 타입, ASSETS, DOM, 제스처 상태 |
| 196–377 | occupancy 오버레이, 툴, 연결 UI |
| 381–765 | hit-test, send/queue, 스프라이트·장애물·경로 드로우 |
| 767–1003 | `draw()`, 인스펙터, 스케일 |
| 1011–1085 | Colyseus bind/connect |
| 1087–1331 | pointer + rAF |
| 1333–1478 | `main()` 부트 |

`FloorRoom.onCreate`는 `loadSeed()`로 waypoint/charger/robot만 채웁니다. 장애물은 메모리만 — 재시작 시 사라집니다. 존/노드/엣지/스테이션 Schema는 없습니다.

---

## 2. 권장 맵 픽셀 · 생성

### 2.1 크기

`shared/constants.ts`:

```ts
export const MAP_WIDTH = 1280;
export const MAP_HEIGHT = 800;
export const PIXEL_CM = 5; // 유지. 맵 = 64.0 m × 40.0 m
```

| 후보 | 셀 수 | 실측 | 채택 |
|------|------|------|------|
| 960×640 | 614,400 | 48×32 m | 복도·교차가 비좁음 |
| **1280×800** | **1,024,000** | **64×40 m** | **채택** |
| 1600×1000 | 1,600,000 | 80×50 m | 1 px A*·inflate 생성 부담 |

`occupancy.bin` / `occupancy_inflated.bin`은 row-major `Uint8`, `1=free`, 길이 **반드시** `1280 * 800`. 불일치 시 `loadOccupancy()`가 throw (현 로직 유지).

캔버스: `web-client/index.html` `<canvas id="map" width="1280" height="800">`. `updateScale()`은 기존 contain 규칙 유지.

A*는 당분간 1 px 그리드 유지합니다. 셀 수가 ~2.5배이므로 측정 후 필요하면 2 px로 내릴 수 있으나, **트래픽 정책 변경이 아닙니다.** 이번 합의 범위 밖입니다.

### 2.2 기하 (흰 = free, 나머지 = 벽)

원점 좌상단, y 아래+. 외곽 40 px는 벽.

```
y=0
    ████ 벽 ██████████████████████████████████████████████████
    ██ WEST_HALL          ██              ██ EAST_HALL      ██
    ██ 440×640            ██   V_NORTH    ██ 384×640        ██
    ██                    ██    36px      ██                ██
    ██         H_CORRIDOR 36px  INTERSECTION 96×132         ██
    ██         ────────────████████████████                 ██
    ██                    ██   V_SOUTH    ██                ██
    ██████████████████████████████████████████████████████████
                                                     x=1280
```

축 정렬 사각형만 칠합니다 (절차적 생성·디버그가 쉽습니다).

| 영역 | `[x0,x1) × [y0,y1)` | 크기 | 의도 |
|------|---------------------|------|------|
| WEST_HALL | `[60,500)×[80,720)` | 440×640 | 열린 홀. 스폰·WP·충전기 |
| H_CORRIDOR | `[500,740)×[382,418)` | 240×**36** | 용량 1 복도 (1.80 m) |
| INTERSECTION | `[740,836)×[334,466)` | 96×132 | 십자 교차 |
| V_NORTH | `[770,806)×[80,334)` | 36×254 | 북측 좁은 복도 |
| V_SOUTH | `[770,806)×[466,720)` | 36×254 | 남측 좁은 복도 |
| EAST_HALL | `[836,1220)×[80,720)` | 384×640 | 반대편 홀 |

복도 폭 36 px 근거:

- 로봇 바디 16×10, `PLAN_INFLATE_PX=8` → 인플레이트 후 중앙 안전띠 ≈ 20 px. 1대 통과 가능.
- 2대 교행에 필요한 대략 `2*ROBOT_WIDTH + TRAFFIC_SEP` ≈ 44 px 미만 → **좁은 복도**로 남음.
- `CORRIDOR_MIN_RADIUS=12`보다 넓어 캡슐 피팅은 가능하나, 이번 작업에서 자동 추출·정책 연결은 하지 않습니다.

교차로는 복도 띠(y 382–418, x 770–806)를 포함해야 끊기지 않습니다.

### 2.3 절차적 PNG → occupancy

신규 `scripts/generate_test_map.ts` (bun, 네이티브 애드온·canvas 없음).

1. `Uint8Array(MAP_WIDTH * MAP_HEIGHT * 4)` 할당. 기본 채움 RGB `(40,40,40)` A=255 (luma ≪ 230 → blocked).
2. 위 표 사각형을 RGB `(255,255,255)`로 채움.
3. 교차 모서리에 선택적 기둥 8×8 (시각적 십자). 기둥은 복도 통로를 막지 않게 INTERSECTION 네 구석에만.
4. **비압축에 가까운 RGBA PNG** 인코딩: IHDR + IDAT(`zlib.deflateSync`, filter 0) + IEND. CRC32는 스크립트 내장. 의존성 추가 없음.
5. `resources/maps/test_floor.png` 기록.
6. 기존 `scripts/generate_occupancy.ts`와 동일한 luma→occ→inflate 함수를 **shared 또는 스크립트 헬퍼로 추출**해 `occupancy.bin`, `occupancy_inflated.bin`, `occupancy.json` 기록.
7. 시드 pose가 `isInflatedFree`인지 검사. 실패 시 throw (홀 좌표를 고칩니다).

`occupancy.json` 예시:

```json
{
  "width": 1280,
  "height": 800,
  "threshold": 230,
  "inflateRadiusPx": 8,
  "freePixelCm": 5,
  "freeCells": 0,
  "inflatedFreeCells": 0,
  "source": "test_floor.png",
  "note": "1=free(white), 0=blocked. procedural halls + 36px corridors + intersection."
}
```

`package.json`:

```json
"occupancy": "bun run scripts/generate_test_map.ts"
```

기존 `generate_occupancy.ts`는 PNG→bin 변환기로 남기되, 입력 경로는 `MAP_PNG_PATH`를 따릅니다.

### 2.4 시드 spawn (새 맵, inflate-safe 목표)

`resources/maps/seed.json`은 **퍼스트 부트 임포트 스냅샷**입니다. 좌표는 생성 스크립트가 검증합니다.

| id | 대략 pose | 위치 |
|----|-----------|------|
| robot-1 | `(200, 400, 0)` | WEST_HALL, 복도 쪽 +x |
| robot-2 | `(1020, 400, 3.1416)` | EAST_HALL, 복도 쪽 −x |
| wp-1 | `(280, 280, 0)` | WEST_HALL |
| wp-2 | `(788, 400, 1.5708)` | INTERSECTION 근처 (인플레이트 확인) |
| wp-3 | `(1080, 560, 3.1416)` | EAST_HALL |
| cs-1 | `(140, 160, 0)` | WEST_HALL 북쪽 |
| cs-2 | `(1140, 160, 1.5708)` | EAST_HALL 북쪽 |
| cs-3 | `(140, 640, 3.1416)` | WEST_HALL 남쪽 |

`1st_floor.png`는 삭제하지 않습니다. 로더는 더 이상 가리키지 않습니다.

---

## 3. occupancy 경로 · `MAP_PNG_PATH`

`shared/occupancy.ts` 변경:

```ts
export const MAP_PNG_PATH = join(RESOURCES_DIR, "maps/test_floor.png");
export const OCCUPANCY_PATH = join(RESOURCES_DIR, "maps/occupancy.bin");
export const OCCUPANCY_INFLATED_PATH = join(RESOURCES_DIR, "maps/occupancy_inflated.bin");
export const OCCUPANCY_JSON_PATH = join(RESOURCES_DIR, "maps/occupancy.json");
export const SEED_PATH = join(RESOURCES_DIR, "maps/seed.json");
export const SQLITE_PATH = join(here, "../data/fms.sqlite");
```

모듈 캐시 `occ` / `inflatedCache`는 크기 불일치 시 재로드해야 하므로 `resetOccupancyCache()`를 추가합니다 (생성 스크립트·테스트용).

웹 에셋 (`web-client/src/assets.ts`):

```ts
map: "/resources/maps/test_floor.png",
occupancy: "/resources/maps/occupancy.bin",
inflated: "/resources/maps/occupancy_inflated.bin",
```

가상 로봇은 계속 `loadOccupancy()` + `inflatedGrid()`를 씁니다. spawn은 §7.

`PIXEL_CM`, `FREE_LUMA_THRESHOLD`, `PLAN_INFLATE_PX`는 유지합니다. `clampObstaclePos`는 `MAP_WIDTH`/`MAP_HEIGHT`를 import하므로 상수만 바꾸면 됩니다.

---

## 4. SQLite — DuckDB가 아닌 이유

| | `bun:sqlite` | DuckDB |
|--|--------------|--------|
| bun | 내장 | 네이티브 애드온 |
| 용도 | OLTP, 행 단위 CRUD, WAL | OLAP 스캔 |
| 이 앱 | 존/WP 수십~수백 행, 재시작 복원 | 집계 없음 |

**SQLite를 채택합니다.** 파일 `data/fms.sqlite` (gitignore). `PRAGMA journal_mode=WAL`, `foreign_keys=ON`.

서버만 씁니다. 가상 로봇은 spawn을 **기동 시 gRPC `register` 응답(또는 별도 `spawn` 다운링크)** 으로 받습니다. 로봇 프로세스가 sqlite를 직접 열지 않습니다 (WAL 락·경로 불일치 방지). 자세한 내용은 §7.

### 4.1 JSON 컬럼 vs 정점 정규화

| 데이터 | 저장 | 이유 |
|--------|------|------|
| waypoint, charger, robot spawn, obstacle, graph node | 컬럼 `x,y,theta` | id 점 갱신이 잦음, 쿼리 단순 |
| zone.polygon / portals / rails | **JSON TEXT** | 항상 통째로 로드·렌더. 정점 단위 SELECT 없음 |
| edge.trajectory / edge.corridor | **JSON TEXT** | 동일 |
| station.interactionNodeIds, node.actions | **JSON TEXT** | 가변 길이 배열 |
| kind별 파라미터 (capacity, cost_scale, …) | **params_json TEXT** | kind 추가 시 ALTER 회피 |

정점 테이블 (`zone_vertices(zone_id, seq, x, y)`)은 만들지 않습니다. 조인·순서 재조립이 Colyseus JSON 문자열과 이중 모델이 됩니다. SQLite JSON1 (`json_extract`)은 디버그용으로만 씁니다.

### 4.2 스키마 SQL

`server/src/db/schema.sql` (마이그레이션 v1, `PRAGMA user_version=1`):

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS map_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  map_id TEXT NOT NULL,
  map_version TEXT NOT NULL,
  pixel_cm REAL NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  origin_x_m REAL NOT NULL DEFAULT 0,
  origin_y_m REAL NOT NULL DEFAULT 0,
  y_down INTEGER NOT NULL DEFAULT 1,
  occupancy_ref TEXT NOT NULL,
  occupancy_sha256 TEXT,
  png_relpath TEXT NOT NULL,
  seed_imported_at TEXT
);

CREATE TABLE IF NOT EXISTS id_seq (
  prefix TEXT PRIMARY KEY,
  last INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS waypoints (
  id TEXT PRIMARY KEY,
  x REAL NOT NULL,
  y REAL NOT NULL,
  theta REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS charging_stations (
  id TEXT PRIMARY KEY,
  x REAL NOT NULL,
  y REAL NOT NULL,
  theta REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS robots (
  id TEXT PRIMARY KEY,
  spawn_x REAL NOT NULL,
  spawn_y REAL NOT NULL,
  spawn_theta REAL NOT NULL DEFAULT 0,
  sprite TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS obstacles (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('triangle', 'square', 'circle')),
  x REAL NOT NULL,
  y REAL NOT NULL,
  size REAL NOT NULL,
  theta REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS traffic_zones (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'forbidden', 'corridor', 'complex', 'avoid', 'prefer',
    'speed_limit', 'directed', 'replanning'
  )),
  polygon_json TEXT NOT NULL,
  portals_json TEXT,
  rails_json TEXT,
  params_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY,
  x REAL NOT NULL,
  y REAL NOT NULL,
  theta REAL NOT NULL DEFAULT 0,
  map_id TEXT NOT NULL,
  actions_json TEXT NOT NULL DEFAULT '[]',
  allowed_deviation_xy REAL,
  allowed_deviation_theta REAL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_edges (
  id TEXT PRIMARY KEY,
  start_node_id TEXT NOT NULL REFERENCES graph_nodes(id),
  end_node_id TEXT NOT NULL REFERENCES graph_nodes(id),
  maximum_speed REAL,
  length REAL,
  trajectory_json TEXT,
  corridor_json TEXT,
  vehicle_type_ids_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('charger', 'pick_drop', 'wait', 'other')),
  x REAL NOT NULL,
  y REAL NOT NULL,
  theta REAL NOT NULL DEFAULT 0,
  interaction_node_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
```

JSON 페이로드 타입 (TypeScript, `shared/semantic.ts`):

```ts
export type Point = { x: number; y: number };

export type Portal = {
  id: string;
  segment: [Point, Point];
  waitPose?: { x: number; y: number; theta: number };
};

export type Rail = {
  id: string;
  points: Point[];
  headingMode: "path_tangent" | "fixed_theta";
};

export type ZoneParams = {
  capacity?: number;
  cost_scale?: number;
  releaseLossBehavior?: "STOP" | "CONTINUE" | "EVACUATE";
  maximumSpeed?: number;
  direction?: number;
  limitation?: "SOFT" | "RESTRICTED" | "STRICT";
};

export type EdgeCorridor = {
  leftWidth: number;
  rightWidth: number;
  corridorReferencePoint: "KINEMATIC_CENTER" | "CONTOUR";
  releaseRequired: boolean;
  releaseLossBehavior: "STOP" | "RETURN";
};

export type NodeAction = { actionType: string; actionId?: string; [k: string]: unknown };
```

`polygon_json` 예: `[{"x":60,"y":80},{"x":500,"y":80},{"x":500,"y":720},{"x":60,"y":720}]`  
저장 시 단순 폴리곤·정점 ≥ 3. 시계방향이면 서버가 CCW로 뒤집습니다. self-intersection은 거부합니다.

`params_json` 예 (corridor): `{"capacity":1,"releaseLossBehavior":"STOP"}`

`map_meta` 단일 행:

```sql
INSERT INTO map_meta (
  id, map_id, map_version, pixel_cm, width, height,
  occupancy_ref, png_relpath
) VALUES (
  1, 'test_floor', '1', 5, 1280, 800,
  'resources/maps/occupancy.bin', 'resources/maps/test_floor.png'
);
```

기동 시 `map_meta.width/height`가 `MAP_WIDTH/HEIGHT`와 다르면 throw합니다 (자동 리샘플 없음).

`id_seq` prefix: `wp`, `cs`, `obs`, `zn`, `n`, `e`, `st`. `nextId`는 메모리 스캔 대신 `UPDATE id_seq SET last=last+1 WHERE prefix=?`.

### 4.3 persist 타이밍

| 이벤트 | SQLite |
|--------|--------|
| place / delete / update (필드) | 동기 `INSERT/UPDATE/DELETE` (트랜잭션 1회) |
| move / rotate | 커밋된 메시지마다 UPDATE. 드래그 중간은 클라이언트가 기존처럼 queue+flush |
| 로봇 **라이브** pose | **저장하지 않음** (20 Hz). spawn만 `robots` 테이블 |
| LIVE 장애물 place 성공 | INSERT 후 Schema 반영 |
| 기동 복원 장애물 | SELECT → Schema. `queryPlace` 호출 금지. 이후 `broadcastObstacles` |

모듈: `server/src/db/sqlite.ts` (open), `migrate.ts`, `repo.ts` (CRUD). FloorRoom만 repo를 호출합니다.

---

## 5. Colyseus Schema 추가

`@colyseus/schema`의 중첩 `ArraySchema`는 Point/Portal/Rail마다 클래스·`@type`가 필요합니다. 편집 단위가 JSON과 같으므로 **문자열로 둡니다.** 클라이언트는 `JSON.parse` 후 그립니다. 잘못된 JSON은 서버가 메시지 단계에서 거부합니다.

```ts
export class TrafficZoneState extends Schema {
  @type("string") id = "";
  @type("string") name = "";
  @type("string") kind = "forbidden";
  @type("string") polygonJson = "[]";
  @type("string") portalsJson = "null";
  @type("string") railsJson = "null";
  @type("string") paramsJson = "{}";
}

export class GraphNodeState extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") theta = 0;
  @type("string") mapId = "";
  @type("string") actionsJson = "[]";
  @type("number") allowedDeviationXY = -1;    // <0 = unset
  @type("number") allowedDeviationTheta = -1;
}

export class GraphEdgeState extends Schema {
  @type("string") id = "";
  @type("string") startNodeId = "";
  @type("string") endNodeId = "";
  @type("number") maximumSpeed = -1;
  @type("number") length = -1;
  @type("string") trajectoryJson = "null";
  @type("string") corridorJson = "null";
  @type("string") vehicleTypeIdsJson = "null";
}

export class StationState extends Schema {
  @type("string") id = "";
  @type("string") name = "";
  @type("string") kind = "charger";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") theta = 0;
  @type("string") interactionNodeIdsJson = "[]";
}

export class FloorState extends Schema {
  @type({ map: Waypoint }) waypoints = new MapSchema<Waypoint>();
  @type({ map: ChargingStation }) chargingStations = new MapSchema<ChargingStation>();
  @type({ map: Robot }) robots = new MapSchema<Robot>();
  @type({ map: Obstacle }) obstacles = new MapSchema<Obstacle>();
  @type({ map: TrafficZoneState }) zones = new MapSchema<TrafficZoneState>();
  @type({ map: GraphNodeState }) nodes = new MapSchema<GraphNodeState>();
  @type({ map: GraphEdgeState }) edges = new MapSchema<GraphEdgeState>();
  @type({ map: StationState }) stations = new MapSchema<StationState>();
}
```

기존 `Waypoint` / `ChargingStation` / `Robot` / `Obstacle` / `PathPoint`는 유지합니다. P0에서 charger와 `StationState`는 공존합니다. 자동 승격은 하지 않습니다 (P1 UI).

`patchRate = 50` 유지. JSON 문자열이 큰 존을 매 패치에 실을 수 있으므로, 존 편집은 **커밋 시 한 번** Schema를 바꿉니다 (드래그 중 로컬 고스트만).

---

## 6. Colyseus 메시지

공통 실패: `client.send("error", { message })`.  
공통 성공(선택): `resourceAck { kind, id, op }` where `op` ∈ `place|move|rotate|delete|update`.

좌표는 맵 픽셀. `theta`는 rad.

### 6.1 기존 (유지, delete/rotate 보강)

| type | payload | 서버 |
|------|---------|------|
| `placeWaypoint` | `{x,y,theta}` | `isFree`. id `wp-N`. SQLite INSERT |
| `placeCharger` | `{x,y,theta}` | 동일, `cs-N` |
| `moveAsset` | `{kind:"waypoint"\|"charger", id, x, y, theta?}` | `isFree`. xy [+theta]. UPDATE |
| `rotateAsset` | `{kind:"waypoint"\|"charger", id, theta}` | **신규**. 위치 유지 |
| `deleteAsset` | `{kind:"waypoint"\|"charger", id}` | **신규**. DELETE |
| `commandRobot` | 기존 | persist 없음 |
| `cancelRobot` | 기존 | persist 없음 |
| `placeObstacle` | `{kind,x,y,size,theta}` | **LIVE: `queryPlace` 투표**. 성공 시 INSERT |
| `moveObstacle` | `{id,x,y,size?,theta?}` | **LIVE: `queryPlace`**. UPDATE |
| `rotateObstacle` | `{id, theta}` | LIVE 투표 (풋프린트 회전). UPDATE |
| `deleteObstacle` | `{id}` | 투표 없음. DELETE + `broadcastObstacles` |
| `updateObstacle` | `{id, size?}` | LIVE 투표. 인스펙터 리사이즈 |

기동 로드 장애물은 Schema에 올린 뒤 `pushObstacles()`만 합니다. 투표 없음.

### 6.2 TrafficZone (P0)

| type | payload | 검사 |
|------|---------|------|
| `placeZone` | `{name?, kind, polygon: Point[], portals?, rails?, params?}` | 정점≥3, 단순, 맵 안. corridor 용량2면 rail≥2. 포탈이 있으면 경계 위 |
| `moveZone` | `{id, dx, dy}` 또는 `{id, polygon}` | 평행이동 또는 정점 교체. 재검사 |
| `rotateZone` | `{id, theta, origin?: Point}` | origin 기본 = centroid. 폴리곤·레일 회전 |
| `deleteZone` | `{id}` | |
| `updateZone` | `{id, name?, kind?, polygon?, portals?, rails?, params?}` | 부분 갱신. kind 변경 시 params 재검증 |

`kind` 허용: `forbidden | corridor | complex | avoid | prefer | speed_limit | directed | replanning`.  
P0 UI는 앞 5개만 노출해도 됩니다. 스키마는 8개 모두 받습니다.

겹침: 저장은 허용하되 `avoid∩prefer`·`forbidden∩*`는 ack에 `warnings: string[]`. **플래너 lethal 반영은 하지 않습니다.**

### 6.3 GraphNode / GraphEdge (스키마·룸·DB는 P0에 포함, UI는 P1)

| type | payload |
|------|---------|
| `placeNode` | `{x,y,theta, mapId?, actions?}` — `isInflatedFree` |
| `moveNode` | `{id,x,y,theta?}` |
| `rotateNode` | `{id,theta}` |
| `deleteNode` | `{id}` — 참조 엣지 있으면 거부 |
| `updateNode` | `{id, mapId?, actions?, allowedDeviationXY?, allowedDeviationTheta?}` |
| `placeEdge` | `{startNodeId, endNodeId, trajectory?, corridor?, maximumSpeed?}` |
| `moveEdge` | `{id, trajectory}` — 궤적 점 이동 |
| `rotateEdge` | 없음 (궤적은 `moveEdge`/`updateEdge`) |
| `deleteEdge` | `{id}` |
| `updateEdge` | `{id, maximumSpeed?, length?, trajectory?, corridor?, vehicleTypeIds?}` |

### 6.4 Station (P1 UI, 룸 핸들러는 준비)

| type | payload |
|------|---------|
| `placeStation` | `{name?, kind, x,y,theta, interactionNodeIds?}` — `isFree` |
| `moveStation` | `{id,x,y,theta?}` |
| `rotateStation` | `{id,theta}` |
| `deleteStation` | `{id}` |
| `updateStation` | `{id, name?, kind?, interactionNodeIds?}` |

`chargingStations`와 동기화하지 않습니다. 기존 charger 툴은 `placeCharger` 유지.

### 6.5 클라이언트 → 룸 목록 (구현 체크리스트)

```
placeWaypoint, moveAsset, rotateAsset, deleteAsset
placeCharger
commandRobot, cancelRobot
placeObstacle, moveObstacle, rotateObstacle, deleteObstacle, updateObstacle
placeZone, moveZone, rotateZone, deleteZone, updateZone
placeNode, moveNode, rotateNode, deleteNode, updateNode
placeEdge, moveEdge, deleteEdge, updateEdge
placeStation, moveStation, rotateStation, deleteStation, updateStation
```

`moveAsset`은 waypoint/charger 하위 호환용으로 남깁니다. 존은 `moveZone`만 씁니다.

---

## 7. Seed vs SQLite 마이그레이션

```
server onCreate
  open data/fms.sqlite (create)
  migrate user_version
  occupancy.bin 로드, 길이 === MAP_WIDTH*MAP_HEIGHT

  if map_meta 없음 OR seed_imported_at IS NULL:
      seed = loadSeed()                         # resources/maps/seed.json
      INSERT map_meta (width/height = constants)
      INSERT waypoints / charging_stations / robots
      id_seq를 시드 max N으로
      zones/nodes/edges/stations/obstacles = 빈 테이블
      seed_imported_at = now
  else:
      SELECT * → FloorState
      장애물은 queryPlace 없이 Schema + broadcastObstacles

  시드 로봇 id가 ROBOT_IDS와 불일치하면 throw
```

**이후 `seed.json`은 읽지 않습니다.** 맵 PNG를 재생성해도 sqlite 좌표는 그대로입니다. 맵과 시드를 리셋하려면 `data/fms.sqlite` 삭제.

가상 로봇 spawn:

1. 로봇은 임시 pose (0,0)로 gRPC `register`만 보냅니다.
2. 서버가 `robots.spawn_*`를 `ServerToRobot` **`spawn` 메시지**(proto 필드 추가)로 내려줍니다.
3. 컨트롤러가 그 pose로 리셋한 뒤 20 Hz pose를 시작합니다.

`seed.json`을 로봇이 직접 읽는 경로(`virtual-robot/src/index.ts`의 `loadSeed()`)는 제거합니다. occupancy.bin은 그대로 로컬 로드합니다.

LIVE pose는 sqlite에 안 남으므로, 재시작 시 로봇은 **항상 spawn**으로 돌아갑니다. 장애물·존·WP는 복원됩니다.

gitignore:

```
data/*.sqlite
data/*.sqlite-wal
data/*.sqlite-shm
```

---

## 8. 포트

원본 `bg_fms`와 동시 기동:

```ts
export const COLYSEUS_PORT = 2568;
export const GRPC_PORT = 50062;
export const WEB_CLIENT_PORT = 5174;
```

| 프로세스 | 원본 | 이 트리 |
|----------|------|---------|
| Colyseus | 2567 | **2568** |
| gRPC RobotBridge | 50061 | **50062** |
| web-client | 5173 | **5174** |

`ROOM_NAME = "floor"` 유지 (포트가 다름).  
`virtual-robot` `TARGET = localhost:50062`.  
웹 `ws://localhost:2568`.  
브라우저: http://localhost:5174

---

## 9. web-client 모듈 분할

`main.ts` 단일 파일(~1500줄)을 해체합니다. bun.build entry는 `main.ts` 유지.

```
web-client/src/
  main.ts                 부트, rAF, 이벤트 바인딩만
  types.ts                Tool, Snapshot, Entity, 제스처
  assets.ts               ASSETS, ROBOT_COLOR, 이미지 로드
  occupancyView.ts        bin 로드, luma isFree, overlay 캔버스, Grid 토글
  colyseusClient.ts       connect, send, error/ack, bindCollections
  snapshot.ts             room.state → Snapshot (zones JSON.parse 포함)
  draw/
    map.ts                배경 PNG, 스케일
    sprites.ts            WP/CS/로봇
    obstacles.ts          △□○, 핸들
    paths.ts              계획 경로, traffic pill
    zones.ts              폴리곤 채움, 포탈, 레일 (P0)
    graph.ts              노드/엣지/리본 (P1, 빈 stub 가능)
  input/
    hitTest.ts
    pointer.ts            down/move/up
    tools.ts              setTool, 단축키 V/W/C/M/D/O/G/Z
    gestures.ts           place/drag/goto/zone-polygon
  ui/
    toolbar.ts
    inspector.ts          pose + zone params
    robotCards.ts
    status.ts
```

P0 툴 추가: **Zone (Z)** — 클릭으로 정점, 더블클릭/Enter로 닫기. kind는 인스펙터 또는 툴 서브버튼 (`forbidden` 기본). Select로 존 히트테스트(폴리곤 내부). 정점 드래그는 `updateZone.polygon`.

`index.html` 툴바에 Zone 버튼, 인스펙터에 kind/capacity/cost_scale. canvas 크기 1280×800.

프레임워크 없이 순수 TS. `web-client/src/server.ts` 엔트리만 `main.ts`.

---

## 10. 서버·공유 모듈 (신규 파일)

```
shared/semantic.ts              Point, Portal, Rail, ZoneParams, 파서
shared/polygon.ts               CCW, simple, centroid, rotate, translate
server/src/db/sqlite.ts
server/src/db/schema.sql
server/src/db/migrate.ts
server/src/db/repo.ts
server/src/schema.ts            기존 + Zone/Node/Edge/Station
server/src/rooms/FloorRoom.ts   로드/persist/메시지 (교통 콜백은 현행)
proto/robot.proto               Spawn { x, y, theta } 다운링크 추가
scripts/generate_test_map.ts
scripts/png_encode.ts           (선택) 최소 PNG 인코더
data/                           sqlite, gitignore
```

`FloorRoom` 교통 스택(`TrafficController`, lease/bid/evasion)은 **호출부 시그니처 유지**. 존 Schema를 정책에 넣지 않습니다.

---

## 11. 구현하지 않을 것

| 항목 | 이유 |
|------|------|
| MQTT / VDA `zoneSet` 어댑터 | 제약. 가상 로봇은 gRPC만 |
| NURBS export, `plannedPath` compile | 내부는 폴리라인 |
| LIF import/export | P2. 런타임 진실은 sqlite |
| 트래픽 정책 변경 | `LocalPlanPolicy` / `CorridorLeasePolicy` / 임대 불변식 수정 금지 |
| forbidden → occupancy lethal 래스터 | 정책·플래너 결합. 존은 저장·표시만 |
| 존 브로드캐스트를 로봇 extra occupancy에 반영 | 위와 동일 |
| 복도 자동 추출 | 사용자가 그림 |
| occupancy 브러시 편집 | `generate_test_map`만 |
| DuckDB | bun 네이티브 애드온 + OLAP |
| 로봇 LIVE pose sqlite 기록 | 20 Hz 과다. spawn만 |
| 기동 시 장애물 `place_query` 재투표 | 연결 전 로봇이 없거나 경로가 비어 거절/통과가 비결정 |
| `1st_floor.png` 삭제 | 로더만 전환 |
| 포트 2567/50061/5173 유지 | 원본과 충돌 |

---

## 12. 구현 순서

1. **map** — `MAP_WIDTH/HEIGHT` 1280×800, 포트 2568/50062/5174, `generate_test_map.ts`, `MAP_PNG_PATH=test_floor.png`, occupancy bin 재생성, `seed.json` 좌표, 캔버스 크기. 기존 UI로 맵만 확인.
2. **db** — `data/fms.sqlite`, schema.sql, migrate, repo, 퍼스트 부트 시드 임포트. FloorRoom은 아직 seed.json 직접 로드여도 됨 (repo 단위 테스트).
3. **schema** — Colyseus Zone/Node/Edge/Station + JSON 필드. proto `spawn`. `FloorState` 확장.
4. **room** — sqlite 로드/저장, 메시지 §6, 장애물 기동 무투표, 로봇 spawn 다운링크. `loadSeed()` 제거.
5. **ui** — `main.ts` 분할, Zone 툴, 인스펙터, persist된 에셋 리로드 확인. 그래프 툴은 stub.

검증 (브라우저 또는 curl 대체):

- 원본 `bg_fms`와 동시 listen (포트 충돌 없음).
- 존 그리고 서버 재시작 → 존·장애물 복원, 로봇은 spawn.
- LIVE 장애물 place는 로봇 연결 시 투표, 거절 동작 유지.
- `occupancy.bin.length === 1024000`.

---

## 합의 요청

구현 들어가기 전에 아래를 확정하고 싶습니다.

1. **맵 1280×800** · 홀+36 px 복도+교차 절차적 PNG. (960×640으로 줄일지)
2. **SQLite + JSON 기하**. DuckDB·정점 정규화 테이블 없음.
3. **포트 2568 / 50062 / 5174**.
4. **P0 UI = 존까지**. 노드/엣지/스테이션은 DB·Schema·메시지 핸들러만 두고 툴바는 다음.
5. **기동 장애물 무투표**, LIVE만 `place_query`.
6. **존을 이번 단계에서 플래너/트래픽에 연결하지 않음** (표시·persist만).
7. **로봇 spawn은 sqlite → gRPC `spawn`**. 로봇이 `seed.json`/sqlite를 직접 읽지 않음.
8. **`rotate*` / `deleteAsset` 신규 메시지**. `moveAsset`은 WP/CS 하위 호환 유지.

동의하면 순서 **map → db → schema → room → ui** 로 코드를 작성합니다.
