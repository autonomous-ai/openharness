/** Native launch keeps its authority; setup replies are bounded observations, never dispatch commands. */
import type { NativeInstallation } from './nativeInstall.js'
import type { NativeSetup, NativeProbeOutput } from './nativeSetup.js'
import { boundedHookInput, hookCandidate } from './nativeHookWire.js'
import { boundedTrustInput } from './nativeTrustWire.js'
import { noteMissingHookScript } from './hookScript.js'

type Payload = Record<string, unknown>
const held = (): NativeInstallation => ({ complete: false, detail: 'Waiting for engine setup.' })
const record = (value: unknown): value is Payload => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, limit = 4096): value is string => typeof value === 'string' && value.length <= limit && !value.includes('\0')
const installation = (value: unknown): NativeInstallation => {
  if (record(value) && value.complete === true) return { complete: true }
  if (!record(value) || value.complete !== false || !text(value.detail, 2000)
    || value.running !== undefined && value.running !== true || value.failed !== undefined && value.failed !== true
    || value.running && value.failed) return held()
  return { complete: false, detail: value.detail, ...(value.running ? { running: true } : {}), ...(value.failed ? { failed: true } : {}) }
}

export function createNativeSetupLink(call: (type: string, payload: Payload, waitMs?: number) => Promise<Payload>): NativeSetup {
  return {
    async prepareTrust(input, request, current) {
      if (!current() || !boundedTrustInput(input)) return null
      const captured = { ...input, files: input.files.map(file => ({ ...file })) }
      const deadline = performance.now() + 5000
      const answer = await call('setup_trust_prepare', { request, ...captured }, 5000)
      if (!text(answer.preparation, 128) || !answer.preparation) return null
      const allowed = current()
      const remaining = Math.floor(deadline - performance.now())
      if (remaining <= 0) return null
      const result = await call('setup_trust_commit', { preparation: answer.preparation,
        engine: captured.engine, request, allowed }, remaining)
      return allowed && current() && performance.now() < deadline ? hookCandidate(result.files, captured.files.length, result) : null
    },
    async prepareFiles(input, request, current) {
      if (!current() || !boundedHookInput(input)) return null
      const captured = { ...input, environment: { ...input.environment }, files: input.files.map(file => ({ ...file })) }
      const answer = await call('setup_files_prepare', { request, ...captured })
      if (answer.error === 'HOOK_SCRIPT_MISSING' && current()) {
        noteMissingHookScript(captured.engine)
        console.warn('[hooks] HOOK_SCRIPT_MISSING')
      }
      if (!text(answer.preparation, 128) || !answer.preparation) return null
      const allowed = current()
      const result = await call('setup_files_commit', { preparation: answer.preparation,
        engine: captured.engine, request, allowed })
      return allowed && current() ? hookCandidate(result.files, captured.files.length, result) : null
    },
    async probe(executable, kind, environment) {
      if (!executable.current()) return null
      const { output } = await call('setup_probe', { command: executable.command, identity: executable.identity, kind, environment })
      return executable.current() && record(output) && Number.isInteger(output.code)
        && text(output.stdout, 65_536) && text(output.stderr, 65_536)
        ? { code: output.code as number, stdout: output.stdout, stderr: output.stderr } satisfies NativeProbeOutput : null
    },
    async opencodeMajor() {
      const { major } = await call('setup_version', { engine: 'opencode' })
      return Number.isSafeInteger(major) && (major as number) >= 0 ? major as number : null
    },
    async hermesKeepsRecord(executable, environment) {
      const { keepsRecord } = await call('setup_version', { engine: 'hermes', command: executable?.command, environment })
      return typeof keepsRecord === 'boolean' ? keepsRecord : null
    },
    async downloading(engine) { return (await call('setup_download', { engine })).downloading === true },
    installations: {
      async ensure(engine, _recipe, environment, request, current) {
        if (!current()) return held()
        const answer = await call('setup_prepare', { engine, environment, request })
        if (!text(answer.preparation, 128) || !answer.preparation) return current() ? installation(answer.installation) : held()
        // This send authorizes installation. Cancellation after it still fences the eventual agent launch.
        const allowed = current()
        const result = await call('setup_commit', { preparation: answer.preparation, engine, request, allowed })
        return allowed && current() ? installation(result.installation) : held()
      },
      async status(engine, request, current) {
        if (!current()) return held()
        const answer = await call('setup_status', { engine, request })
        return !current() ? held() : answer.installation === null ? null : installation(answer.installation)
      },
    },
  }
}
