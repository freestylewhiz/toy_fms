# 다른 PC의 에이전트·칸반 작업 환경

2026-09-23: GitHub 체크아웃에서 기존 작업을 이어가기 위해 프로젝트 스킬과 접속 절차를 공유한다.
개인 PC의 Codex 설치·인증·토큰을 복제하지 않고 프로젝트 규칙만 Git에 보존한다.

## 체크아웃과 스킬

GitHub 저장소는 <https://github.com/freestylewhiz/toy_fms>다. 원하는 디렉터리에 clone하고
저장소 루트에서 에이전트를 시작한다. 기존 서버의 `/project_workspace/fms`나
`/home/dyhwang23/.codex` 경로를 새 PC에 만들 필요는 없다.
실행 의존성·Large Lab 자산 준비는 [README](../../../README.md#실행)를 따른다.

공유 스킬은 [.agents/skills/fms-kanban/SKILL.md](../../../.agents/skills/fms-kanban/SKILL.md)다.
Codex는 저장소의 `.agents/skills`를 검색하며 `$fms-kanban`으로 명시 호출할 수 있다.
나타나지 않으면 저장소 위치에서 새 세션을 시작한다. 다른 에이전트는 `AGENTS.md`의 링크를 통해
같은 `SKILL.md`를 읽는다. [공식 스킬 안내](https://learn.chatgpt.com/docs/build-skills).

예시 요청:

- `$fms-kanban으로 FMS/robot의 Review 카드를 요약해줘.`
- `$fms-kanban으로 이 논의를 planning 후보 카드에 등록해줘. 개발은 아직 시작하지 마.`
- `$fms-kanban으로 합의한 카드의 구현·검증 결과를 남기고 Review로 옮겨줘.`

`.codex/config.toml`은 PC별 선택 설정이며 공유 스킬을 사용하기 위한 필수 파일이 아니다.
필요하면 루트 `codex.config.template.toml`의 필요한 부분만 병합한다. 기존 개인 설정을 덮어쓰지 않는다.
RTK는 선택 도구다. 설치되어 있으면 실행 명령 앞에 `rtk`를 붙이고, 없으면 원래 명령을 실행한다.

## 같은 칸반 서버에 연결

Vikunja 운영 주소는 `http://192.168.0.172:3456`이며 2026-09-23 `/api/v1/info`에서 v2.6.0을 확인했다.
이 주소는 사설망이므로 새 PC에서 같은 네트워크 또는 해당 서버로 연결되는 VPN 경로가 필요하다.
외부 접속용 주소가 따로 있으면 `VIKUNJA_URL`을 그 주소로 지정한다. API 접두사 `/api/v1`은 붙이지 않는다.
Git clone은 칸반 DB·계정·첨부를 복제하지 않는다. 같은 기록을 이어가려면 기존 Vikunja에 접속해야 한다.

웹 UI를 사용하면 해당 서버의 사용자 계정으로 로그인한다. API를 사용할 경우 그 사용자의
Vikunja API 토큰을 생성하고 작업에 필요한 프로젝트 조회/카드/라벨/댓글 권한을 설정한다.
첨부 업로드를 사용할 때는 첨부 권한도 필요하다. GitHub PAT와 Vikunja API 토큰은 서로 다르다.
관리자 계정이나 서비스 DB에 직접 접근할 필요는 없다. 별도 MCP도 필수가 아니다.

주소·토큰을 에이전트 프로세스의 환경 변수로 제공하거나 아래 선택적 로컬 파일을 사용한다.

```sh
umask 077
cp -n .env.vikunja.example .env.vikunja.local
# .env.vikunja.local의 주소와 토큰을 로컬 편집기로 입력한다.
set -a
. ./.env.vikunja.local
set +a
python3 .agents/skills/fms-kanban/scripts/vikunja_api.py /info
python3 .agents/skills/fms-kanban/scripts/vikunja_api.py '/projects?page=1&per_page=50'
```

이 예시는 Bash/POSIX 셸 기준이다. 로컬 환경 파일은 자동으로 로드되지 않으며 직접 설정해야 한다.
스킬의 Python 클라이언트는 Python 3 표준 라이브러리만 사용한다.
사용자 터미널의 일회성 확인은 `--prompt-token`으로 토큰을 숨김 입력할 수 있다.
실제 토큰이나 로컬 파일 내용을 채팅·로그에 출력하지 않는다.
`.env.vikunja.example`에는 빈 토큰만 넣고 `.env.vikunja.local`과 `.codex/`는 Git에서 제외한다.

프로젝트·칸반 view·bucket·label ID는 실행 시 조회한다. 표시 코드의 숫자를 API ID로 간주하지 않는다.
상세 호출과 pagination은 [스킬 API 절차](../../../.agents/skills/fms-kanban/references/vikunja-api.md)에 있다.

## 문서·카드 연결과 권한

정본은 [문서 운영 정책](documentation-policy.md)이다. 카드 생성이나 To Do 상태는 개발 승인이 아니다.
합의된 개발은 In Progress, 구현·검증 완료는 Review, 사용자 최종 확인 후 Done이다.
필요한 합의·검증 기록과 문서 요약 스냅샷을 보존한다. 새 PC의 절대 경로 대신 `docs/...` 저장소
기준 경로를 링크하고 필요하면 Git 커밋을 함께 기록한다. 기존 카드의 과거 스냅샷 경로는 변경하지 않는다.

접속 불가나 권한 부족일 때는 실제 카드 변경을 완료했다고 보고하지 않는다.
프로젝트 소스의 커밋·푸시는 칸반 상태 변경이나 사용자 검수를 대신하지 않는다.
GitHub clone의 `origin`은 GitHub다. 기존 운영 체크아웃은 Forgejo `origin`과 GitHub `github`이
함께 있으므로 푸시 전 `git remote -v`로 대상을 확인한다.

## 검증 범위

2026-09-23 `quick_validate.py`의 스킬 문법 검사와 JSON 클라이언트의 격리 HTTP 검사 6개를 통과했다.
인증 헤더·pagination, JSON 줄바꿈/한글 보존, 403 시 중복 쓰기 방지, redirect 차단,
토큰 누락/잘못된 경로 차단, 익명 info 조회를 확인했다.

```sh
python3 -m unittest discover -s .agents/skills/fms-kanban/scripts -p 'test_*.py' -v
```

운영 서버에서는 공개 info/명세를 읽기만 했으며 테스트 카드를 생성하거나 상태를 변경하지 않았다.
인증된 카드 읽기·쓰기는 새 PC의 사용자별 토큰 설정 후 실제 요청 결과로 확인해야 한다.
