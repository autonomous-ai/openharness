/**
 * `harness device notify`: an agent's question, its suggestion and its state composed into one line, tied to its caller
 * by the command's own environment, and the devices' answer printed (docs/plans/2026-11-22-needs-you-notify-design.md). The devices are a spy: the listener's side is in services/devices.spec.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import { NOTICE_USAGE, noticeCaller, runNotice, type NoticeDeps } from './notice.js'

const CLAUDE = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'sess-1' }

async function notify(words: string[], answer: Record<string, unknown> | number | null = { result: 'shown' }, deps: Partial<NoticeDeps> = {}) {
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

  it("the listener's own rate refusing the notice is limited, any other status no dial", async () => {
    expect(await notify(['Connect the VPN'], 429)).toMatchObject({ code: 0, out: ['limited'], err: [] })
    expect(await notify(['Connect the VPN', '--json'], 429)).toMatchObject({ code: 0, out: ['{"result":"limited"}'] })
    for (const status of [204, 400, 404, 413, 500]) {
      expect(await notify(['Connect the VPN'], status), String(status)).toMatchObject({ code: 0, out: ['no dial'], err: [] })
    }
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

  it('--suggest and --waiting|--proceeding make one composed line, wherever they stand', async () => {
    const sends = async (words: string[]) => (await notify(words)).sent[0].text
    expect(await sends(['Which DB?', '--suggest', 'Postgres', '--proceeding'])).toBe('Proceeding · Which DB? · Doing: Postgres')
    expect(await sends(['--waiting', 'Which', '--suggest', 'Postgres', 'DB?'])).toBe('Waiting · Which DB? · Suggest: Postgres')
    // The last --suggest decides, and one with no word after it is no suggestion.
    expect(await sends(['Q', '--suggest', 'a', '--suggest', 'b'])).toBe('Q · Suggest: b')
    expect(await sends(['Q', '--suggest', 'a', '--suggest'])).toBe('Q')
    // Both states: the safer word.
    expect(await sends(['Q', '--proceeding', '--waiting'])).toBe('Waiting · Q')
    // Only the flags as words of their own: anything else is question text, and still rings.
    expect(await sends(['Q', '--suggest=x'])).toBe('Q --suggest=x')
    const one = await notify(['Which DB? --suggest Postgres --proceeding'])
    expect(one).toMatchObject({ code: 0, out: ['shown'] })
    expect(one.sent[0].text).toBe('Which DB? --suggest Postgres --proceeding')
  })

  it('a flag word right after --suggest is the suggestion, and the exit is 0', async () => {
    const slip = await notify(['Q', '--suggest', '--proceeding'])
    expect(slip).toMatchObject({ code: 0, out: ['shown'], err: [] })
    expect(slip.sent[0].text).toBe('Q · Suggest: --proceeding')
    const json = await notify(['Q', '--suggest', '--json'])
    expect(json).toMatchObject({ code: 0, out: ['shown'] })
    expect(json.sent[0].text).toBe('Q · Suggest: --json')
  })

  it('--json prints the answer as JSON with the new flags', async () => {
    const asked = await notify(['Q', '--waiting', '--json'])
    expect(asked).toMatchObject({ code: 0, out: ['{"result":"shown"}'] })
    expect(asked.sent[0].text).toBe('Waiting · Q')
  })

  it('no text is the usage, and nothing is sent', async () => {
    for (const words of [[], ['--json'], [' \n '], ['--suggest', 'x', '--waiting'], ['--proceeding'], ['--help'], ['-h']]) {
      expect(await notify(words), JSON.stringify(words)).toEqual({ code: 1, out: [], err: [NOTICE_USAGE], sent: [] })
    }
  })

  it('--help elsewhere in the question is text, and it rings', async () => {
    expect(await notify(['Does', '--help', 'work?'])).toMatchObject({ code: 0, out: ['shown'], sent: [{ text: 'Does --help work?' }] })
  })

  it('the usage names the flags', () => {
    expect(NOTICE_USAGE).toBe('harness device notify "<question>" [--suggest "<recommendation>"] [--waiting|--proceeding] [--json]  for an agent: ring the dial when it needs the person to decide or act')
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
