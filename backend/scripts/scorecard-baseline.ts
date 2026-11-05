// The scorecard's baseline (task #3386): every project's figures for the days given, computed by the nightly job's own code
// (superTabs/scorecard) against a read-only database, printed as Markdown tables. It writes nothing.
//
// Safety: reads only. The URL comes from MONGO_READONLY_URL, is switched to readPreference=secondary, and the run is refused
// when the login may write. The URL is never printed. Privacy: Swarms and projects are numbered, never named, except the
// project passed as NAMED_PROJECT (the public repository's own), and no text, name or id leaves the database.
//
// Run from backend/:  MONGO_READONLY_URL=... NAMED_TAB=<tabId> NAMED_PROJECT=<projectId> npx tsx scripts/scorecard-baseline.ts 2026-11-04 2026-11-05
import { PrismaClient } from '@prisma/client'
import { listNamedIndexes } from '../src/superTabs/parts/indexed.js'
import { projectsOf } from '../src/superTabs/projects.js'
import type { SuperTabState } from '../src/superTabs/model.js'
import { scorecardPlan } from '../src/superTabs/scorecard/job.js'
import { dayBounds, scorecardDay, type ScorecardFigures } from '../src/superTabs/scorecard/figures.js'
import { scorecardRecords } from '../src/superTabs/scorecard/records.js'
import { secondaryUrl } from './atlas-snapshot.js'

const days = process.argv.slice(2)
const url = process.env.MONGO_READONLY_URL
if (!url || !days.length || days.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d))) {
  console.error('Usage: MONGO_READONLY_URL=... npx tsx scripts/scorecard-baseline.ts YYYY-MM-DD [YYYY-MM-DD ...]')
  process.exit(2)
}
const db = new PrismaClient({ datasources: { db: { url: secondaryUrl(url) } } })

const COLUMNS: Array<[keyof ScorecardFigures, string]> = [['asksShipped', 'Asks shipped'], ['askToShipMedianMinutes', 'Ask→ship median (min)'],
  ['unansweredAsks', 'Unanswered asks'], ['oldestUnansweredAskMinutes', 'Oldest unanswered (min)'], ['idleMinutes', 'Nobody working, work waiting (min)'],
  ['lostLeftAlone', 'Lost >10 min'], ['fixesAfterMerge', 'Fixes after merge'], ['corrections', 'Corrections of PM'], ['starts', 'Starts'],
  ['startsFailed', 'Failed starts'], ['routeDecisions', 'Route decisions'], ['typedIntoPm', 'Typed into PM'], ['ackPosts', 'Ack-only posts'],
  ['agentPosts', 'Agent posts']]

async function main() {
  const status = await db.$runCommandRaw({ connectionStatus: 1, showPrivileges: true }) as unknown as
    { authInfo?: { authenticatedUserPrivileges?: Array<{ actions?: string[] }> } }
  const actions = new Set((status.authInfo?.authenticatedUserPrivileges ?? []).flatMap(p => p.actions ?? []))
  for (const write of ['insert', 'update', 'remove']) if (actions.has(write)) throw new Error(`Refused: this login may ${write}.`)
  await listNamedIndexes(db)
  const began = Date.now()
  const { targets, failed } = await scorecardPlan(db, Date.parse(`${days.at(-1)}T23:59:59Z`) + 36 * 3600_000)
  if (failed) console.error(`${failed} Swarms could not be read.`)
  const named = new Map<string, string>()
  const namedTab = process.env.NAMED_TAB
  if (namedTab) {
    const head = await db.swarmHead.findUnique({ where: { id: `${namedTab}:head` }, select: { data: true } })
    for (const p of head ? projectsOf(head.data as unknown as SuperTabState) : []) named.set(p.id, p.name)
  }
  const tabs = [...new Set(targets.map(t => t.tabId))]
  for (const on of days) {
    const rows: Array<{ label: string; figures: ScorecardFigures; capped: number }> = []
    for (const target of targets) {
      const { start, end } = dayBounds(on, target.timeZone)
      const { input, capped } = await scorecardRecords(db, { tabId: target.tabId, projectId: target.projectId, chatId: target.chatId, start, end })
      const figures = scorecardDay(input)
      // A project with nothing in the day says nothing about the process.
      if (!figures.agentPosts && !figures.starts && !figures.routeDecisions && !figures.asksShipped && !figures.unansweredAsks && !figures.idleMinutes) continue
      const label = target.tabId === namedTab && target.projectId === process.env.NAMED_PROJECT ? named.get(target.projectId) ?? 'project'
        : `Swarm ${tabs.indexOf(target.tabId) + 1}, project ${targets.filter(t => t.tabId === target.tabId).indexOf(target) + 1}`
      rows.push({ label, figures, capped })
    }
    console.log(`\n### ${on} (each project's own day, ${rows.length} projects with activity)\n`)
    console.log(`| Project | ${COLUMNS.map(([, title]) => title).join(' | ')} |`)
    console.log(`|---|${COLUMNS.map(() => '---:').join('|')}|`)
    const sum = (key: keyof ScorecardFigures) => rows.reduce((total, r) => total + (typeof r.figures[key] === 'number' ? r.figures[key] as number : 0), 0)
    for (const r of rows.sort((a, b) => a.label.localeCompare(b.label))) {
      console.log(`| ${r.label}${r.capped ? ' (capped)' : ''} | ${COLUMNS.map(([key]) => r.figures[key] ?? '–').join(' | ')} |`)
    }
    console.log(`| **All** | ${COLUMNS.map(([key]) => key.endsWith('Minutes') && key !== 'idleMinutes' ? '' : sum(key)).join(' | ')} |`)
  }
  console.error(`Read in ${Math.round((Date.now() - began) / 1000)} s.`)
}

main().finally(() => db.$disconnect()).catch(error => {
  console.error(String(error instanceof Error ? error.message : error).replace(/mongodb(\+srv)?:\/\/[^\s]+/g, 'mongodb://***'))
  process.exit(1)
})
