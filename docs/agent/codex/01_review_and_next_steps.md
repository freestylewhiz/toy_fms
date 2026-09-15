# 현재 구현 검토 및 다음 작업

> 역사 기록 (2026-09-14). 현재 기준은 [`../../../README.md`](../../../README.md)와 [`../../testing.md`](../../testing.md)다.

최종 갱신: 2026-09-14

## 확인한 현재 상태

- Canvas 기반 편집 UI가 동작한다.
- `운용 / 현장 배치 / VDA 배치` 모드가 분리되어 있다.
- pose 편집 세션은 확인/취소, 이동, 회전, 장애물 크기 조정을 지원한다.
- zone 편집 세션은 단순 폴리곤, self-intersection 거부, 라벨 이동, 정점/중점 핸들을 지원한다.
- 리소스는 SQLite에 저장되고 Colyseus state로 브라우저에 투영된다.
- gRPC 로봇 연결과 traffic 구현은 이번 UI 작업의 범위 밖이며 변경하지 않는다.
- Playwright로 현재 페이지를 열었을 때 Canvas 1개, Colyseus online, 콘솔 오류 없음이 확인됐다.

## 확인된 문제

1. ~~`MAP_WIDTH`, `MAP_HEIGHT`, occupancy 경로가 yard 기준 상수라 실제 맵 전환이 아직 불가능하다.~~ UI 카탈로그 기준으로 `yard`/`1st_floor` 배경과 occupancy를 전환하도록 구현했다. 현재 Room/SQLite 계약 때문에 `1st_floor`는 읽기 전용 미리보기다.
2. `resources/maps/seed.json`의 `wp-3 (1300, 200)`는 현재 occupancy에서 free가 아니며 smoke 경로가 실패한다.
3. prefer/avoid zone은 저장·표시되지만 A* 비용에 연결되어 있지 않다.
4. 편집 리소스와 운용 명령의 시각적 분리는 있으나, 우측 도크가 복잡해 선택·속성 수정의 흐름이 길다.
5. Canvas 픽셀 좌표를 직접 클릭하는 자동 테스트는 취약하므로 향후 debug API 또는 월드 좌표 기반 테스트 도우미가 필요하다.

## 우선순위

### P0: UI 동선 재설계

- 맵 컨텍스트를 상단에 고정
- 모드별 목적 설명을 추가
- 우측 도크에 시각적 그룹 계층을 부여
- 편집 세션 상태를 더 강하게 표시

### P1: 맵 컨텍스트와 카탈로그

- `yard`, `1st_floor` 메타데이터를 `web-client/src/main.ts`의 카탈로그에서 관리 — 완료
- 맵 선택 UI와 읽기 전용 보호 — 완료
- 다음 단계는 DB/Room 상태까지 map_id로 분리하는 additive 서버 설계

## 이번 단계 구현 파일

- `web-client/index.html`, `web-client/src/styles.css`: 상단 맵 선택기와 맵 컨텍스트/HUD
- `web-client/src/main.ts`: 맵 로딩, occupancy 전환, read-only 보호, yard 복귀
- `web-client/src/render.ts`: 맵별 캔버스 크기 렌더링
- `scripts/generate_floor_assets.ts`: `1st_floor` occupancy/inflated occupancy 생성
- `resources/maps/1st_floor.occupancy*.bin/json`: 맵 전환용 산출물

### P1: 검증 안정화

- seed 좌표를 occupancy 생성 결과와 검증
- 서버 실행 전 `check:editor`가 실패하는 이유를 문서화
- Playwright로 DOM 제어 가능한 UI smoke 추가

### P2: 편집 결과를 주행 정책에 연결

- obstacle과 forbidden을 planner의 extraBlocked에 반영
- prefer/avoid factor를 planner cost에 반영
- VDA edge/zone의 의미 검증 추가
