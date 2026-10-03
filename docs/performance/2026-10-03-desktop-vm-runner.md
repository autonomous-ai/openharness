# Bounded Desktop VM validation

The [Desktop baseline repair](2026-10-02-desktop-baseline-repair.md) needed manual
log reconciliation after an underused two-worker run was interrupted and three
Flutter tester startups failed. `make desktop-test` now chooses half the logical
CPUs, capped at eight workers, and records complete-file evidence automatically.
Named paths and `--workers` keep scoped checks explicit.

Every selected file must appear in Flutter's JSON reporter, every registered case
must finish, and setup/teardown errors still fail validation. Only the exact
pre-registration WebSocket loader error can cause one recovery attempt, with one
worker and the original time budget. Other errors, assertions, missing files,
incomplete reporters, timeouts and cleanup failures are not retried. The command
checks source, dependency, toolchain and environment identity before recovery and
after validation. It retains both attempts and labels recovered success separately.
The underlying WebSocket failure's external trigger remains unproven.

## Measurement

Source: `9c4ff1541791f739197cacb8277dc390e14a9413`. The working tree was clean and
source/toolchain/environment identities matched before and after execution.
[Machine-readable evidence](2026-10-03-desktop-vm-runner.json) includes all 526
file results and the original receipt/log hashes.

Host: Intel x86_64 macOS 26.6.2, 16 logical CPUs, 64 GiB RAM;
Flutter 3.47.2 / Dart 3.13.2. Dependencies and SDK were already installed.

```sh
python3 scripts/test-desktop.py --flutter /Users/autonomous/.local/share/flutter-3.47.2/bin/flutter --workers 8 --timeout 600
```

| Measurement | Result |
| --- | --- |
| Complete command, including identity checks | **6m51.461s** |
| Flutter test process | **6m42.447s** |
| Start → completion (UTC, October 2) | 17:31:21.927 → 17:38:13.455 |
| Coverage | All 526 VM files; 5,751 passing cases, 16 existing skips |
| Assertions, loader failures, recovery attempts | Zero |
| Process/reporter regression fixtures | 32 passing checks in 28.759s |

The previous baseline audit used 792.283 seconds at two workers before stopping,
156.524 seconds for the 149 remaining files at eight workers, and 6.152 seconds
for one isolated loader retry: **15m54.959s of test execution**, plus manual gaps.
The new complete command is about nine minutes shorter than that historical
execution total. This is an observed operational comparison, not a controlled
benchmark: cache warmth, host load and attempt structure differed. The only
intervening Desktop executable changes were the browser-guarded shortcut mapping
and its browser test. Do not promise the same reduction for every host or release.

Regression fixtures exercise real child processes and receipts, including recovery
of only the affected file, repeated loader failure, source edits, interrupted
reporters, assertions, hidden teardown failures, missing files, and budget expiry.
The shared runner's process cleanup and evidence-reuse checks also pass. A first
fixture run exposed a test-only macOS `/var` versus `/private/var` path mismatch;
the final fixtures use canonical paths, as the production command already did.

This change affects validation tooling and instructions. Browser and native tests
remain separate checks; their unchanged code was not revalidated here. It does
not establish a new end-to-end release time and does not publish a product release.
