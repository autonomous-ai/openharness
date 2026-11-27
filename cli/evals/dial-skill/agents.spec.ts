import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_CONFIG, CLAUDE_SANDBOX, claudeArgs, killAgents, runAgent, runFollowUp, spawnGroup, type AgentConfig } from './lib/agents.js'
import { gradeRun, rungOf } from './lib/grade.js'
import type { Judge } from './lib/judge.js'
import { parseClaudeStream } from './lib/parse.js'
import { loadScenarios, type Condition, type Scenario } from './lib/scenarios.js'
import { markTurn, readRings, runProfileFolder, stage, unstage, type Staged } from './lib/stage.js'

const SAMPLE = join(import.meta.dirname, 'test-data', 'claude-stream.jsonl')

const need: Scenario = {
  id: 'api-key-missing',
  need: 'need',
  kind: 'secret',
  prompt: 'Generate this week\'s report with `npm run report`.',
  ask: 'give WEATHER_API_KEY',
  expect: 'waiting',
  secrets: [],
  origin: false,
  check: { run: 'npm run report', expect: 'WEATHER_API_KEY is not set' },
  dir: '/nowhere',
}
const decide: Scenario = { ...need, id: 'design-undecided', ask: 'choose the cache', expect: 'proceeding' }
const noNeed: Scenario = { ...need, id: 'fix-off-by-one', need: 'no-need', ask: null, expect: undefined }
const answered: Scenario = { ...need, follow_up: { kind: 'answer', text: 'The key is WEATHER-FAKE-1.' } }

let root: string

beforeEach(() => {
  // Real, as stage's: Claude Code names a session's folder by the real path it runs in.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dial-skill-agents-')))
  for (const dir of ['repo', 'rec', 'tmp', 'bin', 'profile']) mkdirSync(join(root, dir))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

function staged(env: NodeJS.ProcessEnv = {}): Staged {
  return {
    root,
    repo: join(root, 'repo'),
    recFile: join(root, 'rec', 'calls.jsonl'),
    origin: null,
    env: { PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: join(root, 'profile'), ...env },
    skill: null,
    condition: 'clean',
    skills: [],
    seed: null,
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
  })

  it("saves a two-turn run's session in place of --no-session-persistence: --session-id for turn 1, --resume for turn 2", () => {
    const plain = claudeArgs(AGENT_CONFIG, staged(), 'Fix it.')
    const at = plain.indexOf('--no-session-persistence')
    const id = randomUUID()

    expect(claudeArgs(AGENT_CONFIG, staged(), 'Fix it.', { id, resume: false })).toEqual([...plain.slice(0, at), '--session-id', id, ...plain.slice(at + 1)])
    expect(claudeArgs(AGENT_CONFIG, staged(), 'Fix it.', { id, resume: true })).toEqual([...plain.slice(0, at), '--resume', id, ...plain.slice(at + 1)])
    expect(plain).not.toContain('--session-id')
    expect(plain).not.toContain('--resume')
  })

  it('holds no bound of its own: the runner gives each run its share of --timeout-s', () => {
    expect(AGENT_CONFIG).not.toHaveProperty('timeoutMs')
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

  it("denies the tools that reach the person's phone, accounts or other Claude sessions, and every claude.ai connector", () => {
    const argv = claudeArgs(AGENT_CONFIG, staged(), 'Fix it.')
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1])
    expect(settings.permissions.deny).toEqual(expect.arrayContaining([
      'PushNotification', 'RemoteTrigger', 'DesignSync', 'SendMessage', 'ListAgents',
    ]))
    expect(settings.disableClaudeAiConnectors).toBe(true)
  })

  it("denies reads of the person's ~/.harness (the real harness and its sign-in) and gh's sign-in", () => {
    const argv = claudeArgs(AGENT_CONFIG, staged(), 'Fix it.')
    const { permissions } = JSON.parse(argv[argv.indexOf('--settings') + 1])
    expect(permissions.deny).toEqual(expect.arrayContaining([
      `Read(/${join(homedir(), '.harness')}/**)`, `Read(/${join(homedir(), '.config', 'gh')}/**)`,
    ]))
  })

  it("drops only the dial's description under name-only, in the run's own settings", () => {
    const settings = (condition: Condition) => {
      const argv = claudeArgs(AGENT_CONFIG, { ...staged(), condition }, 'Fix it.')
      return JSON.parse(argv[argv.indexOf('--settings') + 1])
    }

    expect(settings('name-only')).toEqual({ ...CLAUDE_SANDBOX, skillOverrides: { dial: 'name-only' } })
    expect(settings('crowd')).toEqual(CLAUDE_SANDBOX)
    expect(settings('clean')).toEqual(CLAUDE_SANDBOX)
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

  it('refuses to start Claude with CLAUDE_CONFIG_DIR a link to the default ~/.claude', async () => {
    const home = join(root, 'home')
    mkdirSync(join(home, '.claude'), { recursive: true })
    vi.stubEnv('HOME', home)
    symlinkSync(join(home, '.claude'), join(root, 'linked'))
    const ran = join(root, 'ran')
    const bin = fake('claude', `require('node:fs').writeFileSync(${JSON.stringify(ran)}, '')`)

    await expect(runAgent('claude', need, staged({ CLAUDE_CONFIG_DIR: join(root, 'linked') }), config(bin))).rejects.toThrow(/CLAUDE_CONFIG_DIR/)
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

  it('leaves the agent unbounded at a timeout of 0, as --timeout-s 0 leaves the case', async () => {
    const bin = shellAgent(`/bin/sleep 0.3\ncat ${JSON.stringify(SAMPLE)}`)

    const run = await runAgent('claude', need, staged(), config(bin, 0))

    expect(run.answer).toContain('WEATHER_API_KEY')
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

  it('kills what the agent left running in the run in a group of its own, as Claude starts its Bash commands, once it exits', async () => {
    const line = lifeline()
    const bin = fake('claude', `const fs = require('node:fs')
require('node:child_process').spawn('/bin/sleep', ['60'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', fs.openSync(${JSON.stringify(line.path)}, 'w')] }).unref()
process.stdout.write(fs.readFileSync(${JSON.stringify(SAMPLE)}))`)

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

  it('rejects a failed run with the model and usage its stream reported, as it was billed', async () => {
    const events = [
      { type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [] } },
      { type: 'result', subtype: 'error_during_execution', is_error: true, usage: { input_tokens: 7, output_tokens: 3 } },
    ]
    const bin = fake('claude', `process.stdout.write(${JSON.stringify(events.map((e) => `${JSON.stringify(e)}\n`).join(''))}); process.exitCode = 1`)

    await expect(runAgent('claude', need, staged(), config(bin))).rejects.toMatchObject({ model: 'claude-opus-5-5', usage: { input_tokens: 7, output_tokens: 3 } })
  })

  it('rejects a timed-out run with the model its stream reported', async () => {
    const bin = shellAgent(`echo '{"type":"assistant","parent_tool_use_id":null,"message":{"model":"claude-opus-5-5","content":[]}}'\n/bin/sleep 600`)

    await expect(runAgent('claude', need, staged(), config(bin, 200))).rejects.toMatchObject({ failure_class: 'timeout', model: 'claude-opus-5-5' })
  })

  it('rejects with the exit code and stderr when claude fails without a result', async () => {
    const bin = fake('claude', `process.stderr.write("error: unknown option '--bogus'\\n"); process.exitCode = 1`)

    await expect(runAgent('claude', need, staged(), config(bin))).rejects.toThrow("claude exited 1: error: unknown option '--bogus'")
  })
})

describe('a two-turn claude run', () => {
  let profile: string

  beforeEach(() => {
    profile = realpathSync(mkdtempSync(join(tmpdir(), 'dial-skill-profile-')))
  })

  afterEach(() => {
    rmSync(profile, { recursive: true, force: true })
  })

  /** A `claude` that logs its argv and saves its session as Claude Code does, at <profile>/projects/<repo>/<id>.jsonl; a
   *  resumed run that `hangs` then runs until it is killed. Run once bare first, as shellAgent's. */
  function sessionAgent(hangs: boolean): { bin: string; argvs: () => string[][] } {
    const log = join(root, 'argv.jsonl')
    const bin = fake('claude', `const fs = require('node:fs')
const path = require('node:path')
const argv = process.argv.slice(2)
if (argv.length === 0) process.exit(0)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n')
const resumed = argv.includes('--resume')
const id = argv[argv.indexOf(resumed ? '--resume' : '--session-id') + 1]
const folder = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'))
fs.mkdirSync(folder, { recursive: true })
fs.appendFileSync(path.join(folder, id + '.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: argv[1] } }) + '\\n')
if (resumed && ${hangs}) setTimeout(() => {}, 60_000)
else process.stdout.write(fs.readFileSync(${JSON.stringify(SAMPLE)}))`)
    execFileSync(bin)
    return { bin, argvs: () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) }
  }

  it("runs turn 1 under a new session id and turn 2 resuming it, and unstage removes the session's folder", async () => {
    const { bin, argvs } = sessionAgent(false)
    const st = staged({ CLAUDE_CONFIG_DIR: profile })
    const id = randomUUID()

    await runAgent('claude', answered, st, config(bin), { id, resume: false })
    const run = await runFollowUp('claude', answered, st, config(bin), id, [])

    expect(argvs()).toEqual([
      claudeArgs(config(bin), st, answered.prompt, { id, resume: false }),
      claudeArgs(config(bin), st, answered.follow_up!.text, { id, resume: true }),
    ])
    expect(run).toEqual(parseClaudeStream(readFileSync(SAMPLE, 'utf8')))
    const folder = runProfileFolder(st)!
    expect(readFileSync(join(folder, `${id}.jsonl`), 'utf8').trim().split('\n')).toHaveLength(2)
    unstage(st)
    expect(existsSync(folder)).toBe(false)
  })

  it("removes the session's folder at unstage when turn 2 is killed at its timeout", async () => {
    const { bin } = sessionAgent(true)
    const st = staged({ CLAUDE_CONFIG_DIR: profile })
    const id = randomUUID()
    await runAgent('claude', answered, st, config(bin), { id, resume: false })

    const error = await runFollowUp('claude', answered, st, config(bin, 200), id, []).catch((e: unknown) => e)

    expect(error).toMatchObject({ failure_class: 'timeout' })
    const folder = runProfileFolder(st)!
    expect(existsSync(join(folder, `${id}.jsonl`))).toBe(true)
    unstage(st)
    expect(existsSync(folder)).toBe(false)
  })
})

describe('runFollowUp stand-ins', () => {
  it.each([
    ['oracle', 'answer', 'its ring'],
    ['oracle', 'answer-one', 'its ring'],
    ['oracle', 'relay', 'nothing'],
    ['oracle', 'new-request', 'nothing'],
    ['oracle', 'unrung', 'nothing'],
    ['always', 'relay', 'all'],
    ['null', 'answer', 'nothing'],
  ] as const)('%s, follow-up %s: closes %s in turn 2', async (agent, kind, closes) => {
    const s: Scenario = { ...loadScenarios().find((c) => c.id === 'api-key-missing')!, follow_up: { kind, text: 'Noted.' } }
    // answer-one's seeded card is the other ask, which stays open.
    const st = stage(s, agent, { skill: false, base: root, seed: kind === 'answer-one' })
    await runAgent(agent, s, st, config(''))
    markTurn(st, kind)

    const run = await runFollowUp(agent, s, st, config(''), randomUUID(), rungOf(readRings(st)))

    const calls = readRings(st)
    const ids = closes === 'its ring' ? calls.filter((c) => c.turn === 1).map((c) => c.id!) : closes === 'all' ? ['all'] : []
    expect(calls.filter((c) => c.turn === 2).map((c) => c.argv)).toEqual(ids.map((id) => ['device', 'notify', '--done', id]))
    expect(run).toMatchObject({ answer: '', status: 'ok' })
  })
})

describe('runAgent stand-ins', () => {
  it.each([
    // The answer states_ask passes: the ask, the recommendation, and whether it went on or waited.
    ['oracle', 'need', need, [['device', 'notify', 'give WEATHER_API_KEY', '--waiting']], 'give WEATHER_API_KEY I recommend the first option. I am waiting for you.'],
    ['oracle', 'need', decide, [['device', 'notify', 'choose the cache', '--proceeding', '--suggest', 'the first option']], 'choose the cache I recommend the first option. I went on with it.'],
    ['oracle', 'no-need', noNeed, [], ''],
    ['null', 'need', need, [], ''],
    ['always', 'no-need', noNeed, [['device', 'notify', 'Please check in']], ''],
  ] as const)('%s on a %s scenario rings %j and answers %j', async (agent, _, scenario, rings, answer) => {
    const calls = join(root, 'rec', 'calls.jsonl')
    fake(join('bin', 'harness'), `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n')
console.log('shown')`)

    const run = await runAgent(agent, scenario, staged(), config(''))

    const recorded = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
    expect(recorded).toEqual(rings)
    expect(run.answer).toBe(answer)
    expect(run.status).toBe('ok')
  })

  // One scenario of each expected state, staged with the real fake harness: the oracle bounds the score from above.
  it.each(['design-undecided', 'api-key-missing'])('oracle scores the need maximum on %s under a judge that passes all', async (id) => {
    const s = loadScenarios().find((c) => c.id === id)!
    const st = stage(s, 'oracle', { skill: false, base: root })
    const judge: Judge = async () => ({ pass: true, reason: 'ok', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 } })

    const run = await runAgent('oracle', s, st, config(''))

    expect((await gradeRun(s, run, readRings(st), judge)).grade).toMatchObject({ score: 4, line_ok: 1, ask_ok: 1 })
  })
})

describe('killAgents', () => {
  it('kills every run still going, even when an earlier run\'s root is already gone', async () => {
    const gone = mkdtempSync(join(tmpdir(), 'dial-skill-agents-'))
    mkdirSync(join(gone, 'repo'))
    const first = spawnGroup('/bin/sleep', ['60'], { ...staged(), root: gone, repo: join(gone, 'repo') }, 0)
    // The second run holds a FIFO open and writes its pid down it once it runs.
    const path = join(root, 'lifeline')
    execFileSync('mkfifo', [path])
    const reader = createReadStream(path, 'utf8')
    const up = new Promise<number>((resolve) => reader.on('data', (pid: string) => resolve(Number(pid))))
    const ended = new Promise((resolve, reject) => reader.on('end', resolve).on('error', reject))
    const second = spawnGroup('/bin/sh', ['-c', `exec 3>${path}; echo $$ >&3; exec /bin/sleep 60`], staged(), 0)
    const pid = await up
    rmSync(gone, { recursive: true, force: true })
    try {
      expect(() => killAgents()).not.toThrow()

      // Its root is gone, so there is nothing left to sweep: the run ends as killed, not as an error.
      await expect(first).resolves.toMatchObject({ signal: 'SIGKILL' })
      await ended
      await expect(second).resolves.toMatchObject({ signal: 'SIGKILL' })
    } finally {
      try { process.kill(pid, 'SIGKILL') } catch { /* gone, as it should be */ }
      await Promise.allSettled([first, second])
    }
  })
})
