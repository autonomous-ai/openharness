/**
 * The brief on return (daemons/BRAIN.md "Brief on return"): what happened on every machine while you
 * were away, as one line and a short list.
 *
 *   line   the paired daemon's own back line, its `{summary}` filled (pair/voice.ts backLine):
 *          "reattached. 2 done, 1 waiting 40m, api failed, laptop asleep."
 *   items  at most five, what needs you first: what is waiting on you (each with its answer keys — the
 *          brain holds them while the brief is up), what failed, which machine could not be read, which is
 *          asleep, what finished. Template facts only: no model rewrites a brief.
 *
 * A sleeping machine (the account says it is offline) is named calmly, as `asleep`, never as a failure.
 *
 * Pure: the brain gathers the journals (3 s per machine) and decides when a return is a return.
 */
import type { FleetHarness, MachineJournal, MachineStatus } from './fleet.js'
import { ago, type BackFacts } from './voice.js'
import { statusText, type DaemonAction, type PairQuestion } from './protocol.js'

export interface BriefItem {
  id: string
  kind: 'waiting' | 'failed' | 'unreachable' | 'asleep' | 'done'
  machineId: string
  machine: string
  agentId?: string
  name?: string
  line: string
  /** A waiting item's question, so the brain can offer its keys. */
  question?: PairQuestion
  /** A waiting item's keys, first in its line, working while the brief is up. */
  actions?: DaemonAction[]
}

export interface BriefInput {
  journals: MachineJournal[]
  harnesses: FleetHarness[]
  machines: Array<{ machineId: string; name: string; status: MachineStatus; local: boolean }>
  awayMs: number
  now: number
}

export const BRIEF_ITEMS_MAX = 5

export function composeBrief(input: BriefInput): { facts: BackFacts; items: BriefItem[] } {
  const who = (local: boolean, name: string, machine: string): string => local ? name : `${name}@${machine}`
  const done = new Map<string, { count: number; recap: string | null; at: number; item: Omit<BriefItem, 'line' | 'id' | 'kind'>; local: boolean }>()
  const failed = new Map<string, { reason: string; item: Omit<BriefItem, 'line' | 'id' | 'kind'>; local: boolean }>()
  const touched = new Set<string>()
  const unreachable = new Set<string>()
  const asleep = new Set<string>()
  const statusOf = new Map(input.machines.map((m) => [m.machineId, m.status]))
  for (const journal of input.journals) {
    if (journal.error) {
      if (journal.error === 'asleep' || statusOf.get(journal.machineId) === 'asleep') asleep.add(journal.machine)
      else unreachable.add(journal.machine)
      continue
    }
    for (const entry of journal.entries) {
      const key = `${journal.machineId}\u0000${entry.agentId}`
      const item = { machineId: journal.machineId, machine: journal.machine, agentId: entry.agentId, name: entry.name }
      if (entry.kind === 'done' && entry.text !== 'interrupted') {
        const row = done.get(key) ?? { count: 0, recap: null, at: entry.at, item, local: journal.local }
        row.count++
        row.at = Math.max(row.at, entry.at)
        done.set(key, row)
        touched.add(key)
      } else if (entry.kind === 'recap' && entry.text) {
        const row = done.get(key)
        if (row) row.recap = entry.text
        touched.add(key)
      } else if (entry.kind === 'fail') {
        failed.set(key, { reason: entry.text ?? 'failed', item, local: journal.local })
        touched.add(key)
      } else if (entry.kind === 'question' || entry.kind === 'act') {
        touched.add(key)
      }
    }
  }
  for (const machine of input.machines) {
    if (machine.local) continue
    if (machine.status === 'asleep') asleep.add(machine.name)
    else if (machine.status === 'unreachable' && !asleep.has(machine.name)) unreachable.add(machine.name)
  }
  for (const name of asleep) unreachable.delete(name)

  const waiting = input.harnesses
    .filter((h) => h.harness.question)
    .sort((a, b) => a.harness.question!.since - b.harness.question!.since)
  for (const h of waiting) touched.add(`${h.machineId}\u0000${h.harness.agentId}`)

  const machineIdOf = (name: string): string => input.machines.find((m) => m.name === name)?.machineId ?? name
  const items: BriefItem[] = [
    ...waiting.map((h): BriefItem => {
      const q = h.harness.question!
      return {
        id: `waiting:${h.machineId}:${h.harness.agentId}`, kind: 'waiting', machineId: h.machineId, machine: h.machine,
        agentId: h.harness.agentId, name: h.harness.name, question: q,
        line: statusText(`${who(h.local, h.harness.name, h.machine)}: ${q.text} (${ago(input.now - q.since)})`, 120),
      }
    }),
    ...[...failed.values()].map(({ reason, item, local }): BriefItem => ({
      id: `failed:${item.machineId}:${item.agentId}`, kind: 'failed', ...item,
      line: statusText(`${who(local, item.name ?? '', item.machine)} failed: ${reason}`, 120),
    })),
    ...[...unreachable].map((machine): BriefItem => ({
      id: `unreachable:${machineIdOf(machine)}`, kind: 'unreachable', machineId: machineIdOf(machine), machine, line: `${machine} did not answer.`,
    })),
    ...[...asleep].map((machine): BriefItem => ({
      id: `asleep:${machineIdOf(machine)}`, kind: 'asleep', machineId: machineIdOf(machine), machine, line: `${machine} is asleep.`,
    })),
    ...[...done.values()].sort((a, b) => b.at - a.at).map(({ count, recap, item, local }): BriefItem => ({
      id: `done:${item.machineId}:${item.agentId}`, kind: 'done', ...item,
      line: statusText(`${who(local, item.name ?? '', item.machine)} finished${count > 1 ? ` ${count} turns` : ''}${recap ? `: ${recap}` : '.'}`, 120),
    })),
  ].slice(0, BRIEF_ITEMS_MAX)

  const facts: BackFacts = {
    done: done.size,
    waiting: waiting.length,
    oldestWaitMs: waiting.length ? input.now - waiting[0].harness.question!.since : null,
    awayMs: input.awayMs,
    failed: [...failed.values()].map(({ item, local }) => who(local, item.name ?? '', item.machine)),
    unreachable: [...unreachable],
    asleep: [...asleep],
    machines: input.machines.length,
    changed: touched.size,
    total: input.harnesses.length,
  }
  return { facts, items }
}
