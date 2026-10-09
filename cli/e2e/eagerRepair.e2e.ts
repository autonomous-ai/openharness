/** Native Muse discovery and Pi Close/resume with optional interpretation absent or stalled. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, onTestFailed } from 'vitest'
import { readLeanBundle } from '../src/harnessd/leanBundle.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { withLean } from './harness/release.js'

let scratch = '', bundle = ''
let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'eager-repair-'))
  bundle = join(scratch, 'build', 'cli.js')
  execFileSync(process.execPath, ['build-bundle.mjs'], { cwd: CLI_ROOT,
    env: { ...process.env, BUNDLE_OUT_DIR: dirname(bundle) }, stdio: 'pipe' })
}, 120_000)
afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })
afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }) })

it.each(['missing', 'stalled'] as const)('discovers Muse and closes/resumes Pi with %s optional readers', async mode => {
  const lean = readLeanBundle(readFileSync(bundle))!
  const files = Object.fromEntries([...lean.files].map(([name, value]) => [name, value.toString('utf8')]))
  for (const marker of ['MuseNormalizer', 'PiNormalizer']) {
    const chunks = Object.keys(files).filter(name => name.startsWith('core-inProcess-') && files[name]!.includes(marker))
    expect(chunks, marker).toHaveLength(1)
    if (mode === 'missing') delete files[chunks[0]!]
    else files[chunks[0]!] = `console.error('[fixture] ${marker} stalled'); await new Promise(() => {});\n`
  }
  const script = join(scratch, mode, 'cli.js'); mkdirSync(dirname(script), { recursive: true })
  writeFileSync(script, withLean(readFileSync(bundle, 'utf8'), files), { mode: 0o755 })
  const d = daemon = await IsolatedDaemon.create({ scriptPath: script, env: { HARNESS_CONNECTIONS_PORT: '0' } })
  onTestFailed(() => console.log(d.log()))
  d.env.MUSE_HOME = join(d.root, 'muse'); d.env.PI_HOME = join(d.root, 'pi')
  const museId = 'aaaaaaaa-1111-4222-8333-444444444444'
  const piIds = { unwritten: 'bbbbbbbb-1111-4222-8333-444444444444', written: 'cccccccc-1111-4222-8333-444444444444' }
  for (const engine of ['muse', 'pi'] as const) {
    const path = join(d.root, 'bin', engine); d.env[`${engine.toUpperCase()}_PATH`] = path
    writeFileSync(path, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
if (process.argv.includes('--version') || process.argv.includes('--help')) { console.log('1.0.0'); process.exit(0) }
const id = process.argv.includes('--session') ? process.argv[process.argv.indexOf('--session') + 1] : (${JSON.stringify(piIds)})[path.basename(process.cwd())];
process.title = (${JSON.stringify(engine)} === 'pi' ? 'pi --session-id ' + id : 'muse').padEnd(160);
fs.appendFileSync(${JSON.stringify(join(d.root, `${engine}-launches.jsonl`))}, JSON.stringify({ id, args: process.argv.slice(2) }) + '\\n');
${engine === 'muse' ? `const folder = path.join(process.env.MUSE_HOME, 'sessions', '2026', '10', '09', '${museId}');
fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'session.jsonl'), [
{payload:{record:{workspace_root:process.cwd()}}}, {payload:{kind:'run',event:{kind:'started',prompt:''}}}
].map(JSON.stringify).join('\\n') + '\\n');` : ''}
console.log('fixture-${engine}-ready'); setInterval(() => {}, 1000);
`, { mode: 0o755 })
  }
  await d.start()
  const c = client = await LocalClient.connect(d)
  const rows = async () => (await c.request('agents_list', { includeStopped: true })).agents as Array<Record<string, any>>
  const create = async (engine: string, name: string) => {
    const cwd = join(d.projectsDir, name); mkdirSync(cwd)
    const result = await c.request('agent_create', { engine, cwd }, 60_000)
    expect(result.error, JSON.stringify(result)).toBeUndefined()
    return result.agent as Record<string, any>
  }
  const muse = await create('muse', 'muse')
  await until('Muse scheduled run binds without its interpreter', async () => (await rows()).find(row => row.id === muse.id)?.sessionId === museId || null, 30_000, 100)
  for (const name of ['unwritten', 'written'] as const) {
    const pi = await create('pi', name)
    const id = piIds[name]
    const bound = await until('Pi preallocated identity binds', async () => {
      const row = (await rows()).find(row => row.id === pi.id)
      return row?.sessionId === id && row.status === 'active' ? row : null
    }, 30_000, 100)
    const close = () => c.request('agent_close', { agentId: pi.id, sessionId: id, createdAt: bound.createdAt, mode: 'now' }, 45_000)
    if (name === 'written') {
      const cwd = join(d.projectsDir, name)
      const folder = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
      const path = join(d.env.PI_HOME, 'agent', 'sessions', folder, `2026-10-09_${id}.jsonl`)
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '')
      const held = await close()
      expect(held.error).toBeTruthy()
      expect(held.detail).toContain('could not be read')
      expect((await rows()).find(row => row.id === pi.id)).toMatchObject({ status: 'active', sessionId: id })
      writeFileSync(path, JSON.stringify({ type: 'session', id, cwd }) + '\n')
      // A second native file cannot turn exact resume into a first-file guess at Close.
      const duplicate = join(dirname(path), `2026-10-10_${id}.jsonl`)
      writeFileSync(duplicate, JSON.stringify({ type: 'session', id, cwd }) + '\n')
      const ambiguous = await close()
      expect(ambiguous.error).toBeTruthy()
      expect(ambiguous.detail).toContain('More than one file')
      expect((await rows()).find(row => row.id === pi.id)).toMatchObject({ status: 'active', sessionId: id })
      rmSync(duplicate)
    }
    expect(await close()).toMatchObject({ closed: true })
    expect((await rows()).find(row => row.id === pi.id)).toMatchObject({ status: 'stopped', sessionId: id })
    // Before a first reply Pi has no native conversation to resume; Close still preserves its screen.
    if (name === 'unwritten') continue
    const resumed = await c.request('agent_resume', { agentId: pi.id }, 60_000)
    expect(resumed.error, JSON.stringify(resumed)).toBeUndefined()
    await until('Pi resumes its exact preallocated conversation', async () =>
      (await rows()).find(row => row.id === pi.id)?.status === 'active' || null, 30_000, 100)
    await until('the private Pi process received the saved resume ID', () => readFileSync(join(d.root, 'pi-launches.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(line => JSON.parse(line)).some(row => row.id === id && row.args.includes('--session')) || null, 15_000, 100)
  }
  expect((await fetch(`http://127.0.0.1:${d.port}/api/health`)).ok).toBe(true)
  expect(d.coresStarted()).toBe(1)
}, 240_000)
