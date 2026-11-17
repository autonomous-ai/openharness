/**
 * cmux's own command line (docs/plans/2026-11-17-dial-cmux-design.md): its agents from `sessions list`, which reads
 * cmux's stores without its socket, and, for the dial's words, its socket's mode, a surface's prompt and a paste. For the
 * cmux source and the cmux adapter. Only the release app's binary runs, and only on macOS, where cmux runs.
 *
 * Its runs are its own: orca.ts's run has no stdin, which a paste needs so the words are never an argument other
 * processes can read, and its 1 MiB buffer reads as a timeout, where `sessions list --all` may print several. A run has
 * a deadline that answers by itself, and a bound on what it reads.
 *
 * No CMUX_* variable goes out with a run: a daemon started from a cmux terminal carries that terminal's, and
 * `socket-status` and `sessions list` would follow them to another mode and another store folder than the one watched.
 *
 * Every id and word is held to its form before it is an argument: they came from a hook or from cmux. Nothing here throws
 * or logs: cmux's answers name people's folders and agents, and its callers say what happened in their own fixed words.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveBinaryOnPath } from '../../lib/binaryOnPath.js'
import { MAX_CWD } from './herdrSource.js'
import { RUN_TIMEOUT_MS } from './orca.js'

export const CMUX_ID = /^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/
export const CMUX_WORD = /^[a-z][a-z0-9-]{0,31}$/
/** A store file's name; group 1 is cmux's word for its agent. */
export const CMUX_STORE = /^([a-z][a-z0-9-]{0,31})-hook-sessions\.json$/
export const CMUX_APP_BINARY = '/Applications/cmux.app/Contents/Resources/bin/cmux'
export const CMUX_AUTOMATION_OFF = 'Turn on Automation mode in cmux.'
export const cmuxStoreDir = (home: string): string => join(home, '.cmuxterm')
/** The key a hooked copy and a listed copy of one agent share (registry.ts). */
export const cmuxPaneKey = (surface: string): string => `cmux:${surface.toLowerCase()}`
export const cmuxPaneId = (workspace: string, surface: string): string => `${workspace}/${surface}`

/** The cask links `cmux` here, inside the app; other programs are called `cmux` too. */
const APP_SUFFIX = '/cmux.app/Contents/Resources/bin/cmux'
/** The most a run's stdout is read: `sessions list --all` prints every record of every store. */
const MAX_STDOUT = 8 * 1024 * 1024
/** A session id as one value: a record with another is listed without one. */
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/
/** A mode's word, `cmuxOnly`: cmux's own are camel case. */
const MODE = /^[A-Za-z]{1,32}$/
/** cmux's words that name an engine by another word (AgentHookCatalog.swift at v0.65.2.2). The others it tracks
 *  (`claude`, `codex`, `cursor`, `opencode`, `pi`, `omp`, `muse`, `amp`, `grok`, `copilot`) are their engines' own. */
const KINDS: Record<string, string> = { 'hermes-agent': 'hermes', antigravity: 'agy' }

/** A pane id's two ids, each in its form; else none. */
export function cmuxPaneOf(id: string): { workspace: string; surface: string } | undefined {
  const parts = id.split('/')
  if (parts.length !== 2 || !parts.every((part) => CMUX_ID.test(part))) return undefined
  return { workspace: parts[0], surface: parts[1] }
}

/** cmux's word as an engine's kind: the table, else its own word when it fits CMUX_WORD. */
export function cmuxKind(word: unknown): string | undefined {
  if (typeof word !== 'string') return undefined
  if (Object.hasOwn(KINDS, word)) return KINDS[word]
  return CMUX_WORD.test(word) ? word : undefined
}

export type CmuxLifecycle = 'running' | 'idle' | 'needsInput' | 'unknown'
const LIFECYCLES: ReadonlySet<unknown> = new Set<CmuxLifecycle>(['running', 'idle', 'needsInput', 'unknown'])
const PROMPT_STATES: ReadonlySet<unknown> = new Set(['empty', 'draft', 'dialog', 'unknown'])

export interface CmuxSession {
  word: string; kind: string; surface: string; workspace: string; pid: number
  lifecycle: CmuxLifecycle; updatedAt: number; sessionId?: string; cwd?: string
}
export type CmuxFault = 'no-binary' | 'failed' | 'timeout' | 'too-big'
/** `unread`: how many records cmux matched and did not print. */
export type CmuxSessions = { ok: true; sessions: CmuxSession[]; unread: number } | { ok: false; fault: CmuxFault }
export interface CmuxInputState {
  terminal: boolean; agent: boolean; lifecycle: CmuxLifecycle
  state: 'empty' | 'draft' | 'dialog' | 'unknown'; blocksTyping: boolean
}
export type CmuxPrompt = 'sent' | 'busy' | 'waiting' | 'automation-off' | 'no-answer'
export interface CmuxClient {
  /** cmux's own binary by its real path; none when cmux is not installed, and off macOS. */
  binary(): string | null
  /** Every agent's records, or one agent's by cmux's word: only those active for their surface, each value in form. */
  sessions(word?: string): Promise<CmuxSessions>
  /** `effective_mode`; none when it could not be read. */
  mode(): Promise<string | undefined>
  inputState(surface: string): Promise<CmuxInputState | undefined>
  /** True only when cmux pasted and submitted. Runs once. */
  paste(workspace: string, surface: string, text: string): Promise<boolean>
}
export interface CmuxClientDeps {
  /** The devices process's own environment, with no CMUX_* variable. */
  env: NodeJS.ProcessEnv
  home: string
  platform: NodeJS.Platform
  onPath(name: string): string | null
  /** None when it cannot be resolved. */
  realpath(path: string): string | null
  exists(path: string): boolean
  /** A timer; its cancel is returned. */
  after(ms: number, run: () => void): () => void
}

export function cmuxClientDeps(): CmuxClientDeps {
  return {
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CMUX_'))),
    home: homedir(),
    platform: process.platform,
    onPath: (name) => resolveBinaryOnPath(name),
    realpath: (path) => {
      try {
        return realpathSync(path)
      } catch {
        return null
      }
    },
    exists: existsSync,
    after: (ms, run) => {
      const timer = setTimeout(run, ms)
      return () => clearTimeout(timer)
    },
  }
}

type Run = { ok: true; stdout: string } | { ok: false; fault: 'failed' | 'timeout' | 'too-big' }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parsed = (run: Run): Record<string, unknown> | undefined => {
  if (!run.ok) return undefined
  try {
    const value: unknown = JSON.parse(run.stdout)
    return isObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** A record of `sessions list` that is active for its surface, each value in its form; else none. */
function sessionOf(record: unknown): CmuxSession | undefined {
  if (!isObject(record) || record.active_for_surface !== true) return undefined
  const { agent: word, surface_id: surface, workspace_id: workspace, pid } = record
  const kind = cmuxKind(word)
  if (typeof word !== 'string' || !kind) return undefined
  if (typeof surface !== 'string' || !CMUX_ID.test(surface) || typeof workspace !== 'string' || !CMUX_ID.test(workspace)) {
    return undefined
  }
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined
  const lifecycle = LIFECYCLES.has(record.agent_lifecycle) ? record.agent_lifecycle as CmuxLifecycle : 'unknown'
  const updatedAt = typeof record.updated_at_unix === 'number' && Number.isFinite(record.updated_at_unix) ? record.updated_at_unix : 0
  const sessionId = typeof record.session_id === 'string' && SESSION_ID.test(record.session_id) ? record.session_id : undefined
  const cwd = typeof record.cwd === 'string' && record.cwd ? record.cwd.slice(0, MAX_CWD) : undefined
  return { word, kind, surface, workspace, pid, lifecycle, updatedAt, ...(sessionId ? { sessionId } : {}), ...(cwd ? { cwd } : {}) }
}

export function createCmuxClient(deps: CmuxClientDeps): CmuxClient {
  const binary = (): string | null => {
    if (deps.platform !== 'darwin') return null
    const linked = deps.onPath('cmux')
    const real = linked ? deps.realpath(linked) : null
    if (real?.endsWith(APP_SUFFIX)) return real
    return deps.exists(CMUX_APP_BINARY) ? CMUX_APP_BINARY : null
  }

  /** One run of cmux, with `input` on its stdin (empty when there is none). Never rejects. */
  const run = (file: string, args: string[], input = ''): Promise<Run> => new Promise((resolve) => {
    let child: ChildProcess | undefined
    let done = false
    const finish = (answer: Run, kill = false) => {
      if (done) return
      done = true
      cancel()
      // A run past its deadline or its bound is ended, not waited for: one deaf to SIGTERM would hold the call open.
      if (kill) child?.kill('SIGKILL')
      resolve(answer)
    }
    const cancel = deps.after(RUN_TIMEOUT_MS, () => finish({ ok: false, fault: 'timeout' }, true))
    try {
      child = spawn(file, args, { env: deps.env, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      // What spawn refuses before starting (E2BIG, an argument it cannot pass) throws rather than emits.
      return finish({ ok: false, fault: 'failed' })
    }
    // A binary that cannot run (EACCES, ENOENT) emits this, and so does a kill that fails.
    child.on('error', () => finish({ ok: false, fault: 'failed' }))
    const { stdin, stdout } = child
    // Out of descriptors (EMFILE) it returns with no pipes: a run that never started.
    if (!stdin || !stdout) return finish({ ok: false, fault: 'failed' })
    // A child that exits before it reads its stdin breaks the pipe; its exit says how it went.
    stdin.on('error', () => {})
    stdin.end(input)
    const chunks: Buffer[] = []
    let size = 0
    stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_STDOUT) return finish({ ok: false, fault: 'too-big' }, true)
      chunks.push(chunk)
    })
    child.on('close', (code) => {
      finish(code === 0 ? { ok: true, stdout: Buffer.concat(chunks).toString('utf8') } : { ok: false, fault: 'failed' })
    })
  })

  return {
    binary,
    sessions: async (word) => {
      const file = binary()
      if (!file) return { ok: false, fault: 'no-binary' }
      if (word !== undefined && !CMUX_WORD.test(word)) return { ok: false, fault: 'failed' }
      const answer = await run(file, word === undefined
        ? ['sessions', 'list', '--json', '--all']
        : ['sessions', 'list', '--json', '--agent', word, '--all'])
      if (!answer.ok) return answer
      const top = parsed(answer)
      if (!top || !Array.isArray(top.sessions)) return { ok: false, fault: 'failed' }
      const printed = top.sessions.length
      const total = top.total_matches
      const sessions = top.sessions.flatMap((record) => sessionOf(record) ?? [])
      return { ok: true, sessions, unread: typeof total === 'number' && Number.isSafeInteger(total) && total > printed ? total - printed : 0 }
    },
    mode: async () => {
      const file = binary()
      if (!file) return undefined
      const mode = parsed(await run(file, ['socket-status', '--json']))?.effective_mode
      return typeof mode === 'string' && MODE.test(mode) ? mode : undefined
    },
    inputState: async (surface) => {
      const file = binary()
      if (!file || !CMUX_ID.test(surface)) return undefined
      const state = parsed(await run(file, ['--json', 'rpc', 'surface.input_state', JSON.stringify({ surface_id: surface })]))
      if (!state) return undefined
      const { terminal, agent, lifecycle, state: prompt, blocks_typing: blocksTyping } = state
      if (typeof terminal !== 'boolean' || typeof agent !== 'boolean' || typeof blocksTyping !== 'boolean') return undefined
      if (typeof lifecycle !== 'string' || typeof prompt !== 'string') return undefined
      return {
        terminal, agent, blocksTyping,
        lifecycle: LIFECYCLES.has(lifecycle) ? lifecycle as CmuxLifecycle : 'unknown',
        state: PROMPT_STATES.has(prompt) ? prompt as CmuxInputState['state'] : 'unknown',
      }
    },
    paste: async (workspace, surface, text) => {
      const file = binary()
      if (!file || !CMUX_ID.test(workspace) || !CMUX_ID.test(surface)) return false
      // Never --force: cmux's own Draft guard keeps the words off a prompt someone is typing in.
      const answer = await run(file, ['--json', 'paste', '--workspace', workspace, '--surface', surface, '--submit', '-'], text)
      return parsed(answer)?.submitted === true
    },
  }
}
