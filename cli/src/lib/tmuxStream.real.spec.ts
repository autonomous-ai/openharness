import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENGINES } from '../engines/types.js'
import type { RegisteredSession } from './registry.js'
import { TerminalStreamManager } from './terminalStreamManager.js'
import type { TerminalBackendCoordinator } from './terminalBackendCoordinator.js'
import { pasteRawIntoTmux } from './tmux.js'
import { TmuxControlStream } from './tmuxStream.js'
import { tmuxFeatures } from './tmuxVersion.js'
import { TerminalBinaryKind, type TerminalBinaryClear } from './terminalBinary.js'

const run = process.env.RUN_REAL_TMUX_STREAM === '1' ? describe : describe.skip

function tmux(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tmux', ['-f', '/dev/null', ...args], { timeout: 3_000 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()))
  })
}

async function eventually(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  // A predicate that throws has not come true yet: a file the pane's process is about to create reads
  // ENOENT for the ~200 ms an older tmux takes to start it.
  const settled = async () => { try { return await predicate() } catch { return false } }
  const deadline = Date.now() + timeoutMs
  while (!await settled() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  expect(await predicate()).toBe(true)
}

run('TmuxControlStream real tmux', () => {
  const session = `harness-stream-${randomUUID().slice(0, 8)}`
  let paneId = ''
  let socketRoot = ''

  beforeAll(async () => {
    // A managed client must not attach to a developer's existing server of another tmux version.
    socketRoot = await mkdtemp(join(tmpdir(), 'harness-stream-server-'))
    vi.stubEnv('TMUX_TMPDIR', socketRoot)
    vi.stubEnv('TMUX', undefined)
    vi.stubEnv('TMUX_PANE', undefined)
  })

  afterAll(async () => {
    await tmux(['kill-server']).catch(() => {})
    vi.unstubAllEnvs()
    await rm(socketRoot, { recursive: true, force: true })
  })

  beforeEach(async () => {
    paneId = await tmux(['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', session, 'bash', '--noprofile', '--norc'])
  })

  afterEach(async () => {
    await tmux(['kill-session', '-t', session]).catch(() => { /* exact disposable session only */ })
  })

  it('captures, streams raw output, accepts input, and resizes one-pane windows', async () => {
    const chunks: Buffer[] = []
    let closedReason = ''
    const opened = await TmuxControlStream.open(paneId, { cols: 96, rows: 28 }, {
      onData: (bytes) => chunks.push(Buffer.from(bytes)),
      onClose: (reason) => { closedReason = reason },
    })
    expect(opened.state).toBe('succeeded')
    if (opened.state !== 'succeeded') return

    const historyMarker = 'HARNESS_OLD_TUI_FRAME_MUST_NOT_REPLAY'
    const styledHistoryMarker = 'HARNESS_STYLED_HISTORY'
    const snapshotMarker = 'HARNESS_SNAPSHOT_OK'
    await opened.value.writeRaw(Buffer.from(
      `printf '\\033[31m${styledHistoryMarker}\\033[0m\\n${historyMarker}\\n'; for i in {1..40}; do printf 'filler-%s\\n' "$i"; done; printf '${snapshotMarker}\\n'\r`,
    ))
    await eventually(async () => (await tmux(['capture-pane', '-p', '-t', paneId])).includes(snapshotMarker))
    opened.value.beginSnapshot()
    const snapshot = await opened.value.snapshot()
    expect(snapshot.state).toBe('succeeded')
    if (snapshot.state === 'succeeded') {
      expect(snapshot.value.cols).toBe(96)
      expect(snapshot.value.rows).toBe(28)
      expect(Buffer.from(snapshot.value.bytes).includes(Buffer.from('\u001bc'))).toBe(true)
      expect(Buffer.from(snapshot.value.bytes).includes(Buffer.from(snapshotMarker))).toBe(true)
      expect(Buffer.from(snapshot.value.bytes).includes(Buffer.from(historyMarker))).toBe(true)
      expect(Buffer.from(snapshot.value.bytes).includes(Buffer.from(`\u001b[31m${styledHistoryMarker}`))).toBe(true)
    }

    const postCutMarker = 'HARNESS_POST_CUT_OK'
    await opened.value.writeRaw(Buffer.from(`printf '${postCutMarker}\\n'\r`))
    await eventually(async () => (await tmux(['capture-pane', '-p', '-t', paneId])).includes(postCutMarker))
    expect(Buffer.concat(chunks).includes(Buffer.from(postCutMarker))).toBe(false)
    opened.value.endSnapshot()
    await eventually(() => Buffer.concat(chunks).includes(Buffer.from(postCutMarker)))

    await opened.value.writeRaw(Buffer.from("printf 'HARNESS_STREAM_OK\\n'\r"))
    const deadline = Date.now() + 3_000
    while (!Buffer.concat(chunks).includes(Buffer.from('HARNESS_STREAM_OK')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(Buffer.concat(chunks).includes(Buffer.from('HARNESS_STREAM_OK'))).toBe(true)

    expect((await opened.value.scroll('up', 5)).state).toBe('succeeded')
    expect(await tmux(['display-message', '-p', '-t', paneId, '#{pane_in_mode}'])).toBe('0')
    expect((await opened.value.scroll('down', 1)).state).toBe('succeeded')
    expect(await tmux(['display-message', '-p', '-t', paneId, '#{pane_in_mode}'])).toBe('0')

    expect((await opened.value.resize({ cols: 110, rows: 35 })).state).toBe('succeeded')
    expect(await tmux(['display-message', '-p', '-t', paneId, '#{pane_width}x#{pane_height}'])).toBe('110x35')
    await opened.value.close()
    expect(await tmux(['display-message', '-p', '-t', paneId, '#{pane_width}x#{pane_height}'])).toBe('110x35')
    expect(closedReason === '' || closedReason === 'closed').toBe(true)
  })

  it('opens and resizes narrow and short panes without flooring them to desktop dimensions', async () => {
    const opened = await TmuxControlStream.open(paneId, { cols: 30, rows: 8 }, {
      onData: () => {}, onClose: () => {},
    })
    expect(opened.state).toBe('succeeded')
    try {
      if (opened.state !== 'succeeded') return
      expect(await tmux(['display-message', '-p', '-t', paneId, '#{pane_width}x#{pane_height}'])).toBe('30x8')
      // Before tmux 2.9 a control client sizes the window, and tmux takes no client under 2x2.
      const least = (await tmuxFeatures()).resizeWindow ? 1 : 2
      for (const asked of [{ cols: 1, rows: 1 }, { cols: 39, rows: 11 }, { cols: 120, rows: 40 }]) {
        const size = { cols: Math.max(least, asked.cols), rows: Math.max(least, asked.rows) }
        expect((await opened.value.resize(asked)).state).toBe('succeeded')
        expect(await tmux(['display-message', '-p', '-t', paneId, '#{pane_width}x#{pane_height}'])).toBe(`${size.cols}x${size.rows}`)
        opened.value.beginSnapshot()
        const snapshot = await opened.value.snapshot()
        expect(snapshot.state).toBe('succeeded')
        if (snapshot.state === 'succeeded') expect(snapshot.value).toMatchObject(size)
        opened.value.endSnapshot()
      }
    } finally {
      if (opened.state === 'succeeded') await opened.value.close()
    }
  })

  it('streams large styled Unicode and control-byte output without losing or changing bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-stream-bytes-'))
    const path = join(directory, 'payload.bin')
    const payload = Buffer.from(`BEGIN_STREAM_BYTES\n${'\x1b[38;5;112m─世界🚀\\\0\x1b[0m\r\n'.repeat(4_000)}END_STREAM_BYTES\n`)
    await writeFile(path, payload)
    const chunks: Buffer[] = []
    const opened = await TmuxControlStream.open(paneId, { cols: 96, rows: 28 }, {
      onData: bytes => chunks.push(Buffer.from(bytes)), onClose: () => {},
    })
    try {
      expect(opened.state).toBe('succeeded')
      if (opened.state !== 'succeeded') return
      // The payload is a file, so a shell echo cannot make the assertion pass.
      // Disable tty newline rewriting before cat sends the exact binary bytes.
      const quotedPath = `'${path.replace(/'/g, `'\\''`)}'`
      expect((await opened.value.writeRaw(Buffer.from(`stty -echo -opost; cat ${quotedPath}\r`))).state).toBe('succeeded')
      await eventually(() => Buffer.concat(chunks).includes(Buffer.from('END_STREAM_BYTES\n')))
      expect(Buffer.concat(chunks).includes(payload)).toBe(true)
    } finally {
      if (opened.state === 'succeeded') await opened.value.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('types every byte exactly as given: quotes, a trailing semicolon, a leading dash, control bytes, UTF-8', async () => {
    // tmux before 3.0 has no `send-keys -H`: there the bytes go as quoted literal text and keys, and this
    // is the case that would show a byte its command parser took for syntax (`literalKeyCommands`).
    const directory = await mkdtemp(join(tmpdir(), 'harness-typed-'))
    const sink = join(directory, 'typed.bin')
    const typed = Buffer.concat([
      Buffer.from("-l 'single' \"double\" $HOME #not-a-comment ~ a;b \\; \t\r\u001b[A\u007f 世界🚀 "),
      Buffer.from([0x0a, 0x00, 0x01, 0x1f]),
      Buffer.from('x'.repeat(5_000) + "';"),
    ])
    const typedSession = `harness-typed-${randomUUID().slice(0, 8)}`
    // A raw tty: every byte reaches `head` as it was written, none taken for a signal or a line edit.
    const typedPane = await tmux([
      'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', typedSession,
      'bash', '--noprofile', '--norc', '-c', `stty raw -echo; head -c ${typed.length} > ${sink}`,
    ])
    try {
      const opened = await TmuxControlStream.open(typedPane, { cols: 120, rows: 30 }, { onData: () => {}, onClose: () => {} })
      expect(opened.state).toBe('succeeded')
      if (opened.state !== 'succeeded') return
      // The pane's `stty raw` must land before the first byte, or the tty would still edit lines.
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect((await opened.value.writeRaw(typed)).state).toBe('succeeded')
      await eventually(async () => (await readFile(sink)).length === typed.length, 5_000)
      expect((await readFile(sink)).equals(typed)).toBe(true)
      await opened.value.close()
    } finally {
      await tmux(['kill-session', '-t', typedSession]).catch(() => { /* best effort */ })
    }
  })

  it('delivers a multi-chunk paste to the pane whole and in order', async () => {
    // 8 KiB in one writeRaw spans several `send-keys -H` commands (INPUT_CHUNK_BYTES is 2 KiB).
    // They are pipelined into the control client, so this is the case that would expose either a
    // lost chunk or a reordered one. Lines stay under the tty's canonical-mode limit on purpose.
    const directory = await mkdtemp(join(tmpdir(), 'harness-paste-'))
    const sink = join(directory, 'paste.txt')
    const pasteSession = `harness-paste-${randomUUID().slice(0, 8)}`
    // tmux runs the command with execvp, not a shell, so the redirect needs an explicit one.
    const pastePane = await tmux([
      'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', pasteSession,
      'bash', '--noprofile', '--norc', '-c', `cat > ${sink}`,
    ])

    try {
      const opened = await TmuxControlStream.open(pastePane, { cols: 120, rows: 30 }, {
        onData: () => { /* echo is irrelevant; the file is the assertion */ },
        onClose: () => { /* torn down below */ },
      })
      expect(opened.state).toBe('succeeded')
      if (opened.state !== 'succeeded') return

      const lines = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(4, '0')}${'y'.repeat(96)}`)
      const payload = Buffer.from(`${lines.join('\r')}\r`)
      // Spans five `send-keys -H` commands at INPUT_CHUNK_BYTES.
      expect(Math.ceil(payload.length / 2048)).toBeGreaterThanOrEqual(5)

      expect((await opened.value.writeRaw(payload)).state).toBe('succeeded')
      await eventually(async () => (await readFile(sink, 'utf8')).split('\n').length > lines.length)

      const written = (await readFile(sink, 'utf8')).split('\n').filter((line) => line.length > 0)
      expect(written).toEqual(lines)
      await opened.value.close()
    } finally {
      await tmux(['kill-session', '-t', pasteSession]).catch(() => { /* best effort */ })
    }
  })

  it('delivers a paste via pasteRaw as one atomic paste-buffer, whole and in order', async () => {
    // Same shape as the writeRaw multi-chunk test above, but through pasteRaw — the point of this
    // test is that a payload big enough to span several `send-keys -H` commands via writeRaw still
    // lands as ONE `tmux paste-buffer` here, which is what lets the program in the pane (readline,
    // Ink, ...) see it as a single paste instead of one per chunk.
    const directory = await mkdtemp(join(tmpdir(), 'harness-pasteraw-'))
    const sink = join(directory, 'paste.txt')
    const pasteSession = `harness-pasteraw-${randomUUID().slice(0, 8)}`
    const pastePane = await tmux([
      'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', pasteSession,
      'bash', '--noprofile', '--norc', '-c', `cat > ${sink}`,
    ])

    try {
      const opened = await TmuxControlStream.open(pastePane, { cols: 120, rows: 30 }, {
        onData: () => { /* echo is irrelevant; the file is the assertion */ },
        onClose: () => { /* torn down below */ },
      })
      expect(opened.state).toBe('succeeded')
      if (opened.state !== 'succeeded') return

      const lines = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(4, '0')}${'z'.repeat(96)}`)
      const text = `${lines.join('\n')}\n`
      // Same size class as the writeRaw test — big enough that writeRaw would span 5+ send-keys
      // commands, so pasteRaw's single paste-buffer path is genuinely exercised, not a size where
      // the two approaches would coincide anyway.
      expect(Math.ceil(Buffer.byteLength(text) / 2048)).toBeGreaterThanOrEqual(5)

      expect((await opened.value.pasteRaw(text)).state).toBe('succeeded')
      await eventually(async () => (await readFile(sink, 'utf8')).split('\n').length > lines.length)

      const written = (await readFile(sink, 'utf8')).split('\n').filter((line) => line.length > 0)
      expect(written).toEqual(lines)
      await opened.value.close()
    } finally {
      await tmux(['kill-session', '-t', pasteSession]).catch(() => { /* best effort */ })
    }
  })

  it('runs every catalog engine through the same manager and real tmux stream', async () => {
    for (const [index, engine] of ENGINES.entries()) {
      const agentId = `real-tmux-${engine}`
      const registered = {
        agentId,
        sessionId: `session-${engine}`,
        engine,
        active: true,
        registeredAt: Date.now(),
        touchedAt: Date.now(),
        runtimes: [{ backend: 'tmux', paneId }],
        primaryRuntimeKey: `tmux:default:${paneId}`,
      } as unknown as RegisteredSession
      const frames: Array<{ type: string; payload: Record<string, unknown> }> = []
      const binaryFrames: TerminalBinaryClear[] = []
      const terminals = {
        openStream: async (_session: RegisteredSession, size: { cols: number; rows: number }, sink: Parameters<typeof TmuxControlStream.open>[2]) =>
          TmuxControlStream.open(paneId, size, sink),
      } as unknown as TerminalBackendCoordinator
      const manager = new TerminalStreamManager({
        terminals,
        resolveAgent: (candidate) => candidate === agentId ? registered : undefined,
        sendTarget: (_connId, type, payload) => { frames.push({ type, payload }); return true },
        sendBinaryTarget: (_connId, frame) => { binaryFrames.push(frame); return true },
        streamingAvailable: true,
      })

      try {
        await manager.handleFrame('matrix-client', 'terminal_open', {
          requestId: `open-${engine}`,
          protocolVersion: 3,
          agentId,
          cols: 90 + index,
          rows: 24,
          compression: ['none'],
        })
        const ready = frames.find((frame) => frame.type === 'terminal_ready')
        expect(ready?.payload).toMatchObject({ agentId, engineId: engine })
        const streamId = ready?.payload.streamId
        expect(typeof streamId).toBe('string')

        const marker = `HARNESS_ENGINE_STREAM_${engine.toUpperCase()}`
        await manager.handleBinary('matrix-client', {
          kind: TerminalBinaryKind.input,
          streamId: streamId as string,
          seq: 0,
          compressed: false,
          bytes: Buffer.from(`printf '${marker}\\n'\r`),
        })
        await eventually(() => binaryFrames.some((frame) => {
          if (frame.kind !== TerminalBinaryKind.output || frame.compressed) return false
          return Buffer.from(frame.bytes).includes(Buffer.from(marker))
        }))

        await manager.handleFrame('matrix-client', 'terminal_resize', {
          streamId,
          resizeSeq: 0,
          cols: 100 + index,
          rows: 30,
        })
        expect(await tmux(['display-message', '-p', '-t', paneId, '#{pane_width}x#{pane_height}']))
          .toBe(`${100 + index}x30`)
        await manager.handleFrame('matrix-client', 'terminal_close', { streamId })
      } finally {
        await manager.stop()
      }
    }
  }, 60_000)

  it('never mistakes the control client handshake for the first snapshot command', async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const opened = await TmuxControlStream.open(paneId, { cols: 100, rows: 30 }, {
        onData: () => {},
        onClose: () => {},
      })
      expect(opened.state).toBe('succeeded')
      if (opened.state !== 'succeeded') continue
      opened.value.beginSnapshot()
      const snapshot = await opened.value.snapshot()
      expect(snapshot.state).toBe('succeeded')
      opened.value.endSnapshot()
      await opened.value.close()
    }
  })

  it('keeps the tmux server up while terminals open and close side by side and messages are pasted', async () => {
    // Before tmux 3.7 a notification for every control client (one going, a paste buffer set or deleted)
    // that met one still attaching crashed the server, every agent's pane with it (tmux issue 4980,
    // tmuxControlGate.ts). This is windows.e2e.ts's churn, which found it: on Ubuntu 24.04's tmux 3.4,
    // without the gate, the server segfaulted within the first few hundred of these rounds.
    const beside = `${session}-beside`
    const besidePane = await tmux(['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', beside, 'cat'])
    const sink = { onData: () => {}, onClose: () => {} }
    const openAndClose = async (pane: string, readOnly: boolean) => {
      const opened = await TmuxControlStream.open(pane, { cols: 90, rows: 25 }, sink, readOnly)
      expect(opened.state, opened.state === 'failed' ? opened.reason : '').toBe('succeeded')
      if (opened.state === 'succeeded') await opened.value.close()
    }
    try {
      for (let round = 0; round < 300; round++) {
        await Promise.all([
          openAndClose(paneId, false),
          openAndClose(besidePane, true),
          openAndClose(paneId, true),
          pasteRawIntoTmux(besidePane, `round ${round}\n`),
        ])
      }
      expect(await tmux(['display-message', '-p', '-t', paneId, '#{pane_id}'])).toBe(paneId)
    } finally {
      await tmux(['kill-session', '-t', beside]).catch(() => { /* best effort */ })
    }
  }, 120_000)
})
