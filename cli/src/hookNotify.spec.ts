import { execFileSync, spawn, spawnSync } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import { createServer, type IncomingHttpHeaders } from 'http'
import { connect as netConnect, createServer as createNetServer } from 'net'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observedTitle } from './cable/hosts/observedTitle.js'
import { MAX_HINTS, MAX_TITLE, parseObservedHook } from './core/observedHook.js'
import { ENGINES } from './engines/types.js'
import { HARNESS_OWNER_OPTION, HARNESS_SESSION_PREFIX, harnessPaneOwner, ownerCommand, paneOwnerFormat } from './lib/harnessSessionLabel.js'
import { hookRouteFile, publishHookRoute } from './lib/hookRoutes.js'
import { hookTokenPath } from './lib/hookAuth.js'
import { isTrustedLocal, listenLocalSocket, localSocketName, socketPathIn } from './lib/localSocket.js'
import { writeExecutable } from './testing/executableFixture.js'

// Every case here spawns the real hook as a child process, and several spawn shell shims for tmux, ps
// and sqlite3 on top of that: its hooks get the room the suite gives each case (vitest.config.ts).
vi.setConfig({ hookTimeout: 30_000 })

const HOOK = fileURLToPath(new URL('../hook/notify.mjs', import.meta.url))
/** A preload that moves `Date` by the milliseconds in a file (e2e/harness/clockShift.mjs). */
const CLOCK_SHIFT = fileURLToPath(new URL('../e2e/harness/clockShift.mjs', import.meta.url))
const servers: ReturnType<typeof createServer>[] = []
const netServers: ReturnType<typeof createNetServer>[] = []
const tmpDirs: string[] = []
/** The daemon's pipe servers of the Windows cases, each closed with its own close. */
const pipeServers: Array<() => Promise<void>> = []

/** A pid that ran and has exited: a daemon that is gone. */
function exitedPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid!
}

function writeLegacyStateFile(path: string, value: string): void {
  writeFileSync(path, value, { mode: 0o644 })
  chmodSync(path, 0o644)
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(netServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(pipeServers.splice(0).map((close) => close()))
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * The daemon's socket, as the hook now reaches it (audit H1), in front of a test's fake daemon on [port]. A connection
 * to a port nobody holds is cut, as a daemon that is down. A folder that does not exist yet stays without one.
 */
/** A home short enough to hold the hook's socket folder (lib/localSocket.ts shortSocketFolder) on any machine, even under
 *  an agent's long TMPDIR, so a case about the socket route takes it. */
function shortHome(): string {
  const home = mkdtempSync('/tmp/hh-')
  tmpDirs.push(home)
  return home
}

/** The daemon's way in, where the hook looks for it (lib/localSocket.ts socketPathIn, mirrored in hook/notify.mjs): its
 *  socket beside the data, or in a short folder under `home` when that path is too long for a socket. With no path short
 *  enough the hook posts to the port with the hook-only token, which the daemon keeps beside its data. */
async function daemonSocketFor(port: number, dataDir: string | undefined, home?: string): Promise<void> {
  if (!dataDir || !existsSync(dataDir)) return
  const path = socketPathIn(dataDir, localSocketName(port), home)
  if (!path) {
    try { writeFileSync(hookTokenPath(dataDir), `${'b'.repeat(43)}\n`, { mode: 0o600, flag: 'wx' }) } catch { /* already exists */ }
    return
  }
  await proxySocket(path, port)
}

/** A socket at [path] in front of a test's fake daemon on [port], unless one is there. */
async function proxySocket(path: string, port: number): Promise<void> {
  if (existsSync(path)) return
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const proxy = createNetServer((client) => {
    const upstream = netConnect(port, '127.0.0.1')
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
    client.pipe(upstream).pipe(client)
  })
  netServers.push(proxy)
  await new Promise<void>((resolve) => { proxy.listen(path, resolve) })
  chmodSync(path, 0o600)
}

interface RunHookOpts {
  port: number
  tmuxPane?: string
  /** Legacy environment noise: process-owned hooks must behave the same with or without it. */
  launcherId?: string | null
  /** Install deterministic tmux/ps fixtures so an offline fallback can prove process ownership. */
  processEngine?: 'claude' | 'codex' | 'cursor' | 'hermes' | 'devin' | 'commandcode' | 'grok'
  /** The tmux session the pane is in, and the daemon tag on it (`@harness_daemon`). */
  paneSession?: string
  paneOwner?: string
  /** How long the fake tmux takes to answer each call, in seconds: a hook that spent its budget early. */
  tmuxDelaySeconds?: number
  /** Override the fixture's ps `comm` and full argv to exercise install-root-independent matching. */
  processExecutable?: string
  processArgs?: string
  /** The hook's parent is Hermes' shared gateway (a child of the pane's Hermes), as every hook is from Hermes 0.22. */
  viaHermesGateway?: boolean
  /** Kernel birth evidence for the synthetic process; never read an unrelated host pid. */
  nativeProcess?: 'linux' | 'missing' | 'changed' | 'lock-replaced' | 'boot-replaced' | 'registry-replaced'
    | 'zombie' | 'registry-zombie' | 'registry-command' | 'registry-reparented' | 'short' | 'wrong-pid'
  engine?: 'claude' | 'codex' | 'cursor' | 'hermes' | 'devin' | 'commandcode' | 'grok' | 'copilot' | 'agy'
  /** More of the installed command line: Copilot's and agy's event flags, agy's home. */
  args?: string[]
  /** Run as on Windows: the process table comes from `harness-pty ps --json` (a fake), and `ps` fails. */
  windowsProcessTable?: boolean
  env?: Record<string, string>
  dataDir?: string
  claudeProjectsDir?: string
  codexHome?: string
  cursorHome?: string
  hermesHome?: string
  /** Fake Hermes SQLite source; null means the session row has not appeared. */
  hermesSource?: 'cli' | 'tui' | 'subagent' | null | { source: string; created_source: string | null }
  /** How long Hermes' store takes to answer, in the shipped hook's seconds: a loaded machine. Stretched
   *  as the hook stretches its own step limits under HARNESS_HOOK_DEADLINE_MS (notify.mjs STEP_SCALE),
   *  so the delay keeps the same share of the sqlite3 limit whatever the budget. */
  hermesDelaySeconds?: number
  grokHome?: string
  devinHome?: string
  input?: Record<string, unknown>
  /** The command lines the hook is run through, outermost first: each hands the rest of the line on as `"$0" "$@"`. */
  via?: string[][]
  /** Linux's /proc as the hook's climb reads it, faked on any platform (`process.platform` reads 'linux'): the hook's
   *  ancestors, nearest first. The first is the hook's real parent; the row at index n > 0 has pid 9000 + n; each one's
   *  parent is the next, and the last one's is pid 1. null is a process /proc cannot show (ENOENT). Only
   *  /proc/<pid>/stat and /proc/<pid>/cmdline of these pids are answered; cmdline is argv joined and ended by NUL. */
  procAncestors?: Array<{ comm: string; argv: string[] } | null>
  /** Every path under /proc the hook reads is appended here, one a line. The file is not made when it reads none. */
  procReadLog?: string
}

function runHook(opts: RunHookOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    delete env.HARNESS_PANE
    // The hook abandons its optional work (including the offline registry fallback) when its 4.5s
    // wall-clock budget runs out. Under a full parallel run that budget is spent on host load, not on
    // the hook, and the assertion below then reads a registry nobody wrote — measured as roughly one
    // failure in five full-suite runs. Give the child room so these specs test behaviour, not the load
    // on the machine running them.
    env.HARNESS_HOOK_DEADLINE_MS = '30000'
    // Run inside a named herdr or Herdr Core session, the hook would leave out the HERDR_PANE_ID or HC_TERMINAL_ID a
    // spec sets.
    delete env.HERDR_SESSION
    delete env.HC_SESSION
    if (opts.env) Object.assign(env, opts.env)
    delete env.TMUX_PANE
    if (opts.tmuxPane) env.TMUX_PANE = opts.tmuxPane
    // Every hook asks tmux whose pane it is (notify.mjs routeToPaneOwner). Without a shim below, that
    // question must reach no server at all, least of all the developer's: TMUX outranks TMUX_TMPDIR, and
    // TMUX_TMPDIR has to exist or tmux falls back to the default socket.
    delete env.TMUX
    env.TMUX_TMPDIR = mkdtempSync(join(tmpdir(), 'adapter-hook-tmux-'))
    tmpDirs.push(env.TMUX_TMPDIR)
    delete env.MACHINE_ID
    if (opts.launcherId !== null) env.MACHINE_ID = opts.launcherId ?? '11111111-2222-4333-8444-555555555555'
    if (opts.processEngine || opts.paneOwner !== undefined || opts.paneSession !== undefined) {
      const binDir = mkdtempSync(join(tmpdir(), 'adapter-hook-bin-'))
      tmpDirs.push(binDir)
      const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
      // The pane as tmux describes it: its root process, and the session and tag that say whose agent it
      // is (a Harness session, untagged, unless the test says otherwise).
      const paneFacts = `${opts.paneSession ?? 'harness-claude-1790000000000'}|${opts.paneOwner ?? ''}`
      const tmuxDelay = opts.tmuxDelaySeconds ? `sleep ${opts.tmuxDelaySeconds}\n` : ''
      writeExecutable(join(binDir, 'tmux'), `#!/bin/sh\n${tmuxDelay}printf '%s\\n' ${shellQuote(`7000|${paneFacts}`)}\n`)
      env.PATH = `${binDir}:${env.PATH ?? ''}`
    }
    if (opts.processEngine) {
      const binDir = mkdtempSync(join(tmpdir(), 'adapter-hook-bin-'))
      tmpDirs.push(binDir)
      const executable = opts.processExecutable ?? (opts.processEngine === 'cursor' ? 'agent' : opts.processEngine)
      const processArgs = opts.processArgs ?? executable
      const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
      if (opts.windowsProcessTable) {
        // The same three processes as the `ps` below, as the host lists them, with one it could not open.
        const table = { rows: [
          { pid: 4, parentPid: 0, executable: 'System', startMarker: '', args: 'System', nativeArgv: ['System'] },
          { pid: 7000, parentPid: 1, executable: 'pwsh.exe', startMarker: 'w:133000000000000000', args: 'pwsh.exe', nativeArgv: ['pwsh.exe'] },
          { pid: 7001, parentPid: 7000, executable, startMarker: 'w:133000000000000001', args: processArgs, nativeArgv: processArgs.split(' ') },
          { pid: process.pid, parentPid: 7001, executable: 'node.exe', startMarker: 'w:133000000000000002', args: 'hook-parent', nativeArgv: ['hook-parent'] },
        ] }
        writeExecutable(join(binDir, 'harness-pty'), `#!/bin/sh\n[ "$1 $2" = "ps --json" ] || exit 2\nprintf '%s\\n' ${shellQuote(JSON.stringify(table))}\n`)
        env.HARNESS_PTY_BIN = join(binDir, 'harness-pty')
        writeFileSync(join(binDir, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
      } else {
        // Hermes 0.22+: the hook comes from the shared gateway the pane's Hermes started, not from that Hermes.
        const gateway = opts.viaHermesGateway ? ` '7002 7001 python3 Mon Aug 10 10:00:02 2026 python3 -m hermes_cli.main gateway run --quiet --idle-exit'` : ''
        // In macOS's legacy mode `ps -e` lists every process's environment; this one answers nothing in it instead.
        writeExecutable(join(binDir, 'ps'), `#!/bin/sh\n[ "$COMMAND_MODE" = legacy ] && exit 1\nprintf '%s\\n' '7000 1 zsh Mon Aug 10 10:00:00 2026 -zsh' ${shellQuote(`7001 7000 ${executable} Mon Aug 10 10:00:01 2026 ${processArgs}`)}${gateway} '${process.pid} ${opts.viaHermesGateway ? 7002 : 7001} node Mon Aug 10 10:00:02 2026 hook-parent'\n`)
      }
      const nativeFixture = join(binDir, 'native-process.mjs')
      writeFileSync(nativeFixture, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
${opts.nativeProcess ? "Object.defineProperty(process, 'platform', { value: 'linux' });" : ''}
${opts.windowsProcessTable ? "Object.defineProperty(process, 'platform', { value: 'win32' });" : ''}
const original = fs.readFileSync, open = fs.openSync, close = fs.closeSync, sync = fs.fsyncSync;
const opened = new Map(), fault = ${JSON.stringify(opts.nativeProcess ?? '')}; let reads = 0, replaced = false;
fs.openSync = (path, ...args) => { const fd = open(path, ...args); opened.set(fd, String(path)); return fd; };
fs.closeSync = (fd, ...args) => { opened.delete(fd); return close(fd, ...args); };
fs.fsyncSync = (fd, ...args) => {
  const result = sync(fd, ...args), path = opened.get(fd) || '';
  if (fault === 'lock-replaced' && path.endsWith('/registry.json.lock/owner.json')
    || fault === 'boot-replaced' && path.includes('/registry-boot.') && path.endsWith('.tmp')
    || fault.startsWith('registry-') && path.includes('/registry.json.') && path.endsWith('.tmp')) replaced = true;
  return result;
};
fs.readFileSync = (path, ...args) => {
  if (String(path) !== '/proc/7001/stat') return original(path, ...args);
  if (fault === 'missing') throw Object.assign(Error('fixture process unavailable'), { code: 'ENOENT' });
  if (fault === 'short') return '7001 (claude) S 7000\\n';
  const ticks = fault === 'changed' && reads++ > 0 || replaced && fault.endsWith('-replaced') ? 12346 : 12345;
  const state = fault === 'zombie' || fault === 'registry-zombie' && replaced ? 'Z' : 'S';
  const command = fault === 'registry-command' && replaced ? 'replacement' : ${JSON.stringify(executable)};
  const parent = fault === 'registry-reparented' && replaced ? 1 : 7000;
  return (fault === 'wrong-pid' ? '7002' : '7001') + ' (' + command + ') ' + state
    + ' ' + parent + ' ' + Array(17).fill(0).join(' ') + ' ' + ticks + ' ' + Array(30).fill(0).join(' ') + '\\n';
}; syncBuiltinESMExports();\n`)
      env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import ${nativeFixture}`.trim()
      if (opts.processEngine === 'cursor') {
        const target = join(binDir, 'cursor-agent-target')
        writeFileSync(target, '#!/bin/sh\n', { mode: 0o755 })
        symlinkSync(target, join(binDir, 'agent'))
        symlinkSync(target, join(binDir, 'cursor-agent'))
      } else if (opts.processEngine === 'grok') {
        const target = join(binDir, 'grok-target')
        writeFileSync(target, '#!/bin/sh\n', { mode: 0o755 })
        symlinkSync(target, join(binDir, 'agent'))
        symlinkSync(target, join(binDir, 'grok'))
      }
      if (opts.hermesSource !== undefined) {
        const rows = opts.hermesSource === null ? '[]'
          : JSON.stringify([typeof opts.hermesSource === 'object' ? opts.hermesSource : { source: opts.hermesSource }])
        const stepScale = Number(env.HARNESS_HOOK_DEADLINE_MS) / 4500
        const delay = opts.hermesDelaySeconds ? `sleep ${opts.hermesDelaySeconds * stepScale}\n` : ''
        writeExecutable(join(binDir, 'sqlite3'), `#!/bin/sh\n${delay}printf '%s\\n' '${rows}'\n`)
      }
      env.PATH = `${binDir}:${env.PATH ?? ''}`
    }
    if (opts.procAncestors) {
      const fixtureDir = mkdtempSync(join(tmpdir(), 'adapter-hook-proc-'))
      tmpDirs.push(fixtureDir)
      const fixture = join(fixtureDir, 'proc-ancestors.mjs')
      writeFileSync(fixture, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process, 'platform', { value: 'linux' });
const ancestors = ${JSON.stringify(opts.procAncestors)}, original = fs.readFileSync;
const pidAt = (index) => index === 0 ? process.ppid : 9000 + index;
const rows = new Map(ancestors.map((row, index) => [pidAt(index), { row, parent: index + 1 < ancestors.length ? pidAt(index + 1) : 1 }]));
fs.readFileSync = (path, ...args) => {
  const asked = /^\\/proc\\/(\\d+)\\/(stat|cmdline)$/.exec(String(path)), known = asked && rows.get(Number(asked[1]));
  if (!known) return original(path, ...args);
  if (!known.row) throw Object.assign(Error('fixture process unavailable'), { code: 'ENOENT' });
  if (asked[2] === 'cmdline') return known.row.argv.join('\\0') + '\\0';
  return asked[1] + ' (' + known.row.comm + ') S ' + known.parent + ' ' + Array(17).fill(0).join(' ') + ' 12345 '
    + Array(30).fill(0).join(' ') + '\\n';
}; syncBuiltinESMExports();\n`)
      env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import ${fixture}`.trim()
    }
    if (opts.procReadLog) {
      const fixtureDir = mkdtempSync(join(tmpdir(), 'adapter-hook-proc-'))
      tmpDirs.push(fixtureDir)
      const fixture = join(fixtureDir, 'proc-reads.mjs')
      // Imported after proc-ancestors.mjs, so it sees every read the hook makes, faked or not.
      writeFileSync(fixture, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original = fs.readFileSync, log = ${JSON.stringify(opts.procReadLog)};
fs.readFileSync = (path, ...args) => {
  if (String(path).startsWith('/proc/')) fs.appendFileSync(log, String(path) + '\\n');
  return original(path, ...args);
}; syncBuiltinESMExports();\n`)
      env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import ${fixture}`.trim()
    }
    const args = [HOOK, '--port', String(opts.port)]
    if (opts.engine && opts.engine !== 'claude') args.push('--engine', opts.engine)
    if (opts.dataDir) args.push('--data-dir', opts.dataDir)
    if (opts.claudeProjectsDir) args.push('--claude-projects-dir', opts.claudeProjectsDir)
    if (opts.codexHome) args.push('--codex-home', opts.codexHome)
    if (opts.cursorHome) args.push('--cursor-home', opts.cursorHome)
    if (opts.hermesHome) args.push('--hermes-home', opts.hermesHome)
    if (opts.grokHome) args.push('--grok-home', opts.grokHome)
    if (opts.devinHome) args.push('--devin-home', opts.devinHome)
    if (opts.args) args.push(...opts.args)
    const hookDataDir = opts.dataDir || process.env.ADAPTER_DATA_DIR
    if (hookDataDir) {
      mkdirSync(hookDataDir, { recursive: true, mode: 0o700 })
      try { writeFileSync(join(hookDataDir, 'hook-credential'), `${'a'.repeat(43)}\n`, { mode: 0o600, flag: 'wx' }) } catch { /* already exists */ }
    }
    daemonSocketFor(opts.port, hookDataDir, env.HOME).then(() => {
    const [command, ...argv] = [...(opts.via ?? []).flat(), process.execPath, ...args]
    const child = spawn(command, argv, {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`notify.mjs exited ${code}`)))
    child.stdin.end(JSON.stringify(opts.input ?? {
      hook_event_name: 'SessionEnd',
      session_id: 'session-test',
      reason: 'logout',
    }))
    }, reject)
  })
}

/** A throwaway localhost adapter that records every hook POST. */
async function collect(response: Record<string, unknown> = {}, credential?: string): Promise<{ port: number; requests: Array<{ url: string; body: Record<string, unknown> }>; firedAts: Array<string | undefined>; headers: IncomingHttpHeaders[] }> {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  const firedAts: Array<string | undefined> = []
  const headers: IncomingHttpHeaders[] = []
  const server = createServer((req, res) => {
    // Local service discovery may probe a test port. Only hook POSTs belong to this fixture.
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    if (credential && req.headers['x-harness-hook-token'] !== credential) { req.resume(); res.writeHead(401).end(); return }
    let raw = ''
    req.on('data', (chunk) => { raw += chunk.toString() })
    req.on('end', () => {
      requests.push({ url: req.url ?? '', body: JSON.parse(raw) as Record<string, unknown> })
      firedAts.push(req.headers['x-harness-hook-fired-at'] as string | undefined)
      headers.push(req.headers)
      res.end(JSON.stringify(response))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')
  return { port: address.port, requests, firedAts, headers }
}

/**
 * Until the fake daemon has read [count] requests. A post to /api/hook/observed is written, never waited on: the hook
 * exits once it is in the socket (notify.mjs postObserved), so the daemon can read it after the hook is gone. On a loaded
 * machine it did, and a case that read `requests` as the hook exited found none.
 */
function received(requests: unknown[], count = 1): Promise<void> {
  return vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(count), { timeout: 10_000 })
}

describe('hook notify terminal scope', () => {
  it.each(['claude', 'codex'] as const)('ignores a stale %s memory response and only reports ordinary session registration', async engine => {
    const additionalContext = 'Historical coding memory: keep review changes small.'
    const memoryReceiptId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const { port, requests } = await collect({ ok: true, additionalContext, memoryReceiptId })
    const recordings = JSON.parse(readFileSync(new URL('./lib/__fixtures__/prompt-hooks.json', import.meta.url), 'utf8'))
    const input = recordings[engine].input
    const stdout = await runHook({ port, engine, tmuxPane: '%42', input })
    expect(stdout).toBe('')
    expect(requests.map(request => request.url)).toEqual(['/api/hook/session-start'])
  })

  it('never acknowledges a receipt without emitted user-turn context', async () => {
    const { port, requests } = await collect({ ok: true, memoryReceiptId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })
    const recordings = JSON.parse(readFileSync(new URL('./lib/__fixtures__/prompt-hooks.json', import.meta.url), 'utf8'))
    expect(await runHook({ port, engine: 'claude', tmuxPane: '%42', input: recordings.claude.input })).toBe('')
    expect(requests.map(request => request.url)).toEqual(['/api/hook/session-start'])
  })

  it.each(['claude', 'codex'] as const)('does not inject companion context returned by an older adapter into a %s user turn', async engine => {
    const additionalContext = 'Companions collection context: selected GNU; retain this conversation.'
    const { port, requests } = await collect({ ok: true, additionalContext })
    const recordings = JSON.parse(readFileSync(new URL('./lib/__fixtures__/prompt-hooks.json', import.meta.url), 'utf8'))
    const input = recordings[engine].input
    const stdout = await runHook({ port, engine, tmuxPane: '%42', input })
    expect(stdout).toBe('')
    expect(requests[0]?.body.prompt).toBe(input.prompt)
    expect(await runHook({ port, engine, tmuxPane: '%42', input: { ...input, hook_event_name: 'SessionStart' } })).toBe('')
  })
  // What tells a late Stop from the turn the next prompt opened (src/hookServer.ts hookFiredAt).
  it('says when its engine ran it: its own start, no later than it sends', async () => {
    const { port, firedAts } = await collect()
    const recordings = JSON.parse(readFileSync(new URL('./lib/__fixtures__/prompt-hooks.json', import.meta.url), 'utf8'))
    const before = Date.now()
    await runHook({ port, engine: 'claude', tmuxPane: '%42', input: recordings.claude.input })
    const firedAt = Number(firedAts[0])
    expect(Number.isSafeInteger(firedAt)).toBe(true)
    expect(firedAt).toBeGreaterThanOrEqual(before - 1_000)
    expect(firedAt).toBeLessThanOrEqual(Date.now())
  })

  // CI 44381432197 (Linux): the hook paused while it read the time, its fired time came out before its turn's opening
  // record, and the daemon held that turn's end for 2 minutes. A pause between two clock reads moves nothing: 10 s, longer
  // than any start of the hook here, so a fired time taken from two reads always lands before the hook was started.
  it('says when its engine ran it however long the hook pauses while it reads the time', async () => {
    const { port, firedAts } = await collect()
    const recordings = JSON.parse(readFileSync(new URL('./lib/__fixtures__/prompt-hooks.json', import.meta.url), 'utf8'))
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-paused-'))
    tmpDirs.push(dir)
    const preload = join(dir, 'paused.mjs')
    writeFileSync(preload, 'const uptime = process.uptime\nprocess.uptime = () => uptime() + 10\n')
    const before = Date.now()
    await runHook({ port, engine: 'claude', tmuxPane: '%42', input: recordings.claude.input,
      env: { NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` } })
    expect(Number(firedAts[0])).toBeGreaterThanOrEqual(before)
  })

  it.each(['claude', 'codex', 'grok'] as const)('forwards the actual %s accepted prompt without changing the model input', async engine => {
    const { port, requests } = await collect()
    const recordings = JSON.parse(readFileSync(new URL('./lib/__fixtures__/prompt-hooks.json', import.meta.url), 'utf8'))
    const input = recordings[engine].input
    const stdout = await runHook({ port, engine, tmuxPane: '%42', input })
    expect(requests).toContainEqual({ url: '/api/hook/session-start', body: expect.objectContaining({
      hookEvent: 'UserPromptSubmit', prompt: input.prompt, engine,
    }) })
    expect(stdout).toBe('')
  })
  it.each(['claude', 'codex', 'grok'] as const)('still announces an oversized %s prompt so earlier scope is cleared', async engine => {
    const { port, requests } = await collect()
    const recordings = JSON.parse(readFileSync(new URL('./lib/__fixtures__/prompt-hooks.json', import.meta.url), 'utf8'))
    for (const prompt of ['x'.repeat(140_000), '\u0000'.repeat(30_000)]) {
      const stdout = await runHook({ port, engine, tmuxPane: '%42', input: { ...recordings[engine].input, prompt } })
      expect(stdout).toBe('')
    }
    expect(requests).toHaveLength(2)
    for (const request of requests) expect(request).toMatchObject({ url: '/api/hook/session-start', body: {
      hookEvent: 'UserPromptSubmit', prompt: '', engine,
    } })
  })
  it('refuses a symlinked hook credential instead of authenticating with its target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-credential-link-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    const target = join(dir, 'credential-target')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(target, `${'a'.repeat(43)}\n`, { mode: 0o600 })
    symlinkSync(target, join(dataDir, 'hook-credential'))
    const { port, requests } = await collect()

    // The credential goes only over the socket: a home that holds one, whatever this machine's TMPDIR.
    await runHook({ port, tmuxPane: '%42', dataDir, env: { HOME: shortHome() } })

    expect(requests).toEqual([])
  })

  it('rejects a hook credential FIFO without blocking', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-credential-fifo-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    mkdirSync(dataDir, { mode: 0o700 })
    const credential = join(dataDir, 'hook-credential')
    execFileSync('mkfifo', [credential])

    const result = spawnSync(process.execPath, [HOOK, '--port', '9', '--data-dir', dataDir], {
      encoding: 'utf8',
      env: { ...process.env, TMUX_PANE: '%42' },
      input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'fifo', reason: 'logout' }),
      timeout: 1_500,
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(statSync(credential).isFIFO()).toBe(true)
  })

  it.each(['applied', 'pending', 'duplicate'])('forwards Cursor Task/stop hooks and retains tasks unless completion was applied: %s', async acknowledgement => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-cursor-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    const cursorHome = join(dir, 'cursor')
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const deliveries: unknown[] = []
    const server = createServer((req, res) => {
      if (req.method !== 'POST') { res.writeHead(405).end(); return }
      let raw = ''
      req.on('data', (chunk) => { raw += chunk.toString() })
      req.on('end', () => {
        requests.push({ url: req.url ?? '', body: JSON.parse(raw) as Record<string, unknown> })
        deliveries.push([req.headers['x-harness-hook-delivery-id'], req.headers['x-harness-hook-fired-at']])
        res.end(req.url === '/api/hook/turn-stop' && acknowledgement !== 'applied'
          ? JSON.stringify({ [acknowledgement]: true }) : '{}')
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

    const stdout = await runHook({
      port: address.port,
      tmuxPane: '%21',
      engine: 'cursor',
      dataDir,
      cursorHome,
      input: {
        hook_event_name: 'preToolUse',
        session_id: 'cursor-session',
        tool_name: 'Task',
        tool_use_id: 'call-1',
        tool_input: { description: 'Inspect', prompt: 'Read code', model: 'inherit' },
        user_email: 'must-not-leak@example.com',
      },
    })
    expect(stdout).toBe('{}\n')
    expect(requests).toEqual([{
      url: '/api/hook/tool-start',
      body: {
        sessionId: 'cursor-session',
        toolUseId: 'call-1',
        toolName: 'Task',
        input: { description: 'Inspect', prompt: 'Read code', model: 'inherit' },
        engine: 'cursor',
        tmuxPane: '%21',
        runtimeHints: [{ backend: 'tmux', paneId: '%21' }],
        callerPid: expect.any(Number),
      },
    }])
    expect(JSON.parse(readFileSync(join(dataDir, 'cursor-pending-tasks.json'), 'utf8'))).toMatchObject([{
      sessionId: 'cursor-session',
      toolUseId: 'call-1',
    }])

    requests.splice(0)
    deliveries.splice(0)
    await runHook({
      port: address.port,
      tmuxPane: '%21',
      engine: 'cursor',
      dataDir,
      cursorHome,
      input: {
        hook_event_name: 'stop',
        status: 'error',
        session_id: 'cursor-session',
        workspace_roots: ['/tmp/cursor-workspace'],
        cursor_version: '2026.07.20-8cc9c0b',
      },
    })
    expect(requests.map((request) => request.url)).toEqual([
      '/api/hook/session-start',
      '/api/hook/turn-stop',
    ])
    expect(requests.map(request => request.body.status)).toEqual(['error', 'error'])
    expect(deliveries[0]).toEqual(deliveries[1])
    if (acknowledgement !== 'applied') {
      expect(() => readFileSync(join(dataDir, 'cursor-pending-tasks.json'), 'utf8')).not.toThrow()
      expect(JSON.parse(readFileSync(join(dataDir, 'cursor-pending-tasks.json'), 'utf8'))).toHaveLength(1)
    }
    else expect(() => readFileSync(join(dataDir, 'cursor-pending-tasks.json'), 'utf8')).toThrow()
  })

  it('keeps a Cursor session\'s tasks when its end was not answered in time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-cursor-late-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    const cursorHome = join(dir, 'cursor')
    let slow = false
    const server = createServer((req, res) => {
      if (slow) { setTimeout(() => { try { res.end('{}') } catch { /* the hook has gone */ } }, 2_000).unref(); return }
      req.resume()
      req.on('end', () => res.end('{}'))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')
    const hook = (input: Record<string, unknown>) => runHook({ port: address.port, tmuxPane: '%21', engine: 'cursor', dataDir, cursorHome, input })
    await hook({ hook_event_name: 'preToolUse', session_id: 'cursor-session', tool_name: 'Task', tool_use_id: 'call-1', tool_input: { description: 'Inspect', prompt: 'Read code' } })
    const tasks = () => JSON.parse(readFileSync(join(dataDir, 'cursor-pending-tasks.json'), 'utf8')) as unknown[]
    expect(tasks()).toHaveLength(1)
    slow = true
    await hook({ hook_event_name: 'sessionEnd', session_id: 'cursor-session', reason: 'logout' })
    expect(tasks()).toHaveLength(1)
  })

  it('ignores Cursor background agents without leaking them into the registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-cursor-background-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    const output = await runHook({
      port: 9,
      tmuxPane: '%22',
      engine: 'cursor',
      dataDir,
      cursorHome: join(dir, 'cursor'),
      input: {
        hook_event_name: 'sessionStart',
        session_id: 'background',
        is_background_agent: true,
      },
    })
    expect(output).toBe('{}\n')
    expect(() => readFileSync(join(dataDir, 'registry.json'), 'utf8')).toThrow()
  })

  it('ignores Codex subagent rollouts instead of replacing the parent transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-codex-subagent-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    const codexHome = join(dir, 'codex')
    const childId = '019f8dae-e5f4-7c11-90d1-600854063b2c'
    const parentId = '019f7f1b-195d-70f2-861b-de5d54a3e141'
    const transcriptPath = join(codexHome, 'sessions', '2026', '07', `rollout-${childId}.jsonl`)
    mkdirSync(join(transcriptPath, '..'), { recursive: true })
    writeFileSync(transcriptPath, JSON.stringify({
      type: 'session_meta',
      payload: {
        id: childId,
        source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } },
      },
    }) + '\n')
    const requests: string[] = []
    const server = createServer((req, res) => {
      requests.push(req.url ?? '')
      req.resume()
      res.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

    await runHook({
      port: address.port,
      tmuxPane: '%8',
      engine: 'codex',
      dataDir,
      codexHome,
      input: {
        hook_event_name: 'SessionStart',
        session_id: parentId,
        transcript_path: transcriptPath,
        cwd: '/tmp/codex',
      },
    })

    expect(requests).toEqual([])
    expect(() => readFileSync(join(dataDir, 'registry.json'), 'utf8')).toThrow()
  })

  it('forwards tmux events regardless of legacy MACHINE_ID', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const server = createServer((req, res) => {
      if (req.method !== 'POST') { res.writeHead(405).end(); return }
      let raw = ''
      req.on('data', (chunk) => { raw += chunk.toString() })
      req.on('end', () => {
        requests.push({ url: req.url ?? '', body: JSON.parse(raw) as Record<string, unknown> })
        res.end('{}')
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

    await runHook({ port: address.port, tmuxPane: '%42', launcherId: null })
    expect(requests).toHaveLength(1)

    await runHook({ port: address.port, tmuxPane: '%42' })
    expect(requests).toHaveLength(2)
    expect(requests.map((request) => request.url)).toEqual(['/api/hook/session-end', '/api/hook/session-end'])
  })

  // An agent's temporary folder on a Mac (~/.harness/cli/data/agent-tmp/…) leaves no room for a socket beside a test's
  // data folder. The hook then looks where the daemon would have put it (#4381): in a short folder under home, or, with
  // home too long as well, nowhere, and it posts to the port with the hook-only token.
  it.each([['a short folder under home', 'short'], ['the port with the hook token', 'tcp']] as const)(
    'reaches the daemon through %s when its data folder is too long for a socket', async (_route, route) => {
      const { port, requests } = await collect()
      const dir = mkdtempSync(join(tmpdir(), 'hl-'))
      tmpDirs.push(dir)
      const dataDir = join(dir, 'd'.repeat(100))
      const home = route === 'short' ? shortHome() : join(dir, 'h'.repeat(100))
      mkdirSync(home, { recursive: true })

      await runHook({ port, tmuxPane: '%42', dataDir, env: { HOME: home } })

      expect(requests.map((request) => request.url)).toEqual(['/api/hook/session-end'])
    })

  it('tells a standalone SessionEnd only to the devices, and forwards a tmux SessionEnd', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const server = createServer((req, res) => {
      if (req.method !== 'POST') { res.writeHead(405).end(); return }
      let raw = ''
      req.on('data', (chunk) => { raw += chunk.toString() })
      req.on('end', () => {
        requests.push({ url: req.url ?? '', body: JSON.parse(raw) as Record<string, unknown> })
        res.end('{}')
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

    await runHook({ port: address.port })
    await received(requests)
    expect(requests).toEqual([{
      url: '/api/hook/observed',
      body: { engine: 'claude', sessionId: 'session-test', event: 'session-end', callerPid: process.pid, hostHints: expect.any(Object) },
    }])
    requests.length = 0

    await runHook({ port: address.port, tmuxPane: '%42' })
    expect(requests).toEqual([{
      url: '/api/hook/session-end',
      body: {
        sessionId: 'session-test',
        reason: 'logout',
        engine: 'claude',
        tmuxPane: '%42',
        runtimeHints: [{ backend: 'tmux', paneId: '%42' }],
        callerPid: expect.any(Number),
      },
    }])
  })

  it.each(['linux', 'missing', 'changed', 'lock-replaced', 'boot-replaced', 'registry-replaced',
    'zombie', 'registry-zombie', 'registry-command', 'registry-reparented', 'short', 'wrong-pid'] as const)('retains exact offline process birth evidence: %s', async nativeProcess => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-native-birth-')); tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects'), dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-birth.jsonl')
    mkdirSync(dirname(transcriptPath), { recursive: true }); mkdirSync(dataDir)
    writeLegacyStateFile(join(dataDir, 'registry.json'), '[]'); writeFileSync(transcriptPath, '{}\n')
    await runHook({ port: 9, tmuxPane: '%7', processEngine: 'claude', nativeProcess, dataDir, claudeProjectsDir,
      input: { hook_event_name: 'SessionStart', session_id: 'session-birth', transcript_path: transcriptPath, cwd: '/tmp/demo' } })
    const rows = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf8'))
    // Boot confirmation follows the registry's durable commit; a later native change cannot
    // retroactively invalidate the already-published snapshot of that process.
    if (nativeProcess === 'linux' || nativeProcess === 'boot-replaced') expect(rows).toMatchObject([{ sessionId: 'session-birth', processIdentity: { pid: 7001, startTicks: 12345 } }])
    else expect(readFileSync(join(dataDir, 'registry.json'), 'utf8')).toBe('[]')
  })

  it('keeps old boot authority unchanged when native ownership expires during registry staging', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-native-boot-')); tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects'), dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-current.jsonl')
    mkdirSync(dirname(transcriptPath), { recursive: true }); mkdirSync(dataDir)
    const registryFile = join(dataDir, 'registry.json'), bootFile = join(dataDir, 'registry-boot')
    const oldBoot = 'linux:00000000-0000-0000-0000-000000000000'
    const oldRows = JSON.stringify([{ agentId: 'old-boot-agent', sessionId: 'old-boot-session', engine: 'claude', tmuxPane: '%7',
      processIdentity: { pid: 7001, executable: 'claude', startMarker: 'Mon Aug 10 10:00:01 2026', startTicks: 12345 } }])
    writeLegacyStateFile(registryFile, oldRows); writeLegacyStateFile(bootFile, oldBoot); writeFileSync(transcriptPath, '{}\n')
    const input = { hook_event_name: 'SessionStart', session_id: 'session-current', transcript_path: transcriptPath, cwd: '/tmp/demo' }
    await runHook({ port: 9, tmuxPane: '%7', processEngine: 'claude', nativeProcess: 'registry-replaced', dataDir, claudeProjectsDir, input })
    expect(readFileSync(registryFile, 'utf8')).toBe(oldRows)
    expect(readFileSync(bootFile, 'utf8')).toBe(oldBoot)
    await runHook({ port: 9, tmuxPane: '%7', processEngine: 'claude', nativeProcess: 'linux', dataDir, claudeProjectsDir, input })
    const rows = JSON.parse(readFileSync(registryFile, 'utf8'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sessionId: 'session-current', processIdentity: { startTicks: 12345 } })
    expect(rows[0].agentId).not.toBe('old-boot-agent')
    expect(readFileSync(bootFile, 'utf8')).not.toBe(oldBoot)
  })

  it('retains the offline agent and launch choices when precise birth ticks survive a clock adjustment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-native-clock-')); tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects'), dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-clock.jsonl')
    mkdirSync(dirname(transcriptPath), { recursive: true }); mkdirSync(dataDir)
    writeLegacyStateFile(join(dataDir, 'registry.json'), JSON.stringify([{
      agentId: 'kept-agent', engine: 'claude', sessionId: 'session-before', tmuxPane: '%7',
      processIdentity: { pid: 7001, executable: 'claude', startMarker: 'Mon Aug 10 09:00:01 2026', startTicks: 12345 },
      dsh: 'fixture-harness', defaultName: 'Kept name', permissionMode: 'plan',
    }]))
    writeFileSync(transcriptPath, '{}\n')
    await runHook({ port: 9, tmuxPane: '%7', processEngine: 'claude', nativeProcess: 'linux', dataDir, claudeProjectsDir,
      input: { hook_event_name: 'SessionStart', session_id: 'session-clock', transcript_path: transcriptPath, cwd: '/tmp/demo' } })
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf8'))).toMatchObject([{
      agentId: 'kept-agent', sessionId: 'session-clock', dsh: 'fixture-harness', defaultName: 'Kept name', permissionMode: 'plan',
      processIdentity: { pid: 7001, startTicks: 12345, startMarker: 'Mon Aug 10 10:00:01 2026' },
    }])
    // Invalid saved birth evidence is recovery data, not permission to replace the existing row.
    const rows = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf8'))
    rows[0].processIdentity.startTicks = 'unreadable'
    const invalid = JSON.stringify(rows)
    writeFileSync(join(dataDir, 'registry.json'), invalid)
    await runHook({ port: 9, tmuxPane: '%7', processEngine: 'claude', nativeProcess: 'linux', dataDir, claudeProjectsDir,
      input: { hook_event_name: 'SessionStart', session_id: 'session-clock', transcript_path: transcriptPath, cwd: '/tmp/demo' } })
    expect(readFileSync(join(dataDir, 'registry.json'), 'utf8')).toBe(invalid)
  })

  it('falls back to registry.json when SessionStart cannot reach the adapter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-offline-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-1.jsonl')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    chmodSync(dataDir, 0o755)
    writeLegacyStateFile(join(dataDir, 'registry.json'), '[]')
    writeFileSync(transcriptPath, '{}\n')

    await runHook({
      port: 9,
      tmuxPane: '%7',
      processEngine: 'claude',
      dataDir,
      claudeProjectsDir,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'session-1',
        transcript_path: transcriptPath,
        cwd: '/tmp/demo',
        session_title: 'Demo',
        model: 'sonnet',
        cli_version: '1.0.0',
      },
    })

    const registry = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))
    expect(registry).toMatchObject([{
      sessionId: 'session-1',
      engine: 'claude',
      transcriptPath,
      projectDir: 'demo',
      cwd: '/tmp/demo',
      tmuxPane: '%7',
      title: 'Demo',
      model: 'sonnet',
      cliVersion: '1.0.0',
    }])
    expect(statSync(dataDir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dataDir, 'registry.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dataDir, 'registry-boot')).mode & 0o777).toBe(0o600)
  })

  it('runs ps in unix2003 mode whatever mode the person set, so it can never list an environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-command-mode-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-mode.jsonl')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dataDir, 'registry.json'), '[]', { mode: 0o600 })
    writeFileSync(transcriptPath, '{}\n')

    await runHook({
      port: 9, tmuxPane: '%7', processEngine: 'claude', dataDir, claudeProjectsDir, env: { COMMAND_MODE: 'legacy' },
      input: { hook_event_name: 'SessionStart', session_id: 'session-mode', transcript_path: transcriptPath, cwd: '/tmp/demo' },
    })

    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toMatchObject([{ sessionId: 'session-mode', engine: 'claude', tmuxPane: '%7' }])
  })

  it('reads the process table from harness-pty on Windows, and registers offline with its identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-offline-windows-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-w.jsonl')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dataDir, 'registry.json'), '[]', { mode: 0o600 })
    writeFileSync(transcriptPath, '{}\n')

    await runHook({
      port: 9, tmuxPane: '%7', processEngine: 'claude', windowsProcessTable: true, dataDir, claudeProjectsDir,
      input: { hook_event_name: 'SessionStart', session_id: 'session-w', transcript_path: transcriptPath, cwd: '/tmp/demo' },
    })

    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toMatchObject([{
      sessionId: 'session-w',
      engine: 'claude',
      processIdentity: { pid: 7001, executable: 'claude', startMarker: 'w:133000000000000001' },
    }])
  })

  it('knows Claude Code\'s native exe on Windows by its name without the extension', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-offline-windows-exe-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-x.jsonl')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dataDir, 'registry.json'), '[]', { mode: 0o600 })
    writeFileSync(transcriptPath, '{}\n')

    // The row harness-pty lists for Claude Code's native install (Windows 11, 2026-10-15).
    await runHook({
      port: 9, tmuxPane: '%7', processEngine: 'claude', windowsProcessTable: true, dataDir, claudeProjectsDir,
      processExecutable: 'claude.exe', processArgs: 'C:\\Users\\admin\\.local\\bin\\claude.exe',
      input: { hook_event_name: 'SessionStart', session_id: 'session-x', transcript_path: transcriptPath, cwd: '/tmp/demo' },
    })

    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toMatchObject([{
      sessionId: 'session-x',
      engine: 'claude',
      processIdentity: { pid: 7001, executable: 'claude.exe', startMarker: 'w:133000000000000001' },
    }])
  })

  it('leaves a corrupt offline registry byte-identical instead of replacing it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-offline-corrupt-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-corrupt.jsonl')
    const registryFile = join(dataDir, 'registry.json')
    const corrupt = '[{"schemaVersion":2'
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(transcriptPath, '{}\n')
    writeFileSync(registryFile, corrupt, { mode: 0o600 })

    await runHook({
      port: 9,
      tmuxPane: '%70',
      processEngine: 'claude',
      dataDir,
      claudeProjectsDir,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'session-corrupt',
        transcript_path: transcriptPath,
        cwd: '/tmp/demo',
      },
    })

    expect(readFileSync(registryFile, 'utf8')).toBe(corrupt)
  })

  it('leaves malformed current, future, and legacy rows byte-identical while offline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-offline-invalid-v2-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-invalid-v2.jsonl')
    const registryFile = join(dataDir, 'registry.json')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(transcriptPath, '{}\n')

    for (const bytes of [
      JSON.stringify([{ schemaVersion: 2, agentId: 'damaged' }]),
      JSON.stringify([{ schemaVersion: '3', agentId: 'future' }]),
      JSON.stringify([{}]),
      JSON.stringify([7]),
      JSON.stringify([{ agentId: 'legacy-agent' }]),
    ]) {
      writeFileSync(registryFile, bytes, { mode: 0o600 })
      await runHook({
        port: 9,
        tmuxPane: '%71',
        processEngine: 'claude',
        dataDir,
        claudeProjectsDir,
        input: {
          hook_event_name: 'SessionStart',
          session_id: 'session-invalid-v2',
          transcript_path: transcriptPath,
          cwd: '/tmp/demo',
        },
      })
      expect(readFileSync(registryFile, 'utf8')).toBe(bytes)
    }
  })

  // A step's limit is cut to what is left of the hook's budget, and what is left is a fraction of a
  // millisecond off the whole: `execFile` refuses a fractional timeout (ERR_OUT_OF_RANGE), so once the
  // budget left was under a step's own limit, that step threw, and the offline registration with it.
  // On the shipped 4.5 s budget that is any hook whose earlier steps took a second, as a loaded machine's
  // do. Here tmux answers each of its two calls in 1.5 s of a 9 s budget, which leaves the process scan
  // under its 6 s limit.
  it('still registers offline when its earlier steps took a third of its budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-late-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-late.jsonl')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    writeFileSync(transcriptPath, '{}\n')
    await runHook({
      port: 9,
      tmuxPane: '%7',
      processEngine: 'claude',
      tmuxDelaySeconds: 1.5,
      env: { HARNESS_HOOK_DEADLINE_MS: '9000' },
      dataDir,
      claudeProjectsDir,
      input: { hook_event_name: 'SessionStart', session_id: 'session-late', transcript_path: transcriptPath, cwd: '/tmp/demo' },
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toMatchObject([{ sessionId: 'session-late', tmuxPane: '%7' }])
  })

  it('falls back with Codex engine under CODEX_HOME/sessions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-codex-'))
    tmpDirs.push(dir)
    const codexHome = join(dir, 'codex')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(codexHome, 'sessions', '2026', 'rollout.jsonl')
    mkdirSync(join(codexHome, 'sessions', '2026'), { recursive: true })
    writeFileSync(transcriptPath, '{}\n')

    await runHook({
      port: 9,
      tmuxPane: '%8',
      engine: 'codex',
      processEngine: 'codex',
      processExecutable: 'node',
      processArgs: 'node /nix/store/codex-cli/lib/node_modules/@openai/codex/bin/codex.js',
      dataDir,
      codexHome,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'codex-session',
        transcript_path: transcriptPath,
        cwd: '/tmp/codex',
      },
    })

    const registry = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))
    expect(registry).toMatchObject([{ sessionId: 'codex-session', engine: 'codex', tmuxPane: '%8' }])
  })

  it('does not treat engine names in unrelated process arguments as an offline agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-process-false-positive-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-false.jsonl')
    mkdirSync(join(transcriptPath, '..'), { recursive: true })
    writeFileSync(transcriptPath, '{}\n')

    await runHook({
      port: 9,
      tmuxPane: '%81',
      processEngine: 'claude',
      processExecutable: 'python3',
      processArgs: 'python3 /work/runner.py compare claude codex agent hermes',
      dataDir,
      claudeProjectsDir,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'session-false',
        transcript_path: transcriptPath,
      },
    })

    expect(() => readFileSync(join(dataDir, 'registry.json'), 'utf8')).toThrow()
  })

  it.each(['cli', 'tui'] as const)('offline Hermes fallback binds source=%s and rejects delegation children or unknown rows', async (interactiveSource) => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-hermes-source-'))
    tmpDirs.push(dir)
    const hermesHome = join(dir, 'hermes')
    const cliData = join(dir, 'cli-data')
    const common = {
      port: 9,
      tmuxPane: '%82',
      engine: 'hermes' as const,
      processEngine: 'hermes' as const,
      processExecutable: 'python3',
      processArgs: 'python3 /opt/venvs/hermes/lib/python3.12/site-packages/hermes-agent/hermes',
      hermesHome,
    }

    await runHook({
      ...common,
      dataDir: cliData,
      hermesSource: interactiveSource,
      input: { hook_event_name: 'on_session_start', session_id: '20260810_120000_a1b2c3' },
    })
    expect(JSON.parse(readFileSync(join(cliData, 'registry.json'), 'utf8'))).toMatchObject([{
      sessionId: '20260810_120000_a1b2c3', engine: 'hermes', tmuxPane: '%82',
    }])

    for (const [name, source] of [['child', 'subagent'], ['unknown', null]] as const) {
      const dataDir = join(dir, `${name}-data`)
      await runHook({
        ...common,
        dataDir,
        hermesSource: source,
        input: { hook_event_name: 'on_session_start', session_id: `20260810_12000${name === 'child' ? '1' : '2'}_a1b2c3` },
      })
      expect(() => readFileSync(join(dataDir, 'registry.json'), 'utf8')).toThrow()
    }
  })

  it('offline Hermes fallback binds a Hermes 0.23 local session only when its CLI or TUI created it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-hermes-local-'))
    tmpDirs.push(dir)
    const common = {
      port: 9, tmuxPane: '%82', engine: 'hermes' as const, processEngine: 'hermes' as const, processExecutable: 'python3',
      processArgs: 'python3 /opt/venvs/hermes/lib/python3.12/site-packages/hermes-agent/hermes', hermesHome: join(dir, 'hermes'),
    }
    const local = (n: number) => `local-${String(n).padStart(2, '0').repeat(32)}`
    const cases = [
      ['cli', { source: 'local', created_source: 'cli' }, true], ['tui', { source: 'local', created_source: 'tui' }, true],
      ['acp', { source: 'local', created_source: 'acp' }, false], ['unknown', { source: 'local', created_source: 'unknown' }, false],
      ['child', { source: 'subagent', created_source: null }, false],
    ] as const
    for (const [index, [name, row, binds]] of cases.entries()) {
      const dataDir = join(dir, `${name}-data`)
      await runHook({ ...common, dataDir, hermesSource: row, input: { hook_event_name: 'on_session_start', session_id: local(index + 1) } })
      if (binds) {
        expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf8'))).toMatchObject([{ sessionId: local(index + 1), engine: 'hermes' }])
      } else expect(() => readFileSync(join(dataDir, 'registry.json'), 'utf8')).toThrow()
    }
  })

  it.each(['recovers', 'full', 'resolving', 'disconnects'] as const)('Hermes live admission %s retries within a bound and never writes an offline registry', async outcome => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-hermes-held-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    mkdirSync(dataDir)
    writeLegacyStateFile(join(dataDir, 'registry.json'), '[]')
    let attempts = 0
    const firedAt: unknown[] = []
    const deliveryIds: unknown[] = []
    const server = createServer((req, res) => {
      if (req.method !== 'POST') { req.resume(); res.writeHead(405).end(); return }
      req.resume()
      req.on('end', () => {
        attempts++
        firedAt.push(req.headers['x-harness-hook-fired-at'])
        deliveryIds.push(req.headers['x-harness-hook-delivery-id'])
        if (outcome === 'disconnects' && attempts > 1) { res.destroy(); return }
        if (outcome === 'recovers' && attempts === 3) { res.end(JSON.stringify({ pending: true })); return }
        res.writeHead(outcome === 'resolving' ? 202 : 429)
        res.end(JSON.stringify({ pending: false, retry: true, error: 'HOOK_ADMISSION_BUSY' }))
      })
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('private fixture did not bind')
    expect(await runHook({ port: address.port, tmuxPane: '%82', engine: 'hermes', processEngine: 'hermes',
      processExecutable: 'python3', processArgs: 'python3 /opt/venvs/hermes/lib/python3.12/site-packages/hermes-agent/hermes',
      dataDir, hermesHome: join(dir, 'hermes'), hermesSource: 'cli',
      input: { hook_event_name: 'on_session_start', session_id: '20260810_120000_a1b2c3' },
    })).toBe('{}\n')
    expect(attempts).toBe(outcome === 'recovers' ? 3 : outcome === 'disconnects' ? 2 : 4)
    expect(new Set(firedAt).size).toBe(1)
    expect(new Set(deliveryIds).size).toBe(1)
    expect(deliveryIds[0]).toMatch(/^[a-f0-9-]{36}$/)
    expect(readFileSync(join(dataDir, 'registry.json'), 'utf8')).toBe('[]')
    expect(() => statSync(join(dataDir, 'registry-boot'))).toThrow()
  })

  it.each([
    "import sys, runpy; sys.path.insert(0, '/opt/custom'); runpy.run_module('hermes_cli.main', run_name='__main__')",
    "import os, re, sys; sys.path.insert(0, '/opt/custom'); import hermes_bootstrap; from hermes_cli.main import main; sys.exit(main())",
    "import os, sys, runpy; os.environ.pop('PYTHONHOME', None); sys.path.insert(0, '/opt/custom'); os.environ['HERMES_HOME'] = os.environ.get('HERMES_HOME') or '/home/demo/.hermes'; import hermes_bootstrap; runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)",
    // 0.21.5's multi-line launcher as macOS `ps` prints it: every newline as the four characters `\012`.
    ["import os, re, sys", "os.environ.pop('PYTHONHOME', None)", "sys.path.insert(0, '/opt/custom')",
      'import hermes_bootstrap', 'from hermes_cli.main import main', 'sys.exit(main())'].join('\\012') + '\\012',
  ])('offline Hermes discovery follows a managed Python bootstrap: %s', async (source) => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-hermes-launcher-'))
    tmpDirs.push(dir)
    const common = {
      port: 9, tmuxPane: '%82', engine: 'hermes' as const, processEngine: 'hermes' as const,
      processExecutable: '/home/demo/.her', hermesHome: join(dir, 'hermes'), hermesSource: 'cli' as const,
      input: { hook_event_name: 'on_session_start', session_id: '20260810_120000_a1b2c3' },
    }
    await runHook({ ...common, dataDir: join(dir, 'data'), processArgs: `/opt/python3 -I -I -c ${source}` })
    expect(JSON.parse(readFileSync(join(dir, 'data', 'registry.json'), 'utf8'))).toMatchObject([
      { engine: 'hermes', tmuxPane: '%82', processIdentity: { pid: 7001 } },
    ])
    await runHook({ ...common, dataDir: join(dir, 'unrelated'), processArgs: `python3 worker.py -c ${source}` })
    expect(() => readFileSync(join(dir, 'unrelated', 'registry.json'), 'utf8')).toThrow()
  })

  // From Hermes 0.22 every session's hook runs in one gateway, which the first Hermes client started and which sits under
  // that client's pane: the pane in the hook's environment and its parents are that one, whichever pane the session is in.
  // Offline, the hook cannot tell which pane, so it writes nothing (the daemon reads the session's own pane instead).
  it('writes no offline registration for a Hermes hook from its shared gateway, which belongs to no pane', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-hermes-gateway-'))
    tmpDirs.push(dir)
    const common = {
      port: 9, tmuxPane: '%84', engine: 'hermes' as const, processEngine: 'hermes' as const,
      processExecutable: 'python3', processArgs: 'python3 /opt/venvs/hermes/lib/python3.12/site-packages/hermes-agent/hermes',
      hermesHome: join(dir, 'hermes'), hermesSource: 'cli' as const,
      input: { hook_event_name: 'on_session_start', session_id: '20260810_120004_a1b2c3' },
    }
    await runHook({ ...common, dataDir: join(dir, 'direct') })
    expect(JSON.parse(readFileSync(join(dir, 'direct', 'registry.json'), 'utf8'))).toMatchObject([{ engine: 'hermes', tmuxPane: '%84' }])
    await runHook({ ...common, dataDir: join(dir, 'gateway'), viaHermesGateway: true })
    expect(() => readFileSync(join(dir, 'gateway', 'registry.json'), 'utf8')).toThrow()
  })

  it('still binds a CLI Hermes session when its store is slow to answer, as on a loaded machine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-hermes-slow-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    await runHook({
      port: 9,
      tmuxPane: '%83',
      engine: 'hermes',
      processEngine: 'hermes',
      processExecutable: 'python3',
      processArgs: 'python3 /opt/venvs/hermes/lib/python3.12/site-packages/hermes-agent/hermes',
      hermesHome: join(dir, 'hermes'),
      dataDir,
      hermesSource: 'cli',
      // 1.2 s against the shipped 3 s limit: a store slower than the old 1 s limit still binds. Four times
      // the shipped budget stretches all three (4.8 s against 12 s; the old limit would be 4 s, so this
      // still tells them apart) and leaves a loaded machine over 7 s for what is not the store: starting
      // the hook's fake tmux, ps and sqlite3. At twice the budget (3 s against 6 s, 9 s in all) the earlier
      // steps under a full run at load 110 left sqlite3 less than its 3 s, and nothing was registered.
      hermesDelaySeconds: 1.2,
      env: { HARNESS_HOOK_DEADLINE_MS: '18000' },
      input: { hook_event_name: 'on_session_start', session_id: '20260810_120003_a1b2c3' },
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf8'))).toMatchObject([{
      sessionId: '20260810_120003_a1b2c3', engine: 'hermes', tmuxPane: '%83',
    }])
  })

  it('does not fallback when the adapter accepts the hook event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-online-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-online.jsonl')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    writeFileSync(transcriptPath, '{}\n')

    const server = createServer((_req, res) => res.end('{}'))
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

    await runHook({
      port: address.port,
      tmuxPane: '%9',
      dataDir,
      claudeProjectsDir,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'session-online',
        transcript_path: transcriptPath,
      },
    })

    expect(() => readFileSync(join(dataDir, 'registry.json'), 'utf-8')).toThrow()
  })

  it('does not fall back when the daemon took the event but answers late, as a held daemon does', async () => {
    // A daemon whose event loop is held, or one slow to answer a session-start: the request is in its
    // socket and it handles it once it gets to it. A registry row written behind its back meanwhile was
    // merged over the row the daemon kept, without its name, launch or close plan (e2e/stall.e2e.ts).
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-late-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-late.jsonl')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    chmodSync(dataDir, 0o755)
    writeLegacyStateFile(join(dataDir, 'registry.json'), '[]')
    writeFileSync(transcriptPath, '{}\n')
    const received: string[] = []
    // Takes every request and answers none of them in time.
    const server = createServer((req, res) => {
      received.push(req.url ?? '')
      setTimeout(() => { try { res.end('{}') } catch { /* the hook has gone */ } }, 2_000).unref()
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

    await runHook({
      port: address.port,
      tmuxPane: '%7',
      processEngine: 'claude',
      dataDir,
      claudeProjectsDir,
      input: { hook_event_name: 'SessionStart', session_id: 'session-late', transcript_path: transcriptPath, cwd: '/tmp/demo' },
    })

    expect(received).toContain('/api/hook/session-start')
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toEqual([])
  })

  it.each([['SessionStart', 500], ['SessionStart', 503], ['UserPromptSubmit', 500]] as const)(
    'does not fall back when the daemon answers %s with %i: a daemon that answers is running', async (event, status) => {
      // A 500 taken for an outage wrote a row of the hook's own in place of the agent's, and the running daemon's next
      // save took it in: the agent the daemon had created was gone (e2e/scale.e2e.ts, 2026-11-18).
      const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-refused-'))
      tmpDirs.push(dir)
      const claudeProjectsDir = join(dir, 'claude-projects')
      const dataDir = join(dir, 'data')
      const transcriptPath = join(claudeProjectsDir, 'demo', 'session-refused.jsonl')
      mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
      mkdirSync(dataDir, { recursive: true })
      writeLegacyStateFile(join(dataDir, 'registry.json'), '[]')
      writeFileSync(transcriptPath, '{}\n')
      const received: string[] = []
      const server = createServer((req, res) => {
        received.push(req.url ?? '')
        req.resume()
        res.writeHead(status).end(JSON.stringify({ error: 'INTERNAL' }))
      })
      servers.push(server)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

      await runHook({
        port: address.port,
        tmuxPane: '%7',
        processEngine: 'claude',
        dataDir,
        claudeProjectsDir,
        input: { hook_event_name: event, session_id: 'session-refused', transcript_path: transcriptPath, cwd: '/tmp/demo' },
      })

      expect(received).toContain('/api/hook/session-start')
      expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toEqual([])
    })

  it('does not write fallback registry entries outside tmux or outside the transcript root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-invalid-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const outside = join(dir, 'outside.jsonl')
    mkdirSync(claudeProjectsDir, { recursive: true })
    writeFileSync(outside, '{}\n')

    await runHook({
      port: 9,
      dataDir,
      claudeProjectsDir,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'no-tmux',
        transcript_path: outside,
      },
    })
    await runHook({
      port: 9,
      tmuxPane: '%10',
      dataDir,
      claudeProjectsDir,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'outside',
        transcript_path: outside,
      },
    })

    expect(() => readFileSync(join(dataDir, 'registry.json'), 'utf-8')).toThrow()
  })

  it('leaves offline registry ownership unchanged on SessionEnd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-end-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'registry.json'), JSON.stringify([{ sessionId: 'keep' }, { sessionId: 'ended' }]))

    await runHook({
      port: 9,
      tmuxPane: '%11',
      dataDir,
      input: { hook_event_name: 'SessionEnd', session_id: 'ended', reason: 'logout' },
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toEqual([{ sessionId: 'keep' }, { sessionId: 'ended' }])

    await runHook({
      port: 9,
      tmuxPane: '%11',
      dataDir,
      input: { hook_event_name: 'SessionEnd', session_id: 'keep', reason: 'clear' },
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toEqual([{ sessionId: 'keep' }, { sessionId: 'ended' }])
  })

  it('keeps fallback registry entries when SessionEnd cannot prove the tmux app exited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-end-unknown-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    const binDir = join(dir, 'bin')
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(dataDir, 'registry.json'), JSON.stringify([{ sessionId: 'maybe-alive' }]))
    writeFileSync(join(binDir, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })

    await runHook({
      port: 9,
      tmuxPane: '%13',
      dataDir,
      env: { PATH: `${binDir}:${process.env.PATH ?? ''}` },
      input: { hook_event_name: 'SessionEnd', session_id: 'maybe-alive', reason: 'logout' },
    })

    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toEqual([{ sessionId: 'maybe-alive' }])
  })

  /** What the daemon chose for an agent and keeps on its row, beyond what the process shows (registry.ts
   *  `register()` carries every one): a hook while the daemon is down must not be the write that drops it. */
  const CHOSEN = {
    dsh: 'cad-designer', dshRuntime: '/tmp/dsh/cad-designer/1.2.0', agent: 'reviewer', permissionMode: 'plan',
    subscriptionModel: 'opus', defaultName: 'Claude Code 3', gridWebSearch: true,
    closePlan: { id: 'plan-1', requestedAt: 1_790_000_000_001, identity: 'claude\u0000agent-created', state: 'waiting' },
  }

  it('carries what the daemon chose at launch through an offline re-register', async () => {
    // A hook arriving while the daemon is down rebuilds the row. The grid launch (key included), the
    // Codex profile, the bypass flag and the observed grid are not on the process or in the hook body
    // — they must come from the row being replaced, or this becomes the one write that strips them
    // and the next restart relaunches the agent on the wrong login.
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-carry-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-1.jsonl')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    chmodSync(dataDir, 0o755)
    writeFileSync(transcriptPath, '{}\n')
    const gridLaunch = { networkId: 'grid-abc', networkName: 'Team grid', baseUrl: 'https://grid.example/grid-abc/relay/v1', apiKey: 'gridkey-abc123' }
    writeLegacyStateFile(join(dataDir, 'registry.json'), JSON.stringify([{
      schemaVersion: 2,
      active: true,
      launch: { state: 'starting' },
      agentId: 'agent-created',
      sessionId: '',
      boundAt: null,
      engine: 'claude',
      gateway: null,
      grid: { baseUrl: gridLaunch.baseUrl, model: null },
      gridLaunch,
      codexHome: null,
      bypassPermission: true,
      transcriptPath: null,
      projectDir: 'demo',
      cwd: '/tmp/demo',
      runtimes: [{ backend: 'tmux', paneId: '%7' }],
      primaryRuntimeKey: 'tmux\u0000%7',
      tmuxPane: '%7',
      source: null,
      title: null,
      model: null,
      cliVersion: null,
      processIdentity: { pid: 7001, executable: 'claude', startMarker: 'Mon Aug 10 10:00:01 2026' },
      registeredAt: 1,
      updatedAt: 1,
      lastHookAt: 1,
      lastTranscriptAt: 1,
      // When an app last opened it — every app's "last used" order reads this, so a hook that lands
      // while the daemon is down must not be the write that forgets it.
      lastOpenedAt: 1_790_000_000_000,
      ...CHOSEN,
    }]))

    await runHook({
      port: 9,
      tmuxPane: '%7',
      processEngine: 'claude',
      dataDir,
      claudeProjectsDir,
      input: { hook_event_name: 'SessionStart', session_id: 'session-1', transcript_path: transcriptPath, cwd: '/tmp/demo' },
    })

    const registry = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))
    expect(registry).toHaveLength(1)
    expect(registry[0]).toMatchObject({
      agentId: 'agent-created',
      sessionId: 'session-1',
      grid: { baseUrl: gridLaunch.baseUrl, model: null },
      gridLaunch,
      bypassPermission: true,
      lastOpenedAt: 1_790_000_000_000,
      ...CHOSEN,
    })
    expect(registry[0]).not.toHaveProperty('launch')

    // A row whose launch was a resume only: as the daemon has it, a hook ends that launch.
    const rows = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))
    rows[0] = { ...rows[0], resumeOnly: true, launch: { state: 'starting' } }
    writeLegacyStateFile(join(dataDir, 'registry.json'), JSON.stringify(rows))
    await runHook({
      port: 9, tmuxPane: '%7', processEngine: 'claude', dataDir, claudeProjectsDir,
      input: { hook_event_name: 'UserPromptSubmit', session_id: 'session-1', transcript_path: transcriptPath, cwd: '/tmp/demo', prompt: 'next' },
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))[0]).toMatchObject({ resumeOnly: true, launch: { state: 'ready' }, ...CHOSEN })
  })

  it('reads every engine the daemon can write a row for: its list is the daemon\'s', () => {
    // The hook cannot import the daemon's list (it runs without the adapter's modules), so it keeps a copy,
    // and a copy drifts: `terminal` was missing from it, and one terminal tile made the hook read the whole
    // registry as damaged and register nothing while the daemon was down.
    const source = readFileSync(HOOK, 'utf8')
    const literal = /const REGISTRY_ENGINES = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1]
    expect(literal, 'REGISTRY_ENGINES in hook/notify.mjs').toBeDefined()
    const listed = [...literal!.matchAll(/'([^']+)'/g)].map((match) => match[1])
    expect([...listed].sort()).toEqual([...ENGINES].sort())
    expect(new Set(listed).size).toBe(listed.length)
  })

  it('registers an agent offline beside a terminal tile, and leaves the tile as it was', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-terminal-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-new.jsonl')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    chmodSync(dataDir, 0o755)
    writeFileSync(transcriptPath, '{}\n')
    // A terminal tile as the daemon saves one: no conversation and, until a scan sees its shell, no process.
    const tile = {
      schemaVersion: 2, active: true, defaultName: 'Terminal', agentId: 'agent-terminal', sessionId: '', boundAt: null,
      engine: 'terminal', terminalHost: true, gateway: null, grid: null, codexHome: null, transcriptPath: null,
      projectDir: 'demo', cwd: '/tmp/demo', runtimes: [{ backend: 'tmux', paneId: '%3' }], primaryRuntimeKey: 'tmux\u0000%3',
      tmuxPane: '%3', source: null, title: null, model: null, cliVersion: null, processIdentity: null,
      registeredAt: 1, touchedAt: 1, lastHookAt: 0, lastTranscriptAt: 1,
    }
    writeLegacyStateFile(join(dataDir, 'registry.json'), JSON.stringify([tile]))

    await runHook({
      port: 9, tmuxPane: '%7', processEngine: 'claude', dataDir, claudeProjectsDir,
      input: { hook_event_name: 'SessionStart', session_id: 'session-new', transcript_path: transcriptPath, cwd: '/tmp/demo', source: 'startup' },
    })

    const rows = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual(tile)
    expect(rows[1]).toMatchObject({ engine: 'claude', sessionId: 'session-new', tmuxPane: '%7', processIdentity: { pid: 7001 } })
  })

  it('names a daemon\'s panes as the daemon does', () => {
    const source = readFileSync(HOOK, 'utf8')
    expect(/const HARNESS_OWNER_OPTION = '([^']+)'/.exec(source)?.[1]).toBe(HARNESS_OWNER_OPTION)
    expect(/const HARNESS_SESSION_PREFIX = '([^']+)'/.exec(source)?.[1]).toBe(HARNESS_SESSION_PREFIX)
    // The tag in a pane's start command, before tmux 3.0, read with the format the daemon reads it with.
    const prefix = /const OWNER_COMMAND_PREFIX = '([^']+)'/.exec(source)?.[1]
    expect(`${ownerCommand('0123456789abcdef', ['zsh']).slice(0, 2).join(' ')} zsh`.startsWith(`${prefix}0123456789abcdef`)).toBe(true)
    const format = `#{?#{m:${prefix}*,#{pane_start_command}},#{=${prefix!.length + 16}:pane_start_command},`
      + `#{?#{m:${HARNESS_SESSION_PREFIX}*,#{session_name}},#{${HARNESS_OWNER_OPTION}},}}`
    expect(format).toBe(paneOwnerFormat(false))
    // And the hook's own, read out of its source, are the daemon's: the old tmux one with the session check,
    // and from 3.0 the pane's own option.
    expect(source).toContain('#{?#{m:${HARNESS_SESSION_PREFIX}*,#{session_name}},#{${HARNESS_OWNER_OPTION}},}}')
    expect(source).toContain('const PANE_OWNER_FORMAT = `#{${HARNESS_OWNER_OPTION}}`')
    expect(paneOwnerFormat(true)).toBe(`#{${HARNESS_OWNER_OPTION}}`)
  })

  it('registers offline only a pane its daemon takes for an agent: never a session opened by hand or another daemon\'s', async () => {
    // With the daemon up, the hook of an engine in such a pane is turned away (discovery reads only the
    // daemon's own panes). Offline, the hook wrote a row for it anyway, and the daemon came back with an
    // agent it would never have made, offline for good.
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-owned-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    const register = async (name: string, pane: { paneSession: string; paneOwner?: string }, rows?: unknown[]) => {
      const dataDir = join(dir, name)
      mkdirSync(dataDir, { recursive: true, mode: 0o700 })
      if (rows) writeFileSync(join(dataDir, 'registry.json'), JSON.stringify(rows), { mode: 0o600 })
      const transcriptPath = join(claudeProjectsDir, 'demo', `${name}.jsonl`)
      writeFileSync(transcriptPath, '{}\n')
      await runHook({
        port: 9, tmuxPane: '%7', processEngine: 'claude', dataDir, claudeProjectsDir, ...pane,
        input: { hook_event_name: 'SessionStart', session_id: name, transcript_path: transcriptPath, cwd: '/tmp/demo', source: 'startup' },
      })
      try { return (JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf8')) as Array<{ sessionId: string }>).map((row) => row.sessionId) } catch { return null }
    }
    expect(await register('by-hand', { paneSession: 'mine' })).toBeNull()
    expect(await register('another-daemon', { paneSession: 'harness-claude-1790000000000', paneOwner: 'abcdef0123456789' })).toBeNull()
    // Its own pane, wherever the person moved it, and an untagged one in a session Harness named.
    expect(await register('moved', { paneSession: 'mine', paneOwner: harnessPaneOwner(join(dir, 'moved')) })).toEqual(['moved'])
    expect(await register('untagged', { paneSession: 'harness-claude-1790000000000' })).toEqual(['untagged'])
    // Before tmux 3.0 the tag rides in the pane's start command, cut to its prefix and the tag.
    const startCommand = (dataDir: string) => ownerCommand(harnessPaneOwner(dataDir), []).join(' ')
    expect(await register('old-tmux', { paneSession: 'mine', paneOwner: startCommand(join(dir, 'old-tmux')) })).toEqual(['old-tmux'])
    expect(await register('old-tmux-other', { paneSession: 'harness-claude-1790000000000', paneOwner: startCommand(join(dir, 'elsewhere')) })).toBeNull()
    // A session an older build named, only while the registry holds an agent on that pane.
    expect(await register('legacy-new', { paneSession: 'claude-1790000000000' })).toBeNull()
    const held = {
      schemaVersion: 2, active: true, agentId: 'agent-legacy', sessionId: 'before', boundAt: 1, engine: 'claude',
      gateway: null, grid: null, codexHome: null, transcriptPath: null, projectDir: 'demo', cwd: '/tmp/demo',
      runtimes: [{ backend: 'tmux', paneId: '%7' }], primaryRuntimeKey: 'tmux\u0000%7', tmuxPane: '%7',
      source: null, title: null, model: null, cliVersion: null,
      processIdentity: { pid: 7001, executable: 'claude', startMarker: 'Mon Aug 10 10:00:01 2026' },
      registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
    }
    expect(await register('legacy-held', { paneSession: 'claude-1790000000000' }, [held])).toEqual(['legacy-held'])
  })

  it('takes an engine typed into a terminal tile for that tile, as the daemon does', async () => {
    // The daemon adopts the tile (registry.adoptEngine): the same agent and name, now the engine's, and a
    // terminal again when the engine exits. The hook dropped the tile's row for a new agent instead.
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-terminal-adopt-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-typed.jsonl')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    chmodSync(dataDir, 0o755)
    writeFileSync(transcriptPath, '{}\n')
    writeLegacyStateFile(join(dataDir, 'registry.json'), JSON.stringify([{
      schemaVersion: 2, active: true, defaultName: 'Terminal 10-5 9:41', agentId: 'agent-terminal', sessionId: '', boundAt: null,
      engine: 'terminal', gateway: null, grid: null, codexHome: null, transcriptPath: null,
      projectDir: 'demo', cwd: '/tmp/demo', runtimes: [{ backend: 'tmux', paneId: '%7' }], primaryRuntimeKey: 'tmux\u0000%7',
      tmuxPane: '%7', source: null, title: null, model: null, cliVersion: null,
      processIdentity: { pid: 7000, executable: 'zsh', startMarker: 'Mon Aug 10 10:00:00 2026' },
      registeredAt: 1, touchedAt: 1, lastHookAt: 0, lastTranscriptAt: 1,
    }]))

    await runHook({
      port: 9, tmuxPane: '%7', processEngine: 'claude', dataDir, claudeProjectsDir,
      input: { hook_event_name: 'SessionStart', session_id: 'session-typed', transcript_path: transcriptPath, cwd: '/tmp/demo', source: 'startup' },
    })

    const rows = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      agentId: 'agent-terminal', defaultName: 'Terminal 10-5 9:41', engine: 'claude', terminalHost: true,
      sessionId: 'session-typed', tmuxPane: '%7', processIdentity: { pid: 7001 },
    })
  })

  it('keeps everything else the daemon kept on the row through an offline re-register, a new conversation included', async () => {
    // The hook rebuilt the row from the fields it named, and the daemon, back, loaded that as its own:
    // the agent came back under another name and relaunched out of the mode it was made in, its harness,
    // named agent and close plan gone (e2e/hookclient.e2e.ts, the daemon down while a conversation began).
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-kept-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    chmodSync(dataDir, 0o755)
    const transcript = (sessionId: string) => {
      const path = join(claudeProjectsDir, 'demo', `${sessionId}.jsonl`)
      writeFileSync(path, '{}\n')
      return path
    }
    const kept = {
      defaultName: 'release notes',
      permissionMode: 'plan',
      dsh: 'acme/reviewer',
      dshRuntime: 'harness-runtime-1',
      agent: 'reviewer',
      terminalHost: true,
      resumeOnly: true,
      subscriptionModel: 'claude-opus-5-5',
      gridWebSearch: 'on',
      closePlan: { id: 'close-1', requestedAt: 1_790_000_000_000, identity: 'session-1', state: 'waiting' },
      forkedFrom: { agentId: 'agent-source', name: 'source', sessionId: 'session-0' },
    }
    writeLegacyStateFile(join(dataDir, 'registry.json'), JSON.stringify([{
      schemaVersion: 2, active: true, launch: { state: 'starting' }, agentId: 'agent-kept', sessionId: 'session-1', boundAt: 1,
      engine: 'claude', gateway: null, grid: null, codexHome: null, transcriptPath: transcript('session-1'), projectDir: 'demo',
      cwd: '/tmp/demo', runtimes: [{ backend: 'tmux', paneId: '%7' }], primaryRuntimeKey: 'tmux\u0000%7', tmuxPane: '%7',
      source: null, title: null, model: null, cliVersion: null,
      processIdentity: { pid: 7001, executable: 'claude', startMarker: 'Mon Aug 10 10:00:01 2026' },
      registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
      ...kept,
    }]))

    for (const [event, sessionId, source] of [['UserPromptSubmit', 'session-1', undefined], ['SessionStart', 'session-2', 'clear']] as const) {
      await runHook({
        port: 9, tmuxPane: '%7', processEngine: 'claude', dataDir, claudeProjectsDir,
        input: { hook_event_name: event, session_id: sessionId, transcript_path: transcript(sessionId), cwd: '/tmp/demo', ...(source ? { source } : {}) },
      })
      const rows = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ agentId: 'agent-kept', sessionId, ...kept })
      // A hook means the engine is up, whatever the launch was: over, as `register()` has it, which on a
      // row that may only be resumed reads `ready`.
      expect(rows[0].launch).toEqual({ state: 'ready' })
      expect(rows[0].touchedAt).toBeGreaterThan(1)
    }
  })

  it('an offline re-register of the session a row already holds keeps the row\'s folder', async () => {
    // Claude's UserPromptSubmit carries the tracked shell directory — wherever the agent last
    // `cd`'d — and a daemon-down rebuild must not move the row there any more than the daemon does.
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-cwd-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-1.jsonl')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    chmodSync(dataDir, 0o755)
    writeFileSync(transcriptPath, '{}\n')
    const row = {
      schemaVersion: 2, active: true, agentId: 'agent-bound', sessionId: 'session-1', boundAt: 1, engine: 'claude',
      gateway: null, grid: null, codexHome: null, transcriptPath, projectDir: 'demo', cwd: '/tmp/demo',
      runtimes: [{ backend: 'tmux', paneId: '%7' }], primaryRuntimeKey: 'tmux\u0000%7', tmuxPane: '%7',
      source: null, title: null, model: null, cliVersion: null,
      processIdentity: { pid: 7001, executable: 'claude', startMarker: 'Mon Aug 10 10:00:01 2026' },
      registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
    }
    writeLegacyStateFile(join(dataDir, 'registry.json'), JSON.stringify([row]))

    await runHook({
      port: 9, tmuxPane: '%7', processEngine: 'claude', dataDir, claudeProjectsDir,
      input: { hook_event_name: 'UserPromptSubmit', session_id: 'session-1', transcript_path: transcriptPath, cwd: '/tmp/demo/cli' },
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))[0]).toMatchObject({ agentId: 'agent-bound', sessionId: 'session-1', cwd: '/tmp/demo' })

    // A rotation is a new session and takes the folder it reports.
    const rotated = join(claudeProjectsDir, 'demo', 'session-2.jsonl')
    writeFileSync(rotated, '{}\n')
    await runHook({
      port: 9, tmuxPane: '%7', processEngine: 'claude', dataDir, claudeProjectsDir,
      input: { hook_event_name: 'SessionStart', session_id: 'session-2', transcript_path: rotated, cwd: '/tmp/demo/cli' },
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))[0]).toMatchObject({ agentId: 'agent-bound', sessionId: 'session-2', cwd: '/tmp/demo/cli' })
  })

  it('drops stale registry entries when boot marker predates this boot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-reboot-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'fresh.jsonl')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    chmodSync(dataDir, 0o755)
    writeFileSync(transcriptPath, '{}\n')
    writeLegacyStateFile(join(dataDir, 'registry-boot'), '1')
    writeLegacyStateFile(join(dataDir, 'registry.json'), JSON.stringify([{ sessionId: 'stale', tmuxPane: '%1' }]))

    await runHook({
      port: 9,
      tmuxPane: '%12',
      processEngine: 'claude',
      dataDir,
      claudeProjectsDir,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'fresh',
        transcript_path: transcriptPath,
      },
    })

    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toMatchObject([
      { sessionId: 'fresh', tmuxPane: '%12' },
    ])
  })

  it('does not take a step of the wall clock for a reboot, and keeps every other agent', async () => {
    // A boot named by the moment it began moved with the clock, and a hook that fell back to the
    // registry hours after a laptop slept, or after an NTP step, took it for a reboot and wrote a
    // registry of its one agent (round 29).
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-clock-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    chmodSync(dataDir, 0o755)
    const otherTranscript = join(claudeProjectsDir, 'demo', 'other.jsonl')
    writeFileSync(otherTranscript, '{}\n')
    writeLegacyStateFile(join(dataDir, 'registry.json'), JSON.stringify([{
      schemaVersion: 2, active: true, agentId: 'agent-other', sessionId: 'other', boundAt: 1, engine: 'claude',
      gateway: null, grid: null, codexHome: null, transcriptPath: otherTranscript, projectDir: 'demo', cwd: '/tmp/demo',
      runtimes: [{ backend: 'tmux', paneId: '%1' }], primaryRuntimeKey: 'tmux\u0000%1', tmuxPane: '%1',
      source: null, title: null, model: null, cliVersion: null,
      processIdentity: { pid: 5001, executable: 'claude', startMarker: 'Mon Aug 10 09:00:00 2026' },
      registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
    }]))
    const register = (sessionId: string, env?: Record<string, string>) => {
      const transcriptPath = join(claudeProjectsDir, 'demo', `${sessionId}.jsonl`)
      writeFileSync(transcriptPath, '{}\n')
      return runHook({
        port: 9, tmuxPane: '%12', processEngine: 'claude', dataDir, claudeProjectsDir, env,
        input: { hook_event_name: 'SessionStart', session_id: sessionId, transcript_path: transcriptPath },
      })
    }
    // This boot's mark is written by the first offline write; then the clock moves three hours on, in
    // the hook as in the engine that runs it.
    await register('before')
    expect(statSync(join(dataDir, 'registry-boot')).isFile()).toBe(true)
    const shift = join(dir, 'shift')
    writeFileSync(shift, String(3 * 3_600_000))
    await register('after', { NODE_OPTIONS: `--import ${CLOCK_SHIFT}`, E2E_CLOCK_SHIFT_FILE: shift })
    const rows = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8')) as Array<{ sessionId: string }>
    expect(rows.map((row) => row.sessionId).sort()).toEqual(['after', 'other'])
  })
})

describe('hook notify Grok lifecycle', () => {
  it('resolves updates.jsonl, registers lifecycle events, and uses only StopFailure as a close fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-grok-'))
    tmpDirs.push(dir)
    const grokHome = join(dir, 'grok')
    const cwd = '/tmp/grok workspace'
    const sessionId = '8184b11d-175e-46cb-9cee-cf41cafe70d2'
    const transcript = join(grokHome, 'sessions', encodeURIComponent(cwd), sessionId, 'updates.jsonl')
    mkdirSync(join(transcript, '..'), { recursive: true })
    writeFileSync(transcript, '{}\n')
    const { port, requests } = await collect()

    await runHook({
      port, tmuxPane: '%44', engine: 'grok', grokHome,
      input: { hookEventName: 'session_start', sessionId, cwd, model: 'grok-4.5', cliVersion: '1.0.0' },
    })
    expect(requests).toEqual([{
      url: '/api/hook/session-start',
      body: expect.objectContaining({
        engine: 'grok', hookEvent: 'SessionStart', sessionId, transcriptPath: transcript,
        cwd, tmuxPane: '%44', model: 'grok-4.5', cliVersion: '1.0.0',
      }),
    }])

    requests.splice(0)
    await runHook({ port, tmuxPane: '%44', engine: 'grok', grokHome, input: { hookEventName: 'stop', sessionId, cwd } })
    expect(requests).toEqual([])
    await runHook({ port, tmuxPane: '%44', engine: 'grok', grokHome, input: { hookEventName: 'stop_failure', sessionId, cwd } })
    expect(requests).toEqual([{
      url: '/api/hook/turn-stop',
      body: {
        sessionId,
        transcriptPath: transcript,
        status: 'error',
        engine: 'grok',
        tmuxPane: '%44',
        runtimeHints: [{ backend: 'tmux', paneId: '%44' }],
        callerPid: expect.any(Number),
      },
    }])
  })

  it('writes an offline fallback registry entry under the trusted Grok root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-grok-offline-'))
    tmpDirs.push(dir)
    const grokHome = join(dir, 'grok')
    const dataDir = join(dir, 'data')
    const cwd = '/tmp/grok-offline'
    const sessionId = '98ee3dac-175e-46cb-9cee-cf41cafe70d2'
    const transcript = join(grokHome, 'sessions', encodeURIComponent(cwd), sessionId, 'updates.jsonl')
    mkdirSync(join(transcript, '..'), { recursive: true })
    writeFileSync(transcript, '{}\n')

    await runHook({
      port: 9, tmuxPane: '%45', engine: 'grok', processEngine: 'grok',
      processExecutable: 'agent', processArgs: 'agent', grokHome, dataDir,
      input: { hookEventName: 'session_start', sessionId, cwd },
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf8'))).toMatchObject([{
      sessionId, engine: 'grok', transcriptPath: transcript, projectDir: 'grok-offline', cwd, tmuxPane: '%45',
    }])

    const rejectedDataDir = join(dir, 'cursor-owned-agent-data')
    await runHook({
      port: 9, tmuxPane: '%46', engine: 'grok', processEngine: 'cursor',
      processExecutable: 'agent', processArgs: 'agent', grokHome, dataDir: rejectedDataDir,
      input: { hookEventName: 'session_start', sessionId, cwd },
    })
    expect(() => readFileSync(join(rejectedDataDir, 'registry.json'), 'utf8')).toThrow()
  })
})

/**
 * Devin's documented user-level hook locations include `~/.claude/settings.json`, so the machine's CLAUDE
 * hook can fire inside a Devin session and register it under the wrong engine. The claude arm bails out
 * on a payload whose session id is a Devin slug holding a live `session_locks/<id>.lock`.
 */
describe('hook notify Devin/claude disambiguation', () => {

  it('ignores a Devin session that fired the claude hook, but still registers a real claude session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-devin-'))
    tmpDirs.push(dir)
    const devinHome = join(dir, 'devin')
    const projectsDir = join(dir, 'projects')
    mkdirSync(join(devinHome, 'session_locks'), { recursive: true })
    writeFileSync(join(devinHome, 'session_locks', 'classy-tourmaline.lock'), '21988')
    mkdirSync(projectsDir, { recursive: true })
    const transcript = join(projectsDir, 'a3f1c2d4-0000-4000-8000-000000000001.jsonl')
    writeFileSync(transcript, '')

    const { port, requests } = await collect()

    // Devin's SessionStart, arriving on the claude-armed hook → dropped.
    await runHook({
      port,
      tmuxPane: '%30',
      dataDir: join(dir, 'data'),
      claudeProjectsDir: projectsDir,
      devinHome,
      input: { hook_event_name: 'SessionStart', session_id: 'classy-tourmaline', source: 'startup' },
    })
    expect(requests).toEqual([])

    // A genuine claude session is unaffected.
    await runHook({
      port,
      tmuxPane: '%30',
      dataDir: join(dir, 'data'),
      claudeProjectsDir: projectsDir,
      devinHome,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'a3f1c2d4-0000-4000-8000-000000000001',
        transcript_path: transcript,
        cwd: '/tmp/claude-workspace',
        source: 'startup',
      },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/api/hook/session-start')
    expect(requests[0].body).toMatchObject({ engine: 'claude', sessionId: 'a3f1c2d4-0000-4000-8000-000000000001' })
  })

  it('registers a Devin session with no transcript path and the hook process cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-devin2-'))
    tmpDirs.push(dir)
    const { port, requests } = await collect()

    await runHook({
      port,
      tmuxPane: '%31',
      engine: 'devin',
      dataDir: join(dir, 'data'),
      devinHome: join(dir, 'devin'),
      input: { hook_event_name: 'SessionStart', session_id: 'blue-agustinia', source: 'startup' },
    })

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/api/hook/session-start')
    expect(requests[0].body).toMatchObject({
      engine: 'devin',
      sessionId: 'blue-agustinia',
      tmuxPane: '%31',
      cwd: process.cwd(),
    })
    expect(requests[0].body.transcriptPath).toBeUndefined()
  })

  it('routes a Devin Stop to turn-stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-devin3-'))
    tmpDirs.push(dir)
    const { port, requests } = await collect()

    await runHook({
      port,
      tmuxPane: '%32',
      engine: 'devin',
      dataDir: join(dir, 'data'),
      devinHome: join(dir, 'devin'),
      input: { hook_event_name: 'Stop', session_id: 'blue-agustinia', stop_hook_active: false, prompt_id: 'p1' },
    })

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/api/hook/turn-stop')
    expect(requests[0].body).toMatchObject({ sessionId: 'blue-agustinia' })
  })
})

describe('hook notify Command Code re-registration', () => {
  // Command Code's hook set is PreToolUse/PostToolUse/Stop/SessionStart — Stop doubles as its only catch
  // hook, so it must register as well as close the turn. Without that, a session dropped from the registry
  // stays invisible on web/device until the user quits and relaunches the CLI.
  it('re-registers on Stop, with the transcript path, before closing the turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-cc-'))
    tmpDirs.push(dir)
    const transcript = join(dir, '53955d6d.jsonl')
    writeFileSync(transcript, '{}\n')
    const { port, requests } = await collect()

    await runHook({
      port,
      tmuxPane: '%3',
      engine: 'commandcode',
      dataDir: join(dir, 'data'),
      input: {
        hook_event_name: 'Stop',
        session_id: '53955d6d',
        transcript_path: transcript,
        cwd: '/tmp/demo',
        session_title: 'Greeting',
      },
    })

    expect(requests.map((r) => r.url)).toEqual(['/api/hook/session-start', '/api/hook/turn-stop'])
    expect(requests[0].body).toMatchObject({
      engine: 'commandcode',
      hookEvent: 'Stop',
      sessionId: '53955d6d',
      transcriptPath: transcript,
      tmuxPane: '%3',
      cwd: '/tmp/demo',
      title: 'Greeting',
    })
  })

  it('omits a transcript path that does not exist yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-cc2-'))
    tmpDirs.push(dir)
    const { port, requests } = await collect()

    await runHook({
      port,
      tmuxPane: '%3',
      engine: 'commandcode',
      dataDir: join(dir, 'data'),
      input: { hook_event_name: 'Stop', session_id: '53955d6d', transcript_path: join(dir, 'nope.jsonl') },
    })

    expect(requests).toHaveLength(2)
    expect(requests[0].body.transcriptPath).toBeUndefined()
  })

  it('leaves the claude Stop path as a turn-stop only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-cc3-'))
    tmpDirs.push(dir)
    const transcript = join(dir, 'projects', 'demo', 'abc.jsonl')
    mkdirSync(join(dir, 'projects', 'demo'), { recursive: true })
    writeFileSync(transcript, '{}\n')
    const { port, requests } = await collect()

    await runHook({
      port,
      tmuxPane: '%4',
      dataDir: join(dir, 'data'),
      claudeProjectsDir: join(dir, 'projects'),
      input: { hook_event_name: 'Stop', session_id: 'abc', transcript_path: transcript },
    })

    expect(requests.map((r) => r.url)).toEqual(['/api/hook/turn-stop'])
  })
})

describe('a hook reaches the daemon that made its pane', () => {
  // A computer has one Claude Code entry and one Codex entry, and each daemon writes its own --port and
  // --data-dir into them as it starts. With a dev daemon beside the release one, the last to start took
  // every hook and turned the other's away. Each daemon records where it listens under its pane tag
  // (lib/hookRoutes.ts), and the hook follows the pane's tag there (notify.mjs routeToPaneOwner).
  function computer() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'adapter-hook-routes-')))
    tmpDirs.push(dir)
    const routes = join(dir, 'hook-routes')
    const daemon = (name: string) => {
      const dataDir = join(dir, name)
      mkdirSync(dataDir, { recursive: true, mode: 0o700 })
      const credential = name[0].repeat(43)
      writeFileSync(join(dataDir, 'hook-credential'), `${credential}\n`, { mode: 0o600 })
      return { dataDir, tag: harnessPaneOwner(dataDir), credential }
    }
    return { dir, routes, release: daemon('release'), dev: daemon('dev') }
  }
  const sessionEnd = { hook_event_name: 'SessionEnd', session_id: 'session-routed', reason: 'logout' }

  it('follows the pane\'s tag to its daemon, whichever daemon\'s command ran it', async () => {
    const { routes, release, dev } = computer()
    const atRelease = await collect({}, release.credential)
    const atDev = await collect({}, dev.credential)
    publishHookRoute(release.dataDir, atRelease.port, routes)
    publishHookRoute(dev.dataDir, atDev.port, routes)
    await daemonSocketFor(atRelease.port, release.dataDir)
    // The dev daemon started last: the command is its own. The pane is the release daemon's.
    await runHook({
      port: atDev.port, dataDir: dev.dataDir, tmuxPane: '%7', paneOwner: release.tag,
      env: { HARNESS_HOOK_ROUTES_DIR: routes }, input: sessionEnd,
    })
    expect(atRelease.requests.map((r) => r.url)).toEqual(['/api/hook/session-end'])
    expect(atDev.requests).toEqual([])
    // Its own pane, through its own command, as before.
    await runHook({
      port: atDev.port, dataDir: dev.dataDir, tmuxPane: '%8', paneOwner: dev.tag,
      env: { HARNESS_HOOK_ROUTES_DIR: routes }, input: sessionEnd,
    })
    expect(atDev.requests.map((r) => r.url)).toEqual(['/api/hook/session-end'])
    // Before tmux 3.0 the tag rides in the pane's start command.
    await runHook({
      port: atDev.port, dataDir: dev.dataDir, tmuxPane: '%9', paneOwner: ownerCommand(release.tag, []).join(' '),
      env: { HARNESS_HOOK_ROUTES_DIR: routes }, input: sessionEnd,
    })
    expect(atRelease.requests).toHaveLength(2)
  })

  it('the actual hook rejects malformed route records and uses its installed command', async () => {
    // These checks used to exercise an unused TypeScript reader, not the hook that consumes the file.
    const { routes, release, dev } = computer()
    const atRelease = await collect({}, release.credential)
    const atDev = await collect({}, dev.credential)
    publishHookRoute(release.dataDir, atRelease.port, routes)
    const bodies = ['broken', 'null', '{}', JSON.stringify({ dataDir: release.dataDir, port: 0 }),
      JSON.stringify({ dataDir: release.dataDir, port: 65_536 }),
      JSON.stringify({ dataDir: release.dataDir, port: String(atRelease.port) }),
      JSON.stringify({ dataDir: 7, port: atRelease.port }),
      JSON.stringify({ dataDir: dev.dataDir, port: atRelease.port })]
    for (const body of bodies) {
      writeFileSync(hookRouteFile(release.tag, routes), body, { mode: 0o600 })
      await runHook({ port: atDev.port, dataDir: dev.dataDir, tmuxPane: '%7', paneOwner: release.tag,
        env: { HARNESS_HOOK_ROUTES_DIR: routes }, input: sessionEnd })
    }
    expect(atRelease.requests).toEqual([])
    expect(atDev.requests).toHaveLength(bodies.length)
  })

  it('keeps the command\'s own --port and --data-dir, as every installed command carried them, when the pane names no daemon it can trust', async () => {
    const { dir, routes, release, dev } = computer()
    const atRelease = await collect()
    const atDev = await collect()
    const hook = (paneOwner: string, extra: Partial<RunHookOpts> = {}) => runHook({
      port: atDev.port, dataDir: dev.dataDir, tmuxPane: '%7', paneOwner, env: { HARNESS_HOOK_ROUTES_DIR: routes }, input: sessionEnd, ...extra,
    })
    const record = hookRouteFile(release.tag, routes)
    // An untagged pane in a session Harness named (a pane from before the tag), and a tag with no record
    // (a daemon from before the records).
    await hook('')
    await hook(release.tag)
    // A record that is not the tag's own: another daemon's folder under this tag.
    publishHookRoute(release.dataDir, atRelease.port, routes)
    writeFileSync(record, JSON.stringify({ dataDir: dev.dataDir, port: atRelease.port }), { mode: 0o600 })
    await hook(release.tag)
    // A record others could have written, in a folder others could write, and one whose folder is gone.
    publishHookRoute(release.dataDir, atRelease.port, routes)
    chmodSync(record, 0o666)
    await hook(release.tag)
    publishHookRoute(release.dataDir, atRelease.port, routes)
    chmodSync(routes, 0o777)
    await hook(release.tag)
    chmodSync(routes, 0o700)
    const gone = join(dir, 'gone')
    mkdirSync(gone)
    publishHookRoute(gone, atRelease.port, routes)
    rmSync(gone, { recursive: true })
    await hook(harnessPaneOwner(gone))
    expect(atRelease.requests).toEqual([])
    expect(atDev.requests).toHaveLength(6)
    // And with the record in order, the same hook goes to the release daemon.
    publishHookRoute(release.dataDir, atRelease.port, routes)
    await daemonSocketFor(atRelease.port, release.dataDir)
    await hook(release.tag)
    expect(atRelease.requests).toHaveLength(1)
  })

  it('offline, writes its registry row into the daemon that made the pane, which reads it when it is back', async () => {
    const { dir, routes, release, dev } = computer()
    const claudeProjectsDir = join(dir, 'claude-projects')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-offline.jsonl')
    writeFileSync(transcriptPath, '{}\n')
    // The release daemon is down: nothing listens on port 9.
    publishHookRoute(release.dataDir, 9, routes)
    await runHook({
      port: 9, dataDir: dev.dataDir, tmuxPane: '%7', processEngine: 'claude', claudeProjectsDir,
      paneSession: 'mine', paneOwner: release.tag, env: { HARNESS_HOOK_ROUTES_DIR: routes },
      input: { hook_event_name: 'SessionStart', session_id: 'session-offline', transcript_path: transcriptPath, cwd: '/tmp/demo', source: 'startup' },
    })
    const rows = (folder: string) => { try { return JSON.parse(readFileSync(join(folder, 'registry.json'), 'utf8')) as Array<{ sessionId: string }> } catch { return null } }
    expect(rows(release.dataDir)?.map((row) => row.sessionId)).toEqual(['session-offline'])
    expect(rows(dev.dataDir)).toBeNull()
  })
})

/**
 * On Linux Harness's folders follow the XDG Base Directory paths (docs/plans/2026-11-18-linux-xdg-paths-design.md, The
 * roots on Linux): the XDG data and state folders once the data one exists, else ~/.harness while that exists. macOS and
 * Windows keep ~/.harness (Windows with the pipe's cases, below). An installed command names its data folder; these are
 * the folders behind it: the data folder when it names none, the daemons' route records, and the short folder that holds
 * the socket of a data folder too long for one. A preload sets the platform, so each case runs on any computer.
 */
describe('the hook finds Harness\'s folders by the rule', () => {
  const everyFallback = { data: true, routes: true, socket: true }

  /** A home short enough for a socket under it, holding [folders]. */
  function homeWith(...folders: string[]): string {
    const home = shortHome()
    for (const folder of folders) mkdirSync(join(home, folder), { recursive: true, mode: 0o700 })
    return home
  }

  /** A moved home: ~/.harness (the bridge) and the data root [dataRoot] with the marker the move's commit writes in it. */
  function movedHome(dataRoot = '.local/share/harness'): string {
    const home = homeWith('.harness', dataRoot)
    writeFileSync(join(home, dataRoot, '.harness-root'), '1\n', { mode: 0o600 })
    return home
  }

  /** The hook's environment as on [platform], in [home], naming no data or routes folder, nor this computer's runtime folder. */
  function asOn(platform: NodeJS.Platform, home: string, env: Record<string, string> = {}): Record<string, string> {
    const preload = join(home, 'platform.mjs')
    writeFileSync(preload, `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} })\n`)
    return { HOME: home, ADAPTER_DATA_DIR: '', HARNESS_HOOK_ROUTES_DIR: '', XDG_RUNTIME_DIR: '', NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`, ...env }
  }

  /** A daemon serving [dataDir]: its credential there, its socket beside it or where [socketAt] puts it. */
  async function daemonIn(dataDir: string, socketAt = (port: number) => join(dataDir, `daemon-${port}.sock`)) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const credential = randomBytes(32).toString('base64url')
    writeFileSync(join(dataDir, 'hook-credential'), `${credential}\n`, { mode: 0o600 })
    const daemon = await collect({}, credential)
    await proxySocket(socketAt(daemon.port), daemon.port)
    return daemon
  }

  /** A hook whose command names no data folder reaches the daemon serving [dataDir]. */
  async function reachesData(dataDir: string, env: Record<string, string>): Promise<boolean> {
    const daemon = await daemonIn(dataDir)
    await runHook({ port: daemon.port, tmuxPane: '%42', env })
    return daemon.requests.length === 1
  }

  /** A hook in another daemon's pane follows that daemon's route record in [routes]. */
  async function followsRoute(routes: string, home: string, env: Record<string, string>): Promise<boolean> {
    const ownerDir = join(home, 'owner'), ownDir = join(home, 'own')
    const owner = await daemonIn(ownerDir)
    const own = await daemonIn(ownDir)
    publishHookRoute(ownerDir, owner.port, routes)
    await runHook({ port: own.port, dataDir: ownDir, tmuxPane: '%7', paneOwner: harnessPaneOwner(ownerDir), env })
    return owner.requests.length === 1 && own.requests.length === 0
  }

  /** A short folder's name: its data folder's hash (lib/localSocket.ts shortSocketFolder). */
  const shortName = (dataDir: string): string => createHash('sha256').update(dataDir).digest('hex').slice(0, 16)

  /** A hook whose data folder is too long for a socket reaches its daemon through the short folder in [shortRoot]. */
  async function reachesShortSocket(shortRoot: string, home: string, env: Record<string, string>): Promise<boolean> {
    const dataDir = join(home, 'd'.repeat(100))
    const short = join(shortRoot, shortName(dataDir))
    const daemon = await daemonIn(dataDir, (port) => join(short, `daemon-${port}.sock`))
    // Named in args, not dataDir: runHook would put a socket where it thinks the short folder is.
    await runHook({ port: daemon.port, args: ['--data-dir', dataDir], tmuxPane: '%42', env })
    return daemon.requests.length === 1
  }

  /** Whether each fallback is under [roots]. */
  async function fallbacks(home: string, env: Record<string, string>, roots: { data: string, state: string }) {
    return {
      data: await reachesData(join(roots.data, 'cli', 'data'), env),
      routes: await followsRoute(join(roots.state, 'hook-routes'), home, env),
      socket: await reachesShortSocket(join(roots.state, 's'), home, env),
    }
  }

  const xdgDefaults = (home: string) => ({ data: join(home, '.local', 'share', 'harness'), state: join(home, '.local', 'state', 'harness') })

  it('on a moved Linux home the fallbacks are under the XDG roots', async () => {
    // ~/.harness is the bridge the move leaves: the XDG data folder's marker is what decides.
    const home = movedHome()
    expect(await fallbacks(home, asOn('linux', home), xdgDefaults(home))).toEqual(everyFallback)
  })

  it.each([
    ['a legacy Linux home', 'linux', ['.harness']],
    // Made by something else: the machine stays where its files are.
    ['a Linux home with a data root that holds no marker', 'linux', ['.harness', '.local/share/harness']],
    // The marker is a file: a folder of its name is none.
    ['a Linux home with a folder named as the marker', 'linux', ['.harness', '.local/share/harness/.harness-root']],
    ['macOS', 'darwin', ['.harness', '.local/share/harness']],
  ] as const)('on %s the fallbacks are under ~/.harness, as before', async (_name, platform, folders) => {
    const home = homeWith(...folders)
    const legacy = join(home, '.harness')
    expect(await fallbacks(home, asOn(platform, home), { data: legacy, state: legacy })).toEqual(everyFallback)
  })

  it('takes XDG_DATA_HOME and XDG_STATE_HOME only when each is an absolute path', async () => {
    for (const value of ['', 'xdg']) {
      const home = movedHome()
      const env = asOn('linux', home, { XDG_DATA_HOME: value, XDG_STATE_HOME: value })
      expect(await fallbacks(home, env, xdgDefaults(home)), `XDG_*_HOME=${JSON.stringify(value)}`).toEqual(everyFallback)
    }
    const home = movedHome('xd/harness')
    const env = asOn('linux', home, { XDG_DATA_HOME: join(home, 'xd'), XDG_STATE_HOME: join(home, 'xs') })
    expect(await fallbacks(home, env, { data: join(home, 'xd', 'harness'), state: join(home, 'xs', 'harness') })).toEqual(everyFallback)
  })

  // An agent from before the move runs the command it started with: --data-dir ~/.harness/cli/data, which the bridge's
  // `cli` link turns into the moved folder, and in a pane the move retagged with that folder's tag.
  it('an old command reaches a moved daemon', async () => {
    const home = movedHome()
    const moved = join(xdgDefaults(home).data, 'cli', 'data')
    const daemon = await daemonIn(moved)
    symlinkSync(join(xdgDefaults(home).data, 'cli'), join(home, '.harness', 'cli'))
    const command = { args: ['--data-dir', join(home, '.harness', 'cli', 'data')], tmuxPane: '%7', paneSession: 'mine', paneOwner: harnessPaneOwner(moved) }

    // Up: the credential read through the link, the event posted on the socket beside the moved folder.
    await runHook({ port: daemon.port, ...command, env: asOn('linux', home) })
    expect(daemon.requests.map((request) => request.url)).toEqual(['/api/hook/session-end'])

    // Down: the pane is this command's daemon's, so its offline row is written, in the moved folder.
    const claudeProjectsDir = join(home, 'claude-projects')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-old.jsonl')
    mkdirSync(dirname(transcriptPath), { recursive: true })
    writeFileSync(transcriptPath, '{}\n')
    await runHook({
      port: 9, ...command, processEngine: 'claude', nativeProcess: 'linux', claudeProjectsDir, env: asOn('linux', home),
      input: { hook_event_name: 'SessionStart', session_id: 'session-old', transcript_path: transcriptPath, cwd: '/tmp/demo' },
    })
    expect(JSON.parse(readFileSync(join(moved, 'registry.json'), 'utf8'))).toMatchObject([{ sessionId: 'session-old' }])
  })

  // The account's own runtime folder (XDG Base Directory), as the daemon finds it (lib/localSocket.ts): a link there, or
  // a folder another account could reach, is not one, and the short folder stays in the state root.
  describe('a data folder too long for a socket', () => {
    let runtime: string
    beforeEach(() => { runtime = mkdtempSync('/tmp/hr-'); tmpDirs.push(runtime); chmodSync(runtime, 0o700) })

    it('has its short folder under XDG_RUNTIME_DIR when that is the account\'s own', async () => {
      // The example every client pins (lib/localSocket.spec.ts, Desktop, hn, the store's local-daemon.mjs).
      expect(shortName(`/home/${'u'.repeat(80)}/.local/share/harness/cli/data`)).toBe('410894cc1bc77e10')
      const home = movedHome()
      expect(await reachesShortSocket(join(runtime, 'harness'), home, asOn('linux', home, { XDG_RUNTIME_DIR: runtime }))).toBe(true)
    })

    it('has it in the state root\'s s when XDG_RUNTIME_DIR is a link, open to others, or not absolute', async () => {
      const linked = `${runtime}-link`
      symlinkSync(runtime, linked)
      tmpDirs.push(linked)
      const looser = mkdtempSync('/tmp/hr-')
      tmpDirs.push(looser)
      chmodSync(looser, 0o755)
      for (const value of [linked, looser, 'run/user']) {
        const home = movedHome()
        expect(await reachesShortSocket(join(xdgDefaults(home).state, 's'), home, asOn('linux', home, { XDG_RUNTIME_DIR: value })), value).toBe(true)
      }
    })

    it('on macOS keeps it in ~/.harness/s, whatever XDG_RUNTIME_DIR says', async () => {
      const home = homeWith('.harness')
      expect(await reachesShortSocket(join(home, '.harness', 's'), home, asOn('darwin', home, { XDG_RUNTIME_DIR: runtime }))).toBe(true)
    })
  })

  it('HARNESS_HOOK_ROUTES_DIR and ADAPTER_DATA_DIR still win on a moved home', async () => {
    const home = movedHome()
    const env = asOn('linux', home, { ADAPTER_DATA_DIR: join(home, 'mine', 'data'), HARNESS_HOOK_ROUTES_DIR: join(home, 'mine', 'routes') })
    expect(await reachesData(join(home, 'mine', 'data'), env)).toBe(true)
    expect(await followsRoute(join(home, 'mine', 'routes'), home, env)).toBe(true)
  })
})

describe('hook notify in a Harness pty host pane (Windows)', () => {
  const sessionStart = () => {
    const recordings = JSON.parse(readFileSync(new URL('./lib/__fixtures__/prompt-hooks.json', import.meta.url), 'utf8'))
    return { ...recordings.claude.input, hook_event_name: 'SessionStart' }
  }

  it('names its pane by HARNESS_PANE when there is no TMUX_PANE', async () => {
    const { port, requests } = await collect()
    await runHook({ port, env: { HARNESS_PANE: 'p3:%1007' }, input: sessionStart() })
    expect(requests.map((request) => request.url)).toEqual(['/api/hook/session-start'])
    expect(requests[0].body.runtimeHints).toEqual([{ backend: 'ptyhost', instance: 'p3', paneId: '%1007' }])
    expect(requests[0].body.tmuxPane).toBeUndefined()
  })

  it.each(['p2-0.4.21-dev.win1', 'p2-h0123456789ab'])('names a versioned pty host\'s pane by HARNESS_PANE: %s', async (instance) => {
    const { port, requests } = await collect()
    await runHook({ port, env: { HARNESS_PANE: `${instance}:%7` }, input: sessionStart() })
    expect(requests[0].body.runtimeHints).toEqual([{ backend: 'ptyhost', instance, paneId: '%7' }])
  })

  it('keeps naming a tmux pane by TMUX_PANE, and ignores a HARNESS_PANE that is not one', async () => {
    const { port, requests } = await collect()
    await runHook({ port, tmuxPane: '%42', env: { HARNESS_PANE: 'p3:%1007' }, input: sessionStart() })
    expect(requests[0].body.runtimeHints).toEqual([{ backend: 'tmux', paneId: '%42' }])
    // Not a pane: the session is told to the devices only, as one outside a pane.
    const bad = await collect()
    await runHook({ port: bad.port, env: { HARNESS_PANE: 'p3:1007' }, input: sessionStart() })
    await received(bad.requests)
    expect(bad.requests.map((request) => request.url)).toEqual(['/api/hook/observed'])
    const odd = await collect()
    await runHook({ port: odd.port, env: { HARNESS_PANE: 'p2-0.4.21 x:%7' }, input: sessionStart() })
    await received(odd.requests)
    expect(odd.requests.map((request) => request.url)).toEqual(['/api/hook/observed'])
    const empty = await collect()
    await runHook({ port: empty.port, env: { HARNESS_PANE: '' }, input: sessionStart() })
    await received(empty.requests)
    expect(empty.requests.map((request) => request.url)).toEqual(['/api/hook/observed'])
  })
})

/**
 * Audit W1 (docs/security/2026-11-02-team-account-windows.md): on Windows the hook posted the full local credential to
 * the daemon's TCP port, which the Team account's daemon can hold from boot. It now posts over the daemon's pipe, proving
 * the daemon's token, and with no live pipe it posts nothing, as on macOS with no socket. Node on a Mac cannot open a
 * Windows pipe, so a preload sets the platform to win32 and dials a Unix socket named for the pipe's id instead.
 */
describe('hook notify posts over the daemon\'s pipe on Windows (W1)', () => {
  const sessionStart = () => {
    const recordings = JSON.parse(readFileSync(new URL('./lib/__fixtures__/prompt-hooks.json', import.meta.url), 'utf8'))
    return { ...recordings.claude.input, hook_event_name: 'SessionStart' }
  }

  /** [dataDir], by default a new one short enough for a socket, with the daemon's token, and a preload that runs the hook
   *  as on Windows. */
  function windowsData(dataDir = mkdtempSync('/tmp/hkp-')): { dataDir: string; token: Buffer; id: string; socket: string; preload: string } {
    tmpDirs.push(dataDir)
    const token = randomBytes(32), id = randomBytes(16).toString('hex')
    writeFileSync(join(dataDir, 'daemon-token'), `${token.toString('hex')}\n`, { mode: 0o644 })
    const preload = join(dataDir, 'win32-pipe.mjs')
    writeFileSync(preload, [
      "import http from 'node:http'",
      "Object.defineProperty(process, 'platform', { value: 'win32' })",
      'const dial = http.Agent.prototype.createConnection',
      'http.Agent.prototype.createConnection = function (options, ...rest) {',
      // Any name ending in harness-<id>, local pipe or not: the hook's own check is what refuses one.
      '  const id = /harness-([0-9a-f]{32})$/.exec(options.socketPath ?? "")?.[1]',
      `  const socket = id && ${JSON.stringify(dataDir)} + '/harness-' + id`,
      '  return dial.call(this, socket ? { ...options, socketPath: socket, path: socket } : options, ...rest)',
      '}',
    ].join('\n') + '\n')
    return { dataDir, token, id, socket: join(dataDir, `harness-${id}`), preload }
  }

  function record(dataDir: string, port: number, fields: Record<string, unknown>): void {
    writeFileSync(join(dataDir, `daemon-${port}.json`), JSON.stringify({ port, ...fields }) + '\n', { mode: 0o644 })
  }

  /** The daemon's pipe server, as the daemon serves it (lib/localSocket.ts): every request proves the token. */
  async function pipeDaemon(socket: string, token: Buffer, answer: (res: import('http').ServerResponse) => void = (res) => res.end('{}')) {
    const requests: Array<{ url: string; trusted: boolean; hookToken: unknown; credential: unknown; codexHome: unknown }> = []
    const server = await listenLocalSocket((req, res) => {
      req.resume()
      req.on('end', () => {
        requests.push({ url: req.url ?? '', trusted: isTrustedLocal(req), hookToken: req.headers['x-harness-hook-token'], credential: req.headers['x-harness-local'],
          codexHome: req.headers['x-harness-hook-codex-home'] })
        answer(res)
      })
    }, socket, { token })
    pipeServers.push(server.close)
    return requests
  }

  const run = (port: number, dataDir: string, preload: string, extra: Partial<RunHookOpts> = {}) =>
    runHook({ port, dataDir, env: { HARNESS_PANE: 'p1:%1', NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` }, input: sessionStart(), ...extra })

  it('posts over the daemon\'s pipe, with the pipe auth and no credential, and nothing to the port', async () => {
    const { dataDir, token, id, socket, preload } = windowsData()
    const tcp = await collect()
    record(dataDir, tcp.port, { pipe: `\\\\.\\pipe\\harness-${id}`, pid: process.pid })
    const requests = await pipeDaemon(socket, token)
    await run(tcp.port, dataDir, preload)
    expect(requests).toEqual([{ url: '/api/hook/session-start', trusted: true, hookToken: undefined, credential: undefined }])
    expect(tcp.requests).toEqual([])
  })

  // Windows keeps ~/.harness, whatever is at the XDG folders (the hook finds Harness's folders by the rule, above). It has
  // no tmux pane to route and no socket, so the data folder is its one fallback.
  it('finds its data folder under ~/.harness when its command names none', async () => {
    const home = shortHome()
    mkdirSync(join(home, '.local', 'share', 'harness'), { recursive: true })
    const dataDir = join(home, '.harness', 'cli', 'data')
    mkdirSync(dataDir, { recursive: true })
    const { token, id, socket, preload } = windowsData(dataDir)
    const tcp = await collect()
    record(dataDir, tcp.port, { pipe: `\\\\.\\pipe\\harness-${id}`, pid: process.pid })
    const requests = await pipeDaemon(socket, token)
    await runHook({ port: tcp.port, env: { HOME: home, ADAPTER_DATA_DIR: '', HARNESS_PANE: 'p1:%1', NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` },
      input: sessionStart() })
    expect(requests.map((request) => request.url)).toEqual(['/api/hook/session-start'])
  })

  // A Codex home on a share or a device would have the core open another computer's folder on every registration
  // (src/hookServer.ts hookFacts): the hook says only a drive's path, as the core takes one.
  it('sends a Codex home on a drive, and none on a share, a device or no drive', async () => {
    const { dataDir, token, id, socket, preload } = windowsData()
    const tcp = await collect()
    record(dataDir, tcp.port, { pipe: `\\\\.\\pipe\\harness-${id}`, pid: process.pid })
    const requests = await pipeDaemon(socket, token)
    const codex = JSON.parse(readFileSync(new URL('./lib/__fixtures__/prompt-hooks.json', import.meta.url), 'utf8')).codex.input
    const homes = ['C:\\Users\\u\\.codex-work', '\\\\host\\share\\.codex', '//host/share/.codex', '\\\\?\\C:\\x', '\\foo', '/foo']
    for (const home of homes) {
      await run(tcp.port, dataDir, preload, { engine: 'codex', input: codex,
        env: { HARNESS_PANE: 'p1:%1', NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`, CODEX_HOME: home } })
    }
    expect(requests.map((request) => request.url)).toEqual(homes.map(() => '/api/hook/session-start'))
    expect(requests.map((request) => request.codexHome === undefined ? undefined : decodeURIComponent(String(request.codexHome))))
      .toEqual([homes[0], undefined, undefined, undefined, undefined, undefined])
  })

  it('finds the daemon by its record when the hook was given the port it bound, not the one it was configured with', async () => {
    const { dataDir, token, id, socket, preload } = windowsData()
    const tcp = await collect()
    writeFileSync(join(dataDir, 'daemon-18473.json'), JSON.stringify({ port: tcp.port, pipe: `\\\\.\\pipe\\harness-${id}`, pid: process.pid }))
    const requests = await pipeDaemon(socket, token)
    await run(tcp.port, dataDir, preload)
    expect(requests.map((request) => request.url)).toEqual(['/api/hook/session-start'])
    expect(tcp.requests).toEqual([])
  })

  it.each([
    ['no record', () => undefined],
    ['a record with no pipe', () => ({ pid: process.pid })],
    ['a record with no pid', (id: string) => ({ pipe: `\\\\.\\pipe\\harness-${id}` })],
    ['a pipe on another computer', (id: string) => ({ pipe: `\\\\fileserver\\pipe\\harness-${id}`, pid: process.pid })],
    ['a file named as a pipe', (id: string) => ({ pipe: `C:\\Users\\Public\\harness-${id}`, pid: process.pid })],
    ['a daemon that has exited', (id: string) => ({ pipe: `\\\\.\\pipe\\harness-${id}`, pid: exitedPid() })],
    // The daemon is this account's: a pid another account runs (EPERM; pid 1 is root's) is one reused since it exited,
    // and whoever has it may have created the pipe of the recorded name (Quinn 2's review of #2605).
    ...(process.getuid?.() === 0 ? [] : [['a pid another account runs now', (id: string) => ({ pipe: `\\\\.\\pipe\\harness-${id}`, pid: 1 })] as const]),
  ] as const)('posts nothing, to the pipe or the port, with %s', async (_name, fields) => {
    const { dataDir, token, id, socket, preload } = windowsData()
    const tcp = await collect()
    const value = fields(id)
    if (value) record(dataDir, tcp.port, value)
    const requests = await pipeDaemon(socket, token)
    await run(tcp.port, dataDir, preload)
    expect(requests).toEqual([])
    expect(tcp.requests).toEqual([])
  })

  it.each(['missing', 'linked', 'not a token'] as const)('posts nothing, to the pipe or the port, when the daemon\'s token is %s', async (fault) => {
    const { dataDir, token, id, socket, preload } = windowsData()
    const tcp = await collect()
    record(dataDir, tcp.port, { pipe: `\\\\.\\pipe\\harness-${id}`, pid: process.pid })
    rmSync(join(dataDir, 'daemon-token'))
    if (fault === 'linked') {
      // A link is refused even to a token file inside the data folder: NTFS gives the hook no owner to check.
      writeFileSync(join(dataDir, 'token'), `${token.toString('hex')}\n`)
      symlinkSync(join(dataDir, 'token'), join(dataDir, 'daemon-token'))
    }
    if (fault === 'not a token') writeFileSync(join(dataDir, 'daemon-token'), `${token.toString('hex').toUpperCase()}\n`)
    const requests = await pipeDaemon(socket, token)
    await run(tcp.port, dataDir, preload)
    expect(requests).toEqual([])
    expect(tcp.requests).toEqual([])
  })

  // What the hook does with an answer: a held Hermes admission is retried (four posts in all). Whatever answers on the
  // pipe without the daemon's proof is not the daemon, and its answer is not taken: one post, then the hook moves on.
  it.each([['the daemon\'s proof', 4], ['a wrong proof', 1]] as const)('takes an answer only with the daemon\'s proof: %s', async (proof, posts) => {
    const { dataDir, token, id, socket, preload } = windowsData()
    const tcp = await collect()
    record(dataDir, tcp.port, { pipe: `\\\\.\\pipe\\harness-${id}`, pid: process.pid })
    const held = (res: import('http').ServerResponse) => { res.writeHead(202); res.end(JSON.stringify({ pending: false, retry: true })) }
    let attempts = 0
    if (proof === 'a wrong proof') {
      const impostor = createServer((req, res) => {
        req.resume()
        req.on('end', () => { attempts++; res.setHeader('x-harness-proof', 'a'.repeat(64)); held(res) })
      })
      servers.push(impostor)
      await new Promise<void>((resolve) => { impostor.listen(socket, resolve) })
    } else {
      const requests = await pipeDaemon(socket, token, (res) => { attempts++; held(res) })
      void requests
    }
    await run(tcp.port, dataDir, preload, {
      tmuxPane: '%82', engine: 'hermes', processEngine: 'hermes', windowsProcessTable: true,
      processExecutable: 'python3', processArgs: 'python3 /opt/venvs/hermes/lib/python3.12/site-packages/hermes-agent/hermes',
      hermesHome: join(dataDir, 'hermes'), hermesSource: 'cli',
      input: { hook_event_name: 'on_session_start', session_id: '20260810_120000_a1b2c3' },
    })
    expect(attempts).toBe(posts)
    expect(tcp.requests).toEqual([])
  })
})

describe('hook notify: a session outside a pane', () => {
  /** The environment names the hook may send as host hints, and nothing else (spec: The hook). */
  const HINTS = ['TERM_PROGRAM', '__CFBundleIdentifier', 'HERDR_PANE_ID', 'REX_BLOCK', 'ZELLIJ', 'ZELLIJ_PANE_ID',
    'ZELLIJ_SESSION_NAME', 'TMUX_PANE', 'HC_TERMINAL_ID', 'CMUX_SURFACE_ID', 'CMUX_WORKSPACE_ID', 'KITTY_WINDOW_ID',
    'KITTY_LISTEN_ON', 'WEZTERM_PANE', 'ORCA_AGENT_SESSION_ID', 'ORCA_TERMINAL_HANDLE', 'CLAUDE_CODE_HOST_SESSION_ID',
    'CLAUDE_CODE_ENTRYPOINT']
  /** The hints a cut would turn into another value: left out whole over 64 characters. */
  const WHOLE = ['ZELLIJ_PANE_ID', 'ZELLIJ_SESSION_NAME', 'KITTY_LISTEN_ON']
  /** The hints sent on macOS alone: the one platform the devices try Herdr's window on, though hc runs on Linux too
   *  (spec Q5), and the one cmux runs on. */
  const CMUX_IDS = ['CMUX_SURFACE_ID', 'CMUX_WORKSPACE_ID']
  const MAC_ONLY = ['HC_TERMINAL_ID', ...CMUX_IDS]
  /** HINTS as this platform's hook sends them. */
  const SENT = HINTS.filter((name) => !MAC_ONLY.includes(name) || process.platform === 'darwin')
  /** The names a session outside a pane can set, as many as the hook sends: runHook sets no TMUX_PANE without a pane, and
   *  in a herdr pane the hook sends no hc address and none of cmux's ids. */
  const panelessHints = SENT.filter((name) => !['TMUX_PANE', 'HC_TERMINAL_ID', ...CMUX_IDS].includes(name)).slice(0, MAX_HINTS)
  /** A cmux terminal's surface and workspace. */
  const SURFACE = '0f7c1e52-3a8b-4d2e-9c61-5b2a7e4d9f10'
  const WORKSPACE = '6d2b9a4e-1c7f-4e85-b3a0-8f1d2c6e7b54'
  /** The hint names unset, so the environment this test runs in sends none of its own. */
  const noHints = Object.fromEntries(HINTS.map((name) => [name, '']))
  const folder = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    tmpDirs.push(dir)
    return dir
  }

  it('paneless claude Stop posts turn-stop to /api/hook/observed with callerPid and transcriptPath', async () => {
    const { port, requests } = await collect()
    const transcriptPath = '/home/u/.claude/projects/-work-app/sess-1.jsonl'
    await runHook({ port, input: { hook_event_name: 'Stop', session_id: 'sess-1', cwd: '/work/app', transcript_path: transcriptPath } })
    await received(requests)
    expect(requests).toEqual([{
      url: '/api/hook/observed',
      body: {
        engine: 'claude', sessionId: 'sess-1', event: 'turn-stop', cwd: '/work/app', callerPid: process.pid, transcriptPath,
        hostHints: expect.any(Object),
      },
    }])
  })

  // Each waits for the person: a permission, an MCP server's question or link, or a resume after the quota.
  it.each(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'quota_auto_resume_stale'])(
    'paneless claude Notification %s posts needs-input', async (type) => {
      const { port, requests } = await collect()
      await runHook({ port, input: { hook_event_name: 'Notification', notification_type: type, session_id: 'sess-1', cwd: '/w' } })
      await received(requests)
      expect(requests.map((request) => [request.url, request.body.event])).toEqual([['/api/hook/observed', 'needs-input']])
    })

  // An old Claude Code names no type, and says so a minute after every finished turn too: it would flip each done agent.
  it('a Notification with no type posts nothing', async () => {
    const { port, requests } = await collect()
    await runHook({ port, input: { hook_event_name: 'Notification', message: 'Claude is waiting for your input', session_id: 'sess-1', cwd: '/w' } })
    expect(requests).toEqual([])
  })

  // Claude Code also sends Notification a minute after a finished turn (idle_prompt) and after a sign-in: neither is a
  // wait for the person's answer, and a done agent must not turn into one that needs them.
  it.each(['idle_prompt', 'auth_success'])('paneless claude Notification %s posts nothing', async (type) => {
    const { port, requests } = await collect()
    await runHook({ port, input: { hook_event_name: 'Notification', notification_type: type, session_id: 'sess-1', cwd: '/w' } })
    expect(requests).toEqual([])
  })

  it('claude Notification inside a tmux pane posts nothing', async () => {
    const { port, requests } = await collect()
    await runHook({ port, tmuxPane: '%42', input: {
      hook_event_name: 'Notification', notification_type: 'permission_prompt', session_id: 'sess-1', cwd: '/w',
    } })
    expect(requests).toEqual([])
  })

  const own = { tmuxPane: '%7', paneSession: 'mine' }
  const typed = { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: '/w', prompt: 'prompt-secret' }
  const waits = { hook_event_name: 'Notification', notification_type: 'permission_prompt', session_id: 'sess-1', cwd: '/w' }
  const urls = (requests: Array<{ url: string }>) => requests.map((request) => request.url)

  it.each(['claude', 'codex'] as const)('%s in a tmux pane the person opened posts to /api/hook/observed with TMUX_PANE, and registers nothing', async (engine) => {
    const { port, requests } = await collect()
    await runHook({ port, engine, ...own, env: noHints, codexHome: folder('adapter-hook-own-codex-'), input: typed })
    await received(requests)
    expect(urls(requests)).toEqual(['/api/hook/observed'])
    expect(requests[0].body).toMatchObject({ engine, sessionId: 'sess-1', event: 'turn-start', callerPid: process.pid })
    expect(requests[0].body.hostHints).toEqual({ TMUX_PANE: '%7' })
    expect(JSON.stringify(requests[0].body)).not.toContain('prompt-secret')
  })

  it('its Notification is told, as a paneless session\'s is', async () => {
    const { port, requests } = await collect()
    await runHook({ port, ...own, env: noHints, input: waits })
    await received(requests)
    expect(requests.map((request) => [request.url, request.body.event])).toEqual([['/api/hook/observed', 'needs-input']])
  })

  // The recorded prompt, as 'hook notify terminal scope' sends it.
  it.each([
    ['a Harness pane', { paneSession: 'harness-claude-1790000000000' }],
    ['a pane another daemon tagged', { paneSession: 'mine', paneOwner: 'abcdef0123456789' }],
    ['a pane in a session an older build named', { paneSession: 'claude-1790000000000' }],
    ['a pane tmux cannot describe', {}],
  ])('%s is in a pane, as before: its prompt goes to the daemon, its Notification nowhere', async (_what, pane) => {
    const { port, requests } = await collect()
    const recorded = JSON.parse(readFileSync(new URL('./lib/__fixtures__/prompt-hooks.json', import.meta.url), 'utf8')).claude.input
    await runHook({ port, tmuxPane: '%7', ...pane, input: recorded })
    await runHook({ port, tmuxPane: '%7', ...pane, input: waits })
    expect(urls(requests)).toEqual(['/api/hook/session-start'])
  })

  // The shipped budget, so tmux's step limit is its 2 s: the shim answers after 3.
  it('tmux too slow to answer: a Notification in a pane is still told to nobody', async () => {
    const { port, requests } = await collect()
    await runHook({ port, ...own, tmuxDelaySeconds: 3, env: { HARNESS_HOOK_DEADLINE_MS: '4500' }, input: waits })
    expect(requests).toEqual([])
  })

  // herdr's pane is the nearer host: the hc address and cmux's ids beside it are left out.
  it('sends the first MAX_HINTS of the names set, in the list\'s order', async () => {
    const { port, requests } = await collect()
    const set = Object.fromEntries(HINTS.filter((name) => name !== 'TMUX_PANE').map((name, index) => [name, `hint-${index}`]))
    await runHook({ port, ...own, env: set, input: typed })
    await received(requests)
    expect(HINTS.length).toBeGreaterThan(MAX_HINTS)
    expect(Object.keys(requests[0].body.hostHints as object))
      .toEqual(SENT.filter((name) => !['HC_TERMINAL_ID', ...CMUX_IDS].includes(name)).slice(0, MAX_HINTS))
  })

  it('says how Claude Code was started, beside the app it runs in', async () => {
    const { port, requests } = await collect()
    await runHook({ port, env: { ...noHints, __CFBundleIdentifier: 'com.microsoft.VSCode', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' },
      input: { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: '/w', prompt: 'hi' } })
    await received(requests)
    expect(requests[0].body.hostHints).toEqual({ __CFBundleIdentifier: 'com.microsoft.VSCode', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' })
  })

  it('paneless codex subagent posts nothing', async () => {
    const codexHome = folder('adapter-hook-observed-codex-')
    const { port, requests } = await collect()
    const start = { hook_event_name: 'SessionStart', cwd: '/w' }
    await runHook({ port, engine: 'codex', codexHome, input: {
      ...start, session_id: 'child', source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } },
    } })
    await runHook({ port, engine: 'codex', codexHome, input: { ...start, session_id: 'parent', source: 'startup' } })
    await received(requests)
    expect(requests.map((request) => request.body.sessionId)).toEqual(['parent'])
  })

  it('paneless cursor background agent posts nothing', async () => {
    const cursorHome = folder('adapter-hook-observed-cursor-')
    const { port, requests } = await collect()
    await runHook({ port, engine: 'cursor', cursorHome, input: { hook_event_name: 'sessionStart', session_id: 'background', is_background_agent: true } })
    await runHook({ port, engine: 'cursor', cursorHome, input: { hook_event_name: 'sessionStart', session_id: 'foreground', is_background_agent: false } })
    await received(requests)
    expect(requests.map((request) => request.body.sessionId)).toEqual(['foreground'])
  })

  // agy gives each sub-agent a conversation and hooks of its own; only a top-level one has a presence lock.
  it('paneless agy sub-agent posts nothing', async () => {
    const agyHome = folder('adapter-hook-observed-agy-')
    mkdirSync(join(agyHome, 'presence'))
    writeFileSync(join(agyHome, 'presence', 'top.lock'), '')
    const { port, requests } = await collect()
    for (const conversationId of ['child', 'top']) {
      await runHook({ port, engine: 'agy', args: ['--agy-event', 'PreInvocation', '--agy-home', agyHome], input: { conversationId } })
    }
    await received(requests)
    expect(requests.map((request) => request.body.sessionId)).toEqual(['top'])
  })

  // Each engine's own names for the same moments (main() tells them apart for a pane), in its own session id field.
  it.each([
    ['claude', 'SessionStart', [], { hook_event_name: 'SessionStart' }, { event: 'session-start' }],
    ['claude', 'UserPromptSubmit', [], { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, { event: 'turn-start' }],
    ['claude', 'StopFailure', [], { hook_event_name: 'StopFailure' }, { event: 'turn-error' }],
    ['claude', 'SessionEnd', [], { hook_event_name: 'SessionEnd' }, { event: 'session-end' }],
    ['codex', 'UserPromptSubmit', [], { hook_event_name: 'UserPromptSubmit' }, { event: 'turn-start' }],
    // Devin's payload has no cwd: the hook runs in the session's folder.
    ['devin', 'Stop', [], { hook_event_name: 'Stop' }, { event: 'turn-stop', cwd: process.cwd() }],
    ['commandcode', 'PreToolUse', [], { hook_event_name: 'PreToolUse' }, { event: 'turn-start' }],
    ['commandcode', 'Stop', [], { hook_event_name: 'Stop' }, { event: 'turn-stop' }],
    ['cursor', 'beforeSubmitPrompt', [], { hook_event_name: 'beforeSubmitPrompt', workspace_roots: ['/w'] }, { event: 'turn-start', cwd: '/w' }],
    ['cursor', 'preToolUse', [], { hook_event_name: 'preToolUse', tool_name: 'Task' }, null],
    ['cursor', 'stop completed', [], { hook_event_name: 'stop', status: 'completed' }, { event: 'turn-stop' }],
    ['cursor', 'stop error', [], { hook_event_name: 'stop', status: 'error' }, { event: 'turn-error' }],
    ['cursor', 'sessionEnd', [], { hook_event_name: 'sessionEnd' }, { event: 'session-end' }],
    ['grok', 'session_start', [], { hookEventName: 'session_start', workspaceRoot: '/w' }, { event: 'session-start', cwd: '/w' }],
    ['grok', 'userPromptSubmit', [], { hookEventName: 'userPromptSubmit' }, { event: 'turn-start' }],
    // Grok writes its Stop before the turn's last words, which is why it is not installed (main()).
    ['grok', 'stop', [], { hookEventName: 'stop' }, null],
    ['grok', 'stopFailure', [], { hookEventName: 'stopFailure' }, { event: 'turn-error' }],
    ['grok', 'session_end', [], { hookEventName: 'session_end' }, { event: 'session-end' }],
    ['copilot', 'sessionStart', ['--copilot-event', 'sessionStart'], {}, { event: 'session-start' }],
    ['copilot', 'userPromptSubmitted', ['--copilot-event', 'userPromptSubmitted'], {}, { event: 'turn-start' }],
    ['copilot', 'agentStop end_turn', ['--copilot-event', 'agentStop'], { stopReason: 'end_turn' }, { event: 'turn-stop' }],
    ['copilot', 'agentStop max_turns', ['--copilot-event', 'agentStop'], { stopReason: 'max_turns' }, { event: 'turn-error' }],
    ['copilot', 'sessionEnd', ['--copilot-event', 'sessionEnd'], {}, { event: 'session-end' }],
    ['agy', 'PreInvocation', ['--agy-event', 'PreInvocation'], { workspacePaths: ['/w'] }, { event: 'turn-start', cwd: '/w' }],
    ['agy', 'Stop idle', ['--agy-event', 'Stop'], { fullyIdle: true }, { event: 'turn-stop' }],
    // Waiting for its sub-agents: the turn goes on.
    ['agy', 'Stop waiting', ['--agy-event', 'Stop'], { fullyIdle: false }, null],
    ['agy', 'Stop failed', ['--agy-event', 'Stop'], { terminationReason: 'ERROR' }, { event: 'turn-error' }],
  ] as const)('paneless %s %s', async (engine, _name, args, payload, expected) => {
    const sessionField = engine === 'agy' ? 'conversationId' : engine === 'copilot' || engine === 'grok' ? 'sessionId' : 'session_id'
    const agyHome = folder('adapter-hook-observed-agy-')
    mkdirSync(join(agyHome, 'presence'))
    writeFileSync(join(agyHome, 'presence', 'sess-1.lock'), '')
    const { port, requests } = await collect()
    await runHook({
      port, engine, args: engine === 'agy' ? [...args, '--agy-home', agyHome] : [...args],
      input: { ...payload, [sessionField]: 'sess-1' },
    })
    if (expected !== null) await received(requests)
    expect(requests).toEqual(expected === null ? [] : [{
      url: '/api/hook/observed', body: expect.objectContaining({ engine, sessionId: 'sess-1', ...expected }),
    }])
  })

  it('hostHints carries only the allowlist, ORCA_TERMINAL_HANDLE and CLAUDE_CODE_HOST_SESSION_ID among it: ORCA_PAIRING_CODE and ORCA_AGENT_SESSION_SPAWN_TOKEN set in the env are absent from the body', async () => {
    const { port, requests } = await collect()
    const allowed: Record<string, string> = Object.fromEntries(panelessHints.map((name, index) => [name, `hint-${index}`]))
    await runHook({
      port,
      env: { ...allowed, ORCA_PAIRING_CODE: 'pairing-secret', ORCA_AGENT_SESSION_SPAWN_TOKEN: 'spawn-secret', ORCA_OTHER: 'other-secret' },
      input: { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: '/w', prompt: 'prompt-secret' },
    })
    await received(requests)
    expect(requests.map((request) => request.url)).toEqual(['/api/hook/observed'])
    // Every name a session outside a pane sets, all at once: the hook sends no more than the core takes
    // (core/observedHook.ts), so none is cut.
    expect(requests[0].body.hostHints).toEqual(allowed)
    expect(JSON.stringify(requests[0].body)).not.toMatch(/PAIRING|SPAWN|ORCA_OTHER|secret/)
  })

  // The core reads 4096 bytes of a body at most (hookServer.ts): with every field at its bound, nothing is left out.
  // The core refuses an event with more hints than it takes (core/observedHook.ts): the hook's list holds more names,
  // and it sends the first that number of those set.
  it('lists its hint names in this order, and sends no more than the core takes', () => {
    const literal = /const HOST_HINTS = \[([^\]]*)\]/.exec(readFileSync(HOOK, 'utf8'))?.[1]
    expect(literal, 'HOST_HINTS in hook/notify.mjs').toBeDefined()
    const listed = [...literal!.matchAll(/'([^']+)'/g)].map((match) => match[1])
    expect(listed).toEqual(HINTS)
    expect(Number(/const MAX_HINTS = (\d+)/.exec(readFileSync(HOOK, 'utf8'))?.[1])).toBe(MAX_HINTS)
  })

  it('the largest body the hook can build is under 4096 bytes', async () => {
    const { port, requests } = await collect()
    const hints = Object.fromEntries(panelessHints.map((name) => [name, 'h'.repeat(64)]))
    const path = `/${'d'.repeat(1023)}`
    await runHook({ port, env: hints, input: { hook_event_name: 'Stop', session_id: 's'.repeat(128), cwd: path, transcript_path: path } })
    await received(requests)
    expect(requests).toHaveLength(1)
    expect(requests[0].body).toMatchObject({ sessionId: 's'.repeat(128), cwd: path, transcriptPath: path, hostHints: hints })
    expect(Buffer.byteLength(JSON.stringify(requests[0].body))).toBeLessThan(4096)
  })

  // Claude Code types another session's message in as a prompt that starts so; the devices must not move the dial for it.
  // Its gateway and Codex home are the registration's facts (src/hookServer.ts hookFacts); the devices take neither.
  it('a prompt another session sent posts turn-start with relayed: true, and never the prompt or the facts', async () => {
    const { port, requests, headers } = await collect()
    await runHook({ port, env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', CODEX_HOME: '/x' }, input: {
      hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: '/w',
      prompt: '<cross-session-message from="a1">prompt-secret</cross-session-message>',
    } })
    await received(requests)
    expect(requests).toHaveLength(1)
    expect(requests[0].body).toMatchObject({ event: 'turn-start', relayed: true })
    expect(JSON.stringify(requests[0].body)).not.toMatch(/cross-session|prompt-secret/)
    expect(headers[0]).not.toHaveProperty('x-harness-hook-gateway')
    expect(headers[0]).not.toHaveProperty('x-harness-hook-codex-home')
  })

  it('leading whitespace before it is still relayed', async () => {
    const { port, requests } = await collect()
    await runHook({ port, input: {
      hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', prompt: '\n \t<cross-session-message from="a1">x',
    } })
    await received(requests)
    expect(requests).toHaveLength(1)
    expect(requests[0].body).toMatchObject({ event: 'turn-start', relayed: true })
  })

  it.each([
    ['typed', { prompt: 'hi' }],
    ['quoting one', { prompt: 'see <cross-session-message from="a1">' }],
    ['another tag', { prompt: '<cross-session-messages>' }],
    ['an object', { prompt: { text: '<cross-session-message from="a1">' } }],
    ['no prompt', {}],
  ])('a %s prompt posts no relayed', async (_name, prompt) => {
    const { port, requests } = await collect()
    await runHook({ port, input: { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', ...prompt } })
    await received(requests)
    expect(requests).toHaveLength(1)
    expect(requests[0].body.event).toBe('turn-start')
    expect(requests[0].body).not.toHaveProperty('relayed')
  })

  it.each([
    ['cursor', 'beforeSubmitPrompt', [], { hook_event_name: 'beforeSubmitPrompt', session_id: 'sess-1' }],
    ['copilot', 'userPromptSubmitted', ['--copilot-event', 'userPromptSubmitted'], { sessionId: 'sess-1' }],
    ['claude', 'Stop', [], { hook_event_name: 'Stop', session_id: 'sess-1' }],
    // Their prompt event has Claude Code's name, but only Claude Code types another session's message in so.
    ['codex', 'UserPromptSubmit', [], { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1' }],
    ['grok', 'user_prompt_submit', [], { hookEventName: 'user_prompt_submit', sessionId: 'sess-1' }],
    ['devin', 'UserPromptSubmit', [], { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1' }],
  ] as const)('only Claude Code\'s UserPromptSubmit says it: %s %s posts no relayed', async (engine, _name, args, payload) => {
    const { port, requests } = await collect()
    await runHook({ port, engine, args: [...args], input: { ...payload, prompt: '<cross-session-message from="a1">x' } })
    await received(requests)
    expect(requests).toHaveLength(1)
    expect(requests[0].body).not.toHaveProperty('relayed')
  })

  it('a relayed body with every field at its bound keeps relayed and is under 4096 bytes', async () => {
    const { port, requests } = await collect()
    const hints = Object.fromEntries(panelessHints.map((name) => [name, 'h'.repeat(64)]))
    const path = `/${'d'.repeat(1023)}`
    await runHook({ port, env: hints, input: {
      hook_event_name: 'UserPromptSubmit', session_id: 's'.repeat(128), cwd: path, transcript_path: path,
      prompt: '<cross-session-message from="a1">x',
    } })
    await received(requests)
    expect(requests).toHaveLength(1)
    expect(requests[0].body).toMatchObject({
      sessionId: 's'.repeat(128), event: 'turn-start', relayed: true, cwd: path, transcriptPath: path, hostHints: hints,
    })
    expect(Buffer.byteLength(JSON.stringify(requests[0].body))).toBeLessThan(4096)
  })

  // Which Orca build it is says nothing about where the session runs.
  it('never sends ORCA_APP_VERSION', async () => {
    const { port, requests } = await collect()
    await runHook({ port, env: { ...noHints, ORCA_APP_VERSION: '1.4.256' }, input: { hook_event_name: 'Stop', session_id: 'sess-1' } })
    await received(requests)
    expect(requests).toHaveLength(1)
    expect(requests[0].body.hostHints).toEqual({})
  })

  it('a hint value of 200 chars is cut to 64', async () => {
    const { port, requests } = await collect()
    await runHook({ port, env: { TERM_PROGRAM: 'x'.repeat(200) }, input: { hook_event_name: 'Stop', session_id: 'sess-1' } })
    await received(requests)
    expect(requests).toHaveLength(1)
    expect((requests[0].body.hostHints as Record<string, string>).TERM_PROGRAM).toBe('x'.repeat(64))
  })

  // Zellij is the nearer host: its pane and session come before kitty's window and socket, so the cap drops kitty's first.
  it('a session in Zellij inside kitty sends Zellij\'s three and kitty\'s two', async () => {
    const { port, requests } = await collect()
    const sent = { ZELLIJ: '0', ZELLIJ_PANE_ID: '3', ZELLIJ_SESSION_NAME: 's1', KITTY_WINDOW_ID: '1', KITTY_LISTEN_ON: 'unix:/tmp/kitty-1234' }
    await runHook({ port, env: { ...noHints, ...sent }, input: { hook_event_name: 'Stop', session_id: 'sess-1' } })
    await received(requests)
    expect(requests[0].body.hostHints).toEqual(sent)
  })

  // A cut pane id, session name or socket would name another pane, session or socket: such a value is left out instead,
  // before the cap counts it, so it costs no other hint its place.
  it('a socket or a session name over 64 characters is left out, not cut, and takes none of the MAX_HINTS', async () => {
    for (const name of WHOLE) {
      for (const [value, sent] of [['x'.repeat(65), {}], ['x'.repeat(64), { [name]: 'x'.repeat(64) }]] as const) {
        const { port, requests } = await collect()
        await runHook({ port, env: { ...noHints, [name]: value }, input: { hook_event_name: 'Stop', session_id: 'sess-1' } })
        await received(requests)
        expect(requests[0].body.hostHints, `${name} of ${value.length}`).toEqual(sent)
      }
    }
    const { port, requests } = await collect()
    const set = Object.fromEntries(HINTS.filter((name) => name !== 'TMUX_PANE')
      .map((name, index) => [name, WHOLE.includes(name) ? 'x'.repeat(65) : `hint-${index}`]))
    await runHook({ port, ...own, env: set, input: typed })
    await received(requests)
    expect(Object.keys(requests[0].body.hostHints as object))
      .toEqual(SENT.filter((name) => !['HC_TERMINAL_ID', ...CMUX_IDS, ...WHOLE].includes(name)).slice(0, MAX_HINTS))
  })

  // The core refuses the whole event for a path over its bound (core/observedHook.ts): the path goes, the event stays.
  it('leaves out a cwd the core would refuse, and still posts the event', async () => {
    const { port, requests } = await collect()
    await runHook({ port, input: { hook_event_name: 'Stop', session_id: 'sess-1', cwd: `/${'d'.repeat(1024)}`, transcript_path: '/t.jsonl' } })
    await received(requests)
    expect(requests).toHaveLength(1)
    expect(requests[0].body).not.toHaveProperty('cwd')
    expect(requests[0].body.transcriptPath).toBe('/t.jsonl')
  })

  // The core refuses the whole event for a hint with a control character (core/observedHook.ts): the hint goes.
  it('leaves out a hint value with a control character, and still posts the event', async () => {
    const { port, requests } = await collect()
    await runHook({ port, env: { ...noHints, TERM_PROGRAM: 'ghost\u0007ty', ZELLIJ: '0' }, input: { hook_event_name: 'Stop', session_id: 'sess-1' } })
    await received(requests)
    expect(requests).toHaveLength(1)
    expect(requests[0].body.hostHints).toEqual({ ZELLIJ: '0' })
  })

  // A named herdr session (`herdr --session <name>`) is a server of its own, its pane ids starting again at w1:p1, and
  // herdr 0.8.0 sets HERDR_SESSION in its panes alone: the devices follow the default session, where that id is another
  // pane. The rest of the event still posts, and neither the session's name nor its socket's path is sent.
  it('leaves out HERDR_PANE_ID in a pane of a named herdr session', async () => {
    const { port, requests } = await collect()
    await runHook({
      port,
      env: { ...noHints, HERDR_PANE_ID: 'w1:p1', HERDR_SESSION: 'side', HERDR_SOCKET_PATH: '/h/.config/herdr/sessions/side/herdr.sock' },
      input: { hook_event_name: 'Stop', session_id: 'sess-1' },
    })
    await received(requests)
    expect(requests).toHaveLength(1)
    expect(requests[0].body.hostHints).toEqual({})
    expect(JSON.stringify(requests[0].body)).not.toMatch(/side/)
  })

  // Left out before the cap counts it: a pane id never sent would cost the farthest hint its place, and so would the hc
  // address and cmux's ids beside it.
  it('a named herdr session\'s pane id, and the hc address and cmux\'s ids beside it, take none of the MAX_HINTS', async () => {
    const { port, requests } = await collect()
    const set = Object.fromEntries(HINTS.filter((name) => name !== 'TMUX_PANE').map((name, index) => [name, `hint-${index}`]))
    await runHook({ port, env: { ...set, HERDR_SESSION: 'side' }, input: { hook_event_name: 'Stop', session_id: 'sess-1' } })
    await received(requests)
    expect(Object.keys(requests[0].body.hostHints as object))
      .toEqual(SENT.filter((name) => !['TMUX_PANE', 'HERDR_PANE_ID', 'HC_TERMINAL_ID', ...CMUX_IDS].includes(name)).slice(0, MAX_HINTS))
  })

  // herdr started in an hc terminal keeps that terminal's HC_TERMINAL_ID, and is the nearer host. A named herdr session
  // sends no HERDR_PANE_ID, so the address alone would read as Herdr's own terminal (hostDetect.ts inHerdr).
  it.runIf(process.platform === 'darwin')('leaves out HC_TERMINAL_ID in a herdr pane, its session named or not', async () => {
    const panes: Array<[Record<string, string>, Record<string, string>]> = [
      [{ HERDR_PANE_ID: 'w1:p2' }, { TERM_PROGRAM: 'ghostty', HERDR_PANE_ID: 'w1:p2' }],
      [{ HERDR_PANE_ID: 'w1:p2', HERDR_SESSION: 'side' }, { TERM_PROGRAM: 'ghostty' }],
      [{ HERDR_SESSION: 'side' }, { TERM_PROGRAM: 'ghostty' }],
    ]
    for (const [herdr, sent] of panes) {
      const { port, requests } = await collect()
      await runHook({
        port, env: { ...noHints, ...herdr, HC_TERMINAL_ID: 't7', TERM_PROGRAM: 'ghostty' },
        input: { hook_event_name: 'Stop', session_id: 'sess-1' },
      })
      await received(requests)
      expect(requests[0].body.hostHints, JSON.stringify(herdr)).toEqual(sent)
    }
  })

  // HC_TERMINAL_ID is Herdr Core's address of the terminal the agent runs in (t1, t2… per session): an id, no credential.
  it.runIf(process.platform === 'darwin')('sends HC_TERMINAL_ID from an hc terminal', async () => {
    const sessions: Record<string, string>[] = [{}, { HC_SESSION: 'default' }]
    for (const session of sessions) {
      const { port, requests } = await collect()
      await runHook({
        port, env: { ...noHints, ...session, HC_TERMINAL_ID: 't7', TERM_PROGRAM: 'ghostty' },
        input: { hook_event_name: 'Stop', session_id: 'sess-1' },
      })
      await received(requests)
      expect(requests[0].body.hostHints).toEqual({ TERM_PROGRAM: 'ghostty', HC_TERMINAL_ID: 't7' })
    }
  })

  // A named hc session's terminal addresses start again at t1, and the devices follow the default session, where that
  // address is another terminal. The rest of the event still posts, and neither the session's name nor its socket is sent.
  it.runIf(process.platform === 'darwin')('leaves out HC_TERMINAL_ID in a terminal of a named hc session', async () => {
    const { port, requests } = await collect()
    await runHook({
      port,
      env: { ...noHints, HC_TERMINAL_ID: 't1', HC_SESSION: 'side', HC_SOCKET: '/h/.local/state/herdr-core/side/side.sock' },
      input: { hook_event_name: 'Stop', session_id: 'sess-1' },
    })
    await received(requests)
    expect(requests).toHaveLength(1)
    expect(requests[0].body.hostHints).toEqual({})
    expect(JSON.stringify(requests[0].body)).not.toMatch(/side/)
  })

  // Left out before the cap counts it: an address never sent would cost the farthest hint its place, and so would cmux's
  // ids beside it. No herdr pane in either: a herdr pane leaves the address out of its own.
  it.runIf(process.platform === 'darwin')('a named hc session\'s address, and cmux\'s ids beside it, take none of the MAX_HINTS', async () => {
    const { port, requests } = await collect()
    const set = Object.fromEntries(HINTS.filter((name) => name !== 'TMUX_PANE' && name !== 'HERDR_PANE_ID').map((name, index) => [name, `hint-${index}`]))
    await runHook({ port, env: { ...set, HC_SESSION: 'side' }, input: { hook_event_name: 'Stop', session_id: 'sess-1' } })
    await received(requests)
    expect(Object.keys(requests[0].body.hostHints as object))
      .toEqual(SENT.filter((name) => !['TMUX_PANE', 'HERDR_PANE_ID', 'HC_TERMINAL_ID', ...CMUX_IDS].includes(name)).slice(0, MAX_HINTS))
  })

  it.runIf(process.platform !== 'darwin')('off macOS HC_TERMINAL_ID and cmux\'s ids are left out, and take none of the MAX_HINTS', async () => {
    const { port, requests } = await collect()
    const set = Object.fromEntries(HINTS.filter((name) => name !== 'TMUX_PANE' && name !== 'HERDR_PANE_ID').map((name, index) => [name, `hint-${index}`]))
    await runHook({ port, env: set, input: { hook_event_name: 'Stop', session_id: 'sess-1' } })
    await received(requests)
    expect(Object.keys(requests[0].body.hostHints as object))
      .toEqual(HINTS.filter((name) => !['TMUX_PANE', 'HERDR_PANE_ID', ...MAC_ONLY].includes(name)).slice(0, MAX_HINTS))
  })

  // cmux sets TERM_PROGRAM=ghostty: its surface and workspace ids (UUIDs, no credential) tell its terminal from Ghostty's.
  // The rest of its variables stay in this process, CMUX_SOCKET_PASSWORD first of all.
  it.runIf(process.platform === 'darwin')('sends cmux\'s surface and workspace from a cmux terminal, and no other CMUX_ name', async () => {
    const { port, requests } = await collect()
    await runHook({
      port,
      env: {
        ...noHints, TERM_PROGRAM: 'ghostty', CMUX_SURFACE_ID: SURFACE, CMUX_WORKSPACE_ID: WORKSPACE, CMUX_TAB_ID: SURFACE,
        CMUX_PANEL_ID: SURFACE, CMUX_SOCKET_PATH: '/x/cmux.sock', CMUX_SOCKET_PASSWORD: 'secret',
      },
      input: { hook_event_name: 'Stop', session_id: 'sess-1' },
    })
    await received(requests)
    expect(requests[0].body.hostHints).toEqual({ TERM_PROGRAM: 'ghostty', CMUX_SURFACE_ID: SURFACE, CMUX_WORKSPACE_ID: WORKSPACE })
    expect(JSON.stringify(requests[0].body)).not.toMatch(/TAB_ID|PANEL_ID|SOCKET|secret/)
  })

  // herdr or hc started in a cmux terminal keeps cmux's ids, and is the nearer host. A named session of either sends no
  // pane id or address, and cmux's ids alone would read as cmux's own terminal (hostDetect.ts inCmux): the dial's words
  // would be pasted into herdr's screen, or a shell.
  it.runIf(process.platform === 'darwin')('leaves out cmux\'s ids under herdr or hc, its session named or not', async () => {
    const nearer: Array<[Record<string, string>, Record<string, string>]> = [
      [{ HERDR_PANE_ID: 'w1:p2' }, { TERM_PROGRAM: 'ghostty', HERDR_PANE_ID: 'w1:p2' }],
      [{ HERDR_PANE_ID: 'w1:p2', HERDR_SESSION: 'side' }, { TERM_PROGRAM: 'ghostty' }],
      [{ HC_TERMINAL_ID: 't7' }, { TERM_PROGRAM: 'ghostty', HC_TERMINAL_ID: 't7' }],
      [{ HC_TERMINAL_ID: 't1', HC_SESSION: 'side' }, { TERM_PROGRAM: 'ghostty' }],
    ]
    for (const [host, sent] of nearer) {
      const { port, requests } = await collect()
      await runHook({
        port, env: { ...noHints, TERM_PROGRAM: 'ghostty', CMUX_SURFACE_ID: SURFACE, CMUX_WORKSPACE_ID: WORKSPACE, ...host },
        input: { hook_event_name: 'Stop', session_id: 'sess-1' },
      })
      await received(requests)
      expect(requests[0].body.hostHints, JSON.stringify(host)).toEqual(sent)
    }
  })

  // The core reads 4096 bytes of a body at most (hookServer.ts): the transcript's path goes first, then the folder.
  it('leaves out transcriptPath when the body is over 4096 bytes, and keeps cwd', async () => {
    const { port, requests } = await collect()
    const long = `/${'日'.repeat(1000)}`
    await runHook({ port, env: noHints, input: { hook_event_name: 'Stop', session_id: 'sess-1', cwd: long, transcript_path: long } })
    await received(requests)
    expect(requests).toHaveLength(1)
    expect(requests[0].body).not.toHaveProperty('transcriptPath')
    expect(requests[0].body.cwd).toBe(long)
  })

  it('leaves out cwd too when the body is still over 4096 bytes', async () => {
    const { port, requests } = await collect()
    const long = `/${'日'.repeat(1000)}`
    const wide = Object.fromEntries(panelessHints.map((name) => [name, '日'.repeat(64)]))
    await runHook({ port, env: wide, input: { hook_event_name: 'Stop', session_id: 'sess-1', cwd: long, transcript_path: long } })
    await received(requests)
    expect(requests).toHaveLength(1)
    expect(requests[0].body).not.toHaveProperty('transcriptPath')
    expect(requests[0].body).not.toHaveProperty('cwd')
    expect(requests[0].body.hostHints).toEqual(wide)
  })

  /** The one body a paneless hook posts for this input. */
  const posted = async (input: Record<string, unknown>, env: Record<string, string> = noHints, engine?: 'codex'): Promise<Record<string, unknown>> => {
    const { port, requests } = await collect()
    await runHook({ port, env, engine, input: { session_id: 'sess-1', cwd: '/w', ...input } })
    await received(requests)
    expect(requests.map((request) => request.url)).toEqual(['/api/hook/observed'])
    return requests[0].body
  }
  /** Session names and the title each is posted as. */
  const POSTED_TITLES: Array<[string, string]> = [
    ['  Fix \t\n login   screen ', 'Fix login screen'],
    ['x'.repeat(70), 'x'.repeat(64)],
    // A cut inside a surrogate pair drops its first half.
    [`${'x'.repeat(63)}😀tail`, 'x'.repeat(63)],
    [`${'x'.repeat(62)}😀tail`, `${'x'.repeat(62)}😀`],
    // A cut just after a space trims it.
    [`${'x'.repeat(63)} yz`, 'x'.repeat(63)],
    ['Thơ "gà" \\ 数学 🙂', 'Thơ "gà" \\ 数学 🙂'],
  ]
  /** Session names the core would refuse, or none at all: the title is left out. */
  const LEFT_OUT_TITLES: unknown[] = ['', ' \t\n ', 'Th\u0007o', 'Th\u007fo', 7, { text: 'Tho' }, undefined]
  const titled = (title: unknown) => ({ hook_event_name: 'UserPromptSubmit', ...(title === undefined ? {} : { session_title: title }) })

  it.each([['SessionStart', 'session-start'], ['UserPromptSubmit', 'turn-start']])('a Claude %s with session_title posts title', async (name, event) => {
    expect(await posted({ hook_event_name: name, session_title: 'Tho' })).toMatchObject({ event, title: 'Tho' })
  })

  it.each(POSTED_TITLES)('a title %j is posted as %j', async (title, expected) => {
    expect((await posted(titled(title))).title).toBe(expected)
  })

  it.each(LEFT_OUT_TITLES.map((title) => [title]))('a title %j is left out, and the event is still posted', async (title) => {
    const body = await posted(titled(title))
    expect(body.event).toBe('turn-start')
    expect(body).not.toHaveProperty('title')
  })

  it.each([
    ['Stop', {}],
    ['StopFailure', {}],
    ['SessionEnd', {}],
    ['Notification', { notification_type: 'permission_prompt' }],
  ])('no title on %s', async (name, extra) => {
    expect(await posted({ hook_event_name: name, session_title: 'Tho', ...extra })).not.toHaveProperty('title')
  })

  it('another engine\'s hook that sends session_title posts it too', async () => {
    expect(await posted({ hook_event_name: 'UserPromptSubmit', session_title: 'Tho' }, noHints, 'codex'))
      .toMatchObject({ engine: 'codex', event: 'turn-start', title: 'Tho' })
  })

  it('with an oversized body, transcriptPath goes, then cwd, and title stays', async () => {
    const long = `/${'日'.repeat(1000)}`
    const input = { hook_event_name: 'UserPromptSubmit', cwd: long, transcript_path: long, session_title: '日'.repeat(64) }
    const narrow = await posted(input)
    expect(narrow).not.toHaveProperty('transcriptPath')
    expect(narrow).toMatchObject({ cwd: long, title: '日'.repeat(64) })
    const wide = Object.fromEntries(panelessHints.map((name) => [name, '日'.repeat(64)]))
    const body = await posted(input, wide)
    expect(body).not.toHaveProperty('transcriptPath')
    expect(body).not.toHaveProperty('cwd')
    expect(body).toMatchObject({ title: '日'.repeat(64), hostHints: wide })
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(4096)
  })

  it('a body with every field at its bound keeps its title and both paths', async () => {
    const hints = Object.fromEntries(panelessHints.map((name) => [name, 'h'.repeat(64)]))
    const path = `/${'d'.repeat(1023)}`
    const body = await posted({
      hook_event_name: 'UserPromptSubmit', session_id: 's'.repeat(128), cwd: path, transcript_path: path,
      session_title: 'x'.repeat(64), prompt: '<cross-session-message from="a1">x',
    }, hints)
    expect(body).toMatchObject({ relayed: true, title: 'x'.repeat(64), cwd: path, transcriptPath: path, hostHints: hints })
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(4096)
  })

  // A title the hook cut that the core then refused would cost the named session its session-start and turn-start.
  it('the hook cuts a title at the core\'s bound, and the core takes what it cut', async () => {
    expect(Number(/const MAX_TITLE = (\d+)/.exec(readFileSync(HOOK, 'utf8'))?.[1])).toBe(MAX_TITLE)
    const emoji = await posted(titled('😀'.repeat(40)))
    expect(emoji.title).toBe('😀'.repeat(32))
    const typed = await posted(titled('Thơ "gà" \\ 数学 🙂'))
    for (const body of [emoji, typed]) expect(parseObservedHook(body)).toEqual(body)
  })

  // The hook cannot import the devices' cleaner (cable/hosts/observedTitle.ts): this keeps its copy of the rule the same.
  it.each([...POSTED_TITLES.map(([title]) => title), ...LEFT_OUT_TITLES].map((title) => [title]))(
    'the hook cleans a title %j as the devices\' cleaner does', async (title) => {
      expect((await posted(titled(title))).title).toBe(observedTitle(title))
    })

  it('the hook exits within 300 ms when the daemon never answers', async () => {
    const urls: string[] = []
    let arrived: (at: number) => void = () => {}
    const arrival = new Promise<number>((resolve) => { arrived = resolve })
    // Takes the request in and never answers it.
    const server = createServer((req) => { urls.push(req.url ?? ''); arrived(Date.now()); req.resume() })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')
    await runHook({ port: address.port, input: { hook_event_name: 'Stop', session_id: 'sess-1' } })
    const exited = Date.now()
    const at = await Promise.race([arrival, new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000))])
    server.closeAllConnections()
    expect(urls).toEqual(['/api/hook/observed'])
    expect(exited - (at ?? 0)).toBeLessThan(300)
  })

  it('paneless never calls fallbackRegister or routeToPaneOwner', async () => {
    const dir = folder('adapter-hook-observed-')
    // A tmux that leaves a mark when asked: the pane's routing and the offline fallback both ask it about the pane.
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const mark = join(dir, 'tmux-asked')
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\ntouch '${mark}'\n`, { mode: 0o755 })
    const claudeProjectsDir = join(dir, 'claude-projects')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-offline.jsonl')
    writeFileSync(transcriptPath, '{}\n')
    const input = { hook_event_name: 'SessionStart', session_id: 'session-offline', transcript_path: transcriptPath, cwd: '/tmp/demo', source: 'startup' }
    const env = { PATH: `${bin}:${process.env.PATH ?? ''}` }
    const live = await collect()
    await runHook({ port: live.port, dataDir: join(dir, 'live'), claudeProjectsDir, env, input })
    await received(live.requests)
    expect(live.requests.map((request) => request.url)).toEqual(['/api/hook/observed'])
    // The daemon down (nothing on port 9): no registry row is written behind it.
    await runHook({ port: 9, dataDir: join(dir, 'down'), claudeProjectsDir, env, input })
    expect(existsSync(join(dir, 'down', 'registry.json'))).toBe(false)
    expect(existsSync(mark)).toBe(false)
  })
})

describe('hook notify: the caller a hook names', () => {
  /** Keeps a shell as the hook's parent: `; exit $?` stops bash and dash alike from exec'ing the hook. */
  const STAYS = '"$0" "$@"; exit $?'
  const SH = ['/bin/sh', '-c', STAYS]
  type Ancestor = NonNullable<RunHookOpts['procAncestors']>[number]
  /** The pid `procAncestors` gives its row at [index]. */
  const pidAt = (index: number) => index === 0 ? process.pid : 9000 + index
  const sh: Ancestor = { comm: 'sh', argv: ['/bin/sh', '-c', 'hook'] }
  const engine: Ancestor = { comm: 'claude', argv: ['claude'] }
  const bash = (...argv: string[]): Ancestor => ({ comm: 'bash', argv: ['bash', ...argv] })
  const stop = { hook_event_name: 'Stop', session_id: 'sess-1', cwd: '/work/app' }
  const linux = process.platform === 'linux'
  /** The pid a pane's Stop names. A pane post is waited for, so the request is in when the hook exits. */
  const paneCaller = async (opts: Partial<RunHookOpts>) => {
    const { port, requests } = await collect()
    await runHook({ port, tmuxPane: '%4', input: stop, ...opts })
    expect(requests.map((request) => request.url)).toEqual(['/api/hook/turn-stop'])
    return requests[0].body.callerPid
  }

  it.each<[string, Ancestor[], number]>([
    ['a command shell: its parent', [sh, engine], 1],
    ['each of the five shells, in a row: the process above them all', [sh, { comm: 'dash', argv: ['dash', '-c', 'hook'] }, bash('-ec', 'hook'),
      { comm: 'zsh', argv: ['zsh', '-lc', 'hook'] }, { comm: 'fish', argv: ['fish', '-c', 'hook'] }, engine], 5],
    ['a shell that runs a script (bash run.sh): that shell, not the pane shell above it', [sh, bash('/opt/engine/run.sh'), { comm: 'zsh', argv: ['-zsh'] }], 1],
    ['an engine under a wrapper script that did not exec: the engine program, not the wrapper',
      [sh, { comm: 'node', argv: ['node', '/opt/claude/cli.js'] }, { comm: 'bash', argv: ['/bin/bash', '/usr/local/bin/claude'] }], 1],
    ['a command shell whose parent is init: the shell itself', [sh], 0],
    ['ten command shells in a row: the one 8 steps up', Array<Ancestor>(10).fill(sh), 8],
    ['a process /proc cannot show: the last one reached', [sh, null], 1],
    ['a long option holding a c (bash --norc run.sh): the shell itself', [bash('--norc', 'run.sh'), engine], 0],
    ['a long option, then -c: its parent', [bash('--norc', '-c', 'hook'), engine], 1],
    ['-c after the script (bash run.sh -c): the shell itself', [bash('run.sh', '-c'), engine], 0],
    ['an option\'s own argument before -c (bash -o pipefail -c): its parent', [bash('-o', 'pipefail', '-c', 'hook'), engine], 1],
    ['a shopt option\'s argument before -c (bash -O extglob -ec): its parent', [bash('-O', 'extglob', '-ec', 'hook'), engine], 1],
    ['a + option\'s own argument before -c (bash +o posix -c): its parent', [bash('+o', 'posix', '-c', 'hook'), engine], 1],
    ['an option\'s own argument, then a script (bash -o pipefail run.sh): the shell itself', [bash('-o', 'pipefail', 'run.sh'), engine], 0],
    ['a program that is no shell, whatever its options (node -c): itself', [{ comm: 'node', argv: ['node', '-c', 'x.js'] }, engine], 0],
    ['a person\'s interactive shell: itself', [{ comm: 'zsh', argv: ['-zsh'] }, engine], 0],
  ])('a pane hook names, past %s', async (_case, procAncestors, named) => {
    expect(await paneCaller({ procAncestors })).toBe(pidAt(named))
  })

  it('a paneless hook names by the same rule: past two command shells, the process above both', async () => {
    const { port, requests } = await collect()
    await runHook({ port, input: stop, procAncestors: [sh, bash('-ec', 'hook'), engine] })
    await received(requests)
    expect(requests[0]).toMatchObject({ url: '/api/hook/observed', body: { callerPid: pidAt(2) } })
  })

  // GitHub run 43721656615: Linux's dash keeps an engine's `sh -c` as the hook's parent, and it exits with the hook, so
  // the devices kept a pid already gone, refused a tap on the agent's tmux pane and dropped the agent. The hook sees
  // past it through /proc, which only Linux has; macOS's /bin/sh execs the hook, so its parent is the engine already.
  it.runIf(linux)('a hook run through a shell that stays its parent names the shell\'s parent', async () => {
    const { port, requests } = await collect()
    await runHook({ port, via: [SH], input: stop })
    await received(requests)
    expect(requests).toEqual([{ url: '/api/hook/observed', body: expect.objectContaining({ callerPid: process.pid }) }])
  })

  // Real processes, the kernel's own /proc: dash keeps `sh -c` as the hook's parent, and it exits with the hook.
  it.runIf(linux)('a pane hook run through a shell that stays its parent names the shell\'s parent', async () => {
    expect(await paneCaller({ via: [SH] })).toBe(process.pid)
  })
  it.runIf(linux)('a pane hook run through two shells in a row names the process above both', async () => {
    expect(await paneCaller({ via: [SH, ['bash', '-ec', STAYS]] })).toBe(process.pid)
  })
  it.runIf(linux)('a script bash runs (bash wrapper.sh) is named itself, never what started it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-caller-'))
    tmpDirs.push(dir)
    writeFileSync(join(dir, 'wrapper.sh'), `echo $$ > '${join(dir, 'pid')}'\n"$@"\nexit $?\n`)
    const named = await paneCaller({ via: [['bash', join(dir, 'wrapper.sh')], SH] })
    expect(named).toBe(Number(readFileSync(join(dir, 'pid'), 'utf8')))
    expect(named).not.toBe(process.pid)
  })
  // macOS's /bin/sh is a bash that execs the hook (no `; exit $?` here, as an engine runs it): nothing to climb.
  it.runIf(process.platform === 'darwin')('on macOS a hook names its parent, the engine, and reads nothing under /proc', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-caller-'))
    tmpDirs.push(dir)
    expect(await paneCaller({ via: [['/bin/sh', '-c', '"$0" "$@"']], procReadLog: join(dir, 'proc-reads') })).toBe(process.pid)
    expect(existsSync(join(dir, 'proc-reads'))).toBe(false)
  })
})

// The gateway and the Codex home are the hook's to say, from its own environment: the daemon reads no other process's
// (src/hookServer.ts hookFacts).
describe('hook notify: what the hook says of its own environment', () => {
  const GATEWAY_HEADER = 'x-harness-hook-gateway', CODEX_HOME_HEADER = 'x-harness-hook-codex-home'
  const recordings = JSON.parse(readFileSync(new URL('./lib/__fixtures__/prompt-hooks.json', import.meta.url), 'utf8'))
  /** What registers each engine's session in a pane: its UserPromptSubmit, and Hermes's session start. */
  const registration = (engine: 'claude' | 'codex' | 'hermes') => engine === 'hermes'
    ? { hook_event_name: 'on_session_start', session_id: '20260810_120000_a1b2c3' }
    : recordings[engine].input
  /** Only what a case sets: the endpoints and the Codex home of the machine running the specs never reach the hook. */
  const own = (env: Record<string, string> = {}) => ({ ANTHROPIC_BASE_URL: '', OPENAI_BASE_URL: '', OPENAI_API_BASE: '', CODEX_HOME: '', ...env })

  it.each<['claude' | 'hermes', Record<string, string>, string]>([
    ['claude', { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' }, 'ori'],
    ['claude', { OPENAI_API_BASE: 'https://eu.openrouter.ai/api/v1' }, 'ori'],
    ['hermes', { OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' }, 'ori'],
    ['claude', {}, 'none'],
    ['claude', { ANTHROPIC_BASE_URL: 'https://grid.example/relay' }, 'none'],
    ['claude', { ANTHROPIC_BASE_URL: 'https://openrouter.ai.example.com/api' }, 'none'],
    ['claude', { ANTHROPIC_BASE_URL: 'https://example.com/openrouter.ai' }, 'none'],
    ['claude', { ANTHROPIC_BASE_URL: 'not a url' }, 'none'],
  ])('%s with %j says gateway %s', async (engine, env, gateway) => {
    const { port, headers } = await collect()
    await runHook({ port, engine, tmuxPane: '%42', env: own(env), input: registration(engine) })
    expect(headers).toHaveLength(1)
    expect(headers[0][GATEWAY_HEADER]).toBe(gateway)
  })

  it('says nothing of the gateway for Codex, whose argv says it', async () => {
    const { port, requests, headers } = await collect()
    await runHook({ port, engine: 'codex', tmuxPane: '%42', env: own({ OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' }), input: registration('codex') })
    expect(requests.map((request) => request.url)).toEqual(['/api/hook/session-start'])
    expect(headers[0][GATEWAY_HEADER]).toBeUndefined()
  })

  it('sends a Codex home of its own, whole, and none for its default, a relative one, one over 1,024 characters or one with a control character', async () => {
    const home = shortHome()
    // Past Latin-1, which Node refuses in a header value, and would end the hook.
    const codexHome = join(home, 'nhà コード', '.codex-work')
    const { port, requests, headers } = await collect()
    await runHook({ port, engine: 'codex', tmuxPane: '%42', env: own({ HOME: home, CODEX_HOME: codexHome }), input: registration('codex') })
    expect(decodeURIComponent(String(headers[0][CODEX_HOME_HEADER]))).toBe(codexHome)
    for (const value of [join(home, '.codex'), 'relative', `/${'x'.repeat(1024)}`, '/bad\u0007x', '']) {
      await runHook({ port, engine: 'codex', tmuxPane: '%42', env: own({ HOME: home, CODEX_HOME: value }), input: registration('codex') })
    }
    await runHook({ port, engine: 'claude', tmuxPane: '%42', env: own({ HOME: home, CODEX_HOME: codexHome }), input: registration('claude') })
    expect(requests).toHaveLength(7)
    expect(headers.slice(1).map((sent) => sent[CODEX_HOME_HEADER])).toEqual(Array(6).fill(undefined))
  })

  it('sends no value of a key or an endpoint, and no fact in the body', async () => {
    const secret = 'sk-or-v1-secret'
    const { port, requests, headers } = await collect()
    await runHook({ port, engine: 'claude', tmuxPane: '%42', input: registration('claude'), env: own({
      OPENROUTER_API_KEY: secret, ANTHROPIC_AUTH_TOKEN: secret, ANTHROPIC_API_KEY: secret, OPENAI_API_KEY: secret,
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
    }) })
    expect(headers[0][GATEWAY_HEADER]).toBe('ori')
    const sent = JSON.stringify([requests, headers])
    expect(sent).not.toContain(secret)
    expect(sent).not.toContain('openrouter.ai')
    expect(requests[0].body).not.toHaveProperty('gateway')
    expect(requests[0].body).not.toHaveProperty('codexHome')
  })

  it('says them on the registration alone', async () => {
    const { port, requests, headers } = await collect()
    const env = own({ ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' })
    await runHook({ port, engine: 'claude', tmuxPane: '%42', env, input: registration('claude') })
    await runHook({ port, engine: 'claude', tmuxPane: '%42', env, input: { ...registration('claude'), hook_event_name: 'Stop' } })
    expect(requests.map((request) => request.url)).toEqual(['/api/hook/session-start', '/api/hook/turn-stop'])
    expect(headers[0][GATEWAY_HEADER]).toBe('ori')
    expect([headers[1][GATEWAY_HEADER], headers[1][CODEX_HOME_HEADER]]).toEqual([undefined, undefined])
  })
})

// The engine's own word, from a Harness pane, that it waits on the person, ended a turn, or runs a subagent.
describe('hook notify: waits, turn ends and subagents from a pane', () => {
  const urls = (requests: Array<{ url: string }>) => requests.map((request) => request.url)
  // Claude Code's hook payload names no version.
  const subagent = (event: 'SubagentStart' | 'SubagentStop', fields: Record<string, unknown> = {}) => ({
    hook_event_name: event, session_id: 'lead-1', agent_id: 'agent-7', agent_type: 'Explore', ...fields,
  })
  /** Every event this change installs, engine by engine. */
  const NEW_EVENTS = [
    ['claude', 'PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }],
    ['claude', 'PermissionRequest', { hook_event_name: 'PermissionRequest', tool_name: 'Bash' }],
    ['claude', 'Elicitation', { hook_event_name: 'Elicitation', mcp_server_name: 'docs' }],
    ['claude', 'SubagentStart', subagent('SubagentStart')],
    ['claude', 'SubagentStop', subagent('SubagentStop')],
    ['codex', 'PermissionRequest', { hook_event_name: 'PermissionRequest', tool_name: 'exec_command' }],
    ['codex', 'PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'request_user_input' }],
    ['codex', 'Stop', { hook_event_name: 'Stop', turn_id: 't1' }],
    ['codex', 'Interrupt', { hook_event_name: 'Interrupt', turn_id: 't1' }],
  ] as const

  it.each([
    ['claude', 'PreToolUse', 'AskUserQuestion'], ['codex', 'PermissionRequest', 'exec_command'], ['codex', 'PreToolUse', 'request_user_input'],
  ] as const)('%s %s in a pane posts a wait with the event and the tool\'s name, and none of its input', async (engine, event, tool) => {
    const { port, requests } = await collect()
    await runHook({ port, engine, tmuxPane: '%4', input: { hook_event_name: event, session_id: 'sess-1', tool_name: tool, tool_input: { command: 'input-secret' } } })
    expect(urls(requests)).toEqual(['/api/hook/wait'])
    expect(requests[0].body).toMatchObject({ engine, sessionId: 'sess-1', hookEvent: event, toolName: tool })
    expect(JSON.stringify(requests[0].body)).not.toContain('input-secret')
  })

  // A matcher edited by hand must not turn each tool call into a request to the daemon.
  it.each(['claude', 'codex'] as const)('%s PreToolUse for any other tool posts nothing', async (engine) => {
    const { port, requests } = await collect()
    await runHook({ port, engine, tmuxPane: '%4', input: { hook_event_name: 'PreToolUse', session_id: 'sess-1', tool_name: 'Bash', tool_input: { command: 'ls' } } })
    expect(requests).toEqual([])
  })

  // Variant P (facts-claude §1): PermissionRequest and Elicitation fire as the dialog opens; Notification only after 6 s.
  it.each([
    ['PermissionRequest', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'input-secret' } }, { toolName: 'Bash' }],
    ['Elicitation', { hook_event_name: 'Elicitation', mcp_server_name: 'docs', message: 'input-secret', requested_schema: {} }, {}],
  ] as const)('claude %s posts a wait, and none of what it asks', async (_event, input, tool) => {
    const { port, requests } = await collect()
    await runHook({ port, tmuxPane: '%4', input: { ...input, session_id: 'sess-1' } })
    expect(urls(requests)).toEqual(['/api/hook/wait'])
    expect(requests[0].body).toMatchObject({ engine: 'claude', sessionId: 'sess-1', hookEvent: input.hook_event_name, ...tool })
    expect(JSON.stringify(requests[0].body)).not.toContain('input-secret')
  })

  // Claude Code runs both for one AskUserQuestion dialog (facts-claude §5): two waits on the same session open one.
  it('claude AskUserQuestion\'s PreToolUse and its PermissionRequest each post the same wait', async () => {
    const { port, requests } = await collect()
    for (const event of ['PreToolUse', 'PermissionRequest']) {
      await runHook({ port, tmuxPane: '%4', input: { hook_event_name: event, session_id: 'sess-1', tool_name: 'AskUserQuestion' } })
    }
    expect(requests.map((request) => [request.url, request.body.sessionId, request.body.toolName])).toEqual([
      ['/api/hook/wait', 'sess-1', 'AskUserQuestion'], ['/api/hook/wait', 'sess-1', 'AskUserQuestion'],
    ])
  })

  it('codex Stop in a pane posts turn-stop; codex Interrupt posts turn-stop with status interrupted', async () => {
    const { port, requests } = await collect()
    for (const event of ['Stop', 'Interrupt']) {
      await runHook({ port, engine: 'codex', tmuxPane: '%4', input: { hook_event_name: event, session_id: 'sess-1', turn_id: 't1', last_assistant_message: 'text-secret' } })
    }
    expect(urls(requests)).toEqual(['/api/hook/turn-stop', '/api/hook/turn-stop'])
    expect(requests[0].body).toMatchObject({ engine: 'codex', sessionId: 'sess-1', hookEvent: 'Stop' })
    expect(requests[0].body.status).toBeUndefined()
    expect(requests[1].body).toMatchObject({ engine: 'codex', sessionId: 'sess-1', hookEvent: 'Interrupt', status: 'interrupted' })
    expect(JSON.stringify(requests)).not.toContain('text-secret')
  })

  it('claude SubagentStart and SubagentStop post /api/hook/subagent with the lead\'s session', async () => {
    const { port, requests } = await collect()
    await runHook({ port, tmuxPane: '%4', input: subagent('SubagentStart') })
    await runHook({ port, tmuxPane: '%4', input: subagent('SubagentStop', { last_assistant_message: 'text-secret' }) })
    expect(requests.map((request) => [request.url, request.body.sessionId, request.body.hookEvent])).toEqual([
      ['/api/hook/subagent', 'lead-1', 'SubagentStart'], ['/api/hook/subagent', 'lead-1', 'SubagentStop'],
    ])
    expect(JSON.stringify(requests)).not.toContain('text-secret')
  })

  // Claude Code's own helpers (prompt suggestions, /btw) end with a SubagentStop of no type, after no SubagentStart.
  it.each([[''], [undefined]])('claude SubagentStop with agent_type %j posts nothing', async (agentType) => {
    const { port, requests } = await collect()
    await runHook({ port, tmuxPane: '%4', input: subagent('SubagentStop', { agent_type: agentType }) })
    expect(requests).toEqual([])
  })

  // The hook cannot tell which Claude Code sent it, so no version gates its subagent events.
  it.each([[{}], [{ version: '2.1.300' }]])('claude %j: its subagent events post', async (fields) => {
    const { port, requests } = await collect()
    for (const event of ['SubagentStart', 'SubagentStop'] as const) {
      await runHook({ port, tmuxPane: '%4', input: subagent(event, fields) })
    }
    expect(urls(requests)).toEqual(['/api/hook/subagent', '/api/hook/subagent'])
  })

  // A resumed subagent, or a teammate taking a new message, sends a start with its own stop: the count stays even.
  it('a subagent resumed sends its start and then its stop', async () => {
    const { port, requests } = await collect()
    for (const event of ['SubagentStart', 'SubagentStop', 'SubagentStart', 'SubagentStop'] as const) {
      await runHook({ port, tmuxPane: '%4', input: subagent(event) })
    }
    expect(requests.map((request) => [request.url, request.body.hookEvent])).toEqual([
      ['/api/hook/subagent', 'SubagentStart'], ['/api/hook/subagent', 'SubagentStop'],
      ['/api/hook/subagent', 'SubagentStart'], ['/api/hook/subagent', 'SubagentStop'],
    ])
  })

  // Codex's SubagentStop fires per child turn and never for a failed one (facts-codex §2): its subagents are not counted.
  it.each(['SubagentStart', 'SubagentStop'] as const)('codex %s posts no subagent event', async (event) => {
    const { port, requests } = await collect()
    await runHook({ port, engine: 'codex', tmuxPane: '%4', input: subagent(event) })
    expect(urls(requests)).not.toContain('/api/hook/subagent')
  })

  // Claude Code and Codex read any stdout of these as a decision; an empty one with exit 0 leaves it to the person.
  it.each(NEW_EVENTS)('%s %s writes nothing on stdout and exits 0', async (engine, _event, input) => {
    const { port, requests } = await collect()
    expect(await runHook({ port, engine, tmuxPane: '%4', input: { ...input, session_id: 'sess-1' } })).toBe('')
    expect(requests).toHaveLength(1)
  })

  // Codex runs these before its dialog and waits for them: whatever the daemon answers, they decide nothing.
  it.each(['PermissionRequest', 'PreToolUse'] as const)('codex %s: nothing on stdout and exit 0 when the daemon answers 403, 500 or never', async (event) => {
    for (const answer of [403, 500, 'never'] as const) {
      const seen: string[] = []
      const server = createServer((req, res) => {
        seen.push(req.url ?? '')
        req.resume()
        if (answer !== 'never') res.writeHead(answer).end('{}')
      })
      servers.push(server)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')
      const stdout = await runHook({ port: address.port, engine: 'codex', tmuxPane: '%4', input: {
        hook_event_name: event, session_id: 'sess-1', tool_name: event === 'PreToolUse' ? 'request_user_input' : 'exec_command',
      } })
      server.closeAllConnections()
      expect([answer, stdout, seen]).toEqual([answer, '', ['/api/hook/wait']])
    }
  })

  // Outside a pane the devices hear Codex's own turn end and interrupt as Claude Code's Stop, and none of its words.
  it('outside a pane, a codex Stop tells the devices turn-stop, and its Interrupt turn-aborted', async () => {
    const { port, requests } = await collect()
    for (const [index, event] of ['Stop', 'Interrupt'].entries()) {
      expect(await runHook({ port, engine: 'codex', input: {   // no tmuxPane
        hook_event_name: event, session_id: 'sess-1', turn_id: 't1', cwd: '/w', last_assistant_message: 'text-secret',
      } })).toBe('')
      await received(requests, index + 1)
    }
    expect(requests.map((request) => [request.url, request.body.engine, request.body.sessionId, request.body.event])).toEqual([
      ['/api/hook/observed', 'codex', 'sess-1', 'turn-stop'], ['/api/hook/observed', 'codex', 'sess-1', 'turn-aborted'],
    ])
    expect(JSON.stringify(requests)).not.toContain('text-secret')
  })

  // A lead outside a pane stays working while its subagents run: each event carries the lead's session_id.
  it('outside a pane, claude SubagentStart and a typed SubagentStop tell the devices, with the lead\'s session and no title', async () => {
    const { port, requests } = await collect()
    for (const [index, event] of (['SubagentStart', 'SubagentStop'] as const).entries()) {
      expect(await runHook({ port, input: subagent(event, { cwd: '/w', session_title: 'Tho', last_assistant_message: 'text-secret' }) })).toBe('')
      await received(requests, index + 1)
    }
    expect(requests.map((request) => [request.url, request.body.sessionId, request.body.event])).toEqual([
      ['/api/hook/observed', 'lead-1', 'subagent-start'], ['/api/hook/observed', 'lead-1', 'subagent-stop'],
    ])
    for (const { body } of requests) expect([body.title, body.relayed]).toEqual([undefined, undefined])
    expect(JSON.stringify(requests)).not.toContain('text-secret')
  })

  it.each([[''], [undefined]])('outside a pane, claude SubagentStop with agent_type %j posts nothing', async (agentType) => {
    const { port, requests } = await collect()
    expect(await runHook({ port, input: subagent('SubagentStop', { agent_type: agentType, cwd: '/w' }) })).toBe('')
    expect(requests).toEqual([])
  })

  // Codex's subagents are not counted outside a pane either (facts-codex §2).
  it.each(['SubagentStart', 'SubagentStop'] as const)('outside a pane, codex %s posts nothing', async (event) => {
    const { port, requests } = await collect()
    await runHook({ port, engine: 'codex', input: subagent(event, { cwd: '/w' }) })
    expect(requests).toEqual([])
  })

  /** What a session outside a pane tells the devices of NEW_EVENTS: the waits are its Notification's to say. */
  const TOLD_OUTSIDE = ['SubagentStart', 'SubagentStop', 'Stop', 'Interrupt']
  it.each(NEW_EVENTS.filter(([, event]) => !TOLD_OUTSIDE.includes(event)))('outside a pane, %s %s posts nothing', async (engine, _event, input) => {
    const { port, requests } = await collect()
    await runHook({ port, engine, input: { ...input, session_id: 'sess-1', cwd: '/w' } })
    expect(requests).toEqual([])
  })

  it('outside a pane, claude Stop still tells the devices turn-stop', async () => {
    const { port, requests } = await collect()
    await runHook({ port, input: { hook_event_name: 'Stop', session_id: 'sess-1', cwd: '/w' } })
    await received(requests)
    expect(requests.map((request) => [request.url, request.body.event])).toEqual([['/api/hook/observed', 'turn-stop']])
  })

  it('a Codex child thread\'s hooks still post nothing', async () => {
    const { port, requests } = await collect()
    const child = { session_id: 'sess-1', source: { subagent: { thread_spawn: { parent_thread_id: 'sess-1', depth: 1 } } } }
    await runHook({ port, engine: 'codex', tmuxPane: '%4', input: { ...child, hook_event_name: 'PermissionRequest', tool_name: 'exec_command' } })
    await runHook({ port, engine: 'codex', tmuxPane: '%4', input: { ...child, hook_event_name: 'PreToolUse', tool_name: 'request_user_input' } })
    expect(requests).toEqual([])
  })
})
