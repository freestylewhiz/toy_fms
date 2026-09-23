# 현재 리소스 모델

기준일: 2026-09-16

일반 편집 리소스는 map별 editor DB와 `SemanticSnapshot.mapId`를 통해 맵에 귀속된다. 주요 종류는 waypoint, charger, obstacle, zone, graph node, edge, station, portal, rail이다. node는 자체 `mapId`를 가지며, 위치·경로·옵션 일부는 SQLite JSON으로 저장한다.

로봇 runtime과 점유 상태는 편집 리소스 정의와 분리된다. 텔레포터는 일반 map 리소스가 아니라 공용 운영 리소스다.

`Teleporter` 하나가 정확히 두 `TeleporterEndpoint`를 가진다. endpoint는 `mapId`, pose, entry/exit heading, 좌표 기준 occupancy polygon, clearing point를 가진다. API에서는 endpoints 리스트로 다루고, 저장소에서는 endpoint 행으로 정규화한다.

공용 SQLite에는 텔레포터 정의 외에도 이용 queue, robot owner(map·control epoch), transfer ledger, map world heartbeat를 저장한다. 따라서 두 map server가 하나의 robot ID를 동시에 제어하지 않는다.

정의 상태와 실행 상태는 분리한다. 실제 점유·이전 상태는 durable ledger를 기준으로 복구한다.

구현 근거: `shared/semantic.ts`, `server/src/teleporterStore.ts`, `server/src/rooms/FloorRoom.ts`.
