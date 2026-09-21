/// The names a derived agent starts with, before the engine reports a title.
/// One place so a fork and a clone read as siblings in the rail: `<source> - fork`,
/// `<source> - clone`. A blank source name falls back to "Agent".
library;

String forkNameFor(String name) => '${_baseName(name)} - fork';

/// Clone (⌘⇧N): another agent of the same kind with a fresh conversation.
String cloneNameFor(String name) => '${_baseName(name)} - clone';

String _baseName(String name) => name.trim().isEmpty ? 'Agent' : name.trim();
