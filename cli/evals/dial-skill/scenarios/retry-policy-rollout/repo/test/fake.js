import { HttpError } from '../src/http.js'

// A request function that answers each call with the next outcome: a number fails with that status, an Error is thrown
// as it is, anything else is returned. The last outcome answers every call after it.
export function fakeRequest(...outcomes) {
  const calls = []
  async function request(method, path, body) {
    calls.push({ method, path, body })
    const next = outcomes[Math.min(calls.length, outcomes.length) - 1]
    if (typeof next === 'number') throw new HttpError(next, `${method} ${path}: ${next}`)
    if (next instanceof Error) throw next
    return next
  }
  request.calls = calls
  return request
}
