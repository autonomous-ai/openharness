/**
 * A daemon under test knows nothing of the developer's own state, whatever their shell names.
 *
 * `IsolatedDaemon.create` handed a daemon the environment of the shell that ran the tests, less a few names (audit of
 * 2026-11-15, docs/plans/2026-11-15-e2e-daemon-isolation-design.md). A developer with HARNESS_CONNECTIONS_DIR set gave
 * every daemon under test their connected services' tokens, and one with Harness OS connections under XDG_DATA_HOME
 * had them copied into the test's root (lib/connectors/store.ts `adoptLegacy`). A daemon now inherits only an allowlist
 * (src/testing/daemonEnvironment.ts), and the harness names the rest (harness/daemon.ts). A tmux server the test starts
 * takes the same allowlist (src/testing/isolatedTmux.ts). A daemon runs on a Node alone in its folder
 * (src/testing/testNode.ts).
 *
 * Every path and value here is made up, in a folder of this test. `vi.stubEnv` puts them in this worker's environment
 * as a developer's shell would, and takes them out again: no real value of these variables is read or printed.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Store } from '../src/lib/connectors/store.js'
import { placeNode } from '../src/testing/placeNode.js'

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
  // Boxed: an empty answer is an answer too (`whence -p` of names it cannot find), and `until` waits for a truthy one.
  return (await until(`the tile to write ${file}`, () => existsSync(file) ? { text: readFileSync(file, 'utf8') } : null, 30_000, 100)).text
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
    // The worker's own temporary folder, kept where it is: with no TMPDIR, as on CI's Linux runners, os.tmpdir() reads
    // the made-up TMP below, a folder that does not exist, and the fixture could not make its root in it.
    vi.stubEnv('TMPDIR', tmpdir())
    // A developer's shell that names every one of them: made-up folders, so a failure prints nothing real.
    for (const name of ['USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP']) vi.stubEnv(name, join(scratch, name))
    vi.stubEnv('HARNESS_STORE_CATALOG_URL', 'https://store.invalid/catalog.json')
    const d = daemon = await IsolatedDaemon.create()
    const home = d.env.HOME!
    expect({
      USERPROFILE: d.env.USERPROFILE, LOCALAPPDATA: d.env.LOCALAPPDATA, APPDATA: d.env.APPDATA,
      TMUX_TMPDIR: d.env.TMUX_TMPDIR, TMPDIR: d.env.TMPDIR, TEMP: d.env.TEMP, TMP: d.env.TMP,
      HARNESS_STORE_CATALOG_URL: d.env.HARNESS_STORE_CATALOG_URL,
    }).toEqual({
      USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming'),
      TMUX_TMPDIR: d.tmux.root, TMPDIR: join(d.root, 't'), TEMP: join(d.root, 't'), TMP: join(d.root, 't'),
      HARNESS_STORE_CATALOG_URL: 'http://127.0.0.1:9/catalog.json',
    })
    // A daemon beside another shares its home and its tmux server. Never started: the first one's close takes its folders.
    const beside = await IsolatedDaemon.create({ beside: d })
    expect([beside.env.HOME, beside.env.USERPROFILE, beside.env.TMUX_TMPDIR]).toEqual([home, home, d.tmux.root])
  })

  it('runs its tiles under /bin/zsh, whatever shell the developer uses, unless a test names another', async () => {
    vi.stubEnv('SHELL', '/fake/bin/fish')
    const d = daemon = await IsolatedDaemon.create()
    expect(d.env.SHELL).toBe('/bin/zsh')
    // Never started: it only shows whose word wins. Beside the first, whose close takes its folders.
    expect((await IsolatedDaemon.create({ beside: d, env: { SHELL: '/bin/bash' } })).env.SHELL).toBe('/bin/bash')
  })

  // A fake dial's attach has the devices install Harness's VS Code extension into the VS Code they find
  // (cable/vscodeExtensionSetup.ts): /Applications is the computer's, whatever the home, so they look for VS Code's
  // `code` in the daemon's own root alone, where there is none (devices/vscodeExtension.ts, services/devices.ts).
  it('finds none of the developer\'s VS Code: its devices look for VS Code\'s code only in its own root, where there is none', async () => {
    const d = daemon = await IsolatedDaemon.create()
    const bin = d.env.HARNESS_VSCODE_BIN ?? ''
    expect(isAbsolute(bin), bin).toBe(true)
    expect(relative(d.root, bin).startsWith('..'), bin).toBe(false)
    expect(existsSync(bin), bin).toBe(false)
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

  it('finds its own engines first in a tile\'s login shell, whatever the system\'s profile puts ahead of them', async () => {
    const d = daemon = await IsolatedDaemon.create()
    failed(d)
    // As macOS's /etc/zprofile does (path_helper), on any machine, and like it in a login shell only: a folder put
    // ahead of the daemon's own, after the harness's line in .zshenv and before its line in .zprofile. Its engines
    // only leave a mark, and nothing runs them.
    const decoy = join(scratch, 'decoy'), mark = join(scratch, 'decoy-ran')
    mkdirSync(decoy)
    for (const name of ['claude', 'codex']) writeFileSync(join(decoy, name), `#!/bin/sh\necho ${name} >> ${mark}\n`, { mode: 0o755 })
    appendFileSync(join(d.env.ZDOTDIR!, '.zshenv'), `[[ -o login ]] && path=(${decoy} $path)\n`)
    // The startup lines are the home's, written once: a daemon beside the first adds no second.
    await IsolatedDaemon.create({ beside: d })
    expect(readFileSync(join(d.env.ZDOTDIR!, '.zprofile'), 'utf8').trim().split('\n')).toHaveLength(1)
    await d.start()
    const client = await LocalClient.connect(d)
    try {
      const { tmuxPane } = await tile(d, client, 'path')
      // Asked, never typed: on a developer's Mac the name alone would start their real engine.
      expect(await typed(d, tmuxPane, 'whence -p claude codex', join(d.root, 'resolved')))
        .toBe(`${join(d.root, 'bin', 'claude')}\n${join(d.root, 'bin', 'codex')}\n`)
      expect(existsSync(mark)).toBe(false)
    } finally { client.close() }
  })

  it('finds no engine of the developer\'s by name: its PATH is its own bin, the linked tools and the system\'s folders', async () => {
    // A folder of the developer's PATH with two engines in it, as ~/.opencode/bin and ~/.local/bin are: made up, and
    // each would only leave a mark.
    const theirs = join(scratch, 'their-bin'), mark = join(scratch, 'their-engine-ran')
    mkdirSync(theirs)
    for (const name of ['opencode', 'cursor-agent']) writeFileSync(join(theirs, name), `#!/bin/sh\necho ${name} >> ${mark}\n`, { mode: 0o755 })
    vi.stubEnv('PATH', `${theirs}:${process.env.PATH}`)
    const d = daemon = await IsolatedDaemon.create()
    failed(d)
    // A yes or a no, never the folders: at the base they are the developer's own.
    const own = d.env.PATH!.split(':').filter((folder) => !['/usr/bin', '/bin', '/usr/sbin', '/sbin'].includes(folder))
    expect(own.length === 2 && own[0] === join(d.root, 'bin') && own[1] === join(d.root, 'tools'), 'PATH: its bin, the linked tools, the system\'s folders').toBe(true)
    // The one engine whose recipe names a path outside any home (/usr/local/bin/hermes, lib/engineInstall.ts): the
    // daemon's Hermes is its own bin's, missing until a test writes one.
    expect(d.env.HERMES_PATH).toBe(join(d.root, 'bin', 'hermes'))
    await d.start()
    const client = await LocalClient.connect(d)
    try {
      const { tmuxPane } = await tile(d, client, 'other-engines')
      // Asked, never typed. `whence -p` prints nothing for a name it cannot find.
      expect(await typed(d, tmuxPane, 'whence -p opencode cursor-agent', join(d.root, 'resolved-others'))).toBe('')
      expect(existsSync(mark)).toBe(false)
    } finally { client.close() }
  })

  // The product looks for npm-installed engines beside the Node it runs on, whatever PATH says (lib/engineLaunch.ts
  // `npmRuntimeBins`), and a version manager puts the developer's real engines there (audit of 2026-11-16,
  // docs/plans/2026-11-16-e2e-isolation-3-design.md). These read paths and listings, and run or type no engine.
  it('runs on a Node alone in its folder, and so does node in its tiles', async () => {
    const d = daemon = await IsolatedDaemon.create()
    failed(d)
    await d.start()
    // The core's line: the master starts the core on its own Node.
    const ran = execFileSync('ps', ['-o', 'args=', '-p', String(d.corePid())], { encoding: 'utf8' }).trim().split(' ')[0]
    // A yes or a no, and a count: at the base the folder is the developer's own, and the names in it their programs.
    expect(ran === process.env.E2E_NODE_PATH, 'the daemon runs on the run\'s Node').toBe(true)
    expect(dirname(ran) !== dirname(process.execPath), 'which is not beside the worker\'s').toBe(true)
    expect(readdirSync(dirname(ran)).filter((name) => name !== 'node' && !name.startsWith('libnode.')).length, 'programs beside the daemon\'s Node').toBe(0)
    const client = await LocalClient.connect(d)
    try {
      const { tmuxPane } = await tile(d, client, 'node')
      expect(await typed(d, tmuxPane, 'node -p process.execPath', join(d.root, 'node-path')) === `${ran}\n`, 'node in a tile is the daemon\'s Node').toBe(true)
    } finally { client.close() }
  })

  it('refuses a Node beside other programs, and starts nothing', async () => {
    // A Node of the test's own with a made-up program beside it, as a version manager's folder has: an empty file,
    // never executable, never run. By its real path: the refusal names the folder Node names itself by.
    const decoy = join(realpathSync(scratch), 'decoy')
    mkdirSync(decoy)
    placeNode(join(decoy, 'node'))
    writeFileSync(join(decoy, 'codex'), '')
    const d = daemon = await IsolatedDaemon.create({ node: join(decoy, 'node') })
    await expect(d.start()).rejects.toThrow(`${decoy} holds codex: a daemon under test must run on a Node alone in its folder`)
    expect([d.pid, d.log()]).toEqual([null, ''])
  })

  it('starts nothing when the run gave it no Node, never falling back to the worker\'s', async () => {
    // Created first: its tools folder already links the run's Node, and testPath.ts keeps what it found.
    const d = daemon = await IsolatedDaemon.create()
    for (const none of [undefined, '']) {
      vi.stubEnv('E2E_NODE_PATH', none)
      await expect(d.start()).rejects.toThrow('E2E_NODE_PATH is not set: run the end-to-end tests through vitest.e2e.config.ts')
    }
    expect([d.pid, d.log()]).toEqual([null, ''])
  })

  // A shell script: Windows has no `open` to stand in for.
  it.skipIf(process.platform === 'win32')('opens nothing of the developer\'s: its open is a fake in its own root that records what it is asked and exits 0', async () => {
    const d = daemon = await IsolatedDaemon.create()
    const open = d.env.HARNESS_OPEN_BIN ?? ''
    // Both before it runs: a path outside the root could be the real open, which would bring an app forward.
    expect(isAbsolute(open), open).toBe(true)
    expect(relative(d.root, open).startsWith('..'), open).toBe(false)
    execFileSync(open, ['-b', 'com.example.none'])
    expect(d.opens()).toEqual([['-b', 'com.example.none']])
  })
})
