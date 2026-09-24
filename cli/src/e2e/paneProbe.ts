/**
 * paneProbe — run the smoke checks against a LIVE agent pane, the way a person would: type the
 * prompt into the tmux pane, wait for the marker to show up in what the pane prints.
 *
 * tmux only. The harness runs every agent in a tmux pane (`tmuxBackend.ts`), and `respawn-pane`
 * keeps the pane id across a grid switch, so one `%N` follows the agent through all three legs.
 *
 * Pure-ish: the tmux calls are injected (`Tmux`) so the sequencing — settle, type, poll, tail — is
 * unit-testable offline; `realTmux` is the one that shells out.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SCENARIO, type CheckOutcome, type Leg, type LegOutcome, type LogKind, type SmokeCheck } from './smokeChecks.js'

const execFileP = promisify(execFile)
let typeSequence = 0

export interface Tmux {
  /** The pane's visible text plus scrollback tail (`capture-pane -p -S -<lines>`). */
  capture(pane: string, lines: number): Promise<string>
  /** Type `text` literally, then Enter. */
  type(pane: string, text: string): Promise<void>
  /** Press one key by tmux name (`1`, `Enter`, `Escape`) — for a dialog, not for a prompt. */
  key(pane: string, key: string): Promise<void>
  sleep(ms: number): Promise<void>
  now(): number
}

export const realTmux: Tmux = {
  async capture(pane, lines) {
    const { stdout } = await execFileP('tmux', ['capture-pane', '-p', '-t', pane, '-S', `-${lines}`], { timeout: 5000 })
    return stdout
  },
  async type(pane, text) {
    // Not `send-keys -l`: a whole line arriving as one keystroke burst trips the TUI's paste
    // detector (codex 0.155.1 kept the text in the composer and swallowed the Enter). The harness's
    // own injection (`lib/tmux.ts sendToTmux`) pastes from a named buffer, lets it land, then sends
    // Enter on its own — same sequence here.
    const buffer = `e2e-probe-${process.pid}-${++typeSequence}`
    await execFileP('tmux', ['set-buffer', '-b', buffer, '--', text], { timeout: 5000 })
    await execFileP('tmux', ['paste-buffer', '-t', pane, '-b', buffer, '-d'], { timeout: 5000 })
    await new Promise((r) => setTimeout(r, 400))
    await execFileP('tmux', ['send-keys', '-t', pane, 'Enter'], { timeout: 5000 })
  },
  async key(pane, key) {
    await execFileP('tmux', ['send-keys', '-t', pane, key], { timeout: 5000 })
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
}

/**
 * Startup dialogs a fresh coding tool puts in front of its prompt. A check typed into one of these
 * is not a check: the text is swallowed and Enter picks whatever is highlighted (measured: codex
 * 0.155's "Update available" took the Enter as "1. Update now" and ran `npm install -g`). Each is
 * answered the way a person running a test would — and each answer is recorded in the leg's
 * evidence, since a tool that greets every resume with a dialog is itself a finding.
 */
export const STARTUP_DIALOGS: ReadonlyArray<{ id: string; match: RegExp; keys: string[] }> = [
  // codex: "Do you trust the contents of this directory?" 1. Yes, continue
  { id: 'codex-trust', match: /Do you trust the contents of this directory/, keys: ['1', 'Enter'] },
  // codex: "Update available! x -> y" 1. Update now / 2. Skip / 3. Skip until next version
  { id: 'codex-update', match: /Update available!/, keys: ['2', 'Enter'] },
  // claude: "Do you trust the files in this folder?" — Enter accepts the highlighted "Yes, proceed"
  { id: 'claude-trust', match: /Do you trust the files in this folder/, keys: ['Enter'] },
  // claude: a project .mcp.json must be approved — Enter accepts the highlighted "Use this and all future MCP servers"
  { id: 'claude-mcp-approve', match: /MCP server[s]? (found|configured) in \.mcp\.json|Use this and all future MCP servers|Use this MCP server/, keys: ['Enter'] },
  // claude, on `--dangerously-skip-permissions` (permission mode `full`): a full-screen Bypass
  // Permissions warning whose DEFAULT is "No, exit" — Enter alone exits 1 and leaves the pane a
  // shell. Down first, then Enter, picks "Yes, I accept". This is not a fallback in practice: with
  // `bypassPermissionsModeAccepted` already written to ~/.claude.json, claude 2.1.281 still drew the
  // warning, and answering it here is what let the run's first leg happen at all.
  { id: 'claude-bypass-accept', match: /running in Bypass Permissions mode/, keys: ['Down', 'Enter'] },
  // claude, MID-TURN, on any gateway (measured on grid.autonomous.ai AND a local relay): an "auto mode
  // classifier … your requests go through <host>, which isn't compatible" notice that blocks the turn
  // until a key is pressed. A finding about the relay's Anthropic contract, and a modal to get past.
  { id: 'claude-automode-notice', match: /isn't compatible with this update|ask your gateway to/, keys: ['Enter'] },
]

/**
 * Answer any startup dialog on screen, then wait for the pane to settle again. Returns the ids of
 * the dialogs answered (evidence). Bounded: a dialog that comes back after being answered is left
 * alone after `max` rounds so the check that follows records it as stuck, with the dialog on the tail.
 */
export async function dismissStartupDialogs(tmux: Tmux, pane: string, opts: ProbeOptions = {}, max = 3): Promise<string[]> {
  const o = { ...DEFAULTS, ...opts }
  const answered: string[] = []
  for (let round = 0; round < max; round++) {
    const screen = await tmux.capture(pane, o.tailLines)
    const dialog = STARTUP_DIALOGS.find((d) => d.match.test(screen))
    if (!dialog) break
    for (const k of dialog.keys) {
      await tmux.key(pane, k)
      await tmux.sleep(300)
    }
    answered.push(dialog.id)
    await waitForPaneSettle(tmux, pane, opts)
  }
  return answered
}

export interface ProbeOptions {
  /** How long one check may take before it is `stuck`. Grid models can be slow; default 90s. */
  checkTimeoutMs?: number
  /** The tool / MCP log lines right now (`workspace.ts readLog`); a step with a `log` needs one new matching line. */
  readLog?: (kind: LogKind) => string[]
  /** The pane is "ready" once its screen stops changing for this long. A resumed TUI needs it. */
  settleMs?: number
  /** Give up waiting for the pane to settle after this long (the TUI itself may be stuck). */
  settleTimeoutMs?: number
  pollMs?: number
  tailLines?: number
}

const DEFAULTS: Required<ProbeOptions> = {
  checkTimeoutMs: 90_000,
  readLog: () => [],
  settleMs: 2_000,
  settleTimeoutMs: 60_000,
  pollMs: 1_000,
  tailLines: 40,
}

/** Wait until two consecutive captures match — the TUI has drawn and is waiting on input. */
export async function waitForPaneSettle(tmux: Tmux, pane: string, opts: ProbeOptions = {}): Promise<boolean> {
  const o = { ...DEFAULTS, ...opts }
  const start = tmux.now()
  let last = await tmux.capture(pane, o.tailLines)
  while (tmux.now() - start < o.settleTimeoutMs) {
    await tmux.sleep(o.settleMs)
    const next = await tmux.capture(pane, o.tailLines)
    if (next === last) return true
    last = next
  }
  return false
}

/** A short tag typed after the prompt so THIS check's echo can be told from earlier ones. */
export function checkRef(now: number): string {
  return `ref-${now.toString(36).slice(-4).padStart(4, '0')}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`
}

/**
 * Type one check into the pane and wait for its marker. Evidence (`tail`) comes back either way.
 *
 * The marker only counts AFTER the echo of this check's own `ref` tag. Counting occurrences was
 * wrong: a resume redraws the whole transcript, so the previous leg's answer is on screen again,
 * and as the new turn scrolls the old one out the count stays flat — a real `ANSWER_42` on the
 * back-home leg was recorded as stuck (measured, codex 0.155.1). The tag pins the search to the
 * new turn instead; a wrapped tag (never echoed in one piece) falls back to "one more hit than before".
 */
export async function runCheck(tmux: Tmux, pane: string, check: SmokeCheck, opts: ProbeOptions = {}): Promise<CheckOutcome> {
  const o = { ...DEFAULTS, ...opts }
  const marker = new RegExp(check.marker)
  const before = await tmux.capture(pane, o.tailLines)
  const baselineHits = (before.match(new RegExp(check.marker, 'g')) ?? []).length
  const logBefore = check.log ? o.readLog(check.log).length : 0
  const start = tmux.now()
  const ref = checkRef(start)
  await tmux.type(pane, `${check.prompt} (${ref})`)
  let tail = before
  const dialogs: string[] = []
  while (tmux.now() - start < o.checkTimeoutMs) {
    await tmux.sleep(o.pollMs)
    tail = await tmux.capture(pane, o.tailLines)
    // A modal can land in the middle of a turn (claude's gateway notice); answer it and keep waiting.
    const modal = STARTUP_DIALOGS.find((d) => d.match.test(tail) && !dialogs.includes(d.id))
    if (modal) {
      for (const k of modal.keys) { await tmux.key(pane, k); await tmux.sleep(300) }
      dialogs.push(modal.id)
      continue
    }
    const echo = tail.lastIndexOf(ref)
    const afterEcho = echo >= 0 ? tail.slice(echo + ref.length) : null
    const hits = (tail.match(new RegExp(check.marker, 'g')) ?? []).length
    if ((afterEcho !== null && marker.test(afterEcho)) || (afterEcho === null && hits > baselineHits)) {
      const elapsedMs = tmux.now() - start
      const seen = dialogs.length ? { dialogs } : {}
      if (!check.log) return { id: check.id, status: 'ok', elapsedMs, tail: tail.trimEnd(), ...seen }
      // The marker is on screen; now the proof it went through the tool: a new log line for this step.
      const logLines = o.readLog(check.log).slice(logBefore)
      const used = check.logPattern ? logLines.some((l) => l.includes(check.logPattern!)) : logLines.length > 0
      return used
        ? { id: check.id, status: 'ok', elapsedMs, tail: tail.trimEnd(), logLines, ...seen }
        : { id: check.id, status: 'stuck', elapsedMs, tail: tail.trimEnd(), logLines, note: `marker shown but ${check.log} log gained no line matching "${check.logPattern}" — answered without using it`, ...seen }
    }
  }
  const logLines = check.log ? o.readLog(check.log).slice(logBefore) : undefined
  return { id: check.id, status: 'stuck', elapsedMs: tmux.now() - start, tail: tail.trimEnd(), ...(logLines ? { logLines } : {}), ...(dialogs.length ? { dialogs } : {}) }
}

/**
 * Run this leg's steps of the scenario, in order. Stops at the first stuck step: a pane that is
 * not answering will not answer the next prompt either, and the queued text would only muddy the evidence.
 */
export async function probeLeg(tmux: Tmux, pane: string, leg: Leg, opts: ProbeOptions = {}): Promise<LegOutcome> {
  const steps = SCENARIO[leg]
  const checks: CheckOutcome[] = []
  const settled = await waitForPaneSettle(tmux, pane, opts)
  if (!settled) {
    const tail = (await tmux.capture(pane, opts.tailLines ?? DEFAULTS.tailLines)).trimEnd()
    // Nothing typed: the TUI never stopped redrawing, so the first check is stuck before it began.
    checks.push({ id: steps[0].id, status: 'stuck', elapsedMs: 0, tail })
    for (const c of steps.slice(1)) checks.push({ id: c.id, status: 'not-run' })
    return { leg, checks }
  }
  const dialogs = await dismissStartupDialogs(tmux, pane, opts)
  for (const [i, check] of steps.entries()) {
    const outcome = await runCheck(tmux, pane, check, opts)
    checks.push(outcome)
    if (outcome.status === 'stuck') {
      for (const rest of steps.slice(i + 1)) checks.push({ id: rest.id, status: 'not-run' })
      break
    }
  }
  return dialogs.length ? { leg, checks, dialogs } : { leg, checks }
}
