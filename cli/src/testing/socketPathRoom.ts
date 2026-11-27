import { join } from 'node:path'

/** The bytes a daemon's Unix socket path may take: `MAX_SOCKET_PATH_BYTES` in lib/localSocket.ts, which product code
 *  does not export. socketPathRoom.spec.ts holds the two together through the product's `socketPathIn`. */
export const SOCKET_PATH_ROOM = 96

/** The data folder's socket of a daemon the harness starts under `tmp`, at the longest port: the path that must fit
 *  (e2e/harness/daemon.ts). */
export function suiteSocketPath(tmp: string): string {
  return join(tmp, 'htmux-XXXXXX', 'data', 'daemon-65535.sock')
}

/** A socket path that does not fit falls back to a short folder under the test's home, which is under the same root
 *  and too long as well, so the test failed later with `EINVAL connect` and no word of why. This says why, at once. */
export function assertSocketPathFits(path: string): void {
  const bytes = Buffer.byteLength(path)
  if (bytes > SOCKET_PATH_ROOM) {
    throw new Error(`TMPDIR is too long for the daemon's Unix socket: ${path} would be ${bytes} bytes; a socket path has room for ${SOCKET_PATH_ROOM}. Run with a shorter TMPDIR, for example TMPDIR=/tmp npm run test:e2e.`)
  }
}
