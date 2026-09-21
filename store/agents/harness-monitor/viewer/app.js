/* Harness Monitor's pane.
 *
 * One snapshot from the server, two ways to read it — the Table and the Timeline — and two verbs. Plain DOM,
 * one module import for the arithmetic (viewer/scale.js), no build step, served under `script-src 'self'`.
 *
 * Three rules this file keeps, because they are what make a monitor trustworthy:
 *   one selection, shared by both views and the toolbar, so what is selected is never ambiguous;
 *   rows hold still under the pointer (Activity Monitor does the same), so a live refresh never moves the
 *     row someone is about to click;
 *   every verb says, before it runs, exactly what it will do and to how many.
 */
import { HIDE_STEPS, PAUSE_STEPS, UNITS, bytes, humanIdle, idleOfX, parseDuration, snap, xOf } from './scale.js'

const TOKEN = document.querySelector('meta[name="hps-token"]')?.content ?? ''

const el = (id) => document.getElementById(id)
const dom = {
  where: el('where'), filter: el('filter'),
  actPause: el('act-pause'), actResume: el('act-resume'), actInspect: el('act-inspect'),
  runningValue: el('running-value'), runningBar: el('running-bar'), meterRunning: el('meter-running'),
  memoryValue: el('memory-value'), memoryBar: el('memory-bar'), meterMemory: el('meter-memory'),
  policyValue: el('policy-value'), policyReview: el('policy-review'),
  table: el('table'), grid: el('grid'), tableEmpty: el('table-empty'),
  lanes: el('lanes-view'), laneList: el('lane-list'), axis: el('axis'), lanesEmpty: el('lanes-empty'),
  rulePause: el('rule-pause'), ruleHide: el('rule-hide'),
  policybar: el('policybar'), policyPreview: el('policy-preview'), policySave: el('policy-save'), policyReset: el('policy-reset'),
  statusLeft: el('status-left'), statusRight: el('status-right'),
  inspector: el('inspector'), scrim: el('scrim'), review: el('review'), toast: el('toast'),
}

/** The verbs the pane can send. The server accepts exactly these (test/page.test.mjs keeps the two equal). */
const ACTIONS = [['pause', 'Pause'], ['resume', 'Resume']]

function remember(key, fallback) { try { return localStorage.getItem(key) ?? fallback } catch { return fallback } }
function keep(key, value) { try { localStorage.setItem(key, value) } catch { /* a private window, a preview */ } }

const state = {
  snapshot: null,
  receivedAt: 0,
  view: remember('hm.view', 'table'),
  scope: remember('hm.scope', 'all'),
  machines: remember('hm.machines', 'local'),
  filter: '',
  selected: new Set(),
  cursor: null,
  inspecting: null,
  sort: { key: 'status', dir: 'asc' },
  hovering: false,
  frozen: null,     // the row order kept while the pointer is over the table
  draft: null,      // a policy being dragged in the Timeline, before it is saved
  busy: false,
}

/* ── the fleet, as shown ───────────────────────────────────────────────────── */

const policy = () => ({ ...(state.snapshot?.policy ?? {}), ...(state.draft ?? {}) })
const everyRow = () => state.snapshot?.rows ?? []
/** Rows on the machines being shown. Only this machine by default: that is where Pause and Resume work, and a
 *  list full of rows you cannot act on is a list that trains you to ignore its buttons. */
const allRows = () => everyRow().filter((row) => state.machines === 'all' || row.local !== false)
const planFor = (id) => (state.snapshot?.plan ?? []).find((entry) => entry.id === id)
const isDue = (row) => planFor(row.id)?.action === 'pause'
const status = (row) => row.needsInput ? 'waiting' : row.state === 'running' ? (row.working ? 'working' : 'running') : row.state

/** A harness, not a shell and not a ghost. The two scopes that are about age use the hide line. */
function inScope(row, scope) {
  if (row.state === 'gone' || row.state === 'terminal') return false
  if (scope === 'running') return row.state === 'running'
  if (scope === 'paused') return row.state === 'paused'
  if (scope === 'waiting') return Boolean(row.needsInput)
  return row.state === 'running' || row.idleMs < parseDuration(policy().hideAfterIdle ?? '14d')
}

function matches(row, needle) {
  return [row.title, row.name, row.project, row.engine, row.model, row.branch, row.machine]
    .some((field) => String(field ?? '').toLowerCase().includes(needle))
}

/** What the current scope and search show. Search reaches past the scope, because someone typing a name is
 *  looking for that harness wherever it is. */
function rows() {
  const needle = state.filter.trim().toLowerCase()
  if (needle) return allRows().filter((row) => row.state !== 'gone' && row.state !== 'terminal' && matches(row, needle))
  return allRows().filter((row) => inScope(row, state.scope))
}

const STATUS_ORDER = { waiting: 0, working: 1, running: 2, paused: 3, terminal: 4, gone: 5 }
const SORTS = {
  status: (a, b) => STATUS_ORDER[status(a)] - STATUS_ORDER[status(b)] || a.idleMs - b.idleMs,
  name: (a, b) => (a.title || a.name).localeCompare(b.title || b.name),
  project: (a, b) => a.project.localeCompare(b.project) || a.idleMs - b.idleMs,
  engine: (a, b) => a.engine.localeCompare(b.engine) || a.idleMs - b.idleMs,
  model: (a, b) => String(a.model ?? '~').localeCompare(String(b.model ?? '~')),
  mem: (a, b) => (b.rssBytes || 0) - (a.rssBytes || 0),
  cpu: (a, b) => (b.cpu || 0) - (a.cpu || 0),
  idle: (a, b) => a.idleMs - b.idleMs,
  age: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
  machine: (a, b) => a.machine.localeCompare(b.machine),
}

function sorted() {
  const list = rows()
  if (state.hovering && state.frozen) {
    // Hold the order the person is looking at: known rows keep their place, new ones join at the end.
    const at = new Map(state.frozen.map((id, i) => [id, i]))
    return [...list].sort((a, b) => (at.get(a.id) ?? 1e9) - (at.get(b.id) ?? 1e9))
  }
  const by = SORTS[state.sort.key] ?? SORTS.status
  const out = [...list].sort(by)
  if (state.sort.dir === 'desc') out.reverse()
  state.frozen = out.map((row) => row.id)
  return out
}

const selectedRows = () => allRows().filter((row) => state.selected.has(row.id))
const targets = () => (state.selected.size ? selectedRows() : allRows().filter((row) => row.id === state.cursor))
const protectedWhy = (row) => { const entry = planFor(row.id); return entry?.protectedBy ? entry.why : null }
/** Offered only where it would actually happen: a protected harness (waiting on you, mid-turn, open in a
 *  window, pinned) is refused by the server, so the button would only ever produce an apology. */
/** This machine's harnesses, and another machine's when ITS daemon can save and resume them. */
const reachable = (row) => row.local || row.resumeVia === 'daemon'
const canPause = (row) => reachable(row) && row.state === 'running' && row.resumable && !protectedWhy(row)
const canResume = (row) => reachable(row) && row.state === 'paused' && row.resumable

function age(ms) { return ms ? humanIdle(Date.now() - ms) : '—' }
function gib(value) {
  const n = Number(value) || 0
  if (!n) return '—'
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`
}

/* ── the toolbar and the meters ────────────────────────────────────────────── */

function renderToolbar() {
  const summary = state.snapshot?.summary
  const counts = {
    all: allRows().filter((row) => inScope(row, 'all')).length,
    running: allRows().filter((row) => inScope(row, 'running')).length,
    paused: allRows().filter((row) => inScope(row, 'paused')).length,
    waiting: allRows().filter((row) => inScope(row, 'waiting')).length,
  }
  for (const node of document.querySelectorAll('[data-count]')) {
    const n = counts[node.dataset.count]
    node.textContent = node.dataset.count === 'waiting' && !n ? '' : String(n ?? '')
  }
  for (const button of document.querySelectorAll('[data-scope]')) button.setAttribute('aria-selected', String(button.dataset.scope === state.scope))
  for (const button of document.querySelectorAll('[data-machines]')) button.setAttribute('aria-selected', String(button.dataset.machines === state.machines))
  for (const button of document.querySelectorAll('.views [data-view]')) button.setAttribute('aria-selected', String(button.dataset.view === state.view))

  const chosen = targets()
  dom.actPause.disabled = state.busy || !chosen.some(canPause)
  dom.actResume.disabled = state.busy || !chosen.some(canResume)
  dom.actInspect.disabled = chosen.length !== 1
  const blocked = chosen.length === 1 && chosen[0].state === 'running' ? (protectedWhy(chosen[0]) ?? (!chosen[0].resumable ? 'it could not be resumed afterwards' : null)) : null
  dom.actPause.title = blocked ? `Not paused — ${blocked}` : chosen.length > 1 ? `Pause ${chosen.filter(canPause).length} (p)` : 'Pause — the engine exits, the conversation is kept (p)'
  dom.actResume.title = chosen.length > 1 ? `Resume ${chosen.filter(canResume).length} (r)` : 'Resume — back where it left off (r)'

  if (!summary) return
  const here = state.snapshot.rows.find((row) => row.local)?.machine ?? 'this machine'
  const remote = everyRow().filter((row) => !row.local).length
  dom.where.textContent = state.machines === 'all' && remote ? `${here} and ${new Set(everyRow().filter((row) => !row.local).map((row) => row.machine)).size} more` : here
  if (state.snapshot.status === 'degraded') dom.where.textContent = 'read from the registry — the daemon is not answering'
}

function renderMeters() {
  const summary = state.snapshot?.summary
  if (!summary) return
  const current = policy()
  const ceiling = Number(current.runningCeiling) || 100
  // The ceiling is per machine, so the meter counts this machine — whichever machines the list shows.
  const local = everyRow().filter((row) => row.local !== false)
  const running = local.filter((row) => row.state === 'running').length
  dom.runningValue.textContent = `${running} of ${ceiling}`
  dom.runningBar.style.width = `${Math.min(100, (running / ceiling) * 100)}%`
  dom.meterRunning.classList.toggle('hot', running / ceiling >= 0.9)

  const machineMemory = state.snapshot.machine?.memory || 0
  const held = local.reduce((sum, row) => sum + (row.rssBytes || 0), 0)
  dom.memoryValue.textContent = machineMemory ? `${gib(held)} of ${gib(machineMemory)}` : gib(held)
  dom.memoryBar.style.width = machineMemory ? `${Math.min(100, (held / machineMemory) * 100)}%` : '0%'
  dom.meterMemory.classList.toggle('hot', machineMemory ? held / machineMemory >= 0.6 : false)

  const due = (state.snapshot.plan ?? []).filter((entry) => entry.action === 'pause')
  const frees = due.reduce((sum, entry) => sum + (entry.frees || 0), 0)
  dom.policyValue.textContent = `pause after ${current.pauseAfterIdle}${due.length ? ` · ${due.length} due, ${gib(frees)}` : ' · nothing due'}`
  dom.policyReview.hidden = due.length === 0
}

/* ── the table ─────────────────────────────────────────────────────────────── */

function columns(multiMachine) {
  return [
    { key: 'status', label: '', width: '26px', cell: stateCell, className: 'c-state', title: 'Sort by status' },
    { key: 'name', label: 'Name', width: '33%', cell: nameCell },
    { key: 'project', label: 'Project', width: '15%', cell: (row) => text(row.project, 'dim') },
    { key: 'engine', label: 'Engine', width: '8%', cell: (row) => text(row.engine) },
    { key: 'model', label: 'Model', width: '11%', cell: (row) => text(row.model ?? '—', 'dim') },
    { key: 'mem', label: 'Memory', width: '8%', num: true, cell: (row) => text(gib(row.rssBytes), 'num') },
    { key: 'cpu', label: 'CPU %', width: '6%', num: true, cell: (row) => text(row.state === 'running' ? (row.cpu || 0).toFixed(1) : '—', 'num') },
    { key: 'idle', label: 'Idle', width: '6%', num: true, cell: (row) => text(humanIdle(row.idleMs), 'num'), title: 'Time since the last real turn' },
    { key: 'age', label: 'Age', width: '6%', num: true, cell: (row) => text(age(row.createdAt), 'num dim') },
    ...(multiMachine ? [{ key: 'machine', label: 'Machine', width: '9%', cell: (row) => text(row.machine, 'dim') }] : []),
    { key: 'do', label: '', width: '6%', cell: actionCell },
  ]
}

function text(value, className = '') {
  const td = document.createElement('td')
  td.className = className
  td.textContent = value
  return td
}

const STATUS_WORDS = { waiting: 'Waiting on you', working: 'Working', running: 'Running', paused: 'Paused', terminal: 'Shell' }

function stateCell(row) {
  const td = document.createElement('td')
  td.className = 'c-state'
  const dot = document.createElement('span')
  dot.className = `dot ${status(row)}`
  td.title = STATUS_WORDS[status(row)] ?? row.state
  td.append(dot)
  return td
}

function nameCell(row) {
  const td = document.createElement('td')
  const box = document.createElement('div')
  box.className = 'c-name'
  const title = document.createElement('span')
  title.className = 'title'
  title.textContent = row.title || row.name
  box.append(title)
  if (row.pinned) { const pin = document.createElement('span'); pin.className = 'pin'; pin.textContent = '●'; pin.title = 'pinned — the policy leaves it alone'; box.append(pin) }
  if (isDue(row)) { const due = document.createElement('span'); due.className = 'due'; due.textContent = 'due'; due.title = `the policy would pause this: ${planFor(row.id).why}`; box.append(due) }
  if (!row.local) { const remote = document.createElement('span'); remote.className = 'remote'; remote.textContent = '↗'; remote.title = reachable(row) ? `on ${row.machine}` : `on ${row.machine} — update Harness there to pause or resume it from here`; box.append(remote) }
  td.append(box)
  td.title = `${row.title || row.name}\n${row.home || row.cwd || ''}`
  return td
}

function actionCell(row) {
  const td = document.createElement('td')
  td.className = 'c-do'
  const verb = canPause(row) ? 'pause' : canResume(row) ? 'resume' : null
  if (verb) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.verb = verb
    button.dataset.only = row.id
    button.textContent = ACTIONS.find(([name]) => name === verb)[1]
    td.append(button)
  }
  return td
}

function renderTable() {
  const list = sorted()
  const multiMachine = new Set(list.map((row) => row.machine)).size > 1
  const cols = columns(multiMachine)
  const table = document.createElement('table')
  const colgroup = document.createElement('colgroup')
  for (const column of cols) { const col = document.createElement('col'); col.style.width = column.width; colgroup.append(col) }
  const head = document.createElement('tr')
  for (const column of cols) {
    const th = document.createElement('th')
    th.textContent = column.label
    if (column.num) th.className = 'num'
    if (column.className) th.className = column.className
    if (column.title) th.title = column.title
    if (column.key !== 'do') {
      th.dataset.sort = column.key
      if (state.sort.key === column.key) th.setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending')
    }
    head.append(th)
  }
  const thead = document.createElement('thead'); thead.append(head)
  const tbody = document.createElement('tbody')
  for (const row of list) {
    const tr = document.createElement('tr')
    tr.dataset.id = row.id
    tr.dataset.state = row.state
    tr.setAttribute('aria-selected', String(state.selected.has(row.id) || (!state.selected.size && state.cursor === row.id)))
    for (const column of cols) tr.append(column.cell(row))
    tbody.append(tr)
  }
  table.append(colgroup, thead, tbody)
  const scroll = dom.grid.scrollTop
  dom.grid.replaceChildren(table)
  dom.grid.scrollTop = scroll

  dom.tableEmpty.hidden = list.length > 0
  if (!list.length) {
    const scopeWord = { all: 'No harnesses', running: 'Nothing is running', paused: 'Nothing is paused', waiting: 'Nothing is waiting on you' }[state.scope]
    dom.tableEmpty.innerHTML = '<strong></strong><span></span>'
    dom.tableEmpty.querySelector('strong').textContent = state.filter ? `No harness matches “${state.filter}”` : `${scopeWord}.`
    dom.tableEmpty.querySelector('span').textContent = state.snapshot ? '' : 'Reading the fleet…'
  }
}

/* ── the timeline ──────────────────────────────────────────────────────────── */

function renderAxis() {
  const ticks = [['now', 0], ['1h', UNITS.h], ['6h', 6 * UNITS.h], ['1d', UNITS.d], ['3d', 3 * UNITS.d], ['1w', UNITS.w], ['2w', 2 * UNITS.w], ['4w', 4 * UNITS.w]]
  for (const node of dom.axis.querySelectorAll('.tick')) node.remove()
  for (const [label, idle] of ticks) {
    const tick = document.createElement('span')
    tick.className = 'tick'
    tick.textContent = label
    tick.style.left = `${xOf(idle) * 100}%`
    dom.axis.append(tick)
  }
  placeRules()
}

function placeRules() {
  const current = policy()
  const pauseX = xOf(parseDuration(current.pauseAfterIdle))
  const hideX = xOf(parseDuration(current.hideAfterIdle))
  dom.rulePause.style.left = `${pauseX * 100}%`
  dom.ruleHide.style.left = `${hideX * 100}%`
  dom.rulePause.setAttribute('aria-valuetext', current.pauseAfterIdle)
  dom.ruleHide.setAttribute('aria-valuetext', current.hideAfterIdle)
  dom.rulePause.querySelector('.rule-tag').textContent = `pause ${current.pauseAfterIdle}`
  dom.ruleHide.querySelector('.rule-tag').textContent = `hide ${current.hideAfterIdle}`
  dom.laneList.style.setProperty('--pause-x', pauseX)
  dom.laneList.style.setProperty('--hide-x', hideX)
}

/** Lay chips along a lane, each ending at its own moment in time; push any that overlap to a second row. */
function stack(track) {
  const width = track.clientWidth || 1
  const placed = []
  let levels = 1
  for (const chip of track.querySelectorAll('.chip')) {
    const w = chip.offsetWidth
    const left = Math.max(0, Math.min(width - w, Number(chip.dataset.x) * width - w))
    let level = 0
    while (placed.some((o) => o.level === level && left < o.right + 6 && left + w > o.left - 6)) level += 1
    placed.push({ level, left, right: left + w })
    levels = Math.max(levels, level + 1)
    chip.style.left = `${left}px`
    chip.style.top = `${6 + level * 26}px`
  }
  track.style.height = `${Math.max(34, 12 + levels * 26)}px`
}

function renderLanes() {
  const list = rows()
  dom.lanesEmpty.hidden = list.length > 0
  if (!list.length) dom.lanesEmpty.textContent = state.snapshot ? 'Nothing in this view.' : 'Reading the fleet…'
  const groups = new Map()
  for (const row of list) { const key = row.project || 'elsewhere'; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row) }
  const ordered = [...groups.entries()].sort((a, b) => Math.min(...a[1].map((r) => r.idleMs)) - Math.min(...b[1].map((r) => r.idleMs)))
  const fragment = document.createDocumentFragment()
  for (const [project, group] of ordered) {
    const lane = document.createElement('div'); lane.className = 'lane'
    const label = document.createElement('div'); label.className = 'lane-label'
    label.textContent = project
    if (group.length > 1) { const n = document.createElement('i'); n.textContent = String(group.length); label.append(n) }
    const track = document.createElement('div'); track.className = 'track'
    for (const row of [...group].sort((a, b) => a.idleMs - b.idleMs)) {
      const chip = document.createElement('button')
      chip.type = 'button'; chip.className = 'chip'
      chip.dataset.id = row.id; chip.dataset.state = row.state; chip.dataset.x = String(xOf(row.idleMs))
      if (isDue(row) && !state.draft) chip.dataset.due = 'true'
      chip.setAttribute('aria-selected', String(state.selected.has(row.id)))
      chip.title = `${row.title || row.name} · ${row.engine} · idle ${humanIdle(row.idleMs)}`
      const dot = document.createElement('span'); dot.className = `dot ${status(row)}`
      const what = document.createElement('span'); what.className = 'what'; what.textContent = row.title || row.name
      chip.append(dot, what)
      if (row.rssBytes) { const mem = document.createElement('span'); mem.className = 'mem'; mem.textContent = bytes(row.rssBytes); chip.append(mem) }
      track.append(chip)
    }
    lane.append(label, track)
    fragment.append(lane)
  }
  dom.laneList.replaceChildren(fragment)
  for (const track of dom.laneList.querySelectorAll('.track')) stack(track)
}

/* ── the inspector ─────────────────────────────────────────────────────────── */

function renderInspector() {
  const row = allRows().find((candidate) => candidate.id === state.inspecting)
  dom.inspector.hidden = !row
  if (!row) return
  // Below the meters, whatever height the toolbar wrapped to, so the sheet never covers a reading.
  dom.inspector.style.top = `${el('meters').getBoundingClientRect().bottom}px`
  const entry = planFor(row.id)
  dom.inspector.replaceChildren()

  const header = document.createElement('header')
  const heading = document.createElement('div')
  const h2 = document.createElement('h2'); h2.textContent = row.title || row.name
  const sub = document.createElement('div'); sub.className = 'sub'
  const dot = document.createElement('span'); dot.className = `dot ${status(row)}`
  const words = document.createElement('span')
  words.textContent = `${STATUS_WORDS[status(row)] ?? row.state} · ${row.engine}${row.model ? ` · ${row.model}` : ''}`
  sub.append(dot, words)
  heading.append(h2, sub)
  const close = document.createElement('button'); close.type = 'button'; close.className = 'close'; close.textContent = '✕'; close.setAttribute('aria-label', 'Close')
  close.addEventListener('click', () => { state.inspecting = null; renderInspector() })
  header.append(heading, close)
  dom.inspector.append(header)

  const facts = [
    ['Idle', `${humanIdle(row.idleMs)} — last turn ${new Date(row.lastActivity).toLocaleString()}`],
    ['Age', row.createdAt ? `${age(row.createdAt)} — created ${new Date(row.createdAt).toLocaleDateString()}` : '—'],
    ['Memory', row.rssBytes ? `${gib(row.rssBytes)} across ${row.procs} ${row.procs === 1 ? 'process' : 'processes'}` : '—'],
    ['CPU', row.state === 'running' ? `${(row.cpu || 0).toFixed(1)} %` : '—'],
    ['Folder', row.home || row.cwd || '—'],
    ['Branch', row.branch ?? '—'],
    ['Machine', reachable(row) ? row.machine : `${row.machine} — update Harness there to pause or resume it from here`],
    ['Pane', row.pane ?? (row.state === 'paused' ? 'none — resume opens a new one' : '—')],
    ['Conversation', row.sessionId ? row.sessionId.slice(0, 8) : 'none bound yet'],
  ]
  const overview = document.createElement('section')
  const h3 = document.createElement('h3'); h3.textContent = 'Overview'
  const dl = document.createElement('dl'); dl.className = 'facts'
  for (const [key, value] of facts) { const dt = document.createElement('dt'); dt.textContent = key; const dd = document.createElement('dd'); dd.textContent = value; dl.append(dt, dd) }
  overview.append(h3, dl)
  dom.inspector.append(overview)

  const rules = document.createElement('section')
  const rh = document.createElement('h3'); rh.textContent = 'Policy'
  const note = document.createElement('p'); note.className = 'note'
  if (row.state === 'paused') note.textContent = `Paused. Idle ${humanIdle(row.idleMs)} since its last turn.`
  else if (entry?.action === 'pause') note.textContent = `Due — the policy would pause this: ${entry.why}.`
  else if (entry?.protectedBy) note.textContent = `Protected — ${entry.why}, so it is never paused while that is true.`
  else note.textContent = entry?.why ? `Left alone — ${entry.why}.` : 'Left alone.'
  const how = document.createElement('p'); how.className = 'note'
  how.textContent = row.resumeVia === 'daemon' ? (row.state === 'paused' ? 'Resume brings its conversation back in a new pane.' : 'Pausing keeps its conversation; resuming opens it in a new pane.')
    : row.resumeVia === 'legacy' ? 'Paused before the daemon could save harnesses; it resumes into the pane it left.'
      : row.sessionId ? `The daemon cannot resume ${row.engine}, so it is never paused.` : 'No conversation is bound yet, so there is nothing to resume.'
  if (!row.resumeVia) how.classList.add('warn')
  rules.append(rh, note, how)
  dom.inspector.append(rules)

  if (row.screenTail) {
    const screen = document.createElement('section')
    const sh = document.createElement('h3'); sh.textContent = 'Last on its pane'
    const pre = document.createElement('pre'); pre.className = 'screen'; pre.textContent = row.screenTail
    screen.append(sh, pre)
    dom.inspector.append(screen)
  }

  const actions = document.createElement('div'); actions.className = 'row-actions'
  const verb = canPause(row) ? 'pause' : canResume(row) ? 'resume' : null
  if (verb) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'button primary'
    button.textContent = ACTIONS.find(([name]) => name === verb)[1]
    button.addEventListener('click', () => act(verb, [row.id]))
    actions.append(button)
  }
  dom.inspector.append(actions)
}

/* ── the policy review ─────────────────────────────────────────────────────── */

function openReview() {
  const due = (state.snapshot?.plan ?? []).filter((entry) => entry.action === 'pause')
  if (!due.length) return
  const byId = new Map(allRows().map((row) => [row.id, row]))
  const chosen = new Set(due.map((entry) => entry.id))
  dom.review.replaceChildren()
  const header = document.createElement('header')
  const h2 = document.createElement('h2'); h2.id = 'review-title'; h2.textContent = `Pause ${due.length} idle ${due.length === 1 ? 'harness' : 'harnesses'}`
  const p = document.createElement('p'); p.textContent = `The policy pauses anything untouched for ${policy().pauseAfterIdle}. Each one keeps its conversation and comes back with Resume.`
  header.append(h2, p)
  const list = document.createElement('div'); list.className = 'list'
  const total = document.createElement('span'); total.className = 'total'
  const go = document.createElement('button'); go.type = 'button'; go.className = 'button primary'
  const refresh = () => {
    const frees = [...chosen].reduce((sum, id) => sum + (byId.get(id)?.rssBytes || 0), 0)
    total.textContent = `${chosen.size} selected · frees ${gib(frees)}`
    go.textContent = `Pause ${chosen.size}`
    go.disabled = chosen.size === 0
  }
  for (const entry of due) {
    const row = byId.get(entry.id)
    const item = document.createElement('label'); item.className = 'item'
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = true
    box.addEventListener('change', () => { if (box.checked) chosen.add(entry.id); else chosen.delete(entry.id); refresh() })
    const name = document.createElement('span'); name.className = 'name'; name.textContent = row?.title || entry.name
    const why = document.createElement('span'); why.className = 'why'; why.textContent = `${row?.project ?? ''} · ${entry.why}`
    name.append(why)
    const idle = document.createElement('span'); idle.className = 'num'; idle.textContent = humanIdle(row?.idleMs ?? 0)
    const mem = document.createElement('span'); mem.className = 'num'; mem.textContent = gib(row?.rssBytes)
    item.append(box, name, idle, mem)
    list.append(item)
  }
  const footer = document.createElement('footer')
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'button'; cancel.textContent = 'Cancel'
  cancel.addEventListener('click', closeReview)
  go.addEventListener('click', () => { const ids = [...chosen]; closeReview(); act('pause', ids) })
  footer.append(total, cancel, go)
  dom.review.append(header, list, footer)
  refresh()
  dom.review.hidden = false
  dom.scrim.hidden = false
  go.focus()
}

function closeReview() { dom.review.hidden = true; dom.scrim.hidden = true }

/* ── the status bar ────────────────────────────────────────────────────────── */

function renderStatus() {
  const summary = state.snapshot?.summary
  const shown = rows().length
  const fresh = Date.now() - state.receivedAt < Math.max(12_000, (state.snapshot?.intervalMs ?? 4000) * 3)
  dom.statusLeft.innerHTML = '<span class="live"></span><span></span>'
  dom.statusLeft.querySelector('.live').classList.toggle('stale', !fresh)
  const bits = [`${shown} shown`]
  if (summary) {
    const shownRows = allRows()
    bits.push(`${shownRows.filter((row) => row.state === 'running').length} running`, `${shownRows.filter((row) => row.state === 'paused').length} paused`)
  }
  if (state.selected.size) bits.push(`${state.selected.size} selected`)
  const problems = state.snapshot?.problems ?? []
  if (problems.length && state.machines === 'all') bits.push(`⚠ ${problems.length} ${problems.length === 1 ? 'machine' : 'machines'} not reachable`)
  dom.statusLeft.lastChild.textContent = `${bits.join(' · ')}${fresh ? '' : ' · not updating'}`
  dom.statusLeft.title = problems.map((problem) => `${problem.machine}: ${problem.error}`).join('\n')
  dom.statusRight.innerHTML = state.view === 'table'
    ? '<span class="k"><kbd>⏎</kbd>Inspect</span><span class="k"><kbd>p</kbd>Pause</span><span class="k"><kbd>r</kbd>Resume</span><span class="k"><kbd>/</kbd>Search</span><span class="k"><kbd>1</kbd><kbd>2</kbd>Views</span>'
    : '<span class="k">Drag a line to try a policy</span><span class="k"><kbd>/</kbd>Search</span><span class="k"><kbd>1</kbd><kbd>2</kbd>Views</span>'
}

function render() {
  renderToolbar()
  renderMeters()
  placeRules()
  dom.table.hidden = state.view !== 'table'
  dom.lanes.hidden = state.view !== 'lanes'
  if (state.view === 'table') renderTable(); else renderLanes()
  renderStatus()
  renderInspector()
}

/* ── talking to the server ─────────────────────────────────────────────────── */

function toast(message, bad = false) {
  dom.toast.textContent = message
  dom.toast.className = `toast${bad ? ' bad' : ''}`
  dom.toast.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => { dom.toast.hidden = true }, 5000)
}

async function post(path, payload) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hps-token': TOKEN }, body: JSON.stringify(payload) })
  return response.json()
}

async function act(verb, ids) {
  const eligible = allRows().filter((row) => ids.includes(row.id) && (verb === 'pause' ? canPause(row) : canResume(row)))
  if (!eligible.length || state.busy) return
  state.busy = true
  renderToolbar()
  toast(`${verb === 'pause' ? 'Pausing' : 'Resuming'} ${eligible.length === 1 ? (eligible[0].title || eligible[0].name) : `${eligible.length} harnesses`}…`)
  try {
    const reply = await post('/api/act', { verb, ids: eligible.map((row) => row.id) })
    if (reply.error) { toast(reply.error, true); return }
    const results = reply.results ?? []
    const done = results.filter((result) => result.ok && !result.already)
    const failed = results.filter((result) => !result.ok)
    if (results.length === 1) toast(`${results[0].ok ? '' : 'Could not '}${results[0].ok ? (verb === 'pause' ? 'Paused' : 'Resumed') : verb}: ${results[0].detail}`, !results[0].ok)
    else toast(`${verb === 'pause' ? 'Paused' : 'Resumed'} ${done.length}${failed.length ? ` · ${failed.length} left alone — ${failed[0].detail}` : ''}`, done.length === 0)
    state.selected.clear()
  } catch (error) {
    toast(`Could not ${verb}: ${error.message}`, true)
  } finally {
    state.busy = false
    render()
  }
}

async function savePolicy() {
  if (!state.draft) return
  const reply = await post('/api/policy', { policy: state.draft })
  if (reply.error) { toast(reply.error, true); return }
  toast(`Saved to ${state.snapshot?.configPath ?? 'policy.jsonc'}: pause after ${reply.policy.pauseAfterIdle}, hide after ${reply.policy.hideAfterIdle}.`)
  state.draft = null
  dom.policybar.hidden = true
  render()
}

/* ── input ─────────────────────────────────────────────────────────────────── */

function setView(view) { state.view = view; keep('hm.view', view); render() }
function setScope(scope) { state.scope = scope; keep('hm.scope', scope); state.selected.clear(); render() }

function toggle(id, additive, range) {
  if (range && state.cursor) {
    const order = state.view === 'table' ? (state.frozen ?? []) : rows().map((row) => row.id)
    const [a, b] = [order.indexOf(state.cursor), order.indexOf(id)].sort((x, y) => x - y)
    if (a >= 0 && b >= 0) for (const pick of order.slice(a, b + 1)) state.selected.add(pick)
  } else if (additive) {
    if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id)
  } else {
    state.selected.clear()
    state.selected.add(id)
  }
  state.cursor = id
}

function moveCursor(delta) {
  const order = state.view === 'table' ? sorted().map((row) => row.id) : rows().map((row) => row.id)
  if (!order.length) return
  const index = order.indexOf(state.cursor)
  state.cursor = order[Math.min(order.length - 1, Math.max(0, (index < 0 ? -1 : index) + delta))]
  state.selected.clear()
  state.selected.add(state.cursor)
  if (state.inspecting) state.inspecting = state.cursor
  render()
  dom.grid.querySelector(`tr[data-id="${CSS.escape(state.cursor)}"]`)?.scrollIntoView({ block: 'nearest' })
}

document.addEventListener('click', (event) => {
  const verbButton = event.target.closest('[data-verb]')
  if (verbButton) {
    event.stopPropagation()
    const ids = verbButton.dataset.only ? [verbButton.dataset.only] : targets().map((row) => row.id)
    act(verbButton.dataset.verb, ids)
    return
  }
  if (event.target.closest('#act-inspect')) { const [one] = targets(); if (one) { state.inspecting = one.id; render() } return }
  const scope = event.target.closest('[data-scope]')?.dataset.scope
  if (scope) return setScope(scope)
  const machines = event.target.closest('[data-machines]')?.dataset.machines
  if (machines) { state.machines = machines; keep('hm.machines', machines); state.selected.clear(); return render() }
  const view = event.target.closest('.views [data-view]')?.dataset.view
  if (view) return setView(view)
  const th = event.target.closest('#grid th[data-sort]')
  if (th) {
    const key = th.dataset.sort
    state.sort = { key, dir: state.sort.key === key && state.sort.dir === 'asc' ? 'desc' : 'asc' }
    state.frozen = null
    return render()
  }
  const tr = event.target.closest('#grid tbody tr')
  const chip = event.target.closest('.chip')
  const id = tr?.dataset.id ?? chip?.dataset.id
  if (id) {
    toggle(id, event.metaKey || event.ctrlKey, event.shiftKey)
    if (state.inspecting || chip) state.inspecting = id
    return render()
  }
  if (event.target === dom.scrim) closeReview()
})

dom.grid.addEventListener('dblclick', (event) => {
  const id = event.target.closest('tbody tr')?.dataset.id
  if (id) { state.inspecting = id; render() }
})
dom.grid.addEventListener('pointerenter', () => { state.hovering = true })
dom.grid.addEventListener('pointerleave', () => { state.hovering = false; if (state.snapshot) render() })
dom.filter.addEventListener('input', () => { state.filter = dom.filter.value; render() })
dom.policyReview.addEventListener('click', openReview)
dom.policySave.addEventListener('click', savePolicy)
dom.policyReset.addEventListener('click', () => { state.draft = null; dom.policybar.hidden = true; render() })

for (const rule of [dom.rulePause, dom.ruleHide]) {
  const steps = rule.dataset.rule === 'pause' ? PAUSE_STEPS : HIDE_STEPS
  const key = rule.dataset.rule === 'pause' ? 'pauseAfterIdle' : 'hideAfterIdle'
  const preview = () => {
    const would = rows().filter((row) => row.state === 'running' && row.resumable && !row.pinned && !row.working && !row.attached && row.idleMs >= parseDuration(policy().pauseAfterIdle))
    const frees = would.reduce((sum, row) => sum + (row.rssBytes || 0), 0)
    dom.policyPreview.textContent = `Pause after ${policy().pauseAfterIdle} · hide after ${policy().hideAfterIdle} → would pause ${would.length}, freeing ${gib(frees)}`
    dom.policybar.hidden = false
    render()
  }
  rule.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    const box = dom.axis.getBoundingClientRect()
    const move = (e) => { state.draft = { ...(state.draft ?? {}), [key]: snap(idleOfX((e.clientX - box.left) / Math.max(1, box.width)), steps) }; preview() }
    const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
  })
  rule.addEventListener('keydown', (event) => {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (!direction) return
    event.preventDefault()
    const index = Math.max(0, Math.min(steps.length - 1, steps.indexOf(policy()[key]) - direction))
    state.draft = { ...(state.draft ?? {}), [key]: steps[index] }
    preview()
  })
}

document.addEventListener('keydown', (event) => {
  if (event.target === dom.filter) {
    if (event.key === 'Escape') { dom.filter.value = ''; state.filter = ''; dom.filter.blur(); render() }
    if (event.key === 'ArrowDown') { dom.filter.blur(); moveCursor(1) }
    return
  }
  if (!dom.review.hidden) { if (event.key === 'Escape') closeReview(); return }
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const key = event.key
  if (key === '/') { event.preventDefault(); dom.filter.focus(); return }
  if (key === '1') return setView('table')
  if (key === '2') return setView('lanes')
  if (key === 'j' || key === 'ArrowDown') { event.preventDefault(); return moveCursor(1) }
  if (key === 'k' || key === 'ArrowUp') { event.preventDefault(); return moveCursor(-1) }
  if (key === ' ') { event.preventDefault(); if (state.cursor) { toggle(state.cursor, true); render() } return }
  if (key === 'Enter' || key === 'i') { if (state.cursor) { state.inspecting = state.cursor; render() } return }
  if (key === 'Escape') { state.selected.clear(); state.inspecting = null; state.draft = null; dom.policybar.hidden = true; return render() }
  if (key === 'p') { event.preventDefault(); return act('pause', targets().map((row) => row.id)) }
  if (key === 'r') { event.preventDefault(); return act('resume', targets().map((row) => row.id)) }
})

window.addEventListener('resize', () => { if (state.view === 'lanes') renderLanes() })
setInterval(() => { if (state.snapshot) renderStatus() }, 5000)

/* ── deep links ────────────────────────────────────────────────────────────── */

/** `?view=lanes`, `?scope=paused`, `?machines=all`, `?inspect=<agentId>`, `?review=1` — so the agent beside
 *  this pane, or the app, can open it on exactly the harness it is talking about. Read once, on the first
 *  snapshot, then the URL is left alone. */
const link = new URLSearchParams(location.search)
if (['table', 'lanes'].includes(link.get('view'))) state.view = link.get('view')
if (['all', 'running', 'paused', 'waiting'].includes(link.get('scope'))) state.scope = link.get('scope')
if (['local', 'all'].includes(link.get('machines'))) state.machines = link.get('machines')
let linkPending = Boolean(link.get('inspect') || link.get('review'))
function followLink() {
  if (!linkPending || !state.snapshot) return
  linkPending = false
  const id = link.get('inspect')
  if (id && everyRow().some((row) => row.id === id)) { state.cursor = id; state.selected = new Set([id]); state.inspecting = id }
  render()
  if (link.get('review')) openReview()
}

/* ── the stream ────────────────────────────────────────────────────────────── */

function listen() {
  const source = new EventSource('/events')
  source.addEventListener('snapshot', (event) => {
    try { state.snapshot = JSON.parse(event.data) } catch { return }
    if (!state.snapshot.summary) return
    state.receivedAt = Date.now()
    render()
    followLink()
  })
  source.addEventListener('error', () => { source.close(); renderStatus(); setTimeout(listen, 2500) })
}

/** Draw from the snapshot the server put in the page, before the live stream has said anything. */
function firstPaint() {
  try {
    const initial = JSON.parse(document.getElementById('initial-snapshot')?.textContent || 'null')
    if (initial?.summary) { state.snapshot = initial; state.receivedAt = Date.now() }
  } catch { /* a page served without one draws when the stream arrives */ }
}

firstPaint()
renderAxis()
render()
followLink()
listen()
