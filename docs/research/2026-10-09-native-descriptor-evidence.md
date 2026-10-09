# Native conversation ownership through process and descriptor evidence

A partial process or open-file listing could previously look like an empty or unique Codex conversation. Discovery could choose a sibling; Stop could save no identity before terminating the process. This change makes unavailable, ambiguous and changing native evidence a typed `IDENTITY_UNAVAILABLE` hold. Binding, Stop and Close retain the session and its reason; a later complete lookup can recover without restarting the engine. The private daemon regression verifies readiness and a sibling continue during the outage.

## Authority and bounds

The eager reader retains the expected process generation, executable, actual Linux argv, complete launcher child set, numeric descriptor pool, lossless device/inode keys, physical directory membership and every candidate header. Duplicate descriptors and hard links deduplicate by file identity. Invalid or unknown source metadata, malformed delegated claims and unreadable competing workspaces cannot make another candidate unique. macOS escaped names are resolved against kernel file keys. Directory aliases use physical identity, including case and normalization aliases; ancestor replacement and symlink target changes hold.

The final read joins process and descriptor observations, then synchronously checks path and header evidence with the selected header last. Alternating asynchronous process and descriptor probes always left one observation stale across the last wait. Linux uses bounded synchronous `/proc` reads, including children of every thread. macOS extends the existing bundled read-only helper with a strict `--control` protocol. It compares two complete bounded passes, process birth microseconds, image, command identity, descriptor table capacity, direct children and file keys. The optional discovery `--paths` protocol remains compatible.

The macOS command record can contain environment strings, and a rewritten process title can destroy its argv boundaries. The helper emits only a digest of the bounded raw command record; it never serializes those bytes as argv or environment. The existing single-row `ps` command text is bracketed by native identity checks. This follows the [XNU process-argument implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sysctl.c); descriptor and zombie handling follow [process inspection](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/proc_info.c) and [libproc](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.c). The lsof parser validates the complete [NUL field protocol](https://lsof.readthedocs.io/en/stable/manpage/), including record terminators, owners, types and numeric fields. Errors or stderr invalidate the entire reply, even beside plausible output.

One lookup shares a three-second monotonic budget, 32,768 work operations, 16 MiB of accounted bytes and 64 subprocess probes. Additional caps cover 4,096 graph entries/descriptors, 32 children, 128 Linux threads, 64 homes/candidates, 64 KiB process commands and 256 path components. Subprocesses receive the remaining deadline and SIGKILL on timeout. Filesystem operations are bounded in count and bytes; this is bounded re-observation, not an atomic OS snapshot or a promise that the OS can cancel a blocked filesystem call.

Claude PID records retain a synchronous proof across Stop's final asynchronous process check. It rechecks the complete positive, stale and absent record pool, path ancestry and home set, with the selected record last. A same-process conversation switch during that final wait holds before checkpointing, saving, signaling, terminating or retiring anything.

Only extraction of the immutable bundled executable is cached. Process, descriptor and header results are always fresh. A deleted private helper cache produces a hold and is recreated from pinned bytes on the next control request without waiting for discovery. Existing foreign or invalid cache files are preserved. On macOS, source development without the native artifact holds strict control reads; it does not fall back to permissive process evidence. Build a fresh artifact before native source integration tests:

```sh
python3 cli/scripts/build-process-images.py --output /tmp/private-process-images.json
export HARNESS_PROCESS_IMAGES_ARTIFACT=/tmp/private-process-images.json
```

Use a fresh output filename, private test homes and tmux sockets, unset `TMUX` and `TMUX_PANE`, and run with `TZ=UTC TMPDIR=/tmp`. Portable CLI builds already require and verify the universal artifact. No release is part of this work.

## Golden, review and validation

Linux observations were committed before production changes in `f247154e6`; six healthy macOS observations followed in `b53acda12`, also before the move. The 29-observation artifact remains byte-for-byte unchanged: SHA-256 `1a3a23dde27f550b8ab0eb68d2e9cddb686722aaedc5d552563e4aa910a9778a`. Tests pin the platform, UTC, time and private filesystem; every host binary in the golden is replaced or forbidden. Former unsafe answers in the older session-store golden are explicitly asserted before named safety corrections expect a hold.

Independent review caught process/descriptor await ordering, alias replacement, malformed metadata, descriptor table growth, source-only helper recovery and the composed Claude record race. The private outage case caught BSD `ps` formatting when `comm` was the last column; using the discovery-compatible column placement preserves healthy titles. Focused regressions cover each correction. The separate reviewer also required bounded fixture lifetimes so a smoke-check timeout cannot orphan a child.

Local acceptance on October 9 passed typecheck, architecture and 589 focused assertions; 1,944 core/service assertions and 265 harnessd assertions met every 100% coverage threshold. The existing harnessd skip remains. All 29 private enginehomes, machine and 70-operation chaos cases passed, as did 57 private tmux cases; 15 vendor-dependent tmux rows were explicitly excluded. Fourteen native C checks passed, and the bundled control/cache-recovery path passed on macOS x64. Receipt: `20261009T234506.200411Z-27373`; native C reused its unchanged source/toolchain evidence from `20261009T232820.565516Z-55666`. Script-only cleanup and fixture lifetime corrections follow this receipt and receive their affected checks separately. Serial resume coverage, deliberate broken wiring, matched cost and final exact-head review are recorded when complete; unfinished or failed runs are not counted as passes.

## Timing and remaining scope

Work resumed October 9 at 22:25:51 UTC after the owner's pause. Golden preparation ended at 22:32; implementation and independent-review corrections continued through 23:45. The first complete acceptance ran 23:45:06–23:52:08 UTC, overlapping review and the isolated mutation work. Later validation, measurement, CI waiting and merge are recorded separately in the PR. Publication remains zero.

This closes the descriptor authority boundary and the newly exposed PID-record ordering race. It does not complete the [daemon core checklist](2026-10-09-daemon-core-completion.md): durable catalog writers and legacy registry callers, shared hold/retry state, launch preparation and lifecycle intent, and the remaining turn/input/Close acceptance remain separate work.
