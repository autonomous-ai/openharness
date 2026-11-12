/**
 * One string setting of a YAML file an engine keeps (Hermes: `display.interface` of `<home>/config.yaml`), read
 * without trusting the file. It lives in the agent's home, which a sandbox controls: it may be a FIFO, a folder or
 * 10 MB. So it is opened without waiting for a writer, followed through a link as the engine reads its own config,
 * checked to be a regular file within the limit, and read no further than one byte past it. Nothing is ever written.
 * It names no engine.
 */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { parseDocument } from 'yaml'

// Windows has no such flag, and no FIFO in a folder for the open to wait on.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)

/** The string at `<section>.<key>` of the YAML mapping in [file], as written; null for anything else. Never throws. */
export async function readYamlSetting(file: string, section: string, key: string, maxBytes: number): Promise<string | null> {
  let text: string
  try {
    const handle = await open(file, READ_FLAGS)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > maxBytes) return null
      // One byte past the limit tells a file that grew since its fstat.
      const bytes = Buffer.alloc(maxBytes + 1)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      if (length > maxBytes) return null
      text = bytes.toString('utf8', 0, length)
    } finally {
      await handle.close().catch(() => {})
    }
  } catch {
    return null
  }
  // Read as the engines' YAML 1.1 readers (PyYAML's safe_load) read it: two equal keys are no error and the last
  // counts, aliases are followed and merge keys applied. An alias bomb trips toJS's own limit.
  const document = parseDocument(text, { uniqueKeys: false, prettyErrors: false, merge: true })
  if (document.errors.length > 0) return null
  let root: unknown
  try { root = document.toJS() } catch { return null }
  const settings = mapping(root) ? root[section] : undefined
  const value = mapping(settings) ? settings[key] : undefined
  return typeof value === 'string' ? value : null
}

function mapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
