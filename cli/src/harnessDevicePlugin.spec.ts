import { spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it } from 'vitest'

// The harness-device plugin is files Claude Code reads and a hook it runs as a child process. These checks hold the
// files to what the marketplace and Claude Code expect, and run the hook as Claude Code does: its stdin, a HOME and a
// PATH, and nothing of the developer's own (a throwaway HOME, fake launchers).
const repo = fileURLToPath(new URL('../..', import.meta.url))
const pluginRoot = join(repo, 'plugins', 'harness-device')
const HOOK = join(pluginRoot, 'hooks', 'approve')
const json = (...path: string[]) => JSON.parse(readFileSync(join(...path), 'utf8'))
const INPUT = JSON.stringify({
  session_id: 's-1',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
})

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

function runHook(home: string, path: string) {
  return spawnSync(HOOK, [], { input: INPUT, env: { HOME: home, PATH: path }, encoding: 'utf8' })
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

  it('hooks.json holds one PermissionRequest command hook for every tool, at ${CLAUDE_PLUGIN_ROOT}/hooks/approve, with a 330 s timeout', () => {
    const { hooks } = json(pluginRoot, 'hooks', 'hooks.json') as { hooks: Record<string, unknown> }
    expect(hooks).toEqual({
      PermissionRequest: [
        { matcher: '*', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/approve', timeout: 330 }] },
      ],
    })
  })

  it('hooks.json loads the voice mod, hooks/device.js', () => {
    expect(json(pluginRoot, 'hooks', 'hooks.json').modules).toEqual(['./device.js'])
  })

  it('hooks/approve is executable and starts with #!/bin/sh', () => {
    expect(statSync(HOOK).mode & 0o111).toBe(0o111)
    expect(readFileSync(HOOK, 'utf8').startsWith('#!/bin/sh\n')).toBe(true)
  })

  it('with no launcher it exits 0 with no output', () => {
    const result = runHook(tempDir(), '/usr/bin:/bin')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it('it runs ~/.local/bin/harness first, with device claude approve and the stdin it was given', () => {
    const home = tempDir()
    const bin = tempDir()
    const local = join(home, 'rec-local')
    const onPath = join(home, 'rec-path')
    fakeLauncher(join(home, '.local', 'bin', 'harness'), local, '{"decided":true}', 3)
    fakeLauncher(join(bin, 'harness'), onPath)
    const result = runHook(home, `${bin}:/usr/bin:/bin`)
    expect(readFileSync(`${local}.argv`, 'utf8')).toBe('device\nclaude\napprove\n')
    expect(readFileSync(`${local}.stdin`, 'utf8')).toBe(INPUT)
    expect(existsSync(`${onPath}.argv`)).toBe(false)
    // The hook execs the launcher: its stdout and exit code are what Claude Code reads.
    expect(result.stdout).toBe('{"decided":true}')
    expect(result.status).toBe(3)
  })

  it('with none in ~/.local/bin it runs the one on PATH', () => {
    const home = tempDir()
    const bin = tempDir()
    const onPath = join(home, 'rec-path')
    // A file there that is not executable is no launcher.
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    writeFileSync(join(home, '.local', 'bin', 'harness'), '#!/bin/sh\nexit 9\n')
    fakeLauncher(join(bin, 'harness'), onPath)
    const result = runHook(home, `${bin}:/usr/bin:/bin`)
    expect(result.status).toBe(0)
    expect(readFileSync(`${onPath}.argv`, 'utf8')).toBe('device\nclaude\napprove\n')
    expect(readFileSync(`${onPath}.stdin`, 'utf8')).toBe(INPUT)
  })

  it('the README names harness device claude disable, and says no auto-approve and no always allow', () => {
    const readme = readFileSync(join(pluginRoot, 'README.md'), 'utf8')
    expect(readme).toContain('harness device claude disable')
    expect(readme).toMatch(/no auto-approve/i)
    expect(readme).toMatch(/no "always allow"/i)
  })
})
