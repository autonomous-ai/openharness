// A client's version is self-declared (`?v=` on the adapter socket, `cliVersion`/`firmwareVersion` in a
// device hello), so it is never stored raw: anything outside a plain semver-ish token (or longer than 64
// chars) is dropped rather than stored.
const CLIENT_VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/

// The chip a Harness CLI says hello with. On such a row the version is a CLI's, never firmware
// (spec, 2026-11-27).
export const HARNESS_CLI_CHIP = 'harness-cli'

export function sanitizeClientVersion(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const v = raw.trim()
  return v && CLIENT_VERSION_RE.test(v) ? v : undefined
}
