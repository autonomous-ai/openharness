import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
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

  // The daemon's watch reads the store the moment the fixture's open makes it, an empty file: on Linux that read's lock
  // can land before the fixture's first write (dial eval XH2 on CI, "database is locked"). A reader on its own thread
  // holds a read of the empty store from just before the fixture writes until a quarter second after.
  it('writes its rows while a reader reads the store it has just made', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'codex-app-fixture-'))
    temps.push(temp)
    const home = join(temp, '.codex')
    mkdirSync(home)
    const store = join(home, 'state_5.sqlite')
    writeFileSync(store, '')
    // [0]: the reader holds its read; [1]: the fixture writes now.
    const flags = new Int32Array(new SharedArrayBuffer(8))
    const reader = new Worker(`
      const { workerData: { store, flags } } = require('node:worker_threads')
      const { DatabaseSync } = require('node:sqlite')
      const db = new DatabaseSync(store, { readOnly: true })
      db.exec('BEGIN')
      db.prepare('SELECT count(*) FROM sqlite_master').all()
      Atomics.store(flags, 0, 1)
      Atomics.notify(flags, 0)
      Atomics.wait(flags, 1, 0)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
      db.exec('COMMIT')
      db.close()
    `, { eval: true, workerData: { store, flags } })
    const exited = once(reader, 'exit')
    try {
      expect(Atomics.wait(flags, 0, 0, 10_000)).not.toBe('timed-out')
      Atomics.store(flags, 1, 1)
      Atomics.notify(flags, 1)
      const fixture = codexAppFixture(home)
      expect(() => fixture.threads([{ id: 'eval-thread', cwd: '/work/api' }])).not.toThrow()
    } finally {
      Atomics.store(flags, 1, 1)
      Atomics.notify(flags, 1)
      await exited
    }
  })
})
