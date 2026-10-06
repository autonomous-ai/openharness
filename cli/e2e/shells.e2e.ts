/**
 * The person's login shell, for Claude Code and Codex. The daemon launches each engine through the
 * shell the person uses (`$SHELL`), so their PATH, version managers and startup files apply. zsh and
 * bash speak the POSIX shell language the launch is written in; fish, tcsh and nushell do not. tcsh
 * ships with macOS, so it stands in for every shell that is not POSIX: an agent must start, in its
 * own folder, and work, whichever shell it is.
 */
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
type Row = Record<string, any>

const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const started = client.next(isTurn('turn_started', agentId), 45_000, `turn_started (${content})`)
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  expect((await started).payload?.userMessage).toBe(content)
  await ended
}

const SHELLS = ['/bin/bash', '/bin/tcsh'] as const

describe('the person\'s login shell', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it.each(SHELLS)('a terminal tile under %s is that shell, in the folder asked for', async (shell) => {
    const d = await IsolatedDaemon.create({ env: { SHELL: shell } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    const client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'tile')
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine: 'terminal', cwd }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const info = await until(`the tile's ${shell} to be running`, async () => {
      const answer = await client.request('terminal_info', { agentId: created.agent.id }, 10_000)
      return answer.command && !answer.error && answer.command !== 'sh' ? answer : null
    }, 30_000, 500)
    // tmux names the command from argv[0] on Linux, and Debian's tcsh rewrites its own to "-bin/tcsh",
    // which tmux reads as "bin/tcsh"; macOS's tmux reads the process name. The shell is the same.
    expect(String(info.command).split('/').at(-1)).toBe(shell.split('/').at(-1))
    expect(realpathSync(info.path)).toBe(realpathSync(cwd))
    client.close()
  }, 120_000)

  for (const shell of SHELLS) {
    it.each(['claude', 'codex'] as const)(`%s under ${shell}: an agent starts in its own folder and works`, async (engine: Engine) => {
      const d = await IsolatedDaemon.create({ env: { SHELL: shell } })
      daemon = d
      onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
      await d.start()
      const client = await LocalClient.connect(d)
      const cwd = join(d.projectsDir, `shell-${engine}`)
      mkdirSync(cwd, { recursive: true })
      const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 120_000)
      expect(created.error, JSON.stringify(created)).toBeUndefined()
      const agent = await until(`the ${engine} agent to bind under ${shell}`, async () => {
        const now = await row(client, created.agent.id)
        return now?.sessionId && now.status === 'active' ? now : null
      }, 60_000, 500)
      const info = await client.request('terminal_info', { agentId: agent.id }, 10_000)
      expect(realpathSync(info.path)).toBe(realpathSync(cwd))
      await turn(client, agent.id, `under ${shell}`)
      client.close()
    }, 240_000)
  }

  // A zsh user with no startup files of their own. The zsh of Debian, Ubuntu, Fedora and Arch then opens
  // its new-user setup menu on any terminal before anything else, and every agent's pane showed that menu
  // instead of starting its engine: on the suite's first Linux run, no zsh agent bound at all. The launch
  // keeps the menu out of an agent's pane (engineLaunch.ts zshNewUserGuard). macOS's zsh has no such menu.
  it.skipIf(!existsSync('/bin/zsh')).each(['claude', 'codex'] as const)('%s for a zsh user with no startup files: an agent starts and works', async (engine: Engine) => {
    const d = await IsolatedDaemon.create({ env: { SHELL: '/bin/zsh' } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    rmSync(join(d.env.ZDOTDIR!, '.zshrc'))
    await d.start()
    const client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, `new-zsh-user-${engine}`)
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 120_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agent = await until(`the ${engine} agent to bind`, async () => {
      const now = await row(client, created.agent.id)
      return now?.sessionId && now.status === 'active' ? now : null
    }, 60_000, 500)
    await turn(client, agent.id, 'from a new zsh user')
    // Nothing was written into the person's home to get there.
    expect(['.zshenv', '.zprofile', '.zshrc', '.zlogin'].filter((name) => existsSync(join(d.env.ZDOTDIR!, name)))).toEqual([])
    client.close()
  }, 240_000)
})
