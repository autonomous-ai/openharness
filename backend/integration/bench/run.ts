import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { runBench } from './bench.js'
import { parseArgs } from './config.js'
import { localDatabase } from './mongo.js'
import { readProfile, renderProfile, startProfiling } from './profile.js'
import { renderMarkdown } from './report.js'
import { benchStamps } from './stamps.js'

/** `npm run bench:swarm-state -- [options] [--profile]` (README.md). Writes `<driver>-<time>.json` and `.md` to the results
 *  folder; with `--profile`, every database operation of the run goes through Mongo's profiler and the report adds what each
 *  query shape read and how long it took. */
async function main() {
  const argv = process.argv.slice(2), profile = argv.includes('--profile')
  const { config, out, driver, cache } = parseArgs(argv.filter(arg => arg !== '--profile'))
  const folder = out ?? join(process.cwd(), 'integration/bench/results')
  const database = await localDatabase()
  const stamps = await benchStamps(cache)
  try {
    if (profile) await startProfiling(database.db)
    const peak = profile ? peakConnections(database.db) : null
    const report = { ...await runBench(config, driver, database.db), cache: stamps.label }
    const profiled = profile ? { ...await readProfile(database.db), peakConnections: await peak!.stop() } : null
    const name = `${report.driver}-${report.startedAt.replaceAll(':', '-').replace(/\.\d+Z$/, 'Z')}`
    const markdown = renderMarkdown(report) + (profiled ? `\n${renderProfile(profiled)}` : '')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, `${name}.json`), `${JSON.stringify(profiled ? { ...report, profile: profiled } : report, null, 2)}\n`)
    await writeFile(join(folder, `${name}.md`), markdown)
    process.stdout.write(`${markdown}\nWrote ${join(folder, name)}.json and .md\n`)
  } finally {
    await stamps.close()
    await database.stop()
  }
}

/** The most connections the server held at once, sampled every 250 ms: the bench's one client, so its pool's peak. */
function peakConnections(db: PrismaClient) {
  let peak = 0, running = true
  const sampling = (async () => {
    while (running) {
      const status = await db.$runCommandRaw({ serverStatus: 1, repl: 0, metrics: 0, locks: 0 }) as { connections?: { current?: number } }
      peak = Math.max(peak, Number(status.connections?.current ?? 0))
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  })()
  return { async stop() { running = false; await sampling; return peak } }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
