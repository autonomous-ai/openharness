/**
 * The apps a Linux desktop names for link schemes, as `xdg-mime` answers: on Linux a link opens only once its scheme has
 * an app (cable/hosts/appLink.ts). A fake in the daemon's own bin, first on its PATH, in place of the harness's xdg-mime
 * that names none (harness/daemon.ts): the computer's own handlers are never asked, and the open stays the fake's.
 */
import { join } from 'node:path'
import { writeExecutable } from '../../src/testing/executableFixture.js'
import type { IsolatedDaemon } from './daemon.js'

/** A scheme or a desktop entry's file name that needs no quoting in a shell's `case`. */
const PLAIN = /^[A-Za-z0-9._-]+$/

/** [apps]: each scheme's `.desktop`. Any other question, or another scheme, prints nothing. */
export function writeSchemeApps(d: IsolatedDaemon, apps: Record<string, string>): void {
  const cases = Object.entries(apps).map(([scheme, desktop]) => {
    if (!PLAIN.test(scheme) || !PLAIN.test(desktop)) throw new Error(`not a plain scheme or desktop file: ${scheme} ${desktop}`)
    return `  "query default x-scheme-handler/${scheme}") echo ${desktop} ;;\n`
  })
  writeExecutable(join(d.binDir, 'xdg-mime'), `#!/bin/sh\ncase "$*" in\n${cases.join('')}esac\n`)
}
