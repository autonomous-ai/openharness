import type { Stats } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { INJECT_PASTE_DELAY_BASE_MS, INJECT_PASTE_DELAY_MAX_MS } from '../../lib/submitTiming.js'
import type { TmuxPathOutcome } from '../../lib/tmuxOnPath.js'
import { RECORDED_REX } from '../../testing/recordedRex.js'
import type { Place } from './adapter.js'
import { MAX_TEXT } from './orca.js'
import { createRexAdapter, createRexReads, REX_BIN, REX_PAGE_KEYS_MS, REX_SCROLL_IDLE_MS, rexBlocksRunning, rexFinder, rexPaneIds, rexPaneParts, rexSettle,
  type RexDeps, type RexFinderDeps } from './rex.js'
import { ptyMaker } from './scannedApp.js'

const { env, process: processAnswer, clientList, performed, missingBlock, blockInspect } = RECORDED_REX
const FAKE_REX = '/Users/u/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex'
const FOUND = async (): Promise<TmuxPathOutcome> => ({ state: 'adopted', path: FAKE_REX, from: 'standard install location' })
const ABSENT = async (): Promise<TmuxPathOutcome> => ({ state: 'absent', reason: 'rex was not found' })
const SESSION = env.REX_SESSION
const BLOCK = env.REX_BLOCK
const PID = processAnswer.foregroundPid

interface Call { file: string; args: readonly string[]; timeoutMs: number }

/** A runner that answers as the recorded server did, for the recorded session and block only: any other is missing.
 *  [fail] names a verb (`focus`, `send`, `send-key`, `process`, `client.perform`, `session.view`) that exits 1 instead;
 *  [foreground] is the pid `process` names, by call; [view] what `session.view` prints. */
function recorder(over: Partial<RexDeps> = {},
  opts: { fail?: string; foreground?: (call: number) => number; clients?: string; view?: string } = {}) {
  const calls: Call[] = []
  const lines: string[] = []
  const waits: number[] = []
  let processCalls = 0
  const deps: RexDeps = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      const api = args[2] === '-s' ? args[4] : args[2]
      const verb = args[0] === 'block' ? args[1] === 'call' ? args[6] : args[1] : args[0] === 'api' ? api : args[0]
      if (verb === opts.fail) return { code: 1, stdout: '' }
      if (args[0] === 'client') return { code: 0, stdout: opts.clients ?? clientList.stdout }
      if (verb === 'session.view') return { code: 0, stdout: opts.view ?? '' }
      if (args[0] === 'api') return { code: performed.code, stdout: performed.stdout }
      const session = args[args.indexOf('-s') + 1]
      const block = args.includes('-b') ? args[args.indexOf('-b') + 1] : args[4]
      if (session !== SESSION || block !== BLOCK) return { code: missingBlock.code, stdout: '', stderr: missingBlock.stderr }
      if (verb === 'process') {
        const pid = opts.foreground?.(processCalls++) ?? PID
        return { code: 0, stdout: processAnswer.stdout.replaceAll(`"pid":${PID}`, `"pid":${pid}`) }
      }
      if (verb === 'inspect') return { code: blockInspect.code, stdout: blockInspect.stdout }
      return { code: 0, stdout: '' }
    },
    rex: FOUND,
    platform: 'darwin',
    uid: clientList.uid,
    front: () => 'rex',
    log: (line) => { lines.push(line) },
    wait: async (ms) => { waits.push(ms) },
    ...over,
  }
  return { calls, lines, waits, deps, adapter: createRexAdapter(deps) }
}

const hints = { TERM_PROGRAM: env.TERM_PROGRAM, REX_BLOCK: BLOCK, REX_SESSION: SESSION }
/** A place, by default an agent on the pseudo-terminal Rex's server made for its block. */
const place = (over: Record<string, string> = {}, ptyOwner: string | null = 'rex', pid: number | undefined = PID): Place =>
  ({ host: 'rex', app: 'rex', hints: { ...hints, ...over }, ...(ptyOwner === null ? {} : { ptyOwner }), ...(pid === undefined ? {} : { pid }) })
const OWN = { adapter: 'rex', id: `${SESSION}/${BLOCK}/${PID}` }
const HELD = { adapter: 'rex', id: `held:${SESSION}/${BLOCK}`, held: true as const }
const ran = (...args: string[]): Call => ({ file: FAKE_REX, args, timeoutMs: 10_000 })
const processRead = ran('block', 'call', '-s', SESSION, '-b', BLOCK, 'process')
const focusRun = ran('block', 'focus', '-s', SESSION, BLOCK)
const inspectRun = ran('block', 'inspect', '-s', SESSION, BLOCK, '--json')
const select = (client: string, window?: string) => ran('api', 'call', 'client.perform',
  JSON.stringify({ client_id: client, action: 'session.select', args: { session_id: SESSION, ...(window ? { window_id: window } : {}) }, timeout_ms: 5_000 }))
/** A tap's and a rest's runs: the block focused on the server, its window read, the app asked to show it there. */
const bringRuns = [focusRun, inspectRun, ran('client', 'ls', '--json'), select(clientList.appClient, blockInspect.window)]

describe('the Rex adapter', () => {
  describe('paneOf', () => {
    it("an agent on the terminal Rex's server made for its block has its own pane, with its pid", () => {
      expect(recorder().adapter.paneOf(place())).toEqual(OWN)
    })

    it('a multiplexer, a terminal or an unread maker in a Rex block holds the agent: a tap only', () => {
      const { adapter } = recorder()
      for (const owner of ['tmux', 'zellij', null]) expect(adapter.paneOf(place({}, owner)), String(owner)).toEqual(HELD)
      expect(adapter.paneOf({ ...place(), ptyOwner: null })).toEqual(HELD)
      // No pid: nothing to check the block's foreground against.
      const { pid: _pid, ...noPid } = place()
      expect(adapter.paneOf(noPid)).toEqual(HELD)
    })

    it('no pane without both ids in form: an older hook, a block on another server, a forged value', () => {
      const { adapter } = recorder()
      expect(adapter.paneOf(place({ REX_SESSION: '' }))).toBeUndefined()
      for (const bad of [{ REX_BLOCK: 'x' }, { REX_BLOCK: BLOCK.toUpperCase() }, { REX_SESSION: BLOCK }, { REX_BLOCK: SESSION },
        { REX_BLOCK: `${BLOCK} --flag` }, { REX_SESSION: `${SESSION}/x` }] as Array<Record<string, string>>) {
        expect(adapter.paneOf(place(bad)), JSON.stringify(bad)).toBeUndefined()
      }
    })

    it('none off macOS, where no Rex app runs', () => {
      for (const platform of ['linux', 'win32'] as const) expect(recorder({ platform }).adapter.paneOf(place())).toBeUndefined()
    })
  })

  describe('a tap', () => {
    // The app follows the server's focus within the tab it shows, but changes no tab for it (Diego on the dial,
    // 2026-11-25): its own Go to Session, given the block's window, does.
    it("focuses the block, then asks this user's Rex app alone to show its session on the block's tab", async () => {
      const { adapter, calls, lines } = recorder()
      expect(await adapter.focus(OWN)).toBe(true)
      expect(calls).toEqual(bringRuns)
      expect(lines).toEqual([])
      // A held block is focused the same way.
      calls.length = 0
      expect(await adapter.focus(HELD)).toBe(true)
      expect(calls[0]).toEqual(focusRun)
    })

    it('a block that is gone fails the tap and asks no app', async () => {
      const { adapter, calls } = recorder()
      const gone = { adapter: 'rex', id: `${SESSION}/block:00000000-0000-0000-0000-000000000000/${PID}` }
      expect(await adapter.focus(gone)).toBe(false)
      expect(calls).toHaveLength(1)
    })

    it('with Remote Control off, or no app, the tap still succeeds and says once why the session did not change', async () => {
      const refused = recorder({}, { fail: 'client.perform' })
      expect(await refused.adapter.focus(OWN)).toBe(true)
      expect(refused.lines).toEqual(['[device] open · rex · session not shown (refused)'])
      const none = recorder({}, { clients: JSON.stringify({ clients: [] }) })
      expect(await none.adapter.focus(OWN)).toBe(true)
      expect(none.lines).toEqual(['[device] open · rex · session not shown (no app)'])
      // Another user's app is not this user's.
      const other = recorder({ uid: 502 })
      expect(await other.adapter.focus(OWN)).toBe(true)
      expect(other.calls.some((c) => c.args[0] === 'api')).toBe(false)
    })

    it('no rex found: nothing runs and the tap fails, so the opener brings Rex forward', async () => {
      const { adapter, calls } = recorder({ rex: ABSENT })
      expect(await adapter.focus(OWN)).toBe(false)
      expect(calls).toEqual([])
      expect(adapter.bundle).toBe('com.superlogical.rex')
      expect(adapter.tap).toBe('before')
    })

    it('an id out of form runs nothing', async () => {
      const { adapter, calls } = recorder()
      for (const id of ['x', `${SESSION}/${BLOCK}`, `held:${SESSION}/${BLOCK}/${PID}`, `${SESSION}/${BLOCK}/0`]) {
        expect(await adapter.focus({ adapter: 'rex', id }), id).toBe(false)
      }
      expect(calls).toEqual([])
    })
  })

  describe('a rest', () => {
    it("brings the block on its tab as a tap does, only while Rex is in front, and says nothing when the app refuses", async () => {
      let front: string | undefined = 'rex'
      const { adapter, calls } = recorder({ front: () => front })
      expect(adapter.canShow(OWN)).toBe(true)
      expect(await adapter.show(OWN, 'a1')).toBe('ok')
      expect(calls).toEqual(bringRuns)
      const refused = recorder({}, { fail: 'client.perform' })
      expect(await refused.adapter.show(OWN, 'a1')).toBe('ok')
      expect(refused.lines).toEqual([])
      // No window read: the session alone, as the app opens it.
      const unread = recorder({}, { fail: 'inspect' })
      expect(await unread.adapter.show(OWN, 'a1')).toBe('ok')
      expect(unread.calls.at(-1)).toEqual(select(clientList.appClient))
      front = 'ghostty'
      expect(adapter.canShow(OWN)).toBe(false)
      front = undefined
      expect(adapter.canShow(HELD)).toBe(false)
    })
  })

  describe('words', () => {
    it("are typed into the agent's own block only, checked against its foreground before the words and before Enter", async () => {
      const { adapter, calls, waits } = recorder()
      expect(adapter.canType(OWN)).toBe(true)
      expect(adapter.canType(HELD)).toBe(false)
      expect(await adapter.type(OWN, '-n hello --flag', 'codex', () => true)).toBe(true)
      expect(calls).toEqual([processRead, ran('send', '-s', SESSION, '-b', BLOCK, '--', '-n hello --flag'), processRead,
        ran('send-key', '-s', SESSION, '-b', BLOCK, 'enter')])
      expect(waits).toEqual([rexSettle('-n hello --flag'.length)])
    })

    it('a block whose foreground is another process takes nothing: the agent left it, or a shell is there now', async () => {
      const { adapter, calls } = recorder({}, { foreground: () => PID + 1 })
      expect(await adapter.type(OWN, 'next', 'claude', () => true)).toBe(false)
      expect(calls).toEqual([processRead])
    })

    it('no Enter when the agent left its prompt, or its block, during the settle', async () => {
      const left = recorder()
      expect(await left.adapter.type(OWN, 'next', 'claude', () => false)).toBe(false)
      expect(left.calls.map((c) => c.args[0])).toEqual(['block', 'send'])
      const gone = recorder({}, { foreground: (call) => (call === 0 ? PID : PID + 1) })
      expect(await gone.adapter.type(OWN, 'next', 'claude', () => true)).toBe(false)
      expect(gone.calls.map((c) => c.args[0])).toEqual(['block', 'send', 'block'])
    })

    it('control characters become spaces, so the words are one line and nothing steers the screen', async () => {
      const { adapter, calls } = recorder()
      expect(await adapter.type(OWN, 'a\nb\u001b[2Jc', 'claude', () => true)).toBe(true)
      expect(calls[1]).toEqual(ran('send', '-s', SESSION, '-b', BLOCK, '--', 'a b [2Jc'))
    })

    it('empty, too long, a failed send or a second send to the same block at once: false, with no Enter', async () => {
      const { adapter } = recorder()
      expect(await adapter.type(OWN, '', 'claude')).toBe(false)
      expect(await adapter.type(OWN, 'x'.repeat(MAX_TEXT + 1), 'claude')).toBe(false)
      const failed = recorder({}, { fail: 'send' })
      expect(await failed.adapter.type(OWN, 'next', 'claude')).toBe(false)
      expect(failed.calls.some((c) => c.args[0] === 'send-key')).toBe(false)
      let release!: () => void
      const slow = recorder({ wait: () => new Promise<void>((done) => { release = done }) })
      const first = slow.adapter.type(OWN, 'one', 'claude')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      expect(await slow.adapter.type(OWN, 'two', 'claude')).toBe(false)
      expect(await slow.adapter.show(OWN, 'a1')).toBe('busy')
      release()
      expect(await first).toBe(true)
    })

    it('the settle grows with the words and stops at the longest every typed host waits', () => {
      expect(rexSettle(0)).toBe(INJECT_PASTE_DELAY_BASE_MS)
      expect(rexSettle(600)).toBe(INJECT_PASTE_DELAY_BASE_MS + 10)
      expect(rexSettle(13_039)).toBe(Math.min(INJECT_PASTE_DELAY_MAX_MS, INJECT_PASTE_DELAY_BASE_MS + 217))
      expect(rexSettle(10_000_000)).toBe(INJECT_PASTE_DELAY_MAX_MS)
    })
  })
})

describe('a stroke on a Rex agent', () => {
  const { sessionView } = RECORDED_REX
  /** The recorder, its view of the session as the recorded `dial-test` one, but for the env's block, and its clock. */
  /** The recorded `dial-test` view, whose active window focuses its shell's block: here the env's block. */
  const VIEW = sessionView.stdout.replaceAll('block:01a21118-b015-7718-a224-c2fa6ebb90f6', BLOCK)
  /** A recorder whose session view is VIEW, with a clock; the pageKeys deadline never passes, every other wait at once. */
  const stroke = (over: Partial<RexDeps> = {}, opts: Parameters<typeof recorder>[1] = {}) => {
    let clock = 0
    const made = recorder({
      now: () => clock,
      wait: async (ms) => { if (ms === REX_PAGE_KEYS_MS) await new Promise(() => {}) },
      ...over,
    }, { view: VIEW, ...opts })
    return { ...made, tick: (ms: number) => { clock += ms } }
  }
  /** Lets the pages that wait run out: each is a few awaits and a gap that passes at once. */
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)) }
  const keys = (calls: Call[]) => calls.filter((c) => c.args[0] === 'send-key').map((c) => c.args.at(-1))
  /** Each `rex send` of wheel events, as its direction and count: `up×3`. */
  const wheels = (calls: Call[]) => calls.filter((c) => c.args[0] === 'send').map((c) => {
    const text = c.args.at(-1)!
    const up = (text.match(/\x1b\[<64;10;10M/g) ?? []).length
    const down = (text.match(/\x1b\[<65;10;10M/g) ?? []).length
    return up ? `up×${up}` : `down×${down}`
  })
  const appScrolls = (calls: Call[]) => calls.filter((c) => c.args[2] === 'client.perform')
    .map((c) => (JSON.parse(c.args[3]) as { action: string; block_id: string }))

  it('only on the agent\'s own block, with Rex in front', () => {
    let front: string | undefined = 'rex'
    const { adapter } = stroke({ front: () => front })
    expect(adapter.canScroll!(OWN)).toBe(true)
    expect(adapter.canScroll!(HELD)).toBe(false)
    front = 'ghostty'
    expect(adapter.canScroll!(OWN)).toBe(false)
  })

  // The devices ask a pane either onScreen or pageKeys (devices.ts routeOf): Claude Code fullscreen needs the second.
  it('asks no onScreen, so the devices ask its page keys', () => {
    expect(stroke().adapter.onScreen).toBeUndefined()
  })

  it("page keys for Claude Code drawn fullscreen, at no question, in its block's foreground", async () => {
    const agent = { asking: false, cwd: '/work/api', transcriptPath: '/t/s.jsonl' }
    const fullscreen = vi.fn(async () => true)
    expect(await stroke({ fullscreen }).adapter.pageKeys!(OWN, agent)).toBe(true)
    expect(fullscreen).toHaveBeenCalledWith('/work/api', '/t/s.jsonl')
    expect(await stroke({ fullscreen: async () => false }).adapter.pageKeys!(OWN, agent)).toBe(false)
    expect(await stroke({ fullscreen }, { foreground: () => PID + 1 }).adapter.pageKeys!(OWN, agent)).toBe(false)
    expect(await stroke({ fullscreen: async () => { throw new Error('unreadable') } }).adapter.pageKeys!(OWN, agent)).toBe(false)
    // None asked: a question open, a folder not absolute, no settings reader, a held block.
    expect(stroke({ fullscreen }).adapter.pageKeys!(OWN, { ...agent, asking: true })).toBe(false)
    expect(stroke({ fullscreen }).adapter.pageKeys!(OWN, { ...agent, cwd: 'work' })).toBe(false)
    expect(stroke().adapter.pageKeys!(OWN, agent)).toBe(false)
    expect(stroke({ fullscreen }).adapter.pageKeys!(HELD, agent)).toBe(false)
    // Past its deadline: no.
    const slow = stroke({ fullscreen: () => new Promise(() => {}), wait: async () => {} })
    expect(await slow.adapter.pageKeys!(OWN, agent)).toBe(false)
  })

  // A page key moved Claude Code half a screen at a time, which read as jerky (Diego, 2026-11-25): a wheel line is about
  // one line (measured in Rex, 65 → 64 → 63 and back).
  it('each dial line is one wheel line, toward older lines the wheel up, up to 10 in one send', async () => {
    const { adapter, calls } = stroke()
    adapter.scroll!(OWN, -3, true)
    await settle()
    expect(wheels(calls)).toEqual(['up×3'])
    adapter.scroll!(OWN, 2, true)
    await settle()
    expect(wheels(calls)).toEqual(['up×3', 'down×2'])
    adapter.scroll!(OWN, -14, true)
    await settle()
    expect(wheels(calls)).toEqual(['up×3', 'down×2', 'up×10', 'up×4'])
    expect(keys(calls)).toEqual([])
    expect(calls.find((c) => c.args[0] === 'send')!.args.slice(0, 6)).toEqual(['send', '-s', SESSION, '-b', BLOCK, '--'])
  })

  it('a fling waits for no more than 20 wheel lines either way', async () => {
    const { adapter, calls } = stroke()
    adapter.scroll!(OWN, -200, true)
    await settle()
    expect(wheels(calls)).toEqual(['up×10', 'up×10'])
  })

  it("with no page keys, 8 dial lines are one page of Rex's scrollback; the rest carries, and a pause forgets it", async () => {
    const { adapter, calls, tick } = stroke()
    adapter.scroll!(OWN, -5)
    await settle()
    expect(appScrolls(calls)).toEqual([])
    adapter.scroll!(OWN, -11)
    await settle()
    expect(appScrolls(calls).map((s) => s.action)).toEqual(['client.scroll.page_up', 'client.scroll.page_up'])
    adapter.scroll!(OWN, -7)
    tick(REX_SCROLL_IDLE_MS)
    adapter.scroll!(OWN, -7)
    await settle()
    expect(appScrolls(calls)).toHaveLength(2)
    // A fling waits for no more than 4 pages.
    adapter.scroll!(OWN, -200)
    await settle()
    expect(appScrolls(calls)).toHaveLength(6)
  })

  it("with no page keys, the Rex app's Scroll Page Up or Down of that block, asked of this user's app", async () => {
    const { adapter, calls } = stroke()
    adapter.scroll!(OWN, -8)
    await settle()
    adapter.scroll!(OWN, 8)
    await settle()
    expect(appScrolls(calls)).toEqual([
      expect.objectContaining({ action: 'client.scroll.page_up', block_id: BLOCK }),
      expect.objectContaining({ action: 'client.scroll.page_down', block_id: BLOCK }),
    ])
    expect(keys(calls)).toEqual([])
  })

  it('nothing for a held block, no lines, or no rex', async () => {
    const { adapter, calls } = stroke()
    adapter.scroll!(HELD, -80, true)
    adapter.scroll!(OWN, 0, true)
    await settle()
    expect(calls).toEqual([])
    const none = stroke({ rex: ABSENT })
    none.adapter.scroll!(OWN, -8, true)
    await settle()
    expect(none.calls).toEqual([])
  })
})

describe("Rex's layout and focus reads", () => {
  const { sessions, sessionView, title, titleNone } = RECORDED_REX
  const DIAL_TEST = 'session:01a21118-b015-74f1-b8fd-c4b33bb58038'
  const WORK = 'session:01a1aadc-a884-75c0-925a-c90dbad4c89f'
  const ids = JSON.parse(sessionView.stdout) as { windows: Array<{ window_id: string; layers: Array<{ blocks: Array<{ block_id: string }> }> }> }
  const [shell, codex, claude, split] = ids.windows.flatMap((w) => w.layers.flatMap((l) => l.blocks.map((b) => b.block_id)))
  /** The recorded server: `work` holds no window; `dial-test` its recorded view. Each block's foreground is pid 100 + its
   *  index, and only Claude's block set a title. [fail] names a session whose view fails. */
  function reads(fail?: string) {
    const calls: string[][] = []
    const run: RexDeps['run'] = async (_file, args) => {
      calls.push(args)
      if (args[0] === 'ls') return { code: 0, stdout: sessions.stdout }
      if (args[0] === 'api') {
        const session = args[3]
        if (session === fail) return { code: 1, stdout: '' }
        return session === DIAL_TEST ? { code: 0, stdout: sessionView.stdout }
          : { code: 0, stdout: JSON.stringify({ session_id: WORK, label: 'work', windows: [] }) }
      }
      const block = args[5]
      if (args[6] === 'title') return block === claude ? { code: 0, stdout: title.stdout } : { code: 0, stdout: titleNone.stdout }
      return { code: 0, stdout: JSON.stringify({ foreground: { pid: 100 + [shell, codex, claude, split].indexOf(block) } }) }
    }
    return { calls, reads: createRexReads({ run, rex: FOUND }) }
  }

  it("lists every block in the sidebar's order, with its foreground pid and its program's title", async () => {
    const { reads: r, calls } = reads()
    expect(await r.layout()).toEqual([
      { session: DIAL_TEST, window: ids.windows[0].window_id, block: shell, pid: 100 },
      { session: DIAL_TEST, window: ids.windows[1].window_id, block: codex, pid: 101 },
      { session: DIAL_TEST, window: ids.windows[2].window_id, block: claude, pid: 102, title: 'Phản hồi một chữ OK' },
      { session: DIAL_TEST, window: ids.windows[2].window_id, block: split, pid: 103 },
    ])
    expect(calls[0]).toEqual(['ls', '--json'])
    expect(calls).toContainEqual(['api', 'call', '-s', DIAL_TEST, 'session.view'])
    expect(calls).toContainEqual(['block', 'call', '-s', DIAL_TEST, '-b', claude, 'title'])
  })

  it('a session whose view fails fails the read: a ring half in order would be out of order', async () => {
    expect(await reads(DIAL_TEST).reads.layout()).toBeNull()
  })

  it("each session's focus is the focused block of the window it shows", async () => {
    const { reads: r } = reads()
    expect(await r.focused([DIAL_TEST, WORK])).toEqual(new Map([[DIAL_TEST, shell], [WORK, null]]))
    // One session's read failing keeps the others'.
    expect(await reads(WORK).reads.focused([DIAL_TEST, WORK])).toEqual(new Map([[DIAL_TEST, shell]]))
    expect(await reads(DIAL_TEST).reads.focused([DIAL_TEST])).toBeUndefined()
  })

  it('no rex found: no layout and no focus', async () => {
    const none = createRexReads({ run: async () => ({ code: 0, stdout: '' }), rex: ABSENT })
    expect(await none.layout()).toBeNull()
    expect(await none.focused([DIAL_TEST])).toBeUndefined()
  })

  it('the blocks running a pid: none for no pid, though a block of unknown foreground has none either', () => {
    const panes = [{ session: DIAL_TEST, window: 'w', block: claude, pid: 4242 }, { session: DIAL_TEST, window: 'w', block: shell }]
    expect(rexBlocksRunning(panes, 4242)).toEqual([panes[0]])
    expect(rexBlocksRunning(panes, undefined)).toEqual([])
    expect(rexBlocksRunning(panes, 1)).toEqual([])
  })

  it('pane ids and their parts round-trip, own and held', () => {
    const [own, held] = rexPaneIds(DIAL_TEST, claude, 4242)
    expect(rexPaneParts(own)).toEqual({ session: DIAL_TEST, block: claude, held: false })
    expect(rexPaneParts(held)).toEqual({ session: DIAL_TEST, block: claude, held: true })
    expect(rexPaneIds(DIAL_TEST, claude)).toEqual([held])
    expect(rexPaneParts('x')).toBeUndefined()
  })
})

describe('rexFinder', () => {
  const file = (over: Partial<{ uid: number; mode: number; isFile: boolean }> = {}): Stats =>
    ({ uid: over.uid ?? 501, mode: over.mode ?? 0o100755, isFile: () => over.isFile ?? true }) as unknown as Stats
  const finder = (over: Partial<RexFinderDeps> = {}, files: Record<string, Stats> = {}) =>
    rexFinder({ env: { PATH: '/usr/bin:/bin' }, home: '/Users/u', platform: 'darwin', uid: 501, stat: (path) => files[path], ...over })

  it("finds the Rex Server app's rex under this home, off the daemon's PATH", async () => {
    const fixed = `/Users/u/${REX_BIN}`
    expect(fixed).toBe(FAKE_REX)
    expect(await finder({}, { [fixed]: file() })()).toEqual({ state: 'adopted', path: fixed, from: 'standard install location' })
  })

  it("never one that is not this user's, not executable or not a file", async () => {
    const fixed = `/Users/u/${REX_BIN}`
    for (const st of [file({ uid: 0 }), file({ mode: 0o100644 }), file({ isFile: false })]) {
      expect((await finder({}, { [fixed]: st })()).state).toBe('absent')
    }
  })

  it("takes a rex on PATH only when it is the Rex Server app's: a bare rex is another program", async () => {
    const other = '/opt/homebrew/bin/rex'
    const versioned = '/Users/u/Library/Application Support/com.superlogical.rex/RexServer/Versions/1996/Rex Server.app/Contents/MacOS/rex'
    const versionedDir = versioned.slice(0, versioned.lastIndexOf('/'))
    expect((await finder({ env: { PATH: '/opt/homebrew/bin' } }, { [other]: file() })()).state).toBe('absent')
    expect(await finder({ env: { PATH: versionedDir } }, { [versioned]: file() })())
      .toEqual({ state: 'adopted', path: versioned, from: 'standard install location' })
  })

  it('none off macOS', async () => {
    expect((await finder({ platform: 'linux' }, { [`/Users/u/${REX_BIN}`]: file() })()).state).toBe('absent')
  })
})

describe("Rex's server as a pane's maker", () => {
  it('the recorded chain names Rex: the first parent on no terminal is the Rex Server app', () => {
    expect(ptyMaker(RECORDED_REX.processChain[0].pid, RECORDED_REX.processChain)).toEqual({ pid: 38761, host: 'rex' })
  })

  it('a bare rex is no host', () => {
    const chain = RECORDED_REX.processChain.map((p) => (p.pid === 38761 ? { ...p, executable: '/usr/local/bin/rex' } : p))
    expect(ptyMaker(19445, chain)).toEqual({ pid: 38761 })
  })
})
