import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commandAvailableInInteractiveShell, commandOutputInInteractiveShell } from './interactiveProbe.js'
import type { EngineInstallRecipe } from '../../lib/engineInstall.js'

const dirs: string[] = []
const originalProbePath = process.env.HARNESS_ENGINE_TEST_PATH

afterEach(() => {
  if (originalProbePath === undefined) delete process.env.HARNESS_ENGINE_TEST_PATH
  else process.env.HARNESS_ENGINE_TEST_PATH = originalProbePath
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function executable(dir: string, name: string): string {
  const path = join(dir, name)
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o700)
  return path
}

function bashProbeShell(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-engine-shell-'))
  dirs.push(dir)
  const shell = join(dir, 'bash')
  writeFileSync(shell, `#!/bin/sh
[ "$1" = '-ic' ] || exit 97
shift
script="$1"
shift
PATH="$HARNESS_ENGINE_TEST_PATH"
export PATH
exec /bin/sh -c "$script" "$@"
`)
  chmodSync(shell, 0o700)
  return shell
}

describe('commandAvailableInInteractiveShell', () => {
  it('reports a shell failure as unverified rather than a missing command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-failed-probe-'))
    dirs.push(dir)
    const shell = join(dir, 'bash')
    writeFileSync(shell, '#!/bin/sh\nexit 9\n')
    chmodSync(shell, 0o700)
    const result = await commandAvailableInInteractiveShell('git', shell, undefined, true)
    expect(result).toMatchObject({ status: 'unverified', detail: expect.stringContaining('9') })
  })
  it('bounds a hung shell probe and reports a timeout as unverified', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-slow-probe-'))
    dirs.push(dir)
    const shell = join(dir, 'bash')
    writeFileSync(shell, '#!/bin/sh\nexec /bin/sleep 30\n')
    chmodSync(shell, 0o700)
    const started = Date.now()
    const result = await commandAvailableInInteractiveShell('git', shell, undefined, true)
    expect(result).toEqual({ status: 'unverified', detail: 'Interactive shell tool probe timed out after 5 seconds.' })
    expect(Date.now() - started).toBeLessThan(7_000)
  }, 8_000)
  it('uses the same bash interactive PATH that launches a new engine', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'harness-engine-bin-'))
    dirs.push(binDir)
    executable(binDir, 'kilo')
    process.env.HARNESS_ENGINE_TEST_PATH = binDir

    const shell = bashProbeShell()
    await expect(commandAvailableInInteractiveShell('kilo', shell)).resolves.toBe(true)
    await expect(commandAvailableInInteractiveShell('missing-engine', shell)).resolves.toBe(false)
    await expect(commandAvailableInInteractiveShell('kilo', shell, undefined, true)).resolves.toEqual({ status: 'available' })
    await expect(commandAvailableInInteractiveShell('missing-engine', shell, undefined, true)).resolves.toEqual({ status: 'missing' })
  })

  it('recognizes an installed vendor path before the shell profile has it on PATH', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'harness-engine-vendor-bin-'))
    dirs.push(binDir)
    const installed = executable(binDir, 'cursor-agent')
    process.env.HARNESS_ENGINE_TEST_PATH = '/usr/bin:/bin'
    const recipe: EngineInstallRecipe = {
      command: 'false',
      source: 'test fixture',
      executable: { names: ['cursor-agent'], absolutePaths: [installed] },
    }

    await expect(
      commandAvailableInInteractiveShell('cursor-agent', bashProbeShell(), recipe),
    ).resolves.toBe(true)
  })
})

describe('commandOutputInInteractiveShell', () => {
  it('returns both streams and the exit status from the shell a launch uses, and nothing for a hung command', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'harness-engine-output-'))
    dirs.push(binDir)
    writeFileSync(join(binDir, 'openclaw'), '#!/bin/sh\nprintf "%s\\n" "OpenClaw $1"\nprintf "%s\\n" "a warning" >&2\nexit 3\n')
    chmodSync(join(binDir, 'openclaw'), 0o700)
    writeFileSync(join(binDir, 'stuck'), '#!/bin/sh\nexec /bin/sleep 30\n')
    chmodSync(join(binDir, 'stuck'), 0o700)
    process.env.HARNESS_ENGINE_TEST_PATH = `${binDir}:/usr/bin:/bin`
    const ran = await commandOutputInInteractiveShell('openclaw', 'openclaw', ['--version'], bashProbeShell())
    expect(ran?.code).toBe(3)
    expect(ran?.output).toContain('OpenClaw --version')
    expect(ran?.output).toContain('a warning')
    await expect(commandOutputInInteractiveShell('openclaw', 'stuck', [], bashProbeShell())).resolves.toBeNull()
  }, 8_000)
})
