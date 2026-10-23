import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { messagesCommand, writeMessagesHook } from '../engines/kit/messagesHook.js'
import { PaneInbox } from './inbox.js'

let root: string
let inbox: PaneInbox
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'inbox-')); inbox = new PaneInbox(join(root, 'agent-messages')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const paneDir = (n: string) => join(root, 'agent-messages', 'inbox', n)

describe('a pane inbox', () => {
  it('holds an item in the pane\'s folder until something takes it, and only then the folder exists', () => {
    expect(inbox.paneDir('%7')).toBe(paneDir('7'))
    expect(inbox.paneDir('7')).toBeNull()
    expect(existsSync(paneDir('7'))).toBe(false)
    inbox.put('%7', 'm0000001-aaaa', { session: '', text: 'hello' })
    expect(readdirSync(paneDir('7'))).toEqual(['m0000001-aaaa.json'])
    expect(inbox.waiting('%7', 'm0000001-aaaa')).toBe(true)
    expect(inbox.waiting('%8', 'm0000001-aaaa')).toBe(false)
    expect(inbox.waiting('x', 'm0000001-aaaa')).toBe(false)
  })

  it('keys a pane by its backend: tmux\'s in the folder the hook reads, a pty host\'s in one of its own', () => {
    const tmux = 'tmux\u0000%3', pty = 'ptyhost\u0000p1\u0000%3'
    // The legacy bare `%3`, as state written before other backends names it, is the same tmux pane.
    expect(inbox.paneDir(tmux)).toBe(paneDir('3'))
    expect(inbox.paneDir('%3')).toBe(paneDir('3'))
    expect(inbox.paneDir(pty)).toBe(paneDir('ptyhost.p1.3'))
    for (const bad of ['ptyhost\u0000%3', 'ptyhost\u0000P1\u0000%3', 'tmux\u00003', 'herdr\u0000%3']) expect(inbox.paneDir(bad)).toBeNull()
    inbox.put(tmux, 'k', { session: '', text: 'tmux' })
    inbox.put(pty, 'k', { session: '', text: 'pty' })
    expect(inbox.waiting(tmux, 'k')).toBe(true)
    expect(inbox.waiting(pty, 'k')).toBe(true)
    expect(JSON.parse(readFileSync(join(paneDir('ptyhost.p1.3'), 'k.json'), 'utf8')).text).toBe('pty')
    expect(inbox.claimName(tmux, 'k')).toBe('3-k')
    expect(inbox.claimName('%3', 'k')).toBe('3-k')
    expect(inbox.claimName(pty, 'k')).toBe('ptyhost.p1.3-k')
    expect(inbox.claimName('x', 'k')).toBeNull()
    expect(inbox.claimName(tmux, '../k')).toBeNull()
    expect(inbox.entries().map((e) => [e.pane, e.key]).sort()).toEqual([[pty, 'k'], [tmux, 'k']].sort())
    expect(inbox.reclaim(pty, 'k')).toBe(true)
    expect(inbox.reclaim('%3', 'k')).toBe(true)
    expect(inbox.reclaimed().sort()).toEqual([[pty, 'k'], [tmux, 'k']].sort())
    inbox.restore(pty, 'k')
    expect(inbox.waiting(pty, 'k')).toBe(true)
    expect(inbox.waiting(tmux, 'k')).toBe(false)
  })

  it('keys a versioned pty host\'s pane by its instance: p2-0.4.21-dev.win1:%7 and p2-h0123456789ab:%7', () => {
    const dev = 'ptyhost\u0000p2-0.4.21-dev.win1\u0000%7', hashed = 'ptyhost\u0000p2-h0123456789ab\u0000%7', legacy = 'ptyhost\u0000p2\u0000%7'
    expect(inbox.paneDir(dev)).toBe(paneDir('ptyhost.p2-0.4.21-dev.win1.7'))
    expect(inbox.paneDir(hashed)).toBe(paneDir('ptyhost.p2-h0123456789ab.7'))
    for (const bad of ['ptyhost\u0000p2-\u0000%7', 'ptyhost\u0000p2-a/b\u0000%7', 'ptyhost\u0000p2-0.4.21\u00007']) expect(inbox.paneDir(bad), bad).toBeNull()
    // A delivery key has a `-` in it, as a versioned instance does: the folder still reads back as its pane.
    for (const pane of [dev, hashed, legacy]) inbox.put(pane, 'm0000001-aaaa', { session: '', text: pane })
    expect(inbox.entries().map((e) => [e.pane, e.key]).sort()).toEqual([dev, hashed, legacy].map((pane) => [pane, 'm0000001-aaaa']).sort())
    for (const pane of [dev, hashed, legacy]) expect(inbox.reclaim(pane, 'm0000001-aaaa')).toBe(true)
    expect(inbox.reclaimed().sort()).toEqual([dev, hashed, legacy].map((pane) => [pane, 'm0000001-aaaa']).sort())
  })

  it('refuses what is not a pane or a key', () => {
    expect(() => inbox.put('x', 'k', { session: '', text: 't' })).toThrow(/not a terminal pane/)
    expect(() => inbox.put('%1', '../escape', { session: '', text: 't' })).toThrow(/invalid inbox key/)
    expect(inbox.reclaim('x', 'k')).toBe(false)
    expect(inbox.claimed('x', 'k')).toBe(false)
    inbox.restore('x', 'k')
    inbox.typed('x', 'k')
    inbox.withdraw('x', 'k')
  })

  it('takes an item back for typing, gives it back, and forgets a typed one; the emptied folder goes', () => {
    inbox.put('%3', 'k1', { session: '', text: 'one' })
    expect(inbox.reclaim('%3', 'k1')).toBe(true)
    expect(existsSync(paneDir('3'))).toBe(false)
    expect(inbox.reclaim('%3', 'k1')).toBe(false)
    expect(inbox.reclaimed()).toEqual([['tmux\u0000%3', 'k1']])
    inbox.restore('%3', 'k1')
    expect(inbox.waiting('%3', 'k1')).toBe(true)
    expect(inbox.reclaim('%3', 'k1')).toBe(true)
    inbox.typed('%3', 'k1')
    expect(inbox.reclaimed()).toEqual([])
    // Given back when nothing was taken: nothing happens.
    inbox.restore('%3', 'k1')
    expect(inbox.waiting('%3', 'k1')).toBe(false)
  })

  it('withdraws an item wherever it waits', () => {
    inbox.put('%4', 'a', { session: '', text: 'x' })
    inbox.put('%4', 'b', { session: '', text: 'y' })
    inbox.reclaim('%4', 'b')
    inbox.withdraw('%4', 'a')
    inbox.withdraw('%4', 'b')
    expect(existsSync(paneDir('4'))).toBe(false)
    expect(inbox.reclaimed()).toEqual([])
  })

  it('lists nothing reclaimed before anything was, and skips names it did not write', () => {
    expect(new PaneInbox(join(root, 'never')).reclaimed()).toEqual([])
    mkdirSync(join(root, 'agent-messages', 'typing'), { recursive: true })
    writeFileSync(join(root, 'agent-messages', 'typing', 'stray.txt'), '')
    expect(inbox.reclaimed()).toEqual([])
  })

  it('puts again when the hook removed the emptied folder in between', () => {
    inbox.put('%5', 'a', { session: '', text: 'x' })
    rmSync(paneDir('5'), { recursive: true })
    inbox.put('%5', 'b', { session: '', text: 'y' })
    expect(inbox.waiting('%5', 'b')).toBe(true)
  })
})

describe('the messages hook, as an engine runs it', () => {
  const agentMessages = () => join(root, 'agent-messages')
  const run = (pane: string | undefined, input: unknown) => {
    writeMessagesHook(agentMessages())
    const result = spawnSync('/bin/sh', ['-c', messagesCommand(agentMessages())], {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      env: { PATH: process.env.PATH, ...(pane ? { TMUX_PANE: pane } : {}) },
      encoding: 'utf8',
    })
    return { code: result.status, out: result.stdout, err: result.stderr }
  }

  it('does nothing, starting no Node, when the pane has nothing waiting or is no pane', () => {
    expect(run('%9', { session_id: 's' })).toEqual({ code: 0, out: '', err: '' })
    expect(run(undefined, {})).toEqual({ code: 0, out: '', err: '' })
  })

  it('claims what waits and gives it to the model, oldest first, then removes the emptied folder', () => {
    inbox.put('%2', '0note-abc', { session: '', text: 'the note' })
    inbox.put('%2', 'm0000002-bbbb', { session: '', text: 'second' })
    inbox.put('%2', 'm0000001-aaaa', { session: '', text: 'first' })
    const { code, out } = run('%2', { session_id: 's1', hook_event_name: 'PostToolUse' })
    expect(code).toBe(0)
    expect(JSON.parse(out)).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'the note\n\nfirst\n\nsecond' } })
    expect(existsSync(paneDir('2'))).toBe(false)
    expect(inbox.claimed('%2', 'm0000001-aaaa')).toBe(true)
    expect(inbox.claimed('%2', 'm0000001-aaaa')).toBe(false)
    expect(inbox.claimed('%2', '0note-abc')).toBe(true)
  })

  it('shows the person a line per message in the pane, and gives the model only the messages', () => {
    // Claude Code draws systemMessage as "PostToolUse:Bash says: …", Codex 0.162.1 as "↳ Hook · …"; neither gives it
    // to the model, and both still give it additionalContext (each run for real, 2026-10-12).
    inbox.put('%8', '0note-abc', { session: '', text: 'the note' })
    inbox.put('%8', 'm0000001-aaaa', { session: '', text: '[m1 from lead]\nfirst', notice: '← lead: first' })
    inbox.put('%8', 'm0000002-bbbb', { session: '', text: '[m2 from web]\nsecond', notice: '← web · FYI: second' })
    expect(JSON.parse(run('%8', { session_id: 's1', hook_event_name: 'PostToolUse' }).out)).toEqual({
      systemMessage: '← lead: first\n← web · FYI: second',
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'the note\n\n[m1 from lead]\nfirst\n\n[m2 from web]\nsecond' },
    })
  })

  it('leaves another conversation\'s messages, and a Claude Code sub-agent\'s tool call takes nothing', () => {
    inbox.put('%6', 'mine', { session: 'parent', text: 'for the parent' })
    inbox.put('%6', 'anyone', { session: '', text: 'for whoever' })
    expect(run('%6', { session_id: 'child', hook_event_name: 'PostToolUse' }).out).toContain('for whoever')
    expect(inbox.waiting('%6', 'mine')).toBe(true)
    expect(run('%6', { session_id: 'parent', agent_id: 'sub-1' }).out).toBe('')
    expect(inbox.waiting('%6', 'mine')).toBe(true)
    // Without an event name, it answers as PostToolUse.
    expect(JSON.parse(run('%6', { session_id: 'parent' }).out).hookSpecificOutput).toEqual({ hookEventName: 'PostToolUse', additionalContext: 'for the parent' })
  })

  it('skips an unreadable or empty item, and reads input that is not JSON as none', () => {
    mkdirSync(paneDir('1'), { recursive: true })
    writeFileSync(join(paneDir('1'), 'bad.json'), '{')
    writeFileSync(join(paneDir('1'), 'empty.json'), JSON.stringify({ text: '' }))
    writeFileSync(join(paneDir('1'), 'big.json'), JSON.stringify({ text: 'x'.repeat(70_000) }))
    inbox.put('%1', 'ok', { session: 'any', text: 'kept' })
    expect(JSON.parse(run('%1', 'not json').out).hookSpecificOutput.additionalContext).toBe('kept')
    expect(readdirSync(paneDir('1')).sort()).toEqual(['bad.json', 'big.json', 'empty.json'])
  })

  it('rewrites the script only when it changed', () => {
    writeMessagesHook(agentMessages())
    const file = join(agentMessages(), 'hook.mjs')
    const before = statSync(file).ino
    writeMessagesHook(agentMessages())
    expect(statSync(file).ino).toBe(before)
    writeFileSync(file, 'stale')
    writeMessagesHook(agentMessages())
    expect(readFileSync(file, 'utf8')).not.toBe('stale')
  })
})
