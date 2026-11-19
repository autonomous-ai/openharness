import { describe, expect, it } from 'vitest'
import type { Place } from './adapter.js'
import type { CmuxInputState } from './cmuxCli.js'
import { createCmuxAppAdapter, type CmuxAppDeps } from './cmuxApp.js'
import { MAX_TEXT } from './orca.js'
import { detectApp, detectHost } from './hostDetect.js'

/** cmux prints its ids in upper case. */
const S = 'A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D'
const S2 = '5D4C3B2A-1F0E-4D9C-8B7A-6F5E4D3C2B1A'
const W = '0F1E2D3C-4B5A-4968-8776-655443322110'
const PANE = `${W}/${S}`
const OPEN = '/usr/bin/open'
const AUTOMATION_OFF = 'Turn on Automation mode in cmux.'
/** Pane ids a hook or a forged hint could send that are no cmux surface. */
const FORGED = ['--help', S, `${W}/x; rm -rf /`, `${W}/${S}/x`, `${W}/${S}\n`, ` ${PANE}`, `${W}/${S.replace('A1', 'Z1')}`]

interface Call { file: string; args: string[]; timeoutMs: number }
type Asked = ['mode'] | ['inputState', string] | ['paste', string, string, string]

/** A prompt free for words, as cmux answers `surface.input_state`. */
const IDLE: CmuxInputState = { terminal: true, agent: true, lifecycle: 'idle', state: 'empty', blocksTyping: false }

/** An answer the test gives when it chooses. */
function held<T>() {
  let give!: (value: T) => void
  const answer = new Promise<T>((resolve) => { give = resolve })
  return { answer, give }
}

/** A recording runner that runs nothing, so no spec opens cmux: each call answers the next of [codes], then exit 0.
 *  Beside it a recording client that runs no cmux: Automation mode on, an idle empty prompt and every paste submitted
 *  unless the test sets another answer, or holds one. cmux found, in front, and listing nothing at any surface. */
function recorder(over: Partial<CmuxAppDeps> = {}, codes: Array<number | null> = []) {
  const runs: Call[] = []
  const asked: Asked[] = []
  const answers: {
    mode: Promise<string | undefined> | string | undefined
    input: Promise<CmuxInputState | undefined> | CmuxInputState | undefined
    pasted: Promise<boolean> | boolean
  } = { mode: 'automation', input: IDLE, pasted: true }
  const deps: CmuxAppDeps = {
    run: async (file, args, timeoutMs) => {
      runs.push({ file, args, timeoutMs })
      return { code: codes.length ? codes.shift()! : 0, stdout: '' }
    },
    platform: 'darwin',
    inFront: () => true,
    client: {
      mode: async () => {
        asked.push(['mode'])
        return answers.mode
      },
      inputState: async (surface) => {
        asked.push(['inputState', surface])
        return answers.input
      },
      paste: async (workspace, surface, text) => {
        asked.push(['paste', workspace, surface, text])
        return answers.pasted
      },
    },
    found: () => true,
    kindAt: () => undefined,
    ...over,
  }
  return { runs, asked, answers, adapter: createCmuxAppAdapter(deps) }
}

/** The recorder, each command held until it is let go, so a link can be caught still running. */
function holding(over: Partial<CmuxAppDeps> = {}) {
  const runs: Call[] = []
  const waiting: Array<(code: number | null) => void> = []
  const rest = recorder({
    run: (file, args, timeoutMs) => {
      runs.push({ file, args, timeoutMs })
      return new Promise((resolve) => waiting.push((code) => resolve({ code, stdout: '' })))
    },
    ...over,
  })
  return { ...rest, runs, waiting }
}

/** The place the observed source gives a hook's hints. */
const detected = (hints: Record<string, string>): Place => ({ host: detectHost(hints), app: detectApp(hints), hints })
const cmuxTerminal = (more: Record<string, string> = {}) =>
  ({ TERM_PROGRAM: 'ghostty', CMUX_SURFACE_ID: S, CMUX_WORKSPACE_ID: W, ...more })
const pane = (id: string) => ({ adapter: 'cmux', id })
const link = (workspace: string, surface: string, file = OPEN): Call =>
  ({ file, args: ['-b', 'com.cmuxterm.app', `cmux://workspace/${workspace}/surface/${surface}`], timeoutMs: 10_000 })

describe('the cmux adapter', () => {
  it('its id is cmux, a tap is its own, and its bundle is cmux\'s', () => {
    const { adapter } = recorder()
    expect(adapter.id).toBe('cmux')
    expect(adapter.tap).toBe('instead')
    expect(adapter.bundle).toBe('com.cmuxterm.app')
  })

  // cmux runs on macOS alone: its ids elsewhere name no app of this computer.
  it('off macOS it has no pane, and nothing focuses, shows or types', async () => {
    for (const platform of ['linux', 'win32'] as const) {
      const { runs, asked, adapter } = recorder({ platform })
      expect(adapter.paneOf(detected(cmuxTerminal())), platform).toBeUndefined()
      expect(adapter.canFocus(pane(PANE)), platform).toBe(false)
      expect(adapter.canShow(pane(PANE)), platform).toBe(false)
      expect(adapter.canType(pane(PANE)), platform).toBe(false)
      expect(await adapter.focus(pane(PANE)), platform).toBe(false)
      expect(await adapter.show(pane(PANE), 'agent-1'), platform).toBe('failed')
      expect(await adapter.type(pane(PANE), 'run the tests', 'claude'), platform).toBe(false)
      expect(await adapter.prompt(PANE, 'claude', 'run the tests'), platform).toBe('no-answer')
      expect(runs, platform).toEqual([])
      expect(asked, platform).toEqual([])
    }
  })

  describe('paneOf', () => {
    it('takes both ids from a cmux terminal, as <workspace>/<surface>', () => {
      const { adapter } = recorder()
      expect(adapter.paneOf(detected(cmuxTerminal()))).toEqual(pane(`${W}/${S}`))
      // cmux's TERM_PROGRAM, or none; each id as the hint has it.
      const lower = { CMUX_SURFACE_ID: S.toLowerCase(), CMUX_WORKSPACE_ID: W.toLowerCase() }
      expect(adapter.paneOf(detected(lower))).toEqual(pane(`${W.toLowerCase()}/${S.toLowerCase()}`))
    })

    // Every program a cmux terminal starts inherits its CMUX_* (`code .`, tmux): there they name the terminal the other
    // app was started from, and a tap would open, and words go to, another agent.
    it('refuses one id alone, an id out of form, any host but cmux, and ids another app inherited', () => {
      const { adapter } = recorder()
      const refused: Array<Record<string, string>> = [
        { TERM_PROGRAM: 'ghostty', CMUX_SURFACE_ID: S },
        { TERM_PROGRAM: 'ghostty', CMUX_WORKSPACE_ID: W },
        cmuxTerminal({ CMUX_SURFACE_ID: `${S}x` }),
        cmuxTerminal({ CMUX_WORKSPACE_ID: '--help' }),
        cmuxTerminal({ CMUX_SURFACE_ID: `${W}/${S}` }),
        cmuxTerminal({ TERM_PROGRAM: 'vscode', __CFBundleIdentifier: 'com.microsoft.VSCode' }),
        cmuxTerminal({ TERM_PROGRAM: 'tmux', TMUX_PANE: '%3' }),
        cmuxTerminal({ TMUX_PANE: '%3' }),
      ]
      for (const hints of refused) {
        expect(adapter.paneOf(detected(hints)), JSON.stringify(hints)).toBeUndefined()
        // Each hint is checked here again, whatever host the place names (adapter.ts rule 1).
        expect(adapter.paneOf({ host: 'cmux', app: 'cmux', hints }), JSON.stringify(hints)).toBeUndefined()
      }
      // The host decides too: the same hints on a place another host holds are not cmux's.
      const ghostty: Place = { host: 'ghostty', app: 'ghostty', hints: cmuxTerminal() }
      expect(adapter.paneOf(ghostty)).toBeUndefined()
    })
  })

  // The hook's id and the store's differ in case alone (Review Focus 5): both are one agent.
  it('paneKey is cmux:<surface> in lower case', () => {
    const { adapter } = recorder()
    expect(adapter.paneKey(pane(`${W}/${S}`))).toBe('cmux:a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')
  })

  it('canFocus is macOS\'s; canType follows whether cmux was found; canShow needs cmux in front', () => {
    let found = true
    let front = true
    const { adapter } = recorder({ found: () => found, inFront: () => front })
    expect(adapter.canFocus(pane(PANE))).toBe(true)
    expect(adapter.canType(pane(PANE))).toBe(true)
    expect(adapter.canShow(pane(PANE))).toBe(true)
    // Asked at each look: cmux may have been removed, or left the front, since the last one.
    found = false
    expect(adapter.canType(pane(PANE))).toBe(false)
    expect(adapter.canFocus(pane(PANE))).toBe(true)
    front = false
    expect(adapter.canShow(pane(PANE))).toBe(false)
    expect(adapter.canFocus(pane(PANE))).toBe(true)
  })

  // The link goes to cmux alone by its bundle id: cmux NIGHTLY registers the same scheme.
  it('focus is one open of cmux\'s link sent to cmux alone, true on exit 0', async () => {
    const { runs, asked, adapter } = recorder()
    expect(await adapter.focus(pane(PANE))).toBe(true)
    expect(runs).toEqual([link(W, S)])
    expect(asked).toEqual([])

    // The end-to-end harness points HARNESS_OPEN_BIN at a fake that opens nothing (open.ts openPath).
    const fake = recorder({ bin: '/x/fake-open' })
    expect(await fake.adapter.focus(pane(PANE))).toBe(true)
    expect(await fake.adapter.show(pane(PANE), 'agent-1')).toBe('ok')
    expect(fake.runs).toEqual([link(W, S, '/x/fake-open'), link(W, S, '/x/fake-open')])
  })

  it('an open that fails is false; show is ok or failed', async () => {
    for (const code of [1, null]) {
      const { runs, adapter } = recorder({}, [code])
      expect(await adapter.focus(pane(PANE)), String(code)).toBe(false)
      expect(runs, String(code)).toEqual([link(W, S)])
    }
    const { runs, adapter } = recorder({}, [0, 1, null])
    expect(await adapter.show(pane(PANE), 'agent-1')).toBe('ok')
    expect(await adapter.show(pane(PANE), 'agent-1')).toBe('failed')
    expect(await adapter.show(pane(PANE), 'agent-1')).toBe('failed')
    expect(runs).toEqual([link(W, S), link(W, S), link(W, S)])
  })

  it('a pane out of form runs nothing', async () => {
    const { runs, asked, adapter } = recorder()
    for (const id of FORGED) {
      expect(await adapter.focus(pane(id)), id).toBe(false)
      expect(await adapter.show(pane(id), 'agent-1'), id).toBe('failed')
      expect(await adapter.type(pane(id), 'run the tests', 'claude'), id).toBe(false)
      expect(await adapter.prompt(id, 'claude', 'run the tests'), id).toBe('no-answer')
    }
    expect(runs).toEqual([])
    expect(asked).toEqual([])
  })

  it('a second rest of that agent while one runs is busy, and runs nothing more', async () => {
    const { runs, waiting, adapter } = holding()
    const first = adapter.show(pane(PANE), 'agent-1')
    expect(await adapter.show(pane(PANE), 'agent-1')).toBe('busy')
    expect(runs).toEqual([link(W, S)])
    waiting.shift()!(0)
    expect(await first).toBe('ok')
  })

  describe('words', () => {
    it('sent: the mode, the input state, then one paste with the workspace, the surface and the text', async () => {
      const { asked, runs, adapter } = recorder()
      expect(await adapter.prompt(PANE, 'claude', 'run the tests')).toBe('sent')
      expect(asked).toEqual([['mode'], ['inputState', S], ['paste', W, S, 'run the tests']])
      expect(runs).toEqual([])
    })

    it('control characters become spaces; a blank text and one over MAX_TEXT characters ask nothing and are no-answer', async () => {
      const { asked, adapter } = recorder()
      expect(await adapter.prompt(PANE, 'claude', 'run\nthe\ttests\u001b[2J')).toBe('sent')
      expect(asked).toEqual([['mode'], ['inputState', S], ['paste', W, S, 'run the tests [2J']])
      asked.length = 0
      for (const text of ['', '   ', '\n\r\t', 'x'.repeat(MAX_TEXT + 1)]) {
        expect(await adapter.prompt(PANE, 'claude', text), JSON.stringify(text.slice(0, 8))).toBe('no-answer')
      }
      expect(asked).toEqual([])
    })

    it('a text of 20,000 characters is pasted whole', async () => {
      const { asked, adapter } = recorder()
      expect(await adapter.prompt(PANE, 'claude', 'x'.repeat(20_000))).toBe('sent')
      expect(asked).toEqual([['mode'], ['inputState', S], ['paste', W, S, 'x'.repeat(20_000)]])
    })

    it.each(['cmuxOnly', 'off', 'password', 'somethingNew'])('mode %s is automation-off, and nothing more is asked', async (mode) => {
      const { asked, answers, adapter } = recorder()
      answers.mode = mode
      expect(await adapter.prompt(PANE, 'claude', 'run the tests')).toBe('automation-off')
      expect(asked).toEqual([['mode']])
    })

    it('allowAll goes on as automation does', async () => {
      const { asked, answers, adapter } = recorder()
      answers.mode = 'allowAll'
      expect(await adapter.prompt(PANE, 'claude', 'run the tests')).toBe('sent')
      expect(asked).toEqual([['mode'], ['inputState', S], ['paste', W, S, 'run the tests']])
    })

    // The mode is not known, so the dial does not say to turn it on.
    it('a mode that could not be read is no-answer, and nothing more is asked', async () => {
      const { asked, answers, adapter } = recorder()
      answers.mode = undefined
      expect(await adapter.prompt(PANE, 'claude', 'run the tests')).toBe('no-answer')
      expect(asked).toEqual([['mode']])
    })

    // socket-status reads the saved setting: a running cmux that has not applied it yet still refuses (Review Focus 3).
    it('the mode reads automation and the socket still refuses: no-answer, and no paste runs', async () => {
      const { asked, answers, adapter } = recorder()
      answers.input = undefined
      expect(await adapter.prompt(PANE, 'claude', 'run the tests')).toBe('no-answer')
      expect(asked).toEqual([['mode'], ['inputState', S]])
    })

    it.each<[string, Partial<CmuxInputState>, string]>([
      ['needsInput', { lifecycle: 'needsInput' }, 'waiting'],
      ['running', { lifecycle: 'running' }, 'busy'],
      ['a draft', { state: 'draft' }, 'busy'],
      ['a dialog', { state: 'dialog', blocksTyping: true }, 'busy'],
      ['no terminal', { terminal: false }, 'no-answer'],
      ['no agent', { agent: false }, 'no-answer'],
      ['an unknown lifecycle', { lifecycle: 'unknown' }, 'no-answer'],
      ['an unknown state', { state: 'unknown' }, 'no-answer'],
      ['blocks_typing with an empty prompt', { blocksTyping: true }, 'no-answer'],
    ])('%s at the prompt is %s, and paste is never asked', async (_what, input, outcome) => {
      const { asked, answers, adapter } = recorder()
      answers.input = { ...IDLE, ...input }
      expect(await adapter.prompt(PANE, 'claude', 'run the tests')).toBe(outcome)
      expect(asked).toEqual([['mode'], ['inputState', S]])
    })

    // The source's kind is read last, just before the paste: another agent may hold the surface now.
    it('another kind at that surface is no-answer; no record there goes on', async () => {
      const other = recorder({ kindAt: (surface) => (surface === S ? 'codex' : undefined) })
      expect(await other.adapter.prompt(PANE, 'claude', 'run the tests')).toBe('no-answer')
      expect(other.asked).toEqual([['mode'], ['inputState', S]])
      expect(await other.adapter.prompt(PANE, 'codex', 'run the tests')).toBe('sent')

      const none = recorder({ kindAt: () => undefined })
      expect(await none.adapter.prompt(PANE, 'claude', 'run the tests')).toBe('sent')
    })

    // cmux's own Draft guard, or a stale id, refuses after the idle read: the words may be at the prompt already, so they
    // are never sent again, and never forced over a draft (Review Focus 4).
    it('a paste cmux refuses after an idle read is no-answer: one paste, none forced', async () => {
      const { asked, answers, adapter } = recorder()
      answers.pasted = false
      expect(await adapter.prompt(PANE, 'claude', 'run the tests')).toBe('no-answer')
      expect(asked).toEqual([['mode'], ['inputState', S], ['paste', W, S, 'run the tests']])
    })

    it('a second prompt for that surface while one runs is busy, and the client is asked once; the surface takes words again after each outcome', async () => {
      const { asked, answers, adapter } = recorder()
      const mode = held<string | undefined>()
      answers.mode = mode.answer
      const words = adapter.prompt(PANE, 'claude', 'one')
      // The same surface in another case, as a store may hold it.
      expect(await adapter.prompt(`${W.toLowerCase()}/${S.toLowerCase()}`, 'claude', 'two')).toBe('busy')
      expect(await adapter.prompt(PANE, 'claude', 'two')).toBe('busy')
      expect(asked).toEqual([['mode']])
      answers.mode = 'automation'
      // Another surface takes words meanwhile.
      expect(await adapter.prompt(`${W}/${S2}`, 'claude', 'three')).toBe('sent')
      mode.give('automation')
      expect(await words).toBe('sent')
      expect(asked.filter(([what]) => what === 'paste')).toEqual([['paste', W, S2, 'three'], ['paste', W, S, 'one']])

      const outcomes: Array<[string, () => void]> = [
        ['busy', () => { answers.input = { ...IDLE, lifecycle: 'running' } }],
        ['waiting', () => { answers.input = { ...IDLE, lifecycle: 'needsInput' } }],
        ['automation-off', () => { answers.mode = 'cmuxOnly' }],
        ['no-answer', () => { answers.pasted = false }],
        ['sent', () => {}],
      ]
      for (const [outcome, set] of outcomes) {
        answers.mode = 'automation'
        answers.input = IDLE
        answers.pasted = true
        set()
        expect(await adapter.prompt(PANE, 'claude', 'again'), outcome).toBe(outcome)
      }
      expect(await adapter.prompt(PANE, 'claude', 'last')).toBe('sent')
    })

    // cmux v0.65.2.2 reads only Claude Code's and Codex's prompts (AgentPromptInputState.swift): another agent's is unknown.
    it('only a Claude Code or Codex agent takes words: a hooked copy of another is not typed into, nor offered words where cmux lists one', async () => {
      let listed: string | undefined = 'opencode'
      const { asked, adapter } = recorder({ kindAt: (surface) => (surface === S ? listed : undefined) })
      expect(adapter.canType(pane(PANE))).toBe(false)
      for (const kind of ['claude', 'codex', undefined]) {
        listed = kind
        expect(adapter.canType(pane(PANE)), String(kind)).toBe(true)
      }
      // At a surface cmux lists nothing at yet, the engine the dial means decides: nothing is asked of cmux.
      expect(await adapter.type(pane(PANE), 'run the tests', 'opencode')).toBe(false)
      expect(await adapter.prompt(PANE, 'gemini', 'run the tests')).toBe('no-answer')
      expect(asked).toEqual([])
    })

    it('type answers true, busy, waiting, the Automation sentence, or false', async () => {
      const { asked, answers, adapter } = recorder({ kindAt: () => 'codex' })
      expect(await adapter.type(pane(PANE), 'run the tests', 'codex')).toBe(true)
      expect(asked).toEqual([['mode'], ['inputState', S], ['paste', W, S, 'run the tests']])
      // The engine is the agent the dial means: another holds the surface.
      expect(await adapter.type(pane(PANE), 'run the tests', 'claude')).toBe(false)
      answers.input = { ...IDLE, lifecycle: 'running' }
      expect(await adapter.type(pane(PANE), 'run the tests', 'codex')).toBe('busy')
      answers.input = { ...IDLE, lifecycle: 'needsInput' }
      expect(await adapter.type(pane(PANE), 'run the tests', 'codex')).toBe('waiting')
      answers.mode = 'cmuxOnly'
      expect(await adapter.type(pane(PANE), 'run the tests', 'codex')).toEqual({ refused: AUTOMATION_OFF })
      answers.mode = 'automation'
      answers.input = IDLE
      answers.pasted = false
      expect(await adapter.type(pane(PANE), 'run the tests', 'codex')).toBe(false)
    })

    // A link opens cmux at a tab; a paste goes to a surface by its id, whatever cmux shows.
    it('words and a tap do not wait for each other', async () => {
      const typing = recorder()
      const mode = held<string | undefined>()
      typing.answers.mode = mode.answer
      const sending = typing.adapter.prompt(PANE, 'claude', 'one')
      expect(await typing.adapter.focus(pane(PANE))).toBe(true)
      expect(await typing.adapter.show(pane(PANE), 'agent-1')).toBe('ok')
      expect(typing.runs).toEqual([link(W, S), link(W, S)])
      mode.give('automation')
      expect(await sending).toBe('sent')

      const tapping = holding()
      const tap = tapping.adapter.focus(pane(PANE))
      const rest = tapping.adapter.show(pane(PANE), 'agent-1')
      expect(await tapping.adapter.prompt(PANE, 'claude', 'two')).toBe('sent')
      expect(tapping.asked).toEqual([['mode'], ['inputState', S], ['paste', W, S, 'two']])
      for (const give of tapping.waiting.splice(0)) give(0)
      expect(await tap).toBe(true)
      expect(await rest).toBe('ok')
    })
  })
})
