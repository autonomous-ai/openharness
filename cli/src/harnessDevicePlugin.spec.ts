import { spawnSync } from 'child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeCodeGitBash } from './lib/windows/claudeCodeGitBash.js'

// The harness-device plugin is files Claude Code reads and a hook it runs as a child process. These checks hold the
// files to what the marketplace and Claude Code expect, and run the hook as Claude Code does: its stdin, a HOME and a
// PATH, and nothing of the developer's own (a throwaway HOME, fake launchers).
const repo = fileURLToPath(new URL('../..', import.meta.url))
const pluginRoot = join(repo, 'plugins', 'harness-device')
const HOOK = join(pluginRoot, 'hooks', 'asked')
const json = (...path: string[]) => JSON.parse(readFileSync(join(...path), 'utf8'))
const INPUT = JSON.stringify({
  session_id: 's-1',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
})
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
// The sh script's cases: Windows runs the hook through Git Bash or PowerShell, below.
const posix = it.skipIf(process.platform === 'win32')
// The shells Claude Code runs a hook's command in off Windows: the person's $SHELL (bash, zsh or sh).
const SHELLS = ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/dash'].filter((shell) => existsSync(shell))

type Hook = { type: string; command: string; args?: string[]; onFailure?: string; timeout?: number }
const permissionHook = (root = pluginRoot): Hook =>
  (json(root, 'hooks', 'hooks.json') as { hooks: { PermissionRequest: { hooks: Hook[] }[] } }).hooks.PermissionRequest[0].hooks[0]
// What PowerShell runs of the command: what follows the end of the block comment that hides the sh line from it.
const windowsForm = (command: string): string => command.slice(command.indexOf('#>') + 2)

const tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-device-plugin-'))
  tmpDirs.push(dir)
  return dir
}

/** A launcher that records its argv and stdin in `record`, prints `out` and exits with `code`. */
function fakeLauncher(path: string, record: string, out = '', code = 0): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}.argv'\ncat > '${record}.stdin'\nprintf '%s' '${out}'\nexit ${code}\n`)
  chmodSync(path, 0o755)
}

function runHook(home: string, path: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(HOOK, [], { input: INPUT, env: { HOME: home, PATH: path, ...env }, encoding: 'utf8' })
}

describe('the harness-device plugin', () => {
  it('the marketplace lists harness first and harness-device second, with source ./plugins/harness-device', () => {
    const marketplace = json(repo, '.claude-plugin', 'marketplace.json') as { plugins: { name: string; source: string }[] }
    expect(marketplace.plugins.map((plugin) => plugin.name)).toEqual(['harness', 'harness-device'])
    expect(marketplace.plugins[1].source).toBe('./plugins/harness-device')
  })

  it('plugin.json is named harness-device', () => {
    expect(json(pluginRoot, '.claude-plugin', 'plugin.json').name).toBe('harness-device')
  })

  // The dial only shows a waiting prompt: no description may promise an answer from it.
  it('plugin.json and the marketplace say the dial shows a waiting prompt, and promise no answer from it', () => {
    const marketplace = json(repo, '.claude-plugin', 'marketplace.json') as { plugins: { name: string; description: string }[] }
    const descriptions = [json(pluginRoot, '.claude-plugin', 'plugin.json').description as string,
      marketplace.plugins.find((plugin) => plugin.name === 'harness-device')!.description]
    for (const description of descriptions) {
      expect(description).toMatch(/waiting/i)
      expect(description).not.toMatch(/allow|deny|approv|answers/i)
    }
  })

  // Claude Code on Windows with no Git Bash runs the command in PowerShell, and there counts a hook that fails or times
  // out as a deny unless its onFailure is "continue", which is the default everywhere else.
  it('hooks.json holds one PermissionRequest command hook for every tool, with a 5 s timeout, whose failure never blocks the tool call', () => {
    const { hooks } = json(pluginRoot, 'hooks', 'hooks.json') as { hooks: Record<string, { matcher: string; hooks: Hook[] }[]> }
    expect(Object.keys(hooks)).toEqual(['PermissionRequest'])
    expect(hooks.PermissionRequest.map((block) => block.matcher)).toEqual(['*'])
    expect(hooks.PermissionRequest[0].hooks).toEqual([{ type: 'command', command: expect.any(String), onFailure: 'continue', timeout: 5 }])
  })

  // Claude Code puts the plugin's folder in place of ${CLAUDE_PLUGIN_ROOT} and runs the command through a shell.
  posix.each(SHELLS)('the hook command runs hooks/asked under %s, from a plugin folder with a space in its name', (shell) => {
    const root = join(tempDir(), 'Harness Device')
    cpSync(pluginRoot, root, { recursive: true })
    const home = tempDir()
    const record = join(home, 'rec')
    fakeLauncher(join(home, '.local', 'bin', 'harness'), record, ALLOW, 2)
    const command = permissionHook(root).command.replaceAll('${CLAUDE_PLUGIN_ROOT}', root)
    const result = spawnSync(shell, ['-c', command], { input: INPUT, env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
    expect(readFileSync(`${record}.argv`, 'utf8')).toBe('device\nclaude\nasked\n')
    expect(readFileSync(`${record}.stdin`, 'utf8')).toBe(INPUT)
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
  })

  // Under PowerShell nothing the launcher prints may reach Claude Code, and the hook's exit is 0, whatever the launcher's.
  // A name Windows PowerShell's command lookup does not find sends it through every module on PSModulePath: 30 s on the
  // arm64 runner, past the hook's 5 s. So module loading is off before anything runs, and the launcher is found by file
  // checks alone; with loading off, a cmdlet outside the core (Test-Path among them) would not be found at all.
  it('the Windows form turns module loading off, then looks for the launcher in the profile, then each absolute PATH folder', () => {
    const windows = windowsForm(permissionHook().command)
    expect(windows.trimStart().startsWith("> $null; $PSModuleAutoLoadingPreference = 'None';")).toBe(true)
    expect(windows).not.toMatch(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/)
    const profile = windows.indexOf('$env:USERPROFILE\\.harness\\bin\\harness.exe')
    const onPath = windows.indexOf("foreach ($d in $env:PATH -split ';') { if ($d -match '^([a-z]:\\\\|\\\\\\\\)' -and [IO.File]::Exists(\"$d\\harness.exe\"))")
    expect(profile).toBeGreaterThan(-1)
    expect(onPath).toBeGreaterThan(profile)
    const calls = windows.match(/device claude asked[^;}]*/g)
    expect(calls).toHaveLength(1)
    expect(calls![0].trim()).toBe('device claude asked *> $null')
    expect(windows.trimEnd().endsWith('; exit 0')).toBe(true)
  })

  it('hooks.json loads the voice mod, hooks/device.js', () => {
    expect(json(pluginRoot, 'hooks', 'hooks.json').modules).toEqual(['./device.js'])
  })

  posix('hooks/asked is executable and starts with #!/bin/sh', () => {
    expect(statSync(HOOK).mode & 0o111).toBe(0o111)
    expect(readFileSync(HOOK, 'utf8').startsWith('#!/bin/sh\n')).toBe(true)
  })

  posix('with no launcher it exits 0 with no output', () => {
    const result = runHook(tempDir(), '/usr/bin:/bin')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  posix('it runs ~/.local/bin/harness first, with device claude asked and the stdin it was given', () => {
    const home = tempDir()
    const bin = tempDir()
    const local = join(home, 'rec-local')
    const onPath = join(home, 'rec-path')
    fakeLauncher(join(home, '.local', 'bin', 'harness'), local)
    fakeLauncher(join(bin, 'harness'), onPath)
    const result = runHook(home, `${bin}:/usr/bin:/bin`)
    expect(readFileSync(`${local}.argv`, 'utf8')).toBe('device\nclaude\nasked\n')
    expect(readFileSync(`${local}.stdin`, 'utf8')).toBe(INPUT)
    expect(existsSync(`${onPath}.argv`)).toBe(false)
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
  })

  // What a PermissionRequest hook prints is Claude Code's decision, and its exit code 2 a deny: a launcher of any version,
  // or anything in its place, must never decide the prompt.
  posix('a launcher that prints a decision and fails: the hook prints nothing and exits 0', () => {
    const home = tempDir()
    for (const code of [0, 2, 3]) {
      fakeLauncher(join(home, '.local', 'bin', 'harness'), join(home, 'rec'), ALLOW, code)
      expect(runHook(home, '/usr/bin:/bin'), `exit ${code}`).toMatchObject({ status: 0, stdout: '', stderr: '' })
    }
  })

  posix('with none in ~/.local/bin it runs the one on PATH', () => {
    const home = tempDir()
    const bin = tempDir()
    const onPath = join(home, 'rec-path')
    // A file there that is not executable is no launcher.
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    writeFileSync(join(home, '.local', 'bin', 'harness'), '#!/bin/sh\nexit 9\n')
    fakeLauncher(join(bin, 'harness'), onPath)
    const result = runHook(home, `${bin}:/usr/bin:/bin`)
    expect(result.status).toBe(0)
    expect(readFileSync(`${onPath}.argv`, 'utf8')).toBe('device\nclaude\nasked\n')
    expect(readFileSync(`${onPath}.stdin`, 'utf8')).toBe(INPUT)
  })

  // Git Bash on Windows runs this script: there the launcher is %USERPROFILE%\.harness\bin\harness.exe.
  posix('it runs the launcher in the profile, $USERPROFILE/.harness/bin/harness.exe, before the one on PATH', () => {
    const profile = tempDir()
    const bin = tempDir()
    const inProfile = join(profile, 'rec-profile')
    const onPath = join(profile, 'rec-path')
    fakeLauncher(join(profile, '.harness', 'bin', 'harness.exe'), inProfile, ALLOW, 2)
    fakeLauncher(join(bin, 'harness'), onPath)
    const result = runHook(tempDir(), `${bin}:/usr/bin:/bin`, { USERPROFILE: profile })
    expect(readFileSync(`${inProfile}.argv`, 'utf8')).toBe('device\nclaude\nasked\n')
    expect(readFileSync(`${inProfile}.stdin`, 'utf8')).toBe(INPUT)
    expect(existsSync(`${onPath}.argv`)).toBe(false)
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
  })

  it('the README names harness device claude disable, and says the dial never answers a prompt or approves anything', () => {
    const readme = readFileSync(join(pluginRoot, 'README.md'), 'utf8')
    expect(readme).toContain('harness device claude disable')
    expect(readme).toMatch(/never answers a prompt/i)
    expect(readme).toMatch(/approves nothing/i)
    expect(readme).not.toMatch(/Allow or Deny|allow or deny/)
  })
})

// Claude Code on Windows runs the command in Git Bash when it finds one, else in Windows PowerShell, as the VM showed
// (docs/plans/2026-11-19-dial-windows-vm-notes.md, Task 2): PowerShell gets ${env:CLAUDE_PLUGIN_ROOT} (backslashes) in
// place of ${CLAUDE_PLUGIN_ROOT} and a second line of Claude Code's own; Git Bash gets the command as written, with the
// root in forward slashes.
describe.runIf(process.platform === 'win32')('the harness-device hook on Windows', () => {
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  const powershell = join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const gitBash = claudeCodeGitBash()
  const SUFFIX = '\n; if (-not $?) { if ($LASTEXITCODE -eq 2) { exit 2 } }'
  // The prompt's text holds what a shell or an encoding would change: it must reach the launcher byte for byte.
  const input = JSON.stringify({ ...JSON.parse(INPUT), tool_input: { command: 'echo "héllo" & dir %TEMP% | more' } })
  const runners = [
    {
      name: 'PowerShell',
      root: pluginRoot,
      run: (command: string, options: object) => spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', command.replaceAll('${CLAUDE_PLUGIN_ROOT}', '${env:CLAUDE_PLUGIN_ROOT}') + SUFFIX], options),
    },
    ...(gitBash ? [{
      name: 'Git Bash',
      root: pluginRoot.replaceAll('\\', '/'),
      run: (command: string, options: object) => spawnSync(gitBash, ['-c', command], options),
    }] : []),
  ]

  /** A profile, a working folder, and this process's environment with only the system folders on PATH. */
  function place() {
    const profile = tempDir()
    const cwd = tempDir()
    const own = Object.entries(process.env)
      .filter(([key]) => !['path', 'home', 'userprofile', 'claude_plugin_root'].includes(key.toLowerCase()))
    return { profile, cwd, env: { ...Object.fromEntries(own), USERPROFILE: profile, PATH: `${system};${join(system, 'WindowsPowerShell', 'v1.0')}` } }
  }

  /** node.exe as <profile>\.harness\bin\harness.exe: it reads `device` as ./device.js, which records its arguments and stdin. */
  function standIn(profile: string, cwd: string, code: number): void {
    mkdirSync(join(profile, '.harness', 'bin'), { recursive: true })
    copyFileSync(process.execPath, join(profile, '.harness', 'bin', 'harness.exe'))
    writeFileSync(join(cwd, 'device.js'), [
      "const fs = require('fs')",
      `fs.writeFileSync(${JSON.stringify(join(cwd, 'argv.json'))}, JSON.stringify(process.argv.slice(2)))`,
      `fs.writeFileSync(${JSON.stringify(join(cwd, 'stdin'))}, fs.readFileSync(0))`,
      `process.stdout.write(${JSON.stringify(ALLOW)})`,
      `process.stderr.write(${JSON.stringify(ALLOW)})`,
      `process.exitCode = ${code}`,
    ].join('\n'))
  }

  for (const runner of runners) {
    it(`${runner.name}: runs the profile's launcher with device claude asked and its stdin, prints nothing and exits 0`, () => {
      for (const code of [0, 2]) {
        const { profile, cwd, env } = place()
        standIn(profile, cwd, code)
        const result = runner.run(permissionHook().command, { cwd, input, encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_ROOT: runner.root } })
        expect(JSON.parse(readFileSync(join(cwd, 'argv.json'), 'utf8')), `exit ${code}`).toEqual(['claude', 'asked'])
        expect(readFileSync(join(cwd, 'stdin'), 'utf8'), `exit ${code}`).toBe(input)
        expect(result, `exit ${code}`).toMatchObject({ status: 0, stdout: '', stderr: '' })
      }
    }, 60_000)

    it(`${runner.name}: with no launcher, prints nothing and exits 0`, () => {
      const { cwd, env } = place()
      const result = runner.run(permissionHook().command, { cwd, input, encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_ROOT: runner.root } })
      expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
    }, 30_000)
  }
})
