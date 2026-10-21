import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = join(process.cwd(), '..', 'desktop', 'scripts', 'publish-desktop-windows-staging.sh')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'harness-desktop-staging-'))
  dirs.push(root)
  return root
}

/** Fake contents verify the archive contract; only the Windows job proves executable bytes and tar extraction. */
function zip(root: string, version: string, arch: string, over: { current?: string; leave?: string; marker?: boolean } = {}) {
  const folder = join(root, `src-${arch}`)
  const files: Record<string, string> = {
    'Harness.exe': 'launcher',
    'Harness.ico': 'icon',
    current: `${over.current ?? version}\r\n`,
    [`app/${version}/harness-desktop.exe`]: `app ${arch}`,
    [`app/${version}/harness_pipe_io.dll`]: `pipe ${arch}`,
    [`app/${version}/data/app.so`]: `data ${arch}`,
  }
  if (over.marker) files[`app/${version}/.started`] = 'stale'
  for (const [name, value] of Object.entries(files)) {
    if (name === over.leave) continue
    mkdirSync(join(folder, name, '..'), { recursive: true })
    writeFileSync(join(folder, name), value)
  }
  const out = join(root, `harness-desktop-${version}-windows-${arch}.zip`)
  const made = spawnSync('python3', ['-c', 'import shutil, sys; shutil.make_archive(sys.argv[1][:-4], "zip", sys.argv[2])', out, folder], { encoding: 'utf8' })
  expect(made.status, made.stderr).toBe(0)
  return out
}

/** harness-install.exe as far as the publisher checks it: its name and a Windows program's first two bytes. */
function installer(root: string) {
  const out = join(root, 'harness-install.exe')
  writeFileSync(out, 'MZ installer bytes')
  return out
}

function shim(root: string) {
  const dir = join(root, 'shim')
  mkdirSync(dir)
  writeFileSync(join(root, 'seed.json'), '{"desktop-macos":{"version":"1.2.89"}}\n')
  writeFileSync(join(dir, 'gcloud'), `#!/bin/sh
printf '%s\\n' "$*" >> "$SHIM_ROOT/gcloud.log"
[ "$1" = storage ] || exit 91
case "$2" in
  ls)
    case "$SHIM_MODE" in
      unknown) echo 'ERROR: Reauthentication failed' >&2; exit 1 ;;
      exists-arm) case "$3" in *arm64.zip) exit 0;; esac ;;
      missing-metadata) ;;
      *) case "$3" in *metadata.json) exit 0;; esac ;;
    esac
    echo 'One or more URLs matched no objects' >&2; exit 1 ;;
  objects)
    [ "$3" = describe ] || exit 92
    if [ "$SHIM_MODE" = generation-error ]; then echo 'ERROR: generation unavailable' >&2; exit 1; fi
    printf '17\\n'; exit 0 ;;
  cp)
    shift 2
    while [ "$#" -gt 2 ]; do shift; done
    src="$1" dst="$2"
    case "$dst" in
      gs://*)
        case "$dst" in
          *arm64.zip) if [ "$SHIM_MODE" = fail-arm ]; then echo 'precondition failed' >&2; exit 1; fi ;;
          *metadata.json) if [ "$SHIM_MODE" = race ]; then echo 'precondition failed' >&2; exit 1; fi ;;
        esac
        cp "$src" "$SHIM_ROOT/uploaded-$(basename "$dst")"
        case "$dst" in
          *x64.zip) if [ "$SHIM_MODE" = fail-after-store-x64 ]; then echo 'transport closed' >&2; exit 1; fi ;;
          *arm64.zip) if [ "$SHIM_MODE" = fail-after-store-arm ]; then echo 'transport closed' >&2; exit 1; fi ;;
        esac ;;
      *)
        case "$src" in
          *metadata.json#17) cp "$SHIM_ROOT/seed.json" "$dst" ;;
          *)
            if [ "$SHIM_MODE" = corrupt-readback ]; then printf bad > "$dst"
            else cp "$SHIM_ROOT/uploaded-$(basename "$src")" "$dst"; fi ;;
        esac ;;
    esac
    exit 0 ;;
esac
exit 93
`, { mode: 0o755 })
  return dir
}

function run(args: string[], env: Record<string, string> = {}) {
  const base = { ...process.env }
  for (const name of ['STAGING_PREFIX', 'DRY_RUN', 'DRY_RUN_OUT', 'DRY_RUN_SEED', 'SHIM_MODE', 'SHIM_ROOT']) delete base[name]
  return spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...base, GCS_BUCKET: 's3-autonomous-upgrade-3', ...env } })
}

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

describe.skipIf(process.platform === 'win32')('publish-desktop-windows-staging.sh', () => {
  it('refuses a non-staging prefix, bad version, missing zip, or malformed invocation', () => {
    const root = scratch()
    const x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
    for (const prefix of ['harness', 'harness/desktop', 'harness/stagingx', 'harness/staging/../desktop']) {
      const result = run(['1.2.90', x64, arm64, exe], { STAGING_PREFIX: prefix })
      expect(result.status, prefix).toBe(2)
      expect(result.stderr).toContain('is not harness/staging or a folder under it')
    }
    expect(run(['v1.2.90', x64, arm64, exe]).status).toBe(2)
    expect(run(['1.2.90', x64, arm64]).status).toBe(2)
    expect(run(['1.2.90', x64, arm64, exe, 'extra']).status).toBe(2)
    expect(run(['1.2.90', x64, arm64, exe], { DRY_RUN: 'yes' }).status).toBe(2)
    expect(run(['1.2.90', x64, arm64, exe], { GCS_BUCKET: 'bucket/escape' }).status).toBe(2)
    expect(run(['1.2.90', join(root, 'none.zip'), arm64, exe], { DRY_RUN: '1', DRY_RUN_OUT: join(root, 'out') }).stderr).toContain('is missing')
  })

  it('takes only a harness-install.exe that is a Windows program', () => {
    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64')
    const dry = { DRY_RUN: '1', DRY_RUN_OUT: join(root, 'out') }
    expect(run(['1.2.90', x64, arm64, join(root, 'harness-install.exe')], dry).stderr).toContain('is missing')
    const named = join(root, 'setup.exe')
    writeFileSync(named, 'MZ')
    expect(run(['1.2.90', x64, arm64, named], dry).stderr).toContain('must be named harness-install.exe')
    const text = join(scratch(), 'harness-install.exe')
    writeFileSync(text, 'not a program')
    expect(run(['1.2.90', x64, arm64, text], dry).stderr).toContain('is not a Windows program')
    expect(existsSync(join(root, 'out'))).toBe(false)
  })

  it('requires the exact complete install shape and excludes the first-frame marker', () => {
    const root = scratch(), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
    const dry = { DRY_RUN: '1', DRY_RUN_OUT: join(root, 'out') }
    expect(run(['1.2.90', arm64, arm64, exe], dry).stderr).toContain('must be named harness-desktop-1.2.90-windows-x64.zip')
    for (const needed of ['Harness.exe', 'Harness.ico', 'current', 'app/1.2.90/harness-desktop.exe', 'app/1.2.90/harness_pipe_io.dll']) {
      const other = scratch()
      expect(run(['1.2.90', zip(other, '1.2.90', 'x64', { leave: needed }), arm64, exe], dry).stderr).toContain(`has no ${needed}`)
    }
    const wrong = scratch()
    expect(run(['1.2.90', zip(wrong, '1.2.90', 'x64', { current: '1.2.89' }), arm64, exe], dry).stderr).toContain("says current is '1.2.89'")
    const multiline = scratch()
    expect(run(['1.2.90', zip(multiline, '1.2.90', 'x64', { current: '1.2.90\nother' }), arm64, exe], dry).stderr).toContain('says current is')
    const marked = scratch()
    expect(run(['1.2.90', zip(marked, '1.2.90', 'x64', { marker: true }), arm64, exe], dry).stderr).toContain('inherited .started')
    expect(existsSync(join(root, 'out'))).toBe(false)
  })

  it('writes the three proposed entries and their bytes without any bucket command', () => {
    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
    const out = join(root, 'out')
    const result = run(['1.2.90', x64, arm64, exe], {
      DRY_RUN: '1', DRY_RUN_OUT: out, STAGING_PREFIX: 'harness/staging/test', SHIM_ROOT: root,
      PATH: `${shim(root)}:${process.env.PATH}`,
    })
    expect(result.status, result.stderr).toBe(0)
    const manifest = JSON.parse(readFileSync(join(out, 'metadata.json'), 'utf8'))
    expect(Object.keys(manifest).sort()).toEqual(['desktop-windows-arm64', 'desktop-windows-installer', 'desktop-windows-x64'])
    expect(manifest['desktop-windows-installer']).toEqual({
      version: '1.2.90',
      url: 'https://cdn.autonomous.ai/harness/staging/test/desktop/1.2.90/harness-install.exe',
      sha256: sha(exe), size: readFileSync(exe).length,
    })
    expect(readFileSync(join(out, 'harness-install.exe'))).toEqual(readFileSync(exe))
    expect(manifest['desktop-windows-x64']).toEqual({
      version: '1.2.90',
      url: 'https://cdn.autonomous.ai/harness/staging/test/desktop/1.2.90/harness-desktop-1.2.90-windows-x64.zip',
      sha256: sha(x64), size: readFileSync(x64).length,
    })
    expect(manifest['desktop-windows-arm64'].sha256).toBe(sha(arm64))
    expect(readFileSync(join(out, 'harness-desktop-1.2.90-windows-x64.zip'))).toEqual(readFileSync(x64))
    expect(existsSync(join(root, 'gcloud.log'))).toBe(false)
  })

  it('refuses an existing version before uploading either zip', () => {
    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
    const result = run(['1.2.90', x64, arm64, exe], { SHIM_ROOT: root, SHIM_MODE: 'exists-arm', PATH: `${shim(root)}:${process.env.PATH}` })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('windows-arm64.zip already exists')
    expect(readFileSync(join(root, 'gcloud.log'), 'utf8')).not.toMatch(/storage cp/)
  })

  it('aborts before uploading if object lookup fails for an unknown reason', () => {
    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
    const result = run(['1.2.90', x64, arm64, exe], { SHIM_ROOT: root, SHIM_MODE: 'unknown', PATH: `${shim(root)}:${process.env.PATH}` })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Reauthentication failed')
    expect(readFileSync(join(root, 'gcloud.log'), 'utf8')).not.toMatch(/storage cp/)
  })

  it('aborts before upload if the existing manifest generation cannot be observed', () => {
    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
    const result = run(['1.2.90', x64, arm64, exe], { SHIM_ROOT: root, SHIM_MODE: 'generation-error', PATH: `${shim(root)}:${process.env.PATH}` })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('could not observe the generation')
    expect(readFileSync(join(root, 'gcloud.log'), 'utf8')).not.toMatch(/storage cp/)
  })

  it('uploads three create-only files, verifies their bytes, then merges the observed manifest generation', () => {
    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
    const result = run(['1.2.90', x64, arm64, exe], { SHIM_ROOT: root, PATH: `${shim(root)}:${process.env.PATH}` })
    expect(result.status, result.stderr).toBe(0)
    const log = readFileSync(join(root, 'gcloud.log'), 'utf8').trim().split('\n')
    expect(log.filter((line) => line.includes('storage ls'))).toHaveLength(4)
    expect(log).toContain('storage objects describe gs://s3-autonomous-upgrade-3/harness/staging/desktop/metadata.json --format=value(generation)')
    expect(log.some((line) => line.includes('gs://s3-autonomous-upgrade-3/harness/staging/desktop/metadata.json#17'))).toBe(true)
    const uploads = log.filter((line) => line.includes('storage cp') && line.includes(' --if-generation-match='))
    expect(uploads).toHaveLength(4)
    for (const upload of uploads.slice(0, 3)) expect(upload).toContain('--if-generation-match=0')
    expect(uploads[2]).toContain('gs://s3-autonomous-upgrade-3/harness/staging/desktop/1.2.90/harness-install.exe')
    expect(uploads[3]).toContain('--if-generation-match=17')
    expect(uploads[3]).toContain('--cache-control=no-cache, no-store, must-revalidate')
    const manifest = JSON.parse(readFileSync(join(root, 'uploaded-metadata.json'), 'utf8'))
    expect(Object.keys(manifest).sort()).toEqual(['desktop-macos', 'desktop-windows-arm64', 'desktop-windows-installer', 'desktop-windows-x64'])
    expect(manifest['desktop-windows-x64'].sha256).toBe(sha(x64))
    expect(manifest['desktop-windows-installer'].sha256).toBe(sha(exe))
    expect(readFileSync(join(root, 'uploaded-harness-desktop-1.2.90-windows-arm64.zip'))).toEqual(readFileSync(arm64))
  })

  it('uses generation zero for a confirmed absent manifest', () => {
    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
    const result = run(['1.2.90', x64, arm64, exe], { SHIM_ROOT: root, SHIM_MODE: 'missing-metadata', PATH: `${shim(root)}:${process.env.PATH}` })
    expect(result.status, result.stderr).toBe(0)
    const log = readFileSync(join(root, 'gcloud.log'), 'utf8')
    expect(log).toContain('--if-generation-match=0')
    expect(log).not.toContain('metadata.json#17')
    expect(Object.keys(JSON.parse(readFileSync(join(root, 'uploaded-metadata.json'), 'utf8'))).sort()).toEqual(['desktop-windows-arm64', 'desktop-windows-installer', 'desktop-windows-x64'])
  })

  it('leaves verified objects announced by no manifest when a concurrent metadata writer wins', () => {
    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
    const result = run(['1.2.90', x64, arm64, exe], { SHIM_ROOT: root, SHIM_MODE: 'race', PATH: `${shim(root)}:${process.env.PATH}` })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('metadata changed')
    expect(result.stderr).toContain('new version')
    expect(existsSync(join(root, 'uploaded-metadata.json'))).toBe(false)
    expect(existsSync(join(root, 'uploaded-harness-desktop-1.2.90-windows-x64.zip'))).toBe(true)
    expect(existsSync(join(root, 'uploaded-harness-desktop-1.2.90-windows-arm64.zip'))).toBe(true)
  })

  it('reports a partial object upload without publishing the manifest', () => {
    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
    const result = run(['1.2.90', x64, arm64, exe], { SHIM_ROOT: root, SHIM_MODE: 'fail-arm', PATH: `${shim(root)}:${process.env.PATH}` })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Confirmed prior uploads: x64')
    expect(result.stderr).toContain('arm64 object outcome is unknown')
    expect(result.stderr).toContain('new version')
    expect(existsSync(join(root, 'uploaded-metadata.json'))).toBe(false)
    expect(existsSync(join(root, 'uploaded-harness-desktop-1.2.90-windows-x64.zip'))).toBe(true)
    expect(existsSync(join(root, 'uploaded-harness-desktop-1.2.90-windows-arm64.zip'))).toBe(false)
  })

  it.each([
    ['x64', 'fail-after-store-x64', 'none'],
    ['arm64', 'fail-after-store-arm', 'x64'],
  ])('reports an unknown %s upload result after the fake stores its object', (arch, mode, prior) => {
    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
    const result = run(['1.2.90', x64, arm64, exe], { SHIM_ROOT: root, SHIM_MODE: mode, PATH: `${shim(root)}:${process.env.PATH}` })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`${arch} upload failed`)
    expect(result.stderr).toContain(`${arch} object outcome is unknown`)
    expect(result.stderr).toContain(`Confirmed prior uploads: ${prior}`)
    expect(result.stderr).toContain('Inspect staging and publish a new version')
    expect(existsSync(join(root, 'uploaded-metadata.json'))).toBe(false)
    expect(existsSync(join(root, 'uploaded-harness-desktop-1.2.90-windows-x64.zip'))).toBe(true)
    expect(existsSync(join(root, 'uploaded-harness-desktop-1.2.90-windows-arm64.zip'))).toBe(arch === 'arm64')
  })

  it('does not announce a zip whose served bytes fail the manifest hash', () => {
    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
    const result = run(['1.2.90', x64, arm64, exe], { SHIM_ROOT: root, SHIM_MODE: 'corrupt-readback', PATH: `${shim(root)}:${process.env.PATH}` })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('x64 served bytes differ')
    expect(existsSync(join(root, 'uploaded-metadata.json'))).toBe(false)
  })
})
