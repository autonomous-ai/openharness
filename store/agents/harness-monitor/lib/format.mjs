/**
 * The dense list, as a terminal draws it.
 *
 * One line per harness, columns that line up, glyphs instead of words for state, and the totals on the
 * last line — the shape `tmux ls`, `docker ps` and `htop` all settled on, for the same reason: a fleet is
 * read by scanning down one column, not by reading sentences. Colour only when a terminal is listening,
 * and never as the only carrier of meaning: the glyph says it too.
 */

import { humanIdle } from './policy.mjs'
import { gb } from './state.mjs'

const CODES = { dim: '2', bold: '1', gold: '33', green: '32', red: '31', amber: '93', blue: '36' }

export function painter({ tty = false } = {}) {
  if (!tty) return Object.fromEntries([...Object.keys(CODES), 'plain'].map((key) => [key, (text) => String(text)]))
  const paint = (code) => (text) => `\u001b[${code}m${text}\u001b[0m`
  return { ...Object.fromEntries(Object.entries(CODES).map(([key, code]) => [key, paint(code)])), plain: (text) => String(text) }
}

/** ● running · ◐ working · ○ paused · $ shell · ✕ gone · ! waiting on you. Two characters wide so the
 *  column never shifts when a glyph is double-width on someone's font. */
export function glyph(row, c) {
  if (row.needsInput) return c.amber('! ')
  if (row.state === 'running') return row.working ? c.gold('◐ ') : c.green('● ')
  if (row.state === 'paused') return c.dim('○ ')
  if (row.state === 'terminal') return c.dim('$ ')
  return c.dim('✕ ')
}

function pad(text, width, align = 'left') {
  const value = String(text ?? '')
  // Visible width: strip the escapes a painter may have added before measuring.
  const bare = value.replace(/\u001b\[[0-9;]*m/g, '')
  if (bare.length >= width) return align === 'right' ? value : `${value.slice(0, value.length - (bare.length - width))}`
  const gap = ' '.repeat(width - bare.length)
  return align === 'right' ? gap + value : value + gap
}

const mem = (bytes) => (bytes ? gb(bytes).replace(' ', '') : '—')

/** The table. `columns` is the terminal's width, used to decide what gets dropped: title first, then
 *  branch, then project — a narrow pane still shows state, idle, engine and memory, which is the
 *  minimum that makes the list worth reading. */
export function table(rows, { tty = false, columns = 120, numbered = true, now = Date.now() } = {}) {
  const c = painter({ tty })
  const wide = columns >= 110
  const medium = columns >= 88
  // Only when there is more than one machine in the list: a column that says the same thing on every
  // row is a column that costs width and carries nothing.
  const machines = new Set(rows.map((row) => row.machine))
  const machineWidth = machines.size > 1 ? Math.min(14, Math.max(...[...machines].map((name) => name.length))) : 0
  const widths = {
    n: numbered ? Math.max(2, String(rows.length).length) : 0,
    state: 2, idle: 5, engine: 8, model: wide ? 15 : 0, mem: 6,
    project: medium ? 20 : 0, branch: wide ? 14 : 0, machine: machineWidth,
  }
  const head = [
    numbered ? pad('#', widths.n, 'right') : '',
    pad('', widths.state), pad('IDLE', widths.idle), pad('ENGINE', widths.engine),
    widths.model ? pad('MODEL', widths.model) : '',
    pad('MEM', widths.mem, 'right'),
    widths.project ? ` ${pad('PROJECT', widths.project)}` : '',
    widths.branch ? pad('BRANCH', widths.branch) : '',
    widths.machine ? pad('MACHINE', widths.machine) : '',
    'TITLE',
  ].filter(Boolean).join(' ')

  const lines = [c.dim(head)]
  rows.forEach((row, index) => {
    const title = row.title || row.name
    const line = [
      numbered ? c.dim(pad(index + 1, widths.n, 'right')) : '',
      glyph(row, c),
      pad(row.state === 'gone' ? '—' : humanIdle(row.idleMs), widths.idle),
      pad(row.engine, widths.engine),
      widths.model ? c.dim(pad(row.model ?? '—', widths.model)) : '',
      pad(mem(row.rssBytes), widths.mem, 'right'),
      widths.project ? ` ${pad(row.project, widths.project)}` : '',
      widths.branch ? c.dim(pad(row.branch ?? '—', widths.branch)) : '',
      widths.machine ? (row.local ? c.dim(pad(row.machine, widths.machine)) : c.blue(pad(row.machine, widths.machine))) : '',
      row.state === 'running' ? title : c.dim(title),
    ].filter(Boolean).join(' ')
    lines.push(line.length > columns + 64 ? line.slice(0, columns + 64) : line)
  })
  return lines.join('\n')
}

/** The line under the table: what the fleet is, in one breath. */
export function footer(summary, policy, { tty = false, problems = [] } = {}) {
  const c = painter({ tty })
  const parts = [
    `${summary.total} ${summary.total === 1 ? 'harness' : 'harnesses'}`,
    `${c.green(summary.running)} running`,
    summary.paused ? `${summary.paused} paused` : null,
    summary.gone ? `${summary.gone} gone` : null,
    summary.terminals ? `${summary.terminals} ${summary.terminals === 1 ? 'shell' : 'shells'}` : null,
    summary.needsInput ? c.amber(`${summary.needsInput} waiting on you`) : null,
    `${gb(summary.held)} held`,
    `${summary.projects} projects`,
    summary.machines > 1 ? `${summary.machines} machines` : null,
  ].filter(Boolean)
  const lines = [parts.join(c.dim(' · '))]
  if (policy) lines.push(c.dim(`policy: pause after ${policy.pauseAfterIdle} · hide after ${policy.hideAfterIdle} · ceiling ${policy.runningCeiling} running`))
  for (const problem of problems) lines.push(c.red(`${problem.machine}: ${problem.error}`))
  return lines.join('\n')
}

/** `hps prune --explain` and `hps pause --dry-run`: the plan, one line each, longest reason last. */
export function planLines(entries, { tty = false, verb = null } = {}) {
  const c = painter({ tty })
  const shown = entries.filter((entry) => entry.action !== 'keep' && (!verb || entry.action === verb))
  if (!shown.length) return c.dim('Nothing to do — every harness is where the policy wants it.')
  const width = Math.max(...shown.map((entry) => entry.name.length), 4)
  // Both columns are measured, never guessed: a hardcoded action width silently truncated `pause`
  // to `hiberna`, which is the kind of thing only a test notices.
  const verbWidth = Math.max(...shown.map((entry) => entry.action.length))
  return shown.map((entry) => `${c.bold(pad(entry.action, verbWidth))} ${pad(entry.name, width)}  ${c.dim(entry.why)}`).join('\n')
}

export function receiptLine(result, { tty = false } = {}) {
  const c = painter({ tty })
  const mark = result.ok ? (result.already ? c.dim('=') : c.green('✓')) : result.refused ? c.amber('·') : c.red('✕')
  const freed = result.freed ? c.dim(` (+${gb(result.freed)})`) : ''
  return `${mark} ${result.action} ${result.name}${freed} ${c.dim('— ' + result.detail)}`
}
