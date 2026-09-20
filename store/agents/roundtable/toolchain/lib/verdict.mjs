// The verdict, which is what the app's header reads. Written after every turn, not at the end: the
// spec asks for a feed, and this harness produces one naturally — a turn lands every few seconds.
//
// `ready` is the guardrail against the failure mode of this whole idea. A room that was interesting
// and decided nothing is not ready, however good the transcript reads.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROTOCOL, WORKSPACE, decision, readClaims, readRoom, readTurn } from './room.mjs'

export function writeVerdict() {
  const room = readRoom()
  const { claims } = readClaims()
  const call = decision()
  const seats = room.seats ?? []

  const findings = []
  let answered = 0, absent = 0
  for (const round of PROTOCOL) {
    for (const seat of seats) {
      const turn = readTurn(round.id, seat.id)
      if (!turn) continue
      if (turn.front.state === 'answered') answered += 1
      if (turn.front.state === 'absent') {
        absent += 1
        findings.push({ severity: 'error', kind: 'seat_unavailable', ref: `${seat.id}/${round.id}`,
          message: `${seat.id} (${seat.engine}) did not answer the ${round.name.toLowerCase()}: ${turn.front.error ?? 'no answer'}` })
      }
    }
  }

  let settled = 0, split = 0
  for (const claim of claims) {
    const votes = seats.map((s) => claim.by?.[s.id] ?? 'silent')
    if (votes.length && votes.every((v) => v === 'agree')) {
      settled += 1
      findings.push({ severity: 'info', kind: 'agreed', ref: claim.id ?? undefined, message: `Every seat agrees: ${claim.text}` })
    } else if (votes.includes('agree') && votes.includes('disagree')) {
      split += 1
      findings.push({ severity: 'warning', kind: 'split', ref: claim.id ?? undefined,
        message: `Unresolved: ${claim.text} — ${seats.filter((s) => claim.by?.[s.id] === 'agree').map((s) => s.id).join(', ') || 'none'} for, ${seats.filter((s) => claim.by?.[s.id] === 'disagree').map((s) => s.id).join(', ') || 'none'} against` })
    }
  }

  const everySeatSpoke = seats.length > 0 && PROTOCOL.every((round) =>
    seats.every((seat) => readTurn(round.id, seat.id)?.front?.state === 'answered'))
  const ready = Boolean(call) && everySeatSpoke

  const phases = [
    ...(room.rounds ?? []).map((r) => ({ id: r.id, name: r.name, state: r.state ?? 'pending' })),
    { id: 'decision', name: 'Decision', state: call ? 'done' : room.status === 'deciding' ? 'active' : 'pending' },
  ]

  const summary = !seats.length ? 'Setting the room'
    : !call ? `${seats.length} seats · ${answered} turns${split ? ` · ${split} open splits` : ''}${absent ? ` · ${absent} absent` : ''}`
      : `Decided · ${seats.length} seats · agreed on ${settled}, split on ${split}`

  const verdict = {
    spec: 1, ready, summary, findings, phases,
    artifact: 'index.html',
    updatedAt: new Date().toISOString(),
  }
  mkdirSync(join(WORKSPACE, '.harness'), { recursive: true })
  writeFileSync(join(WORKSPACE, '.harness', 'verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`)
  return verdict
}
