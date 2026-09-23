# 추가 동적 장애물 뒤 정체 — robot-1 원인 분석

2026-09-22 사용자 실운용 관측에 대한 분석. 아래 원인 분석 당시에는 구현/재시작/운영 이동 명령을 수행하지 않았다. 이후 사용자가 세 원인 수정·재기동을 승인했고 구현·검증·운영 반영을 완료했다. 최신 정책과 결과는 [동적 장애물 계획·복구](../current/dynamic-obstacle-recovery.md)가 정본이며 아래 내용은 원인 분석 당시 기록이다.
관련 카드: [ROBOT-9](http://192.168.0.172:3456/tasks/44), [ROBOT-6](http://192.168.0.172:3456/tasks/33).

## 관측과 기록

- LargeLab robot-1: (3343.4353,2676.6360), theta1.760785, 명령4db44fd5-27b6-4236-8c52-cf965b26498c, 목표(3144.2382,3112.4919).
- 약41초 간격 두 관측에서 위치/각도 동일. command running, phase FOLLOW, driveState moving, FMS proceed, enabled/connected/controlReady 모두 정상.
- robot-2는 (3596.0762,2584.2029)에 idle. 해당 장애물은 peer가 아니라 사용자가 추가한 회전된 square obstacle-386578b237ca486d80409891d1054f31, 중심(3325.3338,2764.0725), size80(반변 길이), theta0.284rad.
- 13:03:53.740 요청38 → 13:03:53.797 완료(57.8ms), 기존 경로 채택.
- 13:04:08.698 obstacles, .743 semantic_snapshot 도착. 요청39는 중복 snapshot에 의해취소, 요청40은547.5ms 뒤 stale_context 폐기.
- 13:04:09.293 refresh41 요청 → .325(32.2ms) stale_context 폐기. 이후 조회 구간에 새로운 계획 요청 없음. 기존 display 경로가 남음.
- stale_context 메시지는 최신 장애물과 경로 불일치 뜻이며, 실제 환경이 계속 변경됐다는 증거는 아니다. 고정한 동일 장애물 장면에서도 새 경로가 실제 몸체와 충돌함을 재현했다.

## 원인 1 — 플래너 장애물 표현과 몸체 충돌 판정의 불일치

shared/obstacles.ts의 obstacleBounds와 rasterizeObstaclesInto는 모든 모양에 reach=size+inflate+2를 적용한다. square size는 반변 길이이므로 회전하면 축 정렬 반경은 size*(|cos theta|+|sin theta|)까지 커진다. 현재 square의 실제 반경은 약99.21px지만 마스크 순회는90px에서 잘려 회전 모서리/완충영역을 누락한다. 현재 장애물만 넣은 격리 검사에서 pointHitsObstacle(...,inflate8)는 blocked인데 마스크는 free인 원본 셀2391개를 확인했다.

또한 계획 동적 마스크는 중심점+inflate8px이고 주행 검사는16×10px 회전 몸체+0.5px 여유다. 방향에 따라 전자가 후자를 완전히 포함하지 않는다. planner poseSegmentClear의 robotFootprintClear는 정적 지도 검사이며 동적 장애물은 isPlanFree 중심 마스크로만 본다.

고정 snapshot에서 재계획 당시 시작점(3362.9196,2575.3181)부터 coarse 계획이 약103ms에 생성됐지만, 반환 follow의(3418.9066,2699.5548)에서 해당 square와 몸체 충돌했다. live 당시 exact 반환경로는 trace에 없으므로 과거 두 폐기의 정확한 최초 충돌점까지 동일하다고 단정하지 않는다. 다만 고정 환경에서도 planner와 controller의 불일치가 재현되어, stale 폐기가 항상 장애물 이동 때문인 것은 아님을 확인했다.

현재 정지점에서도 다음0.58px 전진은 isPlanFree=true, 정적 body clear=true이나 poseHitsObstacle=true다. 현재점은 실제 body clear다. 현재점에서 새 계획을 격리 실행하면 fine fallback 경로가 약781ms에 반환되지만 첫 연결부터 같은 실제 장애물과 충돌한다. 이것은 운용 재시도 요청을 발행한 결과가 아닌 격리 계산이다.

## 원인 2 — 폐기한 새 경로 대신 예전 경로가 재개됨

controller requestPlan은 stale 결과와 1회 refresh가 모두 실패하면 HOLD로 남기고 기존 path를 보존한다(1086~1101). 다음 tick의 shouldResumeHold는 local_plan_v1에서 peer/traffic 조건만 확인하고 true를 반환한다(1235~1245). UI 일반 장애물이 남은 path를 막는지 확인하지 않는다. 따라서 HOLD→FOLLOW로 기존 경로를 재개해 새 square 앞까지 이동했다. path 끝까지 도달하지 않았으므로 goal-retry 조건도 성립하지 않는다. 재계획 실패 후 주석의 tick retry 기대와 실제 중간경로 재시도 조건이 다르다.

## 원인 3 — 실제 변화 없는 자세 적용을 이동 성공으로 판정

tryMove는 전진 실패 뒤 applyPose(currentX,currentY,nextTheta)가 성공하면 true를 반환한다(1205~1209). 이미 목표 방향을 향하면 위치와 각도가 모두 같아도 true다. applyPose는 변화 여부와 무관하게 lastMotionAt을 갱신한다(1191~1200). tickFollow의 실패 복구/재계획 분기로 가지 않고 pathIndex도 진전하지 않는다. observedDriveState는 최근lastMotionAt으로 moving을 보고하므로 UI도 움직이는 상태로 남는다.

같은 snapshot으로 독립 RobotController를 생성하고 tryMove를3회 호출: [true,true,true], 위치 변화0, 각도 변화0, lastMotionAt 갱신, driveState moving. 운영 로봇에는 호출하지 않았다.

## 진단 당시 수정 방향

1. 회전 도형의 실제 bounding box와 몸체 여유를 기준으로 마스크/dirty bounds 계산을 통일한다. 기존8px 팽창과 몸체 검증의 안전 포함관계를 검증하고, 최종 동적 몸체 검사를 계획 결과에도 적용한다.
2. 새 장애물로 무효화된 이전 경로를 재개하지 않는다. HOLD 복귀 전에 다음 구간/남은 경로를 현재 전체 장애물로 검사하고, 실패한 중간경로는 간격 제한을 둬 재계획한다. 재시도 폭주·FMS STOP 우회 금지.
3. tryMove 결과에서 평행이동/회전/무변화를 구분한다. 무변화는 lastMotionAt을 갱신하지 않고 일정 정체 후 원인별 HOLD/replan 상태로 전환한다. 사용자 명령은 유지한다.
4. 회전 square45도/현재각, 작은 장애물, 이동중 추가/갱신, 두차례stale후기존path재개금지, 회전만 진행/완전무변화 구분, UI moving 오보고, fine/coarse/worker 통합 회귀를 추가한다.

이번 수정은 알고리즘 교체나 축소격자 철회보다 장애물 표현과 경로 무효화·정체 복구 정합성을 먼저 다룰 문제다. 고정 scene 성능 개선은 유지되지만 ROBOT-9의 기존61개 검사에는 이 연속 실패 시나리오가 빠져 있었다. 사용자 요청은 원인분석이며 수정 착수는 하지 않았다.

근거: [동적 마스크](../../../shared/obstacles.ts), [플래너](../../../shared/planner.ts), [제어기](../../../virtual-robot/src/controller.ts). 원본 상태2개, planning/protocol 기록, 격리 재현결과는 ROBOT-9에 첨부한다.

## 2026-09-22 수정·검증 완료

세 원인을 수정하고 관련71개 검사, 기록 두 시작점의 실제worker경로 충돌0·정확좌표 검증, controller120tick 안전진전/명령유지/제한된 재계획을 통과했다. robot1/2 재시작 후 위치오차0·정상연결·정지상태를 확인했다. robot-1 기존 명령은 interrupted로 정리했고 재발행하지 않았다. [ROBOT-9](http://192.168.0.172:3456/tasks/44)는 Review이며 상세 현행은 [복구 정책](../current/dynamic-obstacle-recovery.md)을 따른다.
