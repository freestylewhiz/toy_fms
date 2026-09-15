# bg_fms ↔ VDA5050 인터페이스 검토

앞 문서의 명세를 전제로, **우리가 무엇을 그대로 쓰고 / 어댑터로 메우고 / 기대하면 안 되는지**.
구현하지 않는다.

---

## 1. 결론 먼저

VDA5050은 이기종 연결 표준이지, v2 시공간 양보의 네이티브 API가 아니다.

- 공통 분모(라인·가상 레일·자유주행이 섞인 플릿) → **base/horizon + zoneSet**. 우리 사용자 존·v0 국소 임대와 맞음.
- v2 L1 delay-first → **`FREELY_NAVIGATING` + `intermediatePath.eta`가 있는 로봇만**. V3이고 벤더가 성실히 채울 때.
- 가상 로봇(지금 bg_fms)은 VDA를 말할 필요가 없다. 내부 proto에 eta만 넣으면 됨.
- 나중에 실기 이기종을 붙일 때 VDA 어댑터를 두고, factsheet로 **능력 강등**을 한다.

한 플릿에 “전원 v2 풀스택”을 걸지 마라.

---

## 2. 능력 클래스 (어댑터가 나누는 것)

factsheet `navigationTypes` + 실제 state 필드.

| 클래스 | 조건 | bg_fms 교통 |
|--------|------|-------------|
| **A. 자유주행 + eta** | `FREELY_NAVIGATING` 이고 `intermediatePath`가 점마다 `eta` | v2 L1–L3. 로컬 플랜 = intermediatePath |
| **B. 자유주행, 경로만** | NURBS/폴리라인은 있으나 eta 없음 (2.x 또는 빈 eta) | v1식 공간 겹침 또는 현재속력으로 t 추정. 호라이즌 짧게 |
| **C. 가상 라인** | `VIRTUAL_LINE_GUIDED` | 플릿이 그래프·base를 자름. 로봇 로컬 A* 없음. v2 스택 스킵 |
| **D. 물리 라인** | `PHYSICAL_LINE_GUIDED` | pose도 약함. base/horizon만 |

C/D 와 A를 같이 굴리면, 교차점은 **항상 플릿이 base를 안 푸는 쪽**으로 맞춰야 한다.
A만 eta로 비키고 C는 레일 그대로 오면 충돌한다.

---

## 3. 데이터 구조 대응

### 3.1 로컬 패스 플랜 (v2의 핵심 입력)

| bg_fms (안) | VDA 3.0 |
|-------------|---------|
| `LocalPlanUpdate.points[]` + 권장 `t[]` | `state.intermediatePath.polyline[].{x,y,theta?,eta}` |
| `LOOKAHEAD_S` (~5s) | 로봇이 정하는 길이. **계약이 아님** |
| `PathUpdate` (전역 남은 경로) | `plannedPath` NURBS (시각 없음) + `traversedNodes` |
| `PoseUpdate` | `mobileRobotPosition` + `velocity` + `driving` |
| 고주파 디스플레이 | `visualization` (교통 정본 아님) |

어댑터:

```
VDA intermediatePath.eta  →  unix_ms 또는 header.timestamp 상대 t
polyline[0] 이 현재 pose가 아니면 현재 pose를 앞에 붙임
eta가 없거나 단조 증가가 아니면 클래스 B로 강등
호라이즌이 1초 미만이면 delay-first 포기
```

단위: VDA는 **미터**, bg_fms occupancy는 **픽셀** (`PIXEL_CM`). 어댑터에서만 변환.

### 3.2 플릿 → 로봇 명령

| bg_fms | VDA |
|--------|-----|
| Colyseus `commandRobot` / gRPC `DriveCommand` (x,y,θ) | `order` 노드 하나 + 엣지(로봇이 경로 계획) |
| 경로를 FMS가 안 만듦 (F3) | 자유주행이면 edge `trajectory` 생략 |
| 일시 정지 | `instantActions` pause / resume |
| cancel | `cancelOrder` (자유주행은 즉시 정지) |
| v2 FMS delay (좌표 없음) | **해당 필드 없음.** 아래 4절 |
| v2 힌트 폴리라인 (일시 prefer) | zone `PRIORITY` 임시 zoneSet, 또는 쓰지 않음 |

DriveCommand 하나 = “goal node 하나짜리 order, trajectory 없음”이 VDA 자유주행에 가장 가깝다.
노드–엣지 그래프를 우리가 갖고 있지 않으면, 가상 그래프(goal만 노드)를 어댑터가 만든다.

### 3.3 사용자 트래픽 존

[`user_defined_traffic_zone`](../../user_defined_traffic_zone/README.md) ↔ VDA `zoneType`.

| 우리 | VDA | 비고 |
|------|-----|------|
| `forbidden` | `BLOCKED` | 거의 1:1. 컨투어 기준 |
| `complex` 용량 1 | `RELEASE` | ACCESS 요청. 플릿이 한 대만 GRANTED |
| `corridor` 용량 1 | `RELEASE` 또는 `LINE_GUIDED` | 레일 강제면 LINE_GUIDED + edge trajectory |
| `corridor` + rail 2줄 교행 | 그래프 두 엣지 + 각각 corridor / 또는 LINE_GUIDED | VDA는 “용량 2” 필드가 없음. 그래프·뮤텍스로 쪼갬 |
| `prefer` | `PRIORITY` + `priorityFactor` | 비용 인센티브. 강제 아님 |
| `avoid` | `PENALTY` + `penaltyFactor` | |
| (없음, 일방) | `DIRECTED` / `BIDIRECTED` | 우리 카탈로그에 없음. 필요하면 추가 |
| 존 안 자율 재계획 금지 | `COORDINATED_REPLANNING` | v2 L3를 끄고 플릿 허가 |
| 속도 | `SPEED_LIMIT` | |

우리 `corridor`의 **포탈 토큰** = VDA `RELEASE` + `zoneRequest`/`responses`.
order 노드가 존 안 released여도 ACCESS는 별도 — 스펙이 그렇게 못 박음. 어댑터도 그렇게.

`supportedZones`에 없는 타입은 그 로봇에게 보내지 않거나, 플릿이 대신 게이트(base를 안 풂).

이 객체들은 MQTT가 아니라 **맵 에디터**가 만든다. 도구·레이어: [`04_map_editor.md`](./04_map_editor.md). 저장 스키마: [`05_semantic_resources.md`](./05_semantic_resources.md).

### 3.4 회랑 (v0 I1/I2)

| 우리 | VDA |
|------|-----|
| 로봇이 만든 캡슐 회랑을 FMS가 disjoint 승인 | **없음** (로봇→플릿 회랑 요청이 표준 주 경로가 아님) |
| | edge.`corridor` = 플릿이 허용 폭을 **하향** |
| | `releaseRequired` corridor = 이탈 전에 허가 (v0 임대와 방향이 비슷) |

자유주행 v2에서는 VDA corridor를 기본 안전망으로 쓰지 않는다.
라인 가이드 로봇을 같은 맵에 넣을 때, 그 로봇의 풋프린트 팽창용으로만 본다.

---

## 4. v2 기능을 VDA로 어떻게 실을까

[`03_policy.md`](../03_policy.md) 층별.

### L1 대기 (경로 유지, 감속)

VDA에 `delay()` API는 없다 (그건 RMF).

자유주행 어댑터 선택지:

1. **base를 안 연장** — decision point 앞에서 서게 함. 이기종에 가장 안전. 스무스는 떨어짐.
2. 목표 노드는 유지한 채, 로봇이 스스로 감속하도록 **새 order를 안 보냄**. 이미 가진 base 안에서 로컬이 서는 모델. 로봇이 “막히면 선다”는 전제.
3. 벤더 전용 instantAction (표준 밖).

권장: 클래스 C/D 및 혼합 플릿은 (1). 클래스 A만 있는 시뮬/단일 벤더는 내부 proto로 delay하고, VDA로 나갈 때만 (1) 또는 로봇 로컬 hold.

### L2 교행 횡변위

VDA는 로컬 회피를 로봇 몫으로 둔다. corridor 안에서만 벗어나라는 제약이 라인 가이드에 있음.
자유주행은 corridor 없이 로컬이 비낀 뒤 **intermediatePath를 고쳐 보고**.
플릿은 그 새 eta를 스케줄에 반영하면 됨. 별도 메시지 불필요.

### L3 작은 우회

`COORDINATED_REPLANNING` 존 안: 로봇이 새 NURBS를 `zoneRequest(REPLANNING)`에 실어 허가.
존 밖 자유공간: 로봇이 혼자 재계획하고 plannedPath/intermediatePath만 갱신. 플릿은 관측.

### L4 FMS delay 중재

표준 필드 없음 → **horizon/base 절단**이 공식 수단.
RMF `Database::delay`를 VDA에 이식하지 말고, “저 로봇 base를 N 노드에서 끊는다”로 매핑.

### L5 힌트 폴리라인

임시 `PRIORITY` 존을 zoneSet으로 뿌리는 방법이 표준과 가장 닮음.
TTL·삭제 = 새 `zoneSetId`.
로봇이 `PRIORITY`를 지원 안 하면 힌트를 보내지 않음 (F3: 강제 경로 금지).

---

## 5. 우리가 참고할 만한 것 / 버릴 것

**참고 (값 큼)**

- factsheet로 능력 선언 → 강등. 이기종의 정답.
- base/horizon = 좌표 없는 교통. eta 없는 로봇의 L4.
- zoneType 카탈로그가 우리 사용자 존과 거의 같은 축 (BLOCKED/RELEASE/PRIORITY/PENALTY/LINE_GUIDED).
- 자유주행은 **경로를 로봇이 플릿에 올린다** (`intermediatePath`). v1/v2 방향과 같음.
- `information[]` 로 로직 금지. 벤더 확장 필드에 교통을 숨기지 말 것.
- corridor 이탈 시 풋프린트 증가를 교통이 고려 — v0 I1과 같은 경고.

**참고 (값 중간)**

- NURBS: 내부는 폴리라인으로 충분. VDA로 나갈 때만 변환.
- visualization vs state 이중 채널. 우리는 pose 주기 + path delta로 이미 비슷.
- `newBaseRequest`: 호라이즌 끝에서 감속. 우리 lease 연장 요청과 리듬이 닮음.

**당장 빌리지 말 것**

- 전 맵 노드–엣지 레이아웃(LIF)을 교통의 유일 모델로 삼기. 우리 시뮬은 occupancy A*.
- knotVector를 시간으로 오해하기.
- 모든 벤더가 V3 `eta`를 준다고 가정하기.
- MQTT/VDA를 가상 로봇 gRPC 대신 쓰기. 시뮬에는 과함.

---

## 6. 권장 어댑터 모양 (설계만)

```
          ┌─────────────┐
  Colyseus│  FloorRoom  │ 존·시드·UI
          └──────┬──────┘
                 │ 내부 TrafficController (정책 v0/v1/v2)
          ┌──────┴──────┐
          │  Robot I/O  │
          └──┬───────┬──┘
     gRPC 시뮬     VDA 어댑터 (실기)
     LocalPlan     factsheet → 클래스 A/B/C/D
     + t           A: intermediatePath.eta → LocalPlan
                   B: path + vx 추정 t, 또는 공간만
                   C/D: nodeStates만, v2 스킵 / base 게이트
```

내부 진실은 계속 **우리 proto + TrafficPolicy**.
VDA는 가장자리. 정책이 VDA 필드 이름을 직접 import 하지 않는다.

가상 로봇 2대 단계에서는 어댑터를 만들지 않는다.
실기 한 대를 붙일 때 factsheet → 클래스 매핑부터.

---

## 7. 스펙 공백 (구현 시 우리가 정해야 하는 것)

- `intermediatePath` 길이 하한. 권장: 최소 2s 또는 `LOOKAHEAD_S`의 절반. 미달이면 클래스 B.
- eta 시계: 로봇 시계 vs 플릿. `header.timestamp`와 eta의 스큐 허용.
- 클래스 A와 C가 같은 교차로: 항상 C 기준으로 base를 자름 (레일 로봇이 비킬 수 없음).
- `PRIORITY` factor ↔ 우리 A* `cost_scale` 식. VDA는 0..1 상대값, 우리는 배율.

이 네 가지는 VDA가 안 정해 준다.
