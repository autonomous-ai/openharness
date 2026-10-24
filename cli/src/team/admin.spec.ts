import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GuestRunner } from '../lib/guestAccounts.js'
import { adminRunner } from './admin.js'

const cleanup: string[] = []
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture(answer: { code: number | null; stdout?: string; stderr?: string }) {
  const parent = mkdtempSync(join(tmpdir(), 'team-admin-'))
  cleanup.push(parent)
  const stage = join(parent, 'stage')
  const seen: { script?: string; files: Record<string, { text: string; mode: number }> } = { files: {} }
  // Never osascript: the fake reads what was staged, as root would, and answers.
  const runner = vi.fn<GuestRunner>(async (_command, args) => {
    const path = /quoted form of "([^"]+)"/.exec(args[1]!)![1]!
    seen.script = readFileSync(path, 'utf8')
    for (const name of ['team.json', 'team.plist']) {
      const file = join(stage, name)
      if (existsSync(file)) seen.files[name] = { text: readFileSync(file, 'utf8'), mode: statSync(file).mode & 0o777 }
    }
    return { code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
  })
  const run = adminRunner({ runner, makeStage: () => { mkdirSync(stage); return stage } })
  return { run, runner, stage, seen }
}

describe('adminRunner', () => {
  it('stages the script and its files privately, runs it behind the administrator prompt, and removes the stage', async () => {
    const f = fixture({ code: 0, stdout: 'harness: done\n' })
    const result = await f.run((dir) => ({ script: `#!/bin/sh\necho ${dir}\n`, files: { 'team.json': '{}', 'team.plist': '<plist/>' } }), 'Harness wants "this".')
    expect(result).toEqual({ ok: true, stdout: 'harness: done\n' })
    expect(f.runner).toHaveBeenCalledTimes(1)
    const [command, args] = f.runner.mock.calls[0]!
    expect(command).toBe('osascript')
    expect(args[0]).toBe('-e')
    expect(args[1]).toContain('with administrator privileges')
    expect(args[1]).toContain('with prompt "Harness wants \\"this\\"."')
    expect(f.seen.script).toBe(`#!/bin/sh\necho ${f.stage}\n`)
    expect(f.seen.files['team.json']).toEqual({ text: '{}', mode: 0o600 })
    expect(existsSync(f.stage)).toBe(false)
  })

  it('tells a cancelled prompt from a script that stopped, in the script\'s own words', async () => {
    expect(await fixture({ code: 1, stderr: '0:180: execution error: User canceled. (-128)' }).run(() => ({ script: '' }), 'p'))
      .toEqual({ ok: false, code: 'CANCELLED', message: 'The administrator prompt was cancelled.' })
    expect(await fixture({ code: 1, stderr: '0:180: execution error: harness: launchd would not start the team daemon (8)' }).run(() => ({ script: '' }), 'p'))
      .toEqual({ ok: false, code: 'FAILED', message: 'launchd would not start the team daemon' })
    expect(await fixture({ code: 2, stderr: '' }).run(() => ({ script: '' }), 'p'))
      .toEqual({ ok: false, code: 'FAILED', message: 'The script stopped (exit 2).' })
  })

  it('removes the stage when building the script throws', async () => {
    const f = fixture({ code: 0 })
    await expect(f.run(() => { throw new Error('bad input') }, 'p')).rejects.toThrow('bad input')
    expect(existsSync(f.stage)).toBe(false)
    expect(f.runner).not.toHaveBeenCalled()
  })
})
