import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { ENGINE_BIN, RESUME_ARGS, canResume, resumeCommand } from '../lib/resume.mjs'

const SESSION = '2d9e6b41-8c07-4f3a-b512-6a1e0f7c9d33'

test('the resume line is the one a person would type', () => {
  assert.equal(resumeCommand('claude', SESSION), `claude --resume ${SESSION}`)
  assert.equal(resumeCommand('codex', SESSION), `codex resume ${SESSION}`)
  assert.equal(resumeCommand('opencode', SESSION), `opencode --session ${SESSION}`)
  assert.equal(resumeCommand('amp', SESSION), `amp threads continue ${SESSION}`)
  assert.equal(resumeCommand('commandcode', SESSION), `cmd --resume ${SESSION}`)
  assert.equal(resumeCommand('cursor', SESSION), `cursor-agent --resume ${SESSION}`)
})

test('an engine with no resume is refused, so it is never paused either', () => {
  assert.equal(canResume('devin'), false)
  assert.equal(canResume('terminal'), false)
  assert.equal(canResume('claude'), true)
  assert.throws(() => resumeCommand('devin', SESSION), /does not know how to resume devin/)
})

test('a session id that is not one an engine wrote never reaches a shell', () => {
  for (const bad of ['; rm -rf /', 'a b', '$(whoami)', '`id`', "x'y", 'short', '', null, '../../etc/passwd']) {
    assert.throws(() => resumeCommand('claude', bad), /session id/, `accepted ${JSON.stringify(bad)}`)
  }
})

test('every engine that can be resumed has a binary to resume it with', () => {
  for (const engine of Object.keys(RESUME_ARGS)) {
    assert.ok(ENGINE_BIN[engine], `${engine} has resume args but no command name`)
    assert.match(resumeCommand(engine, SESSION), new RegExp(`^${ENGINE_BIN[engine]} `))
  }
})

/**
 * The two tables are mirrored from the daemon by hand, because this package installs on its own. This test
 * is the drift guard: it reads the daemon's own source when it is there, and skips when it is not (an
 * installed copy of the package, a release tarball).
 */
test('the resume table still matches the daemon it was copied from', async (t) => {
  const candidates = ['../../../../cli/src/lib/engineLaunch.ts', '../../../../../cli/src/lib/engineLaunch.ts']
  let source = null
  for (const path of candidates) {
    try { source = await readFile(new URL(path, import.meta.url), 'utf8'); break } catch { /* not this layout */ }
  }
  if (!source) return t.skip('the daemon source is not beside this package')
  const block = source.match(/LAUNCH_RESUME_FLAG[^=]*=\s*\{([\s\S]*?)\n\}/)
  assert.ok(block, 'the daemon no longer declares LAUNCH_RESUME_FLAG the way this test reads it')
  const theirs = {}
  for (const line of block[1].split('\n')) {
    const match = /^\s*(\w+):\s*\[([^\]]*)\]/.exec(line)
    if (match) theirs[match[1]] = match[2].split(',').map((word) => word.trim().replace(/^'|'$/g, '')).filter(Boolean)
  }
  assert.deepEqual(RESUME_ARGS, theirs, 'lib/resume.mjs has drifted from the daemon\'s LAUNCH_RESUME_FLAG')
})
