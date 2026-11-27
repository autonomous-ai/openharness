/**
 * inbox.mjs, the Windows follower's own file in a release (inboxEntry.ts), as the build writes it beside cli.js: small,
 * none of the whole CLI in it, and the contract harness.exe, the updaters' canary and install.ps1 rely on: a refused id,
 * or any line that is not the follower's, prints {"off":true} and exits 0 (docs/plans/2026-11-27-windows-follower-ram-design.md).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const CLI_ROOT = fileURLToPath(new URL('..', import.meta.url))
const VERSION = '9.8.7-inbox.1'
/** What Node needs on Windows to find its temporary folder; nothing on a Mac or Linux (as entry.spec.ts). */
const WINDOWS_ENV = Object.fromEntries(['TEMP', 'TMP', 'SystemRoot'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []))
const SESSION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

describe('inbox.mjs, built beside cli.js', () => {
  let scratch = ''
  let inbox = ''
  let cli = ''
  const homes: string[] = []
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'inbox-entry-'))
    execFileSync(process.execPath, ['build-bundle.mjs'], {
      cwd: CLI_ROOT, env: { ...process.env, BUNDLE_OUT_DIR: join(scratch, 'build'), ADAPTER_VERSION: VERSION }, stdio: 'pipe',
    })
    inbox = join(scratch, 'build', 'inbox.mjs')
    cli = readFileSync(join(scratch, 'build', 'cli.js'), 'utf8')
    // The whole release build: under a minute alone, about 4 minutes on a shared Mac at load 600 (2026-11-27).
  }, 600_000)
  afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })
  afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

  /** `node inbox.mjs [args]` on a temp home of its own, with nothing of this machine's environment but PATH. */
  function follow(args: string[]): { status: number | null, stdout: string, stderr: string, home: string } {
    const home = mkdtempSync(join(tmpdir(), 'inbox-home-')); homes.push(home)
    const run = spawnSync(process.execPath, [inbox, ...args], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
      env: {
        ...WINDOWS_ENV, PATH: process.env.PATH, HOME: home, USERPROFILE: home,
        ADAPTER_DATA_DIR: join(home, 'data'), CLAUDE_CONFIG_DIR: join(home, 'claude'),
      },
    })
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, home }
  }

  it('is a file of its own, under 200 KB, with the release banner and none of the whole CLI', () => {
    const bytes = readFileSync(inbox)
    expect(bytes.length).toBeLessThan(200_000)
    expect(bytes.toString('utf8').split('\n')[0].startsWith(`/*! harness v${VERSION} `)).toBe(true)
    expect(bytes.findIndex((byte) => byte > 0x7f)).toBe(-1)
    const code = bytes.toString('utf8')
    for (const marker of [
      'Updating would replace it with a published release', // cli.ts
      '[runtime-profile] connect reconcile failed', // core/main.ts
    ]) {
      expect(cli.includes(marker), `cli.js holds ${marker}`).toBe(true)
      expect(code.includes(marker), `inbox.mjs holds ${marker}`).toBe(false)
    }
  })

  it('follows on its own: a refused id prints {"off":true}, exits 0, and leaves its home as it was', () => {
    const run = follow(['device', 'claude', 'inbox', 'not-a-session-id'])
    expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 0, stdout: '{"off":true}\n', stderr: '' })
    expect(readdirSync(run.home)).toEqual([])
  }, 60_000)

  it.each([
    [[]],
    [['version']],
    [['device']],
    [['device', 'claude', 'attach', 'x']],
    [['device', 'claude', 'inbox', SESSION, 'extra']],
    [['claude', 'inbox', SESSION]],
  ])('answers any other line {"off":true} and exits 0: %j', (args) => {
    const run = follow(args)
    expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 0, stdout: '{"off":true}\n', stderr: '' })
  }, 60_000)
})
