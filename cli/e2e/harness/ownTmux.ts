/**
 * Claude Code in a tmux session a person opened by hand, and that person's tmux clients, on the isolated daemon's private
 * tmux server: never the developer's.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { observedAgentId } from '../../src/cable/hosts/observed.js'
import { CLI_ROOT, until, type IsolatedDaemon } from './daemon.js'

/** The variables a pane needs to run the fake engine against this daemon, as e2e/hookclient.e2e.ts passes them. */
const ENGINE_ENV = ['HOME', 'ZDOTDIR', 'PATH', 'CODEX_HOME', 'CLAUDE_PATH', 'CODEX_PATH']

/** Every name the hook sends as a hint (hook/notify.mjs HOST_HINTS, read as hookNotify.spec.ts reads it), so one added
 *  later is blanked too; but the two tmux itself sets in its panes. */
function hintsToBlank(): string[] {
  const literal = /const HOST_HINTS = \[([^\]]*)\]/.exec(readFileSync(join(CLI_ROOT, 'hook', 'notify.mjs'), 'utf8'))?.[1]
  if (!literal) throw new Error('HOST_HINTS not found in hook/notify.mjs')
  return [...literal.matchAll(/'([^']+)'/g)].map((match) => match[1]).filter((name) => name !== 'TMUX_PANE' && name !== 'TERM_PROGRAM')
}

/** Claude Code (the fake engine) in a tmux session the test opened on the daemon's private server, as a person opens
 *  one by hand: not a session Harness made, so its hooks tell the devices and register nothing. */
export class InOwnTmux {
  private constructor(private readonly d: IsolatedDaemon, readonly pane: string, readonly pid: number, readonly sessionId: string) {}

  /** The dial's id for it. */
  get id(): string { return observedAgentId('claude', this.sessionId) }

  static async start(d: IsolatedDaemon, session: string, folder: string): Promise<InOwnTmux> {
    const cwd = join(d.projectsDir, folder)
    mkdirSync(cwd, { recursive: true })
    const from = d.hookLog().length
    // d.tmux.run carries the test shell's environment, which a server it started hands every pane: a bundle id or an
    // Orca handle from it would have a tap act on the developer's own apps. Each hint is blanked, and the hook sends
    // none that is empty.
    const pane = await d.tmux.run('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', session, '-c', cwd,
      ...ENGINE_ENV.flatMap((name) => ['-e', `${name}=${d.env[name]}`]),
      ...hintsToBlank().flatMap((name) => ['-e', `${name}=`]),
      d.env.CLAUDE_PATH!)
    // Its conversation and its process, as its SessionStart hook named them: the only engine starting now.
    const [, pid, sessionId] = await until(`${folder} to run its SessionStart hook`,
      () => /claude pid=(\d+) SessionStart\(startup\) session=(\S+) ran/.exec(d.hookLog().slice(from)), 30_000, 100)
    return new InOwnTmux(d, pane, Number(pid), sessionId)
  }

  /** Typed at its prompt, then Enter, as e2e/hookclient.e2e.ts types. */
  async type(text: string): Promise<void> {
    await this.d.tmux.run('send-keys', '-t', this.pane, '-l', text)
    await this.d.tmux.run('send-keys', '-t', this.pane, 'Enter')
  }

  /** Whether its hook for [event] has run since the engine started, as the engine noted it. */
  ran(event: string, times = 1): boolean {
    const line = new RegExp(`claude pid=${this.pid} ${event}\\S* session=${this.sessionId} ran`, 'g')
    return (this.d.hookLog().match(line)?.length ?? 0) >= times
  }
}

export interface ControlClient {
  /** '<session> <pane>' this client shows now. */
  where(): Promise<string>
  close(): Promise<void>
}

/**
 * A client of the test's own in control mode (`tmux -C attach-session -t <target>`), as a person's second terminal is
 * and as every Harness terminal is (src/lib/tmuxStream.ts). [target] is a session's name or a pane's id. Before tmux 3.7
 * the server can crash when a control client attaches beside a session being made or closed (src/lib/tmuxControlGate.ts):
 * make every session first, attach one client at a time, and close each before any session goes.
 */
export async function controlClient(d: IsolatedDaemon, target: string): Promise<ControlClient> {
  const child = spawn('tmux', ['-S', d.tmux.socket, '-f', '/dev/null', '-C', 'attach-session', '-t', target],
    { env: d.tmux.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let said = ''
  child.stdout!.on('data', (chunk: Buffer) => { said += chunk.toString('utf8') })
  child.stderr!.resume()
  const exited = new Promise<void>((done) => child.once('exit', () => done()))
  // Attached once tmux has answered its first command.
  child.stdin!.write('display-message -p attached\n')
  await until(`a control client on ${target}`, () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the control client exited (${child.exitCode ?? child.signalCode}): ${said}`)
    return /^attached$/m.test(said)
  }, 30_000, 50)
  return {
    async where() {
      const lines = await d.tmux.run('list-clients', '-F', '#{client_pid} #{session_name} #{pane_id}')
      const mine = lines.split('\n').find((line) => line.startsWith(`${child.pid} `))
      if (!mine) throw new Error(`control client ${child.pid} is not attached: ${lines}`)
      return mine.slice(`${child.pid} `.length)
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return
      // Its end of input detaches it; one that does not go is killed.
      child.stdin!.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
      await exited
      clearTimeout(timer)
    },
  }
}
