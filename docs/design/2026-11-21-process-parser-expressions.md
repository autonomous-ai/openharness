# Reuse the process parser's expressions

The source-720999 Close/Resume comparison still holds release: Close latency is
28.40/28.62% higher and Resume CPU is 16.22/15.62% higher than the original
baseline. The two current-build V13 traces sample the process-row and command-path
parsers repeatedly. Those traces nominate work; their instrumented timings are
not acceptance evidence.

Each parser currently creates the same regular expression for every row. Keep
the two expressions private at module scope. Neither expression has a global or
sticky flag, so matching does not carry a cursor between rows. Keep the patterns,
field ownership, census admission, native reads and identity comparisons exact.

## Design

No stored or transmitted data, contract, authority, dependency or process changes.
The two existing fixed patterns live as long as their module. No rows, input text
or successful observations are cached. There is no new concurrency or migration
mechanism; rollback restores the two expression literals. The code runs on macOS,
Linux and Windows; native Windows validation is deferred by the user.

## Evidence and checks

Before changing production source, the fixed seven-shape raw ABBA probe
`20261120T173337.289875Z-89764` preserved every output. Command-path main-thread CPU
was 3.25/3.53% lower; long-argument row CPU was 9.85/10.72% lower. Other shapes were
inconclusive. This nominates a small change, not a release or original-baseline
performance result.

Run the existing parser, admission, ownership, process-lifetime and caller tests
and types. Compare the actual exported full reader on the unchanged seven-shape
workload, and the shared-census callers on their unchanged seven cases. Retain all
four arms and classify against same-side spread. An inconclusive result is not
proof of equivalence. Independent review and original-baseline validation remain
required; none of the earlier performance or extraction holds is cleared here.
