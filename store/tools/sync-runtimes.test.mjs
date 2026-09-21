// node --test store/tools/sync-runtimes.test.mjs — the copy keeper, on a temporary store.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, packages, sourcesRuntimes, sync } from './sync-runtimes.mjs'

const CANONICAL = '# runtimes.sh, canonical\n'

function store(t) {
  const root = mkdtempSync(join(tmpdir(), 'sync-runtimes-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (rel, text) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text) }
  put('tools/runtimes.sh', CANONICAL)
  // An agent that sources it from toolchain/, with a stale copy.
  put('agents/stale/toolchain/setup.sh', '#!/usr/bin/env bash\n. toolchain/runtimes.sh\n')
  put('agents/stale/toolchain/runtimes.sh', '# old\n')
  // An agent that sources it (via `source`, from viewer.sh at its root) and has no copy.
  put('agents/missing/viewer.sh', '#!/usr/bin/env bash\nsource "$(dirname "$0")/toolchain/runtimes.sh"\n')
  // A viewer with a current copy beside setup.sh.
  put('viewers/current/setup.sh', '#!/usr/bin/env bash\n. ./runtimes.sh\n')
  put('viewers/current/runtimes.sh', CANONICAL)
  // Packages that never mention it, one with the word only in a comment or in node_modules.
  put('agents/plain/toolchain/setup.sh', '#!/usr/bin/env bash\n# no runtimes.sh here\nnpm ci\n')
  put('agents/plain/node_modules/x/run.sh', '. runtimes.sh\n')
  put('agents/plain/a/b/c/deep.sh', '. runtimes.sh\n') // deeper than the walk goes
  put('agents/plain/README.md', '. runtimes.sh\n')
  put('agents/not-a-dir', 'a file where a package would be\n')
  return root
}

test('packages lists every agent and viewer with where its copy lives', (t) => {
  const root = store(t)
  const got = packages(root).map(({ dir, copy }) => [dir.slice(root.length + 1), copy.slice(root.length + 1)])
  assert.deepEqual(got.sort(), [
    ['agents/missing', 'agents/missing/toolchain/runtimes.sh'],
    ['agents/plain', 'agents/plain/toolchain/runtimes.sh'],
    ['agents/stale', 'agents/stale/toolchain/runtimes.sh'],
    ['viewers/current', 'viewers/current/runtimes.sh'],
  ])
})

test('a store with no viewers folder is fine', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sync-runtimes-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'agents', 'a'), { recursive: true })
  assert.deepEqual(packages(root).map((p) => p.dir), [join(root, 'agents', 'a')])
})

test('sourcesRuntimes reads shell scripts only, skipping installed trees', (t) => {
  const root = store(t)
  assert.equal(sourcesRuntimes(join(root, 'agents/stale')), true)
  assert.equal(sourcesRuntimes(join(root, 'agents/missing')), true)
  assert.equal(sourcesRuntimes(join(root, 'agents/plain')), false)
})

test('check names the stale copy and the missing one', (t) => {
  const root = store(t)
  assert.deepEqual(check(root), [
    'agents/missing sources runtimes.sh but has no toolchain/runtimes.sh',
    'agents/stale/toolchain/runtimes.sh differs from tools/runtimes.sh',
  ])
})

test('sync writes what check complained about, and nothing else', (t) => {
  const root = store(t)
  assert.deepEqual(sync(root).sort(), ['agents/missing/toolchain/runtimes.sh', 'agents/stale/toolchain/runtimes.sh'])
  assert.equal(readFileSync(join(root, 'agents/stale/toolchain/runtimes.sh'), 'utf8'), CANONICAL)
  assert.equal(existsSync(join(root, 'agents/plain/toolchain/runtimes.sh')), false)
  assert.deepEqual(check(root), [])
  assert.deepEqual(sync(root), [])
})

test('the command line: --check exits 1 with the problems, then a plain run fixes them', (t) => {
  const root = store(t)
  const script = join(root, 'tools', 'sync-runtimes.mjs')
  writeFileSync(script, readFileSync(fileURLToPath(new URL('./sync-runtimes.mjs', import.meta.url)), 'utf8'))
  assert.throws(() => execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' }), (error) => {
    assert.equal(error.status, 1)
    assert.match(error.stderr.toString(), /agents\/stale\/toolchain\/runtimes\.sh differs/)
    return true
  })
  const out = execFileSync(process.execPath, [script], { encoding: 'utf8' })
  assert.match(out, /wrote agents\/missing\/toolchain\/runtimes\.sh/)
  assert.equal(execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8' }), '')
})
