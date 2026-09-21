import 'dsh_catalog.dart';

/// Compatibility identities only. Never merge unrelated packages by their
/// display name: different publishers can legitimately use the same name.
const retiredHarnessIds = <String, String>{
  'local/ollama': 'autonomous/ollama',
  'local/mlx-lm': 'autonomous/mlx-lm',
  'local/vllm': 'autonomous/vllm',
  'autonomous/copper': 'autonomous/autonomous-circuit',
  'autonomous/circuit': 'autonomous/autonomous-circuit',
  'autonomous/solder': 'autonomous/kicad',
  'autonomous/machines': 'autonomous/machine-monitor',
  'autonomous/toymaker': 'autonomous/autonomous-workshop',
  'autonomous/solid': 'autonomous/autonomous-workshop',
  'autonomous/workshop': 'autonomous/autonomous-workshop',
};

String canonicalHarnessId(String id) => retiredHarnessIds[id] ?? id;

// Older daemons can report an old manifest's name even under the current id.
const _currentIdentity = {
  'autonomous/kicad': (name: 'KiCad', category: 'PCB'),
  'autonomous/machine-monitor': (name: 'Machine Monitor', category: 'Compute'),
  'autonomous/ollama': (name: 'Ollama', category: 'Local AI'),
  'autonomous/mlx-lm': (name: 'MLX-LM', category: 'Local AI'),
  'autonomous/vllm': (name: 'vLLM', category: 'Local AI'),
  'autonomous/autonomous-circuit': (
    name: 'Autonomous Circuit',
    category: 'PCB',
  ),
  'autonomous/autonomous-workshop': (
    name: 'Autonomous Workshop',
    category: 'CAD',
  ),
};

String currentHarnessName(String id, String fallback) =>
    _currentIdentity[canonicalHarnessId(id)]?.name ?? fallback;

/// Resolve an operation to the actual package on THIS machine. The catalog
/// shows the current identity, but install directories and running projects
/// keep their wire ids. Prefer the current install when both versions exist.
DshEntry? harnessForOperation(Iterable<DshEntry> entries, String id) {
  final canonical = canonicalHarnessId(id);
  final matches = entries
      .where((entry) => canonicalHarnessId(entry.id) == canonical)
      .toList();
  return matches.where((e) => e.id == canonical && e.installed).firstOrNull ??
      matches.where((e) => e.installed).firstOrNull ??
      matches.where((e) => e.id == canonical).firstOrNull ??
      matches.firstOrNull;
}

/// One browsing entry per current package. This is a presentation projection;
/// never replace MachineDsh's raw map with it or send its ids blindly to RPCs.
List<DshEntry> currentHarnessCatalog(Iterable<DshEntry> entries) {
  final groups = <String, List<DshEntry>>{};
  for (final entry in entries) {
    (groups[canonicalHarnessId(entry.id)] ??= []).add(entry);
  }
  return [
    for (final group in groups.entries) _currentEntry(group.key, group.value),
  ];
}

DshEntry _currentEntry(String id, List<DshEntry> entries) {
  final metadata =
      entries.where((e) => e.id == id).firstOrNull ?? entries.first;
  final installation = harnessForOperation(entries, id)!;
  final identity = _currentIdentity[id];
  return DshEntry(
    id: id,
    name: identity?.name ?? metadata.name,
    category: identity?.category ?? metadata.category,
    description: metadata.description,
    engine: installation.installed ? installation.engine : metadata.engine,
    kind: metadata.kind,
    author: metadata.author,
    repo: metadata.repo,
    homepage: metadata.homepage,
    upstream: metadata.upstream,
    license: metadata.license,
    tagline: metadata.tagline,
    screenshots: metadata.screenshots,
    examples: metadata.examples,
    installed: installation.installed,
    linked: installation.linked,
    installedCommit: installation.installedCommit,
    availableCommit: installation.availableCommit,
    updateAvailable: installation.updateAvailable,
    viewer: installation.installed ? installation.viewer : metadata.viewer,
    viewerUse: installation.installed
        ? installation.viewerUse
        : metadata.viewerUse,
    tier: installation.installed ? installation.tier : metadata.tier,
  );
}
