# A copied Node under Rosetta: a named refusal, not a 30 s timeout

## Problem

`scripts/local-checks.py --run` fails its `cli-harnessd` check on an Apple Silicon Mac: two or three re-exec tests in
`src/harnessd/master.spec.ts` time out (`until` waits 30 s). With no green check there is no receipt, which blocks other
pull requests.

## Cause (measured, M1 Pro, 2026-11-15)

The Node that ran the tests was nvm's `v22.21.1`, an x86_64 build, so Rosetta ran it. Rosetta translates a binary ahead
of time on the first run from each new path, and it caches that translation by path:

| Run | First | Second |
|---|---|---|
| x86_64 Node, a fresh copy (clone or plain copy) | 15.3 s | 0.08 s |
| the same copy, hard-linked to a new path | 16.1 s | |
| the same copy, moved to a new path | 14.5 s | |
| arm64 Node 22.21.1, a fresh copy | 0.30 s | 0.08 s |

Each slow run starts an `oahd-helper` (the Rosetta translator) in the unified log. `syspolicyd` and `amfid` also show,
and they cost the same on the arm64 copy (0.3 s in all), so this is not Gatekeeper or XProtect.

`placeNode` (`src/testing/placeNode.ts`) copies the test's Node, and the master then hard-links it to
`libexec/harnessd/harnessd-core` and the other process names (`processName.ts`). Each of those paths is new, so on a
Rosetta Node each one costs about 15 s. Two of them in one test come to 31 s, past the 30 s wait.

The same `master.spec.ts`, run on an arm64 Node 22.21.1 with `npm ci`: 60 of 60 pass in 23 s. On the x86_64 Node:
2 fail, 141 s.

## Change

`placeNode` refuses, with an error that names the cause and the fix, when the Node running the tests is an x86_64 build
under Rosetta: `process.platform` is `darwin`, `process.arch` is `x64` and the CPU is Apple's (`os.cpus()[0].model`
starts with `Apple`). An Intel Mac and an arm64 Node are unchanged. The error tells the developer to run the tests with
an arm64 Node. Every spec that copies a Node gets it: `master`, `processName` and `selfUpdate` through `placeNode`,
and `e2e/nodeReferences.e2e.ts`, which copies its own, from the same check (`refuseRosettaNode`) before it copies.
A symlink costs nothing (0.08 s), since it runs the file it names, so the specs that symlink their Node are unchanged.

No timeout changes. A test that copies Node cannot be made to hold under Rosetta without paying about 15 s for each new
path it runs. On an arm64 Node it is already well inside its budget.

## Receipts on this Mac

`local-checks.py --run` runs with an arm64 Node 22 on `PATH`, and with `npm ci` run under it, so the native packages
match. None of nvm's three Nodes here is arm64.

## Not in this change

Under Rosetta, `runtimeInstall.ts` `platformKey` picks the `darwin-x64` runtime (`process.arch`). A user whose Harness
runs under Rosetta then pays about 15 s for each `harnessd-*` link on its first run after a runtime install. That goes
to the maintainers as its own proposal.

## Test

`src/testing/placeNode.spec.ts`: given darwin, x64 and an Apple CPU, `placeNode` throws the named error and copies
nothing. Given darwin, arm64 or an Intel CPU, it copies as before. Red first.
