## What does this help someone do?

Describe the result and why it is useful. Link an issue if there is one.

## How to try it

For a harness, include the install command, one example prompt, and the expected output.
For a visual change, include a screenshot or short recording.

## What did you verify?

List the checks you ran, the engine and operating system you used, and any known limitations.
For a harness, include `harness dsh check` and a real run of the example above.

For paths requiring local checks, the CI plan lists the check names. Run
`python3 scripts/local-checks.py --list PATH...` for their commands and working
directories. After testing the final commit, put its receipts in one JSON fence
like this **before pushing that commit or marking the PR ready**. Replace the
example with actual results; omit the fence when no local check is required.
Body edits alone do not start another CI run. These are attestations of successful
complete checks, not a way to waive failures. Native checks require `macos`.

```harness-local-checks
[
  {"check":"cli-core","command":"npm run test:core","cwd":"cli","head":"FULL_40_CHARACTER_TESTED_HEAD","status":"passed","passed":123,"platform":"macos"}
]
```

Use a positive test count; zero, failed, stale-head and wrong-platform receipts
cannot satisfy the gate. Coverage commands may add ` -- --maxWorkers=2` to cap
resources. Do not include logs, personal paths or environment values.

Record the tested commit/tree (or dirty-source fingerprint), check scope, and result links.
When reusing CI or baseline evidence, link it and explain why it still covers this diff.
For a release task, record request → checks complete → merge → live → completion times;
mark unavailable timestamps unknown. Do not substitute build duration for total elapsed time.

<!-- New harness? Credit upstream authors, include its license, and mention any required accounts
     or paid tools. A small working contribution is welcome; a separate issue is optional. -->
