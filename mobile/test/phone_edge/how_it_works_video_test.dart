import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/welcome/how_it_works_video.dart';
import 'package:video_player/video_player.dart';

import 'edge_fixture.dart';

/// "See how it works": the recording of the app, played on the set-up page — with a player that
/// answers here rather than the platform's.
void main() {
  testWidgets('plays once ready; a tap pauses, plays, and at the end plays '
      'again', (tester) async {
    setPhone(tester, largePhone);
    final video = _Video();
    await tester.pumpWidget(phoneApp(HowItWorksVideoPage(controller: video)));
    await frames(tester);
    expect(video.calls, ['initialize', 'play']);
    expect(find.byType(VideoPlayer), findsOneWidget);

    tap(tester);
    expect(video.calls.last, 'pause');
    tap(tester);
    expect(video.calls.last, 'play');

    // At the end: back to the start, then play.
    video.finish();
    tap(tester);
    expect(video.calls.sublist(video.calls.length - 2), ['seekTo', 'play']);

    await tester.pumpWidget(const SizedBox());
    video.dispose();
  });

  testWidgets('a recording that will not load leaves the page empty, not '
      'broken', (tester) async {
    setPhone(tester, largePhone);
    final video = _Video(fails: true);
    await tester.pumpWidget(phoneApp(HowItWorksVideoPage(controller: video)));
    await frames(tester);
    expect(find.byType(VideoPlayer), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.tap(find.bySemanticsLabel(RegExp('Back')).first);
    await tester.pumpWidget(const SizedBox());
  });
}

/// A tap on the video — its detector's own callback: a player with no texture paints nothing a
/// finger could land on in a test, where on a phone the texture takes the touch.
void tap(WidgetTester tester) => tester
    .widget<GestureDetector>(
      find
          .ancestor(
            of: find.byType(VideoPlayer),
            matching: find.byType(GestureDetector),
          )
          .first,
    )
    .onTap!();

/// A player that plays nothing, and says what it was asked.
class _Video extends VideoPlayerController {
  _Video({this.fails = false}) : super.asset('assets/video/how_it_works.mp4');

  final bool fails;
  final List<String> calls = [];

  @override
  Future<void> initialize() async {
    calls.add('initialize');
    if (fails) throw Exception('no such asset');
    value = value.copyWith(
      isInitialized: true,
      duration: const Duration(seconds: 30),
      size: const Size(1080, 1920),
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

  void finish() => value = value.copyWith(
    isPlaying: false,
    position: const Duration(seconds: 30),
  );
}
