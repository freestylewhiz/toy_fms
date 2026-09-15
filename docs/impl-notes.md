# 구현 메모 (역사 문서)

현재 구현의 기준 문서가 아니다. 구조와 실행 방법은 [`README.md`](../README.md), [`architecture.md`](architecture.md), [`testing.md`](testing.md)를 따른다.

이미 있는 것: docs, proto, shared/{constants,occupancy,planner}.ts, occupancy.bin, seed.json, 스프라이트.

건드리지 마: `shared/`, `proto/`, `resources/`, `docs/` (버그 수정만).

package.json `type: module`. bun 1.x. TypeScript 그대로 실행.

Colyseus 0.16:
- server deps: `colyseus` `@colyseus/schema` `@colyseus/bun-websockets` (또는 `@colyseus/ws-transport` 폴백)
- tsconfig: `"experimentalDecorators": true`, `"useDefineForClassFields": false`
- web: `colyseus.js`

gRPC: `@grpc/grpc-js` `@grpc/proto-loader`, proto 경로 `../proto/robot.proto` (server와 virtual-robot 각각). keepCase: true, oneofs: true.

상대 import: `import { loadSeed } from "../../shared/occupancy.ts";`

서버는 **반드시** `import { Server, Room } from "@colyseus/core"` 를 쓴다.
`colyseus` 메타패키지/알리아스를 같이 쓰면 matchMaker 싱글톤이 두 개가 되어 HTTP `joinOrCreate("floor")`가 `room name not defined`로 죽는다.
