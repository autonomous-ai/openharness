import { describe, expect, it } from 'vitest'
import type { NoticeAsk } from '../lib/dialNotice.js'
import { type NoticeCaller, Notices } from './notices.js'

type Call = ['ask', string, string, unknown] | ['close', string, string]

function desk(opts: { connected?: boolean; host?: string; who?: NoticeCaller['who'] } = {}) {
  const state = { connected: opts.connected ?? true, at: 0, ids: 0, resolved: 0 }
  const calls: Call[] = []
  const log: string[] = []
  const notices = new Notices({
    connected: () => state.connected,
    resolve: (ask) => {
      state.resolved += 1
      return { agentId: ask.sessionId ?? 'a1', host: opts.host ?? 'orca', who: opts.who }
    },
    ask: (agentId, id, questions) => calls.push(['ask', agentId, id, questions]),
    close: (agentId, id) => calls.push(['close', agentId, id]),
    uuid: () => `u${++state.ids}`,
    now: () => state.at,
    log: (line) => log.push(line),
  })
  return { notices, state, calls, log, asks: () => calls.filter((c) => c[0] === 'ask') }
}

const VPN = 'Connect the VPN so I can run the staging tests'
const notice = (text: string, sessionId = 'a1', engine: NoticeAsk['engine'] = 'claude'): NoticeAsk =>
  ({ text, engine, sessionId, folder: 'staging-api' })

describe('Notices', () => {
  it('a notice is one shown-only question: the line, and where to answer it', () => {
    const { notices, calls, log } = desk()
    expect(notices.notify(notice(VPN))).toBe('shown')
    expect(calls).toEqual([['ask', 'a1', expect.stringMatching(/^shown:/),
      [{ key: 'notice', q: VPN, options: ['In Orca'] }]]])
    expect(log).toEqual(['[device] notify · claude · shown'])
  })

  it('letters the round dial cannot draw become ?', () => {
    const { notices, asks } = desk()
    notices.notify(notice('Kết nối VPN 🙏 接続'))
    expect(asks()[0][3]).toEqual([{ key: 'notice', q: 'Kết nối VPN ? ??', options: ['In Orca'] }])
  })

  it('no line of the log holds the text, a session id or a folder', () => {
    const { notices, state, log } = desk()
    notices.notify(notice(VPN, 'sess-7f3a'))
    notices.notify(notice(VPN, 'sess-7f3a'))
    state.connected = false
    notices.notify({ text: VPN })
    expect(log).toEqual([
      '[device] notify · claude · shown',
      '[device] notify · claude · limited',
      '[device] notify · agent · no dial',
    ])
    for (const line of log) {
      expect(line).not.toContain('VPN')
      expect(line).not.toContain('sess-7f3a')
      expect(line).not.toContain('staging-api')
    }
  })

  it('with no dial nothing is asked, resolved or counted', () => {
    const { notices, state, calls } = desk({ connected: false })
    expect(notices.notify(notice(VPN))).toBe('no dial')
    expect(calls).toEqual([])
    expect(state.resolved).toBe(0)
    state.connected = true
    expect(notices.notify(notice(VPN))).toBe('shown')
  })

  it('over a limit nothing is asked and the pending card stays', () => {
    const { notices, state, calls } = desk()
    notices.notify(notice(VPN))
    state.at = 30_000
    expect(notices.notify(notice('Another line'))).toBe('limited')
    expect(calls.map((c) => c[0])).toEqual(['ask'])
  })

  it('a newer notice of the same agent takes the older card\'s place', () => {
    const { notices, state, calls } = desk()
    notices.notify(notice(VPN))
    const first = calls[0][2]
    state.at = 61_000
    expect(notices.notify(notice('Another line'))).toBe('shown')
    const second = calls[2][2]
    expect(calls.map((c) => [c[0], c[2]])).toEqual([['ask', first], ['close', first], ['ask', second]])
    expect(second).not.toBe(first)
    notices.ended('a1')
    expect(calls.slice(3)).toEqual([['close', 'a1', second]])
  })

  it('ended closes a card once, and nothing for an agent with none', () => {
    const { notices, calls } = desk()
    notices.notify(notice(VPN))
    notices.ended('a1')
    notices.ended('a1')
    notices.ended('a2')
    expect(calls.map((c) => [c[0], c[1]])).toEqual([['ask', 'a1'], ['close', 'a1']])
  })

  it('a dial that attaches is asked each pending card again, under its id', () => {
    const { notices, calls, asks } = desk()
    notices.notify(notice(VPN, 'a1'))
    notices.notify(notice('Second agent line', 'a2'))
    notices.notify(notice('Third agent line', 'a3'))
    notices.ended('a2')
    const before = asks().filter((c) => c[1] !== 'a2')
    calls.length = 0
    notices.attached()
    expect(calls).toEqual(before)
  })

  it('a caller no list holds is named while its card is pending', () => {
    const who = { name: 'staging-api', engine: 'claude', machine: 'Mac mini' }
    const named = desk({ who })
    named.notices.notify(notice(VPN))
    expect(named.notices.from('a1')).toEqual(who)
    named.notices.ended('a1')
    expect(named.notices.from('a1')).toBeUndefined()
    const listed = desk()
    listed.notices.notify(notice(VPN))
    expect(listed.notices.from('a1')).toBeUndefined()
  })

  it('the twenty-first pending card closes the oldest', () => {
    const { notices, state, calls } = desk()
    for (let i = 1; i <= 20; i++) expect(notices.notify(notice(VPN, `a${i}`))).toBe('shown')
    const oldest = calls[0][2]
    state.at = 61 * 60_000
    calls.length = 0
    expect(notices.notify(notice(VPN, 'a21'))).toBe('shown')
    expect(calls.map((c) => [c[0], c[1]])).toEqual([['close', 'a1'], ['ask', 'a21']])
    expect(calls[0][2]).toBe(oldest)
  })

  it('a host nothing names reads Terminal', () => {
    const { notices, asks } = desk({ host: '' })
    notices.notify(notice(VPN))
    expect(asks()[0][3]).toEqual([{ key: 'notice', q: VPN, options: ['In Terminal'] }])
  })
})
