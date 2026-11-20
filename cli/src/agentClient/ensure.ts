/**
 * `harness ensure` (#4393): a program's own harness for an engine, kept across its tasks. The live one its token owns by
 * that name, else the closed one opened again with its conversation, else a new one started by `harness new` itself.
 * The daemon is started first when it is down (lib/programDaemon.ts, through `daemonUp`). A new verb: nothing without
 * it changes.
 */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { engineName } from '../messages/model.js'
import {
  EXIT, exactly, inspect, list, named, opened, programOf, refuseAgentWithToken, resumedAgent, run, STARTING_MS, UsageError, wantsJson, words,
  type ClientDeps, type Opened, type Screen, type Setup,
} from './commands.js'
import { AgentClientError, type Daemon } from './daemon.js'
import { outsideCaller, stateOf, type Frame } from './model.js'
import type { AgentEngine } from '../engines/types.js'

import { PROGRAM_TOKEN_FLAG, withProgramLock, type ProgramHarness } from './program.js'

export const ENSURE_USAGE = `Usage: harness ensure <engine> --name <name> ${PROGRAM_TOKEN_FLAG} <path> [--local <dir>] [--fresh] [<folder>] [--json]

One call that keeps a program's own harness (#4393): the live one by that name and token, else the closed one opened
again with its conversation (OpenClaw keeps its --session key, Hermes its resume id), else a new one, started exactly as
harness new starts it. --fresh closes the one there is and starts a new conversation. A name held by a harness without
that token is refused NAME_TAKEN. Two ensures of one name at once make one harness.
The token file is 0600, yours, and holds 32 or more bytes; the token never reaches the harness's terminal.
--json answers {"result":"live"|"resumed"|"new","id","name","engine","engineSession",
"state":"idle"|"working"|"starting"|"stopped","confirmed"?,"why"?,"whyCode"?}: "state" is the one read last; a resumed
one is watched up to 15 s and "confirmed" says whether its engine was seen up. "why" says why a conversation could not
go on, and "whyCode" names it: ENGINE_SESSION_GONE (the engine no longer holds the conversation, so a new one was started),
HARNESS_GONE (the harness is gone from this computer), ENGINE_EXITED (its engine stopped right after it was opened).
Then give it words with harness reply <name> ${PROGRAM_TOKEN_FLAG} <path> -- <words>.
Exit status: 0 ok, 5 refused (NAME_TAKEN, NOT_YOURS, BAD_TOKEN_FILE), 1 failed.
This computer only.`

export interface EnsureDeps extends ClientDeps {
  /** Starts a harness as `harness new` does with [argv] (`--json` among them): its exit code and the lines it printed. */
  create: (argv: string[]) => Promise<{ code: number; lines: string[] }>
  /** Brings this computer's daemon up when it is down, for a program (contract E, #4393): whether it started it and how
   *  long that took. Absent: a daemon that is down is said, as every verb says it. */
  daemonUp?: () => Promise<{ started: boolean; ms: number }>
  /** Whether a live harness's engine still runs: true, false (its pane is gone, or no engine runs in it), or null when
   *  that cannot be told. `engineRuns` when left out. */
  engineAlive?: (frame: Frame) => Promise<boolean | 'pane-gone' | null>
  /** Whether OpenClaw's Gateway holds session [key]: true, false, or null when it cannot be asked. `gatewayHolds` when
   *  left out. */
  sessionHeld?: (key: string) => Promise<boolean | null>
}

type EnsureResult = 'live' | 'resumed' | 'new'
type EnsureState = 'idle' | 'working' | 'starting' | 'stopped'
/** Why a conversation could not go on, for a program to act on. */
type WhyCode = 'ENGINE_SESSION_GONE' | 'HARNESS_GONE' | 'ENGINE_EXITED'

/** What the engine resumes the conversation by: OpenClaw's `--session` key, Hermes's session id; null before it has one. */
function engineSession(frame: Frame): string | null {
  if (frame.sessionId) return frame.sessionId
  // The full key OpenClaw names it by (`--session harness-<id>` makes `agent:main:harness-<id>`), as the bound row says it.
  return frame.engine === 'openclaw' ? `agent:main:harness-${frame.id}` : null
}

export function ensureCommand(argv: readonly string[], deps: EnsureDeps): Promise<number> {
  return run(ENSURE_USAGE, deps, wantsJson, argv, async (s) => {
    const { names, flags, machine } = words(argv, { '--name': 'value', [PROGRAM_TOKEN_FLAG]: 'value', '--local': 'value', '--fresh': 'flag', '--json': 'flag' })
    if (machine !== null) throw new UsageError('harness ensure keeps a harness on this computer: leave out --machine.')
    if (!names.length || names.length > 2) throw new UsageError(names.length ? 'Name the engine, then at most one folder.' : 'Name the engine: harness ensure openclaw --name <name> …')
    const name = String(flags.get('--name') ?? '').trim()
    if (!name) throw new UsageError('Name the harness: --name <name>.')
    if (!flags.has(PROGRAM_TOKEN_FLAG)) throw new UsageError(`A program's harness is proven by its token: ${PROGRAM_TOKEN_FLAG} <path>.`)
    const [engine, folder] = names
    const json = flags.has('--json')
    const began = s.now()
    // The token read, and an agent outside Harness refused, before anything is started for them.
    const p = programOf(flags, s.where().dataDir)!
    refuseAgentWithToken({ caller: outsideCaller(s.env, ''), orphan: false } as Opened)
    const up = deps.daemonUp ? await deps.daemonUp() : { started: false, ms: 0 }
    const o = await opened(s)
    try {
      refuseAgentWithToken(o)
      // Waited for past the longest a holder takes: a close (60 s), a busy resume (BUSY_WAIT_MS) and its start (STARTING_MS).
      return await withProgramLock(o.where.dataDir, name, async () => {
        // Read again under the lock: an ensure that held it before may have made the harness.
        o.frames = await list(o.daemon, true)
        o.stopped = true
        const frames = named(o.frames)
        const byId = new Map(frames.map((f) => [f.id, f]))
        // Never pruned from this one read: a harness being resumed, or one the stopped list leaves out, is missing from it
        // for a moment. One not listed is asked to resume like a closed one; only the daemon's AGENT_NOT_FOUND lets it go.
        const mine = p.records.named(name, p.hash).map((record) => ({ record,
          frame: byId.get(record.agentId) ?? { id: record.agentId, name: record.name, engine: record.engine, status: 'stopped' } as Frame }))
        const other = mine.find((x) => x.record.engine !== engine && x.frame.status !== 'stopped')
        if (other) {
          throw new AgentClientError('NAME_TAKEN', `"${name}" is your ${engineName(other.record.engine)} harness. Close it (harness close ${name} ${PROGRAM_TOKEN_FLAG} <path>) before keeping a ${engineName(engine)} one by that name.`)
        }
        const same = mine.filter((x) => x.record.engine === engine)
        const held = frames.find((f) => f.status !== 'stopped' && exactly(name)(f) && !same.some((x) => x.frame.id === f.id))
        if (!same.length && held) throw new AgentClientError('NAME_TAKEN', `"${name}" is held by a harness this token does not own. Choose another name.`)
        const live = same.find((x) => x.frame.status !== 'stopped')
        const say = async (result: EnsureResult, frame: Frame, why?: { text: string; code: WhyCode }, settled?: Settled): Promise<number> => {
          // The state read last, never one assumed: a resumed harness whose engine exited is said stopped (#4484).
          const state: EnsureState = settled?.state ?? await stateNow({ daemon: o.daemon, frame }, p.records.get(frame.id))
          const answer = { result, id: frame.id, name, engine, engineSession: engineSession(frame), state,
            ...(result === 'resumed' ? { confirmed: settled?.confirmed ?? false } : {}),
            ...(why ? { why: why.text, whyCode: why.code } : {}),
            ...(up.started ? { daemonStarted: true, daemonStartMs: up.ms } : {}) }
          s.out(json ? JSON.stringify(answer) : `${name}: ${result}${why ? ` (${why.text})` : ''} · ${engineName(engine)} · ${state} · ${s.now() - began} ms`)
          return EXIT.ok
        }
        // Live by its row, and its engine checked: the daemon learns of an engine killed, or of its pane gone, only on a
        // later pass, and a program told "live" then has its next reply refused NOT_RUNNING.
        const runs = live && !flags.has('--fresh') && live.frame.launch?.state !== 'starting' ? await (deps.engineAlive ?? engineRuns)(live.frame) : null
        // No engine found in a pane that is still there is believed only while the row says it is not working: a caller
        // that cannot see the engine's process (another namespace, hidepid) must not close it mid-turn.
        const dead = !!live && (runs === 'pane-gone' || (runs === false && stateOf(live.frame) !== 'working'))
        if (live && !flags.has('--fresh') && !dead) return say('live', live.frame)
        if (live && dead) {
          // Its stale row closed first, so the resume below is a closed harness's, as on any later pass. A row the daemon
          // would not close would be found live by the resume, which would then start nothing: said, nothing started.
          const closed = await o.daemon.request('agent_close', { agentId: live.frame.id, sessionId: live.frame.sessionId ?? '', createdAt: live.frame.createdAt ?? '', mode: 'now' }, 60_000)
            .catch((error: unknown) => ({ error: error instanceof AgentClientError ? error.code : 'FAILED' }))
          if (closed.error) {
            throw new AgentClientError('ENGINE_NOT_READY', `${name}'s engine has stopped, and Harness could not close it yet (${String(closed.error)}); nothing was started. Try harness ensure again.`)
          }
        } else if (live) {
          const closed = await o.daemon.request('agent_close', { agentId: live.frame.id, sessionId: live.frame.sessionId ?? '', createdAt: live.frame.createdAt ?? '', mode: 'now' }, 60_000)
          if (closed.error) throw new AgentClientError(String(closed.error), `${name} could not be closed for a fresh start (${String(closed.error)}).`)
        }
        // Closed: opened again with its conversation, unless a fresh one is asked for.
        const closedOne = flags.has('--fresh') ? undefined : dead ? live : same[0]
        if (closedOne) {
          // A conversation its engine no longer holds is never resumed: OpenClaw's TUI would print "No session found" and
          // exit, and every later ensure would open it again for ever (#4484). Unknown (no Gateway to ask) is no answer.
          const key = engine === 'openclaw' && !flags.has('--local') ? engineSession(closedOne.frame) : null
          const gone = async () => !!key && await (deps.sessionHeld ?? gatewayHolds)(key) === false
          if (await gone()) return sessionGone(closedOne.frame, key!, false)
          const resumed = await resumeWhileBusy(s, o, closedOne.frame, name)
          if (!(resumed instanceof AgentClientError) || resumed.code === 'RESUME_UNCONFIRMED') {
            const frame = resumed instanceof AgentClientError ? closedOne.frame : resumed.frame
            p.records.started(closedOne.frame.id, s.now())
            const settled = await settle(frame, !(resumed instanceof AgentClientError))
            if (settled.state === 'stopped') {
              // Its engine exited at once. Gone from the engine's store, the conversation is let go and a new one started;
              // otherwise it is said stopped, and the next ensure tries it again.
              if (await gone()) return sessionGone(frame, key!, true)
              return say('resumed', frame, { text: 'its engine stopped right after it was opened again', code: 'ENGINE_EXITED' }, settled)
            }
            return resumed instanceof AgentClientError || resumed.resumed
              ? say('resumed', frame, undefined, settled)
              : say('new', frame, { text: `${engineName(engine)} could not resume the earlier conversation: the same harness runs in a new one`, code: 'ENGINE_SESSION_GONE' }, settled)
          }
          // Only a harness that can never be opened again is let go: its record gone, or its conversation. Anything else
          // (a launch that failed, a folder not there just now) is said, and the next ensure tries it again: a new
          // harness in its place would lose the conversation for good.
          if (!GONE_FOR_GOOD.has(resumed.code)) throw resumed
          p.records.forget(closedOne.frame.id)
          return created({ text: `the earlier harness could not be opened again (${resumed.message})`,
            code: resumed.code === 'AGENT_NOT_FOUND' ? 'HARNESS_GONE' : 'ENGINE_SESSION_GONE' })
        }
        // A fresh start forgets the old one as the program's: it stays closed, and the name is the new one's.
        for (const x of same) p.records.forget(x.frame.id)
        return created()

        /** [frame] just opened again, watched until its engine is seen up (its pane idle, working or asking) or SETTLE_MS
         *  pass: stopped when its row or its engine is gone meanwhile. A resume the daemon confirmed whose engine still
         *  runs when the watch ends is confirmed too: on a slow machine (a lamp's arm64) OpenClaw's TUI is not drawn
         *  within 15 s, yet the engine that would have exited ("No session found") has stayed up the whole time. */
        async function settle(frame: Frame, daemonConfirmed: boolean): Promise<Settled> {
          const until = s.now() + SETTLE_MS
          for (;;) {
            const now = (await list(o.daemon, true).catch(() => [] as Frame[])).find((f) => f.id === frame.id)
            if (now?.status === 'stopped') return { state: 'stopped', confirmed: false }
            const current = now ?? frame
            const runs = current.launch?.state === 'starting' ? null : await (deps.engineAlive ?? engineRuns)(current)
            if (runs === false || runs === 'pane-gone') return { state: 'stopped', confirmed: false }
            const { screen } = await inspect({ daemon: o.daemon, frame: current })
            const up = screen === 'idle' || screen === 'working' || screen === 'needs-input'
            if (up || s.now() >= until) {
              return { state: stateFrom(screen, current, p.records.get(frame.id)), confirmed: up || (daemonConfirmed && runs === true) }
            }
            // Never past SETTLE_MS by a step: a program's own timeout is close behind it.
            await s.sleep(Math.min(SETTLE_STEP_MS, until - s.now()))
          }
        }

        /** [frame]'s conversation gone from OpenClaw's Gateway: what is left of its row closed when [close], the record let
         *  go, and a new harness started by the same name and token. */
        async function sessionGone(frame: Frame, key: string, close: boolean): Promise<number> {
          if (close) {
            await o.daemon.request('agent_close', { agentId: frame.id, sessionId: frame.sessionId ?? '', createdAt: frame.createdAt ?? '', mode: 'now' }, 60_000)
              .catch(() => undefined)
          }
          p.records.forget(frame.id)
          return created({ text: `${engineName(engine)} no longer holds the earlier conversation (${key}): a new one was started`, code: 'ENGINE_SESSION_GONE' })
        }

        async function created(why?: { text: string; code: WhyCode }): Promise<number> {
          const local = flags.get('--local')
          const made = await deps.create([engine, ...(folder ? [folder] : []), '--name', name, PROGRAM_TOKEN_FLAG, p.file,
            ...(typeof local === 'string' ? ['--local', local] : []), '--json'])
          const line = made.lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown> } catch { return null } }).find((x) => x) ?? null
          if (made.code !== 0 || !line || line.ok !== true) {
            const code = typeof line?.code === 'string' ? line.code : 'FAILED'
            const detail = typeof line?.error === 'string' ? line.error : made.lines.join(' ').trim() || 'The harness could not be started.'
            throw new AgentClientError(code, detail)
          }
          const agent = (line.agent ?? {}) as Frame
          // Recorded by harness new; written here when it could not be, so the harness just made stays the program's.
          if (agent.id && !p.records.get(agent.id)) {
            try {
              p.records.put({ agentId: agent.id, tokenHash: p.hash, name, engine: agent.engine ?? engine, createdAt: s.now(), startedAt: s.now(), inputs: [],
                ...(typeof local === 'string' ? { local: resolve(local) } : {}) })
            }
            catch { /* said by harness new already */ }
          }
          return say('new', { ...agent, engine: agent.engine ?? engine }, why)
        }
      }, LOCK_WAIT_MS)
    } finally { o.daemon.close() }
  })
}

/** A resume refusal that no later try can change: the harness is gone from this machine, or its conversation is. */
const GONE_FOR_GOOD: ReadonlySet<string> = new Set(['AGENT_NOT_FOUND', 'RESUME_UNAVAILABLE'])
/** How long an ensure waits for another of the same name: longer than a holder can take. */
const LOCK_WAIT_MS = 10 * 60_000
/** How long ensure tries a resume again while the last engine is still stopping (AGENT_BUSY), and how often. */
export const BUSY_WAIT_MS = 30_000
const BUSY_STEP_MS = 1_000
/** How long ensure watches a resumed harness for its engine to stay up, and how often: under 20 s, so a program's own
 *  timeout of 30 s holds (#4484). */
export const SETTLE_MS = 15_000
const SETTLE_STEP_MS = 1_000

/** A resumed harness as last read: its state, and whether its engine was seen up. */
interface Settled { state: EnsureState; confirmed: boolean }

/**
 * The closed harness opened again, tried again every second while the daemon answers AGENT_BUSY: its last engine is
 * still exiting, or the process table could not be read (lib/resumeStoppedAgent.ts `canLaunch`), both for a moment.
 * Still busy after BUSY_WAIT_MS: ENGINE_NOT_READY, nothing started. Any other refusal is returned, for the caller.
 */
async function resumeWhileBusy(s: Setup, o: Opened, frame: Frame, name: string): Promise<{ frame: Frame; resumed: boolean } | AgentClientError> {
  const deadline = s.now() + BUSY_WAIT_MS
  for (;;) {
    const result = await resumeOwned(s, o, frame).catch((error: unknown) => error instanceof AgentClientError ? error : Promise.reject(error))
    if (!(result instanceof AgentClientError) || result.code !== 'AGENT_BUSY') return result
    if (s.now() >= deadline) {
      throw new AgentClientError('ENGINE_NOT_READY', `${name}'s last engine is still stopping; nothing was started. Try harness ensure again.`)
    }
    await s.sleep(BUSY_STEP_MS)
  }
}

/** A live harness's state for `ensure`: idle, working, or still starting (no words taken since its engine started, and
 *  not idle yet). */
async function stateNow(t: { daemon: Daemon; frame: Frame }, record: ProgramHarness | null): Promise<EnsureState> {
  return stateFrom((await inspect(t)).screen, t.frame, record)
}

function stateFrom(screen: Screen | null, frame: Frame, record: ProgramHarness | null): EnsureState {
  if (screen === 'idle') return 'idle'
  const fresh = !record || record.inputs.every((input) => input.takenAt < record.startedAt)
  return fresh || frame.launch?.state === 'starting' ? 'starting' : 'working'
}

/** [frame], closed, opened again with its conversation where its engine can (`agent_resume`), as `harness resume` does. */
async function resumeOwned(s: Setup, o: Opened, frame: Frame): Promise<{ frame: Frame; resumed: boolean }> {
  const name = frame.name ?? frame.id.slice(0, 8)
  const creationId = randomUUID()
  let reply: Record<string, unknown>
  try { reply = await o.daemon.request('agent_resume', { agentId: frame.id, creationId }, STARTING_MS) } catch (error) {
    if (!(error instanceof AgentClientError) || error.code !== 'TIMEOUT') throw error
    reply = await o.daemon.request('agent_create_status', { creationId })
    if (reply.state === 'missing') throw error
  }
  const agent = resumedAgent(s, name, name, frame.id, reply)
  return { frame: { ...frame, ...agent }, resumed: reply.resumed !== false }
}

/**
 * Whether [frame]'s engine still runs in its tmux pane, read as the daemon reads it (lib/paneEngineProcess.ts): false
 * when tmux has no such pane or no engine process runs under it, null when that cannot be read (no tmux pane, a probe
 * that failed), and the row is then believed.
 */
export async function engineRuns(frame: Frame): Promise<boolean | 'pane-gone' | null> {
  const runtimes = frame.terminal?.runtimes ?? []
  const paneId = runtimes.find((r) => r.backend === 'tmux' && r.paneId)?.paneId ?? (runtimes.length ? null : frame.tmuxPane ?? null)
  if (!paneId || !/^%\d+$/.test(paneId) || !frame.engine) return null
  // Loaded only here: the process table and tmux are a live harness's check alone.
  const [{ lookupPaneEngineProcess }, { tmuxPanePid }] = await Promise.all([import('../lib/paneEngineProcess.js'), import('../lib/tmux.js')])
  const found = await lookupPaneEngineProcess({ rootProcess: (runtime) => tmuxPanePid(runtime.paneId) }, { backend: 'tmux', paneId }, frame.engine as AgentEngine)
    .catch(() => null)
  if (!found) return null
  return found.ok ? true : found.unknown ? null : /has no pane$/.test(found.reason) ? 'pane-gone' : false
}

/**
 * Whether OpenClaw's Gateway holds session [key], asked as the person asks it (`openclaw gateway call sessions.resolve`):
 * false only when it refuses with "No session found", null whenever it could not be asked or said anything else.
 */
export async function gatewayHolds(key: string, call: (args: string[]) => Promise<{ ok: boolean; said: string }> = openclaw): Promise<boolean | null> {
  const ran = await call(['gateway', 'call', 'sessions.resolve', '--params', JSON.stringify({ key }), '--json', '--timeout', '10000'])
  if (ran.ok) return /"ok"\s*:\s*true/.test(ran.said) ? true : null
  return /No session found/.test(ran.said) ? false : null
}

/** `openclaw` run with [args], never through a shell: whether it exited 0, and what it printed. */
async function openclaw(args: string[]): Promise<{ ok: boolean; said: string }> {
  const { execFile } = await import('node:child_process')
  return new Promise((done) => {
    // The Gateway is given 10 s (--timeout); the process 2 s more to start, so an ensure stays inside a caller's 30 s.
    execFile('openclaw', args, { timeout: 12_000, maxBuffer: 1 << 20 },
      (error, stdout, stderr) => done({ ok: !error, said: `${String(stdout)}\n${String(stderr)}` }))
  })
}
