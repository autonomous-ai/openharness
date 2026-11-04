/**
 * `harness swarm …`: a Swarm as the person at this computer reads it.
 *
 * The Desktop and the web read a Swarm through the same backend parts this does
 * (`GET /api/super-tabs/:tabId/parts`). Until now the CLI could only read it as an agent inside a participating
 * harness (`harness super-tab`), so a person at a headless server could not answer "did my machine join, is there
 * work, why did my start fail" without a browser (headless run, 2026-11-03).
 *
 * Output is plain text in aligned columns: no icons, no digraphs in prose.
 */
import type { AuthSession } from '../lib/authSession.js'
import { controlPlaneAuth, requestJson } from '../lib/controlPlane.js'

type Json = Record<string, unknown>
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : []
const text = (value: unknown): string => typeof value === 'string' ? value : ''

export interface SwarmDeps {
  out(line: string): void
  err(line: string): void
  auth(): Promise<{ session: AuthSession; headers: Record<string, string> }>
  get(path: string, headers: Record<string, string>): Promise<unknown>
}

export const SWARM_USAGE = [
  'Usage: harness swarm <list | status | machines | agents | starts> [--tab <id>]',
  '',
  '  list       the Swarms this account is in',
  '  status     one Swarm: people, machines, this computer, work',
  '  machines   the machines it can run agents on, and their state',
  '  agents     the agents in it, their machine and engine',
  '  starts     agent starts: running, pending, and why one failed',
  '',
  'It reads as you do; no harness of yours has to be running. --tab names one; the first is used otherwise.',
].join('\n')

/** How old a machine reading may be before it is late, then offline (the Desktop's numbers). */
const LIVE_MS = 20_000
const LATE_MS = 35_000

function ago(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86_400)}d`
}

/** Columns, two spaces apart, numbers right-aligned: the shape `harness machines` already uses. */
function table(deps: SwarmDeps, headers: string[], rows: string[][], numeric: readonly number[] = []): void {
  const widths = headers.map((head, column) => Math.max(head.length, ...rows.map((row) => (row[column] ?? '').length)))
  const cell = (value: string, column: number, right: boolean): string => {
    const padded = right ? value.padStart(widths[column]!) : value.padEnd(widths[column]!)
    return padded
  }
  const line = (values: string[]): string => `  ${values.map((value, column) => cell(value, column, numeric.includes(column))).join('  ')}`.replace(/\s+$/, '')
  deps.out(line(headers))
  for (const row of rows) deps.out(line(row))
}

interface Parts {
  tabId: string
  head: Json
  members: Json[]
  machines: Json[]
  agents: Json[]
  groups: Json[]
  starts: Json[]
}

function partsOf(root: Json): Parts {
  return {
    tabId: text(root.tabId),
    head: object(object(root.head).data),
    members: list(root.members).map((row) => object(row.data)),
    machines: list(root.machines).map((row) => object(row.data)),
    agents: list(root.agents).map((row) => object(row.data)),
    groups: list(root.groups).map((row) => object(row.data)),
    starts: list(root.starts).map((row) => object(row.data)),
  }
}

function machineName(parts: Parts, machineId: unknown): string {
  const row = parts.machines.find((machine) => machine.machineId === machineId)
  if (!row) return String(machineId ?? 'unknown')
  const name = text(row.name) || String(machineId)
  // A machine's own row and its team account are two rows: the reading says which one it is.
  return object(row.observation).sessionKind === 'team' ? `${name} (team account)` : name
}

function groupTitle(parts: Parts, conversationId: unknown): string {
  const group = parts.groups.find((row) => row.id === conversationId)
  return text(group?.title) || String(conversationId ?? '')
}

function ownerEmail(parts: Parts, userId: unknown): string {
  const person = parts.members.find((row) => row.id === userId)
  return text(person?.email) || String(userId ?? '')
}

/** The engine names a machine contributes: the reading carries names, and may carry `{ engine }` rows. */
function enginesOf(machine: Json): string {
  const raw = Array.isArray(machine.engines) ? machine.engines : []
  const names = raw.map((engine) => typeof engine === 'string' ? engine : text(object(engine).engine)).filter(Boolean)
  return names.join(', ') || '-'
}

function machineState(machine: Json, now: number): string {
  const receivedAt = Number(object(machine.observation).receivedAt) || 0
  if (!receivedAt) return 'never reported'
  const age = now - receivedAt
  return age <= LIVE_MS ? 'live' : age <= LATE_MS ? 'late' : 'offline'
}

async function tabIdOf(deps: SwarmDeps, headers: Record<string, string>, flags: readonly string[]): Promise<string | null> {
  const inline = flags.find((flag) => flag.startsWith('--tab='))
  if (inline) return inline.slice('--tab='.length)
  const at = flags.indexOf('--tab')
  if (at >= 0) {
    const next = flags[at + 1]
    if (next && !next.startsWith('-')) return next
  }
  const listing = object(await deps.get('/api/super-tabs/list', headers))
  return text(list(listing.tabs)[0]?.id) || null
}

async function partsOfTab(deps: SwarmDeps, headers: Record<string, string>, tabId: string): Promise<Parts> {
  return partsOf(object(await deps.get(`/api/super-tabs/${encodeURIComponent(tabId)}/parts`, headers)))
}

/** The start's result, in the words a person reads: running, starting, pending, or why it failed. */
function startResult(start: Json, now: number): string {
  const error = text(start.error)
  if (error) return `failed: ${error} (${ago(Number(start.requestedAt) || now, now)})`
  if (start.harnessId) return 'running'
  if (start.dispatched) return `starting (${ago(Number(start.requestedAt) || now, now)})`
  return `pending (${ago(Number(start.requestedAt) || now, now)})`
}

export async function swarmCommand(argv: readonly string[], deps: SwarmDeps, json = false): Promise<number> {
  const words = argv.filter((arg) => !arg.startsWith('-'))
  const flags = argv.filter((arg) => arg.startsWith('-'))
  if (!words.length || words[0] === 'help' || flags.includes('-h') || flags.includes('--help')) {
    deps.out(SWARM_USAGE)
    return 0
  }
  try {
    return await run(words[0]!, flags, deps, json)
  } catch (error) {
    deps.err(`error: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

async function run(verb: string, flags: readonly string[], deps: SwarmDeps, json: boolean): Promise<number> {
  const { headers } = await deps.auth()
  const now = Date.now()
  const tabId = await tabIdOf(deps, headers, flags)
  if (!tabId) {
    if (verb === 'list') { deps.out('No Swarms on this account yet.'); return 0 }
    deps.out('No Swarm on this account yet.')
    return 0
  }
  if (verb === 'list') {
    const listing = object(await deps.get('/api/super-tabs/list', headers))
    const tabs = list(listing.tabs).slice(0, 20)
    const rows: string[][] = []
    for (const tab of tabs) {
      const parts = await partsOfTab(deps, headers, text(tab.id))
      const running = parts.agents.length
      const failed = parts.starts.filter((start) => text(start.error)).length
      rows.push([text(tab.name) || text(tab.id), String(parts.members.length), String(parts.machines.length),
        `${running} agent${running === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`])
    }
    if (json) { deps.out(JSON.stringify(rows)); return 0 }
    table(deps, ['SWARM', 'PEOPLE', 'MACHINES', 'WORK'], rows, [1, 2])
    return 0
  }
  const parts = await partsOfTab(deps, headers, tabId)
  const name = text(parts.head.name) || tabId
  switch (verb) {
    case 'status': {
      const running = parts.starts.filter((start) => start.harnessId).length
      const pending = parts.starts.filter((start) => !start.harnessId && !text(start.error)).length
      const failed = parts.starts.filter((start) => text(start.error)).length
      const lead = parts.agents.find((agent) => agent.id && parts.groups.some((group) => group.leadId === agent.id))
      deps.out(name)
      deps.out('  ' + '─'.repeat(Math.max(12, name.length)))
      deps.out(`  people      ${parts.members.length}`)
      deps.out(`  machines    ${parts.machines.length}`)
      deps.out(`  work        ${running} running, ${pending} pending, ${failed} failed`)
      if (lead) deps.out(`  lead        ${text(lead.displayName) || text(lead.name)} on ${machineName(parts, lead.machineId)}`)
      deps.out(`  updated     ${ago(Number(parts.head.lastChangedAt) || now, now)} ago`)
      return 0
    }
    case 'machines': {
      const rows = parts.machines.map((machine) => [
        machineName(parts, machine.machineId),
        ownerEmail(parts, machine.contributorId),
        enginesOf(machine),
        String(parts.agents.filter((agent) => agent.machineId === machine.machineId).length),
        machineState(machine, now),
      ])
      if (json) { deps.out(JSON.stringify(rows)); return 0 }
      table(deps, ['MACHINE', 'OWNER', 'ENGINES', 'AGENTS', 'STATE'], rows, [3])
      return 0
    }
    case 'agents': {
      const rows = parts.agents.map((agent) => [
        text(agent.displayName) || text(agent.name) || String(agent.id).slice(0, 8),
        machineName(parts, agent.machineId),
        text(object(agent.configuration).engine) || 'claude',
      ])
      if (json) { deps.out(JSON.stringify(rows)); return 0 }
      table(deps, ['AGENT', 'MACHINE', 'ENGINE'], rows)
      return 0
    }
    case 'starts': {
      const rows = parts.starts.map((start) => {
        const request = object(start.request)
        return [text(request.name) || String(start.id).slice(0, 8), groupTitle(parts, request.conversationId),
          machineName(parts, request.machineId), startResult(start, now)]
      })
      if (json) { deps.out(JSON.stringify(rows)); return 0 }
      table(deps, ['START', 'GROUP', 'MACHINE', 'RESULT'], rows)
      const failed = parts.starts.filter((start) => text(start.error))
      if (failed.length) {
        deps.out('')
        deps.out('  Why it failed')
        for (const start of failed) deps.out(`  ${text(object(start.request).name) || String(start.id).slice(0, 8)}: ${text(start.error)}`)
      }
      return 0
    }
    default:
      deps.err(`error: unknown command "swarm ${verb}"\n\n${SWARM_USAGE}`)
      return 2
  }
}
