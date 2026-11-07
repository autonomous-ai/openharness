# A person approves the task the PM shaped, never an undecided proposal: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** task #4249 (from the v3 flows audit #4212, finding 16; River for anh Dee). A member in Review could approve a
Buddy proposal before the PM decided it; the PM then accepted or reshaped it (or converted the older chat proposal into a
task) with a different scope, and the approval carried over, so the PM could assign any work the person never saw.

**Architecture:** the approval belongs to the task the PM shaped, after it exists.

- `taskApproval.ts`: `undecidedProposal(group)` is true while a proposal card has no accept or reshape. `task.approve` on
  such a card is refused with `PROPOSAL_UNDECIDED` (a Later card is undecided too). Reject and suggest stay as they are.
- `proposalCards.ts` `proposal.decide` accept or reshape: an approval already `approved` (stored before this fix) goes back
  to `proposal`, without its decision time, so the person approves the shaped task. A chosen agent stays as the suggestion.
- `commands.ts` conversion of an older chat proposal: the new task's approval is the same person and membership, freshly
  staged (`proposal`, no suggestion, created now), never a copy of the card's decision.
- `read/personalTasks.ts`: `canApprove` is false on an undecided proposal, so the Tasks row offers no Approve.

**Tech Stack:** TypeScript backend, vitest.

**Spec:** the audit finding (task #4212, finding 16): "an undecided proposal can't be approved. Approval is for the task the
PM shaped." Brief: "A task in Review needs its own approval of the agent shown, after it exists."

## Global Constraints

- Owns `backend/src/superTabs/` only. No schema, collection or index change: `taskApproval` is an existing field.
- The server enforces it; the client's Approve only follows `canApprove`.
- Never read or print a secret or login.

## Review Focus

- Data stored before the fix: a card already `approved` while undecided must not let the PM assign after accept or reshape.
- A Later card: Approve is refused and not offered.
- The older chat proposal converted into a task: an approved or suggested mirror gives the task a fresh `proposal` approval.
- Auto approve members: nothing changes (no approval is staged).
- After accept, the person approves once and the PM assigns the agent shown, as today.

---

### Task 1: Approval only of a decided proposal, and never carried over

**Files:**
- Modify: `backend/src/superTabs/taskApproval.ts`, `backend/src/superTabs/commands.ts`, `backend/src/superTabs/proposalCards.ts`,
  `backend/src/superTabs/read/personalTasks.ts`
- Test: `backend/src/superTabs/taskApproval.test.ts`, `backend/src/superTabs/read/personalTasks.test.ts`

**Interfaces:**
- Produces: `undecidedProposal(group: Conversation): boolean` in `taskApproval.ts`.

- [ ] **Step 1: Write the failing tests**
  - `taskApproval.test.ts`: "refuses approving an undecided or Later proposal; the person approves the task the PM shaped"
    (replaces "keeps a chosen agent binding when the person approves before PM preparation", which asserted the bypass);
    "a stored approval from before the decision does not carry over to the task the PM shapes" for accept and reshape;
    "a converted older proposal gets a fresh approval, never the card's decision".
  - `read/personalTasks.test.ts`: the capability table gives `canApprove` false for an undecided or Later proposal and true
    once it is accepted or reshaped.
- [ ] **Step 2: Run them and see them fail**
  Run: `cd backend && npx vitest run src/superTabs/taskApproval.test.ts src/superTabs/read/personalTasks.test.ts`
- [ ] **Step 3: Implement** the four changes above.
- [ ] **Step 4: Run them and see them pass**, with the tests of the code that imports what changed.
- [ ] **Step 5: Commit**
