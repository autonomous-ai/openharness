/**
 * An executable fixture (a fake shell, engine or tool) that code under a deadline can run at once.
 *
 * macOS checks each newly written executable on its first exec, about 200 ms each, queued machine-wide: 40 new
 * `#!/bin/sh` scripts run in parallel took 8 s, and the same 40 a second time took none (2026-11-18). Under a parallel
 * run that queue pushed a probe past its 5 s deadline in lib/engineLaunch.spec.ts, so the gate it fed refused nothing.
 * So the file is first a bare `#!/bin/sh` that is run once, to its exit, before any deadline runs; the real content
 * then goes into the same file, which the check has already admitted.
 */
import { chmodSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

export function writeExecutable(path: string, content: string): void {
  // Windows has no /bin/sh to run the stub with, and no such check on a first exec.
  if (process.platform !== 'win32') {
    writeFileSync(path, '#!/bin/sh\n')
    chmodSync(path, 0o700)
    spawnSync(path)
  }
  writeFileSync(path, content, { mode: 0o700 })
}
