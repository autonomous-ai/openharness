/**
 * A host's instance name, one per build: `p<protocol>-<tag>` (pty/src/instance.rs). Two builds of one protocol run
 * side by side in one home, so the build is part of the name that keys the discovery file, lock, pane ids, socket,
 * pipe suffix, log and `HARNESS_PANE`. A host from before this (pre-G) is `p<protocol>`, in `pty-host-<protocol>.json`;
 * it is still found, as an instance of its own.
 */
import { createHash } from 'node:crypto'

/**
 * An instance, unanchored, for the patterns built on it. Hook scripts and engine plugins cannot import it and carry
 * it written out (hook/notify.mjs, engines/{kilo,opencode,pi}/contract.ts): change those with it.
 */
export const PTY_HOST_INSTANCE_SOURCE = String.raw`p\d{1,4}(?:-(?:[0-9A-Za-z.-]{1,32}|h[0-9a-f]{12}))?`
/** A pty host instance: a legacy `p<protocol>`, or `p<protocol>-<version or hash>`. */
export const PTY_HOST_INSTANCE = new RegExp(`^${PTY_HOST_INSTANCE_SOURCE}$`)
/** A pty host pane as its shell names itself: `HARNESS_PANE`, `<instance>:%N`. */
export const PTY_HOST_PANE = new RegExp(`^(${PTY_HOST_INSTANCE_SOURCE}):(%\\d{1,9})$`)

const PLAIN_TAG = /^[0-9A-Za-z.-]{1,32}$/
const LEGACY = /^p(\d{1,4})$/

/**
 * The instance a host of [protocol] built as [version] runs as: the version itself when it is safe in a file name, a
 * pipe name and a socket path, else `h` and the first 12 hex digits of its SHA-256 (build metadata, spaces, length).
 */
export function hostInstanceName(protocol: number, version: string): string {
  const tag = PLAIN_TAG.test(version) ? version : `h${createHash('sha256').update(version, 'utf8').digest('hex').slice(0, 12)}`
  return `p${protocol}-${tag}`
}

/** The protocol an instance is of, or null for anything that is not one. */
export function instanceProtocol(instance: string): number | null {
  return PTY_HOST_INSTANCE.test(instance) ? Number(/^p(\d+)/.exec(instance)![1]) : null
}

/**
 * The name of [instance]'s discovery file in `<home>/run/`, or null for anything that is not an instance (it is never
 * a path): a legacy `p<n>`'s is `pty-host-<n>.json`, as hosts from before instances wrote it.
 */
export function discoveryFileName(instance: string): string | null {
  if (!PTY_HOST_INSTANCE.test(instance)) return null
  const legacy = LEGACY.exec(instance)
  return `pty-host-${legacy ? legacy[1] : instance}.json`
}
