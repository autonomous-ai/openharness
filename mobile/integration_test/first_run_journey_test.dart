import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/main.dart' as app;

/// A first-time user's walk through the real app on a fresh simulator, a screenshot at each
/// step: the welcome, the sample (hints, answering a question, Find, New with a task, the menu),
/// leaving it, and the way in — email, then setting up a computer.
///
/// Signed out on a clean install, so nothing here can reach a real account or a real machine: the
/// sample is offline by construction (`lib/demo/`).
///
///     flutter drive -d <simulator> --driver=test_driver/journey_driver.dart \
///       --target=integration_test/first_run_journey_test.dart
///
/// Screenshots land in `HARNESS_JOURNEY_OUT` (default `build/journey/`).
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('first run, as a new user', (tester) async {
    var step = 0;
    Future<void> shot(String name) async {
      await tester.pump(const Duration(milliseconds: 300));
      step++;
      await binding.takeScreenshot('${step.toString().padLeft(2, '0')}-$name');
    }

    Future<void> wait([int ms = 600]) async {
      for (var elapsed = 0; elapsed < ms; elapsed += 100) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    Future<void> waitFor(Finder finder, {int seconds = 20}) async {
      for (var i = 0; i < seconds * 10; i++) {
        if (finder.evaluate().isNotEmpty) return;
        await tester.pump(const Duration(milliseconds: 100));
      }
      fail('never appeared: $finder');
    }

    await app.main();
    await waitFor(find.text('Is Harness on your computer?'));
    await shot('welcome');

    // The sample: no account, no computer.
    await tester.longPress(find.byKey(const ValueKey('welcome-wordmark')));
    await wait(2000);
    // "Pick up where you left off": the sessions, a tap from their terminals.
    await shot('sample-pick-up');
    await tester.tap(find.text('fix-login', findRichText: true).first);
    await wait(1500);
    await shot('sample-first-time-hints');
    // The hints go on the first touch, which also does what it touched.
    await tester.tapAt(const Offset(200, 300));
    await wait(2500);
    await shot('sample-focus-working');

    // Find: swipe right.
    await tester.dragFrom(const Offset(40, 400), const Offset(300, 0));
    await wait(800);
    await shot('sample-find');

    // The harness that is asking.
    final asking = find.text('refactor-db');
    if (asking.evaluate().isNotEmpty) {
      await tester.tap(asking.first);
      await wait(2000);
      await shot('sample-asking');
      final yes = find.textContaining('1 yes');
      if (yes.evaluate().isNotEmpty) {
        await tester.tap(yes.first);
        await wait(3000);
        await shot('sample-answered');
      }
    }

    // New: swipe left.
    await tester.dragFrom(const Offset(350, 400), const Offset(-300, 0));
    await wait(1000);
    await shot('sample-new');
    await tester.enterText(
      find.byType(TextField).last,
      'Add a dark mode toggle',
    );
    await wait(300);
    await shot('sample-new-task');
    await tester.tap(find.text('Start'));
    await wait(4000);
    await shot('sample-new-harness-working');

    // The menu: a tap on the title; a tap anywhere else puts it away.
    await tester.tap(find.byKey(const ValueKey('terminal-title')).first);
    await wait(800);
    await shot('sample-menu');
    await tester.tapAt(const Offset(200, 120));
    await wait(600);

    // The end card, once the new harness has run a while — and the way to the real thing.
    await waitFor(find.text('Set up my computer'), seconds: 20);
    await wait(400);
    await shot('sample-end-card');
    await tester.tap(find.text('Set up my computer'));
    await wait(1500);
    await shot('set-up-after-sample');
    await tester.tap(find.bySemanticsLabel('Back'));
    await wait(800);
    await shot('back-to-welcome');

    // The two ways in: set it up, or scan the code the desktop app shows.
    await tester.tap(find.text('Not yet — set it up'));
    await wait(800);
    await shot('set-up-computer');
    await tester.tap(find.bySemanticsLabel('Back'));
    await wait(800);
    await tester.tap(find.text('Yes — scan to connect'));
    await wait(1500);
    await shot('scan-to-connect');
    await tester.tap(find.text('Use email instead'));
    await wait(800);
    await shot('sign-in-email');
  });
}
