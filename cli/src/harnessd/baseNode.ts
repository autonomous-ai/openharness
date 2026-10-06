import { dirname, join, sep } from 'node:path'
/** The managed node behind a name link (./processName.ts): `<runtime>/node-…/libexec/harnessd/<name>` → its `bin/node`; any other path is itself. Its own file: the core loads only this. */
export function baseNode(path: string): string {
  return dirname(path).endsWith(`${sep}libexec${sep}harnessd`) ? join(dirname(dirname(dirname(path))), 'bin', 'node') : path
}
