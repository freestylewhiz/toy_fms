# 02 — 프로토콜

기존 `proto/robot.proto` 의 `RobotBridge.Session` 양방향 스트림을 확장한다.
`@grpc/proto-loader` 를 `keepCase: true` 로 로드하므로 **필드명은 snake_case 그대로** 쓴다.

---

## 1. 전체 정의

기존 메시지는 `// (기존)` 으로 표시했고, 나머지는 신규다.

```proto
syntax = "proto3";

package bgfms;

service RobotBridge {
  rpc Session(stream RobotToServer) returns (stream ServerToRobot);
}

// ─────────────────────────────────────────────────────────────
//  봉투
// ─────────────────────────────────────────────────────────────

message RobotToServer {
  oneof payload {
    RegisterRequest  register       = 1;   // (기존)
    PoseUpdate       pose           = 2;   // (기존, 확장)
    PathUpdate       path           = 3;   // (기존, 확장)
    PlaceReply       place_reply    = 4;   // (기존)

    LeaseRequest     lease_request  = 5;
    LeaseRelease     lease_release  = 6;
    TrafficBid       traffic_bid    = 7;
    EvasionReply     evasion_reply  = 8;
    BreadcrumbUpdate breadcrumb     = 9;
  }
}

message ServerToRobot {
  oneof payload {
    DriveCommand     drive            = 1;  // (기존)
    CancelCommand    cancel           = 2;  // (기존)
    PlaceQuery       place_query      = 3;  // (기존)
    ObstacleSnapshot obstacles        = 4;  // (기존)

    LeaseGrant       lease_grant      = 5;
    BidRequest       bid_request      = 6;
    EvasionRequest   evasion_request  = 7;
    ZoneUpdate       zone_update      = 8;
  }
}

// ─────────────────────────────────────────────────────────────
//  기하 — 회랑
// ─────────────────────────────────────────────────────────────

// 선분 (x1,y1)-(x2,y2) 에서 거리 r 이내인 점의 집합 (스타디움/캡슐).
// 점 회랑은 x1==x2, y1==y2 로 표현한다.
message Capsule {
  double x1 = 1;
  double y1 = 2;
  double x2 = 3;
  double y2 = 4;
  double r  = 5;
}

// 캡슐들의 합집합. 연결되어 있을 필요는 없다.
message Corridor {
  repeated Capsule segments = 1;
}

// ─────────────────────────────────────────────────────────────
//  임대 — 이 프로토콜의 심장
// ─────────────────────────────────────────────────────────────

message LeaseRequest {
  string   robot_id   = 1;
  string   request_id = 2;   // 로봇이 발급. 응답 매칭용
  string   lease_id   = 3;   // 기존 임대 확장이면 그 id, 신규면 ""
  Corridor wanted     = 4;   // 새로 확보하고 싶은 영역 (이미 쥔 것 제외)
  double   gain_px    = 5;   // 이 회랑으로 벌 수 있는 주행거리. 우선순위 힌트
  bool     urgent     = 6;   // true = 이거 없으면 곧 멈춘다
}

enum Signal {
  SIGNAL_STOP    = 0;   // 빨강 — 승인 없음. 보유 영역 안에서 대기
  SIGNAL_PROCEED = 1;   // 초록 — 요청 전부 승인
  SIGNAL_PARTIAL = 2;   // 노랑 — 앞부분만 승인. 거기까지 가서 다시 요청
}

message LeaseGrant {
  string   request_id     = 1;
  string   lease_id       = 2;
  Signal   signal         = 3;
  Corridor held           = 4;   // ★ 델타가 아니라 '현재 보유 전체'. 멱등
  int64    lease_until_ms = 5;   // 절대시각 아님 — §4.3 참조
  string   zone_id        = 6;   // 다툼 중이면 존 id, 아니면 ""
  string   reason         = 7;   // 로그/UI 용. 로봇 로직은 이걸 쓰지 않는다
}

message LeaseRelease {
  string   robot_id = 1;
  string   lease_id = 2;
  Corridor freed    = 3;   // 확실히 벗어난 부분
  Corridor retained = 4;   // 계속 쥐겠다고 주장하는 부분 (FMS 교차검증용)
}

// ─────────────────────────────────────────────────────────────
//  트래픽 존 / 우선순위
// ─────────────────────────────────────────────────────────────

message BidRequest {
  string zone_id     = 1;
  int64  window_ms   = 2;   // 이 시간 안에 회신
}

message TrafficBid {
  string zone_id = 1;
  double seed    = 2;   // [0, 100) 실수
}

message ZoneUpdate {
  string zone_id = 1;
  string state   = 2;   // FORMING | ACTIVE | EVADING | DRAINING | LEFT
}

// ─────────────────────────────────────────────────────────────
//  에스컬레이션 — capability query
// ─────────────────────────────────────────────────────────────

enum EvasionMode {
  EVASION_REROUTE = 0;  // 목적지는 유지. 다른 길로 가는 회랑을 내라
  EVASION_VACATE  = 1;  // 목적지는 잊어라. 그 영역에서 빠져나갈 회랑을 내라
}

message EvasionRequest {
  string      zone_id         = 1;
  string      round_id        = 2;
  string      lease_id        = 3;
  Corridor    release_hint    = 4;  // ★ '이 로봇이 쥔 임대'의 부분집합. 남의 정보 아님
  EvasionMode mode            = 5;
  repeated string breadcrumb_hint = 6;  // 이 로봇 '자신의' breadcrumb id
  int64       deadline_ms     = 7;
}

message EvasionReply {
  string       zone_id       = 1;
  string       round_id      = 2;
  string       result        = 3;  // REROUTE | VACATE | NONE
  PathUpdate   plan          = 4;  // result != NONE 이면 새 계획
  LeaseRequest lease_request = 5;  // 새 회랑 요청 동봉 (왕복 1회 절약)
  string       reason        = 6;
}

// ─────────────────────────────────────────────────────────────
//  상태 보고
// ─────────────────────────────────────────────────────────────

message PoseUpdate {
  string robot_id       = 1;  // (기존)
  double x              = 2;  // (기존)
  double y              = 3;  // (기존)
  double theta          = 4;  // (기존)
  string status         = 5;  // (기존) idle | move
  string lease_id       = 6;
  string motion         = 7;  // IDLE | FOLLOW | HOLD | EVADE | LEASE_LOST
  bool   avoidance_mode = 8;
  double head_room_px   = 9;  // 회랑 경계까지 남은 진행 여유. 처리량 지표
}

message PathPoint {          // (기존)
  double x = 1;
  double y = 2;
}

message PathNode {
  double x         = 1;
  double y         = 2;
  double s         = 3;  // 시작점부터 누적 호길이 (px)
  double clearance = 4;  // 로봇이 잰 자유 반경. 안전 판정에 쓰지 않음
}

// ⚠ 경로는 '약속'이 아니라 '예보'다 (F1). 안전은 임대가 담당하고,
//   이 메시지는 L1 효율 계층(통과 순서 예측)에서만 쓴다.
message PathUpdate {
  string   robot_id = 1;  // (기존)
  repeated PathPoint points = 2;  // (기존) UI 표시용 코너
  string   plan_id  = 3;
  repeated PathNode nodes = 4;    // COORD_SAMPLE_PX 간격
  double   total_s  = 5;
}

message Breadcrumb {
  string id         = 1;
  double x          = 2;
  double y          = 3;
  double theta      = 4;
  int64  visited_ms = 5;
}

message BreadcrumbUpdate {
  string robot_id = 1;
  repeated Breadcrumb added = 2;
}

// ─────────────────────────────────────────────────────────────
//  기존 메시지 (변경 없음)
// ─────────────────────────────────────────────────────────────

message RegisterRequest { string robot_id = 1; }
message DriveCommand {
  string command_id = 1;
  string kind = 2;
  double x = 3;
  double y = 4;
  double theta = 5;
}
message CancelCommand { string command_id = 1; }
message ObstacleShape {
  string id = 1;
  string kind = 2;
  double x = 3;
  double y = 4;
  double size = 5;
  double theta = 6;
}
message PlaceQuery { string query_id = 1; ObstacleShape obstacle = 2; }
message PlaceReply {
  string query_id = 1;
  string robot_id = 2;
  bool ok = 3;
  string reason = 4;
}
message ObstacleSnapshot { repeated ObstacleShape items = 1; }
```

---

## 2. 메시지 의미론

### 2.1 `LeaseRequest` — "이 공간 좀 쓸게"

로봇이 보낸다. 회랑의 **모양과 넓이를 로봇이 정한다.**

- `wanted` 는 **아직 안 쥔 부분만** 담는다. 이미 보유한 영역은 다시 요청하지 않는다.
- 반경 `r` 은 로봇이 고른다. 좁게 요청하면 승인 확률이 오르고 회피 기동 여유가 준다.
  넓게 요청하면 반대. **이 트레이드오프의 주인은 로봇이다** — 여기서 사람을 피하려면
  얼마나 필요한지는 로봇만 안다.
- `CORRIDOR_MIN_RADIUS ≤ r ≤ CORRIDOR_MAX_RADIUS`. FMS가 범위를 강제한다.
- `gain_px` 와 `urgent` 는 FMS의 할당 휴리스틱 입력이다. 안전 판정에는 안 쓴다.

### 2.2 `LeaseGrant` — 신호등

| 신호 | 의미 | 로봇의 행동 |
|------|------|-------------|
| `SIGNAL_PROCEED` | 요청 전부 승인 | 그대로 진행 |
| `SIGNAL_PARTIAL` | 앞부분만 승인 | 승인된 데까지 가서 정지 → 재요청 |
| `SIGNAL_STOP` | 승인 없음 | **현재 보유 영역 안에서** 정지 |

**`held` 는 델타가 아니라 현재 보유 전체다.** 스냅샷을 매번 통째로 보내는 이유:

- 패킷 유실/재정렬이 있어도 로봇과 FMS의 원장이 갈라지지 않는다.
- 로봇은 `held` 를 그대로 덮어쓰면 되므로 병합 로직이 필요 없다.
- 회랑은 캡슐 몇 개라 크지 않다 (5초분 ≈ 캡슐 3~5개).

`reason` 은 사람이 읽는 용도다. **로봇 로직은 `reason` 을 파싱하지 않는다.**
거절 사유의 기하를 흘리면 P1이 샌다.

### 2.3 `LeaseRelease` — 반납은 로봇이 한다 (F2의 직접적 해법)

FMS는 pose 를 보고 "여기까지 왔으니 뒤쪽은 비었겠지"라고 **추론하면 안 된다.**
FMS가 아는 pose 는 이미 과거다. 로봇만이 자기가 어디를 확실히 벗어났는지 안다.

- 로봇은 몸이 `RELEASE_HYSTERESIS_PX` 이상 확실히 벗어난 캡슐만 `freed` 에 담는다.
- `retained` 는 교차검증용이다. FMS는 `freed ∪ retained == held` 를 확인하고,
  다르면 반납을 무시하고 경보한다. (원장 desync 조기 검출)

결과: **pose 가 안전 경로에서 완전히 제거된다.** pose 는 UI 와 처리량 지표, 그리고
버그 감시에만 쓴다.

### 2.4 `EvasionRequest` — 좌표가 없다는 점

`release_hint` 는 **그 로봇이 이미 쥔 임대의 부분집합**이다.
FMS가 새 좌표를 만들어내는 게 아니라, "네가 가진 것 중 이만큼을 놓아달라"고 말할 뿐이다.

- 남의 위치·경로·회랑이 실릴 자리가 스키마에 없다 → **P1이 문법 수준에서 강제된다.**
- FMS가 맵을 몰라도 만들 수 있다 (이미 승인했던 영역이므로) → **P2 준수.**

`EVASION_VACATE` 는 목적지를 포기하고 일단 비키라는 뜻이다. 로봇은 자기가 아는
여유 공간(또는 `breadcrumb_hint`)으로 짧은 회랑을 만들어 답한다.

### 2.5 `PathUpdate` — 예보이지 약속이 아니다

F1 때문에 경로는 지켜진다는 보장이 없다. 그래서:

- **안전 판정에 쓰지 않는다.** L1 효율 계층(통과 순서 예측)에서만 쓴다.
- 로봇이 replan 해도 **멈출 필요가 없다.** 기존 임대 안이면 계속 움직여도 된다.
  (경로 기반 방식이었다면 replan 시 권한이 무효가 되어 정지해야 했다. 이 방식의 이점.)
- `clearance` 는 FMS가 "여기서 우회로가 나올 가망이 있나"를 판단하는 힌트 전용이다.
  안전 판정 입력 금지, 다른 로봇에게 전달 금지.

---

## 3. 프로토콜 불변식

구현이 지켜야 할 것. 위반은 전부 버그다.

| # | 불변식 | 검증 위치 |
|---|--------|-----------|
| **PI1** | FMS 원장의 모든 회랑은 쌍쌍이 disjoint (`CORRIDOR_GAP_PX` 이상 이격) | FMS 승인 직전 |
| **PI2** | 로봇 footprint ⊆ 자기 `held` | 로봇 `applyPose` |
| **PI3** | `LeaseGrant.held` 는 항상 현재 보유 전체 (델타 아님) | FMS 송신부 |
| **PI4** | `freed ∪ retained == held` (반납 시) | FMS 수신부 |
| **PI5** | 리스 만료 후 로봇은 **어떤 이동도 하지 않는다** | 로봇 tick |
| **PI6** | FMS는 로봇에게 보낸 어떤 필드에도 다른 로봇에서 유래한 기하를 넣지 않는다 | 코드 리뷰 + 타입 |
| **PI7** | `CORRIDOR_MIN_RADIUS ≤ r ≤ CORRIDOR_MAX_RADIUS` | FMS 수신부 |

---

## 4. 타이밍과 신뢰성

### 4.1 요청 시점

로봇은 **선제적으로** 요청한다. 다 쓰고 나서 요청하면 매번 멈춘다.

```
남은 진행 여유 head_room_px < LINEAR_SPEED_PX_S × LEASE_REQUEST_AHEAD_S (= 24 px)
  → LeaseRequest 송신
```

### 4.2 응답 없음

`LEASE_MS` 안에 `LeaseGrant` 가 안 오면 로봇은 **보유 영역 안에서 정지**한다.
재요청은 지수 백오프 없이 고정 주기(`AUTHORITY_HZ`)로 계속한다 — 멈춰 있는 로봇이
빨리 풀려나는 게 중요하므로.

### 4.3 리스 시각은 절대시각이 아니다

`lease_until_ms` 는 이름과 달리 **FMS 기준 잔여 시간(duration)** 으로 해석한다.
로봇은 `수신 시각 + lease_until_ms` 로 자기 시계에서 환산한다.
클럭 스큐를 피하기 위해서다. (필드명은 관용상 유지하되 주석으로 명시)

### 4.4 순서 보장

gRPC 양방향 스트림은 방향별 순서를 보장한다. 그래도:

- `LeaseGrant` 는 `request_id` 로 매칭한다. 늦게 도착한 옛 응답은 버린다.
- `held` 가 멱등 스냅샷이므로, 최신 것 하나만 적용하면 항상 정합적이다.

---

## 5. Colyseus 상태 (웹 UI)

웹 클라이언트는 gRPC 를 쓰지 않는다. `FloorState` 에 다음을 올린다.

```ts
class LeaseView extends Schema {
  @type("string") robotId: string;
  @type("string") leaseId: string;
  @type("string") signal: string;       // PROCEED | PARTIAL | STOP
  @type([CapsuleView]) segments: ArraySchema<CapsuleView>;
}

class TrafficZoneView extends Schema {
  @type("string") id: string;
  @type("string") state: string;
  @type(["string"]) members: ArraySchema<string>;
}

// FloorState 에 추가
@type({ map: LeaseView }) leases = new MapSchema<LeaseView>();
@type({ map: TrafficZoneView }) zones = new MapSchema<TrafficZoneView>();
```

UI 렌더링 항목은 `07_implementation.md` §4.
