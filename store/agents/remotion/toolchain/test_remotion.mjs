// $REMOTION's progress parsing, against the lines Remotion 4.0.525's CLI prints, and $REMOTION itself
// run against a stand-in CLI (REMOTION_CLI): node --test toolchain/test_remotion.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseLine, shouldPrint } from './remotion.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms))

test('reads the stages of a render', () => {
  assert.deepEqual(parseLine('Bundling 50%'), { stage: 'bundling', progress: 0.05 })
  assert.deepEqual(parseLine('Getting composition'), { stage: 'preparing' })
  assert.deepEqual(parseLine('\x1b[90mComposition          Main\x1b[39m'), { composition: 'Main' })
  assert.deepEqual(parseLine('\x1b[90mOutput               out/main.mp4\x1b[39m'), { output: 'out/main.mp4' })
  assert.deepEqual(parseLine('\x1b[90mCodec                h264\x1b[39m'), { codec: 'h264' })
  assert.deepEqual(parseLine('Rendered 30/60, time remaining: 1s'), { stage: 'rendering', frame: 30, frames: 60, remaining: '1s', progress: 0.5 })
  assert.deepEqual(parseLine('Rendered 0/60'), { stage: 'rendering', frame: 0, frames: 60, remaining: null, progress: 0.1 })
  assert.deepEqual(parseLine('Rendered 0/0'), { stage: 'rendering', frame: 0, frames: 0, remaining: null, progress: 0.1 })
  assert.deepEqual(parseLine('Encoded 60/60'), { stage: 'encoding', frame: 60, frames: 60, progress: 1 })
  assert.deepEqual(parseLine('Encoded 0/0'), { stage: 'encoding', frame: 0, frames: 0, progress: 0.9 })
  assert.deepEqual(parseLine('\x1b[34m+                    out/main.mp4\x1b[39m \x1b[90m391.6 kB\x1b[39m'), { output: 'out/main.mp4', stage: 'finishing', progress: 1 })
  assert.equal(parseLine('Cached bundle. Subsequent renders will be faster.'), null)
})

test('prints progress every tenth, and everything else always', () => {
  const last = {}
  const printed = []
  for (let i = 0; i <= 60; i++) if (shouldPrint(`Rendered ${i}/60`, last)) printed.push(i)
  assert.deepEqual(printed, [0, 6, 12, 18, 24, 30, 36, 42, 48, 54, 60])
  assert.equal(shouldPrint('Getting composition', last), true)
  assert.equal(shouldPrint('Encoded 60/60', last), true)
  assert.equal(shouldPrint('Encoded 60/60', last), true, 'the end is always printed')
  const bundling = ['Bundling 1%', 'Bundling 5%', 'Bundling 10%', 'Bundling 100%'].filter((l) => shouldPrint(l, last))
  assert.deepEqual(bundling, ['Bundling 1%', 'Bundling 10%', 'Bundling 100%'])
  assert.equal(shouldPrint('Encoded 3/0', last), true, 'an unknown total counts as the start')
  assert.equal(shouldPrint('Encoded 4/0', last), false)
})

test('loopback.cjs keeps TCP listeners on 127.0.0.1 and leaves named hosts and pipes alone', async () => {
  const { loopbackArgs } = createRequire(import.meta.url)('./loopback.cjs')
  const f = () => {}
  assert.deepEqual(loopbackArgs([]), [0, '127.0.0.1'])
  assert.deepEqual(loopbackArgs([undefined]), [0, '127.0.0.1'])
  assert.deepEqual(loopbackArgs([null, f]), [0, '127.0.0.1', f])
  assert.deepEqual(loopbackArgs([f]), [0, '127.0.0.1', f])
  assert.deepEqual(loopbackArgs([3000, f]), [3000, '127.0.0.1', f])
  assert.deepEqual(loopbackArgs(['3000', 511, f]), ['3000', '127.0.0.1', 511, f])
  assert.deepEqual(loopbackArgs([3000, '::', f]), [3000, '127.0.0.1', f])
  assert.deepEqual(loopbackArgs([3000, '0.0.0.0']), [3000, '127.0.0.1'])
  assert.deepEqual(loopbackArgs([{ port: 0 }]), [{ port: 0, host: '127.0.0.1' }])
  assert.deepEqual(loopbackArgs([{ port: 0, host: '::' }, f]), [{ port: 0, host: '127.0.0.1' }, f])
  assert.deepEqual(loopbackArgs([{ port: 0, host: 'localhost' }]), [{ port: 0, host: 'localhost' }])
  assert.deepEqual(loopbackArgs([3000, 'localhost']), [3000, 'localhost'])
  assert.deepEqual(loopbackArgs(['/tmp/remotion.sock']), ['/tmp/remotion.sock'])
  for (const key of ['path', 'fd', 'handle', '_handle']) {
    assert.deepEqual(loopbackArgs([{ [key]: 3 }]), [{ [key]: 3 }], key)
  }

  // Required, it patches every server in the process: a listen() with no host lands on loopback.
  const server = net.createServer()
  await new Promise((ok) => server.listen(0, ok))
  try {
    assert.equal(server.address().address, '127.0.0.1')
  } finally {
    await new Promise((ok) => server.close(ok))
  }
})

// ---- $REMOTION against a stand-in CLI --------------------------------------------------------------

function scratch(t, prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A CLI whose behaviour is the given module body; `process.env.SEEN` lets it record render.json mid-run. */
function fakeCli(t, body) {
  const dir = scratch(t, 'remotion-cli-')
  writeFileSync(join(dir, 'cli.mjs'), body)
  writeFileSync(join(dir, 'remotion'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, 'cli.mjs'))} "$@"\n`)
  chmodSync(join(dir, 'remotion'), 0o755)
  return join(dir, 'remotion')
}

const SEEN = `import { appendFileSync, readFileSync } from 'node:fs'
const seen = (label) => appendFileSync(process.env.SEEN, label + ' ' + readFileSync(process.env.HARNESS_WORKSPACE + '/.harness/render.json', 'utf8').replace(/\\n\\s*/g, '') + '\\n')
const out = (s) => process.stdout.write(s)
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms))
`

function run(t, args, { cli, workspace, env = {}, onStart } = {}) {
  const ws = workspace ?? scratch(t, 'remotion-ws-')
  const seen = join(ws, 'seen.log')
  const base = { ...process.env }
  delete base.FORCE_COLOR
  const child = spawn(process.execPath, [join(HERE, 'remotion.mjs'), ...args], {
    cwd: ws, env: { ...base, HARNESS_WORKSPACE: ws, REMOTION_CLI: cli, SEEN: seen, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  onStart?.(child, () => stdout)
  return new Promise((ok) => child.on('exit', (code, signal) => {
    const file = join(ws, '.harness', 'render.json')
    ok({
      code, signal, stdout, stderr, ws,
      job: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null,
      seen: existsSync(seen) ? readFileSync(seen, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf(' ')), JSON.parse(l.slice(l.indexOf(' ') + 1))]) : [],
    })
  }))
}

test('any other subcommand is Remotion itself: same arguments, same output, same exit code', async (t) => {
  const cli = fakeCli(t, "console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 3\n")
  const r = await run(t, ['compositions', 'src/index.ts', '--quiet'], { cli })
  assert.deepEqual([r.code, r.stdout], [3, '["compositions","src/index.ts","--quiet"]\n'])
  assert.equal(r.job, null, 'no render, no render.json')

  const killed = await run(t, ['--help'], { cli: fakeCli(t, "process.kill(process.pid, 'SIGKILL')\n") })
  assert.equal(killed.code, 1, 'killed by a signal is a failure')

  const missing = await run(t, ['studio'], { cli: join(scratch(t, 'remotion-none-'), 'remotion') })
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /^remotion could not start: spawn .*remotion ENOENT\n$/)
})

test('a render writes its progress to .harness/render.json as it goes, and prints every tenth', async (t) => {
  const cli = fakeCli(t, `${SEEN}
seen('start')
out('Bundling 5%\\nBundling 50%\\rBundling 100%\\r\\n')
out('Getting composition\\n')
out('\\x1b[90mComposition          Main\\x1b[39m\\n')
out('Codec                h264\\n\\n')
out('Output               out/main.mp4\\n')
for (let i = 0; i <= 20; i++) out('Rendered ' + i + '/20, time remaining: ' + (20 - i) + 's\\n')
await pause(400)
seen('rendering')
out('Encoded 0/20\\nEncoded 20/20\\n')
process.stderr.write('a warning, on stderr\\n')
out('FORCE_COLOR=' + process.env.FORCE_COLOR + '\\n')
out('\\x1b[34m+                    out/main.mp4\\x1b[39m 391.6 kB')
`)
  const r = await run(t, ['render', 'src/index.ts', 'Main', 'out/main.mp4', '--codec=h264'], { cli })
  assert.equal(r.code, 0, r.stderr)
  const [[, start], [, rendering]] = r.seen
  assert.deepEqual([start.state, start.stage, start.progress, start.composition, start.command], ['running', 'starting', 0, 'Main', 'render'])
  assert.deepEqual([rendering.stage, rendering.frame, rendering.frames, rendering.remaining, rendering.codec, rendering.output], ['rendering', 20, 20, '0s', 'h264', 'out/main.mp4'])
  assert.equal(rendering.progress, 0.9)
  const { job } = r
  assert.deepEqual([job.state, job.stage, job.progress, job.composition, job.output, job.frame, job.frames, job.error], ['done', 'done', 1, 'Main', 'out/main.mp4', 20, 20, null])
  assert.ok(job.finishedAt >= job.startedAt && job.updatedAt >= job.finishedAt)
  const lines = r.stdout.split('\n')
  assert.deepEqual(lines.filter((l) => l.startsWith('Rendered')).map((l) => l.split(',')[0]), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20].map((i) => `Rendered ${i}/20`))
  assert.deepEqual(lines.filter((l) => l.startsWith('Bundling')), ['Bundling 5%', 'Bundling 50%', 'Bundling 100%'])
  assert.ok(lines.includes('FORCE_COLOR=1'), 'colour is kept on for a terminal that reads the output')
  assert.ok(lines.includes('\x1b[34m+                    out/main.mp4\x1b[39m 391.6 kB'), 'a last line without a newline still arrives')
  assert.equal(r.stderr, 'a warning, on stderr\n')
})

test('the composition is guessed from the arguments until the CLI names it', async (t) => {
  const cli = fakeCli(t, `${SEEN}\nseen('start')\n`)
  const guess = async (...args) => (await run(t, args, { cli })).seen[0][1].composition
  assert.equal(await guess('still', 'Poster', 'out/poster.png', '--frame=30'), 'Poster')
  assert.equal(await guess('render', 'src/index.tsx', 'Intro'), 'Intro')
  assert.equal(await guess('render'), null)
})

test('an output path is kept relative to the workspace', async (t) => {
  const ws = scratch(t, 'remotion-ws-')
  mkdirSync(join(ws, 'sub'))
  const cli = fakeCli(t, "console.log('Output ../out/a.mp4'); console.log('Output .')\n")
  const r = await run(t, ['render', 'Main'], { cli, workspace: ws, env: { HARNESS_WORKSPACE: ws } })
  assert.equal(r.job.output, '.', 'the workspace itself is named, not left empty')
  const sub = await new Promise((ok) => {
    const child = spawn(process.execPath, [join(HERE, 'remotion.mjs'), 'render', 'Main'], { cwd: join(ws, 'sub'), env: { ...process.env, HARNESS_WORKSPACE: ws, REMOTION_CLI: fakeCli(t, "console.log('Output ../out/a.mp4')\n") }, stdio: 'ignore' })
    child.on('exit', () => ok(JSON.parse(readFileSync(join(ws, '.harness', 'render.json'), 'utf8'))))
  })
  assert.equal(sub.output, 'out/a.mp4')
})

test('a failed render keeps the lines that say why', async (t) => {
  const noisy = fakeCli(t, `
for (let i = 0; i < 25; i++) console.error('webpack ' + i)
console.error("Error: Cannot find module './Missing'")
console.error('✖ Render failed')
console.error('see above')
process.exitCode = 2
`)
  const r = await run(t, ['render', 'Main'], { cli: noisy })
  assert.equal(r.code, 2)
  assert.deepEqual([r.job.state, r.job.stage, r.job.progress], ['failed', 'failed', 0])
  assert.equal(r.job.error, "Error: Cannot find module './Missing'\n✖ Render failed")

  const plain = await run(t, ['render', 'Main'], { cli: fakeCli(t, "console.log('one\\ntwo\\nthree\\nfour'); process.exitCode = 4\n") })
  assert.equal(plain.job.error, 'two\nthree\nfour', 'no error line: the last three')
  const silent = await run(t, ['render', 'Main'], { cli: fakeCli(t, 'process.exit(5)\n') })
  assert.deepEqual([silent.code, silent.job.error], [5, 'remotion exited 5'])

  const missing = await run(t, ['still', 'Poster'], { cli: join(scratch(t, 'remotion-none-'), 'remotion') })
  assert.equal(missing.code, 1)
  assert.deepEqual([missing.job.command, missing.job.state], ['still', 'failed'])
  assert.match(missing.job.error, /spawn .*remotion ENOENT/)
})

test('stopping $REMOTION stops the render and records it as failed', async (t) => {
  const cli = fakeCli(t, "console.log('Rendered 1/10'); setInterval(() => {}, 1000)\n")
  const r = await run(t, ['render', 'Main'], {
    cli,
    onStart: async (child, stdout) => {
      while (!stdout().includes('Rendered 1/10')) await wait(20)
      child.kill('SIGTERM')
    },
  })
  assert.equal(r.code, 1)
  assert.deepEqual([r.job.state, r.job.frame, r.job.error], ['failed', 1, 'Rendered 1/10'])
})

test('without HARNESS_WORKSPACE the workspace is where $REMOTION runs', async (t) => {
  const ws = scratch(t, 'remotion-ws-')
  const child = spawn(process.execPath, [join(HERE, 'remotion.mjs'), 'render', 'Main'], {
    cwd: ws, env: { ...process.env, HARNESS_WORKSPACE: '', REMOTION_CLI: fakeCli(t, "console.log('Composition   Main')\n") }, stdio: 'ignore',
  })
  assert.equal(await new Promise((ok) => child.on('exit', ok)), 0)
  assert.equal(JSON.parse(readFileSync(join(ws, '.harness', 'render.json'), 'utf8')).state, 'done')
})

test('a workspace whose .harness cannot be written still renders', async (t) => {
  const ws = scratch(t, 'remotion-ws-')
  writeFileSync(join(ws, '.harness'), 'not a folder')
  const r = await run(t, ['render', 'Main'], { cli: fakeCli(t, "console.log('Rendered 1/2'); console.log('FORCE_COLOR=' + process.env.FORCE_COLOR)\n"), workspace: ws, env: { FORCE_COLOR: '0' } })
  assert.equal(r.code, 0)
  assert.match(r.stdout, /FORCE_COLOR=0/, "the caller's colour setting wins")
  assert.equal(readFileSync(join(ws, '.harness'), 'utf8'), 'not a folder')
})

test('imported, or run without a script path, it does nothing', async (t) => {
  const r = await new Promise((ok) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(HERE, 'remotion.mjs')).href)})`], { env: { ...process.env, REMOTION_CLI: join(scratch(t, 'remotion-none-'), 'remotion') } })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('exit', (code) => ok({ code, out }))
  })
  assert.deepEqual(r, { code: 0, out: '' })
})
