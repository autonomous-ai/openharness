import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../..', import.meta.url))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** A build input produced from this checkout on macOS, embedded in the existing
 * portable JS artifact. No download or compiler is required on the user's Mac.
 * Linux/source-only development can omit it and keeps ordinary discovery. */
export function readProcessImageBundle({ path, required = false, cliRoot = root } = {}) {
  if (!path) {
    if (required) throw new Error('Release requires HARNESS_PROCESS_IMAGES_ARTIFACT')
    return undefined
  }
  if (statSync(path).size > 4 * 1024 * 1024) throw new Error('Native process-image artifact is too large')
  const artifact = JSON.parse(readFileSync(path, 'utf8'))
  if (artifact?.schema !== 1 || artifact.platform !== 'darwin'
    || JSON.stringify(artifact.architectures) !== '["arm64","x86_64"]'
    || artifact.sourceSha256 !== sha256(readFileSync(join(cliRoot, 'native/darwin-process-images.c')))
    || artifact.builderSha256 !== sha256(readFileSync(join(cliRoot, 'scripts/build-process-images.py')))
    || !Number.isInteger(artifact.size) || artifact.size < 32 || artifact.size > 2 * 1024 * 1024
    || typeof artifact.base64 !== 'string') throw new Error('Native process-image build inputs do not match')
  const bytes = Buffer.from(artifact.base64, 'base64')
  if (bytes.length !== artifact.size || bytes.toString('base64') !== artifact.base64
    || sha256(bytes) !== artifact.sha256) throw new Error('Native process-image artifact checksum mismatch')
  return JSON.stringify({ schema: 1, size: bytes.length, sha256: artifact.sha256, base64: artifact.base64 })
}
