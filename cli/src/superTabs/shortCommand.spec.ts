import { describe, expect, it, vi } from 'vitest'
import type { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentCommandPrefix, shellResolve, shellWords, type CliDefaults } from './shortCommand.js'

// No spec here starts a shell, reads the developer's ~/.local/bin or touches port 18473: every lookup is a fake.
const NODE = '/home/a/.harness/runtime/node-v22/bin/node', CLI = '/home/a/.harness/cli/cli.js'
const full = `'${NODE}' '--max-semi-space-size=4' '--max-old-space-size=4096' '${CLI}'`
const daemon = { command: full, port: 18473 }
const defaults: CliDefaults = { port: 18473, dataDir: '/data', machineId: () => 'machine-1' }
const launcher = (node = NODE, cli = CLI) => `#!/bin/sh\nexec '${node}' '${cli}' "$@"\n`
const fake = (files: Record<string, string>) => ({ resolve: async () => '/home/a/.local/bin/harness', platform: 'darwin' as const,
  readFile: (path: string) => { if (!(path in files)) throw new Error('ENOENT'); return files[path] }, realpath: (path: string) => path })
const prefix = (over: Partial<typeof daemon> = {}, machine = 'machine-1', deps = fake({ '/home/a/.local/bin/harness': launcher() }), dir = '/data') =>
  agentCommandPrefix({ ...daemon, ...over }, dir, machine, defaults, deps)

describe('the super-tab command an agent is told to run (macOS and Linux)', () => {
  it('is `harness` when the launcher on the agent\'s PATH runs this daemon\'s Node and cli.js, with the default port and this machine left out', async () => {
    expect(await prefix()).toBe('harness super-tab')
  })
  it('keeps --port when it is not the default, or the data folder is not the default one, and --machine when it is another machine', async () => {
    expect(await prefix({ port: 18999 })).toBe('harness super-tab --port 18999')
    expect(await prefix({}, 'machine-1', undefined, '/other')).toBe('harness super-tab --port 18473')
    expect(await prefix({}, "mach'ine")).toBe(`harness super-tab --machine 'mach'"'"'ine'`)
  })
  it('is today\'s full command when no `harness` is found, or the answer is not a path, or the lookup fails', async () => {
    const today = `${full} super-tab --port 18473 --machine 'machine-1'`
    expect(await agentCommandPrefix(daemon, '/data', 'machine-1', defaults, { ...fake({}), resolve: async () => null })).toBe(today)
    expect(await agentCommandPrefix(daemon, '/data', 'machine-1', defaults, { ...fake({}), resolve: async () => { throw new Error('no shell') } })).toBe(today)
    expect(await prefix({}, 'machine-1', fake({}))).toBe(today)
  })
  it('is the full command when the launcher runs another CLI, another Node, or is not the installer\'s script', async () => {
    const path = '/home/a/.local/bin/harness'
    const today = `${full} super-tab --port 18473 --machine 'machine-1'`
    for (const text of [launcher(NODE, '/repo/dev/cli.js'), launcher('/usr/bin/node'), `#!/bin/sh\nexec '${NODE}' '${CLI}' "$@"\necho hi\n`,
      `#!/bin/sh\nexec '${NODE}' '${CLI}' --inspect "$@"\n`, `#!/bin/bash\nexec '${NODE}' '${CLI}' "$@"\n`, 'x'.repeat(5000)]) {
      expect(await prefix({}, 'machine-1', fake({ [path]: text }))).toBe(today)
    }
  })
  it('is the full command when the daemon carries a flag other than V8 memory flags, or has no script', async () => {
    const path = '/home/a/.local/bin/harness'
    const loader = { command: `'${NODE}' '--import' 'tsx' '${CLI}'`, port: 18473 }
    expect(await prefix(loader)).toBe(`${loader.command} super-tab --port 18473 --machine 'machine-1'`)
    expect(await prefix({ command: `'${NODE}'` }, 'machine-1', fake({ [path]: launcher() }))).toBe(`'${NODE}' super-tab --port 18473 --machine 'machine-1'`)
    expect(await prefix({ command: '' }, 'machine-1', fake({ [path]: launcher() }))).toBe(' super-tab --port 18473 --machine \'machine-1\'')
  })
  it('is the full command when a path cannot be resolved', async () => {
    const deps = { ...fake({ '/home/a/.local/bin/harness': launcher() }), realpath: () => { throw new Error('ENOENT') } }
    expect(await prefix({}, 'machine-1', deps)).toBe(`${full} super-tab --port 18473 --machine 'machine-1'`)
  })
  it('reads the installer\'s own quoting for a path with an apostrophe', async () => {
    const cli = "/home/o'neil/.harness/cli/cli.js"
    const command = `'${NODE}' '--max-old-space-size=4096' '${cli.replace(/'/g, `'"'"'`)}'`
    const text = launcher(NODE, cli.replace(/'/g, `'\\''`))
    expect(await prefix({ command }, 'machine-1', fake({ '/home/a/.local/bin/harness': text }))).toBe('harness super-tab')
  })
})

describe('the real files', () => {
  it('is the full command with nothing handed in: specs start no shell', async () => {
    expect(await agentCommandPrefix(daemon, '/data', 'machine-1', defaults)).toBe(`${full} super-tab --port 18473 --machine 'machine-1'`)
  })
  it('reads the launcher from disk, and follows a symbolic link to the cli.js it runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'short-command-'))
    try {
      const real = join(dir, 'cli.js'), link = join(dir, 'link.js'), file = join(dir, 'harness')
      writeFileSync(real, ''); symlinkSync(real, link)
      writeFileSync(file, launcher(NODE, link))
      const command = { command: `'${NODE}' '${real}'`, port: 18473 }
      expect(await agentCommandPrefix(command, '/data', 'machine-1', defaults, { platform: 'linux', resolve: async () => file })).toBe('harness super-tab')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('the super-tab command an agent is told to run (Windows)', () => {
  const win = (found: string | null, cliJs = 'C:\\Users\\a\\.harness\\cli\\1.0\\cli.js', current: { cliJs: string } | null = { cliJs }) => ({
    platform: 'win32' as const, resolve: async () => found, realpath: (path: string) => path, windowsCli: (root: string) => root === 'C:\\Users\\a\\.harness' ? current : null })
  const command = { command: `'C:\\node.exe' '--max-old-space-size=4096' 'C:\\Users\\a\\.harness\\cli\\1.0\\cli.js'`, port: 18473 }
  const today = `${command.command} super-tab --port 18473 --machine 'machine-1'`
  const ask = (deps: ReturnType<typeof win>) => agentCommandPrefix(command, '/data', 'machine-1', defaults, deps)
  it('is `harness` when bin\\harness.exe is the one that runs the CLI the daemon runs, with the default port and this machine left out', async () => {
    expect(await ask(win('C:\\Users\\a\\.harness\\bin\\harness.exe'))).toBe('harness super-tab')
  })
  it('keeps the non-default port', async () => {
    expect(await agentCommandPrefix({ ...command, port: 19000 }, '/data', 'machine-1', defaults, win('C:\\Users\\a\\.harness\\bin\\HARNESS.EXE'))).toBe('harness super-tab --port 19000')
  })
  it('is the full command when harness.exe is absent, is another program, or runs a different version', async () => {
    expect(await ask(win(null))).toBe(today)
    expect(await ask(win('C:\\tools\\harness.cmd'))).toBe(today)
    expect(await ask(win('C:\\Users\\a\\.harness\\bin\\harness.exe', undefined, { cliJs: 'C:\\Users\\a\\.harness\\cli\\2.0\\cli.js' }))).toBe(today)
    expect(await ask(win('C:\\Users\\a\\.harness\\bin\\harness.exe', undefined, null))).toBe(today)
    expect(await ask(win('D:\\other\\bin\\harness.exe'))).toBe(today)
  })
  it('asks the real layout reader when none is handed in, and stays full when that install does not exist', async () => {
    const deps = { platform: 'win32' as const, resolve: async () => 'C:\\no\\such\\bin\\harness.exe', realpath: (path: string) => path }
    expect(await ask(deps as ReturnType<typeof win>)).toBe(today)
  })
  it('is the full command when the install cannot be read', async () => {
    expect(await ask({ ...win('C:\\Users\\a\\.harness\\bin\\harness.exe'), realpath: () => { throw new Error('EACCES') } })).toBe(today)
  })
  it('looks `harness` up on PATH when no lookup is handed in', async () => {
    expect(await agentCommandPrefix(command, '/data', 'machine-1', defaults, { platform: 'win32', realpath: p => p })).toBe(today)
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
  it('starts the account\'s shell as a login shell (a stand-in script here, not the developer\'s own)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'short-shell-'))
    try {
      const shell = join(dir, 'zsh')
      writeFileSync(shell, `#!/bin/sh\ncase "$1" in -lic) printf 'banner\\n\\n__HARNESS_LAUNCHER__=/stand/in/harness\\n';; esac\n`)
      chmodSync(shell, 0o755)
      vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('SHELL', shell)
      expect(await shellResolve()).toBe('/stand/in/harness')
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) }
  })
  const run = (stdout: string, error: Error | null = null, throws = false) => ((_file: string, _args: unknown, _options: unknown, done: (e: Error | null, out: string) => void) => {
    if (throws) throw new Error('spawn failed')
    done(error, stdout)
    return { stdin: { end() {} } }
  }) as unknown as typeof execFile
  it('takes the last marked line, so a banner in the startup files does not matter', async () => {
    expect(await shellResolve('/bin/zsh', run('hello\n\n__HARNESS_LAUNCHER__=/home/a/.local/bin/harness\n'))).toBe('/home/a/.local/bin/harness')
  })
  it('is null for an alias or function, a failed shell, an empty answer, a throw, and when specs run (no shell started)', async () => {
    expect(await shellResolve('/bin/bash', run('\n__HARNESS_LAUNCHER__=alias harness=x\n'))).toBeNull()
    expect(await shellResolve('/bin/bash', run('\n__HARNESS_LAUNCHER__=\n'))).toBeNull()
    expect(await shellResolve('/bin/bash', run('', new Error('timeout')))).toBeNull()
    expect(await shellResolve('/bin/bash', run('', null, true))).toBeNull()
    expect(await shellResolve('/bin/bash', run('no marker here\n'))).toBeNull()
    expect(await shellResolve()).toBeNull()
  })
})
