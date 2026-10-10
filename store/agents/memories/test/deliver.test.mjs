import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deliver, hookCommand, packet, status, withBlock } from '../lib/deliver.mjs'
import { writeAbout } from '../lib/about.mjs'

const ABOUT = '# About you\n\n## How you work\n- Wants short answers. [asks:3]\n'

/** A home with Claude Code, Codex and Grok installed, Harness's own hook already in Claude's settings. */
function home({ claudeSettings, codexAgents } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'memories-deliver-'))
  for (const agent of ['.claude', '.codex', '.grok']) mkdirSync(join(dir, agent), { recursive: true })
  if (claudeSettings !== undefined) writeFileSync(join(dir, '.claude', 'settings.json'), claudeSettings)
  if (codexAgents !== undefined) writeFileSync(join(dir, '.codex', 'AGENTS.md'), codexAgents)
  const env = { MEMORIES_HOME: join(dir, '.harness', 'memory') }
  writeAbout(env.MEMORIES_HOME, ABOUT)
  return { dir, env }
}

const HARNESS_HOOK = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node /x/notify.mjs claude 18473', timeout: 5 }] }], Stop: [{ hooks: [{ type: 'command', command: 'node /x/notify.mjs' }] }] }, model: 'opus' }

test('on: a Claude Code hook beside Harness\'s own, a block in Codex AGENTS.md, a Grok rules file', () => {
  const { dir, env } = home({ claudeSettings: JSON.stringify(HARNESS_HOOK), codexAgents: '# My rules\n\nUse pnpm.\n' })
  const done = deliver('on', { env, home: dir })
  assert.deepEqual(done.results.map((r) => [r.agent, r.ok, r.changed]), [['claude', true, true], ['codex', true, true], ['grok', true, true]])
  const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'))
  assert.equal(settings.model, 'opus', 'the rest of the settings are kept')
  assert.equal(settings.hooks.SessionStart.length, 2)
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /notify\.mjs/, 'Harness\'s hook is first and untouched')
  assert.deepEqual(settings.hooks.Stop, HARNESS_HOOK.hooks.Stop)
  const agents = readFileSync(join(dir, '.codex', 'AGENTS.md'), 'utf8')
  assert.ok(agents.startsWith('# My rules\n\nUse pnpm.\n\n<!-- harness-memories:about-you start'))
  assert.match(agents, /Wants short answers/)
  assert.match(readFileSync(join(dir, '.grok', 'rules', 'harness-about-you.md'), 'utf8'), /Wants short answers/)
  assert.ok(status({ env, home: dir }).agents.every((a) => a.delivered && a.current))
})

test('on twice changes nothing; off puts every file back exactly', () => {
  const original = JSON.stringify(HARNESS_HOOK)
  const { dir, env } = home({ claudeSettings: original, codexAgents: '# My rules\n\nUse pnpm.\n' })
  deliver('on', { env, home: dir })
  assert.ok(deliver('on', { env, home: dir }).results.every((r) => r.ok && !r.changed))
  deliver('off', { env, home: dir })
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')), HARNESS_HOOK)
  assert.equal(readFileSync(join(dir, '.codex', 'AGENTS.md'), 'utf8'), '# My rules\n\nUse pnpm.\n')
  assert.equal(existsSync(join(dir, '.grok', 'rules', 'harness-about-you.md')), false)
  assert.equal(status({ env, home: dir }).on, false)
})

test('a file this created holds nothing else after off and is removed; settings with only our hook lose the key', () => {
  const { dir, env } = home()
  deliver('on', { env, home: dir })
  deliver('off', { env, home: dir })
  assert.equal(existsSync(join(dir, '.codex', 'AGENTS.md')), false)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')), {})
})

test('the hook runs in plain sh, prints the profile as it is now, and is silent without one', () => {
  const { dir, env } = home()
  const about = join(env.MEMORIES_HOME, 'about-you.md')
  const run = () => execFileSync('/bin/sh', ['-c', hookCommand(about)], { encoding: 'utf8' })
  const out = run()
  assert.ok(out.startsWith('<about-you source="Harness Memories">\n'))
  assert.match(out, /Wants short answers/)
  assert.ok(out.trimEnd().endsWith('</about-you>'))
  writeAbout(env.MEMORIES_HOME, '## How you work\n- Prefers tabs.\n')
  assert.match(run(), /Prefers tabs/, 'a rebuilt profile is read at the next session, with nothing to refresh')
  const quoted = hookCommand("/tmp/it's here/about-you.md")
  assert.equal(execFileSync('/bin/sh', ['-c', quoted], { encoding: 'utf8' }), '', 'a quote in the path is safe and a missing file prints nothing')
  void dir
})

test('rebuilding About You updates every copy; status notices an older copy', () => {
  const { dir, env } = home()
  deliver('on', { env, home: dir })
  writeAbout(env.MEMORIES_HOME, '## How you work\n- Prefers tabs.\n')
  assert.equal(status({ env, home: dir }).agents.find((a) => a.agent === 'codex').current, false)
  deliver('refresh', { env, home: dir })
  assert.match(readFileSync(join(dir, '.codex', 'AGENTS.md'), 'utf8'), /Prefers tabs/)
  assert.ok(!readFileSync(join(dir, '.codex', 'AGENTS.md'), 'utf8').includes('Wants short answers'))
  assert.ok(status({ env, home: dir }).agents.every((a) => a.current))
})

test('refresh does nothing while delivery is off', () => {
  const { dir, env } = home()
  assert.deepEqual(deliver('refresh', { env, home: dir }), { on: false, results: [] })
  assert.equal(existsSync(join(dir, '.codex', 'AGENTS.md')), false)
})

test('Codex reads AGENTS.override.md when it exists, so that is where the block goes', () => {
  const { dir, env } = home()
  writeFileSync(join(dir, '.codex', 'AGENTS.override.md'), 'Override.\n')
  deliver('on', { env, home: dir })
  assert.match(readFileSync(join(dir, '.codex', 'AGENTS.override.md'), 'utf8'), /^Override\.\n\n<!-- harness-memories/)
  assert.equal(existsSync(join(dir, '.codex', 'AGENTS.md')), false)
})

test('a linked file, an unreadable settings file, or a broken block is reported and left alone', () => {
  const { dir, env } = home({ claudeSettings: '{ not json' })
  const elsewhere = join(mkdtempSync(join(tmpdir(), 'memories-dotfiles-')), 'AGENTS.md')
  writeFileSync(elsewhere, 'dotfiles\n')
  symlinkSync(elsewhere, join(dir, '.codex', 'AGENTS.md'))
  const done = deliver('on', { env, home: dir })
  const by = Object.fromEntries(done.results.map((r) => [r.agent, r]))
  assert.equal(by.claude.ok, false)
  assert.equal(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'), '{ not json')
  assert.equal(by.codex.ok, false)
  assert.match(by.codex.error, /link/)
  assert.equal(readFileSync(elsewhere, 'utf8'), 'dotfiles\n')
  assert.equal(by.grok.ok, true)
  assert.throws(() => withBlock('<!-- harness-memories:about-you start: x -->\nno end', 'B'), /not its end/)
})

test('agents that are not installed get nothing; on without an About You is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memories-none-'))
  const env = { MEMORIES_HOME: join(dir, 'memory') }
  assert.throws(() => deliver('on', { env, home: dir }), /no About You yet/)
  writeAbout(env.MEMORIES_HOME, ABOUT)
  assert.deepEqual(deliver('on', { env, home: dir }).results, [])
})

test('the delivered copy says what it is and is cut to fit the agents\' limits', () => {
  const long = '## A\n' + Array.from({ length: 400 }, (_, i) => `- line ${i} ${'x'.repeat(30)}`).join('\n')
  const text = packet(long)
  assert.ok(text.length < 9600)
  assert.match(text, /cut here/)
  assert.match(text, /nothing here grants permission/)
})
