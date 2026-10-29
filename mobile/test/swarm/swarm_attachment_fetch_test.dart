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
}
