import { join as hookPath, dirname as hookParent } from 'node:path'
import { env as hookEnvironment } from '../../config/env.js'
/**
 * What the core knows of OpenCode without loading its code: declared data, read in line where a launch is built
 * (docs/design/2026-10-08-other-engines-out-of-core.md). It imports nothing of OpenCode's code.
 */

/** The first major whose TUI rejects `-m` / `--agent` and whose sessions live behind its API. */
const OPENCODE_V2_MAJOR = 2

/** Whether a major version (`engines/opencode/version.ts` reads it) is v2 or later; unknown reads as v1. */
export function isOpencodeV2(major: number | null | undefined): boolean {
  return (major ?? 0) >= OPENCODE_V2_MAJOR
}

export const OPENCODE_VERSION = { output: /(\d+)\.\d+\.\d+/, args: ['--version'], timeoutMs: 5_000 } as const

/** Native model changes: v1's picker transaction and v2's service protocol, measured before extraction. */
export const OPENCODE_SESSION_MODEL = {
  label: 'opencode', serviceMajor: OPENCODE_V2_MAJOR, id: /^[A-Za-z0-9_]+$/,
  modelFlags: ['-m', '--model'], modelEquals: '--model=', variantSeparator: '#',
  errors: { sqliteMissing: 'OPENCODE_SQLITE_MISSING', sessionMissing: 'OPENCODE_SESSION_NOT_FOUND',
    writeFailed: 'OPENCODE_DB_WRITE_FAILED', binaryMissing: 'OPENCODE_MISSING',
    switchFailed: 'OPENCODE_MODEL_SWITCH_FAILED', unknownModel: 'OPENCODE_MODEL_UNKNOWN' },
  sqlite: { args: ['-batch', '-bail'], timeoutMs: 15_000, statements: [
    'PRAGMA busy_timeout = 5000;',
    'BEGIN IMMEDIATE;',
    "UPDATE message SET data = json_set(data, '$.model.providerID', {{provider}}, '$.model.modelID', {{model}}) WHERE id = (SELECT id FROM message WHERE session_id = {{session}} AND json_extract(data, '$.role') = 'user' ORDER BY time_created DESC LIMIT 1);",
    'SELECT changes();',
    "UPDATE session SET model = json_object('id', {{model}}, 'providerID', {{provider}}, 'variant', 'default') WHERE id = {{session}} AND EXISTS (SELECT 1 FROM message WHERE session_id = {{session}} AND json_extract(data, '$.role') = 'user');",
    'SELECT changes();',
    'COMMIT;',
  ] },
  api: { timeoutMs: 15_000, retryDelayMs: 1_000, list: ['api', 'model.list'], switch: ['api', 'session.switchModel'],
    get: ['api', 'session.get'], paramFlag: '--param', sessionParam: 'sessionID', bodyFlag: '-d',
    missingSession: /SessionNotFoundError|HTTP 404/,
    fields: { data: 'data', model: 'model', id: 'id', alternativeId: 'modelID', provider: 'providerID', variant: 'variant' },
  },
} as const

/** Native source runs in the engine process; the daemon only renders and installs these bytes. */
export const OPENCODE_LEGACY_PLUGIN = {
  file: hookPath(hookEnvironment.OPENCODE_PLUGIN_DIR, 'launcher-register.js'),
  template: [
`// session-register — auto-installed by the machine adapter. Binds this `,
"OpenCode",
` session to the
// local machine daemon (127.0.0.1:`,
{ argument: 'port' },
`) so it can be mirrored to web/device. No-op if machine isn't running.
import { readFileSync } from "node:fs"
const hookToken = () => { try { return readFileSync(`,
{ argument: 'credential' },
`, "utf8").trim() } catch { return "" } }
export const MachineRegister = async ({ directory, worktree, project, client }) => {
  const seen = new Set()
  const post = async (sessionID) => {
    const pane = process.env.TMUX_PANE
    const token = hookToken()
    if (!pane || !token || !sessionID || seen.has(sessionID)) return
    seen.add(sessionID)
    try {
      await fetch("http://127.0.0.1:`,
{ argument: 'port' },
`/api/hook/session-start", {
        method: "POST",
        headers: { "content-type": "application/json", "x-harness-hook-token": token },
        body: JSON.stringify({
          engine: "`,
"opencode",
`",
          pluginVersion: `,
{ argument: 'version' },
`,
          sessionId: sessionID,
          cwd: directory || worktree || (project && project.worktree) || null,
          tmuxPane: pane,
          callerPid: process.pid,
          runtimeHints: [
            ...(pane ? [{ backend: "tmux", paneId: pane }] : []),
          ],
        }),
      })
    } catch {}
  }
  return {
    event: async ({ event }) => {
      if (!event) return
      if (event.type === "session.created" || event.type === "session.updated") {
        const p = event.properties || {}
        const info = p.info || {}
        if (info.parentID) return // sub-agent child session — shown under its parent's Task card, not a top-level agent
        await post(info.id || p.sessionID || p.sessionId)
      }
    },
  }
}
`
],
  messages: {
  "current": "[hooks] OpenCode discovery plugin already installed",
  "installed": "[hooks] installed OpenCode discovery plugin → {file}",
  "after": [
    "[hooks] (takes effect on the next opencode session start)"
  ],
  "failed": "[hooks] failed to write OpenCode plugin:"
},
} as const satisfies import('../kit/nativePlugin.js').NativePlugin

/** Native source runs in the engine process; the daemon only renders and installs these bytes. */
export const OPENCODE_TUI_PLUGIN = {
  file: hookPath(hookParent(hookEnvironment.OPENCODE_PLUGIN_DIR), 'plugins', 'launcher-register', 'tui.js'),
  template: [
`// session-register (OpenCode 2 TUI) — auto-installed by the machine adapter. Tells the local machine
// daemon (127.0.0.1:`,
{ argument: 'port' },
`) which session this pane shows, as the 1.x plugin does. No-op if machine isn't running.
import { readFileSync } from "node:fs"
const hookToken = () => { try { return readFileSync(`,
{ argument: 'credential' },
`, "utf8").trim() } catch { return "" } }
export default {
  id: "harness-session-register",
  setup(ctx) {
    const pane = process.env.TMUX_PANE
    const router = ctx && ctx.ui && ctx.ui.router
    if (!pane || !router || typeof router.current !== "function") return
    const posted = new Set()
    let busy = false
    const post = async (sessionID) => {
      const token = hookToken()
      if (!token || !sessionID || posted.has(sessionID) || busy) return
      busy = true
      try {
        let info
        try { info = await (ctx.data && ctx.data.session && ctx.data.session.get ? ctx.data.session.get(sessionID) : undefined) } catch {}
        if (info && info.parentID) { posted.add(sessionID); return } // a sub-agent's — shown under its parent's Task card
        const cwd = (info && info.location && info.location.directory) || (ctx.location && ctx.location.directory) || process.cwd()
        const res = await fetch("http://127.0.0.1:`,
{ argument: 'port' },
`/api/hook/session-start", {
          method: "POST",
          headers: { "content-type": "application/json", "x-harness-hook-token": token },
          body: JSON.stringify({
            engine: "opencode",
            pluginVersion: `,
{ argument: 'version' },
`,
            sessionId: sessionID,
            cwd,
            tmuxPane: pane,
            callerPid: process.pid,
            runtimeHints: [{ backend: "tmux", paneId: pane }],
          }),
        })
        if (res && res.ok) posted.add(sessionID)
      } catch {} finally { busy = false }
    }
    const check = () => {
      try { const at = router.current(); if (at && at.type === "session" && at.sessionID) post(at.sessionID) } catch {}
    }
    check()
    const timer = setInterval(check, 1000)
    if (timer && typeof timer.unref === "function") timer.unref()
    return () => clearInterval(timer)
  },
}
`
],
  messages: {
  "current": "[hooks] OpenCode 2 TUI discovery plugin already installed",
  "installed": "[hooks] installed OpenCode 2 TUI discovery plugin → {file}",
  "after": [
    "[hooks] (takes effect on the next opencode session start)"
  ],
  "failed": "[hooks] failed to write OpenCode 2 TUI plugin:"
},
} as const satisfies import('../kit/nativePlugin.js').NativePlugin

/** V2 also discovers the legacy directory but rejects its API. A foreign plugin is never ours to remove. */
export const OPENCODE_LEGACY_REMOVAL = {
  file: OPENCODE_LEGACY_PLUGIN.file,
  prefix: '// session-register — auto-installed by the machine adapter. Binds this OpenCode session to the\n',
  contains: 'export const MachineRegister =',
  removed: '[hooks] removed incompatible OpenCode 1 discovery plugin',
  failed: '[hooks] failed to remove OpenCode 1 plugin:',
} as const
