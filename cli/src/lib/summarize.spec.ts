import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  configure: vi.fn(),
  runClaude: vi.fn(),
  runCodex: vi.fn(),
  runCursor: vi.fn(),
  runGrok: vi.fn(),
  cleanupCursor: vi.fn(),
  setCounts: vi.fn(),
  resolveKey: vi.fn(),
  complete: vi.fn(),
}))

vi.mock('../config/env.js', () => ({
  env: {
    ADAPTER_DATA_DIR: '/tmp/machine-adapter-summarize-spec',
    CURSOR_HOME: '/tmp/machine-adapter-summarize-spec/cursor',
    SUMMARY_MODEL: 'sonnet',
    CODEX_SUMMARY_MODEL: 'gpt-5.5',
    CURSOR_SUMMARY_MODEL: 'auto',
    GROK_SUMMARY_MODEL: 'grok-4.5',
    SUMMARY_EFFORT: 'low',
    ORI_SUMMARY_MODEL: 'deepseek/deepseek-v4-flash',
  },
}))

vi.mock('./openrouter.js', () => ({
  resolveOpenRouterKey: mocks.resolveKey,
  openRouterComplete: mocks.complete,
}))

vi.mock('./oneshot.js', () => ({
  cleanupCursorOneShotSession: mocks.cleanupCursor,
  configureOneShotPool: mocks.configure,
  runClaudeOneShot: mocks.runClaude,
  runCodexOneShot: mocks.runCodex,
  runCursorOneShot: mocks.runCursor,
  runGrokOneShot: mocks.runGrok,
  setOneShotPoolActiveCounts: mocks.setCounts,
  setOneShotPoolDeviceConnected: vi.fn(),
  shutdownOneShotPool: vi.fn(),
}))

import { deriveReaderText, deriveTurnBody, summarizeTurnText, syncSummaryPoolSessions, deriveTurnSummary } from './summarize.js'

beforeEach(() => {
  mocks.runClaude.mockReset()
  mocks.runCodex.mockReset()
  mocks.runCursor.mockReset()
  mocks.runGrok.mockReset()
  mocks.cleanupCursor.mockReset()
  mocks.cleanupCursor.mockResolvedValue(undefined)
  mocks.setCounts.mockReset()
  mocks.resolveKey.mockReset()
  mocks.complete.mockReset()
})

describe('gateway recap', () => {
  const gateway = { kind: 'ori' as const, apiKey: 'sk-or-v1-process' }

  it('calls OpenRouter directly and never spawns a vendor one-shot', async () => {
    // The point of the whole path: an `ori claude` user may hold no Anthropic credential at all, so the
    // engine one-shot would spawn a CLI that cannot authenticate and the recap would never arrive.
    mocks.resolveKey.mockResolvedValue('sk-or-v1-process')
    mocks.complete.mockResolvedValue('Recap works through the gateway.')

    await expect(summarizeTurnText(
      'Wired the gateway recap path.',
      undefined,
      'Does the gateway recap work?',
      'claude',
      gateway,
    )).resolves.toBe('Recap works through the gateway.\n\nWired the gateway recap path.')

    expect(mocks.complete).toHaveBeenCalledTimes(1)
    expect(mocks.complete.mock.calls[0][0]).toMatchObject({
      model: 'deepseek/deepseek-v4-flash',
      apiKey: 'sk-or-v1-process',
      // A headline in any script, not a paragraph.
      maxTokens: 160,
    })
    expect(mocks.runClaude).not.toHaveBeenCalled()
  })

  it('falls back to the engine one-shot when no key resolves', async () => {
    mocks.resolveKey.mockResolvedValue(null)
    mocks.runClaude.mockResolvedValue({ text: 'Engine recap.', sessionId: null })

    await expect(summarizeTurnText('Did the work.', undefined, 'Status?', 'claude', gateway))
      .resolves.toBe('Engine recap.\n\nDid the work.')

    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.runClaude).toHaveBeenCalledTimes(1)
    expect(mocks.runClaude.mock.calls[0][0]).toMatchObject({ model: 'sonnet' })
  })

  it('leaves a normal vendor agent on its own engine one-shot', async () => {
    mocks.runClaude.mockResolvedValue({ text: 'Engine recap.\n\nNothing changed here.', sessionId: null })

    await expect(summarizeTurnText('Did the work.', undefined, 'Status?', 'claude')).resolves.toBeTruthy()

    expect(mocks.resolveKey).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
  })
})

describe('previous recap', () => {
  it('quotes the previous turn\'s recap as continuity context, fenced off from the content', async () => {
    mocks.runClaude.mockResolvedValue({ text: 'Applied the same change to server.ts.\n\nDone.', sessionId: null })

    await summarizeTurnText(
      'Done, applied the same change to server.ts.',
      undefined,
      'same fix in the other file',
      'claude',
      undefined,
      'Fixed the retry path in client.ts.\n\nThe retry now backs off\nand caps at five attempts.',
    )

    const prompt = mocks.runClaude.mock.calls[0][0].prompt as string
    // Flattened — the stored body's line breaks must not read as structure to preserve.
    expect(prompt).toContain('«Fixed the retry path in client.ts. The retry now backs off and caps at five attempts.»')
    expect(prompt).toContain('PREVIOUS turn')
    // Context, not content: the block sits BEFORE the turn's own message, and the message is unchanged.
    expect(prompt.indexOf('PREVIOUS turn')).toBeLessThan(prompt.indexOf('---\nDone, applied the same change'))
  })

  it('says nothing about a previous turn when there is none', async () => {
    mocks.runClaude.mockResolvedValue({ text: 'Fixed the retry path.\n\nDone.', sessionId: null })

    await summarizeTurnText('Fixed the retry path in client.ts.', undefined, 'fix the retry path', 'claude')

    const prompt = mocks.runClaude.mock.calls[0][0].prompt as string
    expect(prompt).not.toContain('PREVIOUS turn')
  })

  it('does not let the previous recap\'s language trigger the drift retry', async () => {
    // The language check compares the OUTPUT against the ask + answer only. A previous recap in another
    // script is context the model was told to ignore for language, so it must not count as a mismatch.
    mocks.runClaude.mockResolvedValue({ text: 'Deploy finished.\n\nThe service is healthy.', sessionId: null })

    await summarizeTurnText('Deploy finished; service healthy.', undefined, 'deploy status?', 'claude', undefined,
      'Đã sửa đường retry.\n\nRetry giờ lùi dần và dừng ở năm lần.')

    expect(mocks.runClaude).toHaveBeenCalledTimes(1)
  })
})

describe('Cursor recap', () => {
  it('uses a Cursor one-shot with the configured Cursor model', async () => {
    mocks.runCursor.mockResolvedValue({
      text: 'Cursor recap works.',
      sessionId: 'cursor-recap-session',
    })

    await expect(summarizeTurnText(
      'Implemented Cursor recap support.',
      undefined,
      'Does Cursor recap work?',
      'cursor',
    )).resolves.toBe(
      'Cursor recap works.\n\nImplemented Cursor recap support.',
    )

    expect(mocks.runCursor).toHaveBeenCalledOnce()
    expect(mocks.runCursor.mock.calls[0][0]).toMatchObject({
      model: 'auto',
      effort: 'low',
    })
    expect(mocks.runClaude).not.toHaveBeenCalled()
    expect(mocks.runCodex).not.toHaveBeenCalled()
    expect(mocks.cleanupCursor).toHaveBeenCalledWith('cursor-recap-session')
  })

  it('includes Cursor, OpenCode, Kilo and Pi sessions when sizing recap workers', () => {
    syncSummaryPoolSessions([
      { engine: 'claude' },
      { engine: 'codex' },
      { engine: 'cursor' },
      { engine: 'cursor' },
      { engine: 'opencode' },
      // Kilo IS poolable: `kilo run` takes its prompt on stdin and ends at EOF, so a worker can be warmed
      // before the prompt exists — the property hermes and devin lack.
      { engine: 'kilo' },
      { engine: 'pi' },
      { engine: 'commandcode' },
      { engine: 'hermes' }, // not poolable (prompt is argv) — must NOT be counted
      { engine: 'devin' },  // likewise: piping a prompt to `devin -p` panics the CLI
    ])

    expect(mocks.setCounts).toHaveBeenCalledWith({ claude: 1, codex: 1, cursor: 2, opencode: 1, kilo: 1, pi: 1, commandcode: 1 })
  })
})

describe('Grok recap', () => {
  it('uses an isolated direct Grok one-shot with the configured model', async () => {
    mocks.runGrok.mockResolvedValue({
      text: 'Grok recap works.',
      sessionId: 'grok-recap-session',
    })

    await expect(summarizeTurnText(
      'Implemented Grok recap support.',
      undefined,
      'Does Grok recap work?',
      'grok',
    )).resolves.toBe('Grok recap works.\n\nImplemented Grok recap support.')

    expect(mocks.runGrok).toHaveBeenCalledOnce()
    expect(mocks.runGrok.mock.calls[0][0]).toMatchObject({ model: 'grok-4.5', effort: 'low' })
    expect(mocks.runClaude).not.toHaveBeenCalled()
    expect(mocks.runCodex).not.toHaveBeenCalled()
    expect(mocks.runCursor).not.toHaveBeenCalled()
  })
})

describe('language fidelity', () => {
  const VI_SOURCE = 'Đội tuyển Việt Nam đã thắng trận chung kết với tỉ số hai một trước Thái Lan tối qua tại sân Mỹ Đình.'
  const VI_ASK = 'Trận đấu tối qua kết quả thế nào?'

  it('retries when the recap comes back in another language than the source', async () => {
    // The old check only fired for "should be English, came back Vietnamese"; this is the reverse, which
    // is what users actually hit — talking Vietnamese and getting an English recap.
    mocks.runClaude
      .mockResolvedValueOnce({ text: 'Vietnam won the final two one.\n\nVietnam beat Thailand two one last night.', sessionId: 's1' })
      .mockResolvedValueOnce({ text: 'Việt Nam thắng chung kết 2-1.\n\nViệt Nam hạ Thái Lan 2-1 tối qua tại Mỹ Đình.', sessionId: 's2' })

    const out = await summarizeTurnText(VI_SOURCE, undefined, VI_ASK, 'claude')

    expect(mocks.runClaude).toHaveBeenCalledTimes(2)
    expect(mocks.runClaude.mock.calls[1][0].prompt).toContain('RETRY')
    expect(out).toContain('Việt Nam thắng chung kết')
  })

  it('does not retry when the recap keeps the source language', async () => {
    mocks.runClaude.mockResolvedValue({
      text: 'Việt Nam thắng chung kết 2-1.\n\nViệt Nam hạ Thái Lan 2-1 tối qua tại sân Mỹ Đình.',
      sessionId: 's1',
    })

    await summarizeTurnText(VI_SOURCE, undefined, VI_ASK, 'claude')
    expect(mocks.runClaude).toHaveBeenCalledOnce()
  })

  it('does not retry an English turn answered in English', async () => {
    mocks.runClaude.mockResolvedValue({
      text: 'Vietnam won the final two one.\n\nVietnam beat Thailand two one last night at My Dinh stadium.',
      sessionId: 's1',
    })

    await summarizeTurnText(
      'Vietnam won the final against Thailand two one last night at the My Dinh stadium.',
      undefined,
      'How did the match go last night?',
      'claude',
    )
    expect(mocks.runClaude).toHaveBeenCalledOnce()
  })

  it('tolerates a technical term in another script inside a matching recap', async () => {
    // A quoted identifier or product name must not read as a language switch.
    mocks.runClaude.mockResolvedValue({
      text: 'Đã sửa lỗi ở hàm parseConfig.\n\nMình đã sửa hàm parseConfig trong module loader và thêm kiểm tra đầu vào.',
      sessionId: 's1',
    })

    await summarizeTurnText(
      'Mình đã sửa hàm parseConfig trong module loader và thêm kiểm tra đầu vào cho tham số.',
      undefined,
      'Sửa xong chưa?',
      'claude',
    )
    expect(mocks.runClaude).toHaveBeenCalledOnce()
  })
})

describe('the body under the headline', () => {
  // The dial shows the headline and nothing else; the device protocol defines `text` as the answer
  // flattened and clipped. So the model writes ONE line, and the body is excerpted from the answer
  // itself — never a paraphrase that costs tokens on every turn and is shown nowhere.
  const answer = '## Result\n\n- **Deploy**: finished\n- Service is healthy and serving traffic.\n\nNothing else changed.'

  it('is the answer\'s own excerpt, never the model\'s', async () => {
    mocks.runClaude.mockResolvedValue({ text: 'Deploy finished, service healthy.\n\nSome invented paraphrase.', sessionId: 's1' })
    const out = await summarizeTurnText(answer, undefined, 'Done?', 'claude')
    const [recap, body] = out!.split('\n\n')
    expect(recap).toBe('Deploy finished, service healthy.')
    expect(body).toBe(deriveTurnBody(answer))
    expect(body).toBe('Result Deploy: finished Service is healthy and serving traffic. Nothing else changed.')
    expect(out).not.toContain('invented paraphrase')
  })

  it('takes the first non-empty line as the headline when the model still writes more', async () => {
    mocks.runClaude.mockResolvedValue({ text: '\n\nAll good.\nAnd a second line.\n\nA third paragraph…', sessionId: 's1' })
    const out = await summarizeTurnText(answer, undefined, 'Done?', 'claude')
    expect(out!.split('\n\n')[0]).toBe('All good.')
  })

  it('excerpts the whole answer, not the tail the prompt was fed', async () => {
    const opening = 'The opening sentence is what the excerpt should show.'
    const huge = `${opening} ${'filler '.repeat(20_000)}the very end.`
    mocks.runClaude.mockResolvedValue({ text: 'Long answer done.', sessionId: 's1' })
    const out = await summarizeTurnText(huge, undefined, 'Done?', 'claude')
    expect(out!.split('\n\n')[1].startsWith(opening)).toBe(true)
    // The prompt itself still carries only the tail.
    expect((mocks.runClaude.mock.calls[0][0].prompt as string)).not.toContain(opening)
  })

  it('judges language drift on the headline alone', async () => {
    mocks.runClaude.mockResolvedValue({ text: 'All done.\n\nĐoạn thứ hai lạc ngôn ngữ hoàn toàn nhé.', sessionId: 's1' })
    const out = await summarizeTurnText('The deploy finished and the service is healthy.', undefined, 'Done?', 'claude')
    expect(out!.split('\n\n')[0]).toBe('All done.')
    expect(mocks.runClaude).toHaveBeenCalledTimes(1)
  })

  it('never lets an ellipsis into the headline', async () => {
    mocks.runClaude.mockResolvedValue({ text: 'Work is done and then it trails off…', sessionId: 's1' })
    const out = await summarizeTurnText(answer, undefined, 'Status?', 'claude')
    expect(out!.split('\n\n')[0]).not.toContain('…')
  })

  it('asks the model for the headline only', async () => {
    mocks.runClaude.mockResolvedValue({ text: 'Done.', sessionId: 's1' })
    await summarizeTurnText(answer, undefined, 'Done?', 'claude')
    const prompt = mocks.runClaude.mock.calls[0][0].prompt as string
    expect(prompt).toContain('Output ONLY the one line')
    expect(prompt).not.toContain('Part 2')
    expect(prompt).not.toContain('LAY PART 2')
    expect(prompt).not.toContain('two parts')
  })
})

describe('deriveTurnSummary (the local recap)', () => {
  it('headlines the opening of the answer', () => {
    const text = 'Blue selected.\n\nAnything else?'
    expect(deriveTurnSummary(text)?.split('\n')[0]).toBe('Blue selected.')
  })

  it('skips a label at the top', () => {
    const text = 'Kết quả:\nĐã sửa xong file cấu hình.'
    expect(deriveTurnSummary(text)?.split('\n')[0]).toBe('Đã sửa xong file cấu hình.')
  })
})

describe('deriveReaderText', () => {
  it('keeps every word and the paragraphs, and drops only the markdown', () => {
    const answer = '## Result\n\nFixed the **login** screen.\n\n- token refresh\n- `session` cleanup\n\n```ts\nconst x = 1\n```\n\nSee [the PR](https://x.y/1).'
    expect(deriveReaderText(answer)).toBe('Result\n\nFixed the login screen.\n\n• token refresh\n• session cleanup\n\nconst x = 1\n\nSee the PR.')
  })

  it('never clips, however long the answer', () => {
    const long = 'word '.repeat(2000).trim()
    expect(deriveReaderText(long)).toBe(long)
  })
})
