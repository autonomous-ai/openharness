import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = join(process.cwd(), 'scripts', 'upload-install-ps1.sh')
const source = readFileSync(join(process.cwd(), 'scripts', 'install.ps1'), 'utf8')
const PRODUCTION = "$HarnessManifestBase = 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/'"
const APP_OFF = '$HarnessInstallApp = $false'
const APP_ON = '$HarnessInstallApp = $true'

function run(args: string[], env: Record<string, string> = {}) {
  const base = { ...process.env }
  delete base.GCS_BUCKET
  delete base.STAGING_PREFIX
  return spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...base, ...env } })
}

/** The lines that differ between the source and what would be uploaded. */
const changed = (output: string) => {
  const before = source.split('\n')
  const after = output.split('\n')
  expect(after).toHaveLength(before.length)
  return before.flatMap((line, i) => (line === after[i] ? [] : [[line, after[i]]]))
}

describe.skipIf(process.platform === 'win32')('upload-install-ps1.sh', () => {
  it('stages a copy that differs in one line only: the manifest base, moved under harness/staging/', () => {
    const result = run(['--print'])
    expect(result.status, result.stderr).toBe(0)
    expect(changed(result.stdout)).toEqual([[PRODUCTION, "$HarnessManifestBase = 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/staging/'"]])
    expect(result.stderr).toContain('gs://s3-autonomous-upgrade-3/harness/staging/cli/install.ps1')
  })

  it('publishes the file exactly as it is for production', () => {
    const result = run(['--production', '--print'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe(source)
    expect(result.stderr).toContain('gs://s3-autonomous-upgrade-3/harness/cli/install.ps1')
  })

  it('honours another staging prefix under harness/, and refuses anything else', () => {
    expect(changed(run(['--print'], { STAGING_PREFIX: 'harness/staging-dry-run' }).stdout))
      .toEqual([[PRODUCTION, "$HarnessManifestBase = 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/staging-dry-run/'"]])
    expect(run(['--print'], { STAGING_PREFIX: '../elsewhere' }).status).toBe(2)
    expect(run(['--bogus']).status).toBe(2)
  })

  it('previews the staging app copy with only the manifest base and app default changed', () => {
    const result = run(['--app', '--print'])
    expect(result.status, result.stderr).toBe(0)
    expect(changed(result.stdout)).toEqual([
      [PRODUCTION, "$HarnessManifestBase = 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/staging/'"],
      [APP_OFF, APP_ON],
    ])
    expect(result.stderr).toContain('gs://s3-autonomous-upgrade-3/harness/staging/desktop/install.ps1')
  })

  it('previews the production app copy with only the app default changed', () => {
    const result = run(['--app', '--production', '--print'])
    expect(result.status, result.stderr).toBe(0)
    expect(changed(result.stdout)).toEqual([[APP_OFF, APP_ON]])
    expect(result.stderr).toContain('gs://s3-autonomous-upgrade-3/harness/desktop/install.ps1')
  })
})
