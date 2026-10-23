/**
 * `harness update`'s terminal host helpers (./ptyUpdateCommand.ts), on a temp install root. The steps the command
 * takes with them, the CLI's included, are tested in ../updateCommand.spec.ts.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PTY_PAYLOAD_FILES, type PtyEntry } from './ptyPayload.js'
import { newerPtyForUpdate, preparePtyForUpdate, takeBackPtyForUpdate, type PtyUpdateCommandDeps } from './ptyUpdateCommand.js'

let root: string
let ptyRoot: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pty-update-command-'))
  ptyRoot = join(root, 'runtime', 'pty')
  mkdirSync(join(ptyRoot, '0.10.0'), { recursive: true })
  for (const name of PTY_PAYLOAD_FILES) writeFileSync(join(ptyRoot, '0.10.0', name), `old ${name}`)
  writeFileSync(join(ptyRoot, 'current-pty'), '0.10.0\r\n')
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const entryOf = (version = '0.11.0'): PtyEntry => ({ version, url: 'https://cdn.test/pty.zip', sha256: 'a'.repeat(64), size: 10 })
const pointer = () => readFileSync(join(ptyRoot, 'current-pty'), 'utf8').trim()

function deps(entry: PtyEntry | null | Error = entryOf()) {
  const lines: string[] = []
  const prepared: string[] = []
  const d: Partial<PtyUpdateCommandDeps> = {
    fetchEntry: async () => { if (entry instanceof Error) throw entry; return entry },
    prepare: async (e) => { prepared.push(e.version); throw new Error('not reached') },
    log: (line) => lines.push(line),
  }
  return { d, lines, prepared }
}
const ask = (d: Partial<PtyUpdateCommandDeps>) => newerPtyForUpdate({ url: 'https://cdn.test/pty/metadata.json', key: 'win32-x64', rootDir: root, deps: d })

describe('harness update, for the terminal host (Windows)', () => {
  it('installs no pty while one is on probation, says so, and lets the CLI go on', async () => {
    writeFileSync(join(ptyRoot, 'pty-pending.json'), JSON.stringify({ version: '0.10.0', previous: '0.9.0' }))
    const said = '  terminal host 0.10.0 is still on probation, so 0.11.0 is not installed now: run `harness update` again once the daemon has kept it or rolled it back'
    const { d, lines, prepared } = deps()
    expect(await ask(d)).toBeNull()
    expect(lines).toEqual([said])
    // One that appears between the check and the lock: refused there the same way, with nothing downloaded.
    lines.length = 0
    expect(await preparePtyForUpdate(entryOf(), { rootDir: root, deps: d })).toBeNull()
    expect(lines).toEqual([said])
    expect(prepared).toEqual([])
    expect(pointer()).toBe('0.10.0')
  })

  it('wants nothing that is not newer, over no installed host, or from a manifest it cannot read', async () => {
    expect(await ask(deps(entryOf('0.10.0')).d)).toBeNull()
    expect(await ask(deps(null).d)).toBeNull()
    const unreachable = deps(new Error('ECONNRESET'))
    expect(await ask(unreachable.d)).toBeNull()
    expect(unreachable.lines).toEqual(['  could not check for a terminal host update (ECONNRESET); continuing with the CLI'])
    // The first host is install.ps1's to put in: with no current-pty there is nothing for probation to go back to.
    rmSync(join(ptyRoot, 'current-pty'))
    expect(await ask(deps().d)).toBeNull()
  })

  it('a payload that fails its canary is reported, and nothing is installed', async () => {
    const { d, lines } = deps()
    d.prepare = async () => { throw new Error('pty payload refused: harness-pty reports version 0.9.9, expected 0.11.0') }
    expect(await preparePtyForUpdate(entryOf(), { rootDir: root, deps: d })).toBeNull()
    expect(lines).toEqual([
      '▸ Updating the terminal host 0.10.0 → 0.11.0…',
      '  ✗ terminal host 0.11.0 was not installed (pty payload refused: harness-pty reports version 0.9.9, expected 0.11.0) — keeping 0.10.0',
    ])
    expect(pointer()).toBe('0.10.0')
  })

  it('takes a paired host back out after its build failed to go in, marking with ✗ what did not happen', () => {
    mkdirSync(join(ptyRoot, '0.11.0'))
    writeFileSync(join(ptyRoot, 'current-pty'), '0.11.0')
    writeFileSync(join(ptyRoot, 'pty-pending.json'), JSON.stringify({ version: '0.11.0', previous: '0.10.0' }))
    // The rejection the restore records first cannot be written.
    mkdirSync(join(ptyRoot, 'pty-rejected.json'))
    const lines: string[] = []
    takeBackPtyForUpdate(root, (line) => lines.push(line))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^ {2}✗ could not take terminal host 0\.11\.0 back out/)
    rmSync(join(ptyRoot, 'pty-rejected.json'), { recursive: true })
    takeBackPtyForUpdate(root, (line) => lines.push(line))
    expect(lines[1]).toBe('  terminal host 0.11.0 taken back out with the build it came with — back to 0.10.0')
    expect(pointer()).toBe('0.10.0')
  })
})
