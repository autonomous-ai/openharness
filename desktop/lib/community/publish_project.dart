import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:path/path.dart' as p;

import 'fork_project.dart' show communityHarnesses;

const _skipped = {
  'node_modules',
  'build',
  'dist',
  'target',
  'vendor',
  'coverage',
  '__pycache__',
};
final _reserved = RegExp(
  r'^(harness\.json|AGENTS\.md|CLAUDE\.md|SESSION\.md|LICENSE|OPEN-HARNESS\.json|README\.md|CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$',
  caseSensitive: false,
);
const _binary = {'.png', '.jpg', '.jpeg', '.webp', '.glb', '.pdf'};
const _text = {
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

/// Local project files only. No daemon state, hidden files, credentials, links,
/// installed dependencies, or native engine session identifiers are exported.
Future<Map<String, dynamic>> buildPublicationDraft({
  required String folder,
  required String title,
  required String engine,
  String? harnessId,
  Map<String, dynamic>? tail,
}) async {
  final root = Directory(await Directory(folder).resolveSymbolicLinks());
  final files = <Map<String, String>>[];
  var size = 0, visited = 0;
  Future<void> walk(Directory directory, int depth) async {
    if (depth > 8) {
      throw const FormatException(
        'This project is too large to publish as one harness. Choose its portable files on the Hub.',
      );
    }
    await for (final entry in directory.list(followLinks: false)) {
      if (++visited > 1500) {
        throw const FormatException(
          'Choose a smaller project or its portable files on the Hub.',
        );
      }
      final name = p.basename(entry.path);
      if (name.startsWith('.') ||
          _skipped.contains(name) ||
          _reserved.hasMatch(name)) {
        continue;
      }
      if (entry is Link) continue;
      if (entry is Directory) {
        await walk(entry, depth + 1);
        continue;
      }
      if (entry is! File) continue;
      final resolved = await entry.resolveSymbolicLinks();
      if (!p.isWithin(root.path, resolved) ||
          await FileSystemEntity.type(entry.path, followLinks: false) !=
              FileSystemEntityType.file) {
        continue;
      }
      final relative = p
          .relative(entry.path, from: root.path)
          .split(p.separator)
          .join('/');
      if (!RegExp(r'^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,179}$').hasMatch(relative)) {
        continue;
      }
      final extension = p.extension(name).toLowerCase();
      if (!_text.contains(extension) && !_binary.contains(extension)) continue;
      final length = await entry.length();
      if (length > 3000000 || files.length == 30) {
        throw const FormatException(
          'Publish up to 30 files, under 3 MB each. Choose the files on the Hub.',
        );
      }
      final bytes = await entry.readAsBytes();
      final binary = _binary.contains(extension);
      final content = binary ? base64Encode(bytes) : utf8.decode(bytes);
      size += utf8.encode(content).length;
      if (content.length > 3000000 || size > 5600000) {
        throw const FormatException(
          'Keep this harness under 6 MB. Choose a smaller set of files on the Hub.',
        );
      }
      files.add({
        'path': relative,
        'content': content,
        if (binary) 'encoding': 'base64',
      });
    }
  }

  await walk(root, 0);
  files.sort((a, b) => a['path']!.compareTo(b['path']!));
  final htmlFiles = files
      .where((file) => file['path']!.endsWith('.html'))
      .toList();
  if (htmlFiles.isEmpty) {
    throw const FormatException(
      'Ask your agent to create a self-contained preview.html, then publish again.',
    );
  }
  final viewer =
      htmlFiles.where((f) => f['path'] == 'preview.html').firstOrNull ??
      htmlFiles.where((f) => f['path'] == 'index.html').firstOrNull ??
      htmlFiles.first;
  Map<String, dynamic> previous = {};
  final origin = File(p.join(root.path, 'OPEN-HARNESS.json'));
  if (await origin.exists() &&
      await origin.length() <= 8100000 &&
      await FileSystemEntity.type(origin.path, followLinks: false) ==
          FileSystemEntityType.file) {
    try {
      final decoded = jsonDecode(await origin.readAsString());
      if (decoded is Map<String, dynamic>) previous = decoded;
    } on FormatException {
      /* A fresh project is still publishable. */
    }
  }
  final conversation = <Map<String, String>>[];
  for (final row in (tail?['rows'] as List? ?? const [])) {
    if (row is! Map) continue;
    for (final part in [('ask', 'user'), ('answer', 'assistant')]) {
      final text = row[part.$1];
      if (text is String && text.trim().isNotEmpty) {
        for (
          var start = 0;
          start < text.length && conversation.length < 80;
          start += 12000
        ) {
          conversation.add({
            'role': part.$2,
            'text': text.substring(start, min(start + 12000, text.length)),
          });
        }
      }
    }
  }
  return {
    'version': 1,
    'title': title.substring(0, min(100, title.length)),
    'description': previous['description'] is String
        ? previous['description']
        : '',
    'category': previous['category'] is String ? previous['category'] : 'Apps',
    'engine':
        {
          'codex': 'Codex',
          'claude': 'Claude Code',
          'opencode': 'OpenCode',
          'pi': 'pi',
        }[engine] ??
        'Codex',
    if (communityHarnesses.contains(harnessId)) 'harnessId': harnessId,
    'files': files,
    'viewerPath': viewer['path'],
    'conversation': conversation.isEmpty
        ? [
            {'role': 'user', 'text': ''},
          ]
        : conversation,
    if (previous['forkedFrom'] is String) 'forkedFrom': previous['forkedFrom'],
    'contextNote': tail?['hasMore'] == true
        ? 'Recent conversation included. Review it and add any earlier context you want to publish.'
        : conversation.isEmpty
        ? 'Add the conversation or a brief describing what you made.'
        : 'Review the conversation before publishing.',
  };
}

/// A short-lived, one-use loopback page sends the draft to the Hub review form.
/// The Hub keeps it in this browser tab; nothing is published by this handoff.
class PublicationHandoff {
  PublicationHandoff._(this._server, this.url);
  final HttpServer _server;
  final Uri url;
  Timer? _expiry;
  Future<void> close() async {
    _expiry?.cancel();
    await _server.close(force: true);
  }

  static Future<PublicationHandoff> start(
    Map<String, dynamic> draft, {
    String origin = const String.fromEnvironment(
      'HARNESS_COMMUNITY_ORIGIN',
      defaultValue: 'https://harness.autonomous.ai',
    ),
  }) async {
    final target = Uri.parse(origin);
    if (target.scheme != 'https' &&
        !(target.scheme == 'http' &&
            {'127.0.0.1', 'localhost'}.contains(target.host))) {
      throw const FormatException('Invalid Hub address.');
    }
    final bytes = jsonEncode(draft);
    if (utf8.encode(bytes).length > 6000000) {
      throw const FormatException('Keep this harness under 6 MB.');
    }
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final token = List.generate(
      24,
      (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
    final handoff = PublicationHandoff._(
      server,
      Uri.parse('http://127.0.0.1:${server.port}/$token'),
    );
    handoff._expiry = Timer(const Duration(minutes: 5), () {
      unawaited(handoff.close());
    });
    var used = false;
    server.listen((request) async {
      if (used ||
          request.method != 'GET' ||
          request.uri.path != '/$token' ||
          request.headers.value('host') != '127.0.0.1:${server.port}') {
        request.response.statusCode = 404;
        await request.response.close();
        return;
      }
      used = true;
      const escape = HtmlEscape();
      request.response.headers
        ..contentType = ContentType.html
        ..set('Cache-Control', 'no-store')
        ..set('Referrer-Policy', 'no-referrer')
        ..set(
          'Content-Security-Policy',
          "default-src 'none'; script-src 'nonce-$token'; form-action ${target.origin}; frame-ancestors 'none'",
        );
      request.response.write(
        '<!doctype html><title>Review your harness</title><p>Opening your draft in Harness Hub…</p><form method="post" enctype="multipart/form-data" action="${escape.convert(target.resolve('/hub/import').toString())}"><textarea name="draft" hidden>${escape.convert(bytes)}</textarea><button>Continue to Hub</button></form><script nonce="$token">document.forms[0].submit()</script>',
      );
      await request.response.close();
      await handoff.close();
    });
    return handoff;
  }
}
