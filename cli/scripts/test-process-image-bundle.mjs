import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { readProcessImageBundle } from './lib/processImageBundle.mjs'

const root = mkdtempSync(join(tmpdir(), 'harness-image-bundle-'))
after(() => rmSync(root, { recursive: true, force: true }))
mkdirSync(join(root, 'native'))
mkdirSync(join(root, 'scripts'))
writeFileSync(join(root, 'native/darwin-process-images.c'), 'source')
writeFileSync(join(root, 'scripts/build-process-images.py'), 'builder')
const hash = value => createHash('sha256').update(value).digest('hex')
const bytes = Buffer.alloc(64, 7)
const artifact = { schema: 1, platform: 'darwin', architectures: ['arm64', 'x86_64'],
  sourceSha256: hash('source'), builderSha256: hash('builder'), sha256: hash(bytes),
  size: bytes.length, base64: bytes.toString('base64') }
let serial = 0
function read(value, required = true) {
  const path = join(root, `asset-${serial++}.json`)
  writeFileSync(path, JSON.stringify(value))
  return readProcessImageBundle({ path, required, cliRoot: root })
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
