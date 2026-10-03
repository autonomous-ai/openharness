/** Standalone source embedded in the existing 1.x plugin; no additional installation artifact. */
export function opencodeMemoryPluginSource(port: number): string {
  return `
  const memoryMessages = new Map()
  const memoryMessage = async (input, output) => {
    const message = output.message
    if (!input.sessionID || message?.sessionID !== input.sessionID || message.role !== "user"
      || typeof message.id !== "string" || typeof message.agent !== "string") return
    // Native overflow recovery copies user parts with new message IDs and timestamps, retaining
    // metadata. This small origin stamp distinguishes that copy from an actual new submission.
    // It records no text, preference or credential and does not enable learning or recall.
    try {
      for (const part of output.parts || []) {
        if (part.sessionID !== input.sessionID || part.messageID !== message.id || part.synthetic || part.ignored) continue
        part.metadata = { ...part.metadata, harness_submission: { v: 1, sessionID: input.sessionID, messageID: message.id } }
      }
    } catch { /* An immutable third-party part must not break the submitted request. */ }
    // Only chat.message observes an actual submitted request. Compaction and its synthetic
    // auto-continue messages are written internally and must not replace the user's selection.
    memoryMessages.delete(input.sessionID)
    memoryMessages.set(input.sessionID, { id: message.id, agent: message.agent })
    if (memoryMessages.size > 128) memoryMessages.delete(memoryMessages.keys().next().value)
  }
  const memoryRequest = async (sessionID, input) => {
    const pane = process.env.TMUX_PANE, token = hookToken()
    if (!pane || !token || !sessionID) return null
    const response = await fetch("http://127.0.0.1:${port}/api/hook/opencode-memory-runtime", {
      method: "POST", signal: AbortSignal.timeout(400),
      headers: { "content-type": "application/json", "x-harness-hook-token": token },
      body: JSON.stringify({ engine: "opencode", sessionId: sessionID, callerPid: process.pid,
        tmuxPane: pane, runtimeHints: [{ backend: "tmux", paneId: pane }], input }),
    })
    return response.ok ? response.json() : null
  }
  const memoryParams = async (input) => {
    try {
      const submitted = memoryMessages.get(input.sessionID)
      if (!submitted || submitted.id !== input.message?.id || submitted.agent !== input.agent
        || input.message.agent !== input.agent) return
      // Internal title/summary calls can use a different small model; they are not a new selection.
      const model = input.model, selection = input.message?.model
      if (!model || selection?.providerID !== model.providerID || selection?.modelID !== model.id) return
      const grant = await memoryRequest(input.sessionID, { kind: "probe" })
      if (!grant?.observe || typeof grant.challenge !== "string") return
      let healthTimer
      // The pinned 1.x plugin SDK omits a health wrapper; its in-process client still serves the route.
      const health = await Promise.race([client._client.get({ url: "/global/health", signal: AbortSignal.timeout(400) }),
        new Promise(resolve => { healthTimer = setTimeout(() => resolve(null), 400) })])
        .finally(() => clearTimeout(healthTimer))
      if (health?.data?.version !== "1.18.34") return
      const provider = input.provider
      if (!provider || provider.id !== model.providerID) return
      // Functions (including OAuth fetch wrappers) are not representable by an isolated API call.
      const json = (value, depth = 0) => {
        if (depth > 16 || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new Error("unsupported")
        if (value && typeof value === "object") for (const item of Object.values(value)) json(item, depth + 1)
      }
      json(provider.options); json(model)
      const options = { ...provider.options }
      const key = options.apiKey === undefined ? provider.key : options.apiKey
      if (typeof key !== "string" || !key || key === "OAUTH_DUMMY_KEY") return
      delete options.apiKey
      const capabilities = model.capabilities
      const modalities = (value) => Object.entries(value || {}).filter(([, enabled]) => enabled === true).map(([name]) => name)
      const snapshot = { model: model.providerID + "/" + model.id,
        ...(selection.variant ? { variant: selection.variant } : {}), auth: { type: "api", key },
        provider: { name: provider.name, npm: model.api.npm, options,
          models: { [model.id]: { id: model.api.id, name: model.name,
            provider: { npm: model.api.npm, api: model.api.url }, limit: model.limit,
            reasoning: capabilities.reasoning, temperature: capabilities.temperature,
            attachment: capabilities.attachment, tool_call: capabilities.toolcall, interleaved: capabilities.interleaved,
            modalities: { input: modalities(capabilities.input), output: modalities(capabilities.output) },
            options: model.options, variants: model.variants, headers: model.headers,
          } },
        },
      }
      if (Buffer.byteLength(JSON.stringify(snapshot)) > 48000) return
      await memoryRequest(input.sessionID, { kind: "observe", challenge: grant.challenge,
        nativeVersion: health.data.version, snapshot })
    } catch { /* Optional memory never fails or modifies the foreground request. */ }
  }
`
}
