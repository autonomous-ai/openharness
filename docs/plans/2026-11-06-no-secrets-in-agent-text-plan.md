# No secret in any agent post, status, check evidence or PR body (task #3595)

> Implemented by its Engineer test first, by superpowers:test-driven-development, as the project's instructions say
> (Engineer role). No subagent-driven-development and no execution handoff.

**Goal:** Inventory Table A #4 (anh Dee 11-06, checkable rules run as code): a join-link token was logged in #2480. An
agent's text that holds a credential is refused before anything is stored, naming the kinds found and never the value.

**As built after the security reviews (River's ruling, 11-06):** an agent's text-like attachment (text/*, JSON, XML, YAML,
scripts, or a name such as .log, .md, .txt) is scanned up to its first 1 MB with the same detector and refused by kind on both
upload paths; on the direct link its object is deleted. People's files and binaries are as before. A needs_human question's
options and unblocks, and decision.ask's words, are scanned too (SecAlder's review 1).

**Architecture:** One scan, credentials.ts `findCredentials`, the conservative detector chat redaction already uses (it passes
commit ids, UUIDs and hashes), plus one new rule: a bare Harness join or link token (43 base64url characters mixing upper
case, lower case and digits, as sharing.ts makes them). Not machineAccess.ts `secretLike`: its 20-character rule matches every
commit id, message id and UUID, so it would refuse nearly every agent status (River's ruling in #3595). In applyCommand, an
agent's text command whose words hold a credential is refused with SECRET_LIKE: message.send and message.edit, work.status
results, work.check evidence, the task text of conversation.create and work.define, person.tell and decision.ask. An agent's
attachment name is refused the same way in the store's upload. People's own posts keep today's redaction. Text the Swarm
writes to GitHub (the merge train's pull request titles, bodies and comments) is redacted, not refused, so the train never
stalls on it.

**Tech Stack:** TypeScript, vitest.

**Spec:** task #3595's brief and River's ruling in it (11-06): findCredentials plus the bare token rule; refuse with the kinds,
never the value, on the agent paths listed; people keep redaction; a commit id, a message id and a UUID pass; two security
reviews.

## Global Constraints

- The refusal names kinds only (credentials.ts CREDENTIAL_LABELS); no error, log or result echoes the matched value.
- Ordinary agent text passes: commit ids, message and task ids, UUIDs, pull request links.
- Swarm code stays in backend/src/superTabs.

## Design

- growth: nothing stored; a refused command writes nothing.
- concurrency: none; the scan runs inside the command's own pure step.
- read cost: one regex pass over the command's text fields, as redaction already does.
- scale: linear in text size; the command body limit bounds it.
- compatibility: an older CLI shows the refusal's message as any other; nothing else changes for it.
- migration + rollback: none; rolling back returns agents to redaction.
- audience: applies to agents only, decided on the server from the actor.
- identity: n/a, no identity is involved.
- failure: the agent is told what kind it held and to write where it lives instead; it can resend at once.
- platforms: server only.

## Review Focus

- No path in the list stores or echoes the value; the error text holds kinds only.
- No false refusal for the ids agents post all day.

## Task 1: one scan, refused for agents, redacted for people and for the Swarm's GitHub text

**Files:** backend/src/superTabs/credentials.ts (the token rule), commands.ts (the refusal), store.ts (attachment names),
mergeTrain/train.ts (redaction of what it writes); tests in a new agentSecrets.test.ts, credentials.test.ts and
mergeTrain/train.test.ts.

- [ ] Failing tests: each agent path refuses a GitHub token, a bare join token and a join link without echoing them; the same
  paths pass a commit id, a message id, a UUID and a pull request link; a person's post is redacted, not refused; the bare join
  token is found as its own kind; an agent's attachment name is refused; the merge train's text is redacted.
- [ ] Code.
