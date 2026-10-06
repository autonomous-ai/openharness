import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { link, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { nativeProcessImages } from './nativeProcessImages.js'
import { isolatedTmux, type IsolatedTmux } from '../testing/isolatedTmux.js'
import { executableFileIdentity } from './engineBin.js'
import { TmuxBackend } from './tmuxBackend.js'
import { probeTerminalAgents } from './terminalAgentDiscovery.js'
import { enrichProcessRows, processRows } from './tmux.js'

const realDescribe = process.platform === 'darwin' && process.env.RUN_DARWIN_PROCESS_IMAGES === '1'
  ? describe : describe.skip
const children: ChildProcess[] = []
const folders: string[] = []
let server: IsolatedTmux | undefined
const exec = promisify(execFile)
const originalRuntime = env.ADAPTER_RUNTIME_DIR

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const closed = once(child, 'close')
    child.kill('SIGTERM')
    await closed
  }
  await server?.close()
  server = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  env.ADAPTER_RUNTIME_DIR = originalRuntime
  for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true })
})

async function fixture(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'harness-image-identity-')))
  folders.push(path)
  return path
}

async function nativeSleeper(root: string, name: string): Promise<string> {
  const source = join(root, 'sleeper.c')
  const binary = join(root, name)
  // A copied Apple platform binary can be killed by its launch constraints
  // when exec'd from a shell. Compile a fixture with no such constraints.
  await writeFile(source, '#include <unistd.h>\nint main(void) { sleep(30); return 0; }\n')
  await exec('/usr/bin/clang', [source, '-o', binary], { timeout: 30_000 })
  return binary
}

async function images(pids: number[]) {
  const rows = await processRows()
  expect(rows).not.toBeNull()
  const own = rows!.filter(row => pids.includes(row.pid))
  expect(own).toHaveLength(pids.length)
  return enrichProcessRows(own)
}

realDescribe.sequential('real macOS executable identity', () => {
  beforeEach(async () => {
    const artifact = process.env.HARNESS_PROCESS_IMAGES_ARTIFACT
    if (!artifact) return
    vi.stubGlobal('__DARWIN_PROCESS_IMAGES__', await readFile(artifact, 'utf8'))
    env.ADAPTER_RUNTIME_DIR = await fixture()
    // First execution of a freshly written Mach-O may wait on macOS signature
    // inspection. Production can use lsof during that cold start; warm the
    // private helper here before requiring the native integration path.
    expect((await nativeProcessImages([process.pid], 3000)).images.size).toBe(1)
  })

  it('resolves renamed, Unicode, symlinked and hard-linked native images', async () => {
    const root = await fixture()
    const native = await nativeSleeper(root, 'renamed 引擎 2.9.0')
    const alias = join(root, 'agent alias')
    const hard = join(root, 'hard link')
    await symlink(native, alias)
    await link(native, hard)
    for (const path of [native, alias, hard]) {
      const child = spawn(path, ['30'], { stdio: 'ignore' })
      children.push(child)
      await once(child, 'spawn')
    }
    const result = await images(children.map(child => child.pid!))
    const identity = executableFileIdentity(native)!
    expect(identity).not.toBeNull()
    for (const row of result) {
      expect(row.imagePath?.startsWith('/')).toBe(true)
      expect(row.imageFileKey).toBe(identity.fileKey)
    }
  }, 45_000)

  it('discovers an exec replacement in a real private pane without caching its old image', async () => {
    const root = await fixture()
    const native = await nativeSleeper(root, 'unrecognizable image')
    server = await isolatedTmux({ ...process.env, ZDOTDIR: root, CODEX_HOME: join(root, 'codex') })
    vi.stubEnv('TMUX_TMPDIR', server.root)
    vi.stubEnv('TMUX', undefined)
    vi.stubEnv('TMUX_PANE', undefined)
    vi.stubEnv('CODEX_PATH', native)
    const pane = await server.run('new-session', '-d', '-P', '-F', '#{pane_id}',
      '-s', `harness-image-${process.pid}`, '/bin/sh', '-c',
      'read -r line; exec "$1" 30', 'harness-image', native)
    const pid = Number(await server.run('display-message', '-p', '-t', pane, '#{pane_pid}'))
    await server.run('set-option', '-w', '-t', pane, 'remain-on-exit', 'on')
    const [before] = await images([pid])
    // macOS can execute /bin/sh with /bin/bash as its kernel image. Compare
    // the actual mapped executable, not the shell's launch pathname.
    const mapped = (await exec('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], { timeout: 3000 }))
      .stdout.split('\n').find(line => line.startsWith('n/'))?.slice(1)
    expect(mapped).toBeDefined()
    expect(before.imageFileKey).toBe(executableFileIdentity(mapped!)!.fileKey)
    await server.run('send-keys', '-t', pane, 'Enter')
    const expected = executableFileIdentity(native)!.fileKey
    try {
      await vi.waitFor(async () => {
        const [after] = await images([pid])
        expect(after.imageFileKey).toBe(expected)
        expect(after.startMarker).toBe(before.startMarker)
      }, { timeout: 4000, interval: 100 })
    } catch (error) {
      throw new Error(`${error}\n${await server.run('capture-pane', '-p', '-t', pane)}`)
    }
    const probe = await probeTerminalAgents([new TmuxBackend()], ['tmux'])
    expect(probe.processTableAvailable).toBe(true)
    expect(probe.agents).toHaveLength(1)
    expect(probe.agents[0]).toMatchObject({ engine: 'codex', processIdentity: { pid, startMarker: before.startMarker } })
    await server.run('kill-session', '-t', `harness-image-${process.pid}`)
    const afterExit = await probeTerminalAgents([new TmuxBackend()], ['tmux'])
    expect(afterExit.processTableAvailable).toBe(true)
    expect(afterExit.agents).toEqual([])
  }, 45_000)
})
