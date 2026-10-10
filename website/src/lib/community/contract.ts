/**
 * What the Hub accepts from a publication, as `backend/src/lib/communityContract.ts` checks it.
 * ⚠️ A copy, because the website does not ship the backend: `contract.spec.ts` imports that file and
 * fails when the two drift, so change both together (and `desktop/lib/community/hub_contract.dart`).
 */

/** The harnesses the Hub names: how a card labels each, and the source file its publication must include. */
export const communityHarnesses: Record<string, { name: string; marker: string }> = {
  'autonomous/blender': { name: 'Blender', marker: 'scenes/hello.py' },
  'autonomous/marp': { name: 'Marp', marker: 'deck.md' },
  'autonomous/typst': { name: 'Typst', marker: 'main.typ' },
  'autonomous/circuitjs': { name: 'CircuitJS', marker: 'circuit.txt' },
  'autonomous/godogen': { name: 'Godogen', marker: 'studio.json' },
  'autonomous/mujoco': { name: 'MuJoCo', marker: 'sim/hello.py' },
  'autonomous/rdkit': { name: 'RDKit', marker: 'molecules/hello.py' },
  'autonomous/strudel': { name: 'Strudel', marker: 'track.strudel' },
};

export const communityCategories = ['Apps', 'Games', 'Motion', 'Music', 'Design', 'Data', 'Documents', 'Experiments'];
export const communityEngines = ['Codex', 'Claude Code', 'OpenCode', 'pi'];

export const communityLimits = {
  files: 30,
  /** Characters of one file as sent: a binary file is base64, about a third larger than on disk. */
  fileChars: 3_000_000,
  /** The project's share of the 6 MB snapshot, leaving room for the conversation. */
  projectBytes: 5_600_000,
  snapshotBytes: 6_000_000,
  turns: 80,
  turnChars: 12_000,
};

/** The harness source a publication still needs, or null when it has it (or names no harness). */
export function missingMarker(harnessId: string | undefined, paths: string[]): string | null {
  const marker = harnessId ? communityHarnesses[harnessId]?.marker : undefined;
  return marker && !paths.includes(marker) ? marker : null;
}
