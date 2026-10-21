import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error — plain ESM with no declaration file
const { PTY_FILES: manifestFiles } = await import('../../scripts/windows-install-manifest.mjs') as { PTY_FILES: string[] }

const script = join(process.cwd(), 'scripts', 'publish-pty-payload.sh')
const FILES = ['harness-pty.exe', 'harness-launch.exe', 'harness.exe', 'conpty.dll', 'OpenConsole.exe', 'harness-serial.exe']
const hasPython = spawnSync('python3', ['--version']).status === 0
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function payloads(missing?: string) {
  const root = mkdtempSync(join(tmpdir(), 'harness-pty-publish-'))
  dirs.push(root)
  for (const arch of ['x64', 'arm64']) {
    mkdirSync(join(root, arch))
    for (const name of FILES) if (!(arch === 'arm64' && name === missing)) writeFileSync(join(root, arch, name), `${arch}:${name}`)
  }
  return root
}

const run = (root: string, args: string[], extra: Record<string, string> = {}) => spawnSync('bash', [script, ...args], {
  encoding: 'utf8', env: { ...process.env, DRY_RUN: '1', DRY_RUN_OUT: join(root, 'out'), METADATA_PATH: 'harness/staging/pty/metadata.json', GCS_BUCKET: 's3-autonomous-upgrade-3', CDN_ASSET_BASE_URL: 'https://cdn.autonomous.ai', ...extra },
})

describe.skipIf(process.platform === 'win32' || !hasPython)('publish-pty-payload.sh, as a dry run', () => {
  it('zips each architecture\'s six files at the root, and writes the pty key with their digests', () => {
    const root = payloads()
    const result = run(root, ['1.2.3', join(root, 'x64'), join(root, 'arm64')])
    expect(result.status, result.stderr).toBe(0)
    const doc = JSON.parse(readFileSync(join(root, 'out', 'metadata.json'), 'utf8'))
    for (const key of ['win32-x64', 'win32-arm64']) {
      const zip = `harness-pty-1.2.3-${key}.zip`
      const bytes = readFileSync(join(root, 'out', zip))
      expect(doc.pty[key]).toEqual({ version: '1.2.3', url: `https://cdn.autonomous.ai/harness/pty/1.2.3/${zip}`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length })
      const listing = spawnSync('python3', ['-m', 'zipfile', '-l', join(root, 'out', zip)], { encoding: 'utf8' }).stdout
      for (const name of FILES) expect(listing).toMatch(new RegExp(`^${name.replace('.', '\\.')}\\s`, 'm'))
    }
  })

  it('puts the zips under OBJECT_PREFIX, and the manifest URLs follow it', () => {
    const root = payloads()
    const result = run(root, ['1.2.3', join(root, 'x64'), join(root, 'arm64')], { OBJECT_PREFIX: 'harness/staging' })
    expect(result.status, result.stderr).toBe(0)
    const doc = JSON.parse(readFileSync(join(root, 'out', 'metadata.json'), 'utf8'))
    expect(doc.pty['win32-x64'].url).toBe('https://cdn.autonomous.ai/harness/staging/pty/1.2.3/harness-pty-1.2.3-win32-x64.zip')
    expect(doc.pty['win32-arm64'].url).toBe('https://cdn.autonomous.ai/harness/staging/pty/1.2.3/harness-pty-1.2.3-win32-arm64.zip')
    expect(run(root, ['1.2.3', join(root, 'x64'), join(root, 'arm64')], { OBJECT_PREFIX: 'harness/../x' }).status).toBe(2)
    expect(run(root, ['1.2.3', join(root, 'x64'), join(root, 'arm64')], { OBJECT_PREFIX: 'other' }).status).toBe(2)
  })

  it('publishes a prerelease only under staging, with the release core as its version folder', () => {
    const root = payloads()
    const args = ['1.2.3-dev.win1', join(root, 'x64'), join(root, 'arm64')]
    const staged = run(root, args, { OBJECT_PREFIX: 'harness/staging' })
    expect(staged.status, staged.stderr).toBe(0)
    const doc = JSON.parse(readFileSync(join(root, 'out', 'metadata.json'), 'utf8'))
    const zip = 'harness-pty-1.2.3-dev.win1-win32-x64.zip'
    expect(doc.pty['win32-x64'].version).toBe('1.2.3')
    expect(doc.pty['win32-x64'].url).toBe(`https://cdn.autonomous.ai/harness/staging/pty/1.2.3-dev.win1/${zip}`)
    expect(readFileSync(join(root, 'out', zip)).length).toBe(doc.pty['win32-x64'].size)
    const released = run(root, args)
    expect(released.status).toBe(2)
    expect(released.stderr).toContain('only under harness/staging/')
    expect(run(root, args, { OBJECT_PREFIX: 'harness/staging', METADATA_PATH: 'harness/pty/metadata.json' }).status).toBe(2)
    expect(run(root, args, { OBJECT_PREFIX: 'harness/stagingx' }).status).toBe(2)
  })

  it('refuses a payload missing a file, and a version that is not a release', () => {
    const root = payloads('OpenConsole.exe')
    const missing = run(root, ['1.2.3', join(root, 'x64'), join(root, 'arm64')])
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('has no OpenConsole.exe')
    const noSerial = payloads('harness-serial.exe')
    const withoutSerial = run(noSerial, ['1.2.3', join(noSerial, 'x64'), join(noSerial, 'arm64')])
    expect(withoutSerial.status).toBe(1)
    expect(withoutSerial.stderr).toContain('has no harness-serial.exe')
    expect(run(payloads(), ['1.2.3-dev.x', 'a', 'b']).status).toBe(2)
  })

  it('ships the same six files as the installer manifest and install.ps1', () => {
    const sh = readFileSync(script, 'utf8').match(/^FILES=\((.*)\)$/m)?.[1].split(/\s+/)
    const ps1 = readFileSync(join(process.cwd(), 'scripts', 'install.ps1'), 'utf8').match(/\$HarnessPtyFiles = @\((.*)\)/)?.[1].split(',').map((s) => s.trim().replace(/'/g, ''))
    expect(FILES).toHaveLength(6)
    expect(sh).toEqual(FILES)
    expect(ps1).toEqual(FILES)
    expect(manifestFiles).toEqual(FILES)
  })

  // Final review R3-4: a typo such as harness/cli/metadata.json would rewrite the manifest every daemon polls.
  it('publishes only into a pty manifest, production\'s or a staging prefix\'s', () => {
    const root = payloads()
    const args = ['1.2.3', join(root, 'x64'), join(root, 'arm64')]
    for (const path of ['harness/cli/metadata.json', 'harness/runtime/metadata.json', 'harness/staging/cli/metadata.json', 'harness/pty/../cli/metadata.json']) {
      const refused = run(root, args, { METADATA_PATH: path })
      expect(refused.status, path).toBe(2)
      expect(refused.stderr).toContain('is not a pty manifest')
    }
    for (const path of ['harness/pty/metadata.json', 'harness/staging-dry-run/pty/metadata.json']) expect(run(root, args, { METADATA_PATH: path }).status, path).toBe(0)
  })

  it('rejects a DRY_RUN value that is neither 0 nor 1', () => {
    const root = payloads()
    const result = run(root, ['1.2.3', join(root, 'x64'), join(root, 'arm64')], { DRY_RUN: 'true' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('DRY_RUN must be 0 or 1')
  })

  it('aborts, uploading nothing, when gcloud fails for a reason other than not found', () => {
    const root = payloads()
    const shim = join(root, 'shim')
    mkdirSync(shim)
    const log = join(root, 'gcloud.log')
    writeFileSync(join(shim, 'gcloud'), `#!/bin/sh\necho "$@" >> '${log}'\nif [ "$2" = ls ]; then echo "ERROR: Reauthentication failed" >&2; exit 1; fi\nexit 0\n`, { mode: 0o755 })
    const result = run(root, ['1.2.3', join(root, 'x64'), join(root, 'arm64')], { DRY_RUN: '0', PATH: `${shim}:${process.env.PATH}` })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Reauthentication failed')
    expect(readFileSync(log, 'utf8')).not.toMatch(/ cp /)
  })

  it('checks both zips before uploading either, and starts from {} only when the manifest is confirmed absent', () => {
    const root = payloads()
    const shim = join(root, 'shim')
    mkdirSync(shim)
    const log = join(root, 'gcloud.log')
    // arm64 zip exists; everything else is not found.
    writeFileSync(join(shim, 'gcloud'), `#!/bin/sh\necho "$@" >> '${log}'\nif [ "$2" = ls ]; then case "$3" in *arm64.zip) exit 0;; *) echo "One or more URLs matched no objects" >&2; exit 1;; esac; fi\nexit 0\n`, { mode: 0o755 })
    const result = run(root, ['1.2.3', join(root, 'x64'), join(root, 'arm64')], { DRY_RUN: '0', PATH: `${shim}:${process.env.PATH}` })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('already exists')
    expect(readFileSync(log, 'utf8')).not.toMatch(/ cp /)
  })
})
