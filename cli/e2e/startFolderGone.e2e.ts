/**
 * A daemon whose start folder is deleted once it is up. A firmware flash ran `harness start` inside a git worktree,
 * then removed the worktree: the master and the core kept the deleted folder as their own, and from then on discovery
 * could not look and no new agent was ever confirmed. The master and the core now work in the home, however started.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until, type DaemonOptions } from './harness/daemon.js'

type Row = Record<string, any>

const rowOf = async (client: LocalClient, agentId: string): Promise<Row | undefined> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents.find((agent) => agent.id === agentId)

const status = async (d: IsolatedDaemon): Promise<Row> =>
  (await fetch(`http://127.0.0.1:${d.port}/api/status`, { headers: d.localHeaders() })).json() as Promise<Row>

/** The working folder of [pid], as the system reports it. */
function workingFolderOf(pid: number): string {
  if (process.platform === 'linux') return readlinkSync(`/proc/${pid}/cwd`)
  const fields = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
  const name = fields.split('\n').find((line) => line.startsWith('n'))
  if (!name) throw new Error(`lsof named no working folder for ${pid}`)
  return name.slice(1)
}

describe.each<[string, DaemonOptions]>([
  ['under the master', {}],
  ['the core alone (__run)', { noMaster: true }],
  ['harness start -f with HARNESS_NO_MASTER=1', { foreground: true, env: { HARNESS_NO_MASTER: '1' } }],
])('a daemon whose start folder is deleted once it is up, %s', (_what, options) => {
  let daemon: IsolatedDaemon | undefined
  let startFolder = ''
  afterEach(async () => {
    await daemon?.close(); daemon = undefined
    rmSync(startFolder, { recursive: true, force: true })
  })

  it('confirms a new agent, works in its home, and logs no folder failure', async () => {
    startFolder = mkdtempSync(join(tmpdir(), 'harness-start-'))
    const d = daemon = await IsolatedDaemon.create({ ...options, startFolder })
    // A relative PATH entry, as a developer's shell often has: the engines' ownership pass resolves it against the
    // daemon's working folder, which throws once that folder is gone.
    d.env.PATH = `${d.env.PATH}${delimiter}node_modules/.bin`
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    rmSync(startFolder, { recursive: true, force: true })
    if (!options.noMaster && !options.foreground) {
      // A core the master starts once the folder is gone (after a crash, or an update) never had it: the incident's
      // core, whose every read of its working folder failed.
      const core = d.corePid()!, ready = d.log().split('[cli] ready').length
      process.kill(core, 'SIGKILL')
      await until('the master to start a new core', () => d.corePid() !== core && d.log().split('[cli] ready').length > ready, 60_000)
    }

    const client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'after-delete')
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const id = created.agent.id as string
    await until('the new agent\'s launch to be confirmed', async () => {
      const row = await rowOf(client, id)
      return row && (!row.launch || row.launch.state === 'ready') ? row : null
    }, 90_000, 500)
    client.close()

    const home = realpathSync(d.env.HOME!)
    expect(workingFolderOf(d.pid!)).toBe(home)
    const core = d.corePid()
    if (core !== null && core !== d.pid) expect(workingFolderOf(core)).toBe(home)
    expect((await status(d)).discoveryError).toBeNull()
    expect(d.log()).not.toMatch(/process table unavailable|executable ownership unavailable|process\.cwd|uv_cwd/)
  }, 300_000)
})
