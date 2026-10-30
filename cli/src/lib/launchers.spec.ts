import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isOwnHarnessLauncher, isOwnHnLauncher, ownedBinEntries } from './launchers.js'

const cli = '/Users/u/.harness/cli/cli.js'

describe('isOwnHarnessLauncher', () => {
  it('knows the three shapes that shipped', () => {
    expect(isOwnHarnessLauncher(`#!/bin/sh\nexec '/n/node' '${cli}' "$@"\n`, cli)).toBe(true)
    expect(isOwnHarnessLauncher(`#!/bin/sh\nexec "/n/node" "${cli}" "$@"\n`, cli)).toBe(true)
    expect(isOwnHarnessLauncher(`#!/bin/sh\n# pinned\nADAPTER_UPDATE_DISABLE=true; export ADAPTER_UPDATE_DISABLE\nexec "/n/node" "${cli}" "$@"\n`, cli)).toBe(true)
  })

  it('is not somebody else\'s harness', () => {
    expect(isOwnHarnessLauncher('#!/bin/sh\nexec /opt/other/harness "$@"\n', cli)).toBe(false)
    expect(isOwnHarnessLauncher('#!/bin/sh\necho hi\n', cli)).toBe(false)
  })

  it('refuses look-alikes: another cli.js, a longer path, lines after the exec, extra work before it', () => {
    expect(isOwnHarnessLauncher(`#!/bin/sh\nexec '/n/node' '/elsewhere/cli.js' "$@"\n`, cli)).toBe(false)
    expect(isOwnHarnessLauncher(`#!/bin/sh\nexec '/n/node' '/x${cli}' "$@"\n`, cli)).toBe(false)
    expect(isOwnHarnessLauncher(`#!/bin/sh\nexec '/n/node' '${cli}.old' "$@"\n`, cli)).toBe(false)
    expect(isOwnHarnessLauncher(`#!/bin/sh\nexec '/n/node' '${cli}' "$@"\necho done\n`, cli)).toBe(false)
    expect(isOwnHarnessLauncher(`#!/bin/sh\nrm -rf "$HOME/x"\nexec '/n/node' '${cli}' "$@"\n`, cli)).toBe(false)
    expect(isOwnHarnessLauncher(`#!/bin/sh\n# note ${cli}\nexec /opt/other "$@"\n`, cli)).toBe(false)
    expect(isOwnHarnessLauncher(`#!/bin/sh\nexec '/n/node' '${cli}' --flag "$@"\n`, cli)).toBe(false)
  })
})

describe('isOwnHnLauncher', () => {
  it('is only the exact delegation the installer writes', () => {
    expect(isOwnHnLauncher(`#!/bin/sh\nexec '/u/.local/bin/harness' tui "$@"\n`, '/u/.local/bin/harness')).toBe(true)
    expect(isOwnHnLauncher(`#!/bin/sh\nexec '/u/.local/bin/harness' tui "$@"\necho\n`, '/u/.local/bin/harness')).toBe(false)
  })
})

describe('ownedBinEntries', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('lists harness, hn and the managed tmux link, and nothing else in the folder', () => {
    const home = mkdtempSync(join(tmpdir(), 'owned-bin-'))
    dirs.push(home)
    const bin = join(home, '.local', 'bin')
    const root = join(home, '.harness')
    const cliJs = join(root, 'cli', 'cli.js')
    mkdirSync(bin, { recursive: true })
    mkdirSync(join(root, 'runtime', 'tmux-3.7c', 'bin'), { recursive: true })
    writeFileSync(join(bin, 'harness'), `#!/bin/sh\nexec '/n/node' '${cliJs}' "$@"\n`)
    writeFileSync(join(bin, 'hn'), `#!/bin/sh\nexec '${join(bin, 'harness')}' tui "$@"\n`)
    symlinkSync(join(root, 'runtime', 'tmux-3.7c', 'bin', 'tmux'), join(bin, 'tmux'))
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n')
    expect(ownedBinEntries(bin, cliJs, root)).toEqual([join(bin, 'harness'), join(bin, 'hn'), join(bin, 'tmux')])
  })

  it('leaves a tmux link to another tmux, and a harness that runs another bundle', () => {
    const home = mkdtempSync(join(tmpdir(), 'owned-bin-'))
    dirs.push(home)
    const bin = join(home, '.local', 'bin')
    mkdirSync(bin, { recursive: true })
    symlinkSync('/opt/homebrew/bin/tmux', join(bin, 'tmux'))
    writeFileSync(join(bin, 'harness'), `#!/bin/sh\nexec '/n/node' '/elsewhere/cli.js' "$@"\n`)
    expect(ownedBinEntries(bin, join(home, '.harness', 'cli', 'cli.js'), join(home, '.harness'))).toEqual([])
  })

  it('leaves a user wrapper that runs node on another cli.js, or has lines after the exec', () => {
    const home = mkdtempSync(join(tmpdir(), 'owned-bin-'))
    dirs.push(home)
    const bin = join(home, '.local', 'bin')
    const cliJs = join(home, '.harness', 'cli', 'cli.js')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'harness'), `#!/bin/sh\nexec node '/work/mine/cli.js' "$@"\n`)
    writeFileSync(join(bin, 'hn'), `#!/bin/sh\nexec '${join(bin, 'harness')}' tui "$@"\necho bye\n`)
    expect(ownedBinEntries(bin, cliJs, join(home, '.harness'))).toEqual([])
    writeFileSync(join(bin, 'harness'), `#!/bin/sh\nexec '/n/node' '${cliJs}' "$@"\necho after\n`)
    expect(ownedBinEntries(bin, cliJs, join(home, '.harness'))).toEqual([])
  })

  it('leaves a tmux link outside the runtime, a relative one escaping with .., and a dangling one outside it', () => {
    const home = mkdtempSync(join(tmpdir(), 'owned-bin-'))
    dirs.push(home)
    const bin = join(home, '.local', 'bin')
    const root = join(home, '.harness')
    mkdirSync(bin, { recursive: true })
    mkdirSync(join(root, 'runtime'), { recursive: true })
    const tmux = join(bin, 'tmux')
    symlinkSync(join(home, 'mine', 'tmux'), tmux)
    expect(ownedBinEntries(bin, join(root, 'cli', 'cli.js'), root)).toEqual([])
    unlinkSync(tmux)
    symlinkSync('../../.harness/runtime/../../mine/tmux', tmux)
    expect(ownedBinEntries(bin, join(root, 'cli', 'cli.js'), root)).toEqual([])
    unlinkSync(tmux)
    symlinkSync('../../.harness/runtime/tmux-3.7c/../../../elsewhere', tmux)
    expect(ownedBinEntries(bin, join(root, 'cli', 'cli.js'), root)).toEqual([])
    unlinkSync(tmux)
    symlinkSync(join(home, 'gone', 'tmux'), tmux)
    expect(ownedBinEntries(bin, join(root, 'cli', 'cli.js'), root)).toEqual([])
    unlinkSync(tmux)
    // the runtime folder itself is not a tmux the installer linked
    symlinkSync(join(root, 'runtime'), tmux)
    expect(ownedBinEntries(bin, join(root, 'cli', 'cli.js'), root)).toEqual([])
    unlinkSync(tmux)
    symlinkSync(join(root, 'runtime', 'tmux-3.7c', 'bin', 'tmux'), tmux)
    expect(ownedBinEntries(bin, join(root, 'cli', 'cli.js'), root)).toEqual([tmux])
  })

  it('knows the hn that shipped from #365 to #500, and refuses it with other bytes', () => {
    const home = mkdtempSync(join(tmpdir(), 'owned-bin-'))
    dirs.push(home)
    const bin = join(home, '.local', 'bin')
    const cliJs = join(home, '.harness', 'cli', 'cli.js')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'hn'), `#!/bin/sh\nexec '/n/node' '${cliJs}' tui "$@"\n`)
    expect(ownedBinEntries(bin, cliJs, join(home, '.harness'))).toEqual([join(bin, 'hn')])
    writeFileSync(join(bin, 'hn'), `#!/bin/sh\nexec '/n/node' '/mine/cli.js' tui "$@"\n`)
    expect(ownedBinEntries(bin, cliJs, join(home, '.harness'))).toEqual([])
    writeFileSync(join(bin, 'hn'), `#!/bin/sh\nexec '/n/node' '${cliJs}' tui "$@"\necho x\n`)
    expect(ownedBinEntries(bin, cliJs, join(home, '.harness'))).toEqual([])
  })

  it('leaves a symlinked harness or hn alone', () => {
    const home = mkdtempSync(join(tmpdir(), 'owned-bin-'))
    dirs.push(home)
    const bin = join(home, '.local', 'bin')
    const cliJs = join(home, '.harness', 'cli', 'cli.js')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(home, 'real'), `#!/bin/sh\nexec '/n/node' '${cliJs}' "$@"\n`)
    symlinkSync(join(home, 'real'), join(bin, 'harness'))
    symlinkSync(join(home, 'real'), join(bin, 'hn'))
    expect(ownedBinEntries(bin, cliJs, join(home, '.harness'))).toEqual([])
  })
})

describe('isOwnHarnessLauncher shapes', () => {
  it('takes bare node, and paths with spaces or quotes in either style', () => {
    expect(isOwnHarnessLauncher(`#!/bin/sh\nexec node "${cli}" "$@"\n`, cli)).toBe(true)
    const odd = "/Users/o'b rien/.harness/cli/cli.js"
    expect(isOwnHarnessLauncher(`#!/bin/sh\nexec '/a b/node' '/Users/o'\\''b rien/.harness/cli/cli.js' "$@"\n`, odd)).toBe(true)
    expect(isOwnHarnessLauncher(`#!/bin/sh\nexec "/a b/n'ode" "${odd}" "$@"\n`, odd)).toBe(true)
    const spaced = '/Users/a b/.harness/cli/cli.js'
    expect(isOwnHarnessLauncher(`#!/bin/sh\nexec "/a b/node" "${spaced}" "$@"\n`, spaced)).toBe(true)
    expect(isOwnHarnessLauncher(`#!/bin/sh\nexec '/a b/node' '${spaced}' "$@"\n`, spaced)).toBe(true)
  })

  it('refuses an expanding node word and CRLF files', () => {
    expect(isOwnHarnessLauncher(`#!/bin/sh\nexec "$(cmd)" "${cli}" "$@"\n`, cli)).toBe(false)
    expect(isOwnHarnessLauncher('#!/bin/sh\nexec "`cmd`" "' + cli + '" "$@"\n', cli)).toBe(false)
    expect(isOwnHarnessLauncher(`#!/bin/sh\nexec "\\x" "${cli}" "$@"\n`, cli)).toBe(false)
    expect(isOwnHarnessLauncher(`#!/bin/sh\r\nexec '/n/node' '${cli}' "$@"\r\n`, cli)).toBe(false)
  })
})
