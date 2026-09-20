// mock.mjs — the offline stand-in, so the harness runs with no key.
//
// It reads the same words Jev is shown and answers with crude rules: a link that looks like
// navigation is not an item, a field is whatever nearby text shares the most words with the ask.
// It exercises the plumbing. It is NOT Jev's judgement, and the pane badges it MOCK.
import { stems, hash01 } from '../toolchain/jev.mjs'

const NAV = /\b(home|about|contact|sign in|sign up|log ?in|log ?out|register|privacy|terms|cookies?|help|support|faq|careers?|blog|news|press|search|menu|skip to|back to|previous|next page|page \d+|all roles|share|tweet|facebook|linkedin)\b/i
const NEXT = /\b(next|more|older|page \d+|›|»|>)\b/i
const MONEY = /[£$€]\s?\d|\d[\d,.]*\s?(k\b|,000|per (year|annum|hour|day))/i
const DATE = /\b(\d{1,2} )?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d+ (day|week|month|hour)s? ago\b/i

const overlap = (want, have) => {
  const a = new Set(stems(want)), b = stems(have)
  if (!a.size || !b.length) return 0
  let hit = 0
  for (const w of b) if (a.has(w)) hit++
  return hit / Math.sqrt(a.size)
}

/**
 * @param {() => ({ expecting?: 'list'|'item', item?: string })} context  what the viewer is looking at
 */
export function browserMock(context = () => ({})) {
  return (stateText, qid, q, salt) => {
    const ctx = context() ?? {}
    const jitter = (k) => (hash01(`${qid}:${k}:${stateText.length}`, salt) - 0.5) * 0.12

    // What kind of page: the viewer already knows why it opened this one.
    if (qid === 'kind' && q.type === 'choice') {
      const best = ctx.expecting === 'item' ? 'item' : ctx.expecting === 'list' ? 'list' : 'other'
      const probabilities = {}
      for (const o of q.options) probabilities[o] = o === best ? 0.82 : 0.09
      return { type: 'choice', choice: best, confidence: 0.82, probabilities }
    }

    // Is this link one of the things? The instruction carries the link's words and its path.
    if (/^l\d+$/.test(qid) && q.type === 'noul') {
      const m = q.instructions.match(/^"(.*?)" is the text of a link on this page, pointing at (\S+?)\./)
      const label = m?.[1] ?? '', path = m?.[2] ?? ''
      if (!label) return { type: 'noul', noul: 0.1 }
      let p = 0.28
      if (NAV.test(label)) p -= 0.22
      if (/\/\d{2,}(\/|$)|\/[a-z0-9-]{12,}(\/|$)/i.test(path)) p += 0.4   // an id or a long slug: a thing, not a section
      if (path.split('/').filter(Boolean).length >= 2) p += 0.1
      if (label.length > 14) p += 0.12
      if (NEXT.test(label)) p -= 0.3
      p += overlap(ctx.item ?? '', label) * 0.25
      return { type: 'noul', noul: Math.max(0.02, Math.min(0.97, p + jitter(label))) }
    }

    // Which link is the next page.
    if (qid === 'nextpage' && q.type === 'choice') {
      const probabilities = {}
      let best = 'none', bestScore = 0.25
      for (const o of q.options) {
        const text = `${o} ${q.descriptions?.[o] ?? ''}`
        const s = o === 'none' ? 0.2 : /next/i.test(text) ? 0.95 : NEXT.test(text) ? 0.6 : 0.05
        probabilities[o] = s
        if (s > bestScore) { best = o; bestScore = s }
      }
      const total = Object.values(probabilities).reduce((a, b) => a + b, 0) || 1
      for (const k of Object.keys(probabilities)) probabilities[k] /= total
      return { type: 'choice', choice: best, confidence: Math.min(0.95, probabilities[best] * 2), probabilities }
    }

    // A field: pick the piece of page text that shares the most words with what was asked for.
    if (qid.startsWith('f_') && q.type === 'choice') {
      const ask = q.instructions.replace(/^On this page, which piece of text is /, '').replace(/\?.*$/, '')
      const wantsMoney = /salary|pay|price|cost|wage|fee|amount/i.test(ask)
      const wantsDate = /date|posted|published|when|deadline/i.test(ask)
      let best = 'none', bestScore = 0.18
      const scores = {}
      for (const o of q.options) {
        if (o === 'none') { scores[o] = 0.18; continue }
        const text = q.descriptions?.[o] ?? ''
        let s = overlap(ask, text) * 0.8
        if (wantsMoney && MONEY.test(text)) s += 0.75
        if (wantsDate && DATE.test(text)) s += 0.7
        if (text.length > 120) s -= 0.25
        s += jitter(o) * 0.5
        scores[o] = Math.max(0, s)
        if (s > bestScore) { best = o; bestScore = s }
      }
      const total = Object.values(scores).reduce((a, b) => a + b, 0) || 1
      const probabilities = {}
      for (const [k, v] of Object.entries(scores)) probabilities[k] = v / total
      return { type: 'choice', choice: best, confidence: Math.max(0.2, Math.min(0.96, bestScore)), probabilities }
    }

    return null   // everything else: the generic reader in jev.mjs
  }
}
