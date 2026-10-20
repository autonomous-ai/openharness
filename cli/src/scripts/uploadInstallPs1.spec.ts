import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

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

  describe('a production upload', () => {
    const dirs: string[] = []
    afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

    /** A fake bucket behind a gcloud shim; returns a runner and the bucket objects written. */
    function bucket(objects: Record<string, object>) {
      const root = mkdtempSync(join(tmpdir(), 'harness-install-ps1-'))
      dirs.push(root)
      const store = join(root, 'bucket'), shim = join(root, 'shim')
      mkdirSync(shim)
      for (const [object, value] of Object.entries(objects)) {
        mkdirSync(dirname(join(store, object)), { recursive: true })
        writeFileSync(join(store, object), JSON.stringify(value))
      }
      writeFileSync(join(shim, 'gcloud'), `#!/bin/bash
[ "$1" = storage ] || exit 9
obj() { echo "$1" | sed -E 's#^gs://[^/]+/##'; }
if [ "$2" = cat ]; then f='${store}'/"$(obj "$3")"; [ -f "$f" ] || { echo "One or more URLs matched no objects." >&2; exit 1; }; cat "$f"; exit 0; fi
if [ "$2" = cp ]; then dst="\${@: -1}"; mkdir -p "$(dirname '${store}'/"$(obj "$dst")")"; cp "\${@: -2:1}" '${store}'/"$(obj "$dst")"; exit $?; fi
exit 9
`)
      chmodSync(join(shim, 'gcloud'), 0o755)
      return {
        run: (args: string[]) => run(args, { PATH: `${shim}:${process.env.PATH}` }),
        written: (object: string) => existsSync(join(store, object)),
      }
    }
    const entries = (version: string) => ({ 'win32-x64': { version }, 'win32-arm64': { version } })
    const live = (version = '1.2.3') => ({
      'harness/cli/metadata.json': { cli: { version } },
      'harness/runtime/metadata.json': { node: { 'darwin-arm64': {}, ...entries('22.23.2') } },
      'harness/pty/metadata.json': { pty: entries(version) },
    })

    it('goes ahead once production has this CLI, its Node runtime and its terminal host for both Windows builds', () => {
      const b = bucket(live())
      const result = b.run(['--production'])
      expect(result.status, result.stderr).toBe(0)
      expect(b.written('harness/cli/install.ps1')).toBe(true)
    })

    it('refuses while production lacks a Windows Node runtime or terminal host, or has one from another CLI version', () => {
      for (const objects of [
        { ...live(), 'harness/runtime/metadata.json': { node: { 'darwin-arm64': {} } } },
        { ...live(), 'harness/pty/metadata.json': { pty: { 'win32-x64': { version: '1.2.3' } } } },
        { ...live(), 'harness/pty/metadata.json': { pty: entries('1.2.2') } },
        { 'harness/runtime/metadata.json': live()['harness/runtime/metadata.json'], 'harness/pty/metadata.json': { pty: entries('1.2.3') } },
      ]) {
        const b = bucket(objects)
        const result = b.run(['--production'])
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('not ready for Windows')
        expect(b.written('harness/cli/install.ps1')).toBe(false)
      }
    })

    it('refuses the app copy until the production desktop manifest has both Windows zips', () => {
      const without = bucket({ ...live(), 'harness/desktop/metadata.json': { 'desktop-darwin-arm64': {} } })
      expect(without.run(['--app', '--production']).status).toBe(1)
      expect(without.written('harness/desktop/install.ps1')).toBe(false)
      const ready = bucket({ ...live(), 'harness/desktop/metadata.json': { 'desktop-windows-x64': {}, 'desktop-windows-arm64': {} } })
      expect(ready.run(['--app', '--production']).status).toBe(0)
      expect(ready.written('harness/desktop/install.ps1')).toBe(true)
    })
  })
})
