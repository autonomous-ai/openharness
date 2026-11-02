/**
 * `fetch` for a plugin's post to the daemon, as a named function in its source. Any account can bind the TCP port while the daemon restarts,
 * and would hear the hook token and read or answer what is posted (audit H1). So where a socket can be, the post goes over it, and only if it
 * is this account's, owner only, in a folder nobody else can write to; otherwise it fails, and nothing goes to the port. `socket` is null only
 * where the daemon can have none: Windows, or a home too long as well. `node:http` because OpenCode's runtime and Node both have it.
 */
export function pluginFetchSource(name: string, socket: string | null): string {
  return `
  const ${name} = async (url, init) => {
    const socket = ${JSON.stringify(socket)}
    if (!socket) return fetch(url, init)
    const { lstatSync } = await import("node:fs")
    const { dirname } = await import("node:path")
    const { request } = await import("node:http")
    const { Readable } = await import("node:stream")
    const uid = process.getuid?.()
    const file = lstatSync(socket), folder = lstatSync(dirname(socket))
    if (!file.isSocket() || (file.mode & 0o077) !== 0 || !folder.isDirectory() || (folder.mode & 0o022) !== 0
      || (uid !== undefined && (file.uid !== uid || folder.uid !== uid))) throw new Error("The Harness socket is not private.")
    return new Promise((resolve, reject) => {
      const asked = request({ socketPath: socket, method: init.method, path: new URL(url).pathname, signal: init.signal,
        headers: { ...init.headers, "content-length": String(Buffer.byteLength(init.body)) } }, (answer) => {
        resolve(new Response(Readable.toWeb(answer), { status: answer.statusCode }))
      })
      asked.on("error", reject)
      asked.end(init.body)
    })
  }
`
}
