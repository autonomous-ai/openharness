import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// release-desktop.yml's upload-windows job (installer spec §2.2): the three Windows files, create-only, and the two
// scratch parts publish-desktop-manifest.py merges. gcloud is a shim that records each call.
const script = join(process.cwd(), '..', 'desktop', 'scripts', 'upload-desktop-windows.sh')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const VERSION = '1.3.4'
const SCRATCH = 'harness/desktop/.ci/77-1'
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** The release's three files, with zips in the install shape check-windows-zip.py requires. */
function release(over: { installer?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'harness-upload-windows-'))
  dirs.push(root)
  const out = join(root, 'windows-release')
  mkdirSync(out)
  for (const arch of ['x64', 'arm64']) {
    const src = join(root, `src-${arch}`)
    for (const [name, value] of Object.entries({
      'Harness.exe': 'launcher', 'Harness.ico': 'icon', current: `${VERSION}\r\n`,
      [`app/${VERSION}/harness-desktop.exe`]: `app ${arch}`, [`app/${VERSION}/harness_pipe_io.dll`]: `pipe ${arch}`,
    })) {
      mkdirSync(join(src, name, '..'), { recursive: true })
      writeFileSync(join(src, name), value)
    }
    const zip = join(out, `Harness-windows-${arch}.zip`)
    const made = spawnSync('python3', ['-c', 'import shutil, sys; shutil.make_archive(sys.argv[1][:-4], "zip", sys.argv[2])', zip, src], { encoding: 'utf8' })
    expect(made.status, made.stderr).toBe(0)
  }
  writeFileSync(join(out, 'harness-install.exe'), over.installer ?? 'MZ installer bytes')
  const shim = join(root, 'shim')
  mkdirSync(shim)
  writeFileSync(join(shim, 'gcloud'), `#!/bin/sh
printf '%s\\n' "$*" >> "$SHIM_ROOT/gcloud.log"
[ "$1 $2" = "storage cp" ] || exit 91
shift 2
while [ "$#" -gt 2 ]; do shift; done
if [ "$SHIM_MODE" = exists ]; then echo 'precondition failed' >&2; exit 1; fi
cp "$1" "$SHIM_ROOT/uploaded-$(basename "$2")"
`, { mode: 0o755 })
  return { root, out, shim }
}

function run(world: ReturnType<typeof release>, args: string[], env: Record<string, string> = {}) {
  const base = { ...process.env }
  for (const name of ['ARTIFACT_PREFIX', 'SCRATCH_PREFIX', 'CDN_ASSET_BASE_URL', 'SHIM_MODE']) delete base[name]
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...base, PATH: `${world.shim}:${process.env.PATH}`, SHIM_ROOT: world.root, GCS_BUCKET: 's3-autonomous-upgrade-3',
      ARTIFACT_PREFIX: `harness/desktop/${VERSION}`, SCRATCH_PREFIX: SCRATCH, ...env },
  })
}

const calls = (root: string) => existsSync(join(root, 'gcloud.log')) ? readFileSync(join(root, 'gcloud.log'), 'utf8').trim().split('\n') : []

describe.skipIf(process.platform === 'win32')('upload-desktop-windows.sh', () => {
  it('refuses a bad version, a malformed call, or a destination the version job never makes', () => {
    const w = release()
    for (const args of [['v1.3.4', w.out], ['1.3.4-rc1', w.out], [VERSION], [VERSION, w.out, 'extra']]) {
      expect(run(w, args).status, args.join(' ')).toBe(2)
    }
    for (const prefix of ['harness/desktop', 'harness/desktop/1.3.5', 'harness/staging/desktop/1.3.4', 'harness/desktop/1.3.4/../cli', 'harness/desktop-candidates/1-1-short']) {
      const result = run(w, [VERSION, w.out], { ARTIFACT_PREFIX: prefix })
      expect(result.status, prefix).toBe(2)
      expect(result.stderr).toContain('nothing was uploaded')
    }
    expect(run(w, [VERSION, w.out], { SCRATCH_PREFIX: 'harness/desktop/metadata.json' }).status).toBe(2)
    expect(calls(w.root)).toEqual([])
  })

  it('uploads nothing when a zip is not a complete install or the installer is not a program', () => {
    const w = release({ installer: 'not a program' })
    const result = run(w, [VERSION, w.out])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('harness-install.exe is not a Windows program')
    const v = release()
    writeFileSync(join(v.out, 'Harness-windows-arm64.zip'), 'not a zip')
    expect(run(v, [VERSION, v.out]).stderr).toContain('is not a valid install zip')
    expect([...calls(w.root), ...calls(v.root)]).toEqual([])
  })

  it('uploads the three files create-only and immutable, then the two parts the publisher expects', () => {
    const w = release()
    const result = run(w, [VERSION, w.out])
    expect(result.status, result.stderr).toBe(0)
    const log = calls(w.root)
    expect(log).toHaveLength(5)
    for (const [index, name] of ['Harness-windows-x64.zip', 'Harness-windows-arm64.zip', 'harness-install.exe'].entries()) {
      expect(log[index]).toContain('--cache-control=public, max-age=31536000, immutable')
      expect(log[index]).toContain('--if-generation-match=0')
      expect(log[index]).toContain(`gs://s3-autonomous-upgrade-3/harness/desktop/${VERSION}/${name}`)
      expect(readFileSync(join(w.root, `uploaded-${name}`))).toEqual(readFileSync(join(w.out, name)))
    }
    for (const line of log.slice(3)) {
      expect(line).toContain('--cache-control=no-cache, no-store, must-revalidate')
      expect(line).toContain('--if-generation-match=0')
      expect(line).toContain(`gs://s3-autonomous-upgrade-3/${SCRATCH}/windows-`)
    }
    const x64 = JSON.parse(readFileSync(join(w.root, 'uploaded-windows-x64.json'), 'utf8'))
    const arm64 = JSON.parse(readFileSync(join(w.root, 'uploaded-windows-arm64.json'), 'utf8'))
    expect(Object.keys(x64).sort()).toEqual(['desktop-windows-installer', 'desktop-windows-x64'])
    expect(Object.keys(arm64)).toEqual(['desktop-windows-arm64'])
    expect(x64['desktop-windows-installer']).toEqual({
      version: VERSION, url: `https://cdn.autonomous.ai/harness/desktop/${VERSION}/harness-install.exe`,
      sha256: sha(join(w.out, 'harness-install.exe')), size: readFileSync(join(w.out, 'harness-install.exe')).length,
    })
    expect(arm64['desktop-windows-arm64'].sha256).toBe(sha(join(w.out, 'Harness-windows-arm64.zip')))
  })

  it('points a candidate\'s parts at its own objects on the bucket origin', () => {
    const w = release()
    const prefix = `harness/desktop-candidates/77-1-${'a'.repeat(32)}`
    const result = run(w, [VERSION, w.out], { ARTIFACT_PREFIX: prefix, CDN_ASSET_BASE_URL: 'https://storage.googleapis.com/s3-autonomous-upgrade-3' })
    expect(result.status, result.stderr).toBe(0)
    const x64 = JSON.parse(readFileSync(join(w.root, 'uploaded-windows-x64.json'), 'utf8'))
    expect(x64['desktop-windows-x64'].url).toBe(`https://storage.googleapis.com/s3-autonomous-upgrade-3/${prefix}/Harness-windows-x64.zip`)
  })

  it('stops at the first file that already exists, before any part is written', () => {
    const w = release()
    const result = run(w, [VERSION, w.out], { SHIM_MODE: 'exists' })
    expect(result.status).toBe(1)
    expect(calls(w.root)).toHaveLength(1)
    expect(existsSync(join(w.root, 'uploaded-windows-x64.json'))).toBe(false)
  })
})
