/**
 * The Memories pane. One job: browse what your agents remember, beside how you actually work.
 *
 * The prompt is always focused, as in fzf: type to filter, ↑↓ to move, → or ⏎ to open, ← to go back,
 * esc to clear. Everything a memory says is rendered as text (markdown.js); nothing in this file ever
 * assigns HTML.
 */

import { parse, render } from './markdown.js'
import { scoreFields } from './fuzzy.js'
import { buildGrid } from './heatmap.js'

const $ = (id) => document.getElementById(id)
const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

const state = {
  snap: null,
  query: '',
  closed: new Set(),
  expanded: new Set(),
  selected: null,
  rows: [],
  hits: { q: '', items: [], error: null },
  related: new Map(),
  known: null,
  fresh: new Map(),
}

// ── helpers ────────────────────────────────────────────────────────────────────────────────────

const FALLBACK = { amp: '#c9a227', kilo: '#5fb3b3', devin: '#6aa6f8', muse: '#c77dff', agy: '#8bd3a0', commandcode: '#d4a5a5' }
function agent(id) {
  const known = state.snap?.agents.find((row) => row.id === id)
  if (known) return known
  return { id, name: id ? id[0].toUpperCase() + id.slice(1) : 'Unknown', color: FALLBACK[id] ?? '#8a8f98' }
}

const number = (n) => Number(n ?? 0).toLocaleString()
function age(at, now = Date.now()) {
  if (!at) return ''
  const minutes = Math.max(0, (now - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${Math.round(minutes)}m`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`
  if (minutes < 14 * 1440) return `${Math.round(minutes / 1440)}d`
  if (minutes < 120 * 1440) return `${Math.round(minutes / 10080)}w`
  return new Date(at).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
}
const longAge = (at) => {
  const short = age(at)
  if (!short) return ''
  if (short === 'now') return 'just now'
  const unit = { m: 'minutes', h: 'hours', d: 'days', w: 'weeks' }[short.at(-1)]
  return unit ? `${short.slice(0, -1)} ${unit} ago` : short
}
const kindLabel = (row) => row.type && row.type !== row.kind ? row.type : row.kind
/** More than one machine answered: rows then say which machine they live on. */
const manyMachines = () => (state.snap?.machines ?? []).filter((machine) => machine.ok).length > 1
const where = (memory) => (manyMachines() && memory.machine ? memory.machine.name : null)

const short = (id) => agent(id).name.split(' ')[0].toLowerCase()

function who(id, tag = 'span', name = agent(id).name) {
  const info = agent(id)
  const node = el(tag, 'who', name)
  node.style.color = info.color
  return node
}

// ── the switch: About You in every agent ───────────────────────────────────────────────────────

const token = document.querySelector('meta[name="memories-token"]')?.content ?? ''
let switching = false
let switchError = null

function drawSwitch() {
  const snap = state.snap
  const box = $('switch')
  if (!snap) { box.hidden = true; return }
  box.hidden = false
  const delivery = snap.delivery ?? {}
  const button = $('switch-button')
  const detail = $('switch-detail')
  const on = Boolean(delivery.on)
  button.setAttribute('aria-checked', String(on))
  $('switch-word').textContent = switching ? '…' : on ? 'ON' : 'OFF'
  button.disabled = switching || !delivery.built
  // One row: the switch and, beside it, only what explains its state. Which agents get it and what it
  // costs are in About You's own panel; machines that need an update are in the machines list.
  const machines = (snap.machines ?? [])
  const names = (delivery.agents ?? []).filter((row) => row.delivered).map((row) => agent(row.agent).name)
  const onMachines = 1 + machines.filter((machine) => !machine.current && machine.ok && machine.deliveryOn).length
  detail.textContent = !delivery.built ? 'not built yet' : !on && delivery.choseOff && delivery.choiceAt > 2 ? `off since ${since(delivery.choiceAt)}` : ''
  button.title = !delivery.built ? 'Ask the agent on the right: build my About You.'
    : on ? `Every new ${names.join(', ') || 'agent'} session starts with About You (~${number(delivery.tokens)} tokens), on ${onMachines} ${onMachines === 1 ? 'machine' : 'machines'}.`
      : 'New sessions start without About You.'
  const failed = (delivery.agents ?? []).filter((row) => row.error).map((row) => `${agent(row.agent).name}: ${row.error}`)
  const problem = $('switch-problem')
  problem.textContent = [switchError, ...failed].filter(Boolean).join(' · ')
  problem.hidden = !problem.textContent
}

/** When a choice was made, the way a person says it: a time today, else a date. */
function since(at) {
  const date = new Date(at)
  const today = new Date().toDateString() === date.toDateString()
  return today ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

$('switch-button').addEventListener('click', async () => {
  if (switching || !state.snap?.delivery?.built) return
  const on = !state.snap.delivery.on
  switching = true
  drawSwitch()
  try {
    const answer = await (await fetch('/api/deliver', { method: 'POST', headers: { 'content-type': 'application/json', 'x-memories-token': token }, body: JSON.stringify({ on }) })).json()
    const failed = [...(answer.results ?? []).filter((row) => !row.ok).map((row) => `${agent(row.agent).name}: ${row.error}`), ...(answer.failed ?? []).map((row) => `${row.name}: ${row.error}`)]
    switchError = answer.error ?? (failed.length ? failed.join('; ') : null)
  } catch { switchError = 'The switch did not answer. Try again.' }
  switching = false
  drawSwitch()
  $('q').focus()
})

// ── the band: your year with agents ────────────────────────────────────────────────────────────

function drawBand() {
  const sessions = state.snap?.sessions
  const band = $('band')
  if (!sessions || !sessions.asks) { band.hidden = true; return }
  band.hidden = false

  const width = band.clientWidth - 28
  const statsWidth = width > 760 ? 300 : 0
  const fit = Math.floor((width - statsWidth - 30) / 12)
  const span = sessions.firstAt ? Math.ceil((Date.now() - sessions.firstAt) / (7 * 86_400_000)) + 2 : 26
  const weeks = Math.max(12, Math.min(53, fit, Math.max(span, 20)))
  const grid = buildGrid(sessions.activity, { weeks })

  const svg = $('heat')
  const ns = 'http://www.w3.org/2000/svg'
  svg.replaceChildren()
  const size = 10, gap = 2, left = 22, top = 14
  svg.setAttribute('width', String(left + weeks * (size + gap)))
  svg.setAttribute('height', String(top + 7 * (size + gap)))
  const label = (x, y, text) => { const t = document.createElementNS(ns, 'text'); t.setAttribute('x', String(x)); t.setAttribute('y', String(y)); t.textContent = text; svg.append(t) }
  label(0, top + 1 * (size + gap) + 8, 'tue')
  label(0, top + 3 * (size + gap) + 8, 'thu')
  label(0, top + 5 * (size + gap) + 8, 'sat')
  let lastMonth = null
  const today = new Date().toDateString()
  grid.columns.forEach((column, week) => {
    const first = column.find(Boolean)
    if (first) {
      const month = new Date(first.at).getMonth()
      if (month !== lastMonth && new Date(first.at).getDate() <= 7) label(left + week * (size + gap), 9, new Date(first.at).toLocaleDateString(undefined, { month: 'short' }).toLowerCase())
      if (lastMonth === null || new Date(first.at).getDate() <= 7) lastMonth = month
    }
    column.forEach((day, d) => {
      if (!day) return
      const rect = document.createElementNS(ns, 'rect')
      rect.setAttribute('x', String(left + week * (size + gap)))
      rect.setAttribute('y', String(top + d * (size + gap)))
      rect.setAttribute('width', String(size)); rect.setAttribute('height', String(size)); rect.setAttribute('rx', '1.5')
      if (day.total > 0) {
        rect.setAttribute('fill', agent(day.top).color)
        rect.setAttribute('fill-opacity', String([0, 0.32, 0.55, 0.78, 1][day.level]))
      } else rect.setAttribute('class', 'cell')
      if (new Date(day.at).toDateString() === today) rect.classList.add('today')
      const title = document.createElementNS(ns, 'title')
      const parts = Object.entries(day.agents).sort((a, b) => b[1] - a[1]).map(([engine, n]) => `${agent(engine).name} ${number(n)}`)
      title.textContent = `${new Date(day.at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${day.total ? `${number(day.total)} messages — ${parts.join(', ')}` : 'no messages'}`
      rect.append(title)
      svg.append(rect)
    })
  })
  const notes = []
  if (grid.max.total) notes.push(`busiest ${new Date(grid.max.day + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} (${number(grid.max.total)})`)
  notes.push(`${grid.activeDays} active days`)
  if (grid.streak > 1) notes.push(`${grid.streak}-day streak`)
  $('heat-note').textContent = notes.join(' · ')

  $('stat-asks').textContent = number(sessions.asks)
  const agents = sessions.engines.filter((row) => row.asks > 0)
  const since = sessions.firstAt ? new Date(sessions.firstAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''
  const answered = (state.snap.machines ?? []).filter((machine) => machine.ok).length
  $('stat-line').textContent = `${number(sessions.sessions)} sessions · ${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}${answered > 1 ? ` · ${answered} machines` : ''}${since ? ` · since ${since}` : ''}`
  const bar = $('bar'), legend = $('legend')
  bar.replaceChildren(); legend.replaceChildren()
  for (const row of agents) {
    const share = row.asks / sessions.asks
    const piece = el('span'); piece.style.width = `${(share * 100).toFixed(2)}%`; piece.style.background = agent(row.engine).color
    piece.title = `${agent(row.engine).name}: ${number(row.asks)} messages`
    bar.append(piece)
    const item = el('span', null, `${agent(row.engine).name} `)
    item.style.setProperty('--swatch', agent(row.engine).color)
    item.append(el('b', null, share >= 0.01 ? `${Math.round(share * 100)}%` : '<1%'))
    legend.append(item)
  }
}

// ── rows: what the list shows ──────────────────────────────────────────────────────────────────

function memoryRow(memory, depth = 0, parent = null) {
  return { key: `m:${memory.id}${parent ? `@${parent}` : ''}`, type: 'memory', memory, depth, parent }
}

function buildRows() {
  const snap = state.snap
  if (!snap) return []
  const rows = []
  const memories = snap.memories
  const group = (id, label, count) => {
    rows.push({ key: `g:${id}`, type: 'group', id, label, count, open: !state.closed.has(id) })
    return !state.closed.has(id)
  }

  if (state.query.trim()) {
    const q = state.query
    const scored = []
    for (const memory of memories) {
      // Only the title is matched loosely (fzf-style); longer text must contain the words as typed, or a
      // short query matches nearly every description as a scattered subsequence.
      const score = scoreFields(q, [[memory.title, 3], [memory.description, 2, true], [memory.project?.name, 1.5, true], [agent(memory.agent).name, 1, true], [memory.type, 1, true], [memory.body, 1, true]])
      if (score > 0) scored.push([score, memory])
    }
    for (const [n, line] of (snap.about?.lines ?? []).entries()) {
      const score = scoreFields(q, [[line.text, 3, true], [line.section, 1, true]])
      if (score > 0) scored.push([score + 50, { about: n, line }])
    }
    scored.sort((a, b) => b[0] - a[0])
    if (group('found', 'memories', scored.length)) {
      for (const [, item] of scored.slice(0, 300)) rows.push(item.line ? { key: `a:${item.about}`, type: 'about', line: item.line, index: item.about } : memoryRow(item))
      if (!scored.length) rows.push({ key: 'empty:found', type: 'empty', label: 'No memory says that.' })
    }
    const hits = state.hits.q === q.trim() ? state.hits.items : []
    if (group('sessions', 'in your sessions', hits.length)) {
      for (const hit of hits) rows.push({ key: `s:${hit.sessionId}`, type: 'session', hit })
      if (!hits.length) rows.push({ key: 'empty:sessions', type: 'empty', label: state.hits.q === q.trim() ? (state.hits.error ?? 'No conversation says that.') : 'Searching…' })
    }
    return rows
  }

  const yours = memories.filter((memory) => memory.kind === 'you')
  const aboutLines = snap.about?.lines ?? []
  if (group('about', 'about you', aboutLines.length + yours.length)) {
    if (aboutLines.length) {
      let section = null
      aboutLines.forEach((line, n) => {
        if (line.section !== section) { section = line.section; rows.push({ key: `h:${section}`, type: 'section', label: section }) }
        rows.push({ key: `a:${n}`, type: 'about', line, index: n })
      })
    } else rows.push({ key: 'build', type: 'build' })
    if (yours.length) {
      if (aboutLines.length) rows.push({ key: 'h:saved', type: 'section', label: 'Saved by your agents' })
      for (const memory of yours) rows.push(memoryRow(memory))
    }
  }

  if (group('projects', 'projects', snap.projects.length)) {
    for (const project of snap.projects) {
      const key = `p:${project.key}`
      const open = state.expanded.has(key)
      rows.push({ key, type: 'project', project, open })
      if (open) for (const id of project.memories) { const memory = memories.find((row) => row.id === id); if (memory) rows.push(memoryRow(memory, 1, key)) }
    }
    if (!snap.projects.length) rows.push({ key: 'empty:projects', type: 'empty', label: 'No agent has saved anything about a project yet.' })
  }

  const notes = memories.filter((memory) => ['note', 'summary', 'reference'].includes(memory.kind) && !memory.project)
  if (notes.length && group('notes', 'notes and summaries', notes.length)) for (const memory of notes) rows.push(memoryRow(memory))

  const told = memories.filter((memory) => memory.kind === 'instructions')
  if (told.length && group('told', 'what you told them', told.length)) for (const memory of told) rows.push(memoryRow(memory))

  const agents = snap.agents.filter((row) => row.present || row.memories || row.sessions)
  if (group('agents', 'agents', agents.length)) {
    for (const info of agents) {
      const key = `ag:${info.id}`
      const own = memories.filter((memory) => memory.agent === info.id && memory.kind !== 'instructions')
      const open = state.expanded.has(key)
      rows.push({ key, type: 'agent', agent: info, open, children: own.length })
      if (open) for (const memory of own) rows.push(memoryRow(memory, 1, key))
    }
  }
  return rows
}

const selectable = (row) => row && !['group', 'section', 'empty'].includes(row.type)

// ── the list ───────────────────────────────────────────────────────────────────────────────────

function drawList({ keepScroll = true } = {}) {
  const list = $('list')
  const scroll = list.scrollTop
  state.rows = buildRows()
  if (!state.rows.some((row) => row.key === state.selected && selectable(row))) {
    state.selected = state.rows.find(selectable)?.key ?? null
  }
  const now = Date.now()
  const fragment = document.createDocumentFragment()
  for (const row of state.rows) fragment.append(drawRow(row, now))
  list.replaceChildren(fragment)
  if (!state.rows.length) list.append(el('div', 'empty-list', 'Reading your agents…'))
  if (keepScroll) list.scrollTop = scroll
  const total = state.snap ? state.snap.memories.filter((row) => row.kind !== 'instructions').length : 0
  const shown = state.query.trim() ? state.rows.filter((row) => row.type === 'memory' || row.type === 'about').length : total
  $('count').textContent = state.snap ? (state.query.trim() ? `${shown}/${total}` : `${total}`) : ''
  revealSelected()
  drawPreview()
}

function drawRow(row, now) {
  if (row.type === 'group') {
    const node = el('div', 'group')
    node.append(el('span', 'fold', row.open ? '▾' : '▸'), el('span', null, row.label), el('span', 'n', row.count ? String(row.count) : ''))
    node.addEventListener('click', () => {
      const opening = state.closed.has(row.id)
      if (opening) state.closed.delete(row.id); else state.closed.add(row.id)
      drawList()
      // Opening a group puts the cursor on its first row, so the preview shows something at once.
      if (opening) {
        const index = state.rows.findIndex((r) => r.key === row.key)
        const next = state.rows.findIndex((r, i) => i > index && r.type === 'group')
        const first = state.rows.slice(index + 1, next < 0 ? undefined : next).find(selectable)
        if (first) select(first.key)
      }
    })
    return node
  }
  if (row.type === 'section') return el('div', 'section', row.label)
  if (row.type === 'empty') { const node = el('div', 'row muted'); node.append(el('span', 'gutter'), el('span', 'label', row.label)); return node }

  const node = el('div', `row${row.depth ? ` depth${row.depth}` : ''}`)
  node.setAttribute('role', 'option')
  node.dataset.key = row.key
  node.setAttribute('aria-selected', String(row.key === state.selected))
  const gutter = el('span', 'gutter', row.key === state.selected ? '▌' : '')
  const label = el('span', 'label')
  node.append(gutter)

  if (row.type === 'memory') {
    const memory = row.memory
    const dot = el('span', 'dot', '•'); dot.style.color = agent(memory.agent).color
    label.textContent = memory.title
    const tag = el('span', 'tag', [row.parent?.startsWith('ag:') ? kindLabel(memory) : short(memory.agent), where(memory)].filter(Boolean).join(' · '))
    node.append(dot, label, tag, el('span', 'age', age(memory.modified, now)))
    if (state.fresh.has(memory.id) && now - state.fresh.get(memory.id) < 6000) { node.classList.add('fresh'); node.style.setProperty('--glow', agent(memory.agent).color) }
  } else if (row.type === 'about') {
    node.append(el('span', 'dot', '✦'))
    label.textContent = row.line.text
    node.append(label, el('span', 'tag', row.line.refs.length ? `${row.line.refs.length} src` : ''))
  } else if (row.type === 'build') {
    node.classList.add('build')
    node.append(el('span', 'dot', '✦'))
    label.textContent = 'Build your About You'
    node.append(label, el('span', 'tag', 'ask the agent →'))
  } else if (row.type === 'project') {
    const project = row.project
    node.append(el('span', 'dot', row.open ? '▾' : '▸'))
    label.append(el('span', null, project.name), el('span', 'soft', `  ${project.memories.length} ${project.memories.length === 1 ? 'memory' : 'memories'}`))
    node.append(label, el('span', 'tag', project.sessions ? `${number(project.sessions)} ${project.sessions === 1 ? 'session' : 'sessions'}` : ''), el('span', 'age', age(project.lastAt, now)))
  } else if (row.type === 'agent') {
    const info = row.agent
    const dot = el('span', 'dot', row.children ? (row.open ? '▾' : '▸') : '•'); dot.style.color = info.color
    label.append(el('span', null, info.name), el('span', 'soft', info.memory === 'none' ? '  no memory' : `  ${info.memory}`))
    node.append(dot, label, el('span', 'tag', info.memories ? `${info.memories} saved` : ''), el('span', 'age', info.sessions ? String(info.sessions) : ''))
  } else if (row.type === 'session') {
    const hit = row.hit
    const dot = el('span', 'dot', '›'); dot.style.color = agent(hit.engine).color
    label.textContent = hit.title || hit.snippet.replace(/[\u0002\u0003]/g, '')
    node.append(dot, label, el('span', 'tag', short(hit.engine)), el('span', 'age', age(hit.at, now)))
  }
  node.addEventListener('mousedown', (event) => { event.preventDefault(); select(row.key); if (row.type === 'project' || row.type === 'agent') toggle(row) })
  return node
}

function revealSelected() {
  const node = $('list').querySelector(`[data-key="${CSS.escape(state.selected ?? '')}"]`)
  node?.scrollIntoView({ block: 'nearest' })
}

function select(key) {
  if (key === state.selected) return
  state.selected = key
  for (const node of $('list').querySelectorAll('.row[role="option"]')) {
    const on = node.dataset.key === key
    node.setAttribute('aria-selected', String(on))
    node.querySelector('.gutter').textContent = on ? '▌' : ''
  }
  revealSelected()
  drawPreview()
}

function move(delta) {
  const options = state.rows.filter(selectable)
  if (!options.length) return
  const at = options.findIndex((row) => row.key === state.selected)
  const next = delta === Infinity ? options.length - 1 : delta === -Infinity ? 0 : Math.max(0, Math.min(options.length - 1, (at < 0 ? 0 : at) + delta))
  select(options[next].key)
}

function current() { return state.rows.find((row) => row.key === state.selected) }

function toggle(row, open = !row.open) {
  if (row.type !== 'project' && row.type !== 'agent') return
  if (open) state.expanded.add(row.key); else state.expanded.delete(row.key)
  drawList()
}

function forward() {
  const row = current()
  if (!row) return
  if ((row.type === 'project' || row.type === 'agent') && !row.open && (row.type === 'project' || row.children)) { toggle(row, true); return }
  if ((row.type === 'project' || row.type === 'agent') && row.open) { const index = state.rows.indexOf(row); if (selectable(state.rows[index + 1])) select(state.rows[index + 1].key); return }
  document.body.classList.add('reading')
  $('preview').scrollTop = 0
}

function back() {
  if (document.body.classList.contains('reading')) { document.body.classList.remove('reading'); return }
  const row = current()
  if (!row) return
  if (row.parent) { select(row.parent); return }
  if ((row.type === 'project' || row.type === 'agent') && row.open) toggle(row, false)
}

// ── the preview ────────────────────────────────────────────────────────────────────────────────

function head(title, meta, path) {
  const box = el('div')
  box.append(el('h2', 'pv-title', title))
  if (meta) box.append(meta)
  if (path) box.append(el('div', 'pv-path', path))
  return box
}

function metaLine(parts) {
  const line = el('div', 'pv-meta')
  parts.filter(Boolean).forEach((part, n) => {
    if (n) line.append(document.createTextNode(' · '))
    line.append(typeof part === 'string' ? document.createTextNode(part) : part)
  })
  return line
}

function hitRow(hit, onClick) {
  const row = el('div', 'hit')
  row.append(who(hit.engine, 'span', short(hit.engine)), el('span', 'what', hit.title || hit.snippet.replace(/[\u0002\u0003]/g, '')), el('span', 'when', age(hit.at)))
  row.title = hit.cwd || ''
  if (onClick) row.addEventListener('click', onClick)
  return row
}

function snippet(text) {
  const node = el('div', 'snippet')
  let marked = false
  for (const part of String(text ?? '').split(/([\u0002\u0003])/)) {
    if (part === '\u0002') marked = true
    else if (part === '\u0003') marked = false
    else if (part) node.append(marked ? el('mark', null, part) : document.createTextNode(part))
  }
  return node
}

async function relatedFor(memory, box) {
  let found = state.related.get(memory.id)
  if (!found) {
    try { found = await (await fetch(`/api/related?id=${encodeURIComponent(memory.id)}`)).json() } catch { found = { hits: [] } }
    state.related.set(memory.id, found)
  }
  if (current()?.memory?.id !== memory.id) return
  box.replaceChildren()
  if (!found.hits?.length) return
  box.append(el('div', 'pv-h', 'in your sessions'))
  for (const hit of found.hits) { box.append(hitRow(hit)); box.append(snippet(hit.snippet)) }
}

function drawPreview() {
  const preview = $('preview')
  const row = current()
  preview.replaceChildren()
  if (!state.snap) { preview.append(el('div', 'pv-meta', 'Reading what your agents remember…')); return }
  if (!row) { (state.snap.memories.length || state.snap.about ? drawOverview : drawWelcome)(preview); return }

  if (row.type === 'memory') {
    const memory = row.memory
    const scope = memory.project ? memory.project.name : memory.scope === 'global' ? 'every project' : null
    preview.append(head(memory.title, metaLine([who(memory.agent), kindLabel(memory), scope, where(memory) ?? (memory.machine && !memory.machine.current ? memory.machine.name : null), longAge(memory.modified)]), memory.path))
    if (memory.description && memory.description !== memory.title && !memory.body.startsWith(memory.description)) preview.append(el('p', 'pv-big', memory.description))
    preview.append(el('hr', 'pv-rule'))
    preview.append(render(document, el('div', 'md'), parse(memory.body)))
    const related = el('div')
    preview.append(related)
    void relatedFor(memory, related)
    return
  }
  if (row.type === 'about') {
    const { line } = row
    preview.append(head('About you', metaLine([line.section, state.snap.about?.modified ? `built ${longAge(state.snap.about.modified)}` : null]), state.snap.aboutPath))
    preview.append(el('p', 'pv-big', line.text))
    preview.append(deliveryLine())
    if (line.refs.length) {
      preview.append(el('div', 'pv-h', 'where this comes from'))
      const chips = el('div', 'chips')
      for (const ref of line.refs) {
        const chip = el('button', 'chip', refLabel(ref))
        const target = refMemory(ref)
        if (target) chip.addEventListener('click', () => reveal(target))
        else chip.disabled = !ref.startsWith('session:')
        chips.append(chip)
      }
      preview.append(chips)
    }
    return
  }
  if (row.type === 'build') { drawBuild(preview); return }
  if (row.type === 'project') {
    const project = row.project
    preview.append(head(project.name, metaLine([`${project.memories.length} ${project.memories.length === 1 ? 'memory' : 'memories'}`, project.sessions ? `${number(project.sessions)} ${project.sessions === 1 ? 'session' : 'sessions'}` : null, project.lastAt ? `last worked ${longAge(project.lastAt)}` : null]), project.path))
    const engines = Object.entries(project.engines).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
    if (engines.length) {
      const total = engines.reduce((sum, [, n]) => sum + n, 0)
      const mini = el('div', 'mini')
      for (const [engine, n] of engines) { const piece = el('span'); piece.style.width = `${(n / total) * 100}%`; piece.style.background = agent(engine).color; mini.append(piece) }
      preview.append(el('div', 'pv-h', 'your messages here'), mini, metaLine(engines.map(([engine, n]) => { const node = who(engine); node.textContent = `${agent(engine).name} ${number(n)}`; return node })))
    }
    preview.append(el('div', 'pv-h', 'what your agents know'))
    for (const id of project.memories) {
      const memory = state.snap.memories.find((m) => m.id === id)
      if (!memory) continue
      const item = el('div', 'hit')
      item.append(who(memory.agent, 'span', short(memory.agent)), el('span', 'what', memory.title), el('span', 'when', kindLabel(memory)))
      item.addEventListener('click', () => { state.expanded.add(row.key); drawList(); select(`m:${memory.id}@${row.key}`) })
      preview.append(item)
    }
    return
  }
  if (row.type === 'agent') { drawAgent(preview, row.agent); return }
  if (row.type === 'session') {
    const hit = row.hit
    preview.append(head(hit.title || 'A conversation', metaLine([who(hit.engine), hit.cwd, longAge(hit.at)]), `session ${hit.sessionId}`))
    preview.append(el('hr', 'pv-rule'), snippet(hit.snippet))
  }
}

/** Show one memory in the list wherever it lives: clear the search, open its group, select its row. */
function reveal(memory) {
  state.query = ''; $('q').value = ''; state.hits = { q: '', items: [], error: null }
  let key = `m:${memory.id}`
  if (memory.kind === 'you') state.closed.delete('about')
  else if (memory.kind === 'instructions') state.closed.delete('told')
  else if (memory.project) {
    const project = state.snap.projects.find((entry) => entry.memories.includes(memory.id))
    if (project) { state.closed.delete('projects'); state.expanded.add(`p:${project.key}`); key = `m:${memory.id}@p:${project.key}` }
  } else state.closed.delete('notes')
  drawList()
  if (!state.rows.some((row) => row.key === key)) { state.closed.delete('agents'); state.expanded.add(`ag:${memory.agent}`); drawList(); key = `m:${memory.id}@ag:${memory.agent}` }
  select(key)
}

/** Which agents start every new session with About You, said in one line under it. */
function deliveryLine() {
  const delivery = state.snap.delivery
  const box = el('div', 'callout')
  const using = (delivery?.agents ?? []).filter((row) => row.delivered)
  if (delivery?.on && using.length) {
    const names = using.map((row) => agent(row.agent).name + (row.current ? '' : ' (older copy)'))
    box.append(el('div', null, `Every new session of ${names.join(', ')} starts with this.`))
    box.append(el('div', 'pv-meta', 'Sessions already open keep what they started with. Turn it off at the top any time.'))
  } else {
    box.append(el('div', null, 'Your agents do not use this. Turn on "About You in your agents" at the top.'))
  }
  return box
}

function refMemory(ref) {
  const at = ref.indexOf(':')
  if (at < 0) return null
  const who = ref.slice(0, at), file = ref.slice(at + 1)
  return state.snap.memories.find((memory) => memory.agent === who && (memory.path.endsWith('/' + file) || memory.id.endsWith(file))) ?? null
}

function refLabel(ref) {
  const asks = /^asks:(\d+)$/.exec(ref)
  if (asks) return `${number(asks[1])} of your messages`
  const target = refMemory(ref)
  if (target) return `${agent(target.agent).name}: ${target.title}`
  if (ref.startsWith('session:')) return `a conversation (${ref.slice(8, 16)}…)`
  return ref
}

function drawBuild(preview) {
  const sessions = state.snap.sessions
  const yours = state.snap.memories.filter((memory) => memory.kind === 'you').length
  preview.append(head('About you', metaLine(['not built yet']), state.snap.aboutPath))
  preview.append(el('p', 'pv-big', 'A short profile of how you work, built from your own words across every agent.'))
  const call = el('div', 'callout')
  call.append(el('div', null, 'Ask the agent on the right, on the model you picked for this harness:'), el('div', 'say', 'build my About You'))
  preview.append(call)
  const facts = []
  if (sessions?.asks) facts.push(`${number(sessions.asks)} messages you sent to ${sessions.engines.filter((row) => row.asks).length} agents`)
  if (yours) facts.push(`${yours} notes your agents saved about you`)
  if (facts.length) preview.append(el('p', null, `It reads ${facts.join(' and ')}, and writes the profile here. Every line says where it came from.`))
  preview.append(el('p', 'pv-meta', 'Only this harness\'s agent builds it, as a turn you can see on the right. Then every agent gets it; the switch at the top turns that off.'))
}

const TURN_ON = {
  codex: ['Codex keeps memory only when it is turned on. Add this to ~/.codex/config.toml:', '[features]\nmemories = true'],
  grok: ['Grok Build keeps memory only when it is turned on. Add this to ~/.grok/config.toml:', '[memory]\nenabled = true'],
  claude: ['Claude Code memory is off. Turn it back on with /memory in Claude Code.', null],
}

function drawAgent(preview, info) {
  const status = info.memory === 'none' ? 'keeps no memory of its own' : `memory ${info.memory}`
  const title = el('h2', 'pv-title', info.name); title.style.color = info.color
  preview.append(title, metaLine([status, info.sessions ? `${number(info.sessions)} sessions here` : null]))
  preview.append(el('p', 'pv-big', info.says))
  const facts = el('dl', 'kv')
  const add = (k, v) => { if (v === null || v === undefined || v === '') return; facts.append(el('dt', null, k), el('dd', null, v)) }
  add('saved', info.memories ? `${info.memories} ${info.memories === 1 ? 'memory' : 'memories'}` : 'nothing yet')
  if (info.instructions) add('instructions', `${info.instructions} file${info.instructions === 1 ? '' : 's'} you wrote`)
  if (info.unreadable) add('unreadable', `${info.unreadable} memories in a format Harness cannot read`)
  add('kept in', info.where)
  add('home', info.present ? info.home : 'not installed here')
  if (info.machines?.length > 1) add('machines', info.machines.join(', '))
  preview.append(facts)
  const turnOn = info.memory === 'off' ? TURN_ON[info.id] : null
  if (turnOn) {
    preview.append(el('div', 'pv-h', 'turn it on'), el('p', null, turnOn[0]))
    if (turnOn[1]) preview.append(el('div', 'code', turnOn[1]))
  }
}

/** Nothing selected — every group folded, or a search with no match: say what is here, not "nothing". */
function drawOverview(preview) {
  const snap = state.snap
  const memories = snap.memories.filter((row) => row.kind !== 'instructions')
  const agents = snap.agents.filter((row) => row.memories > 0)
  preview.append(head(`${number(memories.length)} ${memories.length === 1 ? 'memory' : 'memories'}`, metaLine([`from ${agents.map((row) => row.name).join(', ') || 'no agent yet'}`, 'on this computer'])))
  const facts = el('dl', 'kv')
  const add = (k, v) => { if (v) facts.append(el('dt', null, k), el('dd', null, v)) }
  add('about you', `${snap.about?.lines.length ?? 0} lines built · ${memories.filter((row) => row.kind === 'you').length} saved by agents`)
  add('projects', `${snap.projects.length}`)
  add('sessions', snap.sessions ? `${number(snap.sessions.sessions)} with ${number(snap.sessions.asks)} of your messages` : null)
  preview.append(facts)
  drawMachines(preview)
  preview.append(el('p', 'pv-meta', state.query.trim() ? 'Nothing matches that yet. Esc clears the search.' : 'Open a group on the left, or type to search.'))
}

/** Which machines answered, and why the others did not. */
function drawMachines(preview) {
  const list = state.snap.machines ?? []
  if (list.length < 2) return
  preview.append(el('div', 'pv-h', 'machines'))
  const facts = el('dl', 'kv')
  for (const machine of list) {
    const count = state.snap.memories.filter((row) => row.machine?.id === machine.id && row.kind !== 'instructions').length
    facts.append(el('dt', null, machine.name + (machine.current ? ' (this one)' : '')), el('dd', null, machine.ok ? `${number(count)} memories` : machine.error ?? 'did not answer'))
  }
  preview.append(facts)
}

function drawWelcome(preview) {
  preview.append(head('Nothing here yet', metaLine(['your agents have not saved any memories on this computer'])))
  preview.append(el('p', null, 'Claude Code saves memories as you work. Codex and Grok Build save them once memory is turned on. Hermes and OpenClaw keep a profile. They will appear here as soon as any agent writes one.'))
}

// ── search: memories here, conversations from the session index ────────────────────────────────

let searchTimer = null
let searchSeq = 0
function searchSessions(q) {
  clearTimeout(searchTimer)
  const text = q.trim()
  if (text.length < 2) { state.hits = { q: text, items: [], error: null }; return }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq
    let answer
    try { answer = await (await fetch(`/api/search?q=${encodeURIComponent(text)}`)).json() } catch { answer = { hits: [], error: 'Search is not available right now.' } }
    if (seq !== searchSeq) return
    state.hits = { q: text, items: answer.hits ?? [], error: answer.error ?? null }
    if (state.query.trim() === text) drawList()
  }, 160)
}

$('q').addEventListener('input', (event) => {
  state.query = event.target.value
  document.body.classList.remove('reading')
  searchSessions(state.query)
  state.selected = null
  drawList({ keepScroll: false })
  $('list').scrollTop = 0
})

document.addEventListener('keydown', (event) => {
  const input = $('q')
  if (event.metaKey || event.ctrlKey && !['n', 'p', 'j', 'k'].includes(event.key)) return
  const key = event.ctrlKey ? { n: 'ArrowDown', j: 'ArrowDown', p: 'ArrowUp', k: 'ArrowUp' }[event.key] : event.key
  if (key === 'ArrowDown') { event.preventDefault(); move(1) }
  else if (key === 'ArrowUp') { event.preventDefault(); move(-1) }
  else if (key === 'PageDown') { event.preventDefault(); move(12) }
  else if (key === 'PageUp') { event.preventDefault(); move(-12) }
  else if (key === 'Home' && !input.value) { event.preventDefault(); move(-Infinity) }
  else if (key === 'End' && !input.value) { event.preventDefault(); move(Infinity) }
  else if (key === 'Enter') { event.preventDefault(); forward() }
  else if (key === 'ArrowRight' && (input.selectionStart === input.value.length || document.activeElement !== input)) { event.preventDefault(); forward() }
  else if (key === 'ArrowLeft' && (input.selectionStart === 0 || document.activeElement !== input)) { event.preventDefault(); back() }
  else if (key === 'Escape') {
    event.preventDefault()
    if (document.body.classList.contains('reading')) document.body.classList.remove('reading')
    else if (input.value) { input.value = ''; state.query = ''; state.hits = { q: '', items: [], error: null }; drawList({ keepScroll: false }) }
    input.focus()
  } else if (document.activeElement !== input && key.length === 1 && !event.altKey) input.focus()
})

// ── live: a snapshot on connect and whenever something changed ─────────────────────────────────

const instance = document.querySelector('meta[name="memories-instance"]')?.content ?? ''

function receive(snap) {
  // The viewer restarted under this page: its token is gone, so the switch would refuse. Reload.
  if (snap.instance && instance && snap.instance !== instance) { location.reload(); return }
  const firstLoad = !state.snap
  const ids = new Set(snap.memories.map((memory) => memory.id))
  if (state.known) for (const id of ids) if (!state.known.has(id)) state.fresh.set(id, Date.now())
  state.known = ids
  state.snap = snap
  if (firstLoad && snap.about?.lines?.length) state.selected = 'a:0'
  drawSwitch()
  drawBand()
  drawList()
  $('updated').textContent = `read ${new Date(snap.observedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
  if (state.fresh.size) setTimeout(() => { for (const [id, at] of state.fresh) if (Date.now() - at > 6000) state.fresh.delete(id) }, 6500)
}

function connect() {
  const live = $('live')
  const source = new EventSource('/events')
  // Connected is the normal state and says nothing; only a lost connection is worth words.
  source.addEventListener('snapshot', (event) => {
    live.textContent = ''; live.classList.remove('lost')
    try { receive(JSON.parse(event.data)) } catch { /* a malformed frame is skipped; the next one replaces it */ }
  })
  source.addEventListener('error', () => { live.textContent = 'reconnecting…'; live.classList.add('lost') })
}

let resizeTimer = null
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawBand, 80) }).observe(document.body)

drawList()
connect()
