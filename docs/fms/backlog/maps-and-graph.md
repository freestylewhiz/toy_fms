# 멀티맵과 그래프 주행

상태: 논의 후보. 노드·엣지 편집은 존재하지만 그래프 실행은 미구현이다.
2026-09-16: yard/large_lab 프로세스·DB 격리와 웹 맵 전환은 구현했다.
한 서버의 다중 맵 운용·맵 간 로봇 이동·통합 점유는 아래 논의 범위로 남긴다.

## 결정할 질문

- mapId별 룸·리소스·로봇 상태·점유를 어떻게 분리할 것인가?
- 맵/그래프 버전이 바뀔 때 진행 작업과 기존 예약은 어떻게 처리할 것인가?
- waypoint와 node, charger와 station을 유지·통합·변환할 것인가?
- 동일 node/edge를 반복 통과하는 route step을 어떤 ID/순번으로 식별할 것인가?
- 방향별 엣지 예약, portal 진입, rail 강제 추종과 존 용량 제어를 어떻게 조합할 것인가?

후보 데이터는 routeId/revision, mapId/version, graphId/version, stepId/sequence다.
현재 공통 ResourceRef의 node/edge/stepId 표현만으로 예약 알고리즘이 구현된 것은 아니다.

범위를 합의하면 DB 전환, 서버 계약, 웹 편집, 로봇 실행을 나누고
다른 맵 간 간섭·반복 경로·버전 불일치 검증 기준을 먼저 정한다.
관련: PILOT-8, [통합 방향](../../concept/backlog/product-scope.md).

층간 좌표 이동의 구체적인 제안은 [텔레포터 리뷰 초안](../../concept/backlog/teleporter.md)에 정리한다. 카드 미등록·미구현 상태다.
