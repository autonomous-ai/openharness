/** Fixture composition: real native preparation with explicitly local probes and bounded file rendering. */
import { inspectNativeLaunch as inspect } from '../engines/nativeLaunch.js'
import { nativeSetupProbes } from '../services/nativeSetup.js'
import type { NativeSetup, NativeSetupProbes } from '../engines/kit/nativeSetup.js'

const setup: NativeSetupProbes & Pick<NativeSetup, 'prepareFiles'> = {
  ...nativeSetupProbes,
  prepareFiles: async (input, _request, current) => 'purpose' in input
    ? (await import('../services/nativeLaunchSettings.js')).prepareNativeLaunchSettings(input, current)
    : (await import('../services/nativeSetupFiles.js')).prepareNativeHookFiles(input, current),
}

export const inspectNativeLaunch: typeof inspect = (engine, source, deps) =>
  inspect(engine, source, { setup, ...deps })
