import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hermesArgv, hermesBootFile, hermesBootSource, hermesRoot, launcherPython } from './hermesLaunch.js'
import { windowsEngineArgv } from './launch.js'

// Hermes' Windows installer, as measured on DESKTOP-0TFH0OJ (2026-11-09): <root>\bin\hermes.exe is a 115 KB uv
// launcher, unsigned, whose `#!` names the (also unsigned) Python it ships; Smart App Control refuses it, but
// `hermes_cli.main` runs fine on that Python. The shapes below are that install's, copied into a temp folder.
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const folder = (): string => { const dir = mkdtempSync(join(tmpdir(), 'hermes-win-')); dirs.push(dir); return dir }
const touch = (file: string, text = ''): string => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); return file }

/** A Hermes install: the agent package, its bundled Python, and the launcher whose shebang names it. */
function install(withShebang = true) {
  const local = folder()
  const root = join(local, 'hermes')
  const python = touch(join(root, 'tools', 'python-3.14.9+20261021-win32-x64', 'python.exe'), 'MZ')
  touch(join(root, 'hermes-agent', 'hermes_cli', 'main.py'), 'def main(): return 0\n')
  const launcher = touch(join(root, 'bin', 'hermes.exe'), withShebang ? `launcher padding\n#!${python} -I` : 'padding only')
  return { local, root, python, launcher, environment: { PATH: `${local}\\hermes\\bin` } }
}

describe('Hermes on Windows, past Smart App Control', () => {
  it('reads the Python its launcher names, and the install root around it', () => {
    const { root, python, launcher } = install()
    expect(launcherPython(launcher)).toBe(python)
    expect(hermesRoot(launcher)).toBe(root)
    // Not a Hermes launcher at all: no root, so nothing to step past.
    expect(hermesRoot(join(root, 'bin', 'other.exe'))).toBeNull()
    expect(hermesRoot(join(root, 'hermes-agent', 'hermes_cli', 'main.py'))).toBeNull()
  })

  it('runs the shipped Python on a boot module, never the unsigned launcher', () => {
    const { root, python, launcher } = install()
    const argv = hermesArgv(launcher, ['--version'], { platform: 'win32' })
    expect(argv).toEqual([python, '-I', hermesBootFile(root), '--version'])
    // The boot module puts the install's own folder first, as the launcher does, then runs its CLI.
    expect(readFileSync(hermesBootFile(root), 'utf8')).toBe(hermesBootSource(root))
    expect(hermesBootSource(root)).toContain(`sys.path.insert(0, ${JSON.stringify(join(root, 'hermes-agent'))})`)
    expect(hermesBootSource(root)).toContain('from hermes_cli.main import main')
  })

  it('falls back to the Python beside the install when the launcher names none', () => {
    const { root, python, launcher } = install(false)
    expect(launcherPython(launcher)).toBeNull()
    expect(hermesArgv(launcher, [], { platform: 'win32' })).toEqual([python, '-I', hermesBootFile(root)])
  })

  it('leaves every other program, platform and broken install exactly as it was', () => {
    const { launcher, root } = install()
    expect(hermesArgv(launcher, [], { platform: 'darwin' })).toBeNull()
    // An install whose package is gone is not one this can start.
    rmSync(join(root, 'hermes-agent'), { recursive: true, force: true })
    expect(hermesArgv(launcher, [], { platform: 'win32' })).toBeNull()
    // A boot file that cannot be written: the launcher's own argv, and Windows' own sentence.
    const ok = install()
    expect(hermesArgv(ok.launcher, [], { platform: 'win32', write: () => { throw new Error('denied') } })).toBeNull()
  })

  it('is what an engine argv does for hermes, and only for hermes', () => {
    const { root, python, launcher } = install()
    const viaHermes = windowsEngineArgv('hermes', [launcher, '--version'], { platform: 'win32', environment: { PATH: '' } })
    expect(viaHermes).toEqual([python, '-I', hermesBootFile(root), '--version'])
    // A different engine pointed at the same path is untouched: this is Hermes' fix, not a Windows-wide one.
    expect(windowsEngineArgv('opencode', [launcher], { platform: 'win32', environment: { PATH: '' } })).toEqual([launcher])
  })
})
