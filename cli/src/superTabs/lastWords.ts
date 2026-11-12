/**
 * What an engine said as it left a Swarm start's pane: why the start failed, in its own words. The rehearsal's Codex builders
 * Nova and Vesper (2026-11-11) quit at launch, and all their Swarm read was "has since stopped"; the reason sat on a shell pane
 * no Swarm view shows, and the Product Manager told its person it could not find out why.
 *
 * The core keeps that pane: as a shell under an id of its own that names the agent (`previousAgentId`, lib/retainExitedSession.ts),
 * or, for an engine that left before it was ever seen, as the agent's own row, a shell now (core/agents/newPane.ts). Its wrapper
 * prints one line as the engine leaves (lib/engineLaunch.ts `engineFallbackPrelude`, lib/windows/engineStart.ts
 * `ENGINE_EXIT_NOTICE_PS`): only what is above that line is the engine's, never the shell's or its person's.
 */
import { homedir } from 'node:os'
import type { CoreApi } from '../core/api.js'
import { redactSecretsInText } from '../lib/logBundle.js'

/** What an engine left with: its exit status, and the line it said, if it said one. */
export interface EngineExit { status: number; said: string | null }

/** The most a start's failure carries of it, counted as a person reads characters. */
export const SAID_MAX = 300
/** The lines read back from the pane's end: an engine's error is a few lines above its wrapper's line. */
const SCROLLBACK = 60
/** The wrapper's line, with an em dash on macOS and Linux and a hyphen in PowerShell. */
const LEFT = /^harness: \S+ exited \((-?\d+)\)\. This pane is a shell now [—-] run /
/** A line that says what went wrong: an engine prints it before its help and usage (Codex's clap, 0.164), which say nothing. */
const WRONG = /\b(?:error|fatal|panic(?:ked)?|failed|denied|unauthori[sz]ed|not found|unknown|invalid|cannot|can't|could not|unable|unexpected|refused|missing)\b/i
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

/** [screen]'s engine's exit, read above the first line its wrapper printed (a person may run the engine again in that shell):
 *  the last line that says what went wrong, else its last two; null when the pane has no such line. */
export function lastWordsOf(screen: string, home: string): EngineExit | null {
  const lines = screen.split(/\r?\n/).map(line => line.replace(/\t/g, ' ').replace(CONTROL, '').trim())
  const at = lines.findIndex(line => LEFT.test(line))
  if (at < 0) return null
  const words = lines.slice(0, at).filter(Boolean)
  const wrong = words.findLast(line => WRONG.test(line))
  const said = (wrong ? [wrong] : words.slice(-2)).join(' · ')
  return { status: Number(LEFT.exec(lines[at]!)![1]), said: said ? bounded(redacted(said, home)) : null }
}

/** Its machine's people and secrets kept out: what a start's failure says goes to the Swarm (backend startFailure.ts tells its raw
 *  reason only to whoever made it, its coordinator and its machine's owner). Homes as `~`, then addresses and tokens. */
function redacted(text: string, home: string): string {
  // A home of `/` (a service account's) is every path: only a real folder is told as `~`.
  return redactSecretsInText((home.length > 1 ? text.split(home).join('~') : text)
    .replace(/(?:\/Users|\/home)\/[^/\s]+/g, '~').replace(/\b[A-Za-z]:\\Users\\[^\\\s]+/gi, '~')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'))
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<redacted>')
}

function bounded(text: string): string {
  const characters = Array.from(text)
  return characters.length > SAID_MAX ? `${characters.slice(0, SAID_MAX - 1).join('')}…` : text
}

/** What [harnessId]'s engine said as it left its pane on this machine, read from the pane the core kept; null while it runs, when
 *  its pane went with it, or when the pane cannot be read. */
export async function engineLastWords(core: Pick<CoreApi, 'agents' | 'superTabs'>, harnessId: string, home: string = homedir()): Promise<EngineExit | null> {
  const own = core.agents.byAgent(harnessId)
  const pane = own?.engine === 'terminal' ? own
    : core.agents.all().find(row => row.previousAgentId === harnessId && row.engine === 'terminal')
  if (!pane || !core.superTabs) return null
  const read = await core.superTabs.screen(pane.agentId, SCROLLBACK).catch((error: Error) => ({ ok: false as const, error: error.message }))
  if (read.ok) return lastWordsOf(read.text, home)
  // Its start still fails, saying only that its agent stopped.
  console.warn(`[super-tabs] could not read what ${harnessId.slice(0, 8)}'s engine said as it left · ${read.error}`)
  return null
}
