# FMS — 구현 구조

Yard occupancy 맵을 기본으로 웨이포인트·충전소·가상 로봇·장애물·traffic 리소스를 실시간으로 다루는 FMS 구현이다. 편집 리소스는 `data/editor.sqlite`, 운영 상태·점유·감사 기록은 `data/runtime.sqlite`에 저장한다. 현재 제어 축은 웹 편집/명령, 서버의 Colyseus 상태·traffic 조정, 로봇의 gRPC 주행이다. 로봇 상태·점유 영속화 규칙은 [`design/robot-runtime-state.md`](design/robot-runtime-state.md), 프로토콜은 [`protocol.md`](protocol.md)가 기준이다.

## 폴더

| 경로 | 역할 | 런타임 |
|------|------|--------|
| `web-client/` | 맵 UI, 배치/명령 | bun (정적 + 브라우저) |
| `server/` | Colyseus 룸 + gRPC RobotBridge | bun |
| `virtual-robot/` | 경로계획·주행 시뮬레이터 × 2 | bun |
| `shared/` | 상수, occupancy, seed 로더 | bun TS (상대 import) |
| `proto/robot.proto` | server ↔ virtual-robot | grpc-js + proto-loader |
| `resources/` | 맵, occupancy.bin, 스프라이트 | — |

## 데이터 흐름

```
브라우저 A/B  --Colyseus WS:2568-->  server
                                      |  상태: waypoints / chargingStations / robots / obstacles
                                      |  메시지: place, moveAsset, commandRobot, placeObstacle
                                      |
                                      |  gRPC bidi :50062  RobotBridge.Session
                                      v
                               virtual-robot-1, virtual-robot-2
```

- 웹은 gRPC를 직접 쓰지 않는다.
- 로봇은 Colyseus에 붙지 않는다. pose는 gRPC로 서버에 올리고, 서버가 Schema를 갱신한다.

## 좌표·물리

- 맵: 기본 `resources/maps/yard.png` **1600×1200** RGBA. `1st_floor.png`는 보조 미리보기 맵이다.
- **1 px = 5 cm**.
- 흰 픽셀(평균 RGB ≥ 230)만 주행·배치 가능. `resources/maps/occupancy.bin` (1=free).
- 이미지 좌표: x 오른쪽+, y 아래+.
- **theta (rad)**: 0 = +x (오른쪽), 반시계 방향이 + (수학 좌표, y-up 기준).
  스프라이트 기본 헤딩은 위(-y)이므로 그릴 때 `rotate(θ + π/2)` (캔버스 y-down).
- 로봇 바디: **길이 0.80 m × 폭 0.50 m = 16×10 px**. 스프라이트 `robots/robot.png` (20×16, 휠 포함)와 맞춤.
- 경로계획 inflate 반경: **8 px** (대략 circumradius).
- 선속도 0.60 m/s = **12 px/s**, 각속도 **90 deg/s**, 제어주기 **50 ms (20 Hz)**.

## 리소스와 상태

시드에는 웨이포인트·충전소·로봇이 포함되며, scene 리소스는 waypoint, charger, obstacle, zone으로 구성된다. VDA node, edge, station, portal, rail은 편집 메타데이터다. 로봇 상태는 `workState`, `fmsControlState`, `connectionState`, `driveState`와 `driveContexts`로 나뉘며, 상세 스키마는 [`server/src/schema.ts`](../server/src/schema.ts), 런타임 규칙은 [`shared/robotRuntime.ts`](../shared/robotRuntime.ts)와 [`robot-state-sync.md`](robot-state-sync.md)를 따른다.

## 포트

- Colyseus / 웹소켓: **2568**
- gRPC: **50062**
- web-client 정적: **5174** (맵·이미지를 `/resources`로 서빙)

## 실행

루트에서:

```
bun run --cwd server start
bun run --cwd virtual-robot start -- --id robot-1
bun run --cwd virtual-robot start -- --id robot-2
bun run --cwd web-client start
```

브라우저: http://localhost:5174
