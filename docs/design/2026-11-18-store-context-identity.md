# Store launch context uses the registered machine

The packaged supervised WiFi Store creation test installed and inspected its package, then failed with
`DSH_UNAVAILABLE`. `runStoreService` compared the daemon query's backend registration ID with the service
startup's local computer ID. Those identify different things: `serviceProcess.ts` uses
`readOrMintComputerId`, while `CoreApi.daemon.machineId()` reads the backend registration. The test had
used the same string for both and incorrectly required a differing registration to fail.

## Design

Use the daemon address returned by the current authenticated service connection. Keep the physical
connection and abort checks before opening the context request and after it finishes. The existing
local request handshake still checks the selected registration ID, transport and protocol. No new
identity authority or cached identity is introduced.
Require a nonempty registration ID of at most 200 characters and a valid integer port before even
the known backend-account fast path, which can return without opening a context socket.

- Growth: N/A; no stored data or retained state is added.
- Concurrency: the existing connection object and abort signal fence replacement, disconnect and stop.
- Read cost: the same one daemon query; remove one invalid string comparison.
- Scale: N/A; this does not add a list, fan-out, query or limit.
- Compatibility: no wire or public contract changes; both signed-in and signed-out IDs remain usable.
- Migration and rollback: no migration; revert this small service change to restore the prior behavior.
- Audience: the existing authenticated local service connection supplies the address, and the local
  context request checks the daemon's selected registration before sending its request.
- Identity: no user login is substituted; local computer identity and backend registration remain distinct.
- Failure: absent/malformed addresses and obsolete physical connections still fail; request errors use
  the existing Store diagnostics and public unavailable result.
- Platforms: shared TypeScript on macOS, Linux and Windows. Run the packaged regression on macOS;
  native Windows validation is deferred by the user.

## Validation

First reproduce through the real Store request table with distinct computer and registered machine
IDs. Preserve tests for malformed addresses and replacement/disconnect/stop, then run the affected
Store process/context/request suites with full coverage of changed runtime code and TypeScript.
The packaged two-mode Store creation regression remains the final acceptance check for this correction
and the separate WiFi view freshness fix.

The unchanged runtime failed the distinct-ID caller test (14 controls passed):
`.harness/validation/20261118T162459.763009Z-55805/receipt.json`, with
`Store context connection changed` at the invalid equality check.

Independent review found that simply deleting the equality allowed empty/oversized IDs and unusable
ports through the backend-account fast path. Eight malformed-address controls then failed before
adding those shape guards, while 16 other controls passed:
`.harness/validation/20261118T162828.656244Z-59481/receipt.json`.

Final source validation passed 86 tests in four files, with `storeProcess.ts`, `storeContext.ts`,
`storeLaunch.ts` and `agentLife.ts` at 100% on every coverage measure, plus TypeScript:
`.harness/validation/20261118T162923.979017Z-60537/receipt.json`. The original combined 839 core run
passed all 6,437 tests but failed its coverage gate on unattributed input; the additional lifecycle
caller case closes that specific branch gap without changing runtime behavior. The existing real
`cancel` and Store-context callers additionally passed 65 tests in two files, covering `requestOnce.ts`
at 100%: `.harness/validation/20261118T162744.368610Z-58828/receipt.json`. The first selection named
a nonexistent `requestOnce.spec.ts`; its actual 77-test/four-file receipt is retained, not counted
as five files or transport coverage. No full-core or packaged acceptance is implied by these checks.
