# 에이전트 합의 (총감독)

세 문서: [`01_design.md`](./01_design.md) (IA), [`02_ui.md`](./02_ui.md) (크롬), [`03_implementation.md`](./03_implementation.md) (스키마).
총감독이 받아들여 **구현에 반영한 것**과, 일부만 받은 것을 적는다.

---

## 전원 동의 → 채택

| 항목 | 결정 |
|------|------|
| 통신 | MQTT 없음. Colyseus WS + gRPC 유지 |
| DB | **`bun:sqlite`**. DuckDB는 에디터 정본이 아님 (OLAP·네이티브 애드온). 나중에 분석용으로 SQLite를 읽을 수는 있음 |
| 모드 | **운용 / 현장 배치 / VDA 배치** 배타. 명령 툴과 배치 툴을 한 레일에 두지 않음 |
| 정본 | occupancy bin = 기하, SQLite = 에셋, Colyseus = 세션 투영, gRPC pose = 로봇 |
| 포트 | 2568 / 50062 / 5174 (원본 bg_fms와 병행) |
| 가변 기하 | Colyseus·SQLite 모두 JSON 문자열 (폴리곤, 궤적, corridor) |
| 장애물 LIVE | gRPC `place_query` 유지. **기동 복원은 투표 없음** |
| 비목표 | MQTT, LIF 파일, NURBS export, occupancy 페인트, 트래픽 정책 변경 |

---

## 총감독이 조정한 것

| 쟁점 | 디자인 | 구현 | **채택** | 이유 |
|------|--------|------|----------|------|
| 맵 크기 | 1600×960 | 1280×800 | **1600×1200** (80m×60m) | 사용자가 로봇을 더 넣을 큰 맵을 요청. inflate 1s 안에 끝남 |
| 교차 | T + 남쪽 포켓 / +자 | +자 | **홀 + 가로 복도 48px + 세로 복도 48px = + 교차** | 심플 테스트 야드 |
| 레일 폭 | 디자인 72px 아이콘 | — | **196px 라벨 레일** | VDA 존 타입이 많아 아이콘만으로는 못 읽음. 02의 72px은 후속 압축 후보 |
| 충전소 한 줄 | 현장/VDA가 같은 행 | 테이블 분리 가능 | **charger 테이블 + VDA station 테이블 병행** | 스프린트에서 승격 UI를 안 넣음. 두 벌이 될 수 있음 → 후속 |
| 장애물 SQLite | 디자인: 넣지 않음 | 구현: 넣음 | **넣음** | 사용자가 모든 리소스 배치·재시작 유지를 요청 |

---

## 구현된 P0

- yard.png + occupancy.bin (큰 홀, 좁은 복도, 십자 교차)
- SQLite `data/editor.sqlite`, seed 1회 import
- Colyseus Zone/Node/Edge/Station/Portal/Rail + `editorUpsert` / `editorDelete`
- 웹: 세 모드, pan/zoom, 현장(wp/cs/obs/forbidden/prefer/avoid), VDA(node/edge/station + zoneSet 타입 + portal/rail), 인스펙터, 아웃라이너, 레이어

## 다음 스프린트 (합의했지만 이번엔 얕게)

- 폴리곤 정점 드래그 (지금은 다시 그려 덮어쓰기)
- waypoint → node, charger → station 승격
- 현장 `corridor` / `complex` (지금은 VDA RELEASE / LINE_GUIDED 로 그림)
- `vehicleTypeId`, 스냅 격자, 측정 툴
- 존 lethal을 occupancy extra에 넣기 (트래픽 연결)
