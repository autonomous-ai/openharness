(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

  function ago(time) {
    const at = Date.parse(time);
    if (!Number.isFinite(at)) return '';
    const seconds = Math.max(0, (Date.now() - at) / 1000);
    if (seconds < 90) return `${Math.round(seconds)}s ago`;
    if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
    return `${Math.round(seconds / 86400)}d ago`;
  }
  const clock = time => (time ? new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  // Hue says who is working; length and glow say whether it is working now.
  const ENGINE_VARS = { claude: '--engine-claude', codex: '--engine-codex', opencode: '--engine-third', gemini: '--engine-third' };
  const engineVar = engine => ENGINE_VARS[String(engine || '').toLowerCase()] ?? '--engine-other';
  const engineColor = engine => `var(${engineVar(engine)})`;

  const WINDOWS = [
    { id: 'day', label: '24 hours', ms: 24 * 3600e3 },
    { id: 'week', label: '7 days', ms: 7 * 24 * 3600e3 },
    { id: 'month', label: '30 days', ms: 30 * 24 * 3600e3 },
  ];
  /** How many ticks one machine draws. Past this the counts stay true and the corona stops thickening. */
  const TICK_CAP = 120;

  const storage = {
    read: key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
    write: (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window */ } },
  };

  let snapshot = null, view = 'fleet', selected = null, windowId = storage.read('machines:window') || 'week';
  let paused = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let positions = new Map(), drags = storage.read('machines:layout') || {}, dragging = null, moved = false;
  let width = 0, height = 0, frame = 0, lastReceived = 0, transportLost = false, toastTimer;
  const stage = $('stage'), canvas = $('links'), ctx = canvas.getContext('2d');
  const nodeButtons = new Map();

  function toast(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
  }

  /* ── the stream ───────────────────────────────────────────────────────── */

  function consume(data) {
    if (!data || data.spec !== 1 || !Array.isArray(data.machines)) return;
    snapshot = data;
    lastReceived = Date.now();
    transportLost = false;
    render();
  }

  function listen() {
    const source = new EventSource('/events');
    source.addEventListener('snapshot', event => { try { consume(JSON.parse(event.data)); } catch { /* a partial frame */ } });
    source.addEventListener('error', () => { transportLost = true; status(); });
  }

  function status() {
    if (!snapshot) return;
    const late = lastReceived && Date.now() - lastReceived > Math.max(45_000, (snapshot.pollIntervalMs || 15_000) * 3);
    const linkable = (snapshot.machines ?? []).filter(machine => machine.needsLink && machine.status !== 'offline').length;
    const waiting = linkable ? ` · ${plural(linkable, 'machine')} waiting to be linked` : '';
    const words = {
      live: snapshot.observedAt ? `Observed ${ago(snapshot.observedAt)}${waiting}` : 'Observing',
      partial: snapshot.observedAt ? `Observed ${ago(snapshot.observedAt)} · a machine did not answer${waiting}` : 'A machine did not answer',
      connecting: 'Asking Harness about your machines',
      unavailable: 'Harness is not answering on this computer',
      'signed-out': 'Not signed in to Harness on this computer',
    };
    $('observed').textContent = transportLost || late ? 'The pane lost its connection to the fleet reader' : (words[snapshot.status] ?? 'Waiting for Harness');
  }

  /* ── render ───────────────────────────────────────────────────────────── */

  function render() {
    if (!snapshot) return;
    $('stage').hidden = view !== 'fleet';
    $('projects').hidden = view !== 'projects';
    $('activity').hidden = view !== 'activity';
    $('window-menu').hidden = view !== 'activity';
    for (const [id, name] of [['view-fleet', 'fleet'], ['view-projects', 'projects'], ['view-activity', 'activity']]) {
      $(id).setAttribute('aria-pressed', String(view === name));
    }
    if (view === 'fleet') renderFleet();
    if (view === 'projects') renderProjects();
    if (view === 'activity') renderActivity();
    renderTotals();
    renderLog();
    renderInspector();
    status();
  }

  function select(kind, id) {
    const same = selected && selected.kind === kind && selected.id === id;
    selected = same ? null : { kind, id };
    for (const [machineId, button] of nodeButtons) button.setAttribute('aria-pressed', String(selected?.kind === 'machine' && selected.id === machineId));
    renderInspector();
    if (view === 'projects') renderProjects();
    draw();
  }

  /* ── fleet: a machine and the harnesses it carries ────────────────────── */

  /** Harnesses to draw: every open one, then the newest, up to what one ring can hold. */
  function visibleHarnesses(machine) {
    const all = [...(machine.harnesses ?? [])];
    if (all.length <= TICK_CAP) return all;
    const open = all.filter(h => h.open);
    const rest = all.filter(h => !h.open).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return [...open, ...rest].slice(0, TICK_CAP);
  }

  /** Harnesses grouped into the projects they are in — the arcs the corona reads as clusters. */
  function groupByProject(harnesses) {
    const groups = new Map();
    for (const harness of harnesses) {
      const key = harness.project?.key ?? 'none';
      const found = groups.get(key) ?? { key, name: harness.project?.name ?? 'No project', branch: harness.project?.branch ?? null, harnesses: [] };
      found.harnesses.push(harness);
      groups.set(key, found);
    }
    return [...groups.values()].sort((a, b) => b.harnesses.length - a.harnesses.length);
  }

  /**
   * The corona: one tick per harness, laid around the machine and broken into an arc per project.
   * An open harness is a long tick that breathes; a dormant one is a short faint mark. Nothing is drawn
   * for a machine that could not be read — an empty ring means "not read", never "nothing running".
   */
  function corona(machine) {
    const inner = 46;
    if (machine.needsLink || machine.status === 'offline' || !machine.harnesses?.length) {
      return `<svg class="corona" viewBox="-66 -66 132 132" aria-hidden="true"><circle class="dashed" r="${inner + 4}"></circle></svg>`;
    }
    const harnesses = visibleHarnesses(machine);
    const groups = groupByProject(harnesses);
    const gap = groups.length > 1 ? Math.min(7, 60 / groups.length) : 0;
    const per = (360 - gap * groups.length) / harnesses.length;
    let angle = -90 + gap / 2;
    const lines = [];
    for (const group of groups) {
      for (const harness of group.harnesses) {
        const radians = angle * Math.PI / 180;
        const length = harness.open ? 11 : 6;
        const x1 = Math.cos(radians) * inner, y1 = Math.sin(radians) * inner;
        const x2 = Math.cos(radians) * (inner + length), y2 = Math.sin(radians) * (inner + length);
        const title = [harness.name, group.name === 'No project' ? null : group.name, harness.agent,
          harness.createdAt ? `started ${ago(harness.createdAt)}` : null, harness.open ? 'open' : 'closed'].filter(Boolean).join(' · ');
        lines.push(`<line class="${harness.open ? 'open' : 'dormant'}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${engineColor(harness.engine)}" stroke-width="${harness.open ? 2.4 : 1.8}" style="animation-delay:${(lines.length % 12) * 0.2}s"><title>${escape(title)}</title></line>`);
        angle += per;
      }
      angle += gap;
    }
    return `<svg class="corona" viewBox="-66 -66 132 132">${lines.join('')}</svg>`;
  }

  function coreOf(machine) {
    if (machine.needsLink) return '<span class="core blank"><strong>Link</strong><small>required</small></span>';
    if (machine.shared) return `<span class="core blank"><strong>${machine.harnessCount || 0}</strong><small>shared</small></span>`;
    if (machine.status === 'offline') return '<span class="core blank"><strong>—</strong><small>offline</small></span>';
    return `<span class="core"><strong>${machine.openCount ?? 0}</strong><small>open</small></span>`;
  }

  /**
   * Presence and link state are independent, and both are said — the split the app's own machine
   * menu makes. A computer that is up but has never been linked reads "online · link required",
   * because "link required" alone hides that the machine itself is perfectly fine.
   */
  function stateWord(machine) {
    if (machine.local) return 'this computer';
    if (machine.shared) return machine.ownerName ? `shared by ${machine.ownerName}` : 'shared with you';
    const presence = machine.status === 'offline' ? 'offline' : machine.status === 'unknown' ? 'status unknown' : 'online';
    return machine.needsLink ? `${presence} · link required` : presence;
  }

  function dotClass(machine) {
    if (machine.needsLink) return 'warn';
    if (machine.status === 'offline') return 'offline';
    if (machine.status === 'unknown') return 'unknown';
    return '';
  }

  /**
   * Where each machine sits before anyone drags it: this computer at the middle, the rest around it.
   *
   * The ring order is by machine id, not by the order the list happens to be sorted in — a machine
   * that goes offline (or comes back) changes that sort, and a map whose nodes swap places whenever
   * a status changes is a map nobody can hold in their head.
   */
  function layout(machines) {
    const places = new Map();
    const local = machines.find(m => m.local);
    const others = machines.filter(m => m !== local).sort((a, b) => a.id.localeCompare(b.id));
    if (local) places.set(local.id, { x: .5, y: .48 });
    const count = others.length;
    if (!count) return places;
    if (!local && count <= 3) {
      others.forEach((machine, index) => places.set(machine.id, { x: (index + 1) / (count + 1), y: .48 }));
      return places;
    }
    const radius = count <= 4 ? .3 : count <= 8 ? .34 : .38;
    others.forEach((machine, index) => {
      const angle = -Math.PI / 2 + (index + (local ? 0 : .5)) * (2 * Math.PI / count);
      places.set(machine.id, { x: .5 + Math.cos(angle) * radius * (height / Math.max(width, 1) < .7 ? 1 : .8), y: .48 + Math.sin(angle) * radius });
    });
    return places;
  }

  function place() {
    const box = stage.getBoundingClientRect();
    width = box.width; height = box.height;
    const machines = snapshot?.machines ?? [];
    const defaults = layout(machines);
    positions = new Map();
    for (const machine of machines) {
      const saved = drags[machine.id], base = defaults.get(machine.id) ?? { x: .5, y: .5 };
      const point = saved && Number.isFinite(saved.x) ? saved : base;
      positions.set(machine.id, { x: clamp(point.x, .1, .9) * width, y: clamp(point.y, .16, .86) * height });
    }
    for (const [id, button] of nodeButtons) {
      const point = positions.get(id);
      if (point) { button.style.left = `${point.x}px`; button.style.top = `${point.y}px`; }
    }
  }

  function renderFleet() {
    const machines = snapshot.machines ?? [];
    const ids = new Set(machines.map(m => m.id));
    for (const [id, button] of nodeButtons) if (!ids.has(id)) { button.remove(); nodeButtons.delete(id); }

    for (const machine of machines) {
      let button = nodeButtons.get(machine.id);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.dataset.machine = machine.id;
        button.addEventListener('click', () => { if (moved) { moved = false; return; } select('machine', machine.id); });
        button.addEventListener('pointerdown', event => {
          if (event.button !== 0) return;
          dragging = { id: machine.id, x: event.clientX, y: event.clientY };
          moved = false;
          button.setPointerCapture?.(event.pointerId);
        });
        button.addEventListener('pointermove', event => {
          if (dragging?.id !== machine.id) return;
          if (Math.hypot(event.clientX - dragging.x, event.clientY - dragging.y) > 5) moved = true;
          if (!moved) return;
          const box = stage.getBoundingClientRect();
          drags[machine.id] = { x: (event.clientX - box.left) / width, y: (event.clientY - box.top) / height };
          place(); draw();
        });
        button.addEventListener('pointerup', () => { dragging = null; if (moved) storage.write('machines:layout', drags); });
        button.addEventListener('pointercancel', () => { dragging = null; moved = false; });
        $('nodes').appendChild(button);
        nodeButtons.set(machine.id, button);
      }
      button.className = `node${machine.local ? ' local' : ''}${machine.status === 'offline' || machine.needsLink ? ' offline' : ''}${paused ? ' paused' : ''}`;
      button.setAttribute('aria-pressed', String(selected?.kind === 'machine' && selected.id === machine.id));
      const carrying = machine.needsLink ? 'nothing readable yet'
        : machine.harnessCount ? plural(machine.harnessCount, 'harness', 'harnesses') : 'no harness open';
      button.setAttribute('aria-label', `${machine.name}, ${stateWord(machine)}, ${carrying}`);
      button.innerHTML = `<span class="orb">${corona(machine)}${coreOf(machine)}</span>`
        + `<span class="node-name"><span class="dot ${dotClass(machine)}"></span><span class="label">${escape(machine.name)}</span></span>`
        + `<span class="node-sub">${escape(machine.needsLink ? stateWord(machine) : `${stateWord(machine)} · ${carrying}`)}</span>`;
    }

    $('stage-empty').hidden = machines.length > 0;
    if (!machines.length) {
      $('empty-title').textContent = snapshot.status === 'signed-out' ? 'Not signed in.' : 'No machines yet.';
      $('empty-message').textContent = snapshot.status === 'signed-out'
        ? 'Sign in to Harness on this computer and your machines appear here.'
        : snapshot.message || 'Ask me to bring your first computer in.';
    }
    const readable = machines.filter(m => !m.needsLink && m.status !== 'offline').length;
    $('stage-subtitle').textContent = machines.length
      ? `${plural(machines.length, 'machine')} · ${readable} readable from here`
      : 'Looking for your computers.';
    $('stage-legend').textContent = machines.some(m => !m.local)
      ? 'Lines are this computer’s links · each tick is one harness, grouped by project'
      : 'Each tick is one harness, grouped by project';
    place();
    draw();
  }

  /** The links out of this computer: solid where one exists, dashed where one is still needed. */
  function draw() {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const pixels = [Math.max(1, Math.floor(width * ratio)), Math.max(1, Math.floor(height * ratio))];
    // Only on a real size change: assigning width or height reallocates the backing store, and this
    // runs on every animation frame.
    if (canvas.width !== pixels[0] || canvas.height !== pixels[1]) {
      [canvas.width, canvas.height] = pixels;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (view !== 'fleet' || !snapshot) return;
    const style = getComputedStyle(document.documentElement);
    const accent = style.getPropertyValue('--accent').trim() || '#2b5fd9';
    const line = style.getPropertyValue('--ink-3').trim() || '#8a8d93';
    const warn = style.getPropertyValue('--warn').trim() || '#a8730f';
    const local = snapshot.machines.find(m => m.local);
    const from = local && positions.get(local.id);
    if (!from) return;
    for (const machine of snapshot.machines) {
      if (machine.local) continue;
      const to = positions.get(machine.id);
      if (!to) continue;
      const midX = (from.x + to.x) / 2 + (to.y - from.y) * .07;
      const midY = (from.y + to.y) / 2 - (to.x - from.x) * .07;
      const chosen = selected?.kind === 'machine' && (selected.id === machine.id);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo(midX, midY, to.x, to.y);
      if (machine.needsLink) { ctx.strokeStyle = warn; ctx.globalAlpha = .5; ctx.setLineDash([2, 6]); }
      else if (machine.status === 'offline') { ctx.strokeStyle = line; ctx.globalAlpha = .28; ctx.setLineDash([1, 7]); }
      else { ctx.strokeStyle = accent; ctx.globalAlpha = chosen ? .85 : .45; ctx.setLineDash([7, 7]); ctx.lineDashOffset = paused ? 0 : -frame * .35; }
      ctx.lineWidth = chosen ? 2 : 1.4;
      ctx.stroke();
      ctx.restore();
    }
  }

  function animate() {
    frame += 1;
    if (!paused && view === 'fleet' && snapshot?.machines?.some(m => !m.local && !m.needsLink && m.status !== 'offline')) draw();
    requestAnimationFrame(animate);
  }

  /* ── projects: the same work, seen across machines ────────────────────── */

  function renderProjects() {
    const projects = (snapshot.projects ?? []).slice(0, 24);
    const machines = (snapshot.machines ?? []).filter(m => m.harnessCount > 0);
    if (!projects.length) {
      $('projects').innerHTML = `<p class="board-note">${escape(snapshot.machines?.some(m => m.needsLink)
        ? 'Link a machine and the projects it is working in appear here.'
        : 'No project has a harness open right now.')}</p>`;
      return;
    }
    const rowHeight = 32, padding = 26;
    const rows = Math.max(projects.length, machines.length);
    const height = rows * rowHeight + padding * 2;
    const boardWidth = Math.max(420, $('projects').clientWidth || 640);
    const leftX = 4, rightX = boardWidth - 4;
    const knotLeft = Math.min(300, boardWidth * .42), knotRight = boardWidth - Math.min(190, boardWidth * .28);
    const y = (index, count) => padding + (rows - count) * rowHeight / 2 + index * rowHeight + rowHeight / 2;

    const threads = [];
    projects.forEach((project, index) => {
      const py = y(index, projects.length);
      for (const machineId of project.machines) {
        const machineIndex = machines.findIndex(m => m.id === machineId);
        if (machineIndex < 0) continue;
        const my = y(machineIndex, machines.length);
        const dim = selected?.kind === 'project' && selected.id !== project.key;
        threads.push(`<path class="thread${project.open ? ' open' : ''}${dim ? ' dim' : ''}" d="M ${knotLeft} ${py} C ${(knotLeft + knotRight) / 2} ${py}, ${(knotLeft + knotRight) / 2} ${my}, ${knotRight} ${my}" stroke-width="${clamp(Math.sqrt(project.harnesses) * .9, 1, 5).toFixed(1)}"></path>`);
      }
    });

    const projectRows = projects.map((project, index) => {
      const py = y(index, projects.length);
      const detail = [plural(project.harnesses, 'harness', 'harnesses'), project.open ? `${project.open} open` : null, project.branches.slice(0, 2).join(', ')]
        .filter(Boolean).join(' · ');
      return `<g class="row" data-project="${escape(project.key)}" role="button" tabindex="0">`
        + `<rect x="${leftX}" y="${py - rowHeight / 2}" width="${knotLeft - leftX}" height="${rowHeight}" fill="transparent"></rect>`
        + `<text class="title" x="${leftX + 2}" y="${py - 1}">${escape(project.name)}</text>`
        + `<text class="faint" x="${leftX + 2}" y="${py + 12}">${escape(detail)}</text>`
        + `<circle class="knot${project.open ? ' open' : ''}" cx="${knotLeft}" cy="${py}" r="3"></circle></g>`;
    });

    const machineRows = machines.map((machine, index) => {
      const my = y(index, machines.length);
      return `<g class="row" data-machine="${escape(machine.id)}" role="button" tabindex="0">`
        + `<rect x="${knotRight}" y="${my - rowHeight / 2}" width="${rightX - knotRight}" height="${rowHeight}" fill="transparent"></rect>`
        + `<circle class="knot${machine.openCount ? ' open' : ''}" cx="${knotRight}" cy="${my}" r="3"></circle>`
        + `<text class="title" x="${knotRight + 10}" y="${my - 1}">${escape(machine.name)}</text>`
        + `<text class="faint" x="${knotRight + 10}" y="${my + 12}">${escape(plural(machine.harnessCount, 'harness', 'harnesses'))}</text></g>`;
    });

    const shown = (snapshot.projects ?? []).length;
    $('projects').innerHTML = `<p class="board-note">${escape(shown > projects.length
      ? `The ${projects.length} busiest of ${shown} projects, and the machines each one is open on.`
      : 'Every project with a harness open, and the machines it is open on.')}</p>`
      + `<svg class="loom" viewBox="0 0 ${boardWidth} ${height}" height="${height}">${threads.join('')}${projectRows.join('')}${machineRows.join('')}</svg>`;
  }

  /* ── activity: what the machines have been doing ──────────────────────── */

  /**
   * When the work started.
   *
   * A roster reports one time per harness that means what it says: when it was created. (Its
   * `updatedAt` is stamped by the registry's own reconcile pass, so it would draw every harness as
   * busy right now — this view does not use it, and neither does anything else here.) So each mark
   * below is one harness, stacked into the hour or day it began: a machine's week, as a skyline.
   */
  function renderActivity() {
    const span = (WINDOWS.find(w => w.id === windowId) ?? WINDOWS[1]).ms;
    const now = Date.now(), start = now - span;
    const machines = (snapshot.machines ?? []).filter(m => (m.harnesses ?? []).length);
    if (!machines.length) {
      $('activity').innerHTML = '<p class="board-note">Nothing to show yet: no machine here has a harness this pane can read.</p>';
      return;
    }
    const columns = span <= 24 * 3600e3 ? 48 : span <= 7 * 24 * 3600e3 ? 56 : 60;
    const STACK_CAP = 9;
    // Gridlines fall on real boundaries — midnight, or every six hours in the day view — so a stack
    // can be read against a date instead of an arbitrary slice of the window.
    const hourly = span <= 24 * 3600e3;
    const step = hourly ? 6 * 3600e3 : 86400e3;
    const ticks = [];
    const first = new Date(start);
    if (hourly) first.setMinutes(0, 0, 0);
    else first.setHours(0, 0, 0, 0);
    for (let at = first.getTime() + step; at < now && ticks.length < 12; at += step) {
      ticks.push({ at, left: ((at - start) / span) * 100, label: hourly
        ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' }) });
    }
    const marks = ticks.map(tick => tick.left);

    const lanes = machines.map(machine => {
      const buckets = new Map();
      let before = 0;
      for (const harness of machine.harnesses ?? []) {
        const at = Date.parse(harness.createdAt);
        if (!Number.isFinite(at)) continue;
        if (at < start) { before += 1; continue; }
        const column = Math.min(columns - 1, Math.floor(((at - start) / span) * columns));
        const found = buckets.get(column) ?? [];
        found.push(harness);
        buckets.set(column, found);
      }
      const started = [...buckets.values()].reduce((total, list) => total + list.length, 0);
      const tallest = Math.max(1, ...[...buckets.values()].map(list => Math.min(list.length, STACK_CAP)));
      const trackHeight = tallest * 6 + 8;
      const width = 100 / columns;
      const blocks = [];
      for (const [column, list] of buckets) {
        list.slice(0, STACK_CAP).forEach((harness, index) => {
          const title = [harness.name, harness.project?.name, harness.agent,
            `started ${new Date(harness.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
            harness.open ? 'still open' : 'closed'].filter(Boolean).join(' · ');
          blocks.push(`<span class="block${harness.open ? ' open' : ''}" style="left:${(column * width).toFixed(2)}%;width:${Math.max(width - .35, .6).toFixed(2)}%;bottom:${index * 6}px;background:${engineColor(harness.engine)}" title="${escape(title)}"></span>`);
        });
        if (list.length > STACK_CAP) {
          blocks.push(`<span class="more" style="left:${(column * width).toFixed(2)}%;bottom:${STACK_CAP * 6}px" title="${escape(`${list.length - STACK_CAP} more started here`)}">+</span>`);
        }
      }
      const note = started
        ? `${plural(started, 'harness', 'harnesses')} started${before ? ` · ${before} older` : ''}`
        : `nothing started here${before ? ` · ${plural(before, 'older harness', 'older harnesses')}` : ''}`;
      return `<div class="lane"><div class="lane-label"><b>${escape(machine.name)}</b><span>${escape(note)}</span></div>`
        + `<div class="track" style="height:${trackHeight}px">${marks.map(mark => `<span class="grid-line" style="left:${mark}%"></span>`).join('')}${blocks.join('')}</div></div>`;
    });

    $('activity').innerHTML = '<p class="board-note">Each mark is one harness, stacked where it was created. Hue is the agent; a solid mark is a harness still open.</p>'
      + `<div class="axis">${ticks.map(tick => `<span style="left:${tick.left.toFixed(2)}%">${escape(tick.label)}</span>`).join('')}<span class="now-label">now</span></div>`
      + lanes.join('');
  }

  /* ── totals and the log ───────────────────────────────────────────────── */

  function renderTotals() {
    const summary = snapshot.summary ?? {};
    const totals = snapshot.totals;
    const blocks = [
      ['MACHINES', summary.machines ?? 0, `${summary.online ?? 0} online`],
      ['HARNESSES', summary.harnesses ?? 0, summary.open ? `${summary.open} open now` : 'none open'],
      ['PROJECTS', summary.projects ?? 0, 'with a harness open'],
    ];
    if (totals?.workedMs) blocks.push(['THIS COMPUTER', `${Math.round(totals.workedMs / 3600e3)}h`, `agent time since ${new Date(totals.since).toLocaleDateString([], { month: 'short', day: 'numeric' })}`]);
    $('totals').innerHTML = blocks.map(([label, value, note]) =>
      `<div><span class="total-label">${label}</span><strong>${escape(value)}</strong><small>${escape(note)}</small></div>`).join('');
  }

  function renderLog() {
    const entries = snapshot.operations ?? [];
    $('log-list').innerHTML = entries.length
      ? entries.slice(0, 12).map(entry => `<div class="entry${entry.ok === false ? ' failed' : ''}"><time>${escape(clock(entry.at))}</time><span>${escape(entry.detail || entry.kind)}</span></div>`).join('')
      : '<div class="quiet">Nothing has changed here yet. Ask me to link, rename or retire a machine.</div>';
  }

  /* ── inspector ────────────────────────────────────────────────────────── */

  const pair = (label, value) => `<div class="pair"><span>${escape(label)}</span><strong>${escape(value)}</strong></div>`;
  const ask = text => `<div class="ask"><span>ASK THE AGENT</span><p>${escape(text)}</p><button type="button" class="copy" data-text="${escape(text)}">Copy request</button></div>`;

  function harnessList(harnesses) {
    const groups = groupByProject(harnesses);
    if (!groups.length) return '<p class="quiet">Nothing running here.</p>';
    return groups.slice(0, 10).map(group => `<div class="project-block"><b>${escape(group.name)}</b>${group.branch ? `<span class="branch">${escape(group.branch)}</span>` : ''}`
      + group.harnesses.slice(0, 8).map(harness => `<div class="harness-row"><span class="mark ${harness.open ? 'open' : 'dormant'}">${harness.open ? '●' : '○'}</span>`
        + `<span class="what">${escape(harness.title || harness.name)}</span><span class="when">${escape(harness.createdAt ? ago(harness.createdAt) : '')}</span></div>`).join('')
      + (group.harnesses.length > 8 ? `<div class="quiet">and ${group.harnesses.length - 8} more</div>` : '')
      + '</div>').join('');
  }

  function linkForm(machine) {
    return `<div class="section"><h3>Link this machine</h3><form class="link-form" data-link="${escape(machine.id)}">`
      + `<p class="why">Its remote password proves you own it. Type it here — it goes straight to Harness and is never part of the conversation.</p>`
      + `<input type="password" name="password" autocomplete="off" placeholder="Remote password" aria-label="Remote password for ${escape(machine.name)}">`
      + `<div class="row"><button type="submit">Link ${escape(machine.name)}</button><span class="error" data-error></span></div>`
      + `<p class="why">Not set one yet? On that machine: <code>harness remote-password set</code>.</p></form></div>`;
  }

  function renderInspector() {
    const panel = $('inspector');
    const machine = selected?.kind === 'machine' ? snapshot.machines.find(m => m.id === selected.id) : null;
    const project = selected?.kind === 'project' ? snapshot.projects.find(p => p.key === selected.id) : null;
    // What was selected can go away between readings — a machine removed, a project whose last
    // harness closed. Let the selection go with it rather than holding a drawer open on nothing.
    if (selected && !machine && !project) selected = null;
    panel.classList.toggle('open', Boolean(selected));

    if (machine) {
      panel.innerHTML = `<div class="inspector-head"><div><span class="eyebrow">${machine.local ? 'THIS COMPUTER' : 'MACHINE'}</span>`
        + `<h2>${escape(machine.name)}</h2><p class="subline">${escape(machine.hostname || machine.id.slice(0, 12))}</p></div>`
        + '<button class="close" type="button" data-close aria-label="Close">×</button></div>'
        + `<div class="detail-status"><span class="dot ${dotClass(machine)}"></span>${escape(stateWord(machine))}${machine.stale ? ' · last known' : ''}</div>`
        + (machine.needsLink ? linkForm(machine) : '')
        + `<div class="section">${pair('Harnesses', machine.needsLink ? 'not readable from here' : String(machine.harnessCount ?? 0))}`
        + pair('Open now', machine.needsLink ? '—' : String(machine.openCount ?? 0))
        + pair('Projects', machine.needsLink ? '—' : String(machine.projectCount ?? 0))
        + (machine.newestAt ? pair('Newest harness', ago(machine.newestAt)) : '')
        + (machine.linkedAt ? pair('Linked', ago(machine.linkedAt)) : '')
        + (machine.createdAt ? pair('On the account since', new Date(machine.createdAt).toLocaleDateString()) : '')
        + (machine.plan ? pair('Plan', machine.plan) : '')
        + pair('Id', machine.id.slice(0, 12))
        + (machine.note ? pair('Note', machine.note) : '')
        + '</div>'
        + (machine.error ? `<div class="section"><h3>Could not be read</h3><p class="quiet">${escape(machine.error)}</p></div>` : '')
        + (machine.needsLink ? '' : `<div class="section"><h3>What it is carrying</h3>${harnessList(machine.harnesses ?? [])}</div>`)
        + ask(machine.needsLink
          ? `Walk me through linking ${machine.name} from this computer.`
          : machine.local
            ? 'What is this computer working on right now, and is anything stuck?'
            : `What is ${machine.name} working on, and should anything move to another machine?`);
      return;
    }

    if (project) {
      const machines = snapshot.machines.filter(m => project.machines.includes(m.id));
      const harnesses = machines.flatMap(m => (m.harnesses ?? []).filter(h => h.project?.key === project.key));
      panel.innerHTML = '<div class="inspector-head"><div><span class="eyebrow">PROJECT</span>'
        + `<h2>${escape(project.name)}</h2><p class="subline">${escape(project.repo || 'a folder, not a repository')}</p></div>`
        + '<button class="close" type="button" data-close aria-label="Close">×</button></div>'
        + `<div class="section">${pair('Harnesses', String(project.harnesses))}${pair('Open now', String(project.open))}`
        + pair('Machines', machines.map(m => m.name).join(', ') || '—')
        + (project.branches.length ? pair('Branches', project.branches.slice(0, 4).join(', ')) : '')
        + (project.newestAt ? pair('Newest harness', ago(project.newestAt)) : '') + '</div>'
        + `<div class="section"><h3>Harnesses</h3>${harnessList(harnesses)}</div>`
        + ask(`Give me the state of ${project.name} across my machines — what is running where, and what finished.`);
      return;
    }

    const summary = snapshot.summary ?? {};
    const engines = Object.entries(summary.engines ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
    // Only the machines that could actually be linked right now: an offline one is a different job.
    const needsLink = snapshot.machines.filter(m => m.needsLink && m.status !== 'offline');
    panel.innerHTML = '<div class="inspector-head"><div><span class="eyebrow">YOUR FLEET</span>'
      + '<h2>Every computer<br>you work on.</h2>'
      + `<p class="subline">${escape(snapshot.account?.email ? `Signed in as ${snapshot.account.email}` : 'One account, one map.')}</p></div></div>`
      + `<div class="section" style="border-top:0;padding-top:0">${pair('Machines', String(summary.machines ?? 0))}`
      + pair('Online', String(summary.online ?? 0))
      + pair('Harnesses', String(summary.harnesses ?? 0))
      + pair('Open now', String(summary.open ?? 0))
      + (snapshot.thisComputer?.version ? pair('Harness version', `v${snapshot.thisComputer.version}`) : '')
      + (snapshot.thisComputer ? pair('Linkable from elsewhere', snapshot.thisComputer.remotePasswordSet ? 'yes' : 'no password set') : '')
      + '</div>'
      + (engines.length ? `<div class="section"><h3>Agents on your machines</h3>${engines.map(([engine, count]) =>
        `<span class="chip"><span class="swatch" style="background:${engineColor(engine)}"></span>${escape(engine)} · ${count}</span>`).join('')}</div>` : '')
      + (needsLink.length ? `<div class="section"><h3>Waiting to be linked</h3>${needsLink.map(machine =>
        `<div class="harness-row"><span class="mark idle">○</span><span class="what">${escape(machine.name)}</span></div>`).join('')}</div>` : '')
      + ask(needsLink.length
        ? `Link ${needsLink[0].name} so I can see what it is running.`
        : snapshot.machines.length > 1
          ? 'Which of my machines is carrying the most, and what would you move?'
          : 'Help me bring another computer into this account.');
  }

  /* ── events ───────────────────────────────────────────────────────────── */

  document.addEventListener('click', async event => {
    const copy = event.target.closest('.copy');
    if (copy) {
      try { await navigator.clipboard.writeText(copy.dataset.text); toast('Request copied — paste it in the terminal.'); }
      catch { toast('This pane could not reach the clipboard.'); }
      return;
    }
    if (event.target.closest('[data-close]')) { selected = null; renderInspector(); render(); return; }
    const row = event.target.closest('[data-project]');
    if (row) { select('project', row.dataset.project); return; }
    const machineRow = event.target.closest('[data-machine]');
    if (machineRow && !machineRow.classList.contains('node')) { select('machine', machineRow.dataset.machine); }
  });

  document.addEventListener('submit', async event => {
    const form = event.target.closest('[data-link]');
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector('input[name=password]');
    const error = form.querySelector('[data-error]');
    const button = form.querySelector('button');
    error.textContent = '';
    button.disabled = true;
    button.textContent = 'Linking…';
    try {
      const response = await fetch('/api/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ machineId: form.dataset.link, password: input.value }),
      });
      const body = await response.json().catch(() => ({}));
      input.value = '';
      if (!response.ok) { error.textContent = body.error || 'That did not work.'; return; }
      toast('Linked. Reading what it is running…');
    } catch {
      error.textContent = 'The pane could not reach Harness.';
    } finally {
      button.disabled = false;
      button.textContent = 'Link';
    }
  });

  $('view-fleet').addEventListener('click', () => { view = 'fleet'; render(); });
  $('view-projects').addEventListener('click', () => { view = 'projects'; render(); });
  $('view-activity').addEventListener('click', () => { view = 'activity'; render(); });
  $('motion').addEventListener('click', () => {
    paused = !paused;
    $('motion').setAttribute('aria-pressed', String(paused));
    $('motion').textContent = paused ? 'Resume motion' : 'Pause motion';
    render();
  });
  $('window-button').addEventListener('click', () => {
    const list = $('window-list'), open = list.hidden;
    list.innerHTML = WINDOWS.map(option => `<button class="menu-row" type="button" role="option" data-window="${option.id}" aria-selected="${option.id === windowId}">${option.label}</button>`).join('');
    list.hidden = !open;
    $('window-button').setAttribute('aria-expanded', String(open));
  });
  $('window-list').addEventListener('click', event => {
    const option = event.target.closest('[data-window]');
    if (!option) return;
    windowId = option.dataset.window;
    storage.write('machines:window', windowId);
    $('window-value').textContent = WINDOWS.find(w => w.id === windowId).label;
    $('window-list').hidden = true;
    $('window-button').setAttribute('aria-expanded', 'false');
    render();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { selected = null; $('window-list').hidden = true; render(); } });
  window.addEventListener('resize', () => { if (view === 'fleet') { place(); draw(); } else render(); });

  $('window-value').textContent = (WINDOWS.find(w => w.id === windowId) ?? WINDOWS[1]).label;
  fetch('/api/snapshot').then(response => response.json()).then(consume).catch(() => { /* the stream will bring it */ });
  listen();
  requestAnimationFrame(animate);
  setInterval(status, 10_000);
})();
