import { describe, expect, it } from 'vitest'
import { createAppLink, type AppLink, type AppLinkDeps } from './appLink.js'
import type { WindowsRaise } from './windowsRaise.js'

/** A made-up app, so the helper is tested apart from any real app's link. */
const FAKE: AppLink = { session: /^s[0-9]{1,3}$/, url: (session) => `fake://open/${session}` }

interface Call { file: string; args: string[]; timeoutMs: number }

/** A recording runner that runs nothing, so no spec opens an app: each call answers the next of [codes], then exit 0.
 *  Every tool is on PATH under /fake/bin, and xdg-mime prints [handler] as the scheme's app. */
function recorder(over: Partial<AppLinkDeps> = {}, codes: Array<number | null> = [], link: AppLink = FAKE, handler = 'fake-app.desktop\n') {
  const calls: Call[] = []
  const deps: AppLinkDeps = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return { code: codes.length ? codes.shift()! : 0, stdout: file.endsWith('/xdg-mime') ? handler : '' }
    },
    platform: 'darwin',
    onPath: (name) => `/fake/bin/${name}`,
    inFront: () => true,
    ...over,
  }
  return { calls, verbs: createAppLink(deps, link) }
}

/** The recorder on Windows, holding a raise whose link notes its URL and bundle and answers the next of [answers],
 *  then true. */
function onWindows(answers: boolean[] = [], link: AppLink = FAKE, over: Partial<AppLinkDeps> = {}) {
  const links: Array<[string, string | undefined]> = []
  const windows: WindowsRaise = {
    app: async () => { throw new Error('no app') },
    link: async (url, bundle) => { links.push([url, bundle]); return answers.length ? answers.shift()! : true },
    cursorFolder: async () => { throw new Error('no folder') },
    desktop: async () => { throw new Error('no desktop') },
  }
  return { ...recorder({ platform: 'win32', windows, ...over }, [], link), links }
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
const asked: Call = { file: '/fake/bin/xdg-mime', args: ['query', 'default', 'x-scheme-handler/fake'], timeoutMs: 10_000 }
const xdgOpened = (session: string, file = '/fake/bin/xdg-open'): Call => ({ file, args: [`fake://open/${session}`], timeoutMs: 10_000 })
/** Lets a read that started settle: the recorder answers at once, so every promise it chains has run by the next turn. */
const settled = () => new Promise((resolve) => setImmediate(resolve))

describe('an app whose session opens by its link', () => {
  it('canFocus is macOS\'s, and Linux\'s until the scheme is read to have no app; canShow also needs the app known and in front, asked each time', async () => {
    let linuxFront = true
    const linux = recorder({ platform: 'linux', inFront: () => linuxFront })
    // The first ask starts the read: a tap's focus waits for it, a rest's look does not. A second while it runs starts none.
    expect(linux.verbs.canFocus(pane('s1'))).toBe(true)
    expect(linux.verbs.canShow(pane('s1'))).toBe(false)
    await settled()
    expect(linux.verbs.canFocus(pane('s1'))).toBe(true)
    expect(linux.verbs.canShow(pane('s1'))).toBe(true)
    linuxFront = false
    expect(linux.verbs.canFocus(pane('s1'))).toBe(true)
    expect(linux.verbs.canShow(pane('s1'))).toBe(false)
    expect(linux.calls).toEqual([asked])

    let front = true
    const { verbs } = recorder({ inFront: () => front })
    expect(verbs.canFocus(pane('s1'))).toBe(true)
    expect(verbs.canShow(pane('s1'))).toBe(true)
    front = false
    expect(verbs.canFocus(pane('s1'))).toBe(true)
    expect(verbs.canShow(pane('s1'))).toBe(false)
  })

  it('canLink: macOS and Windows with its raise; Linux only once xdg-mime named an app; never the app in front', async () => {
    expect(recorder({ inFront: () => false }).verbs.canLink(pane('s1'))).toBe(true)
    expect(onWindows([], FAKE, { inFront: () => false }).verbs.canLink(pane('s1'))).toBe(true)
    expect(recorder({ platform: 'win32' }).verbs.canLink(pane('s1'))).toBe(false)
    const linux = recorder({ platform: 'linux', inFront: () => false })
    expect(linux.verbs.canLink(pane('s1'))).toBe(false) // starts the read
    await settled()
    expect(linux.verbs.canLink(pane('s1'))).toBe(true)
    expect(linux.calls).toEqual([asked])
    for (const none of [recorder({ platform: 'linux' }, [], FAKE, '\n'), recorder({ platform: 'linux', onPath: () => null })]) {
      none.verbs.canLink(pane('s1'))
      await settled()
      expect(none.verbs.canLink(pane('s1'))).toBe(false)
    }
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

  it('a rest: ok, failed, and nothing for a bad id', async () => {
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

describe('a link on Linux', () => {
  it('on Linux a link opens through xdg-open once its scheme has an app', async () => {
    const { calls, verbs } = recorder({ platform: 'linux' })
    expect(await verbs.focus(pane('s1'))).toBe(true)
    expect(calls).toEqual([asked, xdgOpened('s1')])
    expect(await verbs.show(pane('s2'), 'a1')).toBe('ok')
    expect(calls).toEqual([asked, xdgOpened('s1'), xdgOpened('s2')])

    // The bundle is macOS's (open -b): xdg-open takes the URL alone.
    const bundled = recorder({ platform: 'linux' }, [], { ...FAKE, bundle: 'com.example.fake' })
    expect(await bundled.verbs.focus(pane('s1'))).toBe(true)
    expect(bundled.calls).toEqual([asked, xdgOpened('s1')])

    const forged = recorder({ platform: 'linux' })
    for (const id of BAD) {
      expect(await forged.verbs.focus(pane(id)), id).toBe(false)
      expect(await forged.verbs.show(pane(id), 'a1'), id).toBe('failed')
    }
    expect(forged.calls).toEqual([])
  })

  // The opener asks canFocus before it runs focus (open.ts): a first tap while the read runs still opens its link.
  it('a first tap opens the link once xdg-mime names an app, and none once it names no app', async () => {
    const { calls, verbs } = recorder({ platform: 'linux' })
    expect(verbs.canFocus(pane('s1'))).toBe(true)
    expect(await verbs.focus(pane('s1'))).toBe(true)
    expect(calls).toEqual([asked, xdgOpened('s1')])

    const none = recorder({ platform: 'linux' }, [], FAKE, '')
    expect(none.verbs.canFocus(pane('s1'))).toBe(true)
    expect(await none.verbs.focus(pane('s1'))).toBe(false)
    expect(none.verbs.canFocus(pane('s1'))).toBe(false)
    expect(none.calls).toEqual([asked])
  })

  it('reads the scheme\'s app once, and again after an open that failed', async () => {
    for (const code of [1, null]) {
      const { calls, verbs } = recorder({ platform: 'linux' }, [0, code])
      expect(await verbs.focus(pane('s1')), String(code)).toBe(false)
      expect(await verbs.show(pane('s1'), 'a1')).toBe('ok')
      expect(await verbs.focus(pane('s2'))).toBe(true)
      expect(calls).toEqual([asked, xdgOpened('s1'), asked, xdgOpened('s1'), xdgOpened('s2')])
    }

    const together = recorder({ platform: 'linux' })
    expect(await Promise.all([together.verbs.focus(pane('s1')), together.verbs.focus(pane('s2'))])).toEqual([true, true])
    expect(together.calls).toEqual([asked, xdgOpened('s1'), xdgOpened('s2')])
  })

  it('no app, no xdg-mime, no xdg-open or a failed open answers false, and runs no forward', async () => {
    const tried = async (label: string, made: (link: AppLink) => ReturnType<typeof recorder>, calls: Call[]) => {
      const { forward, link } = forwarding(true)
      const { calls: ran, verbs } = made(link)
      expect(await verbs.focus(pane('s1')), label).toBe(false)
      expect(await verbs.show(pane('s1'), 'a1'), label).toBe('failed')
      expect(forward.runs, label).toBe(0)
      expect(ran, label).toEqual(calls)
    }
    // No app is kept as the read's answer: nothing opens, and nothing is read again.
    for (const handler of ['', '\n', 'fake-app', 'fake app.desktop', '../fake.desktop', `${'a'.repeat(129)}.desktop`]) {
      await tried(`printed ${JSON.stringify(handler)}`, (link) => recorder({ platform: 'linux' }, [], link, handler), [asked])
    }
    await tried('xdg-mime failed', (link) => recorder({ platform: 'linux' }, [1], link), [asked])
    await tried('no xdg-mime', (link) => recorder({ platform: 'linux', onPath: (name) => name === 'xdg-mime' ? null : `/fake/bin/${name}` }, [], link), [])
    await tried('no xdg-open', (link) => recorder({ platform: 'linux', onPath: (name) => name === 'xdg-open' ? null : `/fake/bin/${name}` }, [], link), [asked])
    for (const code of [1, null]) {
      await tried(`open ${code}`, (link) => recorder({ platform: 'linux' }, [0, code, 0, code], link), [asked, xdgOpened('s1'), asked, xdgOpened('s1')])
    }
  })

  it.each([
    ['/tmp/e2e/fake-open', '/tmp/e2e/fake-open'],
    ['', '/fake/bin/xdg-open'],
    ['fake-open', '/fake/bin/xdg-open'],
    [undefined, '/fake/bin/xdg-open'],
  ])('HARNESS_OPEN_BIN %j takes xdg-open\'s place when it is an absolute path', async (bin, file) => {
    const { calls, verbs } = recorder({ platform: 'linux', bin })
    expect(await verbs.focus(pane('s1'))).toBe(true)
    expect(calls).toEqual([asked, xdgOpened('s1', file)])
  })

  it('Windows runs nothing', async () => {
    const { forward, link } = forwarding(true)
    const { calls, verbs } = recorder({ platform: 'win32' }, [], link)
    expect(verbs.canFocus(pane('s1'))).toBe(false)
    expect(verbs.canShow(pane('s1'))).toBe(false)
    expect(await verbs.focus(pane('s1'))).toBe(false)
    expect(await verbs.show(pane('s1'), 'a1')).toBe('failed')
    await settled()
    expect(verbs.canFocus(pane('s1'))).toBe(false)
    expect(forward.runs).toBe(0)
    expect(calls).toEqual([])
  })
})

// Windows has no `open`: the link goes to the raise, which opens it through `harness-pty open-link` (windowsRaise.ts).
describe('a link on Windows', () => {
  it('a tap and a rest send the link and its bundle to the raise, and run nothing', async () => {
    const { calls, links, verbs } = onWindows([true, true, false, false], { ...FAKE, bundle: 'com.example.fake' })
    expect(verbs.canFocus(pane('s1'))).toBe(true)
    expect(verbs.canShow(pane('s1'))).toBe(true)
    expect(await verbs.focus(pane('s1'))).toBe(true)
    expect(await verbs.show(pane('s1'), 'a1')).toBe('ok')
    expect(await verbs.focus(pane('s1'))).toBe(false)
    expect(await verbs.show(pane('s1'), 'a1')).toBe('failed')
    expect(links).toEqual(Array(4).fill(['fake://open/s1', 'com.example.fake']))
    expect(calls).toEqual([])
  })

  it('a link with no bundle goes to the raise alone; an id out of form reaches nothing', async () => {
    const { calls, links, verbs } = onWindows()
    expect(await verbs.focus(pane('s1'))).toBe(true)
    for (const id of BAD) {
      expect(await verbs.focus(pane(id)), id).toBe(false)
      expect(await verbs.show(pane(id), 'a1'), id).toBe('failed')
    }
    expect(links).toEqual([['fake://open/s1', undefined]])
    expect(calls).toEqual([])
  })

  it('with a forward, a tap whose link failed runs it once and answers what it answered; a rest never runs it', async () => {
    for (const answer of [true, false]) {
      const { forward, link } = forwarding(answer)
      const { verbs } = onWindows([false, false], link)
      expect(await verbs.focus(pane('s1')), String(answer)).toBe(answer)
      expect(await verbs.show(pane('s1'), 'a1')).toBe('failed')
      expect(forward.runs).toBe(1)
    }
  })

  it('a rest needs the app in front', () => {
    let front = true
    const { verbs } = onWindows([], FAKE, { inFront: () => front })
    expect(verbs.canShow(pane('s1'))).toBe(true)
    front = false
    expect(verbs.canShow(pane('s1'))).toBe(false)
    expect(verbs.canFocus(pane('s1'))).toBe(true)
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
