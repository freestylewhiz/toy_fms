/** Compatibility fix for the pinned @colyseus/core 0.16 full-state cache. */
export function invalidateEmptyRoomSnapshot(room: { clients: { length: number } }): void {
  // Never reset/replace the encoder: its reference IDs belong to live clients.
  const serializer = (room as unknown as {
    _serializer?: { encoder?: { hasChanges?: boolean }; needFullEncode?: boolean };
  })._serializer;
  if (room.clients.length === 0 && serializer?.encoder?.hasChanges) serializer.needFullEncode = true;
}
