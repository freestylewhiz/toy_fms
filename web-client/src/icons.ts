const paths: Record<string, string> = {
  select: '<path d="m5 3 13 9-7 1-3 7Z"/>',
  move: '<path d="M4 17V7h14m-5-5 5 5-5 5"/><circle cx="4" cy="18" r="2"/>',
  dock: '<path d="M4 5v14h16V5M8 3v7h8V3m-4 7v6m-3-3 3 3 3-3"/>',
  waypoint: '<circle cx="12" cy="12" r="6"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/><circle cx="12" cy="12" r="1"/>',
  charger: '<path d="m13 2-8 12h6l-1 8 9-13h-6Z"/>',
  obstacle: '<path d="m12 3 9 17H3Z"/><path d="M12 9v5m0 3h.01"/>',
  forbidden: '<path d="m5 4 13 2 3 12-12 3-7-9Z"/><path d="m8 8 8 8m0-8-8 8"/>',
  prefer: '<path d="m5 4 13 2 3 12-12 3-7-9Z"/><path d="m7 12 3 3 7-7"/>',
  avoid: '<path d="m5 4 13 2 3 12-12 3-7-9Z"/><path d="M7 12h10"/>',
  corridor: '<path d="M3 6h18M3 18h18m-17-6h16m-4-4 4 4-4 4"/>',
  complex: '<path d="M8 3h8v5h5v8h-5v5H8v-5H3V8h5Z"/>',
  node: '<circle cx="12" cy="12" r="5"/><path d="M3 3l5 5m8 8 5 5M3 21l5-5m8-8 5-5"/>',
  edge: '<circle cx="5" cy="17" r="3"/><circle cx="19" cy="7" r="3"/><path d="m8 16 8-7m-5 0h5v5"/>',
  station: '<path d="M4 20V8l8-5 8 5v12ZM8 20v-8h8v8"/>',
  zone: '<path d="m5 4 13 2 3 12-12 3-7-9Z"/>',
  portal: '<path d="M5 21V3h14v18M2 12h14m-4-4 4 4-4 4"/>',
  rail: '<path d="M7 2v20M17 2v20M5 6h14M5 12h14M5 18h14"/>',
  grid: '<path d="M3 3h18v18H3ZM9 3v18m6-18v18M3 9h18M3 15h18"/>',
  marquee: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  focus: '<path d="M3 8V3h5m8 0h5v5M3 16v5h5m8 0h5v-5"/><path d="M9 12h6m-3-3v6"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8Zm-9 10 9 5 9-5m-18 5 9 5 9-5"/>',
  robot: '<rect x="5" y="7" width="14" height="13" rx="4"/><path d="M12 3v4M8 12h1m6 0h1m-8 4h8M2 11v5m20-5v5"/>',
  map: '<path d="m3 5 6-2 6 3 6-2v15l-6 2-6-3-6 2Zm6-2v15m6-12v15"/>',
};

export function icon(name: string, className = 'tool-icon'): string {
  const shape = paths[name] ?? paths.zone;
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shape}</svg>`;
}

export const resourceLabels: Record<string, string> = {
  waypoint: '이동 지점', charger: '충전소', obstacle: '장애물', zone: '구역',
  forbidden: '금지 구역', prefer: '선호 구역', avoid: '회피 구역', corridor: '회랑', complex: '교차 구역',
  node: '노드', edge: '엣지', station: '스테이션', portal: '포털', rail: '레일', robot: '로봇',
};
