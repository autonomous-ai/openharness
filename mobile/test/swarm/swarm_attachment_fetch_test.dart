// The chat's picture fetch over an in-memory transport that answers as a
// real one does: it keeps the picture the attachments host serves, and
// refuses a redirect, so nothing from another host is fetched, kept or drawn.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_attachment_store.dart';
import 'package:http/http.dart' as http;

import 'swarm_attachment_fakes.dart';

/// The attachments host and another one. A redirect is followed only when the
/// request allows it, as `IOClient` does.
class _Hosts extends http.BaseClient {
  _Hosts(this.status);

  /// What the attachments host answers: 200 with the picture, or a redirect
  /// to the other host.
  final int status;
  int elsewhereHits = 0;
  final sent = <http.BaseRequest>[];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    sent.add(request);
    if (status == HttpStatus.ok) return _picture();
    if (!request.followRedirects) {
      return http.StreamedResponse(
        const Stream.empty(),
        status,
        headers: {'location': 'https://elsewhere.example/b.png'},
      );
    }
    elsewhereHits++;
    return _picture();
  }

  http.StreamedResponse _picture() => http.StreamedResponse(
    Stream.value(pixelPng),
    HttpStatus.ok,
    headers: {'content-type': 'image/png'},
  );
}

/// Harness's file storage answering every fetch with [headers], as the
/// backend serves a chat file (superTabs/attachments.ts `served`).
class _Serving extends http.BaseClient {
  _Serving(this.headers);

  final Map<String, String> headers;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async =>
      http.StreamedResponse(
        Stream.value(pixelPng),
        HttpStatus.ok,
        headers: headers,
      );
}

void main() {
  late Directory root;
  final link = Uri.parse('https://cdn.harness.autonomous.ai/a1/a.png');

  setUp(() => root = Directory.systemTemp.createTempSync('swarm-fetch-'));
  tearDown(() {
    if (root.existsSync()) root.deleteSync(recursive: true);
  });

  Future<SwarmAttachmentStore> storeOver(_Hosts hosts) async {
    final store = storeIn(root, SwarmFileFetch(client: hosts));
    await store.keepOnly('person-me');
    return store;
  }

  test('keeps the picture the attachments host serves', () async {
    final hosts = _Hosts(HttpStatus.ok);
    final store = await storeOver(hosts);

    final file = await store.file(link);
    expect(await file.readAsBytes(), pixelPng);
    expect(hosts.sent.single.url, link);
  });

  for (final status in [
    HttpStatus.movedPermanently,
    HttpStatus.found,
    HttpStatus.temporaryRedirect,
  ]) {
    test('refuses a $status redirect: nothing from the other host', () async {
      final hosts = _Hosts(status);
      final store = await storeOver(hosts);

      await expectLater(store.file(link), throwsA(anything));
      expect(hosts.elsewhereHits, 0);
      expect(hosts.sent.single.followRedirects, isFalse);
    });
  }

  group('the extension a file is kept under', () {
    final voice = Uri.parse(
      'https://storage.googleapis.com/harness-cdn/super-tabs/t/abc/'
      'Voice_message.wav?X-Goog-Signature=sig',
    );

    Future<File> kept(Uri url, Map<String, String> headers) async {
      final store = storeIn(root, SwarmFileFetch(client: _Serving(headers)));
      await store.keepOnly('person-me');
      return store.file(url);
    }

    test("a file served as bare bytes is kept under its name's, so an "
        "iPhone's player opens a voice message", () async {
      final file = await kept(voice, {
        'content-type': 'application/octet-stream',
        'content-disposition':
            "attachment; filename*=UTF-8''Voice%20message.wav",
      });
      expect(file.path, endsWith('.wav'));
      expect(await file.readAsBytes(), pixelPng);
    });

    test("with no name in the answer, under its link's", () async {
      final file = await kept(voice, {
        'content-type': 'application/octet-stream',
      });
      expect(file.path, endsWith('.wav'));
    });

    test("a picture is kept under its type's, whatever its name", () async {
      final file = await kept(
        Uri.parse('https://storage.googleapis.com/b/t/abc/photo.jpeg'),
        {
          'content-type': 'image/png',
          'content-disposition': "inline; filename*=UTF-8''photo.jpeg",
        },
      );
      expect(file.path, endsWith('.png'));
    });

    test('bare bytes with no extension in their name stay .bin', () async {
      final file = await kept(
        Uri.parse('https://storage.googleapis.com/b/t/abc/HANDOFF'),
        {
          'content-type': 'application/octet-stream',
          'content-disposition': "attachment; filename*=UTF-8''HANDOFF",
        },
      );
      expect(file.path, endsWith('.bin'));
    });
  });

  test('reads the name however the answer gives it, and takes only a plain '
      'extension', () {
    final bare = Uri.parse('https://storage.googleapis.com/b/t/abc/file');
    String named(String disposition) =>
        swarmKeptExtension('.bin', disposition: disposition, url: bare);

    expect(named("attachment; filename*=UTF-8''Voice%20message.WAV"), '.wav');
    expect(named('attachment; filename="clip.m4a"'), '.m4a');
    expect(named('attachment; FILENAME=notes.txt'), '.txt');
    // Badly encoded: its plain name instead, or the link's.
    expect(
      named("attachment; filename*=UTF-8''%A.wav; filename=\"clip.ogg\""),
      '.ogg',
    );
    expect(named("attachment; filename*=UTF-8''%E0.wav"), '.bin');
    // Not a plain extension: neither a folder in it, nor a name that is one.
    expect(named("attachment; filename*=UTF-8''a.w%2Fav"), '.bin');
    expect(named("attachment; filename*=UTF-8''.wav"), '.bin');
    expect(named("attachment; filename*=UTF-8''a.waveform-long"), '.bin');
    expect(
      swarmKeptExtension('', url: Uri.parse('https://h.test/a/clip.wav?x=1')),
      '.wav',
    );
    expect(
      swarmKeptExtension(
        '.png',
        disposition: "inline; filename*=UTF-8''a.wav",
        url: bare,
      ),
      '.png',
    );
  });
}
