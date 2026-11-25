// Tier A's step of speaking to the dial, and the one delivery path the world does not record itself: words the devices
// type into a terminal through their injected `run`. The mod's inbox (sessions.ts), the core's turns.send and the Codex
// queue's `codex` run (world.ts) record theirs, each with its target, so the gate sees a send to the wrong session.
import { heardClip } from '../../../../cable/__fixtures__/heardClip.js'
import { flagOf } from '../../argv.js'
import type { StepHandler, TierAWorld } from '../world.js'
import { keyOfOrcaHandle } from './sessions.js'

/** Enter, sent on its own after the words (kitty's send-text escape, WezTerm's key): no words. */
const ENTER = new Set(['\\r', '\r'])

/** The words a command types into a terminal: Orca's `terminal send`, with the handle of the pane they go to, kitty's and
 *  WezTerm's `send-text`, Zellij's `write-chars` (cable/hosts/orca.ts, kitty.ts, wezterm.ts, zellij.ts). */
function typedWords(argv: readonly string[]): { text: string; handle?: string } | undefined {
  if (argv[1] === 'terminal' && argv[2] === 'send') {
    const text = argv.find((arg) => arg.startsWith('--text='))?.slice('--text='.length)
    const handle = flagOf(argv, '--terminal')
    return text === undefined ? undefined : { text, ...(handle === undefined ? {} : { handle }) }
  }
  if (!argv.includes('send-text') && !argv.includes('write-chars')) return undefined
  const words = flagOf(argv, '--')
  return words === undefined || ENTER.has(words) ? undefined : { text: words }
}

/**
 * Each command that types words is a `typed` delivery. Of the terminals, tier A models Orca's panes alone: words sent to
 * one reach the session whose own pane it is (sessions.ts keyOfOrcaHandle). Any other, an Orca pane no session owns, a
 * held one or a tmux one's, or another terminal's, is no session's: its target is none, which the gate counts as a wrong
 * send. Answers nothing, so the command is answered as before.
 */
export function recordTyping(world: TierAWorld): void {
  world.answer((argv) => {
    const typed = typedWords(argv)
    if (typed === undefined) return undefined
    const target = typed.handle === undefined ? undefined : keyOfOrcaHandle(world, typed.handle)
    world.deliver({ path: 'typed', target: target ?? null, text: typed.text })
    return undefined
  })
}

export const voiceSteps: { voice: StepHandler<'voice'> } = {
  // The person speaks to the session on the dial's face; the step's target is who the words must reach.
  voice: async (world, step) => {
    world.speech = step.transcript
    // Audio the gate hears: the transcriber answers what the step says, never this, but a clip under a second the
    // gate does not hear is never sent to it.
    world.dial.voice(heardClip())
  },
}
