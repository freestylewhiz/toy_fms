import { RuntimeMapIds, type RuntimeMapId } from "./config/index.ts";
/** Runtime maps use separate processes and databases; preview maps have no server. */
export const RUNTIME_MAPS: Record<RuntimeMapId, {
  readonly id: RuntimeMapId; readonly width: number; readonly height: number; readonly colyseusPort: number; readonly grpcPort: number;
  readonly prefix: string; readonly image: string; readonly dataDirectory: string;
}> = {
  yard: { id: 'yard', width: 1600, height: 1200, colyseusPort: 2568, grpcPort: 50062, prefix: '', image: 'yard.png', dataDirectory: '' },
  large_lab: { id: 'large_lab', width: 10000, height: 10000, colyseusPort: 2569, grpcPort: 50063, prefix: 'large_lab.', image: 'large_lab.png', dataDirectory: 'large_lab' },
} as const;
export { RuntimeMapIds };
export function runtimeMap(id: string = 'yard') {
  if (!RuntimeMapIds.is(id)) throw new Error(`Unknown FMS_MAP_ID: ${id}`);
  return RUNTIME_MAPS[id as RuntimeMapId];
}
