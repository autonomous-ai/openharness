/**
 * Each checker's verdict on a task check (Diego, 2026-11-03, #2311): Review and Test record the same checks in parallel, so
 * a later pass by one checker used to erase another's failure and its evidence. A check keeps every checker's latest
 * verdict; `passedBy` and `evidence`, which every older reader reads, are derived from them with a failure winning.
 */
import type { Check, CheckVerdict } from './model.js'

/** Records [verdict] on [check], in place of its checker's earlier one, which it returns (undefined on its first). The
 *  verdicts are kept oldest first. A pass kept from before verdicts were is its checker's verdict; a failure from then names
 *  no checker, so it is not kept. */
export function recordCheckVerdict(check: Check, verdict: CheckVerdict): CheckVerdict | undefined {
  const kept = check.verdicts ?? (check.passedBy ? [{ by: check.passedBy, passed: true, evidence: check.evidence ?? '', at: 0 }] : [])
  const earlier = kept.find(v => v.by === verdict.by)
  const verdicts = check.verdicts = [...kept.filter(v => v !== earlier), verdict]
  // The check passes only while no checker's latest verdict failed: its latest passer, else the latest failure's evidence.
  const failed = verdicts.findLast(v => !v.passed)
  check.passedBy = failed ? null : verdict.by
  check.evidence = (failed ?? verdict).evidence
  return earlier
}
