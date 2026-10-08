/** Engine-independent events delivered to the core and its consumers. */
export interface SubagentSummary {
  agentId?: string
  agentType?: string
  totalTokens?: number
  totalDurationMs?: number
  totalToolUseCount?: number
}

export type SessionEvent =
  | { type: 'user_message'; payload: { content: string; images?: Array<{ media_type: string; data: string }> } }
  | { type: 'thinking_delta'; payload: { content: string; thinkingId?: string } }
  | { type: 'thinking_title'; payload: { thinkingId?: string; title: string } }
  | { type: 'text_delta'; payload: { content: string } }
  | { type: 'tool_start'; payload: { id: string; tool: string; input: unknown; parentToolUseId?: string } }
  | { type: 'tool_end'; payload: { id: string; tool: string; output: string; isError: boolean; summary: string; parentToolUseId?: string; subagent?: SubagentSummary; durationSeconds?: number } }
  | { type: 'context_compact'; payload: { message: string; trigger?: string } }
  | { type: 'done'; payload: { result: string } }

/** Live-stream events: replay events + the derived turn lifecycle. */
export type LiveEvent =
  | SessionEvent
  | { type: 'turn_started'; payload: { userMessage: string } }
  | { type: 'turn_ended'; payload: { aborted?: true } }   // aborted = killed by an interrupt, no recap
  // An ASYNC sub-agent actually finished. `id` is the spawning tool_use id, so it pairs with the
  // `tool_start`/`tool_end` of the same sub-agent (see taskNotificationEvent).
  | { type: 'subagent_finished'; payload: { id: string; status: string; summary?: string } }

export interface LastTurnText {
  userMessage: string
  assistantText: string
}
