// A stream over a dial's port that never opens the port again, by its name or any other way.
//
// `tty.ReadStream` hands its descriptor to libuv's uv_tty_init, which reopens a terminal by name with a
// plain, blocking open() so as to set non-blocking mode on a description of its own. A pseudo-terminal
// whose far end has gone blocks that open until something opens the far end again, which nothing will.
// SerialLink.open refuses a port that is already gone (its probe), but the far end can go between the
// probe and the reopen: measured 2026-10-06, a fake dial unplugged within 150 ms of its plug held the
// devices' process in that open for 40 s, 2 times in 22 daemons under load, until the master killed the
// process as hung and the other dial with it (sampled: TTYWrap::New → uv_tty_init → uv__open_cloexec →
// open). The probe cannot close that window: the far end is another process, or the USB bus.
//
// A pipe handle opened on the descriptor (uv_pipe_open) takes it as it is, with the same readiness as a
// terminal's (kqueue, or on macOS libuv's select thread when kqueue cannot watch it, uv__stream_try_select,
// which uv_tty_init uses too), and opens nothing. The descriptor is SerialLink's own, opened non-blocking for
// this, so the reason libuv reopens a terminal, not to change the mode of one it shares with another
// process, does not apply here.
//
// The pipe handle's constructor is Node's own (`process.binding('pipe_wrap')`, the one net.Socket uses; its
// deprecation, DEP0111, is documentation-only). A Node without it gets the terminal stream, as before.
import { Socket } from 'node:net'
import { ReadStream } from 'node:tty'
import { getSystemErrorName } from 'node:util'

interface PipeHandle {
  open(fd: number): number
  close(): void
}

/** Node's pipe handle constructor, as net.Socket reaches it. */
export interface PipeWrap {
  Pipe: new (type: number) => PipeHandle
  constants: { SOCKET: number }
}

/** Node's pipe handle constructor, or null when this Node does not offer it. */
export function nodePipes(binding: (name: string) => unknown = (name) => (process as unknown as { binding(name: string): unknown }).binding(name)): PipeWrap | null {
  try {
    const wrap = binding('pipe_wrap') as Partial<PipeWrap> | undefined
    return typeof wrap?.Pipe === 'function' && typeof wrap.constants?.SOCKET === 'number' ? wrap as PipeWrap : null
  } catch {
    return null
  }
}

/** A duplex stream over `fd`, which it takes ownership of: closed when the stream is destroyed. */
export function portStream(fd: number, pipes: PipeWrap | null = nodePipes()): Socket {
  if (!pipes) return new ReadStream(fd, { readable: true, writable: true })
  const handle = new pipes.Pipe(pipes.constants.SOCKET)
  const failed = handle.open(fd)
  if (failed) {
    handle.close()
    const code = getSystemErrorName(failed)
    throw Object.assign(new Error(`the port cannot be read: ${code}`), { code })
  }
  return new Socket({ handle, readable: true, writable: true } as ConstructorParameters<typeof Socket>[0])
}
