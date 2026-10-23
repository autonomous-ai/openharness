/**
 * The last line of the block `harness status` and `harness start` print, from its status row. It said "running in
 * background · stop with: harness stop" under `○ stopped` too, on every platform, and a check that looked for the
 * word "running" passed against a stopped daemon (the Windows install job, B5.12, on the VM).
 * - `●` (running, started, starting) and `◍` (a master that is up: restarting its core, or in safe mode): how to stop it.
 * - `○ stopped`: how to start it.
 * - Anything else (`◌ out of reach`, from inside a sandbox): nothing, since what runs is not known.
 */
export function infoBlockFooter(status: string): string | null {
  if (status.startsWith('●') || status.startsWith('◍')) return '  running in background · stop with: harness stop'
  if (status.startsWith('○')) return '  start with: harness start'
  return null
}
