#!/usr/bin/env node
/**
 * `mem` — what your agents remember, from a shell. The agent in the Memories pane uses it; so can you.
 *
 *   mem sources                       each agent: where its memory lives, on or off, how much
 *   mem list [--agent A] [--kind K]   memories, newest first (kinds: you project reference summary note instructions)
 *   mem show <id|number>              one memory in full
 *   mem search <words>                memories and conversations that say these words
 *   mem asks [--since 30d] [--agent A] [--limit N] [--chars N]
 *                                     your own messages, newest first: the evidence for About You
 *   mem activity                      your messages per agent and per folder
 *   mem about                         the About You profile
 *   mem about write < file            replace it (the previous one is kept as about-you.prev.md)
 *   mem deliver [status|on|off]       About You in every new session of every agent on this computer
 *   mem due [--json]                  whether an About You build is due now, and why (the memory service)
 *   mem snapshot --json               everything above, for another machine's Memories pane (the
 *                                     daemon's memory service answers `memory_snapshot` with it)
 *
 * Every command takes --json. Nothing here writes an agent's files; `about write` writes only
 * ~/.harness/memory/about-you.md.
 */

import { readFileSync } from 'node:fs'
import { homes } from '../lib/agents.mjs'
import { readAbout, writeAbout } from '../lib/about.mjs'
import { deliver, status as deliveryStatus } from '../lib/deliver.mjs'
import { due } from '../lib/due.mjs'
import { asks, search, MARK_OPEN, MARK_CLOSE } from '../lib/sessions.mjs'
import { closeIndex, sessionIndex, snapshot } from '../lib/state.mjs'
import { tilde } from '../lib/text.mjs'

const USAGE = `usage: mem <sources|list|show|search|asks|activity|about> [options] [--json]
  mem list [--agent claude] [--kind you] [--project name]
  mem show <id or list number>
  mem search <words>
  mem asks [--since 30d] [--agent codex] [--limit 400] [--chars 400]
  mem about [write < file]
  mem deliver [status|on|off]`

function parseArgs(argv) {
  const flags = {}
  const words = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') flags.json = true
    else if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=', 2)
      flags[key] = inline ?? argv[++i]
    } else words.push(arg)
  }
  return { flags, words }
}

/** `30d`, `12h`, `2w`, or an ISO date → epoch ms. */
export function since(value, now = Date.now()) {
  if (!value) return 0
  const relative = /^(\d+)\s*([hdw])$/.exec(String(value))
  if (relative) return now - Number(relative[1]) * { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[relative[2]]
  const at = Date.parse(String(value))
  if (Number.isFinite(at)) return at
  throw new Error(`--since takes 30d, 12h, 2w or a date, not ${value}`)
}

const short = (text, max) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > max ? value.slice(0, max - 1) + '…' : value }
const day = (at) => (at ? new Date(at).toISOString().slice(0, 10) : '          ')

function filtered(snap, flags) {
  return snap.memories.filter((row) => (!flags.agent || row.agent === flags.agent) && (!flags.kind || row.kind === flags.kind)
    && (!flags.project || row.project?.name === flags.project))
}

export async function run(argv, { out = (line) => process.stdout.write(line + '\n'), err = (line) => process.stderr.write(line + '\n'), env = process.env, home, stdin = () => readFileSync(0, 'utf8') } = {}) {
  const [command, ...rest] = argv
  const { flags, words } = parseArgs(rest)
  const print = (value) => out(JSON.stringify(value, null, 2))
  const h = homes(env, home)
  try {
    if (!command || command === 'help' || command === '-h' || command === '--help') { out(USAGE); return command ? 0 : 2 }

    if (command === 'sources') {
      const snap = await snapshot({ env, home })
      if (flags.json) { print(snap.agents); return 0 }
      for (const agent of snap.agents) {
        if (!agent.present && !agent.memories && !agent.sessions) continue
        out(`${agent.name.padEnd(12)} memory ${agent.memory.padEnd(4)} ${String(agent.memories).padStart(4)} saved  ${String(agent.sessions).padStart(5)} sessions  ${agent.where ?? ''}`)
        out(`${''.padEnd(12)} ${agent.says}`)
      }
      if (snap.sessionsError) err(snap.sessionsError)
      return 0
    }

    if (command === 'list') {
      const snap = await snapshot({ env, home })
      const rows = filtered(snap, flags)
      if (flags.json) { print(rows.map(({ body, ...row }) => row)); return 0 }
      rows.forEach((row, n) => out(`${String(n + 1).padStart(3)}  ${day(row.modified)}  ${row.agent.padEnd(8)} ${row.kind.padEnd(12)} ${short(row.title, 60).padEnd(60)}  ${row.project?.name ?? ''}`))
      if (!rows.length) out('No memories match.')
      return 0
    }

    if (command === 'show') {
      const snap = await snapshot({ env, home })
      const key = words.join(' ')
      const number = /^\d+$/.test(key) ? filtered(snap, flags)[Number(key) - 1] : null
      const row = number ?? snap.memories.find((memory) => memory.id === key)
      if (!row) { err(`No memory ${key}. Use a number from \`mem list\` or an id from \`mem list --json\`.`); return 1 }
      if (flags.json) { print(row); return 0 }
      out(`# ${row.title}`)
      out(`${row.agent} · ${row.kind}${row.type && row.type !== row.kind ? ` (${row.type})` : ''} · ${row.project?.name ?? row.scope} · ${day(row.modified)}`)
      out(row.path)
      out('')
      out(row.body)
      return 0
    }

    if (command === 'search') {
      const text = words.join(' ')
      if (!text.trim()) { err('mem search <words>'); return 2 }
      const snap = await snapshot({ env, home })
      const needles = text.toLowerCase().split(/\s+/).filter(Boolean)
      const memories = snap.memories.filter((row) => needles.every((needle) => `${row.title}\n${row.description}\n${row.body}`.toLowerCase().includes(needle)))
      const index = await sessionIndex(h)
      const hits = index.db ? search(index.db, text, { limit: Number(flags.limit ?? 10) }) : []
      if (flags.json) { print({ memories: memories.map(({ body, ...row }) => row), sessions: hits }); return 0 }
      out(`memories (${memories.length})`)
      for (const row of memories.slice(0, 30)) out(`  ${row.agent.padEnd(8)} ${short(row.title, 70)}  [${row.id}]`)
      out(`sessions (${hits.length})`)
      for (const hit of hits) out(`  ${hit.engine.padEnd(8)} ${day(hit.at)}  ${short(hit.title, 50).padEnd(50)}  ${short(hit.snippet.replaceAll(MARK_OPEN, '').replaceAll(MARK_CLOSE, ''), 90)}`)
      if (!index.db) err(index.error)
      return 0
    }

    if (command === 'asks') {
      const index = await sessionIndex(h)
      if (!index.db) { err(index.error); return 1 }
      const found = asks(index.db, { since: since(flags.since ?? '30d'), engine: flags.agent ?? null, limit: Number(flags.limit ?? 300), maxChars: Number(flags.chars ?? 400) })
      if (flags.json) { print(found.map((row) => ({ ...row, cwd: tilde(row.cwd, h.home) }))); return 0 }
      for (const row of found) out(`${day(row.at)}  ${row.engine.padEnd(8)} ${short(tilde(row.cwd, h.home), 34).padEnd(34)}  ${short(row.text, 400)}  [session:${row.sessionId}]`)
      out(`${found.length} messages`)
      return 0
    }

    if (command === 'activity') {
      const snap = await snapshot({ env, home })
      if (!snap.sessions) { err(snap.sessionsError); return 1 }
      if (flags.json) { print({ engines: snap.sessions.engines, folders: snap.sessions.folders }); return 0 }
      out(`${snap.sessions.asks} messages in ${snap.sessions.sessions} sessions since ${day(snap.sessions.firstAt)}`)
      for (const row of snap.sessions.engines) out(`  ${row.engine.padEnd(10)} ${String(row.asks).padStart(6)} messages  ${String(row.sessions).padStart(4)} sessions  last ${day(row.lastAt)}`)
      out('folders')
      for (const folder of snap.sessions.folders.slice(0, 20)) out(`  ${String(folder.asks).padStart(6)}  ${folder.cwd}  ${Object.entries(folder.engines).map(([k, v]) => `${k} ${v}`).join(', ')}`)
      return 0
    }

    if (command === 'about') {
      if (words[0] === 'write') {
        // `--gen`: a copy of another machine's build keeps that build's generation (the memory service).
        const gen = flags.gen !== undefined ? Number(flags.gen) : undefined
        if (gen !== undefined && !Number.isInteger(gen)) { err('--gen takes a whole number'); return 2 }
        const path = writeAbout(h.memory, stdin(), gen !== undefined ? { gen } : {})
        if (flags.json) {
          const refreshed = path ? deliver('refresh', { env, home }) : { results: [] }
          print({ written: Boolean(path), refreshed: refreshed.results.filter((r) => r.ok && r.changed).map((r) => r.agent) })
          return 0
        }
        if (!path) { out('A newer About You is already here; left as it is.'); return 0 }
        out(`wrote ${tilde(path, h.home)}`)
        // Agents that hold a copy get the new one now; Claude Code's hook reads the file itself.
        const refreshed = deliver('refresh', { env, home })
        for (const result of refreshed.results) if (result.changed || !result.ok) out(`${result.ok ? 'updated' : 'could not update'} ${result.agent}: ${result.file}${result.error ? ` (${result.error})` : ''}`)
        return 0
      }
      const about = readAbout(h.memory)
      if (!about) { out(`No About You yet. It will live at ${tilde(h.memory, h.home)}/about-you.md.`); return flags.json ? 1 : 0 }
      if (flags.json) { print(about); return 0 }
      out(about.text.trimEnd())
      return 0
    }

    if (command === 'due') {
      const state = due(await snapshot({ env, home }))
      if (flags.json) print(state); else out(`${state.due ? 'due' : 'not due'}: ${state.reason}`)
      return 0
    }

    if (command === 'snapshot') {
      const snap = await snapshot({ env, home })
      // What another machine's pane shows of this one: no local paths it could not open anyway beyond
      // the ~ form, and the session index's folder list left out (it is this machine's layout).
      const { sessions, ...rest } = snap
      const answer = { ...rest, sessions: sessions && { ...sessions, folders: [] }, about: snap.about && { text: snap.about.text, modified: snap.about.modified, gen: snap.about.gen } }
      // The bridge drops a frame past 8 MB, which the asking pane would read as a timeout: past 4 MB,
      // the oldest memories are sent with their first lines only.
      const budget = 4 * 1024 * 1024
      let size = JSON.stringify(answer).length
      for (const row of [...answer.memories].reverse()) {
        if (size <= budget) break
        const cut = row.body.slice(0, 600)
        size -= row.body.length - cut.length
        row.body = cut.length < row.body.length ? cut + '\n…' : cut
      }
      while (size > budget && answer.memories.length) {
        const dropped = answer.memories.pop()
        size -= JSON.stringify(dropped).length + 1
      }
      print(answer)
      return 0
    }

    if (command === 'deliver') {
      const action = words[0] ?? 'status'
      if (action === 'status') {
        const now = deliveryStatus({ env, home })
        if (flags.json) { print(now); return 0 }
        out(`About You in every agent: ${now.on ? 'on' : 'off'}`)
        for (const row of now.agents) out(`  ${row.agent.padEnd(9)} ${row.delivered ? (row.current ? 'yes' : 'older copy') : 'no '}  ${row.file}${row.error ? `  (${row.error})` : ''}`)
        return 0
      }
      if (!['on', 'off', 'refresh'].includes(action)) { err('mem deliver [status|on|off]'); return 2 }
      const choiceAt = flags['choice-at'] !== undefined ? Number(flags['choice-at']) : undefined
      if (choiceAt !== undefined && !Number.isFinite(choiceAt)) { err('--choice-at takes a time in milliseconds'); return 2 }
      // `--choice-at`: a choice made on another machine, applied with its own time (the memory service).
      const done = deliver(action, { env, home, ...(choiceAt !== undefined ? { choiceAt, exact: true } : {}) })
      if (flags.json) { print(done); return done.results.every((r) => r.ok) ? 0 : 1 }
      out(`About You in every agent: ${done.on ? 'on' : 'off'}`)
      for (const row of done.results) out(`  ${row.agent.padEnd(9)} ${row.ok ? (row.changed ? (done.on ? 'added  ' : 'removed') : 'already') : 'failed '}  ${row.file}${row.error ? `  (${row.error})` : ''}`)
      if (done.on) out('New sessions start with it; sessions already open do not change.')
      return done.results.every((r) => r.ok) ? 0 : 1
    }

    err(USAGE)
    return 2
  } catch (error) {
    err(error instanceof Error ? error.message : String(error))
    return 1
  } finally {
    closeIndex()
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/mem.mjs')) {
  // `mem list | head` closes the pipe early; that is the reader being done, not an error.
  process.stdout.on('error', (error) => { if (error.code === 'EPIPE') process.exit(0); throw error })
  process.exitCode = await run(process.argv.slice(2))
}
