/**
 * Which generation of OpenCode is installed, read from the binary itself.
 *
 * The two generations take different command lines and keep sessions in different places, and a v1
 * command line kills a v2 pane: 2.0's TUI accepts only `--standalone --server --auto -c -s --prompt`
 * and exits 1 on anything else (`Unrecognized flag: -m in command opencode`). `-m` and `--agent` live
 * on `opencode run` now. So every launch that hands the TUI a flag asks this first.
 *
 * Read once per installed file, not once per daemon: OpenCode updates itself in place, and 1.18 → 2.0
 * arrived that way, under a running daemon. The file's size and mtime key the cache, so the next
 * launch after an update asks again and every other launch costs a `stat`.
 *
 * Unknown (not installed, or an answer that is not a version) is `null`, and every caller treats it as
 * v1 — the behaviour it had before this module existed.
 */

import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { opencodeBin } from '../../lib/engineBin.js'
import { resolveBinaryOnPath } from '../../lib/binaryOnPath.js'

/** The first major whose TUI rejects `-m` / `--agent` and whose sessions live behind its API. */
const OPENCODE_V2_MAJOR = 2

/** The major in what `opencode --version` prints: `opencode v2.0.18` on v2, a bare `1.18.31` on v1. */
export function parseOpencodeMajor(output: string): number | null {
  const match = /(\d+)\.\d+\.\d+/.exec(output)
  return match ? Number(match[1]) : null
}

export function isOpencodeV2(major: number | null | undefined): boolean {
  return (major ?? 0) >= OPENCODE_V2_MAJOR
}

/** How the version is read. A seam so the cache can be specified without a binary. */
export interface OpencodeVersionProbe {
  /** Something that changes when the installed file does, or null when it cannot be found. */
  identity: () => string | null
  /** What `--version` prints. Throws when the binary will not answer. */
  read: () => string
}

const realProbe: OpencodeVersionProbe = {
  identity: () => {
    const bin = opencodeBin()
    const path = bin.includes('/') ? bin : resolveBinaryOnPath(bin)
    if (!path) return null
    try {
      const stat = statSync(path)
      return `${path}:${stat.size}:${stat.mtimeMs}`
    } catch {
      return null
    }
  },
  // Bounded: this runs on the daemon's thread, once per installed file. 2.0.18 answers in ~50ms.
  read: () => execFileSync(opencodeBin(), ['--version'], {
    encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'],
  }),
}

const cache = new Map<string, number | null>()

/** The installed OpenCode's major version, or null when it cannot be read. Never throws. */
export function opencodeMajorVersion(
  probe: OpencodeVersionProbe = realProbe,
  memo: Map<string, number | null> = cache,
): number | null {
  const identity = probe.identity()
  // No file to key on: nothing is installed where this daemon can see it, so nothing is cached — the
  // pane may install it, and the next launch should find out what it got.
  if (identity !== null && memo.has(identity)) return memo.get(identity) ?? null
  let major: number | null
  try {
    major = parseOpencodeMajor(probe.read())
  } catch {
    major = null
  }
  if (identity !== null) memo.set(identity, major)
  return major
}
