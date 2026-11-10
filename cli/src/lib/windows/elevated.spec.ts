import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GuestRunner } from '../guestAccounts.js'
import { windowsAdminRunner } from './elevated.js'

const cleanup: string[] = []
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('windowsAdminRunner', () => {
  const OWNER_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
  function windows(answer: { code: number | null; stdout?: string; stderr?: string }, icacls = 0, encoding: BufferEncoding = 'utf8',
    whoami = `"desktop\\owner-placeholder","${OWNER_SID}"\r\n`) {
    const parent = mkdtempSync(join(tmpdir(), 'harness-admin-'))
    cleanup.push(parent)
    const stage = join(parent, 'stage')
    const seen: { script?: string; wrapper?: string } = {}
    // Never powershell, icacls or whoami: the fake reads what was staged, as the elevated script would, and writes what it said.
    const runner = vi.fn<GuestRunner>(async (command) => {
      if (command === 'whoami') return { code: whoami ? 0 : 1, stdout: whoami, stderr: '' }
      if (command === 'icacls') return { code: icacls, stdout: '', stderr: icacls ? 'Access is denied.' : '' }
      seen.script = readFileSync(join(stage, 'run.ps1'), 'utf8')
      seen.wrapper = readFileSync(join(stage, 'elevated.ps1'), 'utf8')
      if (answer.stdout !== undefined) writeFileSync(join(stage, 'stdout.txt'), answer.stdout)
      if (answer.stderr !== undefined) writeFileSync(join(stage, 'stderr.txt'), answer.stderr, encoding)
      return { code: answer.code, stdout: '', stderr: '' }
    })
    const run = windowsAdminRunner({ runner, makeStage: () => { mkdirSync(stage); return stage } })
    return { run, runner, stage, seen }
  }
  const decoded = (args: readonly string[]) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1]!, 'base64').toString('utf16le')
  const callOf = (f: { runner: { mock: { calls: Parameters<GuestRunner>[] } } }, name: string) => f.runner.mock.calls.find(([command]) => command === name)!

  it('makes the staging folder the owner\'s alone, by SID, before anything is written in it', async () => {
    const f = windows({ code: 0, stdout: '' })
    await f.run(() => ({ script: 'exit 0' }), 'p')
    expect(f.runner.mock.calls.map(([command]) => command)).toEqual(['whoami', 'icacls', 'powershell.exe'])
    expect(callOf(f, 'whoami')[1]).toEqual(['/user', '/fo', 'csv', '/nh'])
    // The owner, SYSTEM and Administrators, each by SID: a name could resolve to a same-named domain or local account,
    // and SYSTEM's and Administrators' change with the language of Windows. Nothing inherited.
    expect(callOf(f, 'icacls')[1]).toEqual([f.stage, '/inheritance:r', '/grant:r', `*${OWNER_SID}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'])
  })

  it('runs nothing when it cannot tell the owner\'s SID', async () => {
    const f = windows({ code: 0 }, 0, 'utf8', '')
    expect(await f.run(() => ({ script: '' }), 'p')).toEqual({ ok: false, code: 'FAILED', message: 'Could not read this account\'s SID (whoami /user).' })
    expect(f.runner.mock.calls.map(([command]) => command)).toEqual(['whoami'])
    expect(existsSync(f.stage)).toBe(false)
  })

  it('keeps what the script wrote to its own stdout and stderr: run.ps1 runs as a child whose output goes to the files', async () => {
    const f = windows({ code: 0, stdout: '' })
    await f.run(() => ({ script: 'exit 0' }), 'p')
    // `& run.ps1 1> out 2> err` in the same process keeps PowerShell's streams only, and the scripts write through
    // [Console]: every failure read "The script stopped (exit N)".
    expect(f.seen.wrapper).not.toContain('1> $out')
    expect(f.seen.wrapper).toContain("$ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'")
    expect(f.seen.wrapper).toContain("-ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', \"`\"$run`\"\")")
    expect(f.seen.wrapper).toContain('-NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err')
    expect(f.seen.wrapper).toContain('exit $p.ExitCode')
  })

  it('runs run.ps1 elevated through User Account Control, and hands back what it said', async () => {
    const f = windows({ code: 0, stdout: 'harness: team computer abc\r\n' })
    expect(await f.run((dir) => ({ script: `Write-Output '${dir}'`, files: { 'team.json': '{}' } }), 'p'))
      .toEqual({ ok: true, stdout: 'harness: team computer abc\r\n' })
    const [command, args] = callOf(f, 'powershell.exe')
    expect(command).toBe('powershell.exe')
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    const outer = decoded(args)
    expect(outer).toContain('Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru')
    expect(outer).toContain(`'-NoProfile -ExecutionPolicy Bypass -File "${join(f.stage, 'elevated.ps1')}"'`)
    // With a byte order mark, which Windows PowerShell 5.1 needs to read anything but ASCII as UTF-8.
    expect(f.seen.script).toBe(`﻿Write-Output '${f.stage}'`)
    expect(f.seen.wrapper).toContain("Join-Path $PSScriptRoot 'run.ps1'")
    expect(existsSync(f.stage)).toBe(false)
  })

  it('reads 1223 as a cancelled prompt, and keeps the script\'s own reason and status', async () => {
    expect(await windows({ code: 1223 }).run(() => ({ script: '' }), 'p'))
      .toEqual({ ok: false, code: 'CANCELLED', message: 'The administrator prompt was cancelled.' })
    expect(await windows({ code: 4, stderr: 'harness: an account named harnessteam already exists\r\n' }).run(() => ({ script: '' }), 'p'))
      .toEqual({ ok: false, code: 'FAILED', status: 4, message: 'an account named harnessteam already exists' })
    expect(await windows({ code: 2 }).run(() => ({ script: '' }), 'p'))
      .toEqual({ ok: false, code: 'FAILED', status: 2, message: 'The script stopped (exit 2).' })
    // As Windows PowerShell 5.1 writes a redirection it was not told the encoding of: UTF-16 with its byte order mark.
    const utf16 = `﻿${'harness: could not make the account\r\n'}`
    expect(await windows({ code: 5, stderr: Buffer.from(utf16, 'utf16le').toString('latin1') }, 0, 'latin1').run(() => ({ script: '' }), 'p'))
      .toEqual({ ok: false, code: 'FAILED', status: 5, message: 'could not make the account' })
  })

  it('runs nothing when the staging folder cannot be made private', async () => {
    const f = windows({ code: 0 }, 5)
    expect(await f.run(() => ({ script: '' }), 'p')).toEqual({ ok: false, code: 'FAILED',
      message: 'Could not make the staging folder private: Access is denied.' })
    expect(f.runner.mock.calls.map(([command]) => command)).toEqual(['whoami', 'icacls'])
    expect(existsSync(f.stage)).toBe(false)
  })

  it('removes the stage when building the script throws', async () => {
    const f = windows({ code: 0 })
    await expect(f.run(() => { throw new Error('bad input') }, 'p')).rejects.toThrow('bad input')
    expect(existsSync(f.stage)).toBe(false)
    expect(f.runner.mock.calls.map(([command]) => command)).toEqual(['whoami', 'icacls'])
  })
})
