import { describe, expect, it } from 'vitest'
import { RECORDED_ZELLIJ } from '../../testing/recordedZellij.js'
import type { Place } from './adapter.js'
import { MAX_TEXT, type OrcaDeps } from './orca.js'
import { createZellijAdapter } from './zellij.js'

const FAKE_ZELLIJ = '/fake/bin/zellij'
const { env, listPanes, focusPaneId, writeChars, sendKeys, missingPane, missingSession } = RECORDED_ZELLIJ

interface Call { file: string; args: readonly string[]; timeoutMs: number }

/** The recorded listing with its terminal pane [id] left out: the pane closed, or never was. */
const withoutTerminal = (id: number) =>
  JSON.stringify((JSON.parse(listPanes.stdout) as Array<{ id: number; is_plugin: boolean }>).filter((one) => one.is_plugin || one.id !== id))

/** A runner that answers as the recorded session `s1` did, so no spec moves the developer's own Zellij: another session
 *  is gone; `focus-pane-id` fails for a terminal pane the listing lacks; `write-chars` and `send-keys` exit 0 for any
 *  pane. [fail] names a verb that exits 1 instead. */
function recorder(over: Partial<Pick<OrcaDeps, 'run' | 'onPath' | 'platform'>> = {}, panes: string = listPanes.stdout, fail?: string) {
  const calls: Call[] = []
  const deps: Pick<OrcaDeps, 'run' | 'onPath' | 'platform'> = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      const [, session, , verb, id] = args
      if (session !== env.ZELLIJ_SESSION_NAME) return { code: missingSession.code, stdout: '' }
      if (verb === fail) return { code: 1, stdout: '' }
      if (verb === 'list-panes') return { code: listPanes.code, stdout: panes }
      if (verb === 'focus-pane-id') {
        const listed = (JSON.parse(panes) as Array<{ id: number; is_plugin: boolean }>).some((one) => !one.is_plugin && String(one.id) === id)
        return { code: listed ? focusPaneId.code : missingPane.code, stdout: '' }
      }
      return { code: verb === 'write-chars' ? writeChars.code : sendKeys.code, stdout: '' }
    },
    onPath: (name) => (name === 'zellij' ? FAKE_ZELLIJ : null),
    platform: 'linux',
    ...over,
  }
  return { calls, adapter: createZellijAdapter(deps) }
}

const hints = { ZELLIJ: env.ZELLIJ, ZELLIJ_PANE_ID: env.ZELLIJ_PANE_ID, ZELLIJ_SESSION_NAME: env.ZELLIJ_SESSION_NAME }
const place = (over: Record<string, string> = {}, host = 'zellij'): Place => ({ host, app: 'terminal', hints: { ...hints, ...over } })
const pane = (id: string) => ({ adapter: 'zellij', id })
/** A recorded argv, run as the adapter runs it: the binary found on PATH, then the arguments. */
const ran = (args: readonly string[]): Call => ({ file: FAKE_ZELLIJ, args: args.slice(1), timeoutMs: 10_000 })
const typing = (id: string, text: string, session = 's1'): Call[] => [
  ran(['zellij', '--session', session, 'action', 'list-panes', '--json']),
  ran(['zellij', '--session', session, 'action', 'write-chars', '--pane-id', id, '--', text]),
  ran(['zellij', '--session', session, 'action', 'send-keys', '--pane-id', id, 'Enter']),
]

describe('the Zellij adapter', () => {
  it('its id is zellij, it taps before its app, it types, and it has no show and no bundle', () => {
    const { adapter } = recorder()
    expect(adapter.id).toBe('zellij')
    expect(adapter.tap).toBe('before')
    expect(adapter.bundle).toBeUndefined()
    expect(adapter.show).toBeUndefined()
    expect(adapter.canShow).toBeUndefined()
    expect(adapter.canFocus(pane('s1:1'))).toBe(true)
    expect(adapter.canType(pane('s1:1'))).toBe(true)
  })

  it('paneOf takes its two hints, and refuses each out of form', () => {
    const { adapter } = recorder()
    expect(adapter.paneOf(place())).toEqual(pane('s1:1'))
    expect(adapter.paneOf(place({ ZELLIJ_SESSION_NAME: 'a'.repeat(64) }))).toEqual(pane(`${'a'.repeat(64)}:1`))
    expect(adapter.paneOf(place({ ZELLIJ_SESSION_NAME: 'my.proj_2-x', ZELLIJ_PANE_ID: '123456789' }))).toEqual(pane('my.proj_2-x:123456789'))
    for (const session of ['-s1', '--help', 'a/b', '../s1', 'my proj', 'a'.repeat(65), '.s1', 's1:1', '']) {
      expect(adapter.paneOf(place({ ZELLIJ_SESSION_NAME: session })), session).toBeUndefined()
    }
    for (const id of ['terminal_1', 'plugin_0', '-1', '1 ', '1; rm -rf /', '1234567890', '']) {
      expect(adapter.paneOf(place({ ZELLIJ_PANE_ID: id })), id).toBeUndefined()
    }
    expect(adapter.paneOf({ host: 'zellij', app: 'terminal', hints: { ZELLIJ: '0', ZELLIJ_PANE_ID: '1' } })).toBeUndefined()
    expect(adapter.paneOf({ host: 'zellij', app: 'terminal', hints: { ZELLIJ: '0', ZELLIJ_SESSION_NAME: 's1' } })).toBeUndefined()
  })

  it('types only into the agent\'s own pane', async () => {
    const { calls, adapter } = recorder()
    const held = [place({}, 'herdr'), place({}, 'rex'), place({ TMUX_PANE: '%3' })]
    for (const at of held) {
      const found = adapter.paneOf(at)!
      expect(found, at.host).toEqual(pane('held:s1:1'))
      expect(adapter.canType(found)).toBe(false)
      expect(await adapter.type(found, 'hello', 'claude')).toBe(false)
      expect(calls).toEqual([])
    }
    expect(await adapter.focus(pane('held:s1:1'))).toBe(true)
    expect(calls).toEqual([ran(focusPaneId.args)])
  })

  it('a session named held is still the agent\'s own', async () => {
    const { calls, adapter } = recorder({ run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return { code: 0, stdout: args[3] === 'list-panes' ? listPanes.stdout : '' }
    } })
    const found = adapter.paneOf(place({ ZELLIJ_SESSION_NAME: 'held' }))!
    expect(found).toEqual(pane('held:1'))
    expect(adapter.canType(found)).toBe(true)
    expect(await adapter.type(found, 'hello', 'claude')).toBe(true)
    expect(calls).toEqual(typing('1', 'hello', 'held'))
  })

  it('focus runs the recorded focus-pane-id', async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.focus(pane('s1:1'))).toBe(true)
    expect(calls).toEqual([ran(focusPaneId.args)])
  })

  it('types the words with the three recorded calls', async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.type(pane('s1:1'), 'echo agent-words', 'claude')).toBe(true)
    expect(calls).toEqual([ran(listPanes.args), ran(writeChars.args), ran(sendKeys.args)])
  })

  it('a pane that is gone, or a plugin\'s, is not typed into', async () => {
    const gone = recorder({}, withoutTerminal(1))
    expect(await gone.adapter.type(pane('s1:1'), 'hello', 'claude')).toBe(false)
    expect(await gone.adapter.focus(pane('s1:1'))).toBe(false)
    expect(gone.calls).toEqual([ran(listPanes.args), ran(focusPaneId.args)])

    // Plugin 0 is listed, terminal 0 is not: the ids are counted apart.
    const plugin = recorder({}, withoutTerminal(0))
    expect(await plugin.adapter.type(pane('s1:0'), 'hello', 'claude')).toBe(false)
    expect(plugin.calls).toEqual([ran(listPanes.args)])

    const never = recorder()
    expect(await never.adapter.type(pane('s1:9'), 'hello', 'claude')).toBe(false)
    expect(await never.adapter.focus(pane('s1:9'))).toBe(false)
    expect(never.calls).toEqual([ran(listPanes.args), ran(missingPane.args)])
  })

  it('a listing that is not the recorded shape types nothing', async () => {
    for (const stdout of ['', 'not json', '{"id":1,"is_plugin":false}', '[null]', '[{"id":"1","is_plugin":false}]', '[{"id":1}]']) {
      const { calls, adapter } = recorder({}, stdout)
      expect(await adapter.type(pane('s1:1'), 'hello', 'claude'), stdout).toBe(false)
      expect(calls).toEqual([ran(listPanes.args)])
    }
  })

  it('a session that is gone is false', async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.focus(pane('gone:1'))).toBe(false)
    expect(await adapter.type(pane('gone:1'), 'hello', 'claude')).toBe(false)
    expect(calls).toEqual([ran(missingSession.args), ran(['zellij', '--session', 'gone', 'action', 'list-panes', '--json'])])
  })

  it('a call that fails sends nothing after it', async () => {
    const written = recorder({}, listPanes.stdout, 'write-chars')
    expect(await written.adapter.type(pane('s1:1'), 'hello', 'claude')).toBe(false)
    expect(written.calls).toEqual(typing('1', 'hello').slice(0, 2))
    const entered = recorder({}, listPanes.stdout, 'send-keys')
    expect(await entered.adapter.type(pane('s1:1'), 'hello', 'claude')).toBe(false)
    expect(entered.calls).toEqual(typing('1', 'hello'))
  })

  it('one send at a time for a pane', async () => {
    const calls: Call[] = []
    let release = () => {}
    const { adapter } = recorder({
      run: (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs })
        const answer = { code: 0, stdout: args[3] === 'list-panes' ? listPanes.stdout : '' }
        return calls.length === 1 ? new Promise((resolve) => { release = () => resolve(answer) }) : Promise.resolve(answer)
      },
    })
    const first = adapter.type(pane('s1:1'), 'first', 'claude')
    expect(await adapter.type(pane('s1:1'), 'second', 'claude')).toBe(false)
    expect(await adapter.type(pane('s1:0'), 'other', 'claude')).toBe(true)
    release()
    expect(await first).toBe(true)
    expect(await adapter.type(pane('s1:1'), 'third', 'claude')).toBe(true)
    const [listing, ...typed] = typing('1', 'first')
    expect(calls).toEqual([listing, ...typing('0', 'other'), ...typed, ...typing('1', 'third')])
  })

  it('words starting with --, and with control characters', async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.type(pane('s1:1'), '--not-a-flag\nnow\u001b[2J', 'claude')).toBe(true)
    expect(calls).toEqual(typing('1', '--not-a-flag now [2J'))
    expect(await adapter.type(pane('s1:1'), '', 'claude')).toBe(false)
    expect(await adapter.type(pane('s1:1'), 'x'.repeat(MAX_TEXT + 1), 'claude')).toBe(false)
    expect(calls).toHaveLength(3)
  })

  it('a pane id not in its form runs nothing', async () => {
    const { calls, adapter } = recorder()
    for (const id of ['1', 's1', 's1:', ':1', 's1:1; rm -rf /', '-s1:1', 's1:terminal_1', 'held:', 'held:-s1:1', `${'a'.repeat(65)}:1`]) {
      expect(adapter.canType(pane(id)), id).toBe(false)
      expect(await adapter.type(pane(id), 'hello', 'claude'), id).toBe(false)
      expect(await adapter.focus(pane(id)), id).toBe(false)
    }
    expect(calls).toEqual([])
  })

  it('no zellij on PATH: nothing runs', async () => {
    const { calls, adapter } = recorder({ onPath: () => null })
    expect(adapter.canFocus(pane('s1:1'))).toBe(false)
    expect(adapter.canType(pane('s1:1'))).toBe(false)
    expect(await adapter.focus(pane('s1:1'))).toBe(false)
    expect(await adapter.type(pane('s1:1'), 'hello', 'claude')).toBe(false)
    expect(calls).toEqual([])
  })

  it('Windows has no pane', () => {
    const { adapter } = recorder({ platform: 'win32' })
    expect(adapter.paneOf(place())).toBeUndefined()
  })
})
