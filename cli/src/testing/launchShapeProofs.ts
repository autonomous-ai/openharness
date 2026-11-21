/** Normalize observed identities only; the proof program, permissions and executable bytes stay literal. */
export function launchShapeProofs(text: string): string {
  const tokens = new Set([...text.matchAll(/HARNESS_NATIVE_LAUNCH_TOKEN=([a-f0-9-]{36})/g)].map(match => match[1]))
  for (const match of text.matchAll(/"token":"([a-f0-9-]{36})"/g)) tokens.add(match[1])
  for (const token of tokens) text = text.split(token).join('<native-token>')
  text = text.replace(/HARNESS_DAEMON=[a-f0-9]{16}/g, 'HARNESS_DAEMON=<daemon-owner>')
  // These are the three exact stat formats in nativeLaunchGuard.ts. Preserve modes and byte sizes.
  text = text.replace(/"identity":"([^"\n]*):([0-9]+):([0-9]+):([0-9]+):([0-9]+):([0-9]+):([0-9]+)"/g,
    (_all, path: string, _device: string, _inode: string, mode: string, size: string) => `"identity":"${path}:<device>:<inode>:${mode}:${size}:<mtime-ns>:<ctime-ns>"`)
  text = text.replace(/"identity":"[0-9]+:[0-9]+:([0-9]+):[0-9]+"/g, '"identity":"<device>:<inode>:$1:<uid>"')
  text = text.replace(/"version":"[0-9]+:[0-9]+:([0-9]+):[0-9]+:([0-9]+):[0-9]+:[0-9]+"/g,
    '"version":"<device>:<inode>:$1:<uid>:$2:<mtime-ns>:<ctime-ns>"')
  return text.replace(/"stamp":"[0-9]+:[0-9]+:[0-9]+:([0-9]+):([0-9]+):[0-9]+:[0-9]+"/g,
    '"stamp":"<device>:<inode>:<uid>:$1:$2:<mtime-ns>:<ctime-ns>"')
}
