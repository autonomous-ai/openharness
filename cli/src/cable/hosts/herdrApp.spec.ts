import { describe, expect, it, vi } from 'vitest'
import type { Place } from './adapter.js'
import type { HcPrompt } from './hcClient.js'
import { createHerdrAppAdapter, type HerdrAppDeps } from './herdrApp.js'

const FAKE_PATH_HERDR_APP = '/fake/bin/herdr-app'
/** Herdr.app's own binary, written out: the adapter's own constant would agree with itself. */
const APP_BINARY = '/Applications/Herdr.app/Contents/MacOS/Herdr'
/** Addresses a hook or a forged hint could send that are no terminal of this machine's. */
const FORGED = ['vps/t7', 'T7', 't', ' t7', 't7\n', '--help', 't7; rm -rf /', `t${'1'.repeat(17)}`]

interface Call { file: string; args: string[]; timeoutMs: number }

/** A recording runner that runs nothing, so no spec opens Herdr or moves its window: each call answers the next of
 *  [codes], then exit 0. Beside it a recording client that opens no socket (its `prompt` answers `sent` unless the test
 *  sets another answer, its socket there), Herdr in front and every terminal shown unless the test says otherwise, and
 *  the log's lines kept. */
function recorder(over: Partial<HerdrAppDeps> = {}, codes: Array<number | null> = []) {
  const calls: Call[] = []
  const log: string[] = []
  const prompt = vi.fn(async (_address: string, _kind: string, _text: string): Promise<HcPrompt> => ({ outcome: 'sent' }))
  const socketStamp = vi.fn((): string | undefined => '1:1')
  const deps: HerdrAppDeps = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return { code: codes.length ? codes.shift()! : 0, stdout: '' }
    },
    onPath: (name) => (name === 'herdr-app' ? FAKE_PATH_HERDR_APP : null),
    exists: () => false,
    platform: 'darwin',
    client: { prompt, socketStamp },
    inFront: () => true,
    shows: () => true,
    log: (line) => log.push(line),
    ...over,
  }
  return { calls, log, prompt, socketStamp, adapter: createHerdrAppAdapter(deps) }
}

/** Lets every step already able to run take place. */
const turn = () => new Promise((resolve) => setImmediate(resolve))

/** The recorder, each command held until the test answers it, so a run can be caught under way. */
function holding() {
  const calls: Call[] = []
  const waiting: Array<(code: number | null) => void> = []
  const rest = recorder({
    run: (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return new Promise((resolve) => waiting.push((code) => resolve({ code, stdout: '' })))
    },
  })
  /** Answers the oldest command still held, and lets what follows it run. */
  const answer = async (code: number | null) => {
    waiting.shift()!(code)
    await turn()
  }
  return { ...rest, calls, answer }
}

/** An answer the test gives when it chooses. */
function held<T>() {
  let give!: (value: T) => void
  const answer = new Promise<T>((resolve) => { give = resolve })
  return { answer, give }
}

const place = (hints: Record<string, string>): Place => ({ host: 'herdr', app: 'herdr', hints })
const pane = (id: string) => ({ adapter: 'herdr-app', id })
const openCall: Call = { file: '/usr/bin/open', args: ['-b', 'dev.herdr.app'], timeoutMs: 10_000 }
const focusCall = (address: string, file = FAKE_PATH_HERDR_APP): Call =>
  ({ file, args: ['do', 'agent.focus', '--terminal', address], timeoutMs: 10_000 })
const FAILED_LINE = '[herdr-app] focus · failed'

describe('the Herdr adapter', () => {
  it('its id is herdr-app, and a tap is its own', () => {
    const { adapter } = recorder()
    expect(adapter.id).toBe('herdr-app')
    expect(adapter.tap).toBe('instead')
    expect(adapter.type).toEqual(expect.any(Function))
    expect(adapter.show).toEqual(expect.any(Function))
    expect(adapter.canShow).toEqual(expect.any(Function))
  })

  // Herdr's window, and hc's socket as the client speaks it, are tried on macOS only.
  it('off macOS it has no pane, no type, no focus and no show', async () => {
    for (const platform of ['linux', 'win32'] as const) {
      const { calls, log, adapter } = recorder({ platform })
      expect(adapter.paneOf(place({ HC_TERMINAL_ID: 't7' })), platform).toBeUndefined()
      expect(adapter.canFocus(pane('t7')), platform).toBe(false)
      expect(adapter.canShow(pane('t7')), platform).toBe(false)
      expect(adapter.type, platform).toBeUndefined()
      expect(adapter.canType, platform).toBeUndefined()
      expect(await adapter.focus(pane('t7')), platform).toBe(false)
      expect(await adapter.show(pane('t7'), 'agent-1'), platform).toBe('failed')
      expect(calls, platform).toEqual([])
      expect(log, platform).toEqual([])
    }
  })

  it('paneOf takes hc\'s address, and refuses any other', () => {
    const { adapter } = recorder()
    for (const id of ['t7', 't1b', `t${'1'.repeat(16)}`]) {
      expect(adapter.paneOf(place({ HC_TERMINAL_ID: id })), id).toEqual(pane(id))
    }
    // hc gives its programs TERM_PROGRAM=ghostty: the address is Herdr's whatever app the other hints name.
    for (const bundle of ['com.mitchellh.ghostty', 'dev.herdr.app', 'com.stablyai.orca']) {
      const hints = { HC_TERMINAL_ID: 't7', TERM_PROGRAM: 'ghostty', __CFBundleIdentifier: bundle }
      expect(adapter.paneOf(place(hints)), bundle).toEqual(pane('t7'))
    }
    expect(adapter.paneOf(place({}))).toBeUndefined()
    expect(adapter.paneOf(place({ HERDR_PANE_ID: 'w1:p1', TERM_PROGRAM: 'ghostty' }))).toBeUndefined()
    for (const id of FORGED) {
      expect(adapter.paneOf(place({ HC_TERMINAL_ID: id })), id).toBeUndefined()
    }
  })

  // Every hc terminal has HC_TERMINAL_ID, hidden `hc run` workers too: a hooked copy in one has the pane for words only.
  it('canFocus is true only for a terminal Herdr\'s window shows; canShow also needs Herdr in front', () => {
    let front = true
    const shown = new Set(['t7'])
    const { adapter } = recorder({ inFront: () => front, shows: (address) => shown.has(address) })
    expect(adapter.canFocus(pane('t7'))).toBe(true)
    expect(adapter.canShow(pane('t7'))).toBe(true)
    expect(adapter.canFocus(pane('t8'))).toBe(false)
    expect(adapter.canShow(pane('t8'))).toBe(false)
    front = false
    expect(adapter.canFocus(pane('t7'))).toBe(true)
    expect(adapter.canShow(pane('t7'))).toBe(false)
    // Asked at each look: the window may have closed the terminal since.
    shown.delete('t7')
    expect(adapter.canFocus(pane('t7'))).toBe(false)
  })

  it('focus opens Herdr, then switches its window to the terminal', async () => {
    const { calls, log, adapter } = recorder()
    expect(await adapter.focus(pane('t7'))).toBe(true)
    expect(calls).toEqual([openCall, focusCall('t7')])
    expect(log).toEqual([])
  })

  it('herdr-app is found on PATH, else at Herdr.app\'s own binary', async () => {
    expect(recorder().adapter.binary()).toBe(FAKE_PATH_HERDR_APP)
    expect(recorder({ exists: (path) => path === APP_BINARY }).adapter.binary()).toBe(FAKE_PATH_HERDR_APP)
    const app = recorder({ onPath: () => null, exists: (path) => path === APP_BINARY })
    expect(app.adapter.binary()).toBe(APP_BINARY)
    expect(await app.adapter.focus(pane('t7'))).toBe(true)
    expect(app.calls).toEqual([openCall, focusCall('t7', APP_BINARY)])
    expect(recorder({ onPath: () => null }).adapter.binary()).toBeNull()
  })

  it('an open that fails is false, and agent.focus does not run', async () => {
    for (const code of [1, null]) {
      const { calls, log, adapter } = recorder({}, [code])
      expect(await adapter.focus(pane('t7')), String(code)).toBe(false)
      expect(calls, String(code)).toEqual([openCall])
      expect(log, String(code)).toEqual([])
    }
  })

  // Herdr is in front once `open` came back: a window still opening may not take the switch (Review Focus 1).
  it('agent.focus that fails after Herdr came forward is true, with one line and no address in it', async () => {
    for (const code of [1, null]) {
      const { calls, log, adapter } = recorder({}, [0, code])
      expect(await adapter.focus(pane('t7')), String(code)).toBe(true)
      expect(calls, String(code)).toEqual([openCall, focusCall('t7')])
      expect(log, String(code)).toEqual([FAILED_LINE])
    }
    const none = recorder({ onPath: () => null })
    expect(await none.adapter.focus(pane('t7'))).toBe(true)
    expect(none.calls).toEqual([openCall])
    expect(none.log).toEqual([FAILED_LINE])
  })

  it('show runs agent.focus alone: ok, or failed with the line', async () => {
    const { calls, log, adapter } = recorder({}, [0, 1, null])
    expect(await adapter.show(pane('t7'), 'agent-1')).toBe('ok')
    expect(log).toEqual([])
    expect(await adapter.show(pane('t7'), 'agent-1')).toBe('failed')
    expect(await adapter.show(pane('t7'), 'agent-1')).toBe('failed')
    expect(calls).toEqual([focusCall('t7'), focusCall('t7'), focusCall('t7')])
    expect(log).toEqual([FAILED_LINE, FAILED_LINE])
    const none = recorder({ onPath: () => null })
    expect(await none.adapter.show(pane('t7'), 'agent-1')).toBe('failed')
    expect(none.calls).toEqual([])
    expect(none.log).toEqual([FAILED_LINE])
  })

  it('an address not in its form runs nothing', async () => {
    const { calls, log, adapter } = recorder()
    for (const id of FORGED) {
      expect(await adapter.focus(pane(id)), id).toBe(false)
      expect(await adapter.show(pane(id), 'agent-1'), id).toBe('failed')
    }
    expect(calls).toEqual([])
    expect(log).toEqual([])
  })

  describe('one run per terminal', () => {
    it('a second focus and a show for that terminal are the same two calls; another terminal runs beside it', async () => {
      const { calls, adapter, answer } = holding()
      const tap = adapter.focus(pane('t7'))
      const again = adapter.focus(pane('t7'))
      const rest = adapter.show(pane('t7'), 'agent-1')
      const other = adapter.focus(pane('t8'))
      await turn()
      expect(calls).toEqual([openCall, openCall])
      await answer(0)
      expect(calls).toEqual([openCall, openCall, focusCall('t7')])
      await answer(0)
      expect(calls).toEqual([openCall, openCall, focusCall('t7'), focusCall('t8')])
      await answer(0)
      expect(await tap).toBe(true)
      expect(await again).toBe(true)
      expect(await rest).toBe('ok')
      await answer(0)
      expect(await other).toBe(true)
      expect(calls).toHaveLength(4)
    })

    // A rest runs only with Herdr in front (canShow): a tap that comes meanwhile finds Herdr forward.
    it('a tap while a show runs is that show, and Herdr is forward', async () => {
      const { calls, log, adapter, answer } = holding()
      const rest = adapter.show(pane('t7'), 'agent-1')
      const tap = adapter.focus(pane('t7'))
      await answer(1)
      expect(await rest).toBe('failed')
      expect(await tap).toBe(true)
      expect(calls).toEqual([focusCall('t7')])
      expect(log).toEqual([FAILED_LINE])
    })

    it('the terminal is free again after a run that failed', async () => {
      const { calls, adapter } = recorder({}, [1])
      expect(await adapter.focus(pane('t7'))).toBe(false)
      expect(await adapter.focus(pane('t7'))).toBe(true)
      expect(await adapter.show(pane('t7'), 'agent-1')).toBe('ok')
      expect(calls).toEqual([openCall, openCall, focusCall('t7'), focusCall('t7')])
    })
  })

  it('type sends the words with the agent\'s engine, and is true only when sent; canType follows hc\'s socket', async () => {
    const { adapter, prompt, socketStamp } = recorder()
    expect(await adapter.type!(pane('t7'), 'next', 'claude')).toBe(true)
    expect(prompt.mock.calls).toEqual([['t7', 'claude', 'next']])
    prompt.mockResolvedValueOnce({ outcome: 'busy' })
    expect(await adapter.type!(pane('t7'), 'next', 'claude')).toBe(false)
    prompt.mockResolvedValueOnce({ outcome: 'failed', fault: 'rejected', kind: 'not_found' })
    expect(await adapter.type!(pane('t7'), 'next', 'claude')).toBe(false)
    expect(adapter.canType!(pane('t7'))).toBe(true)
    socketStamp.mockReturnValue(undefined)
    expect(adapter.canType!(pane('t7'))).toBe(false)
    socketStamp.mockReturnValue('2:2')
    expect(adapter.canType!(pane('t7'))).toBe(true)
  })

  // Review Focus 5: two transcripts typed at once would mix in the agent's prompt.
  it('a second prompt to one terminal while one is under way is busy, and the client is asked once', async () => {
    const { adapter, prompt } = recorder()
    const first = held<HcPrompt>()
    prompt.mockReturnValueOnce(first.answer)
    const words = adapter.prompt('t7', 'claude', 'one')
    expect(await adapter.prompt('t7', 'claude', 'two')).toEqual({ outcome: 'busy' })
    expect(await adapter.prompt('t8', 'claude', 'three')).toEqual({ outcome: 'sent' })
    first.give({ outcome: 'sent' })
    expect(await words).toEqual({ outcome: 'sent' })
    expect(prompt.mock.calls).toEqual([['t7', 'claude', 'one'], ['t8', 'claude', 'three']])
  })

  it('a terminal takes words again after sent, busy and failed, each answered as the client answered', async () => {
    const { adapter, prompt } = recorder()
    const answers: HcPrompt[] = [{ outcome: 'sent' }, { outcome: 'busy' }, { outcome: 'failed', fault: 'timeout' }]
    for (const answer of answers) {
      prompt.mockResolvedValueOnce(answer)
      expect(await adapter.prompt('t7', 'codex', 'run the tests')).toEqual(answer)
    }
    expect(await adapter.prompt('t7', 'codex', 'run the tests')).toEqual({ outcome: 'sent' })
    expect(prompt).toHaveBeenCalledTimes(4)
  })

  // hc types by address, whatever the window shows.
  it('words and a tap do not wait for each other', async () => {
    const typing = recorder()
    const words = held<HcPrompt>()
    typing.prompt.mockReturnValueOnce(words.answer)
    const sending = typing.adapter.prompt('t7', 'claude', 'one')
    expect(await typing.adapter.focus(pane('t7'))).toBe(true)
    expect(typing.calls).toEqual([openCall, focusCall('t7')])
    words.give({ outcome: 'sent' })
    expect(await sending).toEqual({ outcome: 'sent' })

    const tapping = holding()
    const tap = tapping.adapter.focus(pane('t7'))
    expect(await tapping.adapter.prompt('t7', 'claude', 'two')).toEqual({ outcome: 'sent' })
    expect(tapping.prompt.mock.calls).toEqual([['t7', 'claude', 'two']])
    await tapping.answer(0)
    await tapping.answer(0)
    expect(await tap).toBe(true)
  })

  it('paneKey is herdr-app:<address>', () => {
    expect(recorder().adapter.paneKey(pane('t7'))).toBe('herdr-app:t7')
  })
})
