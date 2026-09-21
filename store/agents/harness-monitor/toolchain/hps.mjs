#!/usr/bin/env node
/**
 * `hps` — the fleet, from a terminal.
 *
 * Everything the agent does, a person can do by hand, with the same words and the same receipts: this
 * file is the only entry point, and the viewer calls the same library underneath. Verbs are the ones a
 * developer already has muscle memory for — `ls`, `pause`, `resume`, `gc`, `log` — and every one of them
 * takes `--json` so the agent beside it never has to parse a table meant for eyes.
 *
 * Nothing here deletes a harness. See lib/actions.mjs for why that boundary is the point.
 */

import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { pause, resume } from '../lib/actions.mjs'
import { collect, resolveRef, summarize } from '../lib/inventory.mjs'
import { capture } from '../lib/panes.mjs'
import { DEFAULT_POLICY, decide, humanIdle, normalizePolicy, parseDuration } from '../lib/policy.mjs'
import { clearPaused, gb, markPaused, readState, record, writeState, writeVerdict } from '../lib/state.mjs'
import { footer, planLines, receiptLine, table } from '../lib/format.mjs'

const WORKSPACE = resolve(process.env.HARNESS_WORKSPACE || process.cwd())
const TTY = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const COLUMNS = Number(process.env.COLUMNS) || process.stdout.columns || 120

const USAGE = `hps — every harness on this machine, running or paused

  hps                                the list, freshest first (like \`docker ps\`)
  hps top                            the same list, refreshing
  hps [--all] [--state running|paused|shell|gone] [--project NAME] [--engine NAME]
            [--idle 4h] [--sort idle|mem|name|project] [--limit N] [--watch [SECONDS]]
            [--machines]           also list every other machine you have linked
  hps show <ref>                     one harness in full, with the last thing on its pane
  hps pause <ref…>               the engine exits; pane, scrollback and conversation stay
  hps resume <ref…>                  the engine comes back where it left off
  hps pause --policy                 what the rules would do to the fleet right now, and why
  hps pause --policy --apply         do it
  hps pause --idle 8h                one threshold instead of all of them
  hps resume --paused                everything that is paused, back in one line
  hps attach <ref>                   hand this terminal to that pane (tmux attach, screen -r)

  <ref> is a row number from the last list, a %pane, an agent-id prefix, or part of a name.
  Add --json to any command. --force gets past a guard; --dry-run shows what would happen.
  \`park\`/\`wake\` alias pause/resume. \`prune\`, \`gc\` and \`policy\` alias \`pause --policy\`.

  The rules are a config file: ~/.config/harness/policy.jsonc. Edit it, or drag the two lines in the pane.
  Nothing here writes it for you — a setter subcommand was only ever a worse text editor. To exempt one
  harness, put its id in "pins" (or click the pin in the pane).
`

function parseArgs(argv) {
  const flags = {}; const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--') { rest.push(...argv.slice(i + 1)); break }
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=')
      const next = argv[i + 1]
      if (inline !== undefined) flags[key] = inline
      else if (next && !next.startsWith('--')) { flags[key] = next; i += 1 }
      else flags[key] = true
    } else rest.push(arg)
  }
  return { flags, rest }
}

const out = (value) => process.stdout.write(`${value}\n`)
const die = (message, code = 1) => { process.stderr.write(`${message}\n`); process.exit(code) }

function filterRows(rows, flags, hideMs = Infinity) {
  let list = rows
  // Below the fold by default: no pane left, or nobody has touched it since `hideAfterIdle`. Both are
  // still one `--all` away — a list that hides things for good is a list people stop trusting.
  if (!flags.all) list = list.filter((row) => row.state !== 'gone' && row.state !== 'terminal' && row.idleMs < hideMs)
  if (flags.state) list = list.filter((row) => row.state === flags.state)
  if (flags.project) list = list.filter((row) => row.project.toLowerCase().includes(String(flags.project).toLowerCase()))
  if (flags.engine) list = list.filter((row) => row.engine === flags.engine)
  if (flags.machine) list = list.filter((row) => row.machine.toLowerCase().includes(String(flags.machine).toLowerCase()))
  if (flags.idle) { const min = parseDuration(flags.idle); list = list.filter((row) => row.idleMs >= min) }
  const sort = flags.sort ?? 'idle'
  const by = {
    idle: (a, b) => a.idleMs - b.idleMs,
    mem: (a, b) => (b.rssBytes || 0) - (a.rssBytes || 0),
    name: (a, b) => a.name.localeCompare(b.name),
    project: (a, b) => a.project.localeCompare(b.project) || a.idleMs - b.idleMs,
  }[sort]
  if (!by) die(`Sort by idle, mem, name or project — not ${sort}.`)
  list = [...list].sort(by)
  if (flags.limit) list = list.slice(0, Math.max(1, Number(flags.limit) || 1))
  return list
}

/** One read of the world: state file, fleet, policy, plan. Every command starts here so that what it
 *  prints and what it would do can never come from two different snapshots. */
async function world({ includeRemote = false } = {}) {
  const state = await readState(WORKSPACE)
  const policy = normalizePolicy(state.policy, { home: homedir() })
  const { rows, problems, machines, degraded } = await collect({ state, includeRemote })
  const plan = decide(rows, policy, { home: homedir() })
  return { state, policy, rows, problems, machines, degraded, plan, summary: summarize(rows) }
}

async function commit(state, entries) {
  await writeState(WORKSPACE, state)
  for (const entry of entries) await record(WORKSPACE, entry)
}

/** Resolve every ref a command was given, reporting the ones that matched nothing rather than guessing. */
function pick(refs, rows) {
  const picked = []; const errors = []
  for (const ref of refs) {
    const { row, error } = resolveRef(ref, rows)
    if (error) errors.push(error); else if (!picked.some((existing) => existing.id === row.id)) picked.push(row)
  }
  return { picked, errors }
}

// `park`/`wake` stay as aliases: muscle memory is real and an alias costs nothing.
// `park`/`wake` and `hibernate` stay as aliases: an alias costs nothing, and muscle memory is real.
// `stop` is deliberately NOT an alias: `harness stop` already means "stop the daemon", and teaching the
// wrong habit here would collide the day these verbs move into the real CLI.
const ALIASES = { park: 'pause', wake: 'resume', revive: 'resume', unpause: 'resume', hibernate: 'pause', top: 'ls', ps: 'ls', prune: 'pause', gc: 'pause', policy: 'pause' }
// `observe` is plumbing: the workspace init script calls it to write the first verdict. Not in the help.
const COMMANDS = new Set(['ls', 'show', 'pause', 'resume', 'attach', 'observe', 'help', ...Object.keys(ALIASES)])

async function main() {
  // `hps` on its own is the list — `docker ps`, not `docker ps ls`. A leading flag is a flag, not a verb,
  // so `hps --idle 4h` works the way a person expects it to.
  const args = process.argv.slice(2)
  const typed = args.length && COMMANDS.has(args[0]) ? args.shift() : args[0]?.startsWith('-') || !args.length ? 'ls' : args.shift()
  let command = ALIASES[typed] ?? typed
  const argv = args
  const { flags, rest } = parseArgs(argv)
  // `prune`, `gc` and `policy` all arrive as `pause`; what they meant was "the whole plan".
  if (['prune', 'gc', 'policy'].includes(typed)) {
    flags.policy = true
    if (rest[0] === 'apply') { rest.shift(); flags.apply = true }
  }
  // ANY BULK SELECTION IS A DRY RUN UNTIL `--apply`. A named ref acts at once — you typed the name, so you
  // meant that one — but `--policy` and `--idle` can select forty harnesses from one line. The first
  // version of this defaulted the other way and paused thirty-five of them on a live machine; reversible
  // is not the same as asked for.
  if ((flags.policy || flags.idle || flags['over-ceiling'] || flags.paused) && !flags.apply) flags['dry-run'] = true
  if (flags.help || command === 'help' || command === '--help') { out(USAGE); return }

  if (command === 'ls' || command === 'ps') {
    const watch = flags.watch !== undefined
    const every = Math.max(1, Number(flags.watch) || Number(flags.every) || 3) * 1000
    for (;;) {
      const { rows, policy, problems, summary } = await world({ includeRemote: Boolean(flags.machines) })
      const list = filterRows(rows, flags, policy.hideAfterIdleMs)
      if (flags.json) { out(JSON.stringify({ rows: list, summary, policy: { ...policy }, problems }, null, 2)); return }
      if (watch) process.stdout.write('\u001b[2J\u001b[H')
      out(table(list, { tty: TTY, columns: COLUMNS }))
      out('')
      out(footer(summarize(list), policy, { tty: TTY, problems }))
      if (!watch) return
      await new Promise((done) => setTimeout(done, every))
    }
  }

  if (command === 'show') {
    const { rows } = await world()
    const { row, error } = resolveRef(rest[0], rows)
    if (error) die(error)
    const screen = row.local && row.pane ? await capture(row.pane, { lines: Number(flags.lines) || 12 }) : ''
    if (flags.json) { out(JSON.stringify({ ...row, screen }, null, 2)); return }
    const pairs = [
      ['name', row.name], ['title', row.title ?? '—'], ['state', row.state + (row.needsInput ? ' (looks like it is waiting on you)' : '')],
      ['idle', `${humanIdle(row.idleMs)} (last turn ${new Date(row.lastActivity).toLocaleString()})`],
      ['engine', `${row.engine}${row.model ? ` · ${row.model}${row.effort ? ` @${row.effort}` : ''}` : ''}`],
      ['folder', row.home], ['branch', row.branch ?? '—'], ['project', row.project],
      ['memory', row.rssBytes ? `${gb(row.rssBytes)} across ${row.procs} ${row.procs === 1 ? 'process' : 'processes'}` : '—'],
      ['pane', row.pane ? `${row.pane}${row.paneTarget ? ` (${row.paneTarget})` : ''}${row.dead ? ' · dead, held open' : ''}` : '—'],
      ['machine', row.machine + (row.local ? '' : row.resumeVia === 'daemon' ? ' (another machine — paused and resumed by its daemon)' : ' (another machine — update Harness there to act on it from here)')],
      ['harness', row.dshName ?? row.dsh ?? '—'], ['agent id', row.id],
      ['pinned', row.pinned ? 'yes — the policy leaves it alone' : 'no'],
      ['resume', row.resumeVia === 'daemon' ? 'through the daemon (agent_resume), in a new pane'
        : row.resumeVia === 'legacy' ? 'typed into its own pane (paused before the daemon could save it)'
          : row.sessionId ? `not possible — the daemon cannot resume ${row.engine}` : 'not possible — no conversation bound yet'],
    ]
    const width = Math.max(...pairs.map(([key]) => key.length))
    for (const [key, value] of pairs) out(`${key.padEnd(width)}  ${value}`)
    if (screen.trim()) { out(''); out('last on its pane:'); for (const line of screen.split('\n').filter((l) => l.trim()).slice(-Number(flags.lines || 12))) out(`  ${line}`) }
    return
  }

  if (['pause', 'resume'].includes(command)) {
    const { rows, policy, state, plan, summary, problems } = await world()
    let targets = []
    // `resume --paused` is the undo button: everything this ever paused, back in one line. A dry run first,
    // like every other bulk selection.
    if (command === 'resume' && flags.paused) {
      targets = rows.filter((row) => row.state === 'paused')
    } else if (flags.policy || flags.idle || flags['over-ceiling']) {
      // The rules select the rows. `--idle` is the same shape with one threshold instead of all of them.
      const chosen = flags.idle
        ? rows.filter((row) => row.state === 'running' && row.idleMs >= parseDuration(flags.idle))
        : rows.filter((row) => plan.entries.find((entry) => entry.id === row.id && entry.action === command))
      targets = chosen
    } else {
      const { picked, errors } = pick(rest, rows)
      for (const error of errors) process.stderr.write(`${error}\n`)
      if (!picked.length) die('Name a harness, or use --policy for everything the rules would touch.')
      targets = picked
    }

    // Dry run: print the plan the rules made, with the reason per row, and change nothing. This is the one
    // thing a config file cannot tell you — what it would do to the fleet as it is right now.
    if (flags['dry-run']) {
      await writeVerdict(WORKSPACE, { summary, rows, plan: plan.entries, problems })
      if (flags.json) { out(JSON.stringify({ dryRun: true, command, totals: plan.totals, plan: plan.entries.filter((e) => e.action !== 'keep') }, null, 2)); return }
      if (flags.policy) {
        out(planLines(plan.entries, { tty: TTY }))
        out('')
        out(`Would ${command} ${plan.totals.pause} — handing back ${gb(plan.totals.frees)} and leaving ${plan.totals.runningAfter} running.`)
        out(`Nothing has moved. Run \`hps ${command} --policy --apply\` to do it.`)
      } else {
        out(targets.map((row) => `${command} ${row.name} — idle ${humanIdle(row.idleMs)}, ${row.state}${row.rssBytes ? `, ${gb(row.rssBytes)}` : ''}`).join('\n') || 'Nothing matches.')
      }
      return
    }

    const options = { policy, force: Boolean(flags.force), killAfterGrace: Boolean(flags.force) }
    const results = []
    let next = state
    for (const row of targets) {
      const ticket = state.paused?.[row.id] ?? null
      const result = command === 'pause' ? await pause(row, options) : await resume(row, { ticket })
      // The ticket is written before the receipt is printed: a pause whose session id was not recorded is
      // a harness nobody can resume, which is worse than one that is still running.
      if (result.ok && result.ticket) next = markPaused(next, row, result.ticket)
      // The daemon holds a harness it confirmed saving; a record here would only go stale.
      if (result.ok && result.via === 'daemon') next = clearPaused(next, row.id)
      if (result.ok && command === 'resume') next = clearPaused(next, row.id)
      results.push(result)
    }
    await commit(next, results.map((result) => ({ ...result, by: flags.by ?? 'cli' })))
    if (flags.json) { out(JSON.stringify({ results }, null, 2)); return }
    for (const result of results) out(receiptLine(result, { tty: TTY }))
    const freed = results.filter((r) => r.ok && r.freed).reduce((sum, r) => sum + r.freed, 0)
    if (freed) out(`\n${gb(freed)} handed back.`)
    const refused = results.filter((r) => r.refused).length
    if (refused) out(`${refused} left alone. Add --force to overrule a guard.`)
    return
  }

  if (command === 'attach') {
    const { rows } = await world({ includeRemote: false })
    const { row, error } = resolveRef(rest[0], rows)
    if (error) die(error)
    if (!row.paneTarget) die('That harness has no pane on this machine.')
    if (flags.json) { out(JSON.stringify({ session: row.paneTarget.split(':')[0], pane: row.pane })); return }
    // Hand the terminal over, the way `docker attach` and `screen -r` do. Printing a command for someone
    // to paste is the worst of both: it is neither the answer nor the action.
    const { spawn } = await import('node:child_process')
    spawn('tmux', ['attach', '-t', row.paneTarget.split(':')[0]], { stdio: 'inherit' })
      .on('exit', (code) => process.exit(code ?? 0))
    return
  }

  if (command === 'observe') {
    const { summary, rows, plan, problems } = await world({ includeRemote: false })
    const verdict = await writeVerdict(WORKSPACE, { summary, rows, plan: plan.entries, problems })
    out(flags.json ? JSON.stringify(verdict, null, 2) : verdict.summary)
    return
  }

  die(`No such command: ${command}\n\n${USAGE}`, 2)
}

main().catch((error) => die(error instanceof Error ? error.message : String(error)))
