// What a seat is told. Two jobs, and they are separate on purpose:
//
//   system — who this seat is: its stance, its read access, and the house rules it shares with every
//            other seat, so four answers come back in the same shape and a row of the matrix can be
//            read across.
//   prompt — the motion, the round, and (from cross-examination on) what the other seats said.
//
// The shape is the UX. Cells that all start with **Position.** can be compared at a glance; four
// essays in four different shapes cannot.

const SHAPES = {
  opening: [
    '**Position.** One sentence. A real answer — pick a side. No "it depends" without saying on what.',
    '**Why.** Up to three bullets, each concrete and specific to this decision, not to decisions in general.',
    '**Strongest case against me.** One line, argued honestly.',
    '**What would change my mind.** One line, and it must be something that could actually be observed.',
  ],
  cross: [
    '**Where they are wrong.** One line per seat, naming the seat. Quote the claim you are attacking.',
    '**What I concede.** One line. If you concede nothing, say so and say why that is not stubbornness.',
    '**Position now.** One sentence — restated, changed or unchanged. Say which.',
  ],
  converge: [
    '**Agreed.** The claims you now accept, as bullets.',
    '**Still refuse.** The claims you do not accept, as bullets, with the reason in the same line.',
    '**What would change my mind.** One line.',
  ],
}

/**
 * Where a turn really begins. Several CLIs narrate their research before answering ("I'll inspect
 * how tightly the daemon is bound to tmux…"). That is honest and it is not the turn — in a matrix
 * cell it pushes the position below the fold. The answer starts at its first heading.
 */
export const FIRST_MARKER = { opening: '**Position.', cross: '**Where they are wrong.', converge: '**Agreed.' }

export function trimToShape(body, roundId) {
  const at = String(body ?? '').indexOf(FIRST_MARKER[roundId] ?? '')
  return at > 0 ? body.slice(at).trim() : String(body ?? '').trim()
}

export function buildSystem(seat, room, roundId, budgetMinutes = 8) {
  const peers = room.seats.filter((s) => s.id !== seat.id).map((s) => `${s.id} (${s.engine})`)
  const lines = [
    `You are "${seat.id}", one seat on a panel of ${room.seats.length} AI agents from different vendors.`,
    peers.length ? `The other seats are: ${peers.join(', ')}. They are not you and do not share your training.` : '',
    seat.stance ? `Your assigned stance: ${seat.stance}. Argue it as well as it can honestly be argued — do not argue for it past the point where the evidence stops.` : 'You have no assigned stance. Say what you actually think.',
    '',
    'You are advising one person who has to make this decision and live with it. They are technical. They do not need the question restated, a summary of both sides, or encouragement. They need your judgement and the reasoning under it.',
    '',
    'House rules, and they are enforced:',
    `- At most ${room.wordCap} words. Under is better. A long answer is a weak answer here.`,
    '- Use exactly these headings, in this order, and write nothing outside them:',
    ...SHAPES[roundId].map((line) => `    ${line}`),
    '- Be specific. Name the file, the number, the failure mode. "Consider the tradeoffs" is not a contribution.',
    '- Disagreement is the product. If you find yourself agreeing with everything, you have not read closely enough.',
    '- You are read-only. Do not write, edit or run anything that changes state. Research, then answer.',
    `- Time-box the research to about ${budgetMinutes} minutes, then answer with what you have. Read the three or four files that decide the question — not the tree. Skip node_modules, dist, build output and lockfiles. An answer grounded in four files beats a survey that never arrives.`,
  ]
  return lines.filter(Boolean).join('\n')
}

export function buildPrompt(seat, room, round, { motionText, peerTurns, ownTurns }) {
  const parts = [`# The motion\n\n${motionText.trim()}`]
  if (room.evidence?.length) {
    parts.push(`# Evidence you may read\n\n${room.evidence.map((p) => `- ${p}`).join('\n')}\n\nRead what you need from these before answering. You may also search the web. Say what you read.`)
  }
  // A seat is a fresh process every round, so its own position has to be handed back to it. Without
  // this a seat contradicts itself in cross-examination and the room reads like four strangers.
  if (ownTurns?.length) {
    parts.push('# What you said earlier, in your own words\n\n' + ownTurns
      .map((t) => `## Your ${t.roundName}\n\n${t.body.trim()}`).join('\n\n')
      + '\n\nThis is your position. Hold it or change it deliberately, and say which.')
  }
  if (peerTurns?.length) {
    parts.push('# What the other seats said\n\n' + peerTurns
      .map((t) => `## ${t.seatId} (${t.front.engine}) — ${t.roundName}\n\n${t.body.trim()}`).join('\n\n'))
  }
  parts.push(`# Your turn: ${round.name}\n\n${round.instruction}`)
  return parts.join('\n\n')
}
