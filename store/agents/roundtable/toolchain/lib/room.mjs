// The room's state on disk. One writer — this process, run by the moderator — so every mutation is a
// read-modify-write of room.json and a turn file beside it. Markdown turns with front matter are
// deliberate: a room is a folder you can commit, grep, quote and re-open six months later.

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const WORKSPACE = process.env.HARNESS_WORKSPACE || process.cwd()
export const ROOM_FILE = join(WORKSPACE, 'room.json')
export const MOTION_FILE = join(WORKSPACE, 'motion.md')
export const CLAIMS_FILE = join(WORKSPACE, 'claims.json')
export const DECISION_FILE = join(WORKSPACE, 'decision.md')

/** The protocol. Sealed openings first — the one rule the whole harness rests on. */
export const PROTOCOL = [
  { id: 'opening', name: 'Openings', peers: false,
    instruction: 'Answer the motion cold. You are the first voice; nobody else has spoken.' },
  { id: 'cross', name: 'Cross-examination', peers: true,
    instruction: 'The other seats have now answered. Say where each is wrong, what they missed, and what you concede.' },
  { id: 'converge', name: 'Convergence', peers: true,
    instruction: 'State what you now agree with, what you still refuse, and the one piece of evidence that would change your mind.' },
]

const EMPTY = {
  spec: 1, motion: '', status: 'seating', evidence: [], wordCap: 250,
  rounds: PROTOCOL.map((r) => ({ id: r.id, name: r.name, state: 'pending' })),
  seats: [], startedAt: null, decidedAt: null,
}

export function readRoom() {
  if (!existsSync(ROOM_FILE)) return structuredClone(EMPTY)
  try { return { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(ROOM_FILE, 'utf8')) } }
  catch { return structuredClone(EMPTY) }
}

export function writeRoom(room) {
  writeFileSync(ROOM_FILE, `${JSON.stringify(room, null, 2)}\n`)
  return room
}

export function readClaims() {
  if (!existsSync(CLAIMS_FILE)) return { claims: [] }
  try { return JSON.parse(readFileSync(CLAIMS_FILE, 'utf8')) } catch { return { claims: [] } }
}

export const roundDir = (roundId) => {
  const index = PROTOCOL.findIndex((r) => r.id === roundId)
  return join(WORKSPACE, 'rounds', `${index + 1}-${roundId}`)
}

export const turnPath = (roundId, seatId) => join(roundDir(roundId), `${seatId}.md`)

export function writeTurn(roundId, seat, { state, body, elapsedMs, error }) {
  mkdirSync(roundDir(roundId), { recursive: true })
  const front = [
    '---',
    `seat: ${seat.id}`,
    `engine: ${seat.engine}`,
    `model: ${seat.model ?? 'default'}`,
    `round: ${roundId}`,
    `state: ${state}`,
    `stance: ${JSON.stringify(seat.stance ?? '')}`,
    `elapsed_ms: ${Math.round(elapsedMs ?? 0)}`,
    error ? `error: ${JSON.stringify(String(error).slice(0, 400))}` : null,
    `at: ${new Date().toISOString()}`,
    '---', '',
  ].filter((line) => line !== null).join('\n')
  writeFileSync(turnPath(roundId, seat.id), front + (body ?? '') + '\n')
}

/** Parse a turn file back into { front, body }; the renderer and the peer packer both need it. */
export function readTurn(roundId, seatId) {
  const file = turnPath(roundId, seatId)
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!match) return { front: {}, body: text }
  const front = {}
  for (const line of match[1].split('\n')) {
    const at = line.indexOf(':')
    if (at < 0) continue
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    if (value.startsWith('"')) { try { value = JSON.parse(value) } catch { /* keep raw */ } }
    front[key] = value
  }
  return { front, body: text.slice(match[0].length) }
}

export function roundTurns(roundId) {
  const dir = roundDir(roundId)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.md'))
    .map((f) => ({ seatId: f.slice(0, -3), ...readTurn(roundId, f.slice(0, -3)) }))
}

export const decision = () => (existsSync(DECISION_FILE) ? readFileSync(DECISION_FILE, 'utf8') : null)
export const motion = () => (existsSync(MOTION_FILE) ? readFileSync(MOTION_FILE, 'utf8') : '')
