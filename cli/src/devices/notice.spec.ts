/**
 * `harness device notify`: an agent's one line, cleaned, tied to its caller by the command's own environment, and the
 * devices' answer printed. The devices are a spy: the listener's side is in services/devices.spec.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import { NOTICE_USAGE, noticeCaller, runNotice, type NoticeDeps } from './notice.js'

const CLAUDE = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'sess-1' }

async function notify(words: string[], answer: Record<string, unknown> | null = { result: 'shown' }, deps: Partial<NoticeDeps> = {}) {
  const out: string[] = []
  const err: string[] = []
  const ask = vi.fn(async () => answer)
  const code = await runNotice(words, {
    dataDir: '/nowhere', env: {}, cwd: '/', ask,
    out: (line) => { out.push(line) }, err: (line) => { err.push(line) },
    ...deps,
  })
  return { code, out, err, sent: ask.mock.calls.map((call) => (call as unknown[])[0] as Record<string, unknown>) }
}

describe('harness device notify', () => {
  it('the answer is printed, and the exit is 0', async () => {
    for (const result of ['shown', 'limited', 'no dial']) {
      expect(await notify(['Connect the VPN'], { result })).toMatchObject({ code: 0, out: [result], err: [] })
    }
    for (const answer of [null, {}, { result: 'rm -rf' }]) {
      expect(await notify(['Connect the VPN'], answer), JSON.stringify(answer)).toMatchObject({ code: 0, out: ['no dial'], err: [] })
    }
    expect(await notify(['Connect the VPN', '--json'], { result: 'limited' })).toMatchObject({ code: 0, out: ['{"result":"limited"}'] })
  })

  it('a long, many-line or unquoted text is one line', async () => {
    expect((await notify(['Connect', 'the', 'VPN'])).sent[0].text).toBe('Connect the VPN')
    const pasted = await notify(['line of output\n'.repeat(7_000).slice(0, 100_000)])
    expect(pasted.code).toBe(0)
    const text = pasted.sent[0].text as string
    expect([...text]).toHaveLength(120)
    expect(text.endsWith('…')).toBe(true)
    expect(text).not.toMatch(/\n/)
    expect((await notify(['--force', 'push', 'needs', 'you'])).sent[0].text).toBe('--force push needs you')
    expect((await notify(['--json', 'push', '--json', 'needs', 'you', '--json'])).sent[0].text).toBe('push needs you')
  })

  it('no text is the usage, and nothing is sent', async () => {
    for (const words of [[], ['--json'], [' \n ']]) {
      expect(await notify(words), JSON.stringify(words)).toEqual({ code: 1, out: [], err: [NOTICE_USAGE], sent: [] })
    }
  })

  it('the caller is read from the command\'s own environment', () => {
    expect(noticeCaller(CLAUDE, '/')).toEqual({ engine: 'claude', sessionId: 'sess-1' })
    expect(noticeCaller({ CLAUDE_CODE_SESSION_ID: 'sess-1' }, '/')).toEqual({})
    expect(noticeCaller({ CODEX_THREAD_ID: 't-1' }, '/')).toEqual({ engine: 'codex', sessionId: 't-1' })
    expect(noticeCaller({ ...CLAUDE, CODEX_THREAD_ID: 't-1' }, '/')).toEqual({ engine: 'claude', sessionId: 'sess-1' })
    expect(noticeCaller({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'sess 1' }, '/')).toEqual({})
    expect(noticeCaller({ CODEX_THREAD_ID: 'x'.repeat(200) }, '/')).toEqual({})
    expect(noticeCaller({}, '/Users/p/code/api')).toEqual({ folder: 'api' })
    expect(noticeCaller({}, '/')).toEqual({})
  })

  it('nothing else of the environment leaves', async () => {
    const { sent } = await notify(['Connect the VPN'], { result: 'shown' },
      { env: { ...CLAUDE, ORCA_PAIRING_CODE: 'secret-1' }, cwd: '/Users/p/code/api' })
    expect(Object.keys(sent[0]).sort()).toEqual(['engine', 'folder', 'sessionId', 'text', 'type'])
    expect(JSON.stringify(sent[0])).not.toContain('secret-1')
  })
})
