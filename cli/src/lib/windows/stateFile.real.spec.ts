// The check a credential file passes before it is read on Windows (secureState.ts `requireWindowsStateFile`), on
// NTFS's own links and junctions: Windows' open has no O_NOFOLLOW, so this check is what keeps a link planted in the
// data folder from handing the daemon another file. Windows only; the Windows workflow runs it with src/lib/windows:
//   cd cli && npx vitest run src/lib/windows/stateFile.real.spec.ts
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requireWindowsStateFile } from '../secureState.js'

const cleanup: Array<() => void> = []
let configured: string | undefined
beforeEach(() => {
  // Only the profile is a state root here: a data folder set for the run would be one too.
  configured = process.env.ADAPTER_DATA_DIR
  delete process.env.ADAPTER_DATA_DIR
})
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo()
  if (configured !== undefined) process.env.ADAPTER_DATA_DIR = configured
})
/** A folder in the profile: %TEMP% is in it. */
function profileDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hstate-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

;(process.platform === 'win32' ? describe : describe.skip)('a credential file on Windows', () => {
  it('is taken when it is a regular file in the profile', () => {
    const file = join(profileDir(), 'daemon-token')
    writeFileSync(file, 'x')
    expect(() => requireWindowsStateFile(file)).not.toThrow()
  })

  it('is refused when it is a file link, even to a file in the profile', (context) => {
    const dir = profileDir()
    writeFileSync(join(dir, 'target'), 'x')
    try {
      symlinkSync(join(dir, 'target'), join(dir, 'daemon-token'), 'file')
    } catch (error) {
      // A file link needs Developer Mode or an elevated token; GitHub's runners have one.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') context.skip()
      throw error
    }
    expect(() => requireWindowsStateFile(join(dir, 'daemon-token'))).toThrow(/link or junction/)
  })

  it('is taken through a junction in its path that stays inside the profile', () => {
    // A data folder reached through a junction (a moved profile folder, OneDrive's) is still the person's.
    const dir = profileDir()
    mkdirSync(join(dir, 'real'))
    writeFileSync(join(dir, 'real', 'daemon-token'), 'x')
    symlinkSync(join(dir, 'real'), join(dir, 'joined'), 'junction')
    expect(() => requireWindowsStateFile(join(dir, 'joined', 'daemon-token'))).not.toThrow()
  })

  it('is refused outside the profile, also when a junction in the profile leads there', () => {
    const windows = process.env.SystemRoot ?? 'C:\\Windows'
    expect(() => requireWindowsStateFile(join(windows, 'win.ini'))).toThrow(/outside your user profile/)
    // A junction needs no privilege: anyone who can write the data folder can plant one.
    const dir = profileDir()
    symlinkSync(windows, join(dir, 'joined'), 'junction')
    expect(() => requireWindowsStateFile(join(dir, 'joined', 'win.ini'))).toThrow(/outside your user profile/)
  })
})
