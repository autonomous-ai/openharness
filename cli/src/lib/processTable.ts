/** The process table: parsing `ps` rows, matching engine processes in it, and reading how they were launched. */

import { execFile } from 'child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readlink } from 'node:fs/promises'
import { platform } from 'node:os'
import { basename } from 'path'
import { type ProcessIdentity, type RegisteredSession } from './registry.js'
import {
  agentAliasOwner,
  agentCommandOwnershipSnapshot,
  engineFileOwners,
  enginePathOverride,
  executableFileIdentity,
} from './engineBin.js'
import { BYPASS_PERMISSION_FLAGS, PERMISSION_MODES, permissionModeApproves } from './engineLaunch.js'
import { discoveryField, versionedInstalls } from '../engines/discoveries.js'
import { psEnv } from './childLocale.js'
import { processStartTicks } from './processLiveness.js'
import { nativeProcessImages } from './nativeProcessImages.js'
import { patientExec } from './patientExec.js'
import { probeExecFile } from './offThreadExec.js'
import { sameProcessIdentity } from './terminalRuntime.js'

// Every `ps` call here: a held event loop must not turn a timeout into an empty answer
// (patientExec.ts).
const run = patientExec(execFile)

export interface ProcessRow extends ProcessIdentity {
  parentPid: number
  args: string
  /** Kernel argv boundaries, when available. Native control must not parse prompt text as flags. */
  nativeArgv?: readonly string[]
  /** Ephemeral evidence only; never persisted or sent to another machine. */
  imagePath?: string
  imageFileKey?: string
  entrypointFileKey?: string
}

const ARGV_TOKEN = /"[^"]*"|'[^']*'|\S+/g

function unquoteArgvToken(token: string): string {
  const quoted = (token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))
  return quoted ? token.slice(1, -1) : token
}

export function argvTokens(args: string): string[] {
  return (args.match(ARGV_TOKEN) ?? []).map(unquoteArgvToken)
}

/** Discovery only needs a command prefix. Do not tokenize a shell script or
 * prompt suffix once per candidate engine. Keep the same token grammar as
 * argvTokens, but stop scanning as soon as the consumer has enough evidence. */
function argvPrefix(args: string, nativeArgv?: readonly string[]): () => string | undefined {
  if (nativeArgv) { let index = 0; return () => nativeArgv[index++] }
  const pattern = new RegExp(ARGV_TOKEN)
  let done = false
  return () => {
    if (done) return undefined
    const match = pattern.exec(args)
    if (match) return unquoteArgvToken(match[0])
    done = true // RegExp.exec resets lastIndex at EOF; never restart the prefix.
    return undefined
  }
}

/**
 * A command's program name, as engine matching compares it: its file name, lower-cased, without a Windows program
 * image's extension (`claude.exe`, `node.exe`, `codex.exe` read as `claude`, `node`, `codex`). Only `.exe` and `.com`:
 * a script (`.cmd`, `.bat`, `.ps1`) is never a process image on Windows, since cmd.exe or PowerShell runs it, so a
 * `claude.ps1` named in some folder's command line is not Claude Code. Either separator ends a folder, since a Windows
 * row names its folders with a backslash and is read on every platform (the hook's copy, tests). `cmd.exe` keeps its
 * extension: it is the Windows command processor, never Command Code's `cmd`. A Unix name has neither extension, so it
 * reads as its basename did. Keep the standalone hook's copy (hook/notify.mjs) in sync.
 */
export function programName(token: string): string {
  const path = token.replace(/[\\/]+$/, '')
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).toLowerCase()
  return name === 'cmd.exe' ? name : name.replace(/\.(?:exe|com)$/, '')
}

const ORI_FLAGS_WITH_VALUE = new Set(['--model', '--log-level', '--completions'])
const INTERPRETER_OPTIONS_WITH_VALUE = new Set(['-r', '--require', '--loader', '--import', '--conditions', '--inspect-port'])
const INLINE_CODE_OPTIONS = new Set(['-c', '--command', '-e', '--eval', '--print'])

/**
 * Return only the executable/script portion of argv, never prompt text or later CLI arguments.
 *
 * Looking for an engine word anywhere in `ps args` is unsafe: `python worker.py "compare codex and
 * claude"` is not two coding agents. Package-manager installs commonly leave `node`, `bun`, Python, or a
 * shell in `comm`, so for those interpreters the first non-option token is the real entrypoint. Absolute
 * prefixes are deliberately retained only for suffix/package-layout checks and are never hard-coded.
 */
function processEntrypoint(args: string, next = argvPrefix(args)): string {
  let token = next() ?? ''
  let command = programName(token)
  if (command === 'env') {
    token = next() ?? ''
    while (token.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) token = next() ?? ''
    command = programName(token)
  }
  // `ori <engine>` (OpenRouter's launcher) computes an environment and then `execve`s the vendor binary
  // away, so a pane running it looks exactly like a bare `claude`/`codex` for all but the ~100ms before
  // the exec. Reading through the wrapper covers that window — and keeps the pane resolvable if a future
  // ori ever spawns a child instead. Its own flags are skipped; everything after them is the engine.
  if (command === 'ori') {
    token = next() ?? ''
    while (token.startsWith('-')) {
      if (ORI_FLAGS_WITH_VALUE.has(token)) next()
      token = next() ?? ''
    }
    command = programName(token)
  }
  if (!/^(?:node|nodejs|bun|deno|python(?:\d+(?:\.\d+)*)?|bash|zsh|sh)$/.test(command)) return token

  token = next() ?? ''
  while (token) {
    if (token === '--' || token === '-m') return next() ?? ''
    // Inline shell/Node/Python source is not an executable entrypoint. Its text can legitimately mention
    // an engine command; the real child process, if one is launched, will be discovered from its own row.
    if (INLINE_CODE_OPTIONS.has(token)) return ''
    if (!token.startsWith('-')) break
    if (INTERPRETER_OPTIONS_WITH_VALUE.has(token)) next()
    token = next() ?? ''
  }
  return token
}

/** A launcher's capability check is not the interactive engine it is about to start.
 * In particular, Codex startup runs `codex --help` before the real resume. Adopting
 * that short-lived PID ends a restart too early and discovery then evicts its pane.
 * Only a standalone probe argument counts: prompt text and option values do not. */
function engineCapabilityProbe(args: string, nativeArgv?: readonly string[]): boolean {
  const next = argvPrefix(args, nativeArgv)
  if (!processEntrypoint(args, next)) return false
  const option = next()
  return (option === '--help' || option === '-h' || option === '--version' || option === '-V')
    && next() === undefined
}

function hasCursorPackageEntrypoint(args: string): boolean {
  // Cursor's launcher uses `exec -a "$0" node .../index.js`, so argv[0] may stay `agent` instead of
  // `node`. Restrict this scan to the executable prefix: prompt text can appear later and is not proof.
  const next = argvPrefix(args)
  for (let seen = 0; seen < 8; seen++) {
    const token = next()
    if (token === undefined) break
    if (/cursor-agent[\/\\]versions[\/\\][^/\\]+[\/\\]index\.js$/i.test(token)) return true
  }
  return false
}

/** Hermes' managed launchers exec Python -I -c with a path bootstrap, then either import main
 * or run it through runpy. Require that executable prefix and actual code, never a script argument
 * or a quoted mention. argv[0] is authoritative here: macOS can truncate an absolute `comm` path.
 * Keep the standalone hook's copy in sync. */
/** macOS `ps` prints argv through vis(3): a newline as `\\012`, a backslash as `\\\\`. Read those back
 * so a multi-line `-c` source is the source it runs. Linux `ps` prints argv as it is, without them. */
function unvisArgs(args: string): string {
  return args.replace(/\\([0-7]{3}|\\)/g, (_, code: string) => code === '\\' ? '\\' : String.fromCharCode(parseInt(code, 8)))
}

function hermesInlineLauncher(row: Pick<ProcessRow, 'args'>): boolean {
  const args = unvisArgs(row.args).trim()
  if (!/^python(?:\d+(?:\.\d+)*)?$/.test(programName(argvPrefix(args)() ?? ''))) return false
  const prefix = /^(?:"[^"]+"|'[^']+'|\S+)(?:\s+-(?:I|E|s|S|u|B|O{1,2}|q))*\s+-c\s+/.exec(args)
  if (!prefix) return false
  const source = args.slice(prefix[0].length).replace(/^["']/, '')
  // Mask string literals before looking for Python statements. A print/prompt containing a whole
  // launcher is still data. Keep literal values only to identify runpy's exact entry module.
  const literals: string[] = []
  const code = source.replace(/(['"])(?:\\[\s\S]|(?!\1)[^\\])*?\1/g, (literal) => {
    literals.push(literal.slice(1, -1))
    return `__literal${literals.length - 1}__`
  })
  if (!/^import\s+(?:(?:os|re|sys|runpy)\s*,\s*)*(?:sys|runpy)[;\s]+(?:os\.environ\.pop\(__literal\d+__,\s*None\)[;\s]+)*sys\.path\.insert\(\s*0,\s*__literal\d+__\s*\)/.test(code)) return false
  if (/\bimport\s+hermes_bootstrap\b/.test(code)
    && /\bfrom\s+hermes_cli\.main\s+import\s+main\b/.test(code)
    && /\bsys\.exit\(\s*main\(\)\s*\)/.test(code)) return true
  const run = /\brunpy\.run_module\(\s*__literal(\d+)__\s*,\s*run_name\s*=\s*__literal(\d+)__(?:\s*,\s*alter_sys\s*=\s*True)?\s*\)/.exec(code)
  return !!run && literals[Number(run[1])] === 'hermes_cli.main' && literals[Number(run[2])] === '__main__'
}

function agentAliasCandidate(row: Pick<ProcessRow, 'executable' | 'args'>): boolean {
  if (programName(row.executable) === 'agent') return true
  return programName(processEntrypoint(row.args)) === 'agent'
}


/**
 * One `ps -axo pid=,ppid=,comm=,lstart=,args=` line → a row.
 *
 * `comm` can itself contain spaces: Command Code rewrites its argv to `⌘ <session title>` and macOS
 * prints that verbatim as the command name. Splitting comm off as a single `\S+` therefore shifted every
 * later field — `startMarker` came out as `"<rest of title> Thu Jul 30"` instead of a start time, so it
 * changed whenever Command Code renamed the session, runtime validation saw a different process,
 * and the reaper evicted a live pane ~10s after its first turn (observed four times on one session; the
 * pane went on serving turn-stop hooks after being declared "gone"). It also silently defeated the
 * PID-reuse guard that startMarker exists for.
 *
 * So anchor on `lstart` instead — it is the one field with a fixed shape (`DOW MON DD HH:MM:SS YYYY`) —
 * and let comm be lazy.
 *
 * That shape is only fixed because every `ps` whose output reaches this parser is spawned under
 * `LC_TIME=C` (`psEnv`, lib/childLocale.ts). The day and month names are left unconstrained as a
 * courtesy to a locale that merely renames them — NOT as support for one. A locale that REORDERS the
 * fields parses zero rows here, and most of them do: `Tue 15 Sep` (en_GB, en_AU), `Di. 15 Sep.`
 * (de_DE), `火  9/15` (ja_JP), `вторник, 15 сентября 2026 г.` (ru_RU). That is what `psEnv` prevents.
 */
export function parseProcessRow(line: string): ProcessRow | null {
  const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s*(.*)$/.exec(line)
  if (!match) return null
  // Found by QA on a quiet machine: saved identities held 13.8 MiB of old ps tables through
  // V8's capture substrings. The deleted-image memo keeps args too. Own each field's storage;
  // UTF-16 preserves the exact command text instead of changing an engine's identity.
  return {
    pid: Number(match[1]),
    parentPid: Number(match[2]),
    executable: Buffer.from(match[3], 'utf16le').toString('utf16le'),
    startMarker: Buffer.from(match[4], 'utf16le').toString('utf16le'),
    args: Buffer.from(match[5], 'utf16le').toString('utf16le'),
  }
}

/**
 * Second line of defence for the locale substitution `ensureUtf8Locale` (lib/childLocale.ts) prevents:
 * a glibc build with no `C.UTF-8` locale falls back to POSIX and `ps` replaces every byte it cannot
 * print with `?` — which erases the `⌘` that is Command Code's only pane marker. `/proc` is raw bytes
 * and cannot be mangled by anything, so re-read the two fields from there, but only for the rows that
 * actually show a `?`, which under a working locale is none. Measured cost of reading every
 * `/proc/<pid>/cmdline` on a 63-process container: 0.48ms, so even the degenerate case is free.
 *
 * No-op off Linux: macOS has no /proc and does not substitute in the first place.
 */
function repairMangledRows(rows: ProcessRow[]): ProcessRow[] {
  if (process.platform !== 'linux') return rows
  return rows.map((row) => {
    if (!row.executable.includes('?') && !row.args.includes('?')) return row
    // cmdline is NUL-separated; node's process.title rewrite space-pads the tail of the argv region.
    const args = readProcField(row.pid, 'cmdline')?.replace(/\0/g, ' ').trimEnd()
    const executable = readProcField(row.pid, 'comm')?.trimEnd()
    return { ...row, ...(executable && { executable }), ...(args && { args }) }
  })
}

function readProcField(pid: number, field: 'cmdline' | 'comm'): string | null {
  try { return readFileSync(`/proc/${pid}/${field}`, 'utf8') } catch { return null }
}

/**
 * The rows that are actually running: a zombie is dropped.
 *
 * ⚠️ **A zombie keeps its pid, its command name and its start time — everything an identity check
 * compares — while being dead.** It stays in the table until its parent reaps it, and an orphan's
 * parent is pid 1, which in a container is often something that never reaps (`tail -f /dev/null` in
 * the remote-machine rig did not). `checkPidRuntime` then called the zombie of a stopped agent's
 * engine "alive", and resume refused that agent for as long as the zombie lasted — forever — with
 * "The previous process is still running". No consumer of the process table wants one: a zombie
 * runs nothing, holds no conversation, and can be neither signalled nor attached to.
 *
 * `ps` renders one as `[comm] <defunct>` (procps) or `<defunct>` (BSD). On Linux the kernel's own
 * state letter settles it, so an argv that merely ENDS in that word is never mistaken for a corpse.
 */
export function liveProcessRows(rows: ProcessRow[]): ProcessRow[] {
  return rows.filter((row) => !isZombie(row))
}

function isZombie(row: ProcessRow): boolean {
  if (!/(^|\s)<defunct>$/.test(row.args)) return false
  if (process.platform !== 'linux') return true
  // `pid (comm) S ...` — comm may hold spaces and parentheses, so the state is read after the LAST `)`.
  const stat = readProcStat(row.pid)
  return stat === null || stat.slice(stat.lastIndexOf(')') + 1).trimStart().startsWith('Z')
}

function readProcStat(pid: number): string | null {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8') } catch { return null }
}

/**
 * A `ps` that is already running answers everyone who asks while it runs. The first reconcile pass
 * after a boot attaches a few agents at once and every attach validates its pane against the table,
 * as does each hook that arrives in the same burst — one table serves them all. There is no cache,
 * only the read in flight: the oldest table anyone is handed began a `ps` ago (tens of ms), never
 * one that finished before they asked. Callers get the SAME array; none of them mutates it (every
 * consumer maps or filters into its own), and any new one must not either.
 */
let processRowsInFlight: Promise<ProcessRow[] | null> | null = null

type ProcessTableSource = () => Promise<ProcessRow[] | null>
let source: ProcessTableSource | null = null

/** Windows reads its table from harness-pty (lib/windows/processTable.ts); tests inject rows. */
export function setProcessTableSource(next: ProcessTableSource | null): void {
  source = next
  processRowsInFlight = null
}

/** A running process's command line as the process table shows it; '' once it is not that process. */
export async function processArgs(identity: ProcessIdentity): Promise<string> {
  const rows = await processRows()
  return rows?.find((row) => sameProcessIdentity(row, identity))?.args ?? ''
}

/**
 * The command line [row]'s engine was launched with, for reading how it was launched (its grid).
 *
 * Its own, unless that is a bare title: Pi renames its process, which on macOS overwrites its argv and environment
 * in `ps` with `pi` (2026-10-14), and nothing it was launched with can be read there. Then the launcher this daemon
 * started it under still holds the command (`… harness-engine [cwd] <engine binary> <args>`, lib/engineLaunch.ts),
 * and is read when it is the direct parent in the same table, naming a binary of that title right after
 * `harness-engine`. Anything else is '': not known, never another process's command line.
 */
export function launchArgs(rows: readonly ProcessRow[], row: ProcessRow): string {
  const title = row.args.trim()
  if (/\s/.test(title)) return row.args
  const parent = rows.find((candidate) => candidate.pid === row.parentPid)
  if (!title || !parent) return ''
  const tokens = argvTokens(parent.args)
  const at = tokens.indexOf('harness-engine')
  if (at < 0) return ''
  const named = (token: string | undefined) => !!token && basename(token) === title
  return named(tokens[at + 1]) || named(tokens[at + 2]) ? parent.args : ''
}

/** [launchArgs] for the process [identity] names, read from a fresh table; '' once it is not that process. */
export async function processLaunchArgs(identity: ProcessIdentity): Promise<string> {
  const rows = await processRows()
  const row = rows?.find((candidate) => sameProcessIdentity(candidate, identity))
  return rows && row ? launchArgs(rows, row) : ''
}

/** The process table, or null when `ps` itself failed — "we could not look" is not "nothing is there". */
export function processRows(): Promise<ProcessRow[] | null> {
  if (processRowsInFlight) return processRowsInFlight
  processRowsInFlight = (source ?? readProcessRows)().finally(() => { processRowsInFlight = null })
  return processRowsInFlight
}

async function readProcessRows(): Promise<ProcessRow[] | null> {
  const rows = await new Promise<ProcessRow[] | null>((resolve) => {
    run('ps', ['-axo', 'pid=,ppid=,comm=,lstart=,args='], { timeout: 3000, env: psEnv() }, (err, stdout) => {
      if (err) { resolve(null); return }
      const rows: ProcessRow[] = []
      for (const line of stdout.split('\n')) {
        const row = parseProcessRow(line)
        if (row) rows.push(row)
      }
      // `ps` lists itself at the least: a table with nobody in it is a read that failed, and taken for
      // an answer it says every engine on the machine has exited.
      resolve(rows.length ? rows : null)
    })
  })
  return rows ? withStartTicks(liveProcessRows(repairMangledRows(rows))) : null
}

/**
 * Linux: each row's start ticks, the part of its identity a clock step cannot move (see
 * `ProcessIdentity.startTicks`). One small /proc read per row, like the mangled-row repair above.
 */
export function withStartTicks(rows: ProcessRow[], ticksOf: (pid: number) => number | null = processStartTicks): ProcessRow[] {
  if (process.platform !== 'linux') return rows
  return rows.map((row) => {
    const startTicks = ticksOf(row.pid)
    return startTicks === null ? row : { ...row, startTicks }
  })
}

function execText(command: string, args: string[], timeout: number): Promise<string | null> {
  return new Promise((resolve) => {
    // `lsof -p pid1,pid2` exits 1 when even one process disappears or is inaccessible, while still
    // returning complete records for the surviving PIDs. Keep that usable partial snapshot. Node's own
    // timeout, for a deadline shared across calls: `killed` without an error is that timeout throwing
    // away an answer that had arrived (patientExec.ts), so it is no answer, not an empty one.
    let child: { killed?: boolean } | undefined
    child = probeExecFile(execFile)(command, args, { timeout }, (err, stdout) => resolve((err && !stdout) || child?.killed ? null : stdout))
  })
}

function parseDarwinProcessImages(stdout: string | null): Map<number, string> {
  const images = new Map<number, string>()
  if (stdout === null) return images
  const seen = new Set<number>()
  let pid: number | null = null
  let textFile = false
  // A killed/buffer-limited helper may end halfway through a path.
  for (const line of stdout.slice(0, stdout.lastIndexOf('\n') + 1).split('\n')) {
    if (/^p\d+$/.test(line)) {
      pid = Number(line.slice(1))
      textFile = false
    } else if (line === 'ftxt') {
      textFile = true
    } else if (textFile && pid && line.startsWith('n')) {
      // The first text region is the executable. An error record must not let
      // a later dylib masquerade as it; incomplete probes use the fallback.
      if (!seen.has(pid) && line.startsWith('n/')) images.set(pid, line.slice(1))
      seen.add(pid)
      textFile = false
    }
  }
  return images
}

export function createDeletedImageMemo({ exists }: { exists: (path: string) => boolean }) {
  const memo = new Map<number, { startMarker: string; args: string; path: string }>()
  return {
    recall(row: ProcessRow): string | undefined {
      const entry = memo.get(row.pid)
      return entry && entry.startMarker === row.startMarker && entry.args === row.args && !exists(entry.path) ? entry.path : undefined
    },
    remember({ pid, startMarker, args }: ProcessRow, path: string): void {
      if (exists(path)) memo.delete(pid)
      else memo.set(pid, { startMarker, args, path })
    },
    forget(pid: number): void { memo.delete(pid) },
    prune(rows: readonly ProcessRow[]): void { for (const pid of memo.keys()) if (!rows.some(row => row.pid === pid)) memo.delete(pid) },
  }
}
const deletedImages = createDeletedImageMemo({ exists: existsSync })

/** macOS has no /proc. Prefer the bundled kernel probe and retain both lsof
 * fallbacks within the same 3s budget. Never cache by PID alone: exec can replace
 * an image without changing its birth. Memo safety rests on !exists(path) and
 * the helper reporting the PID unavailable this same pass; birth and args must match.
 * We accept an exec into another binary keeping argv and birth, then deletion
 * before the helper reads it: only the imagePath evidence string can be wrong.
 * Claude auto-updates left deleted images costing lsof -d txt ~18 ms every
 * 5 s (~0.4% core), measured 2026-10-06. */
async function darwinProcessImages(rows: readonly ProcessRow[]): Promise<{
  images: Map<number, string>; stale: Set<number>
}> {
  const images = new Map<number, string>()
  const stale = new Set<number>()
  if (!rows.length) return { images, stale }
  const deadline = performance.now() + 3000
  const pids = rows.map(row => row.pid)
  const native = await nativeProcessImages(pids, 500)
  const normalizeStart = (marker: string) => marker.trim().split(/\s+/)
    .map((part, index) => index === 2 ? String(Number(part)) : part).join(' ')
  for (const row of rows) {
    const image = native.images.get(row.pid)
    if (!image) {
      const path = native.unavailable.has(row.pid) && deletedImages.recall(row)
      if (path) images.set(row.pid, path)
      continue
    }
    deletedImages.forget(row.pid)
    if (normalizeStart(image.startMarker) === normalizeStart(row.startMarker)) images.set(row.pid, image.path)
    // The PID changed owners since ps. Do not combine the new executable with
    // old ancestry/arguments, or let the fallback reintroduce that stale row.
    else stale.add(row.pid)
  }
  const args = (selected: readonly number[]) => ['-a', '-p', selected.join(','), '-d', 'txt', '-Fn']
  let missing = pids.filter(pid => !images.has(pid) && !stale.has(pid))
  let remaining = Math.floor(deadline - performance.now())
  if (missing.length && remaining > 0) {
    for (const [pid, path] of parseDarwinProcessImages(
      await execText('lsof', ['-b', ...args(missing)], Math.min(1000, remaining)),
    )) images.set(pid, path)
  }
  missing = missing.filter(pid => !images.has(pid))
  remaining = Math.floor(deadline - performance.now())
  if (missing.length && remaining > 0) {
    for (const [pid, path] of parseDarwinProcessImages(await execText('lsof', args(missing), remaining))) {
      images.set(pid, path)
    }
  }
  for (const row of rows) if (native.unavailable.has(row.pid) && images.has(row.pid)) deletedImages.remember(row, images.get(row.pid)!)
  return { images, stale }
}

/**
 * Attach executable-image and entrypoint identity to selected process rows.
 *
 * The rows argument is the whole process table used for memo pruning.
 * Only selectedPids are probed: terminal descendants or one saved PID during validation.
 */
export async function enrichProcessRows(
  rows: ProcessRow[],
  selectedPids: ReadonlySet<number> = new Set(rows.map((row) => row.pid)),
): Promise<ProcessRow[]> {
  const candidates = rows.filter((row) => selectedPids.has(row.pid))
  // Prune the full table so one-pane lookups keep other panes' memo (18 ms/pass, 2026-10-06).
  if (platform() === 'darwin') deletedImages.prune(rows)
  if (!candidates.length) return rows
  const imagePaths = new Map<number, string>()
  const imageIdentities = new Map<number, ReturnType<typeof executableFileIdentity>>()
  let stale = new Set<number>()
  if (platform() === 'linux') {
    await Promise.all(candidates.map(async (row) => {
      const procImage = `/proc/${row.pid}/exe`
      const path = await readlink(procImage).catch(() => null)
      if (path) {
        imagePaths.set(row.pid, path)
        // Stat the proc link itself. If an auto-updater replaced the on-disk path, this still identifies
        // the exact deleted inode executing in the pane rather than the newer file now at that pathname.
        imageIdentities.set(row.pid, executableFileIdentity(procImage))
      }
    }))
  } else if (platform() === 'darwin') {
    const result = await darwinProcessImages(candidates)
    stale = result.stale
    for (const [pid, path] of result.images) {
      imagePaths.set(pid, path)
      imageIdentities.set(pid, executableFileIdentity(path.replace(/ \(deleted\)$/, '')))
    }
  }

  return rows.filter(row => !stale.has(row.pid)).map((row) => {
    if (!selectedPids.has(row.pid)) return row
    const imagePath = imagePaths.get(row.pid)
    const image = imageIdentities.get(row.pid) ?? null
    const entrypoint = processEntrypoint(row.args)
    const entrypointIdentity = entrypoint.includes('/') || entrypoint.includes('\\')
      ? executableFileIdentity(entrypoint)
      : null
    return {
      ...row,
      ...(imagePath && { imagePath }),
      ...(image && { imageFileKey: image.fileKey }),
      ...(entrypointIdentity && { entrypointFileKey: entrypointIdentity.fileKey }),
    }
  })
}

/** All rows below one or more terminal roots, including the roots themselves. */
export function processTreePids(rows: readonly ProcessRow[], rootPids: readonly number[]): Set<number> {
  const children = new Map<number, number[]>()
  for (const row of rows) {
    const list = children.get(row.parentPid) ?? []
    list.push(row.pid)
    children.set(row.parentPid, list)
  }
  const found = new Set<number>()
  const queue = [...rootPids]
  while (queue.length) {
    const pid = queue.shift()!
    if (found.has(pid)) continue
    found.add(pid)
    for (const child of children.get(pid) ?? []) queue.push(child)
  }
  return found
}

/**
 * Linux caps `comm` at 15 bytes (TASK_COMM_LEN) and never prints a path there, while macOS prints the
 * full executable path. Measured on Ubuntu 24.04: a binary named `a-very-long-engine-name-binary` reads
 * back as `a-very-long-eng`. So on Linux the full-path clause can never fire, and an override whose
 * basename is longer than the cap can only ever be seen truncated — accept that prefix as evidence.
 * No supported engine's own basename reaches the cap; this covers a user-set `*_PATH` override.
 */
function commTruncatedPrefixOf(seen: string, want: string): boolean {
  if (process.platform !== 'linux' || !seen || !want) return false
  return Buffer.byteLength(seen) === 15 && want.length > seen.length && want.startsWith(seen)
}

interface EngineProcessSignature {
  basenames: readonly RegExp[]
  entrypoints: readonly RegExp[]
}

/** Vendor-supported native names and launcher/package entrypoints, independent of install prefix. Claude Code's
 *  and Codex's are their discovery contracts' (engines/discoveries.ts). */
export const ENGINE_PROCESS_SIGNATURES: Readonly<Record<RegisteredSession['engine'], EngineProcessSignature>> = {
  ...discoveryField('process'),
  cursor: {
    basenames: [/^cursor-agent$/],
    entrypoints: [/cursor-agent[\/\\]versions[\/\\][^/\\]+[\/\\]index\.js$/],
  },
  opencode: {
    basenames: [/^opencode(?:\.exe)?$/],
    entrypoints: [/opencode-ai[\/\\]bin[\/\\]opencode(?:\.exe)?$/],
  },
  pi: {
    basenames: [/^pi$/],
    entrypoints: [/pi-coding-agent[\/\\]dist[\/\\]cli\.js$/],
  },
  // The release binary is a single executable named `omp` (measured: /proc/<pid>/comm and exe).
  omp: {
    basenames: [/^omp$/],
    entrypoints: [],
  },
  hermes: {
    basenames: [/^hermes$/, /^hermes-agent$/],
    entrypoints: [/hermes-agent[\/\\]hermes$/, /(?:^|[\/\\])hermes_cli(?:[\/\\]|\.|$)/],
  },
  commandcode: {
    basenames: [/^cmd$/, /^command-?code$/],
    entrypoints: [/command-code[\/\\]dist[\/\\]index\.mjs$/],
  },
  devin: {
    basenames: [/^devin$/],
    entrypoints: [/devin[\/\\]cli[\/\\]_versions[\/\\][^/\\]+[\/\\]bin[\/\\]devin$/],
  },
  muse: {
    basenames: [/^muse$/, /^muse-bin-/],
    entrypoints: [],
  },
  amp: {
    basenames: [/^amp$/],
    entrypoints: [/[\/\\]\.amp[\/\\]bin[\/\\]amp$/],
  },
  kilo: {
    basenames: [/^kilo$/, /^kilocode$/, /^\.kilo$/, /^kilo-(?:darwin|linux)-(?:arm64|x64)(?:-baseline)?$/],
    entrypoints: [/@kilocode[\/\\]cli[\/\\]bin[\/\\](?:\.kilo|kilo|kilocode)$/],
  },
  grok: {
    basenames: [/^grok$/, /^grok(?:-[^-]+)?-(?:macos|linux)-(?:aarch64|x86_64)$/],
    entrypoints: [/[\/\\]\.grok[\/\\](?:bin[\/\\]grok|downloads[\/\\]grok[^/\\]*)$/],
  },
  agy: {
    basenames: [/^agy$/],
    entrypoints: [/[\/\\]\.local[\/\\]bin[\/\\]agy$/],
  },
  copilot: {
    basenames: [/^copilot$/],
    entrypoints: [/@github[\/\\]copilot[\/\\](?:npm-loader\.js|index\.js|bin[\/\\]copilot)$/],
  },
  // A terminal is a shell, and a shell is what every pane starts as — so nothing matches it, ever.
  // Discovery walks PROCESS_ENGINES and never asks; this entry exists for the Record's sake.
  terminal: { basenames: [], entrypoints: [] },
}

function heuristicEngineProcessMatchScore(
  row: Pick<ProcessRow, 'executable' | 'args' | 'nativeArgv' | 'imageFileKey' | 'entrypointFileKey'>,
  engine: RegisteredSession['engine'],
  ownership = agentCommandOwnershipSnapshot(),
): number {
  const executable = programName(row.executable)
  const entrypoint = processEntrypoint(row.args, argvPrefix(row.args, row.nativeArgv)).toLowerCase()
  const entrybase = programName(entrypoint)
  // Antigravity also ships an IDE-side `agy` inside its .app bundle. It is not the terminal engine,
  // even when an AGY_PATH override happens to use the same basename.
  if (engine === 'agy' && /\.app[\/\\]Contents[\/\\]/.test(`${row.executable}\n${entrypoint}`)) return 0
  // Only an explicit override is ownership evidence. A default command label is not: both Cursor and
  // Grok ship `agent`, which is exactly the collision this matcher must resolve rather than assume away.
  const configured = enginePathOverride(engine)?.toLowerCase()
  const configuredBase = programName(configured ?? '')
  // Linux's `comm` cap is in bytes of the name as the kernel holds it: compared unstripped.
  if (configured && configuredBase !== 'agent' && (row.executable.toLowerCase() === configured
    || entrypoint === configured || executable === configuredBase || entrybase === configuredBase
    || commTruncatedPrefixOf(basename(row.executable).toLowerCase(), basename(configured).toLowerCase()))) return 4

  // Command Code rewrites argv/comm to a session title, which becomes its only long-lived marker.
  if (engine === 'commandcode' && (/^\s*⌘(?:\s|$)/.test(row.executable) || /^\s*⌘(?:\s|$)/.test(row.args))) return 3

  // Cursor's launcher can retain argv[0]=agent while the Node package path appears later in argv.
  if (engine === 'cursor' && hasCursorPackageEntrypoint(row.args)) return 3

  // Hermes' own launcher, read out of the inline source it runs as. See `hermesInlineLauncher`.
  if (engine === 'hermes' && hermesInlineLauncher(row)) return 2

  const signature = ENGINE_PROCESS_SIGNATURES[engine]
  if (signature.basenames.some((pattern) => pattern.test(executable) || pattern.test(entrybase))) return 3
  if (signature.entrypoints.some((pattern) => pattern.test(entrypoint))) return 2

  // A native binary named only by its version (Claude Code's): only the vendor layout makes that name meaningful.
  const versioned = versionedInstalls[engine]
  if (versioned && (versioned(row.executable) || versioned(entrypoint))) return 3

  if (engine === 'cursor') {
    return agentAliasOwner([row.imageFileKey, row.entrypointFileKey], ownership) === 'cursor' ? 4 : 0
  }
  if (engine === 'grok') {
    if (agentAliasOwner([row.imageFileKey, row.entrypointFileKey], ownership) === 'grok') return 4
  }
  return 0
}

export type EngineProcessMatchEvidence =
  | 'file-identity'
  | 'explicit-override'
  | 'native-or-process-name'
  | 'package-entrypoint'
  | 'pane-hook-hint'
  | 'none'

export interface EngineProcessMatch {
  score: number
  evidence: EngineProcessMatchEvidence
  imagePath?: string
}

/**
 * Structured engine evidence for discovery and remote diagnostics.
 * File identity wins; basename/package rules are compatibility fallbacks for launchers and scripts.
 */
export function engineProcessMatch(
  row: Pick<ProcessRow, 'executable' | 'args' | 'nativeArgv' | 'imagePath' | 'imageFileKey' | 'entrypointFileKey'>,
  engine: RegisteredSession['engine'],
  ownership = agentCommandOwnershipSnapshot(),
): EngineProcessMatch {
  if (engineCapabilityProbe(row.args, row.nativeArgv)) return { score: 0, evidence: 'none' }
  const owners = engineFileOwners([row.imageFileKey, row.entrypointFileKey], ownership)
  if (owners.length === 1) {
    return owners[0] === engine
      ? { score: 4, evidence: 'file-identity', ...(row.imagePath && { imagePath: row.imagePath }) }
      : { score: 0, evidence: 'none', ...(row.imagePath && { imagePath: row.imagePath }) }
  }
  // Conflicting identities are never weakened into a basename guess.
  if (owners.length > 1) return { score: 0, evidence: 'none', ...(row.imagePath && { imagePath: row.imagePath }) }

  const score = heuristicEngineProcessMatchScore(row, engine, ownership)
  if (score <= 0) return { score: 0, evidence: 'none', ...(row.imagePath && { imagePath: row.imagePath }) }
  return {
    score,
    evidence: score === 4
      ? 'explicit-override'
      : score === 2
        ? 'package-entrypoint'
        : score === 1
          ? 'pane-hook-hint'
          : 'native-or-process-name',
    ...(row.imagePath && { imagePath: row.imagePath }),
  }
}

/** Compatibility surface for callers that only need ordering. */
export function engineProcessMatchScore(
  row: Pick<ProcessRow, 'executable' | 'args' | 'nativeArgv' | 'imagePath' | 'imageFileKey' | 'entrypointFileKey'>,
  engine: RegisteredSession['engine'],
  ownership = agentCommandOwnershipSnapshot(),
): number {
  return engineProcessMatch(row, engine, ownership).score
}

/** An unresolved top-level `agent` is a barrier: a nested sub-agent must not steal its tmux pane. */
export function ambiguousAgentProcess(
  row: Pick<ProcessRow, 'executable' | 'args' | 'imageFileKey' | 'entrypointFileKey'>,
  ownership = agentCommandOwnershipSnapshot(),
): boolean {
  if (engineCapabilityProbe(row.args)) return false
  if (!agentAliasCandidate(row) || hasCursorPackageEntrypoint(row.args)) return false
  const executable = programName(row.executable)
  const entrybase = programName(processEntrypoint(row.args))
  if (executable === 'cursor-agent' || entrybase === 'cursor-agent' || executable === 'grok' || entrybase === 'grok') return false
  const owner = agentAliasOwner([row.imageFileKey, row.entrypointFileKey], ownership)
  return owner === 'unknown' || owner === 'conflict'
}

export function selectEngineProcess(
  rows: ProcessRow[],
  rootPid: number,
  engine: RegisteredSession['engine'],
): ProcessRow | null {
  const ownership = agentCommandOwnershipSnapshot()
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    const list = children.get(row.parentPid) ?? []
    list.push(row)
    children.set(row.parentPid, list)
  }
  const queue: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }]
  let best: { row: ProcessRow; depth: number; score: number } | null = null
  while (queue.length > 0) {
    const current = queue.shift()!
    const row = byPid.get(current.pid)
    const score = row ? engineProcessMatchScore(row, engine, ownership) : 0
    if (row && score > 0 && (!best || current.depth < best.depth || (current.depth === best.depth && score > best.score))) {
      best = { row, depth: current.depth, score }
    }
    for (const child of children.get(current.pid) ?? []) queue.push({ pid: child.pid, depth: current.depth + 1 })
  }
  return best?.row ?? null
}

/**
 * How each engine names an already-existing session on its command line, and what its ids look like.
 *
 * This exists because RESUMING is the one way to start an agent that announces nothing: the engine's
 * SessionStart hook fires for a NEW session, so a pane that reattached to an old one is invisible to the
 * daemon until the user happens to type. Read from each CLI's own `--help` on 2026-08-03.
 *
 * One deliberate hole: `--continue` / `-c` carries NO id on any of these CLIs. Nothing can be
 * recovered from argv there.
 *
 * claude and codex DO fire SessionStart on resume, so their argv is normally redundant — but a hook
 * only helps a daemon that was listening for it. An agent whose SessionStart landed while the daemon
 * could not see its pane (a session named by an older build, before the `harness-` whitelist) sits
 * with no session until the user types again, and cannot be forked meanwhile. Their ids are read
 * here for that case; `registry.register` still demands the transcript, which sessionRepair's
 * `findResumedTranscript` derives from the id. `--fork-session` (claude) writes a NEW session, so
 * that argv names the PARENT and must not bind — `codex fork <id>` never matched `resume` to begin with.
 *
 * The id pattern is a filter, not decoration: `-r` on Command Code takes "a name (use quotes for
 * multi-word names)", so a title would otherwise be registered as a session id.
 *
 * Claude Code's and Codex's entries are their discovery contracts' (`resumeArgs`, engines/discoveries.ts).
 */
const RESUME_ARGS: Partial<Record<RegisteredSession['engine'], { flags: readonly string[]; id: RegExp; unless?: readonly string[] }>> = {
  ...discoveryField('resumeArgs'),
  cursor: { flags: ['--resume'], id: /^[0-9a-f-]{16,}$/i },
  // `--fork` continues from the id but writes a NEW session, so the id in argv is the parent's.
  opencode: { flags: ['--session', '-s'], id: /^ses_[A-Za-z0-9]+$/, unless: ['--fork'] },
  // Kilo inherits opencode's resume flags and its `ses_` id prefix — measured on this machine's kilo.db:
  // `ses_024a007fdffe11yG68JPxsHJly`. `--fork` is deliberately NOT here: it CONTINUES from an id but
  // writes a NEW session, so the id in argv is the parent's and would bind the agent to the wrong row.
  kilo: { flags: ['--session', '-s'], id: /^ses_[A-Za-z0-9]+$/, unless: ['--fork'] },
  pi: { flags: ['--session', '--session-id'], id: /^[0-9a-f][0-9a-f-]{7,}$/i },
  // Hermes ids are timestamps: 20260728_115628_f2c86a.
  // Hermes ids are timestamps (20260728_115628_f2c86a), or uuids for an editor's (ACP) sessions.
  hermes: { flags: ['--resume', '-r'], id: /^(?:\d{8}_\d{6}_[0-9a-z]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i },
  // `devin -r <id>` / `--resume <id>`: ids are word slugs (`brisk-otter`).
  devin: { flags: ['--resume', '-r'], id: /^[a-z0-9]+(?:-[a-z0-9]+)+$/ },
  commandcode: { flags: ['--resume', '-r', '--session'], id: /^[0-9a-f-]{16,}$/i },
  // `muse resume <uuid>` names the session; `muse resume --last` does not, so that form falls through
  // to the scan in sessionRepair instead.
  muse: { flags: ['resume', '--session-id'], id: /^[0-9a-f-]{16,}$/i },
  // `amp threads continue <id>` names the thread; the bare `amp last` does not. Amp's ids are the only
  // ones here with a fixed prefix (`T-019fda49-…`), so the pattern doubles as proof it IS an amp id.
  amp: { flags: ['continue', '-c'], id: /^T-[0-9a-f-]{16,}$/i },
  // Grok 1.0.0 accepts both spellings and persists UUID session ids below ~/.grok/sessions.
  grok: { flags: ['--resume', '-r'], id: /^[0-9a-f-]{16,}$/i },
  // `agy --conversation <uuid>` resumes by conversation id; `-c`/`--continue` names nothing and falls
  // through to the presence-lock lookup in sessionRepair.
  agy: { flags: ['--conversation'], id: /^[0-9a-f-]{16,}$/i },
  // `copilot --resume=<id>` and `--session-id <id>`; bare `--resume`/`--continue` name nothing and
  // fall through to the directory scan in sessionRepair.
  copilot: { flags: ['--resume', '--session-id'], id: /^[0-9a-f-]{16,}$/i },
}

/**
 * Whether a live process's argv already contains every flag this engine's confirmed bypass-permission
 * mode requires. Discovery reads it off every running agent and keeps the registry row's
 * `bypassPermission` in step with it, which is what a relaunch reads (a row written before the field
 * existed learns it here). Token-exact via `argvTokens`, not a substring `.includes()` check on the raw
 * string, so a prompt or argument that merely CONTAINS the flag text cannot false-positive. Engines
 * with no confirmed bypass flag (`BYPASS_PERMISSION_FLAGS[engine] === null`) always read false — never
 * guess.
 */
export function bypassPermissionActive(engine: RegisteredSession['engine'], args: string): boolean {
  const flags = BYPASS_PERMISSION_FLAGS[engine]
  if (!flags) return false
  // A named mode says exactly how much the engine approves on its own (`full` — the old
  // skip-everything flag — included); only an argv naming none falls back to the bare flag check.
  const tokens = argvTokens(args)
  const mode = permissionModeFromTokens(engine, tokens)
  return mode ? permissionModeApproves(mode) : flagsInOrder(tokens, flags)
}

/**
 * The permission mode a live process's argv names — the inverse of `permissionModeFlags`, so the row
 * of an agent somebody typed into a terminal (or one written before modes were recorded) can carry
 * the SAME mode a created one does, and a relaunch brings it back exactly: `--dangerously-skip-permissions`
 * comes back as `--dangerously-skip-permissions`, not downgraded to the auto mode. Null when argv
 * names no mode — which is not `ask` (a person picking Ask records it; an argv with no flag is just
 * silent), so `bypassPermission` keeps deciding there as before. Token-exact like
 * `bypassPermissionActive`; an engine with no mode table reads null.
 */
export function permissionModeFromArgv(engine: RegisteredSession['engine'], args: string): string | null {
  return permissionModeFromTokens(engine, argvTokens(args))
}

function permissionModeFromTokens(engine: RegisteredSession['engine'], tokens: readonly string[]): string | null {
  const modes = PERMISSION_MODES[engine]
  if (!modes) return null
  // `full` is checked ahead of the rest where the engine has it: its flag is a single token no other
  // mode shares, and an argv carrying both it and `--permission-mode` is running without permissions
  // whatever else it says. `ask` is empty for most engines and can never be "found"; Claude Code's names its mode.
  const names = ['full', ...Object.keys(modes).filter((mode) => mode !== 'full')]
  for (const mode of names) {
    const flags = modes[mode]
    if (flags?.length && flagsInOrder(tokens, flags)) return mode
  }
  return null
}

/** The flags in order, as launch writes them (`--permission-mode auto` is two tokens, and "auto"
 *  alone elsewhere in argv is not the mode) — or `--flag=value` as one. */
function flagsInOrder(tokens: readonly string[], want: readonly string[]): boolean {
  return tokens.some((_, i) => want.every((flag, j) => tokens[i + j] === flag))
    || (want.length === 2 && tokens.includes(`${want[0]}=${want[1]}`))
}

/** The session id an engine was told to resume, or null when argv does not name one. */
export function resumeSessionId(engine: RegisteredSession['engine'], args: string, nativeArgv?: readonly string[]): string | null {
  const spec = RESUME_ARGS[engine]
  if (!spec) return null
  if (nativeArgv) {
    if (spec.unless?.some(flag => nativeArgv.includes(flag))) return null
    for (const flag of spec.flags) {
      for (let index = 0; index < nativeArgv.length; index++) {
        const token = nativeArgv[index]
        const value = token.toLowerCase() === flag.toLowerCase() ? nativeArgv[index + 1]
          : token.toLowerCase().startsWith(`${flag.toLowerCase()}=`) ? token.slice(flag.length + 1) : undefined
        if (value && spec.id.test(value)) return value
      }
    }
    return null
  }
  if (spec.unless) {
    const tokens = argvTokens(args)
    if (spec.unless.some((flag) => tokens.includes(flag))) return null
  }
  for (const flag of spec.flags) {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const value = new RegExp(`(?:^|\\s)${escaped}(?:=|\\s+)(\\S+)`, 'i').exec(args)?.[1]
    if (value && spec.id.test(value)) return value
  }
  return null
}

/**
 * A whole C-locale `lstart` stamp — `DOW MON DD HH:MM:SS YYYY` — and nothing else.
 *
 * The names are spelled out rather than left as `\S+` so this also rejects a stamp recorded while `ps`
 * still ran under the user's own `LC_TIME` (`K szept. 15 …` parsed fine before `psEnv` landed). Such a
 * stamp can never equal the C-locale one read back for the same process, so without this it would fail
 * the identity comparison below and evict a live pane once per session on upgrade.
 */
export const LSTART_MARKER_RE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4}$/

/**
 * A Windows start marker: `w:` and the process's creation time as a FILETIME, read by the PTY host
 * (pty/src/ps.rs) from the kernel. It is read the same at every scan, so it compares as an `lstart` stamp does.
 */
export const WINDOWS_START_MARKER_RE = /^w:\d+$/

/** Whether a saved marker is one a fresh read can equal: a C-locale `lstart` stamp, or a Windows one. */
export function comparableStartMarker(marker: string): boolean {
  return LSTART_MARKER_RE.test(marker) || WINDOWS_START_MARKER_RE.test(marker)
}
