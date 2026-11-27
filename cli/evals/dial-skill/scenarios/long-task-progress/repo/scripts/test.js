// Runs each test file in its own process, one after another, so a slow or hanging file is named as it happens.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

const files = readdirSync('test', { recursive: true })
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => `test/${name}`)

console.log(`Running ${files.length} test files one at a time; this takes a while.`)
let failed = 0
files.forEach((file, i) => {
  const started = Date.now()
  const run = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8' })
  const tag = `[${String(i + 1).padStart(2)}/${files.length}]`
  console.log(`${tag} ${file} ${run.status === 0 ? 'ok' : 'FAILED'} (${Date.now() - started} ms)`)
  if (run.status !== 0) {
    failed++
    process.stdout.write(run.stdout + run.stderr)
  }
})
console.log(failed ? `${failed} of ${files.length} test files failed` : `All ${files.length} test files passed`)
process.exit(failed ? 1 : 0)
