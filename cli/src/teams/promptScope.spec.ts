import { describe, expect, it } from 'vitest'
import { SwarmPromptScopes } from './promptScope.js'
import { channelTeamId } from './service.js'

const agent = 'same-session'
const a = channelTeamId('swarm-a'), b = channelTeamId('swarm-b')
const bytes = (text: string): Uint8Array => Buffer.from(text)

describe('prompt swarm origin', () => {
  it('pins typed work to A while B receives typing and queued work in the same session', () => {
    const scopes = new SwarmPromptScopes()
    scopes.raw(agent, bytes('help with frontend\r'), 'swarm-a')
    scopes.started(agent, 'help with frontend', 'hook')
    expect(scopes.current(agent)).toBe(a)
    scopes.raw(agent, bytes('help with backend\r'), 'swarm-b')
    scopes.raw(agent, bytes('a third draft'), 'swarm-a')
    expect(scopes.current(agent)).toBe(a)
    scopes.started(agent, 'help with backend', 'hook')
    expect(scopes.current(agent)).toBe(b)
    // Watcher catches up after B's hook: neither older event can move it back to A.
    scopes.started(agent, 'help with frontend')
    scopes.started(agent, 'help with backend')
    expect(scopes.current(agent)).toBe(b)
  })

  it('uses the submitting pane after a draft moves, handles split UTF-8 and bracketed pastes', () => {
    const scopes = new SwarmPromptScopes()
    const utf8 = bytes('café')
    scopes.raw(agent, utf8.slice(0, 4), 'swarm-a')
    scopes.raw(agent, utf8.slice(4), 'swarm-a')
    scopes.raw(agent, bytes('\x1b[200~\nsecond line\x1b[201~'), 'swarm-a')
    scopes.raw(agent, bytes('\r'), 'swarm-b')
    scopes.started(agent, 'café\nsecond line', 'hook')
    expect(scopes.current(agent)).toBe(b)
  })

  it('keeps the origin of prompts broken with the app’s ⇧⏎ and ⌥⏎ line keys', () => {
    const scopes = new SwarmPromptScopes()
    scopes.raw(agent, bytes('a\x1b[13;2ub\r'), 'swarm-a')
    scopes.started(agent, 'a\nb', 'hook', 'claude')
    expect(scopes.current(agent)).toBe(a)
    // A paste, two ⇧⏎, then text, each key arriving as its own write.
    for (const chunk of ['\x1b[200~pasted code\x1b[201~', '\x1b[13;2u', '\x1b', '[13;2u', 'explain it', '\r']) scopes.raw(agent, bytes(chunk), 'swarm-b')
    scopes.started(agent, 'pasted code\n\nexplain it', 'hook', 'claude')
    expect(scopes.current(agent)).toBe(b)
    scopes.raw(agent, bytes('c\x1b\rd\r'), 'swarm-a')
    scopes.started(agent, 'c\nd', 'hook', 'codex')
    expect(scopes.current(agent)).toBe(a)
    // Under LNM the app sends Return as \r\n, so ⌥⏎ arrives as \x1b\r\n: still one line break.
    scopes.raw(agent, bytes('e\x1b\r\nf\r\n'), 'swarm-b')
    scopes.started(agent, 'e\nf', 'hook', 'codex')
    expect(scopes.current(agent)).toBe(b)
  })

  it('ignores SGR mouse reports from clicking into or scrolling the pane', () => {
    const scopes = new SwarmPromptScopes()
    // Recorded shape: click to focus (split press/release), a wheel burst, then ⌥⏎ lines.
    for (const chunk of ['\x1b[<0;12;34M', '\x1b[<0;12;34m', '\x1b[<65;40;20M'.repeat(19), '\x1b', '[<64;4', '0;20M', '\x1b\r', '\x1b\r', 'ok', '\r']) scopes.raw(agent, bytes(chunk), 'swarm-a')
    scopes.started(agent, '\n\nok', 'hook', 'claude')
    expect(scopes.current(agent)).toBe(a)
    scopes.raw(agent, bytes('x\x1b[<0;12M\r'), 'swarm-b') // A malformed report is not a mouse event.
    scopes.started(agent, 'x', 'hook', 'claude')
    expect(scopes.current(agent)).toBeNull()
  })

  it('still fails closed on ⌥⌫ and on other CSI keys that share the ⇧⏎ prefix', () => {
    const scopes = new SwarmPromptScopes()
    scopes.raw(agent, bytes('one two\x1b\x7f\r'), 'swarm-a')
    scopes.started(agent, 'one ', 'hook', 'claude')
    expect(scopes.current(agent)).toBeNull()
    scopes.raw(agent, bytes('word\x1b[1;5D\r'), 'swarm-a')
    scopes.started(agent, 'word', 'hook', 'claude')
    expect(scopes.current(agent)).toBeNull()
    // Pasted escapes reach the engine literally; they are not line keys.
    scopes.raw(agent, bytes('\x1b[200~x\x1b[13;2uy\x1b\rz\x1b[201~\r'), 'swarm-a')
    scopes.started(agent, 'x\ny\nz', 'hook', 'claude')
    expect(scopes.current(agent)).toBeNull()
    // A lone Esc followed later by Return is not ⌥⏎: the draft must not become 'hello\n…'.
    scopes.raw(agent, bytes('hello\x1b'), 'swarm-a')
    scopes.raw(agent, bytes('\r'), 'swarm-a')
    scopes.raw(agent, bytes('next\r'), 'swarm-a')
    scopes.started(agent, 'hello\nnext', 'hook', 'claude')
    expect(scopes.current(agent)).toBeNull()
  })

  it('matches native accepted text instead of treating permission keys as prompts', () => {
    const scopes = new SwarmPromptScopes()
    scopes.raw(agent, bytes('1\r'), 'swarm-b')
    scopes.raw(agent, bytes('ask a peer\r'), 'swarm-a')
    scopes.started(agent, 'ask a peer')
    expect(scopes.current(agent)).toBe(a)
    scopes.raw(agent, bytes('2\r'), 'swarm-b')
    expect(scopes.current(agent)).toBe(a)
  })

  it('fails closed on unknown editor state, native outside input and ambiguous identical queues', () => {
    const scopes = new SwarmPromptScopes()
    scopes.raw(agent, bytes('\x1b[A\r'), 'swarm-a')
    scopes.started(agent, 'a prompt recalled from native history')
    expect(scopes.current(agent)).toBeNull()
    scopes.prepare(agent, 'same text', 'swarm-a')
    scopes.prepare(agent, 'same text', 'swarm-b')
    scopes.started(agent, 'same text')
    expect(scopes.current(agent)).toBeNull()
    scopes.started(agent, 'entered in an external terminal')
    expect(scopes.current(agent)).toBeNull()
  })

  it('never attributes a recalled prompt in B to identical pending text from A', () => {
    const scopes = new SwarmPromptScopes()
    scopes.prepare(agent, 'same text', 'swarm-a')
    scopes.raw(agent, bytes('\x1b[A\r'), 'swarm-b')
    scopes.started(agent, 'same text', 'hook')
    expect(scopes.current(agent)).toBeNull()
    scopes.raw(agent, bytes('a fresh prompt\r'), 'swarm-b')
    scopes.started(agent, 'a fresh prompt', 'hook')
    expect(scopes.current(agent)).toBe(b)
  })

  it('pins structured queued prompts and peer continuations; a roster notice never retargets work', () => {
    const scopes = new SwarmPromptScopes()
    scopes.prepare(agent, 'human task', 'swarm-a')
    scopes.started(agent, 'human task')
    scopes.prepare(agent, 'membership B', undefined, `team:${b}:${'1'.repeat(32)}:intro`)
    scopes.started(agent, 'membership B')
    expect(scopes.current(agent)).toBe(a)
    scopes.prepare(agent, 'peer answer', undefined, `team:${b}:${'2'.repeat(32)}:answer`)
    scopes.started(agent, '<pasted_content id="abcd">\npeer answer\n</pasted_content id="abcd">', 'transcript', 'claude')
    expect(scopes.current(agent)).toBe(b)
  })

  it('does not retain revoked, expired or forgotten prompt origins', () => {
    let now = 0
    const scopes = new SwarmPromptScopes(() => now)
    scopes.prepare(agent, 'not written', 'swarm-a')()
    scopes.started(agent, 'not written')
    expect(scopes.current(agent)).toBeNull()
    scopes.prepare(agent, 'stale', 'swarm-a')
    now += 300_001
    scopes.started(agent, 'stale')
    expect(scopes.current(agent)).toBeNull()
    scopes.prepare(agent, 'valid', 'swarm-a')
    scopes.started(agent, 'valid')
    scopes.forget(agent)
    expect(scopes.current(agent)).toBeNull()
  })

  it('returns to the original task’s swarm after answering an incoming peer question', () => {
    const scopes = new SwarmPromptScopes(), question = '3'.repeat(32)
    scopes.prepare(agent, 'original A task', 'swarm-a')
    scopes.started(agent, 'original A task', 'hook')
    scopes.prepare(agent, 'question from B', undefined, `team:${b}:${question}:question`)
    scopes.started(agent, 'question from B', 'hook')
    expect(scopes.current(agent)).toBe(b)
    scopes.replied(agent, b, question)
    expect(scopes.current(agent)).toBe(a)
    scopes.started(agent, 'question from B') // Late transcript must not undo the return.
    expect(scopes.current(agent)).toBe(a)
    scopes.prepare(agent, 'a new B task', 'swarm-b')
    scopes.started(agent, 'a new B task', 'hook')
    scopes.replied(agent, b, question) // Retrying an old reply cannot retarget new work.
    expect(scopes.current(agent)).toBe(b)
  })

  it('prefers literal submitted text and does not interpret another engine’s paste syntax', () => {
    const scopes = new SwarmPromptScopes()
    const wrapped = '<pasted_content id="abcd">\ninner\n</pasted_content id="abcd">'
    scopes.prepare(agent, 'inner', 'swarm-a')
    scopes.prepare(agent, wrapped, 'swarm-b')
    scopes.started(agent, wrapped, 'hook', 'claude')
    expect(scopes.current(agent)).toBe(b)
    scopes.started(agent, wrapped, 'hook', 'codex')
    expect(scopes.current(agent)).toBeNull()
  })

  it('keeps large chunked pastes bounded and never mistakes an oversized draft for a known prompt', () => {
    const scopes = new SwarmPromptScopes(), text = 'code example '.repeat(8192)
    scopes.raw(agent, bytes('\x1b[200~'), 'swarm-a')
    for (let offset = 0; offset < text.length; offset += 8192) scopes.raw(agent, bytes(text.slice(offset, offset + 8192)), 'swarm-a')
    scopes.raw(agent, bytes('\x1b[201~\r'), 'swarm-a')
    scopes.started(agent, text)
    expect(scopes.current(agent)).toBe(a)
    scopes.raw(agent, bytes('x'.repeat(300_000)), 'swarm-b', true)
    scopes.raw(agent, bytes('\r'), 'swarm-b')
    scopes.started(agent, '', 'hook') // A bounded native hook clears scope even before transcript fallback.
    expect(scopes.current(agent)).toBeNull()
    scopes.started(agent, 'x'.repeat(300_000))
    expect(scopes.current(agent)).toBeNull()
  })
})
