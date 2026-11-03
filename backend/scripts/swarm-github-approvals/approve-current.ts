/**
 * Approves once the GitHub repositories Swarm projects use now, before every Swarm needs an approval for App tokens
 * (src/github/currentApprovals.ts, task #1694). A dry run unless --apply: it prints the count and each (Swarm, project,
 * repository) pair it would approve, those on a repository the app is not installed on (never approved) and those GitHub
 * could not answer for, and writes nothing. It asks GitHub through the app which repositories it is on, read-only, so it
 * needs the app's environment (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY) as the backend has it. Production --apply only with
 * the owner's go, after its dry run was read; the PM runs the production dry run with the read-only login. A second run
 * finds nothing to do.
 *
 *   DATABASE_URL=… GITHUB_APP_ID=… GITHUB_APP_PRIVATE_KEY=… node --import tsx scripts/swarm-github-approvals/approve-current.ts [--apply]
 */
import { parseArgs } from 'node:util'
import { PrismaClient } from '@prisma/client'
import { approveCurrentPairs } from '../../src/github/currentApprovals.js'
import { GitHubApp, githubAppConfig } from '../../src/github/app.js'

const USAGE = 'Usage: DATABASE_URL=… GITHUB_APP_ID=… GITHUB_APP_PRIVATE_KEY=… node --import tsx scripts/swarm-github-approvals/approve-current.ts [--apply]'
/** The options, or null for anything else: an unknown flag or a positional. */
function options(): { apply: boolean } | null {
  try {
    const { values } = parseArgs({ options: { apply: { type: 'boolean' } }, strict: true, allowPositionals: false })
    return { apply: !!values.apply }
  } catch {
    return null
  }
}
const parsed = options()
if (!parsed || !process.env.DATABASE_URL) {
  console.error(USAGE)
  process.exit(2)
}
let config: ReturnType<typeof githubAppConfig> = null
try {
  config = githubAppConfig({ GITHUB_APP_ID: process.env.GITHUB_APP_ID ?? '', GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY ?? '',
    GITHUB_APP_SLUG: process.env.GITHUB_APP_SLUG ?? '' })
} catch {
  config = null
}
if (!config) {
  console.error('Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY as the backend has them: only repositories the app is installed on are approved.')
  console.error(USAGE)
  process.exit(2)
}
const app = new GitHubApp(config)
const db = new PrismaClient()
try {
  const report = await approveCurrentPairs(db, { apply: parsed.apply, installed: async repository => (await app.resolve(repository)) !== null })
  console.log(JSON.stringify(report, null, 2))
  if (!report.apply) console.log(`Dry run: ${report.pairs.length} pairs would be approved (${report.notInstalled.length} not installed, ${report.unknown.length} unknown, never approved). Nothing was written; add --apply to write them.`)
  if (report.failed.length) process.exitCode = 1
} finally {
  await db.$disconnect()
}
