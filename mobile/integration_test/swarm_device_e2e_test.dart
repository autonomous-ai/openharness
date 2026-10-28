import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/main.dart' as app;
import 'package:harness_mobile/phone/phone_shell.dart';
import 'package:harness_mobile/phone/welcome/onboarding_copy.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_need_rows.dart';

/// Swarm end to end on a real phone: the real app, signed in to its owner's
/// account, reading the account's Swarms through one of its own computers.
/// Only on the owner's own phone, when they ask for the run (the mobile
/// owner, 2026-10-27): it is opt-in with `SWARM_E2E_DEVICE=true` and skips
/// otherwise, so no CI or simulator run reaches a real account.
///
/// It reads: Swarm on (in memory only; the saved switch is left as it was),
/// Swarm Home and its drawer, Harness from the project team and the terminal's mark back to Swarm Home,
/// the first project, its project chat and its ⋮ menu. It writes only when `SWARM_E2E_CHAT` names a test chat whose open
/// decision asks this person: there it posts one short line and answers that
/// decision with its first option. Nothing else is written.
///
///     flutter drive -d <phone> --keep-app-running \
///       --driver=test_driver/journey_driver.dart \
///       --target=integration_test/swarm_device_e2e_test.dart \
///       --dart-define=SWARM_E2E_DEVICE=true \
///       [--dart-define=SWARM_E2E_CHAT='Phone e2e']
///
/// `--keep-app-running` always: without it `flutter drive` uninstalls the app
/// (`integration_test/README.md`). Screenshots land in `HARNESS_JOURNEY_OUT`
/// (default `build/journey/`); they show the account's own Swarms, so they
/// stay with the person who ran it.
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  const run = bool.fromEnvironment('SWARM_E2E_DEVICE');
  const chat = String.fromEnvironment('SWARM_E2E_CHAT');

  testWidgets(
    'Swarm on this phone, for its signed-in owner',
    (tester) async {
      var step = 0;
      Future<void> wait([int ms = 600]) async {
        for (var elapsed = 0; elapsed < ms; elapsed += 100) {
          await tester.pump(const Duration(milliseconds: 100));
        }
      }

      Future<void> shot(String name) async {
        // Past any page transition.
        await wait(900);
        step++;
        await binding.takeScreenshot(
          'device-${step.toString().padLeft(2, '0')}-$name',
        );
      }

      Future<void> waitFor(Finder finder, {int seconds = 30}) async {
        for (var i = 0; i < seconds * 10; i++) {
          if (finder.evaluate().isNotEmpty) return;
          if (find.byKey(const ValueKey('swarm-error')).evaluate().isNotEmpty) {
            await shot('swarm-error');
            fail('Swarm said it could not read: see the screenshot');
          }
          await tester.pump(const Duration(milliseconds: 100));
        }
        fail('never appeared: $finder');
      }

      Future<void> waitGone(Finder finder, {int seconds = 30}) async {
        for (var i = 0; i < seconds * 10; i++) {
          if (finder.evaluate().isEmpty) return;
          await tester.pump(const Duration(milliseconds: 100));
        }
        fail('never went: $finder');
      }

      Finder key(String value) => find.byKey(ValueKey(value));
      Finder keyStarting(String prefix) => find.byWidgetPredicate(
        (widget) =>
            widget.key is ValueKey<String> &&
            (widget.key! as ValueKey<String>).value.startsWith(prefix),
      );

      await app.main();
      // Home, with a harness on it (or Swarm Home, Swarm saved on); or the
      // welcome, which this run cannot pass.
      final home = find.byWidgetPredicate(
        (widget) =>
            widget.key == const ValueKey('terminal-title') ||
            widget.key == const ValueKey('swarm-menu'),
      );
      for (var i = 0; i < 900 && home.evaluate().isEmpty; i++) {
        if (find.text(OnboardingCopy.welcome).evaluate().isNotEmpty) {
          fail('Sign in on the phone first, then run this again.');
        }
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(home, findsOneWidget, reason: 'Home with a harness on it');

      // Swarm on for this run only: the value, not the store's write.
      final saved = experimentalFeaturesStore.value;
      addTearDown(() => experimentalFeaturesStore.value = saved);
      experimentalFeaturesStore.value = {...saved, PhoneExperiment.swarm};

      // ① Swarm Home at the root: needs first, Chat with PM, the projects.
      // Its drawer, with no way to Harness; Harness from the project
      // team’s Open terminal action; the
      // terminal's mark goes back to Swarm Home.
      await waitFor(keyStarting('swarm-project-'), seconds: 60);
      await shot('swarm');
      await tester.tap(key('swarm-menu'));
      await waitFor(key('swarm-drawer-home'));
      expect(key('swarm-drawer-harness'), findsNothing);
      await shot('drawer');
      await tester.tap(key('swarm-drawer-home'));
      await waitGone(key('swarm-drawer-home'));
      await tester.tap(keyStarting('swarm-project-').first);
      await waitFor(key('swarm-project-menu'));
      await tester.tap(key('swarm-project-menu'));
      await waitFor(key('swarm-project-menu-status'));
      await tester.tap(key('swarm-project-menu-status'));
      await waitFor(key('swarm-sheet-team'));
      await tester.tap(key('swarm-sheet-team'));
      await waitFor(keyStarting('swarm-open-terminal-'));
      await tester.tap(keyStarting('swarm-open-terminal-').first);
      await waitFor(key('swarm-mark'));
      await shot('home-mark');
      await tester.tap(key('swarm-mark'));
      await waitFor(keyStarting('swarm-project-'), seconds: 60);

      // ② The first project: it opens on its project chat, read only.
      await tester.tap(keyStarting('swarm-project-').first);
      await waitFor(key('swarm-project-menu'));
      await waitFor(key('swarm-messages'));
      await wait(3000);
      await shot('project');
      // Its ⋮ menu: Chat with PM and the team's status, as it reads now.
      await tester.tap(key('swarm-project-menu'));
      await waitFor(key('swarm-project-menu-status'));
      await shot('project-menu');
      // Closed again by a tap above it, as the person would.
      await tester.tapAt(const Offset(20, 120));
      await waitGone(key('swarm-project-menu-status'));

      if (chat.isEmpty) return;

      // ③ The named test chat, from its decision on Swarm Home: one line
      // posted, and the decision answered with its first option.
      // Back, as the page's own chevron does: the shell's navigator.
      tester
          .state<NavigatorState>(
            find
                .descendant(
                  of: find.byType(PhoneShell),
                  matching: find.byType(Navigator),
                )
                .first,
          )
          .pop();
      await wait(1500);
      final card = find.byWidgetPredicate(
        (w) =>
            w is SwarmDecisionCard && w.need.decision.conversationTitle == chat,
      );
      // Swarm Home opens one need at a time: each decision in turn, until
      // the test chat's.
      final tried = <String>{};
      while (card.evaluate().isEmpty) {
        final next = keyStarting('swarm-need-row-decision:')
            .evaluate()
            .map((e) => (e.widget.key! as ValueKey<String>).value)
            .where((k) => !tried.contains(k))
            .firstOrNull;
        if (next == null) break;
        tried.add(next);
        await tester.ensureVisible(key(next));
        await tester.tap(key(next));
        await wait();
      }
      await waitFor(card);
      await shot('test-decision');
      // Who asks, at the top of the card, opens the chat it was asked in.
      await tester.tap(
        find.descendant(
          of: card.first,
          matching: find.byWidgetPredicate(
            (w) =>
                w.key is ValueKey<String> &&
                (w.key! as ValueKey<String>).value.startsWith(
                  'swarm-need-open-',
                ),
          ),
        ),
      );
      await waitFor(key('swarm-send'));
      final now = DateTime.now();
      final line =
          'Phone e2e check ${now.hour.toString().padLeft(2, '0')}:'
          '${now.minute.toString().padLeft(2, '0')}';
      await tester.enterText(find.byType(TextField), line);
      await wait();
      await tester.tap(key('swarm-send'));
      await waitFor(find.text(line));
      await shot('posted');
      // The test decision's first option: `swarm-option-<decision>-0`.
      final option = keyStarting('swarm-option-').first;
      final optionKey = (tester.widget(option).key! as ValueKey<String>).value;
      final decision = optionKey.substring(
        'swarm-option-'.length,
        optionKey.lastIndexOf('-'),
      );
      await tester.tap(option);
      await waitFor(key('swarm-undo-$decision'));
      await shot('decision-held');
      await waitGone(key('swarm-held-$decision'));
      await waitGone(key('swarm-option-$decision-0'));
      await wait(1500);
      await shot('decision-answered');
    },
    skip: !run,
    timeout: const Timeout(Duration(minutes: 5)),
  );
}
