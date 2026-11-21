import { request } from 'node:http'
import type { IsolatedDaemon } from './daemon.js'

/** The Claude mod's poll over the daemon's socket, as the mod sends it: its status and what it was answered (`null`
 *  when the answer is empty). [signal] ends a held poll. */
export function inboxPoll(d: IsolatedDaemon, sessionId: string, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: d.socketPath, path: '/api/hook/inbox', method: 'POST', headers: { 'Content-Type': 'application/json' }, signal },
      (res) => {
        let said = ''
        res.on('data', (chunk: Buffer) => { said += chunk.toString('utf8') })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: said ? JSON.parse(said) : null }))
      })
    req.on('error', reject)
    req.end(JSON.stringify({ sessionId }))
  })
}
