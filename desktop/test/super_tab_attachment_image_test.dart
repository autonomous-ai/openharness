// The chat's picture loader against a real server: it draws the picture the
// attachments host serves, and refuses a redirect, so nothing from another
// host is ever fetched or drawn. A picture is the file's, whatever link it
// came by: a fresh link to a file already seen downloads nothing (#3178), and
// the chat decodes it no larger than it shows it.
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/attachment_viewer.dart';
import 'package:harness/super_tabs/image_cache.dart';

/// A real 1×1 PNG.
const _png = <int>[
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, //
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
  0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0xDA, 0x63, 0x64, 0x60, 0xF8, 0x5F,
  0x0F, 0x00, 0x02, 0x87, 0x01, 0x80, 0xEB, 0x47, 0xBA, 0x92, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

Future<Uint8List> _picture(int width, int height) async {
  final recorder = ui.PictureRecorder();
  ui.Canvas(recorder).drawRect(
    ui.Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    ui.Paint()..color = const ui.Color(0xff3366cc),
  );
  final image = await recorder.endRecording().toImage(width, height);
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  return data!.buffer.asUint8List();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late HttpServer server, elsewhere;
  late int hits, elsewhereHits;
  late Future<void> Function(HttpResponse) answer;
  late SuperTabImageCache original;

  Uri link(String path) => Uri.parse('http://127.0.0.1:${server.port}$path');

  setUp(() async {
    hits = elsewhereHits = 0;
    original = superTabImageCache;
    superTabImageCache = SuperTabImageCache(MemoryImageShelf());
    elsewhere = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    elsewhere.listen((request) {
      elsewhereHits++;
      request.response
        ..headers.contentType = ContentType('image', 'png')
        ..add(_png)
        ..close();
    });
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) {
      hits++;
      answer(request.response);
    });
  });
  tearDown(() async {
    await server.close(force: true);
    await elsewhere.close(force: true);
    // Held by file id: one test's a1 must not answer the next's.
    imageCache
      ..clear()
      ..clearLiveImages();
    superTabImageCache = original;
  });

  /// What file [fileId]'s picture at [url] comes to: its image, or the error
  /// it ends in.
  Future<Object> load(
    Uri url, {
    String fileId = 'a1',
    double? side,
    double pixelRatio = 1,
  }) {
    final done = Completer<Object>();
    attachmentPicture(url, fileId: fileId, side: side)
        .resolve(ImageConfiguration(devicePixelRatio: pixelRatio))
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

  test("a new signed link for the same file id doesn't download again", () async {
    answer = (response) => (response..add(_png)).close();

    expect(await load(link('/a1.png?sig=1'), side: 360), isA<ui.Image>());
    expect(await load(link('/a1.png?sig=2'), side: 360), isA<ui.Image>());
    expect(hits, 1);

    // Flutter's own copy gone, as after a while or a relaunch: the cache
    // answers, not the server.
    imageCache
      ..clear()
      ..clearLiveImages();
    expect(await load(link('/a1.png?sig=3'), side: 360), isA<ui.Image>());
    expect(hits, 1);
  });

  test('another file is another picture', () async {
    answer = (response) => (response..add(_png)).close();

    await load(link('/a1.png?sig=1'));
    await load(link('/a2.png?sig=1'), fileId: 'a2');

    expect(hits, 2);
  });

  test('decodes no larger than the chat shows it', () async {
    final wide = await _picture(2000, 1000);
    answer = (response) => (response..add(wide)).close();

    final shown = await load(link('/a1.png'), side: 360, pixelRatio: 2);
    expect((shown as ui.Image).width, 720);
    expect(shown.height, 360);
    expect(superTabImageCache.shapeOf('a1'), const ui.Size(2000, 1000));

    // The full-screen viewer: the original, from the bytes already here.
    final whole = await load(link('/a1.png?sig=2'));
    expect((whole as ui.Image).width, 2000);
    expect(hits, 1);
  });

  test('a tall picture is held to the chat by its height', () async {
    final tall = await _picture(500, 1500);
    answer = (response) => (response..add(tall)).close();

    final shown = await load(link('/a1.png'), side: 360);
    expect((shown as ui.Image).height, 360);
    expect(shown.width, 120);
  });

  test('a small picture keeps its size', () async {
    answer = (response) => (response..add(_png)).close();

    final shown = await load(link('/a1.png'), side: 360, pixelRatio: 2);
    expect((shown as ui.Image).width, 1);
  });

  test('a failed load is not kept: a fresh link loads it', () async {
    var first = true;
    answer = (response) {
      if (first) {
        first = false;
        response.statusCode = HttpStatus.forbidden;
        return response.close();
      }
      return (response..add(_png)).close();
    };

    expect(await load(link('/a1.png?sig=old'), side: 360), isNot(isA<ui.Image>()));
    expect(await load(link('/a1.png?sig=new'), side: 360), isA<ui.Image>());
    expect(hits, 2);
  });

  test('a picture whose load began before sign-out is not kept', () async {
    final gate = Completer<void>();
    answer = (response) async {
      await gate.future;
      return (response..add(_png)).close();
    };

    final loading = load(link('/a1.png'), side: 360);
    await Future<void>.delayed(Duration.zero);
    await superTabImageCache.clear();
    gate.complete();
    await loading;
    await Future<void>.delayed(Duration.zero);

    expect(await superTabImageCache.read('a1'), isNull);
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
      expect(await superTabImageCache.read('a1'), isNull);
    });
  }
}
