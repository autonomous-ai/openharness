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
