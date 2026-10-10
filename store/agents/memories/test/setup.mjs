/**
 * Every test process reads and writes a throwaway home, never the person's.
 *
 * The readers take their folders from environment variables first (CLAUDE_CONFIG_DIR, CODEX_HOME, …), so
 * a variable left over from the developer's shell would point a test at real memories. They are all
 * cleared here, before any module loads, and the About You and session index locations are redirected.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME', 'HERMES_HOME', 'OPENCLAW_HOME', 'GEMINI_HOME', 'PI_HOME', 'XDG_CONFIG_HOME', 'GROK_MEMORY', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY']) delete process.env[name]
const root = mkdtempSync(join(tmpdir(), 'memories-test-'))
process.env.MEMORIES_HOME = join(root, 'memory')
process.env.ADAPTER_DATA_DIR = join(root, 'harness-data')
process.env.MEMORIES_TEST_ROOT = root
