// node --test daemons/tools/generate.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// --check compares every copy the generator writes with the file in the repository, so a copy aimed at a
// folder that is gone (cli/src/pair, task OPENHARNES-14) fails here instead of being written there.
test('every copy generate.mjs writes is where it is read, and current', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./generate.mjs', import.meta.url)), '--check'], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /roster and copies are current/)
})
