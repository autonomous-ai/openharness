/**
 * A Swarm member's terminal for its Lead (spec/2026-10-23-lead-sees-agent-terminal.md): the screen as plain text, and
 * text and named keys typed into it. Workers got stuck on what only their terminal showed (a permission prompt, a
 * usage-limit screen, a model picker) and only a person at that machine could clear it. The Super Tab service decides
 * who may ask (only the backend's relay of the project's Lead or a person reaches it); the core reads and writes the
 * pane as every other writer does, under the pane's write lock.
 */
import { stripVTControlCharacters } from 'node:util'
import type { ScreenReading } from '../../engines/facets/screen.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { TerminalCaptureOptions, TerminalReadResult } from '../../lib/terminalTypes.js'
import type { SuperTabScreen, SuperTabTyped } from '../../core/api.js'

export interface SuperTabTerminalDeps {
  resolve(agentId: string): RegisteredSession | undefined
  capture(session: RegisteredSession, options: TerminalCaptureOptions): Promise<TerminalReadResult<string>>
  read(session: RegisteredSession, capture: string | null): Promise<ScreenReading | null>
  /** Literal text, never followed by Enter (`terminals/control.ts` `typeTerminal`). */
  type(agentId: string, text: string): Promise<boolean>
  /** One key by its tmux name (`Enter`, `C-c`), as `terminals/control.ts` `keyTerminal` takes it. */
  key(agentId: string, key: string): Promise<boolean>
  /** The pane's write lock (`deviceInput.ts` `legacyWrite`), so a device's write is never interleaved. */
  locked<T>(agentId: string, write: () => Promise<T>): Promise<T>
}

/** The spec's cap; the tmux capture keeps at most 300 lines in any case. */
const MAX_SCROLLBACK = 200
const GONE = { ok: false as const, error: 'The agent is not running on this machine.' }
const CHANGED = { ok: false as const, error: 'The screen changed before the keys were sent; nothing was typed.' }

export function createSuperTabTerminal({ resolve, capture, read, type, key, locked }: SuperTabTerminalDeps) {
  return {
    async screen(agentId: string, scrollback: number): Promise<SuperTabScreen> {
      const session = resolve(agentId)
      if (!session) return GONE
      const lines = Math.min(MAX_SCROLLBACK, Math.max(0, Math.floor(scrollback)))
      const captured = await capture(session, lines ? { mode: 'recent_unwrapped', historyLines: lines, ansi: false } : { mode: 'visible', ansi: false })
      if (captured.state !== 'succeeded') return { ok: false, error: `Could not read the terminal: ${captured.reason}` }
      // tmux without -e still leaves the odd escape (a title, a cursor move); the Lead reads words, never colours.
      const text = stripVTControlCharacters(captured.value)
      return { ok: true, text, hold: (await read(session, text))?.messageHold ?? null }
    },
    async input(agentId: string, text: string, keys: string[]): Promise<SuperTabTyped> {
      if (!resolve(agentId)) return GONE
      if (!text && !keys.length) return { ok: false, error: 'Nothing to type.' }
      return locked(agentId, async () => {
        if (text && !await type(agentId, text)) return { ok: false, error: 'The terminal did not take the text.' }
        for (const name of keys) if (!await key(agentId, name)) return { ok: false, error: `The terminal did not take the key ${name}.` }
        return { ok: true }
      })
    },
    /**
     * Named keys, only while the visible screen is still exactly `screen`: it is read again UNDER the pane's write lock,
     * where no other writer can change it before the keys land. A caller that read the screen earlier (the host's watch,
     * which answers Codex's update prompt for an agent nobody sits at) cannot say it is still there: the Lead, or the
     * person, may have answered it in between, and a key typed then lands in the composer or the next question. What the
     * screen means is the caller's to judge; this only keeps the keys from reaching a different one.
     */
    async inputIfScreen(agentId: string, keys: string[], screen: string): Promise<SuperTabTyped> {
      const session = resolve(agentId)
      if (!session) return GONE
      if (!keys.length) return { ok: false, error: 'Nothing to type.' }
      return locked(agentId, async () => {
        const captured = await capture(session, { mode: 'visible', ansi: false })
        if (captured.state !== 'succeeded') return { ok: false, error: `Could not read the terminal: ${captured.reason}` }
        if (stripVTControlCharacters(captured.value) !== screen) return CHANGED
        for (const name of keys) if (!await key(agentId, name)) return { ok: false, error: `The terminal did not take the key ${name}.` }
        return { ok: true }
      })
    },
  }
}
