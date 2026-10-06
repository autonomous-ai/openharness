/**
 * Which `grid` the sign-in hand-off runs.
 *
 * The hand-off carries the account token, so it has to run the SAME binary every other grid call
 * resolves to (`gridExec.ts`): the developer override, then the managed runtime, then PATH. A
 * hand-off that asked PATH on its own would sign in with one `grid` while models ran on another —
 * two versions writing one `~/.grid`. The token seam itself (stdin, never argv) is covered end to end
 * in `gridCommand.spec.ts`; this file is about WHICH child gets it, and that every kind of sign-in
 * reaches it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let root = ''
let runtimeDir = ''
const saved = { PATH: process.env.PATH, HOME: process.env.HOME, HARNESS_GRID_BIN: process.env.HARNESS_GRID_BIN, ADAPTER_RUNTIME_DIR: process.env.ADAPTER_RUNTIME_DIR }

/** `gridExec.ts` reads `env.ADAPTER_RUNTIME_DIR` at import time, so the module is loaded fresh per case. */
async function load() {
  vi.resetModules()
  process.env.ADAPTER_RUNTIME_DIR = runtimeDir
  return import('./gridHandoff.js')
}

/** A `grid` that records its argv and (on `login`) its standard input, under `label`. A shell script
 *  rather than a Node one, with `/bin/cat` by absolute path: several cases below run with an EMPTY
 *  PATH, where `#!/usr/bin/env node` — or a bare `cat` — would fail for a reason that has nothing to
 *  do with the resolution under test. */
function fakeGrid(dir: string, label: string): string {
  mkdirSync(dir, { recursive: true })
  const bin = join(dir, 'grid')
  writeFileSync(bin, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > "${join(root, `${label}.args`)}"`,
    `printf '%s' "\${GRID_NO_UPDATE_CHECK-unset}" > "${join(root, `${label}.update-check`)}"`,
    `[ "$1" = login ] && /bin/cat > "${join(root, `${label}.stdin`)}"`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 })
  return bin
}

function ran(label: string): boolean { return existsSync(join(root, `${label}.args`)) }
function argsOf(label: string): string[] { return readFileSync(join(root, `${label}.args`), 'utf8').trim().split('\n') }
function updateCheckSeenBy(label: string): string { return readFileSync(join(root, `${label}.update-check`), 'utf8') }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'grid-handoff-'))
  runtimeDir = join(root, 'runtime')
  mkdirSync(runtimeDir)
  // Nothing on PATH unless a case puts something there — never this machine's own `grid`.
  mkdirSync(join(root, 'empty-bin'))
  process.env.PATH = join(root, 'empty-bin')
  // The resolver's last fallback is `$HOME/.local/bin/grid` (grid's own installer's path), so a
  // developer machine that has one must not leak into "nothing to run".
  process.env.HOME = root
  delete process.env.HARNESS_GRID_BIN
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

describe('handOffToGrid — which grid it runs', () => {
  it('runs the grid HARNESS_GRID_BIN names, with nothing on PATH', async () => {
    const override = fakeGrid(join(root, 'elsewhere'), 'override')
    process.env.HARNESS_GRID_BIN = override
    const { handOffToGrid } = await load()

    const result = await handOffToGrid('tok_1', { json: true })

    expect(result.code).toBe('OK')
    expect(argsOf('override')).toEqual(['login', '--harness', '--json'])
    expect(readFileSync(join(root, 'override.stdin'), 'utf8')).toBe('tok_1\n')
    // grid's own "a newer version is out — run `grid update`" must never reach a binary the
    // harness pins: `update` would overwrite it in place. Off for every child this daemon spawns.
    expect(updateCheckSeenBy('override')).toBe('1')
  })

  it('prefers the managed runtime over a grid on PATH', async () => {
    fakeGrid(join(root, 'path-bin'), 'path')
    process.env.PATH = join(root, 'path-bin')
    const managed = fakeGrid(join(runtimeDir, 'grid-0.3.47-darwin-arm64'), 'managed')
    writeFileSync(join(runtimeDir, 'current-grid'), `${managed}\n`)
    const { handOffToGrid } = await load()

    const result = await handOffToGrid('tok_2', { json: true })

    expect(result.code).toBe('OK')
    expect(argsOf('managed')).toEqual(['login', '--harness', '--json'])
    expect(ran('path')).toBe(false)
  })

  it('reports GRID_CLI_MISSING when neither the managed runtime nor PATH has one', async () => {
    const { handOffToGrid } = await load()

    const result = await handOffToGrid('tok_3', { json: true })

    expect(result).toMatchObject({ code: 'GRID_CLI_MISSING', exitCode: 1 })
    expect(result.message).toContain('grid')
  })
})

/**
 * A computer signed in by QR holds a Harness-issued sign-in. The hand-off used to refuse one before
 * `grid` was ever asked, because the control plane could only read Autonomous tokens. It now asks the
 * Harness backend who holds one (autonomous-grid ADR 0046), so accepting or refusing it is `grid`'s
 * answer to give, and this module passes the token on like any other.
 */
describe('handOffToGrid — a Harness-issued sign-in', () => {
  /** The shape the Harness backend issues (`backend/src/lib/harnessTokenFormat.ts`): `hna_` and 43
   *  base64url characters. The removed refusal matched on the prefix alone. */
  const HARNESS_ISSUED = `hna_${'Q'.repeat(43)}`

  it('hands it to grid on standard input, exactly as it does an Autonomous token', async () => {
    fakeGrid(join(root, 'path-bin'), 'path')
    process.env.PATH = join(root, 'path-bin')
    const { handOffToGrid } = await load()

    const result = await handOffToGrid(HARNESS_ISSUED, { json: true })

    expect(result).toMatchObject({ code: 'OK', exitCode: 0, message: '' })
    expect(argsOf('path')).toEqual(['login', '--harness', '--json'])
    expect(readFileSync(join(root, 'path.stdin'), 'utf8')).toBe(`${HARNESS_ISSUED}\n`)
  })
})

/**
 * What a refusal says. `grid` refuses on stderr, and under `--json` it writes one JSON line there —
 * `{"error": {"code", "message", "status"}}` (autonomous-grid `cli/json_error.py`) — before the
 * interpreter prints the same sentence in plain text. The daemon's Set up shows this module's
 * `message` and nothing else, so a refusal that names its own way forward has to arrive there, not
 * only on `stderr`.
 */
describe('handOffToGrid — grid\'s own refusal', () => {
  /** What the control plane says while Harness has not yet learned the account's Google identity
   *  (ADR 0046), rendered the way `grid` renders every control-plane refusal (`control_plane._raise`). */
  const SENTENCE = 'POST https://cp.example.test/v1/grid/auth/harness failed (409): {"detail":"Harness hasn\'t '
    + 'confirmed this account\'s Google identity yet, so nothing was changed. Sign in to Harness once with '
    + 'Google, Apple or your email on any device, then try again."}'
  const ENVELOPE = JSON.stringify({ error: { code: null, message: SENTENCE, status: 409 } })

  /** A `grid` that reads the token, writes `stderr` and exits `status`. The text goes through a file
   *  so no shell quoting stands between the test and the bytes `grid` would write. */
  function refusingGrid(dir: string, stderr: string, status: number): string {
    mkdirSync(dir, { recursive: true })
    const said = join(dir, 'stderr.txt')
    writeFileSync(said, stderr)
    const bin = join(dir, 'grid')
    writeFileSync(bin, ['#!/bin/sh', '/bin/cat > /dev/null', `/bin/cat "${said}" >&2`, `exit ${status}`, ''].join('\n'), { mode: 0o755 })
    return bin
  }

  it('carries the envelope\'s sentence as the message, and leaves stderr as grid wrote it', async () => {
    // The order the real `grid` writes them in: the envelope from `main()`'s handler, then the
    // interpreter's own print of the same `SystemExit` on its way out.
    const stderr = `${ENVELOPE}\n${SENTENCE}\n`
    process.env.HARNESS_GRID_BIN = refusingGrid(join(root, 'refuses'), stderr, 1)
    const { handOffToGrid } = await load()

    const result = await handOffToGrid('tok_refused', { json: true })

    expect(result).toMatchObject({ code: 'GRID_LOGIN_FAILED', exitCode: 1, message: SENTENCE, stderr })
  })

  it('falls back to the exit code when grid wrote no envelope', async () => {
    process.env.HARNESS_GRID_BIN = refusingGrid(join(root, 'plain'), `${SENTENCE}\n`, 1)
    const { handOffToGrid } = await load()

    const result = await handOffToGrid('tok_plain', { json: true })

    expect(result).toMatchObject({ code: 'GRID_LOGIN_FAILED', exitCode: 1, message: '`grid login --harness` exited 1.' })
  })

  it('falls back to the exit code when no envelope carries a sentence', async () => {
    const blank = JSON.stringify({ error: { code: 'some_code', message: ' \n ', status: 400 } })
    const none = JSON.stringify({ error: { code: null, message: null, status: null } })
    process.env.HARNESS_GRID_BIN = refusingGrid(join(root, 'blank'), `{not json\n${blank}\n${none}\n`, 1)
    const { handOffToGrid } = await load()

    const result = await handOffToGrid('tok_blank', { json: true })

    expect(result.message).toBe('`grid login --harness` exited 1.')
  })

  it('reads no envelope without json: grid\'s stderr went to the terminal, uncaptured', async () => {
    process.env.HARNESS_GRID_BIN = refusingGrid(join(root, 'human'), `${ENVELOPE}\n${SENTENCE}\n`, 1)
    const { handOffToGrid } = await load()

    const result = await handOffToGrid('tok_human')

    expect(result).toMatchObject({ code: 'GRID_LOGIN_FAILED', message: '`grid login --harness` exited 1.', stderr: '' })
  })

  it('still calls exit 2 an outdated grid, though argparse\'s refusal comes with an envelope too', async () => {
    // What a `grid` predating `--harness` writes under `--json`: argparse's `SystemExit(2)` carries no
    // sentence, so the envelope's is json_error's generic one — and "too old" is the only useful reading.
    const argparse = JSON.stringify({ error: { code: null, message: 'the command failed with exit status 2', status: null } })
    process.env.HARNESS_GRID_BIN = refusingGrid(join(root, 'old'), `${argparse}\nusage: grid login [-h]\n`, 2)
    const { handOffToGrid } = await load()

    const result = await handOffToGrid('tok_old', { json: true })

    expect(result).toMatchObject({ code: 'GRID_CLI_OUTDATED', exitCode: 2 })
    expect(result.message).toContain('too old')
  })

  it('shows the sentence as one bounded line, whatever bytes the child put in it', async () => {
    // Astral characters past the bound: a cut by UTF-16 unit would leave half a surrogate pair.
    const noisy = `first line\nsecond\tline \u001b[31mred\u001b[0m \u009b2J \u202eagain\u2066\u200b. ${'\u{1F600}'.repeat(700)}`
    const envelope = JSON.stringify({ error: { code: null, message: noisy, status: 500 } })
    process.env.HARNESS_GRID_BIN = refusingGrid(join(root, 'noisy'), `${envelope}\n`, 1)
    const { handOffToGrid } = await load()

    const result = await handOffToGrid('tok_noisy', { json: true })

    expect(result.message.startsWith('first line second line [31mred [0m 2J again . \u{1F600}')).toBe(true)
    expect(result.message).not.toMatch(/[\p{Cc}\p{Cf}]/u)
    expect(result.message).not.toMatch(/\p{Surrogate}/u)
    expect(Array.from(result.message)).toHaveLength(600)
    expect(result.message.endsWith('\u{1F600}…')).toBe(true)
  })
})

/**
 * The watchdog. `grid login --harness` makes two control-plane round trips, and a connection that is
 * accepted and then answered by nobody used to leave this promise pending for good — a `harness
 * login` that never returned, and a daemon reconcile that never settled.
 */
describe('handOffToGrid — a child that never answers', () => {
  /** A `grid` that reads the token and then hangs, the shape of a black-holed control plane.
   *
   *  It IGNORES SIGTERM on purpose: that is the case the watchdog's `SIGKILL` exists for, and a fake
   *  that died politely would let a child which cannot be asked to stop pass as one that can. (The
   *  signal itself is not observable through this module's result — the kill and the settle happen
   *  together — so what this pins is that a TERM-immune child still ends the call.) */
  function hangingGrid(dir: string): string {
    mkdirSync(dir, { recursive: true })
    const bin = join(dir, 'grid')
    // Absolute paths, since PATH is empty here: Linux's sh exits 127 on a bare `sleep` before the watchdog fires.
    writeFileSync(bin, ['#!/bin/sh', "trap '' TERM", '/bin/cat > /dev/null', '/bin/sleep 60', ''].join('\n'), { mode: 0o755 })
    return bin
  }

  it('kills it and reports a timeout rather than awaiting forever', async () => {
    process.env.HARNESS_GRID_BIN = hangingGrid(join(root, 'hangs'))
    const { handOffToGrid } = await load()

    const started = Date.now()
    const result = await handOffToGrid('tok_hang', { json: true, timeoutMs: 300 })

    // It returned at all — the property the whole watchdog exists for.
    expect(Date.now() - started).toBeLessThan(10_000)
    // Classified as the ordinary failure rather than a new code, so every caller's existing
    // handling applies unchanged (the same choice `gridExec` makes for its own timeout).
    expect(result).toMatchObject({ code: 'GRID_LOGIN_FAILED', exitCode: 1 })
    expect(result.message).toContain('did not answer')
  }, 20_000)

  it('does not arm the timeout against a child that answers promptly', async () => {
    fakeGrid(join(root, 'prompt-bin'), 'prompt')
    process.env.HARNESS_GRID_BIN = join(root, 'prompt-bin', 'grid')
    const { handOffToGrid } = await load()

    // A timeout far shorter than the case would take if the timer were not cleared on success.
    const result = await handOffToGrid('tok_fast', { json: true, timeoutMs: 5_000 })

    expect(result.code).toBe('OK')
    expect(argsOf('prompt')).toEqual(['login', '--harness', '--json'])
  })
})
