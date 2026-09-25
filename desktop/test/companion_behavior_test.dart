import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/workspace_companion.dart';
import 'package:harness/state/workspace_onboarding.dart';
import 'package:harness/widgets/companion_panel.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:xterm/xterm.dart' show TerminalStyle;

import 'swarm_state_test.dart' show MemoryStore;

Future<(WorkspaceOnboarding, CompanionController)> companion(
  WidgetTester tester, {
  DateTime Function()? now,
}) async {
  final journey = WorkspaceOnboarding(storage: MemoryStore());
  final pet = CompanionController(
    journey,
    now: now ?? tester.binding.clock.now,
  );
  addTearDown(() {
    pet.dispose();
    journey.dispose();
  });
  journey.sync(
    scope: 'a',
    observed: OnboardingStep.values.toSet(),
    otherComputer: false,
    modelsAvailable: true,
  );
  await tester.pump();
  pet.hatch(reduceMotion: true);
  await tester.pump(const Duration(seconds: 21));
  return (journey, pet);
}

void main() {
  test(
    'all species have distinct, bounded voices and a complete mood sheet',
    () {
      for (final prompt in CompanionPrompt.values) {
        final voices = CompanionSpecies.values
            .map((s) => s.reply(prompt, 0))
            .toSet();
        expect(voices.length, prompt == CompanionPrompt.help ? 1 : 6);
        for (final voice in voices) {
          expect(voice.isNotEmpty, isTrue);
          expect(voice.length, lessThan(140));
        }
      }
      for (final species in CompanionSpecies.values) {
        expect(CompanionDaypart.values.map(species.dayQuote).toSet().length, 4);
        for (final mood in CompanionMood.values) {
          expect(species.pose(mood).length, lessThanOrEqualTo(8));
          expect(mood.trigger, isNotEmpty);
        }
      }
    },
  );

  testWidgets(
    'only new completed turns celebrate; waiting wins; bursts and background stay quiet',
    (tester) async {
      final (_, pet) = await companion(tester);
      void sync(
        Map<String, int> turns, {
        bool waiting = false,
        bool working = false,
        bool blocked = false,
      }) => pet.sync(
        working: working,
        needsInput: waiting,
        blocked: blocked,
        browsing: false,
        completedTurns: turns.values.fold(0, (a, b) => a + b),
        turnsByMachine: turns,
      );
      sync({'a': 10}, working: true);
      expect(pet.mood, CompanionMood.focused);
      sync({'a': 10, 'new-machine': 100});
      expect(pet.mood, CompanionMood.content);
      sync({'a': 11, 'new-machine': 100});
      expect(pet.mood, CompanionMood.celebrating);
      sync({'a': 12}, waiting: true, working: true);
      expect(pet.mood, CompanionMood.waiting);
      sync({'a': 12, 'new-machine': 100});
      expect(pet.mood, CompanionMood.content);
      sync({'a': 13});
      expect(
        pet.mood,
        CompanionMood.content,
      ); // The same burst is not replayed.
      await tester.pump(const Duration(seconds: 21));
      sync({'a': 14});
      expect(pet.mood, CompanionMood.celebrating);
      pet.setEnvironment(foreground: false);
      sync({'a': 15});
      expect(pet.mood, CompanionMood.content);
      pet.setEnvironment(foreground: true);
      sync({'a': 15}, blocked: true);
      expect(pet.mood, CompanionMood.puzzled);
      pet.dispose();
    },
  );

  testWidgets(
    'idle stays still without input tracking; an explicit nap wakes after 15 minutes',
    (tester) async {
      final (_, pet) = await companion(tester);
      void idle() => pet.sync(
        working: false,
        needsInput: false,
        browsing: false,
        completedTurns: 0,
      );
      idle();
      var notifications = 0;
      pet.addListener(() => notifications++);
      await tester.pump(const Duration(hours: 1));
      idle();
      expect(pet.mood, CompanionMood.content);
      // A daypart refresh may update the line on idle(), never on a timer.
      final settled = notifications;
      await tester.pump(const Duration(hours: 1));
      expect(notifications, settled);
      pet.nap();
      pet.sync(
        working: true,
        needsInput: false,
        browsing: false,
        completedTurns: 1,
      );
      expect(pet.napping, isTrue);
      expect(pet.mood, CompanionMood.asleep);
      await tester.pump(const Duration(minutes: 15));
      expect(pet.napping, isFalse);
      expect(pet.mood, CompanionMood.focused);
      pet.dispose();
    },
  );

  testWidgets(
    'daypart refreshes on existing events; a return after a break greets once',
    (tester) async {
      var time = DateTime(2026, 9, 24, 11, 59);
      final (_, pet) = await companion(tester, now: () => time);
      pet.sync(
        working: false,
        needsInput: false,
        browsing: false,
        completedTurns: 0,
      );
      final morning = pet.quote;
      expect(pet.daypart, CompanionDaypart.morning);
      time = DateTime(2026, 9, 24, 12);
      await tester.pump(const Duration(minutes: 1));
      expect(pet.daypart, CompanionDaypart.morning); // No clock timer.
      pet.sync(
        working: false,
        needsInput: false,
        browsing: false,
        completedTurns: 0,
      );
      expect(pet.daypart, CompanionDaypart.afternoon);
      expect(pet.quote, isNot(morning));
      pet.setEnvironment(foreground: false);
      time = DateTime(2026, 9, 25, 8);
      pet.setEnvironment(foreground: true);
      expect(pet.mood, CompanionMood.affectionate);
      expect(pet.reason, contains('Welcome back'));
      expect(pet.daypart, CompanionDaypart.morning);
      await tester.pump(const Duration(seconds: 7));
      var notifications = 0;
      pet.addListener(() => notifications++);
      pet.setEnvironment(foreground: true);
      await tester.pump(const Duration(hours: 1));
      expect(notifications, 0);
      pet.dispose();
    },
  );

  testWidgets(
    'direct play wins over work updates and the completion cooldown',
    (tester) async {
      final (_, pet) = await companion(tester);
      void work(int turns, {bool waiting = false}) => pet.sync(
        working: true,
        needsInput: waiting,
        browsing: false,
        completedTurns: turns,
      );
      work(0);
      work(1);
      expect(pet.mood, CompanionMood.celebrating);
      pet.playHabit();
      final firstFrame = pet.statusGlyph;
      work(2, waiting: true);
      expect(pet.mood, CompanionMood.happy);
      expect(pet.statusGlyph, firstFrame);
      await tester.pump(const Duration(milliseconds: 320));
      expect(pet.statusGlyph, isNot(firstFrame));
      await tester.pump(const Duration(seconds: 6));
      expect(pet.mood, CompanionMood.waiting);
      pet.dispose();
    },
  );

  testWidgets(
    'little conversations, naming, quiet mode, and account changes stay local',
    (tester) async {
      final (journey, pet) = await companion(tester);
      for (final (words, mood) in [
        ('hello', CompanionMood.curious),
        ('pep talk', CompanionMood.happy),
        ('thank you', CompanionMood.affectionate),
        ('boop', CompanionMood.startled),
        ('complain', CompanionMood.grumpy),
        ('sigh', CompanionMood.sad),
        ('oops', CompanionMood.puzzled),
        ('we did it', CompanionMood.celebrating),
      ]) {
        expect(pet.say(words), isTrue);
        expect(pet.mood, mood);
        expect(pet.quote, isNotEmpty);
      }
      expect(pet.say(''), isFalse);
      expect(pet.say('a' * 161), isFalse);
      expect(pet.say('hello\nworld'), isFalse);
      expect(pet.say('/name Pip'), isTrue);
      expect(pet.identity!.name, 'Pip');
      journey.setCompanionQuiet(true);
      pet.playHabit();
      final still = pet.glyph;
      await tester.pump(const Duration(seconds: 1));
      expect(pet.glyph, still);
      expect(pet.motionEnabled, isFalse);
      journey.nameCompanion('Miso');
      await journey.flush();
      final restored = WorkspaceOnboarding(storage: journey.storage);
      restored.sync(
        scope: 'a',
        observed: {},
        otherComputer: false,
        modelsAvailable: true,
      );
      await tester.pump();
      expect(restored.companion!.quiet, isTrue);
      expect(restored.companion!.name, 'Miso');
      restored.dispose();
      journey.sync(
        scope: 'b',
        observed: {},
        otherComputer: false,
        modelsAvailable: true,
      );
      await tester.pump();
      expect(pet.identity, isNull);
      expect(pet.quote, isEmpty);
      expect(pet.napping, isFalse);
      pet.dispose();
    },
  );

  testWidgets(
    'background rejects interaction; repeating nap renews its timer',
    (tester) async {
      final (_, pet) = await companion(tester);
      pet.setEnvironment(foreground: false);
      expect(pet.say('hello'), isFalse);
      pet.pet();
      pet.playHabit();
      pet.nap();
      expect(pet.napping, isFalse);
      pet.setEnvironment(foreground: true);
      await tester.pump(const Duration(seconds: 13));
      expect(pet.mood, CompanionMood.content);
      expect(pet.quote, pet.identity!.species.dayQuote(pet.daypart));

      pet.nap();
      await tester.pump(const Duration(minutes: 14));
      expect(pet.say('nap'), isTrue);
      await tester.pump(const Duration(minutes: 1));
      expect(pet.napping, isTrue);
      await tester.pump(const Duration(minutes: 14));
      expect(pet.napping, isFalse);
      expect(pet.mood, CompanionMood.content);
      pet.dispose();
    },
  );

  testWidgets(
    'conversation keeps focus and draft across live typography; about shows only your creature',
    (tester) async {
      final (_, pet) = await companion(tester);
      final font = terminalFontStore.value, theme = terminalThemeStore.value;
      addTearDown(() {
        terminalFontStore.value = font;
        terminalThemeStore.value = theme;
      });
      var closed = false;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.topRight,
              child: SizedBox(
                width: 320,
                height: 550,
                child: CompanionPanel(
                  controller: pet,
                  onClose: () => closed = true,
                  onStep: (_) {},
                  shortcut: (_) => null,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      final editor = find.byKey(const ValueKey('companion-message-input'));
      expect(tester.widget<TextField>(editor).focusNode!.hasFocus, isTrue);
      await tester.enterText(editor, 'pep talk');
      terminalFontStore.value = const TerminalStyle(
        fontFamily: 'Menlo',
        fontSize: 22,
      );
      terminalThemeStore.value = TerminalThemeChoice.tango;
      await tester.pump();
      expect(tester.widget<TextField>(editor).controller!.text, 'pep talk');
      expect(tester.widget<TextField>(editor).focusNode!.hasFocus, isTrue);
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pump();
      expect(pet.mood, CompanionMood.happy);
      expect(tester.widget<TextField>(editor).controller!.text, isEmpty);
      await tester.ensureVisible(find.text('[ about me ]'));
      await tester.tap(find.text('[ about me ]'));
      await tester.pump();
      expect(find.text('My little moods'), findsOneWidget);
      expect(
        find.textContaining(pet.identity!.species.personality),
        findsOneWidget,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(closed, isFalse);
      expect(find.text('My little moods'), findsNothing);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      expect(closed, isTrue);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      pet.dispose();
    },
  );
}
