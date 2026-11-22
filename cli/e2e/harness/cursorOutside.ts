/**
 * Cursor's agents outside Harness, told by Cursor's own hooks, as codexOutside.ts tells Codex: cursor-agent as the
 * foreground job of a real shell in a terminal of a fake Cursor, and Cursor's own agent a process under the fake Cursor
 * with no terminal. Each runs its hooks from its own process, through a shell as Cursor runs them, so the hook's caller
 * is the agent; its tab's terminal is its stdio, so they come and go on a socket in the daemon's root. Ending it closes
 * its tab.
 *
 * Its transcript is where Cursor writes one (engines/cursor/contract.ts CURSOR_TRANSCRIPT): the daemon's Cursor home,
 * its throwaway home's `.cursor`, in a folder named by its workspace, as tier A writes Cursor's.
 */
import type { ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import type { Writable } from 'node:stream'
import { expect } from 'vitest'
import { inside } from './appEvalDriver.js'
import { until, type IsolatedDaemon } from './daemon.js'
import { closeTab, openTab, type Tab } from './outsideAgent.js'

/** The agent's own process: each hook handed on the socket named by its argument run through a shell as Cursor runs it,
 *  one at a time, each answered there with its exit code and stderr. */
const OWN = `const { spawn } = require('node:child_process')
const channel = require('node:net').connect(process.argv[1])
require('node:readline').createInterface({ input: channel }).on('line', (line) => {
  const { command, cwd, env, input } = JSON.parse(line)
  const hook = spawn('/bin/sh', ['-c', command], { cwd, env, stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  hook.stderr.on('data', (chunk) => { stderr += chunk })
  hook.on('close', (code) => channel.write(JSON.stringify({ code, stderr }) + '\\n'))
  hook.stdin.end(input)
})`
/** For an agent to reach its socket. */
const CONNECT_MS = 30_000
/** For the daemon's Codex hooks to be in their file: Cursor's line is made from theirs. */
const LINE_MS = 30_000
/** Each socket a name of its own in the daemon's root. */
let channels = 0

export type CursorEvent = 'start' | 'turn-start' | 'turn-stop' | 'end'
/** Each event as Cursor's hooks name it (engines/cursor/contract.ts CURSOR_HOOK_SETTINGS). */
const EVENTS: Readonly<Record<CursorEvent, string>> = {
  start: 'sessionStart', 'turn-start': 'beforeSubmitPrompt', 'turn-stop': 'stop', end: 'sessionEnd',
}
/** What the person typed at a turn's start, as tier A's Cursor transcript holds it. */
const PROMPT = 'Eval prompt.'
/** The end of the daemon's Codex hook line (kit/notifyHooks.ts hookArgv): the engine is its last argument. */
const CODEX_ENGINE = / --engine codex$/

/**
 * What one of its hooks runs: Cursor's hook line, which is the daemon's Codex line with `--engine cursor` (both are
 * hookArgv's, the same notify.mjs and homes; the daemon installs no Cursor hooks here), under [env] and the session's
 * [hints], with Cursor's input for [event] on its stdin: its conversation, its workspace's folder, its transcript.
 */
export function hookRun(codexLine: string, env: NodeJS.ProcessEnv, hints: Record<string, string>, event: CursorEvent,
  session: { sessionId: string; cwd: string; transcriptPath: string }): { command: string; env: NodeJS.ProcessEnv; input: string } {
  if (!CODEX_ENGINE.test(codexLine)) throw new Error("a line that is not the daemon's Codex's hook line: it ends in no --engine codex")
  return {
    command: codexLine.replace(CODEX_ENGINE, ' --engine cursor'),
    env: { ...env, ...hints },
    input: JSON.stringify({
      hook_event_name: EVENTS[event], conversation_id: session.sessionId, workspace_roots: [session.cwd],
      transcript_path: session.transcriptPath,
      ...(event === 'turn-start' ? { prompt: PROMPT } : {}), ...(event === 'turn-stop' ? { status: 'completed' } : {}),
    }),
  }
}

/** A transcript line as Cursor writes it (engines/cursor/normalizer.ts lastCursorTurnText). */
const said = (role: 'user' | 'assistant', text: string): string => `${JSON.stringify({ role, message: { content: [{ type: 'text', text }] } })}\n`

export class CursorOutside {
  private constructor(private readonly d: IsolatedDaemon, private readonly tab: Tab, private readonly cwd: string,
    private readonly sessionId: string, private readonly hints: Record<string, string>, readonly transcriptPath: string,
    private readonly answers: Interface, private readonly requests: Writable) {}

  /**
   * In its folder under the daemon's projects, under a fake Cursor: with `terminal`, cursor-agent as the job of a shell
   * in a tab of it ([shellPid] is the shell the window reports), else Cursor's own agent under it with no terminal. Its
   * process goes in [children] too, the driver's last resort when its tab was not closed.
   */
  static async start(d: IsolatedDaemon, folder: string, children: ChildProcess[],
    { sessionId, terminal, hints }: { sessionId: string; terminal: boolean; hints: Record<string, string> }): Promise<CursorOutside> {
    const cwd = join(d.projectsDir, folder)
    mkdirSync(cwd, { recursive: true })
    const workspace = cwd.replace(/[^A-Za-z0-9]/g, '-').replace(/^-+/, '')
    const transcriptPath = join(d.env.HOME!, '.cursor', 'projects', workspace, 'agent-transcripts', sessionId, `${sessionId}.jsonl`)
    if (!inside(d.root, transcriptPath)) throw new Error("Cursor's transcript is not inside the daemon's root")
    mkdirSync(dirname(transcriptPath), { recursive: true })
    // A new one: the ids are the catalog's, and an earlier scenario on this daemon wrote under the same.
    writeFileSync(transcriptPath, '')
    const path = join(d.root, `cursor-${++channels}.sock`)
    const server = createServer()
    let socket: Socket | undefined
    server.once('connection', (connected) => { socket = connected })
    await new Promise<void>((listening, failed) => server.once('error', failed).listen(path, listening))
    let tab: Tab | undefined
    try {
      tab = await openTab(d, cwd, { ...d.env, ...hints, TERM: 'xterm-256color' }, [process.execPath, '-e', OWN, path],
        { app: 'cursor', shell: terminal })
      children.push(tab.process)
      const connected = await until(`the Cursor agent in ${folder} on its socket`, () => socket, CONNECT_MS, 50)
      return new CursorOutside(d, tab, cwd, sessionId, hints, transcriptPath, createInterface({ input: connected }), connected)
    } catch (error) {
      if (tab) await closeTab(tab, folder)
      throw error
    } finally {
      server.close()
    }
  }

  get pid(): number { return this.tab.pid }
  get shellPid(): number | undefined { return this.tab.shellPid }

  /** Runs the real hook/notify.mjs as Cursor's own hooks run it, its turn first written to its transcript as Cursor
   *  writes it: the prompt at its start, [lastAnswer] at its stop. */
  async hook(event: CursorEvent, lastAnswer?: string): Promise<void> {
    if (event === 'turn-start') appendFileSync(this.transcriptPath, said('user', PROMPT))
    if (event === 'turn-stop' && lastAnswer !== undefined) appendFileSync(this.transcriptPath, said('assistant', lastAnswer))
    const codexLine = await until("the daemon's Codex hook line in its hooks.json", () => {
      try {
        const blocks = (JSON.parse(readFileSync(join(this.d.env.CODEX_HOME!, 'hooks.json'), 'utf8')) as
          { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }).hooks?.SessionStart ?? []
        return blocks.flatMap((block) => block.hooks ?? []).map((hook) => hook.command).find((line) => line?.includes('notify.mjs'))
      } catch {
        return undefined
      }
    }, LINE_MS, 100)
    const run = hookRun(codexLine, this.d.env, this.hints, event, { sessionId: this.sessionId, cwd: this.cwd, transcriptPath: this.transcriptPath })
    const { code, stderr } = await this.ask(run)
    expect(code, stderr).toBe(0)
  }

  /** Its process and tab gone, with no hook: as Cursor ends its agent. */
  close(): Promise<void> {
    return closeTab(this.tab, this.cwd)
  }

  /** Through its own process, which answers each hook in turn: one ended first answers none. */
  private ask({ command, env, input }: ReturnType<typeof hookRun>): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      const gone = (): void => reject(new Error("Cursor's agent's process ended before its hook did"))
      this.answers.once('line', (line) => {
        this.answers.off('close', gone)
        resolve(JSON.parse(line) as { code: number | null; stderr: string })
      })
      this.answers.once('close', gone)
      this.requests.write(`${JSON.stringify({ command, cwd: this.cwd, env, input })}\n`)
    })
  }
}
