# VDA5050 프로토콜 — 주행과 교통

기준: **VDA 5050 V3.0.0**. 이탤릭 필드는 스펙상 옵션.

---

## 1. 역할 분리 (스펙 §5.3–5.4)

**플릿 컨트롤**

- 주문 할당, 경로 계산(특히 라인 가이드), 교착 감지·해소
- 교통: 버퍼 경로, 대기 위치, (임시) 구역 개방·최고속도
- 도어·엘리베이터 등 주변기기

**모바일 로봇**

- 로컬라이제이션
- 할당된 경로 수행 (**line-guided** 또는 **freely navigating**)
- 액션 수행, state 연속 송신

즉 표준이 가정하는 교통은 “로봇들이 시공간을 나눠 가진다”가 아니라
**플릿이 길을 잘라 주고 로봇이 그걸 수행한다.**

---

## 2. 두 가지 주행 모델 (스펙 §3.6–3.7, factsheet `navigationTypes`)

| `navigationTypes` | 누가 경로를 짜나 | 교통 입력 |
|-------------------|------------------|-----------|
| `PHYSICAL_LINE_GUIDED` | 바닥에 깔린 물리 라인. 계획 없음 | pose 약함. FMS가 node/edge만 |
| `VIRTUAL_LINE_GUIDED` | 고정 가상 경로(그래프) | Order trajectory 또는 로봇 내장 레일 |
| `FREELY_NAVIGATING` | 로봇이 스스로 계획 | **state `plannedPath` + `intermediatePath` 필수** |

한 대가 여러 타입을 지원하면 factsheet 배열 우선순위 순.
이기종 플릿은 이 세 클래스가 섞인다.

자유주행이라도 **주문은 여전히 node–edge**다.
노드는 경유·정차 목표, 엣지는 논리 연결이다.
엣지 위의 실제 곡선은 플릿이 `trajectory`로 주거나, 로봇이 알아서 짠다.

---

## 3. 전송

MQTT. 로컬 브로커 권장 토픽:

```
vda5050/v3/{manufacturer}/{serialNumber}/{topic}
```

| topic | 발행 | 필수 | 주행 관련 |
|-------|------|------|-----------|
| `order` | 플릿 → 로봇 | 예 | node/edge, trajectory, corridor, released |
| `instantActions` | 플릿 → 로봇 | 예 | pause/resume, cancelOrder |
| `state` | 로봇 → 플릿 | 예 | pose, velocity, 남은 경로, **intermediatePath** |
| `visualization` | 로봇 → (뷰어) | 아니오 | state와 같은 경로 구조를 고주파 |
| `connection` | 브로커/로봇 | 예 | 연결 유실. 헬스체크 대용 금지 |
| `factsheet` | 로봇 → 플릿 | 예 | navigationTypes, supportedZones, 속도 한계 |
| `zoneSet` | 플릿 → 로봇 | 아니오 | 시맨틱 존 |
| `responses` | 플릿 → 로봇 | 아니오 | zone/edge 요청 허가 |

QoS 0 (connection만 QoS 1).
끊겨도 로봇은 **마지막 released 노드까지** 주문을 수행한다.

공통 헤더: `headerId`, `timestamp`(ISO 8601 UTC ms), `version`, `manufacturer`, `serialNumber`.

---

## 4. Order: base 와 horizon (스펙 §6.1) — 이기종 교통의 본체

노드·엣지에 `released`:

- `true` → **base**. 지금 주행 허가. 마지막 base 노드 = **decision point**
- `false` → **horizon**. 예정만. 들어가면 안 됨

규칙:

- 엣지가 released 이려면 양끝 노드도 released
- released 뒤에 unreleased가 오면, 그 뒤는 다시 released 불가
- 로봇은 decision point에서 새 base가 없으면 **정지**
- 끊김·비동기 때문에 **이미 보낸 base는 수정 불가** (취소는 별도, 신뢰 낮음)
- horizon은 order update로 갈아끼울 수 있음
- `newBaseRequest` (state): 베이스가 끝나 감속 중 → 플릿이 연장하라는 트리거

이게 VDA의 타임테이블이다.
로봇 ETA가 없어도, 플릿이 **아직 안 푼 엣지**로 교차·복도를 직렬화한다.

라인 가이드 취소: 다음 가능 노드에서 멈출 수 있음.
자유주행 취소: **가능한 한 빨리** 정지 (다음 노드까지 가지 않음).

---

## 5. 엣지 trajectory 와 corridor (스펙 §6.1.5, §7.3)

`trajectory` (옵션): NURBS. 시작·끝 노드 사이 **기하 경로**.
생략 가능 — 로봇이 궤적을 못 받거나 **스스로 계획**할 때.

`knotVector` 범위 **[0.0, 1.0]**. 시간(초)이 아니다.

`corridor` (옵션): 궤적 좌/우 폭. 장애 회피 시 궤적에서 벗어날 수 있는 띠.
- 전제: 벗어날 **기준 궤적**이 있어야 함 (라인 가이드 + 일시 이탈)
- 기본 released. `releaseRequired=true`면 쓰기 전 플릿 승인 (`edgeRequest`)
- 벗어나면 `OUTSIDE_OF_CORRIDOR`
- 풋프린트가 커지므로 플릿 교통 계산에 반영해야 함 (스펙 명시)

우리 v0 회랑과 닮았지만, **누가 그리는가**가 반대다.
VDA corridor는 플릿이 엣지에 붙여 보내는 허용 폭이다.

---

## 6. 자유주행 경로 공유 (스펙 §6.8) — v2와 맞닿는 지점

자유주행이면 state(및 선택적 visualization)마다:

| 필드 | 형식 | 시간 |
|------|------|------|
| `intermediatePath` | 현재 pose에서 시작하는 폴리라인. waypoint = `x,y`, optional `theta`, **`eta`** | 있음. 가까운 구간, 센서가 믿는 앞 |
| `plannedPath` | NURBS (`trajectory`와 동일 구조). 현재 **base 이상** | 점별 시각 없음. 길 바뀔 때 갱신 |

둘 다 **order 노드와 무관하게 현재 위치에서 시작**.
길이는 로봇이 상황마다 정함.

제약:

- 로봇이 **직접 계획한** 궤적만 여기 넣음
- 레이아웃/order로 이미 정해진 궤적은 `edgeState.trajectory`로만 ack
- `information[]` 는 시각화·디버그. **플릿 로직에 쓰면 안 됨**

즉 타임테이블에 가까운 건 **`intermediatePath.eta` 뿐**이다.
전 미션 NURBS에는 시각이 없다.

---

## 7. Zones (스펙 §6.4)

노드 사이를 자유롭게 다니게 하면서, 영역에 규칙을 건다.
배포는 플릿만 (`zoneSet`). 맵당 활성 존셋 하나. 로봇은 factsheet `supportedZones`로 이해 가능한 타입만 신고.

### 컨투어 기준 (몸 일부라도 들어가면 진입)

| type | 의미 |
|------|------|
| `BLOCKED` | 진입 금지. 들어가 있으면 정지 + 에러 |
| `LINE_GUIDED` | 존 안 자유주행 금지. 엣지 궤적(±corridor)만 |
| `RELEASE` | 플릿 `GRANTED` 전에 진입 금지. 용량 게이트 |
| `COORDINATED_REPLANNING` | 자율 재계획 금지. 새 경로는 플릿 허가 |
| `SPEED_LIMIT` | `maximumSpeed` |
| `ACTION` | 진입/통과/이탈 액션 |

`RELEASE` 회수 시 `releaseLossBehavior`: `STOP` / `CONTINUE` / `EVACUATE`.

### 기구학 중심 기준

| type | 의미 |
|------|------|
| `PRIORITY` | 경로 비용 인센티브 `priorityFactor` 0..1 |
| `PENALTY` | 비선호 `penaltyFactor` 0..1 (1이면 다른 길이 없을 때만) |
| `DIRECTED` / `BIDIRECTED` | 진행 방향. SOFT/RESTRICTED/STRICT |

겹치면 `BLOCKED`가 이긴다. `DIRECTED`∩`BIDIRECTED` 는 스펙이 겹치지 말라고 함.

대화형 존 (`RELEASE`, `COORDINATED_REPLANNING`):
로봇이 들어가기 **전에** `zoneRequests` (state) → 플릿 `responses` (`GRANTED`/`QUEUED`/`REJECTED`/`REVOKED`).
order의 노드가 존 안에 released여도, 존 ACCESS는 따로 받아야 한다.

---

## 8. 플릿이 가정하는 교통 루프 (요약)

```
플릿: 그래프에서 order 작성
     base만 교차·복도가 비게 잘라서 송신
로봇: base 주행
     자유주행이면 intermediatePath(+eta) 보고
     RELEASE 존이면 들어가기 전 ACCESS
     베이스 끝 가까우면 newBaseRequest
플릿: 스케줄이 허락하면 base 연장 / horizon 수정
```

로봇 제공 ETA는 **있으면** 부드럽게 연장하는 힌트이고,
없어도 이기종 교통은 base 절단으로 성립한다.
