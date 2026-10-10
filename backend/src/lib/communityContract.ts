/**
 * What the Hub accepts from a publication. The website and the desktop keep their own copies
 * (`website/src/lib/community/contract.ts`, `desktop/lib/community/hub_contract.dart`); each has a
 * test that reads this file and fails when they drift, so change all three together.
 */

/** The harnesses the Hub names, and the source file a publication of each must include. */
export const communityHarnessMarkers = {
  'autonomous/blender': 'scenes/hello.py',
  'autonomous/marp': 'deck.md',
  'autonomous/typst': 'main.typ',
  'autonomous/circuitjs': 'circuit.txt',
  'autonomous/godogen': 'studio.json',
  'autonomous/mujoco': 'sim/hello.py',
  'autonomous/rdkit': 'molecules/hello.py',
  'autonomous/strudel': 'track.strudel',
} as const

export const communityHarnessIds = Object.keys(communityHarnessMarkers) as [keyof typeof communityHarnessMarkers, ...(keyof typeof communityHarnessMarkers)[]]
export const communityCategories = ['Apps', 'Games', 'Motion', 'Music', 'Design', 'Data', 'Documents', 'Experiments'] as const
export const communityEngines = ['Codex', 'Claude Code', 'OpenCode', 'pi'] as const

export const communityLimits = {
  files: 30,
  /** Characters of one file as sent: a binary file is base64, about a third larger than on disk. */
  fileChars: 3_000_000,
  snapshotBytes: 6_000_000,
  turns: 80,
  turnChars: 12_000,
  coverChars: 350_000,
} as const

/** Names a fork bundle writes for itself, and names Windows cannot hold. */
export const communityReservedName = /^(?:harness\.json|AGENTS\.md|CLAUDE\.md|SESSION\.md|LICENSE|OPEN-HARNESS\.json|README\.md|CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i
export const communityPathPattern = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,179}$/
