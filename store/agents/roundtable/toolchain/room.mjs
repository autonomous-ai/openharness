#!/usr/bin/env node
// `room` — everything the moderator does to the room. The moderator is the only writer; the seats
// only speak. Every command re-renders the pane and rewrites the verdict, so the user watching the
// viewer sees the room fill in rather than a finished transcript appearing at the end.
//
//   room seats                                   which engines this machine can seat
//   room open --motion "…" [--evidence a,b]      start a room
//   room seat --id x --engine codex [--stance …] add a seat
//   room run <opening|cross|converge> [--timeout 600]
//   room render                                  rebuild index.html + verdict
//   room decide                                  close the room (after writing decision.md)

import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ADAPTERS } from './lib/engines.mjs'
import { installedEngines } from './lib/run.mjs'
import { runRound } from './lib/run.mjs'
import { writeIndex } from './lib/render.mjs'
import { writeVerdict } from './lib/verdict.mjs'
import {
  DECISION_FILE, MOTION_FILE, PROTOCOL, WORKSPACE, motion, readRoom, writeRoom,
} from './lib/room.mjs'

const argv = process.argv.slice(2)
const command = argv[0]
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : fallback
}
const die = (message) => { console.error(message); process.exit(1) }
const refresh = () => { writeIndex(); return writeVerdict() }

if (command === 'seats') {
  const found = await installedEngines()
  if (!found.length) die('No engine CLIs on PATH. A room needs at least one seat.')
  for (const engine of found) {
    console.log(`${engine.id.padEnd(10)} ${engine.label.padEnd(14)} ${engine.vendor.padEnd(14)} ${engine.readOnly ? `read-only (${engine.readOnly})` : 'best effort'}`)
  }
  console.log(`\n${found.length} engines available. Seat at least 2 from different vendors, or the room is a mirror.`)
  process.exit(0)
}

if (command === 'open') {
  const text = flag('motion') ?? die('room open --motion "the question"')
  const room = readRoom()
  room.motion = text.split('\n')[0].slice(0, 160)
  room.status = 'running'
  room.startedAt = new Date().toISOString()
  room.evidence = (flag('evidence') ?? '').split(',').filter(Boolean).map((p) => resolve(WORKSPACE, p))
  room.wordCap = Number(flag('word-cap', '250'))
  for (const path of room.evidence) if (!existsSync(path)) die(`evidence not found: ${path}`)
  if (!existsSync(MOTION_FILE) || motion().trim().startsWith('# The motion')) {
    writeFileSync(MOTION_FILE, `# ${room.motion}\n\n${text}\n`)
  }
  writeRoom(room)
  refresh()
  console.log(`Room open: ${room.motion}`)
  process.exit(0)
}

if (command === 'seat') {
  const id = flag('id') ?? die('room seat --id <name> --engine <engine>')
  const engine = flag('engine') ?? die('room seat --id <name> --engine <engine>')
  if (!ADAPTERS[engine]) die(`unknown engine "${engine}" — one of: ${Object.keys(ADAPTERS).join(', ')}`)
  const available = await installedEngines()
  if (!available.some((e) => e.id === engine)) die(`${engine} is not installed on this machine (looked for "${ADAPTERS[engine].bin}" on PATH). Seat it elsewhere or leave it empty and say so.`)
  const room = readRoom()
  if (room.seats.some((s) => s.id === id)) die(`seat "${id}" is already at the table`)
  room.seats.push({ id, engine, model: flag('model'), stance: flag('stance'), state: 'ready' })
  writeRoom(room)
  refresh()
  console.log(`Seated ${id} (${ADAPTERS[engine].label})`)
  process.exit(0)
}

if (command === 'run') {
  const roundId = argv[1]
  const index = PROTOCOL.findIndex((r) => r.id === roundId)
  if (index < 0) die(`unknown round "${roundId}" — one of: ${PROTOCOL.map((r) => r.id).join(', ')}`)
  const room = readRoom()
  if (!room.seats.length) die('no seats — `room seat --id … --engine …` first')
  const round = { ...PROTOCOL[index], previousId: index > 0 ? PROTOCOL[index - 1].id : null }
  room.rounds = room.rounds.map((r) => (r.id === roundId ? { ...r, state: 'active' } : r))
  writeRoom(room)
  refresh()

  const only = flag('only') ? flag('only').split(',') : null
  const started = Date.now()
  console.log(`${round.name}: ${room.seats.length} seats, in parallel${round.peers ? ', each reading the others' : ', sealed — no seat sees another'}…`)
  const results = await runRound(room, round, {
    motionText: motion(), timeoutMs: Number(flag('timeout', '600')) * 1000,
    only, onChange: refresh,
  })

  const fresh = readRoom()
  const allIn = results.every((r) => r.state === 'answered')
  fresh.rounds = fresh.rounds.map((r) => (r.id === roundId ? { ...r, state: allIn ? 'done' : 'failed' } : r))
  writeRoom(fresh)
  const verdict = refresh()
  for (const r of results) console.log(`  ${r.state === 'answered' ? 'ok  ' : 'miss'} ${r.seat.padEnd(14)} ${Math.round(r.elapsedMs / 1000)}s`)
  console.log(`${round.name} done in ${Math.round((Date.now() - started) / 1000)}s · ${verdict.summary}`)
  process.exit(0)
}

if (command === 'decide') {
  if (!existsSync(DECISION_FILE)) die('write decision.md first — the call, and the dissent under it by name')
  const room = readRoom()
  room.status = 'decided'
  room.decidedAt = new Date().toISOString()
  writeRoom(room)
  const verdict = refresh()
  console.log(verdict.ready ? `Decided · ${verdict.summary}` : `Decision written, but not ready: ${verdict.findings.filter((f) => f.severity === 'error').length} seats never answered.`)
  process.exit(0)
}

if (command === 'render') { const v = refresh(); console.log(v.summary); process.exit(0) }

console.log(`room seats | open --motion … | seat --id … --engine … | run <${PROTOCOL.map((r) => r.id).join('|')}> | render | decide`)
process.exit(command ? 1 : 0)
