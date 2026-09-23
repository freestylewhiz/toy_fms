# 작업 지침

@/home/dyhwang23/.codex/RTK.md

## 문서 구조와 지속적인 컨텍스트

문서 정본은 [docs/README.md](docs/README.md)이다. 앞으로 논의 결과와 구현 내용은
`docs/{concept,fms,web,robot}/{current,backlog,todo}/주제.md` 구조를 유지한다.

- `concept`: 통합 방향·공통 개념. `fms`: 서버·운영·트래픽. `web`: UI. `robot`: 로봇.
- `current`: 코드로 확인한 현재 구현과 현행 정책. 코드·검증 근거를 연결한다.
- `backlog`: 미구현 제안과 논의 질문. 문서만 보고 구현에 착수하지 않는다.
- `todo`: 사용자와 구현 범위·완료 기준을 합의한 작업만 등록한다.
- 2026-09-16 정리 시 모든 `todo`를 비웠으며 미착수 제안은 `backlog`로 통합했다.
- Git은 빈 디렉터리를 보존하지 않는다. 새 체크아웃에서 필요하면
  `mkdir -p docs/{concept,fms,web,robot}/todo`로 생성한다. 빈 폴더 유지용 문서는 넣지 않는다.
- 구현·검증 완료 후 `current`를 갱신하고 완료된 `todo`와 해결된 `backlog`를 정리한다.
- 에이전트별 문서, 핸드오프, 중복 과거 설계 폴더를 다시 만들지 않는다.
- 정책 변경의 날짜·이유·영향을 해당 주제에 기록한다. 사용자 최신 지시를 우선한다.

상세 관리 규칙: [문서 운영](docs/concept/current/documentation-policy.md).
Vikunja는 개발 아이템·진행 상태·첨부·검수 대화를, docs는 현재 동작·정책·논의의 본문을 관리한다.
컴포넌트 매핑은 concept → `FMS/planning`, fms → `FMS/server`, web → `FMS/web`, robot → `FMS/robot`이다.
Vikunja의 논의 카드가 To Do 상태여도 docs/todo로 자동 승격하지 않는다.

## 로봇 상태·점유·트래픽 작업 전 참고

관련 동작 변경 전 [운영 복구 정책](docs/fms/current/runtime-recovery.md),
[현행 트래픽](docs/fms/current/traffic.md), [로봇 통신 계약](docs/robot/current/protocol.md)을 읽는다.
후속 제안은 각 컴포넌트의 `backlog`에 분리되어 있다. 현재 구현과 미확정 제안을 혼동하지 않는다.
관련 결정이 바뀌면 현행 정책과 남은 논의도 함께 갱신한다.

## 작업 경로와 프로젝트 운영

- canonical 작업 경로: `/project_workspace/fms`
- 일상 진입 경로: `/project/workspace/fms` (canonical 경로의 심볼릭 링크)
- 원본 백업: `/home/dyhwang23/workspace/jsearch_rebuild_repo/working_directory/image_search/bg_fms_v1_new_ui`
- Vikunja 데이터와 Forgejo 운영 파일은 `/project_management` 아래에서 관리한다.
- Vikunja 분류: `FMS/planning`, `FMS/web`, `FMS/server`, `FMS/robot`.
- `planning`은 통합 논의·방향성, 나머지는 각 파트의 상세 작업이다. 분류명은 코드 디렉터리명(`web-client`, `server`, `virtual-robot`)을 바꾸지 않는다.

### Vikunja 카드 작업 원칙

- **카드**는 Vikunja에 등록된 개발 아이템을 뜻한다. docs/backlog의 계획·논의 문서와 구분한다.
- 기획·구현 후보 카드는 개발 승인 전에 등록할 수 있다. 실제 개발은 사용자와 포함 카드·범위·완료 기준을 합의한 뒤 시작한다.
  문서 선행 리뷰나 카드 등록 보류를 요청한 경우에는 docs의 해당 컴포넌트/backlog에만 작성하고 카드 등록 요청을 기다린다.
- 카드에는 성격에 따라 `기획` 또는 `구현` 라벨을 붙인다. 구현 후보도 `구현`으로 분류하되 이 라벨은 개발 승인이 아니다.
  구현 카드에는 현재 Project 값과 동일한 라벨(예: `fms/server`)도 붙이고 Project 변경 시 함께 갱신한다. 기존 주제 라벨은 유지한다.
- 모든 카드의 description 하단에는 `///////////////`로 앞뒤를 감싼 관련 문서 요약 스냅샷을 넣는다.
  기준일·원문 경로·배경·의도/방향·합의 범위와 미결정 사항을 기록한다. 기존 카드 보완 시에는 등록 시점이 아닌 보완 시점임을 명시한다.
  원문 갱신에 따라 기존 스냅샷을 덮어쓰지 않는다. 변경 합의는 날짜가 있는 추가 기록으로 남긴다.
- 개발 전 카드의 최신 합의·완료 기준과 최신 문서를 함께 확인하고 충돌을 먼저 정리한다.
  카드 생성·`To Do` 상태만으로 착수하거나 docs/todo로 자동 이동하지 않는다.
  구현·검증 후 근거를 남기고 `Review`로 옮긴다. 사용자 검토·최종 확인 후에만 `Done`으로 옮긴다.
  검토 중 수정 요청을 받으면 해당 카드를 `In Progress`로 되돌리고 수정·검증 후 다시 `Review`로 옮긴다.
- 텔레포터 논의 이력은 [리뷰 초안](docs/concept/backlog/teleporter.md)에서 관리하고, 구현된 정책은 [현재 문서](docs/concept/current/teleporter.md)에 기록한다.
  2026-09-16 사용자가 카드 확인 후 PILOT-13~16 구현을 승인했다. Luna가 개별 구현, Codex가 감사·조율·통합 검증을 담당한다.
  PILOT-13~16 구현은 완료되었으며, PILOT-17의 물리적 대기열 고도화는 후속 심층 논의다.
- 심층 논의 문서는 `DISC-NNN-영문주제.md`로 식별한다. `DISC`는 논의 분류, 숫자는 중복 없는 문서 ID이며 카드 ID와 별개다.
  첫 문서는 `docs/concept/backlog/DISC-001-teleporter-queue-management.md`다. 이동·이름 변경 시에도 코드는 유지한다.

Vikunja는 `http://192.168.0.172:3456`에서 운영한다. 카드·상태·라벨·첨부 변경은 Vikunja UI 또는 REST API로 수행한다. API 토큰과 MCP 토큰은 사용자별 최소 권한으로 만들고, 비밀값을 카드·저장소·출력에 기록하지 않는다. Backlog.md 서비스와 이관 원본은 2026-09-18에 제거했으며, Git 원격은 Forgejo를 사용한다.

논의 카드만으로 새 기능 구현을 시작하지 않으며 사용자 최신 지시를 우선한다. 논의는 planning에, 구현·검증은 해당 파트에 기록한다. 구현·검증 결과는 Review에서 사용자 검토를 거친 뒤 Done으로 확정한다.
