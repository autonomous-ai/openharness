/**
 * Another program's Unix socket, as the devices process reaches it: its lines, its stamp and the watch on where it lives.
 * One file, as two programs' sockets (herdr's, and Herdr Core's) are reached the same way, and a second copy would be a
 * second way.
 *
 * Nothing here parses a line or logs: what a line means is its client's, and a socket's lines name people's folders.
 */
import { lstatSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { ownWindowsPath } from '../../devices/dialSkill.js'
import { watchNearest } from './folderWatch.js'

/** Why a connection ended: it never opened, it closed, or a line was past its bound. */
export type LineEnd = 'refused' | 'ended' | 'oversize'
/** Why a client's connection gave no answer, or its subscription ended: the word its log line says, one set for both
 *  clients (herdrClient.ts, hcClient.ts) and their sources' attempts (socketAttempts.ts). `rejected` is the program's own
 *  refusal. */
export type SocketFault = LineEnd | 'no_socket' | 'timeout' | 'bad_json' | 'bad_answer' | 'rejected'

/**
 * One connection that writes `out` once connected, and tells each line that comes back, in order, until the socket is
 * destroyed. `end` is told once, with why it ended: a line past `maxLineBytes` as soon as it is past, before the rest
 * is read; a connection that never opened; one that closed. Unref'd, as each deadline is: another program's connection
 * never keeps the devices process up.
 */
export function connectLines(
  path: string, out: string, maxLineBytes: number, line: (text: string) => void, end: (fault: LineEnd) => void,
): Socket {
  let opened = false
  let held: Buffer[] = []
  let size = 0
  let ended = false
  // An oversize line is told at once, and the close that follows it would tell a second end.
  const finish = (fault: LineEnd) => {
    if (ended) return
    ended = true
    end(fault)
  }
  const socket = createConnection({ path })
  socket.unref()
  socket.on('connect', () => {
    opened = true
    socket.write(out)
  })
  // The close that follows says it.
  socket.on('error', () => {})
  socket.on('close', () => finish(opened ? 'ended' : 'refused'))
  socket.on('data', (chunk: Buffer) => {
    let from = 0
    while (!socket.destroyed) {
      const newline = chunk.indexOf(0x0a, from)
      const piece = chunk.subarray(from, newline === -1 ? chunk.length : newline)
      size += piece.length
      if (size > maxLineBytes) return finish('oversize')
      held.push(piece)
      if (newline === -1) return
      const text = Buffer.concat(held).toString('utf8')
      held = []
      size = 0
      from = newline + 1
      line(text)
    }
  })
  return socket
}

/** The socket's inode and change time, `<inode>:<ctime in ns>`, while it is a socket of that user's; else none. A
 *  program that starts again replaces its socket, so the stamp changes with it. */
export function socketStampOf(path: string, uid: number): string | undefined {
  try {
    const file = lstatSync(path, { bigint: true })
    return file.isSocket() && file.uid === BigInt(uid) ? `${file.ino}:${file.ctimeNs}` : undefined
  } catch {
    return undefined
  }
}

/** A marker file's inode and write time, `<inode>:<mtime in ns>`, while it is a file of this account's on Windows
 *  (ownWindowsPath); else none. herdr there writes it where its socket would be, once its pipe listens, and writes it
 *  again when it starts again. The write time, not the change time: on Windows a file's change time moves when its
 *  last handle closes (docs/windows-rules.md §3), so one herdr's marker could read as two. */
export function markerStampOf(path: string, roots?: readonly string[]): string | undefined {
  if (ownWindowsPath(path, 'file', roots) !== 'ok') return undefined
  try {
    const file = lstatSync(path, { bigint: true })
    return `${file.ino}:${file.mtimeNs}`
  } catch {
    return undefined
  }
}

/** Calls `changed` on each change in the nearest existing folder of the socket's folder, its parent and `home`, with
 *  the name of what changed (folderWatch.ts): cmuxSource.ts, which watches cmux's stores' folder through a path in it,
 *  reads only the store that changed. */
export function watchSocket(
  where: { socketPath: string; home: string }, changed: (file?: string) => void,
): () => void {
  return watchNearest([dirname(where.socketPath), dirname(dirname(where.socketPath)), where.home], changed)
}
