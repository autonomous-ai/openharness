// Merge ONE key into the GCS metadata.json (download-merge-reupload), leaving other keys (e.g. the
// device `commander` entry) untouched. Paths/values come via argv so no stdin/pipe is claimed.
// The inbox triple is optional so a caller with no inbox.mjs writes the entry as before; a partial one
// is a caller bug, refused before anything is written
// (docs/plans/2026-11-27-windows-follower-ram-design.md section 4).
import { readFileSync, writeFileSync } from 'fs'

const args = process.argv.slice(2)
if (args.length !== 10 && args.length !== 13) {
  process.stderr.write(
    'usage: merge-manifest.mjs <src> <dst> <key> <version> <cliUrl> <cliSha> <cliSize> ' +
      '<notifyUrl> <notifySha> <notifySize> [<inboxUrl> <inboxSha> <inboxSize>]\n',
  )
  process.exit(2)
}
const [src, dst, key, version, cliUrl, cliSha, cliSize, notifyUrl, notifySha, notifySize, inboxUrl, inboxSha, inboxSize] =
  args

let data = {}
try {
  const raw = readFileSync(src, 'utf8')
  data = raw.trim() ? JSON.parse(raw) : {}
} catch {
  data = {}
}
if (typeof data !== 'object' || data === null || Array.isArray(data)) data = {}

data[key] = {
  version,
  cli: { url: cliUrl, sha256: cliSha, size: Number(cliSize) },
  notify: { url: notifyUrl, sha256: notifySha, size: Number(notifySize) },
  ...(inboxUrl === undefined ? {} : { inbox: { url: inboxUrl, sha256: inboxSha, size: Number(inboxSize) } }),
}

writeFileSync(dst, JSON.stringify(data, null, 2) + '\n')
