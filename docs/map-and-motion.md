# 맵·경로·주행

## Occupancy (Yard)

- 파일: `resources/maps/occupancy.bin` (row-major, 1600*1200 바이트, 1=free)
- 메타: `resources/maps/occupancy.json`
- 생성: `bun run occupancy` → `scripts/generate_yard_map.ts`
  - `yard.png` 기준 occupancy 생성
  - 반경 8 px 디스크 inflate → occupancy_inflated.bin
- 로더: `shared/occupancy.ts`
- 배치 검사: 해당 픽셀 free.
- 로봇 충돌: 중심 (x,y), 헤딩 theta 기준 **축 정렬이 아닌 OBB** 16×10 px. 모서리 4점 + 가장자리 샘플이 모두 free여야 함.
- 계획 그리드: occupancy를 반경 8 px 디스크 inflate 후 그 위에서 A*.

## A* + 스무딩

1. start/goal을 가장 가까운 safe 셀로 스냅.
2. 4-이웃 또는 8-이웃 A* (비용: 직선 1, 대각 1.414). 맵이 작아서 1 px 그리드도 가능. 너무 느리면 2 px 그리드 후 스냅.
3. string-pulling: 두 웨이포인트 사이 직선이 inflate 그리드에서 막히지 않으면 중간점 제거.
4. 결과 polyline을 따라 이동.

실패 시 로봇은 idle 유지, 서버에 status idle, 웹은 toast.

## 동적 장애물

- 종류: 정삼각형 / 정사각형 / 원. `size`는 중심에서 꼭짓점(또는 반지름)까지, 10–80 px.
- 생성: UI → Colyseus `placeObstacle` → FMS가 연결 로봇마다 gRPC `place_query`. 벽 픽셀을 포함해도 됨. 현재 pose 또는 5초 lookahead와 겹치면 거절. 전원 동의 시에만 `obs-N` 생성. 이동/크기 변경은 `moveObstacle`로 같은 검사.
- 계획: `shared/obstacles.ts`가 inflate 8 px로 래스터화 → `occupancy.setExtraBlocked`. A*의 `isPlanFree`가 정적 inflate 그리드 **그리고** extra blocked를 본다.
- 스냅샷을 받은 로봇은 같은 goal로 재계획한다.

## 추종

- 경로 위를 선속도 12 px/s로 따라감. 매 틱 heading을 경로 접선으로 돌림 (각속도 제한 90°/s).
- 다음 코너가 급하면 미리 감속 가능 (선택).
- **마지막 점 도착 후** 제자리 회전으로 목표 theta에 정렬 (move, dock 모두). 정렬 오차 |Δθ| < 3°.
- 도킹: 충전소 pose가 곧 목표. 진입 방향이 theta. 마지막 30 cm(6 px)는 직선으로 붙는 느낌이면 좋음.
- 매 틱 OBB가 맵 밖으로 나가면 해당 스텝 취소하고 재계획 또는 정지.

## 로봇 크기 vs 스프라이트

- `robot.png` / `robot-2.png`: 20×16 px, 바디 ≈ 16×10, 좌우 휠 너브.
- 웹 렌더는 **맵 픽셀 1:1**로 그려서 충돌 박스와 시각이 맞다.
- waypoint/charger 아이콘은 가독성을 위해 24 px로 그려도 됨 (충돌은 점).
