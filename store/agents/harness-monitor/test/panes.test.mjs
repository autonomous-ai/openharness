import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capture, engineProcess, holdOpen, isPaneId, looksBlocked, paneState, panes, sendLine } from '../lib/panes.mjs'
import { fakeTmux, pane, table } from './fixtures.mjs'

const LIST = [
  '%1§§0§§100§§2.1.268§§harness-claude-1§§1§§1§§1§§§§1789900000',
  '%2§§1§§0§§§§harness-codex-2§§0§§1§§1§§0§§1789800000',
  'garbage line',
  '%3§§0§§300§§zsh§§my-own-session§§0§§2§§1§§§§1789700000',
].join('\n')

test('panes parse, including a dead one and an empty user option', async () => {
  const rows = await panes({ run: async () => LIST })
  assert.equal(rows.size, 3)
  assert.equal(rows.get('%1').dead, false)
  assert.equal(rows.get('%1').attached, true)
  assert.equal(rows.get('%1').pid, 100)
  assert.equal(rows.get('%1').engineExit, null)
  assert.equal(rows.get('%2').dead, true)
  assert.equal(rows.get('%2').engineExit, 0)
  assert.equal(rows.get('%2').pid, null)
  assert.equal(rows.get('%3').target, 'my-own-session:2.1')
  assert.equal(rows.get('%1').lastOutput, 1789900000000)
})

test('no tmux server is an answer, not a crash', async () => {
  const rows = await panes({ run: async () => { throw new Error('no server running') } })
  assert.equal(rows.size, 0)
})

test('a pane id is checked before it is ever passed as an argument', async () => {
  assert.ok(isPaneId('%12'))
  assert.equal(isPaneId('%12; rm -rf /'), false)
  assert.equal(isPaneId('12'), false)
  await assert.rejects(() => sendLine('%1; danger', 'ls'), /Not a tmux pane id/)
  await assert.rejects(() => sendLine('%1', 'ls\nrm -rf /'), /one line/)
})

test('the engine is found at the root of the pane, where tmux usually puts it', () => {
  const found = engineProcess(pane(), table(), 'claude')
  assert.equal(found.pid, 100)
  assert.equal(found.engineAlive, true)
  assert.equal(found.rss, 400 * 1024 * 1024)
})

test('the engine is also found below the pane, and memory is the whole subtree', () => {
  const tree = table({ comm: '/bin/zsh', rss: 5 * 1024 * 1024, children: [{ pid: 101, comm: '/usr/local/bin/codex', rss: 300 * 1024 * 1024, cpu: 7 }] })
  const found = engineProcess(pane(), tree, 'codex')
  assert.equal(found.pid, 101)
  assert.equal(found.procs, 2)
  assert.equal(found.rss, 305 * 1024 * 1024)
  assert.equal(found.cpu.toFixed(1), '7.2') // the shell's own 0.2 counts too: the subtree is the cost
})

test('a pane that fell back to a shell holds no memory against the agent', () => {
  const found = engineProcess(pane(), table({ comm: '-zsh', rss: 6 * 1024 * 1024 }), 'claude')
  assert.equal(found.engineAlive, false)
  assert.equal(found.rss, 0)
})

test('an open prompt is recognized, and ordinary output is not', () => {
  assert.ok(looksBlocked('Do you want to proceed?\n❯ 1. Yes\n  2. No'))
  assert.ok(looksBlocked('Allow command? (y/n)'))
  assert.ok(looksBlocked('Waiting for your approval'))
  assert.equal(looksBlocked('Which file should I edit?'), false, 'a question in prose is a finished turn, not a dialog')
  assert.equal(looksBlocked('Wrote 14 files.\nDone.'), false)
  assert.equal(looksBlocked(''), false)
  assert.equal(looksBlocked('\u001b[32mAll tests passed\u001b[0m'), false)
})

test('holding a pane open and reading it back go through tmux with an argument list', async () => {
  const tmux = fakeTmux({ dead: true, command: 'zsh', engineExit: 0 })
  assert.equal(await holdOpen('%1', true, { run: tmux.run }), true)
  assert.deepEqual(tmux.calls[0], ['set-option', '-w', '-t', '%1', 'remain-on-exit', 'on'])
  const observed = await paneState('%1', { run: tmux.run })
  assert.deepEqual(observed, { dead: true, command: 'zsh', engineExit: 0 })
  await capture('%1', { lines: 5, run: tmux.run })
  assert.deepEqual(tmux.calls.at(-1), ['capture-pane', '-p', '-t', '%1', '-S', '-5'])
})

test('the trust prompt an engine draws on a new folder counts as blocked', () => {
  // Copied from a real pane: this shape walked past an earlier version of the patterns.
  const screen = [
    '────────────────────────────────────────────',
    ' Quick safety check: Is this a project you created or one you trust?',
    " Claude Code'll be able to read, edit, and execute files here.",
    ' ❯ No, exit',
    '   Yes, I trust this folder',
    ' Enter to confirm · Esc to cancel',
  ].join('\n')
  assert.ok(looksBlocked(screen))
})

test('an engine waiting at its own empty prompt is idle, not blocked', () => {
  const screen = [
    '▐▛███▛█   Claude Code v2.1.278',
    '  ▝▝ ▝▝    ~/code/widgets',
    '────────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────────',
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ].join('\n')
  assert.equal(looksBlocked(screen), false)
})

test('a finished turn above an empty prompt is idle too', () => {
  const screen = ['❯ Reply with exactly one word: acorn', '⏺ acorn', '✻ Cogitated for 5s · done', '❯ '].join('\n')
  assert.equal(looksBlocked(screen), false)
})

test('a pane that no longer exists reads as gone, although tmux says nothing and exits 0', async () => {
  // Measured: `tmux display-message -p -t %<missing>` prints an empty line and exits 0.
  assert.equal(await paneState('%182', { run: async () => '\n' }), null)
  assert.equal(await paneState('%182', { run: async () => '' }), null)
  assert.deepEqual(await paneState('%1', { run: async () => '0§§zsh§§\n' }), { dead: false, command: 'zsh', engineExit: null })
})

test('a finished turn whose answer is a numbered list is not a menu', () => {
  const screen = ['  3. Ship the fix behind a flag', '  4. Red test on main, not mine', '✻ Churned for 7s · done 7:20 PM', '❯ ', '  ⏵⏵ auto mode on (shift+tab to cycle)'].join('\n')
  assert.equal(looksBlocked(screen), false)
  const menu = ['Auto mode works better when it knows your environment.', '❯ 1. Yes', '  2. Not now', '  3. Don\'t show again', 'Enter to confirm · Esc to cancel'].join('\n')
  assert.ok(looksBlocked(menu), 'the real dialog still counts')
})
