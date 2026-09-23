import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PROTOCOL_MESSAGES } from './messages.ts';
import { TrafficSignalWireNames, TrafficSignalWireNumbers, EvasionWireNames, EvasionWireNumbers } from './fms.ts';
import { parseTrafficSignal } from '../traffic/types.ts';

test('every RobotBridge wire message has a display label in the protocol catalog', () => {
  const source = readFileSync(new URL('../../proto/robot.proto', import.meta.url), 'utf8');
  const names = new Set<string>();
  for (const envelope of ['RobotToServer', 'ServerToRobot']) {
    const block = source.match(new RegExp(`message ${envelope} \\{[\\s\\S]*?oneof payload \\{([\\s\\S]*?)\\}`))?.[1];
    expect(block).toBeDefined();
    for (const match of block!.matchAll(/\w+\s+(\w+)\s*=\s*\d+;/g)) names.add(match[1]);
  }
  expect([...PROTOCOL_MESSAGES.values].sort()).toEqual([...names].sort());
  for (const name of names) expect(PROTOCOL_MESSAGES.labels[name]).toMatch(/[가-힣]/);
});

test('malformed numeric signal containers cannot authorize robot movement', () => {
  for (const malformed of [[1], [2], { value: 1 }, null, undefined, true]) expect(parseTrafficSignal(malformed)).toBe('STOP');
  for (const valid of [1, '1', 'PROCEED', 'SIGNAL_PROCEED']) expect(parseTrafficSignal(valid)).toBe('PROCEED');
  for (const valid of [2, '2', 'PARTIAL', 'SIGNAL_PARTIAL']) expect(parseTrafficSignal(valid)).toBe('PARTIAL');
});

test('numeric traffic aliases stay compatible with the protobuf enum values', () => {
  const source = readFileSync(new URL('../../proto/robot.proto', import.meta.url), 'utf8');
  for (const [name, catalog, numbers] of [
    ['Signal', TrafficSignalWireNames, TrafficSignalWireNumbers],
    ['EvasionMode', EvasionWireNames, EvasionWireNumbers],
  ] as const) {
    const block = source.match(new RegExp(`enum ${name} \\{([\\s\\S]*?)\\}`))?.[1];
    expect(block).toBeDefined();
    const entries = [...block!.matchAll(/(\w+)\s*=\s*(\d+);/g)].map(match => [match[1], Number(match[2])]);
    expect({ ...numbers.code }).toEqual(Object.fromEntries(entries));
    expect([...catalog.values].sort()).toEqual(entries.map(entry => entry[0]).sort());
  }
});
