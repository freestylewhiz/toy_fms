# 00 — Codex handoff (진행 상황)

최종 갱신: 2026-09-14 (편집 세션·폴리곤 UX·회전 반영 직후)

작업 루트: `bg_fms_v1_new_ui/`  
원본 트리 `bg_fms/` 는 **수정하지 않는다** (병행 실행용 복제본).

---

## 1. 목표 (고정)

사용자가 원한 것:

1. 큰 심플 맵(직사각 홀 + 좁은 복도 + 교차)에서 로봇·리소스를 많이 놓을 수 있을 것
2. UI를 **운용 / 현장 배치 / VDA 배치**로 분리 — 명령(Move/Dock)과 저작을 섞지 말 것
3. 리소스 **배치·이동·회전·편집** + SQLite(또는 DuckDB) 영속 — **채택은 SQLite `bun:sqlite`**
4. Colyseus + gRPC 유지, **MQTT 없음**
5. VDA 시맨틱(node–edge, zoneSet, portal, rail, edge corridor 폭)을 맵에 그릴 수 있을 것

비목표 (요청 없으면 하지 말 것):

- MQTT / 실기 VDA 송신
- LIF import/export, NURBS
- occupancy 픽셀 페인트
- traffic_control v2 정책 구현 (문서는 원본/복사본에 있음, 코드는 v1 local_plan 유지)
- 커밋은 **사용자 요청 있을 때만**

언어/톤: 사용자 규칙상 응답은 **한국어 반말**. 스택은 bun + TS + FastAPI가 아니라 **bun + Colyseus + gRPC**.

---

## 2. 합의된 기술 결정

| 항목 | 값 |
|------|-----|
| 웹 | http://localhost:**5174** |
| Colyseus | **2568** / room `floor` |
| gRPC RobotBridge | **50062** |
| 맵 | `resources/maps/yard.png` **1600×1200**, 1px=5cm → 80m×60m |
| occupancy | `resources/maps/occupancy.bin` (+ inflated) |
| DB | `data/editor.sqlite` (gitignore), seed 1회 import |
| WS URL | `ws://${location.hostname}:2568` (127.0.0.1 브라우저용) |

원본 `bg_fms`: 5173 / 2567 / 50061 / 1st_floor 720×560.

---

## 3. 구현 완료 (P0+)

### 맵·서버·저장

- [x] `scripts/generate_yard_map.ts` → yard + occupancy + inflated
- [x] `shared/constants.ts` 맵/포트
- [x] `shared/store.ts` SQLite (waypoints, chargers, obstacles, zones, nodes, edges, stations, portals, rails)
- [x] Colyseus 스키마 확장 + `editorUpsert` / `editorDelete`
- [x] FloorRoom hydrate from sqlite; LIVE obstacle은 gRPC vote, **DB 복원 시 투표 없음**
- [x] `shared/polygon.ts` + `polygon.test.ts` (단순 폴리곤, append 교차 거부, CCW, centroid)
- [x] 서버 zone upsert 시 `isSimplePolygon` + `ensureCcw`

### 웹 UI

- [x] 모드 3종 레일 분리 (196px 라벨 레일)
- [x] pan/zoom (`camera.ts`), Grid occupancy overlay
- [x] 현장: wp / cs / obstacle / forbidden / prefer / avoid
- [x] VDA: node / edge / station + zoneSet 타입들 + portal / rail
- [x] 인스펙터·아웃라이너·레이어
- [x] **존 폴리곤 UX** (고무줄, Backspace 한 점, 첫 점 닫기, 라벨 이동, 정점/중점 핸들, self-intersection 거부)
- [x] **편집 세션** (배치/수정 → 미리보기 → 확인/취소). Enter 확인, Esc 취소
- [x] **포즈 회전** (노란 핸들 + Q/E ±15° + `[`/`]` ±5°)
- [x] 편집 중 dim + 하단 edit-chrome 바

### 문서

- [x] `docs/user/editor.md` (사용법, 편집 모드 포함)
- [x] `docs/agent/cursor/*` (초기 합의)
- [x] 이 Codex 핸드오프

---

## 4. 알려진 갭 / 버그

| 이슈 | 상태 | 메모 |
|------|------|------|
| 맵 전환 (1st_floor ↔ yard) | **미구현** | 사용자 요청 있음. occupancy/`MAP_WIDTH`가 컴파일 상수. per-map sqlite 또는 map_id 필요. gRPC MapChange 없음 |
| 원본 1st_floor를 선택 가능하게 | **미구현** | `resources/maps/1st_floor.png`는 있음. occupancy/seed는 yard 기준 |
| waypoint→node / charger→station 승격 | 미구현 | charger·station 테이블 병행 |
| 현장 corridor / complex | 미구현 | VDA RELEASE / LINE_GUIDED로 대체 중 |
| 존 lethal → occupancy extra | 미구현 | 트래픽 연결 안 됨 |
| Prefer/Avoid → A* cost | 미구현 | 배치만 |
| 폴리곤 언두 스택 | 얕음 | Backspace 한 점만 |
| 아웃라이너 즉시 갱신 | 간헐 | Colyseus onChange에 의존. 저장 후 리프레시로 확인된 적 있음 |
| Cursor Browser MCP 캔버스 클릭 | 취약 | 버튼/모드 검증만 신뢰. 픽셀 클릭은 사람·스크립트 |
| 좁은 뷰포트에서 fit 8% | UX | 임베디드 브라우저 폭이 작으면 맵이 썸네일처럼 보임 — `0` fit, 창 넓히기 |

---

## 5. 다음 우선순위 (제안)

사용자 맥락상 **맵 전환 + 1st_floor 유지**가 백로그 상단이다.

### P1 — 맵 카탈로그 / 전환

1. 맵 레지스트리: `yard` (1600×1200), `1st_floor` (720×560) — occupancy·png·seed 경로
2. 런타임 `mapWidth()`/`mapHeight()` (또는 active map 컨텍스트). `planner.ts` / `occupancy.ts` 상수 의존 제거
3. per-map DB (`data/maps/{id}.sqlite`) 또는 `map_id` 컬럼
4. UI 맵 셀렉터 + Colyseus `switchMap`
5. 가상 로봇 occupancy 리로드 + seed 텔레포트 (proto에 MapChange 없으면 추가 또는 Session 재연결 규약)
6. 기본 운용 기능은 **1st_floor에서도** Move/Dock/장애물/Grid가 동작해야 함

### P1 — 편집 UX 다듬기

- 편집 세션 중 인스펙터 ↔ 세션 양방향 동기
- 존 생성 초안도 라벨/정점 편집 후 확인 (이미 대부분 있음 — 회귀 테스트)
- 에이전트 테스트용 `window.__editorDebug` 훅 (캔버스 클릭 우회)

### P2

- 승격 UI (wp→node, cs→station)
- 스냅 격자 / 측정
- forbidden → inflated blocked 연동
- 레일 72px 아이콘 압축 (선택)

---

## 6. 실행·검증

```bash
# 터미널
bun run --cwd server start
bun run --cwd web-client start
bun run --cwd virtual-robot start -- --id robot-1
# optional robot-2

# 브라우저
http://localhost:5174   # 또는 http://127.0.0.1:5174

# 테스트
bun test shared/polygon.test.ts
bun run check:editor    # scripts/check_editor.ts
bun run occupancy       # yard 재생성
```

수동 스모크:

1. 운용 ↔ 현장 ↔ VDA 레일 전환
2. 현장 Waypoint 클릭 → 회전 핸들 → **확인** → 목록/DB에 남는지 새로고침
3. Forbidden 꼭짓점 → 닫기 → 확인. 교차 점 찍히면 거부
4. Select로 존 라벨 드래그 → 확인
5. Esc로 편집 취소

커밋: 사용자가 요청하기 전까지 **하지 말 것**.

---

## 7. 코드 진입점 (빠른 맵)

| 관심사 | 경로 |
|--------|------|
| 웹 메인·편집 세션 | `web-client/src/main.ts` |
| 캔버스 렌더·핸들 | `web-client/src/render.ts` |
| HTML 크롬·edit-chrome | `web-client/index.html` |
| 스타일 | `web-client/src/styles.css` |
| 폴리곤 기하 | `shared/polygon.ts` |
| SQLite | `shared/store.ts` |
| 시맨틱 타입 | `shared/semantic.ts` |
| editor messages | `server/src/editorHandlers.ts` |
| 스키마 투영 | `server/src/editorSync.ts`, `server/src/schema.ts` |
| 룸 | `server/src/rooms/FloorRoom.ts` |
| 맵 생성 | `scripts/generate_yard_map.ts` |
