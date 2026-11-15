# The core's loop holds: notes

Packages 1 and 9 of [the plan](../2026-11-15-core-plan.md). Audit: section 3's first row and security 4.

## Step 1 (package 1): Codex's rollout read, bounded and asynchronous

Branch `core-loop-1`. A Codex resume read its whole rollout synchronously on the core's loop, twice when it repaired
(`engines/kit/resumeRepair.ts`, from `core/agents/launch.ts`), with `engines/resumeTranscript.ts` and
`engines/kit/zstdFrames.ts`; Codex's title index was read whole (`lib/sessionTitle.ts`). The step reads it in chunks,
with a size cap and a deadline, and a test holds the core's event loop on a large rollout made in a test home (it never
blocks more than about 50 ms).

## Steps 2 to 5 (package 9)

2. The repair runs in Codex's worker (engine-codex) under the launch's existing hold. The core takes its typed, bounded
   result. With the worker down, the resume goes on without the repair and says so. Copy how the Claude Code and Codex
   workers are reached today.
3. The login shell (`lib/engineBin.ts`, up to 5 s) and `harness-pty version` (`lib/ptyHost/launch.ts`, up to 5 s):
   asynchronous, with a deadline. First check whether they still run in the core: the New dialog's login shells moved
   to the edge host on 13 November.
4. The registry save never sleeps the loop: an async lock with the same exclusion between processes. Keep the fsyncs a
   save needs, and say which and why. Test crash safety and two writers; show save time before and after.
5. Create receipts (`lib/agentCreationReceipt.ts`) are deleted once they cannot matter, and their scan reads only what
   changed, bounded. Find what reads them and why first. Package 4 (git) wants a clone's progress shown through them:
   agree the shape with that package.
