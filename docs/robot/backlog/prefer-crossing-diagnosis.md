# prefer 존 교차 주행 지연 진단

기준일: 2026-09-22 KST. 사용자 요청: 원인 분석과 카드 업데이트, 구현 금지.

## 확인한 사실

prefer는 비용 선호 영역이며 정원·점유 게이트가 아니다.
`server/src/traffic/SemanticCapacityGate.ts:9`의 대상은 corridor/complex/release뿐이다.
실제 Large Lab 기록의 존은 prefer(factor 0.4)와 avoid(factor 3)다.
prefer 영역은 대략 x=2700..3598, y=2202..2310이며 corridor 존이 아니다.

실제 좌우 교차 명령:
- robot-2, operation `43d18430-0fba-4a3e-9b34-863a25b200eb`:
  (2587.21,2275.73) → (3684.03,2250.80), 08:43:35.717 요청,
  계획 약 1.71초/373점, 08:45:26.494 완료.
- robot-1, operation `9c8cf641-0608-4e2c-a3ec-9ffa05f0fcfa`:
  (3646.51,2257.57) → (2565.56,2262.34), 08:43:53.323 요청,
  08:43:53.332 accepted 후 08:45:08.325 running(goal-retry), 08:46:57.209 완료.
  약 75초 동안 같은 시작점에서 계획을 반복했다. 해당 operation의 planner 기록은
  requested 41, stale_context 폐기 40, 이전 요청 cancelled 폐기 1, completed 1이다.
  이전 요청 취소 이벤트가 새 operation에 연결되어 있으므로 새 명령 실패 41회로 세지 않는다.
  오류 문자열은 `latest obstacle context invalidated route`다.

## 원인과 확정 한계

`controller.ts:requestPlan`은 비동기 계산 후 `routeValidAgainstCurrentContext`로
전체 follow 경로를 최신 장애물과 다시 대조한다. 상대 몸체와 약 5초 local plan을
원형 장애물로 합치므로 계산 중 상대가 움직이면 완성된 우회 경로도 폐기될 수 있다.
최초 폐기는 즉시 refresh, 다음 폐기는 HOLD 후 goal-retry로 반복한다.
이번 기록은 이 폐기/재시도에 의한 출발 지연을 직접 입증한다. prefer의 중앙 선호가
서로 비슷한 경로를 유도할 수 있으나 prefer가 구역 전체를 선점한 증거는 없다.
각 폐기의 정확한 충돌 점/장애물 ID는 현재 planner.event에 없으므로 몸체와 예측 경로 중
어느 항목이 지배적이었는지까지 확정하지 않는다. prefer를 제거한 비교 실험도 아직 하지 않았다.
08:38:50의 다른 교차 명령에서는 양측 blocked와 v1-detour도 관측했다.

## 수정 검토 범위와 완료 기준 후보

ROBOT-6의 사용자 검수 후속으로 전체 경로 재검증, 미래 예측 점의 정적 장애물 취급,
계산 중 환경 변화 및 재시도 공정성을 검토한다. 검증을 단순히 끄거나 충돌 위험을 허용하지 않는다.
동일 시작/목표/존에서 양방향 교차, prefer 유무 비교, 정차 peer, 실제 차단을 격리 재현하고
명령 수신→출발 지연·폐기 이유·최소 간격·완료를 측정한다. 허용 지연 수치는 별도 합의한다.
정당한 대기와 계산 반복을 UI에서 구분하는 진단 표시도 검토한다.

운영 로봇에 새 명령을 보내지 않고 저장 기록과 코드만 분석했다. 수정·재기동하지 않았다.
근거 파일: `virtual-robot/src/controller.ts`의 `handlePeerLocalPlans`,
`routeValidAgainstCurrentContext`, `requestPlan`, `server/src/traffic/SemanticCapacityGate.ts`.

카드: [ROBOT-6](http://192.168.0.172:3456/tasks/33), In Progress(진단만, 구현 미승인). 계획/상태 이벤트 근거 JSON을 카드에 첨부했다.


## 2026-09-22 추가 병목 분석 — 요청 지연과 CPU 비용 분리

실제 operation `9c8cf641-0608-4e2c-a3ec-9ffa05f0fcfa`의 requestId 27~67을 집계했다.

| 항목 | 측정 |
| --- | --- |
| 최초 요청~최종 계획 적용 직전 | 74.994초 |
| 현재 목표 계획 요청 | 41회 |
| stale_context 폐기 | 40회 |
| 폐기된 요청의 durationMs 합 | 64.962초 |
| 폐기 요청 평균 / 중앙값 | 1.624초 / 1.617초 |
| 폐기 요청 최소 / 최대 | 1.361초 / 2.377초 |
| 마지막 성공 요청 | 1.827초 |
| 나머지 요청 간 간격 등 | 약 8.205초 |

이 duration은 controller의 요청~응답/최신 문맥 검증 경과 시간이며 순수 A* CPU 시간만은 아니다.
별도 새 명령에 속했던 requestId 26의 cancelled 이벤트는 위 집계에서 제외했다.
40회 폐기에 약 87%의 출발 지연이 소비됐다. 한 번의 계산 가속만으로 반복 폐기 원인이 없어지지는 않는다.

### 고정 장면 CPU 프로파일 (운영 프로세스와 별도)

08:43:53.324 장면의 동일 시작/목표, prefer/avoid와 robot-2 몸체·단기 경로 장애물을 재구성해
원본 planner 함수를 3회 실행했다. 임시 진단 스크립트만 /tmp에 작성했고 저장소 실행 코드,
운영 프로세스·로봇·DB를 변경하지 않았다. 당시 내부 evasion hint나 계산 중 환경 변화까지
완전 복원한 실행은 아니며 과거 40회 폐기 자체를 재현한 실험도 아니다.

- planRoute: 2.103 / 1.937 / 2.182초, 동일 입력에서 follow 374점 / display 21점.
- semantic 정책 준비: 0.784 / 0.142 / 0.122ms.
- 동적 마스크 준비: 2.507 / 0.216 / 0.128ms.
- CPU 샘플: 총 6.77초, 5734 samples, planRoute 약 6.21초.
- softCostAt의 하위 호출 포함 비용은 약 3.68초: 전체 실행의 54.3%, planRoute의 약 59%.
  pointInPolygon·signedDistanceToZoneBoundary·Math.hypot가 주요 하위 연산이다.
  각 함수 inclusive 비중은 겹치므로 서로 더하지 않는다.

Large Lab은 10000×10000(1억 cell)이며 semantic grid 상한은 400만 cell이다.
따라서 전맵 Float32 비용 격자(약 400MB)를 피하고 방문 좌표마다 비용을 계산한다.
`semanticCost`→`softCostAt`→`softZoneMultiplier`에서 폴리곤 내부 여부와 경계 거리를
반복 평가한다. `signedDistanceToZoneBoundary`는 경계 거리 루프 뒤 pointInPolygon을
호출하고, pointInPolygon도 경계 포함 판단을 위해 각 변과 거리를 계산한다.
A*는 원해상도 8방향 탐색이며 동일 cell 비용 캐시는 없다. 후보 이웃과 경로 단순화의
lineCost에서도 동일한 기하 비용을 재평가한다. sparse Map과 heap 역시 비용이 있지만
이번 측정에서 가장 큰 계산 비용 계열은 소프트 존 비용/거리 평가였다.

### 반복 폐기 메커니즘

`setPeerLocalPlans`는 상대 몸체 및 약 5초 미래 경로의 매 두 번째 점을 circle 장애물로
만든다. worker에는 요청 당시 복사본을 보낸다. 계산이 끝나면 controller는 최신 장애물로
follow 전체를 약 4px 이하 간격으로 다시 검사한다. 이때 시간축은 비교하지 않는다.
출발점에서 먼 곳의 현재/미래 상대 위치도 전체 경로 무효화 사유가 될 수 있다.
이후 즉시 refresh 1회, 다시 실패하면 HOLD/tick의 goal-retry가 계산을 반복한다.
pendingPlan 동안 기존 경로 주행도 정지하므로 사용자에게는 명령 무반응처럼 보인다.

이것은 함수 한 번의 재검증이 65초 걸렸다는 뜻이 아니다. 비교적 짧은 유효성 판정이
1~2초짜리 전체 계획을 반복해서 버리게 만드는 구조적 지연이다. 정확한 충돌 장애물 ID와
경로 지점은 기록에 없으므로 현재 몸체/미래 경로/텔레포터 중 각 폐기의 원인까지 확정하지 않는다.
prefer는 정원 게이트 대상이 아니지만 중심 비용 유도가 상대 경로를 겹치게 할 수 있다.
또 factor 0.4가 A* 휴리스틱 하한에 사용돼 탐색량에 영향을 줄 수 있다. prefer 제거 비교는 미실시다.

### 후속 검토 우선순위 (구현 미승인)

1. 폐기 시 정확한 충돌 point/장애물 종류·ID/계획 단계별 시간을 관측해 원인을 구분한다.
2. 장기 경로 계획과 단기 충돌 회피의 시간 범위·재시도 정책을 정리한다. 안전 검증을
   없애는 수정은 하지 않으며 단기 검증·국소 수정·시간축 처리는 비교 검토할 대안이다.
3. 존 revision별 cell/타일 비용 캐시 등으로 비용/거리 중복 계산을 줄이는 안을 검토한다.
   전맵 상시 400MB 비용 격자 할당을 기본 해법으로 전제하지 않는다.
4. 동일 입력 성능뿐 아니라 움직이는 peer와의 실제 교차에서 지연·안전·완료를 함께 검수한다.

프로파일 원본·측정 요약·진단 스크립트·고정 장면을 ROBOT-6에 첨부해 결과 재검토가 가능하게 한다.

## 2026-09-22: 최적화 후보 1차 조사 연결

[PLAN-17](http://192.168.0.172:3456/tasks/43)에 [알고리즘·튜닝 1차 조사](../../concept/backlog/path-planning-optimization-survey.md)를 등록했다. 기존 A* 비용 캐시, 다중 해상도·계층형 탐색 등을 우선 비교하고, 반복 폐기 문제는 시간 기반 동적 계획과 별도로 검토한다. 후보는 확정 설계가 아니며 구현·새 실험·후속 서브에이전트 조사는 아직 수행하지 않았다.

## 2026-09-22 계산량 개선 분리 적용

[ROBOT-9](http://192.168.0.172:3456/tasks/44)의 [축소 격자 계획](../current/coarse-map-planning.md)을 구현·검증했다. 같은 고정 프레임의 계획 warm 중앙값은 약1913ms→24ms였고 원본 가중 비용은6.08% 증가했다. 실제 두 로봇 교차의 stale 폐기40회 문제가 해결되었다는 검증은 아니며 이 카드의 원인/운용 검수는 남아 있다.
