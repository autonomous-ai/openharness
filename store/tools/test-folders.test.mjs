// node --test store/tools/test-folders.test.mjs
// The socket specs leave nothing in the temp folder, which builds up on a shared Mac.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { removeTempFolders, tempFolder } from './test-folders.mjs'

after(removeTempFolders)
const here = (name) => fileURLToPath(new URL(name, import.meta.url))

/** `node --test` on [files] with its own empty temp folder: its exit status, and what it left there. Under /tmp whatever
 *  TMPDIR says: one past the helper's limit would send the specs to /tmp, and this would look in an empty folder. */
function run(files) {
  const temp = tempFolder('tf-', '/tmp')
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env
  const { status } = spawnSync(process.execPath, ['--test', ...files], { env: { ...env, TMPDIR: temp }, stdio: 'ignore' })
  return { status, left: readdirSync(temp) }
}

const specs = ['local-daemon.test.mjs', 'port-holder.test.mjs', 'local-credential.test.mjs'].map(here)

test('the socket specs leave nothing behind, run after run', () => {
  for (let i = 0; i < 2; i++) assert.deepEqual(run(specs), { status: 0, left: [] })
})

test('the socket specs make their folders only through tempFolder, which the run above can see', () => {
  for (const spec of specs) assert.doesNotMatch(readFileSync(spec, 'utf8'), /mkdtemp|'\/tmp'/, spec)
})

test('a folder a spec leaves is seen, however long this run\'s own temp folder is', (t) => {
  const spec = join(tempFolder('tf-spec-'), 'leaves.test.mjs')
  writeFileSync(spec, `import { test } from 'node:test'
import { tempFolder } from ${JSON.stringify(pathToFileURL(here('test-folders.mjs')).href)}
test('leaves its folder', () => { tempFolder('left-') })
`)
  const before = process.env.TMPDIR
  t.after(() => { if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before })
  const base = tempFolder('tf-long-', '/tmp')
  for (const size of [52, 55, 60, 100]) {
    const long = join(base, 'x'.repeat(size - base.length - 1))
    mkdirSync(long)
    process.env.TMPDIR = long
    const { left } = run([spec])
    assert.equal(left.length, 1, `a ${size}-byte temp folder`)
    assert.match(left[0], /^left-/)
  }
})

test('a spec that fails leaves nothing behind either', () => {
  const failing = join(tempFolder('tf-spec-'), 'failing.test.mjs')
  writeFileSync(failing, `import { after, test } from 'node:test'
import { removeTempFolders, tempFolder } from ${JSON.stringify(pathToFileURL(here('test-folders.mjs')).href)}
after(removeTempFolders)
test('fails with its folder made', () => { tempFolder('x-'); throw new Error('on purpose') })
`)
  assert.deepEqual(run([failing]), { status: 1, left: [] })
})
