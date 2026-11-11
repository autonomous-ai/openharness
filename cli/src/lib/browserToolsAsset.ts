import { readFileSync } from 'node:fs'

declare const __BROWSER_TOOLS_JSON__: string

/** One browser tool: its MCP-shaped name and schema, and the one-line example and note `harness browser --help` shows. */
export interface BrowserTool {
  name: string
  description: string
  example: string
  note?: string
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] }
}

/**
 * The agent browser's tool list (cli/assets/browser/browser-tools.json). `harness browser` builds its commands and help
 * from it and the tool server in the image reads the same file, so the two never disagree. The release bundle carries
 * it inside cli.js (build-bundle.mjs `define`); a dev checkout and the tests read the file (src/lib/ and dist/lib/ are
 * both two levels down).
 */
export function browserTools(): { tools: BrowserTool[] } {
  const json = typeof __BROWSER_TOOLS_JSON__ === 'string'
    ? __BROWSER_TOOLS_JSON__
    : readFileSync(new URL('../../assets/browser/browser-tools.json', import.meta.url), 'utf8')
  return JSON.parse(json) as { tools: BrowserTool[] }
}
