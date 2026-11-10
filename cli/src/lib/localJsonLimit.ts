/** The most one JSON frame on the daemon's local socket may be (localWsServer.ts): a window's, a tool's, the CLI's. A token-
 *  authenticated service may send up to the transport's own ceiling. */
export const LOCAL_JSON_MAX_BYTES = 512 * 1024

const kib = (bytes: number): string => `${Math.ceil(bytes / 1024)} KiB`

/** What a request of [bytes] past [limit] is told when the CLI refuses it before sending: nothing was sent. */
export const tooLargeText = (bytes: number, limit = LOCAL_JSON_MAX_BYTES): string =>
  `This request is ${kib(bytes)}, and Harness takes at most ${kib(limit)} in one: nothing was sent. Put the rest in a file and send its path.`

/** What is told when the daemon refused a frame on a line and closed it (`frame_too_large`, or the transport's own 1009). The
 *  frame is not named, so what else waited on the line may have run: it is not said to have been refused. */
export function refusedLineText(payload: Record<string, unknown> | undefined): string {
  const bytes = Number(payload?.bytes), limit = Number(payload?.limit)
  const size = Number.isFinite(bytes) ? `was ${kib(bytes)}` : 'was too large'
  const most = Number.isFinite(limit) ? `takes at most ${kib(limit)} in one` : 'refused it'
  return `A request on this line ${size}, and Harness ${most}: it closed the line. What else waited on it may have run. Put the rest in a file and send its path.`
}
