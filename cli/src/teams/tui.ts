import { emitKeypressEvents } from 'node:readline'
import { stripVTControlCharacters } from 'node:util'
import type { TeamCall } from './command.js'
import { TeamError } from './model.js'

const clean = (value: unknown): string => stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
export function teamTerminalView(team: Record<string, any>, width: number, height: number, selected = 0): string {
  width = Math.max(20, width)
  const members = team.members as Array<Record<string, any>> ?? []
  const exchanges = [...(team.exchanges as Array<Record<string, any>> ?? [])].reverse()
  const name = (id: string) => clean(members.find(m => m.id === id)?.name ?? 'removed')
  const lines = [clean(team.name), `${clean(team.state)} · ${members.filter(m => m.enabled).length} teammates · ${exchanges.length} exchanges`, '']
  const wrap = (value: unknown) => {
    for (const line of clean(value).split('\n')) {
      const chars = Array.from(line)
      if (!chars.length) lines.push('')
      while (chars.length) lines.push(chars.splice(0, width).join(''))
    }
  }
  // Keep an exchange visible even with a full roster or long role descriptions.
  const visibleMembers = members.slice(0, Math.max(1, Math.min(6, Math.floor(height / 5))))
  for (const m of visibleMembers) lines.push(clean(`@${m.name}  ${m.enabled === false ? 'removed' : m.runtime?.engine ?? 'offline'}  ${m.role}`).replace(/\n/g, ' '))
  if (visibleMembers.length < members.length) lines.push(`… ${members.length - visibleMembers.length} more teammates · team members`)
  lines.push('')
  const exchange = exchanges[Math.min(selected, Math.max(0, exchanges.length - 1))]
  if (exchange) {
    wrap(`${Math.min(selected + 1, exchanges.length)}/${exchanges.length}  @${name(exchange.from)} → @${name(exchange.to)}  ${exchange.state}`)
    wrap(`Question ${exchange.id}`)
    wrap(`${exchange.origin === 'owner' ? 'Requested by you' : 'Agent question'} · delivery: ${exchange.delivery?.state}`)
    lines.push(''); wrap(exchange.text)
    if (exchange.context) { lines.push(''); wrap(exchange.context) }
    lines.push('')
    if (exchange.answer) {
      wrap(`${exchange.answer.late ? 'Late answer' : 'Answer'}${exchange.answer.origin === 'owner' ? ' supplied by you' : ` from @${name(exchange.to)}`}:`)
      wrap(exchange.answer.text)
      for (const evidence of exchange.answer.evidence ?? []) wrap(evidence)
      wrap(`Return to @${name(exchange.from)}: ${exchange.continuation?.state ?? 'no notice'}`)
    } else wrap(`Waiting for an explicit reply · ${exchange.delivery?.reason ?? 'use q to return to your shell'}`)
  } else lines.push('No exchanges yet. Ask a teammate from Harness or the team ask command.')
  const clipped = lines.length > height - 3
  return [...lines.slice(0, Math.max(1, height - 3)), clipped ? `… full exchange: status ${clean(exchange?.id)}` : '', '↑/k newer · ↓/j older · r refresh · q close'].map(l => Array.from(l).slice(0, width).join('')).join('\n')
}

/** Read-only terminal conversation view. Its lifetime never owns the underlying team. */
export async function watchTeam(payload: Record<string, unknown>, call: TeamCall): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new TeamError('TTY_REQUIRED', 'Use team get --json when redirecting output; watch needs a terminal.')
  let selected = 0, stopped = false, fetching = false, team: Record<string, any> | null = null, error = ''
  const reading = new AbortController()
  const draw = () => {
    if (stopped) return
    const width = process.stdout.columns ?? 100, height = process.stdout.rows ?? 30
    process.stdout.write('\x1b[H\x1b[2J' + (team ? teamTerminalView(team, width, height - (error ? 1 : 0), selected) : 'Reading team…'))
    if (error) process.stdout.write('\n' + clean(error).slice(0, width))
  }
  const refresh = async () => {
    if (fetching || stopped) return
    fetching = true
    try {
      const result = await call({ ...payload, action: 'get' }, { signal: reading.signal })
      const next = result.team as Record<string, any>
      if (next && (!team || next.revision >= team.revision)) {
        const selectedId = team?.exchanges?.[team.exchanges.length - 1 - selected]?.id
        const nextIndex = (next.exchanges as Array<Record<string, any>>).findIndex(e => e.id === selectedId)
        if (nextIndex >= 0) selected = next.exchanges.length - 1 - nextIndex
        team = next
      }
      error = ''
    } catch (e) { error = e instanceof Error ? e.message : 'Connection unavailable. Press r to retry.' }
    finally { fetching = false; draw() }
  }
  emitKeypressEvents(process.stdin)
  const wasRaw = process.stdin.isRaw
  process.stdin.setRawMode(true); process.stdin.resume()
  process.stdout.write('\x1b[?1049h\x1b[?25l')
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  const keypress = (_text: string, key: { name?: string; ctrl?: boolean }) => {
    if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) { finish(); return }
    if (key.name === 'up' || key.name === 'k') selected = Math.max(0, selected - 1)
    if (key.name === 'down' || key.name === 'j') selected = Math.min(Math.max(0, (team?.exchanges?.length ?? 1) - 1), selected + 1)
    if (key.name === 'r') void refresh()
    draw()
  }
  const ended = () => finish()
  process.stdin.on('keypress', keypress); process.stdin.on('end', ended); process.stdout.on('resize', draw)
  process.on('SIGTERM', ended); process.on('SIGINT', ended)
  const timer = setInterval(() => { void refresh() }, 3000)
  try { draw(); void refresh(); await done }
  finally {
    stopped = true; clearInterval(timer); reading.abort()
    process.stdin.off('keypress', keypress); process.stdin.off('end', ended); process.stdout.off('resize', draw)
    process.off('SIGTERM', ended); process.off('SIGINT', ended)
    process.stdin.setRawMode(wasRaw); process.stdin.pause()
    process.stdout.write('\x1b[?25h\x1b[?1049l')
  }
}
