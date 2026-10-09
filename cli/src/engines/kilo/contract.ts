import { join as hookPath } from 'node:path'
import { env as hookEnvironment } from '../../config/env.js'
/**
 * What the core knows of Kilo without loading its code: declared data, read by the kit
 * (docs/design/2026-10-08-other-engines-out-of-core.md). It imports nothing.
 */
export const contract = {
  /** Its permission prompt lays its rows side by side under `⇆ select` and numbers none: a row is reached by
   *  walking Right from the first (askQuestion.ts), and `kit/questionPane.ts` `walkKeys` turns that into keys. */
  questionWalk: 'right',
} as const

/** Native source runs in the engine process; the daemon only renders and installs these bytes. */
export const KILO_PLUGIN = {
  file: hookPath(hookEnvironment.KILO_PLUGIN_DIR, 'launcher-register.js'),
  template: [
`// session-register — auto-installed by the machine adapter. Binds this `,
"Kilo",
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
"kilo",
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
  "current": "[hooks] Kilo discovery plugin already installed",
  "installed": "[hooks] installed Kilo discovery plugin → {file}",
  "after": [
    "[hooks] (takes effect on the next kilo session start)"
  ],
  "failed": "[hooks] failed to write Kilo plugin:"
},
} as const satisfies import('../kit/nativePlugin.js').NativePlugin
