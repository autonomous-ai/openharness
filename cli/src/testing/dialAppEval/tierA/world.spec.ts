// Tier A's world (world.ts) with a recording start in place of the devices: what it hands them, and how it records
// each command, raise and send they make. Every folder is a temp one, on virtual time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCodexQueue } from '../../../cable/hosts/codexQueue.js'
import type { CoreApi } from '../../../core/api.js'
import type { DevicesDeps, startDevices } from '../../../services/devices.js'
import { claudeSessions, scenario, threads } from '../catalog.js'
import type { Platform, Scenario } from '../types.js'
import { installClock } from './clock.js'
import { World } from './world.js'

const S1 = scenario({ id: 'W1', app: 'chatgpt', title: 'Eval world', dims: ['D3'], steps: [], checks: [], probes: [],
  sessions: [...claudeSessions(['a']), ...threads(['t1'])] })

const worlds: World[] = []
beforeEach(() => { installClock() })
afterEach(() => {
  for (const world of worlds.splice(0)) world.remove()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

/** A world on that platform, and what it handed the devices. */
function worldOn(platform: Platform, of: Scenario = S1): { world: World; core: CoreApi; deps: DevicesDeps } {
  let handed: { core: CoreApi; deps: DevicesDeps } | undefined
  const start = ((core: CoreApi, _ports: unknown, deps: DevicesDeps) => {
    handed = { core, deps }
    return {}
  }) as unknown as typeof startDevices
  const world = new World(of, platform, start)
  worlds.push(world)
  return { world, ...handed! }
}

describe("tier A's world", () => {
  it('records each command with whether it ran to a good end', async () => {
    const { world, deps } = worldOn('darwin')
    world.answer((argv) => (argv.includes('codex://threads/eval-refused') ? { code: 1 } : undefined))
    await deps.orca!.run('/usr/bin/open', ['-b', 'com.openai.codex', 'codex://threads/eval-refused'], 1_000)
    await deps.orca!.run('/usr/bin/open', ['-b', 'com.openai.codex'], 1_000)
    expect(world.seen([]).commands.map(({ argv, ok }) => [argv.at(-1), ok])).toEqual([
      ['codex://threads/eval-refused', false], ['com.openai.codex', true],
    ])
  })

  it("records Windows' raises and links with the helper's answer", async () => {
    const { world, deps } = worldOn('win32')
    world.answer((argv) => (argv[1] === 'raise' ? { code: 1 } : undefined))
    expect(await deps.windowsRaise!.app('com.openai.codex')).toBe(false)
    expect(await deps.windowsRaise!.link('codex://threads/eval', 'com.openai.codex')).toBe(true)
    expect(world.seen([]).commands.map(({ argv, ok }) => [argv[1], ok])).toEqual([['raise', false], ['open-link', true]])
  })

  it("the core's turns.send reaches no session: tier A has no Harness agent, so a real core would refuse it", () => {
    const { world, core } = worldOn('darwin')
    core.turns.send(world.agentId('a'), 'Eval words for alpha.')
    expect(world.seen([]).deliveries).toEqual([{ at: 0, path: 'turns', target: null, text: 'Eval words for alpha.' }])
  })
})

describe("tier A's world records every send, failing closed", () => {
  const WORDS = 'Eval words for one.'

  it("a send of the devices' own Codex queue is a codex delivery to its thread", async () => {
    const { world, deps } = worldOn('darwin')
    const queue = createCodexQueue({ ...deps.codex!, home: '/eval-codex-home', cwd: '/eval-cwd' })
    expect(await queue.send(world.session('t1').id, WORDS, true)).toEqual({ outcome: 'queued' })
    expect(world.seen([]).deliveries).toEqual([{ at: 0, path: 'codex', target: 't1', text: WORDS }])
  })

  it('a codex queue run that failed queued nothing', async () => {
    const { world, deps } = worldOn('darwin')
    world.answer((argv) => (argv.includes('queue') ? { code: 1 } : undefined))
    const queue = createCodexQueue({ ...deps.codex!, home: '/eval-codex-home', cwd: '/eval-cwd' })
    expect(await queue.send(world.session('t1').id, WORDS, true)).toMatchObject({ outcome: 'failed', reason: 'exit 1' })
    expect(world.seen([]).deliveries).toEqual([])
  })

  it('a codex queue run it cannot read, or to a thread the scenario has not, is a delivery to no session', async () => {
    const { world, deps } = worldOn('darwin')
    const run = (args: string[]) => deps.codex!.run('/opt/eval/bin/codex', args, { cwd: '/eval-cwd', env: {}, timeoutMs: 1_000 })
    await run(['queue', `--message=${WORDS}`])
    await run(['queue', '--thread', '00000000-0000-4000-a000-00000000ffff', `--message=${WORDS}`])
    await run(['queue', '--thread', world.session('t1').id])
    expect(world.seen([]).deliveries.map(({ target, text }) => [target, text])).toEqual([[null, WORDS], [null, WORDS], [null, '']])
  })

  it('words herdr, Herdr Core, opencode or cmux are asked to put in a pane are typed into no session', async () => {
    const { world, deps } = worldOn('darwin')
    await deps.herdr!.prompt('w1:p1', 'agent', WORDS)
    await deps.hc!.prompt('eval-terminal', 'agent', WORDS)
    await deps.opencode!.prompt('eval-session', WORDS, 'eval-message')
    await deps.cmux!.paste('eval-workspace', 'eval-surface', WORDS)
    expect(world.seen([]).deliveries).toEqual(Array.from({ length: 4 }, () => ({ at: 0, path: 'typed', target: null, text: WORDS })))
  })

  it("the core's turns.deliver and its question answers reach no session", async () => {
    const { world, core } = worldOn('darwin')
    const agentId = world.agentId('a')
    core.turns.deliver(agentId, WORDS, 'eval-delivery')
    core.questions.answer(agentId, 'eval-request', { q1: 'Eval yes.' })
    await core.questions.answerReviewed({ agentId, requestId: 'eval-request', questions: [], answers: { q1: 'Eval no.' }, selections: {} })
    expect(world.seen([]).deliveries.map(({ path, target, text }) => [path, target, text])).toEqual([
      ['turns', null, WORDS], ['turns', null, 'Eval yes.'], ['turns', null, 'Eval no.'],
    ])
  })

  it('a command tier A does not answer is a gap that names its program', async () => {
    const { world, deps } = worldOn('linux')
    for (const argv of [['/usr/bin/open', '-b', 'com.openai.codex'], ['/usr/bin/xdg-open', 'codex://threads/eval'],
      ['/usr/bin/xdg-mime', 'query', 'default', 'x-scheme-handler/codex'], ['harness-pty', 'raise', 'com.openai.codex']]) {
      await deps.orca!.run(argv[0]!, argv.slice(1), 1_000)
    }
    await deps.codex!.run('/opt/eval/bin/codex', ['queue', '--thread', world.session('t1').id, `--message=${WORDS}`],
      { cwd: '/eval-cwd', env: {}, timeoutMs: 1_000 })
    expect(world.gaps).toEqual([])
    await deps.orca!.run('/usr/bin/osascript', ['-e', 'eval'], 1_000)
    await deps.orca!.run('/usr/bin/osascript', ['-e', 'eval'], 1_000)
    await deps.codex!.run('/opt/eval/bin/codex', ['login'], { cwd: '/eval-cwd', env: {}, timeoutMs: 1_000 })
    expect(world.gaps).toEqual(['a command tier A does not answer: osascript', 'a command tier A does not answer: codex'])
  })
})
