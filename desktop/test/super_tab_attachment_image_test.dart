// The chat's picture loader against a real server: it draws the picture the
// attachments host serves, and refuses a redirect, so nothing from another
// host is ever fetched or drawn.
import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/attachment_viewer.dart';

/// A real 1×1 PNG.
const _png = <int>[
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, //
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
  0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0xDA, 0x63, 0x64, 0x60, 0xF8, 0x5F,
  0x0F, 0x00, 0x02, 0x87, 0x01, 0x80, 0xEB, 0x47, 0xBA, 0x92, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
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
        ..headers.contentType = ContentType('image', 'png')
        ..add(_png)
        ..close();
    });
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) => answer(request.response));
  });
  tearDown(() async {
    await server.close(force: true);
    await elsewhere.close(force: true);
    imageCache.clear();
  });

  /// What [url]'s picture comes to: its image, or the error it ends in.
  Future<Object> load(Uri url) {
    final done = Completer<Object>();
    attachmentPicture(url)
        .resolve(ImageConfiguration.empty)
        .addListener(
          ImageStreamListener(
            (image, _) => done.complete(image.image),
            onError: (error, _) => done.complete(error),
          ),
        );
    return done.future;
  }

  test('draws the picture the attachments host serves', () async {
    answer = (response) => (response..add(_png)).close();

    final image = await load(link('/a.png'));
    expect(image, isA<ui.Image>());
    expect((image as ui.Image).width, 1);
  });

  for (final status in [
    HttpStatus.movedPermanently,
    HttpStatus.found,
    HttpStatus.temporaryRedirect,
  ]) {
    test('refuses a $status redirect: nothing from the other host', () async {
      answer = (response) {
        response
          ..statusCode = status
          ..headers.set(
            HttpHeaders.locationHeader,
            'http://127.0.0.1:${elsewhere.port}/b.png',
          );
        return response.close();
      };

      expect(await load(link('/a.png')), isNot(isA<ui.Image>()));
      expect(elsewhereHits, 0);
    });
  }
}
