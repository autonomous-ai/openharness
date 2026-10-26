/**
 * `harness update`'s steps once the daemon is stopped (./updateCommand.ts `runUpdateSteps`): the terminal host and the
 * CLI, on a temp install root with the real install, canary and staging. The command itself lives in cli.ts and runs as
 * a process that refuses to update from a source checkout, so the order it takes them in is asserted on its source, as
 * cliStopFirst.spec.ts does.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PTY_PROTOCOL } from './ptyHost/protocol.js'
import { confirm, stage, type UpdateEntry } from './selfUpdate.js'
import { installPreparedPty, rejectedPtyVersions } from './windows/ptyInstall.js'
import { PTY_PAYLOAD_FILES, type PreparedPty, type PtyEntry } from './windows/ptyPayload.js'
import { runUpdateSteps, type UpdateStepsDeps } from './updateCommand.js'

let root: string
let ptyRoot: string
let bin: string
let cliDir: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'update-command-'))
  ptyRoot = join(root, 'runtime', 'pty')
  bin = join(root, 'bin')
  cliDir = join(root, 'cli')
  // The machine as install.ps1 leaves it: host 0.10.0 in use, its two bin files copied out of its folder; CLI 1.0.0.
  mkdirSync(join(ptyRoot, '0.10.0'), { recursive: true })
  for (const name of PTY_PAYLOAD_FILES) writeFileSync(join(ptyRoot, '0.10.0', name), `old ${name}`)
  writeFileSync(join(ptyRoot, 'current-pty'), '0.10.0\r\n')
  mkdirSync(bin)
  for (const name of ['harness.exe', 'harness-launch.exe']) writeFileSync(join(bin, name), `old ${name}`)
  mkdirSync(cliDir)
  writeFileSync(join(cliDir, 'cli.js'), 'console.log("1.0.0")\n')
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const above = PTY_PROTOCOL + 1
const ptyEntry: PtyEntry = { version: '0.11.0', url: 'https://cdn.test/pty.zip', sha256: 'a'.repeat(64), size: 10 }
const cliEntry: UpdateEntry = {
  version: '9.9.9', cli: { url: 'https://cdn.test/cli.js', sha256: 'b'.repeat(64) }, notify: { url: 'https://cdn.test/notify.mjs', sha256: 'c'.repeat(64) },
}
/** A CLI build that needs host protocol [needs], as its `version --json` says through the real canary. */
const cliNeeding = (needs: number) => Buffer.from(
  `console.log(process.argv.includes('--json') ? JSON.stringify({ version: '9.9.9', ptyProtocol: ${needs} }) : '9.9.9')\n`,
)
const pointer = () => readFileSync(join(ptyRoot, 'current-pty'), 'utf8').trim()
const cliOnDisk = () => readFileSync(join(cliDir, 'cli.js'), 'utf8')

/** The steps on the temp root: the downloads in the test's hands, the rest real (macOS's in-place CLI layout). */
function steps(o: { cli?: Buffer | null; hostProtocol?: number; hostReads?: (version: string) => number | null; stage?: UpdateStepsDeps['stage'] } = {}) {
  const lines: string[] = []
  const order: string[] = []
  const hostProtocol = o.hostProtocol ?? 2
  const deps: Partial<UpdateStepsDeps> = {
    downloadCli: async () => ({ cliBuf: o.cli ?? cliNeeding(2), notifyBuf: Buffer.from('export {}\n') }),
    stage: o.stage ?? ((dir, cliBuf, notifyBuf, version) => { order.push('stage cli'); stage(dir, cliBuf, notifyBuf, version, 'darwin') }),
    confirm: (dir) => { order.push('confirm cli'); confirm(dir) },
    // The installed host's `version`: the new folder speaks [hostProtocol], the old one 2.
    readHostProtocol: (binary) => (o.hostReads ? o.hostReads(binary) : binary.includes('0.11.0') ? hostProtocol : 2),
    pty: {
      fetchEntry: async () => ptyEntry,
      prepare: async (entry) => {
        const staging = join(ptyRoot, `.staging-1-${Date.now()}`)
        mkdirSync(staging, { recursive: true })
        for (const name of PTY_PAYLOAD_FILES) writeFileSync(join(staging, name), `new ${name}`)
        return { version: entry.version, staging, protocol: hostProtocol, features: ['seed'], paired: hostProtocol > PTY_PROTOCOL } satisfies PreparedPty
      },
      install: (prepared, rootDir) => { order.push('install host'); return installPreparedPty(prepared, rootDir) },
    },
    log: (line) => lines.push(line),
  }
  const run = (want: { cli: UpdateEntry | null; pty: PtyEntry | null }) =>
    runUpdateSteps({ cliEntry: want.cli, pty: want.pty, cliDir, ptyRoot: root, currentVersion: '1.0.0', deps })
  return { run, lines, order }
}

/** cli.ts with its comments blanked, and `updateCommand`'s body. */
function updateCommandSource(): string {
  const source = readFileSync(join(import.meta.dirname, '..', 'cli.ts'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, (match) => ' '.repeat(match.length))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (match, lead: string) => lead + ' '.repeat(match.length - lead.length))
  const from = source.indexOf('async function updateCommand(')
  expect(from).toBeGreaterThan(-1)
  return source.slice(from, source.indexOf('\n}\n', from))
}

describe('harness update', () => {
  it('harness update installs a newer pty payload when the CLI is current', async () => {
    const m = steps()
    expect(await m.run({ cli: null, pty: ptyEntry })).toEqual({ cli: 'none', pty: 'installed' })
    expect(pointer()).toBe('0.11.0')
    expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('new harness.exe')
    // On the master's probation, as an update the updater staged: the restarted daemon's master judges it.
    expect(JSON.parse(readFileSync(join(ptyRoot, 'pty-pending.json'), 'utf8'))).toEqual({ version: '0.11.0', previous: '0.10.0' })
    expect(m.lines).toEqual(['▸ Updating the terminal host 0.10.0 → 0.11.0…', '  ✓ installed terminal host 0.11.0'])

    // cli.ts: the host is asked about before "Already on the latest version", which a newer host does not reach, and
    // the steps run under the lock, after the stop.
    const text = updateCommandSource()
    const asked = text.indexOf('newerPtyFor(') // cli.ts's wrapper around newerPtyForUpdate, with the manifest url and key
    const latest = text.indexOf('Already on the latest version')
    expect(asked).toBeGreaterThan(-1)
    expect(asked).toBeLessThan(latest)
    expect(text.slice(asked, latest)).toMatch(/if \(!cliEntry && !pty\)/)
    const stop = text.indexOf('stopDaemonOrExit(')
    expect(text.indexOf('runUpdateSteps(')).toBeGreaterThan(stop)
    expect(text.indexOf('withSpawnLock(')).toBeLessThan(stop)
  })

  it('harness update installs a rejected pty version anyway', async () => {
    // The background updater never tries 0.11.0 again on this machine; a person asking by name gets it, as for the CLI.
    writeFileSync(join(ptyRoot, 'pty-rejected.json'), '["0.11.0"]')
    expect(await steps().run({ cli: null, pty: ptyEntry })).toEqual({ cli: 'none', pty: 'installed' })
    expect(pointer()).toBe('0.11.0')
  })

  it('installs the host first, then the CLI, and keeps the CLI build at once when it is not part of a pair', async () => {
    const m = steps()
    expect(await m.run({ cli: cliEntry, pty: ptyEntry })).toEqual({ cli: 'installed', pty: 'installed' })
    expect(m.order).toEqual(['install host', 'stage cli', 'confirm cli'])
    expect(cliOnDisk()).toContain('9.9.9')
    expect(existsSync(join(cliDir, 'update-pending.json'))).toBe(false)
  })

  it('refuses a CLI build that needs a host protocol this machine does not have, and says so', async () => {
    const m = steps({ cli: cliNeeding(above) })
    expect(await m.run({ cli: cliEntry, pty: null })).toEqual({ cli: 'failed', pty: 'none' })
    expect(m.lines).toContain(`  ✗ v9.9.9 needs terminal host protocol ${above}; this machine's host speaks 2 — keeping v1.0.0`)
    expect(m.order).toEqual([])
    expect(cliOnDisk()).toContain('1.0.0')
  })

  it('reads a host whose protocol cannot be read as this CLI\'s own, so a build that raises it is refused', async () => {
    // A `harness-pty.exe version` that failed or timed out.
    const m = steps({ cli: cliNeeding(above), hostReads: () => null })
    expect(await m.run({ cli: cliEntry, pty: null })).toEqual({ cli: 'failed', pty: 'none' })
    expect(m.lines).toContain(`  ✗ v9.9.9 needs terminal host protocol ${above}; this machine's host speaks ${PTY_PROTOCOL} — keeping v1.0.0`)
    // And with no current-pty at all.
    rmSync(join(ptyRoot, 'current-pty'))
    expect(await steps({ cli: cliNeeding(above) }).run({ cli: cliEntry, pty: null })).toEqual({ cli: 'failed', pty: 'none' })
  })

  it('installs a paired host with the CLI build that needs it, host first, and leaves both on probation', async () => {
    const m = steps({ cli: cliNeeding(above), hostProtocol: above })
    expect(await m.run({ cli: cliEntry, pty: ptyEntry })).toEqual({ cli: 'installed', pty: 'installed' })
    expect(m.order).toEqual(['install host', 'stage cli'])
    expect(pointer()).toBe('0.11.0')
    expect(cliOnDisk()).toContain('9.9.9')
    // Not kept on the spot: the next master judges the pair, and its rollback restores both.
    expect(JSON.parse(readFileSync(join(cliDir, 'update-pending.json'), 'utf8'))).toMatchObject({ version: '9.9.9' })
    expect(existsSync(join(ptyRoot, 'pty-pending.json'))).toBe(true)
  })

  it('leaves a paired host out when no CLI build being installed needs it', async () => {
    for (const cli of [null, cliEntry]) {
      const m = steps({ cli: cliNeeding(2), hostProtocol: above })
      expect(await m.run({ cli, pty: ptyEntry })).toEqual({ cli: cli ? 'installed' : 'none', pty: 'paired' })
      expect(m.lines).toContain(`  terminal host 0.11.0 speaks protocol ${above}, above this CLI's ${PTY_PROTOCOL} — it goes in only with a CLI build that needs it`)
      expect(m.order).not.toContain('install host')
      expect(pointer()).toBe('0.10.0')
      expect(rejectedPtyVersions(root)).toEqual([])
    }
  })

  it('takes a paired host back out when the CLI build it came with cannot be staged', async () => {
    const m = steps({ cli: cliNeeding(above), hostProtocol: above, stage: () => { throw new Error('ENOSPC: no space left on device') } })
    expect(await m.run({ cli: cliEntry, pty: ptyEntry })).toEqual({ cli: 'failed', pty: 'none' })
    expect(pointer()).toBe('0.10.0')
    expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('old harness.exe')
    expect(existsSync(join(ptyRoot, 'pty-pending.json'))).toBe(false)
    // Nothing was wrong with the host: it is not remembered as rolled back, and pairs with the next build.
    expect(rejectedPtyVersions(root)).toEqual([])
    expect(m.lines).toContain('  ✗ Update failed: ENOSPC: no space left on device')
    expect(m.lines).toContain('  terminal host 0.11.0 taken back out with the build it came with — back to 0.10.0')
  })

  it('off Windows there is no host, and no protocol rule', async () => {
    const lines: string[] = []
    const result = await runUpdateSteps({
      cliEntry, pty: null, cliDir, ptyRoot: null, currentVersion: '1.0.0',
      deps: {
        downloadCli: async () => ({ cliBuf: cliNeeding(above), notifyBuf: Buffer.from('export {}\n') }),
        stage: (dir, cliBuf, notifyBuf, version) => stage(dir, cliBuf, notifyBuf, version, 'darwin'),
        log: (line) => lines.push(line),
      },
    })
    expect(result).toEqual({ cli: 'installed', pty: 'none' })
  })
})
