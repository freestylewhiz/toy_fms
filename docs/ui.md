# Web Client UI (역사 문서)

현재 UI의 실행 포트는 5174이며, 최신 사용자 조작과 화면 기준은 [`docs/user/editor.md`](user/editor.md)를 따른다. 이 문서는 초기 UI 설계 기록이다.

다크 산업형 FMS 콘솔. 클릭만으로 배치·이동·명령이 끝나야 한다.

## 레이아웃

- 상단 바: 제목 `bg_fms · 1st Floor`, Colyseus 연결 점(녹/빨), 선택 중인 로봇 id
- 왼쪽 툴바 (세로 아이콘):
  1. **Select** (V) — 드래그로 에셋 이동, 클릭으로 선택
  2. **Waypoint** (W) — 맵 흰 영역 클릭 시 새 웨이포인트. 클릭 후 드래그로 theta
  3. **Charger** (C) — 동일, 충전소
  4. **Move** (M) — 로봇 선택 후 웨이포인트 클릭, 또는 **흰 바닥을 클릭**해서 좌표로 이동. 클릭 후 드래그하면 도착 헤딩
  5. **Dock** (D) — 로봇 선택 후 충전소 클릭 → `commandRobot dock`
  6. **Obstacle** (O) — 오른쪽에서 △/□/○ 고른 뒤, 맵 **아무 픽셀**이나 클릭(중심) 후 드래그(크기). 벽/회색이 포함돼도 됨. 크기 10–80 px. 원은 회전 무시.
     - 로봇 몸체나 **앞으로 5초 경로**를 가리면 서버가 거절
     - 선택 후 본체 드래그=이동, 흰 핸들 드래그=크기. 인스펙터 x/y/size/θ
     - Delete / 인스펙터 **장애물 삭제**
  7. **Grid** (G) — occupancy 레이어 토글: off → occupancy.bin → occupancy_inflated.bin
     - teal = free / robot-safe
     - gold = inflate 여유(흰 바닥이지만 몸체가 못 감)
     - 어두운 오버레이 = blocked
     - 층 이미지 위에 반투명으로 겹침
- 중앙: 맵 캔버스. `1st_floor.png`를 1:1 또는 contain 스케일. 마우스 좌표는 맵 픽셀로 변환.
- 오른쪽 인스펙터:
  - 로봇 카드 2장: id, status 뱃지, x/y/theta, **이 로봇 선택** 버튼
  - Obstacle shape: 삼각형 / 사각형 / 원
  - 선택된 에셋의 x,y,theta 숫자 + theta 슬라이더 (-π~π)
  - 장애물 선택 시 삭제 버튼
  - Cancel 주행 버튼
- 하단: 마지막 에러/ack 한 줄

## 맵 인터랙션

- 흰 영역이 아닌 곳에 놓으면 스냅하지 말고 거절 + 빨간 플래시
- 웨이포인트/충전소는 아이콘 24px, theta만큼 회전
- 로봇은 스프라이트 20×16, 1:1 픽셀, status=move면 살짝 펄스
- 호버 시 id 라벨
- 드래그 중 고스트 아이콘
- 주행 중 계획 경로는 로봇 색 **점선**. 흰 바닥에서 보이라고 얇은 어두운 외곽선을 깔고, 코너에 작은 점을 찍는다. 면적으로 칠하지 않아서 맵은 그대로 읽힌다.
- 동적 장애물은 분홍 반투명 △/□/○. 선택되면 테두리가 굵어지고 크기 핸들이 생긴다. 벽 픽셀을 포함해도 된다.

## 에셋 경로 (web-client가 서빙)

- `/resources/maps/1st_floor.png`
- `/resources/images/waypoint/waypoint.png`
- `/resources/images/charing-station/charging_station.png`
- `/resources/images/robots/robot.png`
- `/resources/images/robots/robot-2.png`

`bun.serve`에서 `../resources`를 `/resources`로 마운트.

## Colyseus JS

- `colyseus.js` Client `ws://localhost:2568`
- `getStateCallbacks` 또는 `room.state.robots.onAdd/onChange`로 렌더
- CORS 없음 (같은 머신, WS는 다른 포트 — Colyseus는 기본적으로 브라우저 WS 허용)

## 스택

순수 HTML/CSS/TS. 프레임워크 없이 bun이 `index.html` + `src/main.ts`를 서브. 원하면 bun.build로 번들.
