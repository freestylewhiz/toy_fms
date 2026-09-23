# 동적 장애물 계획·정체 복구

2026-09-22 사용자 검수 수정. [ROBOT-9](http://192.168.0.172:3456/tasks/44).
회전 square 추가 후 실제 robot-1이 제자리에서 moving/FOLLOW로 남은 [진단 기록](../backlog/dynamic-obstacle-stall-diagnosis.md)을 바탕으로 세 원인을 수정했다. 이번 수정은 Luna high 구현과 Astra high 최종 조율·검토로 수행했다.

## 1. 동적 장애물 표현과 계획 검증

- square/triangle의 실제 회전 정점으로 bounding box를 구하고 margin을 더한다. full raster와 dirty 영역 갱신이 같은 bounds를 사용한다. 기존 square에 size+inflate+2만 적용해 회전 모서리가 잘리던 문제를 제거했다.
- 정적 지도 inflate는 기존8px이다. 동적 planning mask만 로봇 외접반경+몸체 충돌 검사 여유0.5px, 즉 약9.934px로 변경했다. 방향에 따른 몸체 길이 차이를 보수적으로 포함하며, 좁은 동적 통로에는 기존보다 보수적일 수 있다.
- 플래너는 원본 동적 geometry를 받아 최종 복원 선분에서 controller와 같은 poseHitsAny 검사를 적용한다. 정적 몸체/금지 존 검사도 유지한다. coarse/fine 모두 안전 검사를 우회하지 않는다.
- 확대 마스크 안이지만 실제 몸체는 안전한 현재 시작점에서 탈출할 수 있도록 fine 탐색의 시작점 근방32px에서 실제 geometry를 활용한다. 탐색의 근사 통과 판정만으로 안전을 확정하지 않으며 반환 경로의 실제 선분 방향 몸체 검사와 시작 연결을 최종 확인한다.
- 원본 좌표, 안전한 정확 시작/목표, 임시 차단 목표 snap 후 HOLD/retry 계약을 유지한다. 새 알고리즘이나 시공간 예약은 도입하지 않았다.

### geometry·mask 수명 계약

호출 순서는 setExtraBlocked(mask) 다음 setPlanningObstacles(obstacles)다. 후자가 현재 mask revision에 geometry를 연결한다. 새 mask 등록이나 map context 교체로 revision이 바뀌면 이전 geometry를 사용할 수 없다. raw-mask-only 호출은 기존 마스크 판정을 유지하고, 빈 geometry와 map reset은 과거 shape를 남기지 않는다. 실제 worker와 동기 controller 둘 다 이 순서를 적용한다.

## 2. 무효 경로 재개 금지와 제한된 재계획

- 새 UI 장애물/맵 갱신이 남은 경로를 막거나 비동기 결과가 최신 문맥 검증에서 폐기되면 pathInvalidated를 기록한다. 첫 폐기 뒤1회 즉시 refresh를 허용하고, 계속 실패하면 HOLD에서 명령을 유지한다.
- HOLD는 무효한 이전 경로를 자동 재개하지 않는다. 중간 경로에서도 obstacle-retry를 최소800ms 간격으로 실행하며 pending 요청이 있으면 추가 요청하지 않는다. 유효한 새 경로를 commit할 때 invalidated 상태를 해제한다.
- FMS STOP, 제어·연결 상실, semantic gate/lease 조건은 계속 우선한다. 새 경로를 계산했다는 이유로 허가를 우회하지 않는다. 취소·새 명령·맵 전환은 복구 상태를 정리한다.
- peer heartbeat마다 전체 남은 경로를 다시 검사하지 않는다. UI/map의 명시적 재계획 갱신에서 전체 검사를 하고, peer에는 기존 제한된 경로 검사를 유지한다. tick과 상태 표시의 invalidated 조회는 flag 기반이다.

## 3. 실제 이동 관측

applyPose는 평행이동이나 회전이 실제로 변한 경우만 성공·lastMotionAt 갱신으로 처리한다. 동일 위치/각도 적용은 false이며, tryMove의 회전 fallback이 변화 없이 성공을 보고하지 않는다. 실제 회전만 일어난 경우는 계속 moving이다.
동적 장애물에 막혀 움직이지 못하면 사용자 명령을 버리지 않고 HOLD/replan으로 전환한다. 무효 경로로 대기하는 동안 driveState는 blocked, 문맥은 obstacle_detected로 설명한다. 동기 재계획이 같은 tick 안에 성공하면 외부 snapshot에서 HOLD가 보이지 않고 바로 안전한 새 경로를 따라갈 수 있다.

## 검증

2026-09-22 최종 관련 회귀: **8개 파일71개 통과, 0개 실패(3.59초)**.

```sh
rtk bun test shared/coarsePlanner.test.ts shared/planner.test.ts shared/dynamicPlanner.test.ts shared/semanticNavigation.test.ts shared/occupancy.mapContext.test.ts shared/obstacles.test.ts virtual-robot/src/planning.test.ts virtual-robot/src/controller.test.ts
```

회전 square의 전체 원본 영역을 pointHitsObstacle oracle과 비교하고, dirty 갱신·겹침을 검사했다. geometry revision, 기록의 두 시작점, 두차례 stale 뒤 무효 경로 재개 금지,800ms backoff, 무변화/회전 구분, STOP 동결, 기존 goal 재시도·취소·worker timeout을 함께 확인했다.

실제 PlanningWorkerClient를 독립 프로세스로 실행해 기록 장면의 UI 장애물4개와 idle peer 몸체1개를 반영했다. 운영 로봇에 주행 명령을 보내지 않았다.

| 시작 | 탐색 | planRoute | worker 응답 | 원해상도 검사 | 결과 |
| --- | --- | ---: | ---: | ---: | --- |
| 현재 정체점 (3343.4353,2676.6360) | fine fallback | 1129.5ms | 1602.6ms | 840자세 | 충돌0, 시작·목표 오차0 |
| 이전 재계획점 (3362.9196,2575.3181) | coarse | 57.5ms | 59.6ms | 908자세 | 충돌0, 시작·목표 오차0 |

worker 첫 응답에는 초기 프로세스/맵 준비가 포함된다. 고정 장면의 단일 실행이며 일반 성능 보장이 아니다. 현재 정체점에서 원해상도 fallback은 의도한 복구 동작이다.

격리 controller의 기록 재현은 scripts/reproduce_controller_stall.ts를 사용한다. 120tick은6초의 시뮬레이션 구간이며 실제 경과시간이나 목적지 도달 전체 검증과 구분한다. 최종 결과와 운영 재시작 확인은 ROBOT-9 첨부에 남긴다.

근거: [장애물](../../../shared/obstacles.ts), [플래너](../../../shared/planner.ts), [동적 플래너 검사](../../../shared/dynamicPlanner.test.ts), [controller](../../../virtual-robot/src/controller.ts), [controller 검사](../../../virtual-robot/src/controller.test.ts), [worker](../../../virtual-robot/src/planningWorker.ts), [기록 재현](../../../scripts/reproduce_controller_stall.ts).

### 기록 controller 재현 결과

최종 scripts/reproduce_controller_stall.ts 결과 pass=true. 120tick에서 신규 경로71.46px, 원래 위험 local path를 강제 주입한 경우도 재계획 후70.89px 전진했다. UI·peer 장애물을 기준으로 신규/회복 경로와 모든 실제 pose가 안전했고 명령을 유지했다. 초기 계획을 포함한 요청2회로 제한됐다. 원래 기록 local path의 안전 검사는 false이며, 이를 다시 따라간 것이 아니라 안전한 경로로 교체했음을 확인했다. 동기 재계획이 한tick 내에 끝나 firstHoldTick=-1인 것은 정상이다.

### 운영 반영

사용자가 승인한 robot1/2 재시작을 수행했다. 둘 다 신규 session으로 LargeLab에 연결하고 idle/IDLE/stationary, connected/controlReady/enabled를 확인했다. 두 로봇 위치 오차는0이다. robot-1의 정체된 기존 running 명령은 interrupted로 정리됐고 자동 재발행하지 않았다. robot-2의 완료 명령은 completed를 유지했다. FMS 서버와 UI는 재시작하지 않았다.

ROBOT-9는 Review로 돌아가 사용자 검토를 기다린다. 현재 로봇을 다시 주행시키려면 운영자가 새 이동 명령을 내려야 한다. 이번 검증은 기록 장면의 안전 복구와6초 시뮬레이션 진전이며 모든 동적 배치에서의 도달 보장은 아니다.
