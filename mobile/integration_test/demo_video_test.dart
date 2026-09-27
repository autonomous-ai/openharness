import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/main.dart' as app;
import 'package:harness_mobile/phone/voice_mic_face.dart';

/// "See how it works": the sample, walked at a person's pace, for a screen recording of the app —
/// a harness at work, one asking, answered by voice, and a new one started. Not a test of anything.
///
///     xcrun simctl io <sim> recordVideo --codec=h264 --force demo.mp4 &
///     flutter drive -d <sim> --dart-define=HARNESS_RECORDING=true \
///       --driver=test_driver/journey_driver.dart --target=integration_test/demo_video_test.dart
///
/// It prints `DEMO_START <ms since epoch>` where the recording should begin, to trim it by.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('see how it works', (tester) async {
    Future<void> wait(int ms) async {
      for (var elapsed = 0; elapsed < ms; elapsed += 50) {
        await tester.pump(const Duration(milliseconds: 50));
      }
    }

    await app.main();
    for (var i = 0; i < 400; i++) {
      if (find.text('Is Harness on your computer?').evaluate().isNotEmpty) {
        break;
      }
      await tester.pump(const Duration(milliseconds: 50));
    }
    await tester.longPress(find.byKey(const ValueKey('welcome-wordmark')));
    await wait(1200);
    // ignore: avoid_print
    print('DEMO_START ${DateTime.now().millisecondsSinceEpoch}');

    // Your sessions, one working.
    await wait(1800);
    await tester.tap(find.text('fix-login', findRichText: true).first);
    await wait(4000);

    // Another needs you: Find, a swipe right.
    await tester.dragFrom(const Offset(40, 450), const Offset(300, 0));
    await wait(1600);
    await tester.tap(find.text('refactor-db', findRichText: true).first);
    await wait(2600);

    // Answered by voice.
    await tester.tap(find.byType(VoiceMicCore));
    await wait(2000);
    await tester.tap(find.byType(VoiceMicCore));
    await wait(4200);

    // A new one: a swipe left.
    await tester.dragFrom(const Offset(350, 450), const Offset(-300, 0));
    await wait(1400);
    await tester.enterText(
      find.byType(TextField).last,
      'Add a dark mode toggle',
    );
    await wait(1000);
    await tester.tap(find.text('Start'));
    await wait(5000);
    // ignore: avoid_print
    print('DEMO_END ${DateTime.now().millisecondsSinceEpoch}');
  });
}
