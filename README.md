# FMS v1 — 테스트 야드

시맨틱 리소스 맵 에디터와 가상 로봇을 포함한 FMS 구현 프로젝트다.

| 구성 | 기본 주소/포트 |
|--|--|
| 웹 | http://localhost:5174 |
| Colyseus | 2568 |
| gRPC | 50062 |
| 맵 | `yard.png` 1600×1200 |

MQTT 없음. 브라우저 ↔ FMS 는 Colyseus, 로봇 ↔ FMS 는 gRPC.

자세한 조작: [`docs/user/editor.md`](docs/user/editor.md).  
주행·트래픽 제어와 테스트 배치: [`docs/user/driving.md`](docs/user/driving.md).  
gRPC 명령·브라우저 상태 연동: [`docs/robot-state-sync.md`](docs/robot-state-sync.md).  
구현 구조와 데이터 흐름: [`docs/architecture.md`](docs/architecture.md).
검증 절차: [`docs/testing.md`](docs/testing.md).
맵·주행 기준: [`docs/map-and-motion.md`](docs/map-and-motion.md).

## 후속 설계 기록

[로봇 상태·점유 복구·주행 방식 설계](docs/design/robot-runtime-state.md) —
구현된 상태·점유 복구 규칙과 향후 그래프/VDA 확장안을 분리한 기준 문서.

## 실행

루트에서 터미널 4개:

```
bun run --cwd server start
bun run --cwd web-client start
bun run --cwd virtual-robot start -- --id robot-1
bun run --cwd virtual-robot start -- --id robot-2
```

브라우저: http://localhost:5174

맵을 다시 만들 때: `bun run occupancy` (`scripts/generate_yard_map.ts`).

운영 DB: `data/runtime.sqlite` — 로봇 운영 제외 설정, 구역 점유·예약·대기열, 복구 감사 기록.
검증: `bun test`, `bun run check:runtime:web` (유휴 가상 로봇 한 대 사용).

에셋 DB: `data/editor.sqlite` (gitignore). 지우면 다음 기동에 `seed.json` 을 다시 넣는다.

프로젝트 운영 분류는 Backlog에서 `fms/planning`, `fms/web`, `fms/server`, `fms/robot`을 사용한다. 코드 디렉터리 이름은 `web-client/`, `server/`, `virtual-robot/`을 유지한다.

## 내일 작업 시작

```sh
cd /project/workspace/fms
```

기존 원본 UI가 웹 포트 5174를 사용 중이면 먼저 종료한 뒤 새 작업 트리를 시작한다. 새 프로세스를 자동으로 종료하거나 시작하지 않는다. 의존성이 없는 경우 루트와 `server/`, `web-client/`, `virtual-robot/`에서 각각 `bun install`을 실행한다.

이관·정리 기록은 [`docs/migration-2026-09-15.md`](docs/migration-2026-09-15.md), 검증 결과는 [`fms-validation-2026-09-15.txt`](/project_workspace/fms-validation-2026-09-15.txt)다.
