import type { BenchConfig } from './config.js'
import type { Row, WriterRow } from './metrics.js'
import type { IsolatedPoll } from './probe.js'

export interface Size { bytes: number; documents: number }

export interface BenchReport {
  benchmark: 'swarm-state'
  version: 1
  driver: string
  startedAt: string
  commit: { sha: string; dirty: boolean } | null
  machine: { platform: string; release: string; arch: string; cpu: string; cpus: number; memoryGb: number; node: string; mongo: string }
  config: BenchConfig
  /** plan.ts planDigest: the same in two reports when both ran the same planned work. */
  planDigest: string
  setup: { ms: number; calls: number; workers: number; activeGroups: number; doneGroups: number }
  load: { plannedMs: number; actualMs: number; skipped: Record<string, number>; ops: Row[]; writerKinds: Row[]; writers: WriterRow[]; readers: Row[] }
  state: { afterSetup: Size; afterLoad: Size }
  isolatedPolls: IsolatedPoll[]
}

const ms = (value: number | null) => value === null ? '–' : value.toFixed(1)
const kb = (bytes: number) => (bytes / 1024).toFixed(1)
const errors = (row: Row) => Object.entries(row.errors).map(([code, n]) => `${code} ${n}`).join(', ') || '0'

function table(header: string[], rows: string[][]): string {
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n')
}

const CALL_HEADER = ['Calls', 'OK', 'Failed attempts (conflicts)', 'Calls retried', 'SWARM_BUSY', 'Other errors', 'p50 ms', 'p95 ms', 'max ms']
const callCells = (row: Row) => [row.count, row.ok, row.conflicts, row.retriedCalls, row.swarmBusy].map(String)
  .concat([errors(row), ms(row.p50Ms), ms(row.p95Ms), ms(row.maxMs)])

/** The report people read: one table per question the #1726 goals ask. */
export function renderMarkdown(report: BenchReport): string {
  const { config, setup, load, state } = report
  const run = [
    ['Driver', report.driver], ['Commit', report.commit ? `${report.commit.sha}${report.commit.dirty ? ' (uncommitted changes)' : ''}` : 'unknown'],
    ['Started', report.startedAt],
    ['Machine', `${report.machine.cpu}, ${report.machine.cpus} cores, ${report.machine.memoryGb} GB, ${report.machine.platform} ${report.machine.release} ${report.machine.arch}`],
    ['Runtime', `Node ${report.machine.node}, MongoDB ${report.machine.mongo} (local single-node replica set)`],
    ['Lane', config.lane === 'cross-group' ? 'cross-group (one writer per group: no Lead messages, no delivery passes)' : 'mixed'],
    ['Seed', String(config.seed)], ['Plan', `sha256 ${report.planDigest.slice(0, 16)}`],
    ['Swarm', `${config.groups} groups (${setup.doneGroups} done, ${setup.activeGroups} active), ${setup.workers} workers and a Lead, ${config.machines} machines`],
    ['Readers', `${config.desktopReaders} Desktop every ${config.every.desktopPollMs} ms, ${config.hostReaders} hosts every ${config.every.hostTickMs} ms`],
    ['Cadence', Object.entries(config.every).map(([k, v]) => `${k} ${v}`).join(', ')],
    ['Worker mix', Object.entries(config.mix).map(([k, v]) => `${k} ${v}`).join(', ')],
    ['Setup', `${setup.calls} calls in ${(setup.ms / 1000).toFixed(1)} s`],
    ['Load', `planned ${(load.plannedMs / 1000).toFixed(0)} s, ran ${(load.actualMs / 1000).toFixed(1)} s`],
    ['Skipped', Object.entries(load.skipped).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'],
  ]
  return [
    `# Swarm state benchmark (${report.driver})`, '',
    '## Run', '', table(['', ''], run), '',
    '## Operations', '', 'Every call during the load, by operation. A failed attempt is one database transaction the store retried (write conflict P2034, or a transient error); SWARM_BUSY is a call that ran out of retries.', '',
    table(['Operation', ...CALL_HEADER], load.ops.map(row => [row.key, ...callCells(row)])), '',
    '## Writer kinds', '', 'Every call by kind of writer: workers (posts in their groups), terminals (turns recorded in their groups), machines (reports), hosts (delivery passes), the Lead, and readers.', '',
    table(['Kind', ...CALL_HEADER], load.writerKinds.map(row => [row.key, ...callCells(row)])), '',
    '## Writers', '', table(['Writer', ...CALL_HEADER], load.writers.map(row => [row.key, ...callCells(row)])), '',
    '## Readers', '', 'Bytes are response bodies during the load. The isolated poll runs once each after the load, alone, and counts what MongoDB sent the backend for it.', '',
    table(['Reader', 'Polls', 'p50 ms', 'p95 ms', 'Mean KB', 'p95 KB', 'Isolated: response KB', 'Isolated: database KB'], load.readers.map(row => {
      const alone = report.isolatedPolls.find(p => p.reader === row.key)
      return [row.key, String(row.count), ms(row.p50Ms), ms(row.p95Ms), row.bytes ? kb(row.bytes.mean) : '–', row.bytes ? kb(row.bytes.p95) : '–',
        alone ? kb(alone.responseBytes) : '–', alone ? kb(alone.databaseBytesOut) : '–']
    })), '',
    '## State', '', table(['When', 'Documents', 'KB'], [
      ['After setup', String(state.afterSetup.documents), kb(state.afterSetup.bytes)], ['After the load', String(state.afterLoad.documents), kb(state.afterLoad.bytes)]]), '',
  ].join('\n')
}
