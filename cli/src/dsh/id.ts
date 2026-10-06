/**
 * A domain-specific harness's id, `<owner>/<name>`.
 *
 * Apart from the manifest (./manifest.ts), which holds the zod schemas and builds them as it loads: the
 * registry checks ids, and every process that reads the registry (the core, and the search and
 * workspaces services in their own processes) would otherwise load and build those schemas too, about
 * 8 MiB each, to read one pattern (measured 2026-10-05).
 */
export const DSH_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/
