/**
 * A fake `orca` for the specs and the end-to-end test of `harness device orca`, so none runs the person's Orca: every
 * session here runs inside it, and a real `orca plugin install` would ask it and write its data. It notes each run's
 * arguments, then prints what the test told it for that word as Orca 1.4.262 prints `--json` (one pretty-printed object
 * on stdout) and exits with its code.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { shellSingleQuote } from '../lib/shellQuote.js'

export type FakeOrcaWord = 'status' | 'plugin inspect' | 'plugin list' | 'plugin install' | 'plugin update' | 'plugin enable'
export interface FakeOrcaCli {
  bin: string
  /** What [word] prints from now on, pretty-printed as Orca prints --json, and its exit code. A word with no answer
   *  prints nothing and exits 1. A string is printed as it is: an answer that is not JSON. */
  answer(word: FakeOrcaWord, json: unknown, code?: number): void
  /** Every run's arguments, one line a run, in order. */
  calls(): string[]
}

// An answer is two files named for its word: what it prints and its exit code. Any other word exits 1, as Orca does
// for a command it does not have.
const script = (dir: string): string => `#!/bin/sh
dir=${shellSingleQuote(dir)}
printf '%s\\n' "$*" >> "$dir/calls"
case "$1" in
  status) word=status ;;
  plugin)
    case "$2" in
      inspect|list|install|update|enable) word="plugin-$2" ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
[ -f "$dir/$word.json" ] || exit 1
cat "$dir/$word.json"
exit "$(cat "$dir/$word.code")"
`

/** A script at [bin] (default `<dir>/resources/bin/orca`, a path Orca's launcher check takes); its answers and its log
 *  are in [dir]. */
export function fakeOrcaCli(dir: string, bin = join(dir, 'resources', 'bin', 'orca')): FakeOrcaCli {
  mkdirSync(dir, { recursive: true })
  mkdirSync(dirname(bin), { recursive: true })
  writeFileSync(bin, script(dir))
  // A file that was there keeps its mode through a write: the end-to-end test writes over its harness's launcher.
  chmodSync(bin, 0o755)
  return {
    bin,
    answer(word, json, code = 0) {
      const name = join(dir, word.replace(' ', '-'))
      writeFileSync(`${name}.code`, String(code))
      writeFileSync(`${name}.json`, typeof json === 'string' ? json : `${JSON.stringify(json, null, 2)}\n`)
    },
    calls() {
      try {
        return readFileSync(join(dir, 'calls'), 'utf8').split('\n').slice(0, -1)
      } catch {
        // No run yet.
        return []
      }
    },
  }
}
