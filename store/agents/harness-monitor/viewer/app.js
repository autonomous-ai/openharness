import { ACTIVITY, SPINNER, COLUMNS, PRESETS, isLive, visibleRows, number, memory, bytes, age, formatValue, sumReading, storageTotal } from './table.js'
const el = id => document.getElementById(id)
const dom = {
  search: el('search'), filter: el('filter'), machine: el('machine'), columns: el('columns'), columnOptions: el('column-options'),
  grid: el('grid'), table: el('table'), colgroup: el('colgroup'), head: el('head'), body: el('body'),
  empty: el('empty'), count: el('count'), message: el('message'), updated: el('updated'), problems: el('problems'),
  refresh: el('refresh'), freeze: el('freeze'), live: el('live-status'), inspect: el('inspect'),
  summary: el('summary'), shared: el('shared'), sharedTitle: el('shared-title'), sharedBody: el('shared-body'),
  inspector: el('inspector'), inspectTitle: el('inspect-title'), inspectContext: el('inspect-context'),
  inspectContent: el('inspect-content'), inspectClose: el('inspect-close'), inspectStop: el('inspect-stop'), inspectDelete: el('inspect-delete'),
  stopDialog: el('stop-dialog'), stopTitle: el('stop-title'), stopContext: el('stop-context'), stopResult: el('stop-result'),
  stopCancel: el('stop-cancel'), stopConfirm: el('stop-confirm'), stopDescription: el('stop-description'), stopStorage: el('stop-storage'),
  deleteChoices: el('delete-choices'), deleteSession: el('delete-session'), deleteSessionSize: el('delete-session-size'),
  deleteSessionPaths: el('delete-session-paths'), deleteSessionNote: el('delete-session-note'),
  deleteWorktree: el('delete-worktree'), deleteWorktreeSize: el('delete-worktree-size'),
  deleteWorktreePath: el('delete-worktree-path'), deleteWorktreeNote: el('delete-worktree-note'),
  worktreeChanges: el('worktree-changes'), worktreeDiscardLabel: el('worktree-discard-label'), worktreeDiscard: el('worktree-discard'),
}
const token = document.querySelector('meta[name="hps-token"]').content
const STORAGE_KEY = 'harness-monitor.process-table.v5'
let saved = {}
try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {} } catch { /* optional preference storage */ }
const state = {
  rows: [], snapshot: null, query: '', filter: 'all', machine: 'all',
  sort: COLUMNS.some(c => c.key === saved.sort) ? saved.sort : 'workspaceBytes', direction: saved.direction === 1 ? 1 : -1,
  preset: Object.hasOwn(PRESETS, saved.preset) ? saved.preset : 'overview',
  visible: new Set(Array.isArray(saved.visible) ? saved.visible : PRESETS.overview), widths: {},
  selected: null, inspecting: null, busy: new Set(), nodes: new Map(), shown: [],
  frozen: false, pending: null, connected: false, receivedAt: 0, review: null, workspaceInspection: null,
}
for (const col of COLUMNS) state.widths[col.key] = Math.max(64, Math.min(600, Number(saved.widths?.[col.key]) || col.width))
const text = (node, value) => { if (node.textContent !== String(value)) node.textContent = value }
function element(tag, value, className) {
  const node = document.createElement(tag)
  if (value != null) node.textContent = value
  if (className) node.className = className
  return node
}
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ sort: state.sort, direction: state.direction, preset: state.preset, visible: [...state.visible], widths: state.widths })) } catch { /* private browsing */ }
}
function message(value) { text(dom.message, value) }
async function post(path, payload) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hps-token': token }, body: JSON.stringify(payload) })
  const result = await response.json()
  if (!response.ok || result.error) throw new Error(result.error || 'Request failed. Refresh and try again.')
  return result
}
const actionWidth = () => innerWidth <= 620 ? 100 : 154
window.addEventListener('resize', resizeColumns)
const activeColumns = () => {
  const ordered = PRESETS[state.preset]
  return ordered ? ordered.map(key => COLUMNS.find(c => c.key === key))
    : COLUMNS.filter(c => c.required || state.visible.has(c.key))
}
function resizeColumns() {
  for (const col of dom.colgroup.children) col.style.width = (col.dataset.key === 'close' ? actionWidth() : state.widths[col.dataset.key]) + 'px'
  for (const header of dom.head.querySelectorAll('th')) header.querySelector('.resize')?.setAttribute('aria-valuenow', String(state.widths[header.dataset.key]))
  dom.table.style.width = activeColumns().reduce((sum, c) => sum + state.widths[c.key], actionWidth()) + 'px'
}
function buildColumns() {
  dom.colgroup.replaceChildren(); dom.head.replaceChildren(); state.nodes.clear(); dom.body.replaceChildren()
  const tr = element('tr')
  for (const col of activeColumns()) {
    const width = element('col'); width.dataset.key = col.key; dom.colgroup.append(width)
    const th = element('th', null, col.numeric ? 'numeric' : ''); th.scope = 'col'; th.dataset.key = col.key
    const sort = element('button', col.label); sort.type = 'button'; sort.title = col.help || 'Sort by ' + col.label
    sort.onclick = () => { state.direction = state.sort === col.key ? -state.direction : col.numeric ? -1 : 1; state.sort = col.key; persist(); render() }
    const grip = element('span', null, 'resize'); grip.tabIndex = 0; grip.role = 'separator'
    grip.setAttribute('aria-orientation', 'vertical'); grip.setAttribute('aria-label', 'Resize ' + col.label)
    grip.setAttribute('aria-valuemin', '64'); grip.setAttribute('aria-valuemax', '600')
    const change = value => { state.widths[col.key] = Math.max(64, Math.min(600, value)); resizeColumns() }
    grip.onpointerdown = event => {
      event.preventDefault(); const start = event.clientX, width = state.widths[col.key]
      grip.setPointerCapture(event.pointerId)
      grip.onpointermove = move => change(width + move.clientX - start)
      grip.onpointerup = grip.onpointercancel = () => { grip.onpointermove = null; persist() }
    }
    grip.onkeydown = event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); change(state.widths[col.key] + (event.key === 'ArrowLeft' ? -16 : 16)); persist() } }
    th.append(sort, grip); tr.append(th)
  }
  const closeWidth = element('col'); closeWidth.dataset.key = 'close'; dom.colgroup.append(closeWidth)
  const closeHeader = element('th', null, 'row-actions'); closeHeader.scope = 'col'
  closeHeader.append(element('span', 'Actions')); tr.append(closeHeader)
  dom.head.append(tr); resizeColumns(); render()
}
function columnMenu() {
  dom.columnOptions.replaceChildren()
  for (const group of ['Session', 'Resources', 'AI usage']) {
    dom.columnOptions.append(element('strong', group))
    for (const col of COLUMNS.filter(c => c.group === group && !c.required)) {
      const label = element('label'), check = element('input'); check.type = 'checkbox'; check.checked = state.visible.has(col.key)
      label.title = col.help || col.label
      check.onchange = () => { if (check.checked) state.visible.add(col.key); else state.visible.delete(col.key); state.preset = null; persist(); buildColumns() }
      label.append(check, document.createTextNode(col.label)); dom.columnOptions.append(label)
    }
  }
  const reset = element('button', 'Reset columns'); reset.onclick = () => setPreset('overview'); dom.columnOptions.append(reset)
}
function positionColumnMenu() {
  if (!dom.columns.open) return
  const anchor = dom.columns.querySelector('summary').getBoundingClientRect()
  const height = Math.min(innerHeight * .65, 500)
  const below = innerHeight - anchor.bottom - 14
  const top = below < 160 && anchor.top > below ? Math.max(8, anchor.top - height - 6) : anchor.bottom + 6
  dom.columnOptions.style.left = Math.max(8, Math.min(anchor.right - 230, innerWidth - 238)) + 'px'
  dom.columnOptions.style.top = top + 'px'
  dom.columnOptions.style.maxHeight = Math.max(0, Math.min(height, innerHeight - top - 8)) + 'px'
}
dom.columns.addEventListener('toggle', positionColumnMenu)
window.addEventListener('resize', positionColumnMenu)
function setPreset(preset) {
  state.preset = preset; state.visible = new Set(PRESETS[preset]);
  for (const col of COLUMNS) state.widths[col.key] = col.width
  if (preset === 'ai') { state.sort = 'tokens'; state.direction = -1 }
  else { state.sort = 'workspaceBytes'; state.direction = -1 }
  persist(); columnMenu(); buildColumns()
}
for (const button of document.querySelectorAll('[data-preset]')) button.onclick = () => setPreset(button.dataset.preset)
const iconNames = new Set(['codex', 'opencode', 'cursor', 'pi', 'hermes', 'commandcode', 'devin', 'muse', 'amp', 'kilo', 'grok', 'copilot', 'agy', 'claude'])
const engineNames = { codex: 'Codex', claude: 'Claude', opencode: 'OpenCode', cursor: 'Cursor', terminal: 'Terminal', pi: 'Pi', hermes: 'Hermes', copilot: 'Copilot', gemini: 'Gemini' }
function createRow(row) {
  const tr = element('tr'); tr.dataset.id = row.id
  tr.onclick = () => { state.selected = row.id; select(); dom.grid.focus({ preventScroll: true }) }
  tr.ondblclick = event => { if (!event.target.closest('button')) inspect(row.id) }
  for (const col of activeColumns()) {
    const td = element('td', null, col.numeric ? 'numeric' : ''); td.dataset.key = col.key
    if (col.key === 'name') td.append(element('strong'))
    if (col.key === 'activity') { const span = element('span', null, 'status'); span.append(element('span', null, 'mark'), element('span')); td.append(span) }
    if (col.key === 'engine') {
      const span = element('span', null, 'engine'), img = element('img'); img.alt = ''; img.hidden = true
      span.append(img, element('span')); td.append(span)
    }
    tr.append(td)
  }
  const actions = element('td', null, 'row-actions')
  for (const [verb, label] of [['stop', 'Stop'], ['delete', 'Delete']]) {
    const button = element('button', label, verb === 'stop' ? 'stop-harness' : 'danger')
    button.type = 'button'; button.dataset.action = verb
    button.onclick = event => { event.stopPropagation(); state.selected = row.id; select(); reviewAction(row.id, verb) }
    actions.append(button)
  }
  tr.append(actions)
  return tr
}
function updateRow(tr, row) {
  for (const td of tr.children) {
    const key = td.dataset.key, col = COLUMNS.find(c => c.key === key)
    if (td.classList.contains('row-actions')) {
      for (const button of td.children) {
        const deleting = button.dataset.action === 'delete'
        button.disabled = !(deleting ? canDelete(row) : canStop(row))
        button.setAttribute('aria-label', (deleting ? 'Delete: ' : 'Stop: ') + row.name)
        button.title = state.busy.has(row.id) ? 'Please wait…' : state.frozen ? 'Turn on live updates before acting.'
          : !state.connected || !currentSnapshot() ? 'Reconnect before acting.'
          : row.unavailable || (deleting ? 'Choose session data, worktree data, or both. Review sizes and full paths before deletion.' : 'Stop running work. History and files are kept.')
        button.setAttribute('aria-busy', String(state.busy.has(row.id)))
      }
    } else if (key === 'name') {
      text(td.children[0], row.name)
      td.title = [row.name, row.home, row.model].filter(Boolean).join('\n')
    } else if (key === 'activity') {
      const [mark, label] = ACTIVITY[row.activity] || ACTIVITY.unknown
      td.firstChild.className = 'status ' + row.activity; text(td.firstChild.children[0], mark); text(td.firstChild.children[1], label)
      td.title = row.activityKnown || ['offline', 'starting', 'failed'].includes(row.activity) ? label : 'The owning daemon has not reported activity.'
    } else if (key === 'engine') {
      const img = td.firstChild.children[0], icon = iconNames.has(row.engine) ? row.engine : null
      img.hidden = !icon; img.className = ['cursor', 'opencode', 'grok', 'copilot'].includes(icon) ? 'dark-tile' : ''
      if (icon && img.getAttribute('src') !== 'icons/' + icon + '.png') img.src = 'icons/' + icon + '.png'
      text(td.firstChild.children[1], engineNames[row.engine] || row.engine || '—')
    } else {
      text(td, formatValue(key, row[key]))
      td.classList.toggle('unknown', row[key] == null)
      td.title = row[key] == null ? (col.help || col.label) + '\nThis reading is unavailable.'
        : ['lastActivity', 'createdAt'].includes(key) ? new Date(row[key]).toLocaleString()
        : col.numeric ? Number(row[key]).toLocaleString() + '\n' + (col.help || col.label) : String(row[key])
    }
  }
}
const currentSelection = () => state.shown.find(r => r.id === state.selected)
const currentSnapshot = () => ['ok', 'degraded'].includes(state.snapshot?.status)
const canStop = row => row?.canStop && isLive(row) && state.connected && currentSnapshot() && !state.frozen && !state.busy.has(row.id)
const canDelete = row => row?.canDelete && row.online !== false && state.connected && currentSnapshot() && !state.frozen && !state.busy.has(row.id)
function select() {
  for (const [id, node] of state.nodes) node.setAttribute('aria-selected', String(id === state.selected))
  dom.inspect.disabled = !currentSelection()
}
const totalText = (total, formatter) => total.value == null ? '—' : (total.partial ? '≥' : '') + formatter(total.value)
function summary() {
  const rows = state.shown
  const shared = (state.snapshot?.shared ?? []).filter(s => s.online && rows.some(r => r.machineId === s.machineId && s.agentIds.includes(r.agentId)))
  const resources = [...rows, ...shared]
  dom.summary.replaceChildren()
  for (const [label, total, format, hint] of [
    ['Workspace', storageTotal(rows), bytes, 'Disk space used by working folders. Shared and nested folders count once per machine. Delete lets you review worktree cleanup separately from session data.'],
    ['Session data', sumReading(rows, 'sessionBytes'), bytes, 'Conversation history and checkpoints. Shared database content is approximate; project and worktree files are excluded.'],
    ['RAM', sumReading(resources, 'rssBytes'), memory, 'Resident memory including child processes and shared servers once. Shared memory pages can overlap.'],
    ['CPU', sumReading(resources, 'cpu'), n => Math.round(n) + '%', '100% is one core. Shared servers count once.'],
    ['GPU', sumReading(resources, 'gpuPercent'), n => Math.round(n) + '%', 'Harness process GPU use on supported macOS and Linux NVIDIA drivers. First samples and unavailable counters show —. Cloud model GPU usage is not reported.'],
    ['Tokens', sumReading(rows, 'tokens'), number, 'Conversation totals for shown sessions. Cached input is included once.'],
  ]) {
    const item = element('div', null, 'total'); item.title = hint + ' ≥ means a partial total.'
    item.append(element('span', label), element('strong', totalText(total, format))); dom.summary.append(item)
  }
  const scope = element('p', `${(!state.connected || !currentSnapshot()) && !state.frozen ? 'Last harness readings' : 'Shown harnesses only'} · ≥ partial · — unavailable`, 'summary-scope'); dom.summary.append(scope)
  dom.shared.hidden = !shared.length; text(dom.sharedTitle, shared.length + ' shared ' + (shared.length === 1 ? 'server' : 'servers') + ' included once')
  dom.sharedBody.replaceChildren()
  for (const server of shared) {
    const row = element('div', null, 'shared-row')
    row.append(element('strong', server.name), element('span', server.machine), element('span', `${server.agentIds.length} sessions`),
      element('span', formatValue('cpu', server.cpu) + ' CPU'), element('span', memory(server.rssBytes) + ' RAM'))
    dom.sharedBody.append(row)
  }
}
function render() {
  const { scrollTop, scrollLeft } = dom.grid
  state.shown = visibleRows(state.rows, state)
  const ids = new Set(state.shown.map(r => r.id))
  for (const [id, node] of state.nodes) if (!ids.has(id)) { node.remove(); state.nodes.delete(id) }
  if (state.selected && !ids.has(state.selected)) state.selected = null
  let at = dom.body.firstChild
  for (const row of state.shown) {
    let node = state.nodes.get(row.id)
    if (!node) { node = createRow(row); state.nodes.set(row.id, node) }
    updateRow(node, row); if (at !== node) dom.body.insertBefore(node, at); at = node.nextSibling
  }
  select(); dom.grid.scrollTop = scrollTop; dom.grid.scrollLeft = scrollLeft
  for (const th of dom.head.querySelectorAll('th')) {
    const col = COLUMNS.find(c => c.key === th.dataset.key)
    if (!col) continue
    th.setAttribute('aria-sort', state.sort === col.key ? (state.direction === 1 ? 'ascending' : 'descending') : 'none')
    text(th.firstChild, col.label + (state.sort === col.key ? (state.direction === 1 ? ' ↑' : ' ↓') : ''))
  }
  for (const button of document.querySelectorAll('[data-preset]')) button.setAttribute('aria-pressed', String(button.dataset.preset === state.preset))
  const ready = state.snapshot && state.snapshot.status !== 'starting'
  dom.empty.hidden = state.shown.length > 0
  const filtered = state.query || state.machine !== 'all' || state.filter !== 'all'
  text(dom.empty.firstElementChild, !ready ? 'Connecting to your machines…' : filtered ? 'No matching harnesses' : 'No open harnesses')
  text(dom.empty.lastElementChild, !ready ? 'Open harnesses will appear here.' : filtered ? 'Try another search, machine, or status.' : 'Harnesses appear here while they are open, including when idle.')
  const active = state.rows.filter(isLive).length
  text(dom.count, state.filter === 'stopped' ? `${state.shown.length} stopped harnesses` : `${filtered ? state.shown.length + ' of ' : ''}${active} open ${active === 1 ? 'harness' : 'harnesses'}`)
  text(dom.updated, state.frozen ? 'Updates frozen' : state.receivedAt ? 'Updated ' + age(state.receivedAt) : 'Connecting…')
  text(dom.live, state.frozen ? 'Frozen' : !state.connected ? 'Reconnecting' : state.snapshot?.status === 'starting' ? 'Connecting' : !currentSnapshot() ? 'Unavailable' : 'Live')
  dom.live.classList.toggle('inactive', state.frozen || !state.connected || !currentSnapshot())
  if (ready) summary()
  if (dom.inspector.open) renderInspector()
}
function inspect(id) {
  const row = state.rows.find(r => r.id === id); if (!row) return
  state.inspecting = id
  const inspection = { identity: workspaceIdentity(row), loading: true }
  state.workspaceInspection = inspection
  renderInspector(); dom.inspector.showModal()
  void loadWorkspace(row, inspection)
}
const workspaceIdentity = row => JSON.stringify([row?.id, row?.sessionId, row?.createdAt, row?.cwd])
async function loadWorkspace(row, inspection) {
  try {
    const reply = await post('/api/act', { verb: 'workspace-inspect', ids: [row.id], manual: true, expected: [row] })
    const result = reply.results?.find(r => r.id === row.id)
    if (!result?.ok || !result.workspace) throw new Error(result?.detail || 'Workspace details are unavailable.')
    inspection.workspace = result.workspace
  } catch (error) { inspection.error = error.message }
  finally {
    inspection.loading = false
    if (state.workspaceInspection === inspection && dom.inspector.open) renderInspector()
  }
}
function workspaceSection(row, inspection) {
  const workspace = inspection?.workspace
  const section = element('section', null, 'inspect-section workspace-location')
  section.append(element('h3', 'Workspace'))
  const dl = element('dl')
  const add = (label, value, path = false) => {
    const dd = element('dd'), content = element(path ? 'code' : 'span', value || 'Unavailable')
    dd.append(content)
    if (path && value) {
      const copy = element('button', 'Copy'); copy.type = 'button'; copy.setAttribute('aria-label', 'Copy ' + label.toLowerCase())
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(value); text(copy, 'Copied') }
        catch { text(copy, 'Select path to copy') }
      }
      dd.append(copy)
    }
    dl.append(element('dt', label), dd)
  }
  add('Type', inspection?.loading ? 'Checking…' : ({ main: 'Main checkout', worktree: 'Git worktree', folder: 'Folder', unavailable: 'Unverified' }[workspace?.kind] || 'Unverified'))
  add('Working folder', workspace?.path || row.cwd || row.workspacePath, true)
  if (workspace?.worktreePath) add('Worktree path', workspace.worktreePath, true)
  if (workspace?.mainPath) add('Main project', workspace.mainPath, true)
  if (workspace?.kind === 'main') add('Worktree', 'None — this harness uses the main project directly.')
  section.append(dl, element('p', inspection?.loading ? 'Checking the folder on ' + row.machine + '…'
    : workspace?.reason || inspection?.error || 'The workspace changed. Reopen Inspect to check it again.', 'muted workspace-note'))
  return section
}
function renderInspector() {
  const row = state.rows.find(r => r.id === state.inspecting)
  const inspection = state.workspaceInspection?.identity === workspaceIdentity(row) ? state.workspaceInspection : null
  dom.inspectStop.disabled = !canStop(row)
  dom.inspectDelete.disabled = !canDelete(row)
  if (!row) { text(dom.inspectContext, 'This harness is no longer open.'); return }
  text(dom.inspectTitle, row.name)
  text(dom.inspectContext, [engineNames[row.engine] || row.engine, row.machine, ACTIVITY[row.activity]?.[1]].filter(Boolean).join(' · '))
  dom.inspectContent.replaceChildren()
  dom.inspectContent.append(workspaceSection(row, inspection))
  for (const group of ['Resources', 'AI usage', 'Session']) {
    const section = element('section', null, 'inspect-section'); section.append(element('h3', group)); const dl = element('dl')
    for (const col of COLUMNS.filter(c => c.group === group && !['name', 'activity', 'engine', 'machine', 'home'].includes(c.key))) {
      const label = element('dt', col.label), value = element('dd', formatValue(col.key, row[col.key])); label.title = col.help || col.label
      dl.append(label, value)
    }
    section.append(dl); dom.inspectContent.append(section)
  }
  const processes = element('section', null, 'inspect-section processes'); processes.append(element('h3', 'Process tree'))
  processes.append(element('p', 'Owned processes and children; nested harnesses and shared servers are counted separately.'))
  if (!row.processes?.length) processes.append(element('p', 'Process details are unavailable on this machine.', 'muted'))
  else {
    const table = element('table'), head = element('tr')
    for (const title of ['PID', 'Parent PID', 'CPU', 'RAM']) head.append(element('th', title))
    const tbody = element('tbody'); table.append(head, tbody)
    for (const process of row.processes) {
      const tr = element('tr')
      for (const value of [process.pid, process.parent, formatValue('cpu', process.cpuPercent), memory(process.memoryBytes)]) tr.append(element('td', value))
      tbody.append(tr)
    }
    processes.append(table)
    if (row.processCount > row.processes.length) processes.append(element('p', `Showing ${row.processes.length} of ${row.processCount} processes.`, 'muted'))
  }
  dom.inspectContent.append(processes)
  const notes = element('p', 'Session data is conversation history and checkpoints. Workspace is the project or worktree folder. Delete lets you choose session data, worktree data, or both, with a size and path review. The main project folder is protected. Missing readings are unavailable, not zero.', 'muted metric-note')
  dom.inspectContent.append(notes)
}
async function reviewAction(id, verb = 'stop') {
  const row = state.rows.find(r => r.id === id), deleting = verb === 'delete'
  if (!(deleting ? canDelete(row) : canStop(row))) return
  const review = { id: row.id, sessionId: row.sessionId, createdAt: row.createdAt, lastActivity: row.lastActivity, name: row.name, verb }
  state.review = review
  text(dom.stopTitle, (deleting ? 'Delete' : 'Stop') + ' “' + row.name + '”?')
  text(dom.stopContext, `${row.machine} · ${ACTIVITY[row.activity]?.[1] || 'Unknown'}`)
  text(dom.stopDescription, deleting ? 'Choose the data to permanently delete. Running work will stop. This cannot be undone.'
    : 'Its running work will end and its panes will close. Conversation history and project files are kept.')
  text(dom.stopStorage, '')
  text(dom.stopConfirm, deleting ? 'Delete' : 'Stop')
  text(dom.stopResult, deleting ? 'Checking data sizes, paths and worktree protection…' : '')
  dom.deleteChoices.hidden = true; dom.worktreeDiscard.checked = false; dom.worktreeDiscard.disabled = false
  for (const check of [dom.deleteSession, dom.deleteWorktree]) { check.checked = false; check.disabled = true }
  dom.worktreeChanges.hidden = true; dom.worktreeDiscardLabel.hidden = true
  dom.stopConfirm.disabled = deleting; dom.stopCancel.disabled = false
  dom.stopDialog.showModal()
  if (!deleting) return
  try {
    const reply = await post('/api/act', { verb: 'delete-review', ids: [review.id], manual: true, expected: [review] })
    if (state.review !== review || !dom.stopDialog.open) return
    const result = reply.results?.find(r => r.id === review.id)
    if (!result?.ok || !result.reviewId || !result.choices) throw new Error(result?.detail || 'Could not check the data. Update Harness on the owning machine and try again.')
    review.reviewId = result.reviewId; review.choices = result.choices
    const session = review.choices.sessionData, worktree = review.choices.worktreeData
    dom.deleteSession.disabled = !session.available; dom.deleteSession.checked = session.available
    dom.deleteWorktree.disabled = !worktree.available; dom.deleteWorktree.checked = worktree.available
    text(dom.deleteSessionSize, bytes(session.bytes)); text(dom.deleteWorktreeSize, bytes(worktree.bytes))
    dom.deleteSessionPaths.replaceChildren(...(session.paths || []).map(path => element('code', path)))
    if (!session.paths?.length) dom.deleteSessionPaths.append(element('span', session.available ? 'No saved session files.' : 'Path unavailable.'))
    dom.deleteWorktreePath.replaceChildren(element('code', worktree.path || 'Path unavailable.'))
    text(dom.deleteSessionNote, session.reason || (session.sharedStore
      ? 'Only this conversation and its checkpoints are deleted. Shared database space can be reused; the file may not shrink immediately.'
      : 'Conversation history and saved checkpoints. Project files are kept.'))
    text(dom.deleteWorktreeNote, worktree.reason || `Removes this entire folder, including dependencies and build output. Main project kept: ${worktree.mainPath}. Branch kept: ${worktree.branch || 'commits saved on a branch'}.`)
    text(dom.worktreeChanges, (worktree.changes || []).join('\n'))
    dom.deleteChoices.hidden = false
    text(dom.stopResult, 'Sizes are approximate and may change as running work stops.')
    validateDeleteConfirmation()
  } catch (error) { if (state.review === review && dom.stopDialog.open) text(dom.stopResult, error.message) }
}
dom.inspect.onclick = () => inspect(state.selected)
dom.inspectStop.onclick = () => reviewAction(state.inspecting)
dom.inspectDelete.onclick = () => reviewAction(state.inspecting, 'delete')
function selectedChoices() {
  return { sessionData: !dom.deleteSession.disabled && dom.deleteSession.checked,
    worktreeData: !dom.deleteWorktree.disabled && dom.deleteWorktree.checked }
}
function validateDeleteConfirmation() {
  const review = state.review
  if (review?.verb !== 'delete') return
  const choices = selectedChoices(), dirty = choices.worktreeData && review.choices?.worktreeData?.dirty
  dom.worktreeChanges.hidden = !dirty; dom.worktreeDiscardLabel.hidden = !dirty
  dom.stopConfirm.disabled = !review.reviewId || review.consumed || state.busy.has(review.id)
    || (!choices.sessionData && !choices.worktreeData) || (dirty && !dom.worktreeDiscard.checked)
}
dom.deleteSession.onchange = dom.deleteWorktree.onchange = dom.worktreeDiscard.onchange = validateDeleteConfirmation
dom.inspectClose.onclick = () => dom.inspector.close()
dom.stopCancel.onclick = () => { state.review = null; dom.stopDialog.close() }
dom.stopDialog.addEventListener('cancel', event => { if (state.busy.has(state.review?.id)) event.preventDefault(); else state.review = null })
dom.stopConfirm.onclick = async () => {
  const review = state.review
  if (!review || review.consumed || state.busy.has(review.id)) return
  const deleting = review.verb === 'delete', row = state.rows.find(r => r.id === review.id), choices = selectedChoices()
  if (deleting) { validateDeleteConfirmation(); if (dom.stopConfirm.disabled) return }
  if (!(deleting ? canDelete(row) : canStop(row)) || row.sessionId !== review.sessionId || row.createdAt !== review.createdAt || (deleting && !review.reviewId)) {
    text(dom.stopResult, 'This session or connection changed. Cancel, refresh and review it again.')
    dom.stopConfirm.disabled = true; return
  }
  review.consumed = true
  state.busy.add(review.id); dom.stopConfirm.disabled = true; dom.stopCancel.disabled = true
  for (const check of [dom.deleteSession, dom.deleteWorktree, dom.worktreeDiscard]) check.disabled = true
  text(dom.stopResult, deleting ? 'Stopping and deleting the selected data…' : 'Stopping…'); render()
  try {
    const reply = await post('/api/act', { verb: review.verb, ids: [review.id], manual: true, expected: [review], reviewId: review.reviewId,
      ...(deleting ? { choices, ...(choices.worktreeData ? { path: review.choices.worktreeData.path, discardChanges: dom.worktreeDiscard.checked } : {}) } : {}) })
    const result = reply.results?.find(r => r.id === review.id)
    if (!result?.ok) { text(dom.stopResult, result?.detail || 'The action was not confirmed. Refresh to check.'); return }
    if (deleting && result.sessionDeleted) state.rows = state.rows.filter(r => r.id !== review.id || r.sessionId !== review.sessionId)
    else {
      const stopped = state.rows.find(r => r.id === review.id)
      if (stopped) Object.assign(stopped, { state: 'stopped', activity: 'stopped', live: false, canStop: false, ...(result.worktreeDeleted ? { workspaceBytes: null } : {}) })
    }
    message(!deleting ? 'Stopped ' + review.name + '. History and files kept.'
      : result.sessionDeleted && result.worktreeDeleted ? 'Session and worktree data deleted. Main project and branch kept.'
      : result.worktreeDeleted ? 'Worktree data deleted. Conversation, main project and branch kept.'
      : 'Session data deleted. Project and worktree files kept.')
    state.review = null; dom.stopDialog.close()
    if (dom.inspector.open && state.inspecting === review.id) dom.inspector.close()
    dom.grid.focus({ preventScroll: true })
  } catch (error) { text(dom.stopResult, error.message + ' Refresh to check before trying again.') }
  finally { state.busy.delete(review.id); dom.stopCancel.disabled = false; render() }
}
dom.search.oninput = () => { state.query = dom.search.value; render() }
dom.filter.onchange = () => { state.filter = dom.filter.value; render() }
dom.machine.onchange = () => { state.machine = dom.machine.value; render() }
dom.grid.onkeydown = event => {
  if (event.target.closest('button') || event.target.classList.contains('resize')) return
  if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); const index = state.shown.findIndex(r => r.id === state.selected)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? state.shown.length - 1 : Math.max(0, Math.min(state.shown.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)))
    state.selected = state.shown[next]?.id ?? null; select(); state.nodes.get(state.selected)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  } else if (event.key === 'Enter' && state.selected) { event.preventDefault(); inspect(state.selected) }
  else if (['Delete', 'Backspace'].includes(event.key) && state.selected) { event.preventDefault(); reviewAction(state.selected, 'delete') }
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && dom.columns.open) { dom.columns.open = false; dom.columns.querySelector('summary').focus() }
  if ((event.key === '/' || ((event.metaKey || event.ctrlKey) && event.key === 'f')) && !document.querySelector('dialog[open]') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) { event.preventDefault(); dom.search.focus() }
})
document.addEventListener('pointerdown', event => { if (!dom.columns.contains(event.target)) dom.columns.open = false })
dom.refresh.onclick = async () => {
  dom.refresh.disabled = true
  try { await post('/api/refresh', {}); message(state.frozen ? 'New readings ready. Live updates to display them.' : '') } catch (error) { message(error.message) }
  finally { dom.refresh.disabled = false }
}
dom.freeze.onclick = () => {
  state.frozen = !state.frozen; text(dom.freeze, state.frozen ? 'Live updates' : 'Freeze updates'); dom.freeze.setAttribute('aria-pressed', String(state.frozen))
  if (!state.frozen && state.pending) { applySnapshot(state.pending); state.pending = null }
  render()
}
function applySnapshot(snapshot) {
  state.snapshot = snapshot; state.rows = (snapshot.rows ?? []).filter(row => row.online !== false); state.receivedAt = Date.now()
  const machines = new Map((snapshot.machines ?? []).map(m => [m.machineId, m.name]))
  for (const row of state.rows) machines.set(row.machineId, row.machine)
  const signature = JSON.stringify([...machines])
  if (dom.machine.dataset.signature !== signature) {
    dom.machine.dataset.signature = signature; dom.machine.replaceChildren(new Option('All machines', 'all'))
    for (const [id, name] of machines) dom.machine.append(new Option(name, id))
    if (!machines.has(state.machine)) state.machine = 'all'
    dom.machine.value = state.machine
  }
  dom.problems.hidden = !snapshot.problems?.length
  text(dom.problems, (snapshot.problems ?? []).map(p => p.machine + ': ' + String(p.error ?? 'Unavailable').replace('Offline — showing the last known sessions.', 'Offline — reconnect to view open harnesses.')).join(' · '))
  render()
}
let stream
function connect() {
  if (stream || document.hidden) return
  stream = new EventSource('/events')
  stream.addEventListener('snapshot', event => {
    try {
      const snapshot = JSON.parse(event.data); state.connected = true
      if (dom.message.textContent.startsWith('Readings are stale.')) message('')
      if (state.frozen) state.pending = snapshot; else applySnapshot(snapshot)
    } catch { message('Could not read the monitor update. Refresh and try again.') }
  })
  stream.onerror = () => { state.connected = false; message('Connection interrupted. Showing last readings; reconnecting…'); render() }
  stream.onopen = () => { if (dom.message.textContent.startsWith('Connection interrupted.')) message('') }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) { stream?.close(); stream = null; state.connected = false } else connect() })
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
setInterval(() => {
  if (document.hidden || reducedMotion.matches || state.frozen || !state.connected) return
  const mark = SPINNER[Math.floor(Date.now() / 100) % SPINNER.length]
  for (const node of dom.body.querySelectorAll('.working .mark')) text(node, mark)
}, 100)
setInterval(() => {
  if (document.hidden || state.frozen || !state.receivedAt) return
  if (state.connected && Date.now() - state.receivedAt > 45_000) {
    state.connected = false; message('Readings are stale. Showing the last update; refresh to reconnect.')
  }
  render()
}, 10_000)
columnMenu(); buildColumns(); connect()
