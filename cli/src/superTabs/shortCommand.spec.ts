import { describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentCommandPrefix, fullCommandPrefix, shellResolve, shellWords, windowsResolve, type ShortCommandDeps } from './shortCommand.js'

// No spec here starts a shell, reads the developer's ~/.local/bin or touches port 18473: every lookup is a fake.
const NODE = '/home/a/.harness/runtime/node-v22/bin/node', CLI = '/home/a/.harness/cli/cli.js'
const full = `'${NODE}' '--max-semi-space-size=4' '--max-old-space-size=4096' '${CLI}'`
const daemon = { command: full, port: 18473 }
const today = `${full} super-tab --port 18473 --machine 'machine-1'`
const defaultMachine = () => 'machine-1'
const launcher = (node = NODE, cli = CLI) => `#!/bin/sh\nexec '${node}' '${cli}' "$@"\n`
const PATH = '/home/a/.local/bin/harness'
const fake = (files: Record<string, string>, env: NodeJS.ProcessEnv = {}): ShortCommandDeps => ({ resolve: async () => PATH, platform: 'darwin', env,
  readFile: path => { if (!(path in files)) throw new Error('ENOENT'); return files[path] }, realpath: path => path })
const prefix = (over: Partial<typeof daemon> = {}, machine = 'machine-1', deps = fake({ [PATH]: launcher() })) =>
  agentCommandPrefix({ ...daemon, ...over }, machine, defaultMachine, deps)

describe('the super-tab command an agent is told to run (macOS and Linux)', () => {
  it('is `harness` when the launcher on the agent\'s PATH runs this daemon\'s Node and cli.js, with the default port and this machine left out', async () => {
    expect(await prefix()).toBe('harness super-tab')
  })
  it('keeps --port when it is not the default, and --machine when it is not the one the CLI picks', async () => {
    expect(await prefix({ port: 18999 })).toBe(`harness super-tab --port 18999 --machine 'machine-1'`)
    expect(await prefix({}, "mach'ine")).toBe(`harness super-tab --machine 'mach'"'"'ine'`)
  })
  it.each(['PORT', 'ADAPTER_DATA_DIR', 'ADAPTER_CLI_DIR', 'HARNESS_AUTH_DIR', 'HARNESS_ENV_FILE', 'ADAPTER_COMPUTER_ID', 'ADAPTER_COMPUTER_ID_FILE'])(
    'keeps both flags when the daemon has its own %s, which the agent\'s shell does not have', async name => {
      // An isolated daemon on the default port with the default machine id would otherwise send the agent to the wrong daemon.
      expect(await prefix({}, 'machine-1', fake({ [PATH]: launcher() }, { [name]: '/isolated' }))).toBe(`harness super-tab --port 18473 --machine 'machine-1'`)
    })
  it('is today\'s full command when no `harness` is found, or the lookup fails', async () => {
    expect(await prefix({}, 'machine-1', { ...fake({}), resolve: async () => null })).toBe(today)
    expect(await prefix({}, 'machine-1', { ...fake({}), resolve: async () => { throw new Error('no shell') } })).toBe(today)
    expect(await prefix({}, 'machine-1', fake({}))).toBe(today)
  })
  it('is the full command when the launcher runs another CLI, another Node, or is not the installer\'s script', async () => {
    for (const text of [launcher(NODE, '/repo/dev/cli.js'), launcher('/usr/bin/node'), `#!/bin/sh\nexec '${NODE}' '${CLI}' "$@"\necho hi\n`,
      `#!/bin/sh\nexec '${NODE}' '${CLI}' --inspect "$@"\n`, `#!/bin/bash\nexec '${NODE}' '${CLI}' "$@"\n`, 'x'.repeat(5000)]) {
      expect(await prefix({}, 'machine-1', fake({ [PATH]: text }))).toBe(today)
    }
  })
  it('is the full command when the daemon carries a flag other than V8 memory flags, or has no script', async () => {
    const loader = { command: `'${NODE}' '--import' 'tsx' '${CLI}'`, port: 18473 }
    expect(await prefix(loader)).toBe(`${loader.command} super-tab --port 18473 --machine 'machine-1'`)
    expect(await prefix({ command: `'${NODE}'` })).toBe(`'${NODE}' super-tab --port 18473 --machine 'machine-1'`)
    expect(await prefix({ command: '' })).toBe(' super-tab --port 18473 --machine \'machine-1\'')
  })
  it('is the full command when a path cannot be resolved', async () => {
    expect(await prefix({}, 'machine-1', { ...fake({ [PATH]: launcher() }), realpath: () => { throw new Error('ENOENT') } })).toBe(today)
  })
  it('reads the installer\'s own quoting for a path with an apostrophe, and the double quotes the installed launcher uses', async () => {
    const cli = "/home/o'neil/.harness/cli/cli.js"
    const command = `'${NODE}' '--max-old-space-size=4096' '${cli.replace(/'/g, `'"'"'`)}'`
    expect(await prefix({ command }, 'machine-1', fake({ [PATH]: launcher(NODE, cli.replace(/'/g, `'\\''`)) }))).toBe('harness super-tab')
    expect(await prefix({}, 'machine-1', fake({ [PATH]: `#!/bin/sh\nexec "${NODE}" "${CLI}" "$@"\n` }))).toBe('harness super-tab')
  })
  it('names the full command the same way the host falls back to it', () => {
    expect(fullCommandPrefix(daemon, 'machine-1')).toBe(today)
  })
})

describe('the real files', () => {
  it('is the full command with nothing handed in: specs start no shell', async () => {
    expect(await agentCommandPrefix(daemon, 'machine-1', defaultMachine)).toBe(today)
  })
  it('reads the launcher from disk, and follows a symbolic link to the cli.js it runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'short-command-'))
    try {
      const real = join(dir, 'cli.js'), link = join(dir, 'link.js'), file = join(dir, 'harness')
      writeFileSync(real, ''); symlinkSync(real, link)
      writeFileSync(file, launcher(NODE, link))
      const command = { command: `'${NODE}' '${real}'`, port: 18473 }
      expect(await agentCommandPrefix(command, 'machine-1', defaultMachine, { platform: 'linux', env: {}, resolve: async () => file })).toBe('harness super-tab')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('the super-tab command an agent is told to run (Windows)', () => {
  const EXE = 'C:\\Users\\a\\.harness\\bin\\harness.exe'
  const win = (found: string | null, current: { cliJs: string } | null = { cliJs: 'C:\\Users\\a\\.harness\\cli\\1.0\\cli.js' }): ShortCommandDeps => ({
    platform: 'win32', env: {}, resolve: async () => found, realpath: path => path, windowsCli: root => root === 'C:\\Users\\a\\.harness' ? current : null })
  const command = { command: `'C:\\node.exe' '--max-old-space-size=4096' 'C:\\Users\\a\\.harness\\cli\\1.0\\cli.js'`, port: 18473 }
  const windowsToday = fullCommandPrefix(command, 'machine-1')
  const ask = (deps: ShortCommandDeps, over = {}) => agentCommandPrefix({ ...command, ...over }, 'machine-1', defaultMachine, deps)
  it('is `harness` when bin\\harness.exe is the one that runs the CLI the daemon runs, with the default port and this machine left out', async () => {
    expect(await ask(win(EXE))).toBe('harness super-tab')
  })
  it('keeps the non-default port, and matches the folder names without regard to case', async () => {
    expect(await ask(win('C:\\Users\\a\\.harness\\bin\\HARNESS.EXE'), { port: 19000 })).toBe(`harness super-tab --port 19000 --machine 'machine-1'`)
  })
  it('is the full command when harness.exe is absent, is another program, or runs a different version', async () => {
    expect(await ask(win(null))).toBe(windowsToday)
    expect(await ask(win('C:\\tools\\harness.cmd'))).toBe(windowsToday)
    expect(await ask(win(EXE, { cliJs: 'C:\\Users\\a\\.harness\\cli\\2.0\\cli.js' }))).toBe(windowsToday)
    expect(await ask(win(EXE, null))).toBe(windowsToday)
    expect(await ask(win('D:\\other\\bin\\harness.exe'))).toBe(windowsToday)
  })
  it('is the full command when the install cannot be read', async () => {
    expect(await ask({ ...win(EXE), realpath: () => { throw new Error('EACCES') } })).toBe(windowsToday)
  })
  it('asks the real layout reader when none is handed in, and stays full when that install does not exist', async () => {
    const { windowsCli, ...deps } = win('C:\\no\\such\\bin\\harness.exe')
    expect(windowsCli).toBeTypeOf('function')
    expect(await ask(deps)).toBe(windowsToday)
  })
  it('looks `harness` up on PATH when no lookup is handed in', async () => {
    expect(await ask({ platform: 'win32', env: { PATH: 'C:\\no\\such' }, exists: () => false, realpath: p => p })).toBe(windowsToday)
  })
})

describe('windowsResolve', () => {
  const exists = (...files: string[]) => (path: string) => files.includes(path)
  it('is harness.exe in the first PATH folder that has any form of harness', () => {
    expect(windowsResolve({ PATH: 'C:\\a;C:\\b' }, exists('C:\\a\\harness.exe', 'C:\\b\\harness.ps1'))).toBe('C:\\a\\harness.exe')
    expect(windowsResolve({ Path: 'C:\\a;;C:\\b' }, exists('C:\\b\\harness.exe'))).toBe('C:\\b\\harness.exe')
  })
  it.each(['harness.ps1', 'harness.cmd', 'harness.bat'])('is null when an earlier folder has only %s, which would run instead of the exe', name => {
    expect(windowsResolve({ PATH: `C:\\a;C:\\b` }, exists(`C:\\a\\${name}`, 'C:\\b\\harness.exe'))).toBeNull()
  })
  it('is null when nothing is found, or there is no PATH', () => {
    expect(windowsResolve({ PATH: 'C:\\a' }, exists())).toBeNull()
    expect(windowsResolve({}, exists())).toBeNull()
    expect(windowsResolve({ PATH: 'C:\\no\\such\\folder' })).toBeNull()
  })
})

describe('shellWords', () => {
  it('splits a POSIX line the way the installers quote it', () => {
    expect(shellWords(`exec  'a b' "c d" e\\ f 'it'\\''s' ""`)).toEqual(['exec', 'a b', 'c d', 'e f', "it's", ''])
    expect(shellWords('x\\')).toEqual(['x\\'])
    expect(shellWords(`a'b'"c" \\d`)).toEqual(['abc', 'd'])
  })
})

describe('the lookup in the agent\'s shell', () => {
  // Stand-in shells in a temp folder: the developer's own is never started. `-lic` is the interactive login ask, `-lc` the plain one.
  const standIn = async (interactive: string, plain: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'short-shell-'))
    const shell = join(dir, 'zsh')
    writeFileSync(shell, ['#!/bin/sh', 'case "$1" in', `-lic) printf 'banner\\n\\n%s\\n' '${interactive}';;`, `-lc) printf '%s\\n' '${plain}';;`, 'esac', ''].join('\n'))
    chmodSync(shell, 0o755)
    try { return await shellResolve(shell) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  it('is the file both the interactive login shell and the plain login shell find', async () => {
    expect(await standIn('/stand/in/harness', '/stand/in/harness')).toBe('/stand/in/harness')
  })
  it('is null when they disagree, when the plain one finds nothing, or the interactive one does', async () => {
    expect(await standIn('/usr/local/bin/harness', '/stand/in/harness')).toBeNull()
    expect(await standIn('/stand/in/harness', '')).toBeNull()
    expect(await standIn('alias harness=x', '/stand/in/harness')).toBeNull()
  })
  it('is null when specs run: no shell is started', async () => {
    expect(await shellResolve()).toBeNull()
  })
  it('takes the account\'s shell when none is handed in outside the specs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'short-shell-'))
    try {
      const shell = join(dir, 'zsh')
      writeFileSync(shell, `#!/bin/sh\nprintf '/stand/in/harness\\n'\n`)
      chmodSync(shell, 0o755)
      vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('SHELL', shell)
      expect(await shellResolve()).toBe('/stand/in/harness')
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) }
  })
})
