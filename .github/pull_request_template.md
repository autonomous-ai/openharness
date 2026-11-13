## What does this help someone do?

Describe the result and why it is useful. Link an issue if there is one.

## How to try it

For a harness, include the install command, one example prompt, and the expected output.
For a visual change, include a screenshot or short recording.

## What did you verify?

List the checks you ran, the engine and operating system you used, and any known limitations.
For a harness, include `harness dsh check` and a real run of the example above.

For paths requiring local checks, the CI plan lists the check names. After
testing the final commit, run `python3 scripts/local-checks.py --run` from a
clean tree and paste its output into this body **before pushing that commit or
marking the PR ready**. It runs each required check on that commit and prints
their receipts, or nothing when no local check is required. Body edits alone do
not start another CI run. These are attestations of successful complete checks,
not a way to waive failures. Native checks require `macos`.

Record the tested commit/tree (or dirty-source fingerprint), check scope, and result links.
When reusing CI or baseline evidence, link it and explain why it still covers this diff.
For a release task, record request → checks complete → merge → live → completion times;
mark unavailable timestamps unknown. Do not substitute build duration for total elapsed time.

<!-- New harness? Credit upstream authors, include its license, and mention any required accounts
     or paid tools. A small working contribution is welcome; a separate issue is optional. -->
