import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const checkInstall = readFileSync(join(process.cwd(), 'scripts', 'windows-ci', 'check-install.ps1'), 'utf8')

describe('check-install.ps1', () => {
  // The VM end to end (task B5.14) found it: with ONE harness-pty.exe on the machine, `$hosts = Processes …` held a
  // single CimInstance, because PowerShell unrolls a function's array output. Windows PowerShell 5.1 gives a
  // CimInstance no `.Count`, so `if ($hosts.Count)` stayed false for the whole 30 s and the check printed "no
  // harness-pty.exe runs after creating a terminal" with the host running. It passed in B5.12 only because other
  // users' hosts were on that VM too. Every caller keeps the result an array with @( … ).
  it('keeps every Processes result an array, so one process still counts', () => {
    const calls = [...checkInstall.matchAll(/^.*\bProcesses\s+["'].*$/gm)].map(([line]) => line)
    expect(calls.length).toBeGreaterThan(0)
    for (const line of calls) expect(line, line).toMatch(/@\(\s*Processes\s/)
  })

  it.runIf(process.platform === 'win32')('counts one process as one under Windows PowerShell', () => {
    const fn = checkInstall.match(/^function Processes[\s\S]*?^}\n/m)?.[0]
    expect(fn).toBeTruthy()
    const script = `function Fail([string]$m) { Write-Output "FAIL $m"; exit 1 }\n${fn}\n$one = @(Processes "ProcessId=${process.pid}")\nWrite-Output $one.Count`
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim()
    expect(out).toBe('1')
  })
})
