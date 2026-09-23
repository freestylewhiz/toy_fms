# Vikunja API 호출 절차

2026-09-23 운영 서버 v2.6.0의 `/api/v1/docs.json`에서 확인했다.
서버 버전이 다르면 해당 서버의 `/api/v1/docs.json`을 먼저 확인한다.
이 문서의 숫자 자리표시는 조회 결과로 바꾸며 운영 ID를 고정하지 않는다.

## 연결과 도구

환경은 저장소 루트의 `.env.vikunja.example` 및
[연결 안내](../../../../docs/concept/current/agent-workflow.md)를 따른다.
아래 명령은 저장소 루트에서 실행한다. RTK가 있으면 명령 앞에 `rtk`를 붙인다.

```sh
python3 .agents/skills/fms-kanban/scripts/vikunja_api.py /info
python3 .agents/skills/fms-kanban/scripts/vikunja_api.py '/projects?page=1&per_page=50'
python3 .agents/skills/fms-kanban/scripts/vikunja_api.py '/labels?page=1&per_page=50'
```

도구는 Python 표준 라이브러리만 사용한다. 응답은 `{status, pagination, data}` JSON이다.
`pagination.total_pages` 또는 페이지 결과를 확인해 `page=2` 이후도 조회한다. 자동 재시도는 하지 않는다.
`/info`, `/docs.json`은 토큰 없이 조회 가능하다. 다른 경로는 `VIKUNJA_API_TOKEN`이 필요하다.
토큰을 인자로 넘기지 않는다. 사용자가 터미널에서 직접 연결을 확인할 때는 `--prompt-token`으로 숨김 입력할 수 있다.

## 프로젝트·카드·보드 찾기

| 작업 | 요청 |
| --- | --- |
| 프로젝트 목록 | `GET /projects?page=1&per_page=50` |
| 프로젝트 세부 정보 | `GET /projects/{project}` |
| 프로젝트 view 목록 | `GET /projects/{project}/views` |
| 카드 목록 | `GET /projects/{project}/views/{view}/tasks?page=1&per_page=50` |
| kanban bucket 목록 | `GET /projects/{project}/views/{view}/buckets` |
| 카드 세부 정보·모든 view의 bucket | `GET /tasks/{task}?expand=buckets` |
| 댓글 | `GET /tasks/{task}/comments` |
| 전체 라벨 / 카드 라벨 | `GET /labels` / `GET /tasks/{task}/labels` |

프로젝트의 `parent_project_id`로 FMS 하위인지 확인하고 제목으로 컴포넌트를 찾는다.
view의 `view_kind=kanban`, `bucket_configuration_mode=manual`인지 확인한다.
filter 기반 보드는 task 속성으로 열이 결정되므로 수동 bucket 이동을 사용하지 않는다.
bucket의 title을 `To Do`, `In Progress`, `Review`, `Done`과 대응시킨다.
완료 열의 실제 `done_bucket_id`도 확인한다. 보드가 예상과 다르면 임의 재구성하지 않는다.

카드 목록은 list view로 찾으면 다루기 쉽다. kanban view 결과는 bucket 안의 tasks로 반환될 수 있다.
표시 코드 `identifier`와 제목을 확인해 숫자 `id`를 얻는다. 프로젝트마다 카드 index가 같을 수 있다.

## 승인 범위 내 변경

JSON 본문은 임시 파일로 작성하고 `--body-file`로 전달한다. HTML description과 줄바꿈을
셸 문자열 조합으로 만들지 않는다. 도구는 JSON 객체/배열을 그대로 전송하며 스냅샷 자동 생성이나 상태 정책 판단은 하지 않는다.

| 작업 | 요청 | 주요 본문 |
| --- | --- | --- |
| 카드 생성 | `PUT /projects/{project}/tasks` | `title`, `description` |
| 카드 수정·프로젝트 이동 | `POST /tasks/{task}` | 최신 task의 편집 가능 필드를 보존하고 필요한 필드 변경 |
| bucket 이동 | `POST /projects/{project}/views/{view}/buckets/{bucket}/tasks` | `task_id`, `bucket_id`, `project_view_id` |
| 카드에 라벨 추가 | `PUT /tasks/{task}/labels` | `label_id` |
| 카드에서 라벨 제거 | `DELETE /tasks/{task}/labels/{label}` | 없음 |
| 새 라벨 생성 | `PUT /labels` | `title` (실제로 없고 필요한 경우) |
| 검증/합의 댓글 추가 | `PUT /tasks/{task}/comments` | `comment` |

예: 조회로 확인한 숫자 ID를 사용해 이동 본문을 `/tmp/fms-bucket-move.json`에 준비한 뒤 실행한다.

```sh
python3 .agents/skills/fms-kanban/scripts/vikunja_api.py \
  '/projects/PROJECT_ID/views/VIEW_ID/buckets/BUCKET_ID/tasks' \
  --method POST --body-file /tmp/fms-bucket-move.json
```

본문 형태는 `{"task_id": TASK_ID, "bucket_id": BUCKET_ID, "project_view_id": VIEW_ID}`다.
위 대문자 자리표시는 실제 JSON 숫자가 아니므로 조회한 ID로 치환해야 한다.
스킬의 승인 규칙을 만족한 상태 변경만 수행하고, 응답 후 task와 대상 보드를 재조회한다.

task의 `labels`, `attachments`는 일반 task 수정으로 갱신하지 않는다. 전용 엔드포인트를 사용한다.
전체 라벨을 교체하는 bulk API보다 해당 프로젝트 라벨의 추가/제거를 사용해 주제 라벨을 보존한다.
기존 description과 문서 스냅샷을 덮어쓰지 않는다. task 수정은 서버 버전에 따라 생략된 필드가
영향받을 수 있으므로 최신 데이터에서 편집할 필드만 변경한 본문을 준비하고, 쓰기 직전 `updated`가
달라졌으면 다시 병합한다. 이는 원자적 동시성 보장이 아니므로 변경 후에도 확인한다.

Review는 `done=false`여야 한다. 수정 요청으로 Done에서 되돌리는 경우도 완료 플래그를 해제했는지
확인한다. `done=true` 또는 done bucket으로의 이동은 사용자 최종 확인 후에만 한다.

## 첨부와 오류

첨부 목록은 `GET /tasks/{task}/attachments`, 업로드는 `PUT /tasks/{task}/attachments`다.
업로드는 multipart/form-data의 `files` 필드이며 JSON 도구는 지원하지 않는다.
Vikunja UI로 첨부하거나 해당 서버 명세에 맞는 multipart 클라이언트를 사용한다.
첨부 후 카드에서 파일명·다운로드 가능 여부를 확인한다.

- 401: 토큰 누락·만료 여부를 확인한다. GitHub PAT와 Vikunja 토큰은 별개다.
- 403: 해당 사용자/토큰의 프로젝트 접근 및 요청 동작 권한을 확인한다.
- timeout: 생성/수정이 서버에 반영됐는지 먼저 조회한다. 중복 카드를 만들지 않는다.
- 3xx: 도구는 인증 헤더를 다른 주소로 보내지 않도록 redirect를 따르지 않는다. `VIKUNJA_URL`을 실제 주소로 고친다.

연결 확인과 명세 조회만으로 카드 변경 권한이나 실제 쓰기 성공을 검증했다고 보고하지 않는다.
