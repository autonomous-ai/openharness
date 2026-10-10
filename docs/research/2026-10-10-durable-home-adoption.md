# Durable engine-home adoption

An adopted Claude Code or Codex home must be durable before core treats it as usable or installs its hooks. The former writer merged process-local arrays and overwrote one JSON file, swallowing write failures. Concurrent writers could lose each other's homes; a failed write could still look successful to the hook coordinator.

## Publication and recovery

The existing `engine-homes.json` remains an imported baseline. New additions are immutable, exclusively linked numbered records in `engine-homes.json.adoptions`. Each record identifies its predecessor and contains positive additions and the requirement to retain an observed baseline. Publication flushes the staged record before linking, the record and directory before confirmation, and the confirmation's parent before acknowledging. The initial confirmation is outside the journal (`engine-homes.json.adopted`); subsequent confirmations live in `engine-homes.json.confirmations`. Losing a committed tail or the journal therefore cannot silently resemble an older complete catalog.

A publication loser rebases on the winner, with four attempts and a shared 250 ms work deadline. Complete published intentions can be confirmed after a crash even when the next login environment no longer names their home. Empty abandoned initialization without a complete intention stays held. No published record, baseline, foreign configuration, or abandoned staging file is removed or overwritten. Only a writer's own staging file is unlinked.

Reads are fresh and bounded: 63 moved homes per engine, 128 numbered slots, 64 KiB combined catalog text, regular account-owned files without group/world write permission, descriptor/path version checks, strict UTF-8 and schema, contiguous hash-linked records, complete outside confirmations, and a final membership check. Directory iterators are not trusted to establish absence by themselves: every bounded numbered slot is checked independently, and the directory's full metadata stamp is checked across enumeration. Missing-slot checks avoid constructing an ENOENT exception for each absent name.

The per-catalog adopter retains bounded positive observations and required baseline presence across held calls. These observations can require a hold but cannot supply usable session roots. Overflow stays held. Confirmation, empty-environment recovery, and native omission checks share that state; changing the catalog or resetting the test seam does not transfer it elsewhere.

The core coordinator separately acknowledges adoption and hook installation, retries failures with a reason, refreshes peer homes after confirmation, and closes before daemon teardown. It retains only the two home variables, never the rest of the login environment. Native installers that swallow their own write errors still need the separate launch/hook migration in the completion checklist; this coordinator can retry errors that reach it.

## Bulk registry reads

An initial measurement found a material recurring cost: 200 independent legacy home lookups over 63 journal records took about 3.95 seconds; avoiding ENOENT exceptions reduced that only to 3.14 seconds. Those exploratory results prompted an explicit batch proof, not a cache.

Registry load acquires one immutable catalog snapshot for its synchronous batch. It stages binding decisions, verifies the catalog again, then publishes the rows. Unavailable or changed home evidence preserves the original bindings and attaches an `identityHold` reason to the shared frame. The reason is transient, retained across saves of the same binding, and never persisted as proof. Independent native operations continue to read fresh evidence. The former session-store golden covers healthy registry loading unchanged.

This is the catalog portion of registry loading. Legacy header/repair reads, admission, restore/restart preflight and automatic per-row retry are still part of the remaining caller migration; no claim is made that those paths are finished.

## Matched cost

[Raw measurements](2026-10-10-home-adoption-cost.json) compare main `9eafacf3b` with implementation `0944754af` on Node 22.23.2, macOS x64, under UTC and `/tmp`. Three interleaved fresh-process repetitions cover each source and workload (24 processes), without concurrent local validation, from 01:24:20 to 01:24:28 UTC on October 10. Each native workload makes 25 independent reads; each registry workload makes 200 bound-home lookups, including the candidate's initial snapshot and final verification. One and 63 adopted homes are tested; candidate journal fixtures have the matching number of records. All calls returned complete evidence.

| Workload | Main elapsed / CPU (ms) | Candidate elapsed / CPU (ms) | Main / candidate peak RSS (MiB) |
| --- | ---: | ---: | ---: |
| Native, one home | 3.17 / 6.50 | 61.09 / 94.76 | 80.54 / 90.59 |
| Native, 63 homes | 6.44 / 14.30 | 439.43 / 514.44 | 82.79 / 91.75 |
| Registry batch, one home | 5.38 / 11.48 | 12.78 / 30.05 | 81.84 / 87.18 |
| Registry batch, 63 homes | 18.74 / 44.88 | 64.75 / 97.86 | 87.94 / 90.57 |

Values are medians across the three processes. Elapsed and CPU include the whole operation; imports and fixture construction are excluded, while peak RSS includes the process. Per-row latency samples exclude the batch proofs and must not be used as the whole-batch cost. Independent reads pay for fresh durable evidence (about 17.6 ms per read at 63 records in this workload); the explicit batch avoids paying that cost for every registry row. This is measured cost, not a claimed performance threshold. Subsequent lifecycle corrections only clear a transient reason when releasing or saving a stopped binding; the measured catalog and batch algorithms are unchanged.

## Compatibility and limits

The logical healthy catalog answers remain unchanged, but the physical persistence format changes. Older binaries only understand the imported baseline and do not discover homes written solely to the journal. This work does not claim downgrade compatibility. No CLI release is authorized. The user-owned baseline is preserved byte for byte, including when it is malformed or unavailable.

The checks detect bounded changes and incomplete evidence; they cannot cancel a blocked kernel filesystem operation or create an atomic snapshot of unrelated paths. Simultaneous erasure of every independent on-disk witness cannot be distinguished from a new installation by a fresh process. In-memory unacknowledged observations cannot survive process death unless their intent was published.

## Golden and validation evidence

The home-adoption golden was recorded from former main before production changes, in `843af5c3a`. Fresh-reader adapters and fixed performance clocks were first replayed against former code and committed separately (`92b48b8e7`, `227018162`, `74e030ea7`). Golden artifacts remain unchanged. Their private homes, pinned platforms, fixed clocks and forbidden host binaries make them independent of the host; commands use UTC and `/tmp`.

The validation plan includes typecheck, architecture, core/services and harnessd coverage at 100%, touched registry/home/repair/golden specs, serial resume, and private enginehomes/machine/chaos/tmux acceptance. The full Linux unit suite is provided by automatic ready-PR CI. Mutations run only in an owned disposable worktree, after a green baseline, and must fail an assertion rather than merely fail to import. Matched cost runs separately from local validation.

Independent review produced regressions for empty-environment recovery, late pool additions, imported baselines appearing during publication, ancestor/iterator redirection, peer hook recovery, directory changes after a numbered slot was checked, and observations lost across a held call. The final pass also found a hold reason surviving binding release and leaking into stopped snapshots. Public unbind/release routes now clear it, and stopped persistence strips it; regressions check sibling holds and raw saved bytes. Exact-head/base approval is recorded in [PR #1132](https://github.com/autonomous-ai/openharness/pull/1132) before landing.

Receipt `20261010T012509.817212Z-63290` on `0944754af` passed typecheck, 1,952 core/services tests across 163 files at 100% coverage, 265 harnessd tests at 100% with one existing skip, all 34 private enginehomes/machine/chaos tests, and 57 private tmux tests across six files (15 installed-vendor rows excluded). Seventeen focused files passed; the large-transcript resume file had one timeout under concurrent load. It must pass alone before landing. The unchanged golden baseline passed before all 19 initial wiring mutations failed assertions. Two additional mutations cover the final lifecycle corrections. Final corrected-source coverage, focused/serial results and exact-head automatic CI evidence are recorded in the PR before merge.

Intermediate failures are not counted as passing: one typecheck found a null narrowing error; a registry fixture depended on denied host boot-time inspection; a mock retained a previous test's module environment; and a save initially stripped the transient hold reason. Each received a correction and a targeted regression. The mutation runner also needed a unique directory-flush selector and a shutdown mutation that actually disconnected the close fence; neither runner error was counted as a caught mutant. Draft-only CI deliberately withholds `ci/required` until the PR is ready.

Implementation, validation, independent review/CI waiting, and merge are recorded separately in the PR. Publication remains zero.
