import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'child_process'
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
// Codex's PermissionRequest input, as Codex 0.172.0 writes it.
const CODEX_INPUT = JSON.stringify({
  session_id: 's-1',
  turn_id: 't-1',
  transcript_path: '/home/person/.codex/sessions/2026/11/26/rollout-s-1.jsonl',
  cwd: '/home/person/work',
  hook_event_name: 'PermissionRequest',
  model: 'gpt-5.5',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
})
type HookBlock = { matcher: string; hooks: Hook[] }
const codexHooks = (root = pluginRoot) => (json(root, 'hooks', 'codex.json') as { hooks: Record<string, HookBlock[]> }).hooks
const codexHook = (root = pluginRoot): Hook => codexHooks(root).PermissionRequest[0].hooks[0]
// What PowerShell runs of the command: what follows the end of the block comment that hides the sh line from it.
const windowsForm = (command: string): string => command.slice(command.indexOf('#>') + 2)
const START = join(pluginRoot, 'hooks', 'start')
const startHook = (root = pluginRoot): Hook =>
  (json(root, 'hooks', 'hooks.json') as { hooks: Record<string, HookBlock[]> }).hooks.SessionStart[0].hooks[0]
// Claude Code's SessionStart input.
const START_INPUT = JSON.stringify({
  session_id: 's-1',
  transcript_path: '/home/person/.claude/projects/-home-person-work/s-1.jsonl',
  cwd: '/home/person/work',
  hook_event_name: 'SessionStart',
  source: 'startup',
})
// A stand-in for what `harness device claude start` prints: the hook passes on only a line with this prefix.
const SESSION_LINE = '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The person has a Harness dial."}}'
const SESSION_PREFIX = '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":'
const STOP = join(pluginRoot, 'hooks', 'stop')
const stopHook = (root = pluginRoot): Hook =>
  (json(root, 'hooks', 'hooks.json') as { hooks: Record<string, HookBlock[]> }).hooks.Stop[0].hooks[0]
// Claude Code's Stop input.
const STOP_INPUT = JSON.stringify({
  session_id: 's-1',
  transcript_path: '/home/person/.claude/projects/-home-person-work/s-1.jsonl',
  cwd: '/home/person/work',
  hook_event_name: 'Stop',
  stop_hook_active: false,
  last_assistant_message: 'Should I push the branch?',
})
// A stand-in for what `harness device claude stop` prints: Claude Code reads a Stop hook's stdout as its decision, so
// the hook passes on only a block.
const BLOCK = '{"decision":"block","reason":"r"}'
const BLOCK_PREFIX = '{"decision":"block","reason":'
const CODEX_START = join(pluginRoot, 'hooks', 'codex-start')
const codexStartHook = (root = pluginRoot): Hook => codexHooks(root).SessionStart[0].hooks[0]
// Codex's SessionStart input, as Codex 0.172.0 writes it (the spike of 2026-11-27).
const CODEX_START_INPUT = JSON.stringify({
  session_id: 's-1',
  transcript_path: '/home/person/.codex/sessions/2026/11/27/rollout-s-1.jsonl',
  cwd: '/home/person/work',
  hook_event_name: 'SessionStart',
  model: 'gpt-5.5',
  permission_mode: 'default',
  source: 'startup',
})
const CODEX_STOP = join(pluginRoot, 'hooks', 'codex-stop')
const codexStopHook = (root = pluginRoot): Hook => codexHooks(root).Stop[0].hooks[0]
// Codex's Stop input, as Codex 0.172.0 writes it (the spike of 2026-11-27, F2).
const CODEX_STOP_INPUT = JSON.stringify({
  session_id: 's-1',
  turn_id: 't-1',
  transcript_path: '/home/person/.codex/sessions/2026/11/27/rollout-s-1.jsonl',
  cwd: '/home/person/work',
  hook_event_name: 'Stop',
  model: 'gpt-5.5',
  permission_mode: 'default',
  stop_hook_active: false,
  last_assistant_message: 'Should I push the branch?',
})

const tmpDirs: string[] = []
// Every child has exited when spawnSync returns, but Windows still holds a just-run copy of node.exe for a moment (its
// image mapping, a scanner), and removing the folder then fails with EPERM: rmSync retries that, bounded.
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
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

/** Runs the Codex hook's command as Codex does off Windows: through `shell`, with PLUGIN_ROOT in its environment. */
function runCodexHook(shell: string, root: string, home: string, path = '/usr/bin:/bin') {
  return spawnSync(shell, ['-c', codexHook(root).command], {
    input: CODEX_INPUT, env: { HOME: home, PATH: path, PLUGIN_ROOT: root }, encoding: 'utf8',
  })
}

/** Runs the Codex SessionStart hook's command as Codex does off Windows. */
function runCodexStartHook(shell: string, root: string, home: string, path = '/usr/bin:/bin') {
  return spawnSync(shell, ['-c', codexStartHook(root).command], {
    input: CODEX_START_INPUT, env: { HOME: home, PATH: path, PLUGIN_ROOT: root }, encoding: 'utf8',
  })
}

/** Runs the Codex Stop hook's command as Codex does off Windows. */
function runCodexStopHook(shell: string, root: string, home: string, path = '/usr/bin:/bin') {
  return spawnSync(shell, ['-c', codexStopHook(root).command], {
    input: CODEX_STOP_INPUT, env: { HOME: home, PATH: path, PLUGIN_ROOT: root }, encoding: 'utf8',
  })
}

function runHook(home: string, path: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(HOOK, [], { input: INPUT, env: { HOME: home, PATH: path, ...env }, encoding: 'utf8' })
}

function runStartHook(home: string, path: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(START, [], { input: START_INPUT, env: { HOME: home, PATH: path, ...env }, encoding: 'utf8' })
}

function runStopHook(home: string, path: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(STOP, [], { input: STOP_INPUT, env: { HOME: home, PATH: path, ...env }, encoding: 'utf8' })
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
  it('hooks.json holds the PermissionRequest hook, one SessionStart command hook for startup, resume, clear and compact, and one Stop command hook with no matcher, 5 s, onFailure continue', () => {
    const { hooks } = json(pluginRoot, 'hooks', 'hooks.json') as { hooks: Record<string, HookBlock[]> }
    expect(Object.keys(hooks)).toEqual(['PermissionRequest', 'SessionStart', 'Stop'])
    expect(hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: expect.any(String), onFailure: 'continue', timeout: 5 }] }])
    expect(hooks.Stop[0].hooks[0].command.split('\n')[0]).toBe('echo `# <#` >/dev/null; exec "${CLAUDE_PLUGIN_ROOT}/hooks/stop"')
    expect(hooks.PermissionRequest.map((block) => block.matcher)).toEqual(['*'])
    expect(hooks.PermissionRequest[0].hooks).toEqual([{ type: 'command', command: expect.any(String), onFailure: 'continue', timeout: 5 }])
    expect(hooks.SessionStart.map((block) => block.matcher)).toEqual(['startup|resume|clear|compact'])
    expect(hooks.SessionStart[0].hooks).toEqual([{ type: 'command', command: expect.any(String), onFailure: 'continue', timeout: 5 }])
    expect(hooks.SessionStart[0].hooks[0].command.split('\n')[0]).toBe('echo `# <#` >/dev/null; exec "${CLAUDE_PLUGIN_ROOT}/hooks/start"')
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

  // On Windows the mod tells of the prompt itself and sets HARNESS_DEVICE_MOD_ASKS for the hooks Claude Code starts
  // after (hooks/device.js): the hook then reads its input, so Claude Code's write of a long one never fails, and exits.
  it('the Windows form, with HARNESS_DEVICE_MOD_ASKS set, reads its input and exits 0 before it looks for the launcher', () => {
    const windows = windowsForm(permissionHook().command)
    const told = windows.indexOf('if ($env:HARNESS_DEVICE_MOD_ASKS) { $null = [Console]::In.ReadToEnd(); exit 0 };')
    expect(told).toBeGreaterThan(windows.indexOf("$PSModuleAutoLoadingPreference = 'None';"))
    expect(told).toBeLessThan(windows.indexOf('$env:USERPROFILE\\.harness\\bin\\harness.exe'))
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

  // Git Bash on Windows runs this script too, where the mod tells of the prompt itself and sets HARNESS_DEVICE_MOD_ASKS.
  posix('with HARNESS_DEVICE_MOD_ASKS set it runs no launcher, reads its whole input and exits 0 with no output', () => {
    const profile = tempDir()
    const record = join(profile, 'rec')
    fakeLauncher(join(profile, '.harness', 'bin', 'harness.exe'), record)
    // Past a pipe's buffer: a hook that left it unread would fail Claude Code's write.
    const input = JSON.stringify({ ...JSON.parse(INPUT), tool_name: 'Write', tool_input: { content: 'x'.repeat(1 << 20) } })
    const result = spawnSync(HOOK, [], {
      input, env: { HOME: tempDir(), PATH: '/usr/bin:/bin', USERPROFILE: profile, HARNESS_DEVICE_MOD_ASKS: '1' }, encoding: 'utf8',
    })
    expect(existsSync(`${record}.argv`)).toBe(false)
    expect(result.error).toBeUndefined()
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
  })

  // Claude Code adds what a SessionStart hook prints to the session's context.
  posix.each(SHELLS)("the SessionStart hook runs hooks/start under %s from a folder with a space, and prints the launcher's line", (shell) => {
    const root = join(tempDir(), 'Harness Device')
    cpSync(pluginRoot, root, { recursive: true })
    const home = tempDir()
    const record = join(home, 'rec')
    fakeLauncher(join(home, '.local', 'bin', 'harness'), record, SESSION_LINE)
    const command = startHook(root).command.replaceAll('${CLAUDE_PLUGIN_ROOT}', root)
    const result = spawnSync(shell, ['-c', command], { input: START_INPUT, env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
    expect(readFileSync(`${record}.argv`, 'utf8')).toBe('device\nclaude\nstart\n')
    expect(readFileSync(`${record}.stdin`, 'utf8')).toBe(START_INPUT)
    expect(result).toMatchObject({ status: 0, stdout: `${SESSION_LINE}\n`, stderr: '' })
  })

  // An older or foreign launcher prints its usage, another hook's JSON or nothing, and may fail or write to stderr: none
  // of it may reach the session's context.
  posix('the SessionStart hook prints nothing but the line', () => {
    const home = tempDir()
    const launcher = join(home, '.local', 'bin', 'harness')
    mkdirSync(join(launcher, '..'), { recursive: true })
    for (const out of ['harness v0.6 — connect this computer to your machine', ALLOW, '']) {
      for (const code of [0, 1, 2]) {
        writeFileSync(launcher, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${out}'\necho 'usage: harness device' >&2\nexit ${code}\n`)
        chmodSync(launcher, 0o755)
        expect(runStartHook(home, '/usr/bin:/bin'), `${out} exit ${code}`).toMatchObject({ status: 0, stdout: '', stderr: '' })
      }
    }
  })

  posix('with no launcher the SessionStart hook prints nothing and exits 0', () => {
    expect(runStartHook(tempDir(), '/usr/bin:/bin')).toMatchObject({ status: 0, stdout: '', stderr: '' })
  })

  posix("the SessionStart hook runs ~/.local/bin/harness first, then the profile's harness.exe, then PATH", () => {
    const home = tempDir()
    const profile = tempDir()
    const bin = tempDir()
    const placements = [
      join(home, '.local', 'bin', 'harness'),
      join(profile, '.harness', 'bin', 'harness.exe'),
      join(bin, 'harness'),
    ]
    const record = (i: number) => join(home, `rec-${i}`)
    placements.forEach((launcher, i) => fakeLauncher(launcher, record(i), SESSION_LINE))
    // Each run finds the first placement still there; the next run has it removed.
    for (const [i, launcher] of placements.entries()) {
      const result = runStartHook(home, `${bin}:/usr/bin:/bin`, { USERPROFILE: profile })
      expect(readFileSync(`${record(i)}.argv`, 'utf8'), launcher).toBe('device\nclaude\nstart\n')
      expect(readFileSync(`${record(i)}.stdin`, 'utf8'), launcher).toBe(START_INPUT)
      for (let later = i + 1; later < placements.length; later++) expect(existsSync(`${record(later)}.argv`), launcher).toBe(false)
      expect(result, launcher).toMatchObject({ status: 0, stdout: `${SESSION_LINE}\n`, stderr: '' })
      rmSync(launcher)
    }
  })

  posix('hooks/start is executable and starts with #!/bin/sh', () => {
    expect(statSync(START).mode & 0o111).toBe(0o111)
    expect(readFileSync(START, 'utf8').startsWith('#!/bin/sh\n')).toBe(true)
  })

  it('the SessionStart Windows form turns module loading off, looks in the profile then each absolute PATH folder, runs device claude start once, writes only the SessionStart line, and exits 0', () => {
    const windows = windowsForm(startHook().command)
    expect(windows.trimStart().startsWith("> $null; $PSModuleAutoLoadingPreference = 'None';")).toBe(true)
    expect(windows).not.toMatch(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/)
    expect(windows).not.toContain('HARNESS_DEVICE_MOD_ASKS')
    const profile = windows.indexOf('$env:USERPROFILE\\.harness\\bin\\harness.exe')
    const onPath = windows.indexOf("foreach ($d in $env:PATH -split ';') { if ($d -match '^([a-z]:\\\\|\\\\\\\\)' -and [IO.File]::Exists(\"$d\\harness.exe\"))")
    expect(profile).toBeGreaterThan(-1)
    expect(onPath).toBeGreaterThan(profile)
    const calls = windows.match(/device claude start[^;}]*/g)
    expect(calls).toHaveLength(1)
    expect(calls![0].trim()).toBe('device claude start 2> $null')
    expect(windows).toContain(`if ("$o".StartsWith('${SESSION_PREFIX}')) { [Console]::Out.Write("$o") }`)
    expect(windows.trimEnd().endsWith('; exit 0')).toBe(true)
  })

  // Claude Code reads what a Stop hook prints as its decision: a block keeps the agent's turn going.
  posix.each(SHELLS)("the Stop hook runs hooks/stop under %s from a folder with a space, and prints the launcher's block", (shell) => {
    const root = join(tempDir(), 'Harness Device')
    cpSync(pluginRoot, root, { recursive: true })
    const home = tempDir()
    const record = join(home, 'rec')
    fakeLauncher(join(home, '.local', 'bin', 'harness'), record, BLOCK)
    const command = stopHook(root).command.replaceAll('${CLAUDE_PLUGIN_ROOT}', root)
    const result = spawnSync(shell, ['-c', command], { input: STOP_INPUT, env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
    expect(readFileSync(`${record}.argv`, 'utf8')).toBe('device\nclaude\nstop\n')
    expect(readFileSync(`${record}.stdin`, 'utf8')).toBe(STOP_INPUT)
    expect(result).toMatchObject({ status: 0, stdout: `${BLOCK}\n`, stderr: '' })
  })

  // An older or foreign launcher prints its usage, another hook's JSON or nothing, and may fail or write to stderr: none
  // of it may reach Claude Code as a decision.
  posix('the Stop hook prints nothing but the block', () => {
    const home = tempDir()
    const launcher = join(home, '.local', 'bin', 'harness')
    mkdirSync(join(launcher, '..'), { recursive: true })
    for (const out of ['harness v0.6 — connect this computer to your machine', ALLOW, '']) {
      for (const code of [0, 1, 2]) {
        writeFileSync(launcher, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${out}'\necho 'usage: harness device' >&2\nexit ${code}\n`)
        chmodSync(launcher, 0o755)
        expect(runStopHook(home, '/usr/bin:/bin'), `${out} exit ${code}`).toMatchObject({ status: 0, stdout: '', stderr: '' })
      }
    }
  })

  posix('with no launcher the Stop hook prints nothing and exits 0', () => {
    expect(runStopHook(tempDir(), '/usr/bin:/bin')).toMatchObject({ status: 0, stdout: '', stderr: '' })
  })

  posix("the Stop hook runs ~/.local/bin/harness first, then the profile's harness.exe, then PATH", () => {
    const home = tempDir()
    const profile = tempDir()
    const bin = tempDir()
    const placements = [
      join(home, '.local', 'bin', 'harness'),
      join(profile, '.harness', 'bin', 'harness.exe'),
      join(bin, 'harness'),
    ]
    const record = (i: number) => join(home, `rec-${i}`)
    placements.forEach((launcher, i) => fakeLauncher(launcher, record(i), BLOCK))
    // Each run finds the first placement still there; the next run has it removed.
    for (const [i, launcher] of placements.entries()) {
      const result = runStopHook(home, `${bin}:/usr/bin:/bin`, { USERPROFILE: profile })
      expect(readFileSync(`${record(i)}.argv`, 'utf8'), launcher).toBe('device\nclaude\nstop\n')
      expect(readFileSync(`${record(i)}.stdin`, 'utf8'), launcher).toBe(STOP_INPUT)
      for (let later = i + 1; later < placements.length; later++) expect(existsSync(`${record(later)}.argv`), launcher).toBe(false)
      expect(result, launcher).toMatchObject({ status: 0, stdout: `${BLOCK}\n`, stderr: '' })
      rmSync(launcher)
    }
  })

  posix('hooks/stop is executable and starts with #!/bin/sh', () => {
    expect(statSync(STOP).mode & 0o111).toBe(0o111)
    expect(readFileSync(STOP, 'utf8').startsWith('#!/bin/sh\n')).toBe(true)
  })

  // The native command inherits the hook's stdin as Claude Code wrote it; PowerShell reading or re-piping it would
  // re-encode the person's text.
  it('the Stop Windows form turns module loading off, looks in the profile then each absolute PATH folder, runs device claude stop once with its stdin untouched, writes only the block, and exits 0', () => {
    const windows = windowsForm(stopHook().command)
    expect(windows.trimStart().startsWith("> $null; $PSModuleAutoLoadingPreference = 'None';")).toBe(true)
    expect(windows).not.toMatch(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/)
    expect(windows).not.toContain('HARNESS_DEVICE_MOD_ASKS')
    expect(windows).not.toContain('[Console]::In')
    expect(windows).not.toMatch(/\|\s*&\s*\$h/)
    const profile = windows.indexOf('$env:USERPROFILE\\.harness\\bin\\harness.exe')
    const onPath = windows.indexOf("foreach ($d in $env:PATH -split ';') { if ($d -match '^([a-z]:\\\\|\\\\\\\\)' -and [IO.File]::Exists(\"$d\\harness.exe\"))")
    expect(profile).toBeGreaterThan(-1)
    expect(onPath).toBeGreaterThan(profile)
    const calls = windows.match(/device claude stop[^;}]*/g)
    expect(calls).toHaveLength(1)
    expect(calls![0].trim()).toBe('device claude stop 2> $null')
    expect(windows).toContain(`if ("$o".StartsWith('${BLOCK_PREFIX}')) { [Console]::Out.Write("$o") }`)
    expect(windows.trimEnd().endsWith('; exit 0')).toBe(true)
  })

  // Codex reads .codex-plugin/ before .claude-plugin/, and a manifest's hooks path in place of hooks/hooks.json, so
  // Claude Code's hooks and mod stay Claude Code's. With no version, Codex installs the plugin as `local`.
  it('the Codex manifest is named harness-device, names hooks/codex.json, has no version, and promises no answer', () => {
    const manifest = json(pluginRoot, '.codex-plugin', 'plugin.json')
    expect(manifest.name).toBe('harness-device')
    expect(manifest.hooks).toBe('./hooks/codex.json')
    expect(manifest).not.toHaveProperty('version')
    expect(manifest.description).toMatch(/waiting/i)
    expect(manifest.description).not.toMatch(/allow|deny|approv|answers/i)
  })

  it('hooks/codex.json holds the PermissionRequest and PreToolUse hooks, one SessionStart hook for startup, resume, clear and compact, and one Stop hook with no matcher, 5 s, onFailure continue, and no mod', () => {
    expect(json(pluginRoot, 'hooks', 'codex.json')).not.toHaveProperty('modules')
    const hooks = codexHooks()
    expect(Object.keys(hooks)).toEqual(['PermissionRequest', 'PreToolUse', 'SessionStart', 'Stop'])
    expect(hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: expect.any(String), onFailure: 'continue', timeout: 5 }] }])
    expect(hooks.Stop[0].hooks[0].command.split('\n')[0]).toBe('echo `# <#` >/dev/null; exec "$PLUGIN_ROOT/hooks/codex-stop"')
    expect(hooks.PermissionRequest.map((block) => block.matcher)).toEqual(['*'])
    expect(hooks.PreToolUse.map((block) => block.matcher)).toEqual(['request_user_input'])
    const command = codexHook().command
    for (const event of ['PermissionRequest', 'PreToolUse']) {
      expect(hooks[event][0].hooks, event).toEqual([{ type: 'command', command, onFailure: 'continue', timeout: 5 }])
    }
    expect(hooks.SessionStart.map((block) => block.matcher)).toEqual(['startup|resume|clear|compact'])
    expect(hooks.SessionStart[0].hooks).toEqual([{ type: 'command', command: expect.any(String), onFailure: 'continue', timeout: 5 }])
    expect(hooks.SessionStart[0].hooks[0].command.split('\n')[0]).toBe('echo `# <#` >/dev/null; exec "$PLUGIN_ROOT/hooks/codex-start"')
  })

  // Codex runs the command through a shell with PLUGIN_ROOT in its environment: the shell expands it, so no character
  // of the folder's name can break the line.
  posix.each(SHELLS)('the Codex hook runs hooks/codex-asked under %s, from a folder named with a space, a quote and a dollar sign', (shell) => {
    const root = join(tempDir(), 'Harness "Device" $x')
    cpSync(pluginRoot, root, { recursive: true })
    const home = tempDir()
    const record = join(home, 'rec')
    fakeLauncher(join(home, '.local', 'bin', 'harness'), record, ALLOW, 2)
    const result = runCodexHook(shell, root, home)
    expect(readFileSync(`${record}.argv`, 'utf8')).toBe('device\ncodex\nasked\n')
    expect(readFileSync(`${record}.stdin`, 'utf8')).toBe(CODEX_INPUT)
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
  })

  posix('with none in ~/.local/bin the Codex hook runs the one on PATH', () => {
    const home = tempDir()
    const bin = tempDir()
    const onPath = join(home, 'rec-path')
    // A file there that is not executable is no launcher.
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    writeFileSync(join(home, '.local', 'bin', 'harness'), '#!/bin/sh\nexit 9\n')
    fakeLauncher(join(bin, 'harness'), onPath, ALLOW, 2)
    const result = runCodexHook('/bin/sh', pluginRoot, home, `${bin}:/usr/bin:/bin`)
    expect(readFileSync(`${onPath}.argv`, 'utf8')).toBe('device\ncodex\nasked\n')
    expect(readFileSync(`${onPath}.stdin`, 'utf8')).toBe(CODEX_INPUT)
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
  })

  // An older CLI under the installed plugin has no `device codex`: it prints its usage and exits 1.
  posix('the Codex hook drops a launcher that prints its usage on stderr and exits 1 (an older CLI)', () => {
    const home = tempDir()
    const launcher = join(home, '.local', 'bin', 'harness')
    mkdirSync(join(launcher, '..'), { recursive: true })
    writeFileSync(launcher, '#!/bin/sh\ncat >/dev/null\necho "usage: harness device claude <command>" >&2\nexit 1\n')
    chmodSync(launcher, 0o755)
    expect(runCodexHook('/bin/sh', pluginRoot, home)).toMatchObject({ status: 0, stdout: '', stderr: '' })
  })

  posix('with no launcher, the Codex hook prints nothing and exits 0', () => {
    expect(runCodexHook('/bin/sh', pluginRoot, tempDir())).toMatchObject({ status: 0, stdout: '', stderr: '' })
  })

  posix('hooks/codex-asked is executable and starts with #!/bin/sh', () => {
    const hook = join(pluginRoot, 'hooks', 'codex-asked')
    expect(statSync(hook).mode & 0o111).toBe(0o111)
    expect(readFileSync(hook, 'utf8').startsWith('#!/bin/sh\n')).toBe(true)
  })

  // Codex runs the command in PowerShell on Windows (pwsh or Windows PowerShell). Codex has no mod, so nothing skips the
  // launcher there.
  it('the Codex Windows form turns module loading off, looks in the profile then each absolute PATH folder, runs device codex asked, and exits 0', () => {
    const windows = windowsForm(codexHook().command)
    expect(windows.trimStart().startsWith("> $null; $PSModuleAutoLoadingPreference = 'None';")).toBe(true)
    expect(windows).not.toMatch(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/)
    expect(windows).not.toContain('HARNESS_DEVICE_MOD_ASKS')
    const profile = windows.indexOf('$env:USERPROFILE\\.harness\\bin\\harness.exe')
    const onPath = windows.indexOf("foreach ($d in $env:PATH -split ';') { if ($d -match '^([a-z]:\\\\|\\\\\\\\)' -and [IO.File]::Exists(\"$d\\harness.exe\"))")
    expect(profile).toBeGreaterThan(-1)
    expect(onPath).toBeGreaterThan(profile)
    const calls = windows.match(/device codex asked[^;}]*/g)
    expect(calls).toHaveLength(1)
    expect(calls![0].trim()).toBe('device codex asked *> $null')
    expect(windows.trimEnd().endsWith('; exit 0')).toBe(true)
  })

  // Codex adds what a SessionStart hook prints to the model's request, JSON or plain text alike (the spike).
  posix.each(SHELLS)("the Codex SessionStart hook runs hooks/codex-start under %s, from a folder named with a space, a quote and a dollar sign, and prints the launcher's line", (shell) => {
    const root = join(tempDir(), 'Harness "Device" $x')
    cpSync(pluginRoot, root, { recursive: true })
    const home = tempDir()
    const record = join(home, 'rec')
    fakeLauncher(join(home, '.local', 'bin', 'harness'), record, SESSION_LINE)
    const result = runCodexStartHook(shell, root, home)
    expect(readFileSync(`${record}.argv`, 'utf8')).toBe('device\ncodex\nstart\n')
    expect(readFileSync(`${record}.stdin`, 'utf8')).toBe(CODEX_START_INPUT)
    expect(result).toMatchObject({ status: 0, stdout: `${SESSION_LINE}\n`, stderr: '' })
  })

  // An older launcher's usage, another hook's JSON, nothing, a failure or text on stderr: none of it may reach the model.
  posix('the Codex SessionStart hook prints nothing but the line', () => {
    const home = tempDir()
    const launcher = join(home, '.local', 'bin', 'harness')
    mkdirSync(join(launcher, '..'), { recursive: true })
    for (const out of ['harness v0.6 — connect this computer to your machine', ALLOW, '']) {
      for (const code of [0, 1, 2]) {
        writeFileSync(launcher, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${out}'\necho 'usage: harness device' >&2\nexit ${code}\n`)
        chmodSync(launcher, 0o755)
        expect(runCodexStartHook('/bin/sh', pluginRoot, home), `${out} exit ${code}`).toMatchObject({ status: 0, stdout: '', stderr: '' })
      }
    }
  })

  posix('with no launcher the Codex SessionStart hook prints nothing and exits 0', () => {
    expect(runCodexStartHook('/bin/sh', pluginRoot, tempDir())).toMatchObject({ status: 0, stdout: '', stderr: '' })
  })

  posix('the Codex SessionStart hook runs ~/.local/bin/harness first, then PATH', () => {
    const home = tempDir()
    const bin = tempDir()
    const placements = [join(home, '.local', 'bin', 'harness'), join(bin, 'harness')]
    const record = (i: number) => join(home, `rec-${i}`)
    placements.forEach((launcher, i) => fakeLauncher(launcher, record(i), SESSION_LINE))
    // Each run finds the first placement still there; the next run has it removed.
    for (const [i, launcher] of placements.entries()) {
      const result = runCodexStartHook('/bin/sh', pluginRoot, home, `${bin}:/usr/bin:/bin`)
      expect(readFileSync(`${record(i)}.argv`, 'utf8'), launcher).toBe('device\ncodex\nstart\n')
      expect(readFileSync(`${record(i)}.stdin`, 'utf8'), launcher).toBe(CODEX_START_INPUT)
      for (let later = i + 1; later < placements.length; later++) expect(existsSync(`${record(later)}.argv`), launcher).toBe(false)
      expect(result, launcher).toMatchObject({ status: 0, stdout: `${SESSION_LINE}\n`, stderr: '' })
      rmSync(launcher)
    }
  })

  posix('hooks/codex-start is executable and starts with #!/bin/sh', () => {
    expect(statSync(CODEX_START).mode & 0o111).toBe(0o111)
    expect(readFileSync(CODEX_START, 'utf8').startsWith('#!/bin/sh\n')).toBe(true)
  })

  it('the Codex SessionStart Windows form turns module loading off, looks in the profile then each absolute PATH folder, runs device codex start once, writes only the SessionStart line, and exits 0', () => {
    const windows = windowsForm(codexStartHook().command)
    expect(windows.trimStart().startsWith("> $null; $PSModuleAutoLoadingPreference = 'None';")).toBe(true)
    expect(windows).not.toMatch(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/)
    expect(windows).not.toContain('HARNESS_DEVICE_MOD_ASKS')
    const profile = windows.indexOf('$env:USERPROFILE\\.harness\\bin\\harness.exe')
    const onPath = windows.indexOf("foreach ($d in $env:PATH -split ';') { if ($d -match '^([a-z]:\\\\|\\\\\\\\)' -and [IO.File]::Exists(\"$d\\harness.exe\"))")
    expect(profile).toBeGreaterThan(-1)
    expect(onPath).toBeGreaterThan(profile)
    const calls = windows.match(/device codex start[^;}]*/g)
    expect(calls).toHaveLength(1)
    expect(calls![0].trim()).toBe('device codex start 2> $null')
    expect(windows).toContain(`if ("$o".StartsWith('${SESSION_PREFIX}')) { [Console]::Out.Write("$o") }`)
    expect(windows.trimEnd().endsWith('; exit 0')).toBe(true)
  })

  // Codex reads what a Stop hook prints as its decision, as Claude Code does: a block keeps the agent's turn going (F2).
  posix.each(SHELLS)("the Codex Stop hook runs hooks/codex-stop under %s, from a folder named with a space, a quote and a dollar sign, and prints the launcher's block", (shell) => {
    const root = join(tempDir(), 'Harness "Device" $x')
    cpSync(pluginRoot, root, { recursive: true })
    const home = tempDir()
    const record = join(home, 'rec')
    fakeLauncher(join(home, '.local', 'bin', 'harness'), record, BLOCK)
    const result = runCodexStopHook(shell, root, home)
    expect(readFileSync(`${record}.argv`, 'utf8')).toBe('device\ncodex\nstop\n')
    expect(readFileSync(`${record}.stdin`, 'utf8')).toBe(CODEX_STOP_INPUT)
    expect(result).toMatchObject({ status: 0, stdout: `${BLOCK}\n`, stderr: '' })
  })

  // An older launcher's usage, another hook's JSON, nothing, a failure or text on stderr: none of it may reach Codex as
  // a decision.
  posix('the Codex Stop hook prints nothing but the block', () => {
    const home = tempDir()
    const launcher = join(home, '.local', 'bin', 'harness')
    mkdirSync(join(launcher, '..'), { recursive: true })
    for (const out of ['harness v0.6 — connect this computer to your machine', ALLOW, '']) {
      for (const code of [0, 1, 2]) {
        writeFileSync(launcher, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${out}'\necho 'usage: harness device' >&2\nexit ${code}\n`)
        chmodSync(launcher, 0o755)
        expect(runCodexStopHook('/bin/sh', pluginRoot, home), `${out} exit ${code}`).toMatchObject({ status: 0, stdout: '', stderr: '' })
      }
    }
  })

  posix('with no launcher the Codex Stop hook prints nothing and exits 0', () => {
    expect(runCodexStopHook('/bin/sh', pluginRoot, tempDir())).toMatchObject({ status: 0, stdout: '', stderr: '' })
  })

  posix('the Codex Stop hook runs ~/.local/bin/harness first, then PATH', () => {
    const home = tempDir()
    const bin = tempDir()
    const placements = [join(home, '.local', 'bin', 'harness'), join(bin, 'harness')]
    const record = (i: number) => join(home, `rec-${i}`)
    placements.forEach((launcher, i) => fakeLauncher(launcher, record(i), BLOCK))
    // Each run finds the first placement still there; the next run has it removed.
    for (const [i, launcher] of placements.entries()) {
      const result = runCodexStopHook('/bin/sh', pluginRoot, home, `${bin}:/usr/bin:/bin`)
      expect(readFileSync(`${record(i)}.argv`, 'utf8'), launcher).toBe('device\ncodex\nstop\n')
      expect(readFileSync(`${record(i)}.stdin`, 'utf8'), launcher).toBe(CODEX_STOP_INPUT)
      for (let later = i + 1; later < placements.length; later++) expect(existsSync(`${record(later)}.argv`), launcher).toBe(false)
      expect(result, launcher).toMatchObject({ status: 0, stdout: `${BLOCK}\n`, stderr: '' })
      rmSync(launcher)
    }
  })

  posix('hooks/codex-stop is executable and starts with #!/bin/sh', () => {
    expect(statSync(CODEX_STOP).mode & 0o111).toBe(0o111)
    expect(readFileSync(CODEX_STOP, 'utf8').startsWith('#!/bin/sh\n')).toBe(true)
  })

  // The native command inherits the hook's stdin as Codex wrote it; PowerShell reading or re-piping it would re-encode
  // the person's text.
  it('the Codex Stop Windows form turns module loading off, looks in the profile then each absolute PATH folder, runs device codex stop once with its stdin untouched, writes only the block, and exits 0', () => {
    const windows = windowsForm(codexStopHook().command)
    expect(windows.trimStart().startsWith("> $null; $PSModuleAutoLoadingPreference = 'None';")).toBe(true)
    expect(windows).not.toMatch(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/)
    expect(windows).not.toContain('HARNESS_DEVICE_MOD_ASKS')
    expect(windows).not.toContain('[Console]::In')
    expect(windows).not.toMatch(/\|\s*&\s*\$h/)
    const profile = windows.indexOf('$env:USERPROFILE\\.harness\\bin\\harness.exe')
    const onPath = windows.indexOf("foreach ($d in $env:PATH -split ';') { if ($d -match '^([a-z]:\\\\|\\\\\\\\)' -and [IO.File]::Exists(\"$d\\harness.exe\"))")
    expect(profile).toBeGreaterThan(-1)
    expect(onPath).toBeGreaterThan(profile)
    const calls = windows.match(/device codex stop[^;}]*/g)
    expect(calls).toHaveLength(1)
    expect(calls![0].trim()).toBe('device codex stop 2> $null')
    expect(windows).toContain(`if ("$o".StartsWith('${BLOCK_PREFIX}')) { [Console]::Out.Write("$o") }`)
    expect(windows.trimEnd().endsWith('; exit 0')).toBe(true)
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
      run: (command: string, options: SpawnSyncOptionsWithStringEncoding) => spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', command.replaceAll('${CLAUDE_PLUGIN_ROOT}', '${env:CLAUDE_PLUGIN_ROOT}') + SUFFIX], options),
    },
    ...(gitBash ? [{
      name: 'Git Bash',
      root: pluginRoot.replaceAll('\\', '/'),
      run: (command: string, options: SpawnSyncOptionsWithStringEncoding) => spawnSync(gitBash, ['-c', command], options),
    }] : []),
  ]

  /** A profile, a working folder, and this process's environment with only the system folders on PATH. */
  function place() {
    const profile = tempDir()
    const cwd = tempDir()
    const own = Object.entries(process.env)
      .filter(([key]) => !['path', 'home', 'userprofile', 'claude_plugin_root', 'plugin_root'].includes(key.toLowerCase()))
    return { profile, cwd, env: { ...Object.fromEntries(own), USERPROFILE: profile, PATH: `${system};${join(system, 'WindowsPowerShell', 'v1.0')}` } }
  }

  /** node.exe as <profile>\.harness\bin\harness.exe: it reads `device` as ./device.js, which records its arguments and
   *  stdin and prints [out]. */
  function standIn(profile: string, cwd: string, code: number, out = ALLOW): void {
    mkdirSync(join(profile, '.harness', 'bin'), { recursive: true })
    copyFileSync(process.execPath, join(profile, '.harness', 'bin', 'harness.exe'))
    writeFileSync(join(cwd, 'device.js'), [
      "const fs = require('fs')",
      `fs.writeFileSync(${JSON.stringify(join(cwd, 'argv.json'))}, JSON.stringify(process.argv.slice(2)))`,
      `fs.writeFileSync(${JSON.stringify(join(cwd, 'stdin'))}, fs.readFileSync(0))`,
      `process.stdout.write(${JSON.stringify(out)})`,
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

    it(`${runner.name}: with HARNESS_DEVICE_MOD_ASKS set, runs no launcher, prints nothing and exits 0`, () => {
      const { profile, cwd, env } = place()
      standIn(profile, cwd, 0)
      const result = runner.run(permissionHook().command, {
        cwd, input, encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_ROOT: runner.root, HARNESS_DEVICE_MOD_ASKS: '1' },
      })
      expect(existsSync(join(cwd, 'argv.json'))).toBe(false)
      expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
    }, 30_000)

    it(`${runner.name}: with no launcher, prints nothing and exits 0`, () => {
      const { cwd, env } = place()
      const result = runner.run(permissionHook().command, { cwd, input, encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_ROOT: runner.root } })
      expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
    }, 30_000)

    // PowerShell rewrites a native command's output in its console code page, with CRLF: the line must arrive intact.
    it(`${runner.name}: SessionStart prints the launcher's SessionStart line and exits 0`, () => {
      const { profile, cwd, env } = place()
      standIn(profile, cwd, 0, SESSION_LINE)
      const result = runner.run(startHook().command, { cwd, input: START_INPUT, encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_ROOT: runner.root } })
      expect(JSON.parse(readFileSync(join(cwd, 'argv.json'), 'utf8'))).toEqual(['claude', 'start'])
      expect(readFileSync(join(cwd, 'stdin'), 'utf8')).toBe(START_INPUT)
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe(SESSION_LINE)
    }, 30_000)

    it(`${runner.name}: SessionStart prints nothing for a launcher that prints anything else`, () => {
      const { profile, cwd, env } = place()
      standIn(profile, cwd, 0)
      const result = runner.run(startHook().command, { cwd, input: START_INPUT, encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_ROOT: runner.root } })
      expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
    }, 30_000)

    it(`${runner.name}: SessionStart with no launcher, prints nothing and exits 0`, () => {
      const { cwd, env } = place()
      const result = runner.run(startHook().command, { cwd, input: START_INPUT, encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_ROOT: runner.root } })
      expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
    }, 30_000)

    // The person's answer holds what a console code page would change: it must reach the launcher byte for byte.
    it(`${runner.name}: Stop passes the launcher's block, with the hook's stdin byte for byte, and exits 0`, () => {
      const { profile, cwd, env } = place()
      standIn(profile, cwd, 0, BLOCK)
      const stopInput = JSON.stringify({ ...JSON.parse(STOP_INPUT), last_assistant_message: 'Đã xong, không cần gì thêm.' })
      const result = runner.run(stopHook().command, { cwd, input: stopInput, encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_ROOT: runner.root } })
      expect(JSON.parse(readFileSync(join(cwd, 'argv.json'), 'utf8'))).toEqual(['claude', 'stop'])
      expect(readFileSync(join(cwd, 'stdin'), 'utf8')).toBe(stopInput)
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe(BLOCK)
    }, 30_000)

    it(`${runner.name}: Stop prints nothing for a launcher that prints anything else`, () => {
      const { profile, cwd, env } = place()
      standIn(profile, cwd, 0)
      const result = runner.run(stopHook().command, { cwd, input: STOP_INPUT, encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_ROOT: runner.root } })
      expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
    }, 30_000)

    it(`${runner.name}: Stop with no launcher, prints nothing and exits 0`, () => {
      const { cwd, env } = place()
      const result = runner.run(stopHook().command, { cwd, input: STOP_INPUT, encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_ROOT: runner.root } })
      expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
    }, 30_000)

    // The devices hold a turn's end for its report up to 6 s, and the report goes out once the launcher starts: this is
    // the shell's share of that wait, as the stand-in starts at once. It measures and asserts only that each run ended.
    it(`${runner.name}: the Stop form's time to the report`, () => {
      const { profile, cwd, env } = place()
      standIn(profile, cwd, 0, BLOCK)
      const started = join(cwd, 'started')
      // hrtime is the system's monotonic clock on Windows, so the stand-in's reading compares with this process's.
      writeFileSync(join(cwd, 'device.js'), [
        "const fs = require('fs')",
        `fs.writeFileSync(${JSON.stringify(started)}, String(process.hrtime.bigint()))`,
        'fs.readFileSync(0)',
        `process.stdout.write(${JSON.stringify(BLOCK)})`,
      ].join('\n'))
      const times: number[] = []
      for (let run = 0; run < 10; run++) {
        rmSync(started, { force: true })
        const spawned = process.hrtime.bigint()
        const result = runner.run(stopHook().command, { cwd, input: STOP_INPUT, encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_ROOT: runner.root } })
        expect(result.status, `run ${run}`).toBe(0)
        times.push(Number(BigInt(readFileSync(started, 'utf8')) - spawned) / 1e6)
      }
      const sorted = [...times].sort((a, b) => a - b)
      const median = (sorted[4] + sorted[5]) / 2
      console.log(`[measure] stop report · ${runner.name} · median ${Math.round(median)} · max ${Math.round(sorted[9])} · past 6 s ${times.filter((ms) => ms > 6_000).length}`)
    }, 180_000)
  }

  // Codex runs the command as `<PowerShell> -NoProfile -Command <command>`, with PLUGIN_ROOT in its environment: pwsh when
  // installed, else Windows PowerShell 5.1. These run 5.1, the one every Windows has; pwsh is not run here.
  const codexInput = JSON.stringify({ ...JSON.parse(CODEX_INPUT), tool_input: { command: 'echo "héllo" & dir %TEMP% | more' } })
  const runCodex = (options: SpawnSyncOptionsWithStringEncoding, command = codexHook().command) => spawnSync(powershell, ['-NoProfile', '-Command', command], options)

  it("Codex: runs the profile's launcher with device codex asked and its stdin, prints nothing and exits 0", () => {
    for (const code of [0, 2]) {
      const { profile, cwd, env } = place()
      standIn(profile, cwd, code)
      const result = runCodex({ cwd, input: codexInput, encoding: 'utf8', env: { ...env, PLUGIN_ROOT: pluginRoot } })
      expect(JSON.parse(readFileSync(join(cwd, 'argv.json'), 'utf8')), `exit ${code}`).toEqual(['codex', 'asked'])
      expect(readFileSync(join(cwd, 'stdin'), 'utf8'), `exit ${code}`).toBe(codexInput)
      expect(result, `exit ${code}`).toMatchObject({ status: 0, stdout: '', stderr: '' })
    }
  }, 60_000)

  it('Codex: with no launcher, prints nothing and exits 0', () => {
    const { cwd, env } = place()
    const result = runCodex({ cwd, input: codexInput, encoding: 'utf8', env: { ...env, PLUGIN_ROOT: pluginRoot } })
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
  }, 30_000)

  // PowerShell rewrites a native command's output in its console code page, with CRLF: the line must arrive intact.
  it("Codex: SessionStart prints the launcher's SessionStart line and exits 0", () => {
    const { profile, cwd, env } = place()
    standIn(profile, cwd, 0, SESSION_LINE)
    const result = runCodex({ cwd, input: CODEX_START_INPUT, encoding: 'utf8', env: { ...env, PLUGIN_ROOT: pluginRoot } }, codexStartHook().command)
    expect(JSON.parse(readFileSync(join(cwd, 'argv.json'), 'utf8'))).toEqual(['codex', 'start'])
    expect(readFileSync(join(cwd, 'stdin'), 'utf8')).toBe(CODEX_START_INPUT)
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(SESSION_LINE)
  }, 30_000)

  it('Codex: SessionStart prints nothing for a launcher that prints anything else', () => {
    const { profile, cwd, env } = place()
    standIn(profile, cwd, 0)
    const result = runCodex({ cwd, input: CODEX_START_INPUT, encoding: 'utf8', env: { ...env, PLUGIN_ROOT: pluginRoot } }, codexStartHook().command)
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
  }, 30_000)

  it('Codex: SessionStart with no launcher, prints nothing and exits 0', () => {
    const { cwd, env } = place()
    const result = runCodex({ cwd, input: CODEX_START_INPUT, encoding: 'utf8', env: { ...env, PLUGIN_ROOT: pluginRoot } }, codexStartHook().command)
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
  }, 30_000)

  // The person's answer holds what a console code page would change: it must reach the launcher byte for byte.
  it("Codex: Stop passes the launcher's block, with the hook's stdin byte for byte, and exits 0", () => {
    const { profile, cwd, env } = place()
    standIn(profile, cwd, 0, BLOCK)
    const stopInput = JSON.stringify({ ...JSON.parse(CODEX_STOP_INPUT), last_assistant_message: 'Đã xong, không cần gì thêm.' })
    const result = runCodex({ cwd, input: stopInput, encoding: 'utf8', env: { ...env, PLUGIN_ROOT: pluginRoot } }, codexStopHook().command)
    expect(JSON.parse(readFileSync(join(cwd, 'argv.json'), 'utf8'))).toEqual(['codex', 'stop'])
    expect(readFileSync(join(cwd, 'stdin'), 'utf8')).toBe(stopInput)
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(BLOCK)
  }, 30_000)

  it('Codex: Stop prints nothing for a launcher that prints anything else', () => {
    const { profile, cwd, env } = place()
    standIn(profile, cwd, 0)
    const result = runCodex({ cwd, input: CODEX_STOP_INPUT, encoding: 'utf8', env: { ...env, PLUGIN_ROOT: pluginRoot } }, codexStopHook().command)
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
  }, 30_000)

  it('Codex: Stop with no launcher, prints nothing and exits 0', () => {
    const { cwd, env } = place()
    const result = runCodex({ cwd, input: CODEX_STOP_INPUT, encoding: 'utf8', env: { ...env, PLUGIN_ROOT: pluginRoot } }, codexStopHook().command)
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
  }, 30_000)

  // The devices hold a turn's end for its report up to 6 s, and the report goes out once the launcher starts: this is
  // the shell's share of that wait, as the stand-in starts at once. It measures and asserts only that each run ended.
  it("Codex: the Stop form's time to the report", () => {
    const { profile, cwd, env } = place()
    standIn(profile, cwd, 0, BLOCK)
    const started = join(cwd, 'started')
    // hrtime is the system's monotonic clock on Windows, so the stand-in's reading compares with this process's.
    writeFileSync(join(cwd, 'device.js'), [
      "const fs = require('fs')",
      `fs.writeFileSync(${JSON.stringify(started)}, String(process.hrtime.bigint()))`,
      'fs.readFileSync(0)',
      `process.stdout.write(${JSON.stringify(BLOCK)})`,
    ].join('\n'))
    const times: number[] = []
    for (let run = 0; run < 10; run++) {
      rmSync(started, { force: true })
      const spawned = process.hrtime.bigint()
      const result = runCodex({ cwd, input: CODEX_STOP_INPUT, encoding: 'utf8', env: { ...env, PLUGIN_ROOT: pluginRoot } }, codexStopHook().command)
      expect(result.status, `run ${run}`).toBe(0)
      times.push(Number(BigInt(readFileSync(started, 'utf8')) - spawned) / 1e6)
    }
    const sorted = [...times].sort((a, b) => a - b)
    const median = (sorted[4] + sorted[5]) / 2
    console.log(`[measure] stop report · Codex PowerShell · median ${Math.round(median)} · max ${Math.round(sorted[9])} · past 6 s ${times.filter((ms) => ms > 6_000).length}`)
  }, 180_000)
})
