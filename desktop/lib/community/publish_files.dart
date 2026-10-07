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
  _Candidate(this.path, this.file) : page = null;
  _Candidate.page(this.path, String this.page) : file = null;
  final String path;
  final File? file;

  /// A page made for this publication rather than read from the project.
  final String? page;
  bool get binary =>
      hubBinaryExtensions.contains(p.extension(path).toLowerCase());
  int get depth => '/'.allMatches(path).length;
}

/// Local project files only. No daemon state, hidden files, credentials files, links, installed
/// dependencies, or native engine session identifiers are exported.
///
/// The output is chosen first and the harness's own source second; the rest are added shallowest
/// first while they fit. A file that does not fit is named, never a reason to publish nothing.
///
/// The output is [viewer] (the page a fork was published with) or else `preview.html`. Any other
/// page is never assumed: an app's `index.html` usually needs files the Hub's sandbox cannot load.
/// A page still as it is in [original] (the fork's files as they arrived) shows the original, not
/// this version. Without a page of its own, the output is [picture], a page showing the viewer.
Future<ProjectSelection> selectProjectFiles(
  String folder, {
  String? marker,
  String? viewer,
  Map<String, String> original = const {},
  String? picture,
}) async {
  final root = Directory(await Directory(folder).resolveSymbolicLinks());
  final (candidates, scannedAll) = await _candidates(root);
  var output = _output(candidates, viewer);
  final unchanged =
      output != null &&
      original.containsKey(output.path) &&
      await _content(output) == original[output.path];
  if (output == null || unchanged) {
    if (picture == null) {
      throw FormatException(
        unchanged
            ? '${output.path} is still the original\'s and has none of your changes. '
                  'Ask your agent to update it to show the current result, then publish again.'
            : 'The Hub shows what a session made. Ask your agent for a preview.html that runs on '
                  'its own (for a review, a page presenting it), then publish again.',
      );
    }
    output = _Candidate.page('preview.html', picture);
  }
  final shown = output;
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
    final content = await _content(candidate);
    // The snapshot limit is in bytes; one file's is in characters, as the backend counts each.
    final weight = content == null ? 0 : utf8.encode(content).length;
    final fits =
        content != null &&
        files.length < hubMaxFiles &&
        content.length <= hubMaxFileChars &&
        size + weight <= hubMaxProjectChars;
    if (!fits) {
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

/// The page readers see: the one this project was published with, or else its preview.html.
_Candidate? _output(List<_Candidate> candidates, String? viewer) {
  for (final name in [?viewer, 'preview.html']) {
    final page = candidates
        .where((c) => c.path == name && c.path.endsWith('.html'))
        .firstOrNull;
    if (page != null) return page;
  }
  return null;
}

/// The file as the Hub stores it, or null when a text file is not UTF-8 or too large to read.
Future<String?> _content(_Candidate candidate) async {
  final file = candidate.file;
  if (file == null) return candidate.page;
  if (await file.length() > hubMaxFileChars) return null;
  final bytes = await file.readAsBytes();
  if (candidate.binary) return base64Encode(bytes);
  try {
    return utf8.decode(bytes);
  } on FormatException {
    return null;
  }
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
