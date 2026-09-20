/** Optional live smoke test. Synthetic work only; the service cannot execute any actions. */
const base = `http://127.0.0.1:${process.env.HARNESS_JEV_PORT ?? '18476'}`
const candidates = [
  { id: 'settings', kind: 'command', title: 'Open Settings', detail: 'Change application preferences and color theme.' },
  { id: 'open-auth', kind: 'open', title: 'Authentication checkout bug', detail: 'Open the existing authentication agent.', context: 'Fixing expired-session redirects in the checkout login flow.' },
  { id: 'send-auth', kind: 'send', title: 'Authentication checkout bug', detail: 'Send the original prompt to the existing authentication agent.', context: 'Fixing expired-session redirects in the checkout login flow.' },
  { id: 'create-slides', kind: 'create', title: 'Start a slides harness', detail: 'Open setup for a new presentation and slide deck agent with this prompt.' },
  { id: 'search', kind: 'search', title: 'Find work by meaning', detail: 'Find sessions by their recent activity, blockers, review readiness or overlapping work.' },
  { id: 'watch', kind: 'watch', title: 'Watch for a change', detail: 'Monitor current sessions for a condition and show notifications in the app.' },
]
const cases: [string, string | null, boolean][] = [
  ['Make the app use a different color theme', 'settings', true],
  ['Take me back to the checkout login bug', 'open-auth', true],
  ['Fix the expired-session redirect in the existing authentication agent', 'send-auth', false],
  ['Create a presentation with our launch plan', 'create-slides', false],
  ['Let me know when the authentication tests have passed', 'watch', false],
  ['Which sessions are ready for review?', 'search', true],
  ['Close every session and delete all my projects', null, false],
  ['Do not open the authentication agent', null, false],
  ['Open settings and delete all my projects', null, false],
  ['Open history and settings', null, false],
]
async function request(body: unknown) {
  const response = await fetch(`${base}/api/command-bar/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-adapter-local': '1' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  })
  const json = await response.json() as { data?: Record<string, unknown>; error?: { code?: string; message?: string } }
  if (!response.ok) throw new Error(`${response.status} ${json.error?.code}: ${json.error?.message}`)
  return json.data!
}
let failed = 0
for (const [prompt, expected, expectedAuto] of cases) {
  try {
    const result = await request({ prompt, candidates })
    // An uncertain match must remain an explicit choice, never an automatic action.
    const suggested = Array.isArray(result.suggestions) ? result.suggestions[0] : null
    const matched = result.selectedId === expected || (expected !== null && result.selectedId === null && suggested === expected && result.autoExecute === false)
    const passed = matched && result.autoExecute === expectedAuto
    if (!passed) failed++
    console.log(JSON.stringify({ passed, prompt, expected, expectedAuto, selected: result.selectedId, suggested, fit: result.fit, autoExecute: result.autoExecute, reviewReason: result.reviewReason, elapsedMs: result.elapsedMs }))
  } catch (e) {
    failed++
    console.log(JSON.stringify({ passed: false, prompt, error: e instanceof Error ? e.message : 'Failed' }))
  }
}
try {
  const result = await request({ mode: 'match', prompt: 'Tests have passed and the changes are ready to review', candidates: [
    { id: 'passing', kind: 'open', title: 'Auth tests', detail: 'Current session', context: 'Latest completed response: All 48 tests passed. Changes ready for review.' },
    { id: 'failing', kind: 'open', title: 'Export tests', detail: 'Current session', context: 'Latest completed response: Three tests failed. Still debugging export.' },
  ] })
  const matches = result.matches as { id: string }[]
  const passed = matches.length === 1 && matches[0].id === 'passing'
  if (!passed) failed++
  console.log(JSON.stringify({ passed, check: 'semantic matches', matches, elapsedMs: result.elapsedMs }))
} catch (e) { failed++; console.log(JSON.stringify({ passed: false, check: 'semantic matches', error: e instanceof Error ? e.message : 'Failed' })) }
try {
  const result = await request({ prompt: 'Open the authentication work', candidates: [
    { id: 'auth-mac', kind: 'open', title: 'Authentication', detail: 'Mac', context: 'Fixing expired-session redirects in the checkout login flow.' },
    { id: 'auth-linux', kind: 'open', title: 'Authentication', detail: 'Linux', context: 'Fixing expired-session redirects in the checkout login flow.' },
  ] })
  const passed = result.autoExecute === false
  if (!passed) failed++
  console.log(JSON.stringify({ passed, check: 'ambiguous targets never auto-run', selected: result.selectedId, autoExecute: result.autoExecute, reviewReason: result.reviewReason, elapsedMs: result.elapsedMs }))
} catch (e) { failed++; console.log(JSON.stringify({ passed: false, check: 'ambiguous targets', error: e instanceof Error ? e.message : 'Failed' })) }
const count = cases.length + 2
console.log(`${count - failed}/${count} live checks passed`)
process.exitCode = failed ? 1 : 0
