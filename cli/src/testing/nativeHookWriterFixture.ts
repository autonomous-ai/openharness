/** Kernel identity fixture for HTTP tests. Actual catalog, journal and staging
 * code still run against each test's private filesystem; no host PID is probed. */
import { NativeEvidenceBudget } from '../engines/kit/nativeEvidence.js'
import { NativePaths, verifyNativePathFacts } from '../engines/kit/nativePaths.js'

export async function fixtureNativeHookWriter(root: string) {
  const paths = new NativePaths(new NativeEvidenceBudget())
  paths.resolveSync(root)
  const facts = paths.snapshot()
  let closed = false
  return {
    writer: { boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', namespace: 'linux:4:5', pid: 8100, birth: '12345' },
    verifyWriter(input: string) {
      if (closed || input !== root) throw Error('fixture writer root is unavailable')
      verifyNativePathFacts(facts)
    },
    closeWriter() { closed = true },
  }
}
