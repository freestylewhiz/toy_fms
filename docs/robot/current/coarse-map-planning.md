# 축소 격자 패스 플래닝

2026-09-22 최초 구현·검증 후 사용자 운용검수의 동적 장애물 정체를 추가 수정했다. [동적 장애물 계획·복구](dynamic-obstacle-recovery.md)가 최신 동적 안전·재시도 정책이다. [ROBOT-9](http://192.168.0.172:3456/tasks/44)의 최종 검수 상태를 확인한다.
통합 논의는 [PLAN-17](http://192.168.0.172:3456/tasks/43)과 [알고리즘 조사](../../concept/backlog/path-planning-optimization-survey.md)에 남긴다.
사용자는 이번 축소 격자 방안만 우선 개발하도록 승인했다. 구현은 Luna high 두 에이전트가 코드/검증을 분담했고 Astra high가 최종 조율·코드 리뷰·통합 검증을 수행했다. 다른 알고리즘은 후속 보류다.

## 동작과 좌표

- yard와 large_lab 모두 플래너 내부에서 기본 16px(80cm) 격자를 먼저 탐색한다. 원본은 1px=5cm이며 원본 지도 자산·FMS·로봇·UI 좌표는 바뀌지 않는다. LargeLab은 10000²에서 625²(390625) 탐색 셀로 줄어든다. 원본 지도는 안전 검사/fallback용으로 계속 메모리에 유지하므로 전체 메모리가 256분의1이 된다는 뜻은 아니다.
- 원본 occupancy의 판정은 Math.round이다. coarse 셀 c는 정수 픽셀 c×16..(c+1)×16−1을 소유하고 연속 범위는 c×16−0.5..(c+1)×16−0.5다. 셀 중심은 c×16+7.5이며 끝부분 셀은 실제 유효 폭/높이로 중심을 계산한다. 반환 display/follow는 모두 원본 픽셀 좌표다.
- 안전하게 연결 가능한 소수 시작/목표를 유지한다. 임시 장애물 때문에 막힌 목표는 기존처럼 가까운 안전점에 snap해 HOLD/retry할 수 있도록 한다. 금지 존 내부 목표는 거부한다. 기존 시작점 snap 복구도 유지한다.
- 같은 셀·1px 이동에는 단순화를 적용해 불필요한 셀 중심 왕복을 제거한다. 플래너 API의 coarseCellSizePx:1은 원해상도 비교 모드다. UI 설정이나 통신 필드는 추가하지 않았다.

## 장애물·존과 안전 경계

- 이미 몸체 여유를 반영한 정적 inflated occupancy에서 원본 픽셀 하나라도 막히면 coarse 셀을 막는다. 동일 지도 배열·크기·셀 크기의 정적 결과를 재사용하고 맵 컨텍스트 교체 시 분리한다. 이미 반영한 정적 몸체 여유를 다시 inflate하지 않는다.
- 동적 마스크는 요청에서 방문한 coarse 셀의 원본 픽셀을 검사한다. 1억 셀 전체를 매번 다시 집계하지 않으며 요청마다 새 조회 캐시를 사용해 같은 배열을 갱신해도 이전 장애물 상태가 남지 않는다.
- forbidden/blocked(prohibit)는 작은 소수 좌표 폴리곤도 겹치는 셀 모두 차단한다. 폴리곤과 몸체 외접반경으로 확장한 셀 상자의 교차를 사용한다. 상자 모서리에서는 원형 여유보다 더 보수적일 수 있다.
- prefer/avoid는 기존 몸체·경계 거리 기반 연속 비용장의 셀 중심 및 사분면 4점 평균으로 근사한다. soft 존을 hard 차단이나 점유 제약으로 바꾸지 않는다. 작은 비용 변화가 평균 과정에서 약해질 수 있고 원본 최적 비용을 보장하지 않는다.
- coarse 대각 이동은 양쪽 인접 셀이 모두 열려야 허용한다. 복원된 실제 선분을 원해상도로 검사하고 기존 비용 보존 단순화·코너 완화를 적용한다. 후처리 결과가 몸체 검사를 실패하면 이미 검증한 coarse 원경로를 유지한다.
- coarse 차단은 탐색용 보수 표현이다. 원해상도 정밀화·검증을 통과한 선분이 coarse 차단 셀의 실제 빈 부분을 사용하는 것은 허용한다. 경로를 셀에 맞춰 그리느라 불필요한 꺾임을 강제하지 않는다.
- coarse 시작/목표 셀 차단, 탐색 실패, 복원 검증 실패에는 원해상도 A*로 fallback하며 반환 경로도 원해상도 몸체 검사를 거친다. 좁은 통로가 coarse에서 사라졌다는 이유만으로 no-route를 확정하지 않는다.
- controller의 최신 장애물 재검사·주행 안전 검사·비동기 계획 취소/timeout은 유지한다. peer의 미래 경로를 시간축으로 계획하는 새 알고리즘은 도입하지 않았다.

## 진단과 검증

planRoute의 선택적 diagnostics에는 coarse/fine 모드, fallback 여부·이유, coarse/fine 확장 횟수, 총 계획 시간이 포함된다. 확장 횟수는 heap pop 횟수이며 중복 방문도 포함할 수 있다. 새 UI나 블랙박스 이벤트 표시를 추가한 것은 아니다.

2026-09-22 최종 검사: **7개 파일 61개 통과, 0개 실패(2.33초)**.

```sh
rtk bun test shared/coarsePlanner.test.ts shared/planner.test.ts shared/semanticNavigation.test.ts shared/occupancy.mapContext.test.ts shared/obstacles.test.ts virtual-robot/src/planning.test.ts virtual-robot/src/controller.test.ts
```

새 coarse 검사는 15개이며 작은 hard 존/셀 경계, 원본 장애물, prefer/avoid, 대각 모서리, fine fallback, 소수 좌표, 같은 셀/1px 이동, 부분 셀(factor17), 맵 전환, 동적 배열 재사용 갱신을 포함한다. 기존 blocked-goal HOLD/retry와 비동기 worker 격리·취소·timeout도 통과했다.

## LargeLab 고정 장면 성능

ROBOT-6 당시 기록 프레임을 읽는 격리 Bun 측정이며 실제 운영 이동 명령을 발행하지 않았다. 같은 장면에서 원해상도 모드와 기본 coarse 모드를 비교했다.

| 지표 | 원해상도 | coarse16 |
| --- | ---: | ---: |
| 첫 planRoute(캐시 cold) | 1896.3ms | 187.2ms |
| warm 3회 중앙값 | 1913.2ms | 23.8ms |
| warm 범위 | 1872.2~2396.5ms | 23.8~28.7ms |
| 존/마스크 refresh 포함 3회 | 1711.1~2007.3ms | 21.2~22.8ms |
| heap pop 횟수 | 432595 | 1728 |
| 원본 비용장 적분 | 606.85 | 643.72 (+6.08%) |
| 경로 거리 | 1088.61px | 1084.80px |

모든 측정 경로가 원본 점유·존·몸체·동적 장애물 검사와 시작/목표 오차0 검사를 통과했고 coarse 모드는 fallback 없이 성공했다. 이 장면 warm 중앙값은 약80배 빨랐지만, 단일 프로세스에서 fine→coarse 순서로 각3회 측정한 결과다. JIT/실행 순서·부하 영향을 포함하고 p95/p99, 모든 지도, 모든 교차 주행의 개선 배수는 아니다. cold는 지도 파일 로딩과 초기 semantic/mask 준비를 제외한 planRoute 시간이다. baseline도 새 공통 안전 검사·endpoint 연결이 적용된 원해상도 모드다.

비용 +6.08%는 빠른 탐색을 위한 근사의 대가이며 경로 길이 최단/원본 비용 최적성을 주장하지 않는다. 과거 실제 교차의40회 stale 폐기까지 해소되었는지는 별도 운영 검수 대상이다.

재현: `rtk bun run scripts/benchmark_coarse_planner.ts`. 기록 프레임 경로는 FMS_COARSE_FRAME, 결과는 FMS_COARSE_BENCHMARK_OUT으로 지정한다. 프레임과 최종 JSON 및 검사 근거는 ROBOT-9 첨부에 보관한다. 단독 benchmark는 실제 운영 상태를 변경하지 않는다.

## 실행 반영

최종 idle 상태 확인 후 fms-robot-1/2만 PM2 재시작했다. 재연결 후 두 로봇 모두 large_lab, idle, connected/controlReady/enabled이며 위치 오차0, 완료된 명령 정보 유지가 확인됐다. FMS 서버/UI는 재시작하지 않았고 로봇 이동 명령도 발행하지 않았다. 실행 반영은 완료했으며 사용자 운용 검토 후 Done으로 확정한다.

근거: [coarse 탐색](../../../shared/coarse.ts), [플래너](../../../shared/planner.ts), [occupancy](../../../shared/occupancy.ts), [상수](../../../shared/constants.ts), [coarse 검사](../../../shared/coarsePlanner.test.ts), [성능 측정](../../../scripts/benchmark_coarse_planner.ts).

## 2026-09-22 운용 검수 후 동적 장애물 보완

초기61개 검사에서 누락된 회전 장애물 bounds·동적 몸체 검증·무효 경로 재개·무변화 moving 문제를71개 관련 검사와 실제 기록/worker/controller 재현으로 보완했다. 동적 마스크 여유는 약9.934px이며 정적8px 정책은 유지한다. 최신 정책과 검증 범위는 [동적 장애물 복구](dynamic-obstacle-recovery.md)를 우선한다. 위 최초 성능 수치는 당시 고정 장면 측정 이력이며 추가 수정 후 모든 상황의 수치로 확대하지 않는다.
