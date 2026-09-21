/**
 * One row per harness, from every source that knows something about it.
 *
 * The daemon knows who the agents are, where their panes are and when their transcripts last moved.
 * tmux knows whether a pane is alive, dead or attached. The process table knows what the engine is
 * holding. This package's own state file knows what a person decided (pinned, paused). This module is
 * where those four become the single row shape that the policy, the table and the hps all read, and
 * it is the only place that decides what `state` means.
 *
 * Every machine's agents are listed — the local bridge relays `machine_select` to any machine the user
 * has linked — but pane and memory facts, and every action, are local to this computer. A remote row is
 * marked `local: false` and reads as what it is: seen, not managed from here.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname } from 'node:path'
import { lastTurns } from './activity.mjs'
import { listAgents, machines, withBridge } from './bridge.mjs'
import { engineProcess, panes, processTable } from './panes.mjs'
import { humanIdle } from './policy.mjs'
import { canResume } from './resume.mjs'
import { readRegistry, readStopped, registryAsFrames } from './registry.mjs'

/** Engines the daemon's `agent_resume` restores. Anything else it answers `RESUME_UNAVAILABLE`, so a running
 *  harness on another engine is never paused by this package: pausing it would strand its conversation. */
export const DAEMON_RESUMES = new Set(['claude', 'codex'])

const probes = new Map()
/**
 * Does this machine's daemon have `agent_resume`? Asked, not guessed from a version: a request with no id
 * gets `MISSING_AGENT_ID` from a daemon that has it and `UNSUPPORTED` from one that does not. Cached per
 * machine for a minute — a daemon that updates itself picks up the answer on the next refresh after that.
 */
export async function daemonResumes(machineId, { now = Date.now(), ask = withBridge } = {}) {
  const hit = probes.get(machineId)
  if (hit && now - hit.at < 60_000) return hit.value
  let value = false
  try { await ask(machineId, (rpc) => rpc('agent_resume', {}, { callTimeoutMs: 4000 })) }
  catch (error) { value = error?.code === 'MISSING_AGENT_ID' }
  probes.set(machineId, { at: now, value })
  return value
}

/** `runtime-v1:<agentId>:<engine>:<model>@<effort>` — the runtime profile's answer, as the daemon
 *  sends it. A plain model name (older daemons) is passed through untouched. */
export function parseModel(selected) {
  if (typeof selected !== 'string' || !selected) return { model: null, effort: null }
  const body = selected.startsWith('runtime-v1:') ? selected.split(':').slice(3).join(':') : selected
  const at = body.lastIndexOf('@')
  if (at <= 0) return { model: body || null, effort: null }
  return { model: body.slice(0, at) || null, effort: body.slice(at + 1) || null }
}

/** Working directories are shown relative to `~`: a fleet list is read by the person whose home it is,
 *  and the absolute prefix is the same eleven characters on every row. */
export function tilde(path, home = homedir()) {
  if (typeof path !== 'string' || !path) return ''
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

/** The project a row belongs to: the git root's name when there is one, else the folder's. Two agents
 *  in two worktrees of one repo are two projects, on purpose — that is how they are worked on. */
export function projectOf(agent) {
  const project = agent.project
  if (!project) return { project: 'unknown', cwd: '', branch: null, remote: null }
  const cwd = project.cwd || ''
  return {
    project: project.name || basename(project.root || cwd) || basename(dirname(cwd)) || 'unknown',
    cwd,
    branch: project.branch || null,
    remote: project.remote || null,
  }
}

/** The first of these that is a real moment in time. `Date.parse` answers NaN rather than null, which is
 *  exactly the value that must not reach an idle column, so it is filtered here and not by `??`. */
function firstTime(candidates, fallback) {
  for (const value of candidates) {
    const time = typeof value === 'string' ? Date.parse(value) : Number(value)
    if (Number.isFinite(time) && time > 0) return time
  }
  return fallback
}

/**
 * Merge one machine's agent frames with local pane and process facts.
 *
 * `state` is decided here and nowhere else:
 *   the pane is gone from tmux             → gone      (nothing to resume; history only)
 *   the pane is there and an engine is up   → running
 *   the pane is there, no engine, a ticket  → paused    (conversation intact, waiting to be resumed)
 *   the pane is there, no engine, no ticket → terminal  (a shell somebody opened; nothing to pause)
 * and that is the whole state machine. There is deliberately no fourth state: an earlier version had
 * `retired` as paused-plus-a-decision, and every consumer paid for it — a glyph, a filter, a verb, a
 * grace window — to express something a sorted list already expresses.
 *
 * ## Why a paused row needs the ticket to describe itself
 *
 * When an engine leaves, the daemon does not merely mark the row: it REWRITES it as a terminal. Measured
 * on a real pause, the row kept its `cwd` and lost everything else — `engine` became `terminal`,
 * `sessionId` became empty, `transcriptPath` and `title` became null. So a paused harness would appear in
 * Harness Monitor's own list as a nameless shell, and nothing would know which conversation to resume. The ticket
 * `pause()` wrote into `monitor.json` is the only record, and it is overlaid here.
 */
export function mergeRows(agents, { paneRows = new Map(), table = { byPid: new Map(), children: new Map() }, state = {}, machine = null, local = true, now = Date.now(), home = homedir(), turns = new Map(), registry = new Map(), stopped = new Map(), daemonResume = false } = {}) {
  const pauseTickets = state.paused ?? {}
  const pins = new Set(state.pins ?? [])
  return agents.map((agent) => {
    if (agent.status === 'stopped') return savedRow(agent, { machine, local, now, home, turns, stopped, pins })
    const pane = agent.tmuxPane && local ? paneRows.get(agent.tmuxPane) ?? null : null
    const ticket = pauseTickets[agent.id] ?? null
    // A paused row describes itself from its ticket: the daemon has already forgotten what it was.
    const engine = agent.engine === 'terminal' && ticket?.engine ? ticket.engine : agent.engine
    const sessionId = agent.sessionId || ticket?.sessionId || null
    const proc = local ? engineProcess(pane, table, engine) : { pid: null, rss: 0, cpu: 0, procs: 0, engineAlive: agent.status === 'active' }
    // The one number every rule depends on. `agent.updatedAt` is deliberately NOT in this list: it is
    // the transcript's mtime, which a live engine bumps with bookkeeping between turns (see
    // activity.mjs). Last turn, else the daemon's last hook, else when the agent was registered.
    const reg = registry.get(agent.id)
    const lastActivity = firstTime([turns.get(agent.id), reg?.lastHookAt, Date.parse(agent.createdAt)], now)
    const idleMs = Math.max(0, now - lastActivity)
    const { project, cwd, branch, remote } = projectOf(agent)
    // A remote row cannot be looked up in this machine's tmux, so its liveness is the daemon's word for
    // it. A local row's liveness is the process table — which is the stricter of the two and the one a
    // person can verify, so it wins whenever it is available.
    const present = local ? Boolean(pane) : agent.status !== 'gone'
    let stateName = !present ? 'gone' : proc.engineAlive ? 'running' : 'paused'
    // A shell somebody opened is not a paused agent: it has no conversation and nothing to resume, so it
    // is shown as what it is and left out of every rule.
    if (stateName === 'paused' && engine === 'terminal' && !ticket) stateName = 'terminal'
    const { model, effort } = parseModel(agent.selectedModel)
    // How this one would come back if it were paused — the question the policy and the Pause button both
    // have to answer before they touch it. The daemon path for the engines it restores; this package's own
    // typed resume only for a harness paused before the daemon could save one (its ticket says so).
    const resumeVia = stateName === 'paused' ? 'legacy'
      : daemonResume ? (DAEMON_RESUMES.has(engine) && sessionId ? 'daemon' : null)
        : (canResume(engine) && sessionId ? 'legacy' : null)
    return {
      id: agent.id,
      sessionId,
      name: agent.name || ticket?.title || 'agent',
      title: agent.title || ticket?.title || null,
      engine,
      model, effort,
      state: stateName,
      stateSince: stateName === 'paused' && ticket ? (ticket.at ?? lastActivity) : lastActivity,
      pausedAt: ticket?.at ?? null,
      pane: agent.tmuxPane || null,
      paneTarget: pane?.target ?? null,
      project, cwd, home: tilde(cwd, home), branch, remote,
      lastActivity, idleMs, idle: humanIdle(idleMs),
      createdAt: firstTime([agent.createdAt], null),
      attached: Boolean(pane?.attached),
      // Mid-turn, as far as anything outside the daemon can tell: the engine is burning CPU, or its
      // transcript moved in the last minute and a half. Both are proxies, and both are only ever used
      // to REFUSE to pause something — never to claim an agent is busy in the interface.
      working: local
        ? proc.cpu > 5 || idleMs < 90_000 || (pane?.lastOutput ? now - pane.lastOutput < 60_000 : false)
        : idleMs < 90_000,
      lastOutput: pane?.lastOutput ?? null,
      transcript: reg?.transcriptPath ?? null,
      needsInput: false,
      pinned: pins.has(agent.id),
      workspaceGone: Boolean(cwd) && local && !existsSync(cwd),
      rssBytes: proc.rss,
      procs: proc.procs,
      cpu: proc.cpu,
      enginePid: proc.pid,
      cwdWas: ticket?.cwd ?? null,
      dsh: agent.dsh ?? null,
      dshName: agent.dshName ?? null,
      verdict: agent.verdict?.ready === undefined ? null : Boolean(agent.verdict.ready),
      machine: machine?.name ?? 'this machine',
      machineId: machine?.machineId ?? null,
      local,
      dead: Boolean(pane?.dead),
      resumeVia,
      resumable: Boolean(resumeVia),
    }
  })
}

/**
 * A harness the daemon saved when its engine exited: `status: 'stopped'`, no pane, no process. Everything
 * but idle comes off the wire; idle comes from the saved record's own transcript, like every other row.
 */
function savedRow(agent, { machine, local, now, home, turns, stopped, pins }) {
  const record = stopped.get(agent.id)
  const lastActivity = firstTime([turns.get(agent.id), record?.lastHookAt, Date.parse(agent.updatedAt), Date.parse(agent.createdAt)], now)
  const idleMs = Math.max(0, now - lastActivity)
  const { project, cwd, branch, remote } = projectOf(agent)
  const { model, effort } = parseModel(agent.selectedModel)
  const resumable = DAEMON_RESUMES.has(agent.engine) && Boolean(agent.sessionId)
  // The daemon saves closed Terminal agents too. A shell has no conversation — "resuming" one opens a new
  // shell — so it is a shell here, not a paused harness, and it stays out of every rule and the default list.
  const shell = agent.engine === 'terminal'
  return {
    id: agent.id, sessionId: agent.sessionId || null,
    name: agent.name || 'agent', title: agent.title || null,
    engine: agent.engine, model, effort,
    state: shell ? 'terminal' : 'paused', stateSince: lastActivity, pausedAt: null,
    pane: null, paneTarget: null,
    project, cwd, home: tilde(cwd, home), branch, remote,
    lastActivity, idleMs, idle: humanIdle(idleMs),
    createdAt: firstTime([agent.createdAt], null),
    attached: false, working: false, lastOutput: null,
    transcript: record?.transcriptPath ?? null,
    needsInput: false, pinned: pins.has(agent.id),
    workspaceGone: Boolean(cwd) && local && !existsSync(cwd),
    rssBytes: 0, procs: 0, cpu: 0, enginePid: null, cwdWas: null,
    dsh: agent.dsh ?? null, dshName: agent.dshName ?? null, verdict: null,
    machine: machine?.name ?? 'this machine', machineId: machine?.machineId ?? null,
    local, dead: false,
    resumeVia: resumable && !shell ? 'daemon' : null,
    resumable: resumable && !shell,
    saved: true,
  }
}

/**
 * The whole fleet, from every machine that answers.
 *
 * Failures are per machine and reported, never fatal: a fleet view that refuses to draw because one
 * linked laptop is asleep is worse than one that says which machine it could not reach.
 */
export async function collect({ state = {}, now = Date.now(), includeRemote = true, timeoutMs = 8000, home = homedir(), cache = new Map() } = {}) {
  const [paneRows, table, machineList, registry, stopped] = await Promise.all([panes(), processTable(), machines(), readRegistry(), readStopped()])
  const transcripts = [
    ...registry.rows.map((row) => ({ id: row.agentId, transcriptPath: row.transcriptPath })),
    ...[...stopped.values()].map((row) => ({ id: row.agentId, transcriptPath: row.transcriptPath })),
  ]
  const turns = await lastTurns(transcripts, { cache })
  const current = machineList.find((m) => m.current) ?? null
  const targets = [current, ...(includeRemote ? machineList.filter((m) => !m.current && m.online) : [])].filter(Boolean)
  const problems = []
  let rows = []

  // No daemon, no `harness` on PATH: fall back to the registry file this machine already has. Seeing
  // the fleet must not depend on the app running, and pausing is pure tmux either way.
  if (!targets.length) {
    if (!registry.rows.length) problems.push({ machine: 'this machine', error: 'No Harness daemon on the local bridge and no registry to read.' })
    else problems.push({ machine: 'this machine', error: 'Read from the registry file — the Harness daemon is not answering, so models, branches and remote machines are missing.' })
    const rowsOffline = mergeRows(registryAsFrames(registry.rows), { paneRows, table, state, machine: null, local: true, now, home, turns, registry: registry.byId })
    rowsOffline.sort((a, b) => a.idleMs - b.idleMs || a.name.localeCompare(b.name))
    return { rows: rowsOffline, machines: machineList, problems, observedAt: now, degraded: true }
  }

  await Promise.all(targets.map(async (machine) => {
    try {
      const [agents, daemonResume] = await Promise.all([listAgents(machine.machineId, { timeoutMs }), daemonResumes(machine.machineId, { now })])
      rows = rows.concat(mergeRows(agents, { paneRows, table, state, machine, local: machine.current === true, now, home, turns, registry: registry.byId, stopped, daemonResume }))
    } catch (error) {
      problems.push({ machine: machine.name, error: error instanceof Error ? error.message : String(error) })
    }
  }))

  rows.sort((a, b) => a.idleMs - b.idleMs || a.name.localeCompare(b.name))
  return { rows, machines: machineList, problems, observedAt: now }
}

/** Totals a person reads before deciding anything: the gauge in the header and the CLI's last line. */
export function summarize(rows) {
  const by = (state) => rows.filter((row) => row.state === state).length
  return {
    total: rows.length,
    running: by('running'),
    paused: by('paused'),
    gone: by('gone'),
    terminals: by('terminal'),
    needsInput: rows.filter((row) => row.needsInput).length,
    working: rows.filter((row) => row.working && row.state === 'running').length,
    held: rows.reduce((sum, row) => sum + (row.rssBytes || 0), 0),
    projects: new Set(rows.map((row) => row.project)).size,
    machines: new Set(rows.map((row) => row.machine)).size,
  }
}

/**
 * Resolve what a person typed to exactly one row, or say why it is ambiguous.
 *
 * Accepted, in order: a row number from the last `ls`, a tmux pane id (`%42`), an agent-id prefix, an
 * exact name, then a unique case-insensitive substring of the name or title. The same grammar the shell
 * gave everyone for job control — `%3` is a pane here and a job there — so it needs no learning.
 */
export function resolveRef(ref, rows) {
  const text = String(ref ?? '').trim()
  if (!text) return { error: 'Name a harness: a row number, a %pane, an id, or part of its name.' }
  if (/^\d+$/.test(text)) {
    const row = rows[Number(text) - 1]
    return row ? { row } : { error: `There is no row ${text} — the list has ${rows.length}.` }
  }
  if (/^%\d+$/.test(text)) {
    const matches = rows.filter((row) => row.pane === text)
    return matches.length === 1 ? { row: matches[0] } : { error: `No harness is on pane ${text}.` }
  }
  const exactId = rows.filter((row) => row.id === text || row.id.startsWith(text))
  if (exactId.length === 1) return { row: exactId[0] }
  if (exactId.length > 1) return { error: `${text} matches ${exactId.length} agent ids. Use a longer prefix.` }
  const exactName = rows.filter((row) => row.name.toLowerCase() === text.toLowerCase())
  if (exactName.length === 1) return { row: exactName[0] }
  const needle = text.toLowerCase()
  const loose = rows.filter((row) => row.name.toLowerCase().includes(needle) || (row.title ?? '').toLowerCase().includes(needle))
  if (loose.length === 1) return { row: loose[0] }
  if (loose.length > 1) return { error: `${text} matches ${loose.length} harnesses: ${loose.slice(0, 5).map((row) => row.name).join(', ')}${loose.length > 5 ? '…' : ''}` }
  return { error: `No harness matches ${text}.` }
}
