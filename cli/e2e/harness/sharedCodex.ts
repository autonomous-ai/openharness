/** The local app-server protocol of an older shared Codex session, without a model or credentials.
 * Its real loopback WebSocket is reached through the fake CLI's raw-byte `app-server proxy` command. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'

export async function sharedCodex(home: string) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing fixture server port')
  const start = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' }).trim()
  mkdirSync(join(home, 'app-server-daemon'), { recursive: true })
  writeFileSync(join(home, 'app-server-daemon', 'daemon.pid'), JSON.stringify({ pid: process.pid, processStartTime: start }))
  writeFileSync(join(home, 'app-server-daemon', 'fake-proxy.json'), JSON.stringify({ port: address.port }))
  const state = { threadId: '', loaded: true, requests: [] as Array<{ method: string; params?: Record<string, unknown> }> }
  server.on('connection', socket => socket.on('message', bytes => {
    const frame = JSON.parse(String(bytes)) as { id?: number; method: string; params?: Record<string, unknown> }
    state.requests.push(frame)
    if (frame.id === undefined) return
    let result: Record<string, unknown> = {}
    if (frame.method === 'initialize') result = { codexHome: home }
    else if (frame.params?.threadId !== state.threadId) {
      socket.send(JSON.stringify({ id: frame.id, error: { message: 'unknown fixture thread' } })); return
    } else if (frame.method === 'thread/read') result = { thread: { id: state.threadId, status: { type: state.loaded ? 'active' : 'notLoaded' } } }
    else if (frame.method === 'thread/goal/get') result = { goal: { status: 'active' } }
    else if (frame.method === 'thread/turns/list') result = { data: [{ id: 'held-turn', status: 'inProgress' }] }
    else if (frame.method === 'thread/archive') state.loaded = false
    socket.send(JSON.stringify({ id: frame.id, result }))
  }))
  return { state, async close() {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  } }
}
