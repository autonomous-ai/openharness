/**
 * How an engine left a Swarm start's pane, in fixed words: its exit status, and whether it refused an option Harness started it
 * with. The rehearsal's Codex builders Nova and Vesper (2026-11-11) quit at launch, and all their Swarm read was "has since
 * stopped": the Product Manager told its person it could not find out why.
 *
 * Read from the pane the core kept: the shell that took it over under an id of its own, which names the agent (`previousAgentId`,
 * lib/retainExitedSession.ts), or, for an engine that left before it was ever seen, the agent's own row, a shell now
 * (core/agents/newPane.ts). Its wrapper prints one line as the engine leaves (lib/engineLaunch.ts `engineFallbackPrelude`,
 * lib/windows/engineStart.ts `ENGINE_EXIT_NOTICE_PS`): the status is that line's, and only what is above it is the engine's.
 * None of the pane's words leave this machine. Security review 2 of #3063 (startScreen.ts): no list of patterns makes a
 * terminal's words safe to send to a start's maker and coordinator, so they are told what kind of thing happened.
 */
import type { CoreApi } from '../core/api.js'

/** How an engine left its pane; `leaving` while its row has been a shell only a moment, its wrapper's line not printed yet. */
export type EngineExit = { status: number; option: boolean } | 'leaving'

/** The lines read back from the pane's end: an engine's refusal is a few lines above its wrapper's line. */
const SCROLLBACK = 60
/** How long a shell whose engine left may show no line from its wrapper yet. The wrapper first reads the pane's input dry, until
 *  none comes for 0.3 s (lib/engineLaunch.ts `ENGINE_INPUT_DRAIN_SH`), and the core makes the row a shell as soon as the engine
 *  has left; read between the two, a start failed without its reason (review of #4134). */
export const LEAVING_MS = 10_000
/** The wrapper's line: an em dash on macOS and Linux, a hyphen in PowerShell. */
const LEFT = /^harness: \S+ exited \((-?\d+)\)\. This pane is a shell now [—-] run /
/** How the engines refuse an option they do not have, before anything is drawn: clap (Codex 0.164) and Commander (Claude Code),
 *  as `codex --x` and `claude --x` print it. */
const REFUSED = /^error: (?:unexpected argument|unknown option) '/

/** How [screen]'s engine left, read at the first line its wrapper printed (a person may run the engine again in that shell);
 *  null when it printed none. */
export function exitOn(screen: string): { status: number; option: boolean } | null {
  const lines = screen.split(/\r?\n/).map(line => line.trim())
  const at = lines.findIndex(line => LEFT.test(line))
  if (at < 0) return null
  return { status: Number(LEFT.exec(lines[at]!)![1]), option: lines.slice(0, at).some(line => REFUSED.test(line)) }
}

/** How [harnessId]'s engine left its pane on this machine, from the pane the core kept; null while it runs, when its pane went
 *  with it, or when the pane says nothing of it. */
export async function engineExit(core: Pick<CoreApi, 'agents' | 'panes'>, harnessId: string, now: number = Date.now()): Promise<EngineExit | null> {
  const own = core.agents.byAgent(harnessId)
  const pane = own?.engine === 'terminal' ? own
    : core.agents.all().find(row => row.previousAgentId === harnessId && row.engine === 'terminal')
  if (!pane || !core.panes) return null
  const read = await core.panes.screen(pane.agentId, SCROLLBACK).catch((error: Error) => ({ ok: false as const, error: error.message }))
  if (!read.ok) {
    // Its start still fails, saying only that its agent stopped.
    console.warn(`[super-tabs] could not read how ${harnessId.slice(0, 8)}'s engine left its pane · ${read.error}`)
    return null
  }
  return exitOn(read.text) ?? (now - pane.touchedAt < LEAVING_MS ? 'leaving' : null)
}
