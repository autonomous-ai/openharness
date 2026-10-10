import assert from 'node:assert/strict'
import { test } from 'node:test'
import { run, since } from '../toolchain/mem.mjs'
import { makeHome } from './fixtures.mjs'

const { home, env } = makeHome()

async function mem(args, stdin) {
  const out = [], err = []
  const code = await run(args, { out: (line) => out.push(line), err: (line) => err.push(line), env, home, stdin: () => stdin })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

test('sources lists the agents present, with where their memory lives', async () => {
  const { code, out } = await mem(['sources'])
  assert.equal(code, 0)
  assert.match(out, /Claude Code\s+memory on/)
  assert.match(out, /Codex\s+memory on/)
  assert.ok(!out.includes('Cursor'), 'agents that are not installed and have nothing are left out')
})

test('list, filter, show by number', async () => {
  const you = await mem(['list', '--kind', 'you'])
  assert.match(you.out, /Short answers/)
  assert.ok(!you.out.includes('Build layout'))
  const json = JSON.parse((await mem(['list', '--agent', 'codex', '--json'])).out)
  assert.ok(json.every((row) => row.agent === 'codex' && !('body' in row)))
  const shown = await mem(['show', '1', '--kind', 'you'])
  assert.equal(shown.code, 0)
  assert.match(shown.out, /^# /)
  assert.equal((await mem(['show', 'nothing'])).code, 1)
})

test('search covers memories and conversations', async () => {
  const { out } = await mem(['search', 'fridays'])
  assert.match(out, /memories \(1\)/)
  assert.match(out, /sessions \(1\)/)
})

test('asks prints your messages with their sessions', async () => {
  const { out } = await mem(['asks', '--since', '7d'])
  assert.match(out, /tldr only/)
  assert.match(out, /\[session:s1\]/)
  assert.match(out, /3 messages/)
  assert.throws(() => since('soon'), /--since/)
})

test('about: none yet, then written from stdin, then shown', async () => {
  assert.match((await mem(['about'])).out, /No About You yet/)
  const written = await mem(['about', 'write'], '## How you work\n- Wants short answers. [asks:2]\n')
  assert.equal(written.code, 0)
  assert.match((await mem(['about'])).out, /Wants short answers/)
  assert.equal((await mem(['about', 'write'], 'no lines')).code, 1)
})

test('unknown commands print the usage', async () => {
  const { code, err } = await mem(['frobnicate'])
  assert.equal(code, 2)
  assert.match(err, /usage: mem/)
})
