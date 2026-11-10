/** The most one JSON frame on the daemon's local socket may be (localWsServer.ts): a window's, a tool's, the CLI's. A token-
 *  authenticated service may send up to the transport's own ceiling. */
export const LOCAL_JSON_MAX_BYTES = 512 * 1024

/** What a request past [LOCAL_JSON_MAX_BYTES] is told, by the CLI before it sends one, and when the daemon refused it. */
export const tooLargeText = (bytes: number): string =>
  `This request is ${Math.ceil(bytes / 1024)} KiB, and Harness takes at most ${LOCAL_JSON_MAX_BYTES / 1024} KiB in one: nothing was sent. `
  + 'Put the rest in a file and send its path.'
