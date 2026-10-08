import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import 'hub_contract.dart';

const _skippedFolders = {
  'node_modules',
  'build',
  'dist',
  'target',
  'vendor',
  'coverage',
  '__pycache__',
};
const _maxDepth = 8;
const _maxEntries = 1500;

/// The files a publication carries, and the ones that did not fit.
class ProjectSelection {
  const ProjectSelection({
    required this.files,
    required this.viewerPath,
    required this.leftOut,
    required this.scannedAll,
    this.pictured = false,
  });

  /// `{path, content, encoding?}` rows in path order, as the Hub reads them.
  final List<Map<String, String>> files;
  final String viewerPath;

  /// Portable files left out: over a limit, or not UTF-8 text.
  final List<String> leftOut;

  /// False when the folder was deeper or larger than one publication is ever read.
  final bool scannedAll;

  /// True when the output is the picture of the viewer rather than a page of the project.
  final bool pictured;
}

class _Candidate {
  _Candidate(this.path, File this.file) : page = null;
  _Candidate.page(this.path, String this.page) : file = null;
  final String path;
  final File? file;

  /// A page made for this publication rather than read from the project.
  final String? page;
  bool get binary =>
      hubBinaryExtensions.contains(p.extension(path).toLowerCase());
  int get depth => '/'.allMatches(path).length;

  String? _read;
  bool _wasRead = false;

  /// What the Hub would receive, measured without reading: bytes on disk for text (exact for
  /// UTF-8), base64 length for a binary file.
  Future<int> sentBytes() async {
    if (page != null) return utf8.encode(page!).length;
    final length = await file!.length();
    return binary ? (length + 2) ~/ 3 * 4 : length;
  }

  /// The file as the Hub stores it, read once, or null when text is not UTF-8.
  Future<String?> content() async {
    if (page != null) return page;
    if (_wasRead) return _read;
    _wasRead = true;
    final bytes = await file!.readAsBytes();
    if (binary) return _read = base64Encode(bytes);
    try {
      return _read = utf8.decode(bytes);
    } on FormatException {
      return null;
    }
  }
}

/// The project has no page of its own to show, or only the original's. With a picture of the
/// viewer, publishing can still go ahead; without one, the message says what to ask the agent for.
class NeedsOutput extends FormatException {
  const NeedsOutput(super.message);
}

/// Local project files only. No daemon state, hidden files, credentials files, links, installed
/// dependencies, or native engine session identifiers are exported.
///
/// The output is chosen first and the harness's own source second; the rest are added shallowest
/// first while they fit. A file that does not fit is named, never a reason to publish nothing, and
/// is never read: a size on disk says enough.
///
/// The output is [viewer] (the page a fork was published with), or else `preview.html`, skipping a
/// page still as it is in [original] (the fork's files as they arrived), which shows the original.
/// Any other page is never assumed: an app's `index.html` usually needs files the Hub's sandbox
/// cannot load. Without a page of its own, the output is [picture], a page showing the viewer.
Future<ProjectSelection> selectProjectFiles(
  String folder, {
  String? marker,
  String? viewer,
  Map<String, String> original = const {},
  String? picture,
}) async {
  final root = Directory(await Directory(folder).resolveSymbolicLinks());
  final (candidates, scannedAll) = await _candidates(root);
  final (own, stale) = await _output(candidates, viewer, original);
  final shown =
      own ??
      (picture == null
          ? throw NeedsOutput(
              stale != null
                  ? '${stale.path} is still the original\'s and has none of your changes. '
                        'Ask your agent to update it to show the current result, then publish again.'
                  : 'The Hub shows what a session made. Ask your agent for a preview.html that runs '
                        'on its own (for a review, a page presenting it), then publish again.',
            )
          : _Candidate.page('preview.html', picture));
  final rest =
      candidates.where((c) => c.path != shown.path && c.path != marker).toList()
        ..sort(
          (a, b) =>
              a.depth != b.depth ? a.depth - b.depth : a.path.compareTo(b.path),
        );
  final ordered = [
    shown,
    ...candidates.where((c) => c.path == marker && c.path != shown.path),
    ...rest,
  ];
  final files = <Map<String, String>>[], leftOut = <String>[];
  var size = 0;
  for (final candidate in ordered) {
    // The snapshot limit is in bytes; one file's is in characters, as the backend counts each.
    final weight = await candidate.sentBytes();
    final room =
        files.length < hubMaxFiles && size + weight <= hubMaxProjectChars;
    final content = room ? await candidate.content() : null;
    if (content == null || content.length > hubMaxFileChars) {
      if (candidate == shown) {
        throw FormatException(
          '${shown.path} is too large to publish. Keep the preview under 3 MB.',
        );
      }
      leftOut.add(candidate.path);
      continue;
    }
    size += weight;
    files.add({
      'path': candidate.path,
      'content': content,
      if (candidate.binary) 'encoding': 'base64',
    });
  }
  files.sort((a, b) => a['path']!.compareTo(b['path']!));
  return ProjectSelection(
    files: files,
    viewerPath: shown.path,
    leftOut: leftOut..sort(),
    scannedAll: scannedAll,
    pictured: shown.page != null,
  );
}

/// The page readers see, and the original's page passed over on the way, if any.
Future<(_Candidate?, _Candidate?)> _output(
  List<_Candidate> candidates,
  String? viewer,
  Map<String, String> original,
) async {
  _Candidate? stale;
  for (final name in {?viewer, 'preview.html'}) {
    final page = candidates
        .where((c) => c.path == name && name.endsWith('.html'))
        .firstOrNull;
    if (page == null) continue;
    if (original.containsKey(name) && await page.content() == original[name]) {
      stale ??= page;
      continue;
    }
    return (page, stale);
  }
  return (null, stale);
}

Future<(List<_Candidate>, bool)> _candidates(Directory root) async {
  final found = <_Candidate>[];
  var visited = 0, scannedAll = true;
  Future<void> walk(Directory directory, int depth) async {
    if (depth > _maxDepth) {
      scannedAll = false;
      return;
    }
    await for (final entry in directory.list(followLinks: false)) {
      if (++visited > _maxEntries) {
        scannedAll = false;
        return;
      }
      final name = p.basename(entry.path);
      if (name.startsWith('.') ||
          _skippedFolders.contains(name) ||
          hubReservedName.hasMatch(name) ||
          entry is Link) {
        continue;
      }
      if (entry is Directory) {
        await walk(entry, depth + 1);
        continue;
      }
      if (entry is! File || !await _insideRoot(root, entry)) continue;
      final path = p
          .relative(entry.path, from: root.path)
          .split(p.separator)
          .join('/');
      final extension = p.extension(name).toLowerCase();
      if (!hubPathPattern.hasMatch(path) ||
          (!hubTextExtensions.contains(extension) &&
              !hubBinaryExtensions.contains(extension))) {
        continue;
      }
      found.add(_Candidate(path, entry));
    }
  }

  await walk(root, 0);
  return (found, scannedAll);
}

/// A plain file whose real location is still inside the project.
Future<bool> _insideRoot(Directory root, File file) async =>
    p.isWithin(root.path, await file.resolveSymbolicLinks()) &&
    await FileSystemEntity.type(file.path, followLinks: false) ==
        FileSystemEntityType.file;
