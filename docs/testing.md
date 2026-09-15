# 테스트 및 검증

검증 보고서: [`fms-validation-2026-09-15.txt`](/project_workspace/fms-validation-2026-09-15.txt). 모든 테스트는 대상의 disposable copy에서 실행했고 원본과 작업 대상 데이터는 사용하지 않았다.

```sh
bun test                         # 67 pass, 0 fail, 16 files
bun run test:traffic-v1          # 11 pass, 0 fail
bun run smoke                    # planner smoke: 2 spawn, 6 route checks
```

서비스와 가상 로봇 2대를 실행한 뒤 웹 포트를 임시로 5175로 바꾸어 다음을 순차 실행했다.

```sh
ATLAS_WEB_URL=http://127.0.0.1:5175 bun run check:properties:web
ATLAS_WEB_URL=http://127.0.0.1:5175 bun run check:runtime:web
ATLAS_WEB_URL=http://127.0.0.1:5175 bun run check:workspace:web
ATLAS_WEB_URL=http://127.0.0.1:5175 bun run check:driving:web
```

네 명령 모두 standalone 재실행에서 통과했다. driving 검증은 gRPC 이동·완료·재연결까지 확인한다. `check:driving:live`와 `check:driving:web`은 실제 서버와 로봇에 명령을 보내므로 다른 운용 명령이 없는 환경에서 순차 실행한다.

초기 병렬 실행의 workspace와 driving은 timeout이었으나 standalone 재실행에서 통과했으며, 임시 서비스는 정리했다.
