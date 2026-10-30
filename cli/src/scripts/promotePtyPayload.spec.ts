// promote-pty-payload.sh against a fake bucket and a fake CDN: gcloud and curl are shims on PATH that read and write a
// temporary folder, so nothing here reaches the real bucket.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = join(process.cwd(), 'scripts', 'promote-pty-payload.sh')
const CDN = 'https://cdn.autonomous.ai'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** A fake bucket (bucket/<object>) and CDN (cdn/<object>), with this version's zips published to staging. */
function world(version = '1.2.3', over: { stagingVersion?: string; corrupt?: boolean; production?: object } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'harness-pty-promote-'))
  dirs.push(root)
  const bucket = join(root, 'bucket'), cdn = join(root, 'cdn'), shim = join(root, 'shim'), log = join(root, 'calls.log')
  for (const dir of [bucket, cdn, shim]) mkdirSync(dir)
  const put = (base: string, object: string, content: string | Buffer) => {
    mkdirSync(dirname(join(base, object)), { recursive: true })
    writeFileSync(join(base, object), content)
  }
  const pty: Record<string, object> = {}
  for (const key of ['win32-x64', 'win32-arm64']) {
    const object = `harness/staging/pty/${version}/harness-pty-${version}-${key}.zip`
    const bytes = Buffer.from(`${key} zip of ${version}`)
    put(cdn, object, over.corrupt && key === 'win32-arm64' ? Buffer.from('other bytes') : bytes)
    pty[key] = { version: over.stagingVersion ?? version, url: `${CDN}/${object}`, sha256: sha(bytes), size: bytes.length }
  }
  put(bucket, 'harness/staging/pty/metadata.json', JSON.stringify({ pty, other: { keep: true } }))
  if (over.production) put(bucket, 'harness/pty/metadata.json', JSON.stringify(over.production))
  // gcloud storage ls <gs://b/o> | cp <gs://b/o> <file> | cp [flags] <file> <gs://b/o>
  writeFileSync(join(shim, 'gcloud'), `#!/bin/bash
echo "gcloud $*" >> '${log}'
[ "$1" = storage ] || exit 9
obj() { echo "$1" | sed -E 's#^gs://[^/]+/##'; }
if [ "$2" = ls ]; then [ -f '${bucket}'/"$(obj "$3")" ] && exit 0; echo "One or more URLs matched no objects." >&2; exit 1; fi
if [ "$2" = cp ]; then
  src="\${@: -2:1}"; dst="\${@: -1}"
  case "$src" in gs://*) cp '${bucket}'/"$(obj "$src")" "$dst"; exit $?;; esac
  mkdir -p "$(dirname '${bucket}'/"$(obj "$dst")")"; cp "$src" '${bucket}'/"$(obj "$dst")"; exit $?
fi
exit 9
`)
  writeFileSync(join(shim, 'curl'), `#!/bin/bash
echo "curl $*" >> '${log}'
out=; url=
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -H|--retry|--max-time) shift 2;; https://*) url="$1"; shift;; *) shift;; esac; done
file='${cdn}'/"\${url#${CDN}/}"
[ -f "$file" ] || { echo "curl: (22) 404" >&2; exit 22; }
cp "$file" "$out"
`)
  for (const name of ['gcloud', 'curl']) chmodSync(join(shim, name), 0o755)
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync('bash', [script, ...args], {
    encoding: 'utf8', env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, GCS_BUCKET: 'test-bucket', ...env },
  })
  const production = () => JSON.parse(readFileSync(join(bucket, 'harness/pty/metadata.json'), 'utf8'))
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8') : ''
  return { root, bucket, pty, run, production, calls, hasProduction: () => existsSync(join(bucket, 'harness/pty/metadata.json')) }
}

const uploads = (calls: string) => calls.split('\n').filter((line) => /^gcloud storage cp .* gs:\/\//.test(line) && !/^gcloud storage cp gs:\/\//.test(line))

describe.skipIf(process.platform === 'win32')('promote-pty-payload.sh', () => {
  it('points the production manifest at the staging zips it checked, keeping every other key there, and uploads no zip', () => {
    const w = world('1.2.3', { production: { pty: { 'win32-x64': { version: '1.2.2' }, 'linux-x64': { keep: 1 } }, extra: 1 } })
    const result = w.run(['1.2.3'])
    expect(result.status, result.stderr).toBe(0)
    expect(w.production()).toEqual({ pty: { ...w.pty, 'linux-x64': { keep: 1 } }, extra: 1 })
    // The manifest is the one thing written, and each zip was fetched to be checked.
    expect(uploads(w.calls())).toEqual([expect.stringMatching(/ gs:\/\/test-bucket\/harness\/pty\/metadata\.json$/)])
    expect(w.calls()).toMatch(/curl .*harness-pty-1\.2\.3-win32-x64\.zip/)
    expect(w.calls()).toMatch(/curl .*harness-pty-1\.2\.3-win32-arm64\.zip/)
    expect(result.stdout).toContain('promoted the pty payload 1.2.3')
  })

  it('makes the production manifest when there is none yet', () => {
    const w = world()
    expect(w.run(['1.2.3']).status).toBe(0)
    expect(w.production()).toEqual({ pty: w.pty })
  })

  it('as a dry run, checks the same and writes the manifest it would publish into DRY_RUN_OUT, and nothing to the bucket', () => {
    const w = world()
    const out = join(w.root, 'out')
    const result = w.run(['1.2.3'], { DRY_RUN: '1', DRY_RUN_OUT: out })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(readFileSync(join(out, 'metadata.json'), 'utf8'))).toEqual({ pty: w.pty })
    expect(uploads(w.calls())).toEqual([])
    expect(w.hasProduction()).toBe(false)
    expect(w.run(['1.2.3'], { DRY_RUN: 'yes' }).status).toBe(2)
  })

  it('promotes nothing when a served zip is not what staging names, or staging holds another version', () => {
    const corrupt = world('1.2.3', { corrupt: true })
    const bad = corrupt.run(['1.2.3'])
    expect(bad.status).toBe(1)
    expect(bad.stderr).toMatch(/harness-pty-1\.2\.3-win32-arm64\.zip serves .* nothing was promoted/)
    expect(corrupt.hasProduction()).toBe(false)
    const older = world('1.2.3', { stagingVersion: '1.2.2' })
    const wrong = older.run(['1.2.3'])
    expect(wrong.status).toBe(1)
    expect(wrong.stderr).toContain('the staging win32-x64 pty entry is 1.2.2, not 1.2.3')
    expect(older.hasProduction()).toBe(false)
    // A version staging never had: its entries name another version.
    expect(world('1.2.3').run(['1.2.4']).status).toBe(1)
  })

  // Re-review N6: nothing stopped a promote from putting an older payload over a newer one in production.
  it('refuses to replace a newer production payload unless --allow-downgrade is given', () => {
    const newer = { version: '1.2.4', url: 'https://cdn.autonomous.ai/harness/staging/pty/1.2.4/x.zip', sha256: 'a'.repeat(64), size: 1 }
    const w = world('1.2.3', { production: { pty: { 'win32-arm64': newer } } })
    const refused = w.run(['1.2.3'])
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('production has the win32-arm64 pty payload 1.2.4, newer than 1.2.3; to go back to 1.2.3, run again with --allow-downgrade. Nothing was promoted.')
    expect(w.production().pty['win32-arm64']).toEqual(newer)
    const allowed = w.run(['--allow-downgrade', '1.2.3'])
    expect(allowed.status, allowed.stderr).toBe(0)
    expect(w.production().pty).toEqual(w.pty)
    // The same version again, or a newer one, needs no flag.
    expect(w.run(['1.2.3']).status).toBe(0)
    expect(w.run(['--bogus', '1.2.3']).status).toBe(2)
  })

  it('refuses a prerelease, a manifest that is not a pty manifest, and promoting a manifest into itself', () => {
    const w = world()
    expect(w.run(['1.2.3-dev.win1']).status).toBe(2)
    expect(w.run([]).status).toBe(2)
    expect(w.run(['1.2.3', 'extra']).status).toBe(2)
    for (const path of ['harness/cli/metadata.json', 'harness/runtime/metadata.json', 'harness/pty/../cli/metadata.json']) {
      const refused = w.run(['1.2.3'], { METADATA_PATH: path })
      expect(refused.status, path).toBe(2)
      expect(refused.stderr).toContain('is not a pty manifest')
    }
    expect(w.run(['1.2.3'], { STAGING_METADATA_PATH: 'harness/cli/metadata.json' }).status).toBe(2)
    expect(w.run(['1.2.3'], { METADATA_PATH: 'harness/staging/pty/metadata.json' }).stderr).toContain('are the same')
    expect(w.calls()).toBe('')
  })

  it('refuses when there is no staging manifest, and aborts on a lookup that fails for another reason', () => {
    const w = world()
    rmSync(join(w.bucket, 'harness/staging/pty/metadata.json'))
    const none = w.run(['1.2.3'])
    expect(none.status).toBe(1)
    expect(none.stderr).toContain('there is no staging manifest')
    const shim = join(w.root, 'shim', 'gcloud')
    writeFileSync(shim, '#!/bin/sh\necho "ERROR: Reauthentication failed" >&2\nexit 1\n')
    const auth = w.run(['1.2.3'])
    expect(auth.status).toBe(1)
    expect(auth.stderr).toContain('Reauthentication failed')
    expect(w.hasProduction()).toBe(false)
  })
})
