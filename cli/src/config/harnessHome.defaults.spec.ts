import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { harnessPath } from './harnessHome.js'

// Pins the folders today's code resolves under the home, so moving each caller onto the module changes none of them.
// These modules read the environment and the home once, as they load: each case is a process of its own, in a
// throwaway home, with an environment built from nothing, so neither the run's isolation variables nor a real
// ~/.harness can reach it.
const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url))
const source = (path: string): string => pathToFileURL(fileURLToPath(new URL(path, import.meta.url))).href
const folders: string[] = []
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

function throwaway(): string {
  const folder = mkdtempSync(join(tmpdir(), 'harness-home-'))
  folders.push(folder)
  return folder
}

/** Runs [script] in a throwaway home that holds [made], folders relative to it. */
function run(script: string, variables: Record<string, string> = {}, made: string[] = []) {
  const home = throwaway()
  for (const folder of made) mkdirSync(join(home, folder), { recursive: true })
  const passed = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } : {}
  const env = Object.fromEntries(Object.entries({ PATH: process.env.PATH, HOME: home, USERPROFILE: home, ...passed, ...variables })
    .filter((entry): entry is [string, string] => entry[1] !== undefined))
  const child = spawnSync(process.execPath, [tsx, '--eval', script], { cwd: home, env, encoding: 'utf8', timeout: 60_000, windowsHide: true })
  return { home, status: child.status, stdout: child.stdout, stderr: child.stderr }
}

/** Every folder the pins read, by the name the test compares. */
const READ_FOLDERS = `(async () => {
  const [{ env }, { AUTH_DIR }, { FLASHER_DIR }, { connectorsDir }, { installedTuiPath }, { shortSocketFolder }] = await Promise.all([
    import(${JSON.stringify(source('./env.ts'))}),
    import(${JSON.stringify(source('../lib/authSession.ts'))}),
    import(${JSON.stringify(source('../lib/flasherDir.ts'))}),
    import(${JSON.stringify(source('../lib/connectors/store.ts'))}),
    import(${JSON.stringify(source('../tui/paths.ts'))}),
    import(${JSON.stringify(source('../lib/localSocket.ts'))}),
  ])
  const read = ['ADAPTER_CLI_DIR', 'ADAPTER_DATA_DIR', 'AMP_SESSIONS_DIR', 'ADAPTER_RUNTIME_DIR', 'ADAPTER_COMPUTER_ID_FILE', 'HARNESS_LOGS_DIR',
    'HARNESS_PTY_DIR', 'HARNESS_DEVICES_DIR', 'HARNESS_HOOK_ROUTES_DIR', 'HARNESS_AGENT_MESSAGES_DIR', 'DSH_DIR']
  console.log(JSON.stringify({
    ...Object.fromEntries(read.map((name) => [name, env[name]])),
    AUTH_DIR, FLASHER_DIR, connectorsDir: connectorsDir(), installedTuiPath: installedTuiPath(), shortSocketFolder: shortSocketFolder('/x'),
  }))
})()`

function accountHome(): string | null {
  try { return userInfo().homedir } catch { return null }
}

/** What READ_FOLDERS prints with the data entries under [data] and the state entries under [state]. */
function defaults(data: string, state: string) {
  return {
    ADAPTER_CLI_DIR: join(data, 'cli'),
    ADAPTER_DATA_DIR: join(data, 'cli', 'data'),
    AMP_SESSIONS_DIR: join(data, 'cli', 'data', 'amp-sessions'),
    ADAPTER_RUNTIME_DIR: join(state, 'runtime'),
    ADAPTER_COMPUTER_ID_FILE: join(data, 'computer-id'),
    HARNESS_LOGS_DIR: join(state, 'logs'),
    HARNESS_PTY_DIR: join(state, 'pty'),
    HARNESS_DEVICES_DIR: join(data, 'devices'),
    HARNESS_HOOK_ROUTES_DIR: join(state, 'hook-routes'),
    HARNESS_AGENT_MESSAGES_DIR: join(data, 'agent-messages'),
    DSH_DIR: join(data, 'dsh'),
    AUTH_DIR: join(data, 'auth'),
    FLASHER_DIR: join(state, 'flasher'),
    connectorsDir: join(data, 'connections'),
    installedTuiPath: join(data, 'bin', 'harness-tui'),
    shortSocketFolder: join(state, 's', createHash('sha256').update('/x').digest('hex').slice(0, 16)),
  }
}

describe('the default folders, as today', () => {
  it.skipIf(process.platform === 'linux')('on macOS and Windows, with nothing set, every default is under <home>/.harness', () => {
    const child = run(READ_FOLDERS)
    expect(child.status, child.stderr).toBe(0)
    const root = join(child.home, '.harness')
    expect(JSON.parse(child.stdout)).toEqual(defaults(root, root))
  }, 70_000)

  it.runIf(process.platform === 'linux')('on a fresh Linux home, every default is in its XDG root', () => {
    const child = run(READ_FOLDERS)
    expect(child.status, child.stderr).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual(defaults(join(child.home, '.local', 'share', 'harness'), join(child.home, '.local', 'state', 'harness')))
  }, 70_000)

  it.runIf(process.platform === 'linux')('on a Linux home not moved yet, every default is under <home>/.harness', () => {
    const child = run(READ_FOLDERS, {}, ['.harness'])
    expect(child.status, child.stderr).toBe(0)
    const root = join(child.home, '.harness')
    expect(JSON.parse(child.stdout)).toEqual(defaults(root, root))
  }, 70_000)

  it('an override still wins', () => {
    const elsewhere = throwaway()
    const set = {
      ADAPTER_CLI_DIR: 'cli', ADAPTER_DATA_DIR: 'data', ADAPTER_RUNTIME_DIR: 'runtime', ADAPTER_COMPUTER_ID_FILE: 'computer-id',
      HARNESS_LOGS_DIR: 'logs', HARNESS_PTY_DIR: 'pty', HARNESS_DEVICES_DIR: 'devices', HARNESS_HOOK_ROUTES_DIR: 'hook-routes',
      HARNESS_AGENT_MESSAGES_DIR: 'agent-messages', DSH_DIR: 'dsh', HARNESS_AUTH_DIR: 'auth', HARNESS_FLASHER_CACHE: 'flasher',
      HARNESS_CONNECTIONS_DIR: 'connections',
    }
    const overrides = Object.fromEntries(Object.entries(set).map(([name, folder]) => [name, join(elsewhere, folder)]))
    const child = run(READ_FOLDERS, overrides)
    expect(child.status, child.stderr).toBe(0)
    expect(JSON.parse(child.stdout)).toMatchObject({
      ADAPTER_CLI_DIR: overrides.ADAPTER_CLI_DIR,
      ADAPTER_DATA_DIR: overrides.ADAPTER_DATA_DIR,
      ADAPTER_RUNTIME_DIR: overrides.ADAPTER_RUNTIME_DIR,
      ADAPTER_COMPUTER_ID_FILE: overrides.ADAPTER_COMPUTER_ID_FILE,
      HARNESS_LOGS_DIR: overrides.HARNESS_LOGS_DIR,
      HARNESS_PTY_DIR: overrides.HARNESS_PTY_DIR,
      HARNESS_DEVICES_DIR: overrides.HARNESS_DEVICES_DIR,
      HARNESS_HOOK_ROUTES_DIR: overrides.HARNESS_HOOK_ROUTES_DIR,
      HARNESS_AGENT_MESSAGES_DIR: overrides.HARNESS_AGENT_MESSAGES_DIR,
      DSH_DIR: overrides.DSH_DIR,
      AUTH_DIR: overrides.HARNESS_AUTH_DIR,
      FLASHER_DIR: overrides.HARNESS_FLASHER_CACHE,
      connectorsDir: overrides.HARNESS_CONNECTIONS_DIR,
    })
  }, 70_000)

  // startHome.ts compares paths and opens nothing, so the account's own folder is named as a string only: where the rule
  // finds it for an environment with no XDG variable, as the child's is.
  const account = accountHome()
  it.skipIf(process.platform === 'win32' || !account)('a HOME that is not the account\'s is told its data folder', () => {
    const dataDir = join(harnessPath('cli', account!, process.platform, { env: {}, exists: existsSync }), 'data')
    const child = run(`process.argv[2] = 'status'; import(${JSON.stringify(source('./startHome.ts'))})`, { ADAPTER_DATA_DIR: dataDir })
    expect(child.status, child.stderr).toBe(0)
    const cli = process.platform === 'linux' ? join(child.home, '.local', 'share', 'harness', 'cli') : join(child.home, '.harness', 'cli')
    expect(child.stderr).toBe(`harness: HOME is ${child.home}, not this account's home, so ignoring ADAPTER_DATA_DIR=${dataDir}; `
      + `using ${cli}/data. Set ADAPTER_DATA_DIR to a folder outside ~/.harness to choose one.\n`)
  }, 70_000)
})
