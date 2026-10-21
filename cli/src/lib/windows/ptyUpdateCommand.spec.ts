/**
 * `harness update`'s terminal host half (./ptyUpdateCommand.ts). The command itself lives in cli.ts and runs as a
 * process, which refuses to update from a source checkout; so the two steps it takes are tested here on a temp install
 * root, and the order cli.ts takes them in is asserted on its source, as cliStopFirst.spec.ts does.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PTY_PAYLOAD_FILES, PtyPayloadRefused, type PreparedPty, type PtyEntry } from './ptyPayload.js'
import { installPtyForUpdate, newerPtyForUpdate, type PtyUpdateCommandDeps } from './ptyUpdateCommand.js'

let root: string
let ptyRoot: string
let bin: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pty-update-command-'))
  ptyRoot = join(root, 'runtime', 'pty')
  bin = join(root, 'bin')
  // The machine as install.ps1 leaves it: 0.10.0 in use, its two bin files copied out of its folder.
  mkdirSync(join(ptyRoot, '0.10.0'), { recursive: true })
  for (const name of PTY_PAYLOAD_FILES) writeFileSync(join(ptyRoot, '0.10.0', name), `old ${name}`)
  writeFileSync(join(ptyRoot, 'current-pty'), '0.10.0\r\n')
  mkdirSync(bin)
  for (const name of ['harness.exe', 'harness-launch.exe']) writeFileSync(join(bin, name), `old ${name}`)
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const entryOf = (version = '0.11.0'): PtyEntry => ({ version, url: 'https://cdn.test/pty.zip', sha256: 'a'.repeat(64), size: 10 })
const pointer = () => readFileSync(join(ptyRoot, 'current-pty'), 'utf8').trim()

/** The manifest and the download in the test's hands; the install is the real one, on the temp root. */
function deps(over: { entry?: PtyEntry | null | Error; prepare?: PtyUpdateCommandDeps['prepare'] } = {}) {
  const lines: string[] = []
  const prepared: string[] = []
  const d: Partial<PtyUpdateCommandDeps> = {
    fetchEntry: async () => {
      const entry = over.entry === undefined ? entryOf() : over.entry
      if (entry instanceof Error) throw entry
      return entry
    },
    prepare: over.prepare ?? (async (entry) => {
      prepared.push(entry.version)
      const staging = join(ptyRoot, `.staging-1-${Date.now()}`)
      mkdirSync(staging, { recursive: true })
      for (const name of PTY_PAYLOAD_FILES) writeFileSync(join(staging, name), `new ${name}`)
      return { version: entry.version, staging, protocol: 2, features: ['seed'] } satisfies PreparedPty
    }),
    log: (line) => lines.push(line),
  }
  return { d, lines, prepared }
}

const ask = (d: Partial<PtyUpdateCommandDeps>) => newerPtyForUpdate({ url: 'https://cdn.test/pty/metadata.json', key: 'win32-x64', rootDir: root, deps: d })

/** cli.ts with its comments blanked, and `updateCommand`'s body. */
function updateCommandSource(): string {
  const source = readFileSync(join(import.meta.dirname, '..', '..', 'cli.ts'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, (match) => ' '.repeat(match.length))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (match, lead: string) => lead + ' '.repeat(match.length - lead.length))
  const from = source.indexOf('async function updateCommand(')
  expect(from).toBeGreaterThan(-1)
  return source.slice(from, source.indexOf('\n}\n', from))
}

describe('harness update, for the terminal host (Windows)', () => {
  it('harness update installs a newer pty payload when the CLI is current', async () => {
    const { d, lines } = deps()
    const entry = await ask(d)
    expect(entry).toEqual(entryOf())
    expect(await installPtyForUpdate(entry!, { rootDir: root, deps: d })).toBe(true)
    expect(pointer()).toBe('0.11.0')
    expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('new harness.exe')
    // On the master's probation, as an update the updater staged: the restarted daemon's master judges it.
    expect(JSON.parse(readFileSync(join(ptyRoot, 'pty-pending.json'), 'utf8'))).toEqual({ version: '0.11.0', previous: '0.10.0' })
    expect(lines).toEqual(['▸ Updating the terminal host 0.10.0 → 0.11.0…', '  ✓ installed terminal host 0.11.0'])

    // cli.ts: the host is asked about before "Already on the latest version", which a newer host does not reach, and
    // it is installed under the lock, after the stop, before the CLI's own download.
    const text = updateCommandSource()
    const asked = text.indexOf('newerPtyFor(') // cli.ts's wrapper around newerPtyForUpdate, with the manifest url and key
    const latest = text.indexOf('Already on the latest version')
    expect(asked).toBeGreaterThan(-1)
    expect(asked).toBeLessThan(latest)
    expect(text.slice(asked, latest)).toMatch(/if \(!cliEntry && !pty\)/)
    const stop = text.indexOf('stopDaemonOrExit(')
    const install = text.indexOf('installPtyForUpdate(')
    expect(install).toBeGreaterThan(stop)
    expect(install).toBeLessThan(text.indexOf('downloadCanaryStage('))
    expect(text.indexOf('withSpawnLock(')).toBeLessThan(stop)
  })

  it('harness update installs a rejected pty version anyway', async () => {
    // The background updater never tries 0.11.0 again on this machine; a person asking by name gets it, as for the CLI.
    writeFileSync(join(ptyRoot, 'pty-rejected.json'), '["0.11.0"]')
    const { d } = deps()
    const entry = await ask(d)
    expect(entry?.version).toBe('0.11.0')
    expect(await installPtyForUpdate(entry!, { rootDir: root, deps: d })).toBe(true)
    expect(pointer()).toBe('0.11.0')
  })

  it('installs no pty while one is on probation, says so, and lets the CLI go on', async () => {
    writeFileSync(join(ptyRoot, 'pty-pending.json'), JSON.stringify({ version: '0.10.0', previous: '0.9.0' }))
    const { d, lines, prepared } = deps()
    expect(await ask(d)).toBeNull()
    expect(lines).toEqual(['  terminal host 0.10.0 is still on probation, so 0.11.0 is not installed now: run `harness update` again once the daemon has kept it or rolled it back'])
    // One that appears between the check and the lock: refused there the same way, with nothing downloaded.
    lines.length = 0
    expect(await installPtyForUpdate(entryOf(), { rootDir: root, deps: d })).toBe(false)
    expect(lines).toEqual(['  terminal host 0.10.0 is still on probation, so 0.11.0 is not installed now: run `harness update` again once the daemon has kept it or rolled it back'])
    expect(prepared).toEqual([])
    expect(pointer()).toBe('0.10.0')
  })

  it('wants nothing that is not newer, over no installed host, or from a manifest it cannot read', async () => {
    expect(await ask(deps({ entry: entryOf('0.10.0') }).d)).toBeNull()
    expect(await ask(deps({ entry: null }).d)).toBeNull()
    const unreachable = deps({ entry: new Error('ECONNRESET') })
    expect(await ask(unreachable.d)).toBeNull()
    expect(unreachable.lines).toEqual(['  could not check for a terminal host update (ECONNRESET); continuing with the CLI'])
    // The first host is install.ps1's to put in: with no current-pty there is nothing for probation to go back to.
    rmSync(join(ptyRoot, 'current-pty'))
    expect(await ask(deps().d)).toBeNull()
  })

  it('a payload that fails is reported and leaves the installed host as it was', async () => {
    const { d, lines } = deps({ prepare: async () => { throw new PtyPayloadRefused('harness-pty reports version 0.9.9, expected 0.11.0') } })
    expect(await installPtyForUpdate(entryOf(), { rootDir: root, deps: d })).toBe(false)
    expect(lines).toEqual([
      '▸ Updating the terminal host 0.10.0 → 0.11.0…',
      '  ✗ terminal host 0.11.0 was not installed (pty payload refused: harness-pty reports version 0.9.9, expected 0.11.0) — keeping 0.10.0',
    ])
    expect(pointer()).toBe('0.10.0')
    expect(existsSync(join(ptyRoot, 'pty-pending.json'))).toBe(false)
  })
})
