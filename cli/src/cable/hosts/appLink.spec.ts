import { describe, expect, it } from 'vitest'
import { createAppLink, type AppLink, type AppLinkDeps } from './appLink.js'

/** A made-up app, so the helper is tested apart from any real app's link. */
const FAKE: AppLink = { session: /^s[0-9]{1,3}$/, url: (session) => `fake://open/${session}` }

interface Call { file: string; args: string[]; timeoutMs: number }

/** A recording runner that runs nothing, so no spec opens an app: each call answers the next of [codes], then exit 0. */
function recorder(over: Partial<AppLinkDeps> = {}, codes: Array<number | null> = [], link: AppLink = FAKE) {
  const calls: Call[] = []
  const deps: AppLinkDeps = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return { code: codes.length ? codes.shift()! : 0, stdout: '' }
    },
    platform: 'darwin',
    inFront: () => true,
    ...over,
  }
  return { calls, verbs: createAppLink(deps, link) }
}

/** The recorder, each command held until it is let go, so a link can be caught still running. */
function holding() {
  const calls: Call[] = []
  const waiting: Array<() => void> = []
  const { verbs } = recorder({
    run: (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return new Promise((resolve) => waiting.push(() => resolve({ code: 0, stdout: '' })))
    },
  })
  return { calls, waiting, verbs }
}

/** The made-up app with a forward that answers [answer] and counts its runs. */
function forwarding(answer: boolean) {
  const forward = { runs: 0 }
  const link: AppLink = {
    ...FAKE,
    forward: async () => {
      forward.runs++
      return answer
    },
  }
  return { forward, link }
}

const pane = (id: string) => ({ adapter: 'fake', id })
const opened = (session: string): Call => ({ file: '/usr/bin/open', args: [`fake://open/${session}`], timeoutMs: 10_000 })
const BAD = ['', 's1&x=1', '-b', 's1/../s2']

describe('an app whose session opens by its link', () => {
  it('canFocus is macOS only; canShow also needs the app in front, asked each time', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const { verbs } = recorder({ platform })
      expect(verbs.canFocus(pane('s1')), platform).toBe(false)
      expect(verbs.canShow(pane('s1')), platform).toBe(false)
    }
    let front = true
    const { verbs } = recorder({ inFront: () => front })
    expect(verbs.canFocus(pane('s1'))).toBe(true)
    expect(verbs.canShow(pane('s1'))).toBe(true)
    front = false
    expect(verbs.canFocus(pane('s1'))).toBe(true)
    expect(verbs.canShow(pane('s1'))).toBe(false)
  })

  it('focus runs the link alone, the URL its one argument', async () => {
    const { calls, verbs } = recorder()
    expect(await verbs.focus(pane('s1'))).toBe(true)
    expect(calls).toEqual([{ file: '/usr/bin/open', args: ['fake://open/s1'], timeoutMs: 10_000 }])

    for (const code of [1, null]) {
      const failed = recorder({}, [code])
      expect(await failed.verbs.focus(pane('s1')), String(code)).toBe(false)
      expect(failed.calls).toEqual([opened('s1')])
    }

    for (const platform of ['linux', 'win32'] as const) {
      const off = recorder({ platform })
      expect(await off.verbs.focus(pane('s1')), platform).toBe(false)
      expect(off.calls).toEqual([])
    }

    const forged = recorder()
    for (const id of BAD) expect(await forged.verbs.focus(pane(id)), id).toBe(false)
    expect(forged.calls).toEqual([])
  })

  it('a link with a bundle goes to that app alone, by open -b, for a tap and a rest', async () => {
    const bundled: AppLink = { ...FAKE, bundle: 'com.example.fake' }
    const sent: Call = { file: '/usr/bin/open', args: ['-b', 'com.example.fake', 'fake://open/s1'], timeoutMs: 10_000 }
    const { calls, verbs } = recorder({}, [], bundled)
    expect(await verbs.focus(pane('s1'))).toBe(true)
    expect(await verbs.show(pane('s1'), 'a1')).toBe('ok')
    expect(calls).toEqual([sent, sent])
  })

  it('with a forward, a tap whose link failed runs it once and answers what it answered', async () => {
    for (const code of [1, null]) {
      for (const answer of [true, false]) {
        const { forward, link } = forwarding(answer)
        const { calls, verbs } = recorder({}, [code], link)
        expect(await verbs.focus(pane('s1')), `${code} ${answer}`).toBe(answer)
        expect(forward.runs).toBe(1)
        expect(calls).toEqual([opened('s1')])
      }
    }

    const worked = forwarding(false)
    expect(await recorder({}, [0], worked.link).verbs.focus(pane('s1'))).toBe(true)
    expect(worked.forward.runs).toBe(0)

    const forged = forwarding(true)
    expect(await recorder({}, [], forged.link).verbs.focus(pane('-b'))).toBe(false)
    expect(forged.forward.runs).toBe(0)

    const linux = forwarding(true)
    expect(await recorder({ platform: 'linux' }, [], linux.link).verbs.focus(pane('s1'))).toBe(false)
    expect(linux.forward.runs).toBe(0)
  })
})

describe('a rest on an app session opened by its link', () => {
  it('a rest never runs the forward', async () => {
    const { forward, link } = forwarding(true)
    const { calls, verbs } = recorder({}, [1], link)
    expect(await verbs.show(pane('s1'), 'a1')).toBe('failed')
    expect(forward.runs).toBe(0)
    expect(calls).toEqual([opened('s1')])
  })

  it('a rest: ok, failed, and nothing for a bad id or off macOS', async () => {
    const { calls, verbs } = recorder()
    expect(await verbs.show(pane('s1'), 'a1')).toBe('ok')
    expect(calls).toEqual([opened('s1')])

    for (const code of [1, null]) {
      const failed = recorder({}, [code])
      expect(await failed.verbs.show(pane('s1'), 'a1'), String(code)).toBe('failed')
      expect(failed.calls).toEqual([opened('s1')])
    }

    const forged = recorder()
    for (const id of BAD) expect(await forged.verbs.show(pane(id), 'a1'), id).toBe('failed')
    expect(forged.calls).toEqual([])

    for (const platform of ['linux', 'win32'] as const) {
      const off = recorder({ platform })
      expect(await off.verbs.show(pane('s1'), 'a1'), platform).toBe('failed')
      expect(off.calls).toEqual([])
    }
  })

  it('a link still running drops the next rest for that agent, and another agent\'s runs', async () => {
    const { calls, waiting, verbs } = holding()
    const first = verbs.show(pane('s1'), 'a1')
    expect(await verbs.show(pane('s2'), 'a1')).toBe('busy')
    expect(calls).toEqual([opened('s1')])
    const other = verbs.show(pane('s2'), 'a2')
    expect(calls).toEqual([opened('s1'), opened('s2')])
    waiting[0]()
    expect(await first).toBe('ok')
    // Once its link has ended, the agent takes the next one.
    const next = verbs.show(pane('s2'), 'a1')
    expect(calls).toEqual([opened('s1'), opened('s2'), opened('s2')])
    waiting[1]()
    waiting[2]()
    expect(await other).toBe('ok')
    expect(await next).toBe('ok')
  })

  it('a tap is not refused while a rest\'s link runs, and a rest is not busy while a tap runs', async () => {
    const { calls, waiting, verbs } = holding()
    const rest = verbs.show(pane('s1'), 'a1')
    const tap = verbs.focus(pane('s1'))
    expect(calls).toEqual([opened('s1'), opened('s1')])
    for (const done of waiting.splice(0)) done()
    expect(await rest).toBe('ok')
    expect(await tap).toBe(true)

    const tapFirst = verbs.focus(pane('s1'))
    const restAfter = verbs.show(pane('s1'), 'a1')
    expect(calls).toEqual([opened('s1'), opened('s1'), opened('s1'), opened('s1')])
    for (const done of waiting.splice(0)) done()
    expect(await tapFirst).toBe(true)
    expect(await restAfter).toBe('ok')
  })
})

describe('the link\'s verbs', () => {
  it('the verbs work spread into another object', async () => {
    const { calls, verbs } = recorder()
    // Taken off the copy and called alone: a verb that used `this`, or a method left on a prototype, fails here.
    const copy = { id: 'fake', ...verbs }
    const { focus, show } = copy
    expect(await focus(pane('s1'))).toBe(true)
    expect(await show(pane('s2'), 'a1')).toBe('ok')
    expect(calls).toEqual([opened('s1'), opened('s2')])
  })
})
