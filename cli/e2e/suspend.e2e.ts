/**
 * An engine that is stopped, for Claude Code and Codex: Ctrl+Z typed into its pane, which both CLIs
 * answer by suspending themselves ("Claude Code has been suspended. Run `fg` to bring Claude Code
 * back."), and a SIGSTOP of the engine alone. The engine runs as a job of the pane's interactive shell,
 * and that shell took the stop for the engine's end and exited, hanging up the stopped engine: the
 * pane closed and the agent was gone. tmux continues a stopped pane process at once, but nothing below
 * it, and an agent's pane has no prompt to type `fg` into; the launch script now continues the engine
 * itself (engineLaunch.ts, STOP_PROOF_FUNCTIONS).
 *
 * So the agent stays: the same conversation in the same engine process, working once it is back, with
 * nothing restarted. And its real exit still ends it the usual way: the pane, marked with the engine's
 * status, is a shell. So does a death by SIGINT or SIGQUIT, which zsh took for an interrupt of the whole
 * launch script. Under zsh and bash, and tcsh, which hands the launch to a POSIX shell: dash where
 * there is one, else /bin/sh.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
type Row = Record<string, any>
const engines: Engine[] = ['claude', 'codex']
const SHELLS = ['/bin/zsh', '/bin/bash', '/bin/tcsh'].filter(existsSync)
/** Whether bash runs the engine as its job: under bash itself, or under tcsh handing off to a /bin/sh
 *  that is bash because there is no dash (Fedora). */
const bashRuns = (shell: string): boolean => basename(shell) === 'bash'
  || (basename(shell) === 'tcsh' && !existsSync('/bin/dash') && execFileSync('/bin/sh', ['-c', 'printf %s "${BASH_VERSION:-}"'], { encoding: 'utf8' }) !== '')

const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
async function create(d: IsolatedDaemon, client: LocalClient, engine: Engine, folder: string): Promise<Row> {
  const cwd = join(d.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 120_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${folder} to bind its conversation`, async () => {
    const agent = await row(client, created.agent.id)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
}
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const started = client.next(isTurn('turn_started', agentId), 45_000, `turn_started (${content})`)
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  expect((await started).payload?.userMessage).toBe(content)
  await ended
}

const processTable = () => execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
  .split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
  .map((m) => ({ pid: Number(m![1]), ppid: Number(m![2]), command: m![3].trim() }))

/** The engine's own process, the pane shell's job: the one below the shell started by the engine's
 *  command, never the shell itself, whose command line names it too. For Codex that is npm's Node
 *  wrapper (the fake runs as npm installs Codex); `native` asks for the engine below it instead, which
 *  names its process `codex` as the real binary's reads in ps. */
function enginePid(d: IsolatedDaemon, root: number, engine: Engine, native = false): number | null {
  const table = processTable()
  // A fake engine's process title is its name, then its arguments, as a CLI's command line is.
  const titled = (command: string) => command === engine || command.startsWith(`${engine} `)
  const job = table.find((p) => p.ppid === root && (titled(p.command) || p.command.includes(join(d.root, 'bin', engine))))
  if (!job || !native) return job?.pid ?? null
  return table.find((p) => p.ppid === job.pid && titled(p.command))?.pid ?? null
}
/** Whether the pane's terminal is in line mode rather than raw, as an engine keeps it. */
async function lineMode(d: IsolatedDaemon, pane: string): Promise<boolean> {
  const tty = (await d.tmux.run('display-message', '-p', '-t', pane, '#{pane_tty}')).trim()
  return / icanon /.test(` ${execFileSync('/bin/sh', ['-c', 'stty -a < "$0"', tty], { encoding: 'utf8' }).replace(/\s+/g, ' ')} `)
}
// The pane's command as tmux names it: on Linux, from the process's argv[0], and Debian's tcsh rewrites
// its own to "-bin/tcsh", which tmux reads as "bin/tcsh" (macOS's tmux reads the process name, "tcsh").
// Compared by basename.
const processState = (pid: number): string => {
  try { return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim() } catch { return '' }
}

describe('an engine that is stopped, or killed', () => {
  let daemon: IsolatedDaemon | undefined
  const stopped: number[] = []
  afterEach(async () => {
    // A stopped process left behind by a failed test would outlive it.
    for (const pid of stopped.splice(0)) { try { process.kill(pid, 'SIGCONT') } catch { /* gone */ } }
    await daemon?.close(); daemon = undefined
  })

  for (const shell of SHELLS) {
    it.each(engines)(`%s under ${shell}: Ctrl+Z and a SIGSTOP leave the agent there and working, and its own exit still ends it`, async (engine) => {
      const d = await IsolatedDaemon.create({ env: { SHELL: shell } })
      daemon = d
      onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
      await d.start()
      const client = await LocalClient.connect(d)
      const agent = await create(d, client, engine, `suspend-${engine}`)
      await turn(client, agent.id, 'a first turn')
      const pane = String(agent.terminal?.runtimes?.[0]?.paneId ?? agent.tmuxPane)
      const root = Number((await d.tmux.run('display-message', '-p', '-t', pane, '#{pane_pid}')).trim())
      const pid = await until(`the ${engine} process under the pane`, () => enginePid(d, root, engine), 10_000, 200)
      const exitMark = async () => (await d.tmux.run('show-option', '-p', '-v', '-t', pane, '@harness_engine_exit').catch(() => '')).trim()
      onTestFailed(async () => { console.log(`---- pane ${pane}\n${await d.capture(pane).catch((error) => String(error))}`) })

      /** Back, as it was: the same process, running again, in the same conversation, nothing restarted
       *  and no exit marked; and it works. */
      const back = async (how: string) => {
        await until(`the engine to run again after ${how}`, () => !processState(pid).startsWith('T') || null, 15_000, 100)
        const now = await row(client, agent.id)
        expect(now?.status, how).toBe('active')
        expect(now?.sessionId, how).toBe(agent.sessionId)
        expect(enginePid(d, root, engine), how).toBe(pid)
        expect(await exitMark(), how).toBe('')
        await turn(client, agent.id, `after ${how}`)
        expect(d.coresStarted(), how).toBe(1)
      }

      // Ctrl+Z, typed into the pane. The engine gives the terminal back and stops itself; Claude Code
      // says so, and the shell reports the stopped job. Read from everything the pane writes from here on,
      // not its screen: the engine repaints its composer over those lines the moment it is back.
      const written = join(d.root, `pane-${engine}.out`)
      await d.tmux.run('pipe-pane', '-t', pane, '-o', `cat >> '${written}'`)
      const output = () => { try { return readFileSync(written, 'utf8') } catch { return '' } }
      await d.tmux.run('send-keys', '-t', pane, 'C-z')
      await until('the engine to suspend itself', () => /suspended|stopped/i.test(output()) || null, 15_000, 100)
      if (engine === 'claude') await until('Claude Code to say so', () => output().includes('Claude Code has been suspended') || null, 5_000, 100)
      await back('Ctrl+Z')

      // A SIGSTOP of the engine alone, as a debugger or a person with `kill` sends it. Neither real CLI
      // takes raw mode again on a SIGCONT it did not ask for, so under bash, which puts back its own
      // modes when a job stops, the engine comes back to a line-mode terminal (accepted, and seen
      // here); zsh restores the job's, and dash, which tcsh hands the launch to, leaves them be.
      process.kill(pid, 'SIGSTOP')
      stopped.push(pid)
      await back('a SIGSTOP')
      stopped.splice(0)
      expect(await lineMode(d, pane)).toBe(bashRuns(shell))

      // Its own exit is still the end of it: marked on the pane, which is a shell now.
      client.send('message', { agentId: agent.id, content: '!exit' })
      expect(await until('the exit to be marked on the pane', () => exitMark(), 30_000, 200)).toBe('0')
      await until('the agent to stop counting as active', async () => (await row(client, agent.id))?.status !== 'active' || null, 45_000, 500)
      expect(await until('the pane to be a shell', async () => {
        const [dead, command] = (await d.tmux.run('display-message', '-p', '-t', pane, '#{pane_dead} #{pane_current_command}')).trim().split(' ')
        return dead === '0' && basename(command) === basename(shell) ? basename(command) : null
      }, 30_000, 200)).toBe(basename(shell))
      expect(d.coresStarted()).toBe(1)
      client.close()
    }, 240_000)
  }

  for (const shell of SHELLS) {
    it.each([['claude', 'SIGINT', '130'], ['codex', 'SIGQUIT', '131']] as const)(`%s under ${shell}: an engine that dies of %s still leaves the pane a shell, marked with its status`, async (engine, signal, status) => {
      // zsh gave up the rest of the launch script when its job was killed by INT or QUIT, so the pane
      // closed instead of turning into a shell. npm's Codex wrapper ends with the signal its engine died
      // of, unless it listens for it (INT, TERM, HUP), so a QUIT ends the wrapper too.
      const d = await IsolatedDaemon.create({ env: { SHELL: shell } })
      daemon = d
      onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
      await d.start()
      const client = await LocalClient.connect(d)
      const agent = await create(d, client, engine, `killed-${engine}`)
      await turn(client, agent.id, 'a first turn')
      const pane = String(agent.terminal?.runtimes?.[0]?.paneId ?? agent.tmuxPane)
      const root = Number((await d.tmux.run('display-message', '-p', '-t', pane, '#{pane_pid}')).trim())
      const target = await until(`the ${engine} engine under the pane`, () => enginePid(d, root, engine, engine === 'codex'), 10_000, 200)
      process.kill(target, signal)
      // bash run as the hand-off's /bin/sh reports a job killed by INT as a success.
      expect(await until('the death to be marked on the pane', async () =>
        (await d.tmux.run('show-option', '-p', '-v', '-t', pane, '@harness_engine_exit').catch(() => '')).trim(), 30_000, 200))
        .toBe(signal === 'SIGINT' && basename(shell) === 'tcsh' && bashRuns(shell) ? '0' : status)
      await until('the agent to stop counting as active', async () => (await row(client, agent.id))?.status !== 'active' || null, 45_000, 500)
      expect(await until('the pane to be a shell', async () => {
        const [dead, command] = (await d.tmux.run('display-message', '-p', '-t', pane, '#{pane_dead} #{pane_current_command}')).trim().split(' ')
        return dead === '0' && basename(command) === basename(shell) ? basename(command) : null
      }, 30_000, 200)).toBe(basename(shell))
      expect(d.coresStarted()).toBe(1)
      client.close()
    }, 240_000)
  }
})
