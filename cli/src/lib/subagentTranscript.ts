/**
 * A Claude subagent's transcript: `<session>/subagents/agent-*.jsonl`. Only the file's own folder is
 * checked, so a home under a folder named `subagents` does not refuse every transcript. Shared with
 * discovery without loading the handoff writer into the core (quiet-machine QA, handoff extraction).
 */
export function isSubagentTranscript(path: string): boolean {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length >= 2 && parts[parts.length - 2] === 'subagents'
}
