/**
 * tmux and the process table — the two things the daemon does not put on the wire.
 *
 * What the bridge knows: who the agents are, where their panes are, when their transcripts last moved.
 * What it does not: whether a pane is dead, whether anybody is attached to it, and how much memory the
 * engine behind it is holding. Those are one `tmux list-panes` and one `ps` away, and they are the two
 * columns that make a fleet legible — so they are read here, cheaply, once per refresh.
 *
 * Every tmux call is `execFile` with an argument list: no shell, no interpolation, and a pane id is
 * validated against `%\d+` before it is ever passed, because a pane id from a bad snapshot must fail
 * as an argument rather than arrive somewhere as syntax.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const PANE = /^%\d+$/

export function isPaneId(value) { return typeof value === 'string' && PANE.test(value) }

function assertPane(pane) {
  if (!isPaneId(pane)) throw new Error(`Not a tmux pane id: ${JSON.stringify(pane)}`)
  return pane
}

async function tmux(args, { timeout = 4000 } = {}) {
  const { stdout } = await exec('tmux', args, { timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' })
  return stdout
}

/** tmux renders a raw control byte in `-F` output as its octal escape (`\\037`), so a separator has to
 *  be printable. `§§` is: two bytes no process name or session name carries, and a line that somehow
 *  did contain it fails the pane-id check and is skipped rather than parsed wrong. */
const SEP = '\u00a7\u00a7'

const FIELDS = [
  'pane_id', 'pane_dead', 'pane_pid', 'pane_current_command', 'session_name',
  'session_attached', 'window_index', 'pane_index', '@harness_engine_exit', 'window_activity',
]

/**
 * Every pane on this tmux server, by pane id.
 *
 * `dead` is a pane whose process exited while tmux was told to keep it — its scrollback is still there
 * and `respawn-pane` brings it back, which is what makes pausing lossless. `engineExit` is the status
 * Harness's own launch wrapper records when an engine leaves and the pane falls back to a shell: its
 * presence is the difference between "the engine is gone" and "the install is still running".
 */
export async function panes({ run = tmux } = {}) {
  let out
  try { out = await run(['list-panes', '-a', '-F', FIELDS.map((f) => `#{${f}}`).join(SEP)]) }
  catch { return new Map() } // no tmux server at all: every agent is gone, and the caller says so
  const rows = new Map()
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const [id, dead, pid, command, session, attached, window, index, engineExit, activity] = line.split(SEP)
    if (!isPaneId(id)) continue
    rows.set(id, {
      pane: id,
      dead: dead === '1',
      pid: Number(pid) || null,
      command: command || '',
      session: session || '',
      attached: attached === '1',
      target: `${session}:${window}.${index}`,
      engineExit: engineExit === '' || engineExit === undefined ? null : Number(engineExit),
      // tmux counts in seconds. Last time anything was DRAWN in this window: not a turn (a spinner is
      // activity too), but the right signal for "something is happening in there right now".
      lastOutput: activity ? Number(activity) * 1000 : null,
    })
  }
  return rows
}

/** One snapshot of the process table, as a parent → children index. Cheaper than one `ps` per agent,
 *  and consistent: every row in a refresh is measured against the same instant. */
export async function processTable({ run = exec } = {}) {
  let stdout = ''
  try { ({ stdout } = await run('ps', ['-Ao', 'pid=,ppid=,rss=,pcpu=,comm='], { timeout: 6000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' })) }
  catch { return { byPid: new Map(), children: new Map() } }
  const byPid = new Map()
  const children = new Map()
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1]); const ppid = Number(match[2])
    byPid.set(pid, { pid, ppid, rss: Number(match[3]) * 1024, cpu: Number(match[4]) || 0, comm: match[5].trim() })
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
  }
  return { byPid, children }
}

/** Command names that mean "this is the engine", per engine id. The pane's shell spawns the engine as
 *  a child, and some engines then spawn their own vendored binary — so the walk matches on basename
 *  and takes the shallowest match, which is the process a SIGTERM should go to. */
const ENGINE_COMMANDS = {
  claude: ['claude'], codex: ['codex'], opencode: ['opencode'], cursor: ['cursor-agent'],
  gemini: ['gemini'], grok: ['grok'], copilot: ['copilot'], amp: ['amp'], pi: ['pi'],
  hermes: ['hermes'], muse: ['muse'], kilo: ['kilo'], devin: ['devin'], commandcode: ['cmd'],
  aider: ['aider'], goose: ['goose'], qwen: ['qwen'], droid: ['droid'], auggie: ['auggie'],
}

const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', '-zsh', '-bash'])

/**
 * Walk a pane's process subtree: the engine process to signal, the subtree's memory, its CPU.
 *
 * Memory is the whole subtree because an engine's helpers are its cost too — the number a person is
 * deciding about is "what do I get back if I pause this", not "how big is one pid".
 *
 * The engine is matched at the ROOT as well as below it. tmux's `pane_pid` is the engine itself for
 * every agent whose pane was started on the engine directly (most of them); it is a shell only when the
 * launch wrapper is in play, or after the engine has left and the pane fell back to one. Matching is on
 * the executable's basename, not the process title, because Claude Code renames itself to its version
 * (`2.1.268`) the moment it starts — `pane_current_command` is that title, and it is useless here.
 */
export function engineProcess(pane, table, engine) {
  if (!pane?.pid || !table.byPid.size) return { pid: null, rss: 0, cpu: 0, procs: 0, engineAlive: false }
  const wanted = new Set(ENGINE_COMMANDS[engine] ?? [engine])
  let pid = null, rss = 0, cpu = 0, procs = 0, depth = Infinity
  const walk = (current, level) => {
    const info = table.byPid.get(current)
    if (!info) return
    procs += 1; rss += info.rss; cpu += info.cpu
    const base = info.comm.split('/').pop()
    if (wanted.has(base) && level < depth) { pid = current; depth = level }
    for (const child of table.children.get(current) ?? []) walk(child, level + 1)
  }
  walk(pane.pid, 0)
  const self = table.byPid.get(pane.pid)
  // The pane's own shell is not the agent's cost; subtract it when the engine is gone and all that is
  // left is the fallback shell, so a paused row reads 0 rather than a few megabytes of zsh.
  if (!pid && self && SHELLS.has(self.comm.split('/').pop())) return { pid: null, rss: 0, cpu: 0, procs, engineAlive: false }
  return { pid, rss, cpu, procs, engineAlive: pid !== null }
}

/** The pane's visible screen, for the blocked-prompt check and the inspector's preview. */
export async function capture(pane, { lines = 40, run = tmux } = {}) {
  assertPane(pane)
  try { return await run(['capture-pane', '-p', '-t', pane, '-S', `-${Math.max(1, Math.min(200, lines))}`]) }
  catch { return '' }
}

/**
 * Does this pane look like it is waiting on a person?
 *
 * Best effort, and deliberately loud about it: the app's own **Agents needing input** (⇧⌘I) is the
 * authority, and the daemon does not put pending questions on the local bridge. What is available is
 * the pane's last screen, and an engine waiting for an answer draws a recognizable prompt on it. A
 * false positive costs a harness that stays running; a false negative costs a question paused before it
 * was read — so the patterns are broad on purpose, and the policy protects anything that matches.
 */
const BLOCKED_PATTERNS = [
  /\bdo you want to (proceed|continue|allow)\b/i,
  /\b(allow|approve|permit) (this )?(command|tool|edit|request)\b/i,
  /\?\s*$/,
  /\(y\/n\)|\[y\/n\]|\(yes\/no\)/i,
  /^\s*❯?\s*1[.)]\s+\S/m,
  /\bwaiting for (your )?(input|answer|approval)\b/i,
  /\bpress (enter|y) to\b/i,
  // How an engine tells you it is holding a choice open. Found by watching Claude Code's real trust
  // prompt, which an earlier version of this list walked straight past.
  /\benter to (confirm|continue|select)\b/i,
  /\besc to cancel\b/i,
  /\bis this a project you (created or )?trust/i,
]

/**
 * A vertical menu: a cursor line with at least one more option under it.
 *
 * `❯ ` alone is NOT enough, and that mistake is worth keeping a note about: Claude Code echoes the
 * prompt you just submitted as `❯ your text`, so matching a lone cursor line marked every recently used
 * harness as blocked and refused to pause any of them. A menu has a second option under the cursor —
 * short, indented, and not a separator — and that is what this looks for.
 */
function looksLikeMenu(lines) {
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!/^\s*❯\s+\S/.test(lines[i])) continue
    const next = lines[i + 1]
    if (/^\s{2,}\S/.test(next) && next.trim().length <= 60 && !/^\s*[─━═]/.test(next)) return true
  }
  return false
}

/** The prompt an idle engine draws when it is waiting for a TASK, not for an answer. Subtracted before
 *  anything else runs — otherwise every quiet harness looks blocked and nothing would ever be paused. */
const IDLE_PROMPTS = [
  /^\s*❯\s*$/,
  /^\s*>\s*$/,
  /shift\+tab to cycle/i,
  /for shortcuts\s*$/i,
]

export function looksBlocked(screen) {
  const text = String(screen || '').replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
  const lines = text.split('\n').map((line) => line.replace(/[─━═]{4,}.*$/, '').trimEnd()).filter((line) => line.trim())
  const tail = lines.slice(-8)
  if (!tail.length) return false
  // An engine sitting at its own empty prompt is idle, not blocked — and its prompt line looks exactly
  // like a selected option, so it is removed before the patterns run.
  const candidates = tail.filter((line) => !IDLE_PROMPTS.some((pattern) => pattern.test(line)))
  if (!candidates.length) return false
  const body = candidates.join('\n')
  return looksLikeMenu(candidates) || BLOCKED_PATTERNS.some((pattern) => pattern.test(body))
}

/** Hold a pane open across its process exiting, and hand it back to tmux's own disposal afterwards —
 *  the same pair the daemon uses around a restart (`holdOpen` / `clearPaneRemainOnExit`). Pausing sets
 *  it before the engine is asked to leave, so a pane whose launch wrapper predates the fallback shell
 *  keeps its scrollback instead of taking its window down with it. */
export async function holdOpen(pane, on, { run = tmux } = {}) {
  assertPane(pane)
  try { await run(['set-option', '-w', '-t', pane, 'remain-on-exit', on ? 'on' : 'off']); return true }
  catch { return false }
}

export async function paneState(pane, { run = tmux } = {}) {
  assertPane(pane)
  try {
    const out = await run(['display-message', '-p', '-t', pane, `#{pane_dead}${SEP}#{pane_current_command}${SEP}#{@harness_engine_exit}`])
    const [dead, command, engineExit] = out.trim().split(SEP)
    return { dead: dead === '1', command: command || '', engineExit: engineExit ? Number(engineExit) : null }
  } catch { return null }
}

/** Type a line into a pane's shell. Used for one thing only: the local resume path, when the daemon is
 *  not reachable and the pane has already fallen back to a shell that adopts an engine when told to. */
export async function sendLine(pane, line, { run = tmux } = {}) {
  assertPane(pane)
  if (/[\r\n\u0000]/.test(line)) throw new Error('A pane command is one line.')
  await run(['send-keys', '-t', pane, line, 'Enter'])
}

export async function respawn(pane, { run = tmux } = {}) {
  assertPane(pane)
  await run(['respawn-pane', '-k', '-t', pane])
}

export { tmux as runTmux }
