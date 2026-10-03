/** Loopback viewer. Inventory and explicit actions require no model inference. */

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stop, open, previewDelete, deleteHarness, worktreeAction, inspectWorkspace } from './lib/actions.mjs'
import { cleanupReviews } from './lib/cleanup.mjs'
import { closeBridges } from './lib/bridge.mjs'
import { collect as collectFleet, summarize, tilde } from './lib/inventory.mjs'
import { DEFAULT_POLICY, decide, normalizePolicy } from './lib/policy.mjs'
import { pin, readLog, readState, record, savePolicyValues, writeState, writeVerdict } from './lib/state.mjs'

const PACKAGE = dirname(fileURLToPath(import.meta.url))
const VERBS = new Set(['stop', 'open', 'pin', 'unpin', 'delete-review', 'delete', 'worktree-review', 'worktree-delete', 'workspace-inspect'])

export function createViewer({ workspace, port = 0, intervalMs = 4000, remoteIntervalMs = 15_000, now = () => Date.now(), collect = collectFleet, verbs = { stop, open, previewDelete, deleteHarness, worktreeAction, inspectWorkspace }, cleanup = cleanupReviews() }) {
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
    const { rows, shared = [], machines = [], problems, degraded } = await collect({ state, now: now(), includeRemote: true, cache, remote, remoteIntervalMs: forceRemote ? 0 : remoteIntervalMs })

    const plan = decide(rows, policy, { home: homedir(), now: now() })
    const summary = summarize(rows)
    snapshot = {
      spec: 1,
      status: degraded ? 'degraded' : 'ok',
      rows,
      shared,
      machines,
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
  let writes = Promise.resolve()
  function write(operation) {
    const result = writes.then(operation)
    writes = result.catch(() => {})
    return result
  }
  const act = payload => write(() => actOnce(payload))
  async function actOnce({ verb, ids, manual = false, expected, reviewId, path, discardChanges, choices }) {
    if (!VERBS.has(verb)) return { error: `Not a verb Harness Monitor has: ${verb}` }
    const targets = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string'))].slice(0, 64)
    if (!targets.length) return { error: 'Name at least one harness.' }
    const explicit = manual === true && targets.length === 1
    const deleting = ['delete', 'delete-review', 'worktree-review', 'worktree-delete', 'workspace-inspect'].includes(verb)
    if (deleting && (!explicit || !Array.isArray(expected) || expected.length !== 1)) return { error: 'Review one harness at a time before deleting.' }
    if (['delete', 'worktree-delete'].includes(verb) && (typeof reviewId !== 'string' || !reviewId)) return { error: 'Review this harness before deleting it.' }
    const reviewed = new Map((Array.isArray(expected) ? expected : snapshot.rows).filter(row => row && typeof row.id === 'string').map(({ id, sessionId, lastActivity, createdAt }) => [id, { sessionId, lastActivity, createdAt }]))
    // Bulk actions are restricted to what is still in the reviewed cleanup plan.
    if (verb === 'stop' && !explicit) {
      await polling
      await poll({ immediate: true, forceRemote: true })
    }
    const state = await readState(workspace)
    const policy = normalizePolicy(state.policy, { home: homedir() })
    const rows = snapshot.rows.filter((row) => targets.includes(row.id))
    if (!rows.length) return { error: 'Those harnesses are not in the current view. Refresh and try again.' }

    let next = state
    const results = targets.filter(id => !rows.some(row => row.id === id)).map(id => ({ id, name: id, action: verb, ok: false, refused: true, detail: 'This session is no longer in the current view.' }))
    const eligible = new Set(snapshot.plan.filter(entry => entry.action === 'stop').map(entry => entry.id))
    for (const row of rows) {
      const review = reviewed.get(row.id)
      if ((verb === 'stop' || deleting) && (!review || review.sessionId !== row.sessionId || (deleting && review.createdAt !== row.createdAt) || (!explicit && review.lastActivity !== row.lastActivity))) {
        results.push({ id: row.id, name: row.name, action: verb, ok: false, refused: true, detail: 'This session changed since you reviewed it. Refresh and review it again.' })
        continue
      }
      if (verb === 'stop' && !explicit && !eligible.has(row.id)) {
        results.push({ id: row.id, name: row.name, action: verb, ok: false, refused: true, detail: 'This session is no longer eligible for cleanup. Review the new plan.' })
        continue
      }
      if (verb === 'workspace-inspect') {
        results.push(await verbs.inspectWorkspace(row))
        continue
      }
      if (verb === 'pin' || verb === 'unpin') {
        next = pin(next, row.id, verb === 'pin')
        results.push({ ok: true, action: verb, id: row.id, name: row.name, detail: verb === 'pin' ? 'never stopped by the policy' : 'the policy may stop it again' })
        continue
      }
      const result = verb === 'stop' ? await verbs.stop(row, { policy, force: explicit })
        : verb === 'delete-review' ? await verbs.previewDelete(row)
        : verb === 'delete' ? await verbs.deleteHarness(row, { reviewId, choices, path, discardChanges })
        : verb === 'worktree-review' ? await verbs.worktreeAction(row)
        : verb === 'worktree-delete' ? await verbs.worktreeAction(row, { reviewId, path, discardChanges }) : await verbs.open(row)
      results.push(result)
    }
    if (verb === 'workspace-inspect') return { results }
    if (verb === 'pin' || verb === 'unpin') await writeState(workspace, next)
    for (const result of results) await record(workspace, { ...result, by: 'pane' })
    await polling
    await poll({ immediate: true, forceRemote: true })
    return { results }
  }

  async function savePolicy(raw) {
    // Only the keys the pane can change, and only valid values: the file is a person's, and the pane is a
    // guest in it. Everything else in it — comments included — is left exactly as it was.
    const allowed = ['stopAfterIdle', 'hideAfterIdle', 'runningCeiling']
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
        if (url.pathname === '/api/cleanup/preview') { json(res, 200, await cleanup.preview()); return }
        if (url.pathname === '/api/cleanup/close') {
          let result
          try { result = await write(() => cleanup.close(payload.reviewId, payload.id)) }
          catch (error) {
            if (error.code !== 'INVALID_REVIEW') throw error
            json(res, 409, { error: error.message }); return
          }
          await record(workspace, { ...result, by: 'pane' })
          json(res, 200, result)
          return
        }
        if (url.pathname === '/api/policy') { json(res, 200, await write(() => savePolicy(payload.policy ?? {}))); return }
        if (url.pathname === '/api/refresh') { await polling; await poll({ immediate: true, forceRemote: true }); json(res, 200, { ok: true }); return }
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

      const icon = /^\/icons\/([a-z0-9-]+)\.png$/.exec(url.pathname)
      if (icon) {
        try {
          const content = await readFile(join(PACKAGE, 'viewer', 'icons', icon[1] + '.png'))
          res.writeHead(200, { ...headers, 'content-type': 'image/png' }); res.end(req.method === 'HEAD' ? undefined : content)
        } catch { json(res, 404, { error: 'Icon not found' }) }
        return
      }
      const assets = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
        '/app.css': ['app.css', 'text/css; charset=utf-8'],
        '/scale.js': ['scale.js', 'text/javascript; charset=utf-8'],
        '/table.js': ['table.js', 'text/javascript; charset=utf-8'],
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
