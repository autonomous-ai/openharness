import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/media_preview_page.dart';
import 'package:share_plus/share_plus.dart';
import 'package:video_player/video_player.dart';

import 'phone_edge/edge_fixture.dart';

/// A picture or video an agent printed, downloaded and shown in the app — the page a tap on a
/// terminal's media link opens. Real files in a temporary folder, a share sheet and a player that
/// answer here rather than the platform's.

/// A 1×1 PNG.
final _png = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
);

const _failed = 'Could not open this preview.';

final _share = find.byKey(const ValueKey('media-preview-share'));
final _back = find.byKey(const ValueKey('tty-back'));

void main() {
  late Directory folder;
  setUp(() {
    folder = Directory.systemTemp.createTempSync('media-preview-test-');
    imageCache.clear();
  });
  tearDown(() => folder.deleteSync(recursive: true));

  File file(String name, List<int> bytes) =>
      File('${folder.path}/$name')..writeAsBytesSync(bytes);

  /// Lets the real file read and the image codec finish: neither runs on the test's fake clock.
  Future<void> decode(WidgetTester tester) async {
    for (var i = 0; i < 100; i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
      await tester.pump();
      if (find.text(_failed).evaluate().isNotEmpty) return;
      final raw = find.byType(RawImage);
      if (raw.evaluate().isNotEmpty &&
          tester.widget<RawImage>(raw).image != null) {
        return;
      }
    }
  }

  RawImage picture(WidgetTester tester) =>
      tester.widget<RawImage>(find.byType(RawImage));

  testWidgets('a picture is shown fitted to the screen, zoomable, with only '
      'Back and Share above it', (tester) async {
    setPhone(tester, largePhone);
    final shot = file('shot.png', _png);
    await tester.pumpWidget(phoneApp(MediaPreviewPage(path: shot.path)));
    await decode(tester);

    expect(picture(tester).image, isNotNull);
    expect(picture(tester).fit, BoxFit.contain);
    expect(find.byType(InteractiveViewer), findsOneWidget);
    expect(find.text(_failed), findsNothing);
    expect(_back, findsOneWidget);
    expect(_share, findsOneWidget);
    expect(find.bySemanticsLabel('Share'), findsOneWidget);
    expect(find.bySemanticsLabel('shot.png'), findsOneWidget);
    // Nothing else: no title, no caption, no other control.
    expect(find.byType(Text), findsNothing);
    // The picture has the whole page under the bar to fit into.
    final area = tester.getSize(find.byType(InteractiveViewer));
    expect(area.width, largePhone.size.width);
    expect(
      area.height,
      largePhone.size.height - largePhone.top - largePhone.bottom - 44,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('Share hands the file itself to the share sheet, anchored to '
      'the button', (tester) async {
    setPhone(tester, largePhone);
    final shot = file('shot.png', _png);
    final shared = <ShareParams>[];
    await tester.pumpWidget(
      phoneApp(
        MediaPreviewPage(
          path: shot.path,
          share: (params) async => shared.add(params),
        ),
      ),
    );
    await decode(tester);

    await tester.tap(_share);
    await tester.pump();

    final params = shared.single;
    expect(params.files!.single.path, shot.path);
    expect(params.uri, isNull);
    expect(params.text, isNull);
    // An iPad shows the sheet as a popover, and needs to know what it points at.
    expect(params.sharePositionOrigin, tester.getRect(_share));
  });

  testWidgets('a second tap while the sheet is opening asks for no second '
      'sheet; once it is gone, Share works again', (tester) async {
    setPhone(tester, largePhone);
    final shot = file('shot.png', _png);
    var asked = 0;
    var sheet = Completer<void>();
    await tester.pumpWidget(
      phoneApp(
        MediaPreviewPage(
          path: shot.path,
          share: (_) {
            asked++;
            return sheet.future;
          },
        ),
      ),
    );
    await decode(tester);

    await tester.tap(_share);
    await tester.pump();
    await tester.tap(_share);
    await tester.pump();
    expect(asked, 1);

    sheet.complete();
    await tester.pump();
    sheet = Completer<void>();
    await tester.tap(_share);
    await tester.pump();
    expect(asked, 2);
    sheet.complete();
  });

  testWidgets('a share sheet that will not come up leaves the page as it was', (
    tester,
  ) async {
    setPhone(tester, largePhone);
    final shot = file('shot.png', _png);
    var asked = 0;
    await tester.pumpWidget(
      phoneApp(
        MediaPreviewPage(
          path: shot.path,
          share: (_) async {
            asked++;
            throw StateError('no share sheet here');
          },
        ),
      ),
    );
    await decode(tester);

    await tester.tap(_share);
    await tester.pump();
    await tester.tap(_share);
    await tester.pump();

    expect(asked, 2);
    expect(tester.takeException(), isNull);
    expect(picture(tester).image, isNotNull);
  });

  for (final (name, bytes) in [
    ('corrupt.png', utf8.encode('not a picture at all')),
    ('empty.jpg', <int>[]),
    // A format the phone cannot draw — still a file worth sending somewhere that can.
    ('diagram.svg', utf8.encode('<svg xmlns="http://www.w3.org/2000/svg"/>')),
  ]) {
    testWidgets('$name cannot be decoded: the page says so, and Share still '
        'sends it', (tester) async {
      setPhone(tester, largePhone);
      final broken = file(name, bytes);
      final shared = <ShareParams>[];
      await tester.pumpWidget(
        phoneApp(
          MediaPreviewPage(
            path: broken.path,
            share: (params) async => shared.add(params),
          ),
        ),
      );
      await decode(tester);

      expect(find.text(_failed), findsOneWidget);
      // A still sentence: the zoom is the decoded picture's alone.
      expect(find.byType(InteractiveViewer), findsNothing);
      expect(tester.takeException(), isNull);

      await tester.tap(_share);
      await tester.pump();
      expect(shared.single.files!.single.path, broken.path);
    });
  }

  testWidgets('a copy gone from the disk says so rather than staying blank', (
    tester,
  ) async {
    setPhone(tester, largePhone);
    await tester.pumpWidget(
      phoneApp(MediaPreviewPage(path: '${folder.path}/pruned.png')),
    );
    await decode(tester);
    expect(find.text(_failed), findsOneWidget);
    expect(_share, findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the picture leaves the image cache with the page', (
    tester,
  ) async {
    setPhone(tester, largePhone);
    final shot = file('shot.png', _png);
    await tester.pumpWidget(phoneApp(MediaPreviewPage(path: shot.path)));
    await decode(tester);
    expect(imageCache.currentSize, 1);

    await tester.pumpWidget(const SizedBox());
    expect(imageCache.currentSize, 0);
  });

  testWidgets('a keyboard still up as the page opens does not squeeze the '
      'picture', (tester) async {
    setPhone(tester, largePhone);
    final shot = file('shot.png', _png);
    await tester.pumpWidget(phoneApp(MediaPreviewPage(path: shot.path)));
    await decode(tester);
    final before = tester.getSize(find.byType(InteractiveViewer));

    raiseKeyboard(tester);
    await tester.pump();
    expect(tester.getSize(find.byType(InteractiveViewer)), before);
  });

  group('opened over a page', () {
    Widget host(String path) => phoneApp(
      Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: TextButton(
              onPressed: () => openMediaPreview(context, path),
              child: const Text('terminal'),
            ),
          ),
        ),
      ),
    );

    Future<void> open(WidgetTester tester) async {
      await tester.tap(find.text('terminal'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
    }

    testWidgets('Back returns to the page it was opened from', (tester) async {
      setPhone(tester, largePhone);
      final shot = file('shot.png', _png);
      await tester.pumpWidget(host(shot.path));
      await open(tester);
      expect(find.byType(MediaPreviewPage), findsOneWidget);
      expect(find.text('terminal'), findsNothing);

      await tester.tap(_back);
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(find.byType(MediaPreviewPage), findsNothing);
      expect(find.text('terminal'), findsOneWidget);
    });

    testWidgets("Android's back button returns too", (tester) async {
      setPhone(tester, largePhone);
      final shot = file('shot.png', _png);
      await tester.pumpWidget(host(shot.path));
      await open(tester);

      await tester.binding.handlePopRoute();
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(find.byType(MediaPreviewPage), findsNothing);
      expect(find.text('terminal'), findsOneWidget);
    });

    testWidgets('a picture gives the edge swipe to its pan; a video keeps it', (
      tester,
    ) async {
      setPhone(tester, largePhone);
      final shot = file('shot.png', _png);
      await tester.pumpWidget(host(shot.path));
      await open(tester);
      final pictureRoute =
          ModalRoute.of(tester.element(find.byType(MediaPreviewPage)))!
              as CupertinoPageRoute<void>;
      expect(pictureRoute.popGestureEnabled, isFalse);

      await tester.pumpWidget(host('${folder.path}/clip.mp4'));
      await tester.tap(_back);
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      await open(tester);
      final videoRoute =
          ModalRoute.of(tester.element(find.byType(MediaPreviewPage)))!
              as CupertinoPageRoute<void>;
      expect(videoRoute.popGestureEnabled, isTrue);
    });
  });

  group('a video', () {
    testWidgets('plays once ready; a tap anywhere under the bar pauses, '
        'plays, and at the end plays again', (tester) async {
      setPhone(tester, largePhone);
      final video = _Video();
      await tester.pumpWidget(
        phoneApp(
          MediaPreviewPage(path: '${folder.path}/clip.mp4', controller: video),
        ),
      );
      await tester.pump();
      expect(video.calls, ['initialize', 'play']);
      expect(find.byType(VideoPlayer), findsOneWidget);
      expect(find.byType(InteractiveViewer), findsNothing);
      expect(_share, findsOneWidget);
      expect(find.bySemanticsLabel('clip.mp4'), findsOneWidget);

      final screen = find.byKey(const ValueKey('media-preview-video'));
      // Above a landscape video on a phone held upright, not on it.
      await tester.tapAt(tester.getTopLeft(screen) + const Offset(8, 8));
      expect(video.calls.last, 'pause');
      await tester.tap(screen);
      expect(video.calls.last, 'play');

      video.finish();
      await tester.tap(screen);
      expect(video.calls.sublist(video.calls.length - 2), ['seekTo', 'play']);

      await tester.pumpWidget(const SizedBox());
      // The page plays what it was handed, and leaves disposing it to its owner.
      expect(video.disposed, isFalse);
      await video.dispose();
    });

    testWidgets('one that will not play says so, and Share still sends it', (
      tester,
    ) async {
      setPhone(tester, largePhone);
      final video = _Video(fails: true);
      final shared = <ShareParams>[];
      final path = '${folder.path}/clip.mkv';
      await tester.pumpWidget(
        phoneApp(
          MediaPreviewPage(
            path: path,
            controller: video,
            share: (params) async => shared.add(params),
          ),
        ),
      );
      await tester.pump();

      expect(video.calls, ['initialize']);
      expect(find.byType(VideoPlayer), findsNothing);
      expect(find.text(_failed), findsOneWidget);
      expect(tester.takeException(), isNull);

      await tester.tap(_share);
      await tester.pump();
      expect(shared.single.files!.single.path, path);

      await tester.pumpWidget(const SizedBox());
      await video.dispose();
    });

    testWidgets('one that fails after it started says so too', (tester) async {
      setPhone(tester, largePhone);
      final video = _Video();
      await tester.pumpWidget(
        phoneApp(
          MediaPreviewPage(path: '${folder.path}/clip.mov', controller: video),
        ),
      );
      await tester.pump();
      expect(find.byType(VideoPlayer), findsOneWidget);

      video.value = video.value.copyWith(errorDescription: 'decoder died');
      await tester.pump();
      expect(find.byType(VideoPlayer), findsNothing);
      expect(find.text(_failed), findsOneWidget);
      expect(find.byKey(const ValueKey('media-preview-video')), findsNothing);

      await tester.pumpWidget(const SizedBox());
      await video.dispose();
    });
  });
}

/// A player that plays nothing, and says what it was asked.
class _Video extends VideoPlayerController {
  _Video({this.fails = false}) : super.file(File('/sample-cache/clip.mp4'));

  final bool fails;
  final List<String> calls = [];
  bool disposed = false;

  @override
  Future<void> initialize() async {
    calls.add('initialize');
    if (fails) throw Exception('no decoder for this format');
    value = value.copyWith(
      isInitialized: true,
      duration: const Duration(seconds: 30),
      size: const Size(1920, 1080),
    );
  }

  @override
  Future<void> play() async {
    calls.add('play');
    value = value.copyWith(isPlaying: true);
  }

  @override
  Future<void> pause() async {
    calls.add('pause');
    value = value.copyWith(isPlaying: false);
  }

  @override
  Future<void> seekTo(Duration position) async {
    calls.add('seekTo');
    value = value.copyWith(position: position);
  }

  @override
  Future<void> dispose() async {
    disposed = true;
    await super.dispose();
  }

  void finish() => value = value.copyWith(
    isPlaying: false,
    position: const Duration(seconds: 30),
  );
}
