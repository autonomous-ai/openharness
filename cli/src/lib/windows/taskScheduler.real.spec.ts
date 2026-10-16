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
  it('is taken by schtasks as written, enabled, with its two triggers, and removed again', () => {
    const name = `\\HarnessTest\\b3-${randomBytes(4).toString('hex')}`
    const dir = mkdtempSync(join(tmpdir(), 'task-'))
    const file = join(dir, 'task.xml')
    const run = (...args: string[]) => spawnSync('schtasks', args, { encoding: 'utf8' })
    // The logon trigger names the user by SID (taskSchedulerXml): a name built from USERDOMAIN is not this user
    // over SSH, where OpenSSH sets USERDOMAIN to WORKGROUP.
    const sid = whoamiSid(spawnSync('whoami', WHOAMI_ARGS, { encoding: 'utf8' }).stdout)!
    // UTF-16LE with its byte order mark, as PlatformService.write writes it: schtasks refuses the XML as UTF-8.
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskSchedulerXml({
      launcherPath: join(process.env.SystemRoot!, 'System32', 'whoami.exe'), root: dir, home: dir, logFile: join(dir, 'harness.log'), sid,
    }), 'utf16le')]))
    try {
      const created = run('/Create', '/TN', name, '/XML', file, '/F')
      expect(created.status, created.stderr).toBe(0)
      const shown = run('/Query', '/TN', name, '/XML')
      expect(shown.status).toBe(0)
      const text = shown.stdout.replace(/\u0000/g, '')
      expect(text).toMatch(/<LogonTrigger>/)
      expect(text).toMatch(/<Interval>PT5M<\/Interval>/)
      expect(text).toMatch(/<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/)
      // Enabled: schtasks shows a setting only when it is not the default, so an enabled task has no <Enabled> in its
      // settings, and a disabled one says false (the rule PlatformService.inspect reads it by).
      expect(text).toMatch(/<Settings>/)
      expect(text).not.toMatch(/<Settings>[\s\S]*?<Enabled>false<\/Enabled>[\s\S]*?<\/Settings>/)
    } finally {
      run('/Delete', '/TN', name, '/F')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
