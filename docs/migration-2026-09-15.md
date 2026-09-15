# 2026-09-15 작업 트리 이관 기록

## 경로

- 원본 백업: `/home/dyhwang23/workspace/jsearch_rebuild_repo/working_directory/image_search/bg_fms_v1_new_ui`
- canonical 작업 경로: `/project_workspace/fms`
- 사용자 진입 경로: `/project/workspace/fms` → `/project_workspace/fms` 심볼릭 링크
- 원본은 수정하지 않았다.

## 검증

정리 전 원본과 대상의 일반 파일 6,105개 SHA-256이 일치했고 심볼릭 링크 20개를 보존했다. 승인된 정리와 대상 DB checkpoint 뒤 최종 파일 집합은 달라졌다. 원본 Git 상위 저장소의 상태는 이관 전과 동일하다. 원본 트리의 빈 `.git`은 대상에서 제거했으며, Git 저장소 초기화와 GitLab 연동은 다음 작업일로 미뤘다.

대상 SQLite는 별도 연결로 무결성 검사를 통과했다. WAL checkpoint(TRUNCATE) 결과는 editor/runtime 모두 `0,0,0`이며, 테이블별 행 수는 checkpoint 전후 동일하다.

| DB | 테이블별 행 수 |
|---|---|
| `data/editor.sqlite` | chargers 1, edges 0, meta 3, nodes 0, obstacles 0, portals 0, rails 0, stations 0, waypoints 6, zones 2 |
| `data/runtime.sqlite` | robot_runtime 2, runtime_audit 20, runtime_occupancies 7 |

checkpoint 후 대상의 `*.sqlite-shm`, `*.sqlite-wal`은 남지 않았다. 원본 DB 해시는 검증 전후 동일하다. `data/before-driving-1789373410855.json`은 운영 전 상태 기록으로 보존했다.

## 정리한 항목

- 구 버전 중복 검증기 `scripts/check_workspace.ts`
- 중복 템플릿 `.codex/codex.config.template.toml` (루트 `codex.config.template.toml`은 보존)
- 생성 산출물 `share/map-noise-experiment/` 전체
- 참조되지 않은 스크린샷 `share/스크린샷 2026-09-15 11.10.17.png`
- 비어 있던 `.git`, `.agents` 디렉터리

스크린샷의 정확한 삭제 파일명은 `share/스크린샷 2026-09-15 11.10.17.png`이다.

생성 산출물 디렉터리는 `.gitignore`에 추가했다. 설치된 `node_modules`와 실행에 필요한 맵·occupancy 에셋, 활성 traffic 설계 문서는 유지했다.

## 운영 분류

Backlog 프로젝트 분류는 `fms/planning`, `fms/web`, `fms/server`, `fms/robot`을 사용한다. 이는 관리 분류이며 코드 디렉터리 `web-client/`, `server/`, `virtual-robot/`은 유지한다. GitLab 연동은 다음 작업일에 진행한다.

검증 보고서 [`fms-validation-2026-09-15.txt`](/project_workspace/fms-validation-2026-09-15.txt)의 disposable copy 검사에서 단위 67개, traffic-v1 11개, 브라우저 workspace/properties/runtime/driving E2E가 통과했다. runtime 관련 코드 59개 파일은 이관 전후 동일했고 대상 DB만 checkpoint했다.

## 다음 작업일 시작

`cd /project/workspace/fms`로 진입한다. 포트 5174를 사용하는 기존 원본 UI가 있으면 먼저 종료한 뒤 대상의 server, virtual-robot 2대, web-client를 시작한다. GitLab 연동과 Git 초기화는 확인 후 진행하며, Backlog CLI 지침을 먼저 읽는다.
