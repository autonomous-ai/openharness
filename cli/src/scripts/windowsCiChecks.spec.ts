import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const checkInstall = readFileSync(join(process.cwd(), 'scripts', 'windows-ci', 'check-install.ps1'), 'utf8')
const windowsYml = readFileSync(join(process.cwd(), '..', '.github', 'workflows', 'windows.yml'), 'utf8')
const diagnosis = checkInstall.match(/^function Show-Diagnosis[\s\S]*?^}\n/m)?.[0] ?? ''

// Most cases here read the scripts as text: Linux CI has no PowerShell to run them. The `win32` cases run the real
// PowerShell, on the Windows jobs (windows.yml) and on the VM; the VM end to end (B5.14) ran the whole scripts.
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

  // The VM end to end (task B5.14) again: with a second Windows user's Harness running, the check printed "ok terminal …
  // on harness-pty pid 5028", the OTHER user's host, and counted that host's shell too. WMI lists every user's
  // processes by name, so the check would pass with this install's host missing. It now counts only hosts that run
  // from this install's own folder.
  it('counts only the terminal hosts that run from this install', () => {
    const hosts = checkInstall.split('\n').find((line) => /\$hosts = @\(Processes/.test(line)) ?? ''
    expect(hosts).toMatch(/ExecutablePath/)
    expect(hosts).toContain('StartsWith("$root\\"')
  })

  it.runIf(process.platform === 'win32')('counts one process as one under Windows PowerShell', () => {
    const fn = checkInstall.match(/^function Processes[\s\S]*?^}\n/m)?.[0]
    expect(fn).toBeTruthy()
    const script = `function Fail([string]$m) { Write-Output "FAIL $m"; exit 1 }\n${fn}\n$one = @(Processes "ProcessId=${process.pid}")\nWrite-Output $one.Count`
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim()
    expect(out).toBe('1')
  })

  // Final review R1b-1: a task runs at Task Scheduler's priority 7, below normal, unless it says otherwise, and the
  // daemon and every agent inherit it. The install job proves the class of what the install started.
  it('checks that the daemon, the terminal host and its shells run at normal priority', () => {
    const at = checkInstall.indexOf('$slow = @($mine')
    expect(at).toBeGreaterThan(checkInstall.indexOf('$shells = @(Processes'))
    expect(checkInstall).toContain("Get-Process -Name 'harness-pty', 'node'")
    expect(checkInstall).toContain('@($hosts.ProcessId) + @($shells.ProcessId)')
    expect(checkInstall.slice(at)).toMatch(/PriorityClass\)" -ne 'Normal'/)
    expect(checkInstall).toMatch(/Fail "no node\.exe from \$root runs/)
    // And the task as Task Scheduler registered it, whether or not the task started the daemon on this runner.
    expect(checkInstall).toContain("-notmatch '<Priority>4</Priority>'")
  })

  it('stays ASCII, which Windows PowerShell reads a .ps1 without a BOM in', () => {
    expect(checkInstall).toMatch(/^[\x00-\x7f]*$/)
  })

  // Run 39083518767 failed with "no harness-pty.exe runs" and nothing else: its log artifact was empty, so it could not
  // say whether the host never started or ran uncounted. Every FAIL now prints the evidence first.
  describe('on a FAIL', () => {
    it('prints the diagnosis before it exits', () => {
      expect(checkInstall).toMatch(/^function Fail\(\[string\]\$message\) \{ Write-Host "FAIL \$message"; Show-Diagnosis; exit 1 \}$/m)
      expect(checkInstall.indexOf('function Show-Diagnosis')).toBeLessThan(checkInstall.indexOf('function Fail'))
    })

    it('never fails from inside the diagnosis: no Fail, no Processes (whose WMI failure calls Fail), no exit', () => {
      expect(diagnosis).toBeTruthy()
      expect(diagnosis).not.toMatch(/\bFail\b|\bProcesses\b|\bexit\b/)
      expect(diagnosis).toContain("$ErrorActionPreference = 'Continue'")
    })

    it('shows the status, the local API, the processes, the host and every log tail', () => {
      expect(diagnosis).toContain('& $harness status')
      expect(diagnosis).toContain('/api/status')
      expect(diagnosis).toContain('discoveryError')
      expect(diagnosis).toContain("Get-Process -Name 'harness*'")
      expect(diagnosis).toContain('current-pty')
      for (const tree of ["'cli\\data'", "'pty\\logs'", "'logs'"]) expect(diagnosis).toContain(tree)
      expect(diagnosis).toContain('-Tail 80')
    })

    it('never prints the host\'s token from its discovery file', () => {
      const read = diagnosis.split('\n').filter((line) => line.includes('pty-host-') || line.includes('ConvertFrom-Json'))
      expect(read.join('\n')).toContain('ConvertFrom-Json | Select-Object protocol, pid, version, endpoint |')
      expect(diagnosis).not.toMatch(/\.token\b|Select-Object[^|]*\btoken\b/)
    })

    it('asks only the local API that status names', () => {
      expect(diagnosis).not.toContain('18473')
    })

    it.runIf(process.platform === 'win32')('runs to its end with nothing installed, under Windows PowerShell', () => {
      const home = mkdtempSync(join(tmpdir(), 'check-install-'))
      try {
        const script = `$root = '${home}'\n$harness = '${join(home, 'bin', 'harness.exe')}'\n${diagnosis}\nShow-Diagnosis\nWrite-Output 'diagnosis done'`
        const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
        expect(out).toContain('diagnosis done')
        expect(out).toContain('harness status names no local api')
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }, 30_000)
  })
})

describe('the install job', () => {
  // Every tree it keeps is under a dot folder (.harness, .local), which upload-artifact v4 takes for hidden and leaves
  // out by default: run 39083518767 copied the logs and uploaded "No files were found".
  it('uploads the logs it kept, dot folders and all', () => {
    const keep = windowsYml.match(/- name: Keep the logs[\s\S]*?\n {6}- /)?.[0] ?? ''
    expect(keep).toContain("'.harness\\cli\\data'")
    // \r?: a Windows checkout may have the workflow in CRLF (core.autocrlf; .gitattributes pins only .ps1 and .cmd).
    const upload = windowsYml.match(/- uses: actions\/upload-artifact@v4\r?\n(?: {8}[^\n]*\n)+/g)?.find((step) => step.includes('install-logs-')) ?? ''
    expect(upload).toContain('include-hidden-files: true')
  })

  it('runs these checks on Windows, where the PowerShell ones run at all', () => {
    expect(windowsYml).toContain("'src/scripts/windowsCiChecks.spec.ts'")
  })
})
