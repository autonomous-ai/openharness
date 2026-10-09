import { questionControl as claudeQuestionControl } from './claude/questionControl.js'
import { questionControl as codexQuestionControl } from './codex/questionControl.js'
import { screen as claudeScreen } from './claude/screen.js'
import { submission as claudeSubmission } from './claude/submission.js'
import { submission as codexSubmission } from './codex/submission.js'
import { nativeControl as codexNativeControl } from './codex/nativeControl.js'
import { modelControl as claudeModelControl } from './claude/modelControl.js'
import { modelControl as codexModelControl } from './codex/modelControl.js'
import { screen as codexScreen } from './codex/screen.js'
import type { Engine } from './engine.js'
import { engineLaunches } from './launches.js'
import { hookContracts } from './hooks.js'
import { transcript as claudeTranscript } from './claude/transcript.js'
import { transcript as codexTranscript } from './codex/transcript.js'
import { live as claudeLive } from './claude/live.js'
import { live as codexLive } from './codex/live.js'
import { runtime as claudeRuntime } from './claude/runtimeProfile.js'
import { runtime as codexRuntime } from './codex/runtimeProfile.js'

/** Only the migrated engines. Others keep their existing handlers until their own small batch. */
const engines = {
  claude: { name: 'claude', launch: engineLaunches.claude, transcript: claudeTranscript, hooks: hookContracts.claude, live: claudeLive, runtime: claudeRuntime, screen: claudeScreen, modelControl: claudeModelControl, questionControl: claudeQuestionControl, submission: claudeSubmission },
  codex: { name: 'codex', launch: engineLaunches.codex, transcript: codexTranscript, hooks: hookContracts.codex, live: codexLive, runtime: codexRuntime, screen: codexScreen, modelControl: codexModelControl, questionControl: codexQuestionControl, submission: codexSubmission, nativeControl: codexNativeControl },
} satisfies Record<string, Engine>
type MigratedEngine = keyof typeof engines
export function engineFor(name: string | null | undefined): Engine | undefined {
  return name && Object.hasOwn(engines, name) ? engines[name as MigratedEngine] : undefined
}
