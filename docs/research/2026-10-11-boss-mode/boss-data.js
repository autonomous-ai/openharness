/*
 * The one data source every Boss Mode prototype reads: the desk as ⌘B's office would keep it.
 *
 *   BossData.load()          → Promise<desk>
 *   BossData.subscribe(fn)   → fn(desk, event) after every change; returns an unsubscribe
 *   BossData.needsYou(d)     → why a dispatch needs the person — 'asking' | 'failed' | 'undelivered' |
 *                              'ready' (finished, not yet looked at) — or null
 *   BossData.markSeen(id) / BossData.unseen(id)   the person picked a finished one up, or put it back
 *   BossData.engine(id) · BossData.ago(ms) · BossData.clock(at) · BossData.STATES
 *
 * desk = {
 *   now, real, source, notes: [string],
 *   machines:   [{ id, name, here, online, since, os }]
 *   harnesses:  [{ id, machine, engine, name, project, state, since, createdAt, lastTurnAt, tokens,
 *                  question, summary, turns: [{ at, by: 'you' | 'agent', size }], boss: bool }]
 *   dispatches: [{ id, n, at, text, via, decision: { kind, p, runnerUp, why, ms, cost }, harness, machine,
 *                  created, landedAt, state, since, seenAt, question, summary, pr, history: [{ at, state }] }]
 * }
 * The model is the one README.md describes: what the Boss Mode harness would keep.
 *
 * Opened as a file, or without ?real, it is an invented person's desk, made below, that keeps moving: tasks
 * finish, ask, and new ones arrive (?still holds it). Served by serve.mjs and opened with ?real, it is this
 * computer's own desk, read on request and never written anywhere. A classic script, so pages work from
 * file:// too.
 *
 * Everything in here is untrusted text written by models and people: render it with textContent only.
 */
(function () {
  'use strict'
  const MIN = 60_000
  const HOUR = 3_600_000
  const served = location.protocol.startsWith('http')
  const real = /[?&]real\b/.test(location.search) && served
  const still = /[?&]still\b/.test(location.search)

  const ENGINES = {
    claude: { name: 'Claude Code', short: 'Claude', call: 'CLAUDE', color: '#d97757' },
    codex: { name: 'Codex', short: 'Codex', call: 'CODEX', color: '#3fae8c' },
    gemini: { name: 'Gemini CLI', short: 'Gemini', call: 'GEMINI', color: '#4f8ef7' },
    grok: { name: 'Grok Build', short: 'Grok', call: 'GROK', color: '#8a93a6' },
    opencode: { name: 'OpenCode', short: 'OpenCode', call: 'OPEN', color: '#c8c8c8' },
    hermes: { name: 'Hermes', short: 'Hermes', call: 'HERMES', color: '#d4a72c' },
    pi: { name: 'Pi', short: 'Pi', call: 'PI', color: '#b07cd8' },
  }
  const engine = (id) => ENGINES[id] ?? { name: id || 'agent', short: id || 'agent', call: String(id || 'AGENT').toUpperCase().slice(0, 6), color: '#8b8f96' }

  /** Every state a dispatch or a harness can be in, and whether it is the person's to act on. */
  const STATES = {
    routing: { label: 'Routing', word: 'deciding where it goes' },
    working: { label: 'Working', word: 'working' },
    asking: { label: 'Needs you', word: 'asking you', needs: true },
    done: { label: 'Done', word: 'finished' },
    failed: { label: 'Failed', word: 'failed', needs: true },
    undelivered: { label: 'Not sent', word: 'went nowhere', needs: true },
    offline: { label: 'Out of reach', word: 'on a machine that is asleep' },
    stopped: { label: 'Stopped', word: 'stopped' },
    idle: { label: 'Quiet', word: 'quiet' },
  }

  function needsYou(d) {
    if (!d) return null
    if (d.state === 'asking') return 'asking'
    if (d.state === 'failed') return 'failed'
    if (d.state === 'undelivered') return 'undelivered'
    if (d.state === 'done' && !d.seenAt) return 'ready'
    return null
  }

  function ago(ms) {
    if (!(ms >= 0)) return ''
    if (ms < 45_000) return 'now'
    if (ms < HOUR) return `${Math.round(ms / MIN)}m`
    if (ms < 36 * HOUR) { const h = Math.floor(ms / HOUR), m = Math.round((ms % HOUR) / MIN); return m && h < 10 ? `${h}h${String(m).padStart(2, '0')}` : `${Math.round(ms / HOUR)}h` }
    return `${Math.round(ms / (24 * HOUR))}d`
  }
  const clock = (at) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

  // ── what the person has picked up, kept in this browser only ───────────────────────────────────────

  const SEEN_KEY = 'boss-mode-seen-v1'
  function readSeen() { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {} } catch { return {} } }
  function writeSeen(map) { try { localStorage.setItem(SEEN_KEY, JSON.stringify(map)) } catch { /* private window: it lasts the visit */ } }
  let seenMap = readSeen()

  // ── an invented person's desk ──────────────────────────────────────────────────────────────────────

  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  const MACHINES = [
    ['studio', 'studio', true, 'macOS', null],
    ['build-box', 'build-box', false, 'Linux', null],
    ['laptop', 'laptop', false, 'macOS', 10.9],
  ]

  // [id, machine, engine, project, name, created h ago, state when nothing ⌘B sent changed it]
  const HARNESSES = [
    ['h-certs', 'build-box', 'codex', 'infra', 'Staging certs', 46, 'idle'],
    ['h-swipe', 'studio', 'claude', 'mobile-app', 'Swipe feel', 48, 'idle'],
    ['h-grid', 'studio', 'claude', 'widgets', 'Grid snapshots', 30, 'idle'],
    ['h-backfill', 'build-box', 'codex', 'ml-pipeline', 'Feature backfill', 40, 'idle'],
    ['h-resume', 'studio', 'claude', 'mobile-app', 'Resume crash', 26, 'idle'],
    ['h-rate', 'studio', 'codex', 'api-gateway', 'Rate limits', 28, 'idle'],
    ['h-tokens', 'studio', 'claude', 'design-system', 'Color tokens', 50, 'idle'],
    ['h-incident', 'studio', 'claude', 'payments', 'Incident review', 20, 'idle'],
    // Started by hand (⌘N), never through ⌘B: on the desk, not in the office's book.
    ['h-daemon', 'studio', 'codex', 'cli', 'Daemon restarts', 6.2, 'working'],
    ['h-copy', 'laptop', 'claude', 'website', 'Launch copy', 23, 'offline'],
    ['h-onboard', 'studio', 'claude', 'mobile-app', 'Onboarding in one step', 4.4, 'idle'],
  ]

  // [n, h ago, text, via, harness | {new harness}, p, runner-up [name, p] | null, state, state h ago, seen, words]
  // words: the summary of a finished task, the question of an asking one, what went wrong in a failed one.
  const N = (id, machine, engine, project, name) => ({ id, machine, engine, project, name })
  const DISPATCHES = [
    [1, 21.3, 'rotate the staging certs', 'box', 'h-certs', 0.88, ['new work', 0.07], 'done', 20.6, true,
      'Rotated the staging certificates; the next rotation is due in 60 days.'],
    [2, 18.7, 'add a dark mode to the docs', 'box', N('h-darkdocs', 'studio', 'claude', 'docs-site', 'Docs dark mode'), 0.81, ['Broken links', 0.06], 'stopped', 17.9, true,
      'Stopped by you after the first pass.'],
    [3, 17.2, 'make the swipe feel instant', 'voice', 'h-swipe', 0.66, ['Resume crash', 0.21], 'done', 16.1, true,
      'Swipes now start on touch-down instead of after 80 ms. PR #871.'],
    [4, 16.4, 'drop the legacy renderer from the build', 'box', N('h-legacy', 'studio', 'codex', 'widgets', 'Drop legacy renderer'), 0.74, ['Grid snapshots', 0.19], 'done', 14.9, false,
      'Removed it; the bundle is 84 KB lighter. Two tests leaned on it and were rewritten. PR #874.'],
    [5, 15.8, 'run the full eval on the new ranker and write up the numbers by morning', 'box', N('h-eval', 'build-box', 'codex', 'ml-pipeline', 'Ranker v7 eval'), 0.83, ['Feature backfill', 0.11], 'done', 10.2, false,
      'v7 beats v6 on 11 of 12 slices; recall@10 is up 2.3 points. The write-up is in docs/evals/v7.md. PR #877.'],
    [6, 15.2, 'migrate the ledger tables to the new schema on staging, stop if any row count differs', 'box', N('h-ledger', 'build-box', 'claude', 'payments', 'Ledger migration'), 0.9, ['Incident review', 0.05], 'asking', 9.1, false,
      'Row counts differ on ledger_entries by 14 rows, all soft-deleted. Skip them, or stop as you said?'],
    [7, 14.6, 'regenerate every widget snapshot against the grid renderer', 'box', 'h-grid', 0.71, ['Drop legacy renderer', 0.18], 'done', 13.0, false,
      'Regenerated 214 snapshots. Three changed for real: the tooltip moved 2 px. PR #876.'],
    [8, 13.9, 'find every broken link on the docs site and fix them', 'box', N('h-links', 'studio', 'codex', 'docs-site', 'Broken links'), 0.77, ['Docs dark mode', 0.12], 'done', 12.7, false,
      'Fixed 37 links. Four point at pages that no longer exist; they are listed in the PR. PR #878.'],
    [9, 13.1, 'backfill the features for September', 'box', 'h-backfill', 0.64, ['new work', 0.22], 'failed', 11.4, false,
      'Out of disk on /data at 61% (1–19 September). Nothing is half-written; it can resume from the 20th once there is room.'],
    [10, 12.4, 'measure the battery drain overnight with the dial asleep', 'voice', N('h-battery', 'laptop', 'claude', 'firmware', 'Battery drain'), 0.71, ['new work', 0.12], 'offline', 10.9, false,
      'Last heard measuring: 4.1 mA asleep after 90 minutes.'],
    [11, 11.0, 'write the runbook for a failed migration', 'box', N('h-runbook', 'studio', 'claude', 'infra', 'Failed-migration runbook'), 0.69, ['Ledger migration', 0.2], 'done', 9.8, false,
      'ops/runbooks/failed-migration.md, with the rollback tried once on staging.'],
    [12, 5.3, 'cut a release from main', 'box', null, null, null, 'undelivered', 5.3, false,
      'Nothing was sent: Jev could not be reached (the network was down).'],
    [13, 3.4, 'plot the regression', 'box', 'h-eval', 0.47, ['Feature backfill', 0.18], 'done', 2.9, false,
      'Plotted recall@10 by slice; the only regression is long queries, down 0.4. The chart is in the write-up.'],
    [14, 2.8, 'the app crashes on resume, find out why', 'box', 'h-resume', 0.58, ['Swipe feel', 0.24], 'working', 2.8, false, null],
    [15, 2.5, 'rate limit per key, not per IP', 'box', 'h-rate', 0.77, ['Incident review', 0.08], 'done', 1.6, true,
      'Limits are per API key now; anonymous traffic is still limited per IP. PR #879.'],
    [16, 2.1, 'make the landing page load instantly', 'box', N('h-landing', 'studio', 'codex', 'website', 'Landing speed'), 0.8, ['Launch copy', 0.09], 'asking', 1.3, false,
      'The hero video is 14 MB. Swap it for a poster frame and load the video late, or compress it to about 2 MB?'],
    [17, 1.7, 'rename the color tokens by role', 'box', 'h-tokens', 0.69, ['new work', 0.14], 'working', 1.7, false, null],
    [18, 1.4, 'why is p99 latency up?', 'voice', N('h-p99', 'build-box', 'codex', 'api-gateway', 'p99 latency'), 0.62, ['Rate limits', 0.3], 'working', 1.4, false, null],
    [19, 1.1, 'merge it once CI is green', 'box', 'h-rate', 0.61, ['p99 latency', 0.2], 'done', 0.9, true,
      'Merged #879 after CI passed.'],
    [20, 0.9, 'add the pricing table', 'box', N('h-pricing', 'studio', 'claude', 'website', 'Pricing table'), 0.72, ['Landing speed', 0.2], 'working', 0.9, false, null],
    [21, 0.6, 'terraform drift report', 'box', N('h-drift', 'build-box', 'codex', 'infra', 'Terraform drift'), 0.66, ['Staging certs', 0.25], 'done', 0.25, false,
      'Two resources drifted: an S3 lifecycle rule and a security group. The plan is attached; nothing was applied.'],
    [22, 0.45, 'update the pin map for the v2 board', 'box', N('h-pins', 'studio', 'claude', 'firmware', 'Pin map v2'), 0.79, ['Battery drain', 0.12], 'asking', 0.3, false,
      'The v2 schematic has two pins named BTN_A. Which is the knob’s push switch: GPIO4 or GPIO21?'],
    [23, 0.3, 'tldr the incident from last night', 'box', 'h-incident', 0.62, ['Ledger migration', 0.21], 'done', 0.22, false,
      'A provider outage retried webhooks 40k times in a minute; retries now back off to one hour. No money moved twice.'],
    [24, 0.12, 'audit the icon set for missing sizes', 'box', N('h-icons', 'studio', 'codex', 'design-system', 'Icon audit'), 0.7, ['Color tokens', 0.22], 'working', 0.12, false, null],
  ]

  // What happens next while the page is open: [seconds after load, event]
  const SCRIPT = [
    [9, { dispatch: [25, 'freeze the eval set for this quarter', 'box', 'h-eval', 0.64, ['Feature backfill', 0.14]] }],
    [24, { finish: 'h-tokens', words: 'Renamed 48 tokens by role; the old names stay as aliases for one release. PR #884.' }],
    [41, { ask: 'h-resume', words: 'Found it: the session is read before it is restored. Fix it in the app, or in the SDK (which three other apps use)?' }],
    [60, { dispatch: [26, 'compress the hero video to about 2 MB', 'box', 'h-landing', 0.71, ['Pricing table', 0.12]] }],
    [82, { finish: 'h-p99', words: 'p99 rose with the new auth lookup: 38 ms a request, uncached. Caching it brings p99 back to 210 ms. PR #885.' }],
    [104, { ask: 'h-icons', words: '17 icons have no 16 px size. Draw them, or scale the 24 px ones down for now?' }],
    [126, { dispatch: [27, 'add a test for the retry backoff', 'voice', N('h-backoff', 'studio', 'claude', 'payments', 'Retry backoff test'), 0.76, ['Incident review', 0.17]] }],
    [150, { finish: 'h-pricing', words: 'Three tiers, monthly and yearly; a screenshot is in the PR. PR #886.' }],
    [176, { finish: 'h-eval', words: 'The eval set for Q4 is frozen at 12,480 queries; its hash is in evals/FROZEN.' }],
  ]

  const ID = (n) => `d${String(n).padStart(2, '0')}`

  function invented(now) {
    const random = rng(20261011)
    const machines = MACHINES.map(([id, name, here, os, asleep]) => ({ id, name, here, os, online: asleep == null, since: asleep == null ? null : now - asleep * HOUR }))
    const harnesses = new Map()
    const make = ([id, machine, eng, project, name, created, state]) => {
      const h = { id, machine, engine: eng, name, project, state, since: now - created * HOUR, createdAt: now - created * HOUR, lastTurnAt: null, tokens: 0, question: null, summary: null, turns: [], boss: false }
      harnesses.set(id, h)
      return h
    }
    for (const row of HARNESSES) make(row)

    /** Turns between two moments: bursts of agent turns with the person now and then, as work looks. */
    function play(h, from, to, { density = 1, you = 0.08 } = {}) {
      let t = from
      while (t < to) {
        const burst = 2 + Math.floor(random() * 7 * density)
        for (let i = 0; i < burst && t < to; i++) {
          h.turns.push({ at: t, by: random() < you ? 'you' : 'agent', size: Math.round(200 + Math.pow(random(), 2) * 5200) })
          t += (20 + random() * 140) * 1000
        }
        t += (4 + random() * 38) * MIN / density
      }
    }
    // What the harnesses did before the night's handoffs, so the desk has a past.
    for (const h of harnesses.values()) play(h, h.createdAt, Math.min(now - 18 * HOUR, h.createdAt + (1 + random() * 3) * HOUR), { density: 0.6, you: 0.18 })

    const dispatches = DISPATCHES.map(([n, h0, text, via, target, p, runnerUp, state, s0, seen, words]) => {
      const at = now - h0 * HOUR
      let h = null
      if (target && typeof target === 'object') h = make([target.id, target.machine, target.engine, target.project, target.name, h0 - 0.0002, 'idle'])
      else if (target) h = harnesses.get(target)
      const ms = Math.round(520 + random() * 260)
      const decision = !h
        ? { kind: 'none', p: null, runnerUp: null, why: words, ms: 8000, cost: 0 }
        : { kind: typeof target === 'object' ? 'new' : 'session', p, runnerUp: runnerUp ? { name: runnerUp[0], p: runnerUp[1] } : null, ms, cost: 0.000142 + random() * 0.00005,
          why: typeof target === 'object' ? `new work in ${h.project}, with ${engine(h.engine).short}` : `the same work on the same subject as “${h.name}”` }
      const since = now - s0 * HOUR
      const d = {
        id: ID(n), n, at, text, via, decision, harness: h?.id ?? null, machine: h?.machine ?? null, created: typeof target === 'object',
        landedAt: h ? at + ms : null, state, since, seenAt: seen ? since + 12 * MIN : null,
        question: state === 'asking' ? words : null, summary: state === 'done' || state === 'stopped' || state === 'offline' ? words : null,
        error: state === 'failed' || state === 'undelivered' ? words : null,
        pr: (words && /PR #(\d+)/.exec(words)?.[1]) ?? null,
        history: [{ at, state: 'routing' }, ...(h ? [{ at: at + ms, state: 'working' }] : []), ...(state !== 'working' ? [{ at: since, state }] : [])],
      }
      if (h) {
        h.boss = true
        h.turns.push({ at: at + ms, by: 'you', size: text.length * 4 })
        const end = state === 'working' ? now : since
        play(h, at + ms + 40_000, end, { density: state === 'working' ? 1.3 : 1, you: 0.04 })
        h.state = state === 'undelivered' ? h.state : state
        h.since = since
        h.question = d.question
        h.summary = d.summary ?? d.error
      }
      return d
    })
    // The hand-started ones keep busy, the way they do.
    const daemon = harnesses.get('h-daemon')
    play(daemon, daemon.createdAt, now, { density: 1.1, you: 0.2 })
    daemon.since = daemon.createdAt
    const onboard = harnesses.get('h-onboard')
    play(onboard, onboard.createdAt, now - 2.2 * HOUR, { density: 0.9, you: 0.2 })
    onboard.since = now - 2.2 * HOUR
    const copy = harnesses.get('h-copy')
    copy.since = now - 10.9 * HOUR

    for (const h of harnesses.values()) {
      h.turns.sort((a, b) => a.at - b.at)
      h.tokens = h.turns.reduce((sum, t) => sum + t.size * 9, 0)
      h.lastTurnAt = h.turns.at(-1)?.at ?? h.createdAt
    }
    return {
      now, real: false, source: 'an invented desk',
      notes: [],
      machines, harnesses: [...harnesses.values()], dispatches,
    }
  }

  // ── the invented desk keeps moving ─────────────────────────────────────────────────────────────────

  let desk = null
  const listeners = new Set()
  const emit = (event) => { for (const fn of listeners) { try { fn(desk, event) } catch (error) { console.error(error) } } }

  function harnessOf(id) { return desk.harnesses.find((h) => h.id === id) }

  function startSimulation() {
    const random = rng(1011)
    const started = Date.now()
    let next = 0
    setInterval(() => {
      const now = Date.now()
      desk.now = now
      // Working harnesses take turns.
      for (const h of desk.harnesses) {
        if (h.state !== 'working' || random() > 0.32) continue
        const size = Math.round(200 + Math.pow(random(), 2) * 5200)
        h.turns.push({ at: now, by: 'agent', size }); h.tokens += size * 9; h.lastTurnAt = now
        emit({ type: 'turn', harness: h.id })
      }
      while (next < SCRIPT.length && (now - started) / 1000 >= SCRIPT[next][0]) run(SCRIPT[next++][1], now)
      emit({ type: 'tick' })
    }, 1000)

    function latestFor(hid) { return desk.dispatches.filter((d) => d.harness === hid).sort((a, b) => b.at - a.at)[0] }
    function settle(h, state, words, now) {
      h.state = state; h.since = now
      h.question = state === 'asking' ? words : null
      h.summary = state === 'done' ? words : h.summary
      const d = latestFor(h.id)
      if (d && d.state === 'working') {
        d.state = state; d.since = now; d.history.push({ at: now, state })
        if (state === 'asking') d.question = words; else d.summary = words
        d.pr = /PR #(\d+)/.exec(words)?.[1] ?? null
      }
      emit({ type: state, harness: h.id, dispatch: d?.id })
    }
    function run(event, now) {
      if (event.finish) settle(harnessOf(event.finish), 'done', event.words, now)
      if (event.ask) settle(harnessOf(event.ask), 'asking', event.words, now)
      if (event.dispatch) {
        const [n, text, via, target, p, runnerUp] = event.dispatch
        const created = typeof target === 'object'
        const d = {
          id: ID(n), n, at: now, text, via, decision: { kind: 'routing', p: null, runnerUp: null, why: '', ms: 0, cost: 0 },
          harness: null, machine: null, created, landedAt: null, state: 'routing', since: now, seenAt: null,
          question: null, summary: null, error: null, pr: null, history: [{ at: now, state: 'routing' }],
        }
        desk.dispatches.push(d)
        emit({ type: 'dispatch', dispatch: d.id })
        // Jev answers in about 0.6 s; then the words land.
        setTimeout(() => {
          const at = Date.now()
          let h = created ? null : harnessOf(target)
          if (created) {
            h = { id: target.id, machine: target.machine, engine: target.engine, name: target.name, project: target.project, state: 'working', since: at, createdAt: at, lastTurnAt: at, tokens: 0, question: null, summary: null, turns: [], boss: true }
            desk.harnesses.push(h)
          }
          // A task sent to a harness that was asking answers it: that question is settled.
          for (const old of desk.dispatches) if (old.harness === h.id && old.state === 'asking') { old.state = 'done'; old.since = at; old.seenAt = at; old.summary = `Answered by #${n}.`; old.history.push({ at, state: 'done' }) }
          for (const old of desk.dispatches) if (old.harness === h.id && old.state === 'done' && !old.seenAt) { old.seenAt = at }
          const ms = at - now
          d.decision = { kind: created ? 'new' : 'session', p, runnerUp: runnerUp ? { name: runnerUp[0], p: runnerUp[1] } : null, ms, cost: 0.000161,
            why: created ? `new work in ${h.project}, with ${engine(h.engine).short}` : `the same work on the same subject as “${h.name}”` }
          d.harness = h.id; d.machine = h.machine; d.landedAt = at; d.state = 'working'; d.since = at
          d.history.push({ at, state: 'working' })
          h.state = 'working'; h.since = at; h.question = null; h.boss = true
          h.turns.push({ at, by: 'you', size: text.length * 4 }); h.lastTurnAt = at
          emit({ type: 'landed', dispatch: d.id, harness: h.id })
        }, 640)
      }
    }
  }

  // ── your own desk, through serve.mjs ───────────────────────────────────────────────────────────────

  async function fetchReal() {
    const answer = await fetch('/real/desk', { cache: 'no-store' })
    if (!answer.ok) throw new Error((await answer.json().catch(() => ({}))).error ?? `The server answered ${answer.status}.`)
    return answer.json()
  }

  function startPolling() {
    setInterval(async () => {
      try {
        const fresh = await fetchReal()
        applySeen(fresh)
        // Keep the same object, so a page holding `desk` sees the new rows.
        Object.assign(desk, fresh)
        emit({ type: 'refresh' })
      } catch (error) { emit({ type: 'error', error: String(error?.message ?? error) }) }
      desk.now = Date.now()
      emit({ type: 'tick' })
    }, 5000)
  }

  /** On your desk, what this view cannot know, said once in a corner: ⌘B keeps no record of its sends. */
  function notice(d) {
    const box = document.createElement('div')
    box.setAttribute('role', 'note')
    box.style.cssText = 'position:fixed;left:16px;top:52px;max-width:min(520px,calc(100% - 32px));z-index:90;padding:9px 12px;border:1px solid rgba(255,255,255,.12);border-radius:4px;background:rgba(10,10,12,.92);color:#b9bcc2;font:11.5px/1.5 ui-monospace,Menlo,monospace;transition:opacity .8s;pointer-events:none'
    const head = document.createElement('div')
    head.style.cssText = 'color:#e8e1d0;margin-bottom:3px'
    head.textContent = `Your desk, read only: ${d.dispatches.length} handoffs in 36 h, ${d.dispatches.filter((x) => x.via === 'box').length} of them through ⌘B.`
    box.append(head)
    for (const line of d.notes.slice(0, 5)) box.append(Object.assign(document.createElement('div'), { textContent: `· ${line}` }))
    document.body.append(box)
    setTimeout(() => { box.style.opacity = '0' }, 14000)
    setTimeout(() => box.remove(), 15000)
  }

  function applySeen(d) {
    for (const row of d.dispatches) if (seenMap[row.id]) row.seenAt = seenMap[row.id] === -1 ? null : seenMap[row.id]
  }

  let loading = null
  function load() {
    loading ??= (async () => {
      desk = real ? await fetchReal() : invented(Date.now())
      applySeen(desk)
      if (real) notice(desk)
      if (!still) (real ? startPolling : startSimulation)()
      return desk
    })()
    return loading
  }

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }

  function markSeen(id) {
    const d = desk?.dispatches.find((row) => row.id === id)
    if (!d) return
    d.seenAt = Date.now()
    seenMap[id] = d.seenAt; writeSeen(seenMap)
    emit({ type: 'seen', dispatch: id })
  }
  function unseen(id) {
    const d = desk?.dispatches.find((row) => row.id === id)
    if (!d) return
    d.seenAt = null
    seenMap[id] = -1; writeSeen(seenMap)
    emit({ type: 'unseen', dispatch: id })
  }

  /** The harness a dispatch landed in, and the dispatches a harness took. */
  const harness = (id) => desk?.harnesses.find((h) => h.id === id) ?? null
  const machine = (id) => desk?.machines.find((m) => m.id === id) ?? null

  window.BossData = { load, subscribe, needsYou, markSeen, unseen, engine, harness, machine, ago, clock, STATES, real, still, served, MIN, HOUR }
})()
