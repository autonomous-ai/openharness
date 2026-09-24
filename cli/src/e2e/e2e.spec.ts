import { describe, expect, it } from 'vitest'
import { gridSpawn, backHomeSpawn } from './gridArgv.js'
import { MockVersionSource, NpmVersionSource } from './versionSource.js'
import { compareVersions, planMatrixRuns } from './trigger.js'
import { sessionName } from './sessionName.js'
import { buildMatrixEntry } from './matrix.js'
import type { AgentEngine } from '../engines/types.js'
import { SMOKE_CHECKS, SCENARIO, LEGS, firstStuck, plannedLegs, quotaHit } from './smokeChecks.js'
import { pickGridModel } from './gridSwitchDriver.js'
import { prepareWorkspace, readLog, logPath, preAcceptClaudeBypassMode, CALC_SH, CALC_MCP_MJS } from './workspace.js'
import { execFileSync } from 'node:child_process'
import { probeLeg, runCheck, dismissStartupDialogs, STARTUP_DIALOGS, type Tmux } from './paneProbe.js'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs'
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
    expect(entry.legs.map((l) => l.leg)).toEqual(['subscription', 'grid', 'back-home'])
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

describe('scenario (one conversation carried across the switch)', () => {
  it('uses the script tool and the MCP server on every leg, and recalls the start after each switch', () => {
    expect(LEGS).toEqual(['subscription', 'grid', 'back-home'])
    expect(SCENARIO.subscription.map((c) => c.id)).toEqual(['tool', 'mcp'])
    expect(SCENARIO.grid.map((c) => c.id)).toEqual(['recall', 'tool', 'mcp'])
    expect(SCENARIO['back-home'].map((c) => c.id)).toEqual(['recall', 'tool', 'mcp'])
    for (const c of SMOKE_CHECKS) if (c.id !== 'recall') expect(c.log && c.logPattern).toBeTruthy()
    expect(plannedLegs().flatMap((l) => l.checks).every((c) => c.status === 'not-run')).toBe(true)
  })

  it('no prompt can satisfy its own marker (echo of the typed line is not a pass)', () => {
    for (const c of SMOKE_CHECKS) expect(new RegExp(c.marker).test(c.prompt)).toBe(false)
  })

  it('firstStuck names the first leg/step that did not pass', () => {
    const legs = plannedLegs()
    legs[0].checks.forEach((c) => (c.status = 'ok'))
    legs[1].checks[0].status = 'ok'
    legs[1].checks[1].status = 'stuck'
    expect(firstStuck(legs)).toEqual({ leg: 'grid', check: 'tool', status: 'stuck' })
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

const TOOL_STEP = SCENARIO.subscription[0]
const MCP_STEP = SCENARIO.subscription[1]

describe('pane probe (live steps on a tmux pane)', () => {
  it('passes a step when the marker shows up after the prompt AND the tool log gained the line', async () => {
    const logs = fakeLogs()
    const pane = fakePane((p) => {
      if (p.includes('calc.sh')) logs.lines.tool.push('2026-09-22T06:00:00Z add 40 2 = 42')
      return 'TOOL_42'
    })
    const out = await runCheck(pane, '%1', TOOL_STEP, { settleMs: 1, pollMs: 1, readLog: logs.readLog })
    expect(out.status).toBe('ok')
    expect(out.logLines).toEqual(['2026-09-22T06:00:00Z add 40 2 = 42'])
    expect(pane.typed[0]).toMatch(new RegExp(`^${TOOL_STEP.prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(ref-[0-9a-z]{6}\\)$`))
  })

  it('a marker WITHOUT a new log line is stuck: it answered from memory instead of using the MCP', async () => {
    const logs = fakeLogs()
    const pane = fakePane(() => 'MCP_42')
    const out = await runCheck(pane, '%1', MCP_STEP, { settleMs: 1, pollMs: 1, readLog: logs.readLog })
    expect(out.status).toBe('stuck')
    expect(out.note).toContain('mcp log gained no line')
    expect(out.logLines).toEqual([])
  })

  it('after a resume redraws the previous leg\'s answer, only a marker after THIS prompt\'s echo counts', async () => {
    const recall = SCENARIO.grid[0]
    // Screen after a resume: an old turn with the same marker is back on screen; the new prompt gets no reply.
    const pane = fakePane(() => null)
    await pane.type('%1', 'What was the very first calculation … (ref-old000)')
    await pane.type('%1', 'RECALL_40+2')
    pane.typed.length = 0
    const stuck = await runCheck(pane, '%1', recall, { settleMs: 1, pollMs: 1, checkTimeoutMs: 5 })
    expect(stuck.status).toBe('stuck')
    // Same screen, but the tool answers the new prompt: passes.
    const answering = fakePane((p) => (p.includes('ref-') ? 'RECALL_40+2' : null))
    await answering.type('%1', 'What was the very first calculation … (ref-old000)')
    await answering.type('%1', 'RECALL_40+2')
    const ok = await runCheck(answering, '%1', recall, { settleMs: 1, pollMs: 1, checkTimeoutMs: 5 })
    expect(ok.status).toBe('ok')
  })

  it('out of usage is recognised at once, with its reset time, instead of waiting 90s to be called stuck', async () => {
    // What each tool really prints — codex and claude, from their own binaries.
    const cases: Array<[string, string | null]> = [
      ["■ You've hit your usage limit. Upgrade to Pro, or try again at Sep 24th, 2026 6:02 PM.", 'try again at Sep 24th, 2026 6:02 PM'],
      ["You've hit your session limit \u00b7 resets 6pm", 'resets 6pm'],
      ["You\u2019ve hit your weekly limit \u00b7 resets Mon 9am", 'resets Mon 9am'],
      ["You're out of usage credits. /model to switch models.", null],
    ]
    for (const [said, resets] of cases) {
      const pane = fakePane(() => said)
      const out = await runCheck(pane, '%1', TOOL_STEP, { settleMs: 1, pollMs: 1, checkTimeoutMs: 90_000 })
      expect(out.status, said).toBe('no-quota')
      expect(out.resets ?? null, said).toBe(resets)
      expect(out.elapsedMs!, said).toBeLessThan(10) // one poll, not the 90s budget
    }
    // Claude's early warning is not the limit: the step carries on and passes.
    const logs = fakeLogs()
    const warned = fakePane(() => { logs.lines.tool.push('t add 40 2 = 42'); return 'Approaching usage limit \u00b7 resets 6pm\nTOOL_42' })
    expect((await runCheck(warned, '%1', TOOL_STEP, { settleMs: 1, pollMs: 1, readLog: logs.readLog })).status).toBe('ok')
  })

  it('an old limit message already on screen does not count against a new prompt', async () => {
    const logs = fakeLogs()
    const pane = fakePane((p) => { if (p.includes('calc.sh')) { logs.lines.tool.push('t add 40 2 = 42'); return 'TOOL_42' } return null })
    await pane.type('%1', "You've hit your session limit \u00b7 resets 6pm") // yesterday's, still in the scrollback
    pane.typed.length = 0
    expect((await runCheck(pane, '%1', TOOL_STEP, { settleMs: 1, pollMs: 1, readLog: logs.readLog })).status).toBe('ok')
  })

  it('out of usage ends the leg: nothing more is typed into an account that cannot answer', async () => {
    const pane = fakePane(() => "You've hit your usage limit. try again at 6:02 PM.")
    const leg = await probeLeg(pane, '%1', 'subscription', { settleMs: 1, pollMs: 1 })
    expect(leg.checks.map((c) => `${c.id}=${c.status}`)).toEqual(['tool=no-quota', 'mcp=not-run'])
    expect(pane.typed).toHaveLength(1)
    expect(quotaHit([leg])).toEqual({ leg: 'subscription', check: 'tool', resets: 'try again at 6:02 PM' })
  })

  it('marks a step stuck when the pane never shows the marker, and stops the leg there', async () => {
    const logs = fakeLogs()
    const pane = fakePane((p) => {
      if (p.includes('calc.sh')) { logs.lines.tool.push('t add 40 2 = 42'); return 'TOOL_42' }
      return 'I do not see an MCP server named e2e_calc.'
    })
    const leg = await probeLeg(pane, '%1', 'subscription', { settleMs: 1, pollMs: 1, checkTimeoutMs: 5, readLog: logs.readLog })
    expect(leg.checks.map((c) => `${c.id}=${c.status}`)).toEqual(['tool=ok', 'mcp=stuck'])
    expect(leg.checks[1].tail).toContain('I do not see an MCP server named e2e_calc.')
    expect(pane.typed).toHaveLength(2)
  })

  it('answers a startup dialog (codex update → Skip) before typing the first step, and records it', async () => {
    const logs = fakeLogs()
    const pane = fakePane((p) => {
      if (p.includes('calc.sh')) { logs.lines.tool.push('t add 40 2 = 42'); return 'TOOL_42' }
      if (p.includes('e2e_calc')) { logs.lines.mcp.push('t add 30 12 = 42'); return 'MCP_42' }
      return null
    })
    // What a fresh codex shows before its prompt; a step typed here would pick "1. Update now".
    await pane.type('%1', 'Update available! 0.155.0 -> 0.155.1  › 1. Update now  2. Skip  Press enter to continue')
    pane.typed.length = 0
    const leg = await probeLeg(pane, '%1', 'subscription', { settleMs: 1, pollMs: 1, readLog: logs.readLog })
    expect(pane.typed.slice(0, 2)).toEqual(['<2>', '<Enter>'])
    expect(pane.typed[2]).toContain(TOOL_STEP.prompt)
    expect(leg.dialogs).toEqual(['codex-update'])
    expect(leg.checks.every((c) => c.status === 'ok')).toBe(true)
    expect(await dismissStartupDialogs(pane, '%1', { settleMs: 1 })).toEqual([]) // nothing left on screen
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
