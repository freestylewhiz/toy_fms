# Large Lab — 1억 픽셀 테스트맵

2026-09-16 구현. 맵 ID는 large_lab이며 10,000×10,000 = 100,000,000픽셀이다.
기존 1px=5cm 기준에서 500×500m에 해당한다.

![중앙 기둥·회랑과 사분면별 방](../../../resources/maps/large_lab.preview.png)

## 공간 구성

- 중앙 (5000,5000)에 반경 1200px(60m)의 원형 기둥을 고정 장애물로 둔다.
- 기둥 바깥 반경 1600px(80m)까지 폭 400px(20m)의 원형 통로가 있다.
- 네 사분면에 약 175×175m의 방을 배치하고, 각 방을 벽으로 둘러싼다.
- 각 방의 중앙 방향 모서리는 폭 200px(10m)의 대각선 출입 통로로 회랑과 연결한다.
- 1사분면은 우상단, 2사분면 좌상단, 3사분면 좌하단, 4사분면 우하단이다.

기둥·벽은 배경 그림뿐 아니라 occupancy=0인 실제 지도 장애물이다.
원형 회랑은 지도상의 통행 공간이며 자동 정원 제한을 거는 semantic corridor 존은 아니다.
각 방의 q1-center~q4-center 목적지, 충전소 1개, 로봇 슬롯 2개를 시드로 제공한다.
상세 주행 시나리오와 존·장애물은 사용자가 편집해서 추가한다.

## 등록·실행

웹 맵 선택에서 Large Lab을 선택하거나 http://localhost:5174/?map=large_lab 로 진입한다.
yard와 별도 FMS 프로세스를 사용해 기존 데이터와 점유·주행 상태를 격리한다.

| 항목 | yard | large_lab |
| --- | --- | --- |
| Colyseus | 2568 | 2569 |
| gRPC | 50062 | 50063 |
| 편집·운영 DB | data/ | data/large_lab/ |
| 서버 실행 | PM2 `fms-yard-server` | PM2 `fms-large-lab-server` |
| 가상 로봇 1 | PM2 `fms-robot-1` | 텔레포터로 같은 프로세스가 전환 |
| 가상 로봇 2 | PM2 `fms-robot-2` | 텔레포터로 같은 프로세스가 전환 |

웹과 두 맵 FMS, 가상 로봇은 루트의 `bun run pm2:start`로 PM2가 관리한다. 맵 전환 시 이전 룸을 떠나 새 서버로 연결하며, 로봇 프로세스도 텔레포터 핸드오프에서 목적지 FMS로 전환한다.
새로고침은 URL의 map 선택을 유지한다. 1st_floor는 계속 읽기 전용이며 FMS 서버에 연결하지 않는다.
다중 맵을 한 서버에서 운영하거나 로봇이 맵 사이를 이동하는 기능은 별도 논의 범위다.

## 자산과 대형 맵 처리

bun run maps:large-lab으로 PNG, preview, occupancy, clearance, seed를 다시 생성한다.
생성기는 기존 SQLite 편집 결과를 덮어쓰지 않는다.
자산은 resources/maps/large_lab.*에 있다. 원본 PNG는 10,000×10,000이다.
occupancy와 inflated 파일은 각각 100,000,000바이트이며 좌표 판정은 원해상도를 사용한다.
큰 맵의 clearance는 반경 8px 정사각 침식으로 보수적으로 생성한다.

브라우저 배경 preview와 청사진·점유 오버레이는 최대 2048px 수준으로 줄여 그린다.
따라서 렌더링은 원본 픽셀을 모두 표시하는 방식이 아니며, 리소스 좌표·배치 검사는 원해상도다.
2026-09-22부터 기본 계획은 [16px 축소 격자](../../robot/current/coarse-map-planning.md)를 우선 사용한다. 원해상도 fallback A*는 방문 셀만 기록해 요청마다 1.2GB 이상 초기화하던 배열 할당을 피한다.
긴 우회 경로·다수 로봇·많은 존의 성능 한도는 아직 검증하지 않았다.

## 검증

- scripts/large_lab.test.ts: 1억 셀, 기둥·벽, 네 출입로, 원형 통로 연결, clearance 검증.
- web-client/src/camera.test.ts: 전체 보기 배율에서 자연스러운 축소와 줌 기준점 유지.
- bun run check:large:web: 브라우저 편집·저장·새로고침, DB 저장, yard 격리,
  중앙 기둥 배치 거부, 맵 왕복 전환, 오버레이, 가상 로봇 상태 및 24px 이동 확인.

브라우저 검사는 두 FMS 서버·웹·large_lab의 유휴 robot-1이 필요하며 실제 로봇을 짧게 이동시킨다.
로컬 검증에서 맵 로딩 후 목록 표시는 약 1.2초였다. 이는 이 장비의 측정이며 성능 보증은 아니다.

근거: [맵 프로필](../../../shared/maps.ts), [생성기](../../../scripts/generate_large_lab.ts),
[브라우저 검사](../../../web-client/check_large_map.ts).
