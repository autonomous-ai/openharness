/** Built into the CLI so contributed machines need no separately installed plugin. */
import { ignoreHarnessRuntime } from './harnessRuntimeIgnore.js'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export type SwarmRole = 'lead' | 'dev' | 'reviewer'
export interface SwarmSkill { role: SwarmRole; key: string }
export const isSwarmRole = (value: unknown): value is SwarmRole => value === 'lead' || value === 'dev' || value === 'reviewer'

export function parseSwarmSkill(value: unknown): SwarmSkill | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { role, key } = value as Partial<SwarmSkill>
  return isSwarmRole(role) && typeof key === 'string' && key.length > 0 ? { role, key } : undefined
}

const skills: Record<SwarmRole, string> = {
  lead: `---
name: swarm-lead
description: Use when coordinating a Harness Swarm project as its Lead or Product Manager, before discussing, splitting or assigning work.
---
# Coordinate a Swarm project

1. Restate the request briefly and mark guesses. Ask one question at a time in project chat, starting with what changes the approach: goal, scope, what must not be done, and what counts as done. State the size: small, medium, or large. Large work needs a written description.
2. Split only after the task giver or project owner clearly approves the description. Others' opinions and a vague “ok” do not replace that approval. A small, clear request (a question or one-spot fix) can be done immediately; say what you did. If told “just do it”, skip questions and state important choices.
3. Give numbered options, mark one default, and set a deadline. When it passes, record and use that default for choices already authorized. A deadline never supplies the approval required above.
4. Discuss → approved description → groups → route → assign. Every group carries goal, changes, constraints, owned code and acceptance checks. Multi-part work or work taking about 15 minutes or more goes to Swarm agents in groups. Coordinate it; your own subagents only read and look things up.
5. When a worker finishes, decide reuse, keep, or stop; prefer stop unless more work is coming soon. Never leave a worker idle without an explicit decision. If an active task is a duplicate, obsolete or the wrong task, cancel it with work.cancel and a reason instead of waiting; the worker is told to stop, then decide what to do with it. Check workers silent too long and reassign work stalled too long. Report on-screen trust, sign-in or permission questions in chat immediately, naming the machine owner who can answer.
6. Summarize long threads once and record important decisions once. Keep the project chat informed of progress, blockers and next steps.
`,
  dev: `---
name: swarm-dev
description: Use when receiving or carrying out an assigned workgroup as a Harness Swarm engineer or worker, including review and handoff.
---
# Finish assigned work

1. Say in the group chat that you took the assignment and what you are doing.
2. Follow a multi-step plan in order. For changed behavior, write a test, watch it fail for the expected reason, implement the smallest fix, then verify it passes. Debug systematically: reproduce, inspect evidence, find the cause, test a hypothesis. Check each review finding against the code before changing it. Run relevant checks and read their results before saying done.
3. If blocked, post a “Needs:” line saying what you need, then continue independent parts. Interpret ambiguous answers in their narrowest safe sense and record that interpretation.
4. Work as if nobody will return to help: finish completely and test everything testable. Package any remaining person or device action as one clear step.
5. Every handoff includes “Ready: yes/no”, evidence, the revision and useful links, and what remains unverified. Distinguish local checks from runs in the real environment.
6. Ask the Lead to route work instead of opening your own subagents to split it. Do not touch other groups' code. Merge, push or open a PR only when told.
7. Print little to save quota; keep useful progress and blocker reports in the group chat.
`,
  reviewer: `---
name: swarm-reviewer
description: Use when reviewing a Harness Swarm group's work as its Reviewer, before judging a revision.
---
# Review a group's work

1. Read only; no subagents. Read fully before judging; run the important checks yourself.
2. Check plan alignment first: everything planned is present; flag each deviation so the builder can say if it was intended; if the plan itself is wrong, say so.
3. Review against the group's description; where it is silent, judge by what an ordinary user would expect.
4. Look at tests (real behavior, not mocks), edge cases, security, backward compatibility and data migration, docs.
5. Say what was done well first.
6. Findings graded Critical / Important / Minor with a location each; grade by real severity, never mark a nitpick Critical; say how to fix when it is not obvious.
7. List what you set aside. Tie the verdict ("Ready: yes/no/with fixes") to one revision; never re-review a revision already reviewed. Push risky calls to the Lead.
`,
}

/** A session owns these bytes; retries and CLI upgrades cannot change a running session's skill.
 * No project-wide native skill links: two roles may share a workspace. */
export function prepareSwarmSkill(workspace: string, saved: SwarmSkill): { file: string; instructions: string } {
  if (!parseSwarmSkill(saved)) throw new Error('A Swarm skill needs a role and session key')
  const root = realpathSync(workspace)
  const dir = join(root, '.harness', 'runtime', createHash('sha256').update(saved.key).digest('hex'), 'swarm', 'skills', `swarm-${saved.role}`)
  let path = root
  for (const part of relative(root, dir).split(sep)) {
    path = join(path, part)
    try {
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Swarm skill directory is not a plain directory: ${path}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mkdirSync(path, { mode: 0o700 })
    }
  }
  ignoreHarnessRuntime(root)
  const file = join(dir, 'SKILL.md')
  if (existsSync(file)) {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Swarm skill is not a plain file: ${file}`)
    // Read now so an unreadable saved skill refuses launch, rather than silently dropping the role.
    readFileSync(file, 'utf8')
  } else writeFileSync(file, skills[saved.role], { flag: 'wx', mode: 0o600 })
  return { file, instructions: `Use the built-in swarm-${saved.role} skill for this session. Before working, read ${JSON.stringify(file)} with your file or shell tool.` }
}
