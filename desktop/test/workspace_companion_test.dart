import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/workspace_bar_style.dart';
import 'package:harness/state/workspace_companion.dart';
import 'package:harness/state/workspace_onboarding.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/terminal/terminal_theme.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:harness/widgets/companion_panel.dart';
import 'package:xterm/xterm.dart' show TerminalStyle;

import 'swarm_state_test.dart' show MemoryStore;

Future<void> load(
  WorkspaceOnboarding journey, {
  String scope = 'a',
  bool complete = false,
}) async {
  journey.sync(
    scope: scope,
    observed: complete ? WorkspaceOnboarding.hatchSteps.toSet() : {},
    otherComputer: false,
    modelsAvailable: true,
  );
  await Future<void>.delayed(Duration.zero);
}

void main() {
  testWidgets(
    'discoveries work with Enter and arrows; knocking never earns progress',
    (tester) async {
      final journey = WorkspaceOnboarding();
      final pet = CompanionController(journey);
      addTearDown(journey.dispose);
      addTearDown(pet.dispose);
      journey.sync(
        scope: 'keyboard',
        observed: {},
        otherComputer: false,
        modelsAvailable: false,
      );
      await tester.pump();
      final opened = <OnboardingStep>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 460,
              child: CompanionPanel(
                controller: pet,
                onClose: () {},
                onStep: opened.add,
                shortcut: (_) => null,
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      expect(opened, [OnboardingStep.harnesses]);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.pump();
      expect(
        find.textContaining('Work on another computer from here.'),
        findsOneWidget,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      expect(opened.last, OnboardingStep.machines);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyJ);
      await tester.pump();
      expect(
        find.textContaining('Pick a non-coding harness in the Store.'),
        findsOneWidget,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      expect(opened.last, OnboardingStep.store);
      await tester.tap(find.byKey(const ValueKey('companion-egg-knock')));
      await tester.pump();
      expect(find.text('a tiny rustle from inside.'), findsOneWidget);
      expect(journey.completedCount, 0);
      expect(journey.companion, isNull);
      journey.sync(
        scope: 'keyboard',
        observed: WorkspaceOnboarding.hatchSteps.toSet(),
        otherComputer: true,
        modelsAvailable: false,
      );
      await tester.pump();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      expect(journey.companion, isNotNull);
      await tester.pump(const Duration(seconds: 3));
      await tester.pump();
      final editor = tester.widget<TextField>(
        find.byKey(const ValueKey('companion-message-input')),
      );
      expect(editor.focusNode!.hasFocus, isTrue);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      pet.dispose();
    },
  );

  testWidgets('egg motion pauses in the background and under reduced motion', (
    tester,
  ) async {
    final journey = WorkspaceOnboarding();
    final pet = CompanionController(journey);
    addTearDown(() {
      pet.dispose();
      journey.dispose();
    });
    journey.sync(
      scope: 'a',
      observed: {},
      otherComputer: false,
      modelsAvailable: false,
    );
    await tester.pump();
    final frames = <String>[];
    pet.addListener(() => frames.add(pet.statusGlyph));
    pet.knock();
    expect(pet.statusGlyph, isNot(CompanionController.egg));
    expect(pet.statusColumns, 8);
    pet.setEnvironment(foreground: false);
    expect(pet.statusGlyph, CompanionController.egg);
    frames.clear();
    await tester.pump(const Duration(minutes: 2));
    expect(frames, isEmpty);
    pet.setEnvironment(foreground: true, reduceMotion: true);
    pet.knock();
    expect(pet.statusGlyph, CompanionController.egg);
    await tester.pump(const Duration(seconds: 3));
    frames.clear();
    await tester.pump(const Duration(minutes: 2));
    expect(frames, isEmpty);
    journey.sync(
      scope: 'a',
      observed: WorkspaceOnboarding.hatchSteps.toSet(),
      otherComputer: true,
      modelsAvailable: false,
    );
    pet.setEnvironment(foreground: true);
    await tester.pump(const Duration(seconds: 3));
    expect(pet.statusGlyph, contains('/'));
    expect(pet.statusGlyph, isNot(CompanionController.egg));
    pet.hatch();
    final identity = pet.identity;
    expect(pet.hatching, isTrue);
    for (var i = 0; i < 11; i++) {
      await tester.pump(const Duration(milliseconds: 180));
      expect(pet.statusColumns, 8);
      expect(pet.identity, same(identity));
    }
    expect(pet.hatching, isFalse);
    for (final frame in frames) {
      expect(frame.length, lessThanOrEqualTo(pet.statusColumns));
      expect(RegExp(r'^[\x20-\x7e]+$').hasMatch(frame), isTrue);
    }
    pet.dispose();
    await tester.pump(const Duration(minutes: 2));
  });

  testWidgets(
    'status stays symbol-only and follows bar typography across terminal zoom',
    (tester) async {
      final journey = WorkspaceOnboarding();
      final pet = CompanionController(journey);
      final originalFont = terminalFontStore.value;
      final originalTheme = terminalThemeStore.value;
      addTearDown(() {
        pet.dispose();
        journey.dispose();
        terminalFontStore.value = originalFont;
        terminalThemeStore.value = originalTheme;
      });
      journey.sync(
        scope: 'a',
        observed: {},
        otherComputer: false,
        modelsAvailable: true,
      );
      await tester.pump();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Center(
              child: CompanionTabButton(controller: pet, onPressed: () {}),
            ),
          ),
        ),
      );
      final button = find.byKey(const ValueKey('companion-tab-button'));
      final face = find.byKey(const ValueKey('companion-tab-face'));
      expect(find.text(CompanionController.egg), findsOneWidget);
      expect(find.text('Hatch a companion'), findsNothing);
      expect(find.text('Hatch your companion'), findsNothing);
      final initialInk = tester.widget<Text>(face).style!.color!;
      final width = tester.getSize(button).width;
      journey.sync(
        scope: 'a',
        observed: OnboardingStep.values.toSet(),
        otherComputer: false,
        modelsAvailable: true,
      );
      await tester.pump();
      expect(find.text(CompanionController.readyEgg), findsOneWidget);
      expect(tester.getSize(button).width, width);
      expect(
        tester.widget<Text>(face).style!.color!.a,
        greaterThan(initialInk.a),
      );
      pet.hatch(reduceMotion: true);
      expect(journey.nameCompanion('Little Pip'), isTrue);
      await tester.pump();
      for (final mood in CompanionMood.values) {
        pet.react(mood);
        await tester.pump();
        expect(tester.widget<Text>(face).data, pet.glyph);
        expect(tester.getSize(button).width, width);
        expect(find.text(pet.identity!.name), findsNothing);
      }
      terminalFontStore.value = const TerminalStyle(
        fontFamily: 'Menlo',
        fontSize: 22,
      );
      terminalThemeStore.value = TerminalThemeChoice.tango;
      await tester.pump();
      expect(tester.getSize(button).width, width);
      expect(tester.widget<Text>(face).style!.fontSize, workspaceBarFontSize);
      expect(
        tester.widget<Text>(face).style!.color,
        terminalThemeFor(
          grid.AppTheme.palette.value,
          TerminalThemeChoice.tango,
        ).green,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 7));
    },
  );

  test('hatching requires three earned steps and never rerolls across restarts or accounts', () async {
    final storage = MemoryStore();
    final journey = WorkspaceOnboarding(storage: storage, random: Random(1));
    addTearDown(journey.dispose);
    expect(journey.hatchCompanion(), isFalse);
    await load(journey);
    for (final step in OnboardingStep.values) {
      journey.dismiss(step);
    }
    expect(journey.hatchCompanion(), isFalse);
    await load(journey, complete: true);
    expect(journey.hatchCompanion(), isTrue);
    final species = journey.companion!.species;
    expect(journey.hatchCompanion(), isFalse);
    expect(journey.nameCompanion('  Miso  '), isTrue);
    expect(journey.nameCompanion('bad\nname'), isFalse);
    expect(journey.nameCompanion(''), isFalse);
    await journey.flush();
    final restored = WorkspaceOnboarding(storage: storage);
    addTearDown(restored.dispose);
    await load(restored);
    expect(restored.companion!.name, 'Miso');
    expect(restored.companion!.species, species);
    expect(restored.hatchCompanion(), isFalse);
    await load(restored, scope: 'b');
    expect(restored.companion, isNull);
    await load(restored);
    expect(restored.companion!.name, 'Miso');
  });

  test('every expression and gesture fits eight printable ASCII cells', () {
    expect(CompanionSpecies.values.length, 6);
    for (final species in CompanionSpecies.values) {
      expect(species.poses.length, CompanionMood.values.length);
      expect(species.quotes.length, CompanionMood.values.length);
      for (final frame in [
        ...species.poses,
        ...species.habitFrames,
        species.blink,
      ]) {
        expect(
          frame.length,
          lessThanOrEqualTo(8),
          reason: '${species.name}: $frame',
        );
        expect(RegExp(r'^[\x20-\x7e]+$').hasMatch(frame), isTrue);
      }
    }
    expect(
      CompanionIdentity.fromJson({'species': 'unknown', 'name': 'Miso'}),
      isNull,
    );
  });

  testWidgets(
    'moods follow real work; celebrations end and scope changes cancel reactions',
    (tester) async {
      final journey = WorkspaceOnboarding();
      final pet = CompanionController(journey, now: tester.binding.clock.now);
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
      void sync({
        bool working = false,
        bool waiting = false,
        bool browsing = false,
        int turns = 0,
      }) => pet.sync(
        working: working,
        needsInput: waiting,
        browsing: browsing,
        completedTurns: turns,
      );
      sync(working: true);
      expect(pet.mood, CompanionMood.focused);
      sync(working: true, waiting: true);
      expect(pet.mood, CompanionMood.waiting);
      sync(turns: 1);
      expect(pet.mood, CompanionMood.celebrating);
      await tester.pump(const Duration(seconds: 7));
      expect(pet.mood, CompanionMood.content);
      sync(browsing: true, turns: 1);
      expect(pet.mood, CompanionMood.curious);
      sync(turns: 1);
      await tester.pump(const Duration(minutes: 5));
      expect(pet.mood, CompanionMood.content);
      pet.playHabit();
      journey.sync(
        scope: 'b',
        observed: {},
        otherComputer: false,
        modelsAvailable: true,
      );
      await tester.pump(const Duration(seconds: 7));
      expect(pet.identity, isNull);
      expect(pet.glyph, isEmpty);
      expect(pet.mood, CompanionMood.content);
      pet.dispose();
    },
  );

  testWidgets('egg invitation shows progress and leads to an actual step', (
    tester,
  ) async {
    final journey = WorkspaceOnboarding();
    final pet = CompanionController(journey);
    addTearDown(() {
      pet.dispose();
      journey.dispose();
    });
    journey.sync(
      scope: 'a',
      observed: {},
      otherComputer: false,
      modelsAvailable: true,
    );
    await tester.pump();
    OnboardingStep? opened;
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SizedBox(
            width: 340,
            child: CompanionPanel(
              controller: pet,
              onClose: () {},
              onStep: (step) => opened = step,
              shortcut: (_) => '⌘N',
            ),
          ),
        ),
      ),
    );
    expect(find.text('Your companion'), findsOneWidget);
    expect(find.text('[ ]'), findsNWidgets(3));
    expect(find.text('Try a local model'), findsNothing);
    await tester.tap(find.byKey(const ValueKey('companion-hatch-action')));
    expect(opened, OnboardingStep.harnesses);
    expect(journey.companion, isNull);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    pet.dispose();
  });

  testWidgets('hatch, pet, name and reopen; reduced motion skips the reveal', (
    tester,
  ) async {
    final journey = WorkspaceOnboarding(
      storage: MemoryStore(),
      random: Random(2),
    );
    final pet = CompanionController(journey);
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
    Future<void> mount() => tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: MediaQuery(
          data: const MediaQueryData(disableAnimations: true),
          child: Scaffold(
            body: SizedBox(
              width: 340,
              child: CompanionPanel(
                controller: pet,
                onClose: () {},
                onStep: (_) {},
                shortcut: (_) => null,
              ),
            ),
          ),
        ),
      ),
    );
    await mount();
    await tester.tap(find.byKey(const ValueKey('companion-hatch-action')));
    await tester.pump();
    expect(pet.hatching, isFalse);
    final identity = pet.identity!;
    expect(find.byKey(const ValueKey('companion-panel-face')), findsOneWidget);
    await tester.tap(find.text('[ pet ]'));
    await tester.pump();
    expect(pet.mood, CompanionMood.affectionate);
    await tester.tap(find.text('[ give me a name ]'));
    await tester.pump();
    await tester.pump();
    expect(
      tester.widget<TextField>(find.byType(TextField)).focusNode!.hasFocus,
      isTrue,
    );
    tester.testTextInput.enterText('Pip');
    await tester.pump();
    await tester.tap(find.text('[ save name ]'));
    await tester.pump();
    expect(pet.identity!.name, 'Pip');
    await tester.pumpWidget(const SizedBox());
    await mount();
    expect(pet.identity!.species, identity.species);
    expect(find.text('Pip'), findsOneWidget);
    expect(find.byKey(const ValueKey('companion-hatch-action')), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 7));
  });

  testWidgets('closing the panel during a reveal keeps the same companion', (
    tester,
  ) async {
    final journey = WorkspaceOnboarding();
    final pet = CompanionController(journey);
    journey.sync(
      scope: 'a',
      observed: OnboardingStep.values.toSet(),
      otherComputer: false,
      modelsAvailable: true,
    );
    await tester.pump();
    pet.hatch();
    expect(pet.hatching, isTrue);
    final identity = pet.identity;
    pet.hatch();
    await tester.pump(const Duration(seconds: 3));
    expect(pet.hatching, isFalse);
    expect(pet.identity, same(identity));
    expect(pet.mood, CompanionMood.happy);
    pet.dispose();
    journey.dispose();
    await tester.pump(const Duration(seconds: 20));
    expect(tester.takeException(), isNull);
  });
}
