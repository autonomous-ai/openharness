/**
 * What every agent verb ends with (docs/design/2026-10-15-agent-experience.md, part 2): the step to take next, and
 * when to take it, so an agent is never left to guess. `--json` carries the same steps as `next`.
 */

/** A command to run and when to pick it, or something only words can say ("tell the person …"). */
export type NextStep = { run: string; when: string } | { tell: string }

/** `Next: <command>  (<when>)`, then `  or: …` for the other choices; null when there is nothing next. */
export function formatNext(steps: readonly NextStep[]): string | null {
  if (!steps.length) return null
  return steps.map((step, i) => `${i ? '  or:' : 'Next:'} ${'run' in step ? `${step.run}  (${step.when})` : step.tell}`).join('\n')
}
