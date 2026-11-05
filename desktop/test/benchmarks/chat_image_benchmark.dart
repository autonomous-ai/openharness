// Run explicitly: flutter test test/benchmarks/chat_image_benchmark.dart --reporter expanded
// Task #3178: an image-heavy chat on a loopback attachments host, opened, then
// opened again once every link was replaced (signed links last minutes), then
// after a relaunch. It counts what the chat downloads and what it holds
// decoded; times are loopback and headless, not network or display claims.
import 'dart:async';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/attachment_viewer.dart';
import 'package:harness/super_tabs/image_cache.dart';
import 'package:harness/super_tabs/image_shelf_native.dart';

const _pictures = 30;
const _width = 2400, _height = 1600;

/// A screenshot-like picture: flat blocks with noise, so it compresses as a
/// real one does rather than to nothing.
Future<Uint8List> _screenshot(int seed) async {
  final random = Random(seed);
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  for (var y = 0; y < _height; y += 6) {
    for (var x = 0; x < _width; x += 6) {
      canvas.drawRect(
        ui.Rect.fromLTWH(x.toDouble(), y.toDouble(), 6, 6),
        ui.Paint()..color = ui.Color(0xff000000 | random.nextInt(0xffffff)),
      );
    }
  }
  final image = await recorder.endRecording().toImage(_width, _height);
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  return data!.buffer.asUint8List();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('an image-heavy chat: downloads, bytes and decoded memory', () async {
    final files = [for (var i = 0; i < _pictures; i++) await _screenshot(i)];
    var downloads = 0, served = 0;
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) {
      final bytes = files[int.parse(request.uri.pathSegments.first)];
      downloads++;
      served += bytes.length;
      request.response
        ..add(bytes)
        ..close();
    });
    final home = await Directory.systemTemp.createTemp('chat-image-bench.');
    final shelf = DirectoryImageShelf(Directory('${home.path}/image-cache'));
    final original = superTabImageCache;
    superTabImageCache = SuperTabImageCache(shelf);

    /// Every picture as the chat shows it, on a 2x screen, by links of
    /// generation [links]: what it downloaded, held decoded, and took.
    Future<String> open(String step, int links) async {
      downloads = served = 0;
      var decoded = 0;
      final clock = Stopwatch()..start();
      await Future.wait([
        for (var i = 0; i < _pictures; i++)
          () {
            final done = Completer<void>();
            final url = Uri.parse(
              'http://127.0.0.1:${server.port}/$i/shot.png?sig=$links',
            );
            attachmentPicture(url, fileId: 'f$i', side: 360)
                .resolve(const ImageConfiguration(devicePixelRatio: 2))
                .addListener(
                  ImageStreamListener((info, _) {
                    decoded += info.image.width * info.image.height * 4;
                    if (!done.isCompleted) done.complete();
                  }, onError: (error, _) => done.completeError(error)),
                );
            return done.future;
          }(),
      ]);
      final ms = clock.elapsedMilliseconds;
      // Out of Flutter's memory, as pictures scrolled away or a relaunch
      // leave it; what stays is what the disk kept.
      imageCache
        ..clear()
        ..clearLiveImages();
      await Future<void>.delayed(const Duration(milliseconds: 200));
      return '| $step | $downloads | ${(served / 1e6).toStringAsFixed(1)} MB '
          '| ${(decoded / 1e6).toStringAsFixed(1)} MB | $ms ms |';
    }

    final rows = [
      await open('open the chat', 1),
      await open('open it again, every link new', 2),
    ];
    superTabImageCache = SuperTabImageCache(shelf);
    rows.add(await open('after a relaunch', 3));

    // ignore: avoid_print
    print(
      [
        '$_pictures pictures, ${_width}x$_height, '
            '${(files.fold<int>(0, (s, f) => s + f.length) / 1e6).toStringAsFixed(1)} MB in all',
        '| step | downloads | bytes downloaded | decoded in memory | time |',
        '|---|---|---|---|---|',
        ...rows,
      ].join('\n'),
    );

    superTabImageCache = original;
    await server.close(force: true);
    await home.delete(recursive: true);
  }, timeout: const Timeout(Duration(minutes: 5)));
}
