/** Shared vocabulary for extraction and explicit recall. Missing context is never guessed. */
export const MEMORY_CONTEXT_VERSION = 'coding-context-v1'
export const MEMORY_CONTEXT_GUIDE = `Use taskType for the activity (for example debugging, implementation, refactoring, review, testing, performance, design, architecture, documentation or operations). Use productionIncident with a boolean for whether this is a production incident. Do not use task, task_type or incident as synonyms for these keys. Use language, framework and environment for explicitly supported technology or environment constraints, preserving the source's spelling. Other precise condition keys are allowed when needed; they match exactly, not semantically. Include only conditions actually established by the source or current task. Missing is unknown, not false. An unconditional default uses {}. A project binding already restricts the repository; do not duplicate that identity or its general description as extra applicability keys. Search topics belong in retrievalCues, not invented applicability conditions.`

// Standard fields are guidance rather than a migration of existing condition keys. The store keeps
// its bounded extension map and exact, typed matching; no fuzzy aliasing broadens an old record.
export const MEMORY_RECALL_CONDITIONS_SCHEMA = {
  type: 'object', maxProperties: 24, description: MEMORY_CONTEXT_GUIDE,
  propertyNames: { pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$' },
  additionalProperties: { anyOf: [{ type: 'string', maxLength: 200 }, { type: 'number' }, { type: 'boolean' },
    { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', maxLength: 200 } }] },
}
