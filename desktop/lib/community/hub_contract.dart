/// What the Hub accepts from a publication, as `backend/src/routes/community.ts` checks it.
///
/// ⚠️ Mirrored, not shared: `test/community_hub_contract_test.dart` reads the backend's source and
/// fails when the two drift, so change both together.
library;

/// The harnesses the Hub names, and the source file a publication of each must include.
const hubHarnessMarkers = <String, String>{
  'autonomous/blender': 'scenes/hello.py',
  'autonomous/marp': 'deck.md',
  'autonomous/typst': 'main.typ',
  'autonomous/circuitjs': 'circuit.txt',
  'autonomous/godogen': 'studio.json',
  'autonomous/mujoco': 'sim/hello.py',
  'autonomous/rdkit': 'molecules/hello.py',
  'autonomous/strudel': 'track.strudel',
};

/// A Harness engine id, and the agent the Hub lists it as.
const hubEngines = <String, String>{
  'codex': 'Codex',
  'claude': 'Claude Code',
  'opencode': 'OpenCode',
  'pi': 'pi',
};

const hubMaxFiles = 30;
const hubMaxTurns = 80;
const hubMaxTurnChars = 12000;

/// Characters as sent. A binary file goes as base64, about a third larger than on disk.
const hubMaxFileChars = 3000000;

/// The project's share of the Hub's 6 MB snapshot, leaving room for the conversation.
const hubMaxProjectChars = 5600000;

/// A cover's data URL, as the Hub stores it.
const hubMaxCoverChars = 350000;

const hubBinaryExtensions = {'.png', '.jpg', '.jpeg', '.webp', '.glb', '.pdf'};
const hubTextExtensions = {
  '.html',
  '.css',
  '.js',
  '.mjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.json',
  '.md',
  '.svg',
  '.py',
  '.typ',
  '.strudel',
  '.txt',
  '.csv',
  '.xml',
  '.sdf',
};

/// Names a fork bundle writes for itself, and names Windows cannot hold.
final hubReservedName = RegExp(
  r'^(?:harness\.json|AGENTS\.md|CLAUDE\.md|SESSION\.md|LICENSE|OPEN-HARNESS\.json|README\.md|CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$',
  caseSensitive: false,
);
final hubPathPattern = RegExp(r'^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,179}$');
