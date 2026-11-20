# Hook routes and file observations at one fence

Status: source independently approved and callers validated; matched cost pending.

The V13 Close/Resume diagnostic records 11,064 synchronous metadata reads over
eight Resume requests, including separate route and file-observation passes at
the same preparation fence. Counts nominate the work; instrumented timing is not
performance evidence. Both checks describe the same ancestors for complete
destinations and absent leaves with existing parents.

## Design

- Growth: no persisted data, global success cache, timer or dependency. A private
  weak map associates a factory-created route verifier with its immutable facts
  and canonical destination keys. Its entries live no longer than that verifier.
- Concurrency: combine only when the existing observation union includes every
  reserved key and every retained route fact, with matching identity and alias
  evidence. Every invocation still reads all facts in two fresh passes. The reverse pass
  checks ordinary ancestors after descendants; aliases keep the existing union
  ordering. No successful
  observation survives the invocation. Owner, deadline, dependency callbacks,
  observation revision and all publication boundaries remain. Fallback callbacks
  are captured when the observation set changes; adding or replacing one during
  verification is refused by the revision check before any effect, rather than
  invoking the changed callback in the current iteration.
- Read cost: replace duplicate route plus observation traversals with the
  stronger file-version proof at that same fence. Conflicting, incomplete,
  oversized or custom observations retain the original separate checks.
- Scale: retain 32-observation and 256-fact bounds and fresh operation budgets.
  Caller read-count controls and quiet matched CPU/wall measurements check cost.
- Compatibility: no API, wire or saved-format change. Existing clients keep
  working. A revert restores the separate traversals; no migration is needed.
- Audience and identity: the core remains publication authority. A new route
  cannot replace the reserved route; aliases, account ownership, versions and
  in-pass device identity remain checked. Components gain no filesystem powers.
- Failure: changed routes/files, expired owners and changed observations still
  refuse publication. Existing fallback callbacks still run. No retries added.
- Platforms: shared macOS/Linux/Windows source; local macOS checks and final
  Linux integration required. Native Windows verification is deferred by owner.

Checks selected before implementation: existing caller resource assertions RED;
existing mutation/reentrancy/alias/absent-parent controls; new original-route,
uncovered-destination and custom-callback controls; all hook publication and
native launch callers, architecture and typecheck; independent source review;
quiet matched caller cost before another production Close/Resume comparison.

Baseline receipt `20261120T180257.678170Z-26329` records 18 failures and 87
passes: 16 expected resource assertions, the relocated absent-leaf mutation's
old route-level refusal class, and the observation-revision control moved to
the first combined pass. The changed source passes all 105 checks and typecheck
in `20261120T180359.031300Z-27202`. Single-destination controls and wider callers
remain to be validated; this is not performance acceptance.

Independent review found a refusal-class regression when a present reserved
leaf became an alias. The correction names that alias through the existing
failure-only metadata callback, which cannot authorize a mismatch by returning.
The callback also covers present facts; successful metadata reads are unchanged.
The optional-source complete-file fast path stays unchanged. Original-alias,
alias-version, both-pass device-change, extra-observation and returning-callback
controls accompany the fix. Receipts `20261120T180930.517381Z-32123` and
`20261120T181003.414116Z-32694` each show the two expected pre-fix failures.

The corrected source passes 1,178 tests across 35 caller files and typecheck in
`20261120T181051.954230Z-33361` (77.8 s and 42.4 s). Independent re-review approves
the source. Repository-wide call-site inspection confirms only the hook
observation verifier supplies the fifth metadata callback argument. A subsequent
comment-only edit corrects the existing alias-order description; emitted code
is checked against the exact independently reviewed bytes.

Two refusal-precedence differences remain, both before any effect: a missing
file appearing between passes now uses the settings-file hold instead of the
route-level identity hold; simultaneous unrelated identity replacement and alias
insertion may report the identity failure first. These are diagnostic names,
not changes to publication authority. No performance or release hold is cleared.
