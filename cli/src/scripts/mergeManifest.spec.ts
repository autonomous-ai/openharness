import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// merge-manifest.mjs writes the `cli` entry of the release manifest for upload-cli.sh and fake-cdn.sh
// (docs/plans/2026-11-27-windows-follower-ram-design.md section 4).
const script = join(process.cwd(), 'scripts', 'merge-manifest.mjs')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const base = [
  'cli', '1.2.3',
  'https://cdn.example/harness/cli/1.2.3/cli.js', 'a'.repeat(64), '2100000',
  'https://cdn.example/harness/cli/1.2.3/notify.mjs', 'b'.repeat(64), '5000',
]
const inbox = ['https://cdn.example/harness/cli/1.2.3/inbox.mjs', 'c'.repeat(64), '99000']
const cliEntry = {
  version: '1.2.3',
  cli: { url: 'https://cdn.example/harness/cli/1.2.3/cli.js', sha256: 'a'.repeat(64), size: 2100000 },
  notify: { url: 'https://cdn.example/harness/cli/1.2.3/notify.mjs', sha256: 'b'.repeat(64), size: 5000 },
}

function merge(existing: string, args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-merge-manifest-'))
  dirs.push(dir)
  const src = join(dir, 'src.json')
  const dst = join(dir, 'dst.json')
  writeFileSync(src, existing)
  const run = spawnSync(process.execPath, [script, src, dst, ...args], { encoding: 'utf8' })
  return { run, dst }
}

describe('merge-manifest.mjs', () => {
  it('writes inbox beside cli and notify when given its url, sha256 and size', () => {
    const { run, dst } = merge('{}', [...base, ...inbox])
    expect(run.status, run.stderr).toBe(0)
    expect(JSON.parse(readFileSync(dst, 'utf8'))).toEqual({
      cli: { ...cliEntry, inbox: { url: inbox[0], sha256: inbox[1], size: 99000 } },
    })
  })

  it('writes no inbox without those arguments, as before', () => {
    const { run, dst } = merge('{}', base)
    expect(run.status, run.stderr).toBe(0)
    expect(JSON.parse(readFileSync(dst, 'utf8'))).toEqual({ cli: cliEntry })
  })

  it('keeps every other key of the manifest', () => {
    const commander = { version: '9.9.9', url: 'https://cdn.example/commander.bin' }
    const old = { version: '1.2.2', cli: { url: 'old', sha256: 'old', size: 1 }, inbox: { url: 'old', sha256: 'old', size: 1 } }
    const { run, dst } = merge(JSON.stringify({ commander, cli: old }), base)
    expect(run.status, run.stderr).toBe(0)
    expect(JSON.parse(readFileSync(dst, 'utf8'))).toEqual({ commander, cli: cliEntry })
  })

  it('refuses one or two of the inbox arguments, and writes nothing', () => {
    for (const extra of [inbox.slice(0, 1), inbox.slice(0, 2)]) {
      const { run, dst } = merge('{}', [...base, ...extra])
      expect(run.status).toBe(2)
      expect(run.stderr).toMatch(/^usage: merge-manifest\.mjs /)
      expect(existsSync(dst)).toBe(false)
    }
  })
})
