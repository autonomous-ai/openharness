/** Fixture composition: real native preparation with explicitly local, fixture-controlled probes. */
import { inspectNativeLaunch as inspect } from '../engines/nativeLaunch.js'
import { nativeSetupProbes } from '../services/nativeSetup.js'

export const inspectNativeLaunch: typeof inspect = (engine, source, deps) =>
  inspect(engine, source, { setup: nativeSetupProbes, ...deps })
