import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:path/path.dart' as p;

import 'hub_contract.dart';
import 'publish_conversation.dart';
import 'publish_files.dart';
import 'viewer_picture.dart';

/// A Hub draft of the project in [folder]: its portable files, the recent conversation, and notes
/// telling the person what to review or add before publishing. Nothing here publishes.
Future<Map<String, dynamic>> buildPublicationDraft({
  required String folder,
  required String title,
  required String engine,
  String? harnessId,
  Map<String, dynamic>? tail,
  String? viewerPicture,
}) async {
  final marker = hubHarnessMarkers[harnessId];
  final previous = await _openHarness(folder);
  final selection = await selectProjectFiles(
    folder,
    marker: marker,
    viewer: previous['viewerPath'] is String ? previous['viewerPath'] : null,
    original: _originalFiles(previous),
    picture: viewerPicture == null
        ? null
        : viewerPosterPage(title, viewerPicture),
  );
  final cover = viewerPicture == null
      ? null
      : 'data:image/jpeg;base64,$viewerPicture';
  final conversation = publicationTurns(tail);
  final hasMarker = selection.files.any((file) => file['path'] == marker);
  final agent = hubEngines[engine];
  return {
    'version': 1,
    'title': title.substring(0, min(100, title.length)),
    'description': previous['description'] is String
        ? previous['description']
        : '',
    'category': previous['category'] is String ? previous['category'] : 'Apps',
    'engine': ?agent,
    if (hasMarker) 'harnessId': harnessId,
    'files': selection.files,
    'viewerPath': selection.viewerPath,
    'conversation': conversation.isEmpty
        ? [
            {'role': 'user', 'text': ''},
          ]
        : conversation,
    if (previous['forkedFrom'] is String) 'forkedFrom': previous['forkedFrom'],
    if (selection.pictured && cover != null && cover.length <= hubMaxCoverChars)
      'cover': cover,
    'contextNote': [
      _conversationNote(conversation, tail),
      if (selection.pictured) 'The output is a picture of your viewer, taken just now. A fork opens the real thing.',
      if (selection.leftOut.isNotEmpty) _leftOutNote(selection.leftOut),
      if (!selection.scannedAll)
        'This folder is larger than one harness, so only part of it was read.',
      if (marker != null && !hasMarker)
        'Without $marker this is published as a general harness, not with its own viewer.',
      if (agent == null)
        'The Hub does not list $engine yet. Choose the closest agent.',
    ].join(' '),
  };
}

/// A fork's text files as they arrived, to tell its output apart from a new version of it.
Map<String, String> _originalFiles(Map<String, dynamic> previous) => {
  for (final file in (previous['files'] as List? ?? const []).whereType<Map>())
    if (file['path'] is String && file['content'] is String)
      file['path'] as String: file['content'] as String,
};

String _conversationNote(
  List<Map<String, String>> conversation,
  Map<String, dynamic>? tail,
) {
  if (tail?['hasMore'] == true) {
    return 'Recent conversation included. Review it and add any earlier context you want to publish.';
  }
  if (conversation.isEmpty) {
    return 'Add the conversation or a brief describing what you made.';
  }
  return 'Review the conversation before publishing.';
}

String _leftOutNote(List<String> leftOut) {
  final named = leftOut.take(3).join(', ');
  final more = leftOut.length > 3 ? ' and ${leftOut.length - 3} more' : '';
  return 'Left out $named$more: over the Hub\'s limits or not UTF-8 text. '
      'Choose a project folder here to pick the files yourself.';
}

/// The fork bundle a project came from, for its description, category and attribution.
Future<Map<String, dynamic>> _openHarness(String folder) async {
  final origin = File(p.join(folder, 'OPEN-HARNESS.json'));
  if (!await origin.exists() ||
      await origin.length() > 8100000 ||
      await FileSystemEntity.type(origin.path, followLinks: false) !=
          FileSystemEntityType.file) {
    return const {};
  }
  try {
    final decoded = jsonDecode(await origin.readAsString());
    return decoded is Map<String, dynamic> ? decoded : const {};
  } on FormatException {
    return const {}; // A fresh project is still publishable.
  }
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
