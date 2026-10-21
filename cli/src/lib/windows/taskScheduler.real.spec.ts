// The task XML as Task Scheduler takes it, under a throwaway name (never a user's own taskName(<user>),
// `Harness harnessd (<user>)`). Windows only:
//   cd cli && npx vitest run src/lib/windows/taskScheduler.real.spec.ts
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { taskSchedulerXml, WHOAMI_ARGS, whoamiSid } from '../../harnessd/platform.js'

describe.skipIf(process.platform !== 'win32')('the scheduled task on Windows', () => {
  it('is taken by schtasks as written, enabled, the five-minute task and the logon task, and removed again', () => {
    const name = `\\HarnessTest\\b3-${randomBytes(4).toString('hex')}`
    const logonName = `${name}-logon`
    const dir = mkdtempSync(join(tmpdir(), 'task-'))
    const file = join(dir, 'task.xml')
    const run = (...args: string[]) => spawnSync('schtasks', args, { encoding: 'utf8' })
    // The logon trigger names the user by SID (taskSchedulerXml): a name built from USERDOMAIN is not this user
    // over SSH, where OpenSSH sets USERDOMAIN to WORKGROUP.
    const sid = whoamiSid(spawnSync('whoami', WHOAMI_ARGS, { encoding: 'utf8' }).stdout)!
    // UTF-16LE with its byte order mark, as PlatformService.write writes it: schtasks refuses the XML as UTF-8.
    const definition = { launcherPath: join(process.env.SystemRoot!, 'System32', 'whoami.exe'), root: dir, home: dir, logFile: join(dir, 'harness.log'), sid }
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskSchedulerXml(definition), 'utf16le')]))
    const logonFile = join(dir, 'logon-task.xml')
    writeFileSync(logonFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskSchedulerXml({ ...definition, atLogon: true }), 'utf16le')]))
    try {
      const logonCreated = run('/Create', '/TN', logonName, '/XML', logonFile, '/F')
      expect(logonCreated.status, logonCreated.stderr).toBe(0)
      const logon = run('/Query', '/TN', logonName, '/XML').stdout.replace(/\u0000/g, '')
      expect(logon).toMatch(/<LogonTrigger>/)
      expect(logon).not.toMatch(/<TimeTrigger>/)
      expect(logon).toMatch(/start --if-down --at-logon<\/Arguments>/)
      expect(logon).toMatch(/<Priority>4<\/Priority>/)
      const created = run('/Create', '/TN', name, '/XML', file, '/F')
      expect(created.status, created.stderr).toBe(0)
      const shown = run('/Query', '/TN', name, '/XML')
      expect(shown.status).toBe(0)
      const text = shown.stdout.replace(/\u0000/g, '')
      expect(text).not.toMatch(/<LogonTrigger>/)
      expect(text).toMatch(/<Interval>PT5M<\/Interval>/)
      expect(text).toMatch(/<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/)
      // Not the default 7 (below normal), so schtasks shows it.
      expect(text).toMatch(/<Priority>4<\/Priority>/)
      // Enabled: schtasks shows a setting only when it is not the default, so an enabled task has no <Enabled> in its
      // settings, and a disabled one says false (the rule PlatformService.inspect reads it by).
      const DISABLED = /<Settings>[\s\S]*?<Enabled>false<\/Enabled>[\s\S]*?<\/Settings>/
      expect(text).toMatch(/<Settings>/)
      expect(text).not.toMatch(DISABLED)
      // The negative control: the same task turned off shows exactly what the check above looks for.
      const disabled = run('/Change', '/TN', name, '/DISABLE')
      expect(disabled.status, disabled.stderr).toBe(0)
      const off = run('/Query', '/TN', name, '/XML')
      expect(off.status).toBe(0)
      expect(off.stdout.replace(/\u0000/g, '')).toMatch(DISABLED)
    } finally {
      run('/Delete', '/TN', name, '/F')
      run('/Delete', '/TN', logonName, '/F')
      // schtasks makes the \HarnessTest folder for the task and never removes it: the scheduler's COM API does,
      // and refuses while another run's task is still in it (then it stays for that run to remove).
      spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        "$s = New-Object -ComObject Schedule.Service; $s.Connect(); $s.GetFolder('\\').DeleteFolder('HarnessTest', 0)"], { encoding: 'utf8' })
      rmSync(dir, { recursive: true, force: true })
    }
    // A ceiling, not a timing check: four schtasks calls and a PowerShell COM clean-up take ~5 s on windows-latest.
  }, 60_000)
})
