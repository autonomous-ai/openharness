import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GUARD_REASONS } from './shellGuard.js'

const CLI_ROOT = fileURLToPath(new URL('../..', import.meta.url))

describe('the shell guard in a shipped CLI', () => {
  let scratch = ''
  let argv: string[] = []
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'guard-bundle-'))
    const out = join(scratch, 'release')
    execFileSync(process.execPath, ['build-bundle.mjs'], {
      cwd: CLI_ROOT, env: { ...process.env, BUNDLE_OUT_DIR: out }, stdio: 'pipe', timeout: 120_000,
    })
    // As the shipped CLI's folder says: cli.js is an ES module. Without it, a temporary folder under an agent's own, whose
    // parent marks scripts CommonJS (lib/agentTmp.ts), loaded cli.js as CommonJS and every case failed (#4395).
    writeFileSync(join(out, 'package.json'), '{"type":"module"}\n')
    // The lean core gives hooks the cli.js it was started for through argv[1]. Compile the real helper into
    // a separate chunk, as the release does: its import.meta.url is no longer src/lib/agentShellGuard.ts.
    const source = join(scratch, 'hook-command.ts')
    writeFileSync(source, `import { shellGuardArgv } from ${JSON.stringify(join(CLI_ROOT, 'src/lib/agentShellGuard.ts'))};
process.argv[1] = process.argv[2];
process.stdout.write(JSON.stringify(shellGuardArgv()));
`)
    const helper = join(scratch, 'hook-command.mjs')
    await build({ entryPoints: [source], outfile: helper, bundle: true, platform: 'node', format: 'esm',
      banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }, logLevel: 'silent' })
    argv = JSON.parse(execFileSync(process.execPath, [helper, join(out, 'cli.js')], { encoding: 'utf8', timeout: 15_000 }))
  }, 150_000)
  afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }) })

  it.each([
    ['Bash', { command: 'pkill -f node' }, GUARD_REASONS.killByName],
    ['Bash', { command: 'sudo npm ci' }, GUARD_REASONS.systemWide],
    ['Write', { file_path: '/tmp/shared-notes.txt', content: 'x' }, GUARD_REASONS.fixedTmp],
    ['exec_command', { cmd: 'killall node' }, GUARD_REASONS.killByName],
    ['shell', { command: ['bash', '-lc', 'npm install -g typescript'] }, GUARD_REASONS.systemWide],
  ])('runs the installed hook for %s %j', (tool, input, reason) => {
    const run = spawnSync(argv[0], argv.slice(1), { input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: scratch }),
      encoding: 'utf8', timeout: 15_000, windowsHide: true })
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' })
    expect(JSON.parse(run.stdout)).toEqual({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
    } })
  })

  it('leaves ordinary commands to the engine without loading the CLI or contacting a daemon', () => {
    const run = spawnSync(argv[0], argv.slice(1), { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: scratch }),
      encoding: 'utf8', timeout: 15_000, windowsHide: true })
    expect({ status: run.status, stderr: run.stderr, stdout: run.stdout }).toEqual({ status: 0, stderr: '', stdout: '' })
  })
})
