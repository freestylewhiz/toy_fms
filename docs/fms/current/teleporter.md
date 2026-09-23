# 텔레포터 운용 정책

## 현재 구현

텔레포터는 서로 다른 map에 속한 정확히 두 endpoint를 연결한다. 각 endpoint는 위치, 진입·이탈 heading, 점유 polygon, clearing point를 가진다. 양 endpoint의 점유는 하나의 durable SQLite 사용 기록으로 관리되며, 두 map server가 같은 ledger를 조회한다.

로봇은 source endpoint 경계까지 자동 접근한다. 점유 중인 로봇은 clearing point까지 자동 이탈한다. 고정 waiting pose는 사용하지 않으며, 접근 중인 로봇은 논리 FIFO 순서에 따라 endpoint 밖에서 대기한다.

## 안전 조건

- source 진입은 source map과 destination map의 heartbeat 및 endpoint readiness가 모두 유효할 때만 허용한다.
- destination endpoint와 endpoint에서 clearing point까지의 경로는 static map, inflated occupancy, forbidden zone, dynamic robot body를 검사한다.
- dynamic body 검사는 최대 4px 간격으로 수행한다.
- clearing path 길이는 최대 256px이다. 초과하는 정의는 저장할 수 없다.
- endpoint polygon과 로봇 본체가 겹치면 점유로 간주한다. boundary 접촉도 겹침이다.
- destination에 일시적인 장애물이 있으면 요청을 거부하지 않고 FIFO 대기한다.
- 로봇 본체가 endpoint polygon 밖으로 완전히 빠지면 물리 점유를 해제한다. clearing point 도착과 transfer 완료는 별도로 기록한다.
- 연결이 끊겨도 자동으로 점유를 해제하지 않는다. 명시적인 취소 또는 완료 확인이 필요하다.

## 상태와 복구

사용자가 텔레포터를 주행 대상으로 지정하면 논리 요청을 등록한다. 별도의 거리 임계값이나
고정 대기 좌표는 두지 않는다. 양방향 요청을 같은 FIFO에 넣으며 단절·운영 제외·제어 미준비 로봇은
새 이용권 승격 대상에서 제외한다. 이미 보유한 이용권은 단절만으로 해제하지 않는다.

사용자가 로봇의 **운영 제외**를 명시적으로 실행하면 해당 로봇의 텔레포터 이용권·예약·대기열을
강제 해제하고 진행 전환을 실패 처리한다. 기존 제어 권한과 로봇의 미완료 이전 기록은 무효화한다.
실제 몸체는 장애물로 유지하므로 논리 이용권 해제가 즉시 다른 로봇의 통행 가능을 뜻하지 않는다.
재개는 [운영 복구 정책](runtime-recovery.md)의 명시적 동기화를 따른다.

대기 중이거나 몸체가 입구 밖에 있는 접근 요청은 취소할 수 있다. 취소 시 접근 주행도 중지한다.
몸체가 영역 안에 있거나 이전이 확정된 경우 취소만으로 공간이 비었다고 판단하지 않는다.
텔레포터 이전 중 일반 이동·충전 명령으로 자동 이탈을 덮어쓸 수 없으며, 완료 후에는 일반 주행을 허용한다.

사용 요청, owner map, control epoch, transfer phase는 SQLite에 기록한다. 승격은 `BEGIN IMMEDIATE` 트랜잭션으로 처리해 여러 map server가 동시에 큐를 poll해도 중복 승격하지 않는다. 목적지 도착 후 기존 map의 live robot projection은 제거하고 runtime 기록은 복구를 위해 보존한다.

2026-09-16: readiness race에서 명령을 거부하던 동작을 요청 대기로 변경했다. source 진입 시에는 readiness를 다시 확인하며, destination endpoint에 도착한 로봇의 이탈은 반대 map readiness와 무관하게 허용한다.

2026-09-17 · PILOT-9: 명시적 운영 제외에 따른 전체 논리 이용권 해제 정책 추가. 단순 단절 시 보존은 유지.
