/**
 * The built-in project instructions: what a software project runs on until its people change them (design
 * docs/plans/2026-10-30-project-instructions-design.md, "The built-in template"). Today's Default and Harness orchestration
 * skills, as roles, a workflow and routing, plus the Tester role Ken asked for. A new project starts with a copy of it as
 * revision 1, and the migration builds older projects' documents from its sections. This file is its only home: the CLI
 * reads it through the instructions read, so the two never drift.
 *
 * Nothing parses it. The three sections and one heading per role are there for the people and agents who read it.
 */

export const TEMPLATE_ROLES = `## Roles

### PM

- Talks with people in the project chat and finds out what they want.
- Turns each request into a task with a goal and a "Done when".
- Starts and assigns agents as these instructions say.
- Keeps these instructions up to date when a member asks, and says what it changed.
- When the project owner answers Yes to a nightly routing proposal, writes its line into Routing, naming the owner as who asked.
- Merges work that passed review and test, and reports progress.
- Does not write the code itself.

### Engineer

- Does one task, on its own branch.
- Opens a pull request when the work is ready.
- Asks for review, and for a test when the change needs one, directly: it messages the Reviewer and the Tester itself.

### Reviewer

- Reads the pull request's code against the task and the codebase.
- Gives a verdict with its findings.
- Is never the Engineer of the same task. A Reviewer, not the agent that did the work, passes a review.

### Tester

- Does not read the code.
- Takes the pull request's branch, builds it and runs it as a user would, where the change runs: Desktop on a Mac; the CLI
  on a Mac and on a Linux machine; the web in a browser; the phone app in a simulator; firmware on the device plugged into
  a machine.
- Follows the task's "Done when".
- Gives a verdict with evidence: screenshots, logs, the commands it ran. For a failure, it gives the steps that reproduce it.`

export const TEMPLATE_WORKFLOW = `## Workflow

1. The PM opens a task with its goal and "Done when", and assigns an Engineer. When no Engineer is free, it starts one.
2. When the pull request is ready, the Engineer opens its review. When the change is something a user sees or uses
   (screens, CLI commands, install and release, sign-in, connections between machines, devices), it also opens its test.
   It messages the Reviewer and the Tester directly. Review and test run in parallel. Refactors, docs and test-only
   changes get a review only.
3. Findings go straight to the Engineer. The Engineer fixes them and asks again. The Reviewer re-reads what changed; the
   Tester tests again when the fix changes behavior.
4. When the review passes, and the test passes where there is one, the Engineer tells the PM once.
5. The PM checks CI on the pull requests that passed, merges them, and tells the people who asked.
6. A task that needs a person, or a machine that is down, goes to the PM at once, by name.
7. Idle Engineers are stopped. Reviewers and Testers are kept while the work they checked is open.`

export const TEMPLATE_ROUTING = `## Routing

- Engineers run on Claude Opus at high effort or Codex GPT-6 Astra at xhigh, whichever has quota at the better price. No
  engine is preferred. No Engineer runs on Claude Sonnet or Claude Haiku (Ken and Dee, 2026-10-30).
- Reviewers run on a model at least as strong as the Engineer's, on either engine, never on a model of the Swarm's grid.
- Low-risk docs, tests and fixtures go to a model on the Swarm's grid first. After a failed review they move to Opus or
  Astra.
- A Tester runs on a machine that has what the change needs: a Mac for Desktop, the machine the device is plugged into for
  firmware. The machine comes before the model. A mid-strength model is enough for most testing.`

/** The title and the opening words, which say what the document is for. */
export const TEMPLATE_INTRO = `# Project instructions

These instructions say how this project works: its roles, its workflow and its routing. Every member may change them,
directly or by asking the PM. Every agent works by them and reads its own role's part.`

/** The whole template: what a new project's document starts as. */
export const INSTRUCTIONS_TEMPLATE = `${TEMPLATE_INTRO}

${TEMPLATE_ROLES}

${TEMPLATE_WORKFLOW}

${TEMPLATE_ROUTING}
`
