import { readInlineScreen } from '../testing/inlineScreen.js'
import { inlineSubmission } from '../testing/inlineSubmission.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionInputController } from './sessionInput.js'
import type { RegisteredSession } from './registry.js'
import { TERMINAL_LEASE_REFUSED, type ProcessIdentity, type TerminalActionResult } from './terminalTypes.js'
import { createScreens } from '../core/engines/screens.js'
import { createSubmissions } from '../core/engines/submissions.js'
import { screenFor } from '../engines/screens.js'
import { submissionFor } from '../engines/submissions.js'
import { submissionPolicy } from '../engines/submissionPolicies.js'

function session(engine: 'claude' | 'codex' | 'cursor' | 'commandcode' = 'codex'): RegisteredSession {
  return {
    schemaVersion: 2,
    active: true,
    sessionId: 's1', engine, launcherId: 'h1', agentId: 'h1', boundAt: 0, transcriptPath: '/tmp/s1.jsonl', projectDir: 'tmp', cwd: '/tmp',
    tmuxPane: '%1', source: null, title: null, model: null, cliVersion: null, processIdentity: null,
    runtimes: [{ backend: 'tmux', paneId: '%1' }], primaryRuntimeKey: 'tmux\u0000%1',
    registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
  }
}

/**
 * The composers as the engines draw them, which a message is typed into only when on screen
 * (composerScreen.ts): Claude Code's ruled box and Codex's bold `›` row under a blank one.
 */
const claudeBox = (draft: string, above = '') => `${above}${'─'.repeat(40)}\n❯ ${draft}\n${'─'.repeat(40)}\n  ? for shortcuts`
const codexComposer = (draft: string, footer = '  ? for shortcuts') => `\n\u001b[1m›\u001b[0m ${draft}\n\n${footer}`

describe('SessionInputController', () => {
  afterEach(() => vi.useRealTimers())

  describe('a message not typed because of what its pane shows', () => {
    const held = (reason: string): TerminalActionResult => ({ state: 'failed', dispatch: 'not_started', reason })

    it.each([
      ['codex', 'rewind_picker_open', 'Codex is browsing its transcript, where Enter would rewind the conversation. Close it with Esc in its terminal, then send the message again.'],
      ['claude', 'rewind_picker_open', 'Claude Code has its Rewind menu open, where Enter would pick a point to rewind to. Close it with Esc in its terminal, then send the message again.'],
      ['claude', 'permission_open', 'Claude Code is asking for permission. Answer it first, in the app or in its terminal, then send the message again.'],
      ['codex', 'question_open', 'Codex is asking you a question. Answer it first, in the app or in its terminal, then send the message again.'],
    ] as const)('%s, %s: tells the person why and what to do, asks no lease again, and awaits nothing', async (engine, reason, text) => {
      const onError = vi.fn(), onSubmitted = vi.fn(), sleep = vi.fn(async () => {})
      const inject = vi.fn(async () => held(reason))
      const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission, getSession: () => session(engine), validateRuntime: async () => true,
        inject, sendKey: async () => true, onError, onSubmitted, sleep })
      controller.submit('s1', 'a message from the app')
      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('s1', text))
      expect(inject).toHaveBeenCalledTimes(1)
      expect(sleep).not.toHaveBeenCalled()
      expect(onSubmitted).not.toHaveBeenCalled()
      controller.forget('s1')
    })

    it('waits for an engine to draw its composer, as for the lease, and types once it is there', async () => {
      // A message sent while the engine starts: its pane holds nothing yet.
      const time = { at: 0, now: () => time.at, sleep: vi.fn(async (ms: number) => { time.at += ms }) }
      const onError = vi.fn(), onSubmitted = vi.fn()
      const inject = vi.fn<() => Promise<TerminalActionResult>>().mockResolvedValueOnce(held('prompt_hidden'))
        .mockResolvedValueOnce(held('screen_unreadable')).mockResolvedValue({ state: 'succeeded', dispatch: 'executed' })
      const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission, getSession: () => session('codex'), validateRuntime: async () => true,
        inject, sendKey: async () => true, onError, onSubmitted, now: time.now, sleep: time.sleep })
      controller.submit('s1', 'sent while it starts')
      await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalledWith('s1', 'sent while it starts'))
      expect(inject).toHaveBeenCalledTimes(3)
      expect(onError).not.toHaveBeenCalled()
      controller.forget('s1')
    })

    it('refuses with the reason once the wait is over and the composer never came', async () => {
      const time = { at: 0, now: () => time.at, sleep: vi.fn(async (ms: number) => { time.at += ms }) }
      const onError = vi.fn()
      const inject = vi.fn(async () => held('prompt_hidden'))
      const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission, getSession: () => session('claude'), validateRuntime: async () => true,
        inject, sendKey: async () => true, onError, now: time.now, sleep: time.sleep })
      controller.submit('s1', 'into a screen never seen')
      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('s1', 'Claude Code isn\'t showing its prompt; finish what\'s on its screen in its terminal, then send the message again.'))
      expect(time.at).toBeGreaterThanOrEqual(15_000)
      controller.forget('s1')
    })

    it('typed but its Enter withheld, as something opened: never pressed later, and the person told where the text is', async () => {
      const withheld: TerminalActionResult = { state: 'unknown', dispatch: 'possibly_executed', reason: 'enter_withheld:permission_open' }
      const onError = vi.fn(), onSubmitted = vi.fn(), sendKey = vi.fn(async () => true), forget = vi.fn(), onDelivery = vi.fn()
      vi.useFakeTimers()
      const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission, getSession: () => session('claude'), validateRuntime: async () => true,
        inject: async () => withheld, sendKey, onError, onSubmitted, onDelivery, beforeSubmit: () => forget, beforeTeamWrite: async () => null })
      controller.submit('s1', 'a message from the app')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(onError).toHaveBeenCalledWith('s1', 'Claude Code asked for permission just as your message was typed, so it was not sent; it waits in Claude Code\'s prompt. Answer the request in the app or in its terminal, then press Enter in its terminal to send the message, or clear it there.')
      expect(forget).toHaveBeenCalled()
      expect(onSubmitted).not.toHaveBeenCalled()
      expect(sendKey).not.toHaveBeenCalled()
      // With a receipt: refused with the reason; a team's, without telling a person.
      onError.mockClear()
      controller.submit('s1', 'from the device', 'd1')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(onDelivery).toHaveBeenCalledWith({ sessionId: 's1', deliveryId: 'd1', state: 'rejected', reason: 'enter_withheld' })
      expect(onError).toHaveBeenCalledTimes(1)
      controller.submit('s1', 'a team turn', 'team:1')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(onDelivery).toHaveBeenCalledWith({ sessionId: 's1', deliveryId: 'team:1', state: 'rejected', reason: 'enter_withheld' })
      expect(onError).toHaveBeenCalledTimes(1)
      expect(sendKey).not.toHaveBeenCalled()
      controller.forget('s1')
    })

    it('rejects a message that wants a receipt with the reason, and says why', async () => {
      const onError = vi.fn(), onDelivery = vi.fn()
      const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission, getSession: () => session('codex'), validateRuntime: async () => true,
        inject: async () => held('permission_open'), sendKey: async () => true, onError, onDelivery })
      controller.submit('s1', 'a message from the device', 'd1')
      await vi.waitFor(() => expect(onDelivery).toHaveBeenCalledWith({ sessionId: 's1', deliveryId: 'd1', state: 'rejected', reason: 'permission_open' }))
      expect(onError).toHaveBeenCalledWith('s1', 'Codex is asking for approval. Answer it first, in the app or in its terminal, then send the message again.')
      controller.forget('s1')
    })

    it('rejects a team\'s turn with the reason, and tells no person: its team hears of it', async () => {
      const onError = vi.fn(), onDelivery = vi.fn()
      const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission, getSession: () => session('claude'), validateRuntime: async () => true,
        beforeTeamWrite: async () => null, inject: vi.fn(), injectTeam: async () => held('menu_open'), sendKey: async () => true, onError, onDelivery })
      controller.submit('s1', 'a team turn', 'team:1')
      await vi.waitFor(() => expect(onDelivery).toHaveBeenCalledWith({ sessionId: 's1', deliveryId: 'team:1', state: 'rejected', reason: 'menu_open' }))
      expect(onError).not.toHaveBeenCalled()
      controller.forget('s1')
    })
  })

  describe('a paste the control lease refuses before a byte is written', () => {
    const refused: TerminalActionResult = { state: 'failed', dispatch: 'not_started', reason: TERMINAL_LEASE_REFUSED }
    const done: TerminalActionResult = { state: 'succeeded', dispatch: 'executed' }
    /** A clock that moves only when the controller sleeps. */
    const clock = () => {
      let at = 0
      return { now: () => at, sleep: vi.fn(async (ms: number) => { at += ms }) }
    }

    it('waits for the lease — a resume whose new process is not confirmed yet — and then delivers, once', async () => {
      const time = clock(), onError = vi.fn(), onSubmitted = vi.fn()
      const inject = vi.fn<() => Promise<TerminalActionResult>>().mockResolvedValueOnce(refused).mockResolvedValueOnce(refused).mockResolvedValue(done)
      const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission, getSession: () => session('claude'), validateRuntime: async () => true,
        inject, sendKey: async () => true, onError, onSubmitted, ...time })
      controller.submit('s1', 'right after the resume')
      await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalledWith('s1', 'right after the resume'))
      expect(inject).toHaveBeenCalledTimes(3)
      expect(time.sleep).toHaveBeenCalledWith(250)
      expect(onError).not.toHaveBeenCalled()
      controller.forget('s1')
    })

    it('gives up at fifteen seconds, says the message was not delivered, and wrote nothing', async () => {
      const time = clock(), onError = vi.fn()
      const inject = vi.fn(async () => refused)
      const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission, getSession: () => session('claude'), validateRuntime: async () => true,
        inject, sendKey: async () => true, onError, ...time })
      controller.submit('s1', 'never leased')
      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('s1', 'The message could not be delivered to the agent.'))
      expect(time.now()).toBeGreaterThanOrEqual(15_000)
      expect(inject.mock.calls.length).toBe(61)
      controller.forget('s1')
    })

    it('stops waiting when the agent goes, and never waits on any other refusal', async () => {
      const time = clock(), onError = vi.fn()
      let present = true
      const inject = vi.fn(async () => { present = false; return refused })
      const gone = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission, getSession: () => (present ? session('claude') : undefined), validateRuntime: async () => true,
        inject, sendKey: async () => true, onError, ...time })
      gone.submit('s1', 'to an agent that left')
      await vi.waitFor(() => expect(onError).toHaveBeenCalled())
      expect(inject).toHaveBeenCalledTimes(1)

      const other = vi.fn(async (): Promise<TerminalActionResult> => ({ state: 'failed', dispatch: 'not_started', reason: 'terminal agent is unavailable' }))
      const elsewhere = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission, getSession: () => session('claude'), validateRuntime: async () => true,
        inject: other, sendKey: async () => true, onError: vi.fn(), ...time })
      elsewhere.submit('s1', 'to an agent with no terminal')
      await vi.waitFor(() => expect(other).toHaveBeenCalledTimes(1))
      expect(time.sleep).toHaveBeenCalledTimes(1)
      elsewhere.forget('s1')
    })

    it('waits the same way for a message that wants a receipt, until it is cancelled', async () => {
      const time = clock(), onDelivery = vi.fn()
      const inject = vi.fn<() => Promise<TerminalActionResult>>().mockResolvedValueOnce(refused).mockResolvedValue(done)
      const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission, getSession: () => session('codex'), validateRuntime: async () => true,
        inject, sendKey: async () => true, onError: vi.fn(), onDelivery, ...time })
      controller.submit('s1', 'with a receipt', 'delivery-1')
      await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(2))
      controller.forget('s1')

      const cancelled = vi.fn(async () => refused)
      let cancel: () => void = () => {}
      const waiting = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission, getSession: () => session('codex'), validateRuntime: async () => true,
        inject: cancelled, sendKey: async () => true, onError: vi.fn(), onDelivery,
        now: time.now, sleep: async (ms) => { time.sleep(ms); cancel() } })
      cancel = () => waiting.forget('s1')
      waiting.submit('s1', 'cancelled while waiting', 'delivery-2')
      await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(cancelled).toHaveBeenCalledTimes(1)
    })
  })


  it('retains the submitted swarm through the input queue and records it only at dispatch', async () => {
    const beforeSubmit = vi.fn(() => vi.fn())
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission, getSession: () => session('cursor'), validateRuntime: async () => true,
      inject: async () => true, sendKey: async () => true, beforeSubmit, onError: vi.fn() })
    controller.setTurnOpen('s1', true)
    controller.submit('s1', 'task from A', undefined, 'swarm-a')
    expect(beforeSubmit).not.toHaveBeenCalled()
    controller.onTurnEnded('s1')
    await vi.waitFor(() => expect(beforeSubmit).toHaveBeenCalledWith('h1', 'task from A', 'swarm-a'))
    controller.forget('s1')
  })

  it.each(['team_waiting_draft', 'team_waiting_user', 'team_waiting_idle'])('team input preserves the composer on %s', async reason => {
    const inject = vi.fn(async () => true), sendKey = vi.fn(async () => true), onDelivery = vi.fn()
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission, getSession: () => session('cursor'), validateRuntime: async () => true,
      inject, sendKey, onError: vi.fn(), onDelivery, beforeTeamWrite: async () => reason })
    controller.submit('s1', 'peer question', 'team:fixture')
    await vi.waitFor(() => expect(onDelivery).toHaveBeenCalledWith(expect.objectContaining({ state: 'rejected', reason })))
    expect(inject).not.toHaveBeenCalled()
    expect(sendKey).not.toHaveBeenCalled()
    controller.forget('s1')
  })

  it('rechecks a queued team message at the actual write boundary', async () => {
    const beforeTeamWrite = vi.fn(async () => 'team_waiting_draft'), inject = vi.fn(async () => true), onDelivery = vi.fn()
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission, getSession: () => session(), validateRuntime: async () => true,
      inject, sendKey: async () => true, onError: vi.fn(), onDelivery, beforeTeamWrite })
    controller.setTurnOpen('s1', true)
    controller.submit('s1', 'peer question', 'team:fixture')
    expect(beforeTeamWrite).not.toHaveBeenCalled()
    controller.onTurnEnded('s1')
    await vi.waitFor(() => expect(beforeTeamWrite).toHaveBeenCalledOnce())
    expect(inject).not.toHaveBeenCalled()
    controller.forget('s1')
  })

  it('never retries Enter for an automatic team message with uncertain acceptance', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async () => true), onDelivery = vi.fn()
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission, getSession: () => session(), validateRuntime: async () => true,
      inject: async () => true, sendKey, onError: vi.fn(), onDelivery, beforeTeamWrite: async () => null })
    controller.submit('s1', 'peer question', 'team:fixture')
    await vi.advanceTimersByTimeAsync(12_000)
    expect(onDelivery).toHaveBeenCalledWith(expect.objectContaining({ state: 'unknown' }))
    expect(sendKey).not.toHaveBeenCalled()
    controller.forget('s1')
  })

  it('requeues a team notice when a draft appears while waiting for the terminal writer', async () => {
    const inject = vi.fn(async () => true), onError = vi.fn(), onDelivery = vi.fn()
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission, getSession: () => session(), validateRuntime: async () => true,
      beforeTeamWrite: async () => null, inject,
      injectTeam: async () => ({ state: 'failed', dispatch: 'not_started', reason: 'team_waiting_draft' }),
      sendKey: async () => true, onError, onDelivery })
    controller.submit('s1', 'peer question', 'team:fixture')
    await vi.waitFor(() => expect(onDelivery).toHaveBeenCalledWith(expect.objectContaining({ state: 'rejected', reason: 'team_waiting_draft' })))
    expect(inject).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    controller.forget('s1')
  })

  it.each([
    { engine: 'claude', observed: '\n\n<pasted_content id="04e3">\npeer question\n</pasted_content id="04e3">\n', state: 'started' },
    { engine: 'claude', observed: 'extra user instructions\n<pasted_content id="04e3">\npeer question\n</pasted_content id="04e3">', state: 'unknown' },
    { engine: 'claude', observed: '<pasted_content id="04e3">\npeer question\n</pasted_content id="ffff">', state: 'unknown' },
    { engine: 'claude', observed: '<pasted_content id="04e3">\na different question\n</pasted_content id="04e3">', state: 'unknown' },
    { engine: 'codex', observed: '<pasted_content id="04e3">\npeer question\n</pasted_content id="04e3">', state: 'unknown' },
  ] as const)('attributes native paste evidence only to the exact $engine message: $state', async ({ engine, observed, state }) => {
    const inject = vi.fn(async () => true), sendKey = vi.fn(async () => true), onDelivery = vi.fn()
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission, getSession: () => session(engine), validateRuntime: async () => true,
      inject, sendKey, onError: vi.fn(), onDelivery, beforeTeamWrite: async () => null })
    controller.submit('s1', 'peer question', 'team:fixture')
    await vi.waitFor(() => expect(onDelivery).toHaveBeenCalledWith(expect.objectContaining({ state: 'delivered' })))
    controller.onTurnStarted('s1', observed)
    // The engine reads its own record in its worker: the receipt follows that reading.
    await vi.waitFor(() => expect(onDelivery).toHaveBeenLastCalledWith(expect.objectContaining({ state })))
    expect(inject).toHaveBeenCalledOnce()
    expect(sendKey).not.toHaveBeenCalled()
    controller.forget('s1')
  })

  it('types into a busy Codex pane at once — the TUI queues the follow-up, not the daemon', async () => {
    // A voice command spoken while a Codex task ran used to sit in this controller's queue, invisible,
    // until the task ended. Codex queues composer input itself, so the daemon types straight away.
    const injected: string[] = []
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('codex'), validateRuntime: async () => true,
      inject: async (_pane, content) => { injected.push(content); return true },
      sendKey: async () => true, onError: vi.fn(),
      // The prompt left the composer (Codex took it as a follow-up); no turn_started until the running
      // turn ends.
      capture: async () => '› working…\n',
    })
    controller.setTurnOpen('s1', true)
    controller.submit('s1', 'second')
    await vi.waitFor(() => expect(injected).toEqual(['second']))
    controller.submit('s1', 'third')
    await vi.waitFor(() => expect(injected).toEqual(['second', 'third']))
    controller.onTurnEnded('s1')
    controller.onTurnStarted('s1', 'second')
    expect(injected).toEqual(['second', 'third'])
    controller.forget('s1')
  })

  it('queues Command Code prompts while busy and drains exactly one after turn end', async () => {
    const injected: string[] = []
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('commandcode'), validateRuntime: async () => true,
      inject: async (_pane, content) => { injected.push(content); return true },
      sendKey: async () => true, onError: vi.fn(),
    })
    controller.setTurnOpen('s1', true)
    controller.submit('s1', 'second')
    controller.submit('s1', 'third')
    expect(injected).toEqual([])
    controller.onTurnEnded('s1')
    await vi.waitFor(() => expect(injected).toEqual(['second']))
    controller.onTurnStarted('s1', 'second')
    controller.onTurnEnded('s1')
    await vi.waitFor(() => expect(injected).toEqual(['second', 'third']))
    controller.forget('s1')
  })

  it('clears the echoed prompt from the Cursor composer once the turn starts', async () => {
    const sendKey = vi.fn(async (_pane: string, _key: string) => true)
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('cursor'), validateRuntime: async () => true,
      inject: async () => true, sendKey,
      capture: async () => '⠰ Working\n\n→ hello\nAuto',   // the submitted prompt is still on screen
      onError: vi.fn(),
    })

    controller.onTurnStarted('s1', 'hello')
    await vi.waitFor(() => expect(sendKey.mock.calls.filter(([, k]) => k === 'C-u')).toHaveLength(1))
    controller.forget('s1')
  })

  it('leaves a fresh terminal draft alone when the Cursor composer no longer echoes our prompt', async () => {
    const sendKey = vi.fn(async (_pane: string, _key: string) => true)
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('cursor'), validateRuntime: async () => true,
      inject: async () => true, sendKey,
      capture: async () => '⠰ Working\n\n→ something the user just typed\nAuto',
      onError: vi.fn(),
    })

    controller.onTurnStarted('s1', 'hello')
    await new Promise((r) => setTimeout(r, 20))
    expect(sendKey.mock.calls.filter(([, k]) => k === 'C-u')).toHaveLength(0)
    controller.forget('s1')
  })

  it('clears the Cursor composer before pasting so a stale prompt cannot be appended to', async () => {
    // Cursor keeps the previous prompt on its "→" line after the turn finishes. Without a clear, the next
    // message is typed onto the end of it and the two are submitted as one run-on prompt — observed as a
    // turn starting with the PREVIOUS message's text.
    const order: string[] = []
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('cursor'), validateRuntime: async () => true,
      inject: async (_pane, content) => { order.push(`inject:${content}`); return true },
      sendKey: async (_pane, key) => { order.push(`key:${key}`); return true },
      onError: vi.fn(),
    })
    controller.submit('s1', 'second question')
    await vi.waitFor(() => expect(order).toContain('inject:second question'))
    expect(order[0]).toBe('key:C-u')
    expect(order[1]).toBe('inject:second question')
    controller.forget('s1')
  })

  it('retries Enter without reinjecting the prompt body', async () => {
    vi.useFakeTimers()
    const inject = vi.fn(async () => true)
    const sendKey = vi.fn(async () => true)
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session(), validateRuntime: async () => true, inject, sendKey, onError: vi.fn(),
    })
    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(3_100)
    expect(inject).toHaveBeenCalledTimes(1)
    expect(sendKey).toHaveBeenCalledTimes(2)
    controller.forget('s1')
  })

  it('waits longer before retrying Claude submit verification', async () => {
    vi.useFakeTimers()
    const inject = vi.fn(async () => true)
    const sendKey = vi.fn(async () => true)
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('claude'), validateRuntime: async () => true, inject, sendKey, onError: vi.fn(),
    })
    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(2_900)
    expect(sendKey).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(sendKey).toHaveBeenCalledTimes(1)
    controller.forget('s1')
  })

  it('does not retry Enter for Cursor after the TUI is already working', async () => {
    vi.useFakeTimers()
    const inject = vi.fn(async () => true)
    const sendKey = vi.fn(async (_pane: string, _key: string) => true)
    const onError = vi.fn()
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('cursor'),
      validateRuntime: async () => true,
      inject,
      sendKey,
      capture: async () => '⠰ Working\n\n→ hello\nAuto',
      onError,
    })

    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(5_100)

    expect(inject).toHaveBeenCalledTimes(1)
    // Assert on ENTER specifically, not on the total key count: every Cursor injection also sends a
    // C-u first to clear a stale composer, and that is not a retry.
    expect(sendKey.mock.calls.filter(([, key]) => key === 'Enter')).toHaveLength(0)
    expect(onError).not.toHaveBeenCalled()
    controller.forget('s1')
  })

  it('retries Enter for Cursor only while the exact draft remains in an idle composer', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async (_pane: string, _key: string) => true)
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('cursor'),
      validateRuntime: async () => true,
      inject: async () => true,
      sendKey,
      capture: async () => '→ hello\n\nAuto',
      onError: vi.fn(),
    })

    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(1_600)

    // One retry ENTER. The C-u that precedes every Cursor paste is not counted here.
    expect(sendKey.mock.calls.filter(([, key]) => key === 'Enter')).toHaveLength(1)
    controller.forget('s1')
  })

  it('waits for the Cursor composer to settle before draining the next prompt', async () => {
    vi.useFakeTimers()
    const injected: string[] = []
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('cursor'),
      validateRuntime: async () => true,
      inject: async (_pane, content) => { injected.push(content); return true },
      sendKey: async () => true,
      onError: vi.fn(),
    })

    controller.onTurnStarted('s1', 'first')
    controller.onTurnEnded('s1')
    controller.submit('s1', 'second')
    await vi.advanceTimersByTimeAsync(700)
    expect(injected).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    expect(injected).toEqual(['second'])
    controller.forget('s1')
  })

  it('does not error or press Enter for Claude once the prompt has left the composer', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async () => true)
    const onError = vi.fn()
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('claude'),
      validateRuntime: async () => true,
      inject: async () => true,
      sendKey,
      capture: async () => claudeBox('', '✻ Working (esc to interrupt)\n\n'),
      onError,
    })

    controller.submit('s1', 'hello')
    // Past the old five-observation cutoff and both blind Enter retries.
    await vi.advanceTimersByTimeAsync(60_000)

    expect(sendKey).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    controller.forget('s1')
  })

  it('accepts a Command Code prompt the moment its pane says the agent is working', async () => {
    // Command Code writes the user line to its transcript only after the model finishes thinking — 30s on
    // a real task — so waiting for turn_started declared "the agent did not accept this message" while the
    // terminal plainly showed the message accepted and the work under way.
    vi.useFakeTimers()
    const sendKey = vi.fn(async () => true)
    const onError = vi.fn()
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('commandcode'),
      validateRuntime: async () => true,
      inject: async () => true,
      sendKey,
      // Its real pane: the composer back to its placeholder, the turn running above it.
      capture: async () => '❯ build me a game\n✧ Sculpting…  esc to interrupt • 59s\n────\n❯ Ask your question...',
      onError,
    })

    controller.submit('s1', 'build me a game')
    await vi.advanceTimersByTimeAsync(6_100 * 6)

    expect(onError).not.toHaveBeenCalled()
    expect(sendKey).not.toHaveBeenCalled()   // and no stray Enter into a live composer
    controller.forget('s1')
  })

  it('leaves a fresh Claude draft alone while a submitted voice message waits for background agents', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async () => true)
    const onError = vi.fn()
    const capture = vi.fn(async () => '❯ What are you working on?\n✻ Waiting for 4 background agents to finish\n────\n❯ a different draft I am still writing\n────')
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('claude'), validateRuntime: async () => true,
      inject: async () => true, sendKey, capture, onError,
    })
    controller.submit('s1', 'What are you working on?')
    await vi.advanceTimersByTimeAsync(30_000)
    const observations = capture.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(capture).toHaveBeenCalledTimes(observations) // no permanent polling while Claude waits
    expect(sendKey).not.toHaveBeenCalled() // never submits the unrelated draft
    expect(onError).not.toHaveBeenCalled()
    controller.onTurnStarted('s1', 'What are you working on?')
    controller.onTurnEnded('s1')
    expect(onError).not.toHaveBeenCalled()
    controller.forget('s1')
  })

  describe('a dialog over the composer when the turn has not been seen to start', () => {
    // Recorded on Claude Code 2.1.232: the message was taken, and its turn stopped at a Bash approval.
    // Above the prompt, the transcript's echo of the message, which used to read as an unsent draft.
    const screen = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'permission-claude.txt'), 'utf8')
    const message = 'Run this exact command with Bash, nothing else: curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin'

    it('never presses Enter into a permission prompt, and takes it as the message accepted', async () => {
      vi.useFakeTimers()
      const sendKey = vi.fn(async () => true), onError = vi.fn(), onDelivery = vi.fn()
      let pasted = false
      const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
        getSession: () => session('claude'), validateRuntime: async () => true, onDelivery,
        inject: async () => { pasted = true; return true }, sendKey, capture: async () => pasted ? screen : '❯ ', onError,
      })
      controller.submit('s1', message)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(sendKey).not.toHaveBeenCalled()
      expect(onError.mock.calls).toEqual([])
      controller.forget('s1')
    })

    it('reports a delivery with a receipt as unknown, still without an Enter', async () => {
      vi.useFakeTimers()
      const sendKey = vi.fn(async () => true), onError = vi.fn(), onDelivery = vi.fn()
      let pasted = false
      const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
        getSession: () => session('claude'), validateRuntime: async () => true, onDelivery,
        inject: async () => { pasted = true; return true }, sendKey, capture: async () => pasted ? screen : '❯ ', onError,
      })
      controller.submit('s1', message, 'delivery-1')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(sendKey).not.toHaveBeenCalled()
      expect(onDelivery).toHaveBeenLastCalledWith({ sessionId: 's1', deliveryId: 'delivery-1', state: 'unknown', reason: 'dispatch_ambiguous' })
      controller.forget('s1')
    })

    it('never presses Enter into a menu either, and says the delivery could not be confirmed', async () => {
      vi.useFakeTimers()
      const sendKey = vi.fn(async () => true), onError = vi.fn()
      // Codex browsing its transcript (0.160): Enter would rewind the conversation to the prompt in view.
      const browsing = `› ${message}\n\n  Browsing transcript · ↑↓/jk scroll · ←→/hl prompts · ↵ rewind · esc back\n`
      const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
        getSession: () => session('codex'), validateRuntime: async () => true,
        inject: async () => true, sendKey, capture: async () => browsing, onError,
      })
      controller.submit('s1', message)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(sendKey).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledWith('s1', expect.stringContaining('could not be confirmed'))
      controller.forget('s1')
    })
  })

  it('reports uncertainty without blindly pressing Enter when the terminal shows no composer', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async () => true)
    const onError = vi.fn()
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('claude'), validateRuntime: async () => true,
      inject: async () => true, sendKey, capture: async () => 'Sign in required', onError,
    })
    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sendKey).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('s1', expect.stringContaining('could not be confirmed'))
    controller.forget('s1')
  })

  it('retries Enter then errors for Claude while the prompt stays in the composer', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async () => true)
    const onError = vi.fn()
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('claude'),
      validateRuntime: async () => true,
      inject: async () => true,
      sendKey,
      capture: async () => claudeBox('hello'),
      onError,
    })

    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(3_100 * 3)

    expect(sendKey).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledWith('s1', expect.stringContaining('did not accept'))
    controller.forget('s1')
  })

  describe('Claude Code and Codex readings from their engine worker', () => {
    const held = <T,>() => {
      let resolve!: (value: T) => void
      return { promise: new Promise<T>(settle => { resolve = settle }), resolve }
    }

    it.each(['claude', 'codex'] as const)('%s: no reading of the composer is no evidence: no Enter, and the message unconfirmed', async engine => {
      vi.useFakeTimers()
      const sendKey = vi.fn(async () => true), onError = vi.fn(), onDelivery = vi.fn()
      const read = vi.fn(async () => null)
      const controller = new SessionInputController({ readScreen: readInlineScreen, submission: { ...inlineSubmission, read },
        getSession: () => session(engine), validateRuntime: async () => true, inject: async () => true, sendKey, onDelivery,
        capture: async () => engine === 'claude' ? claudeBox('hello') : codexComposer('hello'), onError })
      controller.submit('s1', 'hello', 'delivery-1')
      await vi.advanceTimersByTimeAsync(30_000)
      // The draft is on screen: the core's own reading would have pressed Enter. It is not the core's to read.
      expect(read).toHaveBeenCalledWith(session(engine), engine === 'claude' ? claudeBox('hello') : codexComposer('hello'), 'hello')
      expect(sendKey).not.toHaveBeenCalled()
      expect(onDelivery).toHaveBeenLastCalledWith({ sessionId: 's1', deliveryId: 'delivery-1', state: 'unknown', reason: 'dispatch_ambiguous' })
      expect(onError).toHaveBeenCalledWith('s1', expect.stringContaining('could not be confirmed'))
      controller.forget('s1')
    })

    it('a reader that throws is no reading either', async () => {
      vi.useFakeTimers()
      const sendKey = vi.fn(async () => true), onError = vi.fn()
      const controller = new SessionInputController({ readScreen: readInlineScreen,
        submission: { ...inlineSubmission, read: async () => { throw new Error('worker gone') } },
        getSession: () => session('claude'), validateRuntime: async () => true, inject: async () => true, sendKey,
        capture: async () => claudeBox('hello'), onError })
      controller.submit('s1', 'hello')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(sendKey).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledWith('s1', expect.stringContaining('could not be confirmed'))
      controller.forget('s1')
    })

    it('a reading that comes back after the turn started decides nothing', async () => {
      vi.useFakeTimers()
      const sendKey = vi.fn(async () => true), onError = vi.fn()
      const reading = held<{ draft: boolean; composer: boolean; nativeDraft: 'pending' } | null>()
      const read = vi.fn(() => reading.promise)
      const controller = new SessionInputController({ readScreen: readInlineScreen, submission: { ...inlineSubmission, read },
        getSession: () => session('claude'), validateRuntime: async () => true, inject: async () => true, sendKey,
        capture: async () => claudeBox('hello'), onError })
      controller.submit('s1', 'hello')
      await vi.advanceTimersByTimeAsync(3_100)
      expect(read).toHaveBeenCalledOnce()
      controller.onTurnStarted('s1', 'hello')
      reading.resolve({ draft: true, composer: true, nativeDraft: 'pending' })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(sendKey).not.toHaveBeenCalled()
      expect(onError).not.toHaveBeenCalled()
      controller.forget('s1')
    })

    describe('a message sent while its engine starts, its turn starting after the verify window', () => {
      // The engine draws its composer before its first hook binds the conversation: the message is typed under
      // the launch's record, which is rebuilt, bound, before the check after the paste. The readings here are
      // the fenced ones core composes (core/engines/screens.ts, submissions.ts): each refuses a record that is
      // no longer the agent's binding.
      const engineProcess = (pid: number): ProcessIdentity => ({ pid, executable: 'engine', startMarker: `start ${pid}` })
      const starting = (engine: 'claude' | 'codex'): RegisteredSession => ({ ...session(engine), launch: { state: 'ready' }, sessionId: '',
        boundAt: null, transcriptPath: null })
      const bound = (engine: 'claude' | 'codex'): RegisteredSession => ({ ...session(engine), boundAt: 5, processIdentity: engineProcess(7) })
      const run = async (engine: 'claude' | 'codex', typed: RegisteredSession, after: RegisteredSession) => {
        let current = typed
        const sendKey = vi.fn(async () => true), onError = vi.fn()
        const resolve = () => current
        const screens = createScreens({ handles: () => false, transport: { read: vi.fn() }, resolve,
          inline: (name, capture) => capture === null ? undefined : screenFor(name).inspect(capture) })
        const submission = createSubmissions({ policy: submissionPolicy, handles: () => false, transport: { read: vi.fn(), echo: vi.fn() },
          resolve, inline: name => submissionFor(name) })
        const controller = new SessionInputController({ readScreen: screens.read, submission, getSession: () => current,
          validateRuntime: async () => true, inject: async () => { current = after; return true }, sendKey,
          // Taken off the composer, its turn not started yet.
          capture: async () => engine === 'claude' ? claudeBox('') : codexComposer(''), onError })
        vi.useFakeTimers()
        controller.submit('s1', 'sent while it was starting')
        await vi.advanceTimersByTimeAsync(5_000)
        controller.onTurnStarted('s1', 'sent while it was starting')
        await vi.advanceTimersByTimeAsync(30_000)
        controller.forget('s1')
        return { sendKey, onError }
      }

      it.each(['claude', 'codex'] as const)('%s: read under its first bind, the message is taken: no failure, no second Enter', async engine => {
        const { sendKey, onError } = await run(engine, starting(engine), bound(engine))
        expect(onError).not.toHaveBeenCalled()
        expect(sendKey).not.toHaveBeenCalled()
      })

      it.each([
        ['a rotation of a bound conversation', bound('claude'), { ...bound('claude'), sessionId: 's2', boundAt: 9 }],
        ['another process than the one it knew', { ...starting('claude'), processIdentity: engineProcess(6) }, bound('claude')],
        ['another pane', starting('claude'), { ...bound('claude'), tmuxPane: '%2' }],
      ])('%s still fails closed: unconfirmed, and no second Enter', async (_name, typed, after) => {
        const { sendKey, onError } = await run('claude', typed, after)
        expect(onError).toHaveBeenCalledWith('s1', expect.stringContaining('could not be confirmed'))
        expect(sendKey).not.toHaveBeenCalled()
      })
    })

    it('a pending draft, as the worker reads it, is what lets the core press Enter again', async () => {
      vi.useFakeTimers()
      const sendKey = vi.fn(async () => true)
      // The pane holds no draft as the core would read it; the engine says its composer still holds the prompt.
      const read = vi.fn(async () => ({ draft: true, composer: true, nativeDraft: 'pending' as const }))
      const controller = new SessionInputController({ readScreen: readInlineScreen, submission: { ...inlineSubmission, read },
        getSession: () => session('codex'), validateRuntime: async () => true, inject: async () => true, sendKey,
        capture: async () => codexComposer(''), onError: vi.fn() })
      controller.submit('s1', 'hello')
      await vi.advanceTimersByTimeAsync(1_600)
      expect(sendKey).toHaveBeenCalledWith('h1', 'Enter')
      controller.forget('s1')
    })

    it('a turn\'s prompt the engine wrapped settles its receipt once read, and the pane at once', async () => {
      const echo = held<{ start: number; end: number } | null>()
      const onDelivery = vi.fn()
      const controller = new SessionInputController({ readScreen: readInlineScreen, submission: { ...inlineSubmission, echo: () => echo.promise },
        getSession: () => session('claude'), validateRuntime: async () => true, inject: async () => true, sendKey: async () => true,
        onError: vi.fn(), onDelivery })
      controller.submit('s1', 'peer question', 'delivery-1')
      await vi.waitFor(() => expect(onDelivery).toHaveBeenCalledWith(expect.objectContaining({ state: 'delivered' })))
      const recorded = '<pasted_content id="04e3">\npeer question\n</pasted_content id="04e3">'
      controller.onTurnStarted('s1', recorded)
      // Nothing waits on the reading: the delivery is no longer the pane's to cancel, or to lose with the agent.
      expect(controller.cancelDelivery('delivery-1')).toBe(false)
      controller.forget('s1')
      expect(onDelivery).not.toHaveBeenCalledWith(expect.objectContaining({ reason: 'agent_gone' }))
      echo.resolve({ start: recorded.indexOf('peer'), end: recorded.indexOf('\n</') })
      await vi.waitFor(() => expect(onDelivery).toHaveBeenLastCalledWith({ sessionId: 's1', deliveryId: 'delivery-1', state: 'started' }))
    })

    const noEcho: Array<[string, () => Promise<null>]> = [
      ['no reading', async () => null],
      ['a failed reading', async () => { throw new Error('worker gone') }],
    ]
    it.each(noEcho)('%s of a wrapped prompt is no match', async (_name, echo) => {
      const onDelivery = vi.fn()
      const controller = new SessionInputController({ readScreen: readInlineScreen, submission: { ...inlineSubmission, echo },
        getSession: () => session('claude'), validateRuntime: async () => true, inject: async () => true, sendKey: async () => true,
        onError: vi.fn(), onDelivery })
      controller.submit('s1', 'peer question', 'delivery-1')
      await vi.waitFor(() => expect(onDelivery).toHaveBeenCalledWith(expect.objectContaining({ state: 'delivered' })))
      controller.onTurnStarted('s1', '<pasted_content id="04e3">\npeer question\n</pasted_content id="04e3">')
      await vi.waitFor(() => expect(onDelivery).toHaveBeenLastCalledWith({ sessionId: 's1', deliveryId: 'delivery-1', state: 'unknown', reason: 'prompt_mismatch' }))
      controller.forget('s1')
    })

    it('an exact echo needs no reading, and a different prompt typed by hand is still noticed', async () => {
      const echo = vi.fn(inlineSubmission.echo)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const onSubmitted = vi.fn()
      const controller = new SessionInputController({ readScreen: readInlineScreen, submission: { ...inlineSubmission, echo },
        getSession: () => session('claude'), validateRuntime: async () => true, inject: async () => true, sendKey: async () => true,
        onError: vi.fn(), onSubmitted })
      const turn = async (typed: string, recorded: string) => {
        controller.submit('s1', typed)
        await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalledWith('s1', typed))
        controller.onTurnStarted('s1', recorded)
        await new Promise(resolve => setTimeout(resolve, 0))
        controller.onTurnEnded('s1')
      }
      await turn('hello', 'hello')
      expect(echo).not.toHaveBeenCalled()
      await turn('second', '<pasted_content id="aa">\nsecond\n</pasted_content id="aa">')
      expect(echo).toHaveBeenCalledOnce()
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('observed a different terminal prompt'))
      await turn('third', 'typed by hand')
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('observed a different terminal prompt')))
      expect(echo).toHaveBeenCalledTimes(2)
      // Another engine's record is compared whole, at once, as before.
      const other = new SessionInputController({ readScreen: readInlineScreen, submission: { ...inlineSubmission, echo },
        getSession: () => session('commandcode'), validateRuntime: async () => true, inject: async () => true, sendKey: async () => true,
        onError: vi.fn(), onSubmitted })
      other.submit('s1', 'fourth')
      await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalledWith('s1', 'fourth'))
      warn.mockClear()
      other.onTurnStarted('s1', 'not fourth')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('observed a different terminal prompt'))
      expect(echo).toHaveBeenCalledTimes(2)
      warn.mockRestore()
      controller.forget('s1')
      other.forget('s1')
    })
  })

  it('does not error or press Enter for Codex once the prompt has left the composer', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async () => true)
    const onError = vi.fn()
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('codex'),
      validateRuntime: async () => true,
      inject: async () => true,
      sendKey,
      capture: async () => codexComposer('\u001b[2mFind and fix a bug in @filename\u001b[0m', '  gpt-5.5 medium ·'),
      onError,
    })

    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(sendKey).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    controller.forget('s1')
  })

  it('retries Enter then errors for Codex while the prompt stays in the composer', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async () => true)
    const onError = vi.fn()
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('codex'),
      validateRuntime: async () => true,
      inject: async () => true,
      sendKey,
      capture: async () => codexComposer('hello'),
      onError,
    })

    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(1_600 * 3)

    expect(sendKey).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledWith('s1', expect.stringContaining('did not accept'))
    controller.forget('s1')
  })

  it('falls back to blind retry/error when no pane capture is available', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async () => true)
    const onError = vi.fn()
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('codex'),
      validateRuntime: async () => true,
      inject: async () => true,
      sendKey,
      onError,
    })

    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(1_600 * 3)

    expect(sendKey).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledWith('s1', expect.stringContaining('did not accept'))
    controller.forget('s1')
  })

  it('does not press Enter after an ambiguous submission when capture cannot prove the draft is pending', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async () => true)
    const onError = vi.fn()
    const ambiguous: TerminalActionResult = {
      state: 'unknown', dispatch: 'possibly_executed', reason: 'response was lost',
    }
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('codex'),
      validateRuntime: async () => true,
      inject: async () => ambiguous,
      sendKey,
      onError,
    })

    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(1_600)

    expect(sendKey).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('s1', expect.stringContaining('could not be confirmed'))
    controller.forget('s1')
  })

  it('allows one evidence-backed Enter after an ambiguous submission leaves the exact draft in the composer', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async () => true)
    const ambiguous: TerminalActionResult = {
      state: 'unknown', dispatch: 'possibly_executed', reason: 'response was lost',
    }
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('codex'),
      validateRuntime: async () => true,
      inject: async () => ambiguous,
      sendKey,
      capture: async () => codexComposer('hello'),
      onError: vi.fn(),
    })

    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(1_600)

    expect(sendKey).toHaveBeenCalledTimes(1)
    controller.forget('s1')
  })

  it('does not press Enter after ambiguous submission when repeated capture shows the draft absent', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async () => true)
    const onError = vi.fn()
    const ambiguous: TerminalActionResult = {
      state: 'unknown', dispatch: 'possibly_executed', reason: 'response was lost',
    }
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('codex'),
      validateRuntime: async () => true,
      inject: async () => ambiguous,
      sendKey,
      capture: async () => '› \ngpt-5.6 medium ·',
      onError,
    })

    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(1_600 * 7)

    expect(sendKey).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('s1', expect.stringContaining('could not be confirmed'))
    controller.forget('s1')
  })

  it('requires fresh draft evidence before retrying an ambiguously completed Enter', async () => {
    vi.useFakeTimers()
    const captures = [codexComposer('hello'), null]
    const sendKey = vi.fn(async (_target: string, _key: string): Promise<TerminalActionResult> => ({
      state: 'unknown', dispatch: 'possibly_executed', reason: 'Enter response was lost',
    }))
    const onError = vi.fn()
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('codex'),
      validateRuntime: async () => true,
      inject: async () => true,
      sendKey,
      capture: async () => captures.shift() ?? null,
      onError,
    })

    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(1_600 * 2)

    expect(sendKey).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('s1', expect.stringContaining('could not be confirmed'))
    controller.forget('s1')
  })

  it('does not re-arm Cursor after an ambiguous submission clears the exact draft', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async (_target: string, _key: string) => true)
    const onError = vi.fn()
    const ambiguous: TerminalActionResult = {
      state: 'unknown', dispatch: 'possibly_executed', reason: 'response was lost',
    }
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('cursor'),
      validateRuntime: async () => true,
      inject: async () => ambiguous,
      sendKey,
      capture: async () => '→ \nAuto',
      onError,
    })

    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(1_600)

    expect(sendKey.mock.calls.filter(([, key]) => key === 'Enter')).toHaveLength(0)
    expect(onError).toHaveBeenCalledWith('s1', expect.stringContaining('could not be confirmed'))
    controller.forget('s1')
  })

  it('requires fresh Cursor draft evidence after an ambiguously completed Enter', async () => {
    vi.useFakeTimers()
    const captures = ['→ hello\nAuto', null]
    const sendKey = vi.fn(async (_target: string, _key: string): Promise<TerminalActionResult> => ({
      state: 'unknown', dispatch: 'possibly_executed', reason: 'key response was lost',
    }))
    const onError = vi.fn()
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('cursor'),
      validateRuntime: async () => true,
      inject: async () => true,
      sendKey,
      capture: async () => captures.shift() ?? null,
      onError,
    })

    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(1_600 * 2)

    expect(sendKey.mock.calls.filter(([, key]) => key === 'Enter')).toHaveLength(1)
    expect(onError).toHaveBeenCalledWith('s1', expect.stringContaining('could not be confirmed'))
    controller.forget('s1')
  })

  it('serializes chat input behind a native runtime control lock', async () => {
    const injected: string[] = []
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('claude'), validateRuntime: async () => true,
      inject: async (_pane, content) => { injected.push(content); return true },
      sendKey: async () => true, onError: vi.fn(),
    })

    const release = controller.acquireControl('s1')
    expect(release).toBeTypeOf('function')
    expect(controller.acquireControl('s1')).toBeNull()
    controller.submit('s1', 'wait behind control')
    expect(injected).toEqual([])

    release?.()
    await vi.waitFor(() => expect(injected).toEqual(['wait behind control']))
    controller.forget('s1')
  })
})

describe('delivery correlation', () => {
  afterEach(() => vi.useRealTimers())

  function setup(overrides: Partial<ConstructorParameters<typeof SessionInputController>[0]> = {}) {
    const onDelivery = vi.fn()
    const inject = vi.fn(async () => true)
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session(), validateRuntime: async () => true,
      inject, sendKey: async () => true, onError: vi.fn(), onDelivery, ...overrides,
    })
    return { controller, onDelivery, inject }
  }

  it('correlates a matching observed turn after successful delivery', async () => {
    const { controller, onDelivery } = setup()
    controller.submit('s1', 'hello', 'delivery-1')
    await vi.waitFor(() => expect(onDelivery).toHaveBeenCalledWith({ sessionId: 's1', deliveryId: 'delivery-1', state: 'delivered' }))
    controller.onTurnStarted('s1', 'hello')
    expect(onDelivery.mock.calls.map(([event]) => event.state)).toEqual(['queued', 'delivered', 'started'])
    controller.forget('s1')
  })

  it('does not claim a started receipt or press Enter when only composer clearance was observed', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async () => true)
    const { controller, onDelivery } = setup({ sendKey, capture: async () => '› \n' })
    controller.submit('s1', 'hello', 'delivery-1')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sendKey).not.toHaveBeenCalled()
    expect(onDelivery.mock.calls.map(([event]) => event.state)).toEqual(['queued', 'delivered', 'unknown'])
    controller.forget('s1')
  })

  it('buffers a turn observed before the paste promise resolves', async () => {
    let release!: (value: boolean) => void
    const { controller, onDelivery } = setup({ inject: () => new Promise<boolean>((resolve) => { release = resolve }) })
    controller.submit('s1', 'hello', 'delivery-1')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    controller.onTurnStarted('s1', 'hello')
    release(true)
    await vi.waitFor(() => expect(onDelivery.mock.calls.map(([event]) => event.state)).toEqual(['queued', 'delivered', 'started']))
    controller.forget('s1')
  })

  it('does not attribute a different human prompt to the delivery', async () => {
    const { controller, onDelivery } = setup()
    controller.submit('s1', 'hello', 'delivery-1')
    await vi.waitFor(() => expect(onDelivery).toHaveBeenCalledTimes(2))
    controller.onTurnStarted('s1', 'different')
    await vi.waitFor(() => expect(onDelivery).toHaveBeenLastCalledWith({ sessionId: 's1', deliveryId: 'delivery-1', state: 'unknown', reason: 'prompt_mismatch' }))
    controller.forget('s1')
  })

  it('revokes a queued delivery without touching the terminal', () => {
    const { controller, onDelivery, inject } = setup()
    controller.setTurnOpen('s1', true)
    controller.submit('s1', 'hello', 'delivery-1')
    expect(controller.cancelDelivery('delivery-1')).toBe(true)
    controller.onTurnEnded('s1')
    expect(inject).not.toHaveBeenCalled()
    expect(onDelivery).toHaveBeenLastCalledWith({ sessionId: 's1', deliveryId: 'delivery-1', state: 'rejected', reason: 'cancelled' })
    controller.forget('s1')
  })

  it('revokes during runtime validation before any paste', async () => {
    let release!: (value: boolean) => void
    const { controller, inject } = setup({ validateRuntime: () => new Promise<boolean>((resolve) => { release = resolve }) })
    controller.submit('s1', 'hello', 'delivery-1')
    expect(controller.cancelDelivery('delivery-1')).toBe(true)
    release(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(inject).not.toHaveBeenCalled()
    controller.forget('s1')
  })

  it('reports queue saturation and expiration without pasting', () => {
    vi.useFakeTimers()
    const { controller, onDelivery, inject } = setup()
    controller.setTurnOpen('s1', true)
    for (let i = 0; i < 9; i++) controller.submit('s1', 'hello', `delivery-${i}`)
    expect(onDelivery).toHaveBeenLastCalledWith({ sessionId: 's1', deliveryId: 'delivery-8', state: 'rejected', reason: 'queue_full' })
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1)
    controller.onTurnEnded('s1')
    expect(onDelivery.mock.calls.filter(([event]) => event.reason === 'queue_expired')).toHaveLength(8)
    expect(inject).not.toHaveBeenCalled()
    controller.forget('s1')
  })

  it.each([
    ['missing agent', { getSession: () => undefined }, 'agent_gone'],
    ['missing process', { validateRuntime: async () => false }, 'runtime_gone_pre_paste'],
    ['failed paste', { inject: async () => false }, 'paste_failed'],
  ] as const)('rejects %s before successful delivery', async (_label, overrides, reason) => {
    const { controller, onDelivery } = setup(overrides)
    controller.submit('s1', 'hello', 'delivery-1')
    await vi.waitFor(() => expect(onDelivery).toHaveBeenLastCalledWith({ sessionId: 's1', deliveryId: 'delivery-1', state: 'rejected', reason }))
    controller.forget('s1')
  })

  it('reports ambiguous paste as unknown and never repastes', async () => {
    vi.useFakeTimers()
    const inject = vi.fn(async (): Promise<TerminalActionResult> => ({ state: 'unknown', dispatch: 'possibly_executed', reason: 'timeout' }))
    const { controller, onDelivery } = setup({ inject })
    controller.submit('s1', 'hello', 'delivery-1')
    await vi.advanceTimersByTimeAsync(1_600)
    expect(onDelivery).toHaveBeenLastCalledWith({ sessionId: 's1', deliveryId: 'delivery-1', state: 'unknown', reason: 'dispatch_ambiguous' })
    expect(inject).toHaveBeenCalledTimes(1)
    controller.forget('s1')
  })

  it('reports retry exhaustion as unknown after the body was pasted', async () => {
    vi.useFakeTimers()
    const { controller, onDelivery } = setup()
    controller.submit('s1', 'hello', 'delivery-1')
    await vi.advanceTimersByTimeAsync(4_600)
    expect(onDelivery).toHaveBeenLastCalledWith({ sessionId: 's1', deliveryId: 'delivery-1', state: 'unknown', reason: 'not_submitted' })
    controller.forget('s1')
  })

  it('reports process loss after paste as unknown', async () => {
    vi.useFakeTimers()
    const validateRuntime = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
    const { controller, onDelivery } = setup({ validateRuntime })
    controller.submit('s1', 'hello', 'delivery-1')
    await vi.advanceTimersByTimeAsync(1_600)
    expect(onDelivery).toHaveBeenLastCalledWith({ sessionId: 's1', deliveryId: 'delivery-1', state: 'unknown', reason: 'runtime_gone_post_paste' })
    controller.forget('s1')
  })
})

describe('optional lamp delivery preserves legacy behavior', () => {
  afterEach(() => vi.useRealTimers())

  it('keeps untracked Claude submits out of the new lamp queue, writing them one after another', async () => {
    // Not held for the turn — Claude takes typing while it works — but never two writes into the pane at
    // once: the second waits for the first's paste, not for the first's turn.
    const validations: Array<(valid: boolean) => void> = []
    const inject = vi.fn(async (_target: string, _text: string) => true)
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('claude'),
      validateRuntime: () => new Promise<boolean>(resolve => validations.push(resolve)),
      inject, sendKey: async () => true, onError: vi.fn(),
    })
    controller.setTurnOpen('s1', true)
    controller.submit('s1', 'first local prompt')
    controller.submit('s1', 'second local prompt')
    expect(validations).toHaveLength(1)
    validations[0](true)
    await vi.waitFor(() => expect(validations).toHaveLength(2))
    expect(inject.mock.calls.map(([, text]) => text)).toEqual(['first local prompt'])
    validations[1](true)
    await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(2))
    expect(inject.mock.calls.map(([, text]) => text)).toEqual(['first local prompt', 'second local prompt'])
    controller.forget('s1')
  })

  it('writes messages that arrive together in the order they arrived, whichever check finishes first', async () => {
    const checks: Array<(valid: boolean) => void> = []
    const inject = vi.fn(async (_target: string, _text: string) => true)
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('codex'),
      validateRuntime: () => new Promise<boolean>(resolve => checks.push(resolve)),
      inject, sendKey: async () => true, onError: vi.fn(),
    })
    for (const text of ['one', 'two', 'three']) controller.submit('s1', text)
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(checks.length).toBe(i + 1))
      checks[i](true)
    }
    await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(3))
    expect(inject.mock.calls.map(([, text]) => text)).toEqual(['one', 'two', 'three'])
    // A write that fails does not hold up the ones behind it.
    const failing = vi.fn(async (_target: string, text: string) => { if (text === 'bad') throw new Error('pane gone'); return true })
    const next = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission, getSession: () => session('codex'), validateRuntime: async () => true,
      inject: failing, sendKey: async () => true, onError: vi.fn() })
    next.submit('s1', 'bad')
    next.submit('s1', 'good')
    await vi.waitFor(() => expect(failing).toHaveBeenCalledTimes(2))
    controller.forget('s1')
    next.forget('s1')
  })

  it('keeps native control available during untracked runtime validation', async () => {
    let resolve!: (valid: boolean) => void
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('claude'),
      validateRuntime: () => new Promise<boolean>(done => { resolve = done }),
      inject: async () => true, sendKey: async () => true, onError: vi.fn(),
    })
    controller.submit('s1', 'local prompt')
    const release = controller.acquireControl('s1')
    expect(release).not.toBeNull()
    release?.()
    resolve(false)
    await Promise.resolve()
    controller.forget('s1')
  })

  it('reports the original legacy cancellation error for a vanished process', async () => {
    const onError = vi.fn()
    const sendKey = vi.fn(async () => true)
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session(), validateRuntime: async () => false,
      inject: async () => true, sendKey, onError,
    })
    controller.cancel('s1')
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('s1', 'This agent process is no longer running.'))
    expect(sendKey).not.toHaveBeenCalled()
    controller.forget('s1')
  })

  it('keeps accepted Command Code delivery until the delayed transcript identifies its start', async () => {
    vi.useFakeTimers()
    const onDelivery = vi.fn()
    const sendKey = vi.fn(async () => true)
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('commandcode'), validateRuntime: async () => true,
      inject: async () => true, sendKey, capture: async () => 'Thinking… esc to interrupt',
      onError: vi.fn(), onDelivery,
    })
    controller.submit('s1', 'long thinking task', 'delivery-commandcode')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onDelivery.mock.calls.map(([event]) => event.state)).toEqual(['queued', 'delivered'])
    expect(sendKey).not.toHaveBeenCalled()
    controller.onTurnStarted('s1', 'long thinking task')
    expect(onDelivery).toHaveBeenLastCalledWith({ sessionId: 's1', deliveryId: 'delivery-commandcode', state: 'started' })
    controller.forget('s1')
  })

  it('does not invent rejection when a turn begins during pre-paste validation', async () => {
    let resolve!: (valid: boolean) => void
    const onDelivery = vi.fn()
    const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
      getSession: () => session('claude'),
      validateRuntime: () => new Promise<boolean>(done => { resolve = done }),
      inject: async () => true, sendKey: async () => true, onError: vi.fn(), onDelivery,
    })
    controller.submit('s1', 'lamp followup', 'delivery-followup')
    controller.onTurnStarted('s1', 'a different local turn')
    resolve(true)
    await vi.waitFor(() => expect(onDelivery.mock.calls.map(([event]) => event.state)).toEqual(['queued', 'delivered']))
    controller.onTurnStarted('s1', 'lamp followup')
    expect(onDelivery).toHaveBeenLastCalledWith({ sessionId: 's1', deliveryId: 'delivery-followup', state: 'started' })
    controller.forget('s1')
  })
})
