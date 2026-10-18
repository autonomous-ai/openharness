import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/main.dart' as app;
import 'package:harness_mobile/phone/welcome/onboarding_copy.dart';

/// A first-time user's walk through the real app on a fresh simulator, a screenshot at each
/// step: ① Welcome — the promise, Google, Apple, and the emailed code under them — then the email,
/// and back (`docs/research/2026-10-11-phone-onboarding`).
///
/// Signed out on a clean install, and nothing here signs in: no account page is opened and no code
/// is sent, so nothing can reach a real account or a real machine. The sample, which this walk used
/// to take from Get it, is Settings' since the onboarding of 2026-10-12 — a signed-in phone's.
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
    await waitFor(find.text(OnboardingCopy.welcome));
    // The picture's agents typing, its packets running to the phone.
    await wait(1500);
    await shot('welcome');

    // The quiet line under the accounts: the emailed code.
    await tester.tap(find.byKey(const ValueKey('welcome-email-way')));
    await wait(800);
    await shot('sign-in-email');
    await tester.enterText(find.byType(TextField).last, 'ada@example.com');
    await wait(300);
    await shot('sign-in-email-typed');

    // Back is the welcome, as it was.
    await tester.tap(find.bySemanticsLabel('Back'));
    await wait(800);
    await shot('back-to-welcome');
  });
}
