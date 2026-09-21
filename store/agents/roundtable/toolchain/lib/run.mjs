// Running the seats. All of them at once, each with its own timeout, none of them able to see the
// room.
//
// That last part is not a detail: a sealed opening is only sealed if the seat cannot read the other
// seats' turn files. So a seat never runs with the workspace as its working directory — it runs in
// the evidence directory, or in an empty scratch directory when there is no evidence. What it knows
// about its peers is exactly what the prompt was told to include, and nothing else.

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ADAPTERS, stripAnsi } from './engines.mjs'
import { buildPrompt, buildSystem, trimToShape } from './prompts.mjs'
import { PROTOCOL, readTurn, roundDir, writeTurn } from './room.mjs'

export function binOnPath(bin) {
  const probe = spawn(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [bin] : ['-v', bin], { shell: true, stdio: 'ignore' })
  return new Promise((resolve) => probe.on('close', (code) => resolve(code === 0)))
}

export async function installedEngines() {
  const out = []
  for (const [id, adapter] of Object.entries(ADAPTERS)) {
    if (await binOnPath(adapter.bin)) out.push({ id, ...adapter })
  }
  return out
}

async function runOne(seat, room, round, { motionText, peerTurns, ownTurns, timeoutMs, onChange }) {
  const adapter = ADAPTERS[seat.engine]
  const started = Date.now()
  writeTurn(round.id, seat, { state: 'thinking', body: '', elapsedMs: 0 })
  onChange?.()

  const scratch = mkdtempSync(join(tmpdir(), 'roundtable-seat-'))
  const outFile = join(scratch, 'answer.md')
  const system = buildSystem(seat, room, round.id, Math.max(2, Math.round((timeoutMs / 60_000) * 0.7)))
  const prompt = buildPrompt(seat, room, round, { motionText, peerTurns, ownTurns })
  const { args, capture } = adapter.build({ system, prompt, model: seat.model, outFile })
  const cwd = room.evidence?.[0] || scratch

  let stdout = '', stderr = '', timedOut = false
  // `detached` puts the seat in its own process group. These CLIs shell out (`/bin/zsh -lc rg …`),
  // and killing only the CLI leaves those grandchildren holding the stdout pipe open — the round
  // then hangs well past its own timeout waiting for a close that never comes.
  // stdin is `ignore`, not a pipe, and that is load-bearing: `codex exec` reads stdin when it is
  // piped and appends it to the prompt, so an open pipe nobody ever closes means the seat waits for
  // input that never comes and the round dies on its timeout with nothing to show.
  const child = spawn(adapter.bin, args, {
    cwd, env: { ...process.env, NO_COLOR: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  const timer = setTimeout(() => {
    timedOut = true
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }, timeoutMs)
  const code = await new Promise((resolve) => {
    child.on('error', () => resolve(-1))
    child.on('close', (c) => resolve(c))
  })
  clearTimeout(timer)

  let body = stripAnsi(stdout).trim()
  if (capture === 'file') { try { body = stripAnsi(await readFile(outFile, 'utf8')).trim() } catch { /* fall back to stdout */ } }
  if (adapter.clean) body = adapter.clean(body)
  body = trimToShape(body, round.id)
  await rm(scratch, { recursive: true, force: true })

  const elapsedMs = Date.now() - started
  if (timedOut) {
    writeTurn(round.id, seat, { state: 'absent', body: '', elapsedMs, error: `no answer within ${Math.round(timeoutMs / 1000)}s` })
  } else if (code !== 0 || !body) {
    writeTurn(round.id, seat, { state: 'absent', body: '', elapsedMs, error: stderr.trim().slice(-400) || `${adapter.bin} exited ${code} with no answer` })
  } else {
    writeTurn(round.id, seat, { state: 'answered', body, elapsedMs })
  }
  onChange?.()
  return { seat: seat.id, state: timedOut || code !== 0 || !body ? 'absent' : 'answered', elapsedMs }
}

/** One round: every seat at once. Wall clock is the slowest seat, not the sum. */
export async function runRound(room, round, { motionText, timeoutMs = 600_000, onChange, only }) {
  mkdirSync(roundDir(round.id), { recursive: true })
  const seats = room.seats.filter((s) => !only || only.includes(s.id))
  // Everything already on the record, from every earlier round: the seat's own turns so it can hold
  // its position, and the peers' so it has something to answer.
  const earlier = PROTOCOL.slice(0, PROTOCOL.findIndex((r) => r.id === round.id))
  const turnsOf = (seatId) => earlier
    .map((r) => ({ seatId, roundName: r.name, ...(readTurn(r.id, seatId) ?? {}) }))
    .filter((t) => t.body && t.front?.state === 'answered')
  const peerTurnsFor = (seat) => (round.peers
    ? room.seats.filter((s) => s.id !== seat.id).flatMap((s) => turnsOf(s.id))
    : [])
  return Promise.all(seats.map((seat) => runOne(seat, room, round, {
    motionText, peerTurns: peerTurnsFor(seat), ownTurns: turnsOf(seat.id), timeoutMs, onChange,
  })))
}
