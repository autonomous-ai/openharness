// The panelists. Each seat is one headless run of a vendor's own CLI — never a Harness session, never
// a tile. The moderator is the only process that writes to the workspace, so every adapter here is
// read-only where its CLI can say so, and speaks to stdout (or to a file the CLI is told to write).
//
// Adding an engine is adding a row. `build()` returns the argv after the binary and where the final
// answer lands; nothing else in the room knows one vendor from another.

/** Vendors decorate their stdout. Strip the decoration, never the answer. */
export const stripAnsi = (text) => String(text ?? '')
  .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
  .replace(/\u001b\][^\u0007]*\u0007/g, '')

export const ADAPTERS = {
  claude: {
    label: 'Claude Code', vendor: 'Anthropic', bin: 'claude', icon: 'claude',
    readOnly: 'tools restricted to Read, Grep, Glob, WebSearch, WebFetch',
    build({ system, prompt, model }) {
      const args = ['-p', prompt, '--append-system-prompt', system, '--output-format', 'text',
        '--allowedTools', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']
      if (model) args.unshift('--model', model)
      return { args, capture: 'stdout' }
    },
  },
  codex: {
    label: 'Codex', vendor: 'OpenAI', bin: 'codex', icon: 'codex',
    readOnly: 'sandbox read-only',
    build({ system, prompt, model, outFile }) {
      const args = ['exec', '--skip-git-repo-check', '--color', 'never', '-s', 'read-only',
        '-o', outFile, `${system}\n\n---\n\n${prompt}`]
      if (model) args.splice(1, 0, '-m', model)
      return { args, capture: 'file' }
    },
  },
  opencode: {
    label: 'OpenCode', vendor: 'SST', bin: 'opencode', icon: 'opencode',
    readOnly: null,
    // `opencode run` prints a "> project · model" banner before the answer.
    clean: (text) => text.replace(/^>[^\n]*\n+/, '').trim(),
    build({ system, prompt, model }) {
      const args = ['run', `${system}\n\n---\n\n${prompt}`]
      if (model) args.splice(1, 0, '-m', model)
      return { args, capture: 'stdout' }
    },
  },
  grok: {
    label: 'Grok Build', vendor: 'xAI', bin: 'grok', icon: 'grok',
    readOnly: null,
    build({ system, prompt, model }) {
      const args = ['-p', `${system}\n\n---\n\n${prompt}`]
      if (model) args.unshift('--model', model)
      return { args, capture: 'stdout' }
    },
  },
  pi: {
    label: 'Pi', vendor: 'Parallel', bin: 'pi', icon: 'pi',
    readOnly: null,
    build({ system, prompt, model }) {
      const args = ['--print', `${system}\n\n---\n\n${prompt}`]
      if (model) args.unshift('--model', model)
      return { args, capture: 'stdout' }
    },
  },
  hermes: {
    label: 'Hermes', vendor: 'Nous Research', bin: 'hermes', icon: 'hermes',
    readOnly: null,
    build({ system, prompt }) {
      return { args: ['-z', `${system}\n\n---\n\n${prompt}`], capture: 'stdout' }
    },
  },
}

export const ENGINE_IDS = Object.keys(ADAPTERS)
