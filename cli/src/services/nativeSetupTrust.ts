/** Optional bounded trust and inherited-MCP preparation; no file is written in this process. */
import { dirname, join } from 'node:path'
import { launchContract } from '../engines/launches.js'
import { prepareTrustText, trustsText } from '../engines/kit/folderTrust.js'
import { mcpObject, prepareInheritedMcp } from '../engines/kit/inheritedMcp.js'
import { inspectHookFile } from '../engines/kit/nativeHookFiles.js'
import { NativePaths } from '../engines/kit/nativePaths.js'
import { NativeEvidenceBudget } from '../engines/kit/nativeEvidence.js'
import { hookCandidate, type NativeHookCandidate } from '../engines/kit/nativeHookWire.js'
import { boundedTrustInput, type NativeTrustInput } from '../engines/kit/nativeTrustWire.js'

export function prepareNativeTrust(input: NativeTrustInput, current: () => boolean): NativeHookCandidate | null {
  if (!current() || !boundedTrustInput(input)) return null
  const contract = launchContract(input.engine)!, trust = contract.trust!
  const text = input.files[0].content
  if (input.source && (text === null || !trustsText(trust, text, input.source))) return null
  const contents = input.files.map(file => file.content)
  if (text !== null) contents[0] = prepareTrustText(trust, text, input.cwd).text
  const evidence: Array<{ verify(): void }> = []
  let remaining = 4 * 1024 * 1024 - contents.reduce<number>((bytes, text) => bytes + (text === null ? 0 : Buffer.byteLength(text)), 0)
  const read = (file: string) => {
    if (!current()) throw Error('Preparation revoked')
    // The publisher inspects destinations with an existing parent. An absent read at
    // the filesystem root has no such parent fact; retain its absence directly.
    const paths = new NativePaths(new NativeEvidenceBudget())
    if (!paths.resolveSync(file, true)) { evidence.push({ verify: paths.retain() }); return null }
    const observed = inspectHookFile(file)
    remaining -= observed.content === null ? 0 : Buffer.byteLength(observed.content)
    if (remaining < 0) throw Error('Trust evidence exceeds its limit')
    evidence.push(observed)
    return observed.content
  }
  if (contract.inheritedMcp) {
    const mcp = contract.inheritedMcp, found = new Set<string>()
    for (let above = dirname(input.cwd), depth = 0; ; above = dirname(above), depth++) {
      if (depth >= 64) return null
      const servers = mcpObject(read(join(above, mcp.file)))?.[mcp.servers]
      if (servers && typeof servers === 'object' && !Array.isArray(servers)) for (const name of Object.keys(servers)) {
        if (Buffer.byteLength(name) > 4096 || found.size >= 256 && !found.has(name)) return null
        found.add(name)
      }
      if (dirname(above) === above) break
    }
    if (found.size) {
      const userText = read(join(input.userHome!, mcp.user.file))
      const user = userText === null ? {} : mcpObject(userText)
      if (!user) return null
      const settings = contents[1] === null ? {} : mcpObject(contents[1])
      contents[1] = prepareInheritedMcp(mcp, [...found], user, settings)?.text ?? contents[1]
    }
  }
  for (const observed of evidence) observed.verify()
  return current() ? hookCandidate({ version: 1, files: contents.map((content, index) => ({ index, content })) }, contents.length) : null
}
