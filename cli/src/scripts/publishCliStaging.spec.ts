import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// The happy path needs a real bundle (the script runs upload-cli.sh's bundle checks on it), so it is the staging
// dry run's to show; these cover every refusal, which all come before the bundle is looked at.
const script = join(process.cwd(), 'scripts', 'publish-cli-staging.sh')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'harness-cli-staging-'))
  dirs.push(root)
  return root
}

/** A gcloud on PATH that logs its arguments and answers `ls` with [ls] (a shell snippet). */
function shim(root: string, ls: string) {
  const dir = join(root, 'shim')
  mkdirSync(dir)
  writeFileSync(join(dir, 'gcloud'), `#!/bin/sh\necho "$@" >> '${join(root, 'gcloud.log')}'\nif [ "$2" = ls ]; then ${ls}; fi\nexit 0\n`, { mode: 0o755 })
  return dir
}

const run = (args: string[], env: Record<string, string> = {}) => {
  const base = { ...process.env }
  delete base.STAGING_PREFIX
  delete base.CLI_DIST_DIR
  return spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...base, GCS_BUCKET: 's3-autonomous-upgrade-3', ...env } })
}

describe.skipIf(process.platform === 'win32')('publish-cli-staging.sh', () => {
  it('refuses a prefix that is not under harness/staging/, before anything else', () => {
    for (const prefix of ['harness', 'harness/cli', 'harness/stagingx', 'harness/staging/../cli', 'other/staging']) {
      const result = run(['0.4.18-dev.win1', '--no-build'], { STAGING_PREFIX: prefix })
      expect(result.status, prefix).toBe(2)
      expect(result.stderr).toContain('is not harness/staging or a folder under it')
    }
  })

  it('refuses a version that is not X.Y.Z[-prerelease], an unknown argument, and a DRY_RUN that is not 0 or 1', () => {
    expect(run(['v0.4.18', '--no-build']).status).toBe(2)
    expect(run(['0.4.18-dev..x', '--no-build']).status).toBe(2)
    expect(run([]).status).toBe(2)
    expect(run(['0.4.18-dev.win1', '--production']).status).toBe(2)
    expect(run(['0.4.18-dev.win1', '--no-build'], { DRY_RUN: 'yes' }).status).toBe(2)
  })

  it('refuses a version that is already there, before the bundle and without uploading', () => {
    const root = scratch()
    const path = `${shim(root, 'case "$3" in */notify.mjs) exit 0;; *) echo "One or more URLs matched no objects" >&2; exit 1;; esac')}:${process.env.PATH}`
    const result = run(['0.4.18-dev.win1', '--no-build'], { PATH: path, CLI_DIST_DIR: join(root, 'none') })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('gs://s3-autonomous-upgrade-3/harness/staging/cli/0.4.18-dev.win1/notify.mjs already exists')
    const log = readFileSync(join(root, 'gcloud.log'), 'utf8')
    expect(log).toContain('storage ls gs://s3-autonomous-upgrade-3/harness/staging/cli/0.4.18-dev.win1/cli.js')
    expect(log).not.toMatch(/ cp /)
  })

  it('aborts, uploading nothing, when gcloud fails for a reason other than not found', () => {
    const root = scratch()
    const path = `${shim(root, 'echo "ERROR: Reauthentication failed" >&2; exit 1')}:${process.env.PATH}`
    const result = run(['0.4.18-dev.win1', '--no-build'], { PATH: path })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Reauthentication failed')
    expect(readFileSync(join(root, 'gcloud.log'), 'utf8')).not.toMatch(/ cp /)
  })

  it('stops on a missing bundle with --no-build, and never builds into it', () => {
    const root = scratch()
    const result = run(['0.4.18-dev.win1', '--no-build'], { DRY_RUN: '1', DRY_RUN_OUT: join(root, 'out'), CLI_DIST_DIR: join(root, 'dist') })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('is missing')
    expect(existsSync(join(root, 'dist'))).toBe(false)
    expect(existsSync(join(root, 'out'))).toBe(false)
  })
})
