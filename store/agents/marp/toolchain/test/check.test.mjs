// `node toolchain/check.mjs [deck]` as the agent runs it: what it prints, what it writes, how it exits.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHECK = fileURLToPath(new URL('../check.mjs', import.meta.url))
const body = 'A body with several words in it.'
const READY = `---\nmarp: true\n---\n# Talk\n\n![bg](bg.svg)\n\n${body}\n\n---\n\n## A\n\n${body}\n\n---\n\n## B\n\n${body}\n`

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'marp-check-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const ws = join(root, 'ws')
  mkdirSync(ws)
  writeFileSync(join(ws, 'bg.svg'), '<svg/>')
  return { root, ws }
}

function check(args, { cwd, env = {} }) {
  const { HARNESS_WORKSPACE: _, ...inherited } = process.env
  const r = spawnSync(process.execPath, [CHECK, ...args], { cwd, encoding: 'utf8', env: { ...inherited, ...env } })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

const verdictOf = (ws) => JSON.parse(readFileSync(join(ws, '.harness', 'verdict.json'), 'utf8'))

test('a ready deck: one line, exit 0, the verdict written', (t) => {
  const { ws } = workspace(t)
  writeFileSync(join(ws, 'deck.md'), READY)
  assert.deepEqual(check([], { cwd: ws }), { code: 0, stdout: 'ready · 3 slides, ready to present\n', stderr: '' })
  assert.equal(verdictOf(ws).artifact, 'deck.md')
  assert.equal(check(['.'], { cwd: ws }).code, 0, 'the workspace itself means its deck')
})

test('a deck that is not ready prints its findings and exits 1', (t) => {
  const { ws } = workspace(t)
  writeFileSync(join(ws, 'deck.md'), READY.replace('bg.svg', 'gone.svg'))
  const r = check(['deck.md'], { cwd: ws })
  assert.equal(r.code, 1)
  assert.deepEqual(r.stdout.split('\n'), ['not ready · 1 error · 3 slides', '  error   image gone.svg is not in the workspace', ''])
  assert.equal(verdictOf(ws).ready, false)
})

test('HARNESS_WORKSPACE wins over the working directory, and a deck in a folder is named by its path', (t) => {
  const { root, ws } = workspace(t)
  mkdirSync(join(ws, 'talks'))
  writeFileSync(join(ws, 'talks', 'keynote.md'), READY)
  writeFileSync(join(ws, 'talks', 'bg.svg'), '<svg/>')
  const r = check(['talks/keynote.md'], { cwd: root, env: { HARNESS_WORKSPACE: ws } })
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.equal(verdictOf(ws).artifact, 'talks/keynote.md')
})

test('a deck that is missing, or outside the workspace, is not checked', (t) => {
  const { root, ws } = workspace(t)
  assert.deepEqual(check(['talk.md'], { cwd: ws }), { code: 2, stdout: '', stderr: `check: talk.md is not in ${realpathSync(ws)}\n` }, 'without HARNESS_WORKSPACE the workspace is the working directory')
  mkdirSync(join(root, 'other'))
  writeFileSync(join(root, 'other', 'deck.md'), READY)
  const outside = check(['../other/deck.md'], { cwd: root, env: { HARNESS_WORKSPACE: ws } })
  assert.deepEqual(outside, { code: 2, stdout: '', stderr: `check: ../other/deck.md is not in ${ws}\n` })
  assert.equal(existsSync(join(ws, '.harness')), false, 'and no verdict is written for it')
})
