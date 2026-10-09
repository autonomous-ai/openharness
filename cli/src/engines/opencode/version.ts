/**
 * Which generation of OpenCode is installed, read from the binary itself.
 *
 * The two generations take different command lines and keep sessions in different places, and a v1
 * command line kills a v2 pane: 2.0's TUI accepts only `--standalone --server --auto -c -s --prompt`
 * and exits 1 on anything else (`Unrecognized flag: -m in command opencode`). `-m` and `--agent` live
 * on `opencode run` now. So every launch that hands the TUI a flag asks this first.
 *
 * Read once per installed file, not once per daemon: OpenCode updates itself in place, and 1.18 → 2.0
 * arrived that way, under a running daemon. The file's size and mtime key the cache, so the next
 * launch after an update asks again and every other launch costs a `stat`.
 *
 * Unknown (not installed, or an answer that is not a version) is `null`. Launch flags retain their
 * v1 fallback; the hook installer waits for a confirmed v1 before writing the incompatible v1 plugin.
 */

export { isOpencodeV2, opencodeMajorVersion, parseOpencodeMajor } from '../launchControl.js'
export type { OpencodeVersionProbe } from '../launchControl.js'
