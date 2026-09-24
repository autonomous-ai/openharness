import { describe, expect, it } from 'vitest'
import { gridSpawn, backHomeSpawn } from './gridArgv.js'
import { MockVersionSource, NpmVersionSource } from './versionSource.js'
import { compareVersions, planMatrixRuns } from './trigger.js'
import { sessionName } from './sessionName.js'
import { buildMatrixEntry } from './matrix.js'
import type { AgentEngine } from '../engines/types.js'
import { SMOKE_CHECKS, SCENARIO, LEGS, firstStuck, plannedLegs, quotaHit, scenarioFor, type CheckId } from './smokeChecks.js'
import { pickGridModel } from './gridSwitchDriver.js'
import { prepareWorkspace, readLog, logPath, readWorkspaceFile, preAcceptClaudeBypassMode, CALC_SH, CALC_MCP_MJS } from './workspace.js'
import { useByRef } from './sessionTools.js'
import { execFileSync } from 'node:child_process'
import { probeLeg, runCheck, dismissStartupDialogs, STARTUP_DIALOGS, type Tmux } from './paneProbe.js'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const GRID = {
  networkId: 'grid-1',
  networkName: 'someone-grid',
  baseUrl: 'https://grid.autonomous.ai/grid-1/relay/v1',
  apiKey: 'sk-probe',
  model: 'grid:gpt-5-mini',
}

describe('argv-package (spawn exactly like the harness)', () => {
  it('codex grid: provider argv + wire_api + clearEnv', () => {
    const spec = gridSpawn('codex', GRID, 'S1')
    expect('ok' in spec ? false : true).toBe(true) // not an error spec
    const s = spec as { command: string[]; env: Record<string, string>; clearEnv: string[] }
    expect(s.command[0]).toBe('codex')
    expect(s.command).toContain('resume') // codex resume <id>
    expect(s.command).toContain('S1')
    expect(s.command.join(' ')).toContain('model_provider="grid"')
    expect(s.command.join(' ')).toContain('model_providers.grid.wire_api="responses"')
    expect(s.command.join(' ')).toContain('https://grid.autonomous.ai/grid-1/relay/v1')
    expect(Object.keys(s.env).length).toBeGreaterThan(0) // the grid key goes in env, not argv
    expect(s.clearEnv.length).toBeGreaterThan(0)
  })

  it('claude grid: --resume + ANTHROPIC_BASE_URL env', () => {
    const spec = gridSpawn('claude', GRID, 'S1') as { command: string[]; env: Record<string, string> }
    expect(spec.command[0]).toBe('claude')
    expect(spec.command).toContain('--resume')
    expect(spec.env.ANTHROPIC_BASE_URL).toContain('grid.autonomous.ai/grid-1')
  })

  it('back home clears the grid env vars', () => {
    const spec = backHomeSpawn('claude', 'S1') as { clearEnv: string[] }
    expect(spec.clearEnv).toContain('ANTHROPIC_BASE_URL')
  })
})

describe('version source (mock first, npm later)', () => {
  it('mock returns fixtures offline', async () => {
    const src = new MockVersionSource()
    expect(await src.latestVersion('codex')).toBe('0.156.0')
    expect(await src.latestVersion('claude')).toBe('2.1.279')
  })

  it('npm impl reads the registry via fetch (stubbed)', async () => {
    let called = ''
    let sentInit: RequestInit | undefined
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      called = url
      sentInit = init
      return { ok: true, json: async () => ({ version: '9.9.9' }) } as unknown as Response
    }) as typeof fetch
    const src = new NpmVersionSource(fetchImpl)
    expect(await src.latestVersion('codex')).toBe('9.9.9')
    expect(called).toContain('@openai/codex')
    // No Accept header: `/latest` answers 406 to the abbreviated-metadata type, and the failure is
    // silent (latest=null reads as "nothing new"), so the request is pinned bare. See versionSource.
    expect(sentInit).toBeUndefined()
  })

  it('reads each engine\'s STABLE channel, and never a pre-release', async () => {
    const asked: string[] = []
    const answer = (version: string) => (async (url: string) => {
      asked.push(url)
      return { ok: true, json: async () => ({ version }) } as unknown as Response
    }) as typeof fetch
    expect(await new NpmVersionSource(answer('2.1.273')).latestVersion('claude')).toBe('2.1.273')
    expect(await new NpmVersionSource(answer('0.156.1')).latestVersion('codex')).toBe('0.156.1')
    // claude's stable is its own `stable` tag, not `latest` (its fast channel); codex's is `latest`.
    expect(asked).toEqual(['https://registry.npmjs.org/@anthropic-ai/claude-code/stable', 'https://registry.npmjs.org/@openai/codex/latest'])
    // Whatever tag it came from, a pre-release is never "the new version".
    for (const v of ['0.158.0-alpha.8', '2.1.300-beta.1', '1.0.0-rc.2', '0.1.2505172116-nightly']) {
      expect(await new NpmVersionSource(answer(v)).latestVersion('codex'), v).toBeNull()
    }
  })

  // A stub cannot catch a registry that refuses our headers, and that exact bug once kept the whole
  // pipeline quiet. This talks to npm for real, so it is opt-in: `RUN_REAL_NPM=1 vitest run src/e2e`.
  it.runIf(process.env.RUN_REAL_NPM === '1')('npm impl really answers for both engines', async () => {
    const src = new NpmVersionSource()
    for (const engine of ['codex', 'claude'] as const) {
      expect(await src.latestVersion(engine)).toMatch(/^\d+\.\d+\.\d+/)
    }
  }, 30_000)
})

describe('claude bypass-permissions warning (what killed a run once)', () => {
  it('accepts it in a config copy, is idempotent, and leaves an unreadable one alone', () => {
    const home = mkdtempSync(join(tmpdir(), 'wd-home-'))
    try {
      expect(preAcceptClaudeBypassMode(home)).toBe('skipped') // no ~/.claude.json at all
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { '/x': { allowedTools: [] } } }))
      expect(preAcceptClaudeBypassMode(home)).toBe('accepted')
      const after = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
      expect(after.bypassPermissionsModeAccepted).toBe(true)
      expect(after.projects['/x']).toEqual({ allowedTools: [] }) // nothing else touched
      expect(preAcceptClaudeBypassMode(home)).toBe('already')
      writeFileSync(join(home, '.claude.json'), 'not json')
      expect(preAcceptClaudeBypassMode(home)).toBe('skipped')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('the probe answers the warning by moving off the default "No, exit"', () => {
    const dialog = STARTUP_DIALOGS.find((d) => d.id === 'claude-bypass-accept')!
    expect(dialog.match.test('  WARNING: Claude Code running in Bypass Permissions mode')).toBe(true)
    expect(dialog.keys).toEqual(['Down', 'Enter'])
  })
})

describe('trigger (current vs latest)', () => {
  it('runs on upgrade, not on unchanged', async () => {
    const src = new MockVersionSource({ codex: '0.156.0', claude: '2.1.279' })
    const cur = {
      currentVersion: async (e: AgentEngine) => (e === 'codex' ? '0.155.1' : '2.1.279'),
    }
    const plans = await planMatrixRuns(src, cur, ['codex', 'claude'])
    const codex = plans.find((p) => p.engine === 'codex')!
    const claude = plans.find((p) => p.engine === 'claude')!
    expect(codex.plan).toBe(true)
    expect(codex.reason).toBe('upgrade')
    expect(claude.plan).toBe(false)
    expect(claude.reason).toBe('unchanged')
  })

  it('compares dotted numeric versions', () => {
    expect(compareVersions('0.155.0', '0.155.1')).toBe(-1)
    expect(compareVersions('0.156.0', '0.155.1')).toBe(1)
    expect(compareVersions('2.1.279', '2.1.279')).toBe(0)
  })
})

describe('session naming', () => {
  it('is namespaced and grep-able', () => {
    const name = sessionName({ engine: 'codex', version: '0.156.0', testcase: 'grid-switch', gridModel: 'grid:gpt-5-mini', at: new Date('2026-09-21T18:05:00Z') })
    expect(name).toMatch(/^codex@0\.156\.0->grid-switch@grid-gpt-5-mini--/)
  })
})

describe('matrix entry (dry run)', () => {
  it('emits argv + notify when not logged in', async () => {
    const plan = { engine: 'claude' as AgentEngine, current: '2.1.278', latest: '2.1.279', reason: 'upgrade' as const, plan: true }
    const entry = await buildMatrixEntry(plan, {
      status: async () => ({ binary: true, login: false, grid: true }),
      grid: async () => null,
      at: new Date('2026-09-21T18:05:00Z'),
    })
    expect(entry.session).toContain('claude@2.1.279')
    expect(entry.notify.join(' ')).toMatch(/NOT_LOGGED_IN/)
    expect(entry.status.login).toBe(false)
    expect(entry.subscriptionModel).toBe('claude-sonnet-5')
    // Dry run: the journey is planned, nothing typed yet.
    expect(entry.legs.map((l) => l.leg)).toEqual(['subscription', 'grid'])
    expect(entry.legs.flatMap((l) => l.checks).every((c) => c.status === 'not-run')).toBe(true)
  })

  it('uses the fixed models for the subscription leg', async () => {
    const src = new MockVersionSource({ codex: '0.156.0' })
    const plans = await planMatrixRuns(src, { currentVersion: async () => '0.155.0' }, ['codex'])
    const entry = await buildMatrixEntry(plans[0], {
      status: async () => ({ binary: true, login: true, grid: true }),
      grid: async () => null,
    })
    expect(entry.subscriptionModel).toBe('gpt-5.5')
  })
})

describe('scenario (what a person does, on each side of the switch)', () => {
  it('the same five plain requests on each side — bash, read, write, edit, MCP — with nothing shared', () => {
    expect(LEGS).toEqual(['subscription', 'grid'])
    for (const leg of LEGS) expect(SCENARIO[leg].map((c) => c.id)).toEqual(['bash', 'read', 'write', 'edit', 'mcp'])
    // Nothing the first side leaves behind can pass the second: its own numbers and its own files.
    const patterns = SMOKE_CHECKS.filter((c) => c.logPattern).map((c) => c.logPattern)
    expect(new Set(patterns).size).toBe(patterns.length)
    const files = SMOKE_CHECKS.map((c) => c.answerFromFile ?? c.file?.path).filter(Boolean)
    expect(new Set(files).size).toBe(files.length)
    expect(plannedLegs().flatMap((l) => l.checks).every((c) => c.status === 'not-run')).toBe(true)
  })

  it('every prompt is a plain request, and never contains its own proof', () => {
    for (const c of SMOKE_CHECKS) {
      expect(c.prompt).not.toMatch(/reply with exactly|<result>|RECALL_|TOOL_|MCP_/i)
      if (c.logPattern) expect(c.prompt).not.toContain(c.logPattern) // "add 40 2" is asked; "= 42" is only the log's
      expect(!!c.log || !!c.answerFromFile || !!c.file).toBe(true) // proven by the machine, never by the reply
      // The result is what is tested, not the route: no request tells the engine which tool to use.
      expect(c.prompt).not.toMatch(/\b(Bash|Read|Write|Edit) tool\b|apply_patch|in the shell/)
    }
    // And every engine gets the same words.
    expect(scenarioFor('codex')).toEqual(scenarioFor('claude'))
  })

  it('firstStuck names the first leg/step that did not pass', () => {
    const legs = plannedLegs()
    legs[0].checks.forEach((c) => (c.status = 'ok'))
    legs[1].checks[0].status = 'ok'
    legs[1].checks[1].status = 'stuck'
    expect(firstStuck(legs)).toEqual({ leg: 'grid', check: 'read', status: 'stuck' })
    legs.forEach((l) => l.checks.forEach((c) => (c.status = 'ok')))
    expect(firstStuck(legs)).toBeNull()
  })
})

/** A pane that answers each typed prompt with `reply(prompt)` on the next capture. */
function fakePane(reply: (prompt: string) => string | null): Tmux & { typed: string[] } {
  let screen = '> '
  let clock = 0
  const typed: string[] = []
  return {
    typed,
    async capture() {
      return screen
    },
    async type(_pane, text) {
      typed.push(text)
      screen += `\n> ${text}`
      const r = reply(text)
      if (r !== null) screen += `\n${r}`
    },
    async key(_pane, key) {
      typed.push(`<${key}>`)
      // Any key answers a dialog: the dialog text leaves the screen.
      screen = screen.replace(/Update available![^\n]*\n?/, '').replace(/Do you trust[^\n]*\n?/, '')
    },
    async sleep(ms) {
      clock += ms
    },
    now: () => clock,
  }
}

/** A tool/MCP log that gains a line whenever the fake tool "uses" it. */
function fakeLogs() {
  const lines: Record<'tool' | 'mcp', string[]> = { tool: [], mcp: [] }
  return { lines, readLog: (k: 'tool' | 'mcp') => [...lines[k]] }
}

/**
 * A fake coding tool on a fake machine: it does what each of the five requests asks — runs the
 * script (a log line), reads the file, writes it, edits it, calls the MCP server (a log line). With
 * `lie`, it only SAYS it did those steps, which is the case the proofs exist for.
 */
function fakeAgent(opts: { lie?: CheckId[] } = {}) {
  const files: Record<string, string> = {
    'notes/secret-1.txt': 'kiwi-4821-tulip\n', 'notes/secret-2.txt': 'otter-1234-ember\n',
    'notes/todo-1.txt': '# todo 1\nstatus: pending\n', 'notes/todo-2.txt': '# todo 2\nstatus: pending\n',
  }
  const logs = fakeLogs()
  const lie = new Set(opts.lie ?? [])
  const reply = (p: string): string | null => {
    let m: RegExpMatchArray | null
    if ((m = p.match(/tools\/calc\.sh add (\d+) (\d+)/))) {
      if (!lie.has('bash')) logs.lines.tool.push(`t add ${m[1]} ${m[2]} = ${+m[1] + +m[2]}`)
      return `The result is ${+m[1] + +m[2]}.`
    }
    if ((m = p.match(/Read (notes\/secret-\d\.txt)/))) return lie.has('read') ? 'It says hello.' : `It says: ${files[m[1]].trim()}`
    if ((m = p.match(/Create the file (\S+) with this text: (.*) \(ref-/))) {
      if (!lie.has('write')) files[m[1]] = `${m[2]}\n`
      return 'Done.'
    }
    if ((m = p.match(/In (\S+), change pending to done/))) {
      if (!lie.has('edit')) files[m[1]] = files[m[1]].replace('pending', 'done')
      return 'Updated.'
    }
    if ((m = p.match(/e2e_calc to add (\d+) and (\d+)/))) {
      if (!lie.has('mcp')) logs.lines.mcp.push(`t add ${m[1]} ${m[2]} = ${+m[1] + +m[2]}`)
      return `${+m[1] + +m[2]}`
    }
    return null
  }
  const pane = fakePane(reply)
  const probe = { settleMs: 1, pollMs: 1, checkTimeoutMs: 5_000, readLog: logs.readLog, readFile: (f: string) => files[f] ?? null }
  return { pane, files, logs, probe }
}

const BASH_STEP = SCENARIO.subscription[0]
const READ_STEP = SCENARIO.subscription[1]

describe('pane probe (live steps on a tmux pane)', () => {
  it('a tool that really does the five requests passes both sides, and each proof is recorded', async () => {
    const { pane, probe, files } = fakeAgent()
    const own = await probeLeg(pane, '%1', 'subscription', probe)
    const grid = await probeLeg(pane, '%1', 'grid', probe)
    expect(own.checks.map((c) => `${c.id}=${c.status}`)).toEqual(['bash=ok', 'read=ok', 'write=ok', 'edit=ok', 'mcp=ok'])
    expect(grid.checks.map((c) => `${c.id}=${c.status}`)).toEqual(['bash=ok', 'read=ok', 'write=ok', 'edit=ok', 'mcp=ok'])
    expect(own.checks[0].logLines).toEqual(['t add 40 2 = 42'])
    expect(grid.checks[4].logLines).toEqual(['t add 60 18 = 78'])
    expect(files['out/hello-2.txt']).toBe('hello from step 2\n')
    expect(files['notes/todo-1.txt']).toContain('status: done')
    // Every step carries the tag its prompt was typed with — how its tools are found afterwards.
    expect([...own.checks, ...grid.checks].every((c) => /^ref-[0-9a-z]{6}$/.test(c.ref ?? ''))).toBe(true)
  })

  it('saying is not doing: each step fails when the tool only claims it, with what was missing', async () => {
    const notes: Record<CheckId, RegExp> = {
      bash: /no tool log line for "add 40 2 = 42"/,
      read: /notes\/secret-1\.txt's token never appeared/,
      write: /out\/hello-1\.txt does not exist/,
      edit: /notes\/todo-1\.txt is "# todo 1\\nstatus: pending"/,
      mcp: /no mcp log line for "add 30 12 = 42"/,
    }
    for (const step of SCENARIO.subscription) {
      const { pane, probe } = fakeAgent({ lie: [step.id] })
      const out = await runCheck(pane, '%1', step, probe)
      expect(out.status, step.id).toBe('stuck')
      expect(out.note, step.id).toMatch(notes[step.id])
    }
  })

  it('read: the token must come after THIS question — one already on screen is no proof', async () => {
    const { pane, probe } = fakeAgent({ lie: ['read'] })
    await pane.type('%1', 'kiwi-4821-tulip') // on screen before the question was asked
    expect((await runCheck(pane, '%1', READ_STEP, probe)).status).toBe('stuck')
  })

  it('write: the exact text, not merely a file', async () => {
    const { pane, probe, files } = fakeAgent({ lie: ['write'] })
    files['out/hello-1.txt'] = 'hello from step one\n'
    const out = await runCheck(pane, '%1', SCENARIO.subscription[2], probe)
    expect(out.status).toBe('stuck')
    expect(out.note).toBe('out/hello-1.txt is "hello from step one"')
  })

  it('read with no secret file in the workspace is the run\'s setup failing, said as such', async () => {
    const { pane, probe } = fakeAgent()
    const out = await runCheck(pane, '%1', READ_STEP, { ...probe, readFile: () => null })
    expect(out.status).toBe('stuck')
    expect(out.note).toMatch(/the run's setup, not the tool/)
    expect(pane.typed).toHaveLength(0) // nothing typed for a step that cannot be proven
  })

  it('out of usage is recognised at once, with its reset time, instead of waiting out the step', async () => {
    // What each tool really prints — codex and claude, from their own binaries.
    const cases: Array<[string, string | null]> = [
      ["■ You've hit your usage limit. Upgrade to Pro, or try again at Sep 24th, 2026 6:02 PM.", 'try again at Sep 24th, 2026 6:02 PM'],
      ["You've hit your session limit · resets 6pm", 'resets 6pm'],
      ["You’ve hit your weekly limit · resets Mon 9am", 'resets Mon 9am'],
      ["You're out of usage credits. /model to switch models.", null],
    ]
    for (const [said, resets] of cases) {
      const pane = fakePane(() => said)
      const out = await runCheck(pane, '%1', BASH_STEP, { settleMs: 1, pollMs: 1, checkTimeoutMs: 120_000 })
      expect(out.status, said).toBe('no-quota')
      expect(out.resets ?? null, said).toBe(resets)
      expect(out.elapsedMs!, said).toBeLessThan(10) // one poll, not the whole budget
    }
    // Claude's early warning is not the limit: the step carries on and passes.
    const logs = fakeLogs()
    const warned = fakePane(() => { logs.lines.tool.push('t add 40 2 = 42'); return 'Approaching usage limit · resets 6pm\n42' })
    expect((await runCheck(warned, '%1', BASH_STEP, { settleMs: 1, pollMs: 1, readLog: logs.readLog })).status).toBe('ok')
  })

  it('an old limit message already on screen does not count against a new request', async () => {
    const { pane, probe } = fakeAgent()
    await pane.type('%1', "You've hit your session limit · resets 6pm") // yesterday's, still in the scrollback
    pane.typed.length = 0
    expect((await runCheck(pane, '%1', BASH_STEP, probe)).status).toBe('ok')
  })

  it('out of usage ends the leg: nothing more is typed into an account that cannot answer', async () => {
    const pane = fakePane(() => "You've hit your usage limit. try again at 6:02 PM.")
    const leg = await probeLeg(pane, '%1', 'subscription', { settleMs: 1, pollMs: 1 })
    expect(leg.checks.map((c) => `${c.id}=${c.status}`)).toEqual(['bash=no-quota', 'read=not-run', 'write=not-run', 'edit=not-run', 'mcp=not-run'])
    expect(pane.typed).toHaveLength(1)
    expect(quotaHit([leg])).toEqual({ leg: 'subscription', check: 'bash', resets: 'try again at 6:02 PM' })
  })

  it('answers codex 0.156\'s stacked startup screens — the one on top first, each once', async () => {
    const { pane, probe } = fakeAgent()
    // What the pane held on grid-dev: the hooks review, and the model notice drawn under it.
    await pane.type('%1', 'Hooks need review\n  2 hooks are new or changed.\n›    Review hooks\n     Trust all and continue')
    await pane.type('%1', 'GPT-5.5 retires on October 14, 2026. Switch to GPT-5.6 Sol to continue working in Codex.\n› 1. Try new model\n  2. Use existing model')
    pane.typed.length = 0
    const answered = await dismissStartupDialogs(pane, '%1', { settleMs: 1, pollMs: 1 })
    expect(answered).toEqual(['codex-model-retire', 'codex-hooks-trust'])
    expect(pane.typed).toEqual(['<2>', '<Enter>', '<Down>', '<Enter>'])
    // And the step typed after them is not disturbed by their text still being in the scrollback.
    pane.typed.length = 0
    expect((await runCheck(pane, '%1', BASH_STEP, probe)).status).toBe('ok')
    expect(pane.typed).toHaveLength(1)
  })

  it('types the request again when a tool that is still loading dropped it', async () => {
    const { pane, probe } = fakeAgent()
    // The first paste vanishes, the way claude's first question did on grid-dev; the second lands.
    const realType = pane.type.bind(pane)
    let dropped = false
    pane.type = async (id, text) => { if (!dropped) { dropped = true; pane.typed.push(text); return } await realType(id, text) }
    // The real per-step budget: the 5s spent seeing whether the first paste landed comes out of it.
    const out = await runCheck(pane, '%1', BASH_STEP, { ...probe, pollMs: 100, checkTimeoutMs: 120_000 })
    expect(out.status).toBe('ok')
    expect(pane.typed).toHaveLength(2) // typed, not seen, typed again
    expect(pane.typed[0]).toBe(pane.typed[1]) // the same request with the same tag
  })

  it('answers claude 2.1.281\'s reworded folder trust by moving off its "No, exit" default', async () => {
    const pane = fakePane(() => null)
    await pane.type('%1', 'Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder')
    pane.typed.length = 0
    expect(await dismissStartupDialogs(pane, '%1', { settleMs: 1, pollMs: 1 })).toEqual(['claude-trust-v2'])
    expect(pane.typed).toEqual(['<Down>', '<Enter>'])
  })

  it('a step that is not proven stops the leg there: nothing more is typed after it', async () => {
    const { pane, probe } = fakeAgent({ lie: ['write'] })
    const leg = await probeLeg(pane, '%1', 'subscription', { ...probe, checkTimeoutMs: 5 })
    expect(leg.checks.map((c) => `${c.id}=${c.status}`)).toEqual(['bash=ok', 'read=ok', 'write=stuck', 'edit=not-run', 'mcp=not-run'])
    expect(pane.typed).toHaveLength(3)
  })

  it('answers a startup dialog (codex update → Skip) before typing the first request, and records it', async () => {
    const { pane, probe } = fakeAgent()
    // What a fresh codex shows before its prompt; a request typed here would pick "1. Update now".
    await pane.type('%1', 'Update available! 0.155.0 -> 0.155.1  › 1. Update now  2. Skip  Press enter to continue')
    pane.typed.length = 0
    const leg = await probeLeg(pane, '%1', 'subscription', probe)
    expect(pane.typed.slice(0, 2)).toEqual(['<2>', '<Enter>'])
    expect(pane.typed[2]).toContain(BASH_STEP.prompt)
    expect(leg.dialogs).toEqual(['codex-update'])
    expect(leg.checks.every((c) => c.status === 'ok')).toBe(true)
    expect(await dismissStartupDialogs(pane, '%1', { settleMs: 1 })).toEqual([]) // nothing left on screen
  })
})

describe('session tools and models (read from the engine\'s own session file)', () => {
  // Records shaped exactly like the real ones — a codex 0.156.1 rollout and a claude 2.1.273
  // session from grid-dev, 2026-09-24 — trimmed to the fields that matter.
  it('codex: code-mode exec calls, classic calls, a namespaced MCP call, and each turn\'s model', () => {
    const home = mkdtempSync(join(tmpdir(), 'wd-sess-'))
    try {
      const dir = join(home, '.codex', 'sessions', '2026', '09', '24')
      mkdirSync(dir, { recursive: true })
      const rec = (o: object) => JSON.stringify(o)
      const user = (t: string) => rec({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] } })
      writeFileSync(join(dir, 'rollout-x.jsonl'), [
        rec({ type: 'turn_context', payload: { model: 'gpt-6-luna' } }), // written BEFORE the turn's message
        user('Run tools/calc.sh add 40 2 and tell me the result. (ref-aaaaaa)'),
        rec({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'const r = await tools.exec_command({cmd:"tools/calc.sh add 40 2"})' } }),
        rec({ type: 'turn_context', payload: { model: 'DeepSeek-V4-Flash-0731' } }),
        user('Use the MCP server e2e_calc to add 60 and 18. (ref-bbbbbb)'),
        rec({ type: 'response_item', payload: { type: 'function_call', name: 'sub', namespace: 'mcp__e2e_calc', arguments: '{}' } }),
        rec({ type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', arguments: '{}' } }),
      ].join('\n'))
      expect(useByRef('codex', '/unused', ['ref-aaaaaa', 'ref-bbbbbb'], home)).toEqual({
        'ref-aaaaaa': { tools: ['exec→exec_command'], models: ['gpt-6-luna'] },
        'ref-bbbbbb': { tools: ['mcp__e2e_calc__sub', 'apply_patch'], models: ['DeepSeek-V4-Flash-0731'] },
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('claude: tool_use names per step, ToolSearch included, and the model of every reply', () => {
    const home = mkdtempSync(join(tmpdir(), 'wd-sess-'))
    try {
      const cwd = '/tmp/grid-matrix-out/agents/claude@2.1.273->grid-switch@none--20260924T081321Z'
      const dir = join(home, '.claude', 'projects', '-tmp-grid-matrix-out-agents-claude-2-1-273--grid-switch-none--20260924T081321Z')
      mkdirSync(dir, { recursive: true })
      const rec = (o: object) => JSON.stringify(o)
      const reply = (model: string, ...tools: string[]) => rec({ type: 'assistant', message: { model, content: tools.map((name) => ({ type: 'tool_use', name, input: {} })) } })
      writeFileSync(join(dir, 's.jsonl'), [
        rec({ type: 'user', message: { role: 'user', content: 'Read notes/secret-1.txt and tell me what it says. (ref-cccccc)' } }),
        reply('claude-haiku-4-5-20251001', 'Read'),
        rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'kiwi-4821-tulip' }] } }),
        reply('claude-haiku-4-5-20251001'),
        rec({ type: 'user', message: { role: 'user', content: 'Use the MCP server e2e_calc to add 30 and 12. (ref-dddddd)' } }),
        reply('DeepSeek-V4-Flash-0731', 'ToolSearch'),
        reply('DeepSeek-V4-Flash-0731', 'mcp__e2e_calc__add'),
        reply('<synthetic>'),
      ].join('\n'))
      expect(useByRef('claude', cwd, ['ref-cccccc', 'ref-dddddd'], home)).toEqual({
        'ref-cccccc': { tools: ['Read'], models: ['claude-haiku-4-5-20251001'] },
        'ref-dddddd': { tools: ['ToolSearch', 'mcp__e2e_calc__add'], models: ['DeepSeek-V4-Flash-0731'] },
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('grid model pick (live)', () => {
  it('takes the smallest model on any listed grid, own grid first, even when the top-level list is empty', () => {
    const pick = pickGridModel({
      gridName: 'mine',
      models: [],
      localModelEngines: null,
      grids: [
        { name: 'mine', own: true, models: [] },
        { name: 'autonomous.ai', own: false, models: [
          { id: 'DeepSeek-V4-Flash-0731', node: 'a' },
          { id: 'Qwen/Qwen3.8-27B', node: 'b' },
          { id: 'Qwen3.6-35B-A3B', node: 'c' },
          { id: 'gemma-4-31B-it', node: 'd' },
        ] },
      ],
    })
    expect(pick).toEqual({ model: 'Qwen/Qwen3.8-27B', gridName: 'autonomous.ai' })
    expect(pickGridModel({ gridName: null, models: [], grids: [], localModelEngines: null })).toBeNull()
  })
})

describe('workspace (the person\'s project the agent is created in)', () => {
  it('lays out the script tool, the MCP config for the engine, and the logs the steps are proven by', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wd-ws-'))
    try {
      // A stand-in for the codex binary: it records the argv it was called with and answers
      // `mcp list` the way a codex that accepted the registration would.
      const codexBin = join(cwd, 'fake-codex')
      const argvLog = join(cwd, 'fake-codex.log')
      writeFileSync(codexBin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(argvLog)}\n[ "$2" = list ] && echo "e2e_calc node /x/calc-mcp.mjs"\nexit 0\n`)
      chmodSync(codexBin, 0o755)
      const laid = prepareWorkspace(cwd, 'codex', { codexBin })
      // The read / write / edit steps' files: a fresh unguessable secret per side, a todo to edit.
      const secrets = [1, 2].map((n) => readWorkspaceFile(cwd, `notes/secret-${n}.txt`)?.trim() ?? '')
      for (const t of secrets) expect(t).toMatch(/^[a-z]+-\d{4}-[a-z]+$/)
      expect(secrets[0]).not.toBe(secrets[1])
      expect(readWorkspaceFile(cwd, 'notes/todo-1.txt')).toContain('status: pending')
      expect(existsSync(join(cwd, 'out'))).toBe(true)
      expect(readWorkspaceFile(cwd, 'out/hello-1.txt')).toBeNull() // written by the step, never by us
      // Fresh per run: two workspaces never share a secret.
      const other = mkdtempSync(join(tmpdir(), 'wd-ws-'))
      prepareWorkspace(other, 'claude')
      expect(readWorkspaceFile(other, 'notes/secret-1.txt')).not.toBe(readWorkspaceFile(cwd, 'notes/secret-1.txt'))
      rmSync(other, { recursive: true, force: true })
      // The registration is codex's own command, with the server and its log as argv — and a stale
      // entry is removed before the add, so an interrupted run cannot leave one behind.
      const calls = readFileSync(argvLog, 'utf8').trim().split('\n')
      expect(calls[0]).toBe('mcp remove e2e_calc')
      expect(calls[1]).toBe(`mcp add e2e_calc -- node ${laid.mcpServer} ${logPath(cwd, 'mcp')}`)
      expect(calls[2]).toBe('mcp list')
      expect(existsSync(join(cwd, 'tools', 'calc.sh'))).toBe(true)
      // The strings shipped in the bundle are the files in workspace/, byte for byte.
      expect(CALC_SH).toBe(readFileSync(join(__dirname, 'workspace', 'calc.sh'), 'utf8'))
      expect(CALC_MCP_MJS).toBe(readFileSync(join(__dirname, 'workspace', 'calc-mcp.mjs'), 'utf8'))
      expect(existsSync(join(cwd, 'tools', 'calc-mcp.mjs'))).toBe(true)
      // codex has no project-level MCP config — a `<cwd>/.codex/config.toml` is never read (measured:
      // `codex mcp list` inside such a workspace does not list the server), so the workspace must not
      // pretend otherwise. Registration goes through `codex mcp add`, which this test does not run:
      // it would write the developer's own ~/.codex/config.toml. What is pinned is that the run says
      // out loud which of the two happened.
      expect(existsSync(join(cwd, '.codex', 'config.toml'))).toBe(false)
      expect(laid.mcpConfig === null || laid.mcpConfig.endsWith(join('.codex', 'config.toml'))).toBe(true)
      expect(laid.mcpNote).toMatch(laid.mcpConfig ? /codex mcp add/ : /codex mcp add failed/)
      // The script answers and leaves its line in the tool log.
      expect(execFileSync('sh', [join(cwd, 'tools', 'calc.sh'), 'add', '40', '2']).toString().trim()).toBe('42')
      expect(readLog(cwd, 'tool').at(-1)).toContain('add 40 2 = 42')
      // The MCP server answers tools/call and leaves its line in the MCP log.
      const rpc = ['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}', '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"sub","arguments":{"a":60,"b":18}}}'].join('\n') + '\n'
      const out = execFileSync('node', [laid.mcpServer, logPath(cwd, 'mcp')], { input: rpc }).toString()
      expect(out).toContain('"text":"42"')
      expect(readLog(cwd, 'mcp').at(-1)).toContain('sub 60 18 = 42')
      // claude gets .mcp.json instead.
      const claude = prepareWorkspace(cwd, 'claude')
      expect(JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8')).mcpServers.e2e_calc.command).toBe('node')
      // The note carries the other half of what was measured: claude reads .mcp.json, but only a
      // `full` agent may call the server's tools.
      expect(claude.mcpConfig).toBe(join(cwd, '.mcp.json'))
      expect(claude.mcpNote).toContain('full')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
