/**
 * The suite's first global setup (vitest.e2e.config.ts): a TMPDIR too long for a daemon's Unix socket stops the run
 * before any test and before the bundle is built, saying so, rather than every test failing later on `EINVAL connect`.
 * It measures the real path, as the test roots are (src/testing/isolatedTmux.ts): macOS's `/var` is `/private/var`.
 */
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { assertSocketPathFits, suiteSocketPath } from '../../src/testing/socketPathRoom.js'

export default function setup(): void {
  assertSocketPathFits(suiteSocketPath(realpathSync(tmpdir())))
}
