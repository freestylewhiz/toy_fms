# 02 — 편집 세션 · 폴리곤 · 회전 UX

최근(2026-09-14) Cursor 세션에서 넣은 UI 동작. Codex가 건드릴 때 회귀를 깨지 말 것.

---

## 문제였던 것

1. 클릭 순서 좌표 배열만으로 존을 그리면 실수 시 전체 재시작, 교차 시 나비(bowtie) 발생
2. 배치가 pointerup에 **즉시 서버 커밋**되어 되돌리기 어려움
3. 존을 잡고 옮길 **라벨/핸들**이 약했음
4. 회전이 드래그 헤딩에만 의존

레퍼런스: Mapbox GL Draw / OSM iD / Terra Draw / Leaflet-Geoman  
→ 단순 폴리곤, 정점·중점, 피처 이동, self-intersection 거부.

---

## 편집 세션 (`editSession`)

`web-client/src/main.ts`

```
배치 도구 클릭 또는 Select로 기존 리소스 선택
  → editSession (pose | zone), create | modify
  → 맵 dim + 하단 #edit-chrome (확인 / 취소)
  → 확인(Enter) 때만 place*/editorUpsert/move*
  → 취소(Esc) 시 세션 폐기
```

- 운용 **Move/Dock** 은 세션 밖 (즉시 명령). `poseDraft`는 명령용만.
- 편집 중 모드/도구 전환은 세션 취소.

포즈 세션:

- `drawPoseEditor` — 링 + 헤딩 + 노란 회전 점 (`POSE_ROTATE_R`)
- `hitPoseEditor` — body / rotate
- obstacle은 size 드래그 유지
- 키: Q/E, `[`/`]`

존 세션:

- 그리기: `draftPoly` + `canAppendVertex` (교차면 점 거부, 빨간 고무줄)
- 닫기(첫 점/Enter/더블클릭) → create zone 세션 (확인 전 미저장)
- modify: 라벨 드래그 = translate, 정점/중점 = reshape → 확인 시 persist
- 서버: `isSimplePolygon` + `ensureCcw`

관련:

- `shared/polygon.ts`
- `web-client/src/render.ts` — labels, handles, dimOthers, hideId
- `web-client/index.html` — `#edit-chrome`
- `server/src/editorHandlers.ts` — zone validation

---

## 에이전트 브라우저 테스트 주의

Cursor IDE Browser MCP는:

- 모드 버튼·툴 버튼·아웃라이너 클릭: OK
- `<canvas>` 월드 좌표 클릭: **불안정** (스크린샷 좌표 스케일, localhost vs 127.0.0.1)

권장:

- 기하/저장: `bun test shared/polygon.test.ts`, `bun run check:editor`
- UI 회귀: 사람 스모크 또는 향후 `window.__editorDebug.placeZone([...])` 같은 훅

---

## 의도적으로 남긴 UX 선택

- 존 **면 내부 드래그로 이동하지 않음** (팬과 충돌) — **라벨만** 이동 핸들
- 편집 중 레일/모드 세그먼트 `pointer-events: none` + 뷰포트 골드 아웃라인
- 생성 직후 목록 갱신은 Colyseus state onChange에 의존
