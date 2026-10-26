import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmApiShares } from './swarmApiShares.js'
import type { ApiConnection } from './apiConnections.js'
import type { GridResult } from './gridExec.js'

const GRID = 'swarm-0123456789ab'
const ok: GridResult = { code: 'OK', exitCode: 0, stdout: '', stderr: '', message: '' }
const connection = { id: 'c1', name: 'OpenRouter', baseUrl: 'https://api.example.test/v1/' } as unknown as ApiConnection
const KEY = 'fixture-secret-key'

function setup(patch: { exec?: (args: readonly string[]) => Promise<GridResult>; fetch?: typeof fetch; access?: () => { connection: ApiConnection; apiKey: string }; stateFile?: string } = {}) {
  const exec = vi.fn(patch.exec ?? (async () => ok))
  const upstream = vi.fn(patch.fetch ?? (async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })))
  const shares = new SwarmApiShares({ access: patch.access ?? (() => ({ connection, apiKey: KEY })), exec, fetch: upstream as unknown as typeof fetch, ...(patch.stateFile ? { stateFile: patch.stateFile } : {}) })
  /** The local endpoint grid was told to join. */
  const at = () => { const args = exec.mock.calls.find(c => c[0].includes('join'))![0]; return args[args.indexOf('--at') + 1]! }
  return { shares, exec, upstream, at }
}

describe('an API shared with a Swarm', () => {
  let open: SwarmApiShares | null = null
  afterEach(async () => { await open?.stopAll(); open = null })

  it('joins a local endpoint under a secret path, which forwards completions and model lists with the key', async () => {
    const f = setup(); open = f.shares
    expect(await f.shares.share(GRID, 'c1', 'deepseek/deepseek-chat')).toEqual({ ok: true })
    const args = f.exec.mock.calls[0]![0]
    expect(args).toEqual(['--remote', 'join', GRID, '--at', expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{36}\/v1$/), '-m', 'deepseek/deepseek-chat',
      '--advertise-as', 'deepseek/deepseek-chat', '--max-concurrency', '4'])
    expect(args.join(' ')).not.toContain(KEY)
    expect(f.shares.list(GRID)).toEqual([{ grid: GRID, connectionId: 'c1', model: 'deepseek/deepseek-chat', name: 'OpenRouter' }])
    expect(f.shares.list('other')).toEqual([])
    // Sharing it again is done already.
    expect(await f.shares.share(GRID, 'c1', 'deepseek/deepseek-chat')).toEqual({ ok: true })
    expect(f.exec).toHaveBeenCalledOnce()

    const answer = await fetch(`${f.at()}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: '{"model":"m"}' })
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ ok: true })
    const [url, init] = f.upstream.mock.calls[0]! as unknown as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toBe('https://api.example.test/v1/chat/completions')
    expect(init.headers).toEqual({ authorization: `Bearer ${KEY}`, 'content-type': 'application/json', accept: 'text/event-stream' })
    expect(String(init.body)).toBe('{"model":"m"}')
    expect((await fetch(`${f.at()}/models`)).status).toBe(200)
    expect(f.upstream.mock.calls[1]![1]).not.toHaveProperty('body')
  })

  it('answers nothing outside its path and its three calls, too large a request, or an API that cannot be reached', async () => {
    const f = setup({ fetch: (async () => { throw new Error('offline') }) as unknown as typeof fetch }); open = f.shares
    await f.shares.share(GRID, 'c1', 'm')
    const root = f.at().replace(/\/[0-9a-f]{36}\/v1$/, '')
    expect((await fetch(`${root}/v1/models`)).status).toBe(404)
    expect((await fetch(`${f.at()}/embeddings`, { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await fetch(`${f.at()}/models`, { method: 'DELETE' })).status).toBe(404)
    expect((await fetch(`${f.at()}/chat/completions`, { method: 'POST', body: Buffer.alloc(33 * 1024 * 1024) }).catch(() => ({ status: 413 }))).status).toBe(413)
    expect((await fetch(`${f.at()}/chat/completions?x=1`, { method: 'POST', body: '{}' })).status).toBe(502)
    expect(f.upstream).toHaveBeenCalledOnce()
  })

  it('passes a body-less answer through, and its type when the API names none', async () => {
    const f = setup({ fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch }); open = f.shares
    await f.shares.share(GRID, 'c1', 'm')
    const answer = await fetch(`${f.at()}/chat/completions`, { method: 'POST', body: '{}' })
    expect(answer.status).toBe(204)
  })

  it('takes every share of a deleted API off its grid and closes it, even when grid refuses, and keeps the others', async () => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'shares-')), 'shares.json')
    const f = setup({ stateFile }); open = f.shares
    await f.shares.share(GRID, 'c1', 'deepseek/deepseek-chat')
    await f.shares.share('swarm-ffffffffffff', 'c1', 'deepseek/deepseek-chat')
    await f.shares.share(GRID, 'c2', 'google/gemini')
    f.exec.mockImplementation(async (args) => args.includes('leave') ? { ...ok, code: 'GRID_FAILED' as const, exitCode: 1, stderr: 'grid is down' } : ok)
    await f.shares.stopConnection('c1')
    expect(f.exec.mock.calls.filter(c => c[0].includes('leave')).map(c => c[0][2])).toEqual([GRID, 'swarm-ffffffffffff'])
    expect(f.shares.list().map(s => s.connectionId)).toEqual(['c2'])
    expect(JSON.parse(await readFile(stateFile, 'utf8')).map((r: { connectionId: string }) => r.connectionId)).toEqual(['c2'])
    // Nothing shared: nothing asked of grid.
    f.exec.mockClear()
    await f.shares.stopConnection('c9')
    expect(f.exec).not.toHaveBeenCalled()
  })

  it('stops by leaving the grid and closing its endpoint, and says why when grid or the API refuses', async () => {
    const f = setup(); open = f.shares
    await f.shares.share(GRID, 'c1', 'm')
    const at = f.at()
    expect(await f.shares.stop(GRID, 'c1', 'm')).toEqual({ ok: true })
    expect(f.exec).toHaveBeenLastCalledWith(['--remote', 'leave', GRID, '--engine', 'm'])
    await expect(fetch(`${at}/models`)).rejects.toThrow()
    expect(f.shares.list()).toEqual([])
    expect(await f.shares.stop(GRID, 'c1', 'm')).toEqual({ ok: true })

    const refused = setup({ exec: async () => ({ ...ok, code: 'GRID_FAILED', exitCode: 1, stderr: 'not a member\n' }) })
    expect(await refused.shares.share(GRID, 'c1', 'm')).toEqual({ error: 'not a member' })
    expect(refused.shares.list()).toEqual([])
    const silent = setup({ exec: async () => ({ ...ok, code: 'GRID_FAILED', exitCode: 1 }) })
    expect(await silent.shares.share(GRID, 'c1', 'm')).toEqual({ error: 'grid refused the request.' })

    const unsaved = setup({ access: () => { throw new Error('This API is not saved.') } })
    expect(await unsaved.shares.share(GRID, 'c9', 'm')).toEqual({ error: 'This API is not saved.' })
    const odd = setup({ access: () => { throw 'odd' } })
    expect(await odd.shares.share(GRID, 'c9', 'm')).toEqual({ error: 'This API is not saved.' })

    // Leaving refused: still shared, and said.
    const stuck = setup(); open = stuck.shares
    await stuck.shares.share(GRID, 'c1', 'm')
    stuck.exec.mockResolvedValueOnce({ ...ok, code: 'GRID_FAILED', exitCode: 1, stderr: 'busy' })
    expect(await stuck.shares.stop(GRID, 'c1', 'm')).toEqual({ error: 'busy' })
    expect(stuck.shares.list()).toHaveLength(1)
  })

  it('joins a share again at the address it has, never leaving first, and shares one it does not have', async () => {
    const f = setup(); open = f.shares
    await f.shares.share(GRID, 'c1', 'm')
    const before = f.at()
    expect(await f.shares.rejoin(GRID, 'c1', 'm')).toEqual({ ok: true })
    expect(f.exec.mock.calls.map(c => c[0].slice(0, 2))).toEqual([['--remote', 'join'], ['--remote', 'join']])
    expect(f.exec.mock.calls[1]![0][f.exec.mock.calls[1]![0].indexOf('--at') + 1]).toBe(before)
    f.exec.mockResolvedValueOnce({ ...ok, code: 'GRID_FAILED', exitCode: 1, stderr: 'busy' })
    expect(await f.shares.rejoin(GRID, 'c1', 'm')).toEqual({ error: 'busy' })
    f.exec.mockRejectedValueOnce(new Error('gone'))
    expect(await f.shares.rejoin(GRID, 'c1', 'm')).toEqual({ error: 'grid could not be run on this computer.' })
    expect(f.shares.list(GRID)).toHaveLength(1)
    expect(await f.shares.rejoin(GRID, 'c1', 'other')).toEqual({ ok: true })
    expect(f.shares.list(GRID)).toHaveLength(2)
  })

  it('runs its joins and leaves one at a time, whoever asks', async () => {
    let running = 0, most = 0
    const f = setup({ exec: async () => { running++; most = Math.max(most, running); await new Promise(r => setTimeout(r, 10)); running--; return ok } })
    open = f.shares
    await Promise.all([f.shares.share(GRID, 'c1', 'a'), f.shares.share(GRID, 'c1', 'b'), f.shares.rejoin(GRID, 'c1', 'a'), f.shares.stop(GRID, 'c1', 'b')])
    expect(most).toBe(1)
    expect(f.shares.list(GRID).map(s => s.model)).toEqual(['a'])
    // A join that throws does not hold the rest up.
    f.exec.mockRejectedValueOnce(new Error('gone'))
    expect(await f.shares.share(GRID, 'c1', 'c')).toEqual({ error: 'grid could not be run on this computer.' })
    expect(await f.shares.share(GRID, 'c1', 'd')).toEqual({ ok: true })
  })

  it('notes its shares and their addresses without the key, and the next process shares them again where they were', async () => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'swarm-api-shares-')), 'shares.json')
    const f = setup({ stateFile }); open = f.shares
    await f.shares.share(GRID, 'c1', 'm')
    const at = f.at()
    const noted = await readFile(stateFile, 'utf8')
    const [port, token] = /^http:\/\/127\.0\.0\.1:(\d+)\/([0-9a-f]{36})\/v1$/.exec(at)!.slice(1)
    expect(JSON.parse(noted)).toEqual([{ grid: GRID, alias: 'm', connectionId: 'c1', port: Number(port), token }])
    expect(noted).not.toContain(KEY)
    await f.shares.stopAll()
    // The process ended without stopping it: the note is still there, and the share comes back at the same address,
    // joined without a leave.
    await writeFile(stateFile, noted)
    const next = setup({ stateFile }); open = next.shares
    await next.shares.restore()
    expect(next.exec.mock.calls.map(c => c[0].slice(0, 3))).toEqual([['--remote', 'join', GRID]])
    expect(next.at()).toBe(at)
    expect(next.shares.list()).toEqual([{ grid: GRID, connectionId: 'c1', model: 'm', name: 'OpenRouter' }])
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual(JSON.parse(noted))
    // Its port taken meanwhile: the old address leaves first, and it joins at a new one.
    await next.shares.stopAll()
    const blocker = (await import('node:net')).createServer()
    await new Promise<void>(resolve => blocker.listen(Number(port), '127.0.0.1', resolve))
    await writeFile(stateFile, noted)
    const moved = setup({ stateFile }); open = moved.shares
    await moved.shares.restore()
    expect(moved.exec.mock.calls.map(c => c[0].slice(0, 2))).toEqual([['--remote', 'leave'], ['--remote', 'join']])
    expect(moved.at()).not.toBe(at)
    await moved.shares.stopAll()
    blocker.close()
    // A note from before connections were noted is taken off and not shared; one from before addresses were noted is taken
    // off and shared anew; a token that is not one is no address. Junk, failures and no file break nothing.
    await writeFile(stateFile, JSON.stringify([null, { grid: 7 }, { grid: GRID, alias: 'x' }, { grid: GRID, alias: 'y', connectionId: 'c1', port: 70000, token: 'zz' }]))
    const old = setup({ stateFile }); open = old.shares
    await old.shares.restore()
    expect(old.exec.mock.calls.map(c => c[0].slice(0, 2))).toEqual([['--remote', 'leave'], ['--remote', 'leave'], ['--remote', 'join']])
    await old.shares.stopAll()
    await writeFile(stateFile, JSON.stringify([{ grid: GRID, alias: 'x', connectionId: 'c1' }]))
    const failing = setup({ stateFile, exec: async () => { throw new Error('gone') } })
    await failing.shares.restore()
    expect(failing.shares.list()).toEqual([])
    expect(await failing.shares.share(GRID, 'c1', 'm')).toEqual({ error: 'grid could not be run on this computer.' })
    await writeFile(stateFile, 'not json')
    await setup({ stateFile }).shares.restore()
    await setup({ stateFile: join(stateFile, 'missing', 'x.json') }).shares.restore()
    await setup().shares.restore()
  })

})
