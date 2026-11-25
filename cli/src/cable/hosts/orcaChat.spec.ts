import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Place } from './adapter.js'
import { createOrcaAdapter, orcaDeps, type OrcaDeps } from './orca.js'
import { createOrcaChatAdapter, ORCA_CHAT_ADAPTER, ORCA_CHAT_REFUSAL, orcaChatId } from './orcaChat.js'
import { writeExecutable } from '../../testing/executableFixture.js'

// Orca 1.4.271's session ids of its chats, in its two forms (36 and 43 characters on Tony's Mac, 2026-11-23); made up.
const CHAT = '6f1d2c3b-4a5e-4f60-8172-93a4b5c6d7e8'
const CLAUDE_CHAT = 'claude_0a1b2c3d_4e5f_4a6b_8c7d_9e0f1a2b3c4d'
const OTHER_CHAT = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const HANDLE = 'term_0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b'
// Orca's own form of a worktree id: its repo's uuid, `::`, the worktree's folder (made up).
const WT = 'bfeba4a9-ec47-4daa-bdb0-5a6b702b5a08::/Users/someone/made-up'
const OTHER_WT = 'bfeba4a9-ec47-4daa-bdb0-5a6b702b5a08::/Users/someone/other'
const FAKE_PATH_ORCA = '/fake/bin/orca'
const FAILED = '[device] orca activate · failed'

const activated = (worktreeId: string) => ['worktree', 'activate', '--worktree', `id:${worktreeId}`, '--json']
const place = (hints: Record<string, string>): Place => ({ host: 'orca', app: 'orca', hints })
const pane = (id: string) => ({ adapter: ORCA_CHAT_ADAPTER, id })
const settled = () => new Promise((resolve) => setImmediate(resolve))
const shown = (value: unknown) => JSON.stringify(value)

interface Call { file: string; args: string[]; timeoutMs: number }

/** Deps whose `run` runs nothing and exits 0. */
function quiet(): OrcaDeps {
  return { run: async () => ({ code: 0, stdout: '' }), onPath: () => FAKE_PATH_ORCA, exists: () => false, platform: 'darwin' }
}

/** The adapter on a `run` that runs nothing and records each call. With [codes], each call answers the next of them at
 *  once, then exit 0; without, each waits until the test ends it with a code, or rejects it. CHAT's and CLAUDE_CHAT's
 *  worktree is WT. */
function chats(over: Partial<OrcaDeps> = {}, codes?: Array<number | null>) {
  const calls: Call[] = []
  const waiting: Array<(code?: number | null) => void> = []
  const refusing: Array<() => void> = []
  const lines: string[] = []
  const worktrees = new Map([[CHAT, WT], [CLAUDE_CHAT, WT]])
  const adapter = createOrcaChatAdapter({
    run: (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      if (codes) return Promise.resolve({ code: codes.length ? codes.shift()! : 0, stdout: '' })
      return new Promise((resolve, reject) => {
        waiting.push((code = 0) => resolve({ code, stdout: '' }))
        refusing.push(() => reject(new Error('made up')))
      })
    },
    onPath: (name) => (name === 'orca' ? FAKE_PATH_ORCA : null),
    exists: () => false,
    platform: 'darwin',
    worktreeOf: (orcaId) => worktrees.get(orcaId),
    log: (line) => { lines.push(line) },
    ...over,
  })
  return { calls, waiting, refusing, lines, worktrees, adapter }
}

/** The same, each call answered at once. */
const answered = (codes: Array<number | null> = []) => chats({}, codes)

describe('Orca chat adapter', () => {
  it('its id is orca-chat, it activates before Orca comes forward, and its members work when called apart from it', async () => {
    const { calls, adapter } = answered()
    expect(ORCA_CHAT_ADAPTER).toBe('orca-chat')
    expect(adapter.id).toBe('orca-chat')
    expect(adapter.tap).toBe('before')
    expect(adapter.bundle).toBe('com.stablyai.orca')
    const { paneOf, canFocus, canShow, focus, show, voiceRefusal, activate } = adapter
    const own = paneOf(place({ ORCA_AGENT_SESSION_ID: CHAT }))!
    expect(own).toEqual(pane(CHAT))
    expect(canFocus(own)).toBe(true)
    expect(canShow(own)).toBe(true)
    expect(await focus(own)).toBe(true)
    expect(await show(own, 'a1')).toBe('ok')
    expect(await activate(WT)).toBe(true)
    expect(voiceRefusal(place({ ORCA_AGENT_SESSION_ID: CHAT }))).toBe(ORCA_CHAT_REFUSAL)
    expect(calls.map((call) => call.args)).toEqual([activated(WT), activated(WT), activated(WT)])
  })

  it('paneOf names a chat by its Orca session id, and not an agent in an Orca terminal, nor hints outside the bounds', () => {
    const { adapter } = answered()
    expect(adapter.paneOf(place({ ORCA_AGENT_SESSION_ID: CHAT }))).toEqual(pane(CHAT))
    expect(adapter.paneOf(place({ ORCA_AGENT_SESSION_ID: CLAUDE_CHAT, __CFBundleIdentifier: 'com.stablyai.orca' }))).toEqual(pane(CLAUDE_CHAT))
    expect(adapter.paneOf(place({ ORCA_AGENT_SESSION_ID: 'x'.repeat(128) }))).toEqual(pane('x'.repeat(128)))
    // An agent in an Orca terminal carries both names: it is that terminal's (orca.ts), with a handle out of form too.
    for (const handle of [HANDLE, '--help', 'held']) {
      expect(adapter.paneOf(place({ ORCA_AGENT_SESSION_ID: CHAT, ORCA_TERMINAL_HANDLE: handle })), handle).toBeUndefined()
    }
    expect(adapter.paneOf(place({}))).toBeUndefined()
    expect(adapter.paneOf(place({ __CFBundleIdentifier: 'com.stablyai.orca' }))).toBeUndefined()
    for (const id of ['', 'x'.repeat(129), `${CHAT}\n`, 'a\u0000b', `${CHAT}\u007f`, `${CHAT}\u0085`, `\u001b[2J${CHAT}`]) {
      expect(adapter.paneOf(place({ ORCA_AGENT_SESSION_ID: id })), shown(id)).toBeUndefined()
      expect(orcaChatId({ ORCA_AGENT_SESSION_ID: id }), shown(id)).toBeUndefined()
    }
    expect(orcaChatId({ ORCA_AGENT_SESSION_ID: CHAT })).toBe(CHAT)
    expect(orcaChatId({ ORCA_AGENT_SESSION_ID: CHAT, ORCA_TERMINAL_HANDLE: HANDLE })).toBeUndefined()
    expect(orcaChatId({})).toBeUndefined()
  })

  it('a tap and a rest run worktree activate with the chat\'s worktree id as one argument', async () => {
    const { calls, adapter } = answered([0, 1])
    expect(await adapter.focus(pane(CHAT))).toBe(true)
    expect(calls).toEqual([{ file: FAKE_PATH_ORCA, args: activated(WT), timeoutMs: 10_000 }])
    // A rest activates too: a chat has no tab to switch to. One that failed says so.
    expect(await adapter.show(pane(CLAUDE_CHAT), 'a1')).toBe('failed')
    expect(await adapter.show(pane(CLAUDE_CHAT), 'a1')).toBe('ok')
    expect(calls.map((call) => call.args)).toEqual([activated(WT), activated(WT), activated(WT)])
  })

  describe('on the real execFile, with a fake orca', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'orca-chat-'))
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('a worktree id with quotes, $( ), spaces and a leading -- reaches orca whole, and no shell reads it', async () => {
      const file = join(dir, 'orca')
      const out = join(dir, 'argv')
      const marker = join(dir, 'ran')
      // Writes its arguments, NUL-separated. Never the real orca.
      writeExecutable(file, `#!/bin/sh\nprintf '%s\\0' "$@" > '${out}'\nexit 0\n`)
      const worktreeId = `-- it's "quoted" $(touch ${marker}) \`touch ${marker}\` ; touch ${marker} | x::/a b`
      const lines: string[] = []
      const adapter = createOrcaChatAdapter({ ...orcaDeps(), onPath: () => file, worktreeOf: () => worktreeId, log: (line) => { lines.push(line) } })
      expect(await adapter.focus(pane(CHAT))).toBe(true)
      expect(readFileSync(out, 'utf8').split('\0').slice(0, -1)).toEqual(activated(worktreeId))
      expect(existsSync(marker)).toBe(false)
      expect(lines).toEqual([])
    })
  })

  it('a chat with no known worktree cannot be focused and runs nothing', async () => {
    const { calls, lines, worktrees, adapter } = answered()
    expect(adapter.canFocus(pane(OTHER_CHAT))).toBe(false)
    expect(adapter.canShow(pane(OTHER_CHAT))).toBe(false)
    expect(await adapter.focus(pane(OTHER_CHAT))).toBe(false)
    expect(await adapter.show(pane(OTHER_CHAT), 'a1')).toBe('failed')
    expect(calls).toEqual([])
    expect(lines).toEqual([])
    // Once a read names its worktree, a tap runs.
    worktrees.set(OTHER_CHAT, OTHER_WT)
    expect(adapter.canFocus(pane(OTHER_CHAT))).toBe(true)
    expect(await adapter.focus(pane(OTHER_CHAT))).toBe(true)
    expect(calls.map((call) => call.args)).toEqual([activated(OTHER_WT)])

    // A pane id outside the bounds is refused before its worktree is asked, whatever the list would say.
    const asked: string[] = []
    const any = createOrcaChatAdapter({ ...quiet(), worktreeOf: (orcaId) => { asked.push(orcaId); return WT }, log: () => {} })
    for (const id of [`${CHAT}\n`, 'x'.repeat(129), '']) {
      expect(any.canFocus(pane(id)), shown(id)).toBe(false)
      expect(any.canShow(pane(id)), shown(id)).toBe(false)
      expect(await any.focus(pane(id)), shown(id)).toBe(false)
      expect(await any.show(pane(id), 'a1'), shown(id)).toBe('failed')
    }
    expect(asked).toEqual([])
  })

  it('no orca on PATH and none in the app runs nothing and says nothing: nothing ran', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      // The app's folder is a macOS path: Linux never runs it.
      const { calls, lines, adapter } = chats({ platform, onPath: () => null, exists: () => platform === 'linux' }, [])
      expect(await adapter.focus(pane(CHAT)), platform).toBe(false)
      expect(await adapter.show(pane(CHAT), 'a1'), platform).toBe('failed')
      expect(await adapter.activate(WT), platform).toBe(false)
      expect(calls, platform).toEqual([])
      expect(lines, platform).toEqual([])
    }
  })

  it('two taps while one activate runs share it', async () => {
    const { calls, waiting, adapter } = chats()
    const rest = adapter.show(pane(CHAT), 'a1')
    const tap = adapter.focus(pane(CHAT))
    // Another chat in the same worktree is the same activate, and so is the chat source's own call.
    const sibling = adapter.focus(pane(CLAUDE_CHAT))
    const resting = adapter.activate(WT)
    await settled()
    expect(calls.map((call) => call.args)).toEqual([activated(WT)])
    // Another worktree is a run of its own, beside it.
    const other = adapter.activate(OTHER_WT)
    await settled()
    expect(calls.map((call) => call.args)).toEqual([activated(WT), activated(OTHER_WT)])
    waiting[0]()
    expect(await rest).toBe('ok')
    expect(await tap).toBe(true)
    expect(await sibling).toBe(true)
    expect(await resting).toBe(true)
    waiting[1](1)
    expect(await other).toBe(false)
    // Once it has ended, a tap runs again.
    const again = adapter.focus(pane(CHAT))
    await settled()
    expect(calls).toHaveLength(3)
    waiting[2]()
    expect(await again).toBe(true)
  })

  it('a failed, timed-out or refused activate answers false and logs one line with no id', async () => {
    for (const end of ['code 1', 'timeout', 'throw'] as const) {
      const { calls, waiting, refusing, lines, adapter } = chats()
      const tapped = adapter.focus(pane(CHAT))
      await settled()
      if (end === 'throw') refusing[0]()
      else waiting[0](end === 'code 1' ? 1 : null)
      expect(await tapped, end).toBe(false)
      expect(lines, end).toEqual([FAILED])
      expect(calls, end).toHaveLength(1)
      // The next rest runs again: a failure keeps nothing.
      const again = adapter.show(pane(CHAT), 'a1')
      await settled()
      waiting[1]()
      expect(await again, end).toBe('ok')
      expect(lines, end).toEqual([FAILED])
    }
    // A run that throws before it answers failed too.
    const thrown = chats({ run: () => { throw new Error('made up') } })
    expect(await thrown.adapter.focus(pane(CHAT))).toBe(false)
    expect(thrown.lines).toEqual([FAILED])

    // A worktree id outside the bounds never reaches orca. 4160 characters is the most Orca's id holds.
    const { calls, lines, adapter } = answered()
    const refused = ['', 'x'.repeat(4161), `${WT}\n`, 'a\u0000b', `${WT}\u001b[2J`, `${WT}\u0085`]
    for (const worktreeId of refused) expect(await adapter.activate(worktreeId), shown(worktreeId)).toBe(false)
    expect(calls).toEqual([])
    expect(lines).toEqual(refused.map(() => FAILED))
    expect(await adapter.activate('x'.repeat(4160))).toBe(true)
    expect(calls.map((call) => call.args)).toEqual([activated('x'.repeat(4160))])
    // Each line is the fixed words alone: no chat, worktree or folder.
    for (const line of [...lines, ...thrown.lines]) {
      for (const secret of [CHAT, WT, 'made-up', 'someone']) expect(line).not.toContain(secret)
    }
  })

  it('voiceRefusal says Type in Orca for chats. for a chat alone', () => {
    const { adapter } = answered()
    expect(ORCA_CHAT_REFUSAL).toBe('Type in Orca for chats.')
    expect(adapter.voiceRefusal(place({ ORCA_AGENT_SESSION_ID: CHAT }))).toBe('Type in Orca for chats.')
    // A chat whose worktree is not known is still a chat.
    expect(adapter.voiceRefusal(place({ ORCA_AGENT_SESSION_ID: OTHER_CHAT }))).toBe('Type in Orca for chats.')
    const others: Array<Record<string, string>> = [{ ORCA_AGENT_SESSION_ID: CHAT, ORCA_TERMINAL_HANDLE: HANDLE }, {},
      { ORCA_AGENT_SESSION_ID: `${CHAT}\n` }, { __CFBundleIdentifier: 'com.stablyai.orca' }, { TERM_PROGRAM: 'iTerm.app' }]
    for (const hints of others) {
      expect(adapter.voiceRefusal(place(hints)), shown(hints)).toBeUndefined()
    }
  })

  it('the adapter has no type: words are never typed for a chat', () => {
    const { calls, adapter } = answered()
    expect('type' in adapter).toBe(false)
    expect(adapter.type).toBeUndefined()
    expect(adapter.canType).toBeUndefined()
    // Nor is a chat one of Orca's terminals, whose adapter types: a chat has none.
    const terminals = createOrcaAdapter(quiet())
    expect(terminals.paneOf({ ...place({ ORCA_AGENT_SESSION_ID: CHAT }), ptyOwner: 'orca' })).toBeUndefined()
    expect(calls).toEqual([])
  })
})
