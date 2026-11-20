import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { harnessPaneOwner } from '../lib/harnessSessionLabel.js'
import { checkMove, OVERRIDE_NAMES, withEnvFile, type ConditionDeps } from './conditions.js'
import { planMove } from './plan.js'

const FS: ConditionDeps['fs'] = { lstatSync, readdirSync, readFileSync, existsSync, realpathSync }

/** The same file system, noting every path it is asked about. */
function watched(seen: string[]): ConditionDeps['fs'] {
  const pass = <F>(fn: F): F => ((path: string, ...rest: unknown[]) => {
    seen.push(path)
    return (fn as (...args: unknown[]) => unknown)(path, ...rest)
  }) as F
  return { lstatSync: pass(lstatSync), readdirSync: pass(readdirSync), readFileSync: pass(readFileSync), existsSync: pass(existsSync), realpathSync: pass(realpathSync) }
}

const folder = (): string => mkdtempSync(join(tmpdir(), 'home-move-'))

/** A home whose ~/.harness was never moved: the CLI's folder, its data folder and the logs. */
function legacyHome(): { home: string; legacy: string; cliDir: string; dataDir: string } {
  const home = folder(), legacy = join(home, '.harness'), cliDir = join(legacy, 'cli'), dataDir = join(cliDir, 'data')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(join(legacy, 'logs'))
  return { home, legacy, cliDir, dataDir }
}

/** An update awaiting its verdict: the hold the conditions before it must win over. */
const pending = (cliDir: string): void => writeFileSync(join(cliDir, 'update-pending.json'), '{}')

/** A tmux before pane options with a pane carrying [tag], and a live PTY host: the holds the conditions before them must win over. */
const laterHolds = (tag: string): Partial<ConditionDeps> => ({ tmux: { version: () => 'tmux 2.9', tags: () => [tag] }, ptyHostRuns: () => true })

function deps(home: string, over: Partial<ConditionDeps> = {}): ConditionDeps {
  return {
    platform: 'linux', home, env: {}, hasExecve: true, fs: FS, alive: () => false, answers: async () => false,
    tmux: { version: () => 'tmux 3.4', tags: () => [] }, ptyHostRuns: () => false, ...over,
  }
}

const NONE = { move: false, hold: null }
const waiting = (reason: string) => ({ move: false, hold: { state: 'waiting', reason } })
const skipped = (name: string) => ({ move: false, hold: { state: 'skipped-override', name } })

describe('whether the move runs: the first condition that holds decides', () => {
  it('not Linux → no hold', async () => {
    const { home, cliDir } = legacyHome()
    pending(cliDir)
    expect(await checkMove(deps(home, { platform: 'darwin' }))).toEqual(NONE)
  })

  it('the data root holds the marker → no hold', async () => {
    const { home, cliDir } = legacyHome()
    pending(cliDir)
    const data = join(home, '.local', 'share', 'harness')
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, '.harness-root'), '1\n')
    expect(await checkMove(deps(home))).toEqual(NONE)
  })

  // Somebody else's folder where the data root goes is no move done: the move runs, and refuses it (move.ts, target-exists).
  it('a data root without the marker → the move runs', async () => {
    const { home } = legacyHome()
    mkdirSync(join(home, '.local', 'share', 'harness'), { recursive: true })
    expect(await checkMove(deps(home))).toMatchObject({ move: true })
  })

  it('a folder named as the marker is none → the move runs', async () => {
    const { home } = legacyHome()
    mkdirSync(join(home, '.local', 'share', 'harness', '.harness-root'), { recursive: true })
    expect(await checkMove(deps(home))).toMatchObject({ move: true })
  })

  it('no ~/.harness → no hold', async () => {
    expect(await checkMove(deps(folder()))).toEqual(NONE)
  })

  it('~/.harness is itself a link → skipped-override, and nothing under it is read', async () => {
    const home = folder(), elsewhere = folder(), legacy = join(home, '.harness')
    mkdirSync(join(elsewhere, 'cli', 'data'), { recursive: true })
    pending(join(elsewhere, 'cli'))
    symlinkSync(elsewhere, legacy)
    const seen: string[] = []
    expect(await checkMove(deps(home, { fs: watched(seen) }))).toEqual(skipped('~/.harness'))
    expect(seen).toContain(legacy)
    expect(seen.filter((path) => path.startsWith(`${legacy}/`) || path.startsWith(elsewhere))).toEqual([])
  })

  it('~/.harness holds only links, hook-routes and connections (a bridge) → no hold', async () => {
    const home = folder(), moved = folder(), legacy = join(home, '.harness')
    mkdirSync(join(legacy, 'hook-routes'), { recursive: true })
    mkdirSync(join(legacy, 'connections'))
    mkdirSync(join(moved, 'cli', 'data'), { recursive: true })
    pending(join(moved, 'cli'))
    symlinkSync(join(moved, 'cli'), join(legacy, 'cli'))
    expect(await checkMove(deps(home))).toEqual(NONE)
  })

  it('no process.execve → no hold', async () => {
    const { home, cliDir } = legacyHome()
    pending(cliDir)
    expect(await checkMove(deps(home, { hasExecve: false }))).toEqual(NONE)
  })

  it('a live pid in adapter.pid → no hold; a dead one is no daemon', async () => {
    const { home, cliDir, dataDir } = legacyHome()
    pending(cliDir)
    writeFileSync(join(dataDir, 'adapter.pid'), '4242\n')
    expect(await checkMove(deps(home, { alive: (pid) => pid === 4242 }))).toEqual(NONE)
    expect(await checkMove(deps(home))).toEqual(waiting('update-pending'))
  })

  it('a socket that answers, beside the data folder or in its short folder → no hold; each is asked once', async () => {
    const { home, legacy, cliDir, dataDir } = legacyHome()
    pending(cliDir)
    const beside = join(dataDir, 'daemon-18473.sock')
    const short = join(legacy, 's', createHash('sha256').update(dataDir).digest('hex').slice(0, 16))
    const far = join(short, 'daemon-18474.sock')
    mkdirSync(short, { recursive: true })
    for (const file of [beside, far, join(dataDir, 'harness.log')]) writeFileSync(file, '')
    const asked: string[] = []
    const answers = async (socket: string) => { asked.push(socket); return socket === far }
    expect(await checkMove(deps(home, { answers }))).toEqual(NONE)
    expect(asked).toEqual([beside, far])
    expect(await checkMove(deps(home))).toEqual(waiting('update-pending'))
  })

  // A daemon of this build on a home too long for a socket beside its data, with an XDG_RUNTIME_DIR (lib/localSocket.ts).
  it('a socket that answers in its short folder under XDG_RUNTIME_DIR → no hold', async () => {
    const { home, cliDir, dataDir } = legacyHome()
    pending(cliDir)
    const runtime = folder()
    const far = join(runtime, 'harness', createHash('sha256').update(dataDir).digest('hex').slice(0, 16), 'daemon-18474.sock')
    mkdirSync(join(far, '..'), { recursive: true })
    writeFileSync(far, '')
    const answers = async (socket: string) => socket === far
    expect(await checkMove(deps(home, { env: { XDG_RUNTIME_DIR: runtime }, answers }))).toEqual(NONE)
  })

  it('a socket that has not answered in a second is no daemon', async () => {
    vi.useFakeTimers()
    try {
      const { home, dataDir } = legacyHome()
      writeFileSync(join(dataDir, 'daemon-18473.sock'), '')
      let settled = false
      const check = checkMove(deps(home, { answers: () => new Promise<boolean>(() => {}) })).finally(() => { settled = true })
      await vi.advanceTimersByTimeAsync(999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await check).toMatchObject({ move: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a spawn lock whose owner lives → no hold', async () => {
    const { home, cliDir, dataDir } = legacyHome()
    pending(cliDir)
    mkdirSync(join(dataDir, 'adapter.spawn.lock'))
    writeFileSync(join(dataDir, 'adapter.spawn.lock', 'owner.json'), JSON.stringify({ pid: 5151, startMarker: 's', token: 't', purpose: 'start', since: 1 }))
    expect(await checkMove(deps(home, { alive: (pid) => pid === 5151 }))).toEqual(NONE)
    expect(await checkMove(deps(home))).toEqual(waiting('update-pending'))
  })

  it('update-pending.json in the CLI folder → waiting update-pending', async () => {
    const { home, legacy, cliDir, dataDir } = legacyHome()
    pending(cliDir)
    const env = { ADAPTER_DATA_DIR: dataDir, DSH_DIR: join(legacy, 'dsh') }
    expect(await checkMove(deps(home, { env, ...laterHolds(harnessPaneOwner(dataDir)) }))).toEqual(waiting('update-pending'))
  })

  it('an override inside ~/.harness, lexically or through a link, in the environment or in its file → skipped-override with its name', async () => {
    const { home, legacy, dataDir } = legacyHome()
    const later = laterHolds(harnessPaneOwner(dataDir))
    expect(await checkMove(deps(home, { ...later, env: { ADAPTER_DATA_DIR: dataDir } }))).toEqual(skipped('ADAPTER_DATA_DIR'))
    // A folder not made yet, under a link to ~/.harness.
    symlinkSync(legacy, join(home, 'alias'))
    expect(await checkMove(deps(home, { ...later, env: { DSH_DIR: join(home, 'alias', 'dsh') } }))).toEqual(skipped('DSH_DIR'))
    const file = join(home, 'harness.env')
    writeFileSync(file, `HARNESS_LOGS_DIR=${join(legacy, 'logs')}\n`)
    expect(await checkMove(deps(home, { ...later, env: { HARNESS_ENV_FILE: file } }))).toEqual(skipped('HARNESS_LOGS_DIR'))
    expect(await checkMove(deps(home, { ...later, env: { DOTENV_CONFIG_PATH: file } }))).toEqual(skipped('HARNESS_LOGS_DIR'))
    // A name already in the environment wins over the file's.
    expect(await checkMove(deps(home, { env: { HARNESS_ENV_FILE: file, HARNESS_LOGS_DIR: join(home, 'logs') } }))).toMatchObject({ move: true })
  })

  it.each(['HARNESS_ENV_FILE', 'DOTENV_CONFIG_PATH'])('an env file inside ~/.harness, named by %s, → skipped-override: the move would take it from its daemon', async (name) => {
    const { home, legacy, dataDir } = legacyHome()
    const file = join(legacy, 'harness.env')
    writeFileSync(file, 'HARNESS_LOG_LEVEL=debug\n')
    expect(await checkMove(deps(home, { ...laterHolds(harnessPaneOwner(dataDir)), env: { [name]: file } }))).toEqual(skipped(name))
  })

  // config/loadEnv.ts reads the file trimmed (envFilePath): the padded name is the same file.
  it.each(['HARNESS_ENV_FILE', 'DOTENV_CONFIG_PATH'])('an env file inside ~/.harness, named by %s with spaces around it, → skipped-override', async (name) => {
    const { home, legacy, dataDir } = legacyHome()
    const file = join(legacy, 'harness.env')
    writeFileSync(file, 'HARNESS_LOG_LEVEL=debug\n')
    expect(await checkMove(deps(home, { ...laterHolds(harnessPaneOwner(dataDir)), env: { [name]: ` ${file} ` } }))).toEqual(skipped(name))
  })

  it('tmux before 3.0 with a pane that carries the tag → waiting old-tmux', async () => {
    const { home, dataDir } = legacyHome()
    const asked: boolean[] = []
    const tmux = { version: () => 'tmux 2.9', tags: (paneOptions: boolean) => { asked.push(paneOptions); return ['0123456789abcdef', harnessPaneOwner(dataDir)] } }
    expect(await checkMove(deps(home, { tmux, ptyHostRuns: () => true }))).toEqual(waiting('old-tmux'))
    expect(asked).toEqual([false])
  })

  it('tmux before 3.0 with no such pane → move', async () => {
    const { home } = legacyHome()
    expect(await checkMove(deps(home, { tmux: { version: () => 'tmux 2.8', tags: () => ['0123456789abcdef'] } }))).toMatchObject({ move: true })
  })

  it('a live PTY host → waiting pty-host', async () => {
    const { home, legacy } = legacyHome()
    const looked: string[] = []
    expect(await checkMove(deps(home, { ptyHostRuns: (dir) => { looked.push(dir); return true } }))).toEqual(waiting('pty-host'))
    expect(looked).toEqual([join(legacy, 'pty')])
  })

  it('else → move, with the old and the new tag', async () => {
    const { home, legacy, dataDir } = legacyHome()
    // From 3.0 a pane's tag is an option the move can set again: a tagged pane holds nothing.
    const tmux = { version: () => 'tmux 3.0a', tags: () => [harnessPaneOwner(dataDir)] }
    expect(await checkMove(deps(home, { tmux }))).toEqual({
      move: true, plan: planMove(home, {}, readdirSync(legacy)),
      oldTag: harnessPaneOwner(dataDir), newTag: harnessPaneOwner(join(home, '.local', 'share', 'harness', 'cli', 'data')),
    })
  })
})

describe('what the conditions read', () => {
  it('the list holds every setting whose default is under the home', () => {
    const source = readFileSync(new URL('../config/env.ts', import.meta.url), 'utf8')
    const underHome = /^\s+([A-Z][A-Z0-9_]*): .*\b(?:harnessPath\(|adapterCliDir|adapterDataDir|adapterRuntimeDir|computerIdFile)/gm
    const fields = [...source.matchAll(underHome)].map((match) => match[1])
    expect(fields).toContain('ADAPTER_DATA_DIR')
    expect(OVERRIDE_NAMES).toEqual(expect.arrayContaining([...fields, 'HARNESS_AUTH_DIR', 'HARNESS_CONNECTIONS_DIR', 'HARNESS_FLASHER_CACHE']))
  })

  // The file config/loadEnv.ts reads, whatever folder the start runs in.
  it('a relative env file is the one in the home', () => {
    const home = folder()
    writeFileSync(join(home, 'harness.env'), 'HARNESS_LOGS_DIR=/from/the/home\n')
    expect(withEnvFile({ fs: FS, env: { HARNESS_ENV_FILE: 'harness.env' }, home })).toEqual({ HARNESS_ENV_FILE: 'harness.env', HARNESS_LOGS_DIR: '/from/the/home' })
  })

  // config/env.ts reads a relative override against the home in every process: the daemon the move waits for or leaves
  // alone uses the folder in the home, never the one in the folder the start runs in.
  describe('a relative override is the home\'s', () => {
    it('one inside ~/.harness → skipped-override with its name', async () => {
      const { home, dataDir } = legacyHome()
      expect(await checkMove(deps(home, { ...laterHolds(harnessPaneOwner(dataDir)), env: { DSH_DIR: join('.harness', 'dsh') } }))).toEqual(skipped('DSH_DIR'))
    })

    it('the CLI folder\'s update-pending.json → waiting update-pending', async () => {
      const { home } = legacyHome()
      mkdirSync(join(home, 'own-cli'))
      pending(join(home, 'own-cli'))
      expect(await checkMove(deps(home, { env: { ADAPTER_CLI_DIR: 'own-cli' } }))).toEqual(waiting('update-pending'))
    })

    it('the PTY host\'s folder is the one asked', async () => {
      const { home } = legacyHome()
      const looked: string[] = []
      expect(await checkMove(deps(home, { env: { HARNESS_PTY_DIR: 'own-pty' }, ptyHostRuns: (dir) => { looked.push(dir); return true } }))).toEqual(waiting('pty-host'))
      expect(looked).toEqual([join(home, 'own-pty')])
    })

    it('the data folder\'s tag, before the move and after', async () => {
      const { home } = legacyHome()
      const own = join(home, 'own-data')
      mkdirSync(own)
      expect(await checkMove(deps(home, { env: { ADAPTER_DATA_DIR: 'own-data' } }))).toMatchObject({ move: true, oldTag: harnessPaneOwner(own), newTag: harnessPaneOwner(own) })
    })
  })

  it('the new tag is the data folder\'s after the move', async () => {
    const { home, dataDir } = legacyHome()
    expect(await checkMove(deps(home))).toMatchObject({
      oldTag: harnessPaneOwner(dataDir), newTag: harnessPaneOwner(join(home, '.local', 'share', 'harness', 'cli', 'data')),
    })

    const outside = join(home, 'own-data')
    mkdirSync(outside)
    const own = harnessPaneOwner(outside)
    expect(await checkMove(deps(home, { env: { ADAPTER_DATA_DIR: outside } }))).toMatchObject({ move: true, oldTag: own, newTag: own })

    // ~/.harness/cli is a link to a folder out of the tree: the link moves, and the data folder stays where it points.
    const linked = folder(), cli = folder()
    mkdirSync(join(cli, 'data'))
    mkdirSync(join(linked, '.harness', 'logs'), { recursive: true })
    symlinkSync(cli, join(linked, '.harness', 'cli'))
    const kept = harnessPaneOwner(join(cli, 'data'))
    expect(await checkMove(deps(linked))).toMatchObject({ move: true, oldTag: kept, newTag: kept })
  })
})
