/**
 * How the core asks which OpenCode is installed when an agent is asked for as a named agent, recorded from main
 * before OpenCode's version probe left the core's static imports (docs/design/2026-10-08-other-engines-out-of-
 * core.md, (o6)). Through the core's own entry for `agent_create` (`createLaunchRequests`), with OpenCode's real
 * probe run against an installed v1, an installed v2 and none at all: v2's TUI exits on `--agent`, so it is
 * refused before any pane exists, and every other engine is answered without asking.
 *
 * The OpenCode binaries are scripts under a throwaway root (`OPENCODE_PATH`), every home is pinned through the
 * environment, `TZ` is UTC, and no path's length matters. Results name the root `<root>`. The argv each launch
 * is built with is (c1)'s launchArgv.golden.spec.ts. `RECORD_OTHER_ENGINES_GOLDEN=1` writes the fixture.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const GOLDEN = fileURLToPath(new URL('./__fixtures__/other-launch.golden.json', import.meta.url))
const RECORD = process.env.RECORD_OTHER_ENGINES_GOLDEN === '1'

let root = ''
let golden: Record<string, unknown> = {}
const recorded: Record<string, unknown> = {}
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null).split(root).join('<root>'))
function check(key: string, value: unknown): void {
  const result = normalize(value)
  recorded[key] = result
  if (!RECORD) expect({ key, result }).toEqual({ key, result: golden[key] })
}

const saved: Record<string, string | undefined> = {}
function setEnv(values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (!(name in saved)) saved[name] = process.env[name]
    if (value === undefined) delete process.env[name]; else process.env[name] = value
  }
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'other-launch-golden-')))
  const home = join(root, 'home')
  setEnv({
    HOME: home, ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_RUNTIME_DIR: join(root, 'runtime'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CLAUDE_PROJECTS_DIR: join(home, '.claude', 'projects'), CODEX_HOME: join(home, '.codex'), TZ: 'UTC',
  })
  for (const dir of ['data', 'runtime', 'work', join('home', '.claude', 'projects'), join('home', '.codex')]) mkdirSync(join(root, dir), { recursive: true })
  for (const [version, prints] of [['v1', '1.18.31'], ['v2', 'opencode v2.0.18']]) {
    mkdirSync(join(root, 'bin', version), { recursive: true })
    writeFileSync(join(root, 'bin', version, 'opencode'), `#!/bin/sh\necho "${prints}"\n`)
    chmodSync(join(root, 'bin', version, 'opencode'), 0o755)
  }
  golden = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>
})

afterAll(() => {
  for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value
  if (root) rmSync(root, { recursive: true, force: true })
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(recorded, null, 1) + '\n')
})

describe('which OpenCode the core asks for, for a named agent', () => {
  it('refuses a named agent on OpenCode v2 before any pane exists, and asks nothing for any other engine', async () => {
    let receipts = 0
    for (const [installed, path] of [['v1', join(root, 'bin', 'v1', 'opencode')], ['v2', join(root, 'bin', 'v2', 'opencode')], ['none', join(root, 'bin', 'none', 'opencode')]] as const) {
      setEnv({ OPENCODE_PATH: path })
      vi.resetModules()
      const { createLaunchRequests } = await import('../core/agents/launches.js')
      const { AgentCreationReceipts } = await import('../lib/agentCreationReceipt.js')
      const asked: unknown[] = []
      const requests = createLaunchRequests({
        receipts: new AgentCreationReceipts(join(root, 'data', `receipts-${++receipts}`)),
        createAgent: () => async (request) => {
          asked.push({ engine: request.engine, agent: request.agent, name: request.name })
          return { ok: false, error: 'RECORDED' }
        },
        forkAgent: () => null, resumeAgent: () => null, restartAgent: () => null,
        byAgent: () => undefined, toProject: async () => ({}) as never, modelTarget: async () => null as never,
      })
      const results: unknown[] = []
      for (const engine of ['opencode', 'claude', 'pi', 'cursor'] as const) {
        for (const agent of ['harness-compute', null] as const) {
          asked.length = 0
          let answer: unknown = null
          await requests.create({ engine, cwd: join(root, 'work'), agent, name: 'Named' }, { local: true }, (result) => { answer = result })
          results.push([engine, agent, answer, [...asked]])
        }
      }
      check(`agent_create · OpenCode ${installed}`, results)
    }
  }, 120_000)

  it('has a recorded outcome for every case, and no other', () => {
    if (RECORD) return
    expect(Object.keys(recorded).sort()).toEqual(Object.keys(golden).sort())
  })
})
