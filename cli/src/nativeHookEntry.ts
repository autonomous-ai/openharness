/** Build this entry into one standalone notify.mjs for every distribution. */
import { runNotify } from '../hook/notify.mjs'
import { createNativeNotifyCursor, nativeNotifyRuntime } from './engines/kit/nativeNotifyCursor.js'
import type { ProcessImageArtifact } from './lib/nativeProcessImageArtifact.js'
import { writeNativeRearmWitness } from './engines/kit/nativeRearmWitness.js'

declare const __DARWIN_PROCESS_IMAGES__: string | undefined
const selfPid = process.pid
const source = typeof __DARWIN_PROCESS_IMAGES__ === 'undefined' ? undefined : __DARWIN_PROCESS_IMAGES__
let artifact: ProcessImageArtifact | undefined
try { if (source) artifact = JSON.parse(source) as ProcessImageArtifact } catch { /* Missing evidence holds the client. */ }
if (process.argv[2] === '--native-rearm-witness') {
  // An interrupted writer, missing argument or rejected promise starts held.
  // Ordinary hook no-op success must never authorize this separate protocol.
  process.exitCode = 75
  void writeNativeRearmWitness(process.argv[3], process.argv[4], { selfPid, artifact }).then(allowed => {
    if (allowed) process.exitCode = 0
  }).catch(error => {
    const reason = error instanceof Error ? error.message.replace(/[\r\n]/g, ' ').slice(0, 500) : 'Evidence is unavailable.'
    process.stderr.write(`Waiting for the original native relaunch evidence: ${reason}\n`)
  })
} else {
  void runNotify({ nativeCursor: createNativeNotifyCursor({ selfPid, artifact }), captureNativeRuntime: nativeNotifyRuntime })
}
