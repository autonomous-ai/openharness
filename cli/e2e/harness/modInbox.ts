import { request } from 'node:http'
import type { IsolatedDaemon } from './daemon.js'

/** The Claude mod's poll over the daemon's socket, as the mod sends it: its status and what it was answered (`null`
 *  when the answer is empty). [signal] ends a held poll. An answer that is not JSON, or is cut short, fails the poll. */
export function inboxPoll(d: Pick<IsolatedDaemon, 'socketPath'>, sessionId: string, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: d.socketPath, path: '/api/hook/inbox', method: 'POST', headers: { 'Content-Type': 'application/json' }, signal },
      (res) => {
        let said = ''
        res.on('data', (chunk: Buffer) => { said += chunk.toString('utf8') })
        res.on('error', reject)
        // An answer cut short closes with no `end`.
        res.on('close', () => { if (!res.complete) reject(new Error("the daemon's inbox answer was cut short")) })
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, body: said ? JSON.parse(said) : null }) } catch (error) { reject(error) }
        })
      })
    req.on('error', reject)
    req.end(JSON.stringify({ sessionId }))
  })
}
