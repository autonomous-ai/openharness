/**
 * Shared tabs' keys (`TabKey`, core/api.ts) asked across a process boundary: Agent Messages in the edge host asks the
 * core (`tab_key`, core/messagesLink.ts), and the core asks the gateway, which holds the key
 * (`gateway_tab_key`, gateway/gatewayProcess.ts). Both hops speak the same shape, one call per method:
 * `{ method, args }`, answered `{ result }`, or `{ error }` with why. The nine methods are the only ones answered.
 *
 * What a side that cannot answer falls back to is `TAB_KEY_OFF`'s: a signature or a hello is refused with why,
 * a welcome is false, a hello accepted is `refused`, a frame is `lost`. Never the frame back as it was.
 */
import type { LaneOpened, LaneSealed, TabKey, TabLink } from '../core/api.js'

type Payload = Record<string, unknown>

export const TAB_KEY_METHODS = ['publicKey', 'signRoster', 'signKeyChange', 'hello', 'welcome', 'accept', 'seal', 'open', 'drop'] as const
export type TabKeyMethod = (typeof TAB_KEY_METHODS)[number]

/** What the asker hears when nobody could answer for the key: its process down, or its gateway not started. */
export const TAB_KEY_ABSENT = 'the gateway holds no key just now: it is not running'

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const isRecord = (value: unknown): value is Payload => !!value && typeof value === 'object' && !Array.isArray(value)
const record = (value: unknown): Payload => (isRecord(value) ? value : {})
const linkOf = (value: unknown): TabLink => {
  const link = record(value)
  return { sharedTabId: text(link.sharedTabId), machineId: text(link.machineId), peerPub: text(link.peerPub) }
}

/**
 * One call answered from `key`. A link and a frame are taken as the shapes they must be; the signatures' arguments
 * are passed as they came, for the key to refuse what is not a roster or a key (gateway/tabKey.ts). A refusal or a
 * failure is answered `{ error }`, never thrown across the link.
 */
export async function answerTabKey(key: TabKey, payload: Payload): Promise<Payload> {
  const [a, b, c] = Array.isArray(payload.args) ? payload.args as unknown[] : []
  try {
    switch (payload.method) {
      case 'publicKey': return { result: await key.publicKey() }
      case 'signRoster': return { result: await key.signRoster(a as string, b as number, c as string) }
      case 'signKeyChange': return { result: await key.signKeyChange(a as string, b as string) }
      case 'hello': return { result: await key.hello(linkOf(a)) }
      case 'welcome': return { result: await key.welcome(linkOf(a), record(b)) }
      case 'accept': return { result: await key.accept(linkOf(a), record(b)) }
      case 'seal': return { result: await key.seal(linkOf(a), record(b)) }
      case 'open': return { result: await key.open(linkOf(a), record(b)) }
      case 'drop': key.drop(linkOf(a)); return {}
      default: return { error: 'UNKNOWN_METHOD' }
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The key as the asker holds it: each method a call. A `SERVICE_…` answer is the link's, not the key's, and is said
 * as the key being away; a call that rejects (no link at all) is the same for every method but the signatures and
 * the hello, which reject with it.
 */
export function askTabKey(call: (payload: Payload) => Promise<Payload>): TabKey {
  const ask = (method: TabKeyMethod, args: unknown[]) => call({ method, args })
  const why = (answer: Payload): Error =>
    new Error(typeof answer.error === 'string' && !answer.error.startsWith('SERVICE_') ? answer.error : TAB_KEY_ABSENT)
  const signed = async (method: TabKeyMethod, args: unknown[]): Promise<string> => {
    const answer = await ask(method, args)
    if (typeof answer.result === 'string') return answer.result
    throw why(answer)
  }
  /** The result of a call whose refusal is an answer, not an error: nothing, when there is none. */
  const result = async (method: TabKeyMethod, args: unknown[]): Promise<unknown> =>
    (await ask(method, args).catch((): Payload => ({}))).result
  return {
    publicKey: () => signed('publicKey', []),
    signRoster: (sharedTabId, version, body) => signed('signRoster', [sharedTabId, version, body]),
    signKeyChange: (sharedTabId, nextPub) => signed('signKeyChange', [sharedTabId, nextPub]),
    hello: async (link) => {
      const answer = await ask('hello', [link])
      if (isRecord(answer.result)) return answer.result
      throw why(answer)
    },
    welcome: async (link, payload) => (await result('welcome', [link, payload])) === true,
    accept: async (link, hello) => {
      const answer = record(await result('accept', [link, hello]))
      return isRecord(answer.welcome) ? { welcome: answer.welcome } : { refused: true }
    },
    seal: async (link, frame): Promise<LaneSealed> => {
      const answer = record(await result('seal', [link, frame]))
      return isRecord(answer.frame) ? { frame: answer.frame } : { lost: true }
    },
    open: async (link, frame): Promise<LaneOpened> => {
      const answer = record(await result('open', [link, frame]))
      if (isRecord(answer.frame)) return { frame: answer.frame }
      return answer.unreadable === true ? { unreadable: true } : { lost: true }
    },
    // Told in order with the rest, never waited on.
    drop: (link) => { void ask('drop', [link]).catch(() => {}) },
  }
}

