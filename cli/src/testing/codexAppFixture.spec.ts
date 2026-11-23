import { mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexAppFixture } from './codexAppFixture.js'

const REFUSED = 'the Codex app fixture never writes the real ~/.codex'

// Only the constructor runs on a real place: it writes nothing, so even a fixture that accepted one leaves no trace.
describe('codexAppFixture', () => {
  const temps: string[] = []
  afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }) })
  const real = () => join(userInfo().homedir, '.codex')

  it("refuses the account's own ~/.codex, and a folder inside it", () => {
    for (const place of [real(), `${real()}/`, join(real(), 'eval-home')]) expect(() => codexAppFixture(place)).toThrow(REFUSED)
  })

  // Their folders ignore case: another spelling is the same folder.
  it.runIf(process.platform === 'darwin' || process.platform === 'win32')('refuses ~/.codex spelled in another case', () => {
    expect(() => codexAppFixture(real().toUpperCase())).toThrow(REFUSED)
  })

  it('refuses ~/.codex reached through a link to the home folder', () => {
    const temp = mkdtempSync(join(tmpdir(), 'codex-app-fixture-'))
    temps.push(temp)
    // A junction on Windows, which needs no right to make; elsewhere the type is not read.
    const link = join(temp, 'home')
    symlinkSync(userInfo().homedir, link, 'junction')
    try {
      expect(() => codexAppFixture(join(link, '.codex'))).toThrow(REFUSED)
    } finally {
      // The link alone, before its folder goes: nothing is ever removed through it.
      unlinkSync(link)
    }
  })

  it('takes a home in a temp folder', () => {
    const temp = mkdtempSync(join(tmpdir(), 'codex-app-fixture-'))
    temps.push(temp)
    expect(codexAppFixture(join(temp, '.codex')).home).toBe(join(temp, '.codex'))
  })
})
