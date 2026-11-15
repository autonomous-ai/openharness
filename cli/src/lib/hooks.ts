/** Explicit inline compatibility for callers outside the supervised core. */
import * as hooks from '../engines/nativeHooks.js'
import { nativeSetupProbes } from '../services/nativeSetup.js'
export { installGrokHooks, installAgyHooks, installCopilotHooks, installCursorHooks,
  installCommandCodeHooks, installDevinHooks, installKiloPlugin, installPiExtension, installAmpPlugin,
  hermesRecordSeen } from '../engines/nativeHooks.js'
export const installHermesHooks: typeof hooks.installHermesHooks = (port, home, options, platform) =>
  hooks.installHermesHooks(port, home, { setup: nativeSetupProbes, ...options }, platform)
export const installOpencodePlugin: typeof hooks.installOpencodePlugin = (port, snapshot, options) =>
  hooks.installOpencodePlugin(port, snapshot, { setup: nativeSetupProbes, ...options })
