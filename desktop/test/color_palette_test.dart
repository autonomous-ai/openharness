import 'dart:async';
import 'dart:ui' show SemanticsAction;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/settings/appearance/palette_section.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/appearance_prefs_store.dart';
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_theme.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:xterm/xterm.dart';

import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

class _Storage implements LocalKeyValueStore {
  final values = <String, String>{};
  Completer<void>? writeGate;
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> delete(String key) async => values.remove(key);
  @override
  Future<void> write(String key, String value) async {
    await writeGate?.future;
    values[key] = value;
  }
}

void main() {
  tearDown(() => grid.AppTheme.palette.value = HarnessPalette.graphite);

  test('rapid palette changes keep the last choice through relaunch', () async {
    final storage = _Storage()..writeGate = Completer<void>();
    final store = AppearancePrefsStore(storage: storage);
    addTearDown(store.dispose);
    final saved = store.setPalette(HarnessPalette.forest);
    store.setPalette(HarnessPalette.ember);
    expect(store.value.palette, HarnessPalette.ember);
    storage.writeGate!.complete();
    await saved;
    final restored = AppearancePrefsStore(storage: storage);
    addTearDown(restored.dispose);
    await restored.load();
    expect(restored.value.palette, HarnessPalette.ember);
    await restored.reset();
    expect(storage.values.containsKey('app_color_palette'), isFalse);
    expect(restored.value.palette, HarnessPalette.graphite);
    storage.values['app_color_palette'] = 'missing-preset';
    await restored.load();
    expect(restored.value.palette, HarnessPalette.graphite);
  });

  test('palette text is readable and terminal themes are cached', () {
    double contrast(Color foreground, Color background) {
      final a = foreground.computeLuminance() + .05;
      final b = background.computeLuminance() + .05;
      return a > b ? a / b : b / a;
    }

    for (final palette in HarnessPalette.values) {
      expect(
        contrast(palette.foreground, palette.background),
        greaterThanOrEqualTo(7),
        reason: palette.name,
      );
      for (final background in [
        palette.search,
        palette.card,
        palette.workspace,
      ]) {
        final secondary = Color.alphaBlend(
          palette.foreground.withValues(alpha: .70),
          background,
        );
        expect(
          contrast(secondary, background),
          greaterThanOrEqualTo(4.5),
          reason: palette.name,
        );
      }
      const matchApp = TerminalThemeChoice.matchApp;
      expect(
        terminalThemeFor(palette, matchApp),
        same(terminalThemeFor(palette, matchApp)),
      );
      expect(
        terminalThemeFor(palette, matchApp).background,
        palette.background,
      );
      expect(terminalThemeFor(palette, matchApp).selection.a, lessThan(.5));
      // A scheme of its own ignores the palette entirely — that is what makes
      // it a scheme rather than a tint of the app's.
      expect(
        terminalScreenThemeFor(palette, TerminalThemeChoice.tango).background,
        const Color(0xff300a24),
        reason: 'Tango does not follow ${palette.name}',
      );
      // The chrome keeps Tango only where it agrees with the palette: a dark
      // scheme's white ink on a light palette's grounds would be ~1:1.
      expect(
        terminalThemeFor(palette, TerminalThemeChoice.tango),
        same(
          palette.isDark
              ? tangoTerminalTheme
              : terminalThemeFor(palette, matchApp),
        ),
        reason: palette.name,
      );
    }
  });

  test('Dark and Light screens hold whatever the palette, and the chrome stays readable', () {
    for (final palette in HarnessPalette.values) {
      expect(
        terminalScreenThemeFor(palette, TerminalThemeChoice.dark),
        same(darkTerminalTheme),
      );
      expect(
        terminalScreenThemeFor(palette, TerminalThemeChoice.light),
        same(lightTerminalTheme),
      );
      // The scheme that disagrees with the palette keeps the screen only; the
      // chrome drawn on the palette's grounds takes the palette's own colours.
      final agrees = palette.isDark
          ? TerminalThemeChoice.dark
          : TerminalThemeChoice.light;
      final disagrees = palette.isDark
          ? TerminalThemeChoice.light
          : TerminalThemeChoice.dark;
      expect(
        terminalThemeFor(palette, agrees),
        same(terminalScreenThemeFor(palette, agrees)),
        reason: palette.name,
      );
      expect(
        terminalThemeFor(palette, disagrees),
        same(terminalThemeFor(palette, TerminalThemeChoice.matchApp)),
        reason: palette.name,
      );
    }
  });

  test('a light palette is light everywhere it is read', () {
    for (final palette in [HarnessPalette.paper, HarnessPalette.mist]) {
      expect(palette.isDark, isFalse, reason: palette.name);
      expect(palette.nativeColors['dark'], 0, reason: palette.name);
      final terminal = terminalThemeFor(palette, TerminalThemeChoice.matchApp);
      expect(terminal.foreground, palette.foreground);
      // The light ramp, not the dark one's pale yellow and white.
      expect(terminal.yellow, lightTerminalTheme.yellow);
      expect(terminal.white, lightTerminalTheme.white);

      double contrast(Color a, Color b) {
        final (x, y) = (a.computeLuminance(), b.computeLuminance());
        return (x > y ? x + .05 : y + .05) / (x > y ? y + .05 : x + .05);
      }

      // Every ANSI slot is somebody's output text on this ground.
      for (final slot in [
        terminal.black,
        terminal.red,
        terminal.green,
        terminal.yellow,
        terminal.blue,
        terminal.magenta,
        terminal.cyan,
        terminal.white,
        terminal.brightBlack,
        terminal.brightRed,
        terminal.brightGreen,
        terminal.brightYellow,
        terminal.brightBlue,
        terminal.brightMagenta,
        terminal.brightCyan,
        terminal.brightWhite,
      ]) {
        expect(
          contrast(slot, palette.background),
          greaterThanOrEqualTo(4.5),
          reason: '${palette.name} $slot',
        );
      }
      for (final ground in [
        palette.background,
        palette.card,
        palette.workspace,
        palette.search,
      ]) {
        expect(
          contrast(Color.alphaBlend(terminal.muted, ground), ground),
          greaterThanOrEqualTo(4.5),
          reason: '${palette.name} muted on $ground',
        );
        expect(
          contrast(Color.alphaBlend(terminal.faded, ground), ground),
          greaterThanOrEqualTo(3),
          reason: '${palette.name} faded on $ground',
        );
      }

      grid.AppTheme.palette.value = palette;
      grid.AppTheme.brightness.value = palette.brightness;
      expect(grid.AppPalette.windowBg, palette.background);
      expect(grid.AppPalette.textPrimary.computeLuminance(), lessThan(.1));
    }
    grid.AppTheme.brightness.value = Brightness.dark;
    expect(HarnessPalette.graphite.nativeColors['dark'], 1);
    expect(
      terminalThemeFor(
        HarnessPalette.graphite,
        TerminalThemeChoice.matchApp,
      ).yellow,
      darkTerminalTheme.yellow,
    );
  });

  testWidgets(
    'palette choices fit narrow settings and support keyboard selection',
    (tester) async {
      final store = AppearancePrefsStore(storage: _Storage());
      addTearDown(store.dispose);
      final semantics = tester.ensureSemantics();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: SizedBox(
              width: 340,
              child: SingleChildScrollView(child: PaletteSection(store: store)),
            ),
          ),
        ),
      );
      expect(tester.takeException(), isNull);
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(store.value.palette, HarnessPalette.dusk);
      await tester.ensureVisible(find.byKey(const ValueKey('palette-forest')));
      expect(
        tester
            .getSemantics(find.bySemanticsLabel('Forest palette'))
            .getSemanticsData()
            .hasAction(SemanticsAction.tap),
        isTrue,
      );
      await tester.tap(find.byKey(const ValueKey('palette-forest')));
      await tester.pump();
      expect(store.value.palette, HarnessPalette.forest);
      expect(tester.takeException(), isNull);
      semantics.dispose();
    },
  );

  testWidgets(
    'palette changes preserve the live terminal and update native colors',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1280, 800);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      const channel = MethodChannel('harness/swarm_tabs');
      final updates = <Map>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
        call,
      ) async {
        if (call.method == 'update') updates.add(call.arguments as Map);
        return true;
      });
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      final app = createApp();
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input)..terminal.write('Keep this output');
      app.adoptSessionForTest(session);
      final projects = SwarmProjectStore();
      await tester.pumpWidget(
        grid.BrightnessScope(
          child: MaterialApp(
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: SwarmScreen(
              notifier: app,
              nativeTabs: true,
              projectStore: projects,
            ),
          ),
        ),
      );
      await tester.pump();
      final terminalState = tester.state(find.byType(TerminalView));
      final before = tester.widget<TerminalView>(find.byType(TerminalView));
      final hadFocus = before.focusNode!.hasFocus;
      final pane = app.focusedPane;
      grid.AppTheme.palette.value = HarnessPalette.midnight;
      await tester.pump();
      final after = tester.widget<TerminalView>(find.byType(TerminalView));
      expect(tester.state(find.byType(TerminalView)), same(terminalState));
      expect(after.terminal, same(before.terminal));
      expect(app.focusedPane, same(pane));
      expect(after.focusNode!.hasFocus, hadFocus);
      expect(after.theme.background, HarnessPalette.midnight.background);
      expect(updates.last['palette'], HarnessPalette.midnight.nativeColors);
      expect(input, isEmpty);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      projects.dispose();
    },
  );
}
