/** Native transport only. Retrieval, evidence, scope and controls remain in Harness's shared core. */
export function opencodeRecallPluginSource(port: number): string {
  return `
  const recallTurns = new Map(), recallCompactions = new Set(), recallParts = new Set()
  let recallVersion
  const recallMessage = async (input, output) => {
    const message = output.message
    if (!input.sessionID || message?.sessionID !== input.sessionID || message.role !== "user"
      || typeof message.id !== "string" || typeof message.agent !== "string") return
    const query = (output.parts || []).filter(part => part.type === "text" && !part.synthetic && !part.ignored
      && typeof part.text === "string").map(part => part.text).join("\\n").slice(0, 4000).trim()
    recallTurns.delete(input.sessionID)
    // File-only requests must replace a previous query too; never recall for a stale user turn.
    recallTurns.set(input.sessionID, { id: message.id, agent: message.agent, query, continuation: false })
    if (recallTurns.size > 128) {
      const oldest = recallTurns.keys().next().value
      recallTurns.delete(oldest); recallCompactions.delete(oldest)
    }
  }
  const recallCompacting = async ({sessionID}) => {
    if (recallTurns.has(sessionID)) recallCompactions.add(sessionID)
  }
  const recallAutoContinue = async (input) => {
    const turn = recallTurns.get(input.sessionID)
    if (turn && turn.agent === input.agent && input.message?.agent === input.agent) turn.continuation = true
  }
  const recallRequest = async (route, sessionID, body, signal) => {
    const pane = process.env.TMUX_PANE, token = hookToken()
    if (!pane || !token) return null
    const response = await fetch("http://127.0.0.1:${port}/api/hook/" + route, {
      method: "POST", signal, headers: { "content-type": "application/json", "x-harness-hook-token": token },
      body: JSON.stringify({ engine: "opencode", sessionId: sessionID, callerPid: process.pid,
        tmuxPane: pane, runtimeHints: [{ backend: "tmux", paneId: pane }], ...body }),
    })
    if (!response.ok || !response.body) return null
    const reader = response.body.getReader(), chunks = []
    let bytes = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > 64000) { await reader.cancel(); return null }
        chunks.push(value)
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } finally { reader.releaseLock() }
  }
  const recallTransform = async (_input, output) => {
    let timer, healthTimer
    const controller = new AbortController()
    try {
      // These parts exist only in the outgoing conversion. Strip our prior parts even if another
      // plugin cloned the message array, then ask the core again so off/forget/correct take effect.
      for (const row of output.messages) row.parts = row.parts.filter(part => !recallParts.has(part.id))
      const row = output.messages.findLast(row => row.info.role === "user")
      if (!row || recallCompactions.delete(row.info.sessionID)) return
      const sessionID = row.info.sessionID, turn = recallTurns.get(sessionID)
      if (!turn?.query || turn.agent !== row.info.agent) return
      const sameTurn = row.info.id === turn.id
      const seed = row.parts.find(part => {
        if (part.type !== "text" || part.ignored) return false
        if (sameTurn) return !part.synthetic
        const origin = part.metadata?.harness_submission
        const replay = !part.synthetic && origin?.v === 1 && origin.sessionID === sessionID && origin.messageID === turn.id
        return replay || (turn.continuation && part.synthetic && part.metadata?.compaction_continue === true)
      })
      if (!seed || !process.env.TMUX_PANE || !hookToken()) return
      const result = await Promise.race([
        (async () => {
          if (!recallVersion) {
            const health = await Promise.race([client._client.get({ url: "/global/health", signal: controller.signal }),
              new Promise(resolve => { healthTimer = setTimeout(() => resolve(null), 400) })])
            if (health?.data?.version) recallVersion = health.data.version
          }
          if (recallVersion !== "1.18.34") return null
          return recallRequest("memory-context", sessionID, { cliVersion: recallVersion, prompt: turn.query }, controller.signal)
        })(),
        new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null) }, 700) }),
      ])
      const context = result?.additionalContext
      if (recallTurns.get(sessionID) !== turn || typeof context !== "string" || !context
        || Buffer.byteLength(context) > 8000) return
      const part = { id: seed.id + "_harness_memory", sessionID, messageID: row.info.id,
        type: "text", text: context, synthetic: true }
      recallParts.add(part.id)
      if (recallParts.size > 256) recallParts.delete(recallParts.values().next().value)
      row.parts.unshift(part)
      if (typeof result.memoryReceiptId === "string" && /^[a-f0-9-]{36}$/.test(result.memoryReceiptId)) {
        void recallRequest("memory-emitted", sessionID, { memoryReceiptId: result.memoryReceiptId }, AbortSignal.timeout(400)).catch(() => {})
      }
    } catch { /* Optional recall must never fail the user's request. */ }
    finally { clearTimeout(timer); clearTimeout(healthTimer); controller.abort() }
  }
`
}
