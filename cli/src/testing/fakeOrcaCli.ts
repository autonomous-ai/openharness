/**
 * A fake `orca` for the specs and the end-to-end test of `harness device orca`, so none runs the person's Orca: every
 * session here runs inside it, and a real `orca plugin install` would ask it and write its data. It notes each run's
 * arguments, then prints what the test told it for that word as Orca 1.4.262 prints `--json` (one pretty-printed object
 * on stdout) and exits with its code; or, holding a plugin's approvals, answers as Orca does for that plugin and keeps
 * its entry: refused without the approval's fingerprint, installed with it, listed, disabled, uninstalled.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { shellSingleQuote } from '../lib/shellQuote.js'

export type FakeOrcaWord = 'status' | 'plugin inspect' | 'plugin list' | 'plugin install' | 'plugin update' | 'plugin enable' | 'plugin uninstall'
/** A plugin whose approvals Orca holds: its key, the version its folder holds, the fingerprint its approval takes and
 *  the grants Orca's refusal lists. */
export interface FakeOrcaPlugin { key: string; version: string; fingerprint: string; grants: Record<string, unknown> }
export interface FakeOrcaCli {
  bin: string
  /** What [word] prints from now on, pretty-printed as Orca prints --json, and its exit code. A word with no answer
   *  prints nothing and exits 1. A string is printed as it is: an answer that is not JSON. */
  answer(word: FakeOrcaWord, json: unknown, code?: number): void
  /** Every run's arguments, one line a run, in order. */
  calls(): string[]
  /** No answers and no plugin: every word exits 1. */
  reset(): void
  /** From now on an Orca that runs, at 1.4.262, holding [plugin]'s approvals: `status` and `plugin inspect` answer so;
   *  `plugin install <folder>`, `update <key>` and `enable <key>` without `--approve <fingerprint>` exit 3
   *  `approval_required` (data: pluginKey, name, version, approvalFingerprint, grants), and with it exit 0 and leave the
   *  entry `running` from the folder `install` was handed, by its real path (`update` and `enable` keep the entry's).
   *  `install` and `update` bring in [plugin]'s version; `enable` turns on the version the entry holds, as Orca enables
   *  the copy it installed, and its refusal names that version. `plugin uninstall <key>` removes it; `plugin list`
   *  lists it. A word given an `answer` answers that. The entry with [plugin]'s key in a `plugin list` answered before
   *  is the one it holds; that answer is dropped. */
  holds(plugin: FakeOrcaPlugin): void
  /** The person turned it off in Orca: the entry lists `status: disabled`. */
  disable(): void
  /** What `plugin list` lists now; undefined with no entry. */
  entry(): Record<string, unknown> | undefined
}

// An answer is two files in `answer/` named for its word: what it prints and its exit code. Any other word exits 1, as
// Orca does for a command it does not have. A plugin held is its files in `plugin/`, and its entry, when Orca lists one,
// is `entry.json`, its version `entry-version` and its source `source.json`, which `update` and `enable` keep. The
// refusal names the version a word would run in place of `@VERSION@`. A path is written into JSON as it is: a test's
// folders hold no character JSON escapes.
const script = (dir: string): string => `#!/bin/sh
dir=${shellSingleQuote(dir)}
printf '%s\\n' "$*" >> "$dir/calls"
case "$1" in
  status) word=status ;;
  plugin)
    case "$2" in
      inspect|list|install|update|enable|uninstall) word="plugin-$2" ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
if [ -f "$dir/answer/$word.json" ]; then
  cat "$dir/answer/$word.json"
  exit "$(cat "$dir/answer/$word.code")"
fi
held="$dir/plugin"
[ -d "$held" ] || exit 1
case "$word" in
  status|plugin-inspect) cat "$held/$word.json" ;;
  plugin-list)
    entry=
    [ -f "$held/entry.json" ] && entry=$(cat "$held/entry.json")
    printf '{"id":"req-3","ok":true,"result":{"plugins":[%s]}}\\n' "$entry" ;;
  plugin-uninstall)
    [ -f "$held/entry.json" ] || exit 1
    rm -f "$held/entry.json" "$held/entry-version" "$held/source.json"
    printf '{"id":"req-6","ok":true,"result":{"pluginKey":"%s"}}\\n' "$(cat "$held/key")" ;;
  *)
    [ "$word" = plugin-install ] || [ -f "$held/entry.json" ] || exit 1
    version=$(cat "$held/version")
    [ "$word" = plugin-enable ] && version=$(cat "$held/entry-version")
    if [ "$4" != --approve ] || [ "$5" != "$(cat "$held/fingerprint")" ]; then
      sed "s/@VERSION@/$version/g" "$held/refusal.json"
      exit 3
    fi
    if [ "$word" = plugin-install ]; then
      printf '{"kind":"local-path","reference":"%s"}' "$(cd "$3" && pwd -P)" > "$held/source.json"
    fi
    printf '%s' "$version" > "$held/entry-version"
    printf '{"pluginKey":"%s","name":"Harness Device","version":"%s","status":"running","needsReconsent":false,"isDev":false,"source":%s}' \\
      "$(cat "$held/key")" "$version" "$(cat "$held/source.json")" > "$held/entry.json"
    printf '{"id":"req-5","ok":true,"result":{"pluginKey":"%s","version":"%s"}}\\n' "$(cat "$held/key")" "$version" ;;
esac
`

const pretty = (json: unknown): string => `${JSON.stringify(json, null, 2)}\n`

/** A script at [bin] (default `<dir>/resources/bin/orca`, a path Orca's launcher check takes); its answers, its plugin
 *  and its log are in [dir]. */
export function fakeOrcaCli(dir: string, bin = join(dir, 'resources', 'bin', 'orca')): FakeOrcaCli {
  mkdirSync(dir, { recursive: true })
  mkdirSync(dirname(bin), { recursive: true })
  writeFileSync(bin, script(dir))
  // A file that was there keeps its mode through a write: the end-to-end test writes over its harness's launcher.
  chmodSync(bin, 0o755)
  const answers = join(dir, 'answer')
  const held = join(dir, 'plugin')
  const entryFile = join(held, 'entry.json')
  return {
    bin,
    answer(word, json, code = 0) {
      mkdirSync(answers, { recursive: true })
      const name = join(answers, word.replace(' ', '-'))
      writeFileSync(`${name}.code`, String(code))
      writeFileSync(`${name}.json`, typeof json === 'string' ? json : pretty(json))
    },
    calls() {
      try {
        return readFileSync(join(dir, 'calls'), 'utf8').split('\n').slice(0, -1)
      } catch {
        // No run yet.
        return []
      }
    },
    reset() {
      rmSync(answers, { recursive: true, force: true })
      rmSync(held, { recursive: true, force: true })
    },
    holds({ key, version, fingerprint, grants }) {
      rmSync(held, { recursive: true, force: true })
      mkdirSync(held)
      writeFileSync(join(held, 'key'), key)
      writeFileSync(join(held, 'version'), version)
      writeFileSync(join(held, 'fingerprint'), fingerprint)
      writeFileSync(join(held, 'status.json'), pretty({ id: 'req-1', ok: true, result: { app: { running: true }, runtime: { reachable: true, appVersion: '1.4.262' } } }))
      writeFileSync(join(held, 'plugin-inspect.json'), pretty({ id: 'req-2', ok: true, result: { plugin: { pluginKey: key, name: 'Harness Device', version } } }))
      writeFileSync(join(held, 'refusal.json'), pretty({
        id: 'req-4', ok: false,
        error: {
          code: 'approval_required', message: `${key} @VERSION@ needs approval before it can run.`,
          data: { pluginKey: key, name: 'Harness Device', version: '@VERSION@', approvalFingerprint: fingerprint, grants },
        },
      }))
      const listAnswer = join(answers, 'plugin-list')
      if (!existsSync(`${listAnswer}.json`)) return
      const plugins = (JSON.parse(readFileSync(`${listAnswer}.json`, 'utf8')) as { result: { plugins: Record<string, unknown>[] } }).result.plugins
      rmSync(`${listAnswer}.json`)
      rmSync(`${listAnswer}.code`)
      const listed = plugins.find((plugin) => plugin.pluginKey === key)
      if (listed === undefined) return
      writeFileSync(entryFile, JSON.stringify(listed))
      writeFileSync(join(held, 'entry-version'), String(listed.version))
      writeFileSync(join(held, 'source.json'), JSON.stringify(listed.source))
    },
    disable() {
      writeFileSync(entryFile, JSON.stringify({ ...JSON.parse(readFileSync(entryFile, 'utf8')) as Record<string, unknown>, status: 'disabled' }))
    },
    entry() {
      return existsSync(entryFile) ? JSON.parse(readFileSync(entryFile, 'utf8')) as Record<string, unknown> : undefined
    },
  }
}
