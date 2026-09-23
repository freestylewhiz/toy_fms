# 텔레포터 공통 계약

기준: 2026-09-16, PILOT-13~16. 적용 대상은 현재 가상 로봇과 운용 맵 `yard`, `large_lab`이다.

## 모델과 단위

영문 리소스 타입은 `teleporter`다. 본체는 특정 맵에 속하지 않으며 서로 다른 맵을 참조하는
정확히 두 끝점을 `endpoints` 리스트로 가진다. 방향은 리스트 순서가 아니라 끝점 ID로 결정한다.

```ts
Teleporter {
  id, name, enabled, revision,
  endpoints: [{
    id, mapId,
    position: { x, y },
    entryTheta, exitTheta,
    occupancyPolygon: [{ x, y }, ...],
    clearingPoint: { x, y }
  }, ...]
}
```

- 위치·이탈 지점은 해당 맵의 절대 픽셀 좌표다. 현재 해상도는 20 px/m다.
- `occupancyPolygon`은 끝점 위치 기준 로컬 오프셋이다. 기본값은 중심을 감싸는 40×40 px 사각형이다.
- 헤딩은 저장·통신에서 rad, 웹 입력에서 도 단위를 쓴다. 진입·출구 헤딩은 각각 독립적이다.
- A에서 B로 이동하면 A의 `entryTheta`로 정렬하고 B의 위치와 `exitTheta`를 적용한다.
- 도착 후 B의 `clearingPoint`로 자동 이동한다. 몸체의 완전 이탈과 명령 완료는 별도 조건이다.
- 단순 통과로 층을 이동하지 않는다. 로봇에 텔레포터 명령을 내려야 한다.

## 저장과 변경

두 FMS 프로세스가 공통 `data/teleporters.sqlite`를 사용한다. 정의·끝점과 이용권·대기열·이전 기록·로봇 소유권은
별도 테이블이다. 기존 맵별 편집 DB나 일반 리소스 ID를 일괄 이관하지 않는다.

두 끝점을 한 트랜잭션으로 저장하며 맵 참조, 좌표 경계, 서로 다른 맵, 고유 끝점 ID,
유한 값, 단순 폴리곤, 끝점 포함 여부와 영역 밖 이탈 지점을 검증한다.
사용 중인 정의 변경을 제한하고, 웹 수정은 `expectedRevision`으로 오래된 편집을 감지한다.

## 식별과 범위

Yard와 Large Lab의 기본 로봇은 모두 `robot-1`, `robot-2`다. 로봇 ID는 물리 로봇의 전역 식별자이며 맵 접두사를 붙이지 않는다. 기존 `large_lab:robot-N` 저장 행은 시작 시 기본 ID로 통합한다.
층을 이동해도 전역 로봇 ID는 유지한다. 전환마다 별도의 이전 ID와 제어 세대를 사용한다.
도착 전환이 완료되면 source map의 live projection은 제거하고 destination map만 공용 world에
현재 pose와 상태를 게시한다. 따라서 한 물리 로봇이 두 맵의 상태 탭에 동시에 나타나지 않는다.
연결 단절이나 결과 불명만으로 출발 위치에 되돌리거나 점유를 해제하지 않는다.

고정 `waiting_pose`와 물리적 대기 슬롯은 사용하지 않는다. 접근 중 대기와 논리적 이용 순서가 초기 정책이다.
물리적 줄서기·대기 공간 최적화는 [DISC-001](../backlog/DISC-001-teleporter-queue-management.md)에서 별도 논의한다.

## 근거

- [공통 타입·기하](../../../shared/teleporterRuntime.ts)
- [정본·실행 기록](../../../server/src/teleporterStore.ts)
- [웹 편집 정책](../../web/current/teleporter.md)

변경 이력: 2026-09-16 — 사용자 승인 범위의 데이터 계약을 현행 문서로 분리했다.
2026-09-21 — `large_lab:robot-N` 레거시 행을 기본 전역 ID로 이관하고 source/destination
projection 중복을 제거했다.
