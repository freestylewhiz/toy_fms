# 텔레포터 후속 논의

PILOT-13~16의 구현과 검증은 완료했다. 현재 동작과 확정 정책은 [current/teleporter.md](../current/teleporter.md)에 기록한다.

## 남은 주제

- **동일 층 연결**: [동일 맵 텔레포터 검토](teleporter-same-map.md). 같은 맵의 두 끝점을 연결하는 모델·편집·제어 동기화 변경 검토.

- 물리적 대기열: 지정 대기 구역, 줄서기 경로, 동적 슬롯과 수용 한도. 상세 논의는 [DISC-001](DISC-001-teleporter-queue-management.md)에서 진행한다.
- 시각적 진입 미리보기와 자동 map 추적 여부.
- 실기·다중 사이트 연동과 사이트별 map registry.
- 운영자 복구 UI와 부하 시험.

새 기능 구현 전 사용자와 범위·완료 기준을 합의하고 해당 컴포넌트의 todo에 등록한다.
