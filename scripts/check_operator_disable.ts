/** Isolated live-process regression: operator exclusion during teleporter clearing. */
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { Database } from 'bun:sqlite';
import { Client } from '../web-client/node_modules/colyseus.js/build/esm/index.mjs';

const root = `/tmp/fms-operator-disable-${Date.now()}`;
mkdirSync(root, { recursive: true });
const offset = Number(process.env.E2E_PORT_OFFSET || 12500);
const common = { ...process.env, FMS_PORT_OFFSET: String(offset), FMS_DATA_ROOT: root, TELEPORTER_SQLITE_PATH: join(root, 'teleporters.sqlite') };
const processes: Bun.Subprocess[] = [];
const rooms: any[] = [];
let db: Database | undefined;
let passed = false;
let generation = 0;
function spawn(name: string, file: string, map: string, args: string[] = []) {
  const child = Bun.spawn(['bun', file, ...args], { env: { ...common, FMS_MAP_ID: map }, stdout: Bun.file(join(root, `${name}-${generation}.log`)), stderr: Bun.file(join(root, `${name}-${generation}.err`)) });
  processes.push(child); return child;
}
async function until(check: () => boolean, label: string, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return; await Bun.sleep(25); }
  throw new Error(`Timed out: ${label}; logs: ${root}`);
}
async function connect(port: number) {
  const end = Date.now() + 20000;
  while (true) {
    try {
      const room = await new Client(`ws://127.0.0.1:${port + offset}`).joinOrCreate('floor');
      room.onMessage('*', () => {}); rooms.push(room);
      await until(() => !!room.state?.robots, 'initial room state');
      return room;
    } catch (error) { if (Date.now() >= end) throw error; await Bun.sleep(200); }
  }
}
function robot(room: any) { return room.state.robots.get('robot-1'); }
async function control(room: any, enabled: boolean) {
  const requestId = crypto.randomUUID(); let ack: any;
  room.onMessage('runtimeAck', (value: any) => { if (value.requestId === requestId) ack = value; });
  room.send('setRobotControl', { robotId: 'robot-1', enabled, requestId, expectedEpoch: robot(room).controlEpoch });
  await until(() => !!ack, `control ${enabled} ack`);
  assert.equal(ack.ok, true, ack.message);
}
try {
  const yardServer = spawn('yard', 'server/src/index.ts', 'yard');
  let labServer = spawn('lab', 'server/src/index.ts', 'large_lab');
  const yard = await connect(2568);
  let lab = await connect(2569);
  let virtualRobot = spawn('robot', 'virtual-robot/src/index.ts', 'yard', ['--id', 'robot-1']);
  await until(() => robot(yard)?.connected && robot(yard)?.controlReady, 'Yard robot ready');
  const polygon = (half: number) => [{ x: -half, y: -half }, { x: half, y: -half }, { x: half, y: half }, { x: -half, y: half }];
  let saved = false;
  yard.onMessage('teleporterAck', (ack: any) => { if (ack.requestId === 'fixture') { assert(ack.ok); saved = true; } });
  yard.send('teleporterUpsert', { requestId: 'fixture', definition: { id: 'disable-test', name: 'disable-test', type: 'teleporter', revision: 1, enabled: true, endpoints: [
    { id: 'yard-end', mapId: 'yard', position: { x: 240, y: 520 }, entryTheta: 0, exitTheta: 0, occupancyPolygon: polygon(20), clearingPoint: { x: 280, y: 520 } },
    { id: 'lab-end', mapId: 'large_lab', position: { x: 1300, y: 1300 }, entryTheta: 0, exitTheta: 0, occupancyPolygon: polygon(100), clearingPoint: { x: 1540, y: 1300 } },
  ] } });
  await until(() => saved, 'definition saved');
  lab.send('editorUpsert', { kind: 'zone', id: 'recovery-zone', family: 'scene', zoneKind: 'corridor', name: 'recovery-zone', theta: 0, capacity: 1, polygon: [ { x: 1150, y: 1150 }, { x: 1600, y: 1150 }, { x: 1600, y: 1450 }, { x: 1150, y: 1450 } ] });
  await until(() => lab.state.zones.has('recovery-zone'), 'destination zone');
  await Bun.sleep(400);
  db = new Database(join(root, 'teleporters.sqlite'), { readonly: true });
  yard.send('commandRobot', { robotId: 'robot-1', kind: 'teleporter', targetId: 'disable-test', endpointId: 'yard-end' });
  await until(() => robot(lab)?.connected && robot(lab)?.controlReady && !!db!.query("SELECT 1 FROM teleporter_transfers WHERE robot_id='robot-1' AND phase='clearing'").get(), 'destination clearing');
  const transfer: any = db.query("SELECT * FROM teleporter_transfers WHERE robot_id='robot-1'").get();
  assert(db.query("SELECT 1 FROM teleporter_uses WHERE robot_id='robot-1'").get(), 'reservation exists before force release');
  await control(lab, false);
  await until(() => robot(lab).fmsControlState === 'disabled', 'disabled projection');
  assert.equal(db.query("SELECT 1 FROM teleporter_uses WHERE robot_id='robot-1'").get(), null);
  assert.equal(db.query("SELECT 1 FROM teleporter_queue WHERE robot_id='robot-1'").get(), null);
  assert.equal((db.query('SELECT phase FROM teleporter_transfers WHERE transfer_id=?').get(transfer.transfer_id) as any).phase, 'failed');
  await until(() => !JSON.parse(lab.state.runtimeOccupanciesJson || '[]').some((item: any) => item.robotId === 'robot-1'), 'all logical zone claims removed');
  const seen = robot(lab).lastSeenAt;
  await until(() => robot(lab).lastSeenAt > seen, 'disabled telemetry continues');
  await until(() => !JSON.parse(readFileSync(join(root, 'robots', 'robot-robot-1.teleporter.json'), 'utf8')).pending, 'pending transfer journal cleared');
  const pose = { x: robot(lab).x, y: robot(lab).y };
  virtualRobot.kill(); await virtualRobot.exited;
  await lab.leave(); labServer.kill(); await labServer.exited;
  generation++;
  labServer = spawn('lab', 'server/src/index.ts', 'large_lab');
  lab = await connect(2569);
  virtualRobot = spawn('robot', 'virtual-robot/src/index.ts', 'yard', ['--id', 'robot-1']);
  await until(() => robot(lab)?.connected, 'disabled robot reconnects after FMS and robot restart');
  assert.equal(robot(lab).fmsControlState, 'disabled');
  assert.equal(robot(lab).controlReady, false);
  assert(Math.hypot(robot(lab).x - pose.x, robot(lab).y - pose.y) < 2, 'restart preserves physical pose');
  assert.equal(db.query("SELECT 1 FROM teleporter_uses WHERE robot_id='robot-1'").get(), null);
  assert(!JSON.parse(lab.state.runtimeOccupanciesJson || '[]').some((item: any) => item.robotId === 'robot-1'));
  await control(lab, true);
  await until(() => robot(lab).controlReady && robot(lab).fmsControlState === 'enabled', 'explicit reactivation');
  assert.equal(robot(lab).workState, 'idle');
  assert.equal((db.query('SELECT phase FROM teleporter_transfers WHERE transfer_id=?').get(transfer.transfer_id) as any).phase, 'failed', 'reactivation cannot resume aborted transfer');
  lab.send('commandRobot', { robotId: 'robot-1', kind: 'move', x: 1540, y: 1300, theta: 0 });
  await until(() => robot(lab).commandState === 'completed' && Math.hypot(robot(lab).x - 1540, robot(lab).y - 1300) < 1, 'new command after recovery', 30000);
  console.log('PASS: force exclusion during clearing releases claims, preserves telemetry/pose, survives robot+FMS restart, and requires explicit reactivation before new movement.');
  passed = true;
} finally {
  for (const room of rooms) { try { await Promise.race([room.leave(), Bun.sleep(500)]); } catch {} }
  for (const child of processes) { try { child.kill(); await child.exited; } catch {} }
  db?.close();
  if (passed) rmSync(root, { recursive: true, force: true });
  else console.error(`Preserved diagnostics: ${root}`);
}
