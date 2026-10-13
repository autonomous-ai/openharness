/**
 * The Memories pane: Sense of Self (self.js), what your agents believe about you, held up by every
 * memory they keep, under a one-row header with the About You switch.
 *
 * The header prompt is always focused, as in fzf: typing anywhere types there, and what it holds is the
 * scene's recall. The scene reads its data through memory-data.js and draws in the pane's one render
 * loop (loop.js), which runs only while the tab is visible. Nothing in this file assigns HTML.
 */

import { agent as agentOf, createMemoryData } from './memory-data.js'
import { createLoop } from './loop.js'
import { mountSelf } from './self.js'

const $ = (id) => document.getElementById(id)

const state = { snap: null }
const agent = (id) => agentOf(id, state.snap)
const number = (n) => Number(n ?? 0).toLocaleString()

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
  // One row: the switch and, beside it, only what explains its state.
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

// ── live: a snapshot on connect and whenever something changed ─────────────────────────────────

const instance = document.querySelector('meta[name="memories-instance"]')?.content ?? ''

function receive(snap) {
  // The viewer restarted under this page: its token is gone, so the switch would refuse. Reload.
  if (snap.instance && instance && snap.instance !== instance) { location.reload(); return }
  state.snap = snap
  data.receive(snap)
  drawSwitch()
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

// ── the scene ──────────────────────────────────────────────────────────────────────────────────

const data = createMemoryData({
  // No snapshot from /events yet: read one, through the same instance check.
  fallback: async () => { const snap = await (await fetch('/api/state')).json(); receive(snap); return snap },
})
const loop = createLoop()
const motion = matchMedia('(prefers-reduced-motion: reduce)')
const input = $('q')

function setQuery(text) {
  input.value = String(text ?? '')
  scene.recall(input.value)
}

const scene = mountSelf({
  root: $('stage'),
  data,
  loop,
  setQuery,
  count: (text) => { $('count').textContent = String(text ?? '') },
  reducedMotion: () => motion.matches,
})

input.addEventListener('input', () => scene.recall(input.value))

document.addEventListener('keydown', (event) => {
  if (event.isComposing) return
  const inInput = document.activeElement === input
  const info = { typing: input.value !== '' }
  if (scene.key(event, info)) { event.preventDefault(); if (!inInput) input.focus(); return }
  if (event.key === 'Escape') { event.preventDefault(); if (input.value) setQuery(''); input.focus(); return }
  if (!inInput && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) input.focus()
})

// One render loop, and only while the tab is visible.
function visibility() {
  if (document.visibilityState === 'hidden') { loop.stop(); scene.stop() } else { scene.start(); loop.start() }
}
document.addEventListener('visibilitychange', visibility)
let resizeTimer = null
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => scene.resize(), 60) }).observe($('stage'))

visibility()
connect()
