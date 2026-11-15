/**
 * A daemon under test knows nothing of the developer's own state, whatever their shell names.
 *
 * `IsolatedDaemon.create` handed a daemon the environment of the shell that ran the tests, less a few names (audit of
 * 2026-11-15, docs/plans/2026-11-15-e2e-daemon-isolation-design.md). A developer with HARNESS_CONNECTIONS_DIR set gave
 * every daemon under test their connected services' tokens, and one with Harness OS connections under XDG_DATA_HOME
 * had them copied into the test's root (lib/connectors/store.ts `adoptLegacy`). A daemon now inherits only an allowlist
 * (src/testing/daemonEnvironment.ts), and the harness names the rest (harness/daemon.ts). A tmux server the test starts
 * takes the same allowlist (src/testing/isolatedTmux.ts).
 *
 * Every path and value here is made up, in a folder of this test. `vi.stubEnv` puts them in this worker's environment
 * as a developer's shell would, and takes them out again: no real value of these variables is read or printed.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Store } from '../src/lib/connectors/store.js'

/** A connections folder with one connection saved, as Connections leaves it. */
function saved(root: string, code: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  new Store(root).save(code, { access_token: 'e2e-not-a-credential', source: 'custom', mcp_entry: { url: `https://${code}.example/mcp`, headers: {} } })
}

/** Every file under [root], with what it holds. */
function files(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map((file) => [file, readFileSync(file, 'utf8')]))
}

/** The connections the daemon shows as made, by code. */
async function connected(d: IsolatedDaemon): Promise<string[]> {
  const client = await LocalClient.connect(d)
  try {
    // Connected services answer once the edge host has reached the core: until then the answer has no list in it.
    const cards = await until('connectors to answer', async () => {
      const answer = await client.request<{ connections?: Array<{ connector: string; state: string }> }>('connectors', { action: 'list' }, 30_000)
      return Array.isArray(answer.connections) ? answer.connections : null
    }, 60_000, 250)
    return cards.filter((card) => card.state !== 'not_connected').map((card) => card.connector).sort()
  } finally { client.close() }
}

/** A terminal tile of [d], up: its row. */
async function tile(d: IsolatedDaemon, client: LocalClient, name: string): Promise<{ id: string; tmuxPane: string }> {
  const cwd = join(d.projectsDir, name)
  mkdirSync(cwd, { recursive: true })
  const opened = await client.request('agent_create', { engine: 'terminal', cwd }, 60_000)
  expect(opened.error, JSON.stringify(opened)).toBeUndefined()
  return until('the terminal tile to be up', async () => {
    const { agents } = await client.request<{ agents: Array<{ id: string; status: string; tmuxPane?: string }> }>('agents_list', { includeStopped: true }, 30_000)
    const now = agents.find((agent) => agent.id === opened.agent.id)
    return now?.status === 'active' && now.tmuxPane ? { id: now.id, tmuxPane: now.tmuxPane } : null
  }, 60_000, 250)
}

/** What [line], typed into [pane], wrote into [file]: the tile's own answer, never its whole environment. The file is
 *  moved into place whatever the line returned: `whence -p` returns 1 for a name it cannot find. */
async function typed(d: IsolatedDaemon, pane: string, line: string, file: string): Promise<string> {
  await d.tmux.run('send-keys', '-t', pane, '-l', `${line} > ${file}.tmp; mv ${file}.tmp ${file}`)
  await d.tmux.run('send-keys', '-t', pane, 'Enter')
  return until(`the tile to write ${file}`, () => existsSync(file) ? readFileSync(file, 'utf8') : null, 30_000, 100)
}

describe('a daemon under test knows nothing of the developer\'s own state', () => {
  let scratch = ''
  let daemon: IsolatedDaemon | undefined
  const failed = (d: IsolatedDaemon) => onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })

  beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'developer-state-')) })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await daemon?.close()
    daemon = undefined
    rmSync(scratch, { recursive: true, force: true })
  })

  it('has its profile under its own home, and its own tmux folder, temporary folder and Store catalog', async () => {
    // A developer's shell that names every one of them: made-up folders, so a failure prints nothing real.
    for (const name of ['USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) vi.stubEnv(name, join(scratch, name))
    vi.stubEnv('HARNESS_STORE_CATALOG_URL', 'https://store.invalid/catalog.json')
    const d = daemon = await IsolatedDaemon.create()
    const home = d.env.HOME!
    expect({
      USERPROFILE: d.env.USERPROFILE, LOCALAPPDATA: d.env.LOCALAPPDATA, APPDATA: d.env.APPDATA,
      TMUX_TMPDIR: d.env.TMUX_TMPDIR, TMPDIR: d.env.TMPDIR, HARNESS_STORE_CATALOG_URL: d.env.HARNESS_STORE_CATALOG_URL,
    }).toEqual({
      USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming'),
      TMUX_TMPDIR: d.tmux.root, TMPDIR: join(d.root, 't'), HARNESS_STORE_CATALOG_URL: 'http://127.0.0.1:9/catalog.json',
    })
    // A daemon beside another shares its home and its tmux server. Never started: the first one's close takes its folders.
    const beside = await IsolatedDaemon.create({ beside: d })
    expect([beside.env.HOME, beside.env.USERPROFILE, beside.env.TMUX_TMPDIR]).toEqual([home, home, d.tmux.root])
  })

  it('takes nothing from the shell but what it needs to run', async () => {
    vi.stubEnv('FAKE_SECRET_TOKEN', 'e2e-not-a-secret')
    vi.stubEnv('HARNESS_CONNECTIONS_DIR', join(scratch, 'connections'))
    vi.stubEnv('SSH_AUTH_SOCK', join(scratch, 'agent.sock'))
    // The shared folders are not the harness's to name either: unset, each falls under the daemon's own home.
    vi.stubEnv('XDG_DATA_HOME', join(scratch, 'share'))
    vi.stubEnv('XDG_CONFIG_HOME', join(scratch, 'config'))
    const d = daemon = await IsolatedDaemon.create()
    expect({
      FAKE_SECRET_TOKEN: d.env.FAKE_SECRET_TOKEN, HARNESS_CONNECTIONS_DIR: d.env.HARNESS_CONNECTIONS_DIR, SSH_AUTH_SOCK: d.env.SSH_AUTH_SOCK,
      XDG_DATA_HOME: d.env.XDG_DATA_HOME, XDG_CONFIG_HOME: d.env.XDG_CONFIG_HOME,
    }).toEqual({
      FAKE_SECRET_TOKEN: undefined, HARNESS_CONNECTIONS_DIR: undefined, SSH_AUTH_SOCK: undefined,
      XDG_DATA_HOME: undefined, XDG_CONFIG_HOME: undefined,
    })
  })

  it('copies no Harness OS connections from the developer\'s shared data folder into its own', async () => {
    const shared = join(scratch, 'share')
    saved(join(shared, 'harness-os', 'connections'), 'harness_os_service')
    const before = files(scratch)
    vi.stubEnv('XDG_DATA_HOME', shared)
    const d = daemon = await IsolatedDaemon.create()
    failed(d)
    await d.start()
    expect(await connected(d)).toEqual([])
    expect(existsSync(join(d.env.HOME!, '.harness', 'connections', 'tokens.json'))).toBe(false)
    expect(files(scratch)).toEqual(before)
  })

  it('shows none of the developer\'s connected services, and leaves their folders as they were', async () => {
    const theirs = join(scratch, 'connections')
    const shared = join(scratch, 'share')
    saved(theirs, 'developer_service')
    saved(join(shared, 'harness-os', 'connections'), 'harness_os_service')
    const before = files(scratch)
    vi.stubEnv('HARNESS_CONNECTIONS_DIR', theirs)
    vi.stubEnv('XDG_DATA_HOME', shared)
    const d = daemon = await IsolatedDaemon.create()
    failed(d)
    await d.start()
    expect(await connected(d)).toEqual([])
    expect(files(scratch)).toEqual(before)
  })

  it('uses the connections folder a test names for it', async () => {
    const own = join(scratch, 'own-connections')
    saved(own, 'test_service')
    const d = daemon = await IsolatedDaemon.create({ env: { HARNESS_CONNECTIONS_DIR: own } })
    failed(d)
    await d.start()
    expect(await connected(d)).toEqual(['test_service'])
  })

  it('gives a tile nothing of the developer\'s when the test itself opened the first tmux session', async () => {
    vi.stubEnv('FAKE_DEV_SECRET', 'e2e-not-a-secret')
    const d = daemon = await IsolatedDaemon.create()
    failed(d)
    // The first client to reach a socket starts its server, and the server's environment is that client's.
    await d.tmux.run('new-session', '-d', '-s', 'opened-by-the-test', '/bin/sleep', '600')
    await d.start()
    const client = await LocalClient.connect(d)
    try {
      const { tmuxPane } = await tile(d, client, 'own-session')
      expect(await typed(d, tmuxPane, 'printf \'%s\\n\' "${FAKE_DEV_SECRET-unset}"', join(d.root, 'tile-secret'))).toBe('unset\n')
    } finally { client.close() }
  })
})
