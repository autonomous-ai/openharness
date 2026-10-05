/** Observed model availability, supplied by the application. No engine or memory implementation. */
export interface IntelligenceStatus {
  state: 'off' | 'unopened' | 'waiting' | 'unsupported' | 'ready'
  agentId?: string
  engine?: string
  model?: string
  effort?: string
  contextKey?: string
  reason?: string
}
