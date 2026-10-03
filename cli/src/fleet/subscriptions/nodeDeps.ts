// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

/** The real machine behind ProviderDeps and SubscriptionsDeps. Read-only except the daemon's own data dir. */
import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { READERS, type ProviderDeps } from './providers.js'
import type { SubscriptionsDeps } from './index.js'

export function nodeProviderDeps(): ProviderDeps {
  return {
    home: homedir(),
    platform: process.platform,
    env: process.env,
    now: () => Date.now(),
    readFile: async (p) => { try { return await fsp.readFile(p, 'utf8') } catch { return null } },
    readTail: async (p, bytes) => {
      let fh: fsp.FileHandle | null = null
      try {
        fh = await fsp.open(p, 'r')
        const { size } = await fh.stat()
        const len = Math.min(size, bytes)
        const buf = Buffer.alloc(len)
        await fh.read(buf, 0, len, size - len)
        return buf.toString('utf8')
      } catch { return null } finally { await fh?.close().catch(() => {}) }
    },
    listDir: async (p) => { try { return await fsp.readdir(p) } catch { return [] } },
    exists: async (p) => { try { await fsp.stat(p); return true } catch { return false } },
    fetchJson: async (url, headers, timeoutMs) => {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
      let body: unknown = null
      try { body = await res.json() } catch { body = null }
      return { status: res.status, body }
    },
    execFile: (cmd, args, timeoutMs) => new Promise((resolve) => {
      execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 256 * 1024 }, (err, stdout) => resolve(err ? null : stdout))
    }),
  }
}

export function nodeSubscriptionsDeps(dataDir: string): SubscriptionsDeps {
  return {
    dataDir,
    now: () => Date.now(),
    readers: READERS,
    providerDeps: nodeProviderDeps(),
    readFile: async (p) => { try { return await fsp.readFile(p, 'utf8') } catch { return null } },
    writeFile: async (p, d) => {
      const tmp = `${p}.${process.pid}.tmp`
      await fsp.writeFile(tmp, d, { mode: 0o600 })
      await fsp.rename(tmp, p)
    },
  }
}
