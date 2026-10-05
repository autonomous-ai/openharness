/** Bounded availability codes, safe to persist or expose instead of native/provider output. */
const reasons = [
  'companion_unopened', 'companion_stopped', 'companion_starting', 'companion_model_unavailable',
  'companion_connection_unavailable', 'companion_account_unavailable', 'companion_configuration_unsupported',
  'inference_context_changed', 'inference_provider_restricted',
  'claude_version_uncertified', 'codex_version_uncertified', 'opencode_version_uncertified',
] as const
export type InferenceWaitReason = typeof reasons[number]

export function inferenceWaitReason(value: unknown): InferenceWaitReason | undefined {
  return typeof value === 'string' && (reasons as readonly string[]).includes(value)
    ? value as InferenceWaitReason : undefined
}
