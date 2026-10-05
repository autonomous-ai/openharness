import { execFileSync, spawn, spawnSync } from 'child_process'
import { createServer, type Server } from 'http'
import { createWriteStream, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it } from 'vitest'
import { useBundledCli } from './__fixtures__/bundledCli.js'

const CLI_ROOT = fileURLToPath(new URL('..', import.meta.url))
const cli = useBundledCli()
const DAY = 86_400_000
const dirs: string[] = []
let rebaseConflict = false
/** The daemon answers OTHER_ACCOUNT: on the preview, or only on the confirm. */
let rebaseOther: 'no' | 'preview' | 'confirm' = 'no'
const servers: Server[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

// Log order is deliberately not the display order: `old` was added first, this machine second, the
// new app last. The `#` printed on each row is its log position, so it survives the display re-sorting.
const now = Date.now()
const MEMBERS = [
  { pub: 'pub-old', kind: 'machine', machineId: 'm_old0000000', label: 'old-box', addedAt: now - 90 * DAY, seq: 1, fingerprint: 'AAAA·BBBB·CCCC·DDDD', self: false },
  { pub: 'pub-self', kind: 'machine', machineId: 'm_self000000', label: 'mbp', addedAt: now - 100 * DAY, seq: 2, fingerprint: 'E2FB·0DF5·5FD8·E6C7', self: true },
  { pub: 'pub-new', kind: 'viewer', machineId: '', label: 'phone', addedAt: now - 2 * DAY, seq: 3, firstSeen: now - 2 * DAY, fingerprint: '1111·2222·3333·4444', self: false },
]

/** A daemon that answers the two device routes `harness devices` calls; records each removal. */
function fakeDaemon(lastSeen: Record<string, number> = { 'pub-old': now - 3 * DAY }, members: typeof MEMBERS = MEMBERS, extra: Record<string, unknown> = {}, newRoutes = false): Promise<{ port: number; removed: string[]; dismissed: unknown[]; rebased: Array<{ confirm?: boolean; head?: unknown }> }> {
  const rebased: Array<{ confirm?: boolean; head?: unknown }> = []
  const removed: string[] = []
  const dismissed: unknown[] = []
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        if (req.method === 'GET' && req.url === '/api/devices') {
          res.end(JSON.stringify({ head: null, frozen: null, self: 'pub-self', members, frozenPeers: [], lastSeen, ...extra }))
        } else if (req.method === 'POST' && req.url === '/api/devices/remove') {
          removed.push((JSON.parse(raw) as { pub: string }).pub)
          res.end(JSON.stringify({ ok: true }))
        } else if (newRoutes && req.method === 'GET' && req.url === '/api/devices/history') {
          res.end(JSON.stringify({ complete: false, frozen: null, rows: [{
            seq: 3, op: 'added', pub: 'pub-new', kind: 'viewer', machineId: '', label: 'phone', fingerprint: '1111·2222·3333·4444',
            at: new Date(2026, 9, 1, 14, 5).getTime(), thisDevice: false, afterJoin: true, pending: true, active: true, whileFrozen: false,
          }] }))
        } else if (newRoutes && req.method === 'POST' && req.url === '/api/devices/dismiss') {
          dismissed.push(JSON.parse(raw))
          res.end(JSON.stringify({ ok: true }))
        } else if (newRoutes && req.method === 'POST' && req.url === '/api/devices/rebaseline') {
          const body = JSON.parse(raw) as { confirm?: boolean; head?: unknown }
          rebased.push(body)
          if (rebaseOther === 'preview' || (body.confirm && rebaseOther === 'confirm')) { res.statusCode = 409; res.end(JSON.stringify({ error: 'OTHER_ACCOUNT' })); return }
          if (body.confirm && rebaseConflict) { res.statusCode = 409; res.end(JSON.stringify({ error: 'LOG_CHANGED' })); return }
          res.end(JSON.stringify({ head: { seq: 7, hash: 'h7' }, added: [{ label: 'phone', kind: 'viewer' }], removed: [], applied: !!body.confirm }))
        } else {
          res.statusCode = 404
          res.end('{}')
        }
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ port: typeof address === 'object' && address ? address.port : 0, removed, dismissed, rebased })
    })
  })
}

function cliEnv(port: number): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), 'harness-cli-devices-'))
  dirs.push(root)
  return {
    ...process.env,
    HOME: root,
    HARNESS_AUTH_DIR: join(root, 'auth'),
    ADAPTER_DATA_DIR: join(root, 'data'),
    ADAPTER_RUNTIME_DIR: join(root, 'runtime'),
    ADAPTER_CLI_DIR: join(root, 'cli'),
    ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'),
    ADAPTER_UPDATE_DISABLE: 'true',
    PORT: String(port),
  }
}

function run(port: number, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli(), 'devices', ...args], { cwd: CLI_ROOT, env: cliEnv(port) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.once('close', (status) => resolve({ status, stdout, stderr }))
  })
}

const quote = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`
/** `script(1)` gives the CLI a terminal (stdin and stdout both a TTY) without node-pty. BSD and
 *  util-linux spell it differently; anything else skips the terminal tests. */
const HAS_SCRIPT = (process.platform === 'darwin' || process.platform === 'linux') && spawnSync('sh', ['-c', 'command -v script && command -v mkfifo'], { stdio: 'ignore' }).status === 0

/** Run `harness devices …` at a terminal and, once it asks `[y/N]`, type `answer` + Enter — after the
 *  question, as a person would. `pipeOut` sends its stdout to a pipe, so only stdin is a terminal.
 *  Returns everything the terminal showed. */
function runAtTerminal(port: number, args: string[], answer: string, pipeOut = false): Promise<{ status: number | null; screen: string }> {
  const cmd = [process.execPath, cli(), 'devices', ...args].map(quote).join(' ') + (pipeOut ? ' | cat; exit "${PIPESTATUS[0]:-$?}"' : '')
  const shell = pipeOut ? `bash -c ${quote(cmd)}` : cmd
  // The keyboard is a FIFO piped in by cat: BSD script refuses a socket or a FIFO as stdin, not a pipe.
  const dir = mkdtempSync(join(tmpdir(), 'harness-cli-tty-'))
  dirs.push(dir)
  const keyboard = join(dir, 'keyboard')
  execFileSync('mkfifo', [keyboard])
  const script = process.platform === 'darwin' ? `script -q /dev/null sh -c ${quote(shell)}` : `script -qec ${quote(shell)} /dev/null`
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', `cat ${quote(keyboard)} | ${script}`], { cwd: CLI_ROOT, env: cliEnv(port), stdio: ['ignore', 'pipe', 'pipe'] })
    const keys = createWriteStream(keyboard)
    keys.on('error', () => {})
    // With stdout piped no question may appear: nothing to wait for, so the keyboard just closes.
    if (pipeOut) keys.end()
    let screen = ''
    let typed = false
    const seen = (c: Buffer): void => {
      screen += c.toString()
      if (!typed && !pipeOut && screen.includes('[y/N]')) { typed = true; keys.end(`${answer}\n`) }
    }
    child.stdout.on('data', seen)
    child.stderr.on('data', seen)
    child.once('close', (status) => { keys.destroy(); resolve({ status, screen: screen.replace(/\r/g, '') }) })
  })
}

describe('harness devices', () => {
  it('lists this machine, then the new device, then the rest, each row keeping its log-order number', async () => {
    const { port } = await fakeDaemon()
    const { status, stdout } = await run(port, ['list'])
    expect(status).toBe(0)
    expect(stdout).toContain('This machine: mbp  E2FB·0DF5·5FD8·E6C7')
    const rows = stdout.split('\n').filter((l) => /^\s+\d+\. /.test(l))
    expect(rows).toEqual([
      '    2. mbp  computer m_self00  E2FB·0DF5·5FD8·E6C7  added 3 months ago  (this machine)',
      '    3. phone  app  1111·2222·3333·4444  added 2 days ago  new',
      '    1. old-box  computer m_old000  AAAA·BBBB·CCCC·DDDD  last active 3 days ago',
    ])
    expect(stdout).toContain('harness devices remove <fingerprint>')
    expect(stdout).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  }, 20_000)

  it('numbers do not move when activity reorders the display', async () => {
    // The unknown laptop opening a session must not hand its number to another device.
    const { port } = await fakeDaemon({ 'pub-old': now - 1000, 'pub-new': now - 2000 })
    const { stdout } = await run(port, ['list'])
    const rows = stdout.split('\n').filter((l) => /^\s+\d+\. /.test(l)).map((l) => l.trim().split('  ')[0])
    expect(rows.slice().sort()).toEqual(['1. old-box', '2. mbp', '3. phone'])
    const shown = await run(port, ['show', '1'])
    expect(shown.stdout).toContain('old-box')
  }, 20_000)

  it('show resolves the number the list prints; remove by number needs --yes without a terminal', async () => {
    const daemon = await fakeDaemon()
    const shown = await run(daemon.port, ['show', '1'])
    expect(shown.status).toBe(0)
    expect(shown.stdout).toContain('old-box')
    expect(shown.stdout).toContain('key code     AAAA·BBBB·CCCC·DDDD')
    expect(shown.stdout).toContain('Not yours? harness devices remove AAAA·BBBB·CCCC·DDDD')
    const refused = await run(daemon.port, ['remove', '1'])
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('without a terminal to confirm')
    expect(refused.stderr).toContain('harness devices remove AAAA·BBBB·CCCC·DDDD')
    expect(daemon.removed).toEqual([])
    const removed = await run(daemon.port, ['remove', '1', '--yes'])
    expect(removed.status).toBe(0)
    expect(daemon.removed).toEqual(['pub-old'])
  }, 30_000)

  it('remove by key code needs no confirmation and hits exactly that device', async () => {
    const daemon = await fakeDaemon()
    const removed = await run(daemon.port, ['remove', '1111·2222'])
    expect(removed.status).toBe(0)
    expect(daemon.removed).toEqual(['pub-new'])
  }, 20_000)

  it('show by fingerprint prefix, and --json adds lastSeen', async () => {
    const { port } = await fakeDaemon()
    const { status, stdout } = await run(port, ['show', 'aaaa-bb', '--json'])
    expect(status).toBe(0)
    expect(JSON.parse(stdout.trim())).toEqual({ ...MEMBERS[0], lastSeen: now - 3 * DAY })
  }, 20_000)

  it('a number past the end of the list is an error, never a key-code prefix; nothing is removed', async () => {
    // 4 is out of range with 3 devices; no key code here starts with 4, but 1 and 2 would if numbers fell through.
    const daemon = await fakeDaemon()
    for (const n of ['4', '9', '12']) {
      const shown = await run(daemon.port, ['show', n])
      expect(shown.status).toBe(1)
      expect(shown.stderr).toContain(`No device #${n} (see: harness devices list)`)
      const removed = await run(daemon.port, ['remove', n, '--yes'])
      expect(removed.status).toBe(1)
      expect(removed.stderr).toContain(`No device #${n} (see: harness devices list)`)
    }
    expect(daemon.removed).toEqual([])
  }, 60_000)

  it('an in-range number still resolves; a 4+ digit key-code prefix out of range still matches by key code', async () => {
    const daemon = await fakeDaemon()
    const three = await run(daemon.port, ['show', '3'])
    expect(three.status).toBe(0)
    expect(three.stdout).toContain('phone')
    const shown = await run(daemon.port, ['show', '1111'])
    expect(shown.status).toBe(0)
    expect(shown.stdout).toContain('phone')
    // Matched by key code, so no number to echo: it removes without --yes or a terminal.
    const removed = await run(daemon.port, ['remove', '1111'])
    expect(removed.status).toBe(0)
    expect(daemon.removed).toEqual(['pub-new'])
  }, 40_000)

  it('a short number with stray spaces or separators is still a list number, never a key-code prefix', async () => {
    // " 1" stripped to "1" would prefix-match phone (1111·…); it must name #1 (old-box) and be confirmed.
    const daemon = await fakeDaemon()
    const shown = await run(daemon.port, ['show', ' 1'])
    expect(shown.status).toBe(0)
    expect(shown.stdout).toContain('old-box')
    expect((await run(daemon.port, ['show', '03 '])).stdout).toContain('phone')
    const refused = await run(daemon.port, ['remove', '1 '])
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('without a terminal to confirm')
    for (const n of [' 4', '0', '00']) {
      const out = await run(daemon.port, ['remove', n, '--yes'])
      expect(out.status).toBe(1)
      expect(out.stderr).toContain(`No device #${n.trim()} (see: harness devices list)`)
    }
    expect(daemon.removed).toEqual([])
    const removed = await run(daemon.port, ['remove', ' 1', '--yes'])
    expect(removed.status).toBe(0)
    expect(daemon.removed).toEqual(['pub-old'])
  }, 60_000)

  it('a selector of only spaces or separators is a usage error for show and remove; nothing is removed', async () => {
    const daemon = await fakeDaemon()
    for (const sub of ['show', 'remove']) {
      for (const sel of [' ', '·', '· ', '-']) {
        const out = await run(daemon.port, sub === 'remove' ? [sub, sel, '--yes'] : [sub, sel])
        expect(out.status).toBe(1)
        expect(out.stderr).toContain('Usage: harness devices show|remove <#|fingerprint>')
      }
    }
    expect(daemon.removed).toEqual([])
  }, 60_000)

  it('a key-code start under 4 characters is confirmed like a number: refused without a terminal, --yes echoes and removes', async () => {
    const daemon = await fakeDaemon()
    for (const sel of ['a', 'AA', 'aaa']) {
      const refused = await run(daemon.port, ['remove', sel])
      expect(refused.status).toBe(1)
      expect(refused.stderr).toContain('without a terminal to confirm')
      expect(refused.stderr).toContain('harness devices remove AAAA·BBBB·CCCC·DDDD')
    }
    expect(daemon.removed).toEqual([])
    const removed = await run(daemon.port, ['remove', 'aa', '--yes'])
    expect(removed.status).toBe(0)
    expect(daemon.removed).toEqual(['pub-old'])
  }, 60_000)

  it('a key-code start of 4 or more characters still removes without --yes', async () => {
    const daemon = await fakeDaemon()
    const removed = await run(daemon.port, ['remove', 'aaaa'])
    expect(removed.status).toBe(0)
    expect(daemon.removed).toEqual(['pub-old'])
  }, 30_000)

  it('a letter key-code prefix works for show and remove', async () => {
    const daemon = await fakeDaemon()
    expect((await run(daemon.port, ['show', 'AAAA·B'])).stdout).toContain('old-box')
    expect((await run(daemon.port, ['remove', 'aaaabbbb'])).status).toBe(0)
    expect(daemon.removed).toEqual(['pub-old'])
  }, 30_000)

  it('a key-code prefix that matches more than one device is refused for show and remove, even with --yes', async () => {
    // A twin of old-box whose key code shares its first two groups: AAAA·BBBB names neither.
    const twin = { pub: 'pub-twin', kind: 'machine', machineId: 'm_twin00000', label: 'twin-box', addedAt: now - 50 * DAY, seq: 4, fingerprint: 'AAAA·BBBB·9999·0000', self: false }
    const daemon = await fakeDaemon(undefined, [...MEMBERS, twin])
    for (const sel of ['a', 'AAAA', 'aaaa-bbbb', 'AAAA·BBBB']) {
      const shown = await run(daemon.port, ['show', sel])
      expect(shown.status).toBe(1)
      expect(shown.stderr).toContain(`More than one device matches "${sel}"`)
      for (const args of [['remove', sel], ['remove', sel, '--yes']]) {
        const out = await run(daemon.port, args)
        expect(out.status).toBe(1)
        expect(out.stderr).toContain(`More than one device matches "${sel}"`)
      }
    }
    expect(daemon.removed).toEqual([])
    // One character more tells them apart.
    expect((await run(daemon.port, ['show', 'AAAA·BBBB·9'])).stdout).toContain('twin-box')
    const removed = await run(daemon.port, ['remove', 'AAAA·BBBB·9'])
    expect(removed.status).toBe(0)
    expect(daemon.removed).toEqual(['pub-twin'])
  }, 90_000)

  it('show on this machine says so', async () => {
    const { port } = await fakeDaemon()
    const { stdout } = await run(port, ['show', '2'])
    expect(stdout).toContain('mbp  (this machine)')
    expect(stdout).toContain('This is this machine.')
  }, 20_000)

  it('an unknown or missing selector fails with the usual message', async () => {
    const { port } = await fakeDaemon()
    const none = await run(port, ['show', '9'])
    expect(none.status).toBe(1)
    expect(none.stderr).toContain('No device #9')
    const noPrefix = await run(port, ['show', 'ZZZZ'])
    expect(noPrefix.stderr).toContain('No device matches "ZZZZ"')
    const usage = await run(port, ['show'])
    expect(usage.status).toBe(1)
    expect(usage.stderr).toContain('Usage: harness devices show|remove <#|fingerprint>')
  }, 20_000)

  it.skipIf(!HAS_SCRIPT)('remove by number at a terminal names the device and removes it on y', async () => {
    const daemon = await fakeDaemon()
    const { status, screen } = await runAtTerminal(daemon.port, ['remove', '1'], 'y')
    expect(screen).toContain('Remove "old-box"  AAAA·BBBB·CCCC·DDDD?  It is signed out and its key is spent. [y/N]')
    expect(screen).toContain('Removed old-box')
    expect(status).toBe(0)
    expect(daemon.removed).toEqual(['pub-old'])
  }, 30_000)

  it.skipIf(!HAS_SCRIPT)('remove by number at a terminal removes nothing on anything but yes', async () => {
    const daemon = await fakeDaemon()
    const no = await runAtTerminal(daemon.port, ['remove', '3'], 'n')
    expect(no.screen).toContain('Remove "phone"  1111·2222·3333·4444?')
    expect(no.screen).toContain('Cancelled — nothing removed.')
    expect(no.status).toBe(0)
    const enter = await runAtTerminal(daemon.port, ['remove', '3'], '')
    expect(enter.screen).toContain('Cancelled — nothing removed.')
    expect(daemon.removed).toEqual([])
  }, 30_000)

  it.skipIf(!HAS_SCRIPT)('remove by number refuses when only stdin is a terminal (the question would not be seen)', async () => {
    const daemon = await fakeDaemon()
    const { status, screen } = await runAtTerminal(daemon.port, ['remove', '1'], 'y', true)
    expect(screen).toContain('without a terminal to confirm')
    expect(screen).not.toContain('[y/N]')
    expect(status).not.toBe(0)
    expect(daemon.removed).toEqual([])
  }, 30_000)

  it('history prints the rows and says when older history needs a connection', async () => {
    const { port } = await fakeDaemon(undefined, undefined, {}, true)
    const { status, stdout } = await run(port, ['history'])
    expect(status).toBe(0)
    expect(stdout).toContain('Device history, newest first (as this machine verified it):')
    expect(stdout).toContain('  3  1 Oct 2026, 14:05  added  phone  app  1111·2222·3333·4444  new')
    expect(stdout).toContain('Older history needs a connection.')
    const asJson = await run(port, ['history', '--json'])
    expect(JSON.parse(asJson.stdout.trim()).rows).toHaveLength(1)
  }, 20_000)

  it('history and dismiss against a daemon that predates them print the restart hint and exit 1', async () => {
    const { port } = await fakeDaemon()
    for (const args of [['history'], ['dismiss']]) {
      const r = await run(port, args)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('This needs a newer Harness running here. Restart it: harness stop && harness start')
    }
  }, 30_000)

  it('rebaseline --yes previews, then confirms with the previewed head', async () => {
    rebaseConflict = false
    const d = await fakeDaemon(undefined, MEMBERS, {}, true)
    const { status, stdout } = await run(d.port, ['rebaseline', '--yes'])
    expect(status).toBe(0)
    expect(d.rebased).toEqual([{ confirm: false }, { confirm: true, head: { seq: 7, hash: 'h7' } }])
    expect(stdout).toContain('+ added')
    expect(stdout).toContain('✓ Done.')
    expect(stdout).not.toContain('would')
  })

  it('rebaseline --yes refuses when the list changed after the preview', async () => {
    rebaseConflict = true
    try {
      const d = await fakeDaemon(undefined, MEMBERS, {}, true)
      const { status, stderr, stdout } = await run(d.port, ['rebaseline', '--yes'])
      expect(status).toBe(1)
      expect(stderr).toContain('The device list changed while you were reviewing it. Run it again.')
      expect(stdout).not.toContain('Done')
    } finally { rebaseConflict = false }
  })

  for (const at of ['preview', 'confirm'] as const) {
    it(`rebaseline tells to sign in again when the list is another account's (${at})`, async () => {
      rebaseOther = at
      try {
        const d = await fakeDaemon(undefined, MEMBERS, {}, true)
        const { status, stderr, stdout } = await run(d.port, ['rebaseline', '--yes'])
        expect(status).toBe(1)
        expect(stderr).toContain('  ✗ The device list now belongs to a different account than the one you signed in with. Sign in again (harness login) to switch accounts.')
        expect(stderr).not.toContain('changed while you were reviewing')
        expect(stdout).not.toContain('Done')
        expect(stdout).not.toContain('would')
        expect(d.rebased).toHaveLength(at === 'preview' ? 1 : 2)
      } finally { rebaseOther = 'no' }
    })
  }

  it('dismiss marks everything, or one device, as seen', async () => {
    const d = await fakeDaemon(undefined, undefined, {}, true)
    const all = await run(d.port, ['dismiss'])
    expect(all.stdout).toContain('Marked every device as seen.')
    const one = await run(d.port, ['dismiss', '3'])
    expect(one.stdout).toContain('Marked phone as seen.')
    expect(d.dismissed).toEqual([{}, { pub: 'pub-new' }])
  }, 30_000)

  it('lists a key that joined and left before you looked, and dismisses it by its key code', async () => {
    const d = await fakeDaemon(undefined, undefined, {
      departed: [{ pub: 'pub-gone', label: 'Chrome', kind: 'viewer', machineId: '', fingerprint: '7777·6666·5555·4444', addedAt: now - DAY, removedAt: now, removedBy: 'pub-gone', removedByLabel: '', selfRemoved: true }],
    }, true)
    const list = await run(d.port, ['list'])
    expect(list.stdout).toContain('⚠ Chrome joined and left before you looked — mark it seen: harness devices dismiss 7777·6666·5555·4444')
    const one = await run(d.port, ['dismiss', '7777·6666'])
    expect(one.stdout).toContain('Marked Chrome as seen.')
    expect(d.dismissed).toEqual([{ pub: 'pub-gone' }])
  }, 30_000)

  it('list flags only what the daemon says is pending, and shows the conflict and suspended lines', async () => {
    const members = MEMBERS.map((m) => ({ ...m, pending: m.pub === 'pub-old', suspended: m.pub === 'pub-new' }))
    const { port } = await fakeDaemon(undefined, members as never, {
      pending: ['pub-old'], suspended: ['pub-new'], conflict: { pub: 'h', label: 'older', fingerprint: '9999·8888', addedAt: now - DAY, afterJoin: false },
    })
    const { stdout } = await run(port, ['list'])
    expect(stdout).toMatch(/old-box.*  new$/m)
    expect(stdout).toMatch(/phone.*  suspended$/m)
    expect(stdout).toContain('This computer is held by another key on your account: older')
    expect(stdout).toContain('Not trusted here until you review the list: phone')
    expect(stdout).toContain('harness devices dismiss')
  }, 20_000)
})
