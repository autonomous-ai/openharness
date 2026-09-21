/* Harness Monitor's pane.
 *
 * One snapshot from the server, two ways to read it, and six verbs. No build step, no dependencies, no
 * inline script — the page is served with `script-src 'self'`, so everything here is plain DOM and one
 * ES module import for the arithmetic (viewer/scale.js, tested in test/scale.test.mjs).
 *
 * The two views share ONE selection and ONE cursor on purpose: a fleet manager where the dense list and
 * the picture disagree about what is selected is a fleet manager that cannot be trusted with a verb.
 */
import { HIDE_STEPS, PAUSE_STEPS, UNITS, bytes, humanIdle, idleOfX, parseDuration, snap, xOf } from './scale.js'

const TOKEN = document.querySelector('meta[name="hps-token"]')?.content ?? ''

const el = (id) => document.getElementById(id)
const dom = {
  where: el('where'), gauges: el('gauges'), filter: el('filter'), refresh: el('refresh'),
  lanes: el('lanes-view'), laneList: el('lane-list'), axis: el('axis'), lanesEmpty: el('lanes-empty'),
  table: el('table'), grid: el('grid'),
  rulePause: el('rule-pause'), ruleHide: el('rule-hide'),
  showAll: el('show-all'), policybar: el('policybar'), policyPreview: el('policy-preview'), policySave: el('policy-save'), policyReset: el('policy-reset'),
  statusLeft: el('status-left'), statusActions: el('status-actions'), statusRight: el('status-right'),
  inspector: el('inspector'), toast: el('toast'),
}

const state = {
  snapshot: null,
  view: 'lanes',
  filter: '',
  showAll: false,
  selected: new Set(),
  cursor: null,
  inspecting: null,
  sort: { key: 'idle', dir: 'asc' },
  draft: null,      // policy being dragged, before it is saved
  busy: false,
}

/* ── the fleet, filtered ──────────────────────────────────────────────────── */

function policy() {
  return { ...(state.snapshot?.policy ?? {}), ...(state.draft ?? {}) }
}

function rows() {
  const all = state.snapshot?.rows ?? []
  const hideMs = parseDuration(policy().hideAfterIdle ?? '14d')
  // Below the fold unless you ask: a pane that opens on 146 rows is the junk drawer this was built to fix.
  // Filtering by hand overrides it, because someone typing a name is looking for that name anywhere.
  const needle = state.filter.trim().toLowerCase()
  const visible = state.showAll || needle
    ? all
    : all.filter((row) => row.state !== 'gone' && row.idleMs < hideMs)
  if (!needle) return visible
  return visible.filter((row) => [row.name, row.title, row.project, row.engine, row.model, row.branch, row.machine, row.state]
    .some((field) => String(field ?? '').toLowerCase().includes(needle)))
}

/** What the plan says about one row, as the server computed it — unless a line is being dragged, in
 *  which case the same idle rules are applied here so the picture answers while the mouse is moving. */
function verdictFor(row) {
  if (state.draft) {
    const pause = parseDuration(state.draft.pauseAfterIdle ?? policy().pauseAfterIdle)

    if (row.pinned || row.needsInput || row.working || row.attached) return null
    if (row.state === 'gone' || row.state === 'terminal') return null
    if (row.state === 'running' && row.idleMs >= pause) return 'pause'
    return null
  }
  const entry = (state.snapshot?.plan ?? []).find((candidate) => candidate.id === row.id)
  return entry && entry.action !== 'keep' ? entry.action : null
}

function planTotals(list) {
  let pause = 0, frees = 0
  for (const row of list) {
    if (verdictFor(row) !== 'pause') continue
    pause += 1
    if (row.state === 'running') frees += row.rssBytes || 0
  }
  return { pause, frees }
}

/* ── rendering ────────────────────────────────────────────────────────────── */

function renderGauges() {
  const summary = state.snapshot?.summary
  if (!summary) return
  const held = summary.held >= 1024 ** 3 ? `${(summary.held / 1024 ** 3).toFixed(1)} GB` : `${Math.round(summary.held / 1024 ** 2)} MB`
  const chips = [
    ['live', summary.running, 'running'],
    ['', summary.paused, 'paused'],
    ['', held, 'held'],
    ['', summary.projects, 'projects'],
  ]
  if (summary.needsInput) chips.unshift(['attention', summary.needsInput, 'waiting on you'])
  dom.gauges.replaceChildren(...chips.map(([kind, value, label]) => {
    const node = document.createElement('span')
    node.className = `gauge ${kind}`.trim()
    node.innerHTML = `<b></b> <span></span>`
    node.querySelector('b').textContent = value
    node.querySelector('span').textContent = label
    return node
  }))
  const machines = state.snapshot.rows.filter((row) => !row.local).length
  dom.where.textContent = machines
    ? `this machine, plus ${machines} seen elsewhere`
    : state.snapshot.status === 'degraded' ? 'read from the registry — the daemon is not answering' : 'this machine'
}

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

function chipFor(row) {
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = 'chip'
  chip.dataset.id = row.id
  chip.dataset.state = row.state
  chip.dataset.working = String(Boolean(row.working && row.state === 'running'))
  chip.dataset.attention = String(Boolean(row.needsInput))
  chip.dataset.selected = String(state.selected.has(row.id))
  const doomed = verdictFor(row)
  if (doomed) chip.dataset.doomed = 'true'
  chip.title = `${row.title || row.name}\n${row.engine}${row.model ? ` · ${row.model}` : ''} · idle ${humanIdle(row.idleMs)}${doomed ? `\nthe policy would ${doomed} this` : ''}`
  const dot = document.createElement('span'); dot.className = 'dot'
  const what = document.createElement('span'); what.className = 'what'; what.textContent = row.title || row.name
  chip.append(dot, what)
  if (row.pinned) { const pin = document.createElement('span'); pin.className = 'pin'; pin.textContent = '📌'; chip.append(pin) }
  if (row.rssBytes) { const mem = document.createElement('span'); mem.className = 'mem'; mem.textContent = bytes(row.rssBytes); chip.append(mem) }
  return chip
}

/** Lay the chips out along the lane, then push any that overlap onto a second row of the same lane.
 *  Measured, not estimated: a title's width depends on the font the app is in. */
function stack(track) {
  const chips = [...track.querySelectorAll('.chip')]
  const width = track.clientWidth || 1
  const placed = []
  let rowsUsed = 1
  for (const chip of chips) {
    const w = chip.offsetWidth
    const wanted = Number(chip.dataset.x) * width
    const left = Math.max(0, Math.min(width - w, wanted - w))   // the chip ends at its own moment in time
    let level = 0
    while (placed.some((other) => other.level === level && left < other.right + 6 && left + w > other.left - 6)) level += 1
    placed.push({ level, left, right: left + w })
    rowsUsed = Math.max(rowsUsed, level + 1)
    chip.style.left = `${left}px`
    chip.style.top = `${5 + level * 26}px`
  }
  track.style.height = `${Math.max(34, 10 + rowsUsed * 26)}px`
}

function renderLanes() {
  const list = rows().filter((row) => row.state !== 'gone' || state.filter)
  dom.lanesEmpty.hidden = list.length > 0
  const lanes = new Map()
  for (const row of list) {
    const key = row.project || 'elsewhere'
    if (!lanes.has(key)) lanes.set(key, [])
    lanes.get(key).push(row)
  }
  // Freshest project first: the top of the hps is the working set, and the sediment sinks.
  const ordered = [...lanes.entries()].sort((a, b) => Math.min(...a[1].map((r) => r.idleMs)) - Math.min(...b[1].map((r) => r.idleMs)))
  const fragment = document.createDocumentFragment()
  for (const [project, group] of ordered) {
    const lane = document.createElement('div')
    lane.className = 'lane'
    const label = document.createElement('div')
    label.className = 'lane-label'
    const branch = group.find((row) => row.branch)?.branch
    label.innerHTML = '<b></b> <i></i>'
    label.querySelector('b').textContent = project
    label.querySelector('i').textContent = group.length > 1 ? `×${group.length}` : (branch ?? '')
    label.title = group.map((row) => `${row.title || row.name} — ${humanIdle(row.idleMs)}`).join('\n')
    const track = document.createElement('div')
    track.className = 'track'
    for (const row of [...group].sort((a, b) => a.idleMs - b.idleMs)) {
      const chip = chipFor(row)
      chip.dataset.x = String(xOf(row.idleMs))
      track.append(chip)
    }
    lane.append(label, track)
    fragment.append(lane)
  }
  dom.laneList.replaceChildren(fragment)
  for (const track of dom.laneList.querySelectorAll('.track')) stack(track)
}

const COLUMNS = [
  { key: 'n', label: '#', sortable: false, cell: (row, i) => ({ text: String(i + 1), className: 'c-num' }) },
  { key: 'state', label: '', cell: (row) => {
    const glyph = row.needsInput ? '!' : row.state === 'running' ? (row.working ? '◐' : '●')
      : row.state === 'paused' ? '○' : row.state === 'terminal' ? '$' : '✕'
    const kind = row.needsInput ? 'attention' : row.working && row.state === 'running' ? 'working' : row.state
    return { text: glyph, className: `c-state st-${kind}`, title: row.needsInput ? 'looks like it is waiting on you' : row.state }
  } },
  { key: 'idle', label: 'idle', cell: (row) => ({ text: row.state === 'gone' ? '—' : humanIdle(row.idleMs), className: 'c-idle' }) },
  { key: 'engine', label: 'engine', cell: (row) => ({ text: row.engine }) },
  { key: 'model', label: 'model', cell: (row) => ({ text: row.model ?? '—', className: 'c-dim' }) },
  { key: 'mem', label: 'mem', cell: (row, i, max) => ({ text: bytes(row.rssBytes), className: 'c-mem membar', bar: max ? (row.rssBytes || 0) / max : 0 }) },
  { key: 'project', label: 'project', cell: (row) => ({ text: row.project, className: 'c-project' }) },
  { key: 'branch', label: 'branch', cell: (row) => ({ text: row.branch ?? '—', className: 'c-dim' }) },
  { key: 'title', label: 'title', cell: (row) => ({ text: row.title || row.name, className: 'c-title' }) },
  // The verb, on the row. It used to appear only after selecting something, which meant a person looking
  // for "the pause button" could not find one.
  { key: 'do', label: '', sortable: false, cell: (row) => ({ text: '', className: 'c-do', verb: row.state === 'running' ? 'pause' : row.state === 'paused' ? 'resume' : null }) },
]

const SORTS = {
  idle: (a, b) => a.idleMs - b.idleMs,
  mem: (a, b) => (b.rssBytes || 0) - (a.rssBytes || 0),
  state: (a, b) => a.state.localeCompare(b.state) || a.idleMs - b.idleMs,
  engine: (a, b) => a.engine.localeCompare(b.engine) || a.idleMs - b.idleMs,
  model: (a, b) => String(a.model ?? '').localeCompare(String(b.model ?? '')),
  project: (a, b) => a.project.localeCompare(b.project) || a.idleMs - b.idleMs,
  branch: (a, b) => String(a.branch ?? '').localeCompare(String(b.branch ?? '')),
  title: (a, b) => String(a.title || a.name).localeCompare(String(b.title || b.name)),
}

function sortedRows() {
  const list = [...rows()]
  const by = SORTS[state.sort.key] ?? SORTS.idle
  list.sort(by)
  if (state.sort.dir === 'desc') list.reverse()
  return list
}

function renderTable() {
  const list = sortedRows()
  const max = Math.max(1, ...list.map((row) => row.rssBytes || 0))
  const table = document.createElement('table')
  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const column of COLUMNS) {
    const th = document.createElement('th')
    th.textContent = column.label
    if (column.sortable !== false) {
      th.dataset.sort = column.key
      if (state.sort.key === column.key) th.setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending')
    }
    headRow.append(th)
  }
  thead.append(headRow)
  const tbody = document.createElement('tbody')
  list.forEach((row, index) => {
    const tr = document.createElement('tr')
    tr.dataset.id = row.id
    tr.dataset.selected = String(state.selected.has(row.id))
    tr.dataset.cursor = String(state.cursor === row.id)
    if (verdictFor(row)) tr.dataset.doomed = 'true'
    for (const column of COLUMNS) {
      const td = document.createElement('td')
      const cell = column.cell(row, index, max)
      td.className = cell.className ?? ''
      if (cell.title) td.title = cell.title
      if (cell.verb) {
        const button = document.createElement('button')
        button.type = 'button'
        button.dataset.verb = cell.verb
        button.dataset.only = row.id
        button.textContent = cell.verb === 'pause' ? 'Pause' : 'Resume'
        td.append(button)
      } else if (cell.bar) {
        const bar = document.createElement('i')
        bar.style.width = `${Math.max(2, cell.bar * 46)}px`
        const span = document.createElement('span')
        span.textContent = cell.text
        td.append(bar, span)
      } else td.textContent = cell.text
      tr.append(td)
    }
    tbody.append(tr)
  })
  table.append(thead, tbody)
  dom.grid.replaceChildren(table)
}

function renderStatus() {
  const summary = state.snapshot?.summary
  const list = rows()
  const totals = planTotals(list)
  const held = totals.frees >= 1024 ** 3 ? `${(totals.frees / 1024 ** 3).toFixed(1)} GB` : `${Math.round(totals.frees / 1024 ** 2)} MB`
  const hidden = (state.snapshot?.rows ?? []).length - list.length
  const bits = [`${list.length} shown${hidden > 0 ? ` of ${(state.snapshot?.rows ?? []).length}` : ''}`]
  if (summary) bits.push(`${summary.running} running`, `${summary.paused} paused`)
  if (totals.pause) bits.push(`policy: pause ${totals.pause} (${held})`)
  for (const problem of state.snapshot?.problems ?? []) bits.push(`⚠ ${problem.machine}`)
  dom.statusLeft.textContent = bits.join('  ·  ')

  const count = state.selected.size
  dom.statusActions.hidden = count === 0
  if (count) {
    dom.statusActions.replaceChildren()
    const label = document.createElement('span')
    label.textContent = `${count} selected`
    dom.statusActions.append(label)
    for (const [verb, text] of [['pause', 'Pause'], ['resume', 'Resume'], ['pin', 'Pin'], ['unpin', 'Unpin']]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = text
      button.dataset.verb = verb
      dom.statusActions.append(button)
    }
    const clear = document.createElement('button')
    clear.type = 'button'; clear.textContent = 'Clear'; clear.dataset.verb = 'clear'
    dom.statusActions.append(clear)
  }
  dom.statusRight.innerHTML = state.view === 'table'
    ? '<kbd>j</kbd><kbd>k</kbd> move · <kbd>space</kbd> select · <kbd>p</kbd> pause · <kbd>r</kbd> resume · <kbd>i</kbd> pin · <kbd>/</kbd> filter'
    : `rules: <code></code> · drag a line to try a change · <kbd>/</kbd> filter`
  const code = dom.statusRight.querySelector('code')
  if (code) code.textContent = state.snapshot?.configPath ?? '~/.config/harness/policy.jsonc'
}

function renderInspector() {
  const row = (state.snapshot?.rows ?? []).find((candidate) => candidate.id === state.inspecting)
  if (!row) { dom.inspector.hidden = true; return }
  dom.inspector.hidden = false
  const verdict = verdictFor(row)
  const entry = (state.snapshot?.plan ?? []).find((candidate) => candidate.id === row.id)
  dom.inspector.replaceChildren()
  const header = document.createElement('header')
  const heading = document.createElement('div')
  const h2 = document.createElement('h2'); h2.textContent = row.title || row.name
  const sub = document.createElement('div'); sub.className = 'sub'
  sub.textContent = `${row.state}${row.pinned ? ' · pinned' : ''} · ${row.engine}${row.model ? ` ${row.model}` : ''} · ${row.machine}`
  heading.append(h2, sub)
  const close = document.createElement('button'); close.type = 'button'; close.className = 'ghost'; close.textContent = '✕'
  close.addEventListener('click', () => { state.inspecting = null; renderInspector() })
  header.append(heading, close)
  dom.inspector.append(header)

  if (entry && entry.action !== 'keep') {
    const why = document.createElement('p'); why.className = 'why'
    why.textContent = `The policy would ${entry.action} this: ${entry.why}.`
    dom.inspector.append(why)
  } else if (entry?.protectedBy) {
    const why = document.createElement('p'); why.className = 'why'
    why.textContent = `Protected: ${entry.why}.`
    dom.inspector.append(why)
  }

  const dl = document.createElement('dl')
  const pairs = [
    ['idle', `${humanIdle(row.idleMs)} — last turn ${new Date(row.lastActivity).toLocaleString()}`],
    ['folder', row.home || '—'],
    ['branch', row.branch ?? '—'],
    ['memory', row.rssBytes ? `${bytes(row.rssBytes)} across ${row.procs} ${row.procs === 1 ? 'process' : 'processes'}` : '—'],
    ['pane', row.pane ? `${row.pane}${row.dead ? ' (dead, held open)' : ''}` : '—'],
    ['harness', row.dshName ?? row.dsh ?? '—'],
    ['id', row.id.slice(0, 8)],
  ]
  for (const [key, value] of pairs) {
    const dt = document.createElement('dt'); dt.textContent = key
    const dd = document.createElement('dd'); dd.textContent = value
    dl.append(dt, dd)
  }
  dom.inspector.append(dl)

  if (row.screenTail) {
    const screen = document.createElement('pre'); screen.className = 'screen'; screen.textContent = row.screenTail
    dom.inspector.append(screen)
  }
  const actions = document.createElement('div'); actions.className = 'row-actions'
  // A shell has no conversation to pause or resume, so it is offered neither.
  const verbs = row.state === 'terminal' ? [] : row.state === 'running' ? [['pause', 'Pause']] : [['resume', 'Resume']]
  if (row.state !== 'terminal') verbs.push(row.pinned ? ['unpin', 'Unpin'] : ['pin', 'Pin'])
  for (const [verb, text] of verbs) {
    const button = document.createElement('button')
    button.type = 'button'; button.className = 'ghost'; button.textContent = text
    button.addEventListener('click', () => act(verb, [row.id]))
    actions.append(button)
  }
  dom.inspector.append(actions)
  if (verdict) dom.inspector.dataset.verdict = verdict
}

function render() {
  if (!state.snapshot) return
  renderGauges()
  placeRules()
  if (state.view === 'lanes') renderLanes(); else renderTable()
  renderStatus()
  renderInspector()
}

/* ── talking to the server ────────────────────────────────────────────────── */

function toast(message, bad = false) {
  dom.toast.textContent = message
  dom.toast.className = `toast${bad ? ' bad' : ''}`
  dom.toast.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => { dom.toast.hidden = true }, 4200)
}

async function post(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hps-token': TOKEN },
    body: JSON.stringify(payload),
  })
  return response.json()
}

async function act(verb, ids) {
  if (state.busy || !ids.length) return
  state.busy = true
  try {
    const reply = await post('/api/act', { verb, ids })
    if (reply.error) { toast(reply.error, true); return }
    const results = reply.results ?? []
    const ok = results.filter((result) => result.ok && !result.already).length
    const refused = results.filter((result) => result.refused)
    if (results.length === 1) toast(`${results[0].ok ? '' : 'not '}${verb}: ${results[0].detail}`, !results[0].ok)
    else toast(`${verb}: ${ok} done${refused.length ? `, ${refused.length} left alone (${refused[0].detail})` : ''}`, ok === 0)
    state.selected.clear()
  } catch (error) {
    toast(`Could not ${verb}: ${error.message}`, true)
  } finally {
    state.busy = false
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

/* ── input ────────────────────────────────────────────────────────────────── */

function setView(view) {
  state.view = view
  dom.lanes.hidden = view !== 'lanes'
  dom.table.hidden = view !== 'table'
  for (const button of document.querySelectorAll('.segmented button')) {
    button.setAttribute('aria-selected', String(button.dataset.view === view))
  }
  render()
}

function toggle(id, additive) {
  if (!additive) {
    const only = state.selected.size === 1 && state.selected.has(id)
    state.selected.clear()
    if (!only) state.selected.add(id)
  } else if (state.selected.has(id)) state.selected.delete(id)
  else state.selected.add(id)
  state.cursor = id
}

function targets() {
  if (state.selected.size) return [...state.selected]
  return state.cursor ? [state.cursor] : []
}

function moveCursor(delta) {
  const list = state.view === 'table' ? sortedRows() : rows()
  if (!list.length) return
  const index = list.findIndex((row) => row.id === state.cursor)
  const next = list[Math.min(list.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta))]
  state.cursor = next.id
  state.inspecting = state.inspecting ? next.id : null
  render()
  const node = dom.grid.querySelector(`tr[data-id="${next.id}"]`)
  node?.scrollIntoView({ block: 'nearest' })
}

document.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip')
  if (chip) { toggle(chip.dataset.id, event.metaKey || event.ctrlKey || event.shiftKey); state.inspecting = chip.dataset.id; render(); return }
  const tr = event.target.closest('#grid tbody tr')
  if (tr) { toggle(tr.dataset.id, event.metaKey || event.ctrlKey || event.shiftKey); state.inspecting = state.inspecting ? tr.dataset.id : null; render(); return }
  const th = event.target.closest('#grid th[data-sort]')
  if (th) {
    const key = th.dataset.sort
    state.sort = { key, dir: state.sort.key === key && state.sort.dir === 'asc' ? 'desc' : 'asc' }
    render(); return
  }
  const button = event.target.closest('[data-verb]')
  const verb = button?.dataset.verb
  if (verb === 'clear') { state.selected.clear(); render(); return }
  // A button on a row acts on THAT row, whatever else is selected — otherwise clicking Pause next to one
  // harness would pause five.
  if (verb) { event.stopPropagation(); act(verb, button.dataset.only ? [button.dataset.only] : targets()); return }
  const view = event.target.closest('[data-view]')?.dataset.view
  if (view) setView(view)
})

dom.refresh.addEventListener('click', () => post('/api/refresh', {}).then(() => toast('Refreshed.')))
dom.showAll.addEventListener('click', () => {
  state.showAll = !state.showAll
  dom.showAll.setAttribute('aria-pressed', String(state.showAll))
  render()
})
dom.policySave.addEventListener('click', savePolicy)
dom.policyReset.addEventListener('click', () => { state.draft = null; dom.policybar.hidden = true; render() })
dom.filter.addEventListener('input', () => { state.filter = dom.filter.value; render() })

/* Dragging a rule: the hps is the only place a threshold can be judged, because the thing you are
   judging is how many chips end up on the wrong side of it. */
for (const rule of [dom.rulePause, dom.ruleHide]) {
  const steps = rule.dataset.rule === 'pause' ? PAUSE_STEPS : HIDE_STEPS
  const key = rule.dataset.rule === 'pause' ? 'pauseAfterIdle' : 'hideAfterIdle'
  const begin = (event) => {
    event.preventDefault()
    rule.classList.add('dragging')
    const track = dom.axis.getBoundingClientRect()
    const move = (moveEvent) => {
      const x = (moveEvent.clientX - track.left) / Math.max(1, track.width)
      state.draft = { ...(state.draft ?? {}), [key]: snap(idleOfX(x), steps) }
      dom.policybar.hidden = false
      const totals = planTotals(rows())
      const held = totals.frees >= 1024 ** 3 ? `${(totals.frees / 1024 ** 3).toFixed(1)} GB` : `${Math.round(totals.frees / 1024 ** 2)} MB`
      dom.policyPreview.textContent = `pause after ${policy().pauseAfterIdle}, hide after ${policy().hideAfterIdle} → would pause ${totals.pause}, handing back ${held}`
      render()
    }
    const end = () => {
      rule.classList.remove('dragging')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
  }
  rule.addEventListener('pointerdown', begin)
  rule.addEventListener('keydown', (event) => {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (!direction) return
    event.preventDefault()
    const current = policy()[key]
    const index = Math.max(0, Math.min(steps.length - 1, steps.indexOf(current) - direction))
    state.draft = { ...(state.draft ?? {}), [key]: steps[index] }
    dom.policybar.hidden = false
    render()
  })
}

document.addEventListener('keydown', (event) => {
  if (event.target === dom.filter) {
    if (event.key === 'Escape') { dom.filter.value = ''; state.filter = ''; dom.filter.blur(); render() }
    return
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const key = event.key
  if (key === '/') { event.preventDefault(); dom.filter.focus(); return }
  if (key === '1') return setView('lanes')
  if (key === '2') return setView('table')
  if (key === 'j' || key === 'ArrowDown') { event.preventDefault(); return moveCursor(1) }
  if (key === 'k' || key === 'ArrowUp') { event.preventDefault(); return moveCursor(-1) }
  if (key === 'g') { const list = state.view === 'table' ? sortedRows() : rows(); state.cursor = list[0]?.id ?? null; return render() }
  if (key === 'G') { const list = state.view === 'table' ? sortedRows() : rows(); state.cursor = list.at(-1)?.id ?? null; return render() }
  if (key === ' ') { event.preventDefault(); if (state.cursor) { toggle(state.cursor, true); render() } return }
  if (key === 'Enter') { state.inspecting = state.cursor; return render() }
  if (key === 'Escape') { state.selected.clear(); state.inspecting = null; state.draft = null; dom.policybar.hidden = true; return render() }
  // h pause · r resume · x retire · i pin · u unpin. `p` and `w` stay bound to the same two verbs,
  // because anyone who used this before it was renamed will reach for them.
  const verbs = { p: 'pause', h: 'pause', r: 'resume', w: 'resume', i: 'pin', u: 'unpin' }
  if (verbs[key]) { event.preventDefault(); act(verbs[key], targets()) }
})

window.addEventListener('resize', () => { if (state.view === 'lanes') renderLanes() })

/* ── the stream ───────────────────────────────────────────────────────────── */

function listen() {
  const source = new EventSource('/events')
  source.addEventListener('snapshot', (event) => {
    try { state.snapshot = JSON.parse(event.data) } catch { return }
    render()
  })
  source.addEventListener('error', () => {
    dom.where.textContent = 'reconnecting…'
    source.close()
    setTimeout(listen, 2500)
  })
}

renderAxis()
listen()
