import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { keepStill } from '../lib/stills.mjs'
import { png } from './media.mjs'

test('stills preserve different versions and retry the same bytes without another copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'video-kept-stills-'))
  try {
    const a = png(), b = Buffer.concat([a, Buffer.from('another native frame fixture')])
    const first = keepStill(root, 'Intro-f0005', a), second = keepStill(root, 'Intro-f0005', b)
    assert.notEqual(first.path, second.path)
    assert.deepEqual(readFileSync(first.abs), a)
    assert.deepEqual(readFileSync(second.abs), b)
    assert.deepEqual(keepStill(root, 'Intro-f0005', a), first)
    assert.equal(readdirSync(join(root, '.harness/stills')).length, 2)
    writeFileSync(first.abs, 'user-edited old evidence')
    const recovered = keepStill(root, 'Intro-f0005', a)
    assert.notEqual(recovered.path, first.path)
    assert.deepEqual(readFileSync(recovered.abs), a)
    assert.equal(readFileSync(first.abs, 'utf8'), 'user-edited old evidence')
    assert.deepEqual(keepStill(root, 'Intro-f0005', a), recovered)
    assert.ok(readdirSync(join(root, '.harness/stills')).every(name => name.endsWith('.png')), 'no staging files remain')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('still writes cannot follow symlinked workspace subdirectories or existing image names', () => {
  const root = mkdtempSync(join(tmpdir(), 'video-still-links-'))
  const outside = mkdtempSync(join(tmpdir(), 'video-still-outside-'))
  try {
    symlinkSync(outside, join(root, '.harness'))
    assert.throws(() => keepStill(root, 'frame', png()), /real workspace directory/)
    assert.deepEqual(readdirSync(outside), [])
    rmSync(join(root, '.harness')); mkdirSync(join(root, '.harness'))
    symlinkSync(outside, join(root, '.harness/stills'))
    assert.throws(() => keepStill(root, 'frame', png()), /real workspace directory/)
    assert.deepEqual(readdirSync(outside), [])
    rmSync(join(root, '.harness/stills'))
    const saved = keepStill(root, 'frame', png())
    const other = join(outside, 'untouched.png'); writeFileSync(other, 'outside')
    rmSync(saved.abs); symlinkSync(other, saved.abs)
    const next = keepStill(root, 'frame', png())
    assert.notEqual(next.path, saved.path)
    assert.equal(readFileSync(other, 'utf8'), 'outside')
    assert.deepEqual(readFileSync(next.abs), png())
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})
