// Optional PNGs: HARNESS_COMPANION_CAPTURE_DIR=/private/tmp/harness-companion-polish-review
// flutter test test/companion_review_render_test.dart
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/workspace_bar_style.dart';
import 'package:harness/state/workspace_companion.dart';
import 'package:harness/state/workspace_onboarding.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/terminal/terminal_theme.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:harness/terminal/terminal_typography.dart';
import 'package:harness/widgets/companion_panel.dart';
import 'package:harness/widgets/workspace_bar_control.dart';
import 'package:xterm/xterm.dart' show TerminalStyle;

import 'support/real_fonts.dart';

class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}

typedef _ReviewCase = ({
  String name,
  int completed,
  CompanionSpecies? species,
  Brightness brightness,
  TerminalThemeChoice terminalTheme,
  Size size,
  double fontSize,
});

const _cases = <_ReviewCase>[
  (
    name: 'initial-egg-dark',
    completed: 0,
    species: null,
    brightness: Brightness.dark,
    terminalTheme: TerminalThemeChoice.matchApp,
    size: Size(440, 580),
    fontSize: 13,
  ),
  (
    name: 'stirring-egg-dark',
    completed: 1,
    species: null,
    brightness: Brightness.dark,
    terminalTheme: TerminalThemeChoice.matchApp,
    size: Size(440, 580),
    fontSize: 13,
  ),
  (
    name: 'store-guidance-dark',
    completed: 2,
    species: null,
    brightness: Brightness.dark,
    terminalTheme: TerminalThemeChoice.matchApp,
    size: Size(440, 580),
    fontSize: 13,
  ),
  (
    name: 'ready-egg-dark',
    completed: 3,
    species: null,
    brightness: Brightness.dark,
    terminalTheme: TerminalThemeChoice.matchApp,
    size: Size(440, 580),
    fontSize: 13,
  ),
  (
    name: 'cat-dark',
    completed: 3,
    species: CompanionSpecies.cat,
    brightness: Brightness.dark,
    terminalTheme: TerminalThemeChoice.matchApp,
    size: Size(440, 580),
    fontSize: 13,
  ),
  (
    name: 'snail-light',
    completed: 3,
    species: CompanionSpecies.snail,
    brightness: Brightness.light,
    terminalTheme: TerminalThemeChoice.matchApp,
    size: Size(440, 580),
    fontSize: 13,
  ),
  (
    name: 'initial-egg-narrow-large-light',
    completed: 0,
    species: null,
    brightness: Brightness.light,
    terminalTheme: TerminalThemeChoice.tango,
    size: Size(320, 720),
    fontSize: 22,
  ),
];

void main() {
  setUpAll(() async {
    if (Platform.isMacOS) {
      // Preserve the real Apple mono metrics and Command key glyph rather
      // than the metric-compatible Courier face used by general layout tests.
      for (final (family, path) in [
        ('.AppleSystemUIFont', '/System/Library/Fonts/SFNS.ttf'),
        ('SF Pro Text', '/System/Library/Fonts/SFNS.ttf'),
        ('Roboto', '/System/Library/Fonts/SFNS.ttf'),
        ('.AppleSystemUIFontMonospaced', '/System/Library/Fonts/SFNSMono.ttf'),
        ('SF Mono', '/System/Library/Fonts/SFNSMono.ttf'),
        ('Menlo', '/System/Library/Fonts/SFNSMono.ttf'),
        ('Helvetica Neue', '/System/Library/Fonts/Apple Symbols.ttf'),
      ]) {
        final bytes = ByteData.sublistView(await File(path).readAsBytes());
        await (FontLoader(family)..addFont(Future.value(bytes))).load();
      }
    } else {
      await loadRealFonts();
    }
  });

  for (final review in _cases) {
    testWidgets('companion review: ${review.name}', (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = review.size;
      addTearDown(tester.view.reset);
      final previousBrightness = grid.AppTheme.brightness.value;
      final previousFont = terminalFontStore.value;
      final previousTheme = terminalThemeStore.value;
      final previousHighlight = FocusManager.instance.highlightStrategy;
      grid.AppTheme.brightness.value = review.brightness;
      FocusManager.instance.highlightStrategy =
          FocusHighlightStrategy.alwaysTraditional;
      terminalFontStore.value = TerminalStyle(
        fontFamily: terminalFontFamily,
        fontFamilyFallback: terminalFontFallback,
        fontSize: review.fontSize,
      );
      terminalThemeStore.value = review.terminalTheme;
      addTearDown(() {
        grid.AppTheme.brightness.value = previousBrightness;
        terminalFontStore.value = previousFont;
        terminalThemeStore.value = previousTheme;
        FocusManager.instance.highlightStrategy = previousHighlight;
      });

      const scope = 'synthetic-companion-render-review';
      final memory = _Memory();
      memory.values[WorkspaceOnboarding.storageKey(scope)] = jsonEncode({
        'completed': WorkspaceOnboarding.hatchSteps
            .take(review.completed)
            .map((step) => step.name)
            .toList(),
        if (review.species case final species?)
          'companion': CompanionIdentity(species, species.label).toJson(),
      });
      final journey = WorkspaceOnboarding(storage: memory);
      final pet = CompanionController(
        journey,
        now: () => DateTime(2026, 9, 24, 9),
      )..setEnvironment(foreground: true, reduceMotion: true);
      addTearDown(() {
        pet.dispose();
        journey.dispose();
      });
      journey.sync(
        scope: scope,
        observed: const {},
        otherComputer: review.completed >= 2,
        modelsAvailable: false,
      );
      await tester.pump();
      expect(journey.loaded, isTrue);
      expect(journey.completedCount, review.completed);
      expect(journey.companion?.species, review.species);

      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: review.brightness),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context).copyWith(disableAnimations: true),
              child: TerminalFontScope(child: child!),
            ),
            home: Builder(
              builder: (context) {
                final cell = terminalCellSizeOf(context);
                final barCell = workspaceBarCellSizeOf(context);
                final theme = terminalThemeFor(
                  grid.AppTheme.palette.value,
                  terminalThemeStore.value,
                );
                return Scaffold(
                  backgroundColor: theme.background,
                  body: Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          WorkspaceBarControl(
                            label: 'New Tab',
                            onPressed: () {},
                            builder: (context, emphasized) => SizedBox(
                              width: barCell.width * 3,
                              height: workspaceBarControlHeight(context),
                              child: Center(
                                child: Text(
                                  '+',
                                  style: workspaceBarTextStyle(
                                    color: theme.foreground,
                                    emphasized: emphasized,
                                  ),
                                ),
                              ),
                            ),
                          ),
                          CompanionTabButton(
                            controller: pet,
                            selected: true,
                            onPressed: () {},
                          ),
                          const SizedBox(width: 10),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Flexible(
                        child: Padding(
                          padding: const EdgeInsets.only(right: 10, bottom: 10),
                          child: SizedBox(
                            width: (cell.width * 46).clamp(
                              0,
                              review.size.width - 20,
                            ),
                            child: CompanionPanel(
                              controller: pet,
                              onClose: () {},
                              onStep: (_) {},
                              shortcut: (step) => switch (step) {
                                OnboardingStep.harnesses => '⌘N',
                                OnboardingStep.machines => '⌘M',
                                OnboardingStep.store => '⌘S',
                                OnboardingStep.models => null,
                              },
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                );
              },
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 150));
      final layoutException = tester.takeException();
      expect(find.byType(CompanionPanel), findsOneWidget);
      expect(find.byType(CompanionTabButton), findsOneWidget);

      final output = Platform.environment['HARNESS_COMPANION_CAPTURE_DIR'];
      if (output != null) {
        final render =
            boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        await tester.runAsync(() async {
          final picture = await render.toImage(pixelRatio: 2);
          try {
            final bytes = await picture.toByteData(
              format: ui.ImageByteFormat.png,
            );
            await Directory(output).create(recursive: true);
            await File('$output/${review.name}.png')
                .writeAsBytes(bytes!.buffer.asUint8List());
          } finally {
            picture.dispose();
          }
        });
      }
      expect(layoutException, isNull);
      await tester.pumpWidget(const SizedBox());
    });
  }
}
