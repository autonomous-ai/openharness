/** The portable harness ABI is files + a shell, not an engine's plugin format.
 * Each adapter names the project instruction files its engine actually reads, in precedence order.
 * Skills and executable tools are exposed through the session's context, so native skill/MCP
 * support is an optional optimization rather than a condition for running a harness.
 * Contracts and primary sources: store/spec/portability.md.
 */
import type { AgentEngine, ProcessEngine } from '../engines/types.js'

export interface HarnessAdapter {
  instructionFiles: readonly string[]
  /** A session-local instruction flag, when the engine provides one. */
  contextArgs?: (contextFile: string) => string[]
}

export const HARNESS_ADAPTERS = {
  claude: { instructionFiles: ['CLAUDE.md'], contextArgs: (file: string) => ['--append-system-prompt', `Read the harness context at ${JSON.stringify(file)} before working.`] },
  codex: { instructionFiles: ['AGENTS.override.md', 'AGENTS.md'] },
  cursor: { instructionFiles: ['AGENTS.md'] },
  opencode: { instructionFiles: ['AGENTS.md', 'CLAUDE.md'] },
  pi: { instructionFiles: ['AGENTS.md', 'CLAUDE.md'], contextArgs: (file: string) => ['--append-system-prompt', file] },
  hermes: { instructionFiles: ['.hermes.md', 'AGENTS.md', 'CLAUDE.md', '.cursorrules'] },
  commandcode: { instructionFiles: ['AGENTS.md'] },
  devin: { instructionFiles: ['AGENTS.md'] },
  muse: { instructionFiles: ['AGENTS.md', 'CLAUDE.md'] },
  amp: { instructionFiles: ['AGENTS.md'] },
  kilo: { instructionFiles: ['AGENTS.md'] },
  grok: { instructionFiles: ['AGENTS.md'] },
  agy: { instructionFiles: ['AGENTS.md', 'GEMINI.md'] },
  copilot: { instructionFiles: ['AGENTS.md'] },
} satisfies Record<ProcessEngine, HarnessAdapter>

/** A terminal has no instruction loader or agent tools. It remains a Coding-only choice. */
export function harnessAdapter(engine: AgentEngine): HarnessAdapter {
  if (engine === 'terminal') throw new Error('A harness needs an agent engine; Terminal cannot run harness instructions.')
  return HARNESS_ADAPTERS[engine]
}

export const HARNESS_BOOTSTRAP = `<!-- harness:runtime v1 -->
## Harness session context

If HARNESS_CONTEXT_FILE is set in your environment, read that file before working:

\`\`\`sh
if [ -n "$HARNESS_CONTEXT_FILE" ]; then cat "$HARNESS_CONTEXT_FILE"; fi
\`\`\`

It contains the instructions and skill index for this session's selected harness.
If the variable is absent, this is an ordinary coding session with no selected harness.
<!-- /harness:runtime -->
`
