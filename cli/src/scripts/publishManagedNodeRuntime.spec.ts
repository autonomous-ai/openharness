import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// The real script against a fake nodejs.org (file://) in dry-run mode: no gcloud, no bucket.
const script = join(process.cwd(), '..', 'desktop', 'scripts', 'publish-managed-node-runtime.sh')
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function run(env: Record<string, string> = {}, args = ['24.0.0']) {
  const root = mkdtempSync(join(tmpdir(), 'harness-node-unix-'))
  dirs.push(root)
  const dist = join(root, 'dist', 'v24.0.0')
  mkdirSync(dist, { recursive: true })
  const lines = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map((target) => {
    const name = `node-v24.0.0-${target}.tar.gz`
    writeFileSync(join(dist, name), `tar ${target}`)
    return `${sha(`tar ${target}`)}  ${name}`
  })
  writeFileSync(join(dist, 'SHASUMS256.txt'), lines.join('\n') + '\n')
  const withoutMetadataPath = { ...process.env }
  delete withoutMetadataPath.METADATA_PATH
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...withoutMetadataPath, DRY_RUN: '1', NODE_DIST_BASE: `file://${join(root, 'dist')}`, ...env },
  })
}

describe.skipIf(process.platform === 'win32')('publish-managed-node-runtime.sh, as a dry run', () => {
  it('defaults to the staging manifest', () => {
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('harness/staging/runtime/metadata.json')
    expect(result.stdout).not.toContain('harness/runtime/metadata.json')
    expect(result.stdout).toContain('harness/runtime/node/v24.0.0/node-v24.0.0-linux-x64.tar.gz')
  })

  it('writes production only through an explicit METADATA_PATH', () => {
    const result = run({ METADATA_PATH: 'harness/runtime/metadata.json' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('harness/runtime/metadata.json')
    expect(result.stdout).not.toContain('harness/staging')
  })

  it('refuses a DRY_RUN that is not exactly 0 or 1', () => {
    const result = run({ DRY_RUN: 'yes' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('DRY_RUN must be 0 or 1')
  })
})
