// Tier A's world (world.ts) with a recording start in place of the devices: what it hands them, and how it records
// each command, raise and send they make. Every folder is a temp one, on virtual time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
})
