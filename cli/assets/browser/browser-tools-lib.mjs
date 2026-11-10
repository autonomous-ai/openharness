// Pure helpers of the tool server (browser-tools.mjs), apart so the CLI's specs can run them without a browser.

// The roles a person acts on. Only these get a ref: the agent clicks, types and selects, and a ref on every heading
// or cell would only make the snapshot longer (the prior art's "role" mode, minus its content refs).
const INTERACTIVE = new Set([
  'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
  'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem',
])

// `- role "name" rest`, as Playwright's ariaSnapshot() writes a line; a name may hold escaped quotes.
const LINE = /^(\s*-\s*)(\w+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/

/**
 * Adds `[ref=eN]` to each interactive line of an aria snapshot. A ref resolves through
 * `getByRole(role, { name, exact: true }).nth(nth)`, or `getByRole(role).nth(nth)` without a name.
 */
export function roleSnapshot(aria) {
  const refs = {}
  const seen = new Map()
  const lines = aria.split('\n').map(line => {
    const match = LINE.exec(line)
    if (!match || !INTERACTIVE.has(match[2].toLowerCase())) return line
    const [, prefix, roleRaw, quoted, rest] = match
    const role = roleRaw.toLowerCase()
    const name = quoted === undefined ? undefined : quoted.replace(/\\(.)/g, '$1')
    // getByRole(role) without a name matches every element of that role, named or not, so an unnamed ref counts
    // them all; a named one counts only its own name.
    const nth = name === undefined ? seen.get(role) ?? 0 : seen.get(`${role}\0${name}`) ?? 0
    seen.set(role, (seen.get(role) ?? 0) + 1)
    if (name !== undefined) seen.set(`${role}\0${name}`, nth + 1)
    const ref = `e${Object.keys(refs).length + 1}`
    refs[ref] = name === undefined ? { role, nth } : { role, name, nth }
    return `${prefix}${roleRaw}${quoted === undefined ? '' : ` "${quoted}"`} [ref=${ref}]${rest}`
  })
  return { text: lines.join('\n'), refs }
}

const ATTEMPTS = 3
const pending = new WeakMap()

/**
 * Connects at most three times, with timeouts of 5, 7 and 9 s and a pause of 250 ms more after each failure (the
 * prior art's pw-session.ts). Concurrent calls with the same `connect` share one attempt, so two tool calls never
 * open two CDP connections.
 */
export function connectWithRetry(connect, sleep) {
  const shared = pending.get(connect)
  if (shared) return shared
  const attempt = (async () => {
    for (let n = 0; n < ATTEMPTS; n += 1) {
      try {
        return await connect(5000 + n * 2000)
      } catch {
        if (n < ATTEMPTS - 1) await sleep(250 + n * 250)
      }
    }
    // The CDP error names the endpoint and Playwright's internals; the agent and its person need only this.
    throw new Error('Browser is not reachable')
  })().finally(() => pending.delete(connect))
  pending.set(connect, attempt)
  return attempt
}

/** Every CDP command and tool call is bounded, so a hung page never holds the agent's turn. */
export function withTimeout(work, ms, what) {
  let timer
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms) })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/**
 * The URL, when the tools may open it: http, https or about:blank. Anything else is refused, file:// above all: the
 * proxy secret is a file in the container, and a page that tells the agent to open it would put the password in the
 * agent's context. Chrome's policy blocks file:// too (policy.json).
 */
export function navigable(url) {
  let parsed = null
  try { parsed = new URL(url) } catch { /* refused below */ }
  if (parsed?.protocol === 'http:' || parsed?.protocol === 'https:' || parsed?.href === 'about:blank') return url
  throw new Error('Only http and https URLs open in the Browser')
}
