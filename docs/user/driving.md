# 주행모드와 트래픽 제어

주행 맵은 `yard`다. `1st_floor`는 읽기 전용 미리보기다.

## 시작

서버를 시작하기 전에 `bun run setup:driving`을 실행한다. 기존 SQLite 배치를
`data/before-driving-<timestamp>.json`에 백업하고 `drive-*` 목적지 6개와
`drive-corridor` 존을 추가한다. 같은 ID의 주행용 리소스는 다시 실행하면 갱신된다.
그 외 기존 리소스는 유지한다.

각 터미널에서 실행한다.

```sh
bun run server
bun run web
bun run robot-1
bun run robot-2
```

브라우저에서 http://localhost:5174 를 열고 **운용**을 선택한다.
로봇 카드를 선택한 뒤 **이동**으로 목적지 또는 빈 위치를 지정한다.
**도킹**은 충전소를 선택한다. **선택 로봇 주행 취소**는 현재 명령을 취소한다.
연결이 끊긴 로봇에는 명령을 보낼 수 없다.

## 주행에 적용되는 존

| 존 | 동작 |
|---|---|
| forbidden / blocked | 로봇 몸체 반경까지 확장한 진입 금지 영역 |
| prefer / priority | 경로 비용 감소, 강제 경로 추종은 아님 |
| avoid / penalty | 경로 비용 증가, 필요하면 통과 가능 |
| speed_limit | `maximumSpeed`(m/s)로 실제 주행 속도 제한 |
| corridor / complex / release | `capacity`(기본 1)에 따른 진입 허가·대기 |

용량 존은 로봇의 접근 경로를 보고 먼저 예약한다. 허가가 없거나 갱신이 끊기면
경계 밖에서 기다린다. 몸체와 진입 예정 경로가 존을 벗어나면 다음 로봇에 넘긴다.
존 안에 정차한 로봇은 계속 점유한다. 특히 연결이 끊긴 로봇의 예약은 연결 복구 후
실제로 비웠음을 확인하기 전까지 유지한다.

기본 배치의 오른쪽 좁은 복도 전체는 용량 1이다. 복도 내부 목적지에서 정차하면
다른 로봇은 계속 기다리므로, 먼저 들어간 로봇을 `drive-corridor-entry`로 되돌리면
다음 로봇이 진입할 수 있다. 홀에서는 기존 `local_plan_v1` 경로 공유와 교착 회피가
동작한다. 정책 변경은 서버와 로봇 모두 같은 `TRAFFIC_POLICY_ID`로 실행한다.

VDA node/edge/rail/portal과 방향·액션 등 나머지 속성은 편집 메타데이터다.
VDA 주문 실행, rail 강제 추종, v2 시공간/ORCA 제어까지 구현한 것은 아니다.

## 검증

```sh
bun test
bun run smoke
bun run check:driving:resources
bun run test:traffic-v1
```

실제 서버·가상 로봇이 켜져 있는 환경에서는 다음을 추가로 실행한다.
실제 명령을 보내는 검사이므로 테스트 중 다른 운용 명령을 보내지 않는다.

```sh
bun run check:driving:live
bun run check:driving:web
```

라이브 검사는 근처 이동의 도착·최종 각도·취소를 확인한다. 웹 검사는
Playwright와 Chromium 설치가 필요하다. 2026-09-15 검증에서는 disposable copy에서 실제 gRPC·브라우저 연결 검증을 통과했다. 상세 결과는 [`docs/testing.md`](../testing.md)를 본다.
