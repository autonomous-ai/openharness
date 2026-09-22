/**
 * The pane beside the terminal: the fleet, live, and the four reversible verbs.
 *
 * A loopback server and nothing else — it binds 127.0.0.1, refuses a request whose Host or Origin is not
 * its own, and serves three static files with a self-only CSP. What it adds over the other store viewers
 * is a narrow write surface, because a fleet manager you can only read is a fleet manager nobody uses:
 *
 *   POST /api/act      pause · resume · retire · pin · unpin — every one of them reversible
 *   POST /api/policy   the thresholds, validated before they are written
 *
 * Both require the token this process mints at boot and hands to its own page; a page from anywhere else
 * does not have it. What is deliberately NOT here: deleting an agent, killing a tmux session, touching a
 * transcript. Those are irreversible, they already exist in the app behind their own confirmation, and a
 * pane full of eighty rows is the last place they belong.
 */

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pause, resume } from './lib/actions.mjs'
import { closeBridges } from './lib/bridge.mjs'
import { collect as collectFleet, summarize, tilde } from './lib/inventory.mjs'
import { capture, looksBlocked } from './lib/panes.mjs'
import { DEFAULT_POLICY, decide, normalizePolicy } from './lib/policy.mjs'
import { clearPaused, markPaused, pin, readLog, readState, record, savePolicyValues, writeState, writeVerdict } from './lib/state.mjs'

const PACKAGE = dirname(fileURLToPath(import.meta.url))
const VERBS = new Set(['pause', 'resume', 'pin', 'unpin'])

/** Panes to read per refresh when looking for an open prompt. Bounded because each one is a tmux call
 *  and a fleet of eighty must cost the same as a fleet of eight: the candidates are the rows the policy
 *  is about to act on, which are the only rows where the answer changes anything. */
const BLOCKED_SCAN_LIMIT = 24

export function createViewer({ workspace, port = 0, intervalMs = 4000, remoteIntervalMs = 60_000, now = () => Date.now(), collect = collectFleet, scan = capture, verbs = { pause, resume } }) {
  const token = randomBytes(24).toString('base64url')
  const clients = new Set()
  const cache = new Map()
  // The remote machines' last answers (lib/inventory.mjs collect): they are asked every
  // `remoteIntervalMs`, the local machine every `intervalMs`, and only while a pane is connected.
  const remote = { at: 0, answers: new Map(), problems: [] }
  let snapshot = { spec: 1, status: 'starting', rows: [], summary: null, policy: DEFAULT_POLICY, plan: [], totals: null, problems: [], log: [], observedAt: null, intervalMs }
  let stopped = false, timer, heartbeat, polling = null
  // Resolves after the first observation lands. The server starts listening before it, so the pane draws
  // its shell immediately; anything that needs the first real snapshot (a test, a caller) awaits this.
  let observed
  const firstObservation = new Promise((resolve) => { observed = resolve })

  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
  const json = (res, code, value) => { res.writeHead(code, { ...headers, 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)) }

  const publish = () => {
    const body = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`
    for (const client of clients) {
      if (client.writableLength > 512 * 1024) { client.destroy(); clients.delete(client) }
      else client.write(body)
    }
  }

  /** One observation: the fleet, what the policy would do to it, and the pane header's verdict. */
  async function observe({ forceRemote = false } = {}) {
    const state = await readState(workspace).catch(() => null)
    if (!state) {
      snapshot = { ...snapshot, status: 'unreadable', problems: [{ machine: 'monitor.json', error: 'The policy file could not be read. Ask the agent to check monitor.json.' }] }
      return
    }
    const policy = normalizePolicy(state.policy, { home: homedir() })
    const { rows, problems, degraded } = await collect({ state, now: now(), includeRemote: true, cache, remote, remoteIntervalMs: forceRemote ? 0 : remoteIntervalMs })

    // Look for an open prompt only where it would change a decision, newest candidates first.
    const candidates = rows
      .filter((row) => row.local && row.state === 'running' && row.pane && row.idleMs >= policy.pauseAfterIdleMs / 2)
      .slice(0, BLOCKED_SCAN_LIMIT)
    await Promise.all(candidates.map(async (row) => {
      const screen = await scan(row.pane, { lines: 30 })
      row.needsInput = looksBlocked(screen)
      row.screenTail = screen.split('\n').filter((line) => line.trim()).slice(-3).join('\n').slice(0, 600)
    }))

    const plan = decide(rows, policy, { home: homedir(), now: now() })
    const summary = summarize(rows)
    snapshot = {
      spec: 1,
      status: degraded ? 'degraded' : 'ok',
      rows,
      summary,
      policy: { ...policy },
      defaults: DEFAULT_POLICY,
      plan: plan.entries,
      totals: plan.totals,
      problems,
      pins: state.pins,
      configPath: tilde(state.configPath, homedir()),
      log: await readLog(workspace, { limit: 30 }),
      observedAt: now(),
      intervalMs,
    }
    await writeVerdict(workspace, { summary, rows, plan: plan.entries, problems }).catch(() => {})
  }

  let lastPollAt = 0
  // The next tick is booked only while a pane is connected: a viewer nobody is looking at — a tab in
  // the background, a pane the person closed but whose process outlived the daemon — must not keep
  // every machine on the account answering it.
  const schedule = () => {
    clearTimeout(timer); timer = null
    if (stopped || clients.size === 0) return
    timer = setTimeout(() => { void poll() }, intervalMs)
  }
  // Someone wants the observation now: read again if the one we have is older than a tick.
  const wake = () => {
    if (stopped || polling || now() - lastPollAt < intervalMs) return
    clearTimeout(timer); timer = null
    void poll()
  }

  async function poll({ immediate = false, forceRemote = false } = {}) {
    if (polling) return polling
    polling = (async () => {
      try { await observe({ forceRemote }) } catch (error) {
        snapshot = { ...snapshot, status: 'unavailable', problems: [{ machine: 'this machine', error: error instanceof Error ? error.message : String(error) }] }
      }
      if (!stopped) publish()
      observed()
    })()
    try { await polling } finally { polling = null; lastPollAt = now() }
    if (!stopped && !immediate) schedule()
  }

  /** The write surface. One verb, up to 64 rows, and a receipt per row — the same library call the CLI
   *  makes, so a click and a typed command cannot behave differently. */
  async function act({ verb, ids }) {
    if (!VERBS.has(verb)) return { error: `Not a verb Harness Monitor has: ${verb}` }
    const targets = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string').slice(0, 64)
    if (!targets.length) return { error: 'Name at least one harness.' }
    const state = await readState(workspace)
    const policy = normalizePolicy(state.policy, { home: homedir() })
    const rows = snapshot.rows.filter((row) => targets.includes(row.id))
    if (!rows.length) return { error: 'Those harnesses are not in the current view. Refresh and try again.' }

    let next = state
    const results = []
    for (const row of rows) {
      if (verb === 'pin' || verb === 'unpin') {
        next = pin(next, row.id, verb === 'pin')
        results.push({ ok: true, action: verb, id: row.id, name: row.name, detail: verb === 'pin' ? 'never paused by the policy' : 'the policy may pause it again' })
        continue
      }
      const ticket = state.paused?.[row.id] ?? null
      const result = verb === 'pause' ? await verbs.pause(row, { policy }) : await verbs.resume(row, { ticket })
      if (result.ok && result.ticket) next = markPaused(next, row, result.ticket)
      if (result.ok && verb === 'resume') next = clearPaused(next, row.id)
      results.push(result)
    }
    await writeState(workspace, next)
    for (const result of results) await record(workspace, { ...result, by: 'pane' })
    await poll({ immediate: true })
    return { results }
  }

  async function savePolicy(raw) {
    // Only the keys the pane can change, and only valid values: the file is a person's, and the pane is a
    // guest in it. Everything else in it — comments included — is left exactly as it was.
    const allowed = ['pauseAfterIdle', 'hideAfterIdle', 'runningCeiling']
    const values = Object.fromEntries(Object.entries(raw ?? {}).filter(([key]) => allowed.includes(key)))
    const state = await readState(workspace)
    let policy
    try { policy = normalizePolicy({ ...state.policy, ...values }, { home: homedir() }) } catch (error) { return { error: error.message } }
    const path = await savePolicyValues(values)
    await record(workspace, { action: 'policy', ok: true, detail: JSON.stringify(values), by: 'pane' })
    await poll({ immediate: true })
    return { policy: { ...policy }, path }
  }

  const server = createServer(async (req, res) => {
    try {
      const address = server.address()
      const hosts = new Set([`127.0.0.1:${address?.port}`, `localhost:${address?.port}`, `[::1]:${address?.port}`])
      if (!hosts.has(req.headers.host)) { json(res, 403, { error: 'Loopback requests only.' }); return }
      const url = new URL(req.url, `http://${req.headers.host}`)
      if (req.headers.origin && req.headers.origin !== url.origin) { json(res, 403, { error: 'Cross-origin requests are not allowed.' }); return }

      if (req.method === 'POST') {
        if (req.headers['x-hps-token'] !== token) { json(res, 403, { error: 'This pane did not mint that token.' }); return }
        let body = ''
        for await (const chunk of req) { body += chunk; if (body.length > 64 * 1024) { json(res, 413, { error: 'Too large.' }); return } }
        let payload; try { payload = JSON.parse(body || '{}') } catch { json(res, 400, { error: 'Send JSON.' }); return }
        if (url.pathname === '/api/act') { json(res, 200, await act(payload)); return }
        if (url.pathname === '/api/policy') { json(res, 200, await savePolicy(payload.policy ?? {})); return }
        if (url.pathname === '/api/refresh') { await poll({ immediate: true, forceRemote: true }); json(res, 200, { ok: true }); return }
        json(res, 404, { error: 'Not found' }); return
      }

      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('allow', 'GET, HEAD, POST'); json(res, 405, { error: 'Not allowed.' }); return }
      if (url.pathname === '/health') { json(res, 200, { ok: true }); return }
      if (url.pathname === '/api/snapshot') { json(res, 200, snapshot); wake(); return }
      if (url.pathname === '/events') {
        if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return }
        if (clients.size >= 16) { json(res, 503, { error: 'Too many viewer connections.' }); return }
        res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', connection: 'keep-alive', 'x-accel-buffering': 'no' })
        res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)
        clients.add(res)
        res.on('close', () => { clients.delete(res); if (clients.size === 0) { clearTimeout(timer); timer = null } })
        // A pane just opened: catch up if the observation is stale, and start ticking either way.
        wake()
        if (!timer && !polling) schedule()
        return
      }

      const assets = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
        '/app.css': ['app.css', 'text/css; charset=utf-8'],
        '/scale.js': ['scale.js', 'text/javascript; charset=utf-8'],
      }
      if (!assets[url.pathname]) { json(res, 404, { error: 'Not found' }); return }
      const [file, contentType] = assets[url.pathname]
      let content = await readFile(join(PACKAGE, 'viewer', file), 'utf8')
      // The page is served the token in a meta tag rather than a cookie or an inline script: no script
      // source changes, so the CSP stays script-src 'self' with no nonce and no 'unsafe-inline'.
      if (file === 'index.html') content = content.replace('__HPS_TOKEN__', token)
      res.writeHead(200, {
        ...headers,
        'content-type': contentType,
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'",
      })
      res.end(req.method === 'HEAD' ? undefined : content)
    } catch {
      if (!res.headersSent) json(res, 500, { error: 'The viewer could not serve this request.' }); else res.end()
    }
  })

  return {
    server,
    token,
    observed: firstObservation,
    snapshot: () => snapshot,
    act,
    start: () => new Promise((ok, fail) => {
      server.once('error', fail)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', fail)
        poll()
        heartbeat = setInterval(() => { for (const client of clients) client.write(': pulse\n\n') }, 20_000)
        ok(server.address().port)
      })
    }),
    close: async () => {
      stopped = true; clearTimeout(timer); clearInterval(heartbeat)
      await polling?.catch(() => {})
      closeBridges()
      for (const client of clients) client.end()
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const workspace = resolve(process.env.HARNESS_WORKSPACE || process.cwd())
  const port = Number(process.env.HARNESS_VIEWER_PORT || 0)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('HARNESS_VIEWER_PORT must be a port number.')
  const viewer = createViewer({ workspace, port })
  console.log(`[hps] http://127.0.0.1:${await viewer.start()}/`)
  const close = () => viewer.close().then(() => process.exit(0))
  process.once('SIGINT', close); process.once('SIGTERM', close)
}
