# 프로토콜

등록·heartbeat·명령 생명주기·브라우저 투영의 현재 규격은
[`robot-state-sync.md`](robot-state-sync.md)를 참조한다. 아래는 기본 메시지와 배치 명령 설명이다.

## Colyseus

- Room name: `floor`
- 싱글 룸, `joinOrCreate("floor")`
- patchRate: 50 ms (로봇 움직임이 부드럽게 보이게)

### Schema (`FloorState`)

```
Waypoint { id:string, x:number, y:number, theta:number }
ChargingStation { id:string, x:number, y:number, theta:number }
Robot { id, x, y, theta, status, path: PathPoint[] }
Obstacle { id, kind:"triangle"|"square"|"circle", x, y, size, theta }
FloorState {
  waypoints: MapSchema<Waypoint>
  chargingStations: MapSchema<ChargingStation>
  robots: MapSchema<Robot>
  obstacles: MapSchema<Obstacle>
}
```

키는 id 문자열.

### 클라이언트 → 룸 메시지

| type | payload | 서버 동작 |
|------|---------|-----------|
| `placeWaypoint` | `{x,y,theta}` | 흰 영역이면 새 id 부여 후 추가 |
| `placeCharger` | `{x,y,theta}` | 동일 |
| `moveAsset` | `{kind:"waypoint"\|"charger", id, x, y, theta}` | 위치/자세 갱신 (흰 영역만) |
| `commandRobot` | `{robotId, kind:"move"\|"dock", targetId?, x?, y?, theta?}` | waypoint/charger id 또는 move일 때 좌표. 흰 영역·inflate 여유 검사 후 gRPC DriveCommand |
| `cancelRobot` | `{robotId}` | CancelCommand |
| `placeObstacle` | `{kind, x, y, size, theta}` | 맵 안이면 됨(벽 픽셀 포함 가능). 연결된 모든 로봇에 gRPC `place_query`. **전부 ok**일 때만 생성 |
| `moveObstacle` | `{id, x, y, size, theta}` | 이동/크기 변경. 같은 `place_query` 후 갱신 |
| `deleteObstacle` | `{id}` | 삭제 후 스냅샷 브로드캐스트. 로봇은 회피 경로 재계획 |

배치 실패 시 `room.send("error", {message})`.

명령 전송 시 `room.broadcast("commandAck", {robotId, commandId, kind, targetId, state:"sent"})`.
실제 수락·완료·취소 결과는 로봇이 보고한 명령 상태를 Schema로 동기화한다.
장애물 생성 시 `room.broadcast("obstacleAck", {id, kind})`.

## gRPC (`proto/robot.proto`)

패키지 `bgfms`. 서버가 gRPC **서버**, 가상로봇이 **클라이언트**.

```
service RobotBridge {
  rpc Session(stream RobotToServer) returns (stream ServerToRobot);
}
```

로봇은 기동 즉시 Session을 열고 첫 메시지로 `register { robot_id, protocol_version }`, 이후 20 Hz로 `pose`를 보낸다.

서버는 `drive` / `cancel` / `place_query` / `obstacles` 를 내리고, 로봇은 pose·계획 경로(`path`)·`place_reply`를 올린다.

`place_query`: 로봇이 현재 pose 또는 **남은 경로의 앞으로 5초**(12 px/s → 60 px)와 후보 장애물이 겹치면 `ok=false`. 전원 ok일 때만 FMS가 생성한다.

`obstacles` 스냅샷을 받으면 로봇은 extra occupancy에 래스터화하고, 주행 중이면 같은 목표로 A* 재계획한다.

재연결 시 같은 robot_id로 다시 register. 서버는 해당 슬롯의 스트림을 교체한다.
