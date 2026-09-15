# VDA5050 데이터 명세 — 주행

V3.0.0 스키마에서 **자율/교통에 쓰는 필드**만. 단위는 스펙 그대로(m, rad, m/s).
전체 스키마는 원문 §7.

이탤릭 = 옵션.

---

## 1. 공통 헤더

모든 메시지.

| 필드 | 타입 | 의미 |
|------|------|------|
| headerId | uint32 | 토픽별 송신마다 +1 (수신 여부와 무관) |
| timestamp | string | ISO 8601 UTC, ms (`YYYY-MM-DDTHH:mm:ss.fffZ`) |
| version | string | `Major.Minor.Patch` |
| manufacturer | string | |
| serialNumber | string | 로봇 식별 |

`timestamp`는 메시지 시각이지 경로 타임테이블이 아니다.

---

## 2. `order` (플릿 → 로봇)

| 필드 | 타입 | 의미 |
|------|------|------|
| orderId | string | |
| orderUpdateId | uint32 | 같은 주문의 갱신 |
| *orderDescription* | string | 사람용. 로직 금지 |
| **nodes[]** | node | |
| **edges[]** | edge | |

`sequenceId`는 노드·엣지가 **공유**한다. 노드 0, 엣지 1, 노드 2, …  
엣지 n 은 노드 n-1 과 n+1 을 잇는다.

### 2.1 node

| 필드 | 타입 | 의미 |
|------|------|------|
| nodeId | string | |
| sequenceId | uint32 | |
| released | boolean | true=base, false=horizon |
| **nodePosition** | object | `x,y` (m), *theta* (rad), `mapId` |
| *allowedDeviationXY* | m | 통과로 인정할 수평 오차 |
| *allowedDeviationTheta* | rad | |
| **actions[]** | action | 이 노드에서 실행 |

자유주행이어도 목적·경유는 이 노드다. A→B 의 B.

### 2.2 edge

| 필드 | 타입 | 의미 |
|------|------|------|
| edgeId | string | |
| sequenceId | uint32 | |
| startNodeId / 끝은 순서 | | 스펙상 startNodeId |
| released | boolean | |
| *maximumSpeed* | m/s | 엣지 최고속. **시간표 아님** |
| *length* | m | 라인 가이드가 정지 전 감속에 사용 |
| *orientation*, *orientationType* | | GLOBAL / TANGENTIAL |
| ***trajectory*** | NURBS | 기하. 생략 가능 |
| ***corridor*** | object | 이탈 허용 폭 |
| **actions[]** | | 엣지 위에 있는 동안만 |

### 2.3 trajectory (NURBS) — 시간 없음

```
trajectory {
  degree: uint32          // default 1
  knotVector: float64[]   // [0,1], 길이 = controlPoints + degree + 1
  controlPoints: [{ x, y, *weight* }]
}
```

클램핑 NURBS. 첫·끝 knot 다중도 `degree+1`.
**knot는 곡선 파라미터이지 ETA가 아니다.**

### 2.4 corridor

```
corridor {
  leftWidth: m
  rightWidth: m
  *corridorReferencePoint*: KINEMATIC_CENTER | CONTOUR
  *releaseRequired*: bool          // default false
  *releaseLossBehavior*: STOP | RETURN
}
```

---

## 3. `state` (로봇 → 플릿) — 주행 관측

주행·교통에 쓰는 핵심만.

| 필드 | 타입 | 의미 |
|------|------|------|
| orderId | string | 현재/직전 주문 |
| lastNodeId, lastNodeSequenceId | | 마지막(또는 현재) 노드 |
| **nodeStates[]** | | 주문 수행에 남은 노드 (idle이면 []) |
| **edgeStates[]** | | 남은 엣지. *trajectory* 는 사전 정의 궤적 ack |
| ***plannedPath*** | NURBS + traversedNodes[] | 자유주행. 현재 위치 시작, base 이상 |
| ***intermediatePath*** | polyline + **eta** | 자유주행. 가까운 앞, **유일한 점별 시각** |
| ***mobileRobotPosition*** | x,y,theta,mapId,localized | 라인 가이드는 생략 가능 |
| ***velocity*** | vx, vy, omega | 로봇 좌표계 m/s, rad/s |
| driving | bool | 주행/제자리회전 |
| *paused* | bool | |
| *newBaseRequest* | bool | 베이스 연장 요청 |
| *distanceSinceLastNode* | m | 라인 가이드 |
| ***zoneRequests[]*** | | RELEASE / REPLANNING |
| ***edgeRequests[]*** | | corridor 사용 허가 |
| operatingMode | enum | AUTOMATIC 등 |
| **errors[]** | | |
| ***information[]*** | | 로직 사용 금지 |

### 3.1 intermediatePath — 타임테이블에 가장 가까운 구조

```
intermediatePath {
  polyline: waypoint[]   // 현재 pose에서 시작
}

waypoint {
  x: m
  y: m
  *theta*: rad
  eta: string            // ISO 8601 UTC, 그 점 통과/도착 추정
}
```

매 state(및 visualization)마다 갱신.
길이는 로봇이 정함 → 벤더마다 호라이즌이 다름.

### 3.2 plannedPath

```
plannedPath {
  trajectory: { degree, knotVector, controlPoints }  // NURBS, 시각 없음
  *traversedNodes*: nodeId[]                         // 이 경로가 지나는 order 노드
}
```

경로가 **크게** 바뀔 때 갱신. 최소 현재 base를 덮어야 함.

### 3.3 velocity

```
velocity { *vx*, *vy*, *omega* }   // 로봇 프레임
```

eta가 없을 때 플릿이 등속 외삽에 쓸 수 있는 유일한 동역학 관측.
스펙이 그걸 교통 로직으로 쓰라고 하진 않는다.

### 3.4 zoneRequest / edgeRequest (요지)

```
requestId, requestType, requestStatus
// ACCESS | REPLANNING | (corridor 사용)
// REPLANNING 이면 trajectory NURBS를 요청에 첨부 가능
```

플릿 `responses`: `GRANTED | QUEUED | REJECTED | REVOKED`, optional `leaseExpiry`.

---

## 4. `visualization` (옵션)

state의 position, velocity, planned/intermediate path와 **같은 구조**, 더 잦은 주기.
뷰어용. 플릿이 여기만 믿고 교통하면 안 됨 (유실·QoS 0).
교통 입력의 정본은 `state`.

---

## 5. `factsheet` — 능력 계약

주행 관련:

| 필드 | 의미 |
|------|------|
| typeSpecification.navigationTypes[] | `PHYSICAL_LINE_GUIDED` / `VIRTUAL_LINE_GUIDED` / `FREELY_NAVIGATING` |
| typeSpecification.supportedZones[] | 이해 가능한 zoneType |
| physicalParameters.minimumSpeed / maximumSpeed | m/s |
| physicalParameters.maximumAcceleration / maximumDeceleration | |
| protocolLimits.timing.minimumStateInterval | state 최소 간격 |
| mobileRobotGeometry | 풋프린트 (corridor·존 컨투어) |

이기종 FMS는 **factsheet를 읽기 전에는** intermediatePath를 기대해서는 안 된다.

---

## 6. `zoneSet` (플릿 → 로봇)

```
zoneSetId, mapId
zones[]: {
  zoneId, zoneType,
  // BLOCKED | LINE_GUIDED | RELEASE | COORDINATED_REPLANNING |
  // SPEED_LIMIT | ACTION | PRIORITY | PENALTY | DIRECTED | BIDIRECTED
  polygon / 기하,
  // type별: maximumSpeed, priorityFactor, penaltyFactor,
  //         direction, releaseLossBehavior, actions, ...
}
```

내용이 바뀌면 **새 zoneSetId**. 활성은 instant action `enableZoneSet`.

---

## 7. 시간에 대한 필드 총정리

| 필드 | 어디에 | 시간인가? |
|------|--------|-----------|
| header.timestamp | 모든 메시지 | 메시지 시각 |
| waypoint.eta | intermediatePath | **예. 그 점 ETA** |
| leaseExpiry | response | 허가 만료 |
| maximumSpeed, length | edge | 상한·거리. 시각 아님 |
| knotVector | NURBS | 곡선 u ∈ [0,1] |
| newBaseRequest | state | “베이스 곧 끝남” 플래그 |
| visualization | 고주파 | 구조는 path와 같음. 정본 아님 |

**주문 전체의 타임테이블(노드별 통과 시각 배열)은 없다.**
