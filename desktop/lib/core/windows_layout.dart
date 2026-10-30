/// The Windows install `install.ps1` writes under `%USERPROFILE%\.harness`
/// (sub-project B §1, "Layout"), read by the rules of B's own readers,
/// `cli/src/lib/windows/installLayout.ts` and `pty/src/launcher.rs`, so the app
/// accepts exactly the installs `harness.exe` accepts:
///
/// - a pointer is the first line of its file, trimmed, with a leading byte
///   order mark dropped (both readers drop one; the writers never write one);
/// - `cli\current` and `runtime\pty\current-pty` name one folder;
/// - what a pointer leads to must exist and resolve inside its root, so a `..`,
///   a junction or a symbolic link that leads out is refused.
library;

import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

/// A pointer names one folder: never `.`, any `..`, a separator, a `:` (a
/// drive or an NTFS stream) or a NUL (`isSingleSegment`, `single_segment`).
bool isSingleSegment(String value) =>
    value.isNotEmpty &&
    value != '.' &&
    !value.contains('..') &&
    !RegExp(r'[\\/:\x00]').hasMatch(value);

/// The pointer in [file]: its first line, trimmed, without a leading byte
/// order mark. Null when the file is missing, unreadable or empty.
Future<String?> readPointer(File file) async {
  final List<int> bytes;
  try {
    bytes = await file.readAsBytes();
  } on FileSystemException {
    return null;
  }
  var text = utf8.decode(bytes, allowMalformed: true);
  if (text.startsWith('\uFEFF')) text = text.substring(1);
  final lines = const LineSplitter().convert(text);
  final line = lines.isEmpty ? '' : lines.first.trim();
  return line.isEmpty ? null : line;
}

/// Whether [path] resolves inside [root], both sides resolved by the file
/// system (`contained` in launcher.rs).
Future<bool> resolvesInside(Directory root, String path) async {
  try {
    final resolvedRoot = await root.resolveSymbolicLinks();
    final resolved = await File(path).resolveSymbolicLinks();
    return p.isWithin(resolvedRoot, resolved);
  } on FileSystemException {
    return false;
  }
}

/// The Node and CLI that B's pointers name.
class ManagedWindowsCli {
  const ManagedWindowsCli({
    required this.node,
    required this.cliJs,
    required this.version,
  });

  /// `node.exe`, as `runtime\current-node` records it.
  final String node;

  /// `cli\<version>\cli.js`.
  final String cliJs;

  /// The version folder `cli\current` names.
  final String version;
}

/// `runtime\current-node` plus `cli\current` under [harnessHome], or null when
/// either is missing or breaks a rule (launcher.rs `resolve`).
Future<ManagedWindowsCli?> managedWindowsCli(Directory harnessHome) async {
  final runtime = Directory(p.join(harnessHome.path, 'runtime'));
  final node = await readPointer(File(p.join(runtime.path, 'current-node')));
  if (node == null || !p.isAbsolute(node)) return null;
  if (!await File(node).exists() || !await resolvesInside(runtime, node)) {
    return null;
  }
  final cliRoot = Directory(p.join(harnessHome.path, 'cli'));
  final version = await readPointer(File(p.join(cliRoot.path, 'current')));
  if (version == null || !isSingleSegment(version)) return null;
  final cliJs = p.join(cliRoot.path, version, 'cli.js');
  if (!await File(cliJs).exists() || !await resolvesInside(cliRoot, cliJs)) {
    return null;
  }
  return ManagedWindowsCli(node: node, cliJs: cliJs, version: version);
}

/// The version folder name a terminal host is installed under: dotted numbers
/// only (`VERSION_DIR` in cli/src/lib/ptyHost/launch.ts, install.ps1's
/// `$HarnessPtyVersionPattern`).
final _ptyVersion = RegExp(r'^\d+(\.\d+)*$');

/// B's terminal host, `runtime\pty\<version>\harness-pty.exe` for the version
/// `runtime\pty\current-pty` names, or null when it is not installed.
Future<({String version, String path})?> installedTerminalHost(
  Directory harnessHome,
) async {
  final ptyRoot = Directory(p.join(harnessHome.path, 'runtime', 'pty'));
  final version = await readPointer(File(p.join(ptyRoot.path, 'current-pty')));
  if (version == null || !_ptyVersion.hasMatch(version)) return null;
  final host = p.join(ptyRoot.path, version, 'harness-pty.exe');
  if (!await File(host).exists() || !await resolvesInside(ptyRoot, host)) {
    return null;
  }
  return (version: version, path: host);
}
