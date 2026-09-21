// `node art.mjs …` as the agent runs it, and the corners of the generators the deck tests do not reach.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chart, frame, wallpaper } from '../art.mjs'

const TOOLCHAIN = fileURLToPath(new URL('..', import.meta.url))
const ART = join(TOOLCHAIN, 'art.mjs')

function art(args, { cwd, script = ART } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, NO_COLOR: '1' } })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'marp-art-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('the generators: light variants, seed 0, an all-zero chart, a one-point line, an image type it cannot frame', () => {
  const light = wallpaper({ dark: false, seed: 0 })
  assert.ok(light.includes('<rect width="1920" height="1080" fill="#fff"/>') && light.includes('stop-opacity="0.5"'))
  assert.equal(light, wallpaper({ dark: false, seed: 1 }), 'seed 0 is seed 1')
  const zero = chart({ data: 'a:0,b:0,c:x', dark: false })
  assert.equal((zero.match(/<rect/g) ?? []).length, 2, 'a value that is not a number is dropped')
  assert.ok(zero.includes('fill="#1d1d1f"') && zero.includes('height="0.0"'))
  const one = chart({ data: 'only:5', type: 'line' })
  assert.ok(one.includes('<circle cx="80.0"'), 'one point sits at the left edge')
  const dir = mkdtempSync(join(tmpdir(), 'marp-art-'))
  try {
    writeFileSync(join(dir, 'clip.bmp'), 'x')
    assert.throws(() => frame({ image: join(dir, 'clip.bmp') }), /frame: unsupported image .*clip\.bmp/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('wallpaper to a file, with every option', (t) => {
  const dir = scratch(t)
  const r = art(['wallpaper', '-o', 'bg.svg', '--palette', 'sunset', '--seed', '3', '--size', '640x360', '--light'], { cwd: dir })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout, 'wrote bg.svg\n')
  assert.equal(readFileSync(join(dir, 'bg.svg'), 'utf8'), wallpaper({ palette: 'sunset', seed: '3', size: '640x360', dark: false }))
})

test('chart to stdout; a flag followed by another flag is a switch', () => {
  const r = art(['chart', '--light', '--data', '2023:12,2024:31', '--type', 'line', '--accent', '#ff375f', '--label', 'Teams'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout, chart({ data: '2023:12,2024:31', type: 'line', accent: '#ff375f', label: 'Teams', dark: false }))
  assert.equal(art(['chart', '--data', 'a:1']).stdout, chart({ data: 'a:1' }))
})

test('frame resolves the image from where it is run, and a large one reaches a pipe whole', (t) => {
  const dir = scratch(t)
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'screen.png'), Buffer.alloc(600_000, 7))
  const r = art(['frame', '--image', 'assets/screen.png', '--kind', 'window', '--palette', 'ocean', '--seed', '9'], { cwd: dir })
  assert.equal(r.code, 0, r.stderr)
  const expected = frame({ image: join(dir, 'assets', 'screen.png'), kind: 'window', palette: 'ocean', seed: '9' })
  assert.ok(expected.length > 65536)
  assert.equal(r.stdout.length, expected.length, 'not cut off at the pipe buffer')
  assert.equal(r.stdout, expected)
})

test('what it cannot do: no image, no data, an unwritable output, an unknown command', (t) => {
  const dir = scratch(t)
  assert.deepEqual(art(['frame']), { code: 1, stdout: '', stderr: 'art: frame: --image <file> is required and must exist\n' })
  assert.deepEqual(art(['chart', '-o', 'x.svg'], { cwd: dir }), { code: 1, stdout: '', stderr: 'art: chart: --data "label:value,label:value" is required\n' })
  const unwritable = art(['wallpaper', '-o', join(dir, 'missing', 'bg.svg')])
  assert.equal(unwritable.code, 1)
  assert.match(unwritable.stderr, /^art: ENOENT: no such file or directory/)
  for (const args of [[], ['poster']]) {
    assert.deepEqual(art(args), { code: 2, stdout: '', stderr: 'usage: art.mjs wallpaper|chart|frame -o <file.svg> [options]\n' })
  }
})

test('runs from a path with a space and through a linked install; importing it runs nothing', (t) => {
  const dir = scratch(t)
  mkdirSync(join(dir, 'Harness Store'))
  symlinkSync(TOOLCHAIN, join(dir, 'Harness Store', 'toolchain'))
  const linked = art(['wallpaper', '--seed', '2'], { script: join(dir, 'Harness Store', 'toolchain', 'art.mjs') })
  assert.equal(linked.code, 0, linked.stderr)
  assert.equal(linked.stdout, wallpaper({ seed: '2' }))
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../art.mjs', import.meta.url).href)})`], { encoding: 'utf8' })
  assert.deepEqual([imported.status, imported.stdout, imported.stderr], [0, '', ''])
})
