import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEngineLaunchArgv, engineFallbackPrelude, noDevtoolsPrelude, shellSingleQuote } from './engineLaunch.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// A Mac's places, in folders of its own: an `xcode-select` that answers as one with no developer tools
// (exit 2) until `xcode` exists, and records each time it is asked. Apple's stubs themselves cannot be
// run here; the activation VM measured that they honour a missing DEVELOPER_DIR without the dialog.
function mac() {
  const root = mkdtempSync(join(tmpdir(), 'harness-no-devtools-'))
  roots.push(root)
  mkdirSync(join(root, 'bin'))
  const xcode = join(root, 'xcode')
  const asked = join(root, 'asked')
  const xcodeSelect = join(root, 'bin', 'xcode-select')
  writeFileSync(xcodeSelect, `#!/bin/sh\necho >>${shellSingleQuote(asked)}\n[ -e ${shellSingleQuote(xcode)} ] && { echo /Applications/Xcode.app/Contents/Developer; exit 0; }\nexit 2\n`)
  chmodSync(xcodeSelect, 0o755)
  const places = {
    xcodeSelect,
    commandLineTools: join(root, 'CommandLineTools'),
    selectLink: join(root, 'xcode_select_link'),
  }
  const run = (shell = '/bin/sh', env: Record<string, string> = {}) => {
    const args = shell.endsWith('zsh') ? ['-f', '-c'] : ['-c']
    // What the agent and the shells it starts see.
    return spawnSync(shell, [...args, `${noDevtoolsPrelude(places)}sh -c 'echo "DEVELOPER_DIR=\${DEVELOPER_DIR:-unset}"'`], {
      env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8', timeout: 20_000,
    })
  }
  const askedCount = () => existsSync(asked) ? readFileSync(asked, 'utf8').split('\n').length - 1 : 0
  return { root, xcode, places, run, askedCount }
}

const shells = ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/dash'].filter((shell) => existsSync(shell))

describe('an agent pane on a Mac without the developer tools', () => {
  for (const shell of shells) {
    it(`points DEVELOPER_DIR where the tools install, for the agent and every shell it starts (${shell})`, () => {
      const m = mac()
      const result = m.run(shell)
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe(`DEVELOPER_DIR=${m.places.commandLineTools}\n`)
      expect(m.askedCount()).toBe(1)
    })
  }

  it('leaves a Mac with the tools alone without asking xcode-select', () => {
    const m = mac()
    mkdirSync(join(m.places.commandLineTools, 'usr', 'bin'), { recursive: true })
    expect(m.run().stdout).toBe('DEVELOPER_DIR=unset\n')
    expect(m.askedCount()).toBe(0)
  })

  it('leaves one whose developer folder was chosen with xcode-select alone', () => {
    const m = mac()
    writeFileSync(m.places.selectLink, '')
    expect(m.run().stdout).toBe('DEVELOPER_DIR=unset\n')
    expect(m.askedCount()).toBe(0)
  })

  it('leaves one with Xcode alone, as xcode-select answers', () => {
    const m = mac()
    writeFileSync(m.xcode, '')
    expect(m.run().stdout).toBe('DEVELOPER_DIR=unset\n')
    expect(m.askedCount()).toBe(1)
  })

  it("keeps a DEVELOPER_DIR the person set", () => {
    const m = mac()
    expect(m.run('/bin/sh', { DEVELOPER_DIR: '/Applications/Xcode-beta.app/Contents/Developer' }).stdout)
      .toBe('DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer\n')
    expect(m.askedCount()).toBe(0)
  })

  it('decides again for a launch that inherited the one set here, and keeps nothing stale', () => {
    // A daemon restarted from such a pane passes both on: the tools installed since, it drops them.
    const m = mac()
    const inherited = { DEVELOPER_DIR: m.places.commandLineTools, HARNESS_DEVELOPER_DIR: '1' }
    expect(m.run('/bin/sh', inherited).stdout).toBe(`DEVELOPER_DIR=${m.places.commandLineTools}\n`)
    mkdirSync(join(m.places.commandLineTools, 'usr', 'bin'), { recursive: true })
    expect(m.run('/bin/sh', inherited).stdout).toBe('DEVELOPER_DIR=unset\n')
  })

  it("gives the person's own shell, after the engine, the developer folder they had", () => {
    const after = engineFallbackPrelude('claude', '/bin/zsh', null)
    const drop = after.indexOf('if [ "${HARNESS_DEVELOPER_DIR:-}" = 1 ]; then unset DEVELOPER_DIR HARNESS_DEVELOPER_DIR; fi')
    expect(drop).toBeGreaterThan(-1)
    expect(drop).toBeLessThan(after.indexOf("exec '/bin/zsh' -l"))
  })

  it('does nothing on a system without xcode-select', () => {
    const m = mac()
    rmSync(m.places.xcodeSelect)
    expect(m.run().stdout).toBe('DEVELOPER_DIR=unset\n')
  })

  it('runs in every agent launch, after the shell has read its startup files', () => {
    const argv = buildEngineLaunchArgv('claude', {}, '/bin/zsh', '/opt/node', 'grid', null)
    // A POSIX shell sources the script from a one-time file.
    const script = argv[argv.indexOf('harness-engine') - 1]
    const file = /^\. '(.*)'$/.exec(script)?.[1]
    expect(file ? readFileSync(file, 'utf8') : script).toContain("DEVELOPER_DIR='/Library/Developer/CommandLineTools'")
  })
})
