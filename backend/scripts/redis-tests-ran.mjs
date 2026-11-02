// CI's check that the Redis-backed unit tests ran against its Redis service instead of skipping: they skip without
// REDIS_TEST_URL, and a cache stamp that could repeat passed CI unseen for that reason (review of #2456).
// Usage: node scripts/redis-tests-ran.mjs <vitest JSON report>, from backend/. Each test file that reads REDIS_TEST_URL
// must have run every test, and passed at least one.
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const report = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const files = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)])
const redisBacked = files('src').filter(file => file.endsWith('.test.ts') && readFileSync(file, 'utf8').includes('REDIS_TEST_URL'))

const problems = []
if (!redisBacked.length) problems.push('no test file reads REDIS_TEST_URL')
for (const file of redisBacked) {
  const result = report.testResults.find(r => relative(process.cwd(), r.name) === file)
  const statuses = (result?.assertionResults ?? []).map(a => a.status)
  const passed = statuses.filter(s => s === 'passed').length
  const notRun = statuses.filter(s => s !== 'passed' && s !== 'failed').length
  if (!result) problems.push(`${file}: not in the report`)
  else if (!passed || notRun) problems.push(`${file}: ${passed} passed, ${notRun} skipped`)
  else console.log(`${file}: ${passed} passed against Redis`)
}
if (problems.length) {
  console.error(`The Redis-backed tests did not all run:\n${problems.join('\n')}`)
  process.exit(1)
}
