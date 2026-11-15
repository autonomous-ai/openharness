/**
 * The keys' routes of the daemon's local door (core/api.ts `SERVICE_HTTP_ROUTES`), answered here, by the gateway, which
 * holds this machine's E2EE identity, its pairings, its trust group and its copy of the account's device key log:
 * `harness pair`, `pairings`, `unpair`, `remote-password`, `link connect`'s mutual half, `group` and `devices`, and the
 * window's Devices list. They were the door's own (hookServer.ts) until the core audit of 2026-11-12 (section 2) moved
 * them, as they were: the core's door checks the caller and a write's local header (core/serviceRoutes.ts) and hands
 * each on as it came; what each takes is checked here, in the door's words, and each answers byte for byte as it did
 * there (e2e/keyRoutes.e2e.ts).
 */
import type { HttpAnswer } from '../core/api.js'

/** What the routes do, as the gateway does it (gateway/start.ts). */
export interface KeyOps {
  /** `harness pair <code>`: CPace toward the browser that is waiting to pair, as long as its rounds take. */
  pair(code: string): Promise<HttpAnswer>
  listPairs(): Promise<HttpAnswer>
  /** `harness unpair <id>`: by fingerprint, prefix or index. */
  revoke(id: string): Promise<HttpAnswer>
  revokeAll(): Promise<HttpAnswer>
  /** `harness remote-password set`: stretched and kept on the live E2EE state, so a `harness link connect` from another
   *  machine sees it at once. */
  setRemotePassword(password: string): Promise<HttpAnswer>
  clearRemotePassword(): Promise<HttpAnswer>
  remotePasswordStatus(): Promise<HttpAnswer>
  /** `harness link connect`: the machine this one just linked pinned it back, so it is trusted here too. */
  trustLinkedPeer(peer: { pub: string; machineId: string; label: string }): Promise<HttpAnswer>
  groupList(): Promise<HttpAnswer>
  groupSync(): Promise<HttpAnswer>
  groupRemove(selector: string): Promise<HttpAnswer>
  devicesList(): Promise<HttpAnswer>
  devicesRemove(pub: string): Promise<HttpAnswer>
  devicesHistory(): Promise<HttpAnswer>
  /** `confirm`: "It's mine" for the one key named, shared with the account's other devices. */
  devicesDismiss(body: { pub?: string; pubs?: string[]; baseline?: boolean; confirm?: boolean }): Promise<HttpAnswer>
  /** A preview of trusting the backend's log again; `confirm` does it, on the head the person was shown. */
  devicesRebaseline(confirm: boolean, head?: { seq: number; hash: string }): Promise<HttpAnswer>
}

const answer = (status: number, body: Record<string, unknown>): HttpAnswer => ({ status, body })
const BAD_JSON = answer(400, { error: 'bad json' })
/** A 32-byte Ed25519 key, base64. */
const KEY = /^[A-Za-z0-9+/]{43}=$/
const MACHINE_ID = /^[a-f0-9]{32}$/

/** What a route does with its body, read as JSON. */
type WithBody = (body: Record<string, unknown>) => Promise<HttpAnswer> | HttpAnswer

/** The command's own failure, said as `harness pair` and `remote-password set` read it: its message. */
const said = async (run: () => Promise<HttpAnswer>): Promise<HttpAnswer> => {
  try { return await run() } catch (error) { return answer(500, { error: error instanceof Error ? error.message : 'INTERNAL' }) }
}

/** The routes, by method and path (the query left out). A body that is not JSON is `bad json`; a body of JSON that holds
 *  no record (`null`) is read as the door read it, which threw where it reached for a field. */
function routes(ops: KeyOps): Record<string, { body?: WithBody; run?: () => Promise<HttpAnswer> }> {
  return {
    'POST /api/pair': { body: (body) => (body.code ? said(() => ops.pair(body.code as string)) : answer(400, { error: 'MISSING_CODE' })) },
    'GET /api/pairs': { run: () => ops.listPairs() },
    'POST /api/revoke': { body: (body) => (body.id ? ops.revoke(body.id as string) : answer(400, { error: 'MISSING_ID' })) },
    'POST /api/revoke-all': { run: () => ops.revokeAll() },
    'POST /api/remote-password/set': { body: (body) => (body.password ? said(() => ops.setRemotePassword(body.password as string)) : answer(400, { error: 'MISSING_PASSWORD' })) },
    'POST /api/remote-password/clear': { run: () => ops.clearRemotePassword() },
    'GET /api/remote-password/status': { run: () => ops.remotePasswordStatus() },
    'POST /api/link/trust-peer': { body: (body) => {
      if (typeof body.pub !== 'string' || !KEY.test(body.pub) || typeof body.machineId !== 'string' || !MACHINE_ID.test(body.machineId)) return answer(400, { error: 'BAD_PEER' })
      const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 60) : body.machineId
      return ops.trustLinkedPeer({ pub: body.pub, machineId: body.machineId, label })
    } },
    'GET /api/group': { run: () => ops.groupList() },
    'POST /api/group/sync': { run: () => ops.groupSync() },
    'POST /api/group/remove': { body: (body) => (typeof body.selector !== 'string' || !body.selector.trim()
      ? answer(400, { error: 'MISSING_SELECTOR' }) : ops.groupRemove(body.selector.trim())) },
    'GET /api/devices': { run: () => ops.devicesList() },
    'POST /api/devices/remove': { body: (body) => (typeof body.pub !== 'string' || !body.pub ? answer(400, { error: 'MISSING_PUB' }) : ops.devicesRemove(body.pub)) },
    'POST /api/devices/rebaseline': { body: (body) => {
      if (!body || typeof body !== 'object') return BAD_JSON
      // The head the person was shown in the preview: a confirm only goes ahead on that same list.
      let head: { seq: number; hash: string } | undefined
      if (body.head !== undefined) {
        const h = body.head as { seq?: unknown; hash?: unknown } | null
        if (!h || typeof h !== 'object' || typeof h.seq !== 'number' || !Number.isSafeInteger(h.seq) || h.seq < 0
          || typeof h.hash !== 'string' || h.hash.length > 128) return answer(400, { error: 'BAD_HEAD' })
        head = { seq: h.seq, hash: h.hash }
      }
      return ops.devicesRebaseline(body.confirm === true, head)
    } },
    'GET /api/devices/history': { run: () => ops.devicesHistory() },
    'POST /api/devices/dismiss': { body: (body) => {
      if (!body || typeof body !== 'object') return BAD_JSON
      if (body.pub !== undefined && (typeof body.pub !== 'string' || !body.pub)) return answer(400, { error: 'MISSING_PUB' })
      // The keys a window displayed, so a key accepted since the window read the list is not cleared unseen.
      if (body.pubs !== undefined && (!Array.isArray(body.pubs) || body.pubs.length > 256
        || body.pubs.some((k) => typeof k !== 'string' || !k || k.length > 256))) return answer(400, { error: 'BAD_PUBS' })
      return ops.devicesDismiss({
        ...(typeof body.pub === 'string' ? { pub: body.pub } : {}),
        ...(Array.isArray(body.pubs) ? { pubs: body.pubs as string[] } : {}),
        ...(body.baseline === true ? { baseline: true } : {}),
        // "It's mine" for one device: the account's other devices are told too (deviceLogSyncer `dismiss`).
        ...(body.confirm === true ? { confirm: true } : {}),
      })
    } },
  }
}

/**
 * The keys' routes, answered: [method] and [path] as the client sent them, [text] the body as the door read it. Null for
 * a path and method that is none of them. Nothing is thrown: what threw in the door's own code (a body of `null` reached
 * for a field, a command that failed) is the 500 its catch-all gave, said in this process's log.
 */
export function keyRoutes(ops: KeyOps, log: (line: string) => void = (line) => console.error(line)) {
  const table = routes(ops)
  return (method: string, path: string, text: string | undefined): Promise<HttpAnswer> | null => {
    const route = Object.hasOwn(table, `${method} ${path}`) ? table[`${method} ${path}`] : undefined
    if (!route) return null
    return (async () => {
      try {
        if (route.run) return await route.run()
        let body: Record<string, unknown>
        try { body = JSON.parse(text ?? '') as Record<string, unknown> } catch { return BAD_JSON }
        return await route.body!(body)
      } catch (error) {
        log(`[gateway] ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
        return answer(500, { error: 'INTERNAL' })
      }
    })()
  }
}
