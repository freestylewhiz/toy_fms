# Codex 핸드오프 — bg_fms_v1_new_ui

이 폴더는 **Codex agent가 이어서 작업**할 때 읽는 진입점이다.  
초기 설계 합의(긴 스펙)는 Cursor 쪽을 참고하고, **현재 구현·갭·다음 할 일**은 여기 문서를 따른다.

| 문서 | 내용 |
|------|------|
| [`00_handoff.md`](./00_handoff.md) | **먼저 읽을 것** — 진행 상황, 제약, 백로그, 검증 |
| [`01_architecture.md`](./01_architecture.md) | 트리·포트·핵심 파일·데이터 흐름 |
| [`02_ux_edit_session.md`](./02_ux_edit_session.md) | 편집 세션 / 폴리곤 / 회전 UX (최근 작업) |

설계 원본(합의·IA·스키마 초안):

- [`../cursor/00_consensus.md`](../cursor/00_consensus.md)
- [`../cursor/01_design.md`](../cursor/01_design.md)
- [`../cursor/02_ui.md`](../cursor/02_ui.md)
- [`../cursor/03_implementation.md`](../cursor/03_implementation.md)

사용자 조작 설명: [`../../user/editor.md`](../../user/editor.md)  
루트 실행: [`../../../README.md`](../../../README.md)

## 한 줄 요약

원본 `bg_fms`를 건드리지 않고 복제한 **시맨틱 맵 에디터 시험 환경**.  
Colyseus + gRPC 유지, **MQTT 없음**, 에셋은 **SQLite**, 맵은 **yard 1600×1200**.  
웹은 운용 / 현장 배치 / VDA 배치 분리 + **편집 세션(확인/취소)** + 존 폴리곤(단순 링) + 포즈 회전.
