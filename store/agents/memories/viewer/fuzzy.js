/**
 * fzf-style matching: every query character in order, rewarded for word starts and runs.
 *
 * Several words must all match (each anywhere, in any field), like fzf's space-separated terms. The
 * score is only for ordering; zero or less means no match.
 */

const boundary = (text, index) => index === 0 || /[\s/_\-.:([{"'`]/.test(text[index - 1]) || (/[a-z]/.test(text[index - 1]) && /[A-Z]/.test(text[index]))

/** One term against one text: the best ordered match's score, or 0. */
export function scoreTerm(term, text, substringOnly = false) {
  const needle = term.toLowerCase()
  const haystack = String(text ?? '')
  const lower = haystack.toLowerCase()
  if (!needle) return 1
  const exact = lower.indexOf(needle)
  if (exact >= 0) return 100 + needle.length * 8 + (boundary(haystack, exact) ? 40 : 0) - Math.min(30, exact / 4)
  // A long body contains almost any short query as a scattered subsequence; only exact text counts there.
  if (substringOnly) return 0
  let score = 0
  let at = -1
  let run = 0
  for (const char of needle) {
    const next = lower.indexOf(char, at + 1)
    if (next < 0) return 0
    run = next === at + 1 ? run + 1 : 0
    score += 1 + run * 3 + (boundary(haystack, next) ? 6 : 0) - Math.min(4, (next - at - 1) / 6)
    at = next
  }
  return Math.max(0.1, score)
}

/** A query (space-separated terms) against weighted fields: `[[text, weight, substringOnly?], …]`. */
export function scoreFields(query, fields) {
  const terms = String(query ?? '').trim().split(/\s+/).filter(Boolean)
  if (!terms.length) return 1
  let total = 0
  for (const term of terms) {
    let best = 0
    for (const [text, weight, substringOnly] of fields) best = Math.max(best, scoreTerm(term, text, substringOnly) * weight)
    if (best <= 0) return 0
    total += best
  }
  return total
}
