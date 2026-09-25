/**
 * One namespaced name per matrix run, stamped identically on the trace, the watchdog session and
 * the report, so every artifact of a run is grep-able and the audit answers: what version of which
 * coding-agent, which test, which grid model, when.
 *
 * Convention: `<engine>@<version>-><testcase>@<grid-model>--<timestamp>`
 * e.g. `codex@0.156.0->grid-switch@grid-gpt-5-mini--20260921T1805Z`
 */
export function sessionName(opts: {
  engine: string
  version: string
  testcase: string
  gridModel?: string
  at?: Date
}): string {
  const model = opts.gridModel && opts.gridModel.trim() ? sanitize(opts.gridModel) : 'none'
  const ts = (opts.at ?? new Date())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  return `${opts.engine}@${sanitize(opts.version)}->${sanitize(opts.testcase)}@${model}--${ts}`
}

function sanitize(v: string): string {
  return v.replace(/[^A-Za-z0-9._@-]/g, '-')
}

/**
 * The agent's working folder, named after the session but with nothing a tool might reinterpret.
 *
 * The session name carries `->` and `@` (readable, grep-able, and fine as a bundle folder), and it
 * used to be the agent's cwd too. claude 2.1.274 turns the `->` in that path into `-` when it builds a
 * Write path, so its files landed in a sibling folder that does not exist for anyone else — every
 * write step failed as "out/hello-1.txt does not exist" with the file sitting next door (grid-dev,
 * 2026-09-25; 2.1.273 did not). A person's project folder does not look like that, so the agent's
 * does not either: letters, digits, `.`, `_` and `-` only.
 */
export function workspaceDirName(session: string): string {
  return session.replace(/->/g, '_to_').replace(/[^A-Za-z0-9._-]/g, '-')
}
