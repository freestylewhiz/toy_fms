# 작업 지침

@/home/dyhwang23/.codex/RTK.md

## 로봇 상태·점유·트래픽 작업 전 참고

로봇 상태, 점유 영속화/수동 해제, 운영 제외/재활성화, 주행 방식이나 트래픽 제어를
변경할 때는 먼저 [설계 기록](docs/design/robot-runtime-state.md)을 읽는다.
확정 요구사항과 잠정 제안을 구분한다. 문서에는 구현된 결정과 후속 확장안이 함께 있으며, 추후 모드 추가에 따라
수정할 수 있다. 관련 결정이 바뀌면 문서의 변경 이력과 미결정 항목도 갱신한다.
사용자의 최신 지시를 우선하고, 문서만으로 새 기능 구현을 시작하지 않는다.

## 작업 경로와 프로젝트 운영

- canonical 작업 경로: `/project_workspace/fms`
- 일상 진입 경로: `/project/workspace/fms` (canonical 경로의 심볼릭 링크)
- 원본 백업: `/home/dyhwang23/workspace/jsearch_rebuild_repo/working_directory/image_search/bg_fms_v1_new_ui`
- Backlog 데이터와 Forgejo 운영 파일은 `/project_management` 아래에서 관리한다.
- Backlog 분류: `fms/planning`, `fms/web`, `fms/server`, `fms/robot`.
- `planning`은 통합 논의·방향성, 나머지는 각 파트의 상세 작업이다. 분류명은 코드 디렉터리명(`web-client`, `server`, `virtual-robot`)을 바꾸지 않는다.

### Backlog 작업 원칙

대화 시작 시 `/project_management/infrastructure/backlog/backlog-cli instructions overview`를 읽고 현재 작업에 적용한다. 생성 전 `instructions task-creation`, 실행/상태 변경 전 `instructions task-execution`, 완료 전 `instructions task-finalization`을 읽는다. 작업 Markdown은 직접 편집하지 않고 CLI를 사용한다. 낯선 하위 명령은 `--help`로 확인한다. Backlog CLI는 `/project_management/pilot`에서 실행하고, Git 원격은 Forgejo를 사용한다.

논의 카드만으로 새 기능 구현을 시작하지 않으며 사용자 최신 지시를 우선한다. 논의는 planning에, 구현·검증은 해당 파트에 기록하고 완료한 작업은 검증 결과와 함께 Done으로 옮긴다.
