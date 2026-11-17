/**
 * A fake `cmux` for specs, so no spec runs the person's cmux. It answers as cmux v0.65.2.2 does, read from
 * manaflow-ai/cmux at that tag (docs/plans/2026-11-17-dial-cmux-plan.md, "What Task 1 settles"); nothing of cmux is
 * installed or run. Where each answer comes from:
 * - A1 `sessions list`: CLI/CMUXCLI+SessionsList.swift. The top level and a record's fields, newest first (ties by
 *   session id), cut at 100 unless `--all`; the state folder is CMUX_AGENT_HOOK_STATE_DIR, else $HOME/.cmuxterm.
 *   Without `--all` cmux also leaves out records that are neither active, restorable nor backed by a transcript: the
 *   fake keeps every record, as the client always asks `--all`.
 * - A2 `socket-status --json`: CLI/CMUXCLI+SocketControlStatus.swift. It never connects; the live app is not observed.
 * - A3 `rpc`: CLI/cmux.swift (`case "rpc"`, the method's result at the top level, JSON with or without `--json`) and
 *   docs/cli-contract.md (Draft Guard: `surface.input_state`'s fields).
 * - A4 `paste`: CLI/CMUXCLI+Paste.swift (its arguments, stdin read before the socket, the Draft guard on `blocks_typing`
 *   unless `--force`), CLI/cmux.swift (`printV2Payload`) and tests_v2/test_terminal_paste_delivery.py (`terminal.paste`
 *   answers `delivery` and `submitted`).
 * - A5 a store is `<agent>-hook-sessions.json`, the name `--agent` takes: CLI/CMUXCLI+AgentHookCatalog.swift.
 * - A6 the modes `off`, `cmuxOnly` (the default), `automation`, `password`, `allowAll`:
 *   Packages/macOS/CmuxSettings/Sources/CmuxSettings/Values/SocketControlMode.swift.
 * - A7 a socket that refuses throws a CLIError, whose exit code is 1 unless set, and the CLI exits with it, its
 *   message on stderr and nothing on stdout: CLI/SocketClient+V2.swift, CLI/CLIError.swift, CLI/cmux.swift
 *   (`CMUXTermMain`). Only `automation` and `allowAll` let a process started outside cmux in: `cmuxOnly` checks the
 *   caller's ancestry, `password` asks a secret, `off` has no socket.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The cmux release the fake answers as; its header names each upstream file a field comes from (A1 to A7). */
export const CMUX_TAG = 'v0.65.2.2'

/** One record of `sessions list`, by cmux's own field names. Unset: active for its surface, `idle`, cwd `/work/api`,
 *  `updated_at_unix` its place in the list. Every record also prints a `transcript_path` and `launch_arguments`. */
export interface FakeCmuxSession {
  agent: string; surface_id: string; workspace_id: string; pid: number | null
  session_id?: string; cwd?: string | null; agent_lifecycle?: string | null
  active_for_surface?: boolean; updated_at_unix?: number; more?: Record<string, unknown>
}
export type FakeCmuxCommand = 'sessions' | 'socket-status' | 'rpc' | 'paste'
/** A command that misbehaves: exits so and prints nothing, prints these bytes, prints that many bytes, or never answers.
 *  A flood stays after its bytes, as a run that keeps writing, so only its reader's kill ends it. */
export type FakeCmuxFault = { exit: number } | { raw: string } | { flood: number } | 'hold'
export interface FakeCmuxState {
  sessions?: FakeCmuxSession[]
  /** `effective_mode`; `cmuxOnly` when unset, as cmux's default. */
  mode?: string
  /** `surface.input_state` by surface id; unset: a terminal with an idle agent at an empty prompt. */
  input?: Record<string, { terminal?: boolean; agent?: boolean; lifecycle?: string; state?: string; blocks_typing?: boolean }>
  /** `terminal.paste`'s `submitted`; true when unset. */
  submitted?: boolean
  fail?: Partial<Record<FakeCmuxCommand, FakeCmuxFault>>
}
/** One run: its arguments, its stdin read to the end, and the names of its own variables that start `CMUX_`. */
export interface FakeCmuxCall { args: string[]; stdin: string; env: string[] }
export interface FakeCmux {
  /** `<root>/cmux.app/Contents/Resources/bin/cmux`. */
  readonly binary: string
  /** A folder that holds one link named `cmux` to it: what a PATH gets. */
  readonly dir: string
  /** Written beside and renamed over, so a run never reads half. */
  set(state: FakeCmuxState): void
  calls(): FakeCmuxCall[]
  remove(): void
}

// The program itself, run by the test's own Node. It records the call before it answers, and sets its exit code rather
// than calling exit: on macOS a pipe's writes are asynchronous, and an exit would cut a long answer short.
const SCRIPT = String.raw`
import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
let stdin = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) stdin += chunk
const env = Object.keys(process.env).filter((name) => name.startsWith('CMUX_')).sort()
appendFileSync(join(here, 'calls.jsonl'), JSON.stringify({ args, stdin, env }) + '\n')

let state = {}
try { state = JSON.parse(readFileSync(join(here, 'state.json'), 'utf8')) } catch {}
// A held run that nobody killed (a spec that failed before its deadline fired) ends by itself, long after any spec.
const hold = () => new Promise((resolve) => setTimeout(resolve, 300000))
const T = 1700000000
const mode = state.mode ?? 'cmuxOnly'
const open = mode === 'automation' || mode === 'allowAll'

let json = false
let rest = args
while (rest[0] === '--json') { json = true; rest = rest.slice(1) }
const [command, ...commandArgs] = rest
const out = (value) => { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); return 0 }
const refuse = (message) => { process.stderr.write('Error: ' + message + '\n'); return 1 }
const UNANSWERED = 64

const inputOf = (surface) => {
  const key = Object.keys(state.input ?? {}).find((id) => id.toLowerCase() === String(surface).toLowerCase())
  const given = key === undefined ? {} : state.input[key]
  const terminal = given.terminal ?? true
  const agent = given.agent ?? true
  const lifecycle = given.lifecycle ?? 'idle'
  const shown = given.state ?? 'empty'
  return {
    state: shown, ...(shown === 'draft' ? { draft_length: 5 } : {}), agent, lifecycle,
    waiting_on_human: lifecycle === 'needsInput',
    blocks_typing: given.blocks_typing ?? (agent && (shown === 'draft' || shown === 'dialog')), terminal,
  }
}

const sessions = (flags) => {
  let agent
  let all = false
  let asJson = json
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--agent' && flags[i + 1] !== undefined) agent = flags[++i].toLowerCase()
    else if (flags[i] === '--all') all = true
    else if (flags[i] === '--json') asJson = true
    else return UNANSWERED
  }
  if (!asJson) return UNANSWERED
  const stateDir = process.env.CMUX_AGENT_HOOK_STATE_DIR ?? join(process.env.HOME ?? homedir(), '.cmuxterm')
  const records = (state.sessions ?? []).map((given, place) => {
    const id = given.session_id ?? '00000000-0000-4000-8000-' + String(place + 1).padStart(12, '0')
    return {
      agent: given.agent, session_id: id, workspace_id: given.workspace_id, surface_id: given.surface_id,
      store_path: join(stateDir, given.agent + '-hook-sessions.json'), updated_at_unix: given.updated_at_unix ?? T + place,
      cwd: given.cwd === undefined ? '/work/api' : given.cwd, transcript_path: '/transcripts/' + id + '.jsonl',
      pid: given.pid, agent_lifecycle: given.agent_lifecycle === undefined ? 'idle' : given.agent_lifecycle,
      launch_arguments: ['--dangerously-skip-permissions'], active_for_surface: given.active_for_surface ?? true, ...given.more,
    }
  }).filter((record) => agent === undefined || record.agent === agent)
  records.sort((a, b) => b.updated_at_unix - a.updated_at_unix || (a.session_id < b.session_id ? -1 : 1))
  const agents = agent === undefined ? [...new Set(records.map((record) => record.agent))] : [agent]
  const stores = agents.map((name) => ({
    agent: name, path: join(stateDir, name + '-hook-sessions.json'), exists: true,
    session_count: records.filter((record) => record.agent === name).length,
  }))
  return out({
    state_dir: stateDir, default_codex_home: join(process.env.HOME ?? homedir(), '.codex'), limit: all ? null : 100,
    total_matches: records.length, stores, sessions: all ? records : records.slice(0, 100),
  })
}

const socketStatus = (flags) => {
  if (flags.some((flag) => flag !== '--json') || !(json || flags.includes('--json'))) return UNANSWERED
  return out({
    effective_mode: mode, configured_mode: mode, managed: false, managed_source: null, policy_key: 'SocketControlMode',
    forced_value_status: 'unmanaged', socket_path: join(here, 'cmux.sock'), socket_path_state: 'absent',
    live_enforcement: 'not_observed', observation_scope: 'profile_and_socket_path',
  })
}

const rpc = (rpcArgs) => {
  if (rpcArgs.length !== 2 || rpcArgs[0] !== 'surface.input_state') return UNANSWERED
  let params
  try { params = JSON.parse(rpcArgs[1]) } catch { return UNANSWERED }
  if (!open) return refuse('Access denied')
  return out(inputOf(params.surface_id))
}

const paste = (pasteArgs) => {
  let workspace
  let surface
  let submit = false
  let force = false
  let fromStdin = false
  for (let i = 0; i < pasteArgs.length; i++) {
    const arg = pasteArgs[i]
    if (arg === '--workspace' && pasteArgs[i + 1] !== undefined) workspace = pasteArgs[++i]
    else if (arg === '--surface' && pasteArgs[i + 1] !== undefined) surface = pasteArgs[++i]
    else if (arg === '--submit') submit = true
    else if (arg === '--force') force = true
    else if (arg === '-') fromStdin = true
    else return UNANSWERED
  }
  if (!fromStdin || workspace === undefined || surface === undefined) return UNANSWERED
  if (!stdin) return refuse('paste requires text as an argument or on stdin')
  if (!open) return refuse('Access denied')
  if (!force && inputOf(surface).blocks_typing) return refuse('paste: the agent prompt holds text someone is typing, so nothing was sent.')
  if (!json) { process.stdout.write('OK\n'); return 0 }
  return out({ workspace_id: workspace, surface_id: surface, delivery: 'delivered', submitted: submit && (state.submitted ?? true) })
}

const fault = state.fail?.[command]
if (fault === 'hold') {
  await hold()
} else if (fault && 'exit' in fault) {
  process.exitCode = fault.exit
} else if (fault && 'raw' in fault) {
  process.stdout.write(fault.raw)
} else if (fault && 'flood' in fault) {
  process.stdout.write(Buffer.alloc(fault.flood, 0x78))
  await hold()
} else if (command === 'sessions' && commandArgs[0] === 'list') {
  process.exitCode = sessions(commandArgs.slice(1))
} else if (command === 'socket-status') {
  process.exitCode = socketStatus(commandArgs)
} else if (command === 'rpc') {
  process.exitCode = rpc(commandArgs)
} else if (command === 'paste') {
  process.exitCode = paste(commandArgs)
} else {
  process.exitCode = UNANSWERED
}
`

/** A path as one word of a `sh` script. */
const quoted = (path: string) => `'${path.replaceAll("'", `'\\''`)}'`

/** In `root`, else a fresh temp folder. */
export function fakeCmux(root?: string): FakeCmux {
  const base = root ?? mkdtempSync(join(tmpdir(), 'cmux-'))
  const bin = join(base, 'cmux.app', 'Contents', 'Resources', 'bin')
  const dir = join(base, 'path')
  mkdirSync(bin, { recursive: true })
  mkdirSync(dir, { recursive: true })
  const binary = join(bin, 'cmux')
  const script = join(bin, 'cmux.mjs')
  const stateFile = join(bin, 'state.json')
  const callsFile = join(bin, 'calls.jsonl')
  writeFileSync(script, SCRIPT)
  writeFileSync(binary, `#!/bin/sh\nexec ${quoted(process.execPath)} ${quoted(script)} "$@"\n`)
  chmodSync(binary, 0o755)
  symlinkSync(binary, join(dir, 'cmux'))
  const set = (state: FakeCmuxState) => {
    const aside = `${stateFile}.${process.pid}.tmp`
    writeFileSync(aside, JSON.stringify(state))
    renameSync(aside, stateFile)
  }
  set({})
  return {
    binary,
    dir,
    set,
    calls: () => existsSync(callsFile)
      ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeCmuxCall)
      : [],
    remove: () => rmSync(base, { recursive: true, force: true }),
  }
}

/** Writes `<home>/.cmuxterm/<word>-hook-sessions.json`, making the folder: what a hook of cmux's does to its store. */
export function touchStore(home: string, word: string): void {
  const folder = join(home, '.cmuxterm')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, `${word}-hook-sessions.json`), JSON.stringify({ version: 1, sessions: {} }))
}
