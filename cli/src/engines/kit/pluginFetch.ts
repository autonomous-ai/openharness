// Plain text and nothing else: an engine's contract imports this, and contracts load no other code (architecture.spec.ts).

/**
 * `fetch` for a plugin's one post to the daemon. Any account can bind the TCP port while the daemon restarts, and would hear the hook token
 * and the session in it (audit H1), so where a socket can be the post goes over it, and only if it is this account's, owner only, in a folder
 * nobody else can write to. Otherwise it fails as a post does, and nothing goes to the port. `node:http` because a plugin's runtime (Bun, Node)
 * has it, where `fetch`'s socket option is Bun's alone.
 */
export const PLUGIN_FETCH = [
`const harnessSocket = `,
{ argument: 'socket' },
`
const harnessFetch = async (url, init) => {
  if (!harnessSocket) return fetch(url, init)
  const { lstatSync } = await import("node:fs")
  const { dirname } = await import("node:path")
  const { request } = await import("node:http")
  const uid = process.getuid?.()
  const file = lstatSync(harnessSocket), folder = lstatSync(dirname(harnessSocket))
  if (!file.isSocket() || (file.mode & 0o077) !== 0 || !folder.isDirectory() || (folder.mode & 0o022) !== 0
    || (uid !== undefined && (file.uid !== uid || folder.uid !== uid))) throw new Error("The Harness socket is not private.")
  return new Promise((resolve, reject) => {
    const asked = request({ socketPath: harnessSocket, method: init.method, path: new URL(url).pathname,
      headers: { ...init.headers, "content-length": String(Buffer.byteLength(init.body)) } }, (answer) => {
      answer.resume()
      answer.on("end", () => resolve({ ok: answer.statusCode >= 200 && answer.statusCode < 300, status: answer.statusCode }))
      answer.on("error", reject)
    })
    asked.on("error", reject)
    asked.end(init.body)
  })
}
`,
] as const
