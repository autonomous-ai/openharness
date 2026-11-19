/**
 * Claude Code in a tmux session a person opened by hand, and that person's tmux clients, on the isolated daemon's private
 * tmux server: never the developer's.
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { observedAgentId } from '../../src/cable/hosts/observed.js'
import { until, type IsolatedDaemon } from './daemon.js'
import { tabUnder, type FakeApp } from './outsideAgent.js'
import { waitForNativeHooks } from './nativeHooks.js'

/** The variables a pane needs to run the fake engine against this daemon, as e2e/hookclient.e2e.ts passes them. */
const ENGINE_ENV = ['HOME', 'ZDOTDIR', 'PATH', 'CODEX_HOME', 'CLAUDE_PATH', 'CODEX_PATH']

/** Claude Code (the fake engine) in a tmux session the test opened on the daemon's private server, as a person opens
 *  one by hand: not a session Harness made, so its hooks tell the devices and register nothing. */
export class InOwnTmux {
  private constructor(private readonly d: IsolatedDaemon, readonly pane: string, readonly sessionId: string) {}

  /** The dial's id for it. */
  get id(): string { return observedAgentId('claude', this.sessionId) }

  /** In a new session, [session]. */
  static start(d: IsolatedDaemon, session: string, folder: string): Promise<InOwnTmux> {
    return InOwnTmux.begin(d, folder, ['new-session', '-d', '-s', session])
  }

  /** In a new window of [session], made in the background: the session's active window stays the one it had. */
  static startIn(d: IsolatedDaemon, session: string, folder: string): Promise<InOwnTmux> {
    return InOwnTmux.begin(d, folder, ['new-window', '-d', '-t', `${session}:`])
  }

  /** [made] is the tmux command that makes its pane. */
  private static async begin(d: IsolatedDaemon, folder: string, made: readonly string[]): Promise<InOwnTmux> {
    await waitForNativeHooks(d, 'claude')
    const cwd = join(d.projectsDir, folder)
    mkdirSync(cwd, { recursive: true })
    const from = d.hookLog().length
    // The private server's environment is the daemon's allowlist (src/testing/daemonEnvironment.ts): no host hint
    // from the developer's shell reaches the pane.
    const pane = await d.tmux.run(...made, '-P', '-F', '#{pane_id}', '-c', cwd,
      ...ENGINE_ENV.flatMap((name) => ['-e', `${name}=${d.env[name]}`]),
      d.env.CLAUDE_PATH!)
    // Its conversation, as its SessionStart hook named it: the only engine starting now.
    const [, sessionId] = await until(`${folder} to run its SessionStart hook`,
      () => /claude pid=\d+ SessionStart\(startup\) session=(\S+) ran/.exec(d.hookLog().slice(from)), 30_000, 100)
    return new InOwnTmux(d, pane, sessionId)
  }

  /** Typed at its prompt, then Enter, as e2e/hookclient.e2e.ts types. */
  async type(text: string): Promise<void> {
    await this.d.tmux.run('send-keys', '-t', this.pane, '-l', text)
    await this.d.tmux.run('send-keys', '-t', this.pane, 'Enter')
  }
}

/**
 * A client of the person's attached to [session] from a tab of a fake [app] (outsideAgent.ts tabUnder), as a person
 * types `tmux attach` in Terminal: it has a tty, and its parents name the app. Resolved once tmux lists it.
 */
export async function tabClient(d: IsolatedDaemon, session: string, app: FakeApp):
  Promise<{ pid: number; tty(): Promise<string>; close(): Promise<void> }> {
  const tab = await tabUnder(d, app, ['tmux', '-S', d.tmux.socket, '-f', '/dev/null', 'attach-session', '-t', session],
    { ...d.tmux.env, TERM: 'xterm-256color' })
  const tty = async (): Promise<string | undefined> => {
    const lines = await d.tmux.run('list-clients', '-F', '#{client_pid} #{client_tty}')
    return lines.split('\n').find((line) => line.startsWith(`${tab.pid} `))?.slice(`${tab.pid} `.length)
  }
  try {
    await until(`a client on ${session} in a ${app} tab`, tty, 30_000, 50)
  } catch (error) {
    await tab.close()
    throw error
  }
  return {
    pid: tab.pid,
    async tty() {
      const found = await tty()
      if (!found) throw new Error(`client ${tab.pid} is not attached`)
      return found
    },
    close: () => tab.close(),
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
