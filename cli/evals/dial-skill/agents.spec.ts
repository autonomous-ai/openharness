import { execFileSync } from 'node:child_process'
import { chmodSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_CONFIG, CLAUDE_SANDBOX, claudeArgs, runAgent, type AgentConfig } from './lib/agents.js'
import { parseClaudeStream } from './lib/parse.js'
import type { Scenario } from './lib/scenarios.js'
import type { Staged } from './lib/stage.js'

const SAMPLE = join(import.meta.dirname, 'test-data', 'claude-stream.jsonl')

const need: Scenario = {
  id: 'api-key-missing',
  need: 'need',
  kind: 'secret',
  prompt: 'Generate this week\'s report with `npm run report`.',
  ask: 'give WEATHER_API_KEY',
  secrets: [],
  origin: false,
  check: { run: 'npm run report', expect: 'WEATHER_API_KEY is not set' },
  dir: '/nowhere',
}
const noNeed: Scenario = { ...need, id: 'fix-off-by-one', need: 'no-need', ask: null }

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dial-skill-agents-'))
  for (const dir of ['repo', 'rec', 'tmp', 'bin', 'profile']) mkdirSync(join(root, dir))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function staged(env: NodeJS.ProcessEnv = {}): Staged {
  return {
    root,
    repo: join(root, 'repo'),
    recFile: join(root, 'rec', 'calls.jsonl'),
    env: { PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: join(root, 'profile'), ...env },
    skill: null,
  }
}

/** An executable script standing in for `claude` (or the staged `harness`). */
function fake(name: string, body: string, interpreter = process.execPath): string {
  const file = join(root, name)
  writeFileSync(file, `#!${interpreter}\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

/** A shell `claude` that runs `body` when given arguments. It is run once bare first: macOS checks a new executable on
 *  its first exec, which can take longer than the 200 ms timeout, and the agent must be running when that fires. */
function shellAgent(body: string): string {
  const file = fake('claude', `[ $# -eq 0 ] && exit 0\n${body}`, '/bin/sh')
  execFileSync(file)
  return file
}

function config(claudeBin: string, timeoutMs = 10_000): AgentConfig {
  return { ...AGENT_CONFIG, claudeBin, timeoutMs }
}

/** A FIFO the fake agent and its child hold open for writing. Its read side ends only when the kernel has closed every
 *  write end, which happens when the last process holding one exits: an exit event for processes that are not ours. */
function lifeline(): { path: string; gone: Promise<void> } {
  const path = join(root, 'lifeline')
  execFileSync('mkfifo', [path])
  const gone = new Promise<void>((resolve, reject) => {
    createReadStream(path).on('error', reject).on('end', resolve).resume()
  })
  return { path, gone }
}

describe('claudeArgs', () => {
  it('runs Claude in print mode with the pinned model and limits, project settings only and the sandbox', () => {
    const st = staged()
    expect(claudeArgs(AGENT_CONFIG, st, 'Fix it.')).toEqual([
      '-p', 'Fix it.',
      '--output-format', 'stream-json', '--verbose',
      '--model', 'claude-opus-5-5', '--effort', 'high', '--max-turns', '40',
      '--setting-sources', 'project',
      '--no-session-persistence',
      '--permission-mode', 'acceptEdits',
      '--disallowedTools', 'WebFetch', 'WebSearch',
      '--add-dir', join(root, 'rec'), join(root, 'tmp'),
      '--settings', JSON.stringify(CLAUDE_SANDBOX),
    ])
    expect(AGENT_CONFIG.timeoutMs).toBe(600_000)
  })

  it('keeps the sandbox on for writes, with a network allowlist and no unsandboxed fallback', () => {
    const argv = claudeArgs(AGENT_CONFIG, staged(), 'Fix it.')
    const { sandbox } = JSON.parse(argv[argv.indexOf('--settings') + 1])
    expect(sandbox.enabled).toBe(true)
    expect(sandbox.autoAllowBashIfSandboxed).toBe(true)
    expect(sandbox.allowUnsandboxedCommands).toBe(false)
    expect(sandbox.network.allowedDomains.length).toBeGreaterThan(0)
    expect(sandbox.network.allowedDomains).not.toContain('*')
  })

  it('never skips permissions', () => {
    const argv = claudeArgs(AGENT_CONFIG, staged(), 'Fix it.').join(' ')
    for (const flag of ['--dangerously-skip-permissions', 'bypassPermissions', '--bare']) expect(argv).not.toContain(flag)
  })
})

describe('runAgent claude', () => {
  it('runs claude in the staged repo with the staged env and returns its parsed stream', async () => {
    const seen = join(root, 'seen.json')
    const bin = fake('claude', `const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }))
process.stdout.write(fs.readFileSync(${JSON.stringify(SAMPLE)}))`)
    const st = staged()

    const run = await runAgent('claude', need, st, config(bin))

    const got = JSON.parse(readFileSync(seen, 'utf8'))
    expect(got.argv).toEqual(claudeArgs(config(bin), st, need.prompt))
    expect(got.cwd).toBe(realpathSync(st.repo))
    expect(got.env.CLAUDE_CONFIG_DIR).toBe(join(root, 'profile'))
    expect(got.env.PATH).toBe('/usr/bin:/bin')
    expect(run).toEqual(parseClaudeStream(readFileSync(SAMPLE, 'utf8')))
  })

  it.each([
    ['unset', undefined],
    ['the default ~/.claude', join(homedir(), '.claude')],
  ])('refuses to start Claude with CLAUDE_CONFIG_DIR %s', async (_, profile) => {
    const ran = join(root, 'ran')
    const bin = fake('claude', `require('node:fs').writeFileSync(${JSON.stringify(ran)}, '')`)

    await expect(runAgent('claude', need, staged({ CLAUDE_CONFIG_DIR: profile }), config(bin))).rejects.toThrow(/CLAUDE_CONFIG_DIR/)
    expect(existsSync(ran)).toBe(false)
  })

  it('refuses to start when claude was not found on PATH', async () => {
    await expect(runAgent('claude', need, staged(), config(''))).rejects.toThrow(/claude was not found/)
  })

  it('kills the agent and its child at the timeout and rejects with timeout', async () => {
    const line = lifeline()
    const bin = shellAgent(`exec 3>${JSON.stringify(line.path)}\n/bin/sleep 600 3>&3 &\nwait`)

    const error = await runAgent('claude', need, staged(), config(bin, 200)).catch((e: unknown) => e)

    expect(error).toMatchObject({ failure_class: 'timeout' })
    await line.gone
  })

  it('kills an agent that ignores SIGTERM 10 s later', async () => {
    const line = lifeline()
    const bin = shellAgent(`trap '' TERM\nexec 3>${JSON.stringify(line.path)}\n/bin/sleep 600 3>&3 &\nwait`)

    const error = await runAgent('claude', need, staged(), config(bin, 200)).catch((e: unknown) => e)

    expect(error).toMatchObject({ failure_class: 'timeout' })
    await line.gone
  }, 20_000)

  it('kills what the agent left running once it exits', async () => {
    const line = lifeline()
    const bin = shellAgent(`exec 3>${JSON.stringify(line.path)}\n/bin/sleep 600 3>&3 >/dev/null 2>&1 &\ncat ${JSON.stringify(SAMPLE)}`)

    const run = await runAgent('claude', need, staged(), config(bin))

    expect(run.answer).toContain('WEATHER_API_KEY')
    await line.gone
  })

  it('rejects account_limited, without the words the runner retries on, when the account limit stops the run', async () => {
    const limit = { type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 6pm", usage: { input_tokens: 0, output_tokens: 0 } }
    const bin = fake('claude', `process.stdout.write(${JSON.stringify(`${JSON.stringify(limit)}\n`)}); process.exitCode = 1`)

    const error = await runAgent('claude', need, staged(), config(bin)).catch((e: unknown) => e)

    expect(error).toMatchObject({ failure_class: 'account_limited' })
    expect((error as Error).message).not.toMatch(/overloaded|rate.?limit/i)
  })

  it('returns a run stopped at --max-turns as truncated, though claude exits 1', async () => {
    const truncated = { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 41, usage: { input_tokens: 1, output_tokens: 2 } }
    const bin = fake('claude', `process.stdout.write(${JSON.stringify(`${JSON.stringify(truncated)}\n`)}); process.exitCode = 1`)

    await expect(runAgent('claude', need, staged(), config(bin))).resolves.toMatchObject({ status: 'truncated' })
  })

  it('rejects with the exit code and stderr when claude fails without a result', async () => {
    const bin = fake('claude', `process.stderr.write("error: unknown option '--bogus'\\n"); process.exitCode = 1`)

    await expect(runAgent('claude', need, staged(), config(bin))).rejects.toThrow("claude exited 1: error: unknown option '--bogus'")
  })
})

describe('runAgent stand-ins', () => {
  it.each([
    ['oracle', 'need', need, [['device', 'notify', 'give WEATHER_API_KEY']], 'give WEATHER_API_KEY'],
    ['oracle', 'no-need', noNeed, [], ''],
    ['null', 'need', need, [], ''],
    ['always', 'no-need', noNeed, [['device', 'notify', 'Please check in']], ''],
  ] as const)('%s on a %s scenario rings %j and answers %j', async (agent, _, scenario, rings, answer) => {
    const calls = join(root, 'rec', 'calls.jsonl')
    fake(join('bin', 'harness'), `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n')
console.log('shown')`)

    const run = await runAgent(agent, scenario, staged(), AGENT_CONFIG)

    const recorded = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
    expect(recorded).toEqual(rings)
    expect(run.answer).toBe(answer)
    expect(run.status).toBe('ok')
  })
})
