# VDA 5050 — 자율주행 관련 프로토콜

이 폴더는 **VDA 5050 Version 3.0.0** (VDA/VDMA, 2025) 중
**주행·경로·교통**에 해당하는 부분만 발췌·정리한다.
원문 전체나 JSON Schema를 대체하지 않는다.
원문: [VDA5050/VDA5050](https://github.com/VDA5050/VDA5050) (`VDA5050_EN.md`), VDA PDF V3.0.0.

bg_fms 와의 대응은 [`03_bg_fms_interface.md`](./03_bg_fms_interface.md).
맵에 무엇을 그리는지는 [`04_map_editor.md`](./04_map_editor.md).

---

## 한 줄

> VDA5050은 이기종 모바일 로봇 ↔ 플릿 컨트롤 MQTT 인터페이스다.
> 교통의 기본 단위는 로봇이 올린 `(x,y,t)` 가 아니라, **플릿이 풀어 준 node–edge (base)** 이다.
> 자유주행 로봇만 state에 `intermediatePath`(점마다 ETA)를 실어, 우리 v2 로컬 플랜과 비슷한 입력을 만든다.

---

## 문서

| 파일 | 내용 |
|------|------|
| [`01_protocol.md`](./01_protocol.md) | 토픽, 주문/베이스/호라이즌, 두 가지 주행 모델, 존·회랑 |
| [`02_data.md`](./02_data.md) | 주행에 쓰는 메시지·필드 명세 |
| [`03_bg_fms_interface.md`](./03_bg_fms_interface.md) | bg_fms v2 / 사용자 존과 매핑, 어댑터 설계 |
| [`04_map_editor.md`](./04_map_editor.md) | FMS 맵 에디터 — 시맨틱 리소스 필요 기능 |
| [`05_semantic_resources.md`](./05_semantic_resources.md) | 존·노드·엣지·회랑 폭 등 저장 객체 |

---

## 버전 주의

| 버전 | 자유주행 경로 공유 |
|------|-------------------|
| ≤ 2.x | Order `trajectory`(NURBS, 시각 없음). State는 pose·속도·남은 node/edge. ETA 경로 없음 |
| **3.0** | `intermediatePath.eta`, `plannedPath`, `zoneSet`, edge `corridor`, request/response |

이 폴더는 **3.0.0** 기준이다. 현장 로봇이 2.x면 eta 경로를 기대해서는 안 된다.
