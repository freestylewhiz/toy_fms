import { icon } from './icons.ts';

/** Workspace chrome. The editor keeps ownership of resource data and commands. */
export function mountWorkspace(): void {
  const get = (selector: string) => document.querySelector<HTMLElement>(selector)!;
  const shell = get('.shell');
  shell.dataset.ui = 'atlas-studio';
  if (window.innerWidth <= 900) shell.classList.add('hide-details');
  if (window.innerWidth <= 600) shell.classList.add('hide-library');
  const rail = get('.rail');
  const inspector = get('.inspector');
  const tools = document.createElement('section');
  tools.className = 'command-deck';
  tools.setAttribute('aria-label', '배치 도구');
  tools.append(get('.rail-intro'));
  const tray = document.createElement('div');
  tray.className = 'command-tray';
  for (const group of document.querySelectorAll('.tool-group')) tray.append(group);
  tools.append(tray);
  shell.prepend(tools);
  const vdaGroup = get('.tool-group[data-for="vda"]');
  const vdaTabs = document.createElement('nav');
  vdaTabs.className = 'vda-tool-tabs'; vdaTabs.setAttribute('aria-label', 'VDA 도구 분류');
  const vdaPanels = new Map<string, HTMLElement>();
  for (const [id, label] of [['graph','그래프'],['zone','구역 규칙'],['aux','포털 · 레일']]) {
    const panel = get('#tools-vda-' + id);
    panel.previousElementSibling?.remove();
    panel.dataset.vdaPanel = id; vdaPanels.set(id, panel);
    const button = document.createElement('button'); button.type = 'button';
    button.dataset.vdaSection = id; button.textContent = label;
    button.addEventListener('click', () => chooseVda(id)); vdaTabs.append(button);
  }
  function chooseVda(id: string) {
    vdaPanels.forEach((panel, key) => { panel.hidden = key !== id; });
    vdaTabs.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.vdaSection === id)));
    window.dispatchEvent(new Event('resize'));
  }
  vdaGroup.prepend(vdaTabs); chooseVda('graph');
  vdaGroup.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest('[data-tool]');
    const panel = target?.closest<HTMLElement>('[data-vda-panel]');
    if (panel) chooseVda(panel.dataset.vdaPanel!);
  });

  rail.innerHTML = `<div class="navigator-header"><span class="panel-kicker">EXPLORER</span><span class="navigator-index">01 / MAP</span></div>
    <div class="project-card"><div class="project-art"><img id="project-map-image" src="/resources/maps/yard.png" alt="현재 맵 미리보기"/><span class="project-orbit"></span><span class="project-coordinate">SPATIAL WORKSPACE</span></div>
    <details class="map-library-drawer"><summary><span><b id="library-map-name">Yard</b><small id="library-map-size">80 × 60 m</small></span><span class="map-switch-hint">맵 전환 ⌄</span></summary>
    <div class="map-library">
      <button class="map-card" data-map-target="yard" type="button" aria-pressed="true"><img src="/resources/maps/yard.png" alt=""/><span><b>Yard</b><small>80 × 60 m · 편집</small></span></button>
      <button class="map-card" data-map-target="1st_floor" type="button" aria-pressed="false"><img src="/resources/maps/1st_floor.png" alt=""/><span><b>1st Floor</b><small>36 × 28 m · 미리보기</small></span></button>
    </div></details></div>
    <div class="resource-heading"><h2>리소스</h2><span id="resource-count">00</span></div>
    <label class="resource-search">${icon('search')}<input id="resource-search" type="search" placeholder="이름 또는 ID 검색" aria-label="리소스 검색"/><kbd>/</kbd></label>
    <div class="resource-filters" aria-label="리소스 종류 필터"><button data-filter="all" aria-pressed="true">전체</button><button data-filter="scene" aria-pressed="false">현장</button><button data-filter="zone" aria-pressed="false">구역</button><button data-filter="graph" aria-pressed="false">그래프</button></div>`;
  rail.append(get('.list-section'));
  get('.list-section .section-heading').hidden = true;
  const notes = document.createElement('div');
  notes.className = 'explorer-note';
  notes.innerHTML = '<span class="panel-kicker">WORKFLOW</span><b>그리다. 조정하다. 연결하다.</b><p>공간을 선택하고, 오른쪽에서<br>다음 움직임의 규칙을 정의하세요.</p><span class="note-shortcut"><kbd>⌘ / Ctrl K</kbd> 빠른 명령</span>';
  rail.append(notes);

  const tabs = document.createElement('nav');
  tabs.className = 'detail-tabs'; tabs.setAttribute('aria-label', '상세 패널');
  tabs.innerHTML = `<button type="button" data-detail="properties" aria-pressed="true">${icon('node')}속성</button><button type="button" data-detail="layers" aria-pressed="false">${icon('layers')}레이어</button><button type="button" data-detail="fleet" aria-pressed="false">${icon('robot')}로봇</button>`;
  inspector.prepend(tabs); get('.dock-heading').remove();
  get('.inspector-section').dataset.detailPanel = 'properties';
  get('#shape-section').dataset.detailPanel = 'properties';
  get('.layer-section').dataset.detailPanel = 'layers';
  get('.robot-section').dataset.detailPanel = 'fleet';
  inspector.dataset.detail = 'properties';
  for (const button of tabs.querySelectorAll<HTMLButtonElement>('button')) {
    button.addEventListener('click', () => {
      inspector.dataset.detail = button.dataset.detail;
      for (const sibling of tabs.querySelectorAll('button')) sibling.setAttribute('aria-pressed', String(sibling === button));
    });
  }
  const runtime = document.createElement('section');
  runtime.className = 'runtime-section';
  runtime.dataset.detailPanel = 'fleet';
  runtime.innerHTML = `<div class="runtime-heading"><span class="panel-kicker">RUNTIME</span><span id="runtime-sync" aria-live="polite"></span></div>
    <div id="runtime-robot-detail" class="runtime-robot-detail"><span class="runtime-empty">로봇을 선택하면 런타임 상태와 제어를 표시합니다.</span></div>
    <div class="runtime-subheading"><b>구역 리소스</b><span>점유 · 예약 · 대기</span></div>
    <div id="runtime-occupancies" class="runtime-occupancies"><span class="runtime-empty">런타임 점유 정보가 없습니다.</span></div>`;
  inspector.append(runtime);
  const heading = get('.inspector-section .section-heading');
  heading.className = 'inspector-heading';
  heading.innerHTML = '<div><span id="property-subtitle" class="panel-kicker">RESOURCE INSPECTOR</span><h2 id="property-title">공간의 규칙</h2></div><svg id="property-art" class="property-art" viewBox="0 0 72 72" aria-hidden="true"></svg>';
  get('#inspect-empty').innerHTML = `<div class="empty-orbit">${icon('waypoint')}</div><span class="panel-kicker">EVERY SPACE HAS A PURPOSE</span><b>무엇을 만들까요?</b><p>지도 위의 리소스를 선택하거나<br>도구에서 새로운 공간을 그려보세요.</p><div class="empty-steps"><span><i>01</i> 도구 선택</span><span><i>02</i> 지도에 배치</span><span><i>03</i> 속성 완성</span></div>`;
  const poseGrid = document.createElement('div'); poseGrid.className = 'pose-grid';
  get('#insp-x-wrap').before(poseGrid); poseGrid.append(get('#insp-x-wrap'), get('#insp-y-wrap'));
  const rotation = document.createElement('div'); rotation.id = 'rotation-module'; rotation.className = 'rotation-module';
  get('#insp-theta-wrap').before(rotation);
  rotation.innerHTML = '<div class="rotation-compass" aria-hidden="true"><span class="compass-north">N</span><i id="rotation-needle"></i><span id="theta-value">0°</span></div><div class="rotation-inputs"></div>';
  rotation.querySelector('.rotation-inputs')!.append(get('#insp-theta-wrap'), get('#insp-theta-slider-wrap'));

  get('.map-hud').innerHTML = '<div class="canvas-title"><div class="hud-breadcrumb"><span>MAP</span><b>yard</b></div><h2 id="canvas-map-name">Yard<span> / 01</span></h2><span id="canvas-map-meta">80 × 60 m · 5 cm/px</span></div><div class="canvas-telemetry"><span class="telemetry-dot"></span><span id="canvas-online-count">연결 대기</span><span class="hud-mode" id="hud-mode">현장 배치</span></div>';
  for (const corner of ['nw','ne','sw','se']) { const el = document.createElement('i'); el.className = `canvas-corner ${corner}`; get('#viewport').append(el); }
  const viewbar = document.createElement('div'); viewbar.className = 'view-controls';
  viewbar.innerHTML = '<button id="map-render-style" type="button" aria-pressed="true" title="청사진 / 원본 도면 전환">청사진</button><span class="control-divider"></span><button id="view-out" type="button" aria-label="축소">−</button><button id="view-fit" type="button" title="전체 맵 보기 (0)">화면 맞춤</button><button id="view-in" type="button" aria-label="확대">+</button>';
  get('#viewport').append(viewbar);
  const minimap = document.createElement('div'); minimap.className = 'minimap';
  minimap.innerHTML = '<div class="minimap-caption"><span>OVERVIEW</span><span>⌖</span></div><canvas id="overview-map" width="160" height="120" tabindex="0" role="button" aria-label="미니맵 · 클릭하여 해당 위치로 이동, Enter로 전체 보기"></canvas>';
  get('#viewport').append(minimap);
  const help = document.createElement('div'); help.className = 'canvas-help'; help.id = 'tool-hint';
  help.textContent = 'SPACE 드래그 이동 · 휠 확대'; get('#viewport').append(help);
  const controls = document.createElement('div'); controls.className = 'panel-controls';
  controls.innerHTML = `<button type="button" id="open-command" title="빠른 명령 (Ctrl/⌘ K)" aria-label="빠른 명령">${icon('search')}<span>빠른 명령</span><kbd>⌘ K</kbd></button><button type="button" id="toggle-library" aria-pressed="true" title="탐색 패널">${icon('map')}</button><button type="button" id="toggle-details" aria-pressed="true" title="속성 패널">${icon('layers')}</button><button type="button" id="focus-workspace" aria-pressed="false" title="지도 집중 모드 (Shift F)">${icon('focus')}</button>`;
  get('.top-meta').prepend(controls);
  get('#toggle-details').setAttribute('aria-pressed', String(!shell.classList.contains('hide-details')));
  get('#toggle-library').setAttribute('aria-pressed', String(!shell.classList.contains('hide-library')));
  for (const [id, cls] of [['toggle-library', 'hide-library'], ['toggle-details', 'hide-details']]) {
    get('#' + id).addEventListener('click', () => {
      shell.classList.remove('focus-mode'); get('#focus-workspace').setAttribute('aria-pressed', 'false');
      const hidden = shell.classList.toggle(cls); get('#' + id).setAttribute('aria-pressed', String(!hidden));
      window.dispatchEvent(new Event('resize'));
    });
  }
  const compact = window.matchMedia('(max-width: 600px)');
  compact.addEventListener('change', event => {
    if (!event.matches) return;
    shell.classList.add('hide-library','hide-details');
    get('#toggle-library').setAttribute('aria-pressed','false');
    get('#toggle-details').setAttribute('aria-pressed','false');
    window.dispatchEvent(new Event('resize'));
  });
  get('#focus-workspace').addEventListener('click', () => {
    const active = shell.classList.toggle('focus-mode'); get('#focus-workspace').setAttribute('aria-pressed', String(active));
    window.dispatchEvent(new Event('resize'));
  });
  let filterKind = 'all';
  const search = get('#resource-search') as HTMLInputElement;
  const filter = () => {
    const query = search.value.trim().toLowerCase();
    for (const item of get('#outliner').querySelectorAll<HTMLButtonElement>('button')) {
      const kind = item.dataset.kind!;
      const family = kind === 'zone' ? 'zone' : ['waypoint','charger','obstacle'].includes(kind) ? 'scene' : 'graph';
      item.hidden = !(filterKind === 'all' || family === filterKind) || !(item.dataset.search ?? item.textContent!).toLowerCase().includes(query);
    }
  };
  for (const button of rail.querySelectorAll<HTMLButtonElement>('[data-filter]')) button.addEventListener('click', () => {
    filterKind = button.dataset.filter!;
    for (const b of rail.querySelectorAll('[data-filter]')) b.setAttribute('aria-pressed', String(b === button));
    filter();
  });
  search.addEventListener('input', filter);
  new MutationObserver(filter).observe(get('#outliner'), { childList: true });
  for (const card of rail.querySelectorAll<HTMLButtonElement>('[data-map-target]')) card.addEventListener('click', () => {
    const select = get('#map-select') as HTMLSelectElement; select.value = card.dataset.mapTarget!; select.dispatchEvent(new Event('change'));
    (get('.map-library-drawer') as HTMLDetailsElement).open = false;
  });
  mountCommandPalette();
}

function mountCommandPalette(): void {
  const dialog = document.createElement('dialog'); dialog.id = 'command-dialog'; dialog.className = 'command-palette';
  dialog.setAttribute('aria-labelledby', 'command-title');
  dialog.innerHTML = `<div class="palette-heading"><span class="panel-kicker" id="command-title">QUICK COMMAND</span><button id="close-command" type="button" aria-label="명령 검색 닫기">Esc</button></div><label class="palette-search">${icon('search')}<input id="command-search" placeholder="무엇을 만들거나 찾을까요?" aria-label="명령 검색" autocomplete="off"/></label><div id="command-results"></div><footer>↑ ↓ 이동 · Enter 실행</footer>`;
  document.body.append(dialog);
  const input = dialog.querySelector<HTMLInputElement>('input')!;
  const results = dialog.querySelector<HTMLElement>('#command-results')!;
  let index = 0;
  const render = () => {
    results.replaceChildren(); index = 0;
    const query = input.value.trim().toLowerCase();
    const seen = new Set<string>();
    for (const tool of document.querySelectorAll<HTMLButtonElement>('.tools [data-tool]')) {
      const id = tool.dataset.tool!;
      if (seen.has(id) || !(tool.textContent! + tool.title).toLowerCase().includes(query)) continue;
      seen.add(id);
      const button = document.createElement('button'); button.type = 'button'; button.innerHTML = icon(id);
      const label = document.createElement('span'); label.textContent = tool.querySelector('span')?.textContent ?? id;
      const key = document.createElement('kbd'); key.textContent = tool.querySelector('kbd')?.textContent ?? '↵';
      button.append(label, key);
      button.addEventListener('click', () => {
        const mode = tool.closest<HTMLElement>('[data-for]')?.dataset.for;
        dialog.close();
        if (mode) document.querySelector<HTMLButtonElement>(`#modes [data-mode="${mode}"]`)?.click();
        tool.click();
      }); results.append(button);
    }
    if (!results.childElementCount) { const empty = document.createElement('p'); empty.textContent = '일치하는 도구가 없습니다.'; results.append(empty); }
    results.querySelector('button')?.setAttribute('data-active','true');
  };
  const open = () => {
    if (document.querySelector('dialog[open]') || document.body.dataset.editing === 'true') return;
    input.value = ''; render(); dialog.showModal(); input.focus();
  };
  document.getElementById('open-command')!.addEventListener('click',open);
  dialog.querySelector('#close-command')!.addEventListener('click',()=>dialog.close());
  input.addEventListener('input',render);
  dialog.addEventListener('keydown', event => {
    if (!['ArrowDown','ArrowUp','Enter'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...results.querySelectorAll<HTMLButtonElement>('button')];
    if (!buttons.length) return;
    if (event.key === 'Enter') { buttons[index]?.click(); return; }
    index = (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons.forEach((b,i)=>b.setAttribute('data-active',String(i===index)));
    buttons[index].scrollIntoView({block:'nearest'});
  });
  dialog.addEventListener('click',event=>{ if (event.target === dialog) { const r=dialog.getBoundingClientRect(); if (event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom) dialog.close(); } });
  window.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); open(); }
    if (document.querySelector('dialog[open]') || (event.target as HTMLElement).closest('input,textarea,select')) return;
    if (event.key === '/') { event.preventDefault(); document.querySelector('.shell')?.classList.remove('hide-library','focus-mode'); document.getElementById('toggle-library')!.setAttribute('aria-pressed','true'); document.getElementById('focus-workspace')!.setAttribute('aria-pressed','false'); window.dispatchEvent(new Event('resize')); document.getElementById('resource-search')!.focus(); }
    if (event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); document.getElementById('focus-workspace')!.click(); }
  });
}
