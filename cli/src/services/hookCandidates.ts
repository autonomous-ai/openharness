/** A setup request renders existing installers against immutable captured input, with no native writer. */
import { HookPreparationHeld, type HookPreparationAttempt, type HookPreparationFiles } from '../engines/kit/nativeHookFiles.js'
import { boundedHookInput, hookCandidate, HOOK_FILE_LIMIT, type NativeHookInput } from '../engines/kit/nativeHookWire.js'

export function createHookCandidates(input: NativeHookInput, current: () => boolean) {
  if (!boundedHookInput(input)) throw new HookPreparationHeld('the candidate inputs exceed their limits')
  const entries = new Map(input.files.map(file => [file.file, { ...file, revision: 0 }]))
  const check = () => { if (!current()) throw new HookPreparationHeld('the candidate owner changed') }
  const files: HookPreparationFiles = {
    // A rendered candidate is not an installation; core reports its publication or held outcome.
    report() {},
    inspect(file, defaultMode = 0o666) {
      check()
      const entry = entries.get(file)
      if (!entry) throw new HookPreparationHeld('the candidate destination was not captured')
      const { content, directory, revision } = entry, mode = entry.mode ?? defaultMode
      const verify = () => {
        check()
        if (entry.revision !== revision) throw new HookPreparationHeld('the candidate changed after observation')
      }
      const prepare = (next: string | null) => {
        verify()
        if (next === null && content !== null && entry.alias) throw new HookPreparationHeld('the candidate plugin entry is an alias')
        if (next !== null && Buffer.byteLength(next) > HOOK_FILE_LIMIT) throw new HookPreparationHeld('the candidate exceeds its size limit')
        if (content !== null && next !== null && content !== next && (mode & 0o200) === 0) throw new HookPreparationHeld('the candidate destination is read-only')
      }
      const replace = (next: string | null, attempt: HookPreparationAttempt) => {
        attempt.verify(); prepare(next)
        if (entry.content !== next) { entry.content = next; entry.revision++ }
        const published = files.inspect(file).verify
        attempt.observe(file, published)
        return { verify: published }
      }
      return { content, directory, mode, stamp: content === null ? null : String(revision), verify, prepare,
        async replace(next, attempt, exclusive) {
          if (exclusive && content !== null) throw new HookPreparationHeld('the candidate claim is occupied')
          return replace(next, attempt)
        },
        async remove(attempt) { return replace(null, attempt) },
      }
    },
    async run(destinations, work, options = {}) {
      check()
      const observations = new Map(destinations.map(file => [file, files.inspect(file).verify]))
      const verify = () => {
        check()
        if (options.current?.() === false) throw new HookPreparationHeld('the candidate owner changed')
        for (const observed of observations.values()) observed()
      }
      const attempt: HookPreparationAttempt = { check: verify, verify,
        observe(file, observed) {
          if (!entries.has(file)) throw new HookPreparationHeld('the candidate destination was not captured')
          observations.set(file, observed)
        },
        async flush() { throw new HookPreparationHeld('a candidate cannot flush a native descriptor') },
      }
      verify(); const result = await work(attempt); verify(); return result
    },
    directory(path, mode, attempt) {
      attempt.verify()
      if (!input.directories?.some(directory => directory.path === path && directory.mode === mode)) {
        throw new HookPreparationHeld('the candidate directory was not captured')
      }
    },
    async write(file, text, mode, attempt) {
      const published = await files.inspect(file, mode).replace(text, attempt)
      published.verify()
    },
  }
  return { files, candidate() {
    check()
    return hookCandidate({ version: 1, files: [...entries.values()].map((entry, index) => ({ index, content: entry.content })) }, entries.size)
  } }
}
