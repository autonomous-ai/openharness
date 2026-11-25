import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { readDevWatchBundle, readProcessImageBundle } from './lib/processImageBundle.mjs'

const root = mkdtempSync(join(tmpdir(), 'harness-image-bundle-'))
after(() => rmSync(root, { recursive: true, force: true }))
mkdirSync(join(root, 'native'))
mkdirSync(join(root, 'scripts'))
writeFileSync(join(root, 'native/darwin-process-images.c'), 'source')
writeFileSync(join(root, 'native/darwin-dev-watch.c'), 'watch source')
writeFileSync(join(root, 'scripts/build-process-images.py'), 'builder')
const hash = value => createHash('sha256').update(value).digest('hex')
const bytes = Buffer.alloc(64, 7)
const watchBytes = Buffer.alloc(64, 9)
const devWatch = { sourceSha256: hash('watch source'), sha256: hash(watchBytes),
  size: watchBytes.length, base64: watchBytes.toString('base64') }
const artifact = { schema: 1, platform: 'darwin', architectures: ['arm64', 'x86_64'],
  sourceSha256: hash('source'), builderSha256: hash('builder'), sha256: hash(bytes),
  size: bytes.length, base64: bytes.toString('base64'), devWatch }
let serial = 0
function write(value) {
  const path = join(root, `asset-${serial++}.json`)
  writeFileSync(path, JSON.stringify(value))
  return path
}
function read(value, required = true) {
  return readProcessImageBundle({ path: write(value), required, cliRoot: root })
}
function readWatch(value, required = true) {
  return readDevWatchBundle({ path: write(value), required, cliRoot: root })
}

test('source-only builds omit the helper; a release must supply it', () => {
  assert.equal(readProcessImageBundle(), undefined)
  assert.throws(() => readProcessImageBundle({ required: true }), /Release requires/)
})

test('embeds only exact binary bytes and identity, without build-machine metadata', () => {
  assert.deepEqual(JSON.parse(read({ ...artifact, toolchain: 'private build path' })), {
    schema: 1, size: 64, sha256: artifact.sha256, base64: artifact.base64,
  })
})

test('rejects stale sources, stale builder, missing architectures and corrupted bytes', () => {
  for (const change of [
    { schema: 2 }, { sourceSha256: hash('old') }, { builderSha256: hash('old') },
    { architectures: ['arm64'] }, { platform: 'linux' }, { size: 63 },
    { sha256: hash('bad') }, { base64: artifact.base64 + '\n' }, { size: 3 * 1024 * 1024 },
  ]) assert.throws(() => read({ ...artifact, ...change }))
})

test('optional means absent, not accepting a supplied broken build artifact', () => {
  assert.throws(() => read({ ...artifact, sourceSha256: 'bad' }, false))
})

test('source-only builds omit the /dev watch helper; a release must supply it', () => {
  assert.equal(readDevWatchBundle(), undefined)
  assert.throws(() => readDevWatchBundle({ required: true }), /Release requires/)
})

// Its own key order, so the perf report's match on {"schema":1,"size": never reads its hash as the process helper's.
test('embeds only the /dev watch helper\'s exact bytes and identity, in its own key order', () => {
  const text = readWatch({ ...artifact, toolchain: 'private build path' })
  assert.ok(text.startsWith('{"schema":1,"sha256":'))
  assert.deepEqual(JSON.parse(text), { schema: 1, sha256: devWatch.sha256, size: 64, base64: devWatch.base64 })
})

test('rejects a missing, stale or corrupted /dev watch helper', () => {
  for (const [change, error] of [
    [{ devWatch: undefined }, /Native \/dev watch build inputs do not match$/],
    [{ devWatch: { ...devWatch, sourceSha256: hash('old') } }, /Native \/dev watch build inputs do not match$/],
    [{ builderSha256: hash('old') }, /Native \/dev watch build inputs do not match$/],
    [{ devWatch: { ...devWatch, size: 63 } }, /Native \/dev watch artifact checksum mismatch$/],
    [{ devWatch: { ...devWatch, sha256: hash('bad') } }, /Native \/dev watch artifact checksum mismatch$/],
    [{ devWatch: { ...devWatch, base64: devWatch.base64 + '\n' } }, /Native \/dev watch artifact checksum mismatch$/],
    [{ devWatch: { ...devWatch, size: 3 * 1024 * 1024 } }, /Native \/dev watch build inputs do not match$/],
  ]) assert.throws(() => readWatch({ ...artifact, ...change }), error)
})
