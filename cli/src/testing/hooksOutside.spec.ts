import { expect, it } from 'vitest'

const { hooksOutside } = await import('../../e2e/harness/daemon.js' as string) as { hooksOutside: (log: string) => string[] }

// What a daemon under test says of each hook file it wrote, installed, updated or kept: its tag, then `(outside the
// home)` when the file is not under the daemon's own home (lib/log.ts fileTag). Its tags are made with a key of its own,
// which no test can make: only those fixed words say where a file is.
const start = '2026-11-21 12:01:17.686 [cli] daemon pid 1 · v0.0.1 · listening on 127.0.0.1:19473'
const lines = (where: string) => [
  `2026-11-21 12:01:17.786 [hooks] installed Claude Code session, turn, wait and subagent hooks → 93658264${where}`,
  `2026-11-21 12:01:17.787 [hooks] Codex session and turn hooks already installed → b7d6b309${where}`,
  `2026-11-21 12:01:17.788 [hooks] updated (path/port changed) → 0a1b2c3d --port 19473 in 9f8e7d6c${where}`,
  `2026-11-21 12:01:17.789 [hooks] recorded Harness's own Codex hooks as reviewed → config.toml${where}`,
  `2026-11-21 12:01:17.790 [hooks] installed Kilo discovery plugin → 6d7e8f90${where}`,
  `2026-11-21 12:01:17.791 [hooks] removed Harness's Hermes hooks → 1a2b3c4d${where}`,
  `2026-11-21 12:01:17.792 [hooks] Hermes session hooks already installed (5e6f7a8b${where})`,
]

it('a hook line that says its file is outside the home fails the check', () => {
  const outside = lines(' (outside the home)')
  expect(hooksOutside([start, ...outside, '2026-11-21 12:01:17.810 [cli] ready'].join('\n'))).toEqual(outside)
})

it('hook lines whose files are in the home pass, whatever the root holds', () => {
  expect(hooksOutside([start, ...lines(''), '2026-11-21 12:01:17.810 [cli] ready'].join('\n'))).toEqual([])
})

it('a hook line that names a path rather than a tag fails', () => {
  const named = '2026-11-21 12:01:18.000 [hooks] installed Codex session and turn hooks → /tmp/htmux-x/home/.codex/hooks.json'
  const unchanged = '2026-11-21 12:01:18.001 [hooks] Devin config file is invalid JSON; leaving it unchanged: /elsewhere/config.json'
  expect(hooksOutside([start, named, unchanged].join('\n'))).toEqual([named, unchanged])
})
