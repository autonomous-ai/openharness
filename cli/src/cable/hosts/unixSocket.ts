/**
 * Another program's Unix socket, as the devices process reaches it: its lines, its stamp and the watch on where it lives.
 * One file, as two programs' sockets (herdr's, and Herdr Core's) are reached the same way, and a second copy would be a
 * second way.
 *
 * Nothing here parses a line or logs: what a line means is its client's, and a socket's lines name people's folders.
 */
import { existsSync, lstatSync, watch, type FSWatcher } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { dirname } from 'node:path'

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

/** Calls `changed` on each change in the nearest existing folder of the socket's folder, its parent and `home`, moving
 *  to a nearer one as it appears, and out of one that is removed. `file` is the name the OS gave for what changed in the
 *  folder held, none when it gave none: cmux's stores sit beside its socket, and cmuxSource.ts reads only the one that
 *  changed. Returns its stop. Never throws: a watch that cannot be held tells nothing. */
export function watchSocket(
  where: { socketPath: string; home: string }, changed: (file?: string) => void,
): () => void {
  const folders = [dirname(where.socketPath), dirname(dirname(where.socketPath)), where.home]
  let held: { watcher: FSWatcher; at: number } | undefined
  const hold = () => {
    // inotify ends the watch of a folder that is removed, so a program that made it again would never be seen.
    if (held && !existsSync(folders[held.at])) {
      held.watcher.close()
      held = undefined
    }
    for (let at = 0; at < (held?.at ?? folders.length); at++) {
      let watcher: FSWatcher
      try {
        watcher = watch(folders[at], { persistent: false }, (_event, file) => {
          hold()
          changed(file ?? undefined)
        })
      } catch {
        continue
      }
      // A watch that fails tells nothing more, and throws nothing into the devices process. Its folder gone, it moves out.
      watcher.on('error', () => {
        watcher.close()
        hold()
      })
      held?.watcher.close()
      held = { watcher, at }
      return
    }
  }
  hold()
  return () => {
    held?.watcher.close()
    held = undefined
  }
}
