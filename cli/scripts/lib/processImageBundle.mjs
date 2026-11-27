import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../..', import.meta.url))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** One helper's checked bytes from the artifact at `path`, built by this checkout's builder for both Mac architectures
 * from `source`; undefined with no path. Both helpers come from the one artifact, so they share these checks. */
function readHelper({ path, required, cliRoot, name, source, entry }) {
  if (!path) {
    if (required) throw new Error('Release requires HARNESS_PROCESS_IMAGES_ARTIFACT')
    return undefined
  }
  if (statSync(path).size > 4 * 1024 * 1024) throw new Error('Native process-image artifact is too large')
  const artifact = JSON.parse(readFileSync(path, 'utf8'))
  const helper = entry(artifact)
  if (artifact?.schema !== 1 || artifact.platform !== 'darwin'
    || JSON.stringify(artifact.architectures) !== '["arm64","x86_64"]'
    || artifact.builderSha256 !== sha256(readFileSync(join(cliRoot, 'scripts/build-process-images.py')))
    || helper?.sourceSha256 !== sha256(readFileSync(join(cliRoot, source)))
    || !Number.isInteger(helper.size) || helper.size < 32 || helper.size > 2 * 1024 * 1024
    || typeof helper.base64 !== 'string') throw new Error(`Native ${name} build inputs do not match`)
  const bytes = Buffer.from(helper.base64, 'base64')
  if (bytes.length !== helper.size || bytes.toString('base64') !== helper.base64
    || sha256(bytes) !== helper.sha256) throw new Error(`Native ${name} artifact checksum mismatch`)
  return { sha256: helper.sha256, size: bytes.length, base64: helper.base64 }
}

/** A build input produced from this checkout on macOS, embedded in the existing
 * portable JS artifact. No download or compiler is required on the user's Mac.
 * Linux/source-only development can omit it and keeps ordinary discovery. */
export function readProcessImageBundle({ path, required = false, cliRoot = root } = {}) {
  const helper = readHelper({ path, required, cliRoot, name: 'process-image',
    source: 'native/darwin-process-images.c', entry: artifact => artifact })
  return helper && JSON.stringify({ schema: 1, size: helper.size, sha256: helper.sha256, base64: helper.base64 })
}

/** The /dev watch helper from the same artifact. Its keys come in another order than the process helper's, so the
 * perf report's match on {"schema":1,"size": (e2e/harness/processImages.ts) never reads its hash for that one's. */
export function readDevWatchBundle({ path, required = false, cliRoot = root } = {}) {
  const helper = readHelper({ path, required, cliRoot, name: '/dev watch',
    source: 'native/darwin-dev-watch.c', entry: artifact => artifact?.devWatch })
  return helper && JSON.stringify({ schema: 1, ...helper })
}
