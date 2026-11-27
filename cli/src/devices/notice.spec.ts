/**
 * `harness device notify`: an agent's question, its suggestion and its state composed into one line, tied to its caller
 * by the command's own environment, and the devices' answer printed (docs/plans/2026-11-22-needs-you-notify-design.md).
 * The devices are a spy: the listener's side is in services/devices.spec.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import { NOTICE_LIST_ANSWER_MAX } from '../lib/dialNotice.js'
import { formatAge, NOTICE_USAGE, noticeCaller, runNotice, type NoticeDeps } from './notice.js'

const CLAUDE = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'sess-1' }

/** [why]: the reason the devices' ask gives for its null. */
async function notify(words: string[], answer: Record<string, unknown> | number | null = { result: 'shown' }, deps: Partial<NoticeDeps> = {}, why?: string) {
  const out: string[] = []
  const err: string[] = []
  const ask = vi.fn(async (_message: unknown, options?: { why?: (reason: string) => void }) => {
    if (why) options?.why?.(why)
    return answer
  })
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
    for (const answer of [{}, { result: 'rm -rf' }]) {
      expect(await notify(['Connect the VPN'], answer), JSON.stringify(answer)).toMatchObject({ code: 0, out: ['no dial'], err: ['harness device notify: unknown result'] })
    }
    expect(await notify(['Connect the VPN', '--json'], { result: 'limited' })).toMatchObject({ code: 0, out: ['{"result":"limited"}'] })
  })

  it("the listener's own rate refusing the notice is limited, any other status no dial", async () => {
    expect(await notify(['Connect the VPN'], 429)).toMatchObject({ code: 0, out: ['limited'], err: [] })
    expect(await notify(['Connect the VPN', '--json'], 429)).toMatchObject({ code: 0, out: ['{"result":"limited"}'] })
    for (const status of [204, 400, 404, 413, 500]) {
      expect(await notify(['Connect the VPN'], status), String(status)).toMatchObject({ code: 0, out: ['no dial'], err: [`harness device notify: status ${status}`] })
    }
  })

  it('a no dial says why on stderr, but for no listener', async () => {
    const held = 'timeout before headers (2004 ms)'
    expect(await notify(['Connect the VPN'], null, {}, held)).toMatchObject({ code: 0, out: ['no dial'], err: [`harness device notify: ${held}`] })
    expect(await notify(['Connect the VPN', '--json'], null, {}, held)).toMatchObject({ code: 0, out: ['{"result":"no dial"}'], err: [`harness device notify: ${held}`] })
    expect(await notify(['Connect the VPN'], null, {}, 'no listener')).toMatchObject({ code: 0, out: ['no dial'], err: [] })
    expect(await notify(['Connect the VPN'], { result: 'later' })).toMatchObject({ code: 0, out: ['no dial'], err: ['harness device notify: unknown result'] })
    for (const result of ['no dial', 'shown']) {
      expect(await notify(['Connect the VPN'], { result })).toMatchObject({ code: 0, out: [result], err: [] })
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
    expect(NOTICE_USAGE).toBe('harness device notify "<question>" [--suggest "<recommendation>"] [--waiting|--proceeding] [--json]  for an agent: ring the dial when it needs the person to decide or act; --list [--json] shows your open cards, --done <id>|all closes them')
  })

  it("notify prints shown and the card's id", async () => {
    expect(await notify(['Q'], { result: 'shown', id: '3f9a1c2e' })).toMatchObject({ code: 0, out: ['shown 3f9a1c2e'], err: [] })
    expect(await notify(['Q', '--json'], { result: 'shown', id: '3f9a1c2e' }))
      .toMatchObject({ code: 0, out: ['{"result":"shown","id":"3f9a1c2e"}'] })
  })

  it('an answer without an id prints shown', async () => {
    for (const id of [undefined, '', '3F9A1C2E', '3f9a1c2', '3f9a1c2e0', 7]) {
      expect(await notify(['Q'], { result: 'shown', id }), String(id)).toMatchObject({ code: 0, out: ['shown'] })
      expect(await notify(['Q', '--json'], { result: 'shown', id }), String(id)).toMatchObject({ code: 0, out: ['{"result":"shown"}'] })
    }
    // Only a card shown has an id to print.
    expect(await notify(['Q'], { result: 'limited', id: '3f9a1c2e' })).toMatchObject({ code: 0, out: ['limited'] })
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

describe('--list and --done', () => {
  const at = { env: CLAUDE, cwd: '/Users/p/code/api' }
  const caller = { engine: 'claude', sessionId: 'sess-1', folder: 'api' }
  const W = { id: '3f9a1c2e', ageS: 720, kind: 'waiting', line: 'Waiting · Which DB? · Suggest: Postgres' }
  const P = { id: '0b7d4e11', ageS: 5, kind: 'proceeding', line: 'Proceeding · Migrate · Doing: Postgres' }

  it("--list prints the caller's cards, one a line, oldest first", async () => {
    const ask = vi.fn(async () => ({ cards: [W, P] }))
    expect(await notify(['--list'], null, { ...at, ask })).toMatchObject({ code: 0, err: [], out: [
      '3f9a1c2e 12m waiting Waiting · Which DB? · Suggest: Postgres',
      '0b7d4e11 5s proceeding Proceeding · Migrate · Doing: Postgres',
    ] })
    expect(ask.mock.calls).toEqual([[{ type: 'noticeList', ...caller }, { maxBytes: NOTICE_LIST_ANSWER_MAX }]])
    // The answer is another process's data: what is not a card is left out.
    const odd = await notify(['--list'], { cards: [{ ...W, id: 'x' }, P, 'z'] }, at)
    expect(odd.out).toEqual(['0b7d4e11 5s proceeding Proceeding · Migrate · Doing: Postgres'])
  })

  it('--list --json prints them as an array', async () => {
    const listed = await notify(['--list', '--json'], { cards: [W, { ...P, extra: 'y' }] }, at)
    expect(listed).toMatchObject({ code: 0, err: [] })
    expect(listed.out).toHaveLength(1)
    // Only a card's own fields.
    expect(JSON.parse(listed.out[0])).toStrictEqual([W, P])
  })

  it('--list with none prints nothing, exit 0', async () => {
    for (const answer of [{ cards: [] }, { cards: [{ ...W, ageS: -1 }] }, { cards: 'x' }, {}, null, 404, 429]) {
      for (const words of [['--list'], ['--list', '--json']]) {
        expect(await notify(words, answer, at), JSON.stringify([words, answer])).toMatchObject({ code: 0, out: [], err: [] })
      }
    }
  })

  it("--done <id> and --done all send the caller's ask and print nothing", async () => {
    for (const id of ['3f9a1c2e', 'all']) {
      for (const answer of [{ closed: 1 }, { closed: 0 }, null, 400]) {
        expect(await notify(['--done', id], answer, at), JSON.stringify([id, answer]))
          .toEqual({ code: 0, out: [], err: [], sent: [{ type: 'noticeDone', ...caller, id }] })
      }
    }
    expect(await notify(['--done', 'all', '--json'], { closed: 2 }, at)).toMatchObject({ code: 0, out: [], err: [] })
  })

  it('--done with a malformed id sends nothing', async () => {
    for (const words of [['--done'], ['--done', ''], ['--done', '3F9A1C2E'], ['--done', '3f9a1c2'], ['--done', 'ALL'], ['--done', '--list']]) {
      expect(await notify(words, { closed: 1 }, at), JSON.stringify(words)).toEqual({ code: 0, out: [], err: [], sent: [] })
    }
  })

  it("typed outside an agent's session, --list and --done send nothing", async () => {
    for (const env of [{}, { CLAUDE_CODE_SESSION_ID: 'sess-1' }]) {
      for (const words of [['--list'], ['--list', '--json'], ['--done', '3f9a1c2e'], ['--done', 'all']]) {
        expect(await notify(words, { cards: [W] }, { env, cwd: '/Users/p/code/api' }), JSON.stringify([env, words]))
          .toEqual({ code: 0, out: [], err: [], sent: [] })
      }
    }
  })

  it('--done wins over --list and over a question', async () => {
    for (const words of [['--list', '--done', '3f9a1c2e'], ['Which', 'DB?', '--waiting', '--done', '3f9a1c2e', '--list']]) {
      expect(await notify(words, { closed: 1 }, at), JSON.stringify(words))
        .toEqual({ code: 0, out: [], err: [], sent: [{ type: 'noticeDone', ...caller, id: '3f9a1c2e' }] })
    }
    // --list over a question: nothing rings.
    expect((await notify(['Which', 'DB?', '--list'], { cards: [] }, at)).sent).toEqual([{ type: 'noticeList', ...caller }])
  })

  it('formatAge: seconds under a minute, minutes under an hour, else hours', () => {
    expect([0, 59, 60, 3599, 3600, 86_399].map(formatAge)).toEqual(['0s', '59s', '1m', '59m', '1h', '23h'])
  })
})
