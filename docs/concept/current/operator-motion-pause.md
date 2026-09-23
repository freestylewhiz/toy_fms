# 운영 일시정지·주행 재개

2026-09-22 PLAN-14 / WEB-6 / SRV-9 / ROBOT-7. 사용자가 구현을 승인했으며,
조율·검토·테스트는 Astra high, 컴포넌트 개발은 Luna high로 수행했다.

## 동작

사용자 일시정지는 교통 STOP·운영 제외와 별도 상태다. 가상 로봇의 이동과 회전을
즉시 정지하지만 진행 중 명령 ID·목표·경로 진행 위치·전체 경로·로컬 경로를 유지한다.
점유·예약·대기열과 제어 세대도 일시정지 때문에 바꾸지 않는다. 위치·상태 보고와
교통 STOP 재평가는 계속한다. 교통 허가가 바뀌어도 사용자 정지는 해제되지 않는다.

주행 재개는 사용자 정지 상태만 해제한다. 교통 STOP·통신·존 허가·장애물 검사는 그대로
적용하며, 보존 경로가 최신 환경에서 막혔으면 이동 전에 대기·기존 재계획을 수행한다.
따라서 재개 ACK는 즉시 이동 시작을 뜻하지 않는다. 정지 중 완료된 비동기 계획은 보류했다가
재개 시 검증하고 적용한다. 정지 중 명시적으로 취소하면 명령을 정리하고 보류된 우회에도
종결 응답을 보낸다.

정지 중 새 이동·도킹·텔레포터 명령은 거부한다. 명시적인 취소·운영 제외·테스트 위치 지정은
기존 계약을 따른다. 운영 제외와 명시적 재활성화에도 사용자 정지 의도는 유지한다.
텔레포터 전환이 진행 중인 로봇의 일시정지 요청은 거부하므로, 적용 성공 이후에 전환으로
맵·좌표가 갑자기 바뀌는 상황을 만들지 않는다.

## 상태·확인·영속화

`operatorPauseDesired`는 저장된 요청 의도, `operatorPaused`는 로봇 보고/ACK로 확인한
적용 상태다. `operatorPausePending`과 `operatorPauseReason`으로 확인 중·거절·단절을 표시한다.
요청 ID·로봇 세션·제어 세대·요청 값이 모두 일치하는 적용 ACK 후 성공 처리한다.
일치하는 pose만으로 성공을 확정하지 않는다. 명시적 로봇 거절은 이전 의도로 복원하며,
timeout·단절은 확인 실패로 표시하고 의도는 재연결 동기화를 위해 보존한다.

저장된 의도는 서버/로봇 재접속·재시작 후에도 전달한다. 기존 운영 복구 정책대로 과거
세션의 명령은 자동 재개하지 않는다. 로봇 위치 복원은 기존 위치 저널 정책을 따른다.
정지 의도 영속화가 일반 신규 seed 로봇의 위치 저장 정책을 바꾸지는 않는다.

FMS의 semantic 점유 계산에는 보존된 로컬 경로를 계속 사용한다. 다른 로봇에 보내는
미래 경로는 비우고 최신 몸체 좌표를 제공하며, FMS의 충돌 예측도 정지 몸체로 계산한다.
보존된 미래 경로를 실제로 움직일 예측으로 오해하지 않게 분리한다.

## 계약과 검증

- 프로토콜 v5: `motion_pause` / `motion_pause_ack`, `operator_paused` 상태.
- 웹 요청: `robot_motion_pause` / `robot_motion_pause_result`; `expectedEpoch` 필수.
- `scripts/operatorPause.integration.test.ts`: 실제 protobuf 직렬화와 서버·로봇 연결,
  ACK 누락·과거 세션, 명령/경로/세대 보존, 점유와 peer 예측 분리, 재접속,
  운영 제외/재활성화, 명시 거절과 중복 ID 충돌.
- `virtual-robot/src/operatorPause.test.ts`: 이동·회전 정지, 환경 변화, 교통 STOP 분리,
  비동기 계획 보류와 취소.
- `virtual-robot/src/motionPauseProtocol.test.ts`: 적용 ACK·중복·과거 세대·기록 실패 격리.
- 실제 두 가상 로봇 운용 검증은 `scripts/check_operator_pause_console.ts`를 사용한다.
  재시작 위치 검증은 운영 환경과 같이 기존 settled pose journal을 가진 조건이다.

구현: `virtual-robot/src/controller.ts`, `virtual-robot/src/grpcClient.ts`,
`server/src/rooms/FloorRoom.ts`, `server/src/runtimeStore.ts`, `server/src/grpc/robotBridge.ts`.

최종 검증: 전체 259개 자동 검사 통과, 실제 두 로봇·브라우저 통합 10개 항목 통과.
운영 적용 결과는 아래 확인 기록을 따른다.

## 2026-09-22 운영 적용 확인

최종 자동 검사 259개와 실제 두 로봇·브라우저 통합 검증 10개 항목을 통과한 뒤,
PM2의 yard/large_lab 서버·웹·로봇 2대를 함께 재기동했다. 두 로봇의 맵·좌표·방향은
전후 동일하고 enabled/connected/controlReady/idle, 일시정지 요청 대기 없음 상태를 확인했다.
운영 웹에서 이벤트 100행·상세·제어 UI를 읽기 전용으로 확인했으며 페이지 오류와
재기동 이후 신규 stderr는 없었다. 검증 중 운영 로봇에 새 이동 명령을 보내지 않았다.
근거: `/tmp/fms-pause-console-postdeploy.json`, `/tmp/fms-pause-console-live-result.json`,
`/tmp/fms-pause-console-live.png`. 카드 첨부에 장기 검수용 결과를 남겼다.
