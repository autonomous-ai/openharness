import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runBench } from './bench.js'
import { parseArgs } from './config.js'
import { localDatabase } from './mongo.js'
import { renderMarkdown } from './report.js'
import { benchStamps } from './stamps.js'

/** `npm run bench:swarm-state -- [options]` (README.md). Writes `<driver>-<time>.json` and `.md` to the results folder. */
async function main() {
  const { config, out, driver, cache } = parseArgs(process.argv.slice(2))
  const folder = out ?? join(process.cwd(), 'integration/bench/results')
  const database = await localDatabase()
  const stamps = await benchStamps(cache)
  try {
    const report = { ...await runBench(config, driver, database.db), cache: stamps.label }
    const name = `${report.driver}-${report.startedAt.replaceAll(':', '-').replace(/\.\d+Z$/, 'Z')}`
    const markdown = renderMarkdown(report)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(join(folder, `${name}.md`), markdown)
    process.stdout.write(`${markdown}\nWrote ${join(folder, name)}.json and .md\n`)
  } finally {
    await stamps.close()
    await database.stop()
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
