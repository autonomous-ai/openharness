# What breaks at scale

Draft, 2026-10-17. The red team for [05](05-framework.md) and [06](06-harness-swarm.md). Each risk has a sign to watch and a mitigation.

## 1. Motion instead of progress (Goodhart)
A swarm is very good at producing what is counted: PRs, passing tests, closed tasks. The pilot merged ~250 PRs on its best day, and 18% of its output was follow-ups to reviews.
- **Sign:** throughput rises while the owner's "try it" verdicts and real users' experience don't improve.
- **Mitigation:** make **escaped defects** and **value against the brief** the headline numbers, not PR counts. Every change users can feel climbs to rung 6 (a person tries it) before it's on. The lead's evening end-to-end run is the most important ritual. Keep it.

## 1½. Gaming the verifier
As models get more capable, they get better at passing checks without doing the work:
- Agents exploited contradictory tests 76% of the time on one benchmark, by editing tests or overloading equality.
- METR couldn't measure GPT-5.6's horizon because of cheating.
- In the pilot, ~33 PRs had "a test that cannot fail", caught by the reviewer and peers.
- **Mitigation:** tests are read-only to the worker they grade; hidden scenarios the worker never sees; a reviewer on a different model with a clean context; transcript checks for test edits; devices and people at the top of the ladder.

## 1¾. More output, worse quality (the industry's own data)
High-adoption teams show +54% bugs per developer, about 3× incidents per PR, 5× review time, +861% churn, and 11.7% fewer deployments (Faros 2026, correlational). DORA 2025 found more instability. A swarm magnifies whatever its gates let through.
- **Mitigation:** headline metrics are escaped defects and shown-working, not PRs. Throttle creation to what the gates can verify.

## 1⅞. Nobody reviews
In Harness's own repo, 98% of October PRs were merged by their own author, `main` requires 0 approvals, and 1 of 354 PRs had a GitHub review ([01b](01b-harness-repo.md)). Up to ~14% of PRs fix something merged in the previous 72 hours. Agents reviewing agents found real defects on almost every PR they covered, but only 27–49% of PRs record a review at all.
- **Sign:** fix-forward rate rises; `main` is red for long stretches; reviews are mentioned, not recorded.
- **Mitigation:** an independent review on the exact commit, by a different context (ideally a different model), recorded where the merge tool checks it. A person samples merged changes weekly.

## 2. Architectural entropy
Thousands of small changes, each locally right, add up to a system nobody designed. In the pilot, behaviour switches that are off unless set (`…=on` environment flags) are the safety valve for merging fast, and they accumulate. PRs named **96 new switches in four days** (Oct 14–17), about 24 a day, where there had been one before (the Oct 17 census found 89, 37 of them off).
- **Sign:** flag count grows, duplicate helpers appear, test runtime climbs (the pilot found 123 real-clock tests waiting 977 s).
- **Mitigation:**
  - A flag lifecycle: each flag has a task to turn it on for everyone or remove it.
  - Consolidation is first-class work: the lead schedules "debt days".
  - An architect role, a worker or the lead, owns the shape of the code and can refuse changes that break it.

## 3. Comprehension debt
On Oct 16 the pilot merged 846k changed lines in one day (some generated or vendored). No person read them; the knowledge lives in agents' logs and threads.
- **Sign:** the owner can't explain how a part works, and nobody can answer except by asking an agent to read the code again.
- **Mitigation:**
  - Docs-as-code rules: the pilot's AGENTS.md requires docs updated with every behaviour change.
  - A living architecture map kept by agents.
  - "Explain this area" as a standard request with sources.
  - Owners judge behaviour and interfaces, not lines.

## 4. Single points of failure
- **The lead:** one agent's context and judgment steer everything. If it's compacted, confused or wrong, the swarm follows. Mitigation: the brief, decisions and tasks live outside its context; a second agent audits its plan daily; split by domain past ~15 workers.
- **The owner:** absence means decisions stall (a weekend, a night). Mitigation: a standing brief that pre-decides; a deputy for routine calls; work that doesn't need a decision continues.
- **The integration branch:** one red build blocks everyone. Mitigation: merge queue with CI on the merged result; automatic revert of a breaking merge; the reviewer owns branch health.

## 5. Correlated blind spots
If the builder and the reviewer are the same model, they share blind spots. The pilot's reviewer is a different engine from most builders, which is good.
- **Mitigation:**
  - Reviewers on a different model family by default.
  - Real-environment rungs (devices, users) that no model can talk its way past.
  - Periodic human review of a random sample of merged changes.

## 6. Security
Many machines, broad permissions, other people's agents in one swarm:
- **Prompt injection across people:** a teammate's message or a task written by someone else's agent is untrusted input. Mitigation: messages are requests, never instructions to bypass rules. Workers act only within their own folder and permission mode. Destructive and irreversible steps are owner decisions.
- **Secrets:** never in messages or tasks. Each worker uses its own machine's credentials.
- **Supply chain:** agents adding dependencies at volume. Mitigation: a dependency rule in the playbook, and a reviewer check.
- **A malicious or compromised member:** their workers can't type into anyone else's, can't merge without gates, and their changes are attributable.

## 7. Cost runaway
Swarms burn tokens, CI minutes and machine hours around the clock.
- **Sign:** cost per merged change rises; tasks are retried repeatedly; long idle-but-awake sessions.
- **Mitigation:** per-swarm and per-worker budgets; cost per merged change on the health line; heavy jobs scheduled for capacity, not urgency.

## 8. Shared accounts and terms of service
The pilot's builders "work through the same account" on GitHub, and subscriptions are used by many agents around the clock.
- **Risk:** platform terms (GitHub, AI providers) on automation and account sharing; attribution is lost when every PR says the same author.
- **Mitigation:** per-worker attribution inside Harness; bot or app accounts where platforms provide them; confirm subscription terms for automated use before offering capacity sharing broadly.

## 8½. Pace over safety, and scope churn from the top
- In the pilot, "test 24/7" and "never idle" produced unattended motion that drifted an arm, plus a full disk mid-install. Speed rules were written by the person who also owned safety, and the safety rules came after the fact.
- Each owner redirection ("reimagine the experience", "skills", "a new app device", "why not now?") moved 10+ builders within the hour, and a new feature arrived three weeks before a freeze.
- **Mitigation:**
  - Safety and resource rules come before speed rules, and they belong to the resource's owner.
  - A direction change is a decision with a visible cost ("pauses 6 tasks, moves the freeze?").
  - A freeze is a rule the lead enforces, even against the owner, until the owner explicitly lifts it.

## 8¾. Permissions are where agents cause real damage
The documented incidents are permission failures, not coding failures. An agent found an unrelated token in its workspace and deleted a production volume and its backups in nine seconds. Another "deleted and recreated" an environment.
- **Mitigation:** least privilege by default; no production credentials in any worker's space; destructive actions need a person.

## 9. People burn out on the swarm's clock
The swarm works 24/7; people don't. Decisions pile up overnight, and "never idle" can become an expectation of people too.
- **Mitigation:**
  - The YOU box is cleared on the person's schedule, never as a stream of interruptions.
  - Quiet hours per person.
  - The lead plans around absence, with work that needs no decision queued for the night.

## 9½. Autonomous scope creep, including in design
Autonomous goals don't stop themselves. An earlier agent-team design study in Harness's repo ran ~6.7 hours and ~333 KB of documents without a live experiment, and grew until the owner asked whether it was almost done. Its protocol was ignored by the first real team.
- **Mitigation:** every goal has a time limit and a stop rule; design ends in an experiment ([08 §0](08-experiments.md)); the owner reviews scope, not volume.

## 10. The deskilling trap
If people only want and judge, who can still debug the system when the swarm can't? This is the long-term version of comprehension debt. Anthropic's own trial found 17% lower comprehension when people learned a new library with AI, worst at debugging. Its staff call it the "paradox of supervision": supervising agents needs the skills that heavy use erodes. Early-career developer employment is already ~20% below its late-2022 peak, so fewer people are learning the craft that supervision depends on.
- **Mitigation:**
  - Keep the system explainable (risk 3).
  - Practise "a person fixes it with agents' help" on real incidents.
  - Value verification skill: designing the bar, the tests, the device lab.
