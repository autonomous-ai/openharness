import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { endTree, windowsPowerShell } from './windowsPowerShell.js'

const session = windowsPowerShell()
const scratch = mkdtempSync(join(tmpdir(), 'harness-ps-session-'))
afterAll(async () => {
  try {
    await session.close()
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

// On any platform: installPs1.spec.ts closes its session in an afterAll that also runs where no case started one.
it('closes a session that never ran a call', async () => {
  await expect(windowsPowerShell().close()).resolves.toBeUndefined()
})

// On any platform: a host that outlived the end of its tree would otherwise hang the call, the queue behind it, or the
// close, with no word of why.
it('stops waiting for a host 3 s after its tree was ended, and names it', async () => {
  vi.useFakeTimers()
  try {
    const left = endTree({ pid: undefined, exited: new Promise(() => undefined) })
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(left).resolves.toBe('host undefined is still running 3 s after its tree was ended')
    await expect(endTree({ pid: undefined, exited: Promise.resolve(0) })).resolves.toBe('')
  } finally {
    vi.useRealTimers()
  }
})

// With room: the first module command a host runs costs about 22 s on windows-11-arm. The three cases that start a host
// of their own come last and run no module command on it, so the file pays that once.
describe.runIf(process.platform === 'win32')('one Windows PowerShell 5.1 for a spec file', { timeout: 120_000 }, () => {
  it('runs every call in one powershell.exe, one at a time, in the order asked', async () => {
    const order = join(scratch, 'order.txt')
    const runs = await Promise.all(['a', 'b', 'c'].map((name) => session.run(`[IO.File]::AppendAllText('${order}', '${name}'); $PID`)))
    expect(Number(runs[0].stdout)).toBeGreaterThan(0)
    expect(new Set(runs.map((run) => run.stdout)).size).toBe(1)
    expect(readFileSync(order, 'utf8')).toBe('abc')
  })

  it('gives each call a runspace of its own: no function, variable or imported module of the call before', async () => {
    const security = String.raw`Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')`
    const seen = '"$([bool](Get-Command Get-HarnessLeft -ErrorAction SilentlyContinue))|$global:HarnessLeft|$(@(Get-Module Microsoft.PowerShell.Security).Count)"'
    expect((await session.run(`function Get-HarnessLeft { 'left' }; $global:HarnessLeft = 'left'; ${security}; ${seen}`)).stdout).toBe('True|left|1')
    expect((await session.run(seen)).stdout).toBe('False||0')
  })

  // A person's Windows refuses script files by default (the Restricted policy): a call must not depend on the computer's.
  it('runs a call as powershell.exe -ExecutionPolicy Bypass does: a script file whatever policy its environment names, the full language, a single-threaded apartment', async () => {
    const file = join(scratch, 'dotted.ps1')
    writeFileSync(file, "function Get-HarnessDotted { 'dotted' }\r\n")
    const run = await session.run(`. '${file}'; "$(Get-HarnessDotted)|$($ExecutionContext.SessionState.LanguageMode)|$([Threading.Thread]::CurrentThread.GetApartmentState())"`, { env: { ...process.env, PSExecutionPolicyPreference: 'Restricted' } })
    expect(run).toEqual({ status: 0, stdout: 'dotted|FullLanguage|STA', stderr: '' })
  })

  it('gives a call the environment it sent, and nothing of the call before', async () => {
    expect((await session.run('"[$env:HARNESS_PS_CALL]"', { env: { ...process.env, HARNESS_PS_CALL: 'sent' } })).stdout).toBe('[sent]')
    expect((await session.run('"[$env:HARNESS_PS_CALL]"')).stdout).toBe('[]')
  })

  // What installPs1.spec.ts's `powershell7` cases stand on. A host that put a module command of its own into the call's
  // runspace ahead of the script (to format the output, say) would load 5.1's Utility there, and those cases would pass
  // whatever install.ps1 called.
  it('has autoload read the PSModulePath its call sent: a stand-in Utility hides Get-FileHash, and the next call has 5.1\'s own again', async () => {
    const modules = join(scratch, 'modules')
    mkdirSync(join(modules, 'HarnessStandIn'), { recursive: true })
    writeFileSync(join(modules, 'HarnessStandIn', 'HarnessStandIn.psm1'), "function Get-HarnessStandIn { 'stand-in' }\r\n")
    // installPs1.spec.ts's stand-in for PowerShell 7's Utility: it lists Get-FileHash and cannot give it to 5.1.
    mkdirSync(join(modules, 'Microsoft.PowerShell.Utility'))
    writeFileSync(join(modules, 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1'), "@{ ModuleVersion = '7.0.0.0'; CompatiblePSEditions = @('Core'); PowerShellVersion = '3.0'; NestedModules = @('Microsoft.PowerShell.Commands.Utility.dll'); CmdletsToExport = @('Add-Type', 'ConvertFrom-Json', 'Get-FileHash', 'Invoke-WebRequest', 'New-Object', 'Select-Object', 'Start-Sleep', 'Write-Host') }\r\n")
    const file = join(scratch, 'hashed.txt')
    writeFileSync(file, 'harness')
    const sha = createHash('sha256').update('harness').digest('hex')
    const own: NodeJS.ProcessEnv = { ...process.env }
    for (const name of Object.keys(own)) if (name.toLowerCase() === 'psmodulepath') delete own[name]
    const standIn = { ...own, PSModulePath: `${modules};${join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')}` }
    const probe = `$hash = try { (Get-FileHash -LiteralPath '${file}' -Algorithm SHA256).Hash.ToLower() } catch { 'no Get-FileHash' }; $module = try { Get-HarnessStandIn } catch { 'no stand-in' }; "$hash|$module"`
    expect((await session.run(probe, { env: own })).stdout).toBe(`${sha}|no stand-in`)
    expect((await session.run(probe, { env: standIn })).stdout).toBe('no Get-FileHash|stand-in')
    expect((await session.run(probe, { env: own })).stdout).toBe(`${sha}|no stand-in`)
  })

  it('returns output, Write-Host lines and warnings in the order written, each line whole', async () => {
    const long = 'x'.repeat(300)
    const run = await session.run(`'one'; Write-Host 'two'; Write-Warning 'three'; 4; $true; Write-Host '${long}'; '${long}'`)
    expect(run).toEqual({ status: 0, stdout: ['one', 'two', 'WARNING: three', '4', 'True', long, long].join('\r\n'), stderr: '' })
  })

  it('gives status 1 and the message on stderr for an error the script did not catch, and status 0 for one it caught', async () => {
    const thrown = await session.run("$ErrorActionPreference = 'Stop'; 'before'; throw 'boom'; 'after'")
    expect({ status: thrown.status, stdout: thrown.stdout }).toEqual({ status: 1, stdout: 'before' })
    expect(thrown.stderr).toContain('boom')
    const unknown = await session.run("$ErrorActionPreference = 'Stop'; Get-HarnessNoSuchCommand")
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toContain("The term 'Get-HarnessNoSuchCommand' is not recognized")
    expect(await session.run("$ErrorActionPreference = 'Stop'; try { throw 'boom' } catch { $_.Exception.Message }")).toEqual({ status: 0, stdout: 'boom', stderr: '' })
  })

  it('keeps answering when a child started with Start-Process -NoNewWindow writes to the host\'s own output', async () => {
    // About 250 KB, more than a pipe holds: a host whose output nobody reads would block the child, and this call with it.
    const echo = `for /L %i in (1,1,4000) do @echo ${'0123456789'.repeat(6)}`
    const loud = await session.run(`$child = Start-Process -FilePath $env:ComSpec -ArgumentList '/d /c ${echo}' -NoNewWindow -PassThru; $null = $child.Handle; $child.WaitForExit(); $child.ExitCode`)
    expect(loud).toEqual({ status: 0, stdout: '0', stderr: '' })
    expect((await session.run("'next'")).stdout).toBe('next')
  })

  it('carries text outside ASCII both ways, and an answer larger than a pipe holds', async () => {
    expect((await session.run("'Jö 日 & co'; Write-Host 'Jö 日 & co'")).stdout).toBe('Jö 日 & co\r\nJö 日 & co')
    const lines = (await session.run("1..20000 | ForEach-Object { \"line $_ \" + ('y' * 60) }")).stdout.split('\r\n')
    expect(lines).toHaveLength(20000)
    expect(lines.at(-1)).toBe(`line 20000 ${'y'.repeat(60)}`)
  })

  // Run, its runspace would stop at the exit with status 0, and a case could pass on a script that never got that far.
  it('refuses a script with an exit statement before it runs any of it, and answers the next call', async () => {
    const ran = join(scratch, 'ran.txt')
    await expect(session.run(`[IO.File]::WriteAllText('${ran}', 'ran'); exit 3`)).rejects.toThrow('a script with an exit statement is refused here')
    expect(existsSync(ran)).toBe(false)
    expect((await session.run("'next'")).stdout).toBe('next')
  })

  it('fails a call that passes its timeout, naming it, ends that host, and answers the next call from a new one', async () => {
    const before = Number((await session.run('$PID')).stdout)
    await expect(session.run('[Threading.Thread]::Sleep(60000)', { timeoutMs: 2_000 })).rejects.toThrow('timed out after 2000 ms')
    expect(() => process.kill(before, 0)).toThrow()
    expect(Number((await session.run('$PID')).stdout)).not.toBe(before)
  })

  it('fails a call whose host exits under it, naming the exit, and answers the next call from a new host', async () => {
    await expect(session.run('[Environment]::Exit(7)')).rejects.toThrow('host exited with code 7')
    expect((await session.run("'back'")).stdout).toBe('back')
  })

  it('leaves no powershell.exe behind when it closes', async () => {
    const own = windowsPowerShell()
    const pid = Number((await own.run('$PID')).stdout)
    await own.close()
    expect(() => process.kill(pid, 0)).toThrow()
  })
})
