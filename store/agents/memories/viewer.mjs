/**
 * The Memories pane: a loopback server that reads every agent's memory and the session index, and
 * serves one page to see them: Sense of Self, About You held up by every memory (viewer/self.js). It
 * never writes anything an agent owns and needs no model: opening the pane sends no prompt. The only
 * file it writes is the pane header's verdict.
 *
 * While a pane is connected it looks again every few seconds and pushes a new snapshot when anything
 * changed — an agent saved a memory, the About You was rebuilt, you finished a turn somewhere.
 */

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homes } from './lib/agents.mjs'
import { noteSeen, writeAbout } from './lib/about.mjs'
import { DEFAULT_CHOICE_AT, deliver } from './lib/deliver.mjs'
import { askMachines, merge, newestChoice, syncAbout, syncChoice } from './lib/fleet.mjs'
import { around, asks, headings, search } from './lib/sessions.mjs'
import { closeIndex, fingerprint, sessionIndex, snapshot as takeSnapshot, writeVerdict } from './lib/state.mjs'

const PACKAGE = dirname(fileURLToPath(import.meta.url))
const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/self.css': ['self.css', 'text/css; charset=utf-8'],
  '/self.js': ['self.js', 'text/javascript; charset=utf-8'],
  '/self-model.js': ['self-model.js', 'text/javascript; charset=utf-8'],
  '/loop.js': ['loop.js', 'text/javascript; charset=utf-8'],
  '/memory-data.js': ['memory-data.js', 'text/javascript; charset=utf-8'],
}
// What /api/asks answers: the person's latest messages, cut short. Fixed, not asked for: a page can
// never read more of what the person typed than the scene draws as mist.
export const ASKS_LIMIT = 4000
export const ASKS_CHARS = 400
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you', 'are', 'not', 'but', 'use', 'when', 'what', 'how', 'why', 'all', 'any', 'one', 'its', 'has', 'have', 'was', 'were', 'out', 'new', 'via', 'per'])

/**
 * `fleet` is the bridge to the daemon (lib/bridge.mjs: `machinesReport`, `request`). Given, the pane also
 * shows every other machine's memories and keeps About You and the on/off choice the same on all of
 * them. Without it — tests, a pane started by hand — the pane reads this computer only.
 *
 * The pane never types into its agent: a turn typed into a pane lands on top of whatever the person is
 * writing there. Building About You by itself is the daemon's memory service's, which waits for an
 * empty input box; until then it is built when the person asks.
 */
export function createViewer({ workspace, port = 0, intervalMs = 4000, env = process.env, home, now = () => Date.now(), snapshot = takeSnapshot, fleet = null, fleetIntervalMs = 60_000, idleFleetIntervalMs = 10 * 60_000 } = {}) {
  const clients = new Set()
  // The one write the pane can make — the About You switch — needs this token, served inside the page:
  // another page in the browser cannot read it, so it cannot flip the switch.
  const token = randomBytes(24).toString('base64url')
  // Which viewer process served the page. A page from an earlier process (the viewer restarted under
  // it: an update, a crash) holds a token this one never minted, so it reloads itself (viewer/app.js).
  const instance = randomBytes(6).toString('hex')
  let current = null
  let local = null
  let machines = null // { here, remotes, at } from the last ask
  let fleetTimer = null
  let asking = null
  let refreshedAt = 0
  let fleetProblems = []
  let printed = ''
  let stopped = false
  let timer = null
  let heartbeat = null
  let looking = null

  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
  const json = (res, code, value) => { res.writeHead(code, { ...headers, 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)) }

  const publish = () => {
    const body = `event: snapshot\ndata: ${JSON.stringify(current)}\n\n`
    for (const client of clients) {
      if (client.writableLength > 8 * 1024 * 1024) { client.destroy(); clients.delete(client) } else client.write(body)
    }
  }

  // Every caller gets the snapshot, including one that arrives while a look is already running.
  async function look() {
    if (looking) return looking.then(() => current)
    looking = (async () => {
      try {
        local = await snapshot({ env, home, now: now() })
        // About You built and nobody has chosen on or off, on any machine this one knows of: on, as the
        // default — at the earliest time a choice can have, so the person's first click on Off, here or
        // on any machine, outranks it everywhere.
        // With other machines, only once they have been asked: a choice may be waiting on one of them.
        const anyChoice = newestChoice(local, machines?.remotes ?? [], machines?.here)
        if (local.about && !anyChoice && (!fleet || machines)) {
          try { deliver('on', { env, home, choiceAt: DEFAULT_CHOICE_AT, exact: true }); local = await snapshot({ env, home, now: now() }) } catch { /* shown as off */ }
        }
        // Delivery on and a copy out of date (About You edited by hand, or a newer Memories writes copies
        // differently): bring them up to date here, at most every ten minutes. Not a choice, so the
        // person's on/off stays as it is.
        const stale = local.delivery?.on && local.delivery.agents?.some((agent) => agent.delivered && !agent.current)
        if (stale && now() - refreshedAt > 10 * 60_000) {
          refreshedAt = now()
          try { deliver('refresh', { env, home }); local = await snapshot({ env, home, now: now() }) } catch { /* the pane shows the older copy */ }
        }
        const merged = machines ? merge(local, machines.remotes, machines.here) : { ...local, machines: [] }
        const next = { ...merged, problems: [...(merged.problems ?? []), ...fleetProblems], instance }
        const print = fingerprint(next) + JSON.stringify(next.machines.map((machine) => [machine.id, machine.ok, machine.error]))
        const changed = print !== printed
        current = next
        printed = print
        if (workspace && changed) { try { writeVerdict(workspace, next) } catch { /* the header is a courtesy; the pane still works */ } }
        if (changed) publish()
      } catch (error) {
        current = { ...(current ?? { spec: 1, memories: [], agents: [], projects: [] }), problems: [{ agent: 'viewer', error: error instanceof Error ? error.message : String(error) }] }
      }
    })()
    try { await looking } finally { looking = null }
    return current
  }

  /**
   * The other machines, About You across them, and the build when one is due. Every minute while the
   * pane is open; every ten minutes while it is not, so About You still reaches the other machines and
   * gets rebuilt while the Memories harness sits in a background tab.
   */
  async function tend() {
    if (!fleet || stopped) return
    if (asking) return asking
    // Each step on its own: one that fails (a profile from another machine this one refuses, a machine
    // that drops the link) is reported in the pane and never stops the steps after it.
    asking = (async () => {
      const problems = []
      const attempt = async (what, step) => {
        try { return await step() } catch (error) { problems.push({ agent: what, error: error instanceof Error ? error.message : String(error) }); return null }
      }
      const memory = homes(env, home).memory
      const asked = await attempt('machines', () => askMachines({ machinesReport: fleet.machinesReport, request: fleet.request }))
      if (asked) {
        machines = { ...asked, at: now() }
        for (const remote of machines.remotes) {
          if (Number.isInteger(remote.snapshot?.about?.gen)) await attempt('About You', () => noteSeen(memory, remote.snapshot.about.gen))
        }
      }
      if (!local) await attempt('this computer', () => look())
      if (machines && local) {
        // A copy of another machine's build keeps its generation; it only refreshes the copies here,
        // never turns delivery on: that is the person's choice, which syncChoice carries.
        const synced = await attempt('About You', () => syncAbout({ local, remotes: machines.remotes, here: machines.here, request: fleet.request,
          writeHere: (text, gen) => { writeAbout(memory, text, { gen }); deliver('refresh', { env, home }) } }))
        if (synced?.wroteHere) await attempt('this computer', () => look())
        const chose = await attempt('the switch', () => syncChoice({ local, remotes: machines.remotes, here: machines.here, request: fleet.request,
          applyHere: (on, at) => deliver(on ? 'on' : 'off', { env, home, choiceAt: at, exact: true }) }))
        for (const failed of [...(synced?.failed ?? []), ...(chose?.failed ?? [])]) problems.push({ agent: failed.name, error: failed.error })
        if (synced?.sentTo.length || chose?.sentTo.length || chose?.appliedHere) {
          const again = await attempt('machines', () => askMachines({ machinesReport: fleet.machinesReport, request: fleet.request }))
          if (again) machines = { ...again, at: now() }
        }
      }
      fleetProblems = problems
      await attempt('this computer', () => look())
    })()
    try { await asking } finally { asking = null }
  }

  const scheduleFleet = () => {
    clearTimeout(fleetTimer); fleetTimer = null
    if (!fleet || stopped) return
    fleetTimer = setTimeout(async () => { await tend(); scheduleFleet() }, clients.size ? fleetIntervalMs : idleFleetIntervalMs)
  }

  /**
   * The switch: on or off here now, then on every other machine that answers (its own daemon applies it
   * with this choice's time). A machine that cannot take it yet gets it at the next round after it can.
   */
  async function setDelivery(on) {
    // Later than any choice this pane knows of, on any machine: a click always outranks what came before.
    const known = newestChoice(local ?? {}, machines?.remotes ?? [], machines?.here)
    const at = Math.max(now(), (known?.at ?? 0) + 1)
    let here
    try { here = deliver(on ? 'on' : 'off', { env, home, choiceAt: at }) } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const sentTo = []
    const failed = []
    if (fleet && machines) {
      for (const remote of machines.remotes.filter((r) => r.snapshot)) {
        try { await fleet.request(remote.id, 'memory_deliver', { on, choiceAt: here.choiceAt }); sentTo.push(remote.name) }
        catch (error) { failed.push({ name: remote.name, error: error instanceof Error ? error.message : String(error) }) }
      }
    }
    await look()
    return { ok: here.results.every((r) => r.ok), on, results: here.results, sentTo, failed }
  }

  // Looks again only while a pane is open: a viewer nobody is watching reads nothing.
  const schedule = () => {
    clearTimeout(timer); timer = null
    if (stopped || clients.size === 0) return
    timer = setTimeout(async () => { await look(); schedule() }, intervalMs)
  }

  // This machine's id as the bridge names it: asked once, and again after a failure.
  let hereId = null
  async function thisMachine() {
    if (hereId) return hereId
    const report = await fleet.machinesReport()
    hereId = report?.machines?.find((machine) => machine.current)?.machineId ?? null
    return hereId
  }

  /**
   * Conversations, found by the same search as Cmd-P: the daemon's session index service (`session_search`),
   * so the same words find the same sessions in both. Measured on one Mac's 9,928 messages (2026-10-10), this
   * package's own search wanted every word in one turn, ranked tool output like what the person said, and
   * found nothing for a question ("what did i decide about pricing": one unrelated session); the daemon's
   * found twelve, from what the person asked. Its hits are labeled from the index here. The package's own
   * search stays for a daemon that cannot answer (none running, or too old) and for related conversations,
   * which want any of the words rather than all.
   */
  async function sessionSearch(text, options) {
    if (fleet && !options.any) {
      try {
        const here = await thisMachine()
        const answer = here ? await fleet.request(here, 'session_search', { query: text, limit: options.limit }, { timeoutMs: 5000 }) : null
        if (Array.isArray(answer?.hits)) return { hits: await labeled(answer.hits) }
      } catch { hereId = null }
    }
    const index = await sessionIndex(homes(env, home))
    if (!index.db) return { hits: [], error: index.error }
    try { return { hits: search(index.db, text, options) } } catch (error) { return { hits: [], error: String(error?.message ?? error) } }
  }

  /** The daemon's hits in this viewer's shape, titled and placed from the index. */
  async function labeled(hits) {
    const index = await sessionIndex(homes(env, home))
    let known = new Map()
    try { if (index.db) known = headings(index.db, hits.map((hit) => hit?.sessionId)) } catch { /* unlabeled is still found */ }
    return hits.filter((hit) => typeof hit?.sessionId === 'string').map((hit) => {
      const heading = known.get(hit.sessionId)
      return {
        sessionId: hit.sessionId, turn: Number.isInteger(hit.turn) ? hit.turn : -1, at: hit.at ?? hit.lastAt ?? null, engine: String(hit.engine ?? ''),
        title: String(hit.external?.title || heading?.title || heading?.header || ''), cwd: String(hit.external?.cwd || heading?.cwd || ''),
        snippet: String(hit.snippet ?? '').replace(/\s+/g, ' ').slice(0, 400),
      }
    })
  }

  /** What was said around where a search found a conversation: read from the index, never a transcript. */
  async function conversation(sessionId, turn) {
    const index = await sessionIndex(homes(env, home))
    if (!index.db) return { turns: [], error: index.error }
    try {
      const [heading] = headings(index.db, [sessionId]).values()
      return { sessionId, title: heading?.title || heading?.header || '', cwd: heading?.cwd ?? '', turns: around(index.db, sessionId, turn) }
    } catch (error) { return { turns: [], error: String(error?.message ?? error) } }
  }

  async function recentAsks() {
    const index = await sessionIndex(homes(env, home))
    if (!index.db) return { asks: [], error: index.error }
    try { return { asks: asks(index.db, { limit: ASKS_LIMIT, maxChars: ASKS_CHARS }) } } catch (error) { return { asks: [], error: String(error?.message ?? error) } }
  }

  const server = createServer(async (req, res) => {
    try {
      const address = server.address()
      const hosts = new Set([`127.0.0.1:${address?.port}`, `localhost:${address?.port}`, `[::1]:${address?.port}`])
      if (!hosts.has(req.headers.host)) { json(res, 403, { error: 'Loopback requests only.' }); return }
      const url = new URL(req.url, `http://${req.headers.host}`)
      if (req.headers.origin && req.headers.origin !== url.origin) { json(res, 403, { error: 'Cross-origin requests are not allowed.' }); return }
      // A page elsewhere cannot read these answers, but an <img> pointed at /events could hold the
      // connection slots open. Browsers say where a request comes from; only this page's own count.
      const site = req.headers['sec-fetch-site']
      if (site && site !== 'same-origin' && site !== 'none') { json(res, 403, { error: 'Only this pane may ask.' }); return }
      // The one write: the About You switch. Everything else in this pane only reads.
      if (req.method === 'POST' && url.pathname === '/api/deliver') {
        if (req.headers['x-memories-token'] !== token) { json(res, 403, { error: 'This pane did not mint that token.' }); return }
        let body = ''
        for await (const chunk of req) { body += chunk; if (body.length > 1024) { json(res, 413, { error: 'Too large.' }); return } }
        let wanted
        try { wanted = JSON.parse(body || '{}').on } catch { json(res, 400, { error: 'Send JSON.' }); return }
        if (typeof wanted !== 'boolean') { json(res, 400, { error: 'Say on: true or on: false.' }); return }
        json(res, 200, await setDelivery(wanted))
        return
      }
      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('allow', 'GET, HEAD, POST'); json(res, 405, { error: 'This pane only reads, but for its switch.' }); return }

      if (url.pathname === '/health') { json(res, 200, { ok: true }); return }
      if (url.pathname === '/api/state') {
        // With no pane connected nothing refreshes in the background, so a stale snapshot is re-read.
        if (!current || clients.size === 0 && now() - (current.observedAt ?? 0) > intervalMs) await look()
        json(res, 200, current)
        return
      }
      if (url.pathname === '/api/search') {
        const q = (url.searchParams.get('q') ?? '').slice(0, 200)
        json(res, 200, { q, ...(await sessionSearch(q, { limit: 20 })) })
        return
      }
      if (url.pathname === '/api/conversation') {
        const sessionId = (url.searchParams.get('sessionId') ?? '').slice(0, 200)
        const turn = Number.parseInt(url.searchParams.get('turn') ?? '', 10)
        json(res, 200, sessionId ? await conversation(sessionId, Number.isInteger(turn) ? turn : null) : { turns: [] })
        return
      }
      if (url.pathname === '/api/asks') {
        // Your own latest messages, the mist over the lake (viewer/memory-data.js). Takes no
        // parameters: how many and how long is fixed here.
        json(res, 200, { limit: ASKS_LIMIT, maxChars: ASKS_CHARS, ...(await recentAsks()) })
        return
      }
      if (url.pathname === '/api/related') {
        // Conversations that talk about the same thing as a memory: its title and description, any word.
        const row = (current ?? await look())?.memories.find((memory) => memory.id === url.searchParams.get('id'))
        if (!row) { json(res, 404, { error: 'No such memory.' }); return }
        const words = `${row.title} ${row.description}`.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []
        const query = [...new Set(words.filter((word) => !STOP.has(word)))].slice(0, 6).join(' ')
        json(res, 200, { id: row.id, ...(await sessionSearch(query, { limit: 6, any: true })) })
        return
      }
      if (url.pathname === '/events') {
        if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return }
        if (clients.size >= 16) { json(res, 503, { error: 'Too many viewer connections.' }); return }
        res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', connection: 'keep-alive', 'x-accel-buffering': 'no' })
        clients.add(res)
        res.on('close', () => { clients.delete(res); if (clients.size === 0) { clearTimeout(timer); timer = null } })
        await look()
        res.write(`event: snapshot\ndata: ${JSON.stringify(current)}\n\n`)
        if (!timer) schedule()
        // A pane just opened: the other machines now, not at the next idle round.
        if (fleet && (!machines || now() - machines.at > fleetIntervalMs)) { void tend().then(scheduleFleet) }
        return
      }

      const asset = ASSETS[url.pathname]
      if (!asset) { json(res, 404, { error: 'Not found' }); return }
      let content = await readFile(join(PACKAGE, 'viewer', asset[0]), 'utf8')
      // The token goes in a meta tag, not an inline script: the policy stays script-src 'self'.
      if (asset[0] === 'index.html') content = content.replace('__MEMORIES_TOKEN__', token).replace('__MEMORIES_INSTANCE__', instance)
      res.writeHead(200, {
        ...headers,
        'content-type': asset[1],
        // Memory files are written by models and may hold anything; the page renders them as text, and
        // this policy makes sure that even a rendering mistake cannot load or run anything.
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      })
      res.end(req.method === 'HEAD' ? undefined : content)
    } catch {
      if (!res.headersSent) json(res, 500, { error: 'The viewer could not serve this request.' }); else res.end()
    }
  })

  return {
    server,
    look,
    snapshot: () => current,
    tend,
    token,
    setDelivery,
    start: () => new Promise((ok, fail) => {
      server.once('error', fail)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', fail)
        void look().then(() => tend()).then(scheduleFleet)
        heartbeat = setInterval(() => { for (const client of clients) client.write(': pulse\n\n') }, 20_000)
        ok(server.address().port)
      })
    }),
    close: async () => {
      stopped = true; clearTimeout(timer); clearTimeout(fleetTimer); clearInterval(heartbeat)
      await looking?.catch(() => {})
      await asking?.catch(() => {})
      fleet?.close?.()
      for (const client of clients) client.end()
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
      closeIndex()
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const workspace = resolve(process.env.HARNESS_WORKSPACE || process.cwd())
  const port = Number(process.env.HARNESS_VIEWER_PORT || 0)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('HARNESS_VIEWER_PORT must be a port number.')
  const bridge = await import('./lib/bridge.mjs')
  const fleet = { machinesReport: () => bridge.machinesReport(), request: bridge.request, close: bridge.closeBridges }
  const viewer = createViewer({ workspace, port, fleet })
  console.log(`[memories] http://127.0.0.1:${await viewer.start()}/`)
  const close = () => viewer.close().then(() => process.exit(0))
  process.once('SIGINT', close); process.once('SIGTERM', close)
}
