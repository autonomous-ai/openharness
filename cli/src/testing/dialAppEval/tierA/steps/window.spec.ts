// Tier A's window steps (window.ts): the ChatGPT app's window title and the Claude mod's attach reach the devices'
// listener as `harness hardware watch` and the mod send them, through the listener's own handlers.
import { describe, expect, it } from 'vitest'
import { frontAppId } from '../../../../cable/hosts/frontApp.js'
import { attachHandler, frontHandler, threadHandler } from '../../../../services/devicesListener.js'
import { claudeSessions, titleOf } from '../../catalog.js'
import { APPS, frontName, type Platform, type Scenario } from '../../types.js'
import type { TierAWorld } from '../world.js'
import { windowSteps } from './window.js'

const sessions = claudeSessions(['a', 'b'])

/** The world as the window steps see it, its listener the devices' handlers for a thread and an attach. */
function worldWith(told: { threads: string[]; attached: string[] }): TierAWorld {
  return {
    scenario: { id: 'spec', sessions } as unknown as Scenario,
    session: (key: string) => sessions.find((s) => s.key === key)!,
    listener: {
      thread: threadHandler((title) => told.threads.push(title)),
      attach: attachHandler((sessionId) => told.attached.push(sessionId)),
    },
  } as unknown as TierAWorld
}

describe("tier A's window steps", () => {
  it('thread and attach reach the listener\'s handlers as the watch and the mod send them', async () => {
    const told = { threads: [] as string[], attached: [] as string[] }
    const world = worldWith(told)
    await windowSteps.thread(world, { kind: 'thread', title: titleOf('t2') })
    await windowSteps.attach(world, { kind: 'attach', session: 'b' })
    expect(told).toEqual({ threads: ['Eval T2'], attached: [sessions[1]!.id] })
  })

  it("the front step tells the listener what frontAppId makes of the platform's own front name, for each app and platform it has one on, Orca's and iTerm2's included", async () => {
    const told: string[] = []
    for (const platform of ['darwin', 'linux', 'win32'] as const satisfies readonly Platform[]) {
      // iTerm2 is macOS only: it has no front name on Linux or Windows.
      for (const app of [...APPS, 'other'] as const) {
        if (app === 'iterm' && platform !== 'darwin') continue
        const fronts: string[] = []
        const world = { platform, listener: { front: frontHandler((id) => fronts.push(id)) } } as unknown as TierAWorld
        await windowSteps.front(world, { kind: 'front', app })
        expect(fronts, `${platform} ${app}`).toEqual([frontAppId(frontName(platform, app))])
        told.push(`${platform} ${app}`)
      }
    }
    expect(told).toContain('darwin iterm')
  })

  it('a message the listener refuses fails the step', async () => {
    const world = worldWith({ threads: [], attached: [] })
    await expect(windowSteps.thread(world, { kind: 'thread', title: 'Eval \u0007' })).rejects.toThrow(/refused/)
  })
})
