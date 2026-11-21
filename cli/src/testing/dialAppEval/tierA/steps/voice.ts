// Tier A's step of speaking to the dial, and the one delivery path the world does not record itself: words the devices
// type into a terminal through their injected `run`. The mod's inbox (sessions.ts), the core's turns.send and the Codex
// queue's `codex` run (world.ts) record theirs, each with its target, so the gate sees a send to the wrong session.
import type { StepHandler, TierAWorld } from '../world.js'

/** A tenth of a second of made-up 16 kHz 16-bit audio: the transcriber answers what the step says, never this. */
const PCM = Buffer.alloc(3_200, 1)
/** Enter, sent on its own after the words (kitty's send-text escape, WezTerm's key): no words. */
const ENTER = new Set(['\\r', '\r'])

/** The words a command types into a terminal: Orca's `terminal send`, kitty's and WezTerm's `send-text`, Zellij's
 *  `write-chars` (cable/hosts/orca.ts, kitty.ts, wezterm.ts, zellij.ts). */
function typedWords(argv: readonly string[]): string | undefined {
  if (argv[1] === 'terminal' && argv[2] === 'send') return argv.find((arg) => arg.startsWith('--text='))?.slice('--text='.length)
  if (!argv.includes('send-text') && !argv.includes('write-chars')) return undefined
  const at = argv.indexOf('--')
  const words = at < 0 ? undefined : argv[at + 1]
  return words === undefined || ENTER.has(words) ? undefined : words
}

/**
 * Each command that types words is a `typed` delivery. Tier A models no terminal, so no session owns the pane they go
 * to: its target is none, which the gate counts as a wrong send. Answers nothing, so the command is answered as before.
 */
export function recordTyping(world: TierAWorld): void {
  world.answer((argv) => {
    const text = typedWords(argv)
    if (text !== undefined) world.deliver({ path: 'typed', target: null, text })
    return undefined
  })
}

export const voiceSteps: { voice: StepHandler<'voice'> } = {
  // The person speaks to the session on the dial's face; the step's target is who the words must reach.
  voice: async (world, step) => {
    world.speech = step.transcript
    world.dial.voice([PCM])
  },
}
