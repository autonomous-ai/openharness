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
  // `open` counts the clients connected now. A request named in `hold` is answered only once `release()` is
  // called: a test can stop whoever asked while the server still owes the answer.
  // `archived`: a thread/archive with no thread/unarchive after it (the thread's history hidden from sessions).
  const state = { threadId: '', loaded: true, archived: false, open: 0, hold: null as string | null,
    requests: [] as Array<{ method: string; params?: Record<string, unknown> }> }
  const held: Array<() => void> = []
  server.on('connection', socket => {
    state.open++
    socket.on('close', () => { state.open-- })
    socket.on('message', bytes => {
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
      else if (frame.method === 'thread/archive') { state.loaded = false; state.archived = true }
      else if (frame.method === 'thread/unarchive') state.archived = false
      const answer = () => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ id: frame.id, result })) }
      if (frame.method === state.hold) held.push(answer)
      else answer()
    })
  })
  return { state, release() { state.hold = null; for (const answer of held.splice(0)) answer() }, async close() {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  } }
}
