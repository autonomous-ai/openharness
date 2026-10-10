/*
 * The one data source every prototype here reads: what the Memories viewer is given (its snapshot), plus
 * the person's own messages to their agents, plus search.
 *
 *   MemoryData.load()      → Promise<{ snapshot, asks, real }>
 *   MemoryData.search(q)   → Promise<hits>   hit: { at, engine, title, cwd, sessionId, turn, snippet }
 *                            snippet marks matches with \u0002 … \u0003 (as the viewer's /api/search does)
 *   MemoryData.refs(line, snapshot) → the memory rows an About You line cites
 *   MemoryData.agent(id, snapshot)  → { id, name, color }
 *
 * Opened as a file, or without ?real, it is an invented person on an invented computer (made here, below).
 * Served by serve.mjs and opened with ?real, it is this computer's own memories, read on request and
 * never written anywhere. A classic script, so the pages work from file:// too.
 *
 * Everything in here is untrusted text written by models and people: render it with textContent only.
 */
(function () {
  'use strict'
  const DAY = 86_400_000
  const real = /[?&]real\b/.test(location.search) && location.protocol.startsWith('http')

  // ── an invented person ───────────────────────────────────────────────────────────────────────────

  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  const AGENTS = [
    ['claude', 'Claude Code', '#d97757', true, 'on', 'Learns as you work, one folder per repository.'],
    ['codex', 'Codex', '#3fae8c', true, 'on', 'Learns in the background from idle conversations.'],
    ['grok', 'Grok Build', '#8a93a6', true, 'on', 'Keeps topics and observations, global and per workspace.'],
    ['gemini', 'Gemini CLI', '#4f8ef7', true, 'on', 'Saves what you ask it to remember into GEMINI.md.'],
    ['hermes', 'Hermes', '#d4a72c', true, 'on', 'Keeps a short profile of you and a notebook.'],
    ['pi', 'Pi', '#b07cd8', true, 'none', 'Reads your instructions; keeps no memory of its own.'],
    ['opencode', 'OpenCode', '#e0e0e0', true, 'none', 'Reads your instructions; keeps no memory of its own.'],
    ['openclaw', 'OpenClaw', '#e5534b', false, 'none', 'Keeps a workspace profile and daily notes.'],
    ['cursor', 'Cursor', '#7fb2ff', false, 'none', 'Memories live in its cloud, not on disk.'],
    ['copilot', 'Copilot', '#9aa4b2', false, 'none', 'Keeps no memory on disk.'],
    ['windsurf', 'Windsurf', '#36c5b0', false, 'unreadable', 'Keeps memories in a binary format.'],
  ]

  const PROJECTS = ['payments', 'widgets', 'docs-site', 'mobile-app', 'infra', 'ml-pipeline', 'design-system', 'api-gateway', 'cli', 'firmware', 'website']

  // [agent, project|null, kind, type, title, description, body]
  const NOTES = [
    ['claude', 'payments', 'you', 'feedback', 'Short answers', 'Wants replies under five lines', 'Keep replies short; lead with the answer.\n\n**Why:** asked for a tl;dr many times.\n**How to apply:** one paragraph, then stop.'],
    ['claude', 'payments', 'project', 'project', 'Webhook retries', 'Retries back off to one hour, then page', 'Webhook retries back off exponentially to one hour, then page the on-call.\n\n**Why:** a provider outage once retried 40k times in a minute.'],
    ['claude', 'payments', 'reference', 'reference', 'Ledger docs', 'Where the ledger design lives', 'The ledger design is in docs/ledger.md; the migration plan beside it.'],
    ['claude', 'payments', 'project', 'project', 'Refund flow', 'Partial refunds are allowed twice', 'A charge may be partially refunded at most twice; the third is a support ticket.'],
    ['claude', 'payments', 'you', 'feedback', 'Merge when green', 'Lands pull requests once CI passes', 'Merge green pull requests without asking.\n\n**Why:** waiting on a yes cost a day twice.'],
    ['claude', 'widgets', 'you', 'feedback', 'Tests first', 'Run the tests before saying done', 'Run `make test` before calling anything done.\n\n**Why:** "done" twice meant "compiles".'],
    ['claude', 'widgets', 'project', 'project', 'Legacy renderer', 'The legacy renderer is going away', 'New work targets the grid renderer only; the legacy one is frozen.'],
    ['claude', 'widgets', 'project', 'project', 'Snapshot tests', 'Grid snapshots live beside each widget', 'Snapshot tests sit next to each widget, regenerated with `make snap`.'],
    ['claude', 'widgets', 'you', 'feedback', 'Screenshots for UI', 'Reviews UI from screenshots', 'Send a screenshot with every UI change; review happens on the picture.'],
    ['claude', 'docs-site', 'you', 'user', 'Plain words', 'Writes docs in plain words', 'Prefers short sentences and no jargon in anything a reader sees.'],
    ['claude', 'docs-site', 'project', 'project', 'Deploys from main', 'Every merge to main publishes the site', 'The docs site deploys on every merge to main; previews per pull request.'],
    ['claude', 'docs-site', 'reference', 'reference', 'Style guide', 'The house style guide', 'The style guide is at docs/style.md: sentence case, no exclamation marks.'],
    ['claude', 'mobile-app', 'you', 'feedback', 'Mockup first', 'Agree on a mockup before UI code', 'Show a mockup and agree on it before writing UI code.\n\n**Why:** two screens were rebuilt from scratch.'],
    ['claude', 'mobile-app', 'project', 'project', 'Release train', 'Releases go out on Tuesdays', 'The app ships on Tuesdays; never on a Friday.'],
    ['claude', 'mobile-app', 'project', 'project', 'Crash on resume', 'Resume crash fixed by restoring the session first', 'The resume crash came from reading the session before it was restored.'],
    ['claude', 'infra', 'project', 'project', 'Staging certs', 'Certificates rotate every 60 days', 'Staging certificates rotate every 60 days by the cron in infra/certs.'],
    ['claude', 'infra', 'you', 'feedback', 'No weekend deploys', 'Merge on weekends, deploy on Monday', 'Merges may land over the weekend; deploys wait for Monday.'],
    ['claude', 'infra', 'reference', 'reference', 'Runbooks', 'Where the runbooks are', 'Runbooks are in the ops wiki under On-call.'],
    ['claude', 'ml-pipeline', 'project', 'project', 'Ranker evals', 'The eval set is frozen per quarter', 'The ranker eval set is frozen each quarter so scores stay comparable.'],
    ['claude', 'ml-pipeline', 'you', 'feedback', 'Measure first', 'Wants numbers before a change', 'Measure before and after any performance change, on the same workload.'],
    ['claude', 'ml-pipeline', 'project', 'project', 'Tokenizer regression', 'A tokenizer upgrade broke emoji', 'The tokenizer upgrade split emoji; pinned until the fix ships.'],
    ['claude', 'design-system', 'project', 'project', 'Token rename', 'Color tokens renamed by role', 'Color tokens are named by role (surface, text, accent), not by hue.'],
    ['claude', 'design-system', 'you', 'feedback', 'Keyboard first', 'Every action needs a key', 'Every action must be reachable from the keyboard; mouse is optional.'],
    ['claude', 'design-system', 'you', 'user', 'Terminal taste', 'Likes the feel of vim, tmux and fzf', 'Draws on vim, tmux and fzf for how tools should feel: quiet, fast, typed.'],
    ['claude', 'api-gateway', 'project', 'project', 'Rate limits', 'Limits are per key, not per IP', 'Rate limits apply per API key; IP limits only for anonymous traffic.'],
    ['claude', 'api-gateway', 'reference', 'reference', 'OpenAPI diff', 'CI fails on a breaking API change', 'CI runs an OpenAPI diff and fails on breaking changes.'],
    ['claude', 'cli', 'you', 'feedback', 'Small core', 'Keep the core small and stable', 'Features go in services the core can run without.\n\n**Why:** a feature crash once took every session down.'],
    ['claude', 'cli', 'project', 'project', 'Release from main', 'Releases are cut from main only', 'Every release is cut from main by the release script; tags are never moved.'],
    ['claude', 'cli', 'you', 'feedback', 'Why comments', 'Comments say why, not what', 'Comments name the incident or the measurement behind the code.'],
    ['claude', 'firmware', 'project', 'project', 'Flash over USB', 'The dial flashes over USB-C', 'The dial flashes over USB-C; hold the knob to enter the bootloader.'],
    ['claude', 'firmware', 'reference', 'reference', 'Pin map', 'Where the pin map lives', 'The pin map is in firmware/board.md.'],
    ['claude', 'website', 'you', 'feedback', 'Speed matters', 'Pages should feel instant', 'Every page should feel instant; measure the first paint.'],
    ['claude', 'website', 'project', 'project', 'Launch copy', 'The launch page copy is final', 'The launch copy is signed off; change only typos.'],
    ['claude', null, 'instructions', 'CLAUDE.md', 'CLAUDE.md for every project', 'Rules', 'Always run the tests before saying done.\nNever push to main directly.'],
    ['codex', null, 'summary', 'summary v1', 'What Codex keeps about you', 'Summary', 'Prefers small pull requests with one change each. Works late. Asks why before agreeing to a design.'],
    ['codex', null, 'summary', 'handbook v1', 'Testing', 'Handbook', 'Run `make test` first; integration tests only when the change touches the network.'],
    ['codex', null, 'summary', 'handbook v1', 'Reviews', 'Handbook', 'One change per pull request; review while CI runs.'],
    ['codex', null, 'summary', 'handbook v1', 'Releases', 'Handbook', 'Releases are cut on Mondays; a failed release is fixed forward.'],
    ['codex', null, 'you', 'remembered on request', 'Use pnpm', 'Remembered on request', 'Use pnpm, not npm.'],
    ['codex', null, 'note', 'conversation summary', 'Fixed the login bug', 'Conversation summary', 'The token expired early because the clock skew was not allowed for.'],
    ['codex', null, 'note', 'conversation summary', 'Sped up the search index', 'Conversation summary', 'Search got 8x faster by ranking before building snippets.'],
    ['codex', null, 'note', 'conversation summary', 'Mobile onboarding', 'Conversation summary', 'Onboarding went from four steps to one by scanning a code.'],
    ['grok', null, 'you', 'topic', 'Code style', 'Topic', 'Two-space indentation everywhere; no semicolons in new JavaScript.'],
    ['grok', 'api-gateway', 'project', 'topic', 'Gateway build', 'Topic', 'The gateway builds with Bazel; cache on the build box.'],
    ['grok', null, 'note', 'observation', 'Asked for dark mode twice', 'Observation', 'Asked twice for a dark mode in the docs site.'],
    ['grok', null, 'note', 'observation', 'Prefers diagrams', 'Observation', 'Understands a design faster from a diagram than from prose.'],
    ['gemini', null, 'you', 'saved', 'Prefers tabs in Go files', 'Saved', 'Prefers tabs in Go files'],
    ['gemini', null, 'you', 'saved', 'Lives in UTC+1', 'Saved', 'Lives in UTC+1'],
    ['gemini', null, 'you', 'saved', 'Reads on a large monitor', 'Saved', 'Reads on a large monitor; wide tables are fine.'],
    ['hermes', null, 'you', 'profile', 'Prefers terse answers.', 'Profile', 'Prefers terse answers.'],
    ['hermes', null, 'you', 'profile', 'Works late in the evening.', 'Profile', 'Works late in the evening.'],
    ['hermes', null, 'you', 'profile', 'Hands work off overnight.', 'Profile', 'Hands work off overnight and reads a summary in the morning.'],
    ['hermes', null, 'note', 'notes', 'Postgres 16', 'Notes', 'The main database is Postgres 16.'],
    ['pi', null, 'instructions', 'AGENTS.md', 'AGENTS.md for every project', 'Rules', 'Keep diffs small.'],
  ]

  const ABOUT = [
    ['How you work', 'Works mostly in Codex and Claude Code, side by side.', ['asks:1480']],
    ['How you work', 'Gives UI feedback with screenshots.', ['asks:212', 'claude:screenshots-for-ui.md']],
    ['How you work', 'Hands work off overnight and reads a summary in the morning.', ['asks:64', 'hermes:USER.md']],
    ['How you work', 'Asks "why" before agreeing to a design.', ['asks:41', 'codex:memory_summary.md']],
    ['How you work', 'Thinks in diagrams more than prose.', ['grok:prefers-diagrams.md']],
    ['What you want from agents', 'Short answers that lead with the result.', ['claude:short-answers.md', 'hermes:USER.md', 'asks:98']],
    ['What you want from agents', 'Tests run before anything is called done.', ['claude:tests-first.md', 'codex:MEMORY.md']],
    ['What you want from agents', 'Green pull requests merged without asking.', ['claude:merge-when-green.md', 'asks:106']],
    ['What you want from agents', 'A mockup agreed before UI code.', ['claude:mockup-first.md']],
    ['What you want from agents', 'One change per pull request.', ['codex:memory_summary.md', 'codex:MEMORY.md']],
    ['Taste', 'Wants tools to feel like vim, tmux and fzf: quiet, fast, typed.', ['claude:terminal-taste.md', 'asks:126']],
    ['Taste', 'Every action reachable from the keyboard.', ['claude:keyboard-first.md']],
    ['Taste', 'Pages that feel instant.', ['claude:speed-matters.md', 'asks:111']],
    ['Taste', 'Plain words; no jargon.', ['claude:plain-words.md']],
    ['Taste', 'Two-space indentation, tabs in Go.', ['grok:code-style.md', 'gemini:GEMINI.md']],
    ['Engineering principles', 'A small, stable core; features as services.', ['claude:small-core.md']],
    ['Engineering principles', 'Measure before and after any performance change.', ['claude:measure-first.md']],
    ['Engineering principles', 'Comments say why, naming the incident.', ['claude:why-comments.md']],
    ['Engineering principles', 'Merge on weekends, deploy on Monday.', ['claude:no-weekend-deploys.md', 'codex:MEMORY.md']],
    ['Right now', 'Shipping the mobile onboarding in one step.', ['codex:mobile-onboarding.md', 'asks:58']],
    ['Right now', 'Freezing the ranker eval set for the quarter.', ['claude:ranker-evals.md']],
    ['Right now', 'Retiring the legacy renderer.', ['claude:legacy-renderer.md']],
  ]

  const SAYINGS = {
    payments: ['why do webhook retries pile up after an outage?', 'make the refund flow handle a third partial refund', 'walk me through the ledger migration', 'add a test for the retry backoff', 'tldr the incident from last night'],
    widgets: ['the grid flickers on resize, fix it', 'regenerate the snapshots and show me the diff', 'drop the legacy renderer from the build', 'why is this widget re-rendering twice?', 'screenshot the empty state'],
    'docs-site': ['rewrite the quickstart in plain words', 'find every broken link', 'add a dark mode to the docs', 'make the search box faster', 'shorter, please'],
    'mobile-app': ['onboarding in one step: scan a code', 'the app crashes on resume, find out why', 'mockup the settings screen first', 'release notes for 1.4', 'make the swipe feel instant'],
    infra: ['rotate the staging certs', 'why did the deploy hang at 90%?', 'write the runbook for a failed migration', 'terraform drift report', 'no deploys this weekend'],
    'ml-pipeline': ['freeze the eval set for this quarter', 'measure the ranker before and after', 'the tokenizer splits emoji now', 'backfill the features for September', 'plot the regression'],
    'design-system': ['rename the color tokens by role', 'every action needs a keyboard shortcut', 'audit the icon set', 'make it feel like fzf', 'contrast check in light mode'],
    'api-gateway': ['rate limit per key, not per IP', 'add the OpenAPI diff to CI', 'why is p99 latency up?', 'cache the auth lookups', 'one change per pull request'],
    cli: ['keep this out of the core', 'why did the daemon restart?', 'cut a release from main', 'comments should say why', 'merge it once CI is green'],
    firmware: ['flash the dial over USB', 'the knob skips steps when turned fast', 'update the pin map', 'measure the battery drain overnight', 'why does it reboot on wake?'],
    website: ['make the landing page load instantly', 'the launch copy is final, only typos', 'compress the hero video', 'add the pricing table', 'check it on a phone'],
  }

  function invented(now) {
    const random = rng(20261010)
    const pick = (list) => list[Math.floor(random() * list.length)]
    const home = '~'
    const slug = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const memories = NOTES.map(([agent, project, kind, type, title, description, body], i) => {
      const file = agent === 'claude' ? (kind === 'instructions' ? '~/.claude/CLAUDE.md' : `~/.claude/projects/-home-you-code-${project}/memory/${slug(title)}.md`)
        : agent === 'codex' ? (type === 'summary v1' ? '~/.codex/memories/memory_summary.md' : type === 'handbook v1' ? '~/.codex/memories/MEMORY.md' : `~/.codex/memories/${slug(title)}.md`)
        : agent === 'gemini' ? '~/.gemini/GEMINI.md' : agent === 'hermes' ? (kind === 'you' ? '~/.hermes/memories/USER.md' : '~/.hermes/memories/MEMORY.md')
        : agent === 'pi' ? '~/.pi/agent/AGENTS.md' : `~/.grok/memory-v2/global/topics/${slug(title)}.md`
      return {
        id: `${agent}:${file}#${i}`, agent, kind, type, scope: project ? 'project' : 'global',
        project: project ? { name: project, path: `~/code/${project}` } : null,
        title, description, body, path: file,
        modified: now - Math.floor(random() * 110 + 0.5) * DAY - Math.floor(random() * DAY), size: body.length,
      }
    })
    const asks = []
    const sessions = new Map()
    for (let day = 0; day < 120; day++) {
      const date = new Date(now - day * DAY)
      const weekend = date.getDay() === 0 || date.getDay() === 6
      const holiday = day >= 50 && day < 57
      const count = holiday ? 0 : weekend ? Math.floor(random() * 6) : 6 + Math.floor(random() * 22)
      for (let n = 0; n < count; n++) {
        const project = PROJECTS[Math.floor(Math.pow(random(), 1.6) * PROJECTS.length)]
        const engine = random() < 0.72 ? 'codex' : random() < 0.85 ? 'claude' : pick(['grok', 'hermes'])
        const sessionId = `s-${project}-${Math.floor(day / 5)}-${engine}`
        const at = now - day * DAY - Math.floor(random() * DAY * 0.6)
        const title = `${project}: ${pick(SAYINGS[project]).replace(/[?.,]+$/, '')}`
        if (!sessions.has(sessionId)) sessions.set(sessionId, { title, engine, cwd: `~/code/${project}`, lastAt: at, firstAt: at, asks: 0 })
        const session = sessions.get(sessionId)
        session.asks++; session.lastAt = Math.max(session.lastAt, at); session.firstAt = Math.min(session.firstAt, at)
        asks.push({ at, engine, cwd: session.cwd, title: session.title, sessionId, turn: session.asks - 1, text: pick(SAYINGS[project]), length: 40 })
      }
    }
    asks.sort((a, b) => b.at - a.at)
    const dayKey = (at) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
    const activityMap = new Map()
    for (const ask of asks) { const key = `${dayKey(ask.at)} ${ask.engine}`; activityMap.set(key, (activityMap.get(key) ?? 0) + 1) }
    const activity = [...activityMap].map(([key, count]) => ({ day: key.split(' ')[0], engine: key.split(' ')[1], asks: count })).sort((a, b) => a.day.localeCompare(b.day))
    const engineRows = AGENTS.map(([id]) => id).map((engine) => {
      const own = [...sessions.values()].filter((s) => s.engine === engine)
      return { engine, sessions: own.length, asks: own.reduce((sum, s) => sum + s.asks, 0), lastAt: Math.max(0, ...own.map((s) => s.lastAt)), firstAt: Math.min(now, ...own.map((s) => s.firstAt)) }
    }).filter((row) => row.sessions)
    const folders = PROJECTS.map((project) => {
      const own = [...sessions.values()].filter((s) => s.cwd === `~/code/${project}`)
      const engines = {}
      for (const s of own) engines[s.engine] = (engines[s.engine] ?? 0) + 1
      return { cwd: `~/code/${project}`, sessions: own.length, asks: own.reduce((sum, s) => sum + s.asks, 0), lastAt: Math.max(0, ...own.map((s) => s.lastAt)), engines }
    })
    const projects = folders.map((folder) => {
      const name = folder.cwd.split('/').pop()
      return { key: `/home/you/code/${name}`, name, path: folder.cwd, memories: memories.filter((m) => m.project?.name === name).map((m) => m.id), sessions: folder.sessions, asks: folder.asks, engines: folder.engines, lastAt: folder.lastAt }
    })
    const lines = ABOUT.map(([section, text, refs]) => ({ section, text, refs }))
    const sections = [...new Set(lines.map((l) => l.section))]
    const aboutText = ['# About you', '', `Built from ${asks.length.toLocaleString('en-US')} of your messages over the last 120 days.`, '',
      ...sections.flatMap((section) => [`## ${section}`, ...lines.filter((l) => l.section === section).map((l) => `- ${l.text} [${l.refs.join(', ')}]`), ''])].join('\n')
    const agents = AGENTS.map(([id, name, color, present, memory, says]) => ({
      id, name, color, present, home: `~/.${id}`, memory, where: '', says,
      memories: memories.filter((m) => m.agent === id && m.kind !== 'instructions').length,
      instructions: memories.filter((m) => m.agent === id && m.kind === 'instructions').length,
      unreadable: id === 'windsurf' ? 3 : 0, sessions: engineRows.find((row) => row.engine === id)?.sessions ?? 0,
    }))
    const snapshot = {
      spec: 1, observedAt: now, memories, agents,
      about: { text: aboutText, modified: now - 3 * 3600_000, gen: now - 3 * 3600_000, intro: `Built from ${asks.length.toLocaleString('en-US')} of your messages over the last 120 days.`, lines },
      aboutPath: '~/.harness/memory/about-you.md',
      delivery: { on: true, choseOff: false, choiceAt: now - 5 * DAY, tokens: 412, built: true, agents: ['claude', 'codex', 'grok', 'gemini'].map((agent) => ({ agent, file: '', delivered: true, current: true })) },
      projects,
      sessions: { sessions: sessions.size, asks: asks.length, firstAt: Math.min(...asks.map((a) => a.at)), engines: engineRows, activity, folders },
      sessionsError: null, problems: [],
      machines: [
        { id: 'studio', name: 'studio', here: true, state: 'ok', memories: memories.length },
        { id: 'laptop', name: 'laptop', here: false, state: 'ok', memories: 14 },
        { id: 'build-box', name: 'build-box', here: false, state: 'offline' },
      ],
    }
    return { snapshot, asks, real: false }
  }

  // ── search and references ────────────────────────────────────────────────────────────────────────

  const words = (text) => String(text).toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []

  function inventedSearch(asks, q) {
    const terms = words(q)
    if (!terms.length) return []
    const seen = new Set()
    const hits = []
    for (const ask of asks) {
      const lower = ask.text.toLowerCase()
      if (!terms.every((term) => lower.includes(term)) || seen.has(ask.sessionId)) continue
      seen.add(ask.sessionId)
      let snippet = ask.text
      for (const term of terms) snippet = snippet.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `\u0002${m}\u0003`)
      hits.push({ at: ask.at, engine: ask.engine, title: ask.title, cwd: ask.cwd, sessionId: ask.sessionId, turn: ask.turn, snippet })
      if (hits.length >= 24) break
    }
    return hits
  }

  /** The memory rows an About You line cites, e.g. "claude:short-answers.md" → that note. */
  function refs(line, snapshot) {
    const found = []
    for (const ref of line.refs ?? []) {
      const [agent, name] = ref.split(':')
      if (!name || agent === 'asks' || agent === 'session') continue
      const base = name.replace(/\.md$/, '')
      for (const row of snapshot.memories) {
        if (row.agent !== agent) continue
        const file = row.path.split('/').pop().replace(/\.md$/, '').replace(/#.*$/, '')
        const titled = row.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        if (file === base || titled === base) found.push(row)
      }
    }
    return [...new Set(found)]
  }

  function agent(id, snapshot) {
    const row = snapshot?.agents?.find((a) => a.id === id)
    return row ? { id, name: row.name, color: row.color } : { id, name: id, color: '#8b8f96' }
  }

  let loaded = null
  async function load() {
    if (loaded) return loaded
    if (!real) { loaded = invented(Date.now()); return loaded }
    const [snapshot, asks] = await Promise.all([
      fetch('/real/snapshot').then((r) => r.json()),
      fetch('/real/asks').then((r) => r.json()),
    ])
    loaded = { snapshot, asks: asks.asks ?? [], real: true }
    return loaded
  }

  async function search(q) {
    if (!String(q).trim()) return []
    if (!real) return inventedSearch((await load()).asks, q)
    const answer = await fetch(`/real/search?q=${encodeURIComponent(q)}`).then((r) => r.json())
    return answer.hits ?? []
  }

  window.MemoryData = { load, search, refs, agent, real, DAY }
})()
