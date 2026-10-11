#!/usr/bin/env node
/**
 * Serves the Boss Mode prototypes on this computer, and, for pages opened with ?real, this computer's own
 * desk: read on each request, only on loopback, and never written anywhere. It only reads.
 *
 *   node docs/research/2026-10-11-boss-mode/serve.mjs [port]
 *   open http://127.0.0.1:<port>/            an invented desk
 *   open http://127.0.0.1:<port>/?real       yours
 *
 * Where your desk comes from (README.md has the whole story):
 *   - every harness on every reachable machine, and whether it is working, needs you, finished unread or
 *     failed: the daemon's local bridge, read the way Harness Monitor reads it (`agents_list`, via
 *     store/agents/harness-monitor/lib/inventory.mjs). Nothing is sent to any harness.
 *   - what you said to each, and when: the session index (`session-search.db`, opened read-only).
 *   - which of those you said to ⌘B: the box's recent prompts (`task_box_recent_v1` in the desktop's
 *     state file; only that key is read, the rest of the file is never kept) matched to the message that
 *     landed in a harness. ⌘B keeps no record of where a task went, so this is the best there is.
 *   - how sure ⌘B was: the router's `[route]` lines in the daemon log, when they are still there.
 *   - what a harness last said: the turn summaries the daemon keeps (`summaries.json`).
 */
import { createServer } from 'node:http'
import { open, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const store = (path) => import(new URL(`../../../store/agents/${path}`, import.meta.url).href)
const { collect } = await store('harness-monitor/lib/inventory.mjs')
const { openIndex } = await store('memories/lib/sessions.mjs')

const HOUR = 3_600_000
const WINDOW = 36 * HOUR
const home = homedir()
const data = process.env.ADAPTER_DATA_DIR || join(home, '.harness', 'cli', 'data')
const desktopState = join(home, '.harness', 'desktop-app-v2', 'state.json')

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' }
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
const clip = (text, n) => { const t = String(text ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }

/** ⌘B's recent prompts, newest first: that one key of the desktop's state file, nothing else. */
async function boxPrompts() {
  try {
    const raw = JSON.parse(await readFile(desktopState, 'utf8'))
    const value = raw?.values?.task_box_recent_v1
    const parsed = typeof value === 'string' ? JSON.parse(value) : null
    return Array.isArray(parsed?.prompts) ? parsed.prompts.filter((p) => typeof p === 'string').slice(0, 20) : []
  } catch { return [] }
}

/** The router's decisions still in the daemon log: when, what kind, Jev's pick and runner-up. */
async function routeLines() {
  const path = join(data, 'harness.log')
  try {
    const info = await stat(path)
    const length = Math.min(info.size, 6 * 1024 * 1024)
    const handle = await open(path, 'r')
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, info.size - length)
    await handle.close()
    const out = []
    for (const line of buffer.toString('utf8').split('\n')) {
      if (!line.includes('[route]')) continue
      const at = Date.parse(line.slice(0, 40).match(/\d{4}-\d\d-\d\dT[\d:.]+Z?/)?.[0] ?? '')
      if (!Number.isFinite(at)) continue
      const kind = /\[route\]\s+session/.test(line) ? 'session' : /\[route\]\s+new/.test(line) ? 'new' : /nothing decided/.test(line) ? 'none' : null
      if (!kind) continue
      const pick = /"([^"]{1,300})"\s+([\d.]+)(?:,\s*then\s+"([^"]{1,300})"\s+([\d.]+))?/.exec(line)
      out.push({ at, kind, name: pick?.[1] ?? null, p: pick ? Number(pick[2]) : null, runnerUp: pick?.[3] ? { name: pick[3], p: Number(pick[4]) } : null })
    }
    return out
  } catch { return [] }
}

async function summaries() {
  try { return JSON.parse(await readFile(join(data, 'summaries.json'), 'utf8')) ?? {} } catch { return {} }
}

const remote = { at: 0, answers: new Map() }
let cache = null

async function desk() {
  if (cache && Date.now() - cache.at < 3500) return cache.desk
  const now = Date.now()
  const notes = []
  const inventory = await collect({ now, includeRemote: true, remote, timeoutMs: 8000 })
  for (const problem of inventory.problems) notes.push(`${problem.machine}: ${problem.error}`)
  const index = await openIndex(data)
  if (index.error) notes.push(index.error)
  const [prompts, routes, recaps] = await Promise.all([boxPrompts(), routeLines(), summaries()])

  const rows = inventory.rows.filter((row) => row.engine !== 'terminal' && (row.live || (row.lastActivity ?? 0) > now - WINDOW))
  const STATE = { working: 'working', starting: 'working', needsInput: 'asking', done: 'done', failed: 'failed', idle: 'done', stopped: 'stopped', offline: 'offline', unknown: 'done' }
  const turnsOf = index.db?.prepare('SELECT at, ask != \'\' AS you, length(answer) AS size FROM turns WHERE session_id = ? AND at >= ? ORDER BY at')
  const lastAsk = index.db?.prepare('SELECT at, ask, answer FROM turns WHERE session_id = ? AND ask != \'\' ORDER BY at DESC LIMIT 1')
  const lastAnswer = index.db?.prepare('SELECT answer FROM turns WHERE session_id = ? AND answer != \'\' ORDER BY at DESC LIMIT 1')
  const findAsk = index.db?.prepare('SELECT at, session_id FROM turns WHERE trim(ask) = ? AND at >= ? ORDER BY at DESC LIMIT 1')

  // Which harness each ⌘B prompt landed in: the newest message with exactly those words.
  const boxed = new Map()
  for (const text of prompts) {
    const hit = findAsk?.get(text.trim(), now - 7 * 24 * HOUR)
    if (hit) boxed.set(`${hit.session_id}\n${hit.at}`, text)
  }
  if (prompts.length && boxed.size < prompts.length) notes.push(`${prompts.length - boxed.size} of ⌘B's ${prompts.length} recent prompts are in no harness this computer indexes.`)

  const harnesses = []
  const dispatches = []
  for (const row of rows) {
    const state = STATE[row.activity] ?? 'done'
    // A harness whose finished turn you have opened since is quiet, not waiting to be read.
    const quiet = row.activity === 'idle' || row.activity === 'unknown'
    const recap = row.sessionId ? recaps[row.sessionId] : null
    const [head, ...body] = typeof recap === 'string' ? recap.split('\n\n') : []
    const said = clip(body.join(' ') || head || (row.sessionId ? lastAnswer?.get(row.sessionId)?.answer : '') || '', 320)
    const turns = row.sessionId && turnsOf ? turnsOf.all(row.sessionId, now - WINDOW).map((t) => ({ at: t.at, by: t.you ? 'you' : 'agent', size: t.size ?? 0 })) : []
    const h = {
      id: row.id, machine: row.machineId, engine: row.engine, name: clip(row.name, 80), project: clip(row.project, 60), state: quiet ? 'idle' : state,
      since: row.stateSince ?? row.lastActivity ?? now, createdAt: row.createdAt ?? now, lastTurnAt: row.lastActivity ?? null,
      tokens: row.tokens ?? 0, question: state === 'asking' ? said : null, summary: state !== 'asking' ? said : null, turns, boss: false,
    }
    harnesses.push(h)
    const ask = row.sessionId ? lastAsk?.get(row.sessionId) : null
    if (!ask || ask.at < now - WINDOW) continue
    const viaBox = boxed.get(`${row.sessionId}\n${ask.at}`)
    const route = viaBox ? routes.filter((r) => r.at <= ask.at + 2000 && r.at >= ask.at - 30_000).sort((a, b) => b.at - a.at)[0] : null
    h.boss = true
    dispatches.push({
      id: `r${dispatches.length + 1}`, n: 0, at: ask.at, text: clip(viaBox ?? ask.ask, 400), via: viaBox ? 'box' : 'pane',
      decision: viaBox
        ? { kind: route?.kind ?? 'session', p: route?.p ?? null, runnerUp: route?.runnerUp ?? null, why: route ? '' : 'the log no longer has this decision', ms: 0, cost: 0 }
        : { kind: 'direct', p: null, runnerUp: null, why: 'typed into the harness, not through ⌘B', ms: 0, cost: 0 },
      harness: h.id, machine: h.machine, created: false, landedAt: ask.at, state, since: state === 'working' ? ask.at : h.since,
      seenAt: quiet ? (row.lastActivity ?? now) : null,
      question: h.question, summary: state === 'failed' ? null : h.summary, error: state === 'failed' ? said : null, pr: /PR #(\d+)/.exec(said)?.[1] ?? null,
      history: [{ at: ask.at, state: 'working' }, ...(state !== 'working' ? [{ at: h.since, state }] : [])],
    })
  }
  dispatches.sort((a, b) => a.at - b.at).forEach((d, i) => { d.n = i + 1 })
  const machines = inventory.machines.map((m) => ({ id: m.machineId, name: clip(m.name, 40), here: m.current, online: m.online, since: null, os: '' }))
    .filter((m) => m.online || harnesses.some((h) => h.machine === m.id))
  if (!prompts.length) notes.push('⌘B has no recent prompts on this computer; every task shown was typed into its harness.')
  const result = { now, real: true, source: 'your desk', notes, machines, harnesses, dispatches }
  cache = { at: Date.now(), desk: result }
  return result
}

const server = createServer(async (req, res) => {
  try {
    const { port } = server.address()
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) { json(res, 403, { error: 'Loopback only.' }); return }
    const site = req.headers['sec-fetch-site']
    if (site && site !== 'same-origin' && site !== 'none') { json(res, 403, { error: 'Only these pages may ask.' }); return }
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/real/desk') { json(res, 200, await desk()); return }
    const path = normalize(join(here, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)))
    if (!path.startsWith(here + sep) || !TYPES[extname(path)] || path.endsWith('.mjs')) { json(res, 404, { error: 'Not found.' }); return }
    const body = await readFile(path).catch(() => null)
    if (!body) { json(res, 404, { error: 'Not found.' }); return }
    res.writeHead(200, { 'content-type': TYPES[extname(path)], 'cache-control': 'no-store' })
    res.end(body)
  } catch (error) {
    json(res, 500, { error: String(error?.message ?? error) })
  }
})

server.listen(Number(process.argv[2] ?? 0), '127.0.0.1', () => {
  console.log(`Boss Mode prototypes: http://127.0.0.1:${server.address().port}/   (your desk: add ?real)`)
})
