// Opt-in, echo-only delivery: no installed engine, daemon, network or developer tmux server.
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { isolatedTmux, type IsolatedTmux } from '../testing/isolatedTmux.js'
import { ReviewedInput } from './reviewedInput.js'
import type { RegisteredSession } from './registry.js'
import { TerminalBackendCoordinator } from './terminalBackendCoordinator.js'
import { TmuxBackend } from './tmuxBackend.js'
import { lookupPaneEngineProcess, sendReviewedToTmux } from './tmux.js'
import { terminalRouteKey } from './terminalRuntime.js'

const run = process.env.RUN_REVIEWED_INPUT_TMUX === '1' ? describe : describe.skip
const exec = promisify(execFile)
run.sequential('reviewed delivery to an isolated echo process', () => {
  let server: IsolatedTmux, binary: string, serial = 0
  const oldClaude = env.CLAUDE_PATH
  beforeAll(async () => {
    server = await isolatedTmux()
    vi.stubEnv('TMUX_TMPDIR', server.root); vi.stubEnv('TMUX', undefined); vi.stubEnv('TMUX_PANE', undefined)
    binary = join(server.root, 'reviewed-echo')
    const source = join(server.root, 'echo.c')
    await writeFile(source, `#include <fcntl.h>
#include <termios.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  int fd = open(argv[1], O_CREAT|O_WRONLY|O_APPEND, 0600);
  if (fd < 0) return 3;
  struct termios tty;
  if (tcgetattr(0, &tty)) return 4;
  cfmakeraw(&tty); if (tcsetattr(0, TCSANOW, &tty)) return 5;
  const char ready[] = "\\033[?2004hREADY\\r\\n────────────\\r\\n❯\\r\\n────────────\\r\\n? for shortcuts\\r\\n";
  alarm(90); write(1, ready, sizeof ready - 1);
  char bytes[4096]; ssize_t n;
  while ((n = read(0, bytes, sizeof bytes)) > 0) { write(fd, bytes, n); fsync(fd); }
  close(fd); return 0;
}
`)
    await exec(process.env.CC || 'cc', [source, '-o', binary], { timeout: 30_000 })
    // Override only the fixture's discovery ownership. Nothing launches the installed Claude binary.
    env.CLAUDE_PATH = binary; vi.stubEnv('CLAUDE_PATH', binary)
  }, 40_000)
  afterAll(async () => {
    env.CLAUDE_PATH = oldClaude; vi.unstubAllEnvs()
    await server?.close() // cleanup always uses the captured private socket
  })
  async function pane() {
    const log = join(server.root, `input-${++serial}`)
    const id = await server.run('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', `reviewed-${serial}`, binary, log)
    await vi.waitFor(async () => expect(await server.run('capture-pane', '-p', '-t', id)).toContain('READY'))
    const found = await lookupPaneEngineProcess(id, 'claude')
    if (!found.ok) throw Error(found.reason)
    const runtime = { backend: 'tmux' as const, paneId: id }
    const row = { agentId: `echo-${serial}`, sessionId: `session-${serial}`, engine: 'claude', active: true,
      processIdentity: found.identity, runtimes: [runtime], primaryRuntimeKey: terminalRouteKey(runtime) } as RegisteredSession
    const backend = new TmuxBackend(), terminals = new TerminalBackendCoordinator([backend], ['tmux'])
    const service = new ReviewedInput({ session: agent => agent === row.agentId ? row : undefined, terminals,
      acquire: () => () => {}, isTurnOpen: () => false })
    return { id, log, row, runtime, backend, service }
  }
  async function replace(id: string) {
    const log = join(server.root, `replacement-${++serial}`)
    await server.run('respawn-pane', '-k', '-t', id, binary, log)
    await vi.waitFor(async () => expect(await readFile(log, 'utf8')).toBe(''))
    return log
  }
  it('delivers one preserved command, bracketed paste and one Enter through the real backend', async () => {
    const f = await pane(), pin = await f.service.prepare(f.row.agentId, 'goal')
    expect(pin.ok).toBe(true); if (!pin.ok) return
    expect(await pin.submit('Echo only.')).toEqual({ state: 'submitted' })
    expect(await pin.submit('Do not repeat.')).toEqual({ state: 'submitted' })
    await vi.waitFor(async () => expect(await readFile(f.log, 'utf8')).toBe('\x1b[200~/goal Echo only.\x1b[201~\r'))
  }, 30_000)
  it('rejects same-pane same-engine replacement even when the registry has not noticed it', async () => {
    const f = await pane(), pin = await f.service.prepare(f.row.agentId, 'loop'); if (!pin.ok) throw Error(pin.error)
    const replacement = await replace(f.id)
    expect(await pin.submit('Never retarget.')).toMatchObject({ state: 'rejected' })
    expect(await readFile(f.log, 'utf8')).toBe(''); expect(await readFile(replacement, 'utf8')).toBe('')
  }, 30_000)
  it('checks after asynchronous buffer loading and types nothing into a replacement', async () => {
    const f = await pane()
    let checks = 0, replacement = ''
    const result = await sendReviewedToTmux(f.id, '/goal No input.', async () => {
      if (++checks === 2) replacement = await replace(f.id)
      return (await f.backend.validateReviewed(f.runtime, { engine: 'claude', processIdentity: f.row.processIdentity! })).state === 'alive'
    })
    expect(result).toMatchObject({ dispatch: 'not_started' })
    expect(await readFile(f.log, 'utf8')).toBe(''); expect(await readFile(replacement, 'utf8')).toBe('')
  }, 30_000)
  it('retains ambiguity after paste and never presses Enter when the next guard fails', async () => {
    const f = await pane(); let checks = 0
    expect(await sendReviewedToTmux(f.id, '/loop Pasted only.', async () => ++checks < 3))
      .toMatchObject({ dispatch: 'possibly_executed' })
    await vi.waitFor(async () => expect(await readFile(f.log, 'utf8')).toBe('\x1b[200~/loop Pasted only.\x1b[201~'))
  }, 15_000)
})
