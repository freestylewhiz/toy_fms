# 시스템 범위와 공통 계약

현재 제품은 맵 편집, 로봇 모니터링·이동·도킹·취소, 가상 로봇 주행 및 트래픽 중재를 제공하는 테스트 야드다.

~~~mermaid
flowchart LR
  Browser[웹 브라우저] -->|HTTP 5174| Web[web-client 정적 서버]
  Browser <-->|Colyseus 2568| FMS[FMS server]
  FMS <-->|gRPC 50062| Robot[virtual-robot]
  FMS --> Editor[(editor.sqlite)]
  FMS --> Runtime[(runtime.sqlite)]
~~~

웹은 gRPC에 직접 연결하지 않는다. 로봇은 Colyseus를 사용하지 않는다.
FMS는 리소스·운영 권한·트래픽을 관리하고, 가상 로봇이 경로를 계획하고 실제 주행 상태를 보고한다.

## 현재 범위

| 항목 | 상태 |
| --- | --- |
| yard 맵 편집·주행 | 구현 |
| large_lab 맵 편집·모니터링·가상 주행 | 별도 FMS·DB로 구현, 10000×10000 |
| 1st_floor 보기 | 읽기 전용 미리보기 |
| 금지·선호·비선호·속도·용량 존 | 주행에 적용 |
| 노드·엣지·스테이션·포털·레일 | 편집·저장, 그래프 주행과 실기 주문 실행은 미구현 |
| 운영 제외·점유 복구 | 영속화 및 명시적 재활성화 구현 |
| VDA 어댑터·MQTT·v2 시공간 트래픽 | 미구현 |

## 좌표와 상태

yard는 1600×1200 px, 1 px = 0.05 m다. 좌표는 x 오른쪽, y 아래쪽이다.
컨트롤러의 헤딩은 atan2(dy, dx)를 사용하므로 0은 오른쪽이고 양의 각도는 화면에서 시계 방향이다.
각도 저장 단위는 rad, 웹 입력은 도 단위를 함께 제공한다.

작업 상태(workState), 운영 참여(fmsControlState), 연결(connectionState), 실제 주행(driveState)을 분리한다.
운영 제외·명령 전송을 물리 정지·실제 이동으로 간주하지 않는다.
자유/그래프 주행 방식과 트래픽 정책 선택도 서로 다른 축이다.

근거: [상수](../../../shared/constants.ts), [상태 계약](../../../shared/robotRuntime.ts),
[서버 진입점](../../../server/src/index.ts), [웹 서버](../../../web-client/src/server.ts),
[로봇 컨트롤러](../../../virtual-robot/src/controller.ts).

맵별 포트·자산·실행 방법은 [대형 테스트맵](large-test-map.md)을 따른다. 두 실행 맵은 별도 프로세스로 격리한다.
