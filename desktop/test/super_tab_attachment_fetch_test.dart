// The chat's file fetch against a real server: it never follows a redirect
// off the attachments host, and it stops reading at the text viewer's limit.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/attachment_viewer.dart';

void main() {
  late HttpServer server, elsewhere;
  late int elsewhereHits;
  late Future<void> Function(HttpResponse) answer;

  Uri link(String path) => Uri.parse('http://127.0.0.1:${server.port}$path');

  setUp(() async {
    elsewhereHits = 0;
    elsewhere = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    elsewhere.listen((request) {
      elsewhereHits++;
      request.response
        ..write('from another host')
        ..close();
    });
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) => answer(request.response));
  });
  tearDown(() async {
    await server.close(force: true);
    await elsewhere.close(force: true);
  });

  test('reads the file', () async {
    answer = (response) => (response..write('hello')).close();

    expect(
      await fetchAttachment(link('/a')),
      Uint8List.fromList('hello'.codeUnits),
    );
  });

  test('a redirect is refused, never followed', () async {
    answer = (response) =>
        response.redirect(Uri.parse('http://127.0.0.1:${elsewhere.port}/b'));

    await expectLater(fetchAttachment(link('/a')), throwsA(anything));
    expect(elsewhereHits, 0);
  });

  test('stops reading past the limit and hangs up', () async {
    // A raw socket, because only it sees the reader hang up: more than the
    // limit, with no length and no end, so only a reader that stops at the
    // limit gets an answer.
    final raw = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(raw.close);
    final hungUp = Completer<void>();
    raw.listen((socket) {
      socket.listen((_) {}, onDone: hungUp.complete, onError: (_) {});
      socket
        ..add(
          utf8.encode('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\n'),
        )
        ..add(Uint8List(1536 * 1024));
    });

    await expectLater(
      fetchAttachment(
        Uri.parse('http://127.0.0.1:${raw.port}/a'),
        maxBytes: 1024 * 1024,
      ),
      throwsA(isA<AttachmentTooLarge>()),
    );
    await hungUp.future.timeout(const Duration(seconds: 10));
  });
}
