// Tier A's dial steps (dial.ts): a tap and a swipe reach the daemon as the firmware's frames, and the cable pulled and
// plugged in again is what the devices' fleet sees of a real one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CableDecoder, CableType } from '../../../../cable/cableFrame.js'
import { claudeSessions } from '../../catalog.js'
import { agentIdOf, type Scenario } from '../../types.js'
import { LoopbackDial } from '../loopbackDial.js'
import type { TierAWorld } from '../world.js'
import { dialSteps } from './dial.js'

const sessions = claudeSessions(['a', 'b'])

/** The world as the dial steps see it: its dial and its sessions. */
function worldOf(dial: LoopbackDial): TierAWorld {
  const session = (key: string) => sessions.find((s) => s.key === key)!
  return { scenario: { id: 'spec', sessions } as unknown as Scenario, dial, session, agentId: (key: string) => agentIdOf(session(key)) } as unknown as TierAWorld
}

/** The fleet's side of the port: what the dial sent, decoded, and whether the port was closed under it. */
async function opened(dial: LoopbackDial) {
  const heard: Array<Record<string, unknown>> = []
  const closed: string[] = []
  const decoder = new CableDecoder()
  const port = await dial.cable.open!('/dev/eval-dial', (chunk) => decoder.feed(chunk, (frame) => {
    if (frame.type === CableType.Json) heard.push(JSON.parse(Buffer.from(frame.payload).toString('utf8')) as Record<string, unknown>)
  }), (why) => closed.push(why))
  return { port, heard, closed }
}

// The dial's refresh task runs on a timer: virtual, so none outlives the case.
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe("tier A's dial steps", () => {
  it('tap sends agent.open and swipe sends focus for the session\'s id', async () => {
    const dial = new LoopbackDial(() => Date.now())
    const world = worldOf(dial)
    await dialSteps.replug(world, { kind: 'replug' })
    const { heard } = await opened(dial)
    await dialSteps.tap(world, { kind: 'tap', session: 'a' })
    await dialSteps.swipe(world, { kind: 'swipe', session: 'b' })
    expect(heard).toEqual([
      { t: 'agent.open', agentId: agentIdOf(sessions[0]!) },
      { t: 'focus', agentId: agentIdOf(sessions[1]!) },
    ])
  })

  it('unplug closes the port and replug lets discovery find it again', async () => {
    const dial = new LoopbackDial(() => Date.now())
    const world = worldOf(dial)
    await dialSteps.replug(world, { kind: 'replug' })
    expect(await dial.cable.discover!()).toHaveLength(1)
    const { port, closed } = await opened(dial)
    await dialSteps.unplug(world, { kind: 'unplug' })
    expect([port.isOpen, closed.length]).toEqual([false, 1])
    expect(await dial.cable.discover!()).toEqual([])
    await expect(dial.cable.open!('/dev/eval-dial', () => {}, () => {})).rejects.toThrow()
    await dialSteps.replug(world, { kind: 'replug' })
    expect(await dial.cable.discover!()).toHaveLength(1)
    expect((await opened(dial)).port.isOpen).toBe(true)
  })
})
