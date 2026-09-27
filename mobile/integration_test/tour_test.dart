import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/main.dart' as app;
import 'package:harness_mobile/phone/voice_mic_face.dart';

/// Every state of the phone app, in the real app on a simulator, over the offline sample — a
/// screenshot each, for review. Signed out on a clean install, so nothing reaches a real account.
///
///     flutter drive -d <simulator> --driver=test_driver/journey_driver.dart \
///       --target=integration_test/tour_test.dart
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('a tour of every screen', (tester) async {
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

    Future<bool> tapIf(Finder finder) async {
      if (finder.evaluate().isEmpty) return false;
      await tester.tap(finder.first);
      return true;
    }

    Future<void> swipeRight() async {
      await tester.dragFrom(const Offset(40, 450), const Offset(300, 0));
      await wait(900);
    }

    Future<void> swipeLeft() async {
      await tester.dragFrom(const Offset(350, 450), const Offset(-300, 0));
      await wait(1000);
    }

    await app.main();
    await waitFor(find.text('Is Harness on your computer?'));
    // The sample, behind a long press on the wordmark: kept for these screenshots.
    await tester.longPress(find.byKey(const ValueKey('welcome-wordmark')));
    await wait(3000);
    // It opens on the sessions to pick up, as a new phone does.
    await shot('pick-up');
    await tester.tap(find.text('fix-login', findRichText: true).first);
    await wait(3000);
    await shot('focus');

    // Typing: only a tap on the prompt's rows, at the foot of the screen, raises the keyboard —
    // left of the mic, which floats over them.
    final screen = tester.view.physicalSize / tester.view.devicePixelRatio;
    await tester.tapAt(Offset(30, screen.height - 60));
    await wait(1200);
    await shot('focus-keyboard');
    await tapIf(find.byKey(const ValueKey('terminal-key-Hide keyboard')));
    await wait(1000);

    // Talking.
    if (await tapIf(find.byType(VoiceMicCore))) {
      await wait(1800);
      await shot('focus-recording');
      await tapIf(find.byType(VoiceMicCore));
      await wait(3500);
      await shot('focus-sent');
    }

    // Reading back.
    await tester.dragFrom(const Offset(200, 300), const Offset(0, 400));
    await wait(1000);
    await shot('focus-reading-history');
    await tester.dragFrom(const Offset(200, 500), const Offset(0, -2000));
    await wait(1200);

    // The menu.
    await tester.tap(find.byKey(const ValueKey('terminal-title')).first);
    await wait(900);
    await shot('menu');
    await tester.tapAt(const Offset(200, 150));
    await wait(700);

    // Find, and each of its modes.
    await swipeRight();
    await shot('find');
    final field = find.byType(TextField).first;
    await tester.enterText(field, 'ap');
    await wait(600);
    await shot('find-typed');
    await tester.enterText(field, '#');
    await wait(600);
    await shot('find-projects');
    await tester.enterText(field, ':');
    await wait(1500);
    await shot('find-models');
    await tester.enterText(field, '>');
    await wait(600);
    await shot('find-commands');
    await tester.enterText(field, '');
    await wait(400);
    FocusManager.instance.primaryFocus?.unfocus();
    await wait(600);

    // The question.
    if (await tapIf(find.text('refactor-db'))) {
      await wait(2200);
      await shot('focus-asking');
    } else {
      await tester.dragFrom(const Offset(350, 450), const Offset(-300, 0));
      await wait(900);
    }

    // New.
    await swipeLeft();
    await shot('new');
    if (await tapIf(find.text('options'))) {
      await wait(600);
      await shot('new-options');
    }
    if (await tapIf(find.text('project'))) {
      await wait(900);
      await shot('chooser-project');
      await tester.tapAt(const Offset(200, 80));
      await wait(700);
    }
    if (await tapIf(find.text('agent'))) {
      await wait(900);
      await shot('chooser-agent');
      await tester.tapAt(const Offset(200, 80));
      await wait(700);
    }
    await tester.dragFrom(const Offset(40, 450), const Offset(300, 0));
    await wait(1000);

    // Settings and Help, through the menu.
    await tester.tap(find.byKey(const ValueKey('terminal-title')).first);
    await wait(900);
    if (await tapIf(find.text('Settings'))) {
      await wait(1200);
      await shot('settings');
      if (await tapIf(find.text('How Harness works'))) {
        await wait(1000);
        await shot('how-it-works');
      }
    }
  });
}
