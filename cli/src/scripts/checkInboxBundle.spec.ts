import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// check-inbox-bundle.mjs runs before a release is uploaded (upload-cli.sh): inbox.mjs, which harness.exe runs on its
// own, must answer a refused id {"off":true} and exit 0. The shebang and lean-bundle checks cover cli.js only (Ken's
// review of #4681). These run it on a fake inbox.mjs.
const script = join(process.cwd(), 'scripts', 'check-inbox-bundle.mjs')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** A fake inbox.mjs whose code is [body], in a folder of its own, with [record] a file beside it it may write. */
function fake(body: (record: string) => string) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-inbox-check-'))
  dirs.push(dir)
  const record = join(dir, 'record.json')
  writeFileSync(join(dir, 'inbox.mjs'), body(record))
  return { inbox: join(dir, 'inbox.mjs'), record }
}

const check = (inbox: string) => spawnSync(process.execPath, [script, inbox], { encoding: 'utf8', timeout: 30_000 })

describe('check-inbox-bundle.mjs', () => {
  it('passes a follower that answers a refused id {"off":true} and exits 0, run in a throwaway home it then removes', () => {
    const { inbox, record } = fake((file) => [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(file)}, JSON.stringify({ argv: process.argv.slice(2), home: process.env.HOME, data: process.env.ADAPTER_DATA_DIR }))`,
      "console.log('{\"off\":true}')",
      '',
    ].join('\n'))
    const run = check(inbox)
    expect(run.status, run.stderr).toBe(0)
    const seen = JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; home: string; data: string }
    expect(seen.argv).toEqual(['device', 'claude', 'inbox', 'not-a-session-id'])
    expect(seen.home).not.toBe(homedir())
    expect(dirname(seen.data)).toBe(dirname(seen.home))
    expect(existsSync(dirname(seen.home))).toBe(false)
  })

  it('refuses another answer, naming the check and not what the follower printed', () => {
    const run = check(fake(() => "console.log('private words')\n").inbox)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain("the inbox follower's check (device claude inbox not-a-session-id) did not answer {\"off\":true}")
    expect(run.stderr).not.toContain('private words')
  })

  it('refuses a follower that answers {"off":true} but exits with another status', () => {
    const run = check(fake(() => "console.log('{\"off\":true}'); process.exitCode = 3\n").inbox)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain("the inbox follower's check (device claude inbox not-a-session-id) exited 3")
  })

  it('refuses a follower that gives no answer in 15 s, the canary\'s bound', { timeout: 30_000 }, () => {
    const run = check(fake(() => 'setInterval(() => {}, 1000)\n').inbox)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain("the inbox follower's check (device claude inbox not-a-session-id) gave no answer in 15 s")
  })

  it('is run by upload-cli.sh on dist/inbox.mjs after the bundle and before anything is uploaded', () => {
    const upload = readFileSync(join(process.cwd(), 'scripts', 'upload-cli.sh'), 'utf8')
    const at = upload.indexOf('node "$ADAPTER_DIR/scripts/check-inbox-bundle.mjs" "$INBOX"')
    expect(at).toBeGreaterThan(upload.indexOf('[ -f "$INBOX" ]'))
    expect(at).toBeLessThan(upload.indexOf('gcs_refuse_republish "gs://'))
  })
})
