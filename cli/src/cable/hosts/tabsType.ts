/**
 * The dial's words typed into an agent's own iTerm2 or Ghostty tab, through the watch and Harness Device's fixed write
 * handlers (docs/plans/2026-11-25-dial-voice-codex-terminals-design.md). They go only while every check holds, just
 * before the words and again just before their Enter, each against a way they would reach another program:
 * 1. The stream is the very one the send began on: a newer watch is another Harness Device, which never had the words.
 * 2. The pane has a proof, in iTerm2 or Ghostty: a nested agent's tty is its multiplexer's, and Terminal.app's only
 *    per-tab write appends a newline to the words in the same write.
 * 3. No other live agent is on the tty: a `codex exec` from Claude's shell tool runs on Claude's tty and would take them.
 * 4. ps: the tty and start are the proof's, so a new process on the tty is another agent, and the agent leads the tty's
 *    foreground group: after a Ctrl-Z, or with a shell left in front, the words would run as a command.
 * 5. lsof: only the agent and its parents read the tty: Claude Code's Ctrl-G editor, a pager or a `!` command would
 *    take them.
 * 6. The source says the agent is at its prompt: a turn begun or a prompt open would take them as its answer.
 * 7. Harness Device writes only to the one session of the app whose tty is the pane's: a pty no session of the app holds
 *    (tmux's, an editor's, another terminal's) gets nothing.
 * It logs nothing: why a send stopped travels in its result, which the source logs as one fixed word.
 */
import { execFile } from 'node:child_process'
import { lstartGeneration } from '../../lib/lstart.js'
import type { HostAdapter } from './adapter.js'
import { parentChain, type ProcessName } from './scannedApp.js'
import { paneTab, runPs, TAB_TTY, type RunPs, type TabApp } from './tabs.js'
import { TYPE_ANSWER_MS, TYPE_APPS, type TabsLine, type TabsWrite, type TypeApp } from './tabsLines.js'
import { cleanWords, createTwoStep, type StepAnswer } from './twoStep.js'
import type { TabsReason, TypeResult } from './types.js'

/** A process as its tty sees it: the tty, its group, the tty's foreground group, and its start (`ps:<ms>`) when that
 *  parsed. */
export interface TabProcess {
  tty: string
  pgid: number
  tpgid: number
  start?: string
}

const NUMBER = /^\d+$/

/** A process's tty, groups and start from one read, so all are of one process; none when the run failed or printed
 *  anything but one such row. Under psEnv (runPs), as the proof's start was read. */
export async function readTabProcess(pid: number, run: RunPs = runPs): Promise<TabProcess | undefined> {
  const out = await run(['-o', 'tty=,pgid=,tpgid=,lstart=', '-p', String(pid)], { timeout: 1_000, maxBuffer: 256 })
  const rows = out?.trim().split('\n')
  if (rows?.length !== 1) return undefined
  const [name = '', pgid = '', tpgid = '', ...lstart] = rows[0].trim().split(/\s+/)
  const tty = `/dev/${name}`
  if (!TAB_TTY.test(tty) || !NUMBER.test(pgid) || !NUMBER.test(tpgid)) return undefined
  const read = { tty, pgid: Number(pgid), tpgid: Number(tpgid) }
  const start = lstartGeneration(lstart.join(' '))
  return start === undefined ? read : { ...read, start }
}

/** lsof's exit code (none once killed past its timeout) and stdout; null when it did not run or printed past maxBuffer. */
export type RunLsof = (args: string[], bounds: { timeout: number; maxBuffer: number }) => Promise<{ code: number | null; stdout: string } | null>

export const READERS_TIMEOUT_MS = 2_000
/** A pid a line: hundreds of readers. */
const READERS_MAX_BYTES = 4096

const runLsof: RunLsof = (args, bounds) => new Promise((resolve) => {
  execFile('/usr/sbin/lsof', args, { ...bounds, killSignal: 'SIGKILL' }, (error, stdout) => {
    // A code that is a word is no exit: lsof did not start, or printed past maxBuffer.
    if (error === null) resolve({ code: 0, stdout })
    else resolve(typeof error.code === 'string' ? null : { code: error.code ?? null, stdout })
  })
})

/** The processes whose stdin is the tty; none when lsof could not say. Exit 1 is a read too: lsof exits so when no
 *  process has the tty open, and on a warning beside what it printed. */
export async function readTtyReaders(tty: string, run: RunLsof = runLsof): Promise<readonly number[] | undefined> {
  if (!TAB_TTY.test(tty)) return undefined
  const read = await run(['-a', '-d', '0', '-t', tty], { timeout: READERS_TIMEOUT_MS, maxBuffer: READERS_MAX_BYTES })
  if (!read || (read.code !== 0 && read.code !== 1)) return undefined
  const lines = read.stdout.split('\n').filter((line) => line !== '')
  return lines.every((line) => NUMBER.test(line)) ? lines.map(Number) : undefined
}

export interface TabsTypeDeps {
  /** The watch's tabs stream now; none while no watch holds one. */
  line(): TabsLine | undefined
  /** Whether another live agent than the one in process [pid] is on that tty (observed.ts othersOnTty). */
  shared(tty: string, pid: number): boolean
  process(pid: number): Promise<TabProcess | undefined>
  readers(tty: string): Promise<readonly number[] | undefined>
  processes(): Promise<readonly ProcessName[]>
  after(ms: number, run: () => void): () => void
}

const typeApp = (app: TabApp): TypeApp | undefined => TYPE_APPS.find((one) => one === app)

/** The tabs adapter's typing, spread onto it (adapter.ts rule 2). */
export function tabsTyping(deps: TabsTypeDeps): Required<Pick<HostAdapter, 'canType' | 'type'>> {
  // One send at a time on a tty, held until a late answer can no longer come: Harness Device's script thread can hold
  // a write behind a consent prompt, and a write it runs late must never meet another send's Enter.
  const twoStep = createTwoStep<string>(deps.after)

  /** Whether the line takes a write within TYPE_ANSWER_MS. A drain wakes every waiter, and another's write may fill the
   *  line again first: each wake asks again, within the one bound. */
  const drained = async (line: TabsLine): Promise<boolean> => {
    let cancel = (): void => {}
    const late = new Promise<false>((resolve) => { cancel = deps.after(TYPE_ANSWER_MS, () => resolve(false)) })
    try {
      // The bound first: past it, a wake that came with it waits no more.
      while (!line.writable()) if (!(await Promise.race([late, line.ready(TYPE_ANSWER_MS)]))) return false
      return true
    } finally {
      cancel()
    }
  }

  return {
    canType: (pane) => {
      const tab = paneTab(pane)
      return deps.line() !== undefined && pane.proof !== undefined && tab !== null && typeApp(tab.app) !== undefined
    },
    type: async (pane, text, _engine, atPrompt): Promise<TypeResult> => {
      const words = cleanWords(text)
      const tab = paneTab(pane)
      if (!words || !tab) return false
      // The line the send began on, which every check compares: a newer watch's is another object.
      const line = deps.line()
      if (!line) return { notSent: 'no-stream' }
      const { proof } = pane
      if (!proof) return { notSent: 'nested' }
      const app = typeApp(tab.app)
      if (!app) return { notSent: 'terminal-app' }
      const { tty } = tab
      const { pid } = proof

      // A read that rejects, or throws as it is asked, is a check that failed.
      const alone = async (): Promise<boolean> => {
        const readers = await (async () => deps.readers(tty))().catch(() => undefined)
        if (!readers?.includes(pid)) return false
        const rows = await (async () => deps.processes())().catch(() => undefined)
        if (!rows) return false
        const own = new Set(parentChain(pid, new Map(rows.map((row) => [row.pid, row]))).map((p) => p.pid))
        return readers.every((reader) => own.has(reader))
      }
      const check = async (): Promise<TabsReason | undefined> => {
        // ps read last, as lsof may take its 2 s: a Ctrl-Z or a quit meanwhile would leave the words at a shell.
        const isAlone = await alone()
        const now = await (async () => deps.process(pid))().catch(() => undefined)
        if (!now || now.tty !== tty || now.start !== proof.start || now.tpgid <= 0) return 'process'
        if (now.pgid !== now.tpgid) return 'background'
        if (!isAlone) return 'foreground-child'
        // Asked after the reads, which take seconds at most: a newer watch, another agent on the tty or a turn begun
        // meanwhile stops the line.
        if (deps.line() !== line) return 'no-stream'
        if (deps.shared(tty, pid)) return 'shared'
        return atPrompt?.() ? undefined : 'busy'
      }
      const step = async (typing: TabsWrite): Promise<StepAnswer<TabsReason>> => {
        if (!line.writable()) {
          if (!(await drained(line))) return { ok: false, why: line.ended.aborted ? 'no-stream' : 'no-answer' }
          // The checks that let this line go are older than the wait.
          const why = await check()
          if (why) return { ok: false, why }
        }
        const { answer, settled } = line.send(typing)
        // An answer lost may still come late: the tty stays held until the line settles.
        const wrote = await answer.catch(() => 'unanswered' as const)
        if (wrote === 'ok') return { ok: true, held: settled }
        return { ok: false, why: wrote === 'refused' ? 'no-session' : wrote === 'ended' ? 'no-stream' : 'no-answer', held: settled }
      }
      const sent = await twoStep.send<TabsReason | false>(tty, words, {
        check,
        words: () => step({ write: { app, tty, text: words } }),
        enter: () => step({ enter: { app, tty } }),
      }, false, 'busy')
      return typeof sent === 'string' ? { notSent: sent } : sent
    },
  }
}
