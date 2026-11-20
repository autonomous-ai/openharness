import { describe, expect, it, vi } from 'vitest'
import type { Place } from './adapter.js'
import type { HerdrPrompt } from './herdrClient.js'
import { createHerdrAdapter, type HerdrAdapterDeps } from './herdr.js'

const FAKE_PATH_HERDR = '/fake/bin/herdr'

interface Call { file: string; args: string[]; timeoutMs: number }

/** A recording runner that runs nothing, so no spec moves the developer's own herdr: each call answers the next of
 *  [codes], then exit 0. Beside it a recording client that opens no socket: its `prompt` answers what the test sets,
 *  `sent` by default, and its socket is there unless the test says otherwise. Terminal is in front unless the test
 *  says otherwise. */
function recorder(over: Partial<HerdrAdapterDeps> = {}, codes: Array<number | null> = []) {
  const calls: Call[] = []
  const prompt = vi.fn(async (_paneId: string, _kind: string, _text: string): Promise<HerdrPrompt> => ({ outcome: 'sent' }))
  const socketStamp = vi.fn((): string | undefined => '1:1')
  // No herdr found running: herdr is on PATH or nowhere.
  const client = { prompt, socketStamp, binary: (): string | undefined => undefined }
  const deps: HerdrAdapterDeps = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return { code: codes.length ? codes.shift()! : 0, stdout: '' }
    },
    onPath: (name) => (name === 'herdr' ? FAKE_PATH_HERDR : null),
    exists: () => false,
    platform: 'darwin',
    client,
    front: () => 'terminal-app',
    ...over,
  }
  return { calls, prompt, socketStamp, adapter: createHerdrAdapter(deps) }
}

const place = (hints: Record<string, string>): Place => ({ host: 'herdr', app: 'herdr', hints })
const pane = (id: string) => ({ adapter: 'herdr', id })
const focusCall = (id: string): Call => ({ file: FAKE_PATH_HERDR, args: ['agent', 'focus', id], timeoutMs: 10_000 })
/** Lets every step already able to run take place. */
const turn = () => new Promise((resolve) => setImmediate(resolve))

/** An answer the test gives when it chooses. */
function held<T>() {
  let give!: (value: T) => void
  const answer = new Promise<T>((resolve) => { give = resolve })
  return { answer, give }
}

describe('the herdr adapter', () => {
  it('its id is herdr, it taps before its app, it types, and it shows', () => {
    const { adapter } = recorder()
    expect(adapter.id).toBe('herdr')
    expect(adapter.tap).toBe('before')
    expect(adapter.show).toEqual(expect.any(Function))
    expect(adapter.canShow).toEqual(expect.any(Function))
    expect(adapter.type).toEqual(expect.any(Function))
    expect(adapter.canFocus(pane('w1:p2'))).toBe(true)
  })

  it('paneOf takes a pane id, and refuses any other', () => {
    const { adapter } = recorder()
    expect(adapter.paneOf(place({ HERDR_PANE_ID: 'w1:p2' }))).toEqual(pane('w1:p2'))
    expect(adapter.paneOf(place({ __CFBundleIdentifier: 'com.mitchellh.ghostty', HERDR_PANE_ID: 'w1:p2' }))).toEqual(pane('w1:p2'))
    expect(adapter.paneOf(place({}))).toBeUndefined()
    for (const id of ['--help', 'w1:p1; rm -rf /', 'w1', ' w1:p1', 'w1:t1', 'p1']) {
      expect(adapter.paneOf(place({ HERDR_PANE_ID: id })), id).toBeUndefined()
    }
  })

  it('paneOf takes an id with herdr\'s letters, w2:pE', () => {
    const { adapter } = recorder()
    expect(adapter.paneOf(place({ HERDR_PANE_ID: 'w2:pE' }))).toEqual(pane('w2:pE'))
    expect(adapter.paneOf({ ...place({ HERDR_PANE_ID: 'w2:pE' }), outer: { app: 'terminal-app', tty: '/dev/ttys004' } }))
      .toEqual(pane('w2:pE:terminal-app'))
  })

  it('focus and show run herdr agent focus w2:pE', async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.focus(pane('w2:pE'))).toBe(true)
    expect(await adapter.show!(pane('w2:pE:terminal-app'), 'agent-1')).toBe('ok')
    expect(calls).toEqual([focusCall('w2:pE'), focusCall('w2:pE')])
  })

  it('focus focuses the agent', async () => {
    const { calls, adapter } = recorder({}, [0, 1, null])
    expect(await adapter.focus(pane('w1:p2'))).toBe(true)
    expect(await adapter.focus(pane('w1:p2'))).toBe(false)
    expect(await adapter.focus(pane('w1:p2'))).toBe(false)
    expect(calls).toEqual([focusCall('w1:p2'), focusCall('w1:p2'), focusCall('w1:p2')])
  })

  it('with no herdr on PATH nothing runs', async () => {
    const { calls, adapter } = recorder({ onPath: () => null })
    expect(await adapter.focus(pane('w1:p2'))).toBe(false)
    expect(calls).toEqual([])
  })

  // herdr's zip on Windows puts it on no PATH: the herdr that wrote the marker is the one the client saw running.
  it('with no herdr on PATH a tap runs the herdr the client found running, and herdr on PATH first', async () => {
    const found = 'C:\\herdr\\herdr.exe'
    const { calls, adapter } = recorder({ onPath: () => null, platform: 'win32', client: { prompt: vi.fn(), socketStamp: () => '1:1', binary: () => found } })
    expect(await adapter.focus(pane('w1:p2'))).toBe(true)
    expect(calls).toEqual([{ file: found, args: ['agent', 'focus', 'w1:p2'], timeoutMs: 10_000 }])
    const onPath = recorder({ platform: 'win32', client: { prompt: vi.fn(), socketStamp: () => '1:1', binary: () => found } })
    expect(await onPath.adapter.focus(pane('w1:p2'))).toBe(true)
    expect(onPath.calls).toEqual([focusCall('w1:p2')])
  })

  it('a pane id not in its form runs nothing', async () => {
    const { calls, adapter, prompt } = recorder()
    for (const id of ['--help', 'w1:p1; rm -rf /', 'w1', ' w1:p1', 'w1:t1', 'p1',
      'w1:p2:Terminal', 'w1:p2:terminal-app:x', 'w1:p2:', 'w1:p2:1', 'w1:p2:nope']) {
      expect(await adapter.focus(pane(id)), id).toBe(false)
      expect(await adapter.show!(pane(id), 'agent-1'), id).toBe('failed')
      expect(adapter.canShow!(pane(id)), id).toBe(false)
      expect(await adapter.type!(pane(id), 'next', 'claude'), id).toBe(false)
    }
    expect(calls).toEqual([])
    expect(prompt).not.toHaveBeenCalled()
  })

  it('type sends the words with the agent\'s engine, and is true only when sent', async () => {
    const { adapter, prompt } = recorder()
    expect(await adapter.type!(pane('w1:p2'), 'next', 'claude')).toBe(true)
    expect(prompt.mock.calls).toEqual([['w1:p2', 'claude', 'next']])
    prompt.mockResolvedValueOnce({ outcome: 'busy' })
    expect(await adapter.type!(pane('w1:p2'), 'next', 'claude')).toBe(false)
    prompt.mockResolvedValueOnce({ outcome: 'failed', fault: 'rejected', code: 'agent_not_ready' })
    expect(await adapter.type!(pane('w1:p2'), 'next', 'claude')).toBe(false)
  })

  // A daemon started by launchd or systemd may not have the shell's XDG_CONFIG_HOME, and so no socket where herdr's is:
  // the words then skip herdr (observed.ts), and no other app types into a multiplexer's pane (orca.ts).
  it('it types only while herdr\'s socket is there, asked at each look', () => {
    const { adapter, socketStamp } = recorder()
    expect(adapter.canType!(pane('w1:p2'))).toBe(true)
    socketStamp.mockReturnValue(undefined)
    expect(adapter.canType!(pane('w1:p2'))).toBe(false)
    socketStamp.mockReturnValue('2:2')
    expect(adapter.canType!(pane('w1:p2'))).toBe(true)
  })

  it('prompt answers what the client answered', async () => {
    for (const answer of [{ outcome: 'sent' }, { outcome: 'busy' }, { outcome: 'failed', fault: 'rejected', code: 'agent_not_ready' }] as HerdrPrompt[]) {
      const { adapter, prompt } = recorder()
      prompt.mockResolvedValueOnce(answer)
      expect(await adapter.prompt('w1:p2', 'codex', 'run the tests')).toEqual(answer)
      expect(prompt.mock.calls).toEqual([['w1:p2', 'codex', 'run the tests']])
    }
  })

  it('paneKey is herdr:<pane id>', () => {
    expect(recorder().adapter.paneKey(pane('w1:p2'))).toBe('herdr:w1:p2')
  })

  // The client speaks herdr's pipe on Windows (herdrClient.ts): the words go over it, and a tap is the command, as
  // everywhere.
  it('on Windows it types while herdr\'s marker is there, and a tap runs the same command', async () => {
    const { calls, adapter, prompt, socketStamp } = recorder({ platform: 'win32' })
    expect(adapter.canType!(pane('w1:p2'))).toBe(true)
    socketStamp.mockReturnValue(undefined)
    expect(adapter.canType!(pane('w1:p2'))).toBe(false)
    expect(await adapter.type!(pane('w1:p2'), 'next', 'claude')).toBe(true)
    expect(prompt.mock.calls).toEqual([['w1:p2', 'claude', 'next']])
    expect(adapter.paneOf(place({ HERDR_PANE_ID: 'w1:p2' }))).toEqual(pane('w1:p2'))
    expect(await adapter.focus(pane('w1:p2'))).toBe(true)
    expect(calls).toEqual([focusCall('w1:p2')])
  })

  describe('a pane with its app', () => {
    const outerPlace = (outer?: Place['outer']): Place => ({ ...place({ HERDR_PANE_ID: 'w1:p2' }), ...(outer ? { outer } : {}) })

    it('paneOf adds the outer app when it is one of the apps', () => {
      const { adapter } = recorder()
      expect(adapter.paneOf(outerPlace({ app: 'terminal-app', tty: '/dev/ttys004' }))).toEqual(pane('w1:p2:terminal-app'))
      expect(adapter.paneOf(outerPlace({ app: 'orca' }))).toEqual(pane('w1:p2:orca'))
      expect(adapter.paneOf(outerPlace({ app: 'nope' }))).toEqual(pane('w1:p2'))
      expect(adapter.paneOf(outerPlace())).toEqual(pane('w1:p2'))
    })

    it('every verb takes the bare pane id', async () => {
      const { calls, adapter, prompt } = recorder()
      expect(await adapter.focus(pane('w1:p2:terminal-app'))).toBe(true)
      expect(calls).toEqual([focusCall('w1:p2')])
      expect(await adapter.type!(pane('w1:p2:terminal-app'), 'next', 'claude')).toBe(true)
      expect(prompt.mock.calls).toEqual([['w1:p2', 'claude', 'next']])
      expect(adapter.paneKey(pane('w1:p2:terminal-app'))).toBe('herdr:w1:p2')
    })

    it('canShow: only a pane with an app, only while that app is in front', () => {
      let front: string | undefined = 'terminal-app'
      const { adapter } = recorder({ front: () => front })
      expect(adapter.canShow!(pane('w1:p2:terminal-app'))).toBe(true)
      expect(adapter.canShow!(pane('w1:p2'))).toBe(false)
      front = 'ghostty'
      expect(adapter.canShow!(pane('w1:p2:terminal-app'))).toBe(false)
      front = undefined
      expect(adapter.canShow!(pane('w1:p2:terminal-app'))).toBe(false)
    })

    it('show focuses the pane: ok when herdr agent focus exits 0, else failed', async () => {
      for (const [code, switched] of [[0, 'ok'], [1, 'failed'], [null, 'failed']] as const) {
        const { calls, adapter } = recorder({}, [code])
        expect(await adapter.show!(pane('w1:p2:terminal-app'), 'agent-1'), String(code)).toBe(switched)
        expect(calls).toEqual([focusCall('w1:p2')])
      }
      const { calls, adapter } = recorder({ onPath: () => null })
      expect(await adapter.show!(pane('w1:p2:terminal-app'), 'agent-1')).toBe('failed')
      expect(calls).toEqual([])
    })

    it('the bare id and the id with its app share one turn', async () => {
      const ran = held<{ code: number | null; stdout: string }>()
      const run = vi.fn((_file: string, _args: string[], _timeoutMs: number) => ran.answer)
      const { adapter, prompt } = recorder({ run })
      const tap = adapter.focus(pane('w1:p2'))
      const shown = adapter.show!(pane('w1:p2:terminal-app'), 'agent-1')
      const words = adapter.prompt('w1:p2', 'claude', 'one')
      // A second prompt meanwhile is busy, the first still waiting its turn.
      expect(await adapter.prompt('w1:p2', 'claude', 'two')).toEqual({ outcome: 'busy' })
      await turn()
      expect(prompt).not.toHaveBeenCalled()
      ran.give({ code: 0, stdout: '' })
      expect(await tap).toBe(true)
      expect(await shown).toBe('ok')
      expect(await words).toEqual({ outcome: 'sent' })
      expect(run.mock.calls).toEqual([[FAKE_PATH_HERDR, ['agent', 'focus', 'w1:p2'], 10_000]])
      expect(prompt.mock.calls).toEqual([['w1:p2', 'claude', 'one']])
    })
  })

  describe('one operation per pane at a time', () => {
    it('a second prompt for that pane is busy, and the client was asked once; another pane\'s prompt runs', async () => {
      const { adapter, prompt } = recorder()
      const first = held<HerdrPrompt>()
      prompt.mockReturnValueOnce(first.answer)
      const words = adapter.prompt('w1:p2', 'claude', 'one')
      expect(await adapter.prompt('w1:p2', 'claude', 'two')).toEqual({ outcome: 'busy' })
      expect(await adapter.prompt('w1:p3', 'claude', 'three')).toEqual({ outcome: 'sent' })
      first.give({ outcome: 'sent' })
      expect(await words).toEqual({ outcome: 'sent' })
      expect(prompt.mock.calls).toEqual([['w1:p2', 'claude', 'one'], ['w1:p3', 'claude', 'three']])
    })

    it('a focus for that pane runs its command only once the prompt has answered', async () => {
      const { calls, adapter, prompt } = recorder()
      const first = held<HerdrPrompt>()
      prompt.mockReturnValueOnce(first.answer)
      const words = adapter.prompt('w1:p2', 'claude', 'one')
      const focused = adapter.focus(pane('w1:p2'))
      // Another pane's tap does not wait.
      expect(await adapter.focus(pane('w1:p3'))).toBe(true)
      await turn()
      expect(calls).toEqual([focusCall('w1:p3')])
      first.give({ outcome: 'sent' })
      expect(await words).toEqual({ outcome: 'sent' })
      expect(await focused).toBe(true)
      expect(calls).toEqual([focusCall('w1:p3'), focusCall('w1:p2')])
    })

    it('a second focus while one runs is one command, and both answer its result', async () => {
      const ran = held<{ code: number | null; stdout: string }>()
      const run = vi.fn((_file: string, _args: string[], _timeoutMs: number) => ran.answer)
      const { adapter } = recorder({ run })
      const tap = adapter.focus(pane('w1:p2'))
      const again = adapter.focus(pane('w1:p2'))
      ran.give({ code: 1, stdout: '' })
      expect(await tap).toBe(false)
      expect(await again).toBe(false)
      expect(run.mock.calls).toEqual([[FAKE_PATH_HERDR, ['agent', 'focus', 'w1:p2'], 10_000]])
    })

    it('a prompt asks the client only once a focus under way has ended', async () => {
      const ran = held<{ code: number | null; stdout: string }>()
      const { adapter, prompt } = recorder({ run: async () => ran.answer })
      const focused = adapter.focus(pane('w1:p2'))
      const words = adapter.prompt('w1:p2', 'claude', 'one')
      // A second prompt meanwhile is busy, the first still waiting its turn.
      expect(await adapter.prompt('w1:p2', 'claude', 'two')).toEqual({ outcome: 'busy' })
      await turn()
      expect(prompt).not.toHaveBeenCalled()
      ran.give({ code: 0, stdout: '' })
      expect(await focused).toBe(true)
      expect(await words).toEqual({ outcome: 'sent' })
      expect(prompt.mock.calls).toEqual([['w1:p2', 'claude', 'one']])
    })

    it('the pane is free again after sent, busy, failed, and a focus that failed', async () => {
      const { calls, adapter, prompt } = recorder({}, [1])
      for (const answer of [{ outcome: 'sent' }, { outcome: 'busy' }, { outcome: 'failed', fault: 'timeout' }] as HerdrPrompt[]) {
        prompt.mockResolvedValueOnce(answer)
        expect(await adapter.prompt('w1:p2', 'claude', 'one')).toEqual(answer)
      }
      expect(await adapter.focus(pane('w1:p2'))).toBe(false)
      expect(await adapter.prompt('w1:p2', 'claude', 'two')).toEqual({ outcome: 'sent' })
      expect(await adapter.focus(pane('w1:p2'))).toBe(true)
      expect(prompt).toHaveBeenCalledTimes(4)
      expect(calls).toEqual([focusCall('w1:p2'), focusCall('w1:p2')])
    })
  })
})
