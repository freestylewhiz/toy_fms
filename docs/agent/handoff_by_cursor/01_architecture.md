# 01 — 아키텍처 요약

## 트리

```
bg_fms_v1_new_ui/
  server/           Colyseus + gRPC (port 2568 / 50062)
  web-client/       bun static + bundle (5174)
  virtual-robot/    gRPC client robots
  shared/           constants, occupancy, store, polygon, semantic, planner, traffic
  resources/maps/   yard.png, occupancy*.bin, 1st_floor.png, seed.json
  data/             editor.sqlite (runtime, gitignored)
  scripts/          occupancy gen, check_editor, smoke
  docs/
    agent/cursor/   초기 합의 스펙
    agent/codex/    이 핸드오프
    user/           사람용 에디터 가이드
```

## 프로세스·통신

```
Browser  --WS-->  Colyseus FloorRoom  --gRPC-->  virtual-robot(s)
                     | persist
                     v
                 editor.sqlite
```

- 브라우저↔FMS: Colyseus (`joinOrCreate("floor")`)
- 로봇↔FMS: gRPC RobotBridge
- MQTT: 없음

## 정본

| 데이터 | 정본 |
|--------|------|
| free/blocked 기하 | `occupancy.bin` / inflated |
| 배치 에셋 | SQLite |
| 세션 뷰 | Colyseus schema (JSON 문자열로 polygon 등) |
| 로봇 pose | gRPC stream (비영속) |

## 메시지 (에디터)

클라이언트 → 서버:

- `placeWaypoint` / `placeCharger` / `moveAsset` / `deleteAsset`
- `placeObstacle` / `moveObstacle` / `deleteObstacle` (LIVE는 vote)
- `editorUpsert` / `editorDelete` — zone, node, edge, station, portal, rail
- `commandRobot` / `cancelRobot`

서버 → 클라이언트:

- state sync (schema)
- `error` `{ message }`
- `obstacleAck`

## 맵 상수 함정

`MAP_WIDTH` / `MAP_HEIGHT` 가 `shared/constants.ts` 에 **컴파일 타임 상수**로 박혀 있다.  
플래너·occupancy·웹 `loadBin` 크기 검사가 모두 여기 의존.  
맵 전환을 넣으면 여기를 런타임 컨텍스트로 바꿔야 한다.

## 시드

`resources/maps/seed.json` (yard용 wp/cs/robot 초기 위치).  
SQLite `meta.seeded` 가 없으면 import. DB 삭제 시 재시드.

## 트래픽

기본 정책 `TRAFFIC_POLICY_ID=local_plan_v1` (원본과 동일 계열).  
에디터 존은 아직 플래너 cost/lethal에 안 묶임.
