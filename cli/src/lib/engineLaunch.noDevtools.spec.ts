import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBinaryOnPath } from './binaryOnPath.js'
import { buildEngineLaunchArgv, noDevtoolsPrelude, shellSingleQuote } from './engineLaunch.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// A Mac without the developer tools, in folders of its own: `sys` stands for /usr/bin, whose `git`
// and `python3` are the stub that opens Apple's dialog (it records that it did) until `installed`
// exists; `later` holds a python3 of the person's own, after /usr/bin on PATH.
function mac() {
  const root = mkdtempSync(join(tmpdir(), 'harness-no-devtools-'))
  roots.push(root)
  const home = join(root, "home with 'quotes")
  const sys = join(root, 'sys')
  const later = join(root, 'later')
  const tools = join(root, 'tools')
  for (const dir of [home, sys, later, tools, join(root, 'xs')]) mkdirSync(dir)
  const dialogs = join(root, 'dialogs')
  const installed = join(root, 'installed')
  const asked = join(root, 'asked')
  const script = (path: string, body: string) => {
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
  }
  for (const tool of ['git', 'python3']) {
    script(join(sys, tool), `if [ -e ${shellSingleQuote(installed)} ]; then echo REAL_${tool}; exit 0; fi\necho ${tool} >>${shellSingleQuote(dialogs)}\nexit 1`)
  }
  script(join(later, 'python3'), 'echo OWN_python3')
  const xcodeSelect = join(root, 'xs', 'xcode-select')
  script(xcodeSelect, `echo >>${shellSingleQuote(asked)}\n[ -e ${shellSingleQuote(installed)} ] && { echo /Library/Developer/CommandLineTools; exit 0; }\nexit 2`)
  // The commands the prelude itself uses, and nothing else from the real system's folders: a CI
  // runner's /bin has a real git that would answer before the stand-ins are ever reached.
  for (const tool of ['mkdir', 'chmod', 'mv', 'ln', 'cat']) {
    const real = resolveBinaryOnPath(tool)
    if (real) symlinkSync(real, join(tools, tool))
  }
  const places = {
    xcodeSelect,
    systemBin: sys,
    commandLineTools: join(root, 'clt', 'usr', 'bin'),
    selectLink: join(root, 'xcode_select_link'),
  }
  const run = (commands: string, shell = '/bin/sh', path = `${tools}:${sys}:${later}`) => {
    const args = shell.endsWith('zsh') ? ['-f', '-c'] : ['-c']
    return spawnSync(shell, [...args, noDevtoolsPrelude(places) + commands], {
      env: { HOME: home, PATH: path }, encoding: 'utf8', timeout: 20_000,
    })
  }
  const nodev = join(home, '.harness/runtime/no-devtools-1')
  const dialogCount = () => existsSync(dialogs) ? readFileSync(dialogs, 'utf8').trim().split('\n').length : 0
  const askedCount = () => existsSync(asked) ? readFileSync(asked, 'utf8').split('\n').length - 1 : 0
  return { root, home, sys, later, tools, nodev, places, installed, run, dialogCount, askedCount }
}

const shells = ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/dash'].filter((shell) => existsSync(shell))

describe('an agent pane on a Mac without the developer tools', () => {
  for (const shell of shells) {
    it(`never opens Apple's dialog: the agent reads what is missing instead (${shell})`, () => {
      const m = mac()
      const result = m.run('git --version; echo "git=$?"; python3 -c 1; echo "PATH=$PATH"', shell)
      expect(result.stderr).toContain("git: this needs Apple's command line developer tools, which this Mac does not have.")
      expect(result.stderr).toContain('Install them with: xcode-select --install')
      expect(result.stdout).toContain('git=127')
      // A python3 of the person's own, later on PATH than the stub, still runs.
      expect(result.stdout).toContain('OWN_python3')
      expect(m.dialogCount()).toBe(0)
      // Just before the system's folder: everything ahead of it is untouched.
      expect(result.stdout).toContain(`PATH=${m.tools}:${m.nodev}:${m.sys}:${m.later}\n`)
    })
  }

  it('writes the stand-ins once, and puts them on PATH once', () => {
    const m = mac()
    expect(m.run(':').status).toBe(0)
    const written = statSync(join(m.nodev, 'stand-in')).mtimeMs
    const twice = m.run(noDevtoolsPrelude(m.places) + 'echo "PATH=$PATH"')
    expect(twice.stdout).toContain(`PATH=${m.tools}:${m.nodev}:${m.sys}:${m.later}\n`)
    expect(statSync(join(m.nodev, 'stand-in')).mtimeMs).toBe(written)
    expect(existsSync(join(m.nodev, 'make'))).toBe(true)
  })

  it('runs the real tool once the developer tools are installed, and the next pane goes without', () => {
    const m = mac()
    m.run(':')
    writeFileSync(m.installed, '')
    // A pane opened before the install keeps the stand-ins on PATH; they hand over.
    const before = spawnSync(join(m.nodev, 'git'), ['--version'], {
      env: { HOME: m.home, PATH: `${m.tools}:${m.nodev}:${m.sys}` }, encoding: 'utf8',
    })
    expect(before.stdout).toContain('REAL_git')
    const after = m.run('git --version; echo "PATH=$PATH"')
    expect(after.stdout).toContain('REAL_git')
    expect(after.stdout).toContain(`PATH=${m.tools}:${m.sys}:${m.later}\n`)
    expect(m.dialogCount()).toBe(0)
  })

  it('leaves a Mac with the tools alone without asking xcode-select', () => {
    const m = mac()
    mkdirSync(m.places.commandLineTools, { recursive: true })
    const result = m.run('echo "PATH=$PATH"')
    expect(result.stdout).toContain(`PATH=${m.tools}:${m.sys}:${m.later}\n`)
    expect(m.askedCount()).toBe(0)
    expect(existsSync(m.nodev)).toBe(false)
  })

  it('leaves a PATH without the system folder alone', () => {
    const m = mac()
    const result = m.run('echo "PATH=$PATH"', '/bin/sh', `${m.tools}:${m.later}`)
    expect(result.stdout).toContain(`PATH=${m.tools}:${m.later}\n`)
  })

  it('runs in every agent launch, after the shell has read its startup files', () => {
    const argv = buildEngineLaunchArgv('claude', {}, '/bin/zsh', '/opt/node', 'grid', null)
    // A POSIX shell sources the script from a one-time file.
    const script = argv[argv.indexOf('harness-engine') - 1]
    const file = /^\. '(.*)'$/.exec(script)?.[1]
    expect(file ? readFileSync(file, 'utf8') : script).toContain('harness_nodev="$HOME/.harness/runtime/no-devtools-1"')
  })
})
